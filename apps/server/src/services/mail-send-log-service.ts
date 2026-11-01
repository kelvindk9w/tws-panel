/**
 * mail-send-log-service.ts — registro dos envios feitos por SMTP (a caixa do
 * projeto que o app usa para enviar): quem enviou, para quem, quando, em que
 * estado está e, se deu errado, o motivo em linguagem clara. Assunto e corpo
 * ficam guardados à parte e ocultos (só a rota "Exibir" os devolve).
 *
 * De onde vem cada dado (conferido num Stalwart v0.11.8 real):
 *  - o ENVIO chega por um aviso do próprio Stalwart (MTA hook, estágio `data`,
 *    só para submissão autenticada): caixa autenticada, id da fila, envelope,
 *    assunto, corpo e anexos. Ver packages/mailer/src/send-hook.ts;
 *  - o ESTADO (entregue, adiado, recusado…) e o motivo vêm dos eventos de
 *    entrega que a página Envios já lê do registro do Stalwart, ligados ao
 *    envio pelo id da fila (applyEvents);
 *  - a RECONCILIAÇÃO (reconcile) cobre o que se perdeu com o painel parado:
 *    mensagens que estão na fila e o painel não conhecia viram registros só
 *    com metadados; as que sumiram da fila sem resultado viram "sem
 *    confirmação".
 *
 * Falha ao registrar NUNCA atrapalha o envio: o aviso é respondido na hora, o
 * registro é feito depois, numa fila em memória de tamanho limitado; o que não
 * couber ou falhar é contado e descartado (o envio já foi aceito).
 *
 * PRIVACIDADE: nada de assunto ou corpo em log, auditoria, notificação ou
 * listagem. Ver comoFuncionaSistema/email/saidas.json.
 */
import type {
  MailDeliveryEvent,
  MailSendContent,
  MailSendItem,
  MailSendListResponse,
  MailSendOrigin,
  MailSendRecipient,
  MailSendSettings,
  MailSendState,
  UpdateMailSendSettingsRequest,
} from "@paas/core";
import { MAIL_SEND_LIMITS } from "@paas/core";
import { explainSendFailure, failureState, parseSendHook, queueItemFromMessage, type QueueMessageRaw } from "@paas/mailer";
import { httpError } from "./http-error.js";
import { MailSendStore, normalizeSettings, type StoredRecipient, type StoredSend } from "./mail-send-store.js";

export interface SendSenderEntry {
  address: string;
  mailbox: string;
  projectId: string | null;
  system: boolean;
}

export interface MailSendLogDeps {
  dataDir: string;
  senders(): Promise<SendSenderEntry[]>;
  projectNames(): Promise<Map<string, string>>;
  serverCreated(): Promise<boolean>;
  listQueue(): Promise<{ items: QueueMessageRaw[]; total: number }>;
  /**
   * Domínios de e-mail que este servidor recebe. Registro reconstruído só pelo
   * log nunca vale para destinatário local: e-mail vindo de fora com remetente
   * forjado também é "entregue" localmente e seria atribuído ao projeto.
   */
  localDomains?(): Promise<string[]>;
  /**
   * Eventos de entrega já guardados (data/mail/envios) dessas mensagens. A reconciliação os
   * aplica de novo: cobre evento que chegou antes do registro, que se perdeu numa gravação
   * ou que foi lido antes desta função existir. Aplicar é idempotente.
   */
  eventsFor?(queueIds: Set<string>, sinceMs: number): Promise<MailDeliveryEvent[]>;
  /** A captura (aviso do Stalwart) está configurada? */
  captureConfigured(): Promise<boolean>;
  log?: (message: string) => void;
  now?: () => number;
  /** Quantos avisos esperam na fila em memória (padrão 16: cada um pode ter vários MiB). */
  queueLimit?: number;
}

export interface SendListFilter {
  projectId?: string;
  origin?: MailSendOrigin;
  state?: MailSendState;
  /** Dia inicial (AAAA-MM-DD), inclusive, em UTC. */
  from?: string;
  /** Dia final (AAAA-MM-DD), inclusive, em UTC. */
  to?: string;
  /** Parte do endereço do destinatário. */
  recipient?: string;
  limit?: number;
  offset?: number;
}

