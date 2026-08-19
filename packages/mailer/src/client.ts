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
 * Auth: HTTP Basic com o fallback-admin (admin:<secret>).
 */
import { DKIM_SELECTOR } from "@paas/core";

export class StalwartApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "StalwartApiError";
  }
}

interface ApiEnvelope {
  data?: unknown;
  status?: number;
  title?: string;
  detail?: string;
}

export class StalwartClient {
  private readonly authHeader: string;

  constructor(
    private readonly baseUrl: string,
    user: string,
    secret: string,
  ) {
    this.authHeader = `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
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

    let payload: ApiEnvelope | null = null;
    try {
      payload = (await res.json()) as ApiEnvelope;
    } catch {
      // resposta sem corpo JSON
    }
    if (!res.ok) {
      const detail = payload?.detail ?? payload?.title ?? `HTTP ${res.status}`;
      throw new StalwartApiError(res.status, `Stalwart: ${detail}`);
    }
    return payload?.data;
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
}
