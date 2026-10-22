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
 *    trimestral da senha;
 *  - "Conferir" (um backup ou todos): entra na mesma fila. A cópia da VPS é
 *    aberta com `7z t`; a externa é baixada, o tamanho e o hash gravados no
 *    backup são comparados e ela é aberta com a senha. O resultado fica
 *    guardado (data/backups.json) e aparece ao lado de cada backup.
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
import { copyFile, cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, rmdir, stat, statfs, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BACKUP_ALL_TARGETS,
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
  type BackupApplyDefaultsResult,
  type BackupCatalog,
  type BackupDefaultsRequest,
  type BackupCheckResult,
  type BackupCheckStatus,
  type BackupCopyWhere,
  type BackupVerifyItem,
  type BackupVerifyRequest,
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
  type ReconciliationId,
  RESTORE_CHECK_FREQUENCIES,
  type DetectedDatabase,
  type RestoreCheckCandidate,
  type RestoreCheckReasonCode,
  type RestoreCheckResult,
  type RestoreCheckRunRequest,
  type RestoreCheckSettings,
  type RestoreCheckSettingsRequest,
  type RestoreCheckUnavailableCode,
  type RestoreCheckView,
} from "@paas/core";
import {
  RESTORE_CHECK_REASONS,
  countDbErrors,
  databaseNamesCompatible,
  firstRestorable,
  frequencyWindowMs,
} from "./backup-restore-check.js";
import { ArchiveError } from "./backup-archive.js";
import {
  PG_GLOBALS_RESTORE,
  tableCountScript,
  REDIS_SAVE,
  buildDetection,
  dumpPlan,
  itemFileName,
  mountId,
  restoreScript,
} from "./backup-detect.js";
import type { BackupDocker, ProjectContainer } from "./backup-docker.js";
import { suggestPassphrase } from "./backup-passphrase.js";
import { StorageError, type BackupStorage, type StoredObject } from "./backup-s3.js";
import { currentSlot, isReminderDue, isRemoteStale, nextSlot, timezoneLabel } from "./backup-schedule.js";
import { httpError } from "./http-error.js";
import { GENERATED_HEADER } from "@paas/deploy";
import { isInsideProjectsDir, isPanelArea } from "./projects-dir.js";
import { loadJson, loadOrCreateKey, withFileLock, writeFileAtomic } from "./json-file.js";
import { PANEL_PRESERVED, PANEL_RESTORE_DIR, PANEL_RESTORE_MARKER, PANEL_RESTORE_PROGRESS, type PanelRestoreMarker } from "./panel-restore.js";
import type { NotificationEvent } from "./notification-service.js";
import { mailAuthError } from "./mail-auth-error.js";

// ---------------------------------------------------------------------------
// Dependências
// ---------------------------------------------------------------------------

export interface Archiver {
  available(): Promise<boolean>;
  create(archive: string, inputs: string[], opts: { password?: string | null }): Promise<void>;
  test(archive: string, password: string | null): Promise<void>;
  /** `only`: extrai só estes caminhos do arquivo. */
  extract(archive: string, outDir: string, password: string | null, only?: string[]): Promise<void>;
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
  /**
   * Reserva o projeto (nenhum deploy dele começa enquanto a reserva existir) e devolve a função que a solta.
   * Lança se o projeto já está em deploy. Usado pelo teste de restauração no projeto de destino.
   */
  hold?(id: string): Promise<() => void>;
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
  /** Prazo da consulta do roteiro ao armazenamento (backups de outro painel); padrão 5 s. Só ela: as operações de backup não mudam. */
  foreignCheckTimeoutMs?: number;
  /** Espera entre as tentativas de falar com o banco que acabou de subir. */
  readyDelayMs?: number;
  /** Prazo do restore do banco no teste de restauração (padrão 30 min). */
  restoreCheckTimeoutMs?: number;
  /** Espera antes de reiniciar o painel depois de preparar a restauração (padrão 3 s). */
  restartDelayMs?: number;
  /** Nome do fuso da VPS em uso (Configurações → Fuso horário). */
  timezoneName?: () => string;
  /**
   * O domínio já aponta (DNS) para ESTA VPS? Usado ao restaurar o painel: o
   * acesso pelo IP desativado no painel antigo só continua desativado se o
   * domínio já resolve aqui. Sem a função, conta como "não aponta".
   */
  panelDomainPointsHere?: (domain: string) => Promise<boolean>;
  /**
   * Depois de restaurar, compara o que o backup tinha ATIVO com o que roda
   * nesta VPS e guarda as pendências (webmail, servidor de e-mail, domínio do
   * painel). Só informa: nada é ativado. Ver restore-reconciliation.ts.
   */
  mailAuth?: {
    /** Confere a senha de administração do Stalwart em execução e, se divergente, reaplica a configuração. */
    repair(): Promise<"ok" | "repaired" | "failed" | "unreachable" | "not_running">;
  };
  /**
   * Depois de restaurar o e-mail, cadastra no painel os domínios e caixas que o
   * Stalwart trouxe (o painel lista do seu cadastro, não do Stalwart). Só
   * nomes; nunca senhas. Ver MailService.adoptFromStalwart.
   */
  mailAdopt?: {
    adopt(): Promise<{ domains: string[]; mailboxes: string[]; skipped: string[]; skippedTotal?: number; truncated?: boolean; passwordsRealigned?: number; passwordsReapplied?: number; passwordsFailed?: string[] }>;
  };
  reconciliation?: {
    planStaged(staged: string): Promise<string[]>;
    markPending(ids: ReconciliationId[], source: "panel" | "email"): Promise<void>;
  };
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
  /**
   * Último backup COMPLETO que esta instalação enviou ao armazenamento externo
   * e conferiu (a regra do painel novo só olha este, nunca `lastSuccessAt`, que
   * já é preenchido pela cópia na VPS). Painéis de antes do campo: a carga
   * copia `lastRemoteVerifiedAt`, que era gravado nesse mesmo momento.
   */
  lastRemoteSentAt?: string | null;
  lastStaleNoticeAt: string | null;
  /**
   * Só projetos: segue o "Padrão dos projetos" (muda junto com ele). Vira
   * false quando a frequência, as cópias ou o ligado/desligado são salvos
   * na aba do projeto; "Voltar ao padrão" e "Aplicar também" põem true.
   */
  followsDefaults?: boolean;
  /** Painel: por que a última passagem da agenda não enviou backup (ver `tick`). */
  heldReason?: string;
  /** Painel: quantas vezes seguidas a listagem do armazenamento falhou na regra do painel novo. */
  heldFailures?: number;
  /** Painel: o aviso de "backups de outro servidor no armazenamento" já foi dado. */
  heldNotified?: boolean;
  /** Só projetos: teste de restauração do banco em outro projeto. */
  restoreCheck?: StoredRestoreCheck;
}

/** O que o painel guarda do teste de restauração de um projeto de origem. */
interface StoredRestoreCheck {
  settings: RestoreCheckSettings | null;
  last: RestoreCheckResult | null;
  /** A opção foi desligada pelo painel (destino apagado ou renomeado). */
  notice?: { code: "destination_missing" | "destination_renamed"; text: string; at: string } | null;
}

/**
 * Depois de restaurar o painel de outro servidor: a agenda de projetos e do
 * e-mail fica em pausa até a pessoa restaurar os dados de cada um (ver
 * `holdReason`). `released` = itens já liberados.
 */
interface RestoreHold {
  since: string;
  released: string[];
}

/** "Padrão dos projetos". */
interface StoredDefaults {
  enabled: boolean;
  frequencyHours: BackupFrequencyHours;
  localKeep: number;
  remoteKeep: number;
}

const INITIAL_DEFAULTS: StoredDefaults = { enabled: true, frequencyHours: 24, localKeep: DEFAULT_LOCAL_KEEP, remoteKeep: DEFAULT_REMOTE_KEEP };

/** O que o painel sabe de uma cópia (gravado no backup) e a última conferência. */
interface StoredCopyInfo {
  /** Quando a cópia foi criada (UTC, ISO): a retenção ordena por aqui, não pelo nome (hora local). */
  createdAt?: string;
  sha256?: string;
  size?: number;
  /** Cópia externa: saiu cifrada. */
  encrypted?: boolean;
  check?: BackupCheckResult;
  /**
   * Backup incompleto (ex.: o Redis não confirmou o SAVE): fica guardado,
   * mas não conta como completo — a retenção nunca apaga a última cópia
   * completa por causa dele.
   */
  incomplete?: boolean;
}

interface StoredFileChecks {
  local?: StoredCopyInfo;
  remote?: StoredCopyInfo;
}

