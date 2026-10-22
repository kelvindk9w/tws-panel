/**
 * client.ts — cliente da API REST de gerenciamento do Stalwart (linha v0.11).
 *
 * Endpoints usados (verificados contra o código-fonte v0.11.8):
 *  - POST   /api/principal          cria domínio ({"type":"domain"}) ou caixa
 *                                   ({"type":"individual", roles:["user"]} — o
 *                                   papel "user" é obrigatório p/ SMTP/IMAP)
 *  - GET    /api/principal?type=... lista
 *  - DELETE /api/principal/{nome}   remove
 *  - POST   /api/dkim               gera par de chaves ({"algorithm":"Rsa"} → RSA 2048)
 *  - GET    /api/dkim/{id}          chave pública (base64 do parâmetro p=)
 *  - GET    /api/queue/messages?values=1&text=…
 *                                   fila de saída, com o estado de cada
 *                                   destinatário (formato em delivery-status.ts)
 *  - GET    /api/queue/messages?values=1&limit=N   fila inteira (página Envios)
 *  - PATCH  /api/queue/messages/{id}  tenta de novo agora (ver retryQueuedMessage)
 *  - DELETE /api/queue/messages/{id}  tira da fila (cancela)
 * Auth: HTTP Basic com o fallback-admin (admin:<secret>).
 */
import { isIP } from "node:net";
import { DKIM_SELECTOR } from "@paas/core";
import type { QueuedMessage } from "./delivery-status.js";
import { isQueueId, parseQueueResponse, type QueueMessageRaw } from "./queue-view.js";

export class StalwartApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "StalwartApiError";
  }
}

/** O que o painel guarda de um principal do Stalwart: nunca senhas. */
export interface StalwartPrincipalSummary {
  name: string;
  emails: string[];
}

function assertIp(ip: string): void {
  if (!isIP(ip)) throw new StalwartApiError(400, `IP inválido: ${JSON.stringify(ip)}`);
}

interface ApiEnvelope {
  data?: unknown;
  status?: number;
  title?: string;
  detail?: string;
}

/** Páginas lidas por listPrincipals (500 por página): acima de PRINCIPAL_LIST_MAX a lista vem cortada. */
const PRINCIPAL_LIST_PAGES = 40;
export const PRINCIPAL_LIST_MAX = PRINCIPAL_LIST_PAGES * 500;

/** Cara de hash (crypt "$6$", "$argon2id$", "$app$"; "{SHA}"): não dá para comparar com a senha em texto. */
const HASHED_SECRET_RE = /^(\$[0-9a-z]+\$|\{[A-Za-z0-9-]+\})/;

export class StalwartClient {
  private readonly authHeader: string;

