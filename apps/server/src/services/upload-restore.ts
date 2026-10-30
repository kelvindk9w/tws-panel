/**
 * upload-restore.ts — "Restaurar de um arquivo": o dump de banco chega por envio (outro servidor, a máquina de
 * desenvolvimento, uma ferramenta) e é restaurado no banco de um serviço do projeto.
 *
 * Fluxo (a tela acompanha cada passo):
 *  1. ENVIO (receive): o corpo do pedido é gravado em disco AO CHEGAR, em data/uploads/restore/<id> (id sorteado; o nome
 *     do arquivo da pessoa nunca vira caminho nem entra em comando). Nada fica na memória e /tmp (tmpfs) não é usado.
 *     Tamanho máximo configurável (padrão 10 GB), espaço livre conferido antes e durante o envio, e o formato é
 *     reconhecido pelos primeiros bytes assim que eles chegam: arquivo errado interrompe o envio.
 *  2. VALIDAÇÃO: .gz lido até o fim; SQL do PostgreSQL sem comandos do cliente psql; backup do painel (.7z) aberto
 *     (pedindo a senha, se cifrado).
 *  3. RESTAURAÇÃO (begin/execute), só depois da reautenticação feita pela rota: opcionalmente um backup completo do
 *     projeto antes (aborta se falhar); reserva o deploy; para o app; despeja o arquivo na entrada padrão do cliente do
 *     banco DENTRO do container (psql, pg_restore, mysql, mongorestore), o mesmo caminho da restauração de backups do
 *     painel; liga o app de novo.
 *  4. LIMPEZA: o arquivo enviado (e a pasta de trabalho de um .7z) é apagado ao terminar, com sucesso ou falha, e ao
 *     cancelar. Uma varredura apaga o que ficou para trás (partida do painel e a cada hora, mais de 24 h).
 *
 * Auditoria: quem pediu, o projeto, o serviço, o tamanho e o formato. Nunca o nome do arquivo, o conteúdo, a senha
 * do backup nem a saída do banco.
 */
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  BACKUP_ENGINE_LABELS,
  UPLOAD_RESTORE_DEFAULT_MAX_BYTES,
  type BackupDatabaseEngine,
  type BackupRecord,
  type Project,
  type UploadRestoreBackupChoice,
  type UploadRestoreCheckRequest,
  type UploadRestoreCheckResponse,
  type UploadRestoreJob,
  type UploadRestoreOptions,
  type UploadRestoreStartRequest,
  type UploadRestoreTarget,
  type UploadRestoreUploaded,
} from "@paas/core";
import { MY_ENV, PG_ENV, dumpPlan, mongoEnv } from "./backup-detect.js";
import type { BackupDocker } from "./backup-docker.js";
import { mongoRestoreFailure, type Archiver } from "./backup-service.js";
import { httpError, type HttpError } from "./http-error.js";
import {
  FORMAT_HEAD_BYTES,
  UploadFormatError,
  assertFormatFitsEngine,
  detectFormat,
  formatLabel,
  scanPostgresSql,
  verifyGzip,
  type DetectedFormat,
} from "./upload-restore-format.js";

const MiB = 1024 * 1024;
/** Espaço que sempre sobra no disco depois do envio (o painel precisa gravar o próprio estado). */
const DISK_RESERVE = 1024 * MiB;
/** Durante o envio, abaixo disto livre o envio é interrompido. */
const DISK_FLOOR = 512 * MiB;
/** De quantos em quantos bytes gravados o espaço livre é conferido. */
const SPACE_CHECK_EVERY = 64 * MiB;
/** Quantos arquivos enviados e não usados cada projeto pode ter ao mesmo tempo. */
const MAX_UPLOADS_PER_PROJECT = 2;
const STALE_MS = 24 * 60 * 60_000;
const BACKUP_WAIT_MS = 30 * 60_000;
const RESTORE_TIMEOUT_MS = 6 * 60 * 60_000;
const OUTPUT_MAX = 20_000;
const JOBS_KEPT = 3;
const DB_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.$-]{0,62}$/;
const SAFE_PATH_PART = /^[A-Za-z0-9._-]+$/;

/** Tamanho máximo do envio vindo do ambiente (PAAS_UPLOAD_RESTORE_MAX_BYTES); valor inválido volta ao padrão. */
export function uploadRestoreMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PAAS_UPLOAD_RESTORE_MAX_BYTES;
  if (!raw) return UPLOAD_RESTORE_DEFAULT_MAX_BYTES;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= MiB ? n : UPLOAD_RESTORE_DEFAULT_MAX_BYTES;
}

// ---------------------------------------------------------------------------
// Scripts (rodam no container do banco, com `sh -c`; o arquivo entra pela entrada padrão)
// ---------------------------------------------------------------------------

