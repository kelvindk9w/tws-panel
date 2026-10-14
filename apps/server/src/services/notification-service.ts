/**
 * notification-service.ts — serviço central de notificações (avisos fora do
 * painel, Configurações → Notificações).
 *
 * Quem avisa não conhece os canais: cada módulo (ou o gancho dos alertas, ver
 * notification-sources.ts) chama `notify({ kind, key, title })` e este serviço
 * decide se e como o aviso sai:
 *  - o tipo está ligado? (escolha da pessoa, padrão em @paas/core);
 *  - há canal conectado? (Telegram e/ou e-mail);
 *  - o mesmo assunto (`key`) já saiu nos últimos 10 min? Então só conta, e no
 *    fim da janela sai UM resumo ("repetiu N vezes");
 *  - passou do limite por hora do canal? Conta e, quando a hora libera, manda
 *    um resumo de quantos ficaram de fora;
 *  - falhou? Tenta de novo com recuo (30 s, 2 min, 10 min) e, se não der,
 *    registra "falhou" no histórico e no log — nunca derruba quem avisou.
 *
 * Segredo: o token do robô do Telegram fica CIFRADO em repouso (AES-256-GCM,
 * chave própria em data/notifications-key, mesmo padrão do 2FA e do cofre de
 * credenciais). Ele nunca volta pela API, nunca vai para a auditoria nem para
 * o log. O histórico guarda só o assunto, sem o conteúdo.
 *
 * Mensagens: curtas, em português, sem senha, token ou IP (maskSensitive
 * troca IPs e endereços …sslip.io — que têm o IP no nome — por um marcador).
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_NOTIFICATION_KINDS,
  MAX_NOTIFICATION_RECIPIENTS,
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_LABELS,
  type NotificationChannelId,
  type NotificationHistoryEntry,
  type NotificationKind,
  type NotificationsStatus,
} from "@paas/core";
import { isSingleEmailAddress } from "@paas/mailer";
import { httpError } from "./http-error.js";
import { TelegramError, type TelegramClient } from "./telegram-client.js";

/** Um aviso pedido por algum módulo do painel. */
export interface NotificationEvent {
  kind: NotificationKind;
  /** Assunto para agrupar repetidos: o mesmo `key` na janela vira um resumo. */
  key: string;
  /** Uma linha, sem dado sensível (vai como assunto do e-mail). */
  title: string;
  /** Linhas extras curtas (opcional). */
  body?: string[];
  /** Tela do painel para o link (ex.: "/alerts"), quando o painel tem domínio próprio. */
  path?: string;
}

/** Envio por e-mail, fornecido pelo plugin de e-mail (que é quem enxerga o MailService). */
export interface EmailSender {
  readiness(): Promise<{ ready: boolean; reason: string | null; from: string | null }>;
  send(msg: { to: string; subject: string; text: string; html: string }): Promise<void>;
}

export interface NotificationFacts {
  channels: Array<{ id: NotificationChannelId; connected: boolean; tested: boolean }>;
}

export interface NotificationAuditSink {
  record(input: { action: string; detail: string; actor?: string; target?: string | null }): Promise<unknown>;
}

export interface NotificationServiceOptions {
  dataDir: string;
  telegram: TelegramClient;
  now?: () => number;
  audit?: NotificationAuditSink;
  log?: (message: string) => void;
  /** Endereço do painel para o link nas mensagens; null = não pôr link. */
  panelUrl?: () => Promise<string | null>;
  /** Janela de agrupamento de repetidos (padrão 10 min). */
  groupWindowMs?: number;
  /** Máximo de avisos por canal por hora (padrão 20). */
  maxPerHour?: number;
  /** Recuo entre as tentativas (padrão 30 s, 2 min, 10 min). */
  retryDelaysMs?: number[];
}

interface SealedBox {
  iv: string;
  tag: string;
  data: string;
}

interface StoredTelegram {
  token: SealedBox;
  botUsername: string;
  chatId: string | null;
  chatTitle: string | null;
  connectedAt: string | null;
  testedAt: string | null;
}

