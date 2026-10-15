/**
 * backup-service.ts — serviço central dos backups (Configurações → Backups e
 * aba Backups de cada projeto).
 *
 * Criado em app.ts e decorado no escopo RAIZ (como as notificações): as rotas
 * de backup, as de projetos (escolha "Fazer backup" na criação, apagar o
 * projeto) e o gancho do deploy (detecção depois de publicar) usam o mesmo
 * objeto.
 *
 * O que faz:
 *  - fila: um backup (ou restauração) por vez, em segundo plano, sem travar
 *    o painel. Cada item vira um registro com etapas, para a tela acompanhar;
 *  - agenda: 03:00 no fuso da VPS e depois a cada 24, 12 ou 6 h (por item);
 *  - cópia na VPS: sempre, sem senha, as N mais recentes (padrão 2) em
 *    data/backups/<pasta>/AAAA-MM-DD_HH-MM.7z (fora do backup do painel);
 *  - cópia externa (S3/R2): cifrada ou não; depois do envio baixa de volta,
 *    confere o hash e abre com o 7-Zip (`7z t`). Só então apaga as antigas
 *    além das N mais recentes (padrão 5). Falhou → não apaga nada e avisa;
 *  - restauração do projeto (bancos e pastas), do e-mail e do painel (este
 *    na subida seguinte, ver panel-restore.ts);
 *  - avisos (notificações): backup que falhou, externo atrasado e o lembrete
 *    trimestral da senha.
 *
 * Segredos: a chave secreta do armazenamento e a senha dos backups ficam
 * CIFRADAS em data/backups.json (AES-256-GCM, chave própria em
 * data/backups-key, mesmo padrão do token do Telegram). Nunca voltam pela
 * API (a senha só pela revelação com a senha de login) e nunca vão para a
 * auditoria nem para o log. A senha chega ao 7-Zip pela entrada padrão.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, realpath, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BACKUP_ENGINE_LABELS,
  BACKUP_FREQUENCIES,
  BACKUP_ROOT_FOLDER,
  DEFAULT_BACKUP_HOUR,
  DEFAULT_LOCAL_KEEP,
  DEFAULT_REMOTE_KEEP,
  MAX_BACKUP_KEEP,
  MAX_BACKUP_PASSWORD_LENGTH,
  MIN_BACKUP_PASSWORD_LENGTH,
  backupFileStamp,
  backupFolderFor,
  backupPasswordStrength,
  isValidBackupFileName,
  parseBackupFileStamp,
  type BackupCatalog,
  type BackupDatabaseEngine,
  type BackupDestinationInfo,
  type BackupDestinationRequest,
  type BackupFrequencyHours,
  type BackupPoint,
  type BackupProvider,
  type BackupRecord,
  type BackupRestoreRequest,
  type BackupRunStep,
  type BackupsStatus,
  type BackupTargetKind,
  type BackupTargetSettingsRequest,
  type BackupTargetStatus,
  type ExtraBackupFolder,
  type Project,
  type ProjectBackupDetection,
  type ProjectBackupView,
} from "@paas/core";
import { ArchiveError } from "./backup-archive.js";
import {
  PG_GLOBALS_RESTORE,
  REDIS_SAVE,
  buildDetection,
  dumpPlan,
  itemFileName,
  mountId,
  restoreScript,
} from "./backup-detect.js";
import type { BackupDocker, ProjectContainer } from "./backup-docker.js";
import { suggestPassphrase } from "./backup-passphrase.js";
import { StorageError, type BackupStorage } from "./backup-s3.js";
import { currentSlot, isReminderDue, isRemoteStale, nextSlot, timezoneLabel } from "./backup-schedule.js";
import { httpError } from "./http-error.js";
import { PANEL_PRESERVED, PANEL_RESTORE_DIR, PANEL_RESTORE_MARKER, type PanelRestoreMarker } from "./panel-restore.js";
import type { NotificationEvent } from "./notification-service.js";

// ---------------------------------------------------------------------------
// Dependências
// ---------------------------------------------------------------------------

export interface Archiver {
  available(): Promise<boolean>;
  create(archive: string, inputs: string[], opts: { password?: string | null }): Promise<void>;
  test(archive: string, password: string | null): Promise<void>;
  extract(archive: string, outDir: string, password: string | null): Promise<void>;
}

export interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface BackupProjects {
  list(): Promise<Project[]>;
  get(id: string): Promise<Project | null>;
  /** Pasta do código no servidor (projetos que não vêm do GitHub). */
  srcDir(project: Project): string;
  /** Publica o projeto (do GitHub) e espera o deploy terminar. */
  redeploy(id: string): Promise<void>;
}

/** tar local (pasta do código dos projetos que não vêm do GitHub). */
export interface LocalTar {
  create(parent: string, name: string, outFile: string): Promise<void>;
  extract(file: string, parent: string): Promise<void>;
}

export interface MailBackupTargets {
  container: string;
  volume: string;
  /** Pasta de dados dentro do container (o volume). */
  dataPath: string;
  /** Pasta da configuração dentro do container. */
  etcPath: string;
  webmailContainer: string;
  webmailVolume: string;
  webmailPath: string;
}

export interface BackupAuditSink {
  record(input: { action: string; detail: string; actor?: string; target?: string | null }): Promise<unknown>;
}

export interface BackupServiceOptions {
  dataDir: string;
  projectsDir: string;
  docker: BackupDocker;
  archiver: Archiver;
  storage: (cfg: StorageConfig) => BackupStorage;
  projects: BackupProjects;
  mail: MailBackupTargets;
  /** Confere a senha de login de quem pede para ver a senha dos backups. */
  verifyLogin: (userId: string, password: string) => Promise<boolean>;
  notify?: (e: NotificationEvent) => void;
  audit?: BackupAuditSink;
  log?: (message: string) => void;
  now?: () => number;
  statfs?: (p: string) => Promise<{ bavail: number; bsize: number; blocks: number }>;
  tar?: LocalTar;
  /** Reinicia o painel (depois de restaurar o painel). */
  restartPanel?: () => void;
  backupHour?: number;
  /** Espera entre as tentativas de falar com o banco que acabou de subir. */
  readyDelayMs?: number;
  /** Espera antes de reiniciar o painel depois de preparar a restauração (padrão 3 s). */
  restartDelayMs?: number;
}

// ---------------------------------------------------------------------------
// Estado em disco
// ---------------------------------------------------------------------------

interface SealedBox {
  iv: string;
  tag: string;
  data: string;
}

interface StoredDestination {
  provider: BackupProvider;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secret: SealedBox;
  connectedAt: string;
  testedAt: string | null;
}

interface StoredEncryption {
  enabled: boolean;
  password: SealedBox | null;
  passwordSetAt: string | null;
  acknowledgedAt: string | null;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastReminderAt: string | null;
}

interface StoredTarget {
  enabled: boolean;
  frequencyHours: BackupFrequencyHours;
  localKeep: number;
  remoteKeep: number;
  /** Último horário agendado já atendido (ms). */
  lastSlot: number | null;
  enabledSince: string;
  choices: Record<string, boolean>;
  extraFolders: ExtraBackupFolder[];
  lastSuccessAt: string | null;
  lastRemoteVerifiedAt: string | null;
  lastStaleNoticeAt: string | null;
}

interface StoredConfig {
  destination: StoredDestination | null;
  encryption: StoredEncryption;
  targets: Record<string, StoredTarget>;
  detections: Record<string, ProjectBackupDetection>;
}

/** O que vai em manifesto.json dentro do .7z (lido de volta na restauração). */
interface ManifestItem {
  type: "database" | "mount" | "extra" | "source" | "email";
  service?: string;
  engine?: BackupDatabaseEngine;
  /** Postgres: um arquivo por banco. */
  databases?: Array<{ name: string; file: string }>;
  globalsFile?: string;
  file?: string;
  destination?: string;
  mountType?: "volume" | "bind";
  source?: string;
  isFile?: boolean;
  part?: "stalwart-data" | "stalwart-etc" | "webmail";
}

interface Manifest {
  version: 1;
  kind: BackupTargetKind;
  name: string;
  projectId?: string;
  slug?: string;
  createdAt: string;
  items: ManifestItem[];
}

interface Job {
  record: BackupRecord;
  run: (record: BackupRecord) => Promise<void>;
}

/** Erro com mensagem para a pessoa (vai para o histórico como está). */
class BackupFailure extends Error {}

/** Arquivo citado no manifesto: só dentro das pastas que o próprio backup cria. */
const MANIFEST_FILE = /^(bancos|volumes|pastas|codigo|email)(\/[A-Za-z0-9._-]+){1,2}$/;

/**
 * Confere cada arquivo que o manifesto cita antes de tocar em qualquer coisa:
 * um backup trocado por alguém com acesso ao armazenamento não pode apontar
 * para fora da pasta extraída (../, link simbólico, caminho absoluto).
 */
async function checkManifestFiles(manifest: Manifest, content: string): Promise<void> {
  const root = await realpath(content);
  const files = manifest.items.flatMap((i) => [i.file, i.globalsFile, ...(i.databases ?? []).map((d) => d.file)]).filter((f): f is string => f !== undefined);
  for (const f of files) {
    const bad = () => new BackupFailure(`Este backup tem um caminho inválido ("${f.slice(0, 80)}") e não foi restaurado. O arquivo pode ter sido alterado.`);
    if (!MANIFEST_FILE.test(f) || f.split("/").some((seg) => seg === "." || seg === "..")) throw bad();
    let real: string;
    try {
      real = await realpath(path.join(content, f));
    } catch {
      throw bad();
    }
    if (!real.startsWith(root + path.sep)) throw bad();
  }
}