const DAY = 86_400_000;
const RECONCILE_FIRST_MS = 90_000;
const RECONCILE_EVERY_MS = 5 * 60_000;
const PURGE_FIRST_MS = 120_000;
const PURGE_EVERY_MS = 60 * 60_000;
/** Mensagem pendente que sumiu da fila há menos tempo que isso ainda pode estar no registro. */
const UNCONFIRMED_AFTER_MS = 15 * 60_000;
/**
 * Mensagem que continua "na fila" (nunca teve um único evento de entrega) depois disso vira
 * "sem confirmação", mesmo que a fila ainda a mostre ou não responda. O Stalwart tenta de novo
 * em 2 min, depois em intervalos crescentes: qualquer tentativa, boa ou ruim, escreve no
 * registro nas primeiras horas. 6 h sem nada = o registro não chegou ao painel (rotação do log,
 * container recriado, leitura quebrada). "Na fila" nunca é resultado final.
 */
export const NO_EVENT_AFTER_MS = 6 * 60 * 60_000;
/** Reaplicação: a leitura do histórico começa um pouco antes do envio pendente mais antigo e nunca passa disso. */
const REAPPLY_SLACK_MS = 5 * 60_000;
const REAPPLY_MAX_WINDOW_MS = 30 * DAY;
const SETTINGS_CACHE_MS = 5_000;
const CAP_CHECK_EVERY = 50;

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

function newRecipient(address: string, at: string | null = null, state: MailSendState = "queued"): StoredRecipient {
  return { address, domain: domainOf(address), state, deferrals: 0, updatedAt: at, nextRetryAt: null, remoteHost: null, error: null };
}

const RANK: MailSendState[] = ["rejected", "failed", "deferred", "queued", "unconfirmed", "cancelled", "delivered"];

/** Estado geral: o problema mais grave primeiro, depois o que ainda está pendente. */
export function aggregateState(recipients: ReadonlyArray<{ state: MailSendState }>): MailSendState {
  if (recipients.length === 0) return "queued";
  for (const s of RANK) if (recipients.some((r) => r.state === s)) return s;
  return "queued";
}

export class MailSendLogService {
  private readonly store: MailSendStore;
  private readonly now: () => number;
  private readonly pending: unknown[] = [];
  private readonly queueLimit: number;
  private draining = false;
  private ready: Promise<void> | null = null;
  private settingsCache: { at: number; value: MailSendSettings } | null = null;
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private contentWrites = 0;
  /** Corrente de exclusão: ingest, eventos, reconciliação e expurgo alteram registros um de cada vez. */
  private chain: Promise<unknown> = Promise.resolve();
  /** "Sem confirmação" já conferido contra o histórico nesta execução (novos resultados chegam pela coleta). */
  private readonly checkedUnconfirmed = new Set<string>();
  /** Contadores de diagnóstico (nenhum conteúdo). */
  readonly counters = { received: 0, stored: 0, invalid: 0, dropped: 0, failed: 0 };

  constructor(private readonly deps: MailSendLogDeps) {
    this.now = deps.now ?? Date.now;
    this.store = new MailSendStore(deps.dataDir, this.now, (message) => this.log(message));
    this.queueLimit = deps.queueLimit ?? 16;
  }