interface StoredConfig {
  telegram: StoredTelegram | null;
  email: { recipients: string[]; testedAt: string | null };
  kinds: Record<NotificationKind, boolean>;
}

interface Rendered {
  title: string;
  subject: string;
  text: string;
  html: string;
}

interface Delivery {
  /** Linha do histórico deste envio (atualizada a cada tentativa). */
  entry: NotificationHistoryEntry;
  channel: NotificationChannelId;
  /** Destinatário do e-mail (um por entrega). */
  to: string | null;
  message: Rendered;
  attempt: number;
  nextAt: number;
}

interface Group {
  kind: NotificationKind;
  title: string;
  path: string | undefined;
  windowEnd: number;
  count: number;
}

const HOUR_MS = 60 * 60 * 1000;
const MAX_HISTORY = 50;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const DEFAULT_TICK_MS = 30_000;

const SSLIP_RE = /\b(?:[a-z0-9-]+\.)*?(?:\d{1,3}[.-]){3}\d{1,3}\.sslip\.io\b/gi;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_CANDIDATE_RE = /(?<![\w:])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?![\w:])/gi;
const EMAIL_RE = /[^\s<>@"]+@[^\s<>"]+\.[a-z]{2,}/gi;

/** Troca IPs e endereços …sslip.io (que têm o IP no nome) por um marcador. */
export function maskSensitive(text: string): string {
  return text
    .replace(SSLIP_RE, "[endereço pelo IP]")
    .replace(IPV4_RE, "[IP oculto]")
    .replace(IPV6_CANDIDATE_RE, (m) => (m.includes("::") || m.split(":").length === 8 ? "[IP oculto]" : m));
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Motivo curto de uma falha, sem IP nem endereço de e-mail. */
function shortReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return maskSensitive(raw).replace(EMAIL_RE, "[endereço]").slice(0, 200);
}

function isPermanent(err: unknown): boolean {
  if (err instanceof TelegramError) return err.permanent;
  return (err as { permanent?: unknown } | null)?.permanent === true;
}

function emptyConfig(): StoredConfig {
  return { telegram: null, email: { recipients: [], testedAt: null }, kinds: { ...DEFAULT_NOTIFICATION_KINDS } };
}

export class NotificationService {
  private readonly file: string;
  private readonly historyFile: string;
  private readonly keyFile: string;
  private readonly telegram: TelegramClient;
  private readonly now: () => number;
  private readonly audit: NotificationAuditSink | undefined;
  private readonly log: (message: string) => void;
  private readonly panelUrl: (() => Promise<string | null>) | undefined;
  private readonly groupWindowMs: number;
  private readonly maxPerHour: number;
  private readonly retryDelaysMs: number[];

  private config: StoredConfig = emptyConfig();
  private token: string | null = null;
  private history: NotificationHistoryEntry[] = [];
  private key: Buffer | null = null;
  private loading: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private emailSender: EmailSender | null = null;
  private timer: NodeJS.Timeout | null = null;

  private readonly groups = new Map<string, Group>();
  private readonly sentAt: Record<NotificationChannelId, number[]> = { telegram: [], email: [] };
  private readonly suppressed: Record<NotificationChannelId, number> = { telegram: 0, email: 0 };
  private retries: Delivery[] = [];

  constructor(opts: NotificationServiceOptions) {
    this.file = path.join(opts.dataDir, "notifications.json");
    this.historyFile = path.join(opts.dataDir, "notifications-history.json");
    this.keyFile = path.join(opts.dataDir, "notifications-key");
    this.telegram = opts.telegram;
    this.now = opts.now ?? Date.now;
    this.audit = opts.audit;
    this.log = opts.log ?? ((m) => console.warn(m));
    this.panelUrl = opts.panelUrl;
    this.groupWindowMs = opts.groupWindowMs ?? 10 * 60_000;
    this.maxPerHour = opts.maxPerHour ?? 20;
    this.retryDelaysMs = opts.retryDelaysMs ?? [30_000, 120_000, 600_000];
  }

