/**
 * mail-envios-service.ts — página Envios: a fila do servidor de e-mail agora,
 * o histórico de entregas, o volume por dia e por projeto e as taxas.
 *
 * De onde vem o histórico: o Stalwart 0.11.8 tira a mensagem da fila quando
 * termina e o histórico de rastreio dele é da edição Enterprise. O painel lê
 * o registro do container (`docker logs --since`) a cada 5 min e guarda só o
 * resumo de cada entrega (envelope, resultado, código e resposta do servidor
 * do destinatário) em data/mail/envios/AAAA-MM-DD.jsonl, por 30 dias. O
 * conteúdo das mensagens nunca passa por aqui. Detalhes em
 * packages/mailer/src/delivery-log.ts e comoFuncionaSistema/email/envios.json.
 *
 * Nada se perde numa leitura que falha: cada coleta trabalha numa CÓPIA do
 * leitor do registro e só fica com ela depois de gravar os eventos e o
 * cursor. Se algo falha no meio, a próxima coleta relê do mesmo ponto com o
 * leitor de antes e gera os mesmos eventos; os que já tinham chegado ao
 * arquivo do dia não se repetem (linha idêntica conta uma vez só na leitura).
 * O estado (cursor, primeiro envio) só muda em fila e com gravação atômica:
 * o cancelamento pelo painel e a coleta não desfazem a gravação um do outro.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type {
  MailDeliveryEvent,
  MailDeliveryState,
  MailHistoryItem,
  MailHistoryResponse,
  MailQueueActionResponse,
  MailQueueResponse,
  MailRate,
  MailRefusal,
  MailRefusalsResponse,
  MailSenderInfo,
  MailVolumeDay,
  MailVolumeProject,
  MailVolumeResponse,
} from "@paas/core";
import {
  DeliveryLogReader,
  isDeliveryLogLine,
  isQueueId,
  isRefusalLogLine,
  parseRefusalLine,
  queueItemFromMessage,
  StalwartApiError,
  type MailNetwork,
  type QueueMessageRaw,
} from "@paas/mailer";
import { mailAuthError } from "./mail-auth-error.js";
import { MailRefusalStore } from "./mail-refusal-store.js";
import { httpError } from "./http-error.js";
import { loadJson, loadJsonInLock, withFileLock, writeFileAtomic } from "./json-file.js";

export interface SenderEntry {
  address: string;
  mailbox: string;
  projectId: string | null;
  system: boolean;
}

export interface MailEnviosDeps {
  dataDir: string;
  /** O servidor de e-mail já foi criado? (sem ele não há fila nem registro) */
  serverCreated(): Promise<boolean>;
  listQueue(): Promise<{ items: QueueMessageRaw[]; total: number }>;
  retry(id: string): Promise<boolean>;
  cancel(id: string): Promise<boolean>;
  senders(): Promise<SenderEntry[]>;
  projectNames(): Promise<Map<string, string>>;
  /**
   * O teste "Testar conexão a partir do app" deste projeto estava rodando nesse instante? As recusas que ele
   * mesmo causa (senha errada de propósito, TLS) não são tentativas do app e não entram na lista.
   */
  isProbe?(projectId: string, atMs: number): boolean;
  /**
   * Sub-redes e gateways das redes do e-mail (para separar app de internet; ver mail-networks.ts). null/ausente =
   * não deu para consultar: vale o plano B por faixa privada.
   */
  internalNetworks?(): Promise<MailNetwork[] | null>;
  /** Linhas do registro do Stalwart desde `since` (null = desde o começo da retenção). */
  readLogs(since: Date | null, onLine: (line: string) => void): Promise<void>;
  /**
   * Chamado com os eventos novos de entrega (registro de envios por SMTP).
   * Falha aqui nunca derruba a coleta.
   */
  onEvents?: (events: MailDeliveryEvent[]) => Promise<void>;
  now?: () => number;
  retentionDays?: number;
}

export interface HistoryFilter {
  /** Período em dias (1 a 30). */
  days: number;
  state?: MailDeliveryState;
  /** Id do projeto, ou "none" = sem projeto. */
  projectId?: string;
  mailbox?: string;
  /** Domínio do destinatário. */
  domain?: string;
  q?: string;
  limit?: number;
  offset?: number;
  /** Ler o registro antes, se a última leitura tiver mais de 1 min. */
  refresh?: boolean;
}