interface StoredConfig {
  destination: StoredDestination | null;
  encryption: StoredEncryption;
  targets: Record<string, StoredTarget>;
  projectDefaults: StoredDefaults;
  detections: Record<string, ProjectBackupDetection>;
  restoreHold?: RestoreHold | null;
  /** Quando este painel foi restaurado de um backup: o conteúdo dele passou a ser o do backup, não "painel novo vazio". */
  panelRestoredAt?: string | null;
  /** "<pasta>/<arquivo>" → hash, tamanho e a última conferência de cada cópia. */
  checks: Record<string, StoredFileChecks>;
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

/**
 * O projeto não tem nada marcado (ou nada para copiar). No backup pedido à mão
 * é falha; no agendado o painel desliga o automático daquele projeto — repetir
 * "falhou" a cada horário não ajuda.
 */
class NothingToBackup extends BackupFailure {}

/** O backup está cifrado com uma senha que o painel não tem. */
class NoPassword extends BackupFailure {}

interface RestoreCheckFile {
  fileName: string;
  source: "local" | "remote";
  sizeBytes: number | null;
  trigger: "auto" | "manual";
  incomplete: boolean;
  /** Nome do destino quando o teste foi pedido (para o aviso). */
  destinationName: string;
}

interface RestoreCheckContext {
  release: (() => void) | null;
  dbWarnings: number;
}

/** O teste de restauração parou: "não executado" (nada foi tocado) ou "falhou". */
class RestoreCheckStop extends Error {
  constructor(
    readonly code: RestoreCheckReasonCode,
    readonly status: "not_run" | "failed" = "not_run",
  ) {
    super(code);
  }
}

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

/**
 * O que a retenção apaga: as cópias além das `keep` mais novas (`files` em
 * ordem, da mais antiga para a mais nova) — menos a última cópia COMPLETA,
 * se nenhuma das que ficam for completa. Cópias incompletas seguidas nunca
 * levam embora a última completa.
 */
export function retentionVictims(files: string[], keep: number, isComplete: (file: string) => boolean, protect?: string): string[] {
  const victims = files.slice(0, Math.max(0, files.length - keep));
  const candidates = (list: string[]): string[] => list.filter((f) => f !== protect);
  if (files.slice(victims.length).some(isComplete)) return candidates(victims);
  const lastComplete = [...victims].reverse().find(isComplete);
  return candidates(lastComplete ? victims.filter((f) => f !== lastComplete) : victims);
}

/**
 * Do mais antigo ao mais novo. O nome tem a hora LOCAL (e muda com o fuso da
 * VPS) e o sufixo de colisão (`-2`) ordena ANTES do original como texto, então
 * o nome sozinho não serve: manda a data UTC que o painel registrou (`when`);
 * sem ela, a data do nome; no empate, o número do sufixo (sem sufixo = 1).
 */
export function orderBackups(names: string[], when: (name: string) => number | null): string[] {
  const time = (n: string): number => when(n) ?? parseBackupFileStamp(n)?.getTime() ?? 0;
  const seq = (n: string): number => Number(/_\d{2}-\d{2}-(\d{1,3})\.7z$/.exec(n)?.[1] ?? 1);
  return [...names].sort((a, b) => time(a) - time(b) || seq(a) - seq(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** Temporários de gravação (atômica ou parcial): nunca entram no backup do painel. */
const TEMP_FILE_RE = /\.(tmp|partial)$/;

/**
 * Copia `src` para `dst` para o backup do painel compactar uma foto parada,
 * e não os arquivos em uso. Cada arquivo é copiado dentro da fila de
 * gravação dele (services/json-file.ts): um store que grava pelo helper
 * nunca é copiado no meio de uma gravação. Arquivo que sumiu entre listar e
 * copiar foi apagado de propósito (não faz parte do estado); arquivo que
 * existe e não pode ser lido faz o backup FALHAR, dizendo qual.
 */
async function snapshotTree(src: string, dst: string, rel: string): Promise<void> {
  let info;
  try {
    info = await lstat(src);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  try {
    if (info.isSymbolicLink()) {
      await symlink(await readlink(src), dst);
    } else if (info.isDirectory()) {
      await mkdir(dst, { mode: info.mode & 0o777 });
      for (const name of await readdir(src)) {
        if (TEMP_FILE_RE.test(name)) continue;
        await snapshotTree(path.join(src, name), path.join(dst, name), `${rel}/${name}`);
      }
    } else if (info.isFile()) {
      await withFileLock(src, () => copyFile(src, dst));
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && !existsSync(src)) return;
    if (err instanceof BackupFailure) throw err;
    throw new BackupFailure(
      `Não foi possível copiar "${rel}" do diretório de dados do painel (${code === "EACCES" ? "sem permissão de leitura" : reasonOf(err)}). O backup não foi feito e as cópias anteriores foram mantidas.`,
    );
  }
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
    projectDefaults: { ...INITIAL_DEFAULTS },
    detections: {},
    checks: {},
  };
}

/** Quanto tempo a agenda espera os dados voltarem depois de restaurar o painel. */
const RESTORE_HOLD_MS = 7 * 24 * HOUR_MS;

function parseRestoreHold(v: unknown): RestoreHold | null {
  if (typeof v !== "object" || v === null) return null;
  const h = v as Partial<RestoreHold>;
  if (typeof h.since !== "string" || Number.isNaN(Date.parse(h.since))) return null;
  return { since: h.since, released: Array.isArray(h.released) ? h.released.filter((x): x is string => typeof x === "string") : [] };
}

/** Caminho com os links resolvidos até onde existe; o que falta fica como está. */
async function realWithMissingTail(p: string): Promise<string> {
  const missing: string[] = [];
  let cur = path.resolve(p);
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    missing.unshift(path.basename(cur));
    cur = parent;
  }
  return path.join(await realpath(cur), ...missing);
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
  private mailAdopt: BackupServiceOptions["mailAdopt"];

  constructor(private readonly opts: BackupServiceOptions) {
    this.mailAdopt = opts.mailAdopt;
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
      // Erro de leitura NÃO vira "sem configuração": a carga falha e o arquivo
      // fica como está (o destino e a senha dos backups estão nele).
      this.config = await loadJson<StoredConfig>(this.file, {
        empty: emptyConfig,
        parse: (value) => {
          if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
          const raw = value as Partial<StoredConfig>;
          const base = emptyConfig();
          return {
            destination: raw.destination ?? null,
            encryption: { ...base.encryption, ...(raw.encryption ?? {}) },
            targets: raw.targets ?? {},
            projectDefaults: { ...INITIAL_DEFAULTS, ...(raw.projectDefaults ?? {}) },
            detections: raw.detections ?? {},
            checks: raw.checks ?? {},
            restoreHold: parseRestoreHold(raw.restoreHold),
            panelRestoredAt: typeof raw.panelRestoredAt === "string" ? raw.panelRestoredAt : null,
          };
        },
        log: this.log,
      });
      // Instalação de antes de `lastRemoteSentAt`: quem já tinha enviado e conferido uma cópia externa continua
      // contando como tendo conteúdo próprio; quem só tinha cópia na VPS (ou nada) não.
      for (const t of Object.values(this.config.targets)) {
        if (typeof t !== "object" || t === null || t.lastRemoteSentAt !== undefined) continue;
        t.lastRemoteSentAt = t.lastRemoteVerifiedAt ?? null;
      }
      // Instalação de antes do "Padrão dos projetos": quem está como o painel
      // criava sozinho (ligado, 24 h, 2 e 5) segue o padrão; o resto ficou
      // assim porque alguém mudou, então é configuração própria.
      for (const [id, t] of Object.entries(this.config.targets)) {
        if (!id.startsWith("project:") || t.followsDefaults !== undefined) continue;
        t.followsDefaults = t.enabled && t.frequencyHours === 24 && t.localKeep === DEFAULT_LOCAL_KEEP && t.remoteKeep === DEFAULT_REMOTE_KEEP;
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
      this.history = await loadJson<BackupRecord[]>(this.historyFile, {
        empty: () => [],
        parse: (raw) => {
          const entries = (raw as { entries?: BackupRecord[] } | null)?.entries;
          return Array.isArray(entries) ? entries : null;
        },
        log: this.log,
      });
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
      // Teste de restauração que ficou "em andamento": não vai terminar sozinho, e o banco de teste pode estar pela metade.
      let restoreInterrupted = false;
      for (const t of Object.values(this.config.targets)) {
        const last = typeof t === "object" && t !== null ? t.restoreCheck?.last : null;
        if (last?.status !== "running") continue;
        last.status = "failed";
        last.reasonCode = "panel_restarted";
        last.reason = RESTORE_CHECK_REASONS.panel_restarted;
        last.finishedAt ??= new Date(this.now()).toISOString();
        restoreInterrupted = true;
      }
      if (restoreInterrupted) await this.persistQuiet({ config: true });
      if (interrupted) await this.persistQuiet({ history: true });
      await rm(this.tmpDir, { recursive: true, force: true }).catch(() => undefined);
    })().catch((err: unknown) => {
      this.loading = null;
      throw err;
    });
    return this.loading;
  }

  /** Chave de cifra: lida (ou criada) uma vez; erro de leitura falha a carga (json-file.ts). */
  private async loadKey(): Promise<void> {
    this.key = await loadOrCreateKey(this.keyFile, KEY_BYTES, {
      log: this.log,
      dependents: async () => {
        try {
          const raw = JSON.parse(await readFile(this.file, "utf8")) as Partial<StoredConfig>;
          const itens = [raw.destination?.secret ? "a chave de acesso ao armazenamento externo" : null, raw.encryption?.password ? "a senha dos backups" : null];
          const achados = itens.filter((i): i is string => i !== null);
          return achados.length > 0 ? achados.join(" e ") : null;
        } catch {
          return null;
        }
      },
    });
  }

  private seal(secret: string, key: Buffer = this.key!): SealedBox {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  }

  private open(box: SealedBox, key: Buffer = this.key!): string {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64"));
    decipher.setAuthTag(Buffer.from(box.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]).toString("utf8");
  }

  private async writeJson(file: string, data: unknown): Promise<void> {
    await writeFileAtomic(file, JSON.stringify(data, null, 2) + "\n");
  }

  /**
   * Grava o que mudou. Falha de gravação é PROPAGADA a quem pediu a mudança
   * (configurar destino, senha, frequência…): dizer "salvo" sem ter salvo
   * perderia a configuração no próximo reinício. A fila segue para o próximo.
   */
  private persist(what: { config?: boolean; history?: boolean }): Promise<void> {
    const config = what.config ? structuredClone(this.config) : null;
    const history = what.history ? this.history.slice(-MAX_HISTORY) : null;
    const run = this.writing.then(async () => {
      try {
        if (config) await this.writeJson(this.file, config);
        if (history) await this.writeJson(this.historyFile, { entries: history });
      } catch (err) {
        this.log(`Backups: não foi possível gravar no disco (${(err as Error).message}).`);
        throw err;
      }
    });
    this.writing = run.catch(() => undefined);
    return run;
  }

  /** Para gravações internas (agendador, fim de operação): registra a falha e segue, sem derrubar quem roda. */
  private persistQuiet(what: { config?: boolean; history?: boolean }): Promise<void> {
    return this.persist(what).catch(() => undefined);
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

  /** Item sem configuração guardada: projeto nasce com o padrão dos projetos. */
  private target(id: string): StoredTarget {
    let t = this.config.targets[id];
    if (!t) {
      const project = id.startsWith("project:");
      const base = project ? this.config.projectDefaults : INITIAL_DEFAULTS;
      t = {
        enabled: base.enabled,
        frequencyHours: base.frequencyHours,
        localKeep: base.localKeep,
        remoteKeep: base.remoteKeep,
        lastSlot: currentSlot(this.now(), base.frequencyHours, this.hour),
        enabledSince: new Date(this.now()).toISOString(),
        choices: {},
        extraFolders: [],
        lastSuccessAt: null,
        lastRemoteVerifiedAt: null,
        lastRemoteSentAt: null,
        lastStaleNoticeAt: null,
        ...(project ? { followsDefaults: true } : {}),
      };
      this.config.targets[id] = t;
    }
    return t;
  }

  /**
   * Frequência, cópias e ligado/desligado (já validados). Trocar a frequência
   * ou religar recomeça a contagem no horário atual. Devolve o que mudou,
   * para a auditoria.
   */
  private applySettings(t: StoredTarget | StoredDefaults, req: BackupDefaultsRequest): string[] {
    const changes: string[] = [];
    const restart = () => {
      if ("lastSlot" in t) t.lastSlot = currentSlot(this.now(), t.frequencyHours, this.hour);
    };
    if (req.frequencyHours !== undefined && req.frequencyHours !== t.frequencyHours) {
      t.frequencyHours = req.frequencyHours;
      restart();
      changes.push(`a cada ${t.frequencyHours} h`);
    }
    for (const k of ["localKeep", "remoteKeep"] as const) {
      const v = req[k];
      if (v === undefined) continue;
      t[k] = v;
      changes.push(`${k === "localKeep" ? "na VPS" : "fora"}: ${v} cópias`);
    }
    if (req.enabled !== undefined && req.enabled !== t.enabled) {
      t.enabled = req.enabled;
      if (t.enabled) {
        restart();
        if ("enabledSince" in t) t.enabledSince = new Date(this.now()).toISOString();
      }
      changes.push(t.enabled ? "ligado" : "desligado");
    }
    return changes;
  }

  private validateSettings(req: BackupDefaultsRequest): void {
    if (req.frequencyHours !== undefined && !BACKUP_FREQUENCIES.includes(req.frequencyHours)) {
      throw httpError(400, "invalid_frequency", "Frequência inválida: use 24, 12 ou 6 horas.");
    }
    for (const k of ["localKeep", "remoteKeep"] as const) {
      const v = req[k];
      if (v !== undefined && (!Number.isInteger(v) || v < 1 || v > MAX_BACKUP_KEEP)) {
        throw httpError(400, "invalid_keep", `Quantidade de cópias inválida: de 1 a ${MAX_BACKUP_KEEP}.`);
      }
    }
  }

  /**
   * Projeto recém-criado: "Fazer backup: sim/não". Sem escolha ou igual ao
   * padrão = segue o padrão; diferente = configuração própria.
   */
  async initProject(projectId: string, enabled?: boolean): Promise<void> {
    await this.ensureLoaded();
    const t = this.target(projectTargetId(projectId));
    if (enabled !== undefined && enabled !== this.config.projectDefaults.enabled) {
      this.applySettings(t, { enabled });
      t.followsDefaults = false;
    }
    await this.persist({ config: true });
  }

  /** "Padrão dos projetos": grava e leva junto os projetos que seguem o padrão. */
  async updateDefaults(req: BackupDefaultsRequest, actor: string): Promise<void> {
    await this.ensureLoaded();
    this.validateSettings(req);
    const d = this.config.projectDefaults;
    const changes = this.applySettings(d, req);
    let followers = 0;
    for (const p of await this.opts.projects.list()) {
      const t = this.target(projectTargetId(p.id));
      if (!t.followsDefaults) continue;
      this.applySettings(t, d);
      followers++;
    }
    await this.persist({ config: true });
    if (changes.length > 0) {
      const who = followers === 1 ? "1 projeto segue o padrão" : `${followers} projetos seguem o padrão`;
      this.audit("backups.defaults", `Padrão dos projetos: ${changes.join(", ")} (${who}).`, actor);
    }
  }

  /** "Aplicar também nestes projetos": copia o padrão e passa a seguir o padrão. */
  async applyDefaults(projectIds: string[], actor: string): Promise<BackupApplyDefaultsResult> {
    await this.ensureLoaded();
    const applied: BackupApplyDefaultsResult["applied"] = [];
    const missing: string[] = [];
    for (const pid of [...new Set(projectIds)]) {
      const project = await this.opts.projects.get(pid);
      if (!project || project.id !== pid) {
        missing.push(pid);
        continue;
      }
      const t = this.target(projectTargetId(pid));
      this.applySettings(t, this.config.projectDefaults);
      t.followsDefaults = true;
      applied.push({ id: pid, name: project.name });
    }
    await this.persist({ config: true });
    if (applied.length > 0) {
      this.audit("backups.defaults_applied", `Padrão dos projetos aplicado em: ${applied.map((a) => a.name).join(", ")}.`, actor);
    }
    return { applied, missing };
  }

  /** "Voltar ao padrão" na aba do projeto. */
  async useDefaults(id: string, actor: string): Promise<void> {
    await this.ensureLoaded();
    if (!id.startsWith("project:")) throw httpError(400, "not_a_project", "Só projetos seguem o padrão dos projetos.");
    const { name } = await this.resolveTarget(id);
    const t = this.target(id);
    this.applySettings(t, this.config.projectDefaults);
    t.followsDefaults = true;
    await this.persist({ config: true });
    this.audit("backups.settings", `${name}: voltou ao padrão dos projetos.`, actor, name);
  }

  /** Projeto apagado: esquece a configuração (os arquivos de backup ficam). */
  async forgetProject(projectId: string): Promise<void> {
    await this.ensureLoaded();
    delete this.config.targets[projectTargetId(projectId)];
    delete this.config.detections[projectId];
    // Projetos que usavam este como destino do teste de restauração: a opção se desliga, com aviso.
    for (const [id, t] of Object.entries(this.config.targets)) {
      if (t?.restoreCheck?.settings?.enabled && t.restoreCheck.settings.destinationId === projectId) {
        this.disableRestoreCheck(id, "destination_missing");
      }
    }
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

  private targetStatus(id: string, kind: BackupTargetKind, name: string, folder: string, available: boolean, createdAt?: string): BackupTargetStatus {
    const t = this.target(id);
    const pausedReason = this.holdReason(id, createdAt) ?? t.heldReason ?? null;
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
      nextRunAt: t.enabled && available && !pausedReason ? new Date(nextSlot(this.now(), t.frequencyHours, this.hour)).toISOString() : null,
      available,
      pausedReason,
      ...(kind === "project"
        ? {
            followsDefaults: t.followsDefaults !== false,
            restoreCheck: { enabled: Boolean(t.restoreCheck?.settings?.enabled), last: t.restoreCheck?.last ?? null },
          }
        : {}),
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
    this.reconcileRestoreChecks(projects);
    const targets = [
      this.targetStatus("panel", "panel", "Painel", "_painel", true),
      this.targetStatus("email", "email", "E-mail", "_email", email),
      ...projects.map((p) => this.targetStatus(projectTargetId(p.id), "project", p.name, p.slug, true, p.createdAt)),
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
      projectDefaults: { ...this.config.projectDefaults },
      running: this.running?.record ?? null,
      queued: this.queue.map((j) => j.record),
      history: this.decorate([...this.history].reverse().slice(0, 50), projects),
      timezone: timezoneLabel(-new Date(this.now()).getTimezoneOffset()),
      timezoneName: this.opts.timezoneName?.() ?? (process.env.TZ || "UTC"),
      backupHour: this.hour,
      archiverAvailable: this.archiverOk,
      localPath: "/var/lib/docker/volumes/paas_data/_data/backups",
    };
  }

  /**
   * Para o roteiro (passo 6). `foreignBackupsHeld`: true = o armazenamento guarda backups de outro painel e este é novo;
   * "unknown" = não deu para conferir (falha ou prazo estourado), e o roteiro NÃO convida a fazer backup; ausente = livre.
   */
  async facts(): Promise<{ destinationConnected: boolean; verifiedRemote: number; lastFailure: string | null; foreignBackupsHeld?: true | "unknown" }> {
    await this.ensureLoaded();
    const verified = Object.values(this.config.targets).filter((t) => t.lastRemoteVerifiedAt).length;
    const failed = [...this.history].reverse().find((r) => r.remote === "failed");
    // Só leitura da regra que pausa o backup do painel (nada é gravado nem avisado); só custa uma listagem quando importa.
    const foreign = this.config.destination !== null && verified === 0 ? await this.foreignBackupsState() : false;
    return {
      destinationConnected: this.config.destination !== null,
      verifiedRemote: verified,
      lastFailure: failed?.remoteDetail ?? null,
      ...(foreign ? { foreignBackupsHeld: foreign } : {}),
    };
  }

  private foreignCache: { key: string; at: number; held: boolean } | null = null;
  private foreignInflight: Promise<true | "unknown" | false> | null = null;

  /**
   * Consulta do roteiro (só leitura): prazo curto, resultado "há cópias alheias" em cache por 60 s (a chave muda com o armazenamento, os projetos ou o que
   * já foi enviado; "livre" nunca é cacheado) e, se não deu para conferir, "unknown" (não cacheado, para "Conferir de novo" tentar outra vez).
   */
  private async foreignBackupsState(): Promise<true | "unknown" | false> {
    const projectCount = (await this.opts.projects.list()).length;
    const d = this.config.destination!;
    const key = JSON.stringify([d.connectedAt, d.testedAt, d.endpoint, d.bucket, projectCount, this.config.panelRestoredAt, this.target("panel").lastRemoteSentAt, this.target("email").lastRemoteSentAt]);
    const c = this.foreignCache;
    if (c && c.key === key && this.now() - c.at < 60_000) return c.held;
    // Uma ida ao armazenamento por vez: consultas simultâneas dividem o resultado e, com uma travada (o pedido segue aberto
    // até o timeout do S3Storage), as recargas não empilham outras; elas recebem o "unknown" já decidido.
    if (this.foreignInflight) return this.foreignInflight;
    const work = this.panelFreshOverForeign(projectCount, true).then((why) => why !== null);
    const result = this.withForeignDeadline(work).then(
      (held): true | false => {
        // Só o "há cópias alheias" (lado seguro) fica em cache: "livre" consulta sempre, porque o conteúdo do bucket muda por fora.
        if (held) this.foreignCache = { key, at: this.now(), held };
        else this.foreignCache = null;
        return held;
      },
      (): "unknown" => "unknown",
    );
    this.foreignInflight = result;
    void work.then(
      () => undefined,
      () => undefined,
    ).then(() => {
      if (this.foreignInflight === result) this.foreignInflight = null;
    });
    return result;
  }

  async projectView(projectId: string): Promise<ProjectBackupView> {
    await this.ensureLoaded();
    const id = projectTargetId(projectId);
    const { name, folder, project } = await this.resolveTarget(id);
    const t = this.target(id);
    const all = await this.opts.projects.list();
    this.reconcileRestoreChecks(all);
    return {
      target: this.targetStatus(id, "project", name, folder, true, project!.createdAt),
      detection: this.config.detections[project!.id] ?? null,
      choices: { ...t.choices },
      extraFolders: [...t.extraFolders],
      history: this.decorate(
        [...this.history].reverse().filter((r) => r.target === id).slice(0, 30),
        [project!],
      ),
      destinationConnected: this.config.destination !== null,
      restoreCheck: this.restoreCheckView(project!, all),
    };
  }

  async updateTarget(id: string, req: BackupTargetSettingsRequest, actor: string): Promise<void> {
    await this.ensureLoaded();
    const { name } = await this.resolveTarget(id);
    const t = this.target(id);
    this.validateSettings(req);
    const changes = this.applySettings(t, req);
    // Salvar frequência, cópias ou ligado na aba do projeto = configuração própria.
    const own = req.enabled !== undefined || req.frequencyHours !== undefined || req.localKeep !== undefined || req.remoteKeep !== undefined;
    if (own && id.startsWith("project:") && t.followsDefaults !== false) {
      t.followsDefaults = false;
      changes.push("configuração própria");
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
    // Pedir o mesmo backup (ou a mesma conferência) duas vezes não duplica.
    const dup = [this.running, ...this.queue].find(
      (j) =>
        j &&
        j.record.target === record.target &&
        j.record.operation === record.operation &&
        (record.operation === "backup" || record.operation === "restore_check" || (record.operation === "verify" && j.record.fileName === record.fileName)),
    );
    if (dup) return dup.record;
    this.queue.push({ record, run });
    this.history.push(record);
    void this.persistQuiet({ history: true });
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
      if (err instanceof NothingToBackup && r.trigger === "schedule") {
        // Agendado e sem nada para copiar: desliga o automático deste projeto,
        // avisa uma vez e registra como aviso (sem alarme de falha).
        r.status = "warning";
        r.warnings.push(`${reasonOf(err)} O backup automático deste projeto foi desligado; ligue de novo na aba Backups quando houver o que copiar.`);
        for (const s of r.steps) if (s.status === "running") s.status = "done";
        this.disableEmptyProject(r);
      } else {
        r.status = "failed";
        r.error = reasonOf(err);
        for (const s of r.steps) if (s.status === "running") s.status = "failed";
        this.log(`Backups: ${r.operation === "backup" ? "backup" : "restauração"} de ${r.targetName} falhou (${r.error}).`);
      }
    }
    for (const s of r.steps) if (s.status === "running") s.status = "done";
    r.finishedAt = new Date(this.now()).toISOString();
    if (r.status !== "failed" && r.trigger === "manual") {
      // Os dados do item voltaram (restauração) ou a pessoa fez o backup à mão: a agenda dele vale de novo.
      if (r.operation === "restore" || r.operation === "backup") this.releaseHold(r.target);
    }
    if (r.operation === "backup" && r.status !== "failed" && r.target === "panel") delete this.target("panel").heldReason;
    if (r.operation === "backup" && (r.status === "failed" || r.remote === "failed")) {
      this.opts.notify?.({
        kind: "backup_failed",
        key: `backup-failed:${r.target}`,
        title: r.status === "failed" ? `Backup de ${r.targetName} falhou` : `Backup de ${r.targetName}: a cópia externa falhou`,
        body: [(r.error ?? r.remoteDetail ?? "").slice(0, 200)].filter(Boolean),
        path: r.target.startsWith("project:") ? `/projects/${r.target.slice(8)}/backups` : "/settings/backups",
      });
    }
    if (r.operation === "backup" && r.status !== "failed" && r.local && r.target.startsWith("project:")) {
      await this.queueAutoRestoreCheck(r).catch((err: unknown) => this.log(`Backups: teste de restauração de ${r.targetName} não entrou na fila (${reasonOf(err)}).`));
    }
    await this.persistQuiet({ config: true, history: true });
    this.running = null;
    void this.pump();
  }

  /**
   * Texto de por que a agenda do item está em pausa depois de restaurar o
   * painel de outro servidor; null = vale. O painel nunca entra (o estado dele
   * já voltou inteiro). Projeto criado depois da restauração não é afetado, e a
   * pausa acaba sozinha em 7 dias para nada ficar sem backup para sempre.
   */
  private holdReason(id: string, createdAt?: string): string | null {
    const h = this.config.restoreHold;
    if (!h || id === "panel") return null;
    const since = Date.parse(h.since);
    if (this.now() - since > RESTORE_HOLD_MS) return null;
    if (h.released.includes(id)) return null;
    if (createdAt && Date.parse(createdAt) > since) return null;
    return "Em pausa: o painel foi restaurado e os dados deste item ainda não voltaram nesta VPS. O backup automático começa quando você restaurar os dados dele (ou fizer um backup à mão), ou em até 7 dias.";
  }

  private releaseHold(id: string): void {
    const h = this.config.restoreHold;
    if (!h || h.released.includes(id)) return;
    h.released.push(id);
    // o horário que passou durante a pausa não dispara um backup na hora
    const t = this.target(id);
    t.lastSlot = currentSlot(this.now(), t.frequencyHours, this.hour);
  }

  /**
   * Painel recém-instalado que ainda não tem nada seu (sem projetos, nenhum
   * backup feito aqui) enquanto o armazenamento já guarda backups do painel de
   * outro servidor: enviar agora poria um painel vazio no lugar do bom (e a
   * retenção apagaria os mais antigos). Devolve o motivo, ou null se pode enviar.
   */
  private sentExternally(t: StoredTarget): boolean {
    return Boolean(t.lastRemoteSentAt);
  }

  private withForeignDeadline<T>(p: Promise<T>): Promise<T> {
    p.catch(() => undefined); // se estourar o prazo, a resposta tardia não vira erro solto
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("o armazenamento não respondeu a tempo")), this.opts.foreignCheckTimeoutMs ?? 5000);
    });
    return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
  }