  /** O plugin de e-mail registra aqui como enviar (ou null para tirar). */
  setEmailSender(sender: EmailSender | null): void {
    this.emailSender = sender;
  }

  // -------------------------------------------------------------------------
  // Carga, cifra e gravação
  // -------------------------------------------------------------------------

  private ensureLoaded(): Promise<void> {
    this.loading ??= (async () => {
      await this.loadKey();
      try {
        const raw = JSON.parse(await readFile(this.file, "utf8")) as Partial<StoredConfig>;
        const base = emptyConfig();
        this.config = {
          telegram: raw.telegram ?? null,
          email: {
            recipients: Array.isArray(raw.email?.recipients) ? raw.email.recipients : [],
            testedAt: raw.email?.testedAt ?? null,
          },
          kinds: { ...base.kinds, ...(raw.kinds ?? {}) },
        };
      } catch {
        this.config = emptyConfig();
      }
      if (this.config.telegram) {
        try {
          this.token = this.open(this.config.telegram.token);
        } catch {
          this.log("Notificações: não foi possível decifrar o token do Telegram (arquivo ou chave alterados). Conecte o robô de novo.");
          this.config.telegram = null;
        }
      }
      try {
        const raw = JSON.parse(await readFile(this.historyFile, "utf8")) as { entries?: NotificationHistoryEntry[] };
        this.history = Array.isArray(raw.entries) ? raw.entries : [];
      } catch {
        this.history = [];
      }
    })();
    return this.loading;
  }

  private async loadKey(): Promise<void> {
    try {
      const raw = Buffer.from((await readFile(this.keyFile, "utf8")).trim(), "hex");
      if (raw.length === KEY_BYTES) {
        this.key = raw;
        return;
      }
    } catch {
      // sem chave ainda — gera abaixo
    }
    const fresh = randomBytes(KEY_BYTES);
    await mkdir(path.dirname(this.keyFile), { recursive: true });
    await writeFile(this.keyFile, fresh.toString("hex") + "\n", { encoding: "utf8", mode: 0o600 });
    await chmod(this.keyFile, 0o600);
    this.key = fresh;
  }

