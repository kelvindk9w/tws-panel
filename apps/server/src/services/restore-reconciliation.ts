/**
 * restore-reconciliation.ts — depois de restaurar um backup, compara o que o
 * painel antigo tinha ATIVO com o que roda de fato nesta VPS.
 *
 * Causa raiz (ver comoFuncionaSistema/_RELATORIO-reconciliacao-restauracao.md):
 * o backup do painel traz data/mail/webmail.json com `enabled: true`, mas o
 * container do webmail (e o do servidor de e-mail) não vêm junto: nascem de
 * novo na VPS nova. A flag restaurada passava por "o webmail está ativo" e a
 * tela da restauração marcava com um check o passo "Restaurar o webmail", que
 * só devolve os DADOS do volume. A fonte da verdade aqui é o Docker.
 *
 * Regras:
 *  - só INFORMA e oferece a ação (ativar webmail ou e-mail mexe em portas,
 *    DNS e certificados): nada sobe sozinho;
 *  - a pendência fica em data/restore-reconciliation.json (um reinício do
 *    painel mantém) até ser resolvida — sozinha, quando o serviço passa a
 *    rodar — ou dispensada;
 *  - "não deu para conferir" (Docker ou DNS sem resposta) nunca resolve nem
 *    some: continua pendente com status `unknown`;
 *  - a lista é calculada na hora a partir do Docker; o arquivo guarda só o
 *    que o backup dizia estar ativo.
 */
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { RECONCILIATION_IDS, type ReconciliationId, type ReconciliationItem, type ReconciliationResponse } from "@paas/core";
import { httpError } from "./http-error.js";
import { JsonFile, writeFileAtomic } from "./json-file.js";

export type ContainerProbe = "running" | "stopped" | "missing";

export type MailAuthProbe = "ok" | "mismatch" | "unreachable" | "not_running";
export type MailAuthRepair = "ok" | "repaired" | "failed" | "unreachable" | "not_running";

export interface ReconciliationProbes {
  /** A senha de administração do painel autentica no Stalwart em execução? Ver MailService.checkAdminAuth. */
  mailAuth?(): Promise<MailAuthProbe>;
  /** Reaplica a configuração do Stalwart com a senha do painel. Ver MailService.repairAdminAuth. */
  repairMailAuth?(): Promise<MailAuthRepair>;
  /** Estado do container; LANÇA quando o Docker não respondeu (diferente de "não existe"). */
  container(name: string): Promise<ContainerProbe>;
  /** O domínio já aponta (DNS) para esta VPS? Lança se não deu para conferir. */
  panelDomainPointsHere?(domain: string): Promise<boolean>;
}

export interface RestoreReconciliationOptions {
  dataDir: string;
  containers: { stalwart: string; webmail: string };
  probes: ReconciliationProbes;
  now?: () => number;
  log?: (message: string) => void;
}

type Source = "panel" | "email";
type State = "open" | "resolved" | "dismissed";

interface StoredItem {
  id: ReconciliationId;
  state: State;
  source: Source;
  since: string;
  closedAt: string | null;
  /** Só em panel-domain: o domínio que o painel antigo tinha ativo. */
  domain?: string;
}

interface StoredFile {
  items: StoredItem[];
}

export const RECONCILIATION_FILE = "restore-reconciliation.json";

/** O DNS não é consultado a cada pedido da tela. */
const DNS_TTL_MS = 5 * 60_000;

function parseFile(raw: unknown): StoredFile | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  const valid: StoredItem[] = [];
  for (const it of items) {
    if (typeof it !== "object" || it === null) continue;
    const o = it as Partial<StoredItem>;
    if (!RECONCILIATION_IDS.includes(o.id as ReconciliationId)) continue;
    if (o.state !== "open" && o.state !== "resolved" && o.state !== "dismissed") continue;
    valid.push({
      id: o.id as ReconciliationId,
      state: o.state,
      source: o.source === "email" ? "email" : "panel",
      since: typeof o.since === "string" ? o.since : "",
      closedAt: typeof o.closedAt === "string" ? o.closedAt : null,
      ...(typeof o.domain === "string" ? { domain: o.domain } : {}),
    });
  }
  return { items: valid };
}