interface EnviosState {
  cursor: { at: string | null; hashes: string[] };
  firstEventAt: string | null;
  collectedAt: string | null;
  collectError: string | null;
}

const EMPTY_STATE: EnviosState = { cursor: { at: null, hashes: [] }, firstEventAt: null, collectedAt: null, collectError: null };

const DAY = 86_400_000;
const FIRST_COLLECT_MS = 60_000;
const COLLECT_EVERY_MS = 5 * 60_000;
const REFRESH_AFTER_MS = 60_000;
/** Folga ao pedir o registro desde a última linha (relógio do Docker x do Stalwart). */
const SINCE_SLACK_MS = 10_000;
const BOUNCE_LIMIT = 0.02;
const DEFER_LIMIT = 0.05;
const LOW_VOLUME = 50;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

function hashLine(line: string): string {
  return createHash("sha1").update(line).digest("hex").slice(0, 16);
}

function rate(num: number, den: number, limit: number): MailRate {
  if (den === 0) return { value: null, limit, high: false };
  const value = num / den;
  return { value, limit, high: value > limit };
}

function stalwartError(err: unknown): never {
  const auth = mailAuthError(err);
  if (auth) throw auth;
  if (err instanceof StalwartApiError) {
    if (err.status === 404) {
      throw httpError(404, "queue_message_not_found", "Essa mensagem já saiu da fila (foi entregue, recusada ou cancelada).");
    }
    if (err.status === 0) throw httpError(502, "mail_unreachable", err.message);
  }
  throw err;
}

export class MailEnviosService {
  private readonly dir: string;
  private readonly stateFile: string;
  private readonly now: () => number;
  private readonly retentionDays: number;
  /** Leitor do registro confirmado: só avança quando a coleta foi gravada. */
  private reader = new DeliveryLogReader();
  private collecting: Promise<{ added: number }> | null = null;
  /** Tentativas recusadas antes da fila (senha errada, TLS, remetente): lidas do mesmo registro. */
  private readonly refusalStore: MailRefusalStore;
  /** Última vez que a tela pediu leitura (sucesso ou não): limita a 1 por minuto mesmo com o Stalwart fora. */
  private lastRefreshTry: number | null = null;
  private timers: Array<ReturnType<typeof setTimeout>> = [];

  constructor(private readonly deps: MailEnviosDeps) {
    this.dir = path.join(deps.dataDir, "mail", "envios");
    this.stateFile = path.join(this.dir, "estado.json");
    this.now = deps.now ?? Date.now;
    this.retentionDays = deps.retentionDays ?? 30;
    this.refusalStore = new MailRefusalStore({ dir: path.join(this.dir, "recusas"), now: this.now, retentionDays: this.retentionDays });
  }

  // -------------------------------------------------------------------------
  // Agendamento
  // -------------------------------------------------------------------------