  private async panelFreshOverForeign(projectCount: number, readOnly = false): Promise<string | null> {
    const t = this.target("panel");
    // O que é desta instalação: projeto cadastrado, painel restaurado, ou um backup (do painel ou do e-mail)
    // já ENVIADO ao armazenamento externo. Cópia só na VPS (`lastSuccessAt`) não conta: o painel novo
    // faz uma às 03:00 mesmo sem armazenamento, e isso não pode desligar a proteção.
    if (projectCount > 0 || this.config.panelRestoredAt || this.sentExternally(t) || this.sentExternally(this.target("email"))) return null;
    const storage = this.storage();
    const d = this.config.destination;
    if (!storage || !d) return null;
    // A regra não vale para sempre (reinstalação no mesmo armazenamento): solta 7 dias depois da conexão.
    if (this.now() - Date.parse(d.connectedAt) > RESTORE_HOLD_MS) return null;
    const prefix = `${BACKUP_ROOT_FOLDER}/_painel/`;
    try {
      const found = (await storage.list(prefix)).some((o) => isValidBackupFileName(o.key.slice(prefix.length)));
      if (!readOnly) delete t.heldFailures;
      if (!found) return null;
      return "Em pausa: este painel é novo e o armazenamento já guarda backups do painel de outro servidor. Para não os sobrescrever, o painel só envia backup automático depois de ter um projeto, de você restaurar o painel ou de fazer um backup à mão com o armazenamento já conectado (cópia só na VPS não conta). Para continuar o painel antigo, comece por restaurar o painel antigo; se este é um painel novo, faça o primeiro backup à mão em Configurações → Backups (Fazer backup agora), que não é bloqueado. Atenção: a partir do primeiro backup, a retenção apaga as cópias mais antigas da pasta (mantém só as mais novas; o padrão é 5), inclusive as do painel antigo; para guardá-las, baixe-as ANTES de fazer o primeiro backup ou use outro bucket/pasta. A pausa acaba sozinha 7 dias depois de o armazenamento ser conectado.";
    } catch (err) {
      if (readOnly) throw err; // consulta do roteiro: sem contar falha nem avisar; quem chama trata como "não deu para conferir"
      t.heldFailures = (t.heldFailures ?? 0) + 1;
      if (t.heldFailures === 3) {
        this.opts.notify?.({
          kind: "backup_stale",
          key: "backup-panel-held-error",
          title: "Backup automático do painel parado: o armazenamento não responde",
          body: [`Não foi possível listar o armazenamento ${t.heldFailures} vezes seguidas (${reasonOf(err)}). Confira a conexão em Configurações → Backups.`.slice(0, 250)],
          path: "/settings/backups",
        });
      }
      return `Em pausa: não foi possível conferir se o armazenamento já guarda backups de outro servidor (${reasonOf(err)}). Tentamos de novo no próximo horário.`;
    }
  }