async function readJsonObject(file: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class RestoreReconciliation {
  private readonly store: JsonFile<StoredFile>;
  private readonly now: () => number;
  private readonly dnsCache = new Map<string, { at: number; value: boolean }>();

  constructor(private readonly opts: RestoreReconciliationOptions) {
    this.store = new JsonFile<StoredFile>(path.join(opts.dataDir, RECONCILIATION_FILE), {
      empty: () => ({ items: [] }),
      parse: parseFile,
    });
    this.now = opts.now ?? Date.now;
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  // -------------------------------------------------------------------------
  // Restauração do painel: compara o backup (pasta preparada) com esta VPS
  // -------------------------------------------------------------------------

  /**
   * Chamado com a pasta que vai ENTRAR no lugar do diretório de dados (nunca
   * com o backup original). Grava nela o arquivo de pendências desta
   * restauração (ou apaga o que veio no backup, se não há nenhuma) e, no
   * webmail, troca a flag "ativo" que não corresponde a container nenhum.
   * Nunca lança: cada conferência falha sozinha. Devolve os avisos (pt-BR)
   * para o resultado da restauração.
   */
  async planStaged(staged: string): Promise<string[]> {
    const warnings: string[] = [];
    const items: StoredItem[] = [];
    const since = this.stamp();
    const add = (item: Omit<StoredItem, "state" | "source" | "since" | "closedAt">): void => {
      items.push({ ...item, state: "open", source: "panel", since, closedAt: null });
    };

    // Webmail
    try {
      const file = path.join(staged, "mail", "webmail.json");
      const webmail = await readJsonObject(file);
      if (webmail?.["enabled"] === true) {
        const state = await this.probe(this.opts.containers.webmail);
        if (state === "running") {
          // já roda aqui: tudo certo, nada a perguntar
        } else if (state === "unknown") {
          add({ id: "webmail" });
          warnings.push(
            "O painel antigo tinha o webmail ativo e não foi possível conferir se ele roda nesta VPS (o Docker não respondeu). O painel vai lembrar disso até você conferir em E-mail → Webmail ou dispensar o aviso.",
          );
        } else {
          if (state === "missing") {
            // A flag restaurada dizia "ativo" sem container nenhum: o estado que entra no lugar passa a dizer a verdade.
            await writeFileAtomic(file, JSON.stringify({ ...webmail, enabled: false }, null, 2) + "\n", { mode: 0o600 });
          }
          add({ id: "webmail" });
          warnings.push(
            "O painel antigo tinha o webmail ativo e ele não está rodando nesta VPS. Nada foi ativado: depois do reinício o painel pergunta se você quer ativá-lo (E-mail → Webmail).",
          );
        }
      }
    } catch (err) {
      this.opts.log?.(`Reconciliação: não deu para conferir o webmail (${reasonOf(err)}).`);
    }

    // Servidor de e-mail
    try {
      const mail = await readJsonObject(path.join(staged, "mail", "mail.json"));
      if (typeof mail?.["adminSecret"] === "string" && mail["adminSecret"] !== "") {
        const state = await this.probe(this.opts.containers.stalwart);
        if (state === "unknown") {
          add({ id: "mail-server" });
          warnings.push(
            "O painel antigo tinha o servidor de e-mail e não foi possível conferir se ele roda nesta VPS (o Docker não respondeu). O painel vai lembrar disso até você conferir em E-mail ou dispensar o aviso.",
          );
        } else if (state === "running") {
          // O mail.json do backup traz a senha de administração do servidor ANTIGO; o container que já roda aqui tem outra.
          add({ id: "mail-auth" });
        } else {
          add({ id: "mail-server" });
          warnings.push(
            "O painel antigo tinha o servidor de e-mail e ele não está rodando nesta VPS. Nada foi ligado: depois do reinício o painel pergunta se você quer iniciá-lo (E-mail → Iniciar).",
          );
        }
      }
    } catch (err) {
      this.opts.log?.(`Reconciliação: não deu para conferir o servidor de e-mail (${reasonOf(err)}).`);
    }

    // Domínio do painel
    try {
      const panel = await readJsonObject(path.join(staged, "panel-domain.json"));
      const domain = panel?.["domain"];
      if (typeof domain === "string" && domain !== "" && panel?.["active"] === true) {
        let points: boolean | null = null;
        try {
          points = this.opts.probes.panelDomainPointsHere ? await this.opts.probes.panelDomainPointsHere(domain) : null;
        } catch {
          points = null;
        }
        if (points !== true) {
          add({ id: "panel-domain", domain });
          warnings.push(
            points === null
              ? "O painel antigo abria por um domínio próprio e não foi possível conferir se o DNS dele já aponta para esta VPS. O painel vai lembrar disso até você conferir em Configurações → Domínio do painel ou dispensar o aviso."
              : "O painel antigo abria por um domínio próprio, e o DNS dele ainda não aponta para esta VPS. Aponte o registro A para cá e confira em Configurações → Domínio do painel.",
          );
        }
      }
    } catch (err) {
      this.opts.log?.(`Reconciliação: não deu para conferir o domínio do painel (${reasonOf(err)}).`);
    }

    const target = path.join(staged, RECONCILIATION_FILE);
    try {
      if (items.length === 0) await rm(target, { force: true });
      else await writeFileAtomic(target, JSON.stringify({ items }, null, 2) + "\n", { mode: 0o600 });
    } catch (err) {
      this.opts.log?.(`Reconciliação: não deu para gravar as pendências (${reasonOf(err)}).`);
      warnings.push(`Não foi possível guardar a lista do que o painel antigo tinha ativo (${reasonOf(err)}). Confira à mão: webmail, servidor de e-mail e domínio do painel.`);
    }
    return warnings;
  }

  private async probe(container: string): Promise<ContainerProbe | "unknown"> {
    try {
      return await this.opts.probes.container(container);
    } catch {
      return "unknown";
    }
  }

  // -------------------------------------------------------------------------
  // Restauração do e-mail (e outros fluxos que só sabem o que ficou faltando)
  // -------------------------------------------------------------------------

  /** Abre a pendência (ou reabre uma já resolvida ou dispensada: é uma restauração nova). */
  async markPending(ids: ReconciliationId[], source: Source): Promise<void> {
    await this.store.update((current) => {
      const items = [...current.items];
      for (const id of ids) {
        const at = items.findIndex((i) => i.id === id);
        const open: StoredItem = { id, state: "open", source, since: this.stamp(), closedAt: null };
        if (at === -1) items.push(open);
        else if (items[at]!.state !== "open") items[at] = open;
      }
      return { items };
    });
  }

  // -------------------------------------------------------------------------
  // A lista
  // -------------------------------------------------------------------------

  /** Pendências em aberto, conferidas AGORA no Docker; as que já rodam são marcadas como resolvidas. */
  async list(): Promise<ReconciliationResponse> {
    const stored = await this.store.read();
    const open = stored.items.filter((i) => i.state === "open");
    if (open.length === 0) return { items: [] };
    const evaluated = await Promise.all(open.map(async (item) => ({ item, status: await this.evaluate(item) })));
    const resolved = evaluated.filter((e) => e.status === "resolved").map((e) => e.item.id);
    if (resolved.length > 0) {
      await this.store.update((current) => ({
        items: current.items.map((i) => (i.state === "open" && resolved.includes(i.id) ? { ...i, state: "resolved", closedAt: this.stamp() } : i)),
      }));
    }
    const items: ReconciliationItem[] = [];
    for (const { item, status } of evaluated) {
      if (status === "resolved") continue;
      items.push({ id: item.id, status, source: item.source, since: item.since });
    }
    return { items };
  }

  private async evaluate(item: StoredItem): Promise<"resolved" | "pending" | "unknown"> {
    if (item.id === "panel-domain") return this.evaluateDomain(item);
    if (item.id === "mail-auth") return this.evaluateMailAuth();
    const name = item.id === "webmail" ? this.opts.containers.webmail : this.opts.containers.stalwart;
    const state = await this.probe(name);
    if (state === "unknown") return "unknown";
    return state === "running" ? "resolved" : "pending";
  }

  private async evaluateMailAuth(): Promise<"resolved" | "pending" | "unknown"> {
    if (!this.opts.probes.mailAuth) return "unknown";
    try {
      const result = await this.opts.probes.mailAuth();
      if (result === "mismatch") return "pending";
      return result === "unreachable" ? "unknown" : "resolved";
    } catch {
      return "unknown";
    }
  }

  /**
   * Na subida do painel: se há pendência de autenticação aberta, tenta
   * reaplicar a configuração do servidor de e-mail (reinício do container, sem
   * apagar dados). Falha não derruba nada: a pendência continua na tela com a
   * ação. Devolve o resultado, ou null quando não havia o que fazer.
   */
  async repairOpen(): Promise<MailAuthRepair | null> {
    const stored = await this.store.read();
    if (!stored.items.some((i) => i.id === "mail-auth" && i.state === "open")) return null;
    if (!this.opts.probes.repairMailAuth) return null;
    try {
      return await this.opts.probes.repairMailAuth();
    } catch (err) {
      this.opts.log?.(`Reconciliação: não deu para reaplicar a configuração do servidor de e-mail (${reasonOf(err)}).`);
      return null;
    }
  }

  private async evaluateDomain(item: StoredItem): Promise<"resolved" | "pending" | "unknown"> {
    const domain = item.domain ?? null;
    if (!domain) return "resolved";
    // O domínio saiu do painel: não há o que apontar.
    const live = await readJsonObject(path.join(this.opts.dataDir, "panel-domain.json"));
    if (live && live["domain"] !== domain) return "resolved";
    const points = this.opts.probes.panelDomainPointsHere;
    if (!points) return "unknown";
    const cached = this.dnsCache.get(domain);
    if (cached && this.now() - cached.at < DNS_TTL_MS) return cached.value ? "resolved" : "pending";
    try {
      const value = await points(domain);
      this.dnsCache.set(domain, { at: this.now(), value });
      return value ? "resolved" : "pending";
    } catch {
      return "unknown";
    }
  }

  /** "Dispensar": a pessoa não quer mais ser lembrada. */
  async dismiss(id: string): Promise<ReconciliationResponse> {
    let found = false;
    await this.store.update((current) => ({
      items: current.items.map((i) => {
        if (i.id !== id || i.state !== "open") return i;
        found = true;
        return { ...i, state: "dismissed", closedAt: this.stamp() };
      }),
    }));
    if (!found) throw httpError(404, "reconciliation_not_found", "Esse aviso não existe mais.");
    return this.list();
  }
}