/** gzip só existe se o container tiver: sem ele o pipeline "sucederia" com entrada vazia, então para antes. */
const GUNZIP = [
  'if [ "$GZ" = gz ]; then',
  '  command -v gzip >/dev/null 2>&1 || { echo "o container do banco não tem o gzip para abrir o arquivo .gz" >&2; exit 127; }',
  "  UNZIP='gzip -dc'",
  "else",
  "  UNZIP=cat",
  "fi",
].join("\n");

/** $1 = banco, $2 = gz|raw. Para no primeiro erro e desfaz tudo (uma transação só). */
export const PG_SQL_SCRIPT = [PG_ENV, 'DB="$1"; GZ="$2"', GUNZIP, '$UNZIP | psql -U "$U" -d "$DB" -X -q -v ON_ERROR_STOP=1 --single-transaction'].join("\n");

/** $1 = banco, $2 = gz|raw, $3 = clean|keep. Donos e permissões do dump são ignorados (o servidor de destino não tem os papéis). */
export const PG_CUSTOM_SCRIPT = [
  PG_ENV,
  'DB="$1"; GZ="$2"; CLEAN="$3"',
  GUNZIP,
  'FLAGS="--no-owner --no-privileges --single-transaction --exit-on-error"',
  '[ "$CLEAN" = clean ] && FLAGS="$FLAGS --clean --if-exists"',
  '$UNZIP | pg_restore -U "$U" -d "$DB" $FLAGS',
].join("\n");

/** $1 = banco (pode ser vazio), $2 = gz|raw. O cliente para no primeiro erro; o que já foi aplicado fica. */
export const MYSQL_SCRIPT = [MY_ENV, 'DB="$1"; GZ="$2"', GUNZIP, '$UNZIP | if [ -n "$DB" ]; then $CLI -u"$U" "$DB"; else $CLI -u"$U"; fi'].join("\n");

/** $1 = gz|raw, $2 = clean|keep. */
export const MONGO_SCRIPT = [
  'GZ="$1"; CLEAN="$2"',
  GUNZIP,
  'FLAGS=""',
  '[ "$CLEAN" = clean ] && FLAGS="--drop"',
  mongoEnv("mongorestore"),
  '$UNZIP | mongorestore --archive $FLAGS --quiet "$@"',
].join("\n");

const PG_LIST = dumpPlan("postgres")[0]!.script;
const MYSQL_LIST = `${MY_ENV}\n$CLI -u"$U" -N -B -e 'SHOW DATABASES' | grep -Ev '^(information_schema|performance_schema|mysql|sys)$' || true`;

// ---------------------------------------------------------------------------
// Dependências
// ---------------------------------------------------------------------------

export interface UploadRestoreDeps {
  dataDir: string;
  docker: BackupDocker;
  backups: {
    databaseServices(projectId: string): Promise<Array<{ service: string; engine: BackupDatabaseEngine; containerId: string | null; running: boolean; databaseName: string | null }>>;
    openUploadedArchive(archive: string, given: string | null): Promise<{ password: string | null } | { needsPassword: true; message: string }>;
    runNow(target: string, actor: string): Promise<BackupRecord>;
    record(id: string): Promise<BackupRecord>;
  };
  archiver: Pick<Archiver, "extract">;
  projects: {
    get(id: string): Promise<Project | null>;
    hold?(id: string, reason?: string): Promise<() => void>;
    maintenance?(slug: string): () => void;
  };
  audit: { record(input: { actor?: string; action: string; target?: string | null; detail: string }): Promise<unknown> };
  maxBytes?: number;
  statfs?: (p: string) => Promise<{ bavail: number; bsize: number }>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  backupWaitMs?: number;
  backupPollMs?: number;
  restoreTimeoutMs?: number;
  staleMs?: number;
  /** De quantos em quantos bytes gravados o espaço livre é conferido (padrão 64 MB). */
  spaceCheckBytes?: number;
}

interface UploadMeta {
  id: string;
  projectId: string;
  service: string;
  file: string;
  sizeBytes: number;
  detected: DetectedFormat;
  needsPassword: boolean;
  createdAt: number;
  inUse: boolean;
}

interface Plan {
  project: Project;
  meta: UploadMeta;
  target: { service: string; engine: BackupDatabaseEngine; containerId: string };
  database: string | null;
  clean: boolean;
  backup: UploadRestoreBackupChoice;
  backupPassword: string | null;
  /** Serviços de banco do projeto: ficam ligados; os demais (o app) param durante a restauração. */
  dbServices: Set<string>;
}

/** Falha com mensagem para a pessoa (vai para o trabalho como está). */
class Failure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly output: string | null = null,
  ) {
    super(message);
  }
}