const IV_BYTES = 12;
const KEY_BYTES = 32;
const MAX_HISTORY = 200;
const HOUR_MS = 3_600_000;
const REVEAL_LIMIT = 5;
const REVEAL_WINDOW_MS = 15 * 60_000;
const CHECK_FILE = `${BACKUP_ROOT_FOLDER}/_verificacao/senha.7z`;
const MAX_EXTRA_FOLDERS = 20;

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1).replace(".", ",")} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

function reasonOf(err: unknown): string {
  if (err instanceof BackupFailure || err instanceof StorageError || err instanceof ArchiveError) return err.message;
  const raw = err instanceof Error ? err.message : String(err);
  return raw.slice(0, 300);
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function dirSize(dir: string, skip: (name: string) => boolean = () => false): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (skip(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += (await stat(p)).size;
  }
  return total;
}

function runTar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (c: Buffer) => (err = (err + c.toString()).slice(-2000)));
    child.on("error", (e) => reject(e));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `tar saiu com código ${code}`))));
  });
}

const defaultTar: LocalTar = {
  create: (parent, name, outFile) => runTar(["-cf", outFile, "-C", parent, name]),
  extract: (file, parent) => runTar(["-xf", file, "-C", parent]),
};

function emptyConfig(): StoredConfig {
  return {
    destination: null,
    encryption: {
      enabled: true,
      password: null,
      passwordSetAt: null,
      acknowledgedAt: null,
      lastTestAt: null,
      lastTestOk: null,
      lastReminderAt: null,
    },
    targets: {},
    detections: {},
  };
}

export function projectTargetId(projectId: string): string {
  return `project:${projectId}`;
}

// ---------------------------------------------------------------------------
// Serviço
// ---------------------------------------------------------------------------

export class BackupService {
  private readonly file: string;
  private readonly historyFile: string;
  private readonly keyFile: string;
  readonly backupsDir: string;
  private readonly tmpDir: string;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly statfsFn: (p: string) => Promise<{ bavail: number; bsize: number; blocks: number }>;
  private readonly tar: LocalTar;
  private readonly hour: number;
  private readonly readyDelayMs: number;

  private config: StoredConfig = emptyConfig();
  private history: BackupRecord[] = [];
  private key: Buffer | null = null;
  private loading: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private queue: Job[] = [];
  private running: Job | null = null;
  private idleWaiters: Array<() => void> = [];
  private revealAttempts = new Map<string, number[]>();
  private timer: NodeJS.Timeout | null = null;
  private archiverOk: boolean | null = null;
  private emailAvailable: boolean | null = null;