  constructor(
    private readonly baseUrl: string,
    user: string,
    secret: string,
  ) {
    this.authHeader = `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;
  }

  /** Chamada crua: devolve o corpo como texto (erros já viram StalwartApiError). */
  private async call(method: string, path: string, body?: unknown): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api${path}`, {
        method,
        headers: {
          authorization: this.authHeader,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new StalwartApiError(
        0,
        `Sem conexão com o Stalwart (${err instanceof Error ? err.message : String(err)}).`,
      );
    }

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      let payload: ApiEnvelope | null = null;
      try {
        payload = JSON.parse(text) as ApiEnvelope;
      } catch {
        // resposta sem corpo JSON
      }
      const detail = payload?.detail ?? payload?.title ?? `HTTP ${res.status}`;
      throw new StalwartApiError(res.status, `Stalwart: ${detail}`);
    }
    return text;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const text = await this.call(method, path, body);
    try {
      return (JSON.parse(text) as ApiEnvelope | null)?.data;
    } catch {
      // resposta sem corpo JSON
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Domínios
  // -------------------------------------------------------------------------

  async createDomain(domain: string): Promise<void> {
    await this.request("POST", "/principal", { type: "domain", name: domain });
  }

  async deleteDomain(domain: string): Promise<void> {
    await this.request("DELETE", `/principal/${encodeURIComponent(domain)}`);
  }

  /** Gera o par DKIM RSA 2048 no servidor. Idempotente por domínio. */
  async createDkimSignature(domain: string, selector = DKIM_SELECTOR): Promise<string> {
    const id = `rsa-${domain}`;
    try {
      await this.request("POST", "/dkim", { algorithm: "Rsa", domain, selector, id });
    } catch (err) {
      // Já existe (ex.: domínio recriado) — segue com a chave existente.
      if (!(err instanceof StalwartApiError && err.status === 400)) throw err;
    }
    return id;
  }

  /** Chave pública DKIM em base64 (valor do parâmetro p= do TXT). */
  async getDkimPublicKey(signatureId: string): Promise<string> {
    const data = await this.request("GET", `/dkim/${encodeURIComponent(signatureId)}`);
    if (typeof data !== "string" || data.length < 100) {
      throw new StalwartApiError(500, "Stalwart retornou uma chave DKIM inválida.");
    }
    return data;
  }

  /**
   * Como getDkimPublicKey, mas devolve null quando o Stalwart diz que a
   * assinatura NÃO existe (404, ou resposta sem chave). Qualquer outra falha
   * (401, rede, 5xx) sobe: quem lê não deve criar uma chave por causa dela.
   */
  async findDkimPublicKey(signatureId: string): Promise<string | null> {
    let text: string;
    try {
      text = await this.call("GET", `/dkim/${encodeURIComponent(signatureId)}`);
    } catch (err) {
      if (err instanceof StalwartApiError && err.status === 404) return null;
      throw err;
    }
    let data: unknown;
    try {
      data = (JSON.parse(text) as ApiEnvelope | null)?.data;
    } catch {
      data = undefined;
    }
    if (data === undefined || data === null) return null;
    if (typeof data !== "string" || data.length < 100) {
      throw new StalwartApiError(500, "Stalwart retornou uma chave DKIM inválida.");
    }
    return data;
  }

  // -------------------------------------------------------------------------
  // Caixas (principals "individual")
  // -------------------------------------------------------------------------

  async createMailbox(email: string, password: string, extraEmails: string[] = []): Promise<void> {
    await this.request("POST", "/principal", {
      type: "individual",
      name: email,
      secrets: [password],
      emails: [email, ...extraEmails],
      quota: 0,
      // Sem o papel "user" o Stalwart autentica mas nega SMTP/IMAP
      // ("Your account is not authorized to use this service").
      roles: ["user"],
    });
  }

  /** Troca a senha da caixa (o Stalwart guarda só o hash). */
  async setMailboxPassword(email: string, password: string): Promise<void> {
    await this.request("PATCH", `/principal/${encodeURIComponent(email)}`, [
      { action: "set", field: "secrets", value: [password] },
    ]);
  }

  /**
   * Endereço extra da caixa (alias). O Stalwart só deixa a caixa autenticada
   * enviar como endereços que são dela — é assim que o projeto envia como
   * "nao-responda@" usando a caixa técnica.
   */
  async addMailboxAlias(email: string, alias: string): Promise<void> {
    await this.request("PATCH", `/principal/${encodeURIComponent(email)}`, [
      { action: "addItem", field: "emails", value: alias },
    ]);
  }

  /**
   * Endereços da caixa (o principal e os aliases), em minúsculas. O Stalwart
   * devolve `emails` como lista ou, com um endereço só, como texto.
   */
  async mailboxEmails(email: string): Promise<string[]> {
    const data = (await this.request("GET", `/principal/${encodeURIComponent(email)}`)) as {
      emails?: string | string[];
    } | null;
    const emails = data?.emails;
    const list = typeof emails === "string" ? [emails] : Array.isArray(emails) ? emails : [];
    return list.map((e) => e.toLowerCase());
  }

  /**
   * A senha guardada pelo painel é a que a caixa tem no Stalwart? A comparação é feita aqui, em memória: a senha
   * que o servidor devolve nunca sai deste método. `true`/`false` quando o servidor devolve a senha em texto
   * (v0.11.8); `null` quando não dá para comparar (sem o campo, lista vazia ou só hash). Erro HTTP sobe.
   */
  async mailboxPasswordMatches(email: string, password: string): Promise<boolean | null> {
    const data = (await this.request("GET", `/principal/${encodeURIComponent(email)}`)) as {
      secrets?: string | string[];
    } | null;
    const raw = data?.secrets;
    const secrets = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
    if (secrets.includes(password)) return true;
    if (secrets.length === 0 || secrets.some((s) => HASHED_SECRET_RE.test(s))) return null;
    return false;
  }

  async removeMailboxAlias(email: string, alias: string): Promise<void> {
    await this.request("PATCH", `/principal/${encodeURIComponent(email)}`, [
      { action: "removeItem", field: "emails", value: alias },
    ]);
  }

  async deleteMailbox(email: string): Promise<void> {
    await this.request("DELETE", `/principal/${encodeURIComponent(email)}`);
  }

  /** Lista endereços de e-mail de principals "individual" de um domínio. */
  async listMailboxes(domain: string): Promise<string[]> {
    const data = (await this.request(
      "GET",
      `/principal?type=individual&filter=${encodeURIComponent(`@${domain}`)}&limit=1000`,
    )) as { items?: Array<{ name?: string }> } | null;
    return (data?.items ?? [])
      .map((item) => item.name ?? "")
      .filter((name) => name.endsWith(`@${domain}`));
  }

  /**
   * Domínios ou caixas que o Stalwart tem (GET /api/principal?type=…), para o
   * painel cadastrar o que veio de um backup. Devolve só nome e endereços: a
   * resposta traz `secrets` (hash/senhas da caixa) e o resto, que NUNCA sai
   * daqui — cada item é montado campo a campo.
   */
  async listPrincipals(type: "domain" | "individual"): Promise<StalwartPrincipalSummary[]> {
    return (await this.listPrincipalsChecked(type)).items;
  }

  /** Como listPrincipals, e diz se havia MAIS que PRINCIPAL_LIST_MAX (a página seguinte ao teto não veio vazia). */
  async listPrincipalsChecked(type: "domain" | "individual"): Promise<{ items: StalwartPrincipalSummary[]; truncated: boolean }> {
    const limit = 500;
    const out: StalwartPrincipalSummary[] = [];
    for (let page = 1; page <= PRINCIPAL_LIST_PAGES + 1; page += 1) {
      const data = (await this.request("GET", `/principal?type=${type}&limit=${limit}&page=${page}`)) as {
        items?: unknown[];
      } | null;
      const items = Array.isArray(data?.items) ? data!.items : [];
      if (page > PRINCIPAL_LIST_PAGES) return { items: out, truncated: items.length > 0 };
      for (const item of items) {
        const raw = typeof item === "string" ? { name: item } : (item as { name?: unknown; emails?: unknown } | null);
        const name = typeof raw?.name === "string" ? raw.name.trim().toLowerCase() : "";
        if (!name) continue;
        const emails = (raw as { emails?: unknown }).emails;
        const list = typeof emails === "string" ? [emails] : Array.isArray(emails) ? emails : [];
        out.push({ name, emails: list.filter((e): e is string => typeof e === "string").map((e) => e.toLowerCase()) });
      }
      if (items.length < limit) break;
    }
    return { items: out, truncated: false };
  }

  // -------------------------------------------------------------------------
  // IP isento do bloqueio automático (webmail)
  // -------------------------------------------------------------------------

  /**
   * Isenta `ip` do bloqueio automático (server.allowed-ip), desfaz um
   * bloqueio já feito dele (server.blocked-ip) e tira a isenção do IP
   * anterior. Conferido no Stalwart v0.11.8 real: grava no banco e vale
   * depois de GET /api/reload, sem reiniciar. Usado para o webmail, de onde
   * chegam os logins de todos os visitantes (ver webmail.ts).
   */
  async exemptIp(ip: string, previousIp: string | null): Promise<void> {
    assertIp(ip);
    const remove = [
      ...(previousIp && previousIp !== ip && isIP(previousIp) ? [`server.allowed-ip.${previousIp}`] : []),
      `server.blocked-ip.${ip}`,
    ];
    await this.request("POST", "/settings", [
      { type: "delete", keys: remove },
      { type: "insert", prefix: null, values: [[`server.allowed-ip.${ip}`, ""]], assert_empty: false },
    ]);
    await this.request("GET", "/reload");
  }

  async removeIpExemption(ip: string): Promise<void> {
    assertIp(ip);
    await this.request("POST", "/settings", [{ type: "delete", keys: [`server.allowed-ip.${ip}`] }]);
    await this.request("GET", "/reload");
  }

  // -------------------------------------------------------------------------
  // Fila de saída
  // -------------------------------------------------------------------------

  /**
   * Mensagens na fila cujo remetente ou destinatário contém `text`. O
   * Stalwart compara com o endereço do destinatário em minúsculas
   * (`address_lcase.contains`), por isso o texto vai em minúsculas.
   */
  async listQueuedMessages(text: string): Promise<QueuedMessage[]> {
    const data = (await this.request(
      "GET",
      `/queue/messages?values=1&text=${encodeURIComponent(text.toLowerCase())}`,
    )) as { items?: unknown[] } | null;
    return (data?.items ?? []).filter((item): item is QueuedMessage => typeof item === "object" && item !== null);
  }

  /**
   * A fila inteira (até `limit` mensagens), com o id preservado como texto
   * (u64 — o JSON.parse comum arredondaria). Página Envios → Fila agora.
   */
  async listQueue(limit = 200): Promise<{ items: QueueMessageRaw[]; total: number }> {
    return parseQueueResponse(await this.call("GET", `/queue/messages?values=1&limit=${limit}`));
  }

  /**
   * "Tentar agora": PATCH /api/queue/messages/{id}. ATENÇÃO (conferido no
   * código da v0.11.8 e num Stalwart real): além de marcar a tentativa para
   * agora, o Stalwart encurta o prazo da mensagem para 10 s depois. Se essa
   * tentativa falhar de novo, ele desiste e devolve o aviso de falha ao
   * remetente. Por isso a página chama de "última tentativa".
   * true = havia domínio pendente para tentar.
   */
  async retryQueuedMessage(id: string): Promise<boolean> {
    if (!isQueueId(id)) throw new StalwartApiError(400, "Id de fila inválido.");
    return (await this.request("PATCH", `/queue/messages/${id}`)) === true;
  }

  /**
   * "Cancelar": DELETE /api/queue/messages/{id} (sem filtro): a mensagem sai
   * da fila sem nova tentativa e sem aviso ao remetente.
   */
  async cancelQueuedMessage(id: string): Promise<boolean> {
    if (!isQueueId(id)) throw new StalwartApiError(400, "Id de fila inválido.");
    return (await this.request("DELETE", `/queue/messages/${id}`)) === true;
  }
}
