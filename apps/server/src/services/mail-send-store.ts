/**
 * mail-send-store.ts — o que fica no disco do registro de envios por SMTP.
 *
 *  - data/mail/envios/saidas/AAAA-MM-DD.jsonl (0600, pasta 0700): metadados de
 *    cada mensagem (um instantâneo por linha; vale o último de cada id). Dia =
 *    dia em que o servidor aceitou a mensagem. Entra no backup do painel.
 *    NUNCA tem assunto nem corpo.
 *  - data/mail/envios/saidas-config.json (0600): retenção e privacidade.
 *  - data/envios-conteudo/<id>.json (0600, pasta 0700): assunto e corpo de UMA
 *    mensagem cada. Fica numa pasta própria de propósito: o backup do painel
 *    a deixa de fora (MAIL_SEND_CONTENT_DIRNAME em backup-service.ts).
 *
 * Tudo em memória é o índice dos metadados (leitura de listagem sem tocar no
 * disco). Gravação é sempre por acréscimo de linha ou troca atômica de
 * arquivo; linha corrompida é ignorada na leitura (nunca derruba o painel).
 */
import { appendFile, chmod, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  MAIL_SEND_CONTENT_DIRNAME,
  MAIL_SEND_DEFAULT_SETTINGS,
  MAIL_SEND_LIMITS,
  type MailSendAttachment,
  type MailSendFailure,
  type MailSendOrigin,
  type MailSendSettings,
  type MailSendState,
} from "@paas/core";
import { isQueueId } from "@paas/mailer";
import { loadJson, withFileLock, writeFileAtomic } from "./json-file.js";

export interface StoredRecipient {
  address: string;
  domain: string;
  state: MailSendState;
  deferrals: number;
  updatedAt: string | null;
  nextRetryAt: string | null;
  remoteHost: string | null;
  error: MailSendFailure | null;
}

/** "none" = sem conteúdo guardado; "stored" = guardado; "expired" = apagado pela retenção; "removed" = apagado porque a gravação foi desligada. */
export type StoredContentState = "none" | "stored" | "expired" | "removed";

export interface StoredSend {
  id: string;
  at: string;
  from: string;
  login: string | null;
  mailbox: string | null;
  origin: MailSendOrigin;
  projectId: string | null;
  /** Nome do projeto no momento do envio (o projeto pode ter sido removido depois). */
  projectName: string | null;
  size: number;
  attachments: MailSendAttachment[];
  recipients: StoredRecipient[];
  content: StoredContentState;
  truncated: boolean;
  captured: boolean;
}

export interface StoredContent {
  id: string;
  subject: string | null;
  body: string | null;
  bodyTruncated: boolean;
  attachments: MailSendAttachment[];
  storedAt: string;
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY = 86_400_000;

function clamp(value: unknown, range: { min: number; max: number }, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(range.max, Math.max(range.min, Math.round(value))) : fallback;
}

/** Aceita só o que o painel conhece; o resto volta ao padrão. */
export function normalizeSettings(raw: unknown): MailSendSettings {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const d = MAIL_SEND_DEFAULT_SETTINGS;
  const metadataDays = clamp(o.metadataDays, MAIL_SEND_LIMITS.metadataDays, d.metadataDays);
  const bodyDays = Math.min(clamp(o.bodyDays, MAIL_SEND_LIMITS.bodyDays, d.bodyDays), metadataDays);
  const projects = Array.isArray(o.projectsWithoutContent)
    ? o.projectsWithoutContent.filter((p): p is string => typeof p === "string" && p.length > 0 && p.length <= 64)
    : [];
  return {
    metadataDays,
    bodyDays,
    storeContent: typeof o.storeContent === "boolean" ? o.storeContent : d.storeContent,
    maxBodyKiB: clamp(o.maxBodyKiB, MAIL_SEND_LIMITS.maxBodyKiB, d.maxBodyKiB),
    maxTotalMiB: clamp(o.maxTotalMiB, MAIL_SEND_LIMITS.maxTotalMiB, d.maxTotalMiB),
    projectsWithoutContent: [...new Set(projects)].sort(),
  };
}

export class MailSendStore {
  readonly dir: string;
  readonly contentDir: string;
  private readonly settingsFile: string;
  private records = new Map<string, StoredSend>();
  private loaded = false;
  /** Ids cujo último instantâneo ainda não foi gravado em disco. */
  private readonly unsaved = new Set<string>();
  /** Gravações em ordem: uma de cada vez. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly now: () => number = Date.now,
    /** Aviso para o log do painel (erro de gravação de OUTRO dia que não impede o envio atual de ser salvo). */
    private readonly log: (message: string) => void = () => undefined,
  ) {
    this.dir = path.join(dataDir, "mail", "envios", "saidas");
    this.settingsFile = path.join(dataDir, "mail", "envios", "saidas-config.json");
    this.contentDir = path.join(dataDir, MAIL_SEND_CONTENT_DIRNAME);
  }