  constructor(private readonly opts: BackupServiceOptions) {
    this.file = path.join(opts.dataDir, "backups.json");
    this.historyFile = path.join(opts.dataDir, "backups-history.json");
    this.keyFile = path.join(opts.dataDir, "backups-key");
    this.backupsDir = path.join(opts.dataDir, "backups");
    this.tmpDir = path.join(this.backupsDir, ".tmp");
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.warn(m));
    this.statfsFn = opts.statfs ?? ((p) => statfs(p));
    this.tar = opts.tar ?? defaultTar;
    this.hour = opts.backupHour ?? DEFAULT_BACKUP_HOUR;
    this.readyDelayMs = opts.readyDelayMs ?? 2000;
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
          destination: raw.destination ?? null,
          encryption: { ...base.encryption, ...(raw.encryption ?? {}) },
          targets: raw.targets ?? {},
          detections: raw.detections ?? {},
        };
      } catch {
        this.config = emptyConfig();
      }
      if (this.config.destination) {
        try {
          this.open(this.config.destination.secret);
        } catch {
          this.log("Backups: não foi possível decifrar a chave do armazenamento (arquivo ou chave alterados). Conecte o armazenamento de novo.");
          this.config.destination = null;
        }
      }
      if (this.config.encryption.password) {
        try {
          this.open(this.config.encryption.password);
        } catch {
          this.log("Backups: não foi possível decifrar a senha dos backups. Defina a senha de novo.");
          this.config.encryption.password = null;
          this.config.encryption.passwordSetAt = null;
        }
      }
      try {
        const raw = JSON.parse(await readFile(this.historyFile, "utf8")) as { entries?: BackupRecord[] };
        this.history = Array.isArray(raw.entries) ? raw.entries : [];
      } catch {
        this.history = [];
      }
      // O painel caiu no meio de uma operação: ela não vai continuar sozinha.
      let interrupted = false;
      for (const r of this.history) {
        if (r.status === "running" || r.status === "queued") {
          r.status = "failed";
          r.error = "O painel reiniciou durante a operação. Faça de novo.";
          r.finishedAt ??= new Date(this.now()).toISOString();
          interrupted = true;
        }
      }
      if (interrupted) await this.persist({ history: true });
      await rm(this.tmpDir, { recursive: true, force: true }).catch(() => undefined);
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
    const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  }

  private persist(what: { config?: boolean; history?: boolean }): Promise<void> {
    const config = what.config ? structuredClone(this.config) : null;
    const history = what.history ? this.history.slice(-MAX_HISTORY) : null;
    this.writing = this.writing.then(async () => {
      try {
        if (config) await this.writeJson(this.file, config);
        if (history) await this.writeJson(this.historyFile, { entries: history });
      } catch (err) {
        this.log(`Backups: não foi possível gravar no disco (${(err as Error).message}).`);
      }
    });
    return this.writing;
  }

  async flush(): Promise<void> {
    await this.writing;
  }

  private audit(action: string, detail: string, actor: string, target = "backups"): void {
    void this.opts.audit?.record({ action, detail, actor, target })?.catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Itens (painel, e-mail, projetos)
  // -------------------------------------------------------------------------

  private target(id: string): StoredTarget {
    let t = this.config.targets[id];
    if (!t) {
      t = {
        enabled: true,
        frequencyHours: 24,
        localKeep: DEFAULT_LOCAL_KEEP,
        remoteKeep: DEFAULT_REMOTE_KEEP,
        lastSlot: currentSlot(this.now(), 24, this.hour),
        enabledSince: new Date(this.now()).toISOString(),
        choices: {},
        extraFolders: [],
        lastSuccessAt: null,
        lastRemoteVerifiedAt: null,
        lastStaleNoticeAt: null,
      };
      this.config.targets[id] = t;
    }
    return t;
  }

  /** Projeto recém-criado: "Fazer backup: sim/não". */
  async initProject(projectId: string, enabled: boolean): Promise<void> {
    await this.ensureLoaded();
    const t = this.target(projectTargetId(projectId));
    t.enabled = enabled;
    await this.persist({ config: true });
  }

  /** Projeto apagado: esquece a configuração (os arquivos de backup ficam). */
  async forgetProject(projectId: string): Promise<void> {
    await this.ensureLoaded();
    delete this.config.targets[projectTargetId(projectId)];
    delete this.config.detections[projectId];
    await this.persist({ config: true });
  }

  private async resolveTarget(id: string): Promise<{ kind: BackupTargetKind; name: string; folder: string; project: Project | null }> {
    if (id === "panel") return { kind: "panel", name: "Painel", folder: backupFolderFor({ kind: "panel" }), project: null };
    if (id === "email") return { kind: "email", name: "E-mail", folder: backupFolderFor({ kind: "email" }), project: null };
    const m = /^project:(.+)$/.exec(id);
    const project = m ? await this.opts.projects.get(m[1]!) : null;
    if (!project) throw httpError(404, "not_found", "Projeto não encontrado.");
    return { kind: "project", name: project.name, folder: backupFolderFor({ kind: "project", slug: project.slug }), project };
  }

  private lastOf(id: string, pred: (r: BackupRecord) => boolean): BackupRecord | null {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const r = this.history[i]!;
      if (r.target === id && pred(r)) return r;
    }
    return null;
  }

  private targetStatus(id: string, kind: BackupTargetKind, name: string, folder: string, available: boolean): BackupTargetStatus {
    const t = this.target(id);
    const live = [this.running, ...this.queue].find((j) => j?.record.target === id && j.record.operation === "backup")?.record;
    return {
      id,
      kind,
      name,
      folder,
      enabled: t.enabled,
      frequencyHours: t.frequencyHours,
      localKeep: t.localKeep,
      remoteKeep: t.remoteKeep,
      lastBackup: live ?? this.lastOf(id, (r) => r.operation === "backup"),
      lastSuccessAt: t.lastSuccessAt,
      lastRemoteVerifiedAt: t.lastRemoteVerifiedAt,
      nextRunAt: t.enabled && available ? new Date(nextSlot(this.now(), t.frequencyHours, this.hour)).toISOString() : null,
      available,
    };
  }

  private async mailAvailable(): Promise<boolean> {
    try {
      this.emailAvailable = (await this.opts.docker.state(this.opts.mail.container)).exists;
    } catch {
      this.emailAvailable = false;
    }
    return this.emailAvailable;
  }

  private destinationInfo(): BackupDestinationInfo | null {
    const d = this.config.destination;
    if (!d) return null;
    return {
      type: "s3",
      provider: d.provider,
      endpoint: d.endpoint,
      region: d.region,
      bucket: d.bucket,
      accessKeyHint: `…${d.accessKeyId.slice(-4)}`,
      connectedAt: d.connectedAt,
      testedAt: d.testedAt,
    };
  }

  async status(): Promise<BackupsStatus> {
    await this.ensureLoaded();
    this.archiverOk ??= await this.opts.archiver.available();
    const email = await this.mailAvailable();
    const projects = await this.opts.projects.list();
    const targets = [
      this.targetStatus("panel", "panel", "Painel", "_painel", true),
      this.targetStatus("email", "email", "E-mail", "_email", email),
      ...projects.map((p) => this.targetStatus(projectTargetId(p.id), "project", p.name, p.slug, true)),
    ];
    const e = this.config.encryption;
    return {
      destination: this.destinationInfo(),
      encryption: {
        enabled: e.enabled,
        passwordSet: Boolean(e.password),
        passwordSetAt: e.passwordSetAt,
        acknowledgedAt: e.acknowledgedAt,
        lastTestAt: e.lastTestAt,
        lastTestOk: e.lastTestOk,
      },
      targets,
      running: this.running?.record ?? null,
      queued: this.queue.map((j) => j.record),
      history: [...this.history].reverse().slice(0, 50),
      timezone: timezoneLabel(-new Date(this.now()).getTimezoneOffset()),
      backupHour: this.hour,
      archiverAvailable: this.archiverOk,
      localPath: "/var/lib/docker/volumes/paas_data/_data/backups",
    };
  }

  /** Para o roteiro (passo 6). */
  async facts(): Promise<{ destinationConnected: boolean; verifiedRemote: number; lastFailure: string | null }> {
    await this.ensureLoaded();
    const verified = Object.values(this.config.targets).filter((t) => t.lastRemoteVerifiedAt).length;
    const failed = [...this.history].reverse().find((r) => r.remote === "failed");
    return {
      destinationConnected: this.config.destination !== null,
      verifiedRemote: verified,
      lastFailure: failed?.remoteDetail ?? null,
    };
  }

  async projectView(projectId: string): Promise<ProjectBackupView> {
    await this.ensureLoaded();
    const id = projectTargetId(projectId);
    const { name, folder, project } = await this.resolveTarget(id);
    const t = this.target(id);
    return {
      target: this.targetStatus(id, "project", name, folder, true),
      detection: this.config.detections[project!.id] ?? null,
      choices: { ...t.choices },
      extraFolders: [...t.extraFolders],
      history: [...this.history].reverse().filter((r) => r.target === id).slice(0, 30),
      destinationConnected: this.config.destination !== null,
    };
  }

  async updateTarget(id: string, req: BackupTargetSettingsRequest, actor: string): Promise<void> {
    await this.ensureLoaded();
    const { name } = await this.resolveTarget(id);
    const t = this.target(id);
    const changes: string[] = [];
    if (req.frequencyHours !== undefined) {
      if (!BACKUP_FREQUENCIES.includes(req.frequencyHours)) throw httpError(400, "invalid_frequency", "Frequência inválida: use 24, 12 ou 6 horas.");
      if (req.frequencyHours !== t.frequencyHours) {
        t.frequencyHours = req.frequencyHours;
        t.lastSlot = currentSlot(this.now(), t.frequencyHours, this.hour);
        changes.push(`a cada ${t.frequencyHours} h`);
      }
    }
    for (const k of ["localKeep", "remoteKeep"] as const) {
      const v = req[k];
      if (v === undefined) continue;
      if (!Number.isInteger(v) || v < 1 || v > MAX_BACKUP_KEEP) {
        throw httpError(400, "invalid_keep", `Quantidade de cópias inválida: de 1 a ${MAX_BACKUP_KEEP}.`);
      }
      t[k] = v;
      changes.push(`${k === "localKeep" ? "na VPS" : "fora"}: ${v} cópias`);
    }
    if (req.enabled !== undefined && req.enabled !== t.enabled) {
      t.enabled = req.enabled;
      if (t.enabled) {
        t.lastSlot = currentSlot(this.now(), t.frequencyHours, this.hour);
        t.enabledSince = new Date(this.now()).toISOString();
      }
      changes.push(t.enabled ? "ligado" : "desligado");
    }
    if (req.choices) {
      t.choices = { ...t.choices, ...req.choices };
      changes.push("itens escolhidos");
    }
    if (req.extraFolders) {
      if (req.extraFolders.length > MAX_EXTRA_FOLDERS) throw httpError(400, "too_many_folders", `No máximo ${MAX_EXTRA_FOLDERS} pastas.`);
      t.extraFolders = req.extraFolders.map((f) => {
        const p = f.path.trim();
        if (!p.startsWith("/") || p === "/" || p.split("/").includes("..") || /[\0\n]/.test(p)) {
          throw httpError(400, "invalid_path", `Caminho inválido: "${p}". Use um caminho completo dentro do container, como /app/uploads.`);
        }
        return { id: `extra:${f.service}:${p}`, service: f.service.trim(), path: p.replace(/\/+$/, "") };
      });
      changes.push(`${t.extraFolders.length} pasta(s) adicionada(s)`);
    }
    await this.persist({ config: true });
    if (changes.length > 0) this.audit("backups.settings", `${name}: ${changes.join(", ")}.`, actor, name);
  }

  // -------------------------------------------------------------------------
  // Destino externo (S3 / R2)
  // -------------------------------------------------------------------------

  private storage(): BackupStorage | null {
    const d = this.config.destination;
    if (!d) return null;
    return this.opts.storage({
      endpoint: d.endpoint,
      region: d.region,
      bucket: d.bucket,
      accessKeyId: d.accessKeyId,
      secretAccessKey: this.open(d.secret),
    });
  }

  async setDestination(req: BackupDestinationRequest, actor: string): Promise<BackupsStatus> {
    await this.ensureLoaded();
    const bucket = req.bucket.trim();
    // O Cloudflare mostra o "S3 API" já com o bucket no fim
    // (https://<conta>.r2.cloudflarestorage.com/<bucket>): aceita colado assim.
    let endpoint = req.endpoint.trim().replace(/\/+$/, "");
    if (bucket && endpoint.toLowerCase().endsWith(`/${bucket.toLowerCase()}`)) endpoint = endpoint.slice(0, -(bucket.length + 1));
    const accessKeyId = req.accessKeyId.trim();
    const region = req.region.trim() || (req.provider === "r2" ? "auto" : "us-east-1");
    if (!/^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(endpoint)) {
      throw httpError(400, "invalid_endpoint", "Endereço inválido. Use o endpoint completo, como https://<id>.r2.cloudflarestorage.com.");
    }
    const prev = this.config.destination;
    const secret = req.secretAccessKey?.trim() || (prev ? this.open(prev.secret) : "");
    if (!secret) throw httpError(400, "secret_required", "Informe a chave secreta (Secret Access Key).");
    const storage = this.opts.storage({ endpoint, region, bucket, accessKeyId, secretAccessKey: secret });
    try {
      await storage.test();
    } catch (err) {
      throw httpError(400, "destination_test_failed", reasonOf(err));
    }
    const at = new Date(this.now()).toISOString();
    this.config.destination = {
      provider: req.provider,
      endpoint,
      region,
      bucket,
      accessKeyId,
      secret: this.seal(secret),
      connectedAt: prev && prev.bucket === bucket && prev.endpoint === endpoint ? prev.connectedAt : at,
      testedAt: at,
    };
    await this.persist({ config: true });
    this.audit("backups.destination_saved", `Armazenamento externo conectado: bucket "${bucket}" em ${new URL(endpoint).host}.`, actor);
    await this.uploadCheckFile().catch(() => undefined);
    return this.status();
  }

  async testDestination(actor: string): Promise<BackupsStatus> {
    await this.ensureLoaded();
    const storage = this.storage();
    if (!storage) throw httpError(409, "no_destination", "Conecte um armazenamento externo primeiro.");
    try {
      await storage.test();
    } catch (err) {
      this.audit("backups.destination_test", "Teste do armazenamento externo: falhou.", actor);
      throw httpError(502, "destination_test_failed", reasonOf(err));
    }
    this.config.destination!.testedAt = new Date(this.now()).toISOString();
    await this.persist({ config: true });
    this.audit("backups.destination_test", "Teste do armazenamento externo: deu certo.", actor);
    return this.status();
  }

  async removeDestination(actor: string): Promise<BackupsStatus> {
    await this.ensureLoaded();
    this.config.destination = null;
    await this.persist({ config: true });
    this.audit("backups.destination_removed", "Armazenamento externo desconectado (os backups que já estão lá continuam lá).", actor);
    return this.status();
  }

  // -------------------------------------------------------------------------
  // Criptografia e senha
  // -------------------------------------------------------------------------

  private password(): string | null {
    const box = this.config.encryption.password;
    return box ? this.open(box) : null;
  }

  suggestPassword(): string {
    return suggestPassphrase();
  }

  async setPassword(password: string, acknowledged: boolean, actor: string): Promise<BackupsStatus> {
    await this.ensureLoaded();
    if (password.length < MIN_BACKUP_PASSWORD_LENGTH || password.length > MAX_BACKUP_PASSWORD_LENGTH) {
      throw httpError(400, "weak_password", `A senha precisa ter pelo menos ${MIN_BACKUP_PASSWORD_LENGTH} caracteres.`);
    }
    if (!backupPasswordStrength(password).ok) {
      throw httpError(400, "weak_password", "Senha fácil de adivinhar (repetida ou em sequência). Use uma frase com várias palavras.");
    }
    if (!acknowledged) {
      throw httpError(400, "not_acknowledged", 'Marque "Guardei a senha em lugar seguro" para continuar.');
    }
    const changed = this.config.encryption.password !== null;
    const at = new Date(this.now()).toISOString();
    Object.assign(this.config.encryption, {
      password: this.seal(password),
      passwordSetAt: at,
      acknowledgedAt: at,
      lastTestAt: null,
      lastTestOk: null,
      lastReminderAt: null,
    });
    await this.persist({ config: true });
    this.audit(
      changed ? "backups.password_changed" : "backups.password_set",
      changed ? "Senha dos backups trocada (os backups antigos continuam com a senha antiga)." : "Senha dos backups definida.",
      actor,
    );
    await this.uploadCheckFile().catch(() => undefined);
    return this.status();
  }

  async setEncryption(enabled: boolean, actor: string): Promise<BackupsStatus> {
    await this.ensureLoaded();
    this.config.encryption.enabled = enabled;
    await this.persist({ config: true });
    this.audit(
      "backups.encryption",
      enabled ? "Criptografia da cópia externa ligada." : "Criptografia da cópia externa desligada: os próximos backups externos vão sem senha.",
      actor,
    );
    return this.status();
  }

  /** Ver a senha: só com a senha de login, no máximo 5 vezes a cada 15 min. */
  async revealPassword(userId: string, loginPassword: string, actor: string): Promise<string> {
    await this.ensureLoaded();
    const now = this.now();
    const attempts = (this.revealAttempts.get(userId) ?? []).filter((t) => now - t < REVEAL_WINDOW_MS);
    if (attempts.length >= REVEAL_LIMIT) {
      throw httpError(429, "too_many_attempts", "Muitas tentativas. Espere 15 minutos e tente de novo.");
    }
    attempts.push(now);
    this.revealAttempts.set(userId, attempts);
    if (!(await this.opts.verifyLogin(userId, loginPassword))) {
      this.audit("backups.password_reveal_denied", "Pedido para ver a senha dos backups com a senha de login errada.", actor);
      throw httpError(401, "invalid_login_password", "Senha de login incorreta.");
    }
    const pw = this.password();
    if (!pw) throw httpError(409, "no_password", "Nenhuma senha de backup definida.");
    this.audit("backups.password_revealed", "A senha dos backups foi mostrada na tela.", actor);
    return pw;
  }

  /** Grava (ou troca) o arquivinho cifrado que "Testar minha senha" abre. */
  private async uploadCheckFile(): Promise<void> {
    const storage = this.storage();
    const pw = this.password();
    if (!storage || !pw) return;
    const dir = await this.tempDir("verificacao");
    try {
      const txt = path.join(dir, "verificacao.txt");
      await writeFile(txt, "Se você abriu este arquivo, a senha dos backups do TWS Panel está certa.\n");
      const archive = path.join(dir, "senha.7z");
      await this.opts.archiver.create(archive, [txt], { password: pw });
      await storage.upload(CHECK_FILE, archive);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async testPassword(password: string, actor: string): Promise<{ ok: boolean; message: string }> {
    await this.ensureLoaded();
    const storage = this.storage();
    if (!storage) throw httpError(409, "no_destination", "Conecte o armazenamento externo para testar a senha.");
    // Sem senha guardada (VPS nova em "Restaurar de outro servidor"): confere a
    // senha digitada no arquivo de verificação que a instalação antiga deixou
    // no armazenamento, sem regravá-lo e sem guardar nada.
    const saved = this.password() !== null;
    const dir = await this.tempDir("teste-senha");
    let ok = false;
    try {
      const file = path.join(dir, "senha.7z");
      try {
        await storage.download(CHECK_FILE, file);
      } catch (err) {
        if (!(err instanceof StorageError && err.code === "not_found")) throw httpError(502, "destination_error", reasonOf(err));
        if (!saved) {
          throw httpError(
            409,
            "no_check_file",
            "O armazenamento ainda não tem o arquivo de verificação da senha. Defina a senha: se ela estiver errada, a restauração avisa.",
          );
        }
        await this.uploadCheckFile();
        await storage.download(CHECK_FILE, file);
      }
      try {
        await this.opts.archiver.test(file, password);
        ok = true;
      } catch (err) {
        if (!(err instanceof ArchiveError && err.code === "wrong_password")) throw httpError(500, "archive_error", reasonOf(err));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    if (saved) {
      const at = new Date(this.now()).toISOString();
      this.config.encryption.lastTestAt = at;
      this.config.encryption.lastTestOk = ok;
      await this.persist({ config: true });
    }
    this.audit("backups.password_test", ok ? "Teste da senha dos backups: certa." : "Teste da senha dos backups: não abriu.", actor);
    return ok
      ? { ok, message: "Senha certa: ela abre o arquivo de verificação gravado no seu armazenamento." }
      : { ok, message: "Essa senha não abre os backups atuais. Confira o kit de recuperação ou veja a senha aqui (pede a senha de login)." };
  }

  // -------------------------------------------------------------------------
  // Fila
  // -------------------------------------------------------------------------

  private newRecord(target: string, name: string, operation: BackupRecord["operation"], trigger: BackupRecord["trigger"]): BackupRecord {
    return {
      id: randomBytes(6).toString("hex"),
      target,
      targetName: name,
      operation,
      trigger,
      status: "queued",
      queuedAt: new Date(this.now()).toISOString(),
      startedAt: null,
      finishedAt: null,
      fileName: null,
      sizeBytes: null,
      local: false,
      remote: "none",
      remoteEncrypted: false,
      remoteDetail: null,
      steps: [],
      warnings: [],
      error: null,
    };
  }

  private enqueue(record: BackupRecord, run: Job["run"]): BackupRecord {
    const dup = [this.running, ...this.queue].find(
      (j) => j && j.record.target === record.target && j.record.operation === record.operation && record.operation === "backup",
    );
    if (dup) return dup.record;
    this.queue.push({ record, run });
    this.history.push(record);
    void this.persist({ history: true });
    void this.pump();
    return record;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const job = this.queue.shift();
    if (!job) {
      for (const w of this.idleWaiters.splice(0)) w();
      return;
    }
    this.running = job;
    const r = job.record;
    r.status = "running";
    r.startedAt = new Date(this.now()).toISOString();
    try {
      await job.run(r);
      if (r.status === "running") r.status = r.warnings.length > 0 || r.remote === "failed" || r.remote === "skipped" ? "warning" : "success";
    } catch (err) {
      r.status = "failed";
      r.error = reasonOf(err);
      for (const s of r.steps) if (s.status === "running") s.status = "failed";
      this.log(`Backups: ${r.operation === "backup" ? "backup" : "restauração"} de ${r.targetName} falhou (${r.error}).`);
    }
    for (const s of r.steps) if (s.status === "running") s.status = "done";
    r.finishedAt = new Date(this.now()).toISOString();
    if (r.operation === "backup" && (r.status === "failed" || r.remote === "failed")) {
      this.opts.notify?.({
        kind: "backup_failed",
        key: `backup-failed:${r.target}`,
        title: r.status === "failed" ? `Backup de ${r.targetName} falhou` : `Backup de ${r.targetName}: a cópia externa falhou`,
        body: [(r.error ?? r.remoteDetail ?? "").slice(0, 200)].filter(Boolean),
        path: r.target.startsWith("project:") ? `/projects/${r.target.slice(8)}/backups` : "/settings/backups",
      });
    }
    await this.persist({ config: true, history: true });
    this.running = null;
    void this.pump();
  }

  /** Um registro (para a tela acompanhar o progresso). */
  async record(id: string): Promise<BackupRecord> {
    await this.ensureLoaded();
    const found = [this.running?.record, ...this.queue.map((j) => j.record), ...this.history].find((r) => r?.id === id);
    if (!found) throw httpError(404, "not_found", "Registro de backup não encontrado.");
    return found;
  }

  /** Espera a fila esvaziar (testes e desligamento). */
  idle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private step(r: BackupRecord, label: string): void {
    for (const s of r.steps) if (s.status === "running") s.status = "done";
    const s: BackupRunStep = { label, status: "running" };
    r.steps.push(s);
  }

  private async tempDir(prefix: string): Promise<string> {
    const dir = path.join(this.tmpDir, `${prefix}-${randomBytes(4).toString("hex")}`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** Não lota a VPS: precisa de `bytes × fator` livres e o disco não pode passar de 95%. */
  private async ensureSpace(bytes: number, factor: number): Promise<void> {
    await mkdir(this.backupsDir, { recursive: true });
    let fs;
    try {
      fs = await this.statfsFn(this.backupsDir);
    } catch {
      return; // sem a medida, segue (a falha de disco aparece no passo que falhar)
    }
    const free = fs.bavail * fs.bsize;
    const total = fs.blocks * fs.bsize;
    const need = Math.ceil(bytes * factor) + 256 * 1024 * 1024;
    if (free - need < total * 0.05) {
      throw new BackupFailure(
        `Espaço em disco insuficiente: o backup precisa de cerca de ${formatBytes(need)} e há ${formatBytes(free)} livres. Libere espaço ou desmarque itens grandes.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Pedidos de backup
  // -------------------------------------------------------------------------

  /** "Fazer backup agora" (ou o agendador). */
  async runNow(id: string, actor: string | null): Promise<BackupRecord> {
    await this.ensureLoaded();
    const t = await this.resolveTarget(id);
    if (t.kind === "email" && !(await this.mailAvailable())) {
      throw httpError(409, "email_unavailable", "O servidor de e-mail ainda não foi criado nesta instalação.");
    }
    if (t.project && !t.project.lastDeployAt) {
      throw httpError(409, "not_deployed", "Faça o primeiro deploy do projeto antes do backup.");
    }
    const record = this.newRecord(id, t.name, "backup", actor ? "manual" : "schedule");
    const queued = this.enqueue(record, (r) => this.runBackup(r, t.kind, t.folder, t.project));
    if (actor && queued === record) this.audit("backups.run", `Backup de ${t.name} pedido (Fazer backup agora).`, actor, t.name);
    return queued;
  }

  private async runBackup(r: BackupRecord, kind: BackupTargetKind, folder: string, project: Project | null): Promise<void> {
    if (!(this.archiverOk ??= await this.opts.archiver.available())) {
      throw new BackupFailure("O 7-Zip não está instalado no container do painel. Atualize o painel (a imagem nova já traz o 7-Zip).");
    }
    const staging = await this.tempDir(kind);
    try {
      const content = path.join(staging, "conteudo");
      await mkdir(content, { recursive: true });
      let inputs: string[];
      let manifest: Manifest;
      if (kind === "project") ({ inputs, manifest } = await this.collectProject(r, project!, content));
      else if (kind === "email") ({ inputs, manifest } = await this.collectEmail(r, content));
      else ({ inputs, manifest } = await this.collectPanel(r));
      await writeFile(path.join(content, "manifesto.json"), JSON.stringify(manifest, null, 2) + "\n");
      await writeFile(path.join(content, "LEIA-ME.txt"), readme(manifest));
      inputs.push(path.join(content, "manifesto.json"), path.join(content, "LEIA-ME.txt"));
      await this.finishArchive(r, folder, staging, inputs);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  /** Detecção (aba Backups) a partir dos containers do projeto. */
  async detectProject(projectId: string): Promise<ProjectBackupDetection> {
    await this.ensureLoaded();
    const project = await this.opts.projects.get(projectId);
    if (!project) throw httpError(404, "not_found", "Projeto não encontrado.");
    const detection = await this.detect(project);
    this.config.detections[project.id] = detection;
    await this.persist({ config: true });
    return detection;
  }

  private async detect(project: Project): Promise<ProjectBackupDetection> {
    const docker = this.opts.docker;
    const containers = await docker.projectContainers(project.slug);
    const inspects = await docker.inspect(containers.map((c) => c.id));
    const diffs: Record<string, string> = {};
    for (const c of containers) {
      if (!c.running || diffs[c.service] !== undefined) continue;
      diffs[c.service] = await docker.diff(c.id).catch(() => "");
    }
    const sizeItems = inspects.flatMap((c) =>
      c.Mounts.filter((m) => m.Type === "volume" || m.Type === "bind").map((m) => ({
        id: mountId(c.Config.Labels?.["com.docker.compose.service"] ?? c.Name.replace(/^\//, ""), m.Destination),
        kind: m.Type as "volume" | "bind",
        source: m.Type === "volume" ? (m.Name ?? m.Source) : m.Source,
      })),
    );
    const source = project.ingestMode !== "git" ? this.opts.projects.srcDir(project) : null;
    if (source) sizeItems.push({ id: "src", kind: "bind", source });
    const { sizes, files } = await docker.sizes(sizeItems);
    return buildDetection({
      containers: inspects,
      diffs,
      sizes,
      files,
      sourceFolder: source ? { path: source, sizeBytes: sizes.src ?? null } : null,
      now: new Date(this.now()),
    });
  }

  private async collectProject(r: BackupRecord, project: Project, content: string): Promise<{ inputs: string[]; manifest: Manifest }> {
    const docker = this.opts.docker;
    const id = projectTargetId(project.id);
    const t = this.target(id);
    this.step(r, "Conferir o que entra no backup");
    const detection = await this.detect(project);
    this.config.detections[project.id] = detection;
    if (detection.error) throw new BackupFailure(detection.error);
    const chosen = (itemId: string, def: boolean) => t.choices[itemId] ?? def;
    const dbs = detection.databases.filter((d) => chosen(d.id, d.defaultSelected));
    const mounts = detection.mounts.filter((m) => !m.coveredByDump && chosen(m.id, m.defaultSelected));
    const extras = t.extraFolders;
    const withSource = detection.sourceFolder !== null && chosen("src", true);
    if (dbs.length + mounts.length + extras.length + (withSource ? 1 : 0) === 0) {
      throw new BackupFailure("Nada marcado para o backup. Marque pelo menos um item na aba Backups do projeto.");
    }
    const containers = await docker.projectContainers(project.slug);
    const byService = new Map<string, ProjectContainer>();
    for (const c of containers) if (!byService.has(c.service) || c.running) byService.set(c.service, c);
    const need = (service: string): ProjectContainer => {
      const c = byService.get(service);
      if (!c) throw new BackupFailure(`O serviço "${service}" não tem container. Faça o deploy e tente de novo.`);
      return c;
    };

    this.step(r, "Conferir o espaço em disco");
    const coveredSize = (service: string) =>
      detection.mounts.filter((m) => m.service === service && m.coveredByDump).reduce((s, m) => s + (m.sizeBytes ?? 0), 0);
    const estimate =
      dbs.reduce((s, d) => s + coveredSize(d.service), 0) +
      mounts.reduce((s, m) => s + (m.sizeBytes ?? 0), 0) +
      (withSource ? (detection.sourceFolder!.sizeBytes ?? 0) : 0);
    await this.ensureSpace(estimate, this.remoteFactor());

    const items: ManifestItem[] = [];
    if (dbs.length > 0) {
      this.step(r, "Copiar os bancos de dados");
      await mkdir(path.join(content, "bancos"), { recursive: true });
      for (const db of dbs) {
        const c = need(db.service);
        if (!c.running) throw new BackupFailure(`O banco "${db.service}" está parado. Ligue o projeto e tente de novo.`);
        const base = itemFileName(db.service, "").replace(/__raiz$/, "");
        if (db.engine === "postgres") {
          const [list, globals, one] = dumpPlan("postgres");
          const names = (await docker.execCapture(c.id, list!.script, [])).split("\n").map((s) => s.trim()).filter(Boolean);
          const dir = path.join(content, "bancos", base);
          await mkdir(dir, { recursive: true });
          const item: ManifestItem = { type: "database", service: db.service, engine: "postgres", databases: [] };
          try {
            await docker.execToFile(c.id, globals!.script, [], path.join(dir, "_papeis.sql"));
            item.globalsFile = `bancos/${base}/_papeis.sql`;
          } catch {
            r.warnings.push(`${db.service}: os papéis (usuários) do Postgres não foram copiados; os bancos foram.`);
          }
          for (const name of names) {
            const file = `${name.replace(/[^A-Za-z0-9._-]+/g, "_")}.sql`;
            await this.dumpTo(c.id, one!.script, [name], path.join(dir, file), db.service);
            item.databases!.push({ name, file: `bancos/${base}/${file}` });
          }
          items.push(item);
        } else if (db.engine === "redis") {
          await docker.execCapture(c.id, REDIS_SAVE, []).catch(() => "");
          const file = `bancos/${base}-redis.tar`;
          await docker.copyOut(c.id, "/data", path.join(content, file));
          items.push({ type: "database", service: db.service, engine: "redis", file, destination: "/data" });
        } else {
          const [all] = dumpPlan(db.engine);
          const file = `bancos/${base}${all!.ext}`;
          await this.dumpTo(c.id, all!.script, [], path.join(content, file), db.service);
          items.push({ type: "database", service: db.service, engine: db.engine, file });
        }
      }
    }
    if (mounts.length + extras.length > 0) {
      this.step(r, "Copiar os arquivos");
      for (const m of mounts) {
        const c = need(m.service);
        const file = `volumes/${itemFileName(m.service, m.destination)}.tar`;
        await mkdir(path.join(content, "volumes"), { recursive: true });
        await docker.copyOut(c.id, m.destination, path.join(content, file));
        items.push({ type: "mount", service: m.service, destination: m.destination, mountType: m.type, source: m.source, isFile: m.isFile, file });
      }
      for (const x of extras) {
        const c = need(x.service);
        const file = `pastas/${itemFileName(x.service, x.path)}.tar`;
        await mkdir(path.join(content, "pastas"), { recursive: true });
        await docker.copyOut(c.id, x.path, path.join(content, file));
        items.push({ type: "extra", service: x.service, destination: x.path, file });
      }
    }
    if (withSource) {
      this.step(r, "Copiar o código (o projeto não vem do GitHub)");
      const src = detection.sourceFolder!.path;
      await mkdir(path.join(content, "codigo"), { recursive: true });
      await this.tar.create(path.dirname(src), path.basename(src), path.join(content, "codigo", "codigo.tar"));
      items.push({ type: "source", destination: src, file: "codigo/codigo.tar" });
    }
    const inputs = ["bancos", "volumes", "pastas", "codigo"].map((d) => path.join(content, d)).filter((p) => existsSync(p));
    return {
      inputs,
      manifest: { version: 1, kind: "project", name: project.name, projectId: project.id, slug: project.slug, createdAt: new Date(this.now()).toISOString(), items },
    };
  }

  private async dumpTo(container: string, script: string, args: string[], out: string, service: string): Promise<void> {
    try {
      await this.opts.docker.execToFile(container, script, args, out);
    } catch (err) {
      throw new BackupFailure(`O dump do banco "${service}" falhou: ${reasonOf(err)}`);
    }
  }

  private async collectEmail(r: BackupRecord, content: string): Promise<{ inputs: string[]; manifest: Manifest }> {
    const docker = this.opts.docker;
    const mail = this.opts.mail;
    const state = await docker.state(mail.container);
    if (!state.exists) throw new BackupFailure("O servidor de e-mail ainda não foi criado nesta instalação.");
    this.step(r, "Conferir o espaço em disco");
    const { sizes } = await docker.sizes([{ id: "mail", kind: "volume", source: mail.volume }]);
    await this.ensureSpace(sizes.mail ?? 0, this.remoteFactor());
    await mkdir(path.join(content, "email"), { recursive: true });
    const items: ManifestItem[] = [];
    // Cópia consistente: o Stalwart fica parado só durante a cópia (quem
    // manda e-mail tenta de novo sozinho; ninguém perde mensagem).
    this.step(r, "Parar o e-mail por alguns segundos e copiar");
    if (state.running) await docker.stop(mail.container);
    try {
      await docker.copyOut(mail.container, mail.dataPath, path.join(content, "email", "stalwart-data.tar"));
      items.push({ type: "email", part: "stalwart-data", file: "email/stalwart-data.tar" });
      await docker.copyOut(mail.container, mail.etcPath, path.join(content, "email", "stalwart-etc.tar"));
      items.push({ type: "email", part: "stalwart-etc", file: "email/stalwart-etc.tar" });
    } finally {
      if (state.running) await docker.start(mail.container);
    }
    const webmail = await docker.state(mail.webmailContainer);
    if (webmail.exists) {
      this.step(r, "Copiar o webmail");
      await docker.copyOut(mail.webmailContainer, mail.webmailPath, path.join(content, "email", "webmail.tar"));
      items.push({ type: "email", part: "webmail", file: "email/webmail.tar" });
    }
    return {
      inputs: [path.join(content, "email")],
      manifest: { version: 1, kind: "email", name: "E-mail", createdAt: new Date(this.now()).toISOString(), items },
    };
  }

  private panelEntries = async (): Promise<string[]> => {
    const legacyProjects = path.resolve(path.join(this.opts.dataDir, "projects")) === path.resolve(this.opts.projectsDir);
    const names = await readdir(this.opts.dataDir);
    return names
      .filter((n) => n !== "backups" && !(n === "projects" && legacyProjects) && !/\.(tmp|partial)$/.test(n))
      .map((n) => path.join(this.opts.dataDir, n));
  };

  private async collectPanel(r: BackupRecord): Promise<{ inputs: string[]; manifest: Manifest }> {
    this.step(r, "Conferir o espaço em disco");
    const inputs = await this.panelEntries();
    let size = 0;
    for (const p of inputs) {
      const s = await stat(p);
      size += s.isDirectory() ? await dirSize(p) : s.size;
    }
    await this.ensureSpace(size, this.remoteFactor());
    this.step(r, "Copiar o diretório de dados do painel");
    return { inputs, manifest: { version: 1, kind: "panel", name: "Painel", createdAt: new Date(this.now()).toISOString(), items: [] } };
  }

  /** Quanto espaço a mais o backup ocupa enquanto roda (cópia, .7z, cifrado e conferência). */
  private remoteFactor(): number {
    const d = this.config.destination;
    return d && this.config.encryption.enabled ? 3.2 : d ? 2.4 : 2.2;
  }

  private uniqueName(dir: string): string {
    const stamp = backupFileStamp(new Date(this.now()));
    let name = `${stamp}.7z`;
    for (let i = 2; existsSync(path.join(dir, name)); i++) name = `${stamp}-${i}.7z`;
    return name;
  }

  private async localFiles(folder: string): Promise<string[]> {
    try {
      return (await readdir(path.join(this.backupsDir, folder))).filter(isValidBackupFileName).sort();
    } catch {
      return [];
    }
  }

  private async finishArchive(r: BackupRecord, folder: string, staging: string, inputs: string[]): Promise<void> {
    const t = this.target(r.target);
    this.step(r, "Compactar (.7z)");
    const localDir = path.join(this.backupsDir, folder);
    await mkdir(localDir, { recursive: true });
    const name = this.uniqueName(localDir);
    const plain = path.join(staging, "local.7z");
    await this.opts.archiver.create(plain, inputs, {});
    const localPath = path.join(localDir, name);
    await rename(plain, localPath);
    r.fileName = name;
    r.local = true;
    r.sizeBytes = (await stat(localPath)).size;
    t.lastSuccessAt = new Date(this.now()).toISOString();
    // Cópias na VPS além das N mais recentes.
    const local = await this.localFiles(folder);
    for (const old of local.slice(0, Math.max(0, local.length - t.localKeep))) {
      await rm(path.join(localDir, old), { force: true });
    }

    const storage = this.storage();
    if (!storage) return;
    const encrypt = this.config.encryption.enabled;
    const pw = encrypt ? this.password() : null;
    if (encrypt && !pw) {
      r.remote = "skipped";
      r.remoteDetail = "Defina a senha dos backups (Configurações → Backups) para enviar a cópia externa cifrada.";
      return;
    }
    const key = `${BACKUP_ROOT_FOLDER}/${folder}/${name}`;
    try {
      this.step(r, encrypt ? "Cifrar e enviar para o armazenamento externo" : "Enviar para o armazenamento externo");
      r.remote = "uploading";
      r.remoteEncrypted = encrypt;
      let upload = localPath;
      if (encrypt) {
        // A cópia externa é um SEGUNDO .7z, cifrado (nomes inclusive): a da VPS fica sem senha.
        upload = path.join(staging, "externo.7z");
        await this.opts.archiver.create(upload, inputs, { password: pw });
      }
      const hash = await sha256File(upload);
      await storage.upload(key, upload);
      r.remote = "uploaded";
      this.step(r, "Conferir a cópia externa (baixar e abrir)");
      const back = path.join(staging, "conferencia.7z");
      await storage.download(key, back);
      if ((await sha256File(back)) !== hash) {
        throw new BackupFailure("A cópia baixada de volta não bate com a enviada (hash diferente). Nada foi apagado.");
      }
      await this.opts.archiver.test(back, pw);
      await rm(back, { force: true });
      if (encrypt) await rm(upload, { force: true });
      r.remote = "verified";
      t.lastRemoteVerifiedAt = new Date(this.now()).toISOString();
      t.lastStaleNoticeAt = null;
      this.step(r, "Apagar os backups externos mais antigos");
      const prefix = `${BACKUP_ROOT_FOLDER}/${folder}/`;
      const remote = (await storage.list(prefix)).map((o) => o.key.slice(prefix.length)).filter(isValidBackupFileName).sort();
      for (const old of remote.slice(0, Math.max(0, remote.length - t.remoteKeep))) {
        await storage.remove(`${prefix}${old}`);
      }
    } catch (err) {
      if (r.remote !== "verified") r.remote = "failed";
      r.remoteDetail = reasonOf(err);
      for (const s of r.steps) if (s.status === "running") s.status = "failed";
    }
  }

  // -------------------------------------------------------------------------
  // Restaurar
  // -------------------------------------------------------------------------

  async points(id: string): Promise<BackupPoint[]> {
    await this.ensureLoaded();
    const { folder } = await this.resolveTarget(id);
    return this.pointsFor(folder);
  }

  private async pointsFor(folder: string): Promise<BackupPoint[]> {
    const map = new Map<string, BackupPoint>();
    for (const name of await this.localFiles(folder)) {
      const s = await stat(path.join(this.backupsDir, folder, name));
      map.set(name, { fileName: name, at: parseBackupFileStamp(name)!.toISOString(), sizeBytes: s.size, local: true, remote: false });
    }
    const storage = this.storage();
    if (storage) {
      const prefix = `${BACKUP_ROOT_FOLDER}/${folder}/`;
      let objects;
      try {
        objects = await storage.list(prefix);
      } catch (err) {
        throw httpError(502, "destination_error", reasonOf(err));
      }
      for (const o of objects) {
        const name = o.key.slice(prefix.length);
        if (!isValidBackupFileName(name)) continue;
        const cur = map.get(name);
        if (cur) cur.remote = true;
        else map.set(name, { fileName: name, at: parseBackupFileStamp(name)!.toISOString(), sizeBytes: o.size, local: false, remote: true });
      }
    }
    return [...map.values()].sort((a, b) => b.fileName.localeCompare(a.fileName));
  }

  /** "Restaurar de outro servidor": o que existe no armazenamento conectado. */
  async catalog(): Promise<BackupCatalog> {
    await this.ensureLoaded();
    const storage = this.storage();
    if (!storage) throw httpError(409, "no_destination", "Conecte o mesmo armazenamento do servidor antigo primeiro.");
    let folders: string[];
    try {
      folders = await storage.listFolders(`${BACKUP_ROOT_FOLDER}/`);
    } catch (err) {
      throw httpError(502, "destination_error", reasonOf(err));
    }
    const projects = await this.opts.projects.list();
    const catalog: BackupCatalog = { panel: [], email: [], projects: [] };
    for (const folder of folders) {
      if (folder === "_verificacao") continue;
      const points = (await this.pointsFor(folder)).filter((p) => p.remote);
      if (folder === "_painel") catalog.panel = points;
      else if (folder === "_email") catalog.email = points;
      else {
        const p = projects.find((x) => x.slug === folder) ?? null;
        catalog.projects.push({ folder, projectId: p?.id ?? null, projectName: p?.name ?? null, points });
      }
    }
    return catalog;
  }

  /** Texto que a pessoa digita para confirmar a restauração. */
  static confirmText(kind: BackupTargetKind, name: string): string {
    return kind === "panel" ? "painel" : kind === "email" ? "e-mail" : name;
  }

  async restore(id: string, req: BackupRestoreRequest & { password?: string }, actor: string): Promise<BackupRecord> {
    await this.ensureLoaded();
    const t = await this.resolveTarget(id);
    if (!isValidBackupFileName(req.fileName)) throw httpError(400, "invalid_file", "Nome de backup inválido.");
    const expected = BackupService.confirmText(t.kind, t.name);
    if (req.confirm.trim().toLowerCase() !== expected.toLowerCase()) {
      throw httpError(400, "confirm_mismatch", `Para confirmar, digite exatamente: ${expected}`);
    }
    if (req.source === "local" && !existsSync(path.join(this.backupsDir, t.folder, req.fileName))) {
      throw httpError(404, "not_found", "Esse backup não está mais na VPS.");
    }
    if (req.source === "remote" && !this.config.destination) {
      throw httpError(409, "no_destination", "Conecte o armazenamento externo primeiro.");
    }
    const record = this.newRecord(id, t.name, "restore", "manual");
    record.fileName = req.fileName;
    this.audit("backups.restore", `Restauração de ${t.name} pedida (backup ${req.fileName}, ${req.source === "local" ? "cópia da VPS" : "cópia externa"}).`, actor, t.name);
    return this.enqueue(record, (r) => this.runRestore(r, t.kind, t.folder, t.project, req, actor));
  }

  private async runRestore(
    r: BackupRecord,
    kind: BackupTargetKind,
    folder: string,
    project: Project | null,
    req: BackupRestoreRequest & { password?: string },
    actor: string,
  ): Promise<void> {
    const staging = await this.tempDir(`restaurar-${kind}`);
    let keepStaging = false;
    try {
      this.step(r, req.source === "local" ? "Abrir a cópia da VPS" : "Baixar do armazenamento externo");
      let archive = path.join(this.backupsDir, folder, req.fileName);
      if (req.source === "remote") {
        const storage = this.storage()!;
        archive = path.join(staging, req.fileName);
        try {
          await storage.download(`${BACKUP_ROOT_FOLDER}/${folder}/${req.fileName}`, archive);
        } catch (err) {
          throw new BackupFailure(reasonOf(err));
        }
      }
      this.step(r, "Conferir e abrir o arquivo");
      const password = await this.findPassword(archive, req.password ?? null, req.source === "remote");
      const content = path.join(staging, "conteudo");
      await this.opts.archiver.extract(archive, content, password);
      let manifest: Manifest | null = null;
      try {
        manifest = JSON.parse(await readFile(path.join(content, "manifesto.json"), "utf8")) as Manifest;
      } catch {
        manifest = null;
      }
      if (!manifest || manifest.kind !== kind) {
        throw new BackupFailure("Este arquivo não é um backup deste item (manifesto ausente ou de outro tipo).");
      }
      await checkManifestFiles(manifest, content);
      if (kind === "project") await this.restoreProject(r, project!, manifest, content, req.redeploy === true);
      else if (kind === "email") await this.restoreEmail(r, manifest, content);
      else {
        await this.stagePanel(r, content, req.fileName, actor);
        keepStaging = true;
      }
    } finally {
      if (!keepStaging) await rm(staging, { recursive: true, force: true });
    }
  }

  /** null = sem senha; senão a do pedido ou a guardada. Erro claro quando nenhuma abre. */
  private async findPassword(archive: string, given: string | null, remote: boolean): Promise<string | null> {
    let opensWithout = false;
    try {
      await this.opts.archiver.test(archive, null);
      opensWithout = true;
    } catch (err) {
      if (!(err instanceof ArchiveError && err.code === "wrong_password")) throw err;
    }
    if (opensWithout) {
      // Com a criptografia ligada, a cópia externa sempre sai cifrada. Uma que
      // abre sem senha pode ter sido trocada por quem tem acesso ao bucket.
      if (remote && this.config.encryption.enabled) {
        throw new BackupFailure(
          "Esta cópia externa está sem senha, mas a criptografia está ligada. Por segurança, o painel não restaura: ela pode ter sido trocada por alguém com acesso ao armazenamento. Se ela é de antes de você ligar a criptografia, use a cópia da VPS ou desligue a criptografia só para restaurar.",
        );
      }
      return null;
    }
    const candidates = [given, this.password()].filter((p): p is string => Boolean(p));
    for (const pw of candidates) {
      try {
        await this.opts.archiver.test(archive, pw);
        return pw;
      } catch (err) {
        if (!(err instanceof ArchiveError && err.code === "wrong_password")) throw err;
      }
    }
    throw new BackupFailure(
      given
        ? "A senha digitada não abre este backup. Se ele é de antes de uma troca de senha, use a senha daquela época."
        : "Este backup está cifrado com uma senha que o painel não tem. Digite a senha usada na época e tente de novo.",
    );
  }

  private async waitReady(container: string, engine: BackupDatabaseEngine): Promise<void> {
    const probe: Record<string, string> = {
      postgres: 'pg_isready -q -U "${POSTGRES_USER:-postgres}"',
      mysql: "mysqladmin ping --silent 2>/dev/null || mariadb-admin ping --silent",
      mariadb: "mariadb-admin ping --silent 2>/dev/null || mysqladmin ping --silent",
      mongo: "mongosh --quiet --eval 1 >/dev/null 2>&1 || mongo --quiet --eval 1 >/dev/null 2>&1 || true",
    };
    const script = probe[engine];
    if (!script) return;
    for (let i = 0; i < 30; i++) {
      try {
        await this.opts.docker.execCapture(container, script, []);
        return;
      } catch {
        await new Promise((res) => setTimeout(res, this.readyDelayMs));
      }
    }
  }

  private async restoreProject(r: BackupRecord, project: Project, manifest: Manifest, content: string, redeploy: boolean): Promise<void> {
    const docker = this.opts.docker;
    let containers = await docker.projectContainers(project.slug);
    if (containers.length === 0) {
      if (!redeploy) {
        throw new BackupFailure('O projeto não tem containers nesta VPS. Marque "Publicar do GitHub antes de restaurar" ou faça o deploy primeiro.');
      }
      this.step(r, "Publicar o projeto do GitHub");
      await this.opts.projects.redeploy(project.id);
      containers = await docker.projectContainers(project.slug);
      if (containers.length === 0) throw new BackupFailure("O deploy terminou, mas o projeto não tem containers.");
    }
    const byService = new Map<string, ProjectContainer>();
    for (const c of containers) if (!byService.has(c.service)) byService.set(c.service, c);
    // Os destinos vêm do projeto de agora (detecção e pastas cadastradas),
    // nunca do manifesto: ele está dentro do arquivo e pode ter sido trocado.
    const detection = await this.detect(project);
    const key = (service: string, dest: string) => `${service}\0${dest}`;
    const allowedMounts = new Set(detection.mounts.map((m) => key(m.service, m.destination)));
    const allowedExtras = new Set(this.target(projectTargetId(project.id)).extraFolders.map((x) => key(x.service, x.path)));
    const wasRunning = new Set(containers.filter((c) => c.running).map((c) => c.id));
    const dbServices = new Set(manifest.items.filter((i) => i.type === "database" && i.engine !== "redis").map((i) => i.service!));
    const stopped = new Set<string>();
    const stop = async (c: ProjectContainer) => {
      if (stopped.has(c.id) || !wasRunning.has(c.id)) return;
      await docker.stop(c.id);
      stopped.add(c.id);
    };
    try {
      this.step(r, "Parar o app durante a restauração");
      for (const c of containers) if (!dbServices.has(c.service)) await stop(c);

      for (const item of manifest.items) {
        const c = item.service ? byService.get(item.service) : undefined;
        if (item.type === "source") {
          this.step(r, "Pôr o código de volta");
          await this.tar.extract(path.join(content, item.file!), path.dirname(this.opts.projects.srcDir(project)));
          continue;
        }
        if (!c) {
          r.warnings.push(`O serviço "${item.service}" não existe mais no projeto: "${item.file}" não foi restaurado.`);
          continue;
        }
        if (item.type === "database" && item.engine !== "redis") {
          this.step(r, `Restaurar o banco ${item.service} (${BACKUP_ENGINE_LABELS[item.engine!]})`);
          if (!c.running && !wasRunning.has(c.id)) await docker.start(c.id);
          await this.waitReady(c.id, item.engine!);
          const errors: string[] = [];
          if (item.engine === "postgres") {
            if (item.globalsFile) await docker.execFromFile(c.id, PG_GLOBALS_RESTORE, [], path.join(content, item.globalsFile)).catch(() => undefined);
            for (const db of item.databases ?? []) {
              const { stderr } = await docker.execFromFile(c.id, restoreScript("postgres"), [db.name], path.join(content, db.file));
              errors.push(...stderr.split("\n").filter((l) => /ERROR:/.test(l)));
            }
          } else {
            const { stderr } = await docker.execFromFile(c.id, restoreScript(item.engine!), [], path.join(content, item.file!));
            errors.push(...stderr.split("\n").filter((l) => /ERROR/.test(l)));
          }
          if (errors.length > 0) r.warnings.push(`${item.service}: ${errors.length} aviso(s) do banco na restauração (ex.: ${errors[0]!.trim().slice(0, 160)}).`);
          continue;
        }
        const redis = item.type === "database";
        const dest = redis ? "/data" : item.destination ?? "";
        const allowed = redis || (item.type === "extra" ? allowedExtras : allowedMounts).has(key(item.service!, dest));
        if (!allowed) {
          r.warnings.push(`"${dest}" (${item.service}) não é uma pasta deste projeto: não foi restaurada.`);
          continue;
        }
        this.step(r, `Restaurar ${dest} (${item.service})`);
        await stop(c);
        if (item.type === "extra") await docker.copyIn(c.id, path.posix.dirname(dest), path.join(content, item.file!));
        else await docker.restorePath(c.id, dest, path.join(content, item.file!), item.isFile === true);
      }
    } finally {
      this.step(r, "Ligar o projeto de novo");
      const order = [...containers].sort((a, b) => Number(dbServices.has(b.service)) - Number(dbServices.has(a.service)));
      for (const c of order) {
        if (wasRunning.has(c.id) && stopped.has(c.id)) await docker.start(c.id).catch(() => r.warnings.push(`O container ${c.name} não ligou de novo.`));
      }
    }
  }

  private async restoreEmail(r: BackupRecord, manifest: Manifest, content: string): Promise<void> {
    const docker = this.opts.docker;
    const mail = this.opts.mail;
    const part = (p: ManifestItem["part"]) => manifest.items.find((i) => i.part === p);
    const stalwart = await docker.state(mail.container);
    this.step(r, "Parar o e-mail e pôr os dados de volta");
    if (stalwart.running) await docker.stop(mail.container);
    try {
      const data = part("stalwart-data");
      if (data) await docker.restoreVolume(mail.volume, path.join(content, data.file!));
      const etc = part("stalwart-etc");
      if (etc && stalwart.exists) await docker.copyIn(mail.container, path.posix.dirname(mail.etcPath), path.join(content, etc.file!));
    } finally {
      if (stalwart.exists) await docker.start(mail.container);
    }
    if (!stalwart.exists) {
      r.warnings.push("O servidor de e-mail ainda não existe nesta VPS: abra a página E-mail e clique em Iniciar. Ele sobe com os dados restaurados.");
    }
    const web = part("webmail");
    if (web) {
      this.step(r, "Restaurar o webmail");
      const wm = await docker.state(mail.webmailContainer);
      if (wm.running) await docker.stop(mail.webmailContainer);
      try {
        await docker.restoreVolume(mail.webmailVolume, path.join(content, web.file!));
      } finally {
        if (wm.running) await docker.start(mail.webmailContainer);
      }
    }
  }

  /** Painel: deixa pronto para a troca na próxima subida e pede o reinício. */
  private async stagePanel(r: BackupRecord, content: string, fileName: string, actor: string): Promise<void> {
    this.step(r, "Preparar a troca do estado do painel");
    const target = path.join(this.backupsDir, PANEL_RESTORE_DIR);
    await rm(target, { recursive: true, force: true });
    await rename(content, target);
    for (const name of PANEL_PRESERVED) await rm(path.join(target, name), { recursive: true, force: true });
    const marker: PanelRestoreMarker = { requestedAt: new Date(this.now()).toISOString(), fileName, actor };
    await this.writeJson(path.join(this.backupsDir, PANEL_RESTORE_MARKER), marker);
    r.warnings.push("O painel vai reiniciar para terminar a restauração. Depois, entre de novo com o usuário e a senha do backup.");
    setTimeout(() => this.opts.restartPanel?.(), this.opts.restartDelayMs ?? 3000).unref();
  }

  // -------------------------------------------------------------------------
  // Agenda, atraso e lembrete
  // -------------------------------------------------------------------------

  async tick(): Promise<void> {
    await this.ensureLoaded();
    const now = this.now();
    const projects = await this.opts.projects.list();
    const ids = ["panel", "email", ...projects.map((p) => projectTargetId(p.id))];
    for (const id of ids) {
      const t = this.target(id);
      if (!t.enabled) continue;
      const project = id.startsWith("project:") ? projects.find((p) => projectTargetId(p.id) === id)! : null;
      if (project && !project.lastDeployAt) continue;
      if (id === "email" && !(this.emailAvailable ?? (await this.mailAvailable()))) continue;
      const slot = currentSlot(now, t.frequencyHours, this.hour);
      if (t.lastSlot === null || slot > t.lastSlot) {
        t.lastSlot = slot;
        await this.persist({ config: true });
        await this.runNow(id, null).catch((err: unknown) => this.log(`Backups: agendado de ${id} não entrou na fila (${reasonOf(err)}).`));
      }
      // Externo atrasado (2 dias ou 2× a frequência), avisado no máximo 1×/dia.
      const d = this.config.destination;
      if (!d) continue;
      const since = Math.max(Date.parse(d.connectedAt), Date.parse(t.enabledSince));
      const verified = t.lastRemoteVerifiedAt ? Date.parse(t.lastRemoteVerifiedAt) : null;
      const noticed = t.lastStaleNoticeAt ? Date.parse(t.lastStaleNoticeAt) : 0;
      if (isRemoteStale({ lastVerifiedAt: verified, since, now, frequencyHours: t.frequencyHours }) && now - noticed > 24 * HOUR_MS) {
        t.lastStaleNoticeAt = new Date(now).toISOString();
        await this.persist({ config: true });
        const name = id === "panel" ? "Painel" : id === "email" ? "E-mail" : project!.name;
        const days = Math.floor((now - (verified ?? since)) / (24 * HOUR_MS));
        this.opts.notify?.({
          kind: "backup_stale",
          key: `backup-stale:${id}`,
          title: `${name}: sem backup externo conferido há ${days} dias`,
          body: ["Confira em Configurações → Backups o motivo da última falha."],
          path: "/settings/backups",
        });
      }
    }
    const e = this.config.encryption;
    if (
      e.password &&
      this.config.destination &&
      isReminderDue({
        passwordSetAt: e.passwordSetAt ? Date.parse(e.passwordSetAt) : null,
        lastTestOkAt: e.lastTestOk && e.lastTestAt ? Date.parse(e.lastTestAt) : null,
        lastReminderAt: e.lastReminderAt ? Date.parse(e.lastReminderAt) : null,
        now,
      })
    ) {
      e.lastReminderAt = new Date(now).toISOString();
      await this.persist({ config: true });
      this.opts.notify?.({
        kind: "backup_reminder",
        key: "backup-reminder",
        title: "Você ainda tem sua senha de backup? Teste aqui",
        body: ['Em Configurações → Backups, clique em "Testar minha senha". Sem ela, ninguém consegue abrir os backups externos.'],
        path: "/settings/backups",
      });
    }
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err: unknown) => this.log(`Backups: falha na agenda (${reasonOf(err)}).`));
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// ---------------------------------------------------------------------------
// LEIA-ME de cada backup
// ---------------------------------------------------------------------------

function readme(m: Manifest): string {
  const lines = [
    `Backup do TWS Panel — ${m.name}`,
    `Feito em ${new Date(m.createdAt).toLocaleString("pt-BR")}`,
    "",
    "Este arquivo abre no 7-Zip (Windows), no Keka (Mac) ou com `7z x` no Linux.",
    "Para restaurar pelo painel: aba Backups do projeto (ou Configurações → Backups) → Restaurar.",
    "",
  ];
  if (m.kind === "panel") {
    lines.push(
      "Conteúdo: o diretório de dados do painel (/data do container tws-panel): contas, projetos",
      "cadastrados, configurações, certificados próprios e as chaves que cifram os segredos.",
      "Restaurar sem o painel: pare o painel, copie estes arquivos para o volume paas_data e suba de novo,",
      "ou rode na VPS: sudo bash scripts/restaurar-painel.sh <arquivo.7z>",
    );
  } else if (m.kind === "email") {
    lines.push(
      "Conteúdo:",
      "- email/stalwart-data.tar: os dados do Stalwart (caixas, mensagens, pastas, regras, contas e chaves DKIM).",
      "- email/stalwart-etc.tar: a configuração do Stalwart.",
      "- email/webmail.tar: preferências e contatos do webmail (se ele estava ativado).",
      "Restaurar sem o painel: pare o container paas-stalwart e extraia stalwart-data.tar no volume paas_stalwart_data.",
    );
  } else {
    lines.push("Conteúdo:");
    for (const i of m.items) {
      if (i.type === "database" && i.engine === "postgres") {
        for (const db of i.databases ?? []) lines.push(`- ${db.file}: banco "${db.name}" (PostgreSQL, serviço ${i.service}). psql -U <usuário> -d ${db.name} < ${db.file}`);
        if (i.globalsFile) lines.push(`- ${i.globalsFile}: usuários e papéis do PostgreSQL.`);
      } else if (i.type === "database" && i.engine === "redis") {
        lines.push(`- ${i.file}: a pasta /data do Redis (serviço ${i.service}), em .tar.`);
      } else if (i.type === "database") {
        const how = i.engine === "mongo" ? `mongorestore --archive=${i.file} --drop` : `mysql -u root -p < ${i.file}`;
        lines.push(`- ${i.file}: ${BACKUP_ENGINE_LABELS[i.engine!]} (serviço ${i.service}). ${how}`);
      } else if (i.type === "source") {
        lines.push(`- ${i.file}: o código do projeto (pasta ${i.destination}), em .tar.`);
      } else {
        lines.push(`- ${i.file}: ${i.destination} do serviço ${i.service}, em .tar (tar -xf ${i.file} -C <destino>).`);
      }
    }
  }
  return lines.join("\n") + "\n";
}