const ignore = (): undefined => undefined;
const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const tail = (s: string, n = OUTPUT_MAX): string => (s.length > n ? s.slice(-n) : s);
const familyOf = (e: BackupDatabaseEngine): string => (e === "mariadb" ? "mysql" : e);

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= MiB) return `${Math.round(n / MiB)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export class UploadRestoreService {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly statfsFn: NonNullable<UploadRestoreDeps["statfs"]>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly staleMs: number;
  private readonly spaceCheckBytes: number;
  private readonly pollMs: number;
  private readonly uploads = new Map<string, UploadMeta>();
  /** Envios em curso por projeto (ainda sem registro em `uploads`). */
  private readonly receiving = new Map<string, number>();
  private readonly running = new Set<string>();
  private readonly jobs = new Map<string, UploadRestoreJob[]>();
  private readonly background = new Set<Promise<unknown>>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: UploadRestoreDeps) {
    this.dir = path.join(deps.dataDir, "uploads", "restore");
    this.maxBytes = deps.maxBytes ?? UPLOAD_RESTORE_DEFAULT_MAX_BYTES;
    this.statfsFn = deps.statfs ?? ((p) => statfs(p));
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.staleMs = deps.staleMs ?? STALE_MS;
    this.spaceCheckBytes = deps.spaceCheckBytes ?? SPACE_CHECK_EVERY;
    this.pollMs = deps.backupPollMs ?? 1500;
  }

  get limit(): number {
    return this.maxBytes;
  }

  // -------------------------------------------------------------------------
  // Tela
  // -------------------------------------------------------------------------

  private async project(id: string): Promise<Project> {
    const p = await this.deps.projects.get(id);
    if (!p) throw httpError(404, "not_found", "Projeto não encontrado.");
    return p;
  }

  private async free(): Promise<number | null> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      const fs = await this.statfsFn(this.dir);
      return fs.bavail * fs.bsize;
    } catch {
      return null;
    }
  }

  private busy(projectId: string): boolean {
    return this.running.has(projectId) || (this.receiving.get(projectId) ?? 0) > 0;
  }

  private async listDatabases(t: { engine: BackupDatabaseEngine; containerId: string | null; running: boolean }): Promise<string[]> {
    if (!t.running || !t.containerId || (familyOf(t.engine) !== "postgres" && familyOf(t.engine) !== "mysql")) return [];
    const script = familyOf(t.engine) === "postgres" ? PG_LIST : MYSQL_LIST;
    const out = await this.deps.docker.execCapture(t.containerId, script, []).catch(() => "");
    return out.split("\n").map((l) => l.trim()).filter((l) => DB_NAME.test(l));
  }

  async options(projectId: string): Promise<UploadRestoreOptions> {
    const project = await this.project(projectId);
    const targets = await this.deps.backups.databaseServices(projectId);
    const services: UploadRestoreTarget[] = [];
    for (const t of targets) {
      services.push({ service: t.service, engine: t.engine, running: t.running, databases: await this.listDatabases(t), defaultDatabase: t.databaseName });
    }
    return {
      services,
      maxBytes: this.maxBytes,
      freeBytes: await this.free(),
      // TODO(feat/aba-banco): quando a marca "projeto de desenvolvimento" (Project.development) entrar no dev, é este campo
      // que a tela lê para sugerir "Não fazer backup". Até lá a leitura é defensiva e o padrão é o backup completo.
      development: (project as Project & { development?: boolean }).development === true,
      busy: this.busy(projectId),
    };
  }

  // -------------------------------------------------------------------------
  // Envio
  // -------------------------------------------------------------------------

  private async targetOf(projectId: string, service: string): Promise<{ service: string; engine: BackupDatabaseEngine; containerId: string | null; running: boolean; databaseName: string | null }> {
    const t = (await this.deps.backups.databaseServices(projectId)).find((x) => x.service === service);
    if (!t) throw httpError(400, "unknown_service", "Esse serviço não é um banco deste projeto (PostgreSQL, MySQL/MariaDB ou MongoDB).");
    return t;
  }

  /** Confere só os primeiros bytes (a tela manda 8 KB antes de enviar o arquivo): evita subir GB de um arquivo errado. */
  async precheck(projectId: string, service: string, head: Buffer, fileName: string | undefined): Promise<{ format: DetectedFormat["format"]; gzip: boolean }> {
    await this.project(projectId);
    const t = await this.targetOf(projectId, service);
    this.assertName(fileName);
    const detected = this.inspectHead(t.engine, head);
    return { format: detected.format, gzip: detected.gzip };
  }

  private assertName(fileName: string | undefined): void {
    if (fileName && /\.zip$/i.test(fileName.trim())) {
      throw httpError(400, "zip_not_supported", "Arquivo .zip não é aceito. Extraia o dump (.sql, .dump, .backup) e envie-o, ou compacte só ele com gzip (.sql.gz).");
    }
  }

  private inspectHead(engine: BackupDatabaseEngine, head: Buffer): DetectedFormat {
    const detected = detectFormat(head);
    assertFormatFitsEngine(engine, detected);
    return detected;
  }

  /**
   * Grava o corpo do pedido em disco, sem guardá-lo na memória. Interrompe e apaga o que gravou se: passa do tamanho
   * máximo, o disco está acabando, o formato não serve ao banco escolhido ou o cliente desiste.
   */
  async receive(input: { projectId: string; service: string; actor: string; stream: Readable; contentLength: number | null; fileName?: string }): Promise<UploadRestoreUploaded> {
    const { projectId, service, stream } = input;
    const project = await this.project(projectId);
    const t = await this.targetOf(projectId, service);
    this.assertName(input.fileName);
    const mine = [...this.uploads.values()].filter((u) => u.projectId === projectId).length;
    if (this.running.has(projectId) || mine + (this.receiving.get(projectId) ?? 0) >= MAX_UPLOADS_PER_PROJECT) {
      throw httpError(409, "upload_busy", "Já há um envio ou uma restauração por arquivo neste projeto. Termine ou cancele antes de enviar outro arquivo.");
    }
    this.receiving.set(projectId, (this.receiving.get(projectId) ?? 0) + 1);
    const id = randomBytes(12).toString("hex");
    const file = path.join(this.dir, id);
    let total = 0;
    let head = Buffer.alloc(0);
    let detected: DetectedFormat | null = null;
    let nextCheck = this.spaceCheckBytes;
    const inspect = (): void => {
      if (detected) return;
      if (head.length === 0) throw httpError(400, "empty_file", "O arquivo está vazio.");
      detected = this.inspectHead(t.engine, head);
    };
    const guard = new Transform({
      transform: (chunk: Buffer, _enc, cb) => {
        void (async () => {
          total += chunk.length;
          if (total > this.maxBytes) throw httpError(413, "too_large", `O arquivo passou do máximo de ${formatBytes(this.maxBytes)} e o envio foi interrompido.`);
          if (!detected && head.length < FORMAT_HEAD_BYTES) {
            head = Buffer.concat([head, chunk.subarray(0, FORMAT_HEAD_BYTES - head.length)]);
            if (head.length >= FORMAT_HEAD_BYTES) inspect();
          }
          if (total >= nextCheck) {
            nextCheck = total + this.spaceCheckBytes;
            const left = await this.free();
            if (left !== null && left < DISK_FLOOR) throw httpError(507, "no_space", "O disco do servidor está quase cheio: o envio foi interrompido e o arquivo parcial apagado. Libere espaço e tente de novo.");
          }
          return chunk;
        })().then(
          (out) => cb(null, out),
          (err: unknown) => cb(err as Error),
        );
      },
      flush: (cb) => {
        try {
          inspect();
          cb();
        } catch (err) {
          cb(err as Error);
        }
      },
    });
    try {
    if (input.contentLength !== null && input.contentLength > this.maxBytes) {
      throw httpError(413, "too_large", `O arquivo tem ${formatBytes(input.contentLength)} e o máximo é ${formatBytes(this.maxBytes)}.`);
    }
    const free = await this.free();
    if (free !== null && input.contentLength !== null && free < input.contentLength + DISK_RESERVE) {
      throw httpError(507, "no_space", `Não há espaço no disco para receber ${formatBytes(input.contentLength)}: há ${formatBytes(free)} livres. Libere espaço no servidor e tente de novo.`);
    }
      await pipeline(stream, guard, createWriteStream(file, { flags: "wx", mode: 0o600 }));
      const written = (await stat(file)).size;
      if (written !== total || (input.contentLength !== null && written !== input.contentLength)) {
        throw httpError(400, "incomplete_upload", "O envio chegou incompleto. Tente de novo.");
      }
      const meta: UploadMeta = { id, projectId, service, file, sizeBytes: written, detected: detected!, needsPassword: false, createdAt: this.now(), inUse: true };
      this.uploads.set(id, meta);
      try {
        await this.validate(meta, t.engine);
      } finally {
        meta.inUse = false;
      }
      this.audit(input.actor, "backups.upload_restore_uploaded", project, `Arquivo recebido para restaurar o serviço ${service}: ${formatLabel(meta.detected.format)}${meta.detected.gzip ? " (gzip)" : ""}, ${written} bytes.`);
      return { uploadId: id, sizeBytes: written, format: meta.detected.format, gzip: meta.detected.gzip, needsPassword: meta.needsPassword };
    } catch (err) {
      this.uploads.delete(id);
      await rm(file, { force: true }).catch(ignore);
      throw err;
    } finally {
      const left = this.receiving.get(projectId)! - 1;
      if (left <= 0) this.receiving.delete(projectId);
      else this.receiving.set(projectId, left);
    }
  }

  /** Lê o arquivo recebido até o fim (formato, .gz inteiro, SQL sem comandos do psql, .7z abre). */
  private async validate(meta: UploadMeta, engine: BackupDatabaseEngine): Promise<void> {
    const { format, gzip } = meta.detected;
    if (format === "panel_backup") {
      const opened = await this.deps.backups.openUploadedArchive(meta.file, null);
      meta.needsPassword = "needsPassword" in opened;
      return;
    }
    if (format === "sql" && familyOf(engine) === "postgres") await scanPostgresSql(meta.file, gzip);
    else if (gzip) await verifyGzip(meta.file);
  }

  async cancel(projectId: string, uploadId: string, actor: string): Promise<void> {
    const project = await this.project(projectId);
    const meta = this.uploads.get(uploadId);
    if (!meta || meta.projectId !== projectId) throw httpError(404, "upload_not_found", "Esse arquivo enviado não existe mais.");
    if (meta.inUse) throw httpError(409, "upload_in_use", "A restauração com este arquivo já começou e não pode ser cancelada.");
    await this.discard(meta);
    this.audit(actor, "backups.upload_restore_cancelled", project, "Arquivo enviado descartado antes de restaurar.");
  }

  private async discard(meta: UploadMeta): Promise<void> {
    this.uploads.delete(meta.id);
    await rm(meta.file, { force: true }).catch(ignore);
    await rm(`${meta.file}.work`, { recursive: true, force: true }).catch(ignore);
  }

  // -------------------------------------------------------------------------
  // Backup do painel (.7z) enviado
  // -------------------------------------------------------------------------

  private requireUpload(projectId: string, uploadId: string): UploadMeta {
    const meta = this.uploads.get(uploadId);
    if (!meta || meta.projectId !== projectId) throw httpError(404, "upload_not_found", "Esse arquivo enviado não existe mais. Envie-o de novo.");
    return meta;
  }

  async check(projectId: string, uploadId: string, req: UploadRestoreCheckRequest): Promise<UploadRestoreCheckResponse> {
    await this.project(projectId);
    const meta = this.requireUpload(projectId, uploadId);
    if (meta.detected.format !== "panel_backup") throw httpError(400, "not_panel_backup", "Só backups do painel (.7z) precisam desta conferência.");
    if (meta.inUse) throw httpError(409, "upload_in_use", "A restauração com este arquivo já começou.");
    const t = await this.targetOf(projectId, req.service);
    meta.inUse = true;
    try {
      const opened = await this.openArchive(meta, req.password ?? null);
      const work = `${meta.file}.work`;
      await rm(work, { recursive: true, force: true });
      await this.deps.archiver.extract(meta.file, work, opened, ["manifesto.json"]).catch((err: unknown) => {
        throw httpError(400, "invalid_backup", errMessage(err));
      });
      const items = await this.matchingItems(work, t.engine);
      await rm(work, { recursive: true, force: true });
      meta.needsPassword = false;
      return { ok: true, databases: items.flatMap((i) => (i.databases ?? []).map((d) => d.name)) };
    } finally {
      meta.inUse = false;
    }
  }

  /** Senha do .7z (a guardada pelo painel ou a digitada); sem nenhuma que abra, pede a senha. */
  private async openArchive(meta: UploadMeta, given: string | null): Promise<string | null> {
    const opened = await this.deps.backups.openUploadedArchive(meta.file, given);
    if ("needsPassword" in opened) throw httpError(400, "password_required", opened.message);
    return opened.password;
  }

  private async readManifest(work: string): Promise<ManifestLite> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path.join(work, "manifesto.json"), "utf8"));
    } catch {
      throw httpError(400, "invalid_backup", "Este arquivo não é um backup do painel (manifesto ausente ou ilegível).");
    }
    const m = parsed as Partial<ManifestLite> | null;
    if (!m || !Array.isArray(m.items)) throw httpError(400, "invalid_backup", "Este arquivo não é um backup do painel (manifesto sem itens).");
    return m as ManifestLite;
  }

  private async matchingItems(work: string, engine: BackupDatabaseEngine): Promise<ManifestItemLite[]> {
    const manifest = await this.readManifest(work);
    const items = manifest.items.filter((i) => i.type === "database" && typeof i.engine === "string" && familyOf(i.engine as BackupDatabaseEngine) === familyOf(engine));
    if (items.length === 0) {
      throw httpError(400, "no_matching_database", `O backup não traz um banco ${BACKUP_ENGINE_LABELS[engine]}. Ele tem: ${[...new Set(manifest.items.filter((i) => i.type === "database").map((i) => i.engine))].join(", ") || "nenhum banco"}.`);
    }
    return items;
  }

  /** Caminho de um arquivo do manifesto, só se for um arquivo comum dentro da pasta extraída (nada de `..` nem links). */
  private async safeFile(work: string, rel: unknown): Promise<string> {
    if (typeof rel !== "string" || rel.split("/").some((p) => !SAFE_PATH_PART.test(p) || p === "..")) {
      throw new Failure("invalid_backup", "O manifesto do backup aponta para um caminho inválido.");
    }
    const abs = path.join(work, rel);
    const info = await lstat(abs).catch(ignore);
    if (!info?.isFile()) throw new Failure("invalid_backup", "Um arquivo citado no manifesto não está no backup.");
    const real = await realpath(abs);
    if (!real.startsWith((await realpath(work)) + path.sep)) throw new Failure("invalid_backup", "O manifesto do backup aponta para um caminho inválido.");
    return abs;
  }

  // -------------------------------------------------------------------------
  // Começar (depois da reautenticação)
  // -------------------------------------------------------------------------

  /**
   * Confere TUDO que o pedido pode errar antes de a rota pedir a senha (um código do 2FA é de uso único e não deve ser
   * gasto à toa).
   */
  async plan(projectId: string, req: UploadRestoreStartRequest): Promise<Plan> {
    const project = await this.project(projectId);
    if (req.confirm.trim().toLowerCase() !== project.name.trim().toLowerCase()) {
      throw httpError(400, "confirm_mismatch", `Para confirmar, digite exatamente: ${project.name}`);
    }
    const meta = this.requireUpload(projectId, req.uploadId);
    if (meta.inUse || this.running.has(projectId)) throw httpError(409, "upload_busy", "Já há uma restauração por arquivo neste projeto.");
    const targets = await this.deps.backups.databaseServices(projectId);
    const t = targets.find((x) => x.service === req.service);
    if (!t) throw httpError(400, "unknown_service", "Esse serviço não é um banco deste projeto.");
    if (!t.running || !t.containerId) throw httpError(409, "database_stopped", "O banco está parado. Ligue o projeto e tente de novo.");
    assertFormatFitsEngine(t.engine, meta.detected);
    if (meta.needsPassword && !req.backupPassword) throw httpError(400, "password_required", "Este backup está cifrado: digite a senha dele.");
    let database: string | null = null;
    const family = familyOf(t.engine);
    if (family === "postgres" || family === "mysql") {
      const wanted = req.database ?? t.databaseName ?? null;
      if (wanted !== null && !DB_NAME.test(wanted)) throw httpError(400, "invalid_database", "Nome de banco inválido.");
      if (wanted !== null) {
        const known = await this.listDatabases(t);
        if (known.length > 0 && !known.includes(wanted)) throw httpError(400, "unknown_database", `O banco "${wanted}" não existe nesse serviço.`);
      }
      if (family === "postgres" && wanted === null) throw httpError(400, "database_required", "Escolha o banco de destino.");
      database = wanted;
    }
    return {
      project,
      meta,
      target: { service: t.service, engine: t.engine, containerId: t.containerId },
      database,
      clean: req.clean === true,
      backup: req.backup,
      backupPassword: req.backupPassword ?? null,
      dbServices: new Set(targets.map((x) => x.service)),
    };
  }

  async begin(plan: Plan, actor: string): Promise<UploadRestoreJob> {
    const { project, meta } = plan;
    if (this.running.has(project.id) || meta.inUse) throw httpError(409, "upload_busy", "Já há uma restauração por arquivo neste projeto.");
    this.running.add(project.id);
    meta.inUse = true;
    const job: UploadRestoreJob = {
      id: randomBytes(6).toString("hex"),
      projectId: project.id,
      service: plan.target.service,
      engine: plan.target.engine,
      format: meta.detected.format,
      sizeBytes: meta.sizeBytes,
      clean: plan.clean,
      backup: plan.backup,
      status: "validating",
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: null,
      backupFileName: null,
      output: null,
      error: null,
    };
    this.jobs.set(project.id, [job, ...(this.jobs.get(project.id) ?? [])].slice(0, JOBS_KEPT));
    await this.audit(
      actor,
      "backups.upload_restore",
      project,
      `Restauração por arquivo pedida: serviço ${plan.target.service} (${BACKUP_ENGINE_LABELS[plan.target.engine]}), ${formatLabel(meta.detected.format)}${meta.detected.gzip ? " (gzip)" : ""}, ${meta.sizeBytes} bytes. Backup antes: ${plan.backup === "full" ? "completo" : "não"}. Limpar antes: ${plan.clean ? "sim" : "não"}.`,
    );
    const work = this.execute(job, plan, actor);
    this.background.add(work);
    void work.finally(() => this.background.delete(work));
    return structuredClone(job);
  }

  job(projectId: string, jobId: string): UploadRestoreJob {
    const job = this.jobs.get(projectId)?.find((j) => j.id === jobId);
    if (!job) throw httpError(404, "job_not_found", "Trabalho não encontrado (a lista é zerada quando o painel reinicia).");
    return structuredClone(job);
  }

  /** Espera os trabalhos em curso (testes e desligamento). */
  async settled(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  // -------------------------------------------------------------------------
  // Execução
  // -------------------------------------------------------------------------

  private async execute(job: UploadRestoreJob, plan: Plan, actor: string): Promise<void> {
    const { project, meta } = plan;
    let release: (() => void) | undefined;
    let endMaintenance: (() => void) | undefined;
    const stopped: string[] = [];
    try {
      const dump = await this.prepareDump(plan);
      if (plan.backup === "full") {
        job.status = "waiting_backup";
        job.backupFileName = await this.backupFirst(project, actor);
      }
      job.status = "restoring";
      endMaintenance = this.deps.projects.maintenance?.(project.slug);
      try {
        release = await this.deps.projects.hold?.(project.id, "Restauração de arquivo em andamento");
      } catch (err) {
        throw new Failure("project_busy", `${errMessage(err)} Nada foi alterado.`);
      }
      const containers = await this.deps.docker.projectContainers(project.slug);
      for (const c of containers) {
        if (c.running && !plan.dbServices.has(c.service)) {
          await this.deps.docker.stop(c.id);
          stopped.push(c.id);
        }
      }
      job.output = await this.run(plan, dump);
      await this.audit(actor, "backups.upload_restore_done", project, "Concluído.");
      job.status = "success";
    } catch (err) {
      // Failure e os erros com código (httpError, UploadFormatError) levam a mensagem pronta; o resto é falha genérica.
      const code = (err as Partial<HttpError>).code;
      const f =
        err instanceof Failure ? err : typeof code === "string" ? new Failure(code, errMessage(err)) : new Failure("restore_failed", `A restauração falhou: ${errMessage(err)}`);
      job.error = { code: f.code, message: f.message };
      if (f.output) job.output = tail(f.output);
      job.status = "failed";
      await this.audit(actor, "backups.upload_restore_failed", project, `Falhou (${f.code}).`);
    } finally {
      for (const id of stopped) await this.deps.docker.start(id).catch(ignore);
      release?.();
      endMaintenance?.();
      job.finishedAt = new Date(this.now()).toISOString();
      await this.discard(meta);
      this.running.delete(project.id);
    }
  }

  /** O arquivo que vai para a entrada do cliente do banco: o enviado ou, num backup do painel, o dump de dentro dele. */
  private async prepareDump(plan: Plan): Promise<{ file: string; format: DetectedFormat["format"]; gzip: boolean }> {
    const { meta, target } = plan;
    if (meta.detected.format !== "panel_backup") return { file: meta.file, format: meta.detected.format, gzip: meta.detected.gzip };
    const free = await this.free();
    const need = meta.sizeBytes * 3 + DISK_RESERVE;
    if (free !== null && free < need) {
      throw new Failure("no_space", `Não há espaço para abrir o backup: precisa de cerca de ${formatBytes(need)} livres e há ${formatBytes(free)}. O banco não foi alterado.`);
    }
    const work = `${meta.file}.work`;
    await rm(work, { recursive: true, force: true });
    const password = await this.openArchive(meta, plan.backupPassword);
    await this.deps.archiver.extract(meta.file, work, password, ["manifesto.json", "bancos"]).catch((err: unknown) => {
      throw new Failure("invalid_backup", `Não foi possível abrir o backup: ${errMessage(err)}`);
    });
    const items = await this.matchingItems(work, target.engine);
    const item = items.length === 1 ? items[0]! : items.find((i) => i.service === target.service);
    if (!item) throw new Failure("ambiguous_backup", `O backup tem mais de um banco ${BACKUP_ENGINE_LABELS[target.engine]} (${items.map((i) => i.service).join(", ")}) e nenhum se chama ${target.service}.`);
    let rel: unknown = item.file;
    if (item.databases) {
      const dbs = item.databases;
      const one = dbs.find((d) => d.name === plan.database) ?? (dbs.length === 1 ? dbs[0] : undefined);
      if (!one) throw new Failure("ambiguous_backup", `O backup tem os bancos ${dbs.map((d) => d.name).join(", ")}; nenhum se chama ${plan.database}. Escolha como destino um banco com o mesmo nome de um deles.`);
      rel = one.file;
    }
    const file = await this.safeFile(work, rel);
    const head = Buffer.alloc(FORMAT_HEAD_BYTES);
    const fh = await open(file, "r");
    let read: number;
    try {
      read = (await fh.read(head, 0, FORMAT_HEAD_BYTES, 0)).bytesRead;
    } finally {
      await fh.close();
    }
    const detected = detectFormat(head.subarray(0, read));
    assertFormatFitsEngine(target.engine, detected);
    if (detected.format === "panel_backup") throw new UploadFormatError("not_a_dump", "O arquivo de dentro do backup não é um dump.");
    if (detected.format === "sql" && familyOf(target.engine) === "postgres") await scanPostgresSql(file, detected.gzip);
    return { file, format: detected.format, gzip: detected.gzip };
  }

  /** Backup completo do projeto pela mesma fila da aba Backups; só segue se terminou sem falha nem aviso. */
  private async backupFirst(project: Project, actor: string): Promise<string> {
    let record: BackupRecord;
    try {
      record = await this.deps.backups.runNow(`project:${project.id}`, actor);
    } catch (err) {
      throw new Failure("backup_failed", `O backup antes da restauração não pôde começar: ${errMessage(err)} Nada foi alterado.`);
    }
    const queued = record;
    const deadline = this.now() + (this.deps.backupWaitMs ?? BACKUP_WAIT_MS);
    while (record.status === "queued" || record.status === "running") {
      if (this.now() > deadline) throw new Failure("backup_timeout", "O backup antes da restauração passou de 30 minutos. Nada foi alterado.");
      await this.sleep(this.pollMs);
      record = await this.deps.backups.record(queued.id);
    }
    if (record.status !== "success" || !record.fileName) {
      const why = record.status === "failed" ? (record.error ?? "falhou") : (record.warnings[0] ?? "terminou com avisos");
      throw new Failure("backup_failed", `O backup antes da restauração não terminou bem (${why.slice(0, 300)}). Nada foi alterado.`);
    }
    return record.fileName;
  }

  private async run(plan: Plan, dump: { file: string; format: DetectedFormat["format"]; gzip: boolean }): Promise<string> {
    const { target, database, clean } = plan;
    const gz = dump.gzip ? "gz" : "raw";
    const family = familyOf(target.engine);
    let script: string;
    let args: string[];
    if (family === "postgres") {
      script = dump.format === "pg_custom" ? PG_CUSTOM_SCRIPT : PG_SQL_SCRIPT;
      args = dump.format === "pg_custom" ? [database!, gz, clean ? "clean" : "keep"] : [database!, gz];
    } else if (family === "mysql") {
      script = MYSQL_SCRIPT;
      args = [database ?? "", gz];
    } else {
      script = MONGO_SCRIPT;
      args = [gz, clean ? "clean" : "keep"];
    }
    let out: { stderr: string; stdout?: string };
    try {
      out = await this.deps.docker.execFromFile(target.containerId, script, args, dump.file, { timeoutMs: this.deps.restoreTimeoutMs ?? RESTORE_TIMEOUT_MS });
    } catch (err) {
      throw new Failure("restore_failed", `A restauração falhou: ${errMessage(err)}${family === "postgres" ? " O PostgreSQL desfez tudo: o banco continua como estava." : ""}`);
    }
    const output = tail(`${out.stdout ?? ""}${out.stderr}`.trim());
    if (family === "mongo") {
      const failed = mongoRestoreFailure(out.stderr);
      if (failed) throw new Failure("restore_failed", `${failed} O MongoDB pode ter ficado com a restauração pela metade.`, output);
    }
    return output;
  }

  // -------------------------------------------------------------------------
  // Limpeza
  // -------------------------------------------------------------------------

  /** Apaga o que sobrou na pasta de envios (mais velho que `maxAgeMs`) e que nenhum envio ou trabalho em curso usa. */
  async sweep(maxAgeMs = this.staleMs): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return 0;
    }
    const busy = new Set([...this.uploads.values()].filter((u) => u.inUse).map((u) => u.id));
    let removed = 0;
    for (const name of names) {
      const id = name.replace(/\.work$/, "");
      if (busy.has(id)) continue;
      const info = await stat(path.join(this.dir, name)).catch(ignore);
      if (!info || this.now() - info.mtimeMs < maxAgeMs) continue;
      this.uploads.delete(id);
      await rm(path.join(this.dir, name), { recursive: true, force: true }).catch(ignore);
      removed++;
    }
    return removed;
  }

  /** Limpa tudo o que ficou de antes (partida do painel: a memória dos envios se foi, então eles não servem mais) e repete a cada hora. */
  start(intervalMs = 60 * 60_000): void {
    void this.sweep(0).catch((err: unknown) => this.deps.log?.(`Envios de restauração: limpeza da partida falhou (${errMessage(err)}).`));
    this.timer = setInterval(() => void this.sweep().catch(ignore), intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.settled();
  }

  private audit(actor: string, action: string, project: Project, detail: string): Promise<unknown> {
    return this.deps.audit.record({ actor, action, target: project.slug, detail }).catch(ignore);
  }
}

interface ManifestItemLite {
  type?: string;
  service?: string;
  engine?: string;
  file?: string;
  databases?: Array<{ name: string; file: string }>;
}

interface ManifestLite {
  items: ManifestItemLite[];
}