  // -------------------------------------------------------------------------
  // Configuração
  // -------------------------------------------------------------------------

  async loadSettings(): Promise<MailSendSettings> {
    return loadJson(this.settingsFile, { empty: () => normalizeSettings({}), parse: (v) => normalizeSettings(v) });
  }

  async saveSettings(settings: MailSendSettings): Promise<void> {
    await mkdir(path.dirname(this.settingsFile), { recursive: true, mode: 0o700 });
    await withFileLock(this.settingsFile, () => writeFileAtomic(this.settingsFile, JSON.stringify(normalizeSettings(settings), null, 2) + "\n"));
  }

  // -------------------------------------------------------------------------
  // Metadados
  // -------------------------------------------------------------------------

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Lê os dias guardados para a memória. Chamado uma vez; sem pasta = vazio. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.records = new Map();
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch {
      names = [];
    }
    for (const name of names.sort()) {
      if (!DAY_FILE.test(name)) continue;
      let text = "";
      try {
        text = await readFile(path.join(this.dir, name), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as StoredSend;
          if (typeof rec?.id === "string" && isQueueId(rec.id) && Array.isArray(rec.recipients)) this.records.set(rec.id, rec);
        } catch {
          // linha cortada por queda de energia: ignora
        }
      }
    }
    this.loaded = true;
  }

  get(id: string): StoredSend | undefined {
    return this.records.get(id);
  }

  all(): StoredSend[] {
    return [...this.records.values()];
  }

  /**
   * Guarda o instantâneo (memória na hora; disco em seguida, em ordem). Se a gravação em disco falhar, o
   * instantâneo fica anotado como pendente e é regravado na próxima gravação ou na próxima limpeza: sem isso o envio
   * aparecia na tela (memória) e sumia na reinicialização do painel, que relê só o disco.
   */
  put(rec: StoredSend): Promise<void> {
    this.records.set(rec.id, rec);
    this.unsaved.add(rec.id);
    return this.enqueue(() => this.flushUnsaved(rec.id));
  }

  /** Quantos instantâneos ainda não chegaram ao disco (para teste e diagnóstico). */
  get pendingWrites(): number {
    return this.unsaved.size;
  }

  /**
   * Grava, em ordem, o que ainda não está no disco. Cada instantâneo é tentado por conta própria: um arquivo de dia
   * quebrado não trava os outros dias. Só sai da lista de pendentes quem foi gravado E ainda é a versão que está na
   * memória (se mudou durante a gravação, a nova versão continua pendente). Quem pediu a gravação (`ownId`) só recebe
   * erro se o SEU envio continua fora do disco; falha de outro dia é registrada no log e não é repassada.
   */
  private async flushUnsaved(ownId?: string): Promise<void> {
    if (this.unsaved.size === 0) return;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const errors = new Map<string, unknown>();
    for (const id of [...this.unsaved]) {
      const rec = this.records.get(id);
      if (!rec) {
        this.unsaved.delete(id);
        continue;
      }
      try {
        const file = path.join(this.dir, `${rec.at.slice(0, 10)}.jsonl`);
        await appendFile(file, JSON.stringify(rec) + "\n", { encoding: "utf8", mode: 0o600 });
        if (this.records.get(id) === rec) this.unsaved.delete(id);
      } catch (err) {
        errors.set(id, err);
      }
    }
    if (ownId !== undefined && this.unsaved.has(ownId) && errors.has(ownId)) throw errors.get(ownId);
    for (const [id, err] of errors) {
      if (id !== ownId) this.log(`Registro de envios: não consegui gravar o envio ${id} em disco (${err instanceof Error ? err.message : String(err)}). Tento de novo na próxima gravação.`);
    }
  }

  /** Dias (AAAA-MM-DD) que ainda têm instantâneo pendente. */
  private pendingDays(): Set<string> {
    const days = new Set<string>();
    for (const id of this.unsaved) {
      const rec = this.records.get(id);
      if (rec) days.add(rec.at.slice(0, 10));
    }
    return days;
  }

  // -------------------------------------------------------------------------
  // Conteúdo (assunto e corpo)
  // -------------------------------------------------------------------------

  private contentPath(id: string): string {
    if (!isQueueId(id)) throw new Error("id de mensagem inválido");
    return path.join(this.contentDir, `${id}.json`);
  }

  async writeContent(content: StoredContent): Promise<void> {
    await mkdir(this.contentDir, { recursive: true, mode: 0o700 });
    await chmod(this.contentDir, 0o700).catch(() => undefined);
    await writeFileAtomic(this.contentPath(content.id), JSON.stringify(content) + "\n");
    await chmod(this.contentPath(content.id), 0o600).catch(() => undefined);
  }

  async readContent(id: string): Promise<StoredContent | null> {
    try {
      const v = JSON.parse(await readFile(this.contentPath(id), "utf8")) as StoredContent;
      return typeof v === "object" && v !== null && v.id === id ? v : null;
    } catch {
      return null;
    }
  }

  async deleteContent(id: string): Promise<void> {
    await rm(this.contentPath(id), { force: true });
  }

  /** Arquivos de conteúdo com tamanho e data (para a retenção). */
  async contentFiles(): Promise<Array<{ id: string; size: number; mtimeMs: number }>> {
    let names: string[] = [];
    try {
      names = await readdir(this.contentDir);
    } catch {
      return [];
    }
    const out: Array<{ id: string; size: number; mtimeMs: number }> = [];
    for (const name of names) {
      const m = /^(\d{1,20})\.json$/.exec(name);
      if (!m) continue;
      try {
        const s = await stat(path.join(this.contentDir, name));
        out.push({ id: m[1]!, size: s.size, mtimeMs: s.mtimeMs });
      } catch {
        // sumiu no meio
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Retenção
  // -------------------------------------------------------------------------

  /**
   * Apaga os dias além de `metadataDays` (e o conteúdo dessas mensagens) e
   * enxuga os dias que têm muito instantâneo repetido.
   */
  async prune(metadataDays: number): Promise<{ removedDays: number; removedRecords: number }> {
    const cutoffDay = new Date(this.now() - metadataDays * DAY).toISOString().slice(0, 10);
    let removedDays = 0;
    let removedRecords = 0;
    for (const rec of this.all()) {
      if (rec.at.slice(0, 10) < cutoffDay) {
        this.records.delete(rec.id);
        removedRecords++;
        await this.deleteContent(rec.id).catch(() => undefined);
      }
    }
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch {
      return { removedDays, removedRecords };
    }
    await this.enqueue(async () => {
      await this.flushUnsaved().catch(() => undefined);
      // Só o dia que ainda tem instantâneo fora do disco deixa de ser enxugado (reescrevê-lo o perderia de vez);
      // os outros dias seguem normalmente.
      const blocked = this.pendingDays();
      for (const name of names) {
        const m = DAY_FILE.exec(name);
        if (!m) continue;
        const file = path.join(this.dir, name);
        if (m[1]! < cutoffDay) {
          await rm(file, { force: true });
          removedDays++;
          continue;
        }
        if (!blocked.has(m[1]!)) await this.compactDay(file, m[1]!);
      }
    });
    return { removedDays, removedRecords };
  }

  /** Reescreve o dia só com o último instantâneo de cada mensagem, se valer a pena. */
  private async compactDay(file: string, day: string): Promise<void> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return;
    }
    const lines = text.split("\n").filter((l) => l.trim());
    const mine = this.all().filter((r) => r.at.slice(0, 10) === day);
    if (lines.length <= mine.length * 2 + 10) return;
    await writeFileAtomic(file, mine.map((r) => JSON.stringify(r)).join("\n") + "\n");
    await chmod(file, 0o600).catch(() => undefined);
  }
}