  start(): void {
    const tick = () => void this.collect().catch(() => undefined);
    const first = setTimeout(() => {
      tick();
      const every = setInterval(tick, COLLECT_EVERY_MS);
      every.unref?.();
      this.timers.push(every);
    }, FIRST_COLLECT_MS);
    first.unref?.();
    this.timers.push(first);
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  // -------------------------------------------------------------------------
  // Remetentes
  // -------------------------------------------------------------------------

  private async senderLookup(): Promise<(address: string) => MailSenderInfo> {
    const [entries, names] = await Promise.all([this.deps.senders(), this.deps.projectNames()]);
    const map = new Map(entries.map((e) => [e.address.toLowerCase(), e]));
    return (address) => {
      if (!address) return { address: "", mailbox: null, projectId: null, projectName: null, system: true };
      const e = map.get(address.toLowerCase());
      if (!e) return { address, mailbox: null, projectId: null, projectName: null, system: false };
      return {
        address,
        mailbox: e.mailbox,
        projectId: e.projectId,
        projectName: e.projectId ? (names.get(e.projectId) ?? null) : null,
        system: e.system,
      };
    };
  }

  // -------------------------------------------------------------------------
  // Fila agora
  // -------------------------------------------------------------------------

  async queue(): Promise<MailQueueResponse> {
    const checkedAt = new Date(this.now()).toISOString();
    if (!(await this.deps.serverCreated())) {
      return {
        available: false,
        message: "O servidor de e-mail ainda não foi criado. Inicie-o na página E-mail.",
        items: [],
        total: 0,
        checkedAt,
      };
    }
    try {
      const [{ items, total }, sender] = await Promise.all([this.deps.listQueue(), this.senderLookup()]);
      return {
        available: true,
        message: null,
        items: items.map((m) => {
          const { from, ...view } = queueItemFromMessage(m);
          return { ...view, sender: sender(from) };
        }),
        total,
        checkedAt,
      };
    } catch (err) {
      return {
        available: false,
        message: mailAuthError(err)?.message ?? `Não deu para ler a fila do servidor de e-mail: ${err instanceof Error ? err.message : String(err)}`,
        items: [],
        total: 0,
        checkedAt,
      };
    }
  }

  private requireId(id: string): void {
    if (!isQueueId(id)) throw httpError(400, "invalid_queue_id", "Id de mensagem inválido.");
  }

  async retry(id: string): Promise<MailQueueActionResponse> {
    this.requireId(id);
    const ok = await this.deps.retry(id).catch(stalwartError);
    if (!ok) throw httpError(404, "queue_message_not_found", "Essa mensagem não tem mais nada pendente na fila.");
    return {
      ok: true,
      message: "Tentando entregar agora. Se o destino recusar de novo, o servidor desiste e avisa o remetente.",
    };
  }

  async cancel(id: string): Promise<MailQueueActionResponse> {
    this.requireId(id);
    // Destinatários ainda pendentes, para o histórico mostrar o cancelamento.
    const before = await this.deps
      .listQueue()
      .then((q) => q.items.find((m) => m.id === id))
      .catch(() => undefined);
    const ok = await this.deps.cancel(id).catch(stalwartError);
    if (!ok) throw httpError(404, "queue_message_not_found", "Essa mensagem já saiu da fila.");
    if (before) {
      const view = queueItemFromMessage(before);
      const at = new Date(this.now()).toISOString();
      const events: MailDeliveryEvent[] = view.recipients
        .filter((r) => r.state === "waiting" || r.state === "deferred")
        .map((r) => ({
          at,
          queueId: id,
          from: view.from,
          to: r.address.toLowerCase(),
          toDomain: r.domain,
          state: "cancelled",
          code: null,
          detail: "Cancelada no painel.",
          remoteHost: null,
          nextRetryAt: null,
        }));
      await this.append(events);
    }
    return { ok: true, message: "Mensagem tirada da fila. Ela não será mais enviada." };
  }

  // -------------------------------------------------------------------------
  // Leitura do registro
  // -------------------------------------------------------------------------

  /** Erro de leitura é lançado (o registro não é regravado vazio); arquivo ruim vai para o lado. */
  private loadState(inLock = false): Promise<EnviosState> {
    return (inLock ? loadJsonInLock : loadJson)<EnviosState>(this.stateFile, {
      empty: () => structuredClone(EMPTY_STATE),
      parse: (value) =>
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? { ...structuredClone(EMPTY_STATE), ...(value as Partial<EnviosState>) }
          : null,
    });
  }

  /** Lê, altera e grava o estado numa fila só (e gravação atômica). */
  private async updateState(change: (state: EnviosState) => void): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await withFileLock(this.stateFile, async () => {
      const state = await this.loadState(true);
      change(state);
      await writeFileAtomic(this.stateFile, JSON.stringify(state, null, 2) + "\n");
    });
  }