  /** Agendado sem nada para copiar: desliga o automático do projeto (configuração própria) e avisa. */
  private disableEmptyProject(r: BackupRecord): void {
    const t = this.target(r.target);
    t.enabled = false;
    t.followsDefaults = false; // mudar o padrão dos projetos não religa
    this.audit("backups.settings", `${r.targetName}: nada para copiar, backup automático desligado.`, "painel", r.targetName);
    this.opts.notify?.({
      kind: "backup_failed",
      key: `backup-empty:${r.target}`,
      title: `Backup de ${r.targetName}: automático desligado (nada para copiar)`,
      body: ["Se o projeto passar a guardar dados, marque o que entra na aba Backups e ligue de novo."],
      path: `/projects/${r.target.slice(8)}/backups`,
    });
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
      else ({ inputs, manifest } = await this.collectPanel(r, staging));
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
      throw new NothingToBackup("Nada marcado para o backup. Marque pelo menos um item na aba Backups do projeto ou desligue o backup automático deste projeto.");
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
    // Nomes de arquivo dentro do .7z: a troca de caracteres ("a b" e "a/b"
    // viram "a_b") podia dar o mesmo nome a dois itens, e o segundo
    // sobrescrevia o primeiro. Repetido (sem diferenciar maiúsculas, por
    // causa do Windows) ganha sufixo: a_b.sql, a_b-2.sql… O manifesto guarda
    // o arquivo de cada item, então a restauração não muda.
    const used = new Set<string>();
    const unique = (dir: string, base: string, ext: string): string => {
      let name = base;
      for (let n = 2; used.has(`${dir}/${name}${ext}`.toLowerCase()); n++) name = `${base}-${n}`;
      used.add(`${dir}/${name}${ext}`.toLowerCase());
      return `${dir}/${name}${ext}`;
    };
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
          used.add(`bancos/${base}/_papeis.sql`.toLowerCase());
          const item: ManifestItem = { type: "database", service: db.service, engine: "postgres", databases: [] };
          try {
            await docker.execToFile(c.id, globals!.script, [], path.join(dir, "_papeis.sql"));
            item.globalsFile = `bancos/${base}/_papeis.sql`;
          } catch {
            r.warnings.push(`${db.service}: os papéis (usuários) do Postgres não foram copiados; os bancos foram.`);
          }
          for (const name of names) {
            const file = unique(`bancos/${base}`, name.replace(/[^A-Za-z0-9._-]+/g, "_"), ".sql");
            await this.dumpTo(c.id, one!.script, [name], path.join(content, file), db.service);
            item.databases!.push({ name, file });
          }
          items.push(item);
        } else if (db.engine === "redis") {
          // O SAVE grava o que está na memória no dump.rdb. Sem o "OK", o
          // /data copiado pode estar velho (ou sem dump nenhum): o backup
          // segue, mas fica marcado como incompleto e avisa.
          const saved = await docker.execCapture(c.id, REDIS_SAVE, []).then(
            (out) => ({ ok: out.trim() === "OK", why: out.trim().split("\n")[0] || "sem resposta" }),
            (err: unknown) => ({ ok: false, why: reasonOf(err) }),
          );
          if (!saved.ok) {
            r.warnings.push(
              `${db.service}: o Redis não confirmou o SAVE (${saved.why.slice(0, 160)}). A cópia do /data dele pode estar desatualizada: este backup ficou incompleto e não substitui as cópias completas anteriores.`,
            );
            this.incomplete.add(r);
          }
          const file = unique("bancos", `${base}-redis`, ".tar");
          await docker.copyOut(c.id, "/data", path.join(content, file));
          items.push({ type: "database", service: db.service, engine: "redis", file, destination: "/data" });
        } else {
          const [all] = dumpPlan(db.engine);
          const file = unique("bancos", base, all!.ext ?? "");
          await this.dumpTo(c.id, all!.script, [], path.join(content, file), db.service);
          items.push({ type: "database", service: db.service, engine: db.engine, file });
        }
      }
    }
    if (mounts.length + extras.length > 0) {
      this.step(r, "Copiar os arquivos");
      for (const m of mounts) {
        const c = need(m.service);
        const file = unique("volumes", itemFileName(m.service, m.destination), ".tar");
        await mkdir(path.join(content, "volumes"), { recursive: true });
        await docker.copyOut(c.id, m.destination, path.join(content, file));
        items.push({ type: "mount", service: m.service, destination: m.destination, mountType: m.type, source: m.source, isFile: m.isFile, file });
      }
      for (const x of extras) {
        const c = need(x.service);
        const file = unique("pastas", itemFileName(x.service, x.path), ".tar");
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
      .filter((n) => n !== "backups" && !(n === "projects" && legacyProjects) && !TEMP_FILE_RE.test(n))
      .map((n) => path.join(this.opts.dataDir, n));
  };

  private async collectPanel(r: BackupRecord, staging: string): Promise<{ inputs: string[]; manifest: Manifest }> {
    this.step(r, "Conferir o espaço em disco");
    const live = await this.panelEntries();
    let size = 0;
    for (const p of live) {
      const s = await stat(p).catch(() => null);
      if (s) size += s.isDirectory() ? await dirSize(p) : s.size;
    }
    await this.ensureSpace(size, this.remoteFactor());
    this.step(r, "Copiar o diretório de dados do painel");
    // O 7-Zip compacta uma cópia: com os arquivos em uso, um que some ou muda
    // no meio sai do .7z sem aviso (código 1 do 7-Zip, achado 3 da revisão).
    const copy = path.join(staging, "painel");
    await mkdir(copy, { recursive: true, mode: 0o700 });
    const inputs: string[] = [];
    for (const p of live) {
      const name = path.basename(p);
      await snapshotTree(p, path.join(copy, name), name);
      // o que sumiu entre listar e copiar não entra (foi apagado de propósito)
      if (await lstat(path.join(copy, name)).catch(() => null)) inputs.push(path.join(copy, name));
    }
    return { inputs, manifest: { version: 1, kind: "panel", name: "Painel", createdAt: new Date(this.now()).toISOString(), items: [] } };
  }

  /** Quanto espaço a mais o backup ocupa enquanto roda (cópia, .7z, cifrado e conferência). */
  private remoteFactor(): number {
    const d = this.config.destination;
    return d && this.config.encryption.enabled ? 3.2 : d ? 2.4 : 2.2;
  }

  /** Backups em andamento que ficaram incompletos (ver StoredCopyInfo.incomplete). */
  private readonly incomplete = new WeakSet<BackupRecord>();

  /**
   * Nome que NENHUMA cópia conhecida usa: nem a pasta da VPS, nem o
   * armazenamento externo, nem o histórico deste alvo (M5). Sem isso, depois que
   * a retenção apaga a cópia local, um backup no mesmo minuto reaproveitava o
   * nome e o envio sobrescrevia a cópia externa antiga. Se o armazenamento não
   * responder à listagem, vale o resto — e o envio ainda confere antes de gravar.
   */
  private async uniqueName(dir: string, folder: string, target: string): Promise<string> {
    const used = new Set<string>();
    for (const f of await this.localFiles(folder)) used.add(f);
    for (const h of this.history) if (h.target === target && h.fileName) used.add(h.fileName);
    const prefix = `${folder}/`;
    for (const key of Object.keys(this.config.checks)) if (key.startsWith(prefix)) used.add(key.slice(prefix.length));
    const storage = this.storage();
    if (storage) {
      const remotePrefix = `${BACKUP_ROOT_FOLDER}/${folder}/`;
      try {
        for (const o of await storage.list(remotePrefix)) used.add(o.key.slice(remotePrefix.length));
      } catch {
        /* sem listagem: a conferência antes do envio ainda protege a cópia externa */
      }
    }
    const stamp = backupFileStamp(new Date(this.now()));
    let name = `${stamp}.7z`;
    for (let i = 2; used.has(name) || existsSync(path.join(dir, name)); i++) name = `${stamp}-${i}.7z`;
    return name;
  }

  /** Cópias da VPS do mais antigo ao mais novo (data registrada; sem ela, a do arquivo; sem ela, a do nome). */
  private async orderedLocalFiles(folder: string): Promise<string[]> {
    const names = await this.localFiles(folder);
    const when = new Map<string, number>();
    for (const n of names) {
      const recorded = this.config.checks[BackupService.checkKey(folder, n)]?.local?.createdAt;
      const at = recorded ? Date.parse(recorded) : (await stat(path.join(this.backupsDir, folder, n)).then((s) => s.mtimeMs).catch(() => NaN));
      if (!Number.isNaN(at)) when.set(n, at);
    }
    return orderBackups(names, (n) => when.get(n) ?? null);
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
    const complete = !this.incomplete.has(r);
    const mark: StoredCopyInfo = complete ? {} : { incomplete: true };
    this.step(r, "Compactar (.7z)");
    const localDir = path.join(this.backupsDir, folder);
    await mkdir(localDir, { recursive: true });
    const name = await this.uniqueName(localDir, folder, r.target);
    const plain = path.join(staging, "local.7z");
    await this.opts.archiver.create(plain, inputs, {});
    const localPath = path.join(localDir, name);
    await rename(plain, localPath);
    r.fileName = name;
    r.local = true;
    r.sizeBytes = (await stat(localPath)).size;
    // Hash e tamanho guardados: o "Conferir" compara com eles depois.
    const createdAt = new Date(this.now()).toISOString();
    this.copyInfo(folder, name, "local", { createdAt, sha256: await sha256File(localPath), size: r.sizeBytes, ...mark });
    if (complete) t.lastSuccessAt = new Date(this.now()).toISOString();
    // Cópias na VPS além das N mais recentes (nunca a última completa).
    // (nunca a recém-criada, qualquer que seja a ordem dos nomes)
    const local = await this.orderedLocalFiles(folder);
    for (const old of retentionVictims(local, t.localKeep, (f) => !this.config.checks[BackupService.checkKey(folder, f)]?.local?.incomplete, name)) {
      await rm(path.join(localDir, old), { force: true });
      this.dropCopy(folder, old, "local");
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
      const uploadSize = (await stat(upload)).size;
      // Nunca sobrescreve uma cópia externa que já exista com esse nome.
      if ((await storage.list(key)).some((o) => o.key === key)) {
        throw new BackupFailure(`Já existe uma cópia externa com o nome ${name}. O envio foi recusado para não sobrescrevê-la.`);
      }
      await storage.upload(key, upload);
      this.copyInfo(folder, name, "remote", { createdAt, sha256: hash, size: uploadSize, encrypted: encrypt, ...mark });
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
      if (complete) t.lastRemoteSentAt = t.lastRemoteVerifiedAt;
      // A conferência automática depois do envio também conta como "conferido em".
      this.copyInfo(folder, name, "remote", { check: { status: "ok", at: t.lastRemoteVerifiedAt, reason: null } });
      t.lastStaleNoticeAt = null;
      this.step(r, "Apagar os backups externos mais antigos");
      const prefix = `${BACKUP_ROOT_FOLDER}/${folder}/`;
      const listed = (await storage.list(prefix)).filter((o) => isValidBackupFileName(o.key.slice(prefix.length)));
      const modified = new Map(listed.map((o) => [o.key.slice(prefix.length), o.lastModified ? Date.parse(o.lastModified) : NaN]));
      const remote = orderBackups(
        listed.map((o) => o.key.slice(prefix.length)),
        (f) => {
          const recorded = this.config.checks[BackupService.checkKey(folder, f)]?.remote?.createdAt;
          const at = recorded ? Date.parse(recorded) : (modified.get(f) ?? NaN);
          return Number.isNaN(at) ? null : at;
        },
      );
      for (const old of retentionVictims(remote, t.remoteKeep, (f) => !this.config.checks[BackupService.checkKey(folder, f)]?.remote?.incomplete, name)) {
        await storage.remove(`${prefix}${old}`);
        this.dropCopy(folder, old, "remote");
      }
    } catch (err) {
      if (r.remote !== "verified") r.remote = "failed";
      r.remoteDetail = reasonOf(err);
      for (const s of r.steps) if (s.status === "running") s.status = "failed";
    }
  }

  // -------------------------------------------------------------------------
  // Conferir backups ("Conferir" e "Conferir todos")
  // -------------------------------------------------------------------------

  private static checkKey(folder: string, fileName: string): string {
    return `${folder}/${fileName}`;
  }

  /** Junta dados de uma cópia ao que já se sabe dela. */
  private copyInfo(folder: string, fileName: string, where: BackupCopyWhere, info: StoredCopyInfo): void {
    const key = BackupService.checkKey(folder, fileName);
    const entry = (this.config.checks[key] ??= {});
    entry[where] = { ...(entry[where] ?? {}), ...info };
  }

  /** A cópia foi apagada (retenção): esquece o que se sabia dela. */
  private dropCopy(folder: string, fileName: string, where: BackupCopyWhere): void {
    const key = BackupService.checkKey(folder, fileName);
    const entry = this.config.checks[key];
    if (!entry) return;
    delete entry[where];
    if (!entry.local && !entry.remote) delete this.config.checks[key];
  }

  private folderOf(target: string, projects: Project[]): string | null {
    if (target === "panel") return "_painel";
    if (target === "email") return "_email";
    const p = projects.find((x) => projectTargetId(x.id) === target);
    return p ? p.slug : null;
  }

  /** Histórico com a situação de cada cópia (existe na VPS? última conferência). */
  private decorate(records: BackupRecord[], projects: Project[]): BackupRecord[] {
    return records.map((r) => {
      if (r.operation !== "backup" || !r.fileName) return r;
      const folder = this.folderOf(r.target, projects);
      if (!folder) return r;
      const entry = this.config.checks[BackupService.checkKey(folder, r.fileName)];
      return {
        ...r,
        localExists: r.local && existsSync(path.join(this.backupsDir, folder, r.fileName)),
        localCheck: entry?.local?.check ?? null,
        remoteCheck: entry?.remote?.check ?? null,
      };
    });
  }

  /**
   * "Conferir": um backup (fileName) ou todos de um item (sem fileName), ou
   * todos de tudo (id = "all"). Entra na fila, um por vez, com uma etapa por
   * cópia. A senha da época, quando informada, só vive na memória do pedido.
   */
  async verify(id: string, req: BackupVerifyRequest, actor: string): Promise<BackupRecord> {
    await this.ensureLoaded();
    if (req.fileName !== undefined && !isValidBackupFileName(req.fileName)) throw httpError(400, "invalid_file", "Nome de backup inválido.");
    const all = id === BACKUP_ALL_TARGETS;
    if (all && req.fileName) throw httpError(400, "invalid_file", "Para um backup só, confira pelo item dele.");
    const where = req.where ?? "both";
    if (where === "remote" && !this.config.destination) throw httpError(409, "no_destination", "Conecte o armazenamento externo primeiro.");
    const targets = all
      ? [
          { id: "panel", name: "Painel", folder: "_painel" },
          ...((await this.mailAvailable()) ? [{ id: "email", name: "E-mail", folder: "_email" }] : []),
          ...(await this.opts.projects.list()).map((p) => ({ id: projectTargetId(p.id), name: p.name, folder: p.slug })),
        ]
      : [await this.resolveTarget(id)].map((t) => ({ id, name: t.name, folder: t.folder }));
    const name = all ? "Todos os backups" : targets[0]!.name;
    const record = this.newRecord(all ? BACKUP_ALL_TARGETS : id, name, "verify", "manual");
    record.fileName = req.fileName ?? null;
    record.verify = { items: [], summary: { ok: 0, failed: 0, missing: 0, needsPassword: 0 } };
    const queued = this.enqueue(record, (r) => this.runVerify(r, targets, where, req.fileName ?? null, req.password ?? null, actor));
    if (queued === record) {
      const what = req.fileName ? `do backup ${req.fileName}` : all ? "de todos os backups" : "de todos os backups do item";
      this.audit("backups.verify", `Conferência ${what} de ${name} pedida (${where === "both" ? "VPS e externa" : where === "local" ? "cópia da VPS" : "cópia externa"}).`, actor, name);
    }
    return queued;
  }

  private async runVerify(
    r: BackupRecord,
    targets: Array<{ id: string; name: string; folder: string }>,
    where: BackupCopyWhere | "both",
    fileName: string | null,
    password: string | null,
    actor: string,
  ): Promise<void> {
    const storage = where === "local" ? null : this.storage();
    const plan: Array<BackupVerifyItem & { folder: string; listedSize: number | null }> = [];
    for (const t of targets) {
      const local = where === "remote" ? [] : await this.localFiles(t.folder);
      let remote: StoredObject[] = [];
      let listError: string | null = null;
      if (storage) {
        try {
          remote = await storage.list(`${BACKUP_ROOT_FOLDER}/${t.folder}/`);
        } catch (err) {
          listError = reasonOf(err);
          r.warnings.push(`${t.name}: não foi possível listar o armazenamento externo (${listError}).`);
        }
      }
      const prefix = `${BACKUP_ROOT_FOLDER}/${t.folder}/`;
      const remoteSizes = new Map(remote.map((o) => [o.key.slice(prefix.length), o.size]));
      const names = fileName
        ? [fileName]
        : [...new Set([...local, ...[...remoteSizes.keys()].filter(isValidBackupFileName)])].sort().reverse();
      for (const n of names) {
        const base = { target: t.id, targetName: t.name, fileName: n, folder: t.folder, status: "pending" as const, reason: null };
        if (where !== "remote" && (local.includes(n) || fileName)) plan.push({ ...base, where: "local", listedSize: null });
        if (storage && (remoteSizes.has(n) || fileName)) {
          plan.push({ ...base, where: "remote", listedSize: remoteSizes.get(n) ?? null });
        }
      }
    }
    const summary = r.verify!.summary;
    r.verify!.items = plan.map(({ folder: _f, listedSize: _s, ...item }) => item);
    r.steps = plan.map((i) => ({ label: `${i.targetName} · ${i.fileName} · ${i.where === "local" ? "cópia da VPS" : "cópia externa"}`, status: "pending" }));
    if (plan.length === 0) r.warnings.push(fileName ? "Este backup não existe mais na VPS nem no armazenamento externo." : "Nenhum backup para conferir.");
    for (let i = 0; i < plan.length; i++) {
      const item = plan[i]!;
      const view = r.verify!.items[i]!;
      const step = r.steps[i]!;
      step.status = "running";
      view.status = "running";
      const result =
        item.where === "local"
          ? await this.checkLocal(item.folder, item.fileName)
          : await this.checkRemote(storage!, item.folder, item.fileName, item.listedSize, password);
      this.copyInfo(item.folder, item.fileName, item.where, { check: result });
      view.status = result.status;
      view.reason = result.reason;
      step.status = result.status === "failed" ? "failed" : "done";
      if (result.status === "ok") summary.ok++;
      else if (result.status === "failed") summary.failed++;
      else if (result.status === "missing") summary.missing++;
      else summary.needsPassword++;
      await this.persistQuiet({ config: true });
    }
    const parts = [
      `${summary.ok} íntegra(s)`,
      summary.failed ? `${summary.failed} com problema` : null,
      summary.missing ? `${summary.missing} não existe(m) mais` : null,
      summary.needsPassword ? `${summary.needsPassword} pede(m) a senha da época` : null,
    ].filter(Boolean);
    this.audit("backups.verify_result", `Conferência de ${r.targetName}: ${parts.join(", ")}.`, actor, r.targetName);
    if (summary.needsPassword) r.warnings.push("Alguma cópia não abre com a senha guardada. Confira de novo informando a senha da época do backup.");
    if (summary.failed > 0) {
      r.status = "failed";
      r.error = `${summary.failed} cópia(s) com problema.`;
      const failed = r.verify!.items.filter((x) => x.status === "failed");
      this.opts.notify?.({
        kind: "backup_failed",
        key: `backup-verify-failed:${r.target}`,
        title: failed.length === 1 ? `Conferência do backup de ${failed[0]!.targetName} falhou` : `Conferência dos backups: ${failed.length} cópias com problema`,
        body: failed
          .slice(0, 3)
          .map((x) => `${x.targetName} ${x.fileName} (${x.where === "local" ? "VPS" : "externa"}): ${(x.reason ?? "").slice(0, 120)}`),
        path: r.target.startsWith("project:") ? `/projects/${r.target.slice(8)}/backups` : "/settings/backups",
      });
    }
  }

  private result(status: BackupCheckStatus, reason: string | null): BackupCheckResult {
    return { status, at: new Date(this.now()).toISOString(), reason };
  }

  /** Cópia da VPS: existe, tamanho e hash do backup, `7z t`. */
  private async checkLocal(folder: string, fileName: string): Promise<BackupCheckResult> {
    const file = path.join(this.backupsDir, folder, fileName);
    if (!existsSync(file)) return this.result("missing", "A cópia da VPS não existe mais (a retenção apagou as mais antigas).");
    const info = this.config.checks[BackupService.checkKey(folder, fileName)]?.local;
    try {
      const size = (await stat(file)).size;
      if (info?.size !== undefined && size !== info.size) {
        return this.result("failed", `O tamanho mudou desde o backup (${formatBytes(size)}; era ${formatBytes(info.size)}).`);
      }
      if (info?.sha256 && (await sha256File(file)) !== info.sha256) {
        return this.result("failed", "O conteúdo mudou desde o backup (hash diferente).");
      }
      await this.opts.archiver.test(file, null);
      return this.result("ok", null);
    } catch (err) {
      if (err instanceof ArchiveError && err.code === "wrong_password") {
        return this.result("failed", "A cópia da VPS pede senha, mas o painel grava essa cópia sem senha: ela pode ter sido trocada.");
      }
      return this.result("failed", `O 7-Zip não conseguiu abrir: ${reasonOf(err)}`);
    }
  }

  /** Cópia externa: baixa, compara tamanho e hash do envio e abre com a senha. */
  private async checkRemote(
    storage: BackupStorage,
    folder: string,
    fileName: string,
    listedSize: number | null,
    given: string | null,
  ): Promise<BackupCheckResult> {
    const info = this.config.checks[BackupService.checkKey(folder, fileName)]?.remote;
    const dir = await this.tempDir("conferir");
    try {
      await this.ensureSpace(listedSize ?? info?.size ?? 0, 1.1);
      const file = path.join(dir, fileName);
      try {
        await storage.download(`${BACKUP_ROOT_FOLDER}/${folder}/${fileName}`, file);
      } catch (err) {
        if (err instanceof StorageError && err.code === "not_found") {
          return this.result("missing", "A cópia externa não existe mais (a retenção apagou as mais antigas).");
        }
        return this.result("failed", `Não foi possível baixar do armazenamento: ${reasonOf(err)}`);
      }
      const size = (await stat(file)).size;
      const expected = info?.size ?? listedSize;
      if (expected !== undefined && expected !== null && size !== expected) {
        return this.result("failed", `O arquivo baixado tem ${formatBytes(size)}, e o enviado tinha ${formatBytes(expected)}.`);
      }
      if (info?.sha256 && (await sha256File(file)) !== info.sha256) {
        return this.result("failed", "O arquivo baixado não bate com o enviado (hash diferente).");
      }
      let opensWithout = false;
      try {
        await this.opts.archiver.test(file, null);
        opensWithout = true;
      } catch (err) {
        if (!(err instanceof ArchiveError && err.code === "wrong_password")) return this.result("failed", `O 7-Zip não conseguiu abrir: ${reasonOf(err)}`);
      }
      if (opensWithout) {
        return info?.encrypted
          ? this.result("failed", "Esta cópia saiu cifrada e agora abre sem senha: ela pode ter sido trocada por alguém com acesso ao armazenamento.")
          : this.result("ok", null);
      }
      for (const pw of [given, this.password()].filter((p): p is string => Boolean(p))) {
        try {
          await this.opts.archiver.test(file, pw);
          return this.result("ok", null);
        } catch (err) {
          if (!(err instanceof ArchiveError && err.code === "wrong_password")) return this.result("failed", `O 7-Zip não conseguiu abrir: ${reasonOf(err)}`);
        }
      }
      return this.result(
        "needs_password",
        given
          ? "A senha digitada também não abre esta cópia. Use a senha da época do backup."
          : "Não abre com a senha guardada. Se o backup é de antes de uma troca de senha, informe a senha da época.",
      );
    } catch (err) {
      return this.result("failed", reasonOf(err));
    } finally {
      await rm(dir, { recursive: true, force: true });
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
      const { content, manifest } = await this.openBackup(r, staging, folder, kind, req.fileName, req.source, req.password ?? null);
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

  /**
   * Baixa (se for externa), abre (com a senha do pedido ou a guardada) e lê o manifesto de um backup.
   * Usado pela restauração e pelo teste de restauração. `only`: extrai só estes caminhos do arquivo.
   */
  private async openBackup(
    r: BackupRecord,
    staging: string,
    folder: string,
    kind: BackupTargetKind,
    fileName: string,
    source: "local" | "remote",
    given: string | null,
    only?: string[],
  ): Promise<{ content: string; manifest: Manifest }> {
    this.step(r, source === "local" ? "Abrir a cópia da VPS" : "Baixar do armazenamento externo");
    let archive = path.join(this.backupsDir, folder, fileName);
    if (source === "remote") {
      const storage = this.storage();
      if (!storage) throw new BackupFailure("Conecte o armazenamento externo primeiro.");
      archive = path.join(staging, fileName);
      try {
        await storage.download(`${BACKUP_ROOT_FOLDER}/${folder}/${fileName}`, archive);
      } catch (err) {
        throw new BackupFailure(reasonOf(err));
      }
    }
    this.step(r, "Conferir e abrir o arquivo");
    const password = await this.findPassword(archive, given, source === "remote");
    const content = path.join(staging, "conteudo");
    await (only ? this.opts.archiver.extract(archive, content, password, only) : this.opts.archiver.extract(archive, content, password));
    let manifest: Manifest | null = null;
    try {
      manifest = JSON.parse(await readFile(path.join(content, "manifesto.json"), "utf8")) as Manifest;
    } catch {
      manifest = null;
    }
    if (!manifest || manifest.kind !== kind) {
      throw new BackupFailure("Este arquivo não é um backup deste item (manifesto ausente ou de outro tipo).");
    }
    return { content, manifest };
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
    throw new NoPassword(
      given
        ? "A senha digitada não abre este backup. Se ele é de antes de uma troca de senha, use a senha daquela época."
        : "Este backup está cifrado com uma senha que o painel não tem. Digite a senha usada na época e tente de novo.",
    );
  }

  /**
   * Restaura o(s) dump(s) de UM banco do manifesto no container do banco e devolve as linhas ERROR do banco
   * (avisos: a restauração não para por elas). É o único caminho de restauração de banco do painel: a
   * restauração do projeto e o teste de restauração passam por aqui.
   *  - `globals` (padrão: sim): papéis do Postgres. O teste de restauração NÃO os restaura.
   *  - `postgres`: quais dumps e em que banco do container entram (padrão: cada um no banco de mesmo nome).
   *  - `timeoutMs`: prazo próprio do comando de restauração.
   */
  private async restoreDatabaseDump(
    container: string,
    item: ManifestItem,
    content: string,
    o: { globals?: boolean; postgres?: Array<{ file: string; into: string }>; timeoutMs?: number } = {},
  ): Promise<string[]> {
    const docker = this.opts.docker;
    const exec = o.timeoutMs ? { timeoutMs: o.timeoutMs } : undefined;
    await this.waitReady(container, item.engine!);
    const errors: string[] = [];
    if (item.engine === "postgres") {
      if (item.globalsFile && o.globals !== false) await docker.execFromFile(container, PG_GLOBALS_RESTORE, [], path.join(content, item.globalsFile)).catch(() => undefined);
      const dumps = o.postgres ?? (item.databases ?? []).map((d) => ({ file: d.file, into: d.name }));
      for (const db of dumps) {
        const script = restoreScript("postgres");
        const file = path.join(content, db.file);
        const { stderr } = exec ? await docker.execFromFile(container, script, [db.into], file, exec) : await docker.execFromFile(container, script, [db.into], file);
        errors.push(...stderr.split("\n").filter((l) => /ERROR:/.test(l)));
      }
    } else {
      const script = restoreScript(item.engine!);
      const file = path.join(content, item.file!);
      const { stderr } = exec ? await docker.execFromFile(container, script, [], file, exec) : await docker.execFromFile(container, script, [], file);
      errors.push(...stderr.split("\n").filter((l) => /ERROR/.test(l)));
    }
    return errors;
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
    let sourceFirst = false;
    if (containers.length === 0) {
      if (!redeploy) {
        throw new BackupFailure('O projeto não tem containers nesta VPS. Marque "Publicar do GitHub antes de restaurar" ou faça o deploy primeiro.');
      }
      // Projeto que não vem do GitHub: o código tem de estar no lugar ANTES de
      // publicar, porque a publicação lê dele (upload copia da pasta de
      // origem; existing usa a própria pasta). Sem isso, a pasta da VPS antiga
      // não existe aqui e a publicação falha.
      const sourceItem = manifest.items.find((i) => i.type === "source");
      if (sourceItem && project.ingestMode !== "git") {
        this.step(r, "Pôr o código de volta");
        await this.restoreSourceBeforeDeploy(r, project, path.join(content, sourceItem.file!));
        sourceFirst = true;
      }
      this.step(r, project.ingestMode === "git" ? "Publicar o projeto do GitHub" : "Publicar o projeto");
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
          if (sourceFirst) continue;
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
          const errors = await this.restoreDatabaseDump(c.id, item, content);
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

  /**
   * VPS nova, projeto de upload ou de pasta do servidor: devolve o código à
   * pasta de origem do projeto (a que o cadastro aponta) para a publicação
   * poder ler dele. Regras:
   *  - só grava DENTRO da pasta de projetos e nunca na área do painel (.paas);
   *  - o destino vem do cadastro do projeto, nunca do manifesto do backup;
   *  - pasta que já existe com arquivos é do usuário: fica como está;
   *  - o tar é aberto numa pasta privada e só então copiado (links não são
   *    seguidos), e o que foi criado pela metade é desfeito.
   */
  private async restoreSourceBeforeDeploy(r: BackupRecord, project: Project, tarFile: string): Promise<void> {
    const dest = path.resolve(project.source);
    const root = this.opts.projectsDir;
    /** Dentro da pasta de projetos e fora da área do painel, seguindo os links que já existem no caminho. */
    const check = async (candidate: string): Promise<void> => {
      if (!(await isInsideProjectsDir(root, candidate))) {
        throw new BackupFailure(
          `A pasta do código deste projeto (${dest}) fica fora da pasta de projetos desta VPS (${root}); o painel não grava fora dela. Ponha o código dentro da pasta de projetos e cadastre o caminho de novo.`,
        );
      }
      if (await isPanelArea(root, candidate)) {
        throw new BackupFailure(`A pasta do código deste projeto (${dest}) é a área do painel (a pasta de projetos ou ".paas"); o painel não restaura o código ali.`);
      }
    };
    await check(await realWithMissingTail(dest));
    const info = await lstat(dest).catch(() => null);
    if (info && !info.isDirectory()) throw new BackupFailure(`${dest} existe e não é uma pasta; o código não foi restaurado.`);
    if (info && (await readdir(dest)).length > 0) {
      r.warnings.push(`A pasta do código (${dest}) já existe nesta VPS e tem arquivos: ficou como está, nada foi sobrescrito.`);
      return;
    }
    const name = path.basename(this.opts.projects.srcDir(project));
    const tmp = await this.tempDir("codigo");
    try {
      await this.tar.extract(tarFile, tmp);
      const from = path.join(tmp, name);
      if (!(await lstat(from).catch(() => null))?.isDirectory()) {
        throw new BackupFailure(`O backup não traz a pasta do código ("${name}").`);
      }
      // Uma pasta por vez: o mkdir recursivo segue links e criaria pastas fora da pasta de projetos
      // se um link fosse plantado no caminho. Cada nível é conferido pelo caminho real antes do próximo.
      const levels: string[] = [];
      let existing = path.dirname(dest);
      for (; !(await lstat(existing).catch(() => null)); existing = path.dirname(existing)) levels.unshift(existing);
      await check(path.join(await realpath(existing), ...levels.map((l) => path.basename(l)), path.basename(dest)));
      for (const level of levels) {
        try {
          await mkdir(level);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
            throw new BackupFailure(`Não foi possível gravar o código em ${dest}: ${reasonOf(err)}. Confira se o painel tem permissão de escrita na pasta de projetos.`);
          }
        }
        await check(path.join(await realpath(level)));
      }
      await check(path.join(await realpath(path.dirname(dest)), path.basename(dest)));
      // Só o que ESTA restauração copia entra na lista de desfazer: o que o usuário tenha criado ali nunca é tocado.
      const copied: string[] = [];
      let created = false;
      try {
        if (!info) {
          await mkdir(dest);
          created = true;
        }
        for (const entry of await readdir(from)) {
          const target = path.join(dest, entry);
          if (!(await lstat(target).catch(() => null))) copied.push(target);
          await cp(path.join(from, entry), target, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
        }
        if (project.ingestMode === "upload") {
          // O .env gerado pelo painel antigo (senhas da VPS antiga) não volta: o painel gera um novo no deploy.
          // Um .env escrito pelo dono (sem o cabeçalho do painel) fica.
          const env = path.join(dest, ".env");
          const text = await readFile(env, "utf8").catch(() => null);
          if (text !== null && text.startsWith(GENERATED_HEADER)) await rm(env, { force: true });
        }
      } catch (err) {
        try {
          for (const target of copied) await rm(target, { recursive: true, force: true });
          // a pasta que esta restauração criou sai se ficou vazia (rmdir não apaga pasta com arquivos)
          if (created) await rmdir(dest);
        } catch {
          /* a limpeza não pode esconder o motivo da falha */
        }
        throw new BackupFailure(`Não foi possível gravar o código em ${dest}: ${reasonOf(err)}. Confira se o painel tem permissão de escrita na pasta de projetos.`);
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
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
      r.warnings.push(
        "O servidor de e-mail ainda não existe nesta VPS: abra a página E-mail e clique em Iniciar. Ele sobe com os dados restaurados. Depois de iniciar, use Sincronizar com o servidor de e-mail para o painel cadastrar os domínios e caixas que vieram no backup.",
      );
    }
    const pending: ReconciliationId[] = [];
    if (!stalwart.exists) pending.push("mail-server");
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
      // O passo acima devolve os DADOS do volume; ele não liga o webmail. O check do passo não pode passar por "webmail ativo".
      if (!wm.running) {
        pending.push("webmail");
        r.warnings.push(
          "Os dados do webmail voltaram, mas o webmail não está rodando nesta VPS. Nada foi ativado: ative em E-mail → Webmail (o painel também pergunta no Dashboard).",
        );
      }
    }
    // O etc/ restaurado traz a senha de administração do servidor ANTIGO (config.toml); o painel usa a do mail.json desta VPS.
    let canAdopt = stalwart.exists && this.mailAdopt !== undefined;
    if (stalwart.exists && this.opts.mailAuth) {
      let result: "ok" | "repaired" | "failed" | "unreachable" | "not_running" | "erro" = "erro";
      try {
        result = await this.opts.mailAuth.repair();
      } catch (err) {
        this.opts.log?.(`E-mail: não deu para conferir a senha de administração depois de restaurar (${reasonOf(err)}).`);
      }
      // sem autenticar no Stalwart não há o que ler: a pessoa sincroniza depois de resolver
      if (result !== "ok" && result !== "repaired") canAdopt = false;
      if (result === "repaired") {
        r.warnings.push("A senha de administração do servidor de e-mail que veio no backup não era a deste painel: o painel reaplicou a configuração e reiniciou o servidor de e-mail. Nenhum dado foi apagado.");
      } else if (result === "failed" || result === "unreachable" || result === "erro") {
        pending.push("mail-auth");
        r.warnings.push(
          "Não foi possível confirmar que o painel autentica no servidor de e-mail depois da restauração. Se aparecer “não conseguiu autenticar”, pare e inicie o servidor em E-mail → Servidor (ou use o aviso do Dashboard)." +
            (this.mailAdopt !== undefined
              ? " Os domínios e caixas do e-mail ainda não foram cadastrados no painel: depois disso, abra E-mail e use Sincronizar com o servidor de e-mail."
              : ""),
        );
      }
    }
    if (canAdopt) await this.adoptRestoredEmail(r);
    if (pending.length > 0 && this.opts.reconciliation) {
      try {
        await this.opts.reconciliation.markPending(pending, "email");
      } catch (err) {
        this.opts.log?.(`Reconciliação: não deu para guardar a pendência (${reasonOf(err)}).`);
      }
    }
  }

  /**
   * O Stalwart voltou com os domínios e caixas do backup, mas o painel lista
   * do seu próprio cadastro. Cadastra o que falta (só nomes; nada é ativado,
   * nenhuma senha é lida) e conta o resultado no registro. Falha não derruba a
   * restauração: os dados já voltaram, e o botão Sincronizar repete o passo.
   */
  private async adoptRestoredEmail(r: BackupRecord): Promise<void> {
    this.step(r, "Conferir os domínios e caixas do e-mail no painel");
    try {
      const { domains, mailboxes, skipped, skippedTotal, truncated, passwordsRealigned = 0, passwordsReapplied = 0, passwordsFailed = [] } = await this.mailAdopt!.adopt();
      if (domains.length > 0 || mailboxes.length > 0) {
        const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
        const what = [
          ...(domains.length > 0 ? [count(domains.length, "domínio", "domínios")] : []),
          ...(mailboxes.length > 0 ? [count(mailboxes.length, "caixa", "caixas")] : []),
        ].join(" e ");
        r.steps[r.steps.length - 1]!.label = `Cadastrei ${what} no painel`;
        r.warnings.push(
          `Cadastrei ${what} no painel (o que o servidor de e-mail trouxe do backup). Nada foi ativado.` +
            (mailboxes.length > 0 ? " As caixas cadastradas ficam sem senha conhecida pelo painel: para enviar por elas, use Trocar senha." : "") +
            (domains.length > 0 ? " O DNS dos domínios aparece como não verificado: use Verificar agora em cada um." : ""),
        );
      }
      const caixas = (n: number) => `${n} ${n === 1 ? "caixa" : "caixas"}`;
      if (passwordsRealigned > 0) {
        const label = `Realinhei a senha de ${caixas(passwordsRealigned)} do painel`;
        if (domains.length === 0 && mailboxes.length === 0) r.steps[r.steps.length - 1]!.label = label;
        r.warnings.push(
          `${label} (postmaster@ e caixas de projeto) no servidor de e-mail: a senha delas no servidor era diferente da que o painel guarda (o backup trouxe a antiga), e o painel reaplicou a dele. Nenhuma caixa de usuário foi alterada e nada foi reiniciado.`,
        );
      }
      if (passwordsReapplied > 0 && passwordsRealigned === 0 && domains.length === 0 && mailboxes.length === 0) {
        // informativo: não deu para conferir antes, então não se afirma que estava diferente (e o status não é rebaixado)
        r.steps[r.steps.length - 1]!.label = `Reapliquei a senha de ${caixas(passwordsReapplied)} do painel (não deu para conferir antes)`;
      }
      if (passwordsFailed.length > 0) {
        r.warnings.push(
          `Não consegui realinhar a senha destas caixas: ${passwordsFailed.slice(0, 10).join(", ")}${passwordsFailed.length > 10 ? ` e mais ${passwordsFailed.length - 10}` : ""}. Abra E-mail e use Sincronizar com o servidor de e-mail, ou Trocar senha na caixa.`,
        );
      }
      if (skipped.length > 0) {
        const total = Math.max(skippedTotal ?? 0, skipped.length);
        const shown = skipped.slice(0, 10).join(", ") + (total > 10 ? ` e mais ${total - 10}` : "");
        r.warnings.push(
          `Do servidor de e-mail, não consegui cadastrar no painel estes nomes (nome sem endereço completo, domínio inválido ou sem chave de assinatura): ${shown}. Eles continuam no servidor, sem alteração.`,
        );
      }
      if (truncated) {
        r.warnings.push(
          "O servidor de e-mail tem mais de 20 000 domínios ou caixas: o painel leu só os primeiros, e o resto não foi conferido nem cadastrado.",
        );
      }
    } catch (err) {
      const reason = mailAuthError(err)?.message ?? reasonOf(err);
      r.warnings.push(
        `Não foi possível cadastrar no painel os domínios e caixas do e-mail (${reason}). Nada foi apagado. Quando o servidor de e-mail responder, abra E-mail e use Sincronizar com o servidor de e-mail.`,
      );
    }
  }

  /**
   * O serviço de e-mail só existe dentro do plugin de rotas do e-mail (o
   * Fastify isola o escopo); o plugin entrega aqui o mesmo serviço da tela.
   */
  setMailAdopt(adopt: BackupServiceOptions["mailAdopt"]): void {
    this.mailAdopt = adopt;
  }

  /** Painel: deixa pronto para a troca na próxima subida e pede o reinício. */
  private async stagePanel(r: BackupRecord, content: string, fileName: string, actor: string): Promise<void> {
    this.step(r, "Preparar a troca do estado do painel");
    // Troca pela metade (só acontece se a subida não terminou nem desfez):
    // a pasta extraída ainda guarda parte do backup — não pode ser apagada.
    if (existsSync(path.join(this.backupsDir, PANEL_RESTORE_PROGRESS))) {
      throw new BackupFailure("Há uma restauração do painel pela metade. Reinicie o painel para ele terminar ou desfazer a troca e tente de novo.");
    }
    const target = path.join(this.backupsDir, PANEL_RESTORE_DIR);
    await rm(target, { recursive: true, force: true });
    await rename(content, target);
    for (const name of PANEL_PRESERVED) await rm(path.join(target, name), { recursive: true, force: true });
    await this.adaptRestoredPanel(r, target);
    await this.reconcileStagedPanel(r, target);
    const marker: PanelRestoreMarker = { requestedAt: new Date(this.now()).toISOString(), fileName, actor };
    await this.writeJson(path.join(this.backupsDir, PANEL_RESTORE_MARKER), marker);
    r.warnings.push("O painel vai reiniciar para terminar a restauração. Depois, entre de novo com o usuário e a senha do backup.");
    setTimeout(() => this.opts.restartPanel?.(), this.opts.restartDelayMs ?? 3000).unref();
  }

  /**
   * O backup do painel traz o estado de OUTRO servidor. Antes da troca, ajusta
   * a cópia que vai entrar no lugar (nunca o backup original) no que não vale
   * numa VPS nova. Cada ajuste falha sozinho: o aviso diz o que conferir.
   */
  private async adaptRestoredPanel(r: BackupRecord, staged: string): Promise<void> {
    try {
      await this.adaptStagedBackupSettings(r, staged);
    } catch (err) {
      r.warnings.push(
        `Não foi possível ajustar as configurações de backup que vão voltar (${reasonOf(err)}). Depois do reinício, confira em Configurações → Backups o armazenamento externo e a agenda dos projetos.`,
      );
    }
    try {
      await this.adaptStagedPanelDomain(r, staged);
    } catch (err) {
      r.warnings.push(
        `Não foi possível conferir o acesso pelo IP (${reasonOf(err)}). Se o painel não abrir pelo domínio, use o endereço do IP; se também não abrir, rode scripts/reativar-acesso-ip.sh no servidor.`,
      );
    }
  }

  /**
   * O que o painel antigo tinha ativo (webmail, servidor de e-mail, domínio)
   * x o que roda nesta VPS. Só informa e guarda a pendência; nunca ativa nada
   * e nunca derruba a restauração.
   */
  private async reconcileStagedPanel(r: BackupRecord, staged: string): Promise<void> {
    if (!this.opts.reconciliation) return;
    try {
      r.warnings.push(...(await this.opts.reconciliation.planStaged(staged)));
    } catch (err) {
      r.warnings.push(
        `Não foi possível conferir o que o painel antigo tinha ativo (${reasonOf(err)}). Depois do reinício, confira o webmail e o servidor de e-mail em E-mail e o domínio em Configurações → Domínio do painel.`,
      );
    }
  }

  /**
   * Configurações de backup que voltam com o painel:
   *  - o ARMAZENAMENTO em uso nesta VPS continua (o que a restauração usou
   *    para baixar): um token novo, ou o antigo revogado, não quebra a
   *    restauração dos projetos e do e-mail. A senha dos backups continua a do
   *    backup (é a que abre as cópias antigas);
   *  - a agenda dos projetos e do e-mail fica em pausa até os dados voltarem
   *    (ver `holdReason`), e a do painel conta o horário de agora como atendido.
   */
  private async adaptStagedBackupSettings(r: BackupRecord, staged: string): Promise<void> {
    await this.flush();
    const cfgFile = path.join(staged, "backups.json");
    const keyFile = path.join(staged, "backups-key");
    if (!existsSync(cfgFile) || !existsSync(keyFile)) {
      // Backup antigo, sem as configurações de backup: leva as de agora, senão o painel ficaria sem armazenamento.
      if (existsSync(this.file) && existsSync(this.keyFile)) {
        await copyFile(this.file, cfgFile);
        await copyFile(this.keyFile, keyFile);
        await rm(path.join(staged, "backups-history.json"), { force: true });
        // O conteúdo do painel passa a ser o do backup: a regra do painel novo não vale mais (ver `panelFreshOverForeign`).
        const current = JSON.parse(await readFile(cfgFile, "utf8")) as Partial<StoredConfig>;
        current.panelRestoredAt = new Date(this.now()).toISOString();
        await writeFileAtomic(cfgFile, JSON.stringify(current, null, 2) + "\n");
        r.warnings.push("Este backup não traz as configurações de backup: o armazenamento e a senha de agora continuam.");
      }
      return;
    }
    const cfg = JSON.parse(await readFile(cfgFile, "utf8")) as Partial<StoredConfig>;
    if (typeof cfg !== "object" || cfg === null) throw new Error("backups.json do backup é inválido");
    const hex = (await readFile(keyFile, "utf8")).trim();
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("a chave de backups do backup é inválida");
    const stagedKey = Buffer.from(hex, "hex");
    const current = this.config.destination;
    if (current) {
      const secret = this.open(current.secret);
      let same = false;
      try {
        same = cfg.destination?.accessKeyId === current.accessKeyId && this.open(cfg.destination.secret, stagedKey) === secret;
      } catch {
        same = false;
      }
      cfg.destination = { ...current, secret: this.seal(secret, stagedKey) };
      if (!same) {
        r.warnings.push(
          `As chaves do armazenamento externo que você configurou nesta VPS (${current.bucket}, …${current.accessKeyId.slice(-4)}) foram mantidas: o backup trazia outras, e as de agora são as que funcionam aqui. Se o servidor antigo foi invadido, revogue o token antigo no provedor.`,
        );
      }
    }
    // Mesma VPS: o que já tem containers aqui continua na agenda. VPS nova: nada está liberado.
    const released: string[] = [];
    for (const p of await this.opts.projects.list()) {
      let found: ProjectContainer[] = [];
      try {
        found = await this.opts.docker.projectContainers(p.slug);
      } catch {
        /* sem resposta do Docker: o projeto fica em pausa (o lado seguro) */
      }
      if (found.length > 0) released.push(projectTargetId(p.id));
    }
    let mailExists = false;
    try {
      mailExists = (await this.opts.docker.state(this.opts.mail.container)).exists;
    } catch {
      /* idem */
    }
    if (mailExists) released.push("email");
    cfg.restoreHold = { since: new Date(this.now()).toISOString(), released };
    cfg.panelRestoredAt = new Date(this.now()).toISOString();
    const panel = cfg.targets?.["panel"];
    if (panel) panel.lastSlot = currentSlot(this.now(), panel.frequencyHours, this.hour);
    await writeFileAtomic(cfgFile, JSON.stringify(cfg, null, 2) + "\n");
  }

  /**
   * Acesso pelo IP desativado no painel antigo: só continua desativado se o
   * domínio do painel já aponta para esta VPS. Senão o painel restaurado
   * responderia só no domínio (ainda apontando para o servidor antigo) e
   * ninguém entraria.
   */
  private async adaptStagedPanelDomain(r: BackupRecord, staged: string): Promise<void> {
    const file = path.join(staged, "panel-domain.json");
    if (!existsSync(file)) return;
    const state = JSON.parse(await readFile(file, "utf8")) as { domain?: unknown; ipAccessDisabled?: unknown };
    if (state.ipAccessDisabled !== true) return;
    const domain = typeof state.domain === "string" ? state.domain : null;
    let points = false;
    if (domain && this.opts.panelDomainPointsHere) points = await this.opts.panelDomainPointsHere(domain).catch(() => false);
    if (points) return;
    state.ipAccessDisabled = false;
    await writeFileAtomic(file, JSON.stringify(state, null, 2) + "\n");
    r.warnings.push(
      `O painel antigo tinha o acesso pelo IP desativado. Aqui ele fica ativo, porque ${domain ?? "o domínio do painel"} ainda não aponta para esta VPS (sem isso você não conseguiria entrar). Quando o DNS apontar, desative de novo em Configurações → Domínio do painel.`,
    );
  }

  // -------------------------------------------------------------------------
  // Teste de restauração: valida o backup do banco restaurando-o em outro projeto
  // -------------------------------------------------------------------------
  //
  // Desligado por padrão: o backup padrão não muda. Ligado, depois de cada backup
  // do projeto de origem o painel enfileira (na mesma fila de backup e restauração,
  // uma operação por vez) a restauração do DUMP DO BANCO no banco do projeto de
  // destino e confere que ele ficou com tabelas. Só o dump do banco: nada de
  // volumes, arquivos, código, variáveis ou e-mail, e nem os papéis do Postgres.
  // O resultado fica em `restoreCheck` do projeto de origem.

  private rcOf(targetId: string): StoredRestoreCheck | undefined {
    return this.config.targets[targetId]?.restoreCheck;
  }

  /** O banco do projeto de origem que o backup copia (marcado, restaurável), ou o motivo de não haver. */
  private sourceDatabase(projectId: string): { db: DetectedDatabase | null; reason: string | null; code: RestoreCheckUnavailableCode | null } {
    const det = this.config.detections[projectId];
    if (!det || det.error) return { db: null, code: "undetected", reason: "O banco deste projeto ainda não foi detectado. Faça o deploy e use Detectar de novo." };
    const dbs = det.databases.filter((d) => firstRestorable([d]));
    if (dbs.length === 0) return { db: null, code: "no_database", reason: "Este projeto não tem banco PostgreSQL, MySQL, MariaDB ou MongoDB detectado." };
    const choices = this.config.targets[projectTargetId(projectId)]?.choices ?? {};
    const chosen = dbs.find((d) => choices[d.id] ?? d.defaultSelected);
    if (!chosen) return { db: null, code: "not_selected", reason: "O banco deste projeto não está marcado no backup. Marque-o em O que entra no backup." };
    return { db: chosen, code: null, reason: null };
  }

  /** Este projeto é o destino do teste de outro (ligado)? */
  private isRestoreCheckDestination(projectId: string): boolean {
    return Object.values(this.config.targets).some((t) => t?.restoreCheck?.settings?.enabled && t.restoreCheck.settings.destinationId === projectId);
  }

  private restoreCheckCandidates(projectId: string, source: DetectedDatabase, all: Project[]): RestoreCheckCandidate[] {
    const out: RestoreCheckCandidate[] = [];
    for (const p of all) {
      if (p.id === projectId) continue;
      const det = this.config.detections[p.id];
      if (!det || det.error) continue;
      const d = det.databases.find((x) => x.engine === source.engine);
      if (!d || !databaseNamesCompatible(source.engine, source.databaseName, d.databaseName)) continue;
      // quem é origem de um teste não é destino de outro: nunca restaurar em cima de um projeto "de verdade"
      if (this.rcOf(projectTargetId(p.id))?.settings?.enabled) continue;
      out.push({ id: p.id, name: p.name, engine: source.engine });
    }
    return out;
  }

  private restoreCheckView(project: Project, all: Project[]): RestoreCheckView {
    const rc = this.rcOf(projectTargetId(project.id));
    const { db, reason, code } = this.sourceDatabase(project.id);
    const isDest = !reason && this.isRestoreCheckDestination(project.id);
    const unavailableReason = reason ?? (isDest ? "Este projeto é o destino do teste de restauração de outro projeto, então não pode ter um teste próprio." : null);
    return {
      settings: rc?.settings ? { ...rc.settings } : null,
      last: rc?.last ? { ...rc.last } : null,
      unavailableReason,
      unavailableCode: code ?? (isDest ? "is_destination" : null),
      engine: db?.engine ?? null,
      candidates: db && !unavailableReason ? this.restoreCheckCandidates(project.id, db, all) : [],
      notice: rc?.notice ? { ...rc.notice } : null,
    };
  }

  /** Destino apagado ou renomeado: a opção se desliga (com aviso) em vez de restaurar no projeto errado. */
  private reconcileRestoreChecks(all: Project[]): void {
    for (const [id, t] of Object.entries(this.config.targets)) {
      const s = t?.restoreCheck?.settings;
      if (!s?.enabled) continue;
      const dest = all.find((p) => p.id === s.destinationId);
      if (!dest) this.disableRestoreCheck(id, "destination_missing");
      else if (dest.name !== s.destinationName) this.disableRestoreCheck(id, "destination_renamed");
    }
  }

  private disableRestoreCheck(targetId: string, code: "destination_missing" | "destination_renamed"): void {
    const rc = this.rcOf(targetId)!;
    const settings = rc.settings!;
    settings.enabled = false;
    const text = `${RESTORE_CHECK_REASONS[code]} A validação do backup restaurando em outro projeto foi desligada; escolha o destino de novo para ligá-la.`;
    rc.notice = { code, text, at: new Date(this.now()).toISOString() };
    this.audit("backups.restore_check", `Teste de restauração desligado (${code === "destination_missing" ? "destino apagado" : "destino renomeado"}).`, "painel", settings.destinationName);
    this.opts.notify?.({
      kind: "backup_failed",
      key: `restore-check-off:${targetId}`,
      title: "Teste de restauração do backup desligado",
      body: [text.slice(0, 250)],
      path: `/projects/${targetId.slice(8)}/backups`,
    });
    void this.persistQuiet({ config: true });
  }

  /** Liga, troca o destino ou a frequência, ou desliga. Ligar e trocar o destino exigem digitar o nome do destino. */
  async updateRestoreCheck(projectId: string, req: RestoreCheckSettingsRequest, actor: string): Promise<RestoreCheckView> {
    await this.ensureLoaded();
    const id = projectTargetId(projectId);
    const { project } = await this.resolveTarget(id);
    const all = await this.opts.projects.list();
    this.reconcileRestoreChecks(all);
    const t = this.target(id);
    const cur = t.restoreCheck?.settings ?? null;
    if (!req.enabled) {
      if (cur?.enabled) {
        cur.enabled = false;
        await this.persist({ config: true });
        this.audit("backups.restore_check", `${project!.name}: teste de restauração desligado.`, actor, project!.name);
      }
      return this.restoreCheckView(project!, all);
    }
    if (req.frequency !== undefined && !(RESTORE_CHECK_FREQUENCIES as readonly string[]).includes(req.frequency)) {
      throw httpError(400, "invalid_restore_check_frequency", "Frequência inválida.");
    }
    const { db, reason } = this.sourceDatabase(projectId);
    if (!db) throw httpError(409, "restore_check_unavailable", reason!);
    if (this.isRestoreCheckDestination(projectId)) {
      throw httpError(409, "restore_check_chain", "Este projeto é o destino do teste de restauração de outro projeto, então não pode ter um teste próprio.");
    }
    const destId = req.destinationId ?? cur?.destinationId;
    if (!destId) throw httpError(400, "invalid_destination", "Escolha o projeto de destino.");
    if (destId === projectId) throw httpError(400, "invalid_destination", "O destino não pode ser o próprio projeto.");
    const dest = await this.opts.projects.get(destId);
    if (!dest) throw httpError(404, "not_found", "Projeto de destino não encontrado.");
    const keeps = Boolean(cur?.enabled && cur.destinationId === dest.id && cur.destinationName === dest.name);
    if (!keeps) {
      if (!this.restoreCheckCandidates(projectId, db, all).some((c) => c.id === dest.id)) {
        throw httpError(400, "invalid_destination", "Este projeto não pode ser o destino: precisa ser outro projeto, com banco do mesmo tipo e que não faça um teste próprio.");
      }
      if ((req.confirm ?? "").trim().toLowerCase() !== dest.name.toLowerCase()) {
        throw httpError(400, "confirm_mismatch", `Para confirmar, digite exatamente: ${dest.name}`);
      }
    }
    t.restoreCheck = {
      settings: { enabled: true, destinationId: dest.id, destinationName: dest.name, frequency: req.frequency ?? cur?.frequency ?? "each" },
      last: t.restoreCheck?.last ?? null,
      notice: null,
    };
    await this.persist({ config: true });
    if (!keeps) this.audit("backups.restore_check", `${project!.name}: teste de restauração ligado, destino ${dest.name}.`, actor, project!.name);
    else this.audit("backups.restore_check", `${project!.name}: frequência do teste de restauração alterada.`, actor, project!.name);
    return this.restoreCheckView(project!, all);
  }

  /** Último backup usável (completo): a cópia da VPS, ou a externa quando a da VPS não existe mais. */
  private async latestRestorableBackup(folder: string): Promise<{ fileName: string; source: "local" | "remote"; sizeBytes: number | null } | null> {
    let points: BackupPoint[];
    try {
      points = await this.pointsFor(folder);
    } catch {
      const local: BackupPoint[] = [];
      for (const name of await this.localFiles(folder)) {
        local.push({ fileName: name, at: parseBackupFileStamp(name)!.toISOString(), sizeBytes: (await stat(path.join(this.backupsDir, folder, name))).size, local: true, remote: false });
      }
      points = local.sort((a, b) => b.fileName.localeCompare(a.fileName));
    }
    for (const p of points) {
      const entry = this.config.checks[BackupService.checkKey(folder, p.fileName)];
      if (p.local && !entry?.local?.incomplete) return { fileName: p.fileName, source: "local", sizeBytes: p.sizeBytes };
      if (p.remote && !entry?.remote?.incomplete) return { fileName: p.fileName, source: "remote", sizeBytes: p.sizeBytes };
    }
    return null;
  }

  /** "Testar agora": o teste com o último backup, com a mesma confirmação digitada. Ignora a frequência. */
  async runRestoreCheck(projectId: string, req: RestoreCheckRunRequest, actor: string): Promise<BackupRecord> {
    await this.ensureLoaded();
    const id = projectTargetId(projectId);
    const { project, folder } = await this.resolveTarget(id);
    this.reconcileRestoreChecks(await this.opts.projects.list());
    const s = this.rcOf(id)?.settings;
    if (!s?.enabled) throw httpError(409, "restore_check_off", "Ligue a validação do backup restaurando em outro projeto primeiro.");
    if (req.confirm.trim().toLowerCase() !== s.destinationName.toLowerCase()) {
      throw httpError(400, "confirm_mismatch", `Para confirmar, digite exatamente: ${s.destinationName}`);
    }
    const file = await this.latestRestorableBackup(folder);
    if (!file) throw httpError(409, "no_backup", RESTORE_CHECK_REASONS.no_backup);
    const queued = this.enqueueRestoreCheck(project!.id, project!.name, s, { ...file, trigger: "manual", incomplete: false });
    this.audit("backups.restore_check_run", `Teste de restauração de ${project!.name} pedido (destino ${s.destinationName}).`, actor, project!.name);
    return queued;
  }

  /** Depois de um backup do projeto: enfileira o teste, se a opção está ligada e a frequência deixa. */
  private async queueAutoRestoreCheck(r: BackupRecord): Promise<void> {
    const rc = this.rcOf(r.target);
    const s = rc?.settings;
    if (!s?.enabled || !r.fileName) return;
    const window = frequencyWindowMs(s.frequency);
    const last = rc!.last;
    if (window > 0 && last && last.status !== "not_run" && this.now() - Date.parse(last.startedAt) < window) return;
    this.enqueueRestoreCheck(r.target.slice(8), r.targetName, s, { fileName: r.fileName, source: "local", sizeBytes: r.sizeBytes, trigger: "auto", incomplete: this.incomplete.has(r) });
  }

  private enqueueRestoreCheck(projectId: string, projectName: string, s: RestoreCheckSettings, file: Omit<RestoreCheckFile, "destinationName">): BackupRecord {
    const id = projectTargetId(projectId);
    const record = this.newRecord(id, projectName, "restore_check", file.trigger === "auto" ? "schedule" : "manual");
    record.fileName = file.fileName;
    const job: RestoreCheckFile = { ...file, destinationName: s.destinationName };
    const queued = this.enqueue(record, (rec) => this.restoreCheckJob(rec, projectId, job));
    if (queued === record) {
      const rc = this.rcOf(id)!;
      rc.last = {
        status: "running",
        trigger: file.trigger,
        startedAt: new Date(this.now()).toISOString(),
        finishedAt: null,
        durationMs: null,
        destinationId: s.destinationId,
        destinationName: s.destinationName,
        backupFileName: file.fileName,
        reasonCode: null,
        reason: null,
        dbWarnings: 0,
        recordId: record.id,
      };
      void this.persistQuiet({ config: true });
    }
    return queued;
  }

  private async restoreCheckJob(r: BackupRecord, projectId: string, file: RestoreCheckFile): Promise<void> {
    const id = projectTargetId(projectId);
    const started = this.now();
    const ctx: RestoreCheckContext = { release: null, dbWarnings: 0 };
    let status: "ok" | "failed" | "not_run" = "ok";
    let code: RestoreCheckReasonCode | null = null;
    try {
      await this.restoreCheckBody(r, projectId, file, ctx);
    } catch (err) {
      if (err instanceof RestoreCheckStop) {
        status = err.status;
        code = err.code;
      } else {
        // nada do erro vai para o log: pode citar valores do banco
        status = "failed";
        code = "restore_failed";
        this.log(`Backups: teste de restauração de ${r.targetName} terminou com erro inesperado.`);
      }
    } finally {
      try {
        ctx.release?.();
      } catch {
        /* a reserva já foi solta */
      }
    }
    const reason = code ? RESTORE_CHECK_REASONS[code] : null;
    const last = this.rcOf(id)?.last;
    if (last && last.recordId === r.id) {
      last.status = status;
      last.finishedAt = new Date(this.now()).toISOString();
      last.durationMs = Math.max(0, this.now() - started);
      last.reasonCode = code;
      last.reason = reason;
      last.dbWarnings = ctx.dbWarnings;
    }
    if (status === "ok") {
      if (ctx.dbWarnings > 0) r.warnings.push(`${ctx.dbWarnings} aviso(s) do banco na restauração.`);
    } else if (status === "not_run") {
      r.status = "warning";
      r.warnings.push(reason!);
      for (const s of r.steps) if (s.status === "running") s.status = "done";
    } else {
      r.status = "failed";
      r.error = reason;
      for (const s of r.steps) if (s.status === "running") s.status = "failed";
      this.opts.notify?.({
        kind: "backup_failed",
        key: `restore-check-failed:${id}`,
        title: `Teste de restauração de ${r.targetName} falhou`,
        body: [`Destino: ${file.destinationName}. ${reason}`.slice(0, 250)],
        path: `/projects/${projectId}/backups`,
      });
    }
  }

  private async restoreCheckBody(r: BackupRecord, projectId: string, file: RestoreCheckFile, ctx: RestoreCheckContext): Promise<void> {
    const id = projectTargetId(projectId);
    const docker = this.opts.docker;
    this.step(r, "Conferir os projetos de origem e de destino");
    const s = this.rcOf(id)?.settings;
    if (!s?.enabled) throw new RestoreCheckStop("turned_off");
    const all = await this.opts.projects.list();
    const dest = all.find((p) => p.id === s.destinationId);
    if (!dest) {
      this.disableRestoreCheck(id, "destination_missing");
      throw new RestoreCheckStop("destination_missing");
    }
    if (dest.name !== s.destinationName) {
      this.disableRestoreCheck(id, "destination_renamed");
      throw new RestoreCheckStop("destination_renamed");
    }
    if (this.rcOf(projectTargetId(dest.id))?.settings?.enabled) throw new RestoreCheckStop("destination_chain");
    const { db: sourceDb } = this.sourceDatabase(projectId);
    if (!sourceDb) throw new RestoreCheckStop("source_no_database");
    if (file.incomplete) throw new RestoreCheckStop("backup_incomplete");

    // Nenhum deploy do destino começa enquanto o teste roda (a fila já impede backup e restauração dele).
    if (this.opts.projects.hold) {
      try {
        ctx.release = await this.opts.projects.hold(dest.id);
      } catch {
        throw new RestoreCheckStop("destination_busy");
      }
    }
    let detection: ProjectBackupDetection;
    try {
      detection = await this.detect(dest);
    } catch {
      throw new RestoreCheckStop("destination_not_running");
    }
    if (detection.error) throw new RestoreCheckStop("destination_not_running");
    if (!firstRestorable(detection.databases)) throw new RestoreCheckStop("destination_no_database");
    const destDb = detection.databases.find((d) => d.engine === sourceDb.engine);
    if (!destDb) throw new RestoreCheckStop("engine_mismatch");
    if (!databaseNamesCompatible(destDb.engine, sourceDb.databaseName, destDb.databaseName)) throw new RestoreCheckStop("database_name_mismatch");
    // O banco do destino tem de estar rodando: o painel não liga, não para e não reinicia nada do destino.
    const container = (await docker.projectContainers(dest.slug)).find((c) => c.service === destDb.service);
    if (!container || !container.running) throw new RestoreCheckStop("destination_not_running");

    try {
      await this.ensureSpace(Number(file.sizeBytes), 4);
    } catch {
      throw new RestoreCheckStop("no_space");
    }

    const staging = await this.tempDir("teste-restauracao");
    try {
      const folder = backupFolderFor({ kind: "project", slug: (await this.opts.projects.get(projectId))!.slug });
      let opened: { content: string; manifest: Manifest };
      try {
        // só o manifesto e os dumps dos bancos saem do arquivo: volumes e código nem são abertos
        opened = await this.openBackup(r, staging, folder, "project", file.fileName, file.source, null, ["manifesto.json", "bancos"]);
      } catch (err) {
        throw new RestoreCheckStop(err instanceof NoPassword ? "no_password" : "backup_unreadable");
      }
      const { content, manifest } = opened;
      const items = manifest.items.filter((i) => i.type === "database" && i.engine === destDb.engine);
      if (items.length === 0) throw new RestoreCheckStop("no_database_in_backup");
      const item = items.length === 1 ? items[0] : items.find((i) => i.service === sourceDb.service);
      if (!item) throw new RestoreCheckStop("ambiguous_database");
      try {
        await checkManifestFiles({ ...manifest, items: [item] }, content);
      } catch {
        throw new RestoreCheckStop("backup_unreadable");
      }
      let postgres: Array<{ file: string; into: string }> | undefined;
      let sanityDb = "";
      if (item.engine === "postgres") {
        const dumps = item.databases!;
        const others = dumps.filter((d) => d.name !== "postgres");
        const main = dumps.find((d) => d.name === sourceDb.databaseName) ?? (others.length === 1 ? others[0] : undefined);
        if (!main) throw new RestoreCheckStop("ambiguous_database");
        sanityDb = destDb.databaseName ?? main.name;
        postgres = [{ file: main.file, into: sanityDb }];
      }
      this.step(r, `Restaurar o banco em ${dest.name}`);
      let errors: string[];
      try {
        errors = await this.restoreDatabaseDump(container.id, item, content, { globals: false, postgres, timeoutMs: this.opts.restoreCheckTimeoutMs ?? 30 * 60_000 });
      } catch (err) {
        throw new RestoreCheckStop(/prazo/.test(err instanceof Error ? err.message : "") ? "timeout" : "restore_failed", "failed");
      }
      ctx.dbWarnings = countDbErrors(errors.join("\n"), item.engine!);
      this.step(r, "Conferir o banco do destino");
      const script = tableCountScript(item.engine!);
      if (script) {
        let tables = 0;
        try {
          tables = Number.parseInt((await docker.execCapture(container.id, script, item.engine === "postgres" ? [sanityDb] : [])).trim(), 10);
        } catch {
          throw new RestoreCheckStop("sanity_failed", "failed");
        }
        if (!(tables >= 1)) throw new RestoreCheckStop("sanity_failed", "failed");
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  // -------------------------------------------------------------------------
  // Agenda, atraso e lembrete
  // -------------------------------------------------------------------------

  async tick(): Promise<void> {
    await this.ensureLoaded();
    const now = this.now();
    if (this.config.restoreHold && now - Date.parse(this.config.restoreHold.since) > RESTORE_HOLD_MS) {
      this.config.restoreHold = null;
      await this.persistQuiet({ config: true });
    }
    const projects = await this.opts.projects.list();
    const ids = ["panel", "email", ...projects.map((p) => projectTargetId(p.id))];
    for (const id of ids) {
      const t = this.target(id);
      if (!t.enabled) continue;
      const project = id.startsWith("project:") ? projects.find((p) => projectTargetId(p.id) === id)! : null;
      if (project && !project.lastDeployAt) continue;
      if (id === "email" && !(this.emailAvailable ?? (await this.mailAvailable()))) continue;
      // Em pausa só não agenda: o aviso de "sem backup externo há N dias" abaixo continua valendo.
      const paused = this.holdReason(id, project?.createdAt) !== null;
      const slot = currentSlot(now, t.frequencyHours, this.hour);
      if (!paused && (t.lastSlot === null || slot > t.lastSlot)) {
        t.lastSlot = slot;
        let run = true;
        if (id === "panel") {
          const why = await this.panelFreshOverForeign(projects.length);
          if (why) {
            t.heldReason = why;
            this.log(`Backups: ${why}`);
            // o aviso já dado fica registrado à parte: uma falha de listagem antes não o consome e ele não repete
            if (!t.heldNotified && !why.includes("não foi possível conferir")) {
              t.heldNotified = true;
              this.opts.notify?.({
                kind: "backup_stale",
                key: "backup-panel-held",
                title: "Backup automático do painel em pausa: o armazenamento tem backups de outro servidor",
                body: [why.slice(0, 250)],
                path: "/settings/backups",
              });
            }
            run = false;
          } else {
            delete t.heldReason;
            delete t.heldNotified;
          }
        }
        await this.persistQuiet({ config: true });
        if (run) await this.runNow(id, null).catch((err: unknown) => this.log(`Backups: agendado de ${id} não entrou na fila (${reasonOf(err)}).`));
      }
      // Externo atrasado (2 dias ou 2× a frequência), avisado no máximo 1×/dia.
      const d = this.config.destination;
      if (!d) continue;
      const since = Math.max(Date.parse(d.connectedAt), Date.parse(t.enabledSince));
      const verified = t.lastRemoteVerifiedAt ? Date.parse(t.lastRemoteVerifiedAt) : null;
      const noticed = t.lastStaleNoticeAt ? Date.parse(t.lastStaleNoticeAt) : 0;
      if (isRemoteStale({ lastVerifiedAt: verified, since, now, frequencyHours: t.frequencyHours }) && now - noticed > 24 * HOUR_MS) {
        t.lastStaleNoticeAt = new Date(now).toISOString();
        await this.persistQuiet({ config: true });
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
      await this.persistQuiet({ config: true });
      this.opts.notify?.({
        kind: "backup_reminder",
        key: "backup-reminder",
        title: "Você ainda tem sua senha de backup? Teste aqui",
        body: ['Em Configurações → Backups, clique em "Testar minha senha". Sem ela, ninguém consegue abrir os backups externos.'],
        path: "/settings/backups",
      });
    }
  }

  /**
   * O fuso da VPS mudou (Configurações → Fuso horário): a agenda passa a
   * contar as 03:00 no fuso novo. O horário que acabou de "chegar" no fuso
   * novo conta como atendido — senão trocar de Berlim para São Paulo de
   * manhã dispararia na hora um backup das 03:00 que já passou.
   */
  async timezoneChanged(): Promise<void> {
    await this.ensureLoaded();
    const now = this.now();
    for (const t of Object.values(this.config.targets)) {
      const slot = currentSlot(now, t.frequencyHours, this.hour);
      if (t.lastSlot === null || slot > t.lastSlot) t.lastSlot = slot;
    }
    await this.persistQuiet({ config: true });
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