  /**
   * Uma alteração de registros por vez. Sem isso, o aviso do envio e o resultado de entrega
   * (que chegam por caminhos diferentes) leem o mesmo registro, esperam disco e um grava por
   * cima do outro: o envio voltava a "na fila", ou o aviso perdia a caixa e o tamanho.
   */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }

  private load(): Promise<void> {
    this.ready ??= this.store.load();
    return this.ready;
  }

  // -------------------------------------------------------------------------
  // Agendamento
  // -------------------------------------------------------------------------

  start(): void {
    const later = (ms: number, every: number, fn: () => Promise<unknown>) => {
      const first = setTimeout(() => {
        void fn().catch(() => undefined);
        const loop = setInterval(() => void fn().catch(() => undefined), every);
        loop.unref?.();
        this.timers.push(loop);
      }, ms);
      first.unref?.();
      this.timers.push(first);
    };
    later(RECONCILE_FIRST_MS, RECONCILE_EVERY_MS, () => this.reconcile());
    later(PURGE_FIRST_MS, PURGE_EVERY_MS, () => this.purge());
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  // -------------------------------------------------------------------------
  // Configuração
  // -------------------------------------------------------------------------

  async settings(): Promise<MailSendSettings> {
    const cached = this.settingsCache;
    if (cached && this.now() - cached.at < SETTINGS_CACHE_MS) return cached.value;
    const value = await this.store.loadSettings();
    this.settingsCache = { at: this.now(), value };
    return value;
  }

  async updateSettings(req: UpdateMailSendSettingsRequest): Promise<MailSendSettings> {
    const current = await this.store.loadSettings();
    const next: Record<string, unknown> = { ...current };
    for (const key of ["metadataDays", "bodyDays", "maxBodyKiB", "maxTotalMiB"] as const) {
      const v = req[key];
      if (v === undefined) continue;
      const range = MAIL_SEND_LIMITS[key];
      if (!Number.isInteger(v) || v < range.min || v > range.max) {
        throw httpError(400, "invalid_request", `Valor fora do limite: ${key} (${range.min} a ${range.max}).`);
      }
      next[key] = v;
    }
    if (req.storeContent !== undefined) next.storeContent = req.storeContent;
    if (req.project) {
      const list = new Set(current.projectsWithoutContent);
      if (req.project.storeContent) list.delete(req.project.id);
      else list.add(req.project.id);
      next.projectsWithoutContent = [...list];
    }
    if ((next.bodyDays as number) > (next.metadataDays as number)) {
      throw httpError(400, "invalid_request", "O conteúdo não pode ficar guardado por mais tempo que os dados da mensagem.");
    }
    const value = normalizeSettings(next);
    await this.store.saveSettings(value);
    this.settingsCache = { at: this.now(), value };
    // Desligou a gravação: o que já estava guardado é apagado na hora (a pessoa espera isso).
    if (!value.storeContent || (req.project && !req.project.storeContent)) {
      await this.dropContent((rec) => !value.storeContent || (rec.projectId !== null && value.projectsWithoutContent.includes(rec.projectId)));
    }
    return value;
  }

  /**
   * Apaga o conteúdo que a pessoa mandou parar de guardar. Só marca como
   * apagado quando o arquivo realmente saiu; se falhar, o próximo expurgo repete.
   */
  private dropContent(pick: (rec: StoredSend) => boolean): Promise<void> {
    return this.exclusive(async () => {
      await this.load();
      for (const rec of this.store.all()) {
        if (rec.content !== "stored" || !pick(rec)) continue;
        if (!(await this.removeContent(rec.id))) continue;
        const cur = this.store.get(rec.id);
        if (cur) await this.store.put({ ...cur, content: "removed" });
      }
    });
  }

  /** true = o arquivo não existe mais. */
  private async removeContent(id: string): Promise<boolean> {
    try {
      await this.store.deleteContent(id);
      return true;
    } catch (err) {
      this.counters.failed++;
      this.log(`Registro de envios: não consegui apagar o conteúdo de um envio (${err instanceof Error ? err.message : String(err)}). Tento de novo no próximo expurgo.`);
      return false;
    }
  }

  private async isLocal(address: string): Promise<boolean> {
    const domains = (await this.deps.localDomains?.().catch(() => [])) ?? [];
    return domains.map((d) => d.toLowerCase()).includes(domainOf(address));
  }

  // -------------------------------------------------------------------------
  // Atribuição a projeto
  // -------------------------------------------------------------------------

  private async attribution(login: string | null, from: string) {
    const [entries, names] = await Promise.all([this.deps.senders(), this.deps.projectNames()]);
    const byAddress = new Map(entries.map((e) => [e.address.toLowerCase(), e]));
    // A caixa autenticada manda; sem ela (reconstruído pelo registro), vale o remetente.
    const entry = (login ? byAddress.get(login.toLowerCase()) : undefined) ?? byAddress.get(from.toLowerCase());
    const projectId = entry?.projectId ?? null;
    const origin: MailSendOrigin = projectId ? "project" : entry ? "panel" : "other";
    return {
      origin,
      projectId,
      projectName: projectId ? (names.get(projectId) ?? null) : null,
      mailbox: entry?.mailbox ?? (login && byAddress.has(login.toLowerCase()) ? login.toLowerCase() : null),
    };
  }

  // -------------------------------------------------------------------------
  // Recebimento (aviso do Stalwart)
  // -------------------------------------------------------------------------

  /**
   * Põe o aviso na fila de registro. Síncrono e barato: o Stalwart está
   * esperando a resposta. "invalid" = formato errado; "dropped" = fila cheia.
   */
  submit(payload: unknown): "queued" | "invalid" | "dropped" {
    this.counters.received++;
    const ctx = (payload as { context?: { stage?: unknown; sasl?: { login?: unknown }; queue?: { id?: unknown } } } | null)?.context;
    if (!ctx || ctx.stage !== "data" || typeof ctx.sasl?.login !== "string" || typeof ctx.queue?.id !== "string") {
      this.counters.invalid++;
      return "invalid";
    }
    if (this.pending.length >= this.queueLimit) {
      this.counters.dropped++;
      return "dropped";
    }
    this.pending.push(payload);
    this.drain();
    return "queued";
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    setImmediate(() => {
      void this.drainAll();
    });
  }

  private async drainAll(): Promise<void> {
    try {
      for (let raw = this.pending.shift(); raw !== undefined; raw = this.pending.shift()) {
        try {
          await this.exclusive(() => this.ingest(raw));
        } catch (err) {
          this.counters.failed++;
          // Só a mensagem do erro: nunca o aviso (tem assunto e corpo).
          this.log(`Registro de envios: não consegui guardar um envio (${err instanceof Error ? err.message : String(err)}).`);
        }
      }
    } finally {
      this.draining = false;
      if (this.pending.length > 0) this.drain();
    }
  }

  /** Espera a fila de registro esvaziar (testes e desligamento). */
  async flush(): Promise<void> {
    while (this.draining || this.pending.length > 0) await new Promise((r) => setTimeout(r, 5));
  }

  private async ingest(raw: unknown): Promise<void> {
    await this.load();
    const settings = await this.settings();
    const peek = raw as { context: { sasl: { login: string } }; envelope?: { from?: { address?: string } } };
    const login = peek.context.sasl.login.toLowerCase();
    const attr = await this.attribution(login, String(peek.envelope?.from?.address ?? ""));
    // Assunto e corpo só de caixa de PROJETO (o que o app envia). Webmail e clientes
    // IMAP de caixas pessoais ficam só com os dados da mensagem.
    const withContent = settings.storeContent && attr.origin === "project" && !(attr.projectId && settings.projectsWithoutContent.includes(attr.projectId));
    const parsed = parseSendHook(raw, { maxBodyBytes: settings.maxBodyKiB * 1024, withContent });
    if (!parsed.ok) {
      this.counters.invalid++;
      return;
    }
    const m = parsed.value;
    // O Stalwart repete o aviso se achar que falhou: o mesmo envio não vira dois.
    if (this.store.get(m.queueId)?.captured) return;
    const at = new Date(this.now()).toISOString();
    const hasContent = withContent && (m.subject !== null || m.body !== null);
    if (hasContent) {
      await this.store.writeContent({
        id: m.queueId,
        subject: m.subject,
        body: m.body,
        bodyTruncated: m.bodyTruncated,
        attachments: m.attachments,
        storedAt: at,
      });
    }
    // Registro que o resultado de entrega criou antes do aviso (só metadados): o aviso completa, não substitui.
    const existing = this.store.get(m.queueId);
    const recipients = m.to.map((to) => existing?.recipients.find((r) => r.address === to) ?? newRecipient(to));
    for (const r of existing?.recipients ?? []) if (!recipients.some((x) => x.address === r.address)) recipients.push(r);
    await this.store.put({
      id: m.queueId,
      at: existing && existing.at < at ? existing.at : at,
      from: m.from,
      login,
      mailbox: attr.mailbox ?? login,
      origin: attr.origin,
      projectId: attr.projectId,
      projectName: attr.projectName,
      size: m.size,
      attachments: m.attachments,
      recipients,
      content: hasContent ? "stored" : "none",
      truncated: m.bodyTruncated,
      captured: true,
    });
    this.counters.stored++;
    if (hasContent && ++this.contentWrites % CAP_CHECK_EVERY === 0) await this.enforceCap().catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Estados (eventos de entrega do registro do Stalwart)
  // -------------------------------------------------------------------------

  /** Aplica os eventos de entrega. Fora de ordem e repetidos não estragam nada. */
  applyEvents(events: MailDeliveryEvent[]): Promise<void> {
    if (events.length === 0) return Promise.resolve();
    return this.exclusive(() => this.applyEventsNow(events));
  }

  private async applyEventsNow(events: MailDeliveryEvent[]): Promise<void> {
    await this.load();
    const changed = new Map<string, StoredSend>();
    const sorted = [...events].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    for (const e of sorted) {
      let rec = changed.get(e.queueId) ?? this.store.get(e.queueId);
      if (!rec) {
        // Evento antes do aviso (ou sem aviso): registro só com metadados.
        const attr = await this.attribution(null, e.from);
        // Sem aviso, não dá para saber se é envio ou e-mail recebido de fora que o
        // servidor entregou localmente: só entram remetentes que o painel conhece.
        if (attr.origin === "other") continue;
        // O remetente do log é forjável por quem escreve na porta 25: destino local não prova envio.
        if (await this.isLocal(e.to)) continue;
        rec = {
          id: e.queueId,
          at: e.at,
          from: e.from,
          login: null,
          mailbox: attr.mailbox,
          origin: attr.origin,
          projectId: attr.projectId,
          projectName: attr.projectName,
          size: 0,
          attachments: [],
          recipients: [],
          content: "none",
          truncated: false,
          captured: false,
        };
      } else {
        rec = structuredClone(rec);
      }
      let r = rec.recipients.find((x) => x.address === e.to);
      if (!r) {
        r = newRecipient(e.to);
        rec.recipients.push(r);
      }
      // Evento mais velho que o que já valeu: ignora.
      if (r.updatedAt && e.at < r.updatedAt && r.state !== "unconfirmed") continue;
      const failure = e.state === "delivered" || e.state === "cancelled" ? null : explainSendFailure({ code: e.code, detail: e.detail });
      const target: MailSendState =
        e.state === "delivered" ? "delivered" : e.state === "cancelled" ? "cancelled" : e.state === "deferred" ? "deferred" : failureState(failure!);
      // O mesmo evento lido duas vezes (releitura do registro) conta uma vez só. "Sem confirmação"
      // foi decidido por tempo depois deste adiamento: reaplicá-lo não o desfaz nem soma outro adiamento.
      if (r.updatedAt === e.at && (r.state === target || (r.state === "unconfirmed" && target === "deferred"))) continue;
      if (r.state === "unconfirmed" && target === "deferred" && r.updatedAt && e.at < r.updatedAt) continue;
      r.updatedAt = e.at;
      r.remoteHost = e.remoteHost;
      r.state = target;
      r.error = failure;
      r.nextRetryAt = target === "deferred" ? e.nextRetryAt : null;
      if (target === "deferred") r.deferrals++;
      changed.set(rec.id, rec);
    }
    for (const rec of changed.values()) await this.store.put(rec);
  }

  // -------------------------------------------------------------------------
  // Reconciliação
  // -------------------------------------------------------------------------

  /**
   * 1) Reaplica os resultados de entrega já guardados aos envios ainda pendentes (ou "sem
   * confirmação"); 2) compara com a fila do Stalwart: mensagens que estão lá e o painel não
   * conhece viram registros só com metadados; 3) pendentes que saíram da fila sem resultado
   * (15 min), ou que ficaram 6 h sem nenhum evento, viram "sem confirmação". Fila que não
   * respondeu: só vale a regra das 6 h.
   */
  async reconcile(): Promise<{ created: number; unconfirmed: number }> {
    await this.load();
    await this.reapplyStoredEvents();
    let queue: QueueMessageRaw[] | null = null;
    if (await this.deps.serverCreated()) {
      try {
        queue = (await this.deps.listQueue()).items;
      } catch {
        queue = null;
      }
    }
    return this.exclusive(async () => {
      const created = queue ? await this.adoptQueued(queue) : 0;
      const inQueue = queue ? new Set(queue.map((m) => m.id)) : null;
      const now = this.now();
      let unconfirmed = 0;
      for (const rec of this.store.all()) {
        const age = now - Date.parse(rec.at);
        const pending = rec.recipients.filter((r) => r.state === "queued" || r.state === "deferred");
        if (pending.length === 0) continue;
        // Saiu da fila sem resultado (15 min) ou ficou 6 h sem nenhum evento, esteja a fila de pé ou não.
        const leftQueue = inQueue !== null && !inQueue.has(rec.id) && age > UNCONFIRMED_AFTER_MS;
        const silent = age > NO_EVENT_AFTER_MS;
        const targets = pending.filter((r) => (leftQueue ? true : silent && r.state === "queued"));
        if (targets.length === 0) continue;
        const next = structuredClone(rec);
        for (const r of next.recipients) {
          if (targets.some((t) => t.address === r.address)) {
            r.state = "unconfirmed";
            r.nextRetryAt = null;
          }
        }
        await this.store.put(next);
        unconfirmed++;
      }
      return { created, unconfirmed };
    });
  }

  /**
   * Reaplica os eventos de entrega guardados aos envios ainda pendentes. "Sem confirmação" é
   * conferido uma vez por execução (os resultados novos chegam pela coleta); a leitura do
   * histórico começa no envio pendente mais antigo, nunca em todo o período.
   */
  private async reapplyStoredEvents(): Promise<void> {
    if (!this.deps.eventsFor) return;
    const ids = new Set<string>();
    const lost = new Set<string>();
    let oldest = Infinity;
    for (const rec of this.store.all()) {
      const open = rec.recipients.some((r) => r.state === "queued" || r.state === "deferred");
      const gone = !open && !this.checkedUnconfirmed.has(rec.id) && rec.recipients.some((r) => r.state === "unconfirmed");
      if (!open && !gone) continue;
      ids.add(rec.id);
      if (gone) lost.add(rec.id);
      oldest = Math.min(oldest, Date.parse(rec.at));
    }
    if (ids.size === 0) return;
    const sinceMs = Math.max(oldest - REAPPLY_SLACK_MS, this.now() - REAPPLY_MAX_WINDOW_MS);
    try {
      await this.applyEvents(await this.deps.eventsFor(ids, sinceMs));
      for (const id of lost) this.checkedUnconfirmed.add(id);
    } catch (err) {
      this.counters.failed++;
      this.log(`Registro de envios: não consegui reaplicar os resultados de entrega guardados (${err instanceof Error ? err.message : String(err)}).`);
    }
  }

  /** Mensagens na fila que o painel não conhecia viram registros só com metadados. */
  private async adoptQueued(queue: QueueMessageRaw[]): Promise<number> {
    const local = new Set((await this.deps.localDomains?.().catch(() => [])) ?? []);
    let created = 0;
    for (const m of queue) {
      if (this.store.get(m.id)) continue;
      const view = queueItemFromMessage(m);
      if (!view.from) continue; // aviso do próprio servidor
      const attr = await this.attribution(null, view.from);
      if (attr.origin === "other") continue;
      const remote = view.recipients.filter((r) => !local.has(domainOf(r.address)));
      if (remote.length === 0) continue;
      const at = view.createdAt ?? new Date(this.now()).toISOString();
      await this.store.put({
        id: m.id,
        at,
        from: view.from,
        login: null,
        mailbox: attr.mailbox,
        origin: attr.origin,
        projectId: attr.projectId,
        projectName: attr.projectName,
        size: view.size,
        attachments: [],
        recipients: remote.map((r) => newRecipient(r.address, null, r.state === "waiting" ? "queued" : r.state === "bounced" ? "failed" : r.state)),
        content: "none",
        truncated: false,
        captured: false,
      });
      created++;
    }
    return created;
  }

  // -------------------------------------------------------------------------
  // Retenção
  // -------------------------------------------------------------------------

  /** Apaga o que passou da retenção e respeita o teto de espaço. */
  purge(): Promise<{ removedRecords: number; expiredContents: number }> {
    return this.exclusive(() => this.purgeNow());
  }

  private async purgeNow(): Promise<{ removedRecords: number; expiredContents: number }> {
    await this.load();
    const settings = await this.store.loadSettings();
    const { removedRecords } = await this.store.prune(settings.metadataDays);
    let expiredContents = 0;
    const cutoff = this.now() - settings.bodyDays * DAY;
    for (const rec of this.store.all()) {
      if (rec.content !== "stored") continue;
      const content = await this.store.readContent(rec.id);
      const stale = !content || Date.parse(content.storedAt) < cutoff;
      if (!stale) continue;
      if (!(await this.removeContent(rec.id))) continue;
      await this.store.put({ ...rec, content: "expired" });
      expiredContents++;
    }
    for (const f of await this.store.contentFiles()) {
      if (!this.store.get(f.id)) await this.removeContent(f.id);
    }
    expiredContents += await this.enforceCap();
    return { removedRecords, expiredContents };
  }

  /** Passou do teto total: apaga o conteúdo mais antigo até caber. Devolve quantos apagou. */
  private async enforceCap(): Promise<number> {
    const settings = await this.settings();
    const cap = settings.maxTotalMiB * 1024 * 1024;
    const files = (await this.store.contentFiles()).sort((a, b) => a.mtimeMs - b.mtimeMs || (a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
    let total = files.reduce((n, f) => n + f.size, 0);
    let removed = 0;
    for (const f of files) {
      if (total <= cap) break;
      if (!(await this.removeContent(f.id))) continue;
      total -= f.size;
      const rec = this.store.get(f.id);
      if (rec && rec.content === "stored") await this.store.put({ ...rec, content: "expired" });
      removed++;
    }
    return removed;
  }

  // -------------------------------------------------------------------------
  // Listagem (NUNCA com assunto ou corpo)
  // -------------------------------------------------------------------------

  async list(filter: SendListFilter): Promise<MailSendListResponse> {
    await this.load();
    const [settings, names, configured, created] = await Promise.all([
      this.settings(),
      this.deps.projectNames(),
      this.deps.captureConfigured(),
      this.deps.serverCreated(),
    ]);
    const all = this.store.all();
    const projects = new Map<string, string>();
    for (const r of all) if (r.projectId) projects.set(r.projectId, names.get(r.projectId) ?? r.projectName ?? r.projectId);
    const q = filter.recipient?.trim().toLowerCase();
    const from = filter.from ? `${filter.from}T00:00:00.000Z` : null;
    const to = filter.to ? `${filter.to}T23:59:59.999Z` : null;
    const matched = all
      .filter((r) => !filter.projectId || (filter.projectId === "none" ? r.projectId === null : r.projectId === filter.projectId))
      .filter((r) => !filter.origin || r.origin === filter.origin)
      .filter((r) => !filter.state || r.recipients.some((x) => this.effectiveState(r, x) === filter.state))
      .filter((r) => !from || r.at >= from)
      .filter((r) => !to || r.at <= to)
      .filter((r) => !q || r.recipients.some((x) => x.address.includes(q)))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));
    const limit = Math.min(Math.max(filter.limit ?? 25, 1), 100);
    const offset = Math.max(filter.offset ?? 0, 0);
    const scoped = filter.projectId && filter.projectId !== "none" ? filter.projectId : null;
    return {
      items: matched.slice(offset, offset + limit).map((r) => this.view(r, names)),
      total: matched.length,
      limit,
      offset,
      projects: [...projects].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
      capture: { configured, lastReceivedAt: this.lastCaptured(scoped), serverCreated: created },
      retention: { metadataDays: settings.metadataDays, bodyDays: settings.bodyDays },
      storesContent: settings.storeContent && !(scoped && settings.projectsWithoutContent.includes(scoped)),
    };
  }

  /** Último envio registrado pelo aviso do Stalwart (do projeto, quando a lista é de um projeto). */
  private lastCaptured(projectId: string | null): string | null {
    let last: string | null = null;
    for (const r of this.store.all()) {
      if (!r.captured || (projectId && r.projectId !== projectId)) continue;
      if (last === null || r.at > last) last = r.at;
    }
    return last;
  }

  /** O estado que a tela mostra (e o filtro usa): "na fila" sem evento há 6 h já é "sem confirmação". */
  private effectiveState(r: StoredSend, x: StoredRecipient): MailSendState {
    return x.state === "queued" && this.now() - Date.parse(r.at) > NO_EVENT_AFTER_MS ? "unconfirmed" : x.state;
  }

  private view(r: StoredSend, names: Map<string, string>): MailSendItem {
    // "Na fila" nunca é final: sem nenhum evento depois de 6 h, a tela já mostra "sem confirmação",
    // mesmo antes da próxima reconciliação gravar isso.
    const recipients: MailSendRecipient[] = r.recipients.map((x) => ({
      address: x.address,
      domain: x.domain,
      state: this.effectiveState(r, x),
      deferrals: x.deferrals,
      updatedAt: x.updatedAt,
      nextRetryAt: x.nextRetryAt,
      remoteHost: x.remoteHost,
      error: x.error,
    }));
    return {
      id: r.id,
      at: r.at,
      from: r.from,
      mailbox: r.login ? r.mailbox : null,
      origin: r.origin,
      projectId: r.projectId,
      projectName: r.projectId ? (names.get(r.projectId) ?? r.projectName) : null,
      state: aggregateState(recipients),
      recipients,
      size: r.size,
      attachments: r.attachments,
      hasContent: r.content === "stored",
      contentExpired: r.content === "expired",
      contentRemoved: r.content === "removed",
      contentTruncated: r.truncated,
      captured: r.captured,
    };
  }

  // -------------------------------------------------------------------------
  // Exibir (a única saída de assunto e corpo)
  // -------------------------------------------------------------------------

  async reveal(id: string, scope: { projectId?: string } = {}): Promise<MailSendContent> {
    await this.load();
    const rec = /^\d{1,20}$/.test(id) ? this.store.get(id) : undefined;
    if (!rec || (scope.projectId && rec.projectId !== scope.projectId)) {
      throw httpError(404, "send_not_found", "Mensagem não encontrada.");
    }
    if (rec.content === "none") {
      throw httpError(404, "content_not_stored", "O assunto e o corpo desta mensagem não foram guardados (a gravação estava desligada ou o envio não foi capturado).");
    }
    if (rec.content === "removed") {
      throw httpError(410, "content_removed", "O assunto e o corpo desta mensagem foram apagados quando a gravação foi desligada.");
    }
    const content = rec.content === "stored" ? await this.store.readContent(id) : null;
    if (!content) {
      throw httpError(410, "content_expired", "O assunto e o corpo desta mensagem já foram apagados pela retenção.");
    }
    const settings = await this.settings();
    return {
      id,
      subject: content.subject,
      body: content.body,
      bodyTruncated: content.bodyTruncated,
      attachments: content.attachments,
      expiresAt: new Date(Date.parse(content.storedAt) + settings.bodyDays * DAY).toISOString(),
    };
  }
}