  private async append(events: MailDeliveryEvent[]): Promise<void> {
    if (events.length === 0) return;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const byDay = new Map<string, string[]>();
    for (const e of events) {
      const day = e.at.slice(0, 10);
      byDay.set(day, [...(byDay.get(day) ?? []), JSON.stringify(e)]);
    }
    for (const [day, lines] of byDay) {
      await appendFile(path.join(this.dir, `${day}.jsonl`), lines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
    }
    const first = events.map((e) => e.at).sort()[0]!;
    await this.updateState((state) => {
      if (!state.firstEventAt || first < state.firstEventAt) state.firstEventAt = first;
    });
    await this.deps.onEvents?.(events).catch(() => undefined);
  }

  /** Lê o registro novo do Stalwart e guarda os eventos. Uma leitura por vez. */
  collect(): Promise<{ added: number }> {
    this.collecting ??= this.doCollect().finally(() => {
      this.collecting = null;
    });
    return this.collecting;
  }

  private async doCollect(): Promise<{ added: number }> {
    if (!(await this.deps.serverCreated())) return { added: 0 };
    const state = await this.loadState();
    const cursorMs = state.cursor.at ? Date.parse(state.cursor.at) : null;
    const seen = new Set(state.cursor.hashes);
    let maxMs = cursorMs;
    let maxHashes = new Set(seen);
    const events: MailDeliveryEvent[] = [];
    const refused: MailRefusal[] = [];
    const projectOf = await this.refusalProjects();
    const sendersKnown = projectOf !== null;
    const networks = await this.deps.internalNetworks?.().catch(() => null);
    // Trabalha numa cópia: o leitor confirmado só muda depois de tudo gravado.
    const reader = this.reader.clone();
    try {
      await this.deps.readLogs(cursorMs === null ? null : new Date(cursorMs - SINCE_SLACK_MS), (line) => {
        const refusal = isRefusalLogLine(line);
        if (!refusal && !isDeliveryLogLine(line)) return;
        const ms = Date.parse(line.slice(0, line.indexOf(" ")));
        if (Number.isNaN(ms)) return;
        const h = hashLine(line);
        if (cursorMs !== null && (ms < cursorMs || (ms === cursorMs && seen.has(h)))) return;
        if (maxMs === null || ms > maxMs) {
          maxMs = ms;
          maxHashes = new Set([h]);
        } else if (ms === maxMs) {
          maxHashes.add(h);
        }
        if (refusal) {
          const parsed = parseRefusalLine(line, networks);
          if (parsed) {
            // Só tentativa vinda da rede interna conta como "do app": a internet toda tenta senha nas portas de e-mail.
            const projectId = parsed.origin === "internal" && parsed.login ? (projectOf?.get(parsed.login) ?? null) : null;
            if (projectId && this.deps.isProbe?.(projectId, ms)) return;
            refused.push({ ...parsed, projectId });
          }
          return;
        }
        events.push(...reader.push(line));
      });
    } catch (err) {
      await this.updateState((fresh) => {
        fresh.collectError = err instanceof Error ? err.message : String(err);
      });
      return { added: 0 };
    }
    // Sem a lista de caixas não dá para dizer de qual projeto é cada recusa interna: guardá-la agora a deixaria sem
    // projeto para sempre (e fora da aba Envios do projeto). A coleta espera a próxima rodada, com o cursor parado.
    if (!sendersKnown && refused.some((r) => r.origin === "internal" && r.login)) {
      await this.updateState((fresh) => {
        fresh.collectError = "Não foi possível ler as caixas de envio para atribuir as recusas aos projetos; tento de novo na próxima coleta.";
      });
      return { added: 0 };
    }
    await this.append(events);
    // As recusas precisam chegar ao disco ANTES de o cursor andar: o registro do container gira e o que o cursor
    // deixou para trás não é lido de novo. Se a gravação falhar, o cursor fica onde estava e a próxima coleta repete
    // (linhas idênticas de entrega e recusa no mesmo minuto valem uma só, então reler não duplica nada).
    try {
      await this.refusalStore.append(refused);
    } catch (err) {
      await this.updateState((fresh) => {
        fresh.collectError = err instanceof Error ? err.message : String(err);
      });
      return { added: 0 };
    }
    await this.updateState((fresh) => {
      fresh.cursor = { at: maxMs === null ? null : new Date(maxMs).toISOString(), hashes: [...maxHashes] };
      fresh.collectedAt = new Date(this.now()).toISOString();
      fresh.collectError = null;
    });
    this.reader = reader;
    await this.prune();
    return { added: events.length };
  }

  /** Login da caixa de projeto → id do projeto (só caixas que um projeto usa para enviar); null = não conseguiu ler as caixas. */
  private async refusalProjects(): Promise<Map<string, string> | null> {
    try {
      const map = new Map<string, string>();
      for (const e of await this.deps.senders()) {
        if (!e.projectId) continue;
        map.set(e.mailbox.toLowerCase(), e.projectId);
        map.set(e.address.toLowerCase(), e.projectId);
      }
      return map;
    } catch {
      return null;
    }
  }

  /** Tentativas recusadas guardadas (todas, ou só as de um projeto), mais recentes primeiro. */
  async refusals(query: { projectId?: string; scope?: "app" | "external"; limit?: number } = {}): Promise<MailRefusalsResponse> {
    const [{ items, total }, state, names, serverCreated] = await Promise.all([
      this.refusalStore.list(query),
      this.loadState(),
      this.deps.projectNames().catch(() => new Map<string, string>()),
      this.deps.serverCreated().catch(() => false),
    ]);
    return {
      items: items.map((i) => ({ ...i, projectName: i.projectId ? (names.get(i.projectId) ?? null) : null })),
      total,
      retentionDays: this.refusalStore.retention,
      collectedAt: state.collectedAt,
      serverCreated,
    };
  }

  /**
   * Coleta só se a última leitura (ou tentativa) tem mais de 1 min: a tela de envios chama a cada
   * abertura e, com o Stalwart fora do ar, a leitura falha e não grava a hora. A tentativa é
   * guardada em memória para o limite valer também nesse caso. Nunca lança.
   */
  async refreshIfStale(): Promise<void> {
    const now = this.now();
    if (this.lastRefreshTry !== null && now - this.lastRefreshTry <= REFRESH_AFTER_MS) return;
    this.lastRefreshTry = now;
    try {
      const state = await this.loadState();
      if (!state.collectedAt || now - Date.parse(state.collectedAt) > REFRESH_AFTER_MS) await this.collect();
    } catch {
      // a lista segue com o que já há
    }
  }

  /** Resultados de entrega guardados dessas mensagens, a partir de `sinceMs` (nunca além da retenção). */
  async eventsFor(queueIds: Set<string>, sinceMs: number): Promise<MailDeliveryEvent[]> {
    const from = Math.max(sinceMs, this.now() - this.retentionDays * DAY);
    return (await this.readEvents(from)).filter((e) => queueIds.has(e.queueId));
  }

  /** Apaga os dias além da retenção. */
  private async prune(): Promise<void> {
    const cutoff = new Date(this.now() - this.retentionDays * DAY).toISOString().slice(0, 10);
    for (const name of await readdir(this.dir)) {
      const m = DAY_FILE.exec(name);
      if (m && m[1]! < cutoff) await rm(path.join(this.dir, name), { force: true });
    }
  }

  private async readEvents(sinceMs: number): Promise<MailDeliveryEvent[]> {
    const sinceDay = new Date(sinceMs).toISOString().slice(0, 10);
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: MailDeliveryEvent[] = [];
    for (const name of names.sort()) {
      const m = DAY_FILE.exec(name);
      if (!m || m[1]! < sinceDay) continue;
      // Linha idêntica = o mesmo evento gravado de novo por uma coleta que
      // falhou depois de gravar os eventos e antes do cursor: conta uma vez.
      const seen = new Set<string>();
      for (const line of (await readFile(path.join(this.dir, name), "utf8")).split("\n")) {
        if (!line.trim() || seen.has(line)) continue;
        seen.add(line);
        try {
          const e = JSON.parse(line) as MailDeliveryEvent;
          if (Date.parse(e.at) >= sinceMs) out.push(e);
        } catch {
          // linha corrompida: ignora
        }
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Histórico
  // -------------------------------------------------------------------------

  async history(filter: HistoryFilter): Promise<MailHistoryResponse> {
    let state = await this.loadState();
    if (filter.refresh && (!state.collectedAt || this.now() - Date.parse(state.collectedAt) > REFRESH_AFTER_MS)) {
      await this.collect();
      state = await this.loadState();
    }
    const days = Math.min(Math.max(filter.days, 1), this.retentionDays);
    const sender = await this.senderLookup();
    const all: MailHistoryItem[] = (await this.readEvents(this.now() - days * DAY)).map((e) => ({ ...e, sender: sender(e.from) }));

    const projects = new Map<string, string>();
    const mailboxes = new Set<string>();
    const domains = new Set<string>();
    for (const i of all) {
      if (i.sender.projectId) projects.set(i.sender.projectId, i.sender.projectName ?? i.sender.projectId);
      mailboxes.add(i.sender.mailbox ?? i.from);
      domains.add(i.toDomain);
    }

    const q = filter.q?.trim().toLowerCase();
    const items = all
      .filter((i) => !filter.state || i.state === filter.state)
      .filter((i) => !filter.projectId || (filter.projectId === "none" ? i.sender.projectId === null : i.sender.projectId === filter.projectId))
      .filter((i) => !filter.mailbox || (i.sender.mailbox ?? i.from) === filter.mailbox)
      .filter((i) => !filter.domain || i.toDomain === filter.domain.toLowerCase())
      .filter((i) => !q || [i.to, i.from, i.detail ?? "", i.remoteHost ?? ""].some((v) => v.toLowerCase().includes(q)))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 200;
    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      collectedAt: state.collectedAt,
      collectError: state.collectError,
      retentionDays: this.retentionDays,
      projects: [...projects].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
      mailboxes: [...mailboxes].sort(),
      domains: [...domains].sort(),
    };
  }

  // -------------------------------------------------------------------------
  // Volume e taxas
  // -------------------------------------------------------------------------

  /**
   * Envios por dia (no fuso de quem pede: `tzOffsetMinutes` como o
   * getTimezoneOffset do navegador, 180 = UTC-3) e por projeto.
   */
  async volume(opts: { days: number; tzOffsetMinutes: number }): Promise<MailVolumeResponse> {
    const shift = opts.tzOffsetMinutes * 60_000;
    const localDay = (ms: number) => new Date(ms - shift).toISOString().slice(0, 10);
    const today = localDay(this.now());
    const startLocal = Date.parse(`${today}T00:00:00Z`) - (opts.days - 1) * DAY;
    const events = await this.readEvents(startLocal + shift);
    const sender = await this.senderLookup();

    const days: MailVolumeDay[] = [];
    for (let i = 0; i < opts.days; i++) {
      days.push({ date: new Date(startLocal + i * DAY).toISOString().slice(0, 10), delivered: 0, bounced: 0, deferred: 0, cancelled: 0 });
    }
    const dayOf = new Map(days.map((d) => [d.date, d]));
    const projects = new Map<string | null, MailVolumeProject>();
    const recipients = new Set<string>();
    const deferredByDay = new Set<string>();
    const deferredAny = new Set<string>();
    const totals = { delivered: 0, bounced: 0, deferred: 0, cancelled: 0, recipients: 0 };

    for (const e of events) {
      const day = dayOf.get(localDay(Date.parse(e.at)));
      if (!day) continue;
      const key = `${e.queueId}|${e.to}`;
      recipients.add(key);
      const s = sender(e.from);
      const project =
        projects.get(s.projectId) ??
        projects
          .set(s.projectId, { projectId: s.projectId, name: s.projectName ?? s.projectId ?? "Sem projeto", delivered: 0, bounced: 0, deferred: 0 })
          .get(s.projectId)!;
      if (e.state === "deferred") {
        const dayKey = `${day.date}|${key}`;
        if (!deferredByDay.has(dayKey)) {
          deferredByDay.add(dayKey);
          day.deferred++;
        }
        if (!deferredAny.has(key)) {
          deferredAny.add(key);
          totals.deferred++;
          project.deferred++;
        }
        continue;
      }
      day[e.state]++;
      totals[e.state]++;
      if (e.state !== "cancelled") project[e.state]++;
    }
    totals.recipients = recipients.size;
    const sent = totals.delivered + totals.bounced;
    return {
      days,
      byProject: [...projects.values()].sort((a, b) => b.delivered + b.bounced + b.deferred - (a.delivered + a.bounced + a.deferred)),
      totals,
      bounceRate: rate(totals.bounced, sent, BOUNCE_LIMIT),
      deferRate: rate(totals.deferred, totals.recipients, DEFER_LIMIT),
      complaintRate: null,
      lowVolume: sent < LOW_VOLUME,
    };
  }

  /** Últimos 7 dias, para a nota de entregabilidade. */
  async summary7d(): Promise<{ delivered: number; bounced: number; deferredRecipients: number; recipients: number }> {
    const events = await this.readEvents(this.now() - 7 * DAY);
    const recipients = new Set<string>();
    const deferred = new Set<string>();
    let delivered = 0;
    let bounced = 0;
    for (const e of events) {
      const key = `${e.queueId}|${e.to}`;
      recipients.add(key);
      if (e.state === "delivered") delivered++;
      else if (e.state === "bounced") bounced++;
      else if (e.state === "deferred") deferred.add(key);
    }
    return { delivered, bounced, deferredRecipients: deferred.size, recipients: recipients.size };
  }

  /** Primeiro envio já registrado (não some com a retenção). */
  async firstEventAt(): Promise<string | null> {
    return (await this.loadState()).firstEventAt;
  }
}