  private seal(secret: string): SealedBox {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key!, iv);
    const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  }

  private open(box: SealedBox): string {
    const decipher = createDecipheriv("aes-256-gcm", this.key!, Buffer.from(box.iv, "base64"));
    decipher.setAuthTag(Buffer.from(box.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]).toString("utf8");
  }

  private async writeJson(file: string, data: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await chmod(file, 0o600);
  }

  /** Grava configuração (e histórico) em fila; falha de disco vai para o log. */
  private persist(what: { config?: boolean; history?: boolean }): Promise<void> {
    const config = what.config ? structuredClone(this.config) : null;
    const history = what.history ? [...this.history] : null;
    this.writing = this.writing.then(async () => {
      try {
        if (config) await this.writeJson(this.file, config);
        if (history) await this.writeJson(this.historyFile, { entries: history });
      } catch (err) {
        this.log(`Notificações: não foi possível gravar no disco (${(err as Error).message}).`);
      }
    });
    return this.writing;
  }

  /** Espera as gravações pendentes (antes de desligar ou de apagar o diretório). */
  async flush(): Promise<void> {
    await this.writing;
  }

  private record(action: string, detail: string, actor: string): void {
    void this.audit?.record({ action, detail, actor, target: "notificações" })?.catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Situação
  // -------------------------------------------------------------------------

  /** Situação do servidor de e-mail; sem pronto, `reason` sempre explica o que falta. */
  private async emailReadiness(): Promise<{ ready: boolean; reason: string; from: string | null }> {
    if (!this.emailSender) {
      return { ready: false, reason: "O servidor de e-mail do painel não está disponível nesta instalação.", from: null };
    }
    try {
      const r = await this.emailSender.readiness();
      return { ready: r.ready, reason: r.reason ?? "O servidor de e-mail do painel não está pronto.", from: r.from };
    } catch {
      return { ready: false, reason: "Não foi possível conferir o servidor de e-mail agora. Tente de novo em instantes.", from: null };
    }
  }

  async status(): Promise<NotificationsStatus> {
    await this.ensureLoaded();
    const t = this.config.telegram;
    const readiness = await this.emailReadiness();
    return {
      telegram: {
        state: !t ? "none" : t.chatId ? "connected" : "awaiting_chat",
        botUsername: t?.botUsername ?? null,
        chatTitle: t?.chatTitle ?? null,
        connectedAt: t?.connectedAt ?? null,
        testedAt: t?.testedAt ?? null,
      },
      email: {
        available: readiness.ready,
        unavailableReason: readiness.ready ? null : readiness.reason,
        from: readiness.from,
        recipients: [...this.config.email.recipients],
        testedAt: this.config.email.testedAt,
      },
      kinds: { ...this.config.kinds },
      history: [...this.history].reverse(),
    };
  }

  async facts(): Promise<NotificationFacts> {
    await this.ensureLoaded();
    const t = this.config.telegram;
    const e = this.config.email;
    return {
      channels: [
        { id: "telegram", connected: Boolean(t?.chatId), tested: Boolean(t?.chatId && t.testedAt) },
        { id: "email", connected: e.recipients.length > 0, tested: e.recipients.length > 0 && Boolean(e.testedAt) },
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Telegram
  // -------------------------------------------------------------------------

  async setTelegramToken(rawToken: string, actor: string): Promise<NotificationsStatus> {
    await this.ensureLoaded();
    const token = rawToken.trim();
    let bot: { username: string };
    try {
      bot = await this.telegram.getMe(token);
    } catch (err) {
      if (err instanceof TelegramError && err.code === "invalid_token") {
        throw httpError(400, "invalid_token", err.message);
      }
      throw httpError(502, "telegram_unreachable", shortReason(err));
    }
    this.token = token;
    this.config.telegram = {
      token: this.seal(token),
      botUsername: bot.username,
      chatId: null,
      chatTitle: null,
      connectedAt: null,
      testedAt: null,
    };
    await this.persist({ config: true });
    this.record("notifications.telegram_token", `Robô do Telegram @${bot.username} informado; falta conectar a conversa.`, actor);
    return this.status();
  }

  async connectTelegram(actor: string): Promise<NotificationsStatus> {
    await this.ensureLoaded();
    const t = this.config.telegram;
    if (!t || !this.token) {
      throw httpError(409, "telegram_no_token", "Cole primeiro o token do robô que o @BotFather mandou.");
    }
    let chat;
    try {
      chat = await this.telegram.findLatestChat(this.token);
    } catch (err) {
      throw httpError(409, "telegram_error", shortReason(err));
    }
    if (!chat) {
      throw httpError(
        409,
        "telegram_no_chat",
        `Ainda não chegou nenhuma mensagem para @${t.botUsername}. Abra a conversa com ele no Telegram, mande /start e clique em Conectar de novo.`,
      );
    }
    t.chatId = chat.chatId;
    t.chatTitle = chat.title;
    t.connectedAt = new Date(this.now()).toISOString();
    t.testedAt = null;
    await this.persist({ config: true });
    this.record("notifications.telegram_connected", `Telegram conectado à conversa "${chat.title}" (robô @${t.botUsername}).`, actor);
    return this.status();
  }

  async testTelegram(actor: string): Promise<NotificationsStatus> {
    await this.ensureLoaded();
    const t = this.config.telegram;
    if (!t?.chatId || !this.token) {
      throw httpError(409, "telegram_not_connected", "Conecte o Telegram antes de enviar o teste.");
    }
    const message = await this.render({
      title: "Teste de notificação",
      body: ["Se você recebeu esta mensagem, os avisos do painel vão chegar por aqui."],
    });
    const entry = this.addHistory("telegram", "test", message.title);
    try {
      await this.telegram.sendMessage(this.token, t.chatId, message.text);
    } catch (err) {
      this.finishEntry(entry, "failed", shortReason(err));
      await this.persist({ history: true });
      this.record("notifications.test", "Teste pelo Telegram: falhou.", actor);
      throw httpError(502, "telegram_send_failed", shortReason(err));
    }
    this.finishEntry(entry, "sent", null);
    t.testedAt = new Date(this.now()).toISOString();
    await this.persist({ config: true, history: true });
    this.record("notifications.test", "Teste pelo Telegram: enviado.", actor);
    return this.status();
  }

  async removeTelegram(actor: string): Promise<NotificationsStatus> {
    await this.ensureLoaded();
    this.config.telegram = null;
    this.token = null;
    await this.persist({ config: true });
    this.record("notifications.telegram_removed", "Telegram desconectado; o token do robô foi apagado do painel.", actor);
    return this.status();
  }

  // -------------------------------------------------------------------------
  // E-mail
  // -------------------------------------------------------------------------

  private async requireEmailReady(): Promise<void> {
    const readiness = await this.emailReadiness();
    if (!readiness.ready) {
      throw httpError(409, "email_unavailable", readiness.reason);
    }
  }

  async setEmailRecipients(list: string[], actor: string): Promise<NotificationsStatus> {
    await this.ensureLoaded();
    const recipients: string[] = [];
    for (const raw of list) {
      const address = raw.trim().toLowerCase();
      if (!isSingleEmailAddress(address)) {
        throw httpError(400, "invalid_recipient", `"${raw.trim() || "(vazio)"}" não é um endereço de e-mail válido.`);
      }
      if (!recipients.includes(address)) recipients.push(address);
    }
    if (recipients.length === 0) {
      throw httpError(400, "invalid_recipient", "Informe pelo menos um endereço de e-mail.");
    }
    if (recipients.length > MAX_NOTIFICATION_RECIPIENTS) {
      throw httpError(400, "too_many_recipients", `No máximo ${MAX_NOTIFICATION_RECIPIENTS} endereços.`);
    }
    await this.requireEmailReady();
    const same =
      recipients.length === this.config.email.recipients.length &&
      recipients.every((r) => this.config.email.recipients.includes(r));
    this.config.email = { recipients, testedAt: same ? this.config.email.testedAt : null };
    await this.persist({ config: true });
    this.record("notifications.email_saved", `Avisos por e-mail para ${recipients.length} endereço(s).`, actor);
    return this.status();
  }

  async testEmail(actor: string): Promise<NotificationsStatus> {
    await this.ensureLoaded();
    const { recipients } = this.config.email;
    if (recipients.length === 0) {
      throw httpError(409, "email_no_recipients", "Salve pelo menos um endereço antes de enviar o teste.");
    }
    await this.requireEmailReady();
    const message = await this.render({
      title: "Teste de notificação",
      body: ["Se você recebeu esta mensagem, os avisos do painel vão chegar neste endereço."],
    });
    let failure: unknown = null;
    for (const to of recipients) {
      const entry = this.addHistory("email", "test", message.title);
      try {
        await this.emailSender!.send({ to, subject: message.subject, text: message.text, html: message.html });
        this.finishEntry(entry, "sent", null);
      } catch (err) {
        failure ??= err;
        this.finishEntry(entry, "failed", shortReason(err));
      }
    }
    if (failure) {
      await this.persist({ history: true });
      this.record("notifications.test", "Teste por e-mail: falhou.", actor);
      throw httpError(502, "email_send_failed", `O servidor de e-mail não aceitou o teste: ${shortReason(failure)}`);
    }
    this.config.email.testedAt = new Date(this.now()).toISOString();
    await this.persist({ config: true, history: true });
    this.record("notifications.test", `Teste por e-mail: enviado para ${recipients.length} endereço(s).`, actor);
    return this.status();
  }

  async removeEmail(actor: string): Promise<NotificationsStatus> {
    await this.ensureLoaded();
    this.config.email = { recipients: [], testedAt: null };
    await this.persist({ config: true });
    this.record("notifications.email_removed", "Avisos por e-mail desligados.", actor);
    return this.status();
  }

  // -------------------------------------------------------------------------
  // Tipos
  // -------------------------------------------------------------------------

  async setKinds(kinds: Partial<Record<NotificationKind, boolean>>, actor: string): Promise<NotificationsStatus> {
    await this.ensureLoaded();
    for (const kind of NOTIFICATION_KINDS) {
      const value = kinds[kind];
      if (typeof value === "boolean") this.config.kinds[kind] = value;
    }
    await this.persist({ config: true });
    const summary = NOTIFICATION_KINDS.map(
      (k) => `${NOTIFICATION_KIND_LABELS[k].title}: ${this.config.kinds[k] ? "sim" : "não"}`,
    ).join("; ");
    this.record("notifications.kinds", `O que avisa: ${summary}.`, actor);
    return this.status();
  }

  // -------------------------------------------------------------------------
  // Envio dos avisos
  // -------------------------------------------------------------------------

  private async render(input: { title: string; body?: string[]; path?: string }): Promise<Rendered> {
    const title = maskSensitive(input.title);
    const body = (input.body ?? []).map(maskSensitive);
    let base: string | null = null;
    try {
      base = this.panelUrl ? await this.panelUrl() : null;
    } catch {
      base = null;
    }
    const link = base ? `${base.replace(/\/+$/, "")}${input.path ?? ""}` : null;
    const footer = link ? `Abrir o painel: ${link}` : "Veja os detalhes no painel.";
    const text = [`TWS Panel: ${title}`, ...(body.length ? ["", ...body] : []), "", footer].join("\n");
    const html = [
      `<p><strong>${escapeHtml(title)}</strong></p>`,
      ...body.map((line) => `<p>${escapeHtml(line)}</p>`),
      link
        ? `<p><a href="${escapeHtml(link)}">Abrir o painel</a></p>`
        : "<p>Veja os detalhes no painel.</p>",
      '<p style="color:#888;font-size:12px">Aviso automático do TWS Panel. Para mudar o que chega aqui, abra Configurações → Notificações.</p>',
    ].join("\n");
    return { title, subject: `[TWS Panel] ${title}`, text, html };
  }

  private addHistory(channel: NotificationChannelId, kind: NotificationHistoryEntry["kind"], title: string): NotificationHistoryEntry {
    const entry: NotificationHistoryEntry = {
      id: randomBytes(6).toString("hex"),
      at: new Date(this.now()).toISOString(),
      channel,
      kind,
      title,
      status: "retrying",
      detail: null,
    };
    this.history.push(entry);
    if (this.history.length > MAX_HISTORY) this.history = this.history.slice(-MAX_HISTORY);
    return entry;
  }

  private finishEntry(entry: NotificationHistoryEntry, status: NotificationHistoryEntry["status"], detail: string | null): void {
    entry.status = status;
    entry.detail = detail;
  }

  /** Canais que recebem avisos agora. */
  private activeChannels(): NotificationChannelId[] {
    const out: NotificationChannelId[] = [];
    if (this.config.telegram?.chatId && this.token) out.push("telegram");
    if (this.config.email.recipients.length > 0) out.push("email");
    return out;
  }

  private takeSlot(channel: NotificationChannelId): boolean {
    const now = this.now();
    this.sentAt[channel] = this.sentAt[channel].filter((t) => now - t < HOUR_MS);
    if (this.sentAt[channel].length >= this.maxPerHour) return false;
    this.sentAt[channel].push(now);
    return true;
  }

  /** Um aviso pedido por algum módulo. Nunca lança: falha vai para o histórico e o log. */
  async notify(event: NotificationEvent): Promise<void> {
    await this.ensureLoaded();
    if (!this.config.kinds[event.kind]) return;
    if (this.activeChannels().length === 0) return;
    const now = this.now();
    const group = this.groups.get(event.key);
    if (group && now < group.windowEnd) {
      group.count += 1;
      return;
    }
    this.groups.set(event.key, {
      kind: event.kind,
      title: event.title,
      path: event.path,
      windowEnd: now + this.groupWindowMs,
      count: 0,
    });
    await this.dispatch(event.kind, await this.render(event));
  }

  private async dispatch(kind: NotificationHistoryEntry["kind"], message: Rendered): Promise<void> {
    for (const channel of this.activeChannels()) {
      if (!this.takeSlot(channel)) {
        this.suppressed[channel] += 1;
        continue;
      }
      const targets = channel === "email" ? [...this.config.email.recipients] : [null];
      for (const to of targets) {
        const entry = this.addHistory(channel, kind, message.title);
        await this.attempt({ entry, channel, to, message, attempt: 0, nextAt: 0 });
      }
    }
    await this.persist({ history: true });
  }

  private async deliver(d: Delivery): Promise<void> {
    if (d.channel === "telegram") {
      const t = this.config.telegram;
      if (!t?.chatId || !this.token) {
        throw Object.assign(new Error("O Telegram foi desconectado antes do envio."), { permanent: true });
      }
      await this.telegram.sendMessage(this.token, t.chatId, d.message.text);
      return;
    }
    const readiness = await this.emailReadiness();
    if (!readiness.ready) throw new Error(readiness.reason);
    await this.emailSender!.send({ to: d.to!, subject: d.message.subject, text: d.message.text, html: d.message.html });
  }

  private async attempt(d: Delivery): Promise<void> {
    try {
      await this.deliver(d);
      this.finishEntry(d.entry, "sent", null);
    } catch (err) {
      const reason = shortReason(err);
      const delay = this.retryDelaysMs[d.attempt];
      if (isPermanent(err) || delay === undefined) {
        this.finishEntry(d.entry, "failed", reason);
        this.log(`Notificações: aviso "${d.message.title}" não foi enviado pelo ${d.channel === "telegram" ? "Telegram" : "e-mail"} (${reason}).`);
        return;
      }
      const asked = err instanceof TelegramError && err.retryAfterMs ? err.retryAfterMs : 0;
      this.finishEntry(d.entry, "retrying", reason);
      this.retries.push({ ...d, attempt: d.attempt + 1, nextAt: this.now() + Math.max(delay, asked) });
    }
  }

  /**
   * Trabalho periódico: resumos de repetidos cuja janela acabou, novas
   * tentativas vencidas e o resumo do que ficou de fora pelo limite por hora.
   */
  async tick(): Promise<void> {
    await this.ensureLoaded();
    const now = this.now();

    for (const [key, group] of [...this.groups]) {
      if (now < group.windowEnd) continue;
      this.groups.delete(key);
      if (group.count === 0 || !this.config.kinds[group.kind]) continue;
      const times = group.count === 1 ? "1 vez" : `${group.count} vezes`;
      const minutes = Math.round(this.groupWindowMs / 60_000);
      await this.dispatch(
        group.kind,
        await this.render({
          title: `${group.title} (repetiu ${times} nos últimos ${minutes} minutos)`,
          ...(group.path ? { path: group.path } : {}),
        }),
      );
    }

    const due = this.retries.filter((d) => d.nextAt <= now);
    if (due.length > 0) {
      this.retries = this.retries.filter((d) => d.nextAt > now);
      for (const d of due) {
        await this.attempt(d);
      }
      await this.persist({ history: true });
    }

    for (const channel of ["telegram", "email"] as const) {
      const count = this.suppressed[channel];
      if (count === 0 || !this.activeChannels().includes(channel)) continue;
      if (!this.takeSlot(channel)) continue;
      this.suppressed[channel] = 0;
      const message = await this.render({
        title: `${count} avisos não foram enviados para não lotar`,
        body: [`O limite é de ${this.maxPerHour} avisos por hora. Veja os alertas no painel.`],
        path: "/alerts",
      });
      const targets = channel === "email" ? [...this.config.email.recipients] : [null];
      for (const to of targets) {
        const entry = this.addHistory(channel, "summary", message.title);
        await this.attempt({ entry, channel, to, message, attempt: 0, nextAt: 0 });
      }
      await this.persist({ history: true });
    }
  }

  start(intervalMs = DEFAULT_TICK_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err: unknown) =>
        this.log(`Notificações: falha no envio periódico (${err instanceof Error ? err.message : String(err)}).`),
      );
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
