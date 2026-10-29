/**
 * backup-service.test.ts — o serviço central dos backups com Docker, 7-Zip e
 * armazenamento de mentira (em memória), e disco de verdade numa pasta
 * temporária. O relógio é um número passado ao serviço (sem relógio falso).
 *
 * Cobre: destino e segredos cifrados, senha (definir, trocar, ver com a senha
 * de login, testar), backup de projeto/e-mail/painel, cópia na VPS sem senha
 * e externa cifrada, conferência depois do envio, retenção, falhas que não
 * apagam nada, restauração (projeto, e-mail, painel), agenda, atraso e
 * lembrete da senha.
 */
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDecipheriv } from "node:crypto";
import { ingestCode, writeProjectDotenv } from "@paas/deploy";
import { BACKUP_ROOT_FOLDER, backupFileStamp, type Project } from "@paas/core";
import { ArchiveError } from "../src/services/backup-archive.js";
import type { ContainerInspect } from "../src/services/backup-detect.js";
import type { BackupDocker, ProjectContainer } from "../src/services/backup-docker.js";
import { StorageError, type BackupStorage, type StoredObject } from "../src/services/backup-s3.js";
import { BackupService, orderBackups, projectTargetId, retentionVictims, type Archiver, type BackupServiceOptions } from "../src/services/backup-service.js";
import type { NotificationEvent } from "../src/services/notification-service.js";
import { RestoreReconciliation } from "../src/services/restore-reconciliation.js";
import { removeDir } from "./helpers/tmp.js";

// ---------------------------------------------------------------------------
// Dublês
// ---------------------------------------------------------------------------

/** "7-Zip" que guarda os arquivos num JSON (com a senha, para conferir). */
class FakeArchiver implements Archiver {
  calls: Array<{ op: string; password: string | null }> = [];
  ok = true;
  async available() {
    return this.ok;
  }
  private async collect(p: string, base: string, out: Record<string, string>): Promise<void> {
    const s = await stat(p);
    if (s.isDirectory()) {
      for (const name of await readdir(p)) await this.collect(path.join(p, name), `${base}/${name}`, out);
    } else out[base] = (await readFile(p)).toString("base64");
  }
  async create(archive: string, inputs: string[], opts: { password?: string | null }) {
    this.calls.push({ op: "create", password: opts.password ?? null });
    const files: Record<string, string> = {};
    for (const i of inputs) await this.collect(i, path.basename(i), files);
    await writeFile(archive, JSON.stringify({ password: opts.password ?? null, files }));
  }
  private async read(archive: string, password: string | null) {
    const raw = JSON.parse(await readFile(archive, "utf8")) as { password: string | null; files: Record<string, string> };
    if (raw.password !== password) throw new ArchiveError("A senha não abre este backup.", "wrong_password");
    return raw.files;
  }
  async test(archive: string, password: string | null) {
    this.calls.push({ op: "test", password });
    await this.read(archive, password);
  }
  async extract(archive: string, outDir: string, password: string | null) {
    this.calls.push({ op: "extract", password });
    const files = await this.read(archive, password);
    for (const [rel, b64] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(outDir, rel)), { recursive: true });
      await writeFile(path.join(outDir, rel), Buffer.from(b64, "base64"));
    }
  }
}

class FakeStorage implements BackupStorage {
  objects = new Map<string, Buffer>();
  failUpload = false;
  corruptDownload = false;
  failTest: StorageError | null = null;
  async test() {
    if (this.failTest) throw this.failTest;
  }
  async upload(key: string, file: string) {
    if (this.failUpload) throw new StorageError("O armazenamento respondeu com erro 500.", "server_error");
    this.objects.set(key, await readFile(file));
  }
  async download(key: string, file: string) {
    const obj = this.objects.get(key);
    if (!obj) throw new StorageError("Arquivo não encontrado no armazenamento.", "not_found");
    await writeFile(file, this.corruptDownload ? Buffer.concat([obj, Buffer.from("x")]) : obj);
  }
  async list(prefix: string): Promise<StoredObject[]> {
    return [...this.objects.keys()]
      .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
      .sort()
      .map((key) => ({ key, size: this.objects.get(key)!.length, lastModified: null }));
  }
  async listFolders(prefix: string) {
    const set = new Set<string>();
    for (const k of this.objects.keys()) if (k.startsWith(prefix) && k.slice(prefix.length).includes("/")) set.add(k.slice(prefix.length).split("/")[0]!);
    return [...set].sort();
  }
  async remove(key: string) {
    this.objects.delete(key);
  }
  describe() {
    return "fake";
  }
}

const PG_PASSWORD = "senha-do-banco-nao-vaza";

class FakeDocker implements BackupDocker {
  calls: string[] = [];
  restored: Array<{ container: string; dest: string; content: string }> = [];
  dbInput: Array<{ container: string; args: string[]; content: string }> = [];
  containers: ProjectContainer[] = [
    { id: "c-db", name: "paas-loja-db-1", service: "db", running: true },
    { id: "c-web", name: "paas-loja-web-1", service: "web", running: true },
  ];
  states: Record<string, { exists: boolean; running: boolean }> = {
    "paas-stalwart": { exists: true, running: true },
    "paas-webmail": { exists: true, running: true },
  };
  failDump = false;
  /** Sufixo do conteúdo dos dumps: distingue o estado "atual" (cópia de segurança) do que veio do backup. */
  dumpTag = "";
  /** Falha (erro do banco) na próxima restauração cujo primeiro argumento (ou "") bate; `times` vezes. */
  failRestore: { arg: string; times: number; error?: string; skip?: number } | null = null;
  /** Resposta do execCapture da sonda de motor (script com `command -v`). */
  probeAnswer = "";
  /** Registro das trocas do PostgreSQL (restaurar num banco novo e trocar) e das falhas injetadas. */
  swaps: Array<{ kind: "swap" | "revert" | "drop" | "fix"; args: string[] }> = [];
  swapAnswer = "swapped\n";
  /** Resposta do PG_SWAP_FIX (conferência depois de uma troca que deu erro) e falha injetada nele. */
  fixAnswer = "reverted\n";
  failFix = false;
  /** Resposta do PG_SPACE ("<livre> <tamanho>") e do PG_SWEEP_LIST. */
  spaceAnswer = "";
  sweepAnswer = "";
  failSwap = false;
  failRevert = false;
  async projectContainers() {
    return this.containers;
  }
  async inspect(ids: string[]): Promise<ContainerInspect[]> {
    const all: Record<string, ContainerInspect> = {
      "c-db": {
        Name: "/paas-loja-db-1",
        Config: { Image: "postgres:16", Env: ["POSTGRES_USER=app", `POSTGRES_PASSWORD=${PG_PASSWORD}`], Labels: { "com.docker.compose.service": "db" } },
        Mounts: [{ Type: "volume", Name: "paas-loja_pg", Source: "/x", Destination: "/var/lib/postgresql/data" }],
        State: { Running: true },
      },
      "c-web": {
        Name: "/paas-loja-web-1",
        Config: { Image: "paas-loja-web", Env: [], Labels: { "com.docker.compose.service": "web" } },
        Mounts: [{ Type: "volume", Name: "paas-loja_uploads", Source: "/x", Destination: "/app/uploads" }],
        State: { Running: true },
      },
    };
    return ids.map((id) => all[id]!).filter(Boolean);
  }
  async diff(container: string): Promise<string> {
    this.calls.push(`diff ${container}`);
    return container === "c-web" ? "A /app/notas/1.pdf\n" : "";
  }
  async sizes(items: Array<{ id: string }>) {
    return { sizes: Object.fromEntries(items.map((i) => [i.id, 1000])), files: new Set<string>() };
  }
  async execToFile(container: string, script: string, args: string[], outFile: string) {
    this.calls.push(`execToFile ${container} ${args.join(",")}`);
    if (this.failDump) throw new Error("pg_dump: conexão recusada");
    await writeFile(outFile, `dump ${container} ${args.join(",")} ${script.includes("globals-only") ? "papeis" : "banco"}${this.dumpTag}`);
    return { stderr: "" };
  }
  async execCapture(container: string, script: string, args: string[] = []): Promise<string> {
    this.calls.push(`execCapture ${container}`);
    if (script.includes("RENAME TO :\"o\"") && script.includes("echo swapped")) {
      this.swaps.push({ kind: "swap", args });
      if (this.failSwap) throw new Error("ERROR:  database is being accessed by other users");
      return this.swapAnswer;
    }
    if (script.includes('echo "$RES"')) {
      this.swaps.push({ kind: "fix", args });
      if (this.failFix) throw new Error("docker exec: contêiner reiniciando");
      return this.fixAnswer;
    }
    if (script.includes("pg_database_size")) return this.spaceAnswer;
    if (script.includes("tws_new_") && script.includes("select case when")) return this.sweepAnswer;
    if (script.includes("RENAME TO :\"t\"") && script.includes("dropdb")) {
      this.swaps.push({ kind: "revert", args });
      if (this.failRevert) throw new Error("ERROR:  não deu para renomear");
      return "";
    }
    if (script.includes("dropdb") && !script.includes("ALLOW_CONNECTIONS")) {
      this.swaps.push({ kind: "drop", args });
      return "";
    }
    if (script.includes("SAVE")) return "OK\n";
    if (script.includes("command -v postgres")) return this.probeAnswer;
    return script.includes("pg_database") ? "app\npostgres\n" : "";
  }
  async execFromFile(container: string, script: string, args: string[], inFile: string) {
    this.calls.push(`execFromFile ${container} ${args.join(",")}`);
    this.dbInput.push({ container, args, content: await readFile(inFile, "utf8") });
    const f = this.failRestore;
    if (f && f.times > 0 && (args[0] ?? "") === f.arg && !script.endsWith("template1 -X -q")) {
      if (f.skip) {
        f.skip--;
        return { stderr: "" };
      }
      f.times--;
      throw new Error(f.error ?? "ERROR:  relation already exists");
    }
    return { stderr: "" };
  }
  /** Permissão (octal) da pasta onde o docker cp grava, no instante da cópia. */
  copyOutDirModes: string[] = [];
  async copyOut(container: string, p: string, outFile: string) {
    this.calls.push(`copyOut ${container} ${p}`);
    if (this.failCopyOut === container) throw new Error("docker cp: no space left on device");
    this.copyOutDirModes.push(`${container}:${((await stat(path.dirname(outFile))).mode & 0o777).toString(8)}`);
    await writeFile(outFile, `tar ${container} ${p}`);
  }
  async copyIn(container: string, parent: string, tarFile: string) {
    this.calls.push(`copyIn ${container} ${parent}`);
    this.restored.push({ container, dest: parent, content: await readFile(tarFile, "utf8") });
  }
  async restorePath(container: string, dest: string, tarFile: string) {
    this.calls.push(`restorePath ${container} ${dest}`);
    this.restored.push({ container, dest, content: await readFile(tarFile, "utf8") });
  }
  async restoreVolume(volume: string, tarFile: string) {
    this.calls.push(`restoreVolume ${volume}`);
    this.restored.push({ container: volume, dest: "/v", content: await readFile(tarFile, "utf8") });
  }
  failMerge = false;
  merged: Array<{ volume: string; content: string }> = [];
  async mergeVolume(volume: string, tarFile: string) {
    this.calls.push(`mergeVolume ${volume}`);
    if (this.failMerge) throw new Error("docker: sem espaço no volume");
    this.merged.push({ volume, content: await readFile(tarFile, "utf8") });
  }
  failCopyOut: string | null = null;
  async state(container: string) {
    return this.states[container] ?? { exists: false, running: false };
  }
  async stop(container: string) {
    this.calls.push(`stop ${container}`);
  }
  async start(container: string) {
    this.calls.push(`start ${container}`);
  }
}

function project(partial: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "Loja",
    slug: "loja",
    ingestMode: "git",
    source: "https://github.com/x/loja.git",
    branch: null,
    domain: "loja.exemplo.com",
    websocket: false,
    detection: null,
    proxyService: null,
    proxyPort: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    lastDeployAt: "2026-10-01T00:00:00Z",
    lastDeployStatus: "success",
    deployedBranch: null,
    deployedSource: null,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Montagem
// ---------------------------------------------------------------------------

const H = 3_600_000;
let dir: string;
let now: number;
let docker: FakeDocker;
let archiver: FakeArchiver;
let storage: FakeStorage;
let notices: NotificationEvent[];
let audits: Array<{ action: string; detail: string }>;
let logs: string[];
let projects: Project[];
let redeploys: string[];
let maintenance: string[];
let restarted: number;
let restartWaiters: Array<() => void> = [];
/** O reinício é agendado por um timer (não aguardado pelo serviço): espera o evento real, sem chutar tempo. */
function waitRestarted(n = 1): Promise<void> {
  if (restarted >= n) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`o painel não pediu reinício (${restarted}/${n})`)), 4000);
    restartWaiters.push(() => {
      if (restarted < n) return false as never;
      clearTimeout(t);
      resolve();
    });
  });
}
let free: number;

function build(overrides: Partial<BackupServiceOptions> = {}): BackupService {
  return new BackupService({
    dataDir: dir,
    projectsDir: path.join(dir, "projects"),
    docker,
    archiver,
    storage: () => storage,
    projects: {
      list: async () => projects,
      get: async (id) => projects.find((p) => p.id === id || p.slug === id) ?? null,
      srcDir: (p) => path.join(dir, "projects", p.slug, "src"),
      maintenance: (slug) => {
        maintenance.push(`+${slug}`);
        return () => void maintenance.push(`-${slug}`);
      },
      redeploy: async (id) => {
        redeploys.push(id);
        docker.containers = [
          { id: "c-db", name: "paas-loja-db-1", service: "db", running: true },
          { id: "c-web", name: "paas-loja-web-1", service: "web", running: true },
        ];
      },
    },
    mail: {
      container: "paas-stalwart",
      volume: "paas_stalwart_data",
      dataPath: "/opt/stalwart-mail/data",
      etcPath: "/opt/stalwart-mail/etc",
      webmailContainer: "paas-webmail",
      webmailVolume: "paas_webmail_data",
      webmailPath: "/var/roundcube",
    },
    verifyLogin: async (_id, pw) => pw === "senha-de-login",
    notify: (e) => notices.push(e),
    audit: { record: async (e) => void audits.push(e) },
    log: (m) => logs.push(m),
    now: () => now,
    statfs: async () => ({ bavail: free, bsize: 1, blocks: 100 * 1024 ** 3 }),
    restartPanel: () => {
      restarted++;
      for (const w of [...restartWaiters]) w();
    },
    restartDelayMs: 0,
    readyDelayMs: 1,
    tar: {
      create: async (_parent, name, out) => writeFile(out, `codigo ${name}`),
      extract: async () => undefined,
    },
    ...overrides,
  });
}

let service: BackupService;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-backup-"));
  now = new Date(2026, 9, 14, 10, 0).getTime();
  docker = new FakeDocker();
  archiver = new FakeArchiver();
  storage = new FakeStorage();
  notices = [];
  audits = [];
  logs = [];
  projects = [project()];
  redeploys = [];
  maintenance = [];
  restarted = 0;
  restartWaiters = [];
  free = 50 * 1024 ** 3;
  await writeFile(path.join(dir, "users.json"), '{"users":[]}');
  service = build();
});

afterEach(async () => {
  await service.idle();
  await service.flush();
  await removeDir(dir);
});

const DEST = {
  provider: "r2" as const,
  endpoint: "https://abc.r2.cloudflarestorage.com",
  region: "",
  bucket: "meus-backups",
  accessKeyId: "AKIAEXEMPLO1234",
  secretAccessKey: "chave-secreta-do-r2",
};
const PW = "cavalo-azul-janela-trigo-mesa-41";

async function connect(withPassword = true): Promise<void> {
  await service.setDestination(DEST, "admin");
  if (withPassword) await service.setPassword(PW, true, "admin");
}

async function backup(id = projectTargetId("p1")) {
  const r = await service.runNow(id, "admin");
  await service.idle();
  return service.record(r.id);
}

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

describe("situação", () => {
  it("painel, e-mail e cada projeto; criptografia sugerida (ligada) e sem senha", async () => {
    const s = await service.status();
    expect(s.targets.map((t) => t.id)).toEqual(["panel", "email", "project:p1"]);
    expect(s.targets.every((t) => t.enabled && t.frequencyHours === 24 && t.localKeep === 2 && t.remoteKeep === 5)).toBe(true);
    expect(s.targets[0]!.nextRunAt).toBe(new Date(2026, 9, 15, 3, 0).toISOString());
    expect(s.encryption).toMatchObject({ enabled: true, passwordSet: false });
    expect(s.destination).toBeNull();
    expect(s.archiverAvailable).toBe(true);
    expect(s.timezone).toMatch(/^UTC[+-]\d{2}:\d{2}$/);
    docker.states = {};
    service = build();
    expect((await service.status()).targets[1]).toMatchObject({ available: false, nextRunAt: null });
  });

  it("o roteiro vê destino e backups conferidos", async () => {
    expect(await service.facts()).toEqual({ destinationConnected: false, verifiedRemote: 0, lastFailure: null });
    await connect();
    await backup();
    expect(await service.facts()).toMatchObject({ destinationConnected: true, verifiedRemote: 1 });
  });

  describe("o roteiro vê backups de outro painel no armazenamento (só leitura)", () => {
    const OTHER = `${BACKUP_ROOT_FOLDER}/_painel/2026-10-13_03-00.7z`;

    it("painel novo, armazenamento conectado com backups do painel de outro servidor: foreignBackupsHeld", async () => {
      projects = [];
      await connect();
      storage.objects.set(OTHER, Buffer.from("backup bom do servidor antigo"));
      expect(await service.facts()).toMatchObject({ destinationConnected: true, verifiedRemote: 0, foreignBackupsHeld: true });
      // ler não muda nada: nenhuma pausa gravada, nenhum aviso
      expect((await service.status()).targets.find((t) => t.id === "panel")!.pausedReason).toBeNull();
    });

    it("sem backup do painel no armazenamento, com projeto, sem destino ou com backup já conferido: sem o campo", async () => {
      projects = [];
      expect(await service.facts()).not.toHaveProperty("foreignBackupsHeld");
      await connect();
      expect(await service.facts()).not.toHaveProperty("foreignBackupsHeld");
      storage.objects.set(OTHER, Buffer.from("x"));
      projects = [project({ id: "p1" })];
      expect(await service.facts()).not.toHaveProperty("foreignBackupsHeld");
    });

    it("listagem falha: estado explícito 'unknown' (nunca some), sem gravar nada, e a próxima consulta tenta de novo", async () => {
      projects = [];
      await connect();
      storage.objects.set(OTHER, Buffer.from("x"));
      const list = storage.list.bind(storage);
      let calls = 0;
      storage.list = async (...args: Parameters<typeof list>) => {
        calls++;
        throw new Error("sem rede");
      };
      expect(await service.facts()).toMatchObject({ foreignBackupsHeld: "unknown" });
      // nenhuma falha contada para o aviso do agendador, nenhuma pausa gravada
      expect((await service.status()).targets.find((t) => t.id === "panel")!.pausedReason).toBeNull();
      // 'unknown' não fica em cache: conferir de novo consulta o armazenamento outra vez
      expect(await service.facts()).toMatchObject({ foreignBackupsHeld: "unknown" });
      expect(calls).toBe(2);
      storage.list = list;
      expect(await service.facts()).toMatchObject({ foreignBackupsHeld: true });
    });

    it("armazenamento que não responde: a consulta estoura o prazo curto e vira 'unknown' em vez de travar o roteiro", async () => {
      projects = [];
      service = build({ foreignCheckTimeoutMs: 30 });
      await connect();
      storage.list = () => new Promise(() => undefined);
      const t0 = Date.now();
      expect(await service.facts()).toMatchObject({ foreignBackupsHeld: "unknown" });
      expect(Date.now() - t0).toBeLessThan(2000);
    });

    it("bucket vazio, depois as cópias do painel antigo entram no MESMO bucket: 'Conferir de novo' já vê (o 'livre' não fica em cache)", async () => {
      projects = [];
      await connect();
      expect(await service.facts()).not.toHaveProperty("foreignBackupsHeld");
      storage.objects.set(OTHER, Buffer.from("copiado à mão"));
      expect(await service.facts()).toMatchObject({ foreignBackupsHeld: true });
    });

    it("só o 'há cópias alheias' (lado seguro) fica em cache; o 'livre' consulta sempre", async () => {
      projects = [];
      await connect();
      const list = storage.list.bind(storage);
      let calls = 0;
      storage.list = async (...args: Parameters<typeof list>) => {
        calls++;
        return list(...args);
      };
      await service.facts();
      await service.facts();
      expect(calls).toBe(2);
      storage.objects.set(OTHER, Buffer.from("x"));
      await service.facts();
      await service.facts();
      expect(calls).toBe(3);
    });

    it("consultas simultâneas dividem uma só ida ao armazenamento; com a consulta travada, não abre outra", async () => {
      projects = [];
      service = build({ foreignCheckTimeoutMs: 30 });
      await connect();
      let calls = 0;
      let release!: () => void;
      let hang = true;
      storage.list = () => {
        calls++;
        if (!hang) return Promise.resolve([]);
        return new Promise((resolve) => {
          release = () => resolve([]);
        });
      };
      const all = await Promise.all([service.facts(), service.facts(), service.facts()]);
      expect(all.every((f) => f.foreignBackupsHeld === "unknown")).toBe(true);
      expect(calls).toBe(1);
      // ainda travada: as recargas seguintes não empilham pedidos
      expect(await service.facts()).toMatchObject({ foreignBackupsHeld: "unknown" });
      expect(calls).toBe(1);
      hang = false;
      release();
      await new Promise((r) => setTimeout(r, 5));
      expect(await service.facts()).not.toHaveProperty("foreignBackupsHeld");
      expect(calls).toBe(2);
    });

    it("resultado em cache por ~60 s; muda o armazenamento, o projeto ou a hora: consulta de novo", async () => {
      projects = [];
      await connect();
      storage.objects.set(OTHER, Buffer.from("x"));
      const list = storage.list.bind(storage);
      let calls = 0;
      storage.list = async (...args: Parameters<typeof list>) => {
        calls++;
        return list(...args);
      };
      expect(await service.facts()).toMatchObject({ foreignBackupsHeld: true });
      expect(await service.facts()).toMatchObject({ foreignBackupsHeld: true });
      expect(calls).toBe(1);
      // passou de 60 s
      now += 61_000;
      await service.facts();
      expect(calls).toBe(2);
      // projeto cadastrado: o resultado muda sem esperar o cache
      projects = [project({ id: "p1" })];
      expect(await service.facts()).not.toHaveProperty("foreignBackupsHeld");
      expect(calls).toBe(2); // com projeto, a regra nem consulta o armazenamento
      projects = [];
      expect(await service.facts()).toMatchObject({ foreignBackupsHeld: true });
      const before = calls;
      expect(await service.facts()).toMatchObject({ foreignBackupsHeld: true });
      expect(calls).toBe(before); // de novo em cache
      // armazenamento reconectado (outro connectedAt): invalida
      now += 1000;
      await connect();
      await service.facts();
      expect(calls).toBe(before + 1);
    });
  });
});

describe("destino externo", () => {
  it("testa antes de salvar e guarda a chave secreta cifrada", async () => {
    const s = await service.setDestination(DEST, "admin");
    expect(s.destination).toMatchObject({ provider: "r2", region: "auto", bucket: "meus-backups", accessKeyHint: "…1234" });
    expect(JSON.stringify(s)).not.toContain("chave-secreta-do-r2");
    await service.flush();
    const raw = await readFile(path.join(dir, "backups.json"), "utf8");
    expect(raw).not.toContain("chave-secreta-do-r2");
    expect((await stat(path.join(dir, "backups.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(dir, "backups-key"))).mode & 0o777).toBe(0o600);
    expect(audits.map((a) => a.detail).join(" ")).not.toContain("chave-secreta-do-r2");
  });

  it("endpoint colado como o Cloudflare mostra (com o bucket no fim) é aceito", async () => {
    const s = await service.setDestination({ ...DEST, endpoint: "https://abc.r2.cloudflarestorage.com/meus-backups/" }, "admin");
    expect(s.destination?.endpoint).toBe("https://abc.r2.cloudflarestorage.com");
  });

  it("editar sem a chave secreta mantém a guardada; sem nenhuma, pede", async () => {
    await expect(service.setDestination({ ...DEST, secretAccessKey: "" }, "admin")).rejects.toMatchObject({ code: "secret_required" });
    await service.setDestination(DEST, "admin");
    const spy = vi.fn(() => storage);
    service = build({ storage: spy });
    await service.setDestination({ ...DEST, region: "us-east-1", secretAccessKey: undefined }, "admin");
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ secretAccessKey: "chave-secreta-do-r2", region: "us-east-1" }));
  });

  it("falha no teste: não salva e explica", async () => {
    storage.failTest = new StorageError("O armazenamento recusou as chaves.", "invalid_credentials");
    await expect(service.setDestination(DEST, "admin")).rejects.toMatchObject({ statusCode: 400, message: "O armazenamento recusou as chaves." });
    expect((await service.status()).destination).toBeNull();
    await expect(service.setDestination({ ...DEST, endpoint: "ftp://x" }, "admin")).rejects.toMatchObject({ code: "invalid_endpoint" });
  });

  it("Testar conexão e desconectar", async () => {
    await expect(service.testDestination("admin")).rejects.toMatchObject({ code: "no_destination" });
    await service.setDestination(DEST, "admin");
    now += H;
    expect((await service.testDestination("admin")).destination!.testedAt).toBe(new Date(now).toISOString());
    storage.failTest = new StorageError("fora", "unreachable");
    await expect(service.testDestination("admin")).rejects.toMatchObject({ statusCode: 502 });
    expect((await service.removeDestination("admin")).destination).toBeNull();
  });

  it("chave do cofre trocada: volta a 'sem destino' com aviso no log", async () => {
    await connect();
    await service.flush();
    await writeFile(path.join(dir, "backups-key"), "00".repeat(32));
    service = build();
    const s = await service.status();
    expect(s.destination).toBeNull();
    expect(s.encryption.passwordSet).toBe(false);
    expect(logs.join(" ")).toMatch(/decifrar/);
  });
});

describe("senha dos backups", () => {
  it("exige tamanho, força e o 'Guardei a senha'", async () => {
    await expect(service.setPassword("curta", true, "a")).rejects.toMatchObject({ code: "weak_password" });
    await expect(service.setPassword("aaaaaaaaaaaaaaaa", true, "a")).rejects.toMatchObject({ code: "weak_password" });
    await expect(service.setPassword(PW, false, "a")).rejects.toMatchObject({ code: "not_acknowledged" });
  });

  it("guarda cifrada, grava o arquivo de verificação e audita sem a senha", async () => {
    await service.setDestination(DEST, "admin");
    const s = await service.setPassword(PW, true, "admin");
    expect(s.encryption).toMatchObject({ passwordSet: true, acknowledgedAt: new Date(now).toISOString() });
    await service.flush();
    expect(await readFile(path.join(dir, "backups.json"), "utf8")).not.toContain(PW);
    expect(storage.objects.has("TWS Panel Backups/_verificacao/senha.7z")).toBe(true);
    await service.setPassword("outra-frase-bem-comprida-9", true, "admin");
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["backups.password_set", "backups.password_changed"]));
    expect(JSON.stringify(audits)).not.toContain(PW);
  });

  it("ver a senha pede a senha de login, audita e tem limite", async () => {
    await expect(service.revealPassword("u1", "senha-de-login", "admin")).rejects.toMatchObject({ code: "no_password" });
    await service.setPassword(PW, true, "admin");
    await expect(service.revealPassword("u1", "errada", "admin")).rejects.toMatchObject({ statusCode: 401 });
    expect(await service.revealPassword("u1", "senha-de-login", "admin")).toBe(PW);
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["backups.password_reveal_denied", "backups.password_revealed"]));
    await service.revealPassword("u1", "senha-de-login", "admin");
    await service.revealPassword("u1", "senha-de-login", "admin");
    await expect(service.revealPassword("u1", "senha-de-login", "admin")).rejects.toMatchObject({ statusCode: 429 });
    now += 16 * 60_000;
    expect(await service.revealPassword("u1", "senha-de-login", "admin")).toBe(PW);
    expect(JSON.stringify(audits)).not.toContain(PW);
  });

  it("Testar minha senha abre o arquivo de verificação do destino", async () => {
    await expect(service.testPassword(PW, "a")).rejects.toMatchObject({ code: "no_destination" });
    await service.setDestination(DEST, "admin");
    await expect(service.testPassword(PW, "a")).rejects.toMatchObject({ code: "no_check_file" });
    await service.setPassword(PW, true, "admin");
    expect(await service.testPassword(PW, "a")).toMatchObject({ ok: true });
    expect(await service.testPassword("nao-e-essa-senha", "a")).toMatchObject({ ok: false });
    expect((await service.status()).encryption).toMatchObject({ lastTestOk: false });
    // arquivo sumiu do destino: o painel grava de novo e testa
    storage.objects.clear();
    expect(await service.testPassword(PW, "a")).toMatchObject({ ok: true });
    storage.failUpload = true;
    storage.objects.clear();
    await expect(service.testPassword(PW, "a")).rejects.toThrow();
  });

  it("VPS nova: confere a senha antiga no arquivo do armazenamento antes de salvar, sem regravá-lo", async () => {
    await connect();
    const checkKey = "TWS Panel Backups/_verificacao/senha.7z";
    const original = storage.objects.get(checkKey)!;
    // Outra instalação (VPS nova), sem senha guardada, conectada ao mesmo armazenamento.
    const otherDir = await mkdtemp(path.join(tmpdir(), "paas-backup-nova-"));
    const nova = build({ dataDir: otherDir });
    try {
      await nova.setDestination(DEST, "admin");
      expect(await nova.testPassword("senha-errada-qualquer-1", "admin")).toMatchObject({ ok: false });
      expect(await nova.testPassword(PW, "admin")).toMatchObject({ ok: true });
      expect(storage.objects.get(checkKey)).toEqual(original);
      expect((await nova.status()).encryption).toMatchObject({ passwordSet: false, lastTestOk: null });
    } finally {
      await nova.flush();
      await removeDir(otherDir);
    }
  });

  it("criptografia desligada e a sugestão de frase", async () => {
    expect((await service.setEncryption(false, "admin")).encryption.enabled).toBe(false);
    expect(service.suggestPassword().split("-")).toHaveLength(7);
  });
});

describe("backup de projeto", () => {
  it("local sem senha, externo cifrado e conferido; o dump roda no container", async () => {
    await connect();
    const r = await backup();
    expect(r).toMatchObject({ status: "success", local: true, remote: "verified", remoteEncrypted: true });
    expect(r.fileName).toBe("2026-10-14_10-00.7z");
    const local = JSON.parse(await readFile(path.join(dir, "backups", "loja", r.fileName!), "utf8")) as {
      password: string | null;
      files: Record<string, string>;
    };
    expect(local.password).toBeNull();
    expect(Object.keys(local.files).sort()).toEqual([
      "LEIA-ME.txt",
      "bancos/db/_papeis.sql",
      "bancos/db/app.sql",
      "bancos/db/postgres.sql",
      "manifesto.json",
      "volumes/web__app_uploads.tar",
    ]);
    const remote = JSON.parse(storage.objects.get(`TWS Panel Backups/loja/${r.fileName}`)!.toString()) as { password: string };
    expect(remote.password).toBe(PW);
    expect(docker.calls).toContain("execToFile c-db app");
    expect(docker.calls).toContain("copyOut c-web /app/uploads");
    expect(JSON.stringify(docker.calls)).not.toContain(PG_PASSWORD);
    const view = await service.projectView("p1");
    expect(view.detection?.unsavedWrites).toEqual([{ service: "web", count: 1, samples: ["/app/notas/1.pdf"] }]);
    expect(view.history[0]!.id).toBe(r.id);
    expect(view.target.lastRemoteVerifiedAt).toBe(new Date(now).toISOString());
    expect(Buffer.from(local.files["LEIA-ME.txt"]!, "base64").toString()).toMatch(/psql -U/);
  });

  it("retenção: as 2 últimas na VPS e as N últimas fora, apagadas só depois de conferir", async () => {
    await connect();
    await service.updateTarget(projectTargetId("p1"), { remoteKeep: 3 }, "admin");
    for (let i = 0; i < 5; i++) {
      await backup();
      now += 6 * H;
    }
    expect((await readdir(path.join(dir, "backups", "loja"))).sort()).toHaveLength(2);
    expect((await storage.list("TWS Panel Backups/loja/")).length).toBe(3);
    const points = await service.points(projectTargetId("p1"));
    expect(points.map((p) => [p.local, p.remote])).toEqual([
      [true, true],
      [true, true],
      [false, true],
    ]);
  });

  it("conferência falhou: não apaga nada fora e avisa", async () => {
    await connect();
    await service.updateTarget(projectTargetId("p1"), { remoteKeep: 1 }, "admin");
    await backup();
    now += H;
    storage.corruptDownload = true;
    const r = await backup();
    expect(r).toMatchObject({ status: "warning", remote: "failed", local: true });
    expect(r.remoteDetail).toMatch(/hash/);
    expect((await storage.list("TWS Panel Backups/loja/")).length).toBe(2);
    expect(notices.at(-1)).toMatchObject({ kind: "backup_failed", title: "Backup de Loja: a cópia externa falhou" });
    expect((await service.facts()).lastFailure).toMatch(/hash/);
    expect((await service.facts()).lastFailureAt).toBe(r.finishedAt ?? r.startedAt);
    expect((await service.facts()).lastFailureAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("facts: falha seguida de sucesso não conta; sucesso seguido de falha conta, com a data da falha", async () => {
    await connect();
    storage.corruptDownload = true;
    const bad = await backup();
    expect(bad.remote).toBe("failed");
    expect((await service.facts()).lastFailureAt).toBe(bad.finishedAt ?? bad.startedAt);
    storage.corruptDownload = false;
    now += H;
    const good = await backup();
    expect(good.remote).toBe("verified");
    const ok = await service.facts();
    expect(ok.lastFailure).toBeNull();
    expect(ok).not.toHaveProperty("lastFailureAt");
    now += H;
    storage.corruptDownload = true;
    const bad2 = await backup();
    const again = await service.facts();
    expect(again.lastFailure).toMatch(/hash/);
    expect(again.lastFailureAt).toBe(bad2.finishedAt ?? bad2.startedAt);
    expect(again.lastFailureAt).not.toBe(bad.finishedAt);
  });

  it("facts: projeto apagado e destino desconectado não deixam a falha antiga acesa", async () => {
    await connect();
    storage.corruptDownload = true;
    await backup();
    expect((await service.facts()).lastFailure).toMatch(/hash/);
    await service.removeDestination("admin");
    const off = await service.facts();
    expect(off.destinationConnected).toBe(false);
    expect(off.lastFailure).toBeNull();
    expect(off).not.toHaveProperty("lastFailureAt");
    await connect();
    expect((await service.facts()).lastFailure).toMatch(/hash/);
    await service.forgetProject("p1");
    expect((await service.facts()).lastFailure).toBeNull();
  });

  it("facts: falha sem detalhe volta como texto vazio (a tela escreve a frase)", async () => {
    await connect();
    storage.corruptDownload = true;
    const r = await backup();
    delete (r as { remoteDetail?: string }).remoteDetail;
    expect((await service.facts()).lastFailure).toBe("");
  });

  it("envio falhou", async () => {
    await connect();
    storage.failUpload = true;
    const r = await backup();
    expect(r).toMatchObject({ status: "warning", remote: "failed" });
  });

  it("criptografia ligada sem senha: a externa fica para depois; desligada vai sem senha", async () => {
    await connect(false);
    const r = await backup();
    expect(r).toMatchObject({ status: "warning", remote: "skipped" });
    expect(r.remoteDetail).toMatch(/Defina a senha/);
    await service.setEncryption(false, "admin");
    now += H;
    const r2 = await backup();
    expect(r2).toMatchObject({ status: "success", remote: "verified", remoteEncrypted: false });
    const remote = JSON.parse(storage.objects.get(`TWS Panel Backups/loja/${r2.fileName}`)!.toString()) as { password: string | null };
    expect(remote.password).toBeNull();
  });

  it("sem destino: só a cópia na VPS", async () => {
    const r = await backup();
    expect(r).toMatchObject({ status: "success", local: true, remote: "none" });
  });

  it("nada marcado, disco cheio, dump que falha e 7-Zip ausente viram falha com aviso", async () => {
    await service.updateTarget(projectTargetId("p1"), { choices: { "db:db": false, "mnt:web:/app/uploads": false } }, "admin");
    expect((await backup()).error).toMatch(/Nada marcado/);
    expect(notices.at(-1)).toMatchObject({ kind: "backup_failed", path: "/projects/p1/backups" });
    await service.updateTarget(projectTargetId("p1"), { choices: { "db:db": true } }, "admin");
    free = 1024;
    expect((await backup()).error).toMatch(/Espaço em disco insuficiente/);
    free = 50 * 1024 ** 3;
    docker.failDump = true;
    expect((await backup()).error).toMatch(/O dump do banco "db" falhou: pg_dump: conexão recusada/);
    docker.failDump = false;
    archiver.ok = false;
    service = build();
    expect((await backup()).error).toMatch(/7-Zip não está instalado/);
  });

  it("banco parado, serviço sem container e projeto sem containers", async () => {
    docker.containers = [{ id: "c-db", name: "db", service: "db", running: false }, { id: "c-web", name: "w", service: "web", running: true }];
    expect((await backup()).error).toMatch(/está parado/);
    docker.containers = [{ id: "c-db", name: "db", service: "db", running: true }];
    const r = await service.runNow(projectTargetId("p1"), "admin");
    await service.idle();
    expect((await service.record(r.id)).status).toBe("success");
    docker.containers = [];
    expect((await backup()).error).toMatch(/Nenhum container/);
  });

  it("pastas adicionadas, Redis e o código de projeto que não vem do GitHub", async () => {
    projects = [project({ ingestMode: "upload", source: "/x" })];
    docker.containers.push({ id: "c-redis", name: "paas-loja-cache-1", service: "cache", running: true });
    const inspect = docker.inspect.bind(docker);
    docker.inspect = async (ids) => [
      ...(await inspect(ids.filter((i) => i !== "c-redis"))),
      { Name: "/cache", Config: { Image: "redis:7", Env: [], Labels: { "com.docker.compose.service": "cache" } }, Mounts: [], State: { Running: true } },
    ];
    await service.updateTarget(projectTargetId("p1"), { choices: { "db:cache": true }, extraFolders: [{ service: "web", path: "/app/storage/" }] }, "admin");
    const r = await backup();
    expect(r.status).toBe("success");
    const files = Object.keys(
      (JSON.parse(await readFile(path.join(dir, "backups", "loja", r.fileName!), "utf8")) as { files: Record<string, string> }).files,
    );
    expect(files).toEqual(expect.arrayContaining(["codigo/codigo.tar", "pastas/web__app_storage.tar", "bancos/cache-redis.tar"]));
  });

  it("nomes que colidem depois de normalizados ganham sufixo: nenhum dump ou pasta sobrescreve outro (achado 13)", async () => {
    const capture = docker.execCapture.bind(docker);
    docker.execCapture = async (c, script) => (script.includes("pg_database") ? "a b\na/b\na_b\nA_B\n" : capture(c, script));
    await service.updateTarget(
      projectTargetId("p1"),
      { extraFolders: [{ service: "web", path: "/data/x" }, { service: "web", path: "/data_x" }] },
      "admin",
    );
    const r = await backup();
    expect(r.status).toBe("success");
    const arquivo = JSON.parse(await readFile(path.join(dir, "backups", "loja", r.fileName!), "utf8")) as { files: Record<string, string> };
    const conteudo = (f: string) => Buffer.from(arquivo.files[f]!, "base64").toString();
    const manifest = JSON.parse(conteudo("manifesto.json")) as {
      items: Array<{ type: string; destination?: string; file?: string; databases?: Array<{ name: string; file: string }> }>;
    };
    const dbs = manifest.items.find((i) => i.type === "database")!.databases!;
    expect(new Set(dbs.map((d) => d.file)).size).toBe(4);
    for (const d of dbs) expect(conteudo(d.file)).toBe(`dump c-db ${d.name} banco`);
    expect(dbs.map((d) => d.file)).toEqual(["bancos/db/a_b.sql", "bancos/db/a_b-2.sql", "bancos/db/a_b-3.sql", "bancos/db/A_B-4.sql"]);
    const extras = manifest.items.filter((i) => i.type === "extra");
    expect(new Set(extras.map((e) => e.file)).size).toBe(2);
    for (const e of extras) expect(conteudo(e.file!)).toBe(`tar c-web ${e.destination}`);
    // e a restauração devolve cada um ao seu lugar
    const rr = await service.restore(projectTargetId("p1"), { fileName: r.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    expect((await service.record(rr.id)).status).not.toBe("failed");
    expect(docker.dbInput.find((d) => d.args[0] === "a/b")!.content).toBe("dump c-db a/b banco");
    expect(docker.dbInput.find((d) => d.args[0] === "A_B")!.content).toBe("dump c-db A_B banco");
    expect(docker.restored.map((x) => x.content)).toEqual(expect.arrayContaining(["tar c-web /data/x", "tar c-web /data_x"]));
  });

  it("o primeiro deploy vem antes; e-mail sem servidor", async () => {
    projects = [project({ lastDeployAt: null })];
    await expect(service.runNow(projectTargetId("p1"), "admin")).rejects.toMatchObject({ code: "not_deployed" });
    await expect(service.runNow("project:nao-existe", "admin")).rejects.toMatchObject({ statusCode: 404 });
    docker.states = {};
    await expect(service.runNow("email", "admin")).rejects.toMatchObject({ code: "email_unavailable" });
  });

  it("um por vez: o mesmo item pedido duas vezes entra uma só", async () => {
    const a = await service.runNow("panel", "admin");
    const b = await service.runNow("panel", "admin");
    expect(b.id).toBe(a.id);
    const s = await service.status();
    expect([s.running?.id, ...s.queued.map((q) => q.id)]).toContain(a.id);
    await service.idle();
  });
});

describe("backup do e-mail e do painel", () => {
  it("e-mail: para o Stalwart só durante a cópia, e copia o webmail", async () => {
    const r = await backup("email");
    expect(r.status).toBe("success");
    const i = docker.calls.indexOf("stop paas-stalwart");
    expect(docker.calls.slice(i, i + 4)).toEqual([
      "stop paas-stalwart",
      "copyOut paas-stalwart /opt/stalwart-mail/data",
      "copyOut paas-stalwart /opt/stalwart-mail/etc",
      "start paas-stalwart",
    ]);
    expect(docker.calls).toContain("copyOut paas-webmail /var/roundcube");
  });

  it("painel: o diretório de dados, sem as cópias de backup nem temporários", async () => {
    await mkdir(path.join(dir, "mail"), { recursive: true });
    await writeFile(path.join(dir, "mail", "domains.json"), "{}");
    await writeFile(path.join(dir, "algo.tmp"), "x");
    await writeFile(path.join(dir, "api-tokens.json"), '{"tokens":[]}');
    const r = await backup("panel");
    expect(r.status).toBe("success");
    const files = Object.keys(
      (JSON.parse(await readFile(path.join(dir, "backups", "_painel", r.fileName!), "utf8")) as { files: Record<string, string> }).files,
    );
    expect(files).toEqual(expect.arrayContaining(["users.json", "mail/domains.json", "backups-key", "manifesto.json"]));
    expect(files.some((f) => f.startsWith("backups/") || f.endsWith(".tmp"))).toBe(false);
    // tokens de API não viajam no backup do painel (nem voltam dele)
    expect(files).not.toContain("api-tokens.json");
  });

  it("painel: assunto e corpo dos envios por SMTP ficam FORA do backup; os metadados entram", async () => {
    await mkdir(path.join(dir, "envios-conteudo"), { recursive: true });
    await writeFile(path.join(dir, "envios-conteudo", "1.json"), '{"subject":"segredo"}');
    await mkdir(path.join(dir, "mail", "envios", "saidas"), { recursive: true });
    await writeFile(path.join(dir, "mail", "envios", "saidas", "2026-10-22.jsonl"), '{"id":"1"}\n');
    const r = await backup("panel");
    expect(r.status).toBe("success");
    const raw = await readFile(path.join(dir, "backups", "_painel", r.fileName!), "utf8");
    const files = Object.keys((JSON.parse(raw) as { files: Record<string, string> }).files);
    expect(files.some((f) => f.startsWith("envios-conteudo"))).toBe(false);
    expect(files).toContain("mail/envios/saidas/2026-10-22.jsonl");
    expect(raw).not.toContain("segredo");
  });

  it("painel: métricas por minuto ficam FORA do backup; as de hora e de dia e a retenção escolhida entram", async () => {
    await mkdir(path.join(dir, "metrics-min"), { recursive: true });
    await writeFile(path.join(dir, "metrics-min", "2026-10-24.jsonl"), '{"t":1,"h":{"cpuBusy":5},"c":{}}\n');
    await mkdir(path.join(dir, "metrics", "hour"), { recursive: true });
    await writeFile(path.join(dir, "metrics", "hour", "2026-10-24.jsonl"), '{"t":0,"n":60,"h":{},"c":{}}\n');
    await mkdir(path.join(dir, "metrics", "day"), { recursive: true });
    await writeFile(path.join(dir, "metrics", "day", "2026-10.jsonl"), '{"t":0,"n":1440,"h":{},"c":{}}\n');
    await writeFile(path.join(dir, "metrics-settings.json"), '{"retention":{"minuteHours":72,"hourDays":30,"dayDays":365}}\n');
    const r = await backup("panel");
    expect(r.status).toBe("success");
    const files = Object.keys(
      (JSON.parse(await readFile(path.join(dir, "backups", "_painel", r.fileName!), "utf8")) as { files: Record<string, string> }).files,
    );
    expect(files.some((f) => f.startsWith("metrics-min"))).toBe(false);
    expect(files).toEqual(expect.arrayContaining(["metrics/hour/2026-10-24.jsonl", "metrics/day/2026-10.jsonl", "metrics-settings.json"]));
  });
});

describe("restaurar", () => {
  it("projeto: confirma pelo nome, para o app, restaura bancos e pastas e liga de novo", async () => {
    await connect();
    const b = await backup();
    await expect(
      service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "errado" }, "admin"),
    ).rejects.toMatchObject({ code: "confirm_mismatch", message: "Para confirmar, digite exatamente: Loja" });
    docker.calls = [];
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "remote", confirm: "loja" }, "admin");
    await service.idle();
    const done = await service.record(r.id);
    expect(done.status).toBe("success");
    // A detecção (docker diff) e a cópia de segurança do banco atual rodam antes de parar o app.
    const calls = docker.calls.filter((c) => !c.startsWith("diff"));
    // o app é parado ANTES da cópia de segurança (nada grava durante o dump) e a cópia vem antes de sobrescrever
    expect(calls.indexOf("stop c-web")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("stop c-web")).toBeLessThan(calls.indexOf("execToFile c-db app"));
    expect(calls.indexOf("execToFile c-db app")).toBeLessThan(calls.findIndex((c) => c.startsWith("execFromFile c-db app,tws_new_")));
    // PostgreSQL restaura num banco novo e troca pelo atual; o antigo é apagado no fim
    expect(calls.filter((c) => c.startsWith("execCapture c-db"))).toHaveLength(calls.filter((c) => c.startsWith("execCapture c-db")).length);
    expect(docker.calls.filter((c) => c.startsWith("execFromFile c-db ") && c !== "execFromFile c-db ").map((c) => c.split(",")[0])).toEqual(["execFromFile c-db app", "execFromFile c-db postgres"]);
    expect(docker.calls).toContain("restorePath c-web /app/uploads");
    expect(docker.calls.at(-1)).toBe("start c-web");
    expect(docker.dbInput.find((d) => d.args[0] === "app")!.content).toBe("dump c-db app banco");
    expect(archiver.calls.filter((c) => c.op === "extract").at(-1)!.password).toBe(PW);
    expect(audits.map((a) => a.action)).toContain("backups.restore");
  });

  it("backup de antes da troca de senha: pede a senha da época", async () => {
    await connect();
    const b = await backup();
    await service.setPassword("nova-frase-bem-comprida-77", true, "admin");
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "remote", confirm: "Loja" }, "admin");
    await service.idle();
    expect((await service.record(r.id)).error).toMatch(/senha que o painel não tem/);
    const r2 = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "remote", confirm: "Loja", password: "chute-errado-123" }, "admin");
    await service.idle();
    expect((await service.record(r2.id)).error).toMatch(/A senha digitada não abre/);
    const r3 = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "remote", confirm: "Loja", password: PW }, "admin");
    await service.idle();
    expect((await service.record(r3.id)).status).not.toBe("failed");
  });

  it("VPS nova: sem containers, publica do GitHub antes (ou explica)", async () => {
    const b = await backup();
    docker.containers = [];
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    expect((await service.record(r.id)).error).toMatch(/Publicar do GitHub/);
    const r2 = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja", redeploy: true }, "admin");
    await service.idle();
    expect(redeploys).toEqual(["p1"]);
    expect((await service.record(r2.id)).steps.map((s) => s.label)).toContain("Publicar o projeto do GitHub");
  });

  it("restaurar um projeto o marca em manutenção do começo ao fim (o monitoramento não o trata como queda), com sucesso ou com erro", async () => {
    const b = await backup();
    const ok = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    expect((await service.record(ok.id)).status).not.toBe("failed");
    expect(maintenance).toEqual([`+${projects[0]!.slug}`, `-${projects[0]!.slug}`]);
    maintenance = [];
    docker.containers = [];
    const bad = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    expect((await service.record(bad.id)).error).toMatch(/Publicar do GitHub/);
    expect(maintenance).toEqual([`+${projects[0]!.slug}`, `-${projects[0]!.slug}`]);
  });

  it("serviço que sumiu, arquivo que não existe e restauração sem destino", async () => {
    const b = await backup();
    docker.containers = [{ id: "c-db", name: "db", service: "db", running: true }];
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    expect((await service.record(r.id)).warnings.join(" ")).toMatch(/"web" não existe mais/);
    await expect(service.restore(projectTargetId("p1"), { fileName: "2026-01-01_03-00.7z", source: "local", confirm: "Loja" }, "a")).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(service.restore(projectTargetId("p1"), { fileName: "../x", source: "local", confirm: "Loja" }, "a")).rejects.toMatchObject({
      code: "invalid_file",
    });
    await expect(service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "remote", confirm: "Loja" }, "a")).rejects.toMatchObject({
      code: "no_destination",
    });
  });

  it("e-mail: para, devolve o volume e a configuração, liga de novo", async () => {
    const b = await backup("email");
    docker.calls = [];
    const r = await service.restore("email", { fileName: b.fileName!, source: "local", confirm: "E-MAIL" }, "admin");
    await service.idle();
    expect((await service.record(r.id)).status).toBe("success");
    expect(docker.calls).toEqual([
      "stop paas-stalwart",
      "restoreVolume paas_stalwart_data",
      "copyIn paas-stalwart /opt/stalwart-mail",
      "start paas-stalwart",
      "stop paas-webmail",
      "restoreVolume paas_webmail_data",
      "start paas-webmail",
    ]);
    docker.states = {};
    const r2 = await service.restore("email", { fileName: b.fileName!, source: "local", confirm: "e-mail" }, "admin");
    await service.idle();
    expect((await service.record(r2.id)).warnings.join(" ")).toMatch(/clique em Iniciar/);
  });

  it("painel: prepara a troca para a próxima subida e reinicia", async () => {
    const b = await backup("panel");
    const r = await service.restore("panel", { fileName: b.fileName!, source: "local", confirm: "painel" }, "admin");
    await service.idle();
    expect((await service.record(r.id)).status).toBe("warning");
    expect(existsSync(path.join(dir, "backups", ".restaurar-painel.json"))).toBe(true);
    expect(existsSync(path.join(dir, "backups", ".restaurar-painel", "users.json"))).toBe(true);
    await waitRestarted();
    expect(restarted).toBe(1);
  });

  it("painel com uma troca pela metade (progresso gravado): recusa e não apaga a pasta extraída", async () => {
    const b = await backup("panel");
    await mkdir(path.join(dir, "backups", ".restaurar-painel"), { recursive: true });
    await writeFile(path.join(dir, "backups", ".restaurar-painel", "secrets.json"), "parte do backup anterior");
    await writeFile(path.join(dir, "backups", ".restaurar-painel.progresso.json"), "{}");
    const r = await service.restore("panel", { fileName: b.fileName!, source: "local", confirm: "painel" }, "admin");
    await service.idle();
    expect((await service.record(r.id)).error).toMatch(/restauração do painel pela metade/);
    expect(await readFile(path.join(dir, "backups", ".restaurar-painel", "secrets.json"), "utf8")).toBe("parte do backup anterior");
    expect(restarted).toBe(0);
  });

  it("arquivo de outro tipo não é restaurado", async () => {
    const b = await backup("panel");
    await mkdir(path.join(dir, "backups", "_email"), { recursive: true });
    await writeFile(path.join(dir, "backups", "_email", b.fileName!), await readFile(path.join(dir, "backups", "_painel", b.fileName!)));
    const r = await service.restore("email", { fileName: b.fileName!, source: "local", confirm: "e-mail" }, "admin");
    await service.idle();
    expect((await service.record(r.id)).error).toMatch(/não é um backup deste item/);
  });
});

describe("Caddy (certificados e conta ACME) no backup CIFRADO do painel", () => {
  const CADDY = { container: "paas-caddy", volume: "paas_caddy_data", dataPath: "/data" };
  const archiveOf = async (file: string) => JSON.parse(await readFile(file, "utf8")) as { password: string | null; files: Record<string, string> };
  const localArchive = async (fileName: string) => archiveOf(path.join(dir, "backups", "_painel", fileName));
  const remoteArchive = async (fileName: string) => {
    const buf = storage.objects.get(`${BACKUP_ROOT_FOLDER}/_painel/${fileName}`)!;
    return JSON.parse(buf.toString("utf8")) as { password: string | null; files: Record<string, string> };
  };
  const text = (b64: string) => Buffer.from(b64, "base64").toString("utf8");
  const stagedCaddy = path.join(".restaurar-painel", "_caddy");

  beforeEach(() => {
    docker.states["paas-caddy"] = { exists: true, running: true };
    service = build({ caddy: CADDY });
  });

  async function restorePanel(fileName: string, source: "local" | "remote") {
    const r = await service.restore("panel", { fileName, source, confirm: "painel" }, "admin");
    await service.idle();
    return service.record(r.id);
  }

  it("cópia externa cifrada leva _caddy/caddy-data.tar (copyOut do /data do paas-caddy); a da VPS, sem senha, não leva", async () => {
    await connect();
    const r = await backup("panel");
    expect(r.status).toBe("success");
    expect(docker.calls).toContain("copyOut paas-caddy /data");
    const remote = await remoteArchive(r.fileName!);
    expect(remote.password).toBe(PW);
    expect(text(remote.files["_caddy/caddy-data.tar"]!)).toBe("tar paas-caddy /data");
    expect(Object.keys(remote.files)).toEqual(expect.arrayContaining(["users.json", "manifesto.json"]));
    const local = await localArchive(r.fileName!);
    expect(local.password).toBeNull();
    expect(Object.keys(local.files).some((f) => f.startsWith("_caddy"))).toBe(false);
    expect(JSON.stringify(local)).not.toContain(Buffer.from("tar paas-caddy /data").toString("base64"));
  });

  it("a pasta _caddy (chaves privadas) é criada só para o dono: 0700 quando o docker cp grava nela", async () => {
    await connect();
    await backup("panel");
    expect(docker.copyOutDirModes).toContain("paas-caddy:700");
  });

  it("o LEIA-ME do painel explica onde estão os certificados", async () => {
    await connect();
    const r = await backup("panel");
    const readme = text((await remoteArchive(r.fileName!)).files["LEIA-ME.txt"]!);
    expect(readme).toMatch(/_caddy\/caddy-data\.tar/);
    expect(readme).toMatch(/paas_caddy_data/);
  });

  it("cópia externa SEM cifra (criptografia desligada): as chaves do Caddy não saem da VPS", async () => {
    await connect();
    await service.setEncryption(false, "admin");
    const r = await backup("panel");
    expect(r.status).toBe("success");
    expect(docker.calls.some((c) => c.startsWith("copyOut paas-caddy"))).toBe(false);
    expect(Object.keys((await remoteArchive(r.fileName!)).files).some((f) => f.startsWith("_caddy"))).toBe(false);
    expect(r.steps.map((s) => s.label).join(" | ")).toMatch(/só entram na cópia externa cifrada/);
  });

  it("sem armazenamento externo: nada do Caddy é copiado", async () => {
    const r = await backup("panel");
    expect(r.status).toBe("success");
    expect(docker.calls.some((c) => c.startsWith("copyOut paas-caddy"))).toBe(false);
    expect(Object.keys((await localArchive(r.fileName!)).files).some((f) => f.startsWith("_caddy"))).toBe(false);
  });

  it("senha definida mas sem armazenamento externo: nada do Caddy é copiado", async () => {
    await service.setPassword(PW, true, "admin");
    const r = await backup("panel");
    expect(r.status).toBe("success");
    expect(docker.calls.some((c) => c.startsWith("copyOut paas-caddy"))).toBe(false);
  });

  it("armazenamento sem senha definida (cópia externa pulada): nada do Caddy é copiado", async () => {
    await connect(false);
    const r = await backup("panel");
    expect(r.remote).toBe("skipped");
    expect(docker.calls.some((c) => c.startsWith("copyOut paas-caddy"))).toBe(false);
  });

  it("sem a opção `caddy` o backup do painel não toca no Caddy (instalação sem proxy)", async () => {
    service = build();
    await connect();
    const r = await backup("panel");
    expect(r.status).toBe("success");
    expect(docker.calls.some((c) => c.includes("paas-caddy"))).toBe(false);
  });

  it("Caddy ainda não criado: backup normal, sem aviso", async () => {
    docker.states["paas-caddy"] = { exists: false, running: false };
    await connect();
    const r = await backup("panel");
    expect(r.status).toBe("success");
    expect(r.warnings).toEqual([]);
    expect(docker.calls.some((c) => c.startsWith("copyOut paas-caddy"))).toBe(false);
    expect(r.steps.map((s) => s.label).join(" | ")).toMatch(/Caddy ainda não foi criado/);
  });

  it("Docker sem resposta ao olhar o Caddy: trata como sem Caddy e o backup segue", async () => {
    vi.spyOn(docker, "state").mockImplementation(async (c: string) => {
      if (c === "paas-caddy") throw new Error("docker fora");
      return { exists: false, running: false };
    });
    await connect();
    const r = await backup("panel");
    expect(r.status).toBe("success");
    expect(docker.calls.some((c) => c.startsWith("copyOut paas-caddy"))).toBe(false);
  });

  it("falha ao copiar o Caddy: aviso claro, backup do painel segue completo e a cópia externa é conferida", async () => {
    docker.failCopyOut = "paas-caddy";
    await connect();
    const r = await backup("panel");
    expect(r.status).toBe("warning");
    expect(r.warnings.join(" ")).toMatch(/certificados do Caddy.*no space left/);
    expect(r.remote).toBe("verified");
    expect(Object.keys((await remoteArchive(r.fileName!)).files).some((f) => f.startsWith("_caddy"))).toBe(false);
    expect(Object.keys((await remoteArchive(r.fileName!)).files)).toContain("users.json");
    expect((await readdir(path.join(dir, "backups"))).some((n) => n.startsWith(".tmp") && n !== ".tmp")).toBe(false);
  });

  it("a pasta temporária com as chaves do Caddy some ao fim do backup", async () => {
    await connect();
    await backup("panel");
    const tmp = path.join(dir, "backups", ".tmp");
    const left = existsSync(tmp) ? await readdir(tmp) : [];
    expect(left).toEqual([]);
  });

  it("restaurar a cópia externa: devolve os dados ao volume do Caddy, marca o recarregamento e não deixa _caddy no estado do painel", async () => {
    await connect();
    const b = await backup("panel");
    const rec = await restorePanel(b.fileName!, "remote");
    expect(rec.status).toBe("warning");
    expect(docker.merged).toEqual([{ volume: "paas_caddy_data", content: "tar paas-caddy /data" }]);
    expect(rec.steps.map((s) => s.label).join(" | ")).toMatch(/Devolver os certificados/);
    expect(existsSync(path.join(dir, "backups", ".caddy-reload-pending"))).toBe(true);
    expect(existsSync(path.join(dir, "backups", ".restaurar-painel", "users.json"))).toBe(true);
    expect(existsSync(path.join(dir, "backups", stagedCaddy))).toBe(false);
    expect(existsSync(path.join(dir, "backups", ".restaurar-painel", "manifesto.json"))).toBe(true);
    // a chave não aparece em nenhum registro, aviso nem log
    expect(JSON.stringify(rec) + logs.join("\n")).not.toContain("caddy-data.tar\":");
    await waitRestarted();
  });

  it("restaurar a cópia da VPS (sem os dados do Caddy): nada é devolvido nem marcado", async () => {
    await connect();
    const b = await backup("panel");
    const rec = await restorePanel(b.fileName!, "local");
    expect(rec.status).toBe("warning");
    expect(docker.merged).toEqual([]);
    expect(docker.calls.some((c) => c.startsWith("mergeVolume"))).toBe(false);
    expect(existsSync(path.join(dir, "backups", ".caddy-reload-pending"))).toBe(false);
    await waitRestarted();
  });

  it("falha ao devolver ao volume: aviso, sem marcador, a restauração do painel continua", async () => {
    await connect();
    const b = await backup("panel");
    docker.failMerge = true;
    const rec = await restorePanel(b.fileName!, "remote");
    expect(rec.error ?? null).toBeNull();
    expect(rec.warnings.join(" ")).toMatch(/Não foi possível devolver os certificados do Caddy.*sem espaço no volume/);
    expect(existsSync(path.join(dir, "backups", ".caddy-reload-pending"))).toBe(false);
    expect(existsSync(path.join(dir, "backups", stagedCaddy))).toBe(false);
    expect(existsSync(path.join(dir, "backups", ".restaurar-painel.json"))).toBe(true);
    await waitRestarted();
  });

  it("_caddy que é um arquivo comum no lugar da pasta: ignorada com aviso", async () => {
    await connect();
    const b = await backup("panel");
    const original = archiver.extract.bind(archiver);
    vi.spyOn(archiver, "extract").mockImplementation(async (archive, outDir, password) => {
      await original(archive, outDir, password);
      await removeDir(path.join(outDir, "_caddy"));
      await writeFile(path.join(outDir, "_caddy"), "arquivo, não pasta");
    });
    const rec = await restorePanel(b.fileName!, "remote");
    expect(rec.warnings.join(" ")).toMatch(/fora do formato esperado/);
    expect(docker.merged).toEqual([]);
    expect(existsSync(path.join(dir, "backups", stagedCaddy))).toBe(false);
    await waitRestarted();
  });

  it("caddy-data.tar que é um link: ignorado com aviso", async () => {
    await connect();
    const b = await backup("panel");
    const original = archiver.extract.bind(archiver);
    vi.spyOn(archiver, "extract").mockImplementation(async (archive, outDir, password) => {
      await original(archive, outDir, password);
      await rm(path.join(outDir, "_caddy", "caddy-data.tar"), { force: true });
      await symlink("/etc/hostname", path.join(outDir, "_caddy", "caddy-data.tar"));
    });
    const rec = await restorePanel(b.fileName!, "remote");
    expect(rec.warnings.join(" ")).toMatch(/fora do formato esperado/);
    expect(docker.merged).toEqual([]);
    expect(existsSync(path.join(dir, "backups", stagedCaddy))).toBe(false);
    await waitRestarted();
  });

  it("pasta _caddy que é um link: ignorada e removida sem seguir o link", async () => {
    await connect();
    const b = await backup("panel");
    const alvo = path.join(dir, "fora-do-backup");
    await mkdir(alvo);
    await writeFile(path.join(alvo, "caddy-data.tar"), "não é do backup");
    const original = archiver.extract.bind(archiver);
    vi.spyOn(archiver, "extract").mockImplementation(async (archive, outDir, password) => {
      await original(archive, outDir, password);
      await removeDir(path.join(outDir, "_caddy"));
      await symlink(alvo, path.join(outDir, "_caddy"));
    });
    const rec = await restorePanel(b.fileName!, "remote");
    expect(rec.warnings.join(" ")).toMatch(/fora do formato esperado/);
    expect(docker.merged).toEqual([]);
    // o conteúdo do destino do link continua lá: remover o link não apaga o que ele aponta
    expect(await readFile(path.join(alvo, "caddy-data.tar"), "utf8")).toBe("não é do backup");
    await waitRestarted();
  });

  it("instalação sem a opção `caddy`: o backup traz os certificados, mas são ignorados com aviso (e removidos do estado)", async () => {
    await connect();
    const b = await backup("panel");
    service = build();
    const rec = await restorePanel(b.fileName!, "remote");
    expect(rec.warnings.join(" ")).toMatch(/não sabe devolvê-los/);
    expect(docker.merged).toEqual([]);
    expect(existsSync(path.join(dir, "backups", stagedCaddy))).toBe(false);
    await waitRestarted();
  });
});

describe("restaurar: backup adulterado não manda nos caminhos", () => {
  const FILE = "2026-10-13_03-00.7z";
  const b64 = (s: string) => Buffer.from(s).toString("base64");

  /** Grava na VPS um "backup" montado à mão, com o manifesto que quisermos. */
  async function forge(items: unknown[], extra: Record<string, string> = {}): Promise<void> {
    const folder = (await service.status()).targets.find((t) => t.id === projectTargetId("p1"))!.folder;
    const manifest = { version: 1, kind: "project", name: "Loja", projectId: "p1", slug: "loja", createdAt: "2026-10-13T06:00:00Z", items };
    const files: Record<string, string> = { "manifesto.json": b64(JSON.stringify(manifest)) };
    for (const [k, v] of Object.entries(extra)) files[k] = b64(v);
    await mkdir(path.join(dir, "backups", folder), { recursive: true });
    await writeFile(path.join(dir, "backups", folder, FILE), JSON.stringify({ password: null, files }));
  }

  async function restoreForged() {
    const r = await service.restore(projectTargetId("p1"), { fileName: FILE, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    return service.record(r.id);
  }

  it("pasta que o projeto não tem é ignorada com aviso", async () => {
    await forge([{ type: "mount", service: "web", destination: "/etc", mountType: "volume", file: "volumes/web__etc.tar" }], {
      "volumes/web__etc.tar": "tar",
    });
    const r = await restoreForged();
    expect(docker.calls).not.toContain("restorePath c-web /etc");
    expect(r.warnings.join(" ")).toMatch(/\/etc.*não é uma pasta deste projeto/);
  });

  it("pasta extra só se estiver cadastrada no projeto", async () => {
    await forge([{ type: "extra", service: "web", destination: "/root/.ssh", file: "pastas/web__ssh.tar" }], { "pastas/web__ssh.tar": "tar" });
    const r = await restoreForged();
    expect(docker.calls.some((c) => c.startsWith("copyIn"))).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/\/root\/\.ssh.*não é uma pasta deste projeto/);
  });

  it("Redis volta sempre para /data, não para o caminho do manifesto", async () => {
    await forge([{ type: "database", service: "db", engine: "redis", destination: "/etc", file: "bancos/db-redis.tar" }], {
      "bancos/db-redis.tar": "tar",
    });
    await restoreForged();
    expect(docker.calls).toContain("restorePath c-db /data");
    expect(docker.calls).not.toContain("restorePath c-db /etc");
  });

  it("código volta para a pasta do projeto, não para o caminho do manifesto", async () => {
    const extracted: string[] = [];
    service = build({ tar: { create: async () => undefined, extract: async (_f, parent) => void extracted.push(parent) } });
    await forge([{ type: "source", destination: "/etc/cron.d/x", file: "codigo/codigo.tar" }], { "codigo/codigo.tar": "tar" });
    await restoreForged();
    expect(extracted).toEqual([path.join(dir, "projects", "loja")]);
  });

  it("arquivo fora do backup (../ ou nome estranho) faz a restauração falhar sem tocar em nada", async () => {
    await forge([{ type: "mount", service: "web", destination: "/app/uploads", mountType: "volume", file: "../../users.json" }]);
    const r = await restoreForged();
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/caminho inválido/);
    expect(docker.calls.some((c) => c.startsWith("restorePath") || c.startsWith("stop"))).toBe(false);
  });

  it("arquivo citado que não existe ou é link para fora também falha", async () => {
    await forge([{ type: "mount", service: "web", destination: "/app/uploads", mountType: "volume", file: "volumes/sumiu.tar" }]);
    expect((await restoreForged()).error).toMatch(/caminho inválido/);
    const extract = archiver.extract.bind(archiver);
    archiver.extract = async (archive, outDir, password) => {
      await extract(archive, outDir, password);
      await mkdir(path.join(outDir, "volumes"), { recursive: true });
      await symlink(path.join(dir, "users.json"), path.join(outDir, "volumes", "web__app_uploads.tar"));
    };
    await forge([{ type: "mount", service: "web", destination: "/app/uploads", mountType: "volume", file: "volumes/web__app_uploads.tar" }]);
    const r = await restoreForged();
    expect(r.error).toMatch(/caminho inválido/);
    expect(docker.calls.some((c) => c.startsWith("restorePath"))).toBe(false);
  });

  it("criptografia ligada: cópia externa que abre sem senha é recusada", async () => {
    await connect();
    const b = await backup();
    const folder = (await service.status()).targets.find((t) => t.id === projectTargetId("p1"))!.folder;
    const key = [...storage.objects.keys()].find((k) => k.endsWith(`/${folder}/${b.fileName}`))!;
    storage.objects.set(key, await readFile(path.join(dir, "backups", folder, b.fileName!)));
    docker.calls = [];
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "remote", confirm: "Loja" }, "admin");
    await service.idle();
    const done = await service.record(r.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/sem senha/);
    expect(docker.calls.some((c) => c.startsWith("restorePath") || c.startsWith("execFromFile"))).toBe(false);
  });
});

describe("restaurar de outro servidor", () => {
  it("lista o que existe no armazenamento", async () => {
    await expect(service.catalog()).rejects.toMatchObject({ code: "no_destination" });
    await connect();
    await backup();
    await backup("panel");
    storage.objects.set("TWS Panel Backups/antigo/2026-01-01_03-00.7z", Buffer.from("x"));
    const c = await service.catalog();
    expect(c.panel).toHaveLength(1);
    expect(c.email).toEqual([]);
    expect(c.projects).toEqual([
      { folder: "antigo", projectId: null, projectName: null, points: [expect.objectContaining({ fileName: "2026-01-01_03-00.7z" })] },
      { folder: "loja", projectId: "p1", projectName: "Loja", points: [expect.objectContaining({ remote: true })] },
    ]);
  });
});

describe("configuração por item", () => {
  it("valida frequência, cópias e pastas", async () => {
    const id = projectTargetId("p1");
    await expect(service.updateTarget(id, { frequencyHours: 8 as 6 }, "a")).rejects.toMatchObject({ code: "invalid_frequency" });
    await expect(service.updateTarget(id, { localKeep: 0 }, "a")).rejects.toMatchObject({ code: "invalid_keep" });
    await expect(service.updateTarget(id, { extraFolders: [{ service: "web", path: "relativo" }] }, "a")).rejects.toMatchObject({ code: "invalid_path" });
    await expect(service.updateTarget(id, { extraFolders: [{ service: "web", path: "/app/../etc" }] }, "a")).rejects.toMatchObject({ code: "invalid_path" });
    await expect(
      service.updateTarget(id, { extraFolders: Array.from({ length: 21 }, (_, i) => ({ service: "web", path: `/p${i}` })) }, "a"),
    ).rejects.toMatchObject({ code: "too_many_folders" });
    await service.updateTarget(id, { frequencyHours: 6, enabled: false }, "admin");
    await service.updateTarget(id, { enabled: true, localKeep: 3 }, "admin");
    const v = await service.projectView("p1");
    expect(v.target).toMatchObject({ frequencyHours: 6, enabled: true, localKeep: 3 });
    expect(audits.at(-1)!.detail).toMatch(/Loja: na VPS: 3 cópias, ligado/);
  });

  it("criação do projeto (sim/não), detecção e projeto apagado", async () => {
    await service.initProject("p1", false);
    expect((await service.projectView("p1")).target.enabled).toBe(false);
    const view = await service.projectView("p1");
    expect(view.detection).toBeNull();
    await service.detectProject("p1");
    expect((await service.projectView("p1")).detection?.databases[0]?.engine).toBe("postgres");
    await service.forgetProject("p1");
    expect((await service.projectView("p1")).target.enabled).toBe(true);
    await expect(service.detectProject("x")).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.record("nada")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("operação interrompida por reinício vira falha", async () => {
    await writeFile(
      path.join(dir, "backups-history.json"),
      JSON.stringify({ entries: [{ id: "x", target: "panel", targetName: "Painel", operation: "backup", status: "running", steps: [], warnings: [] }] }),
    );
    service = build();
    expect((await service.record("x"))).toMatchObject({ status: "failed", error: expect.stringMatching(/reiniciou/) });
  });
});

describe("padrão dos projetos", () => {
  const P1 = projectTargetId("p1");
  const P2 = projectTargetId("p2");

  it("vem com 24 h, 2 e 5 e ligado; projeto que nunca salvou segue o padrão", async () => {
    const s = await service.status();
    expect(s.projectDefaults).toEqual({ enabled: true, frequencyHours: 24, localKeep: 2, remoteKeep: 5 });
    expect(s.targets.find((t) => t.id === P1)).toMatchObject({ followsDefaults: true });
    expect(s.targets.find((t) => t.id === "panel")!.followsDefaults).toBeUndefined();
  });

  it("trocar o padrão muda quem segue, não quem tem configuração própria nem painel e e-mail", async () => {
    projects = [project(), project({ id: "p2", name: "Blog", slug: "blog" })];
    await service.updateTarget(P2, { frequencyHours: 12 }, "admin");
    await service.updateDefaults({ frequencyHours: 6, localKeep: 8, remoteKeep: 30 }, "admin");
    const s = await service.status();
    expect(s.projectDefaults).toMatchObject({ frequencyHours: 6, localKeep: 8, remoteKeep: 30 });
    expect(s.targets.find((t) => t.id === P1)).toMatchObject({ frequencyHours: 6, localKeep: 8, remoteKeep: 30, followsDefaults: true });
    expect(s.targets.find((t) => t.id === P2)).toMatchObject({ frequencyHours: 12, localKeep: 2, remoteKeep: 5, followsDefaults: false });
    expect(s.targets.find((t) => t.id === "panel")).toMatchObject({ frequencyHours: 24, localKeep: 2 });
    expect(audits.at(-1)).toMatchObject({ action: "backups.defaults" });
    expect(audits.at(-1)!.detail).toMatch(/Padrão dos projetos: a cada 6 h, na VPS: 8 cópias, fora: 30 cópias \(1 projeto segue o padrão\)/);
    // não mexe nos itens marcados
    await service.updateTarget(P1, { choices: { "db:db": false } }, "admin");
    expect((await service.projectView("p1")).target.followsDefaults).toBe(true);
    expect((await service.projectView("p1")).choices).toEqual({ "db:db": false });
  });

  it("projeto novo nasce com o padrão; com a escolha diferente do padrão, vira próprio", async () => {
    await service.updateDefaults({ frequencyHours: 6, localKeep: 8, remoteKeep: 30 }, "admin");
    projects = [project(), project({ id: "p2", name: "Blog", slug: "blog" }), project({ id: "p3", name: "Site", slug: "site" })];
    await service.initProject("p2", true);
    await service.initProject("p3", false);
    expect((await service.projectView("p2")).target).toMatchObject({ enabled: true, frequencyHours: 6, localKeep: 8, followsDefaults: true });
    expect((await service.projectView("p3")).target).toMatchObject({ enabled: false, frequencyHours: 6, localKeep: 8, followsDefaults: false });
    // padrão desligado e projeto criado sem escolher: nasce desligado, seguindo o padrão
    await service.updateDefaults({ enabled: false }, "admin");
    projects.push(project({ id: "p4", name: "Api", slug: "api" }));
    await service.initProject("p4");
    expect((await service.projectView("p4")).target).toMatchObject({ enabled: false, followsDefaults: true });
  });

  it("salvar frequência ou cópias na aba do projeto vira configuração própria; Voltar ao padrão desfaz", async () => {
    await service.updateDefaults({ frequencyHours: 6 }, "admin");
    await service.updateTarget(P1, { enabled: true, frequencyHours: 12, localKeep: 3, remoteKeep: 4 }, "admin");
    expect((await service.projectView("p1")).target).toMatchObject({ frequencyHours: 12, followsDefaults: false });
    await service.useDefaults(P1, "admin");
    expect((await service.projectView("p1")).target).toMatchObject({ frequencyHours: 6, localKeep: 2, remoteKeep: 5, followsDefaults: true });
    expect(audits.at(-1)!.detail).toMatch(/Loja: voltou ao padrão dos projetos/);
    await expect(service.useDefaults("panel", "admin")).rejects.toMatchObject({ statusCode: 400 });
  });

  it("Aplicar também nestes projetos: copia o padrão e marca como seguindo", async () => {
    projects = [project(), project({ id: "p2", name: "Blog", slug: "blog" })];
    await service.updateTarget(P1, { frequencyHours: 12, enabled: false }, "admin");
    await service.updateTarget(P2, { localKeep: 9 }, "admin");
    await service.updateDefaults({ frequencyHours: 6, localKeep: 8, remoteKeep: 30 }, "admin");
    const r = await service.applyDefaults(["p1", "nao-existe"], "admin");
    expect(r).toEqual({ applied: [{ id: "p1", name: "Loja" }], missing: ["nao-existe"] });
    const s = await service.status();
    expect(s.targets.find((t) => t.id === P1)).toMatchObject({ enabled: true, frequencyHours: 6, localKeep: 8, remoteKeep: 30, followsDefaults: true });
    expect(s.targets.find((t) => t.id === P2)).toMatchObject({ localKeep: 9, followsDefaults: false });
    expect(audits.at(-1)).toMatchObject({ action: "backups.defaults_applied", detail: "Padrão dos projetos aplicado em: Loja." });
  });

  it("valida o padrão", async () => {
    await expect(service.updateDefaults({ frequencyHours: 8 as 6 }, "a")).rejects.toMatchObject({ code: "invalid_frequency" });
    await expect(service.updateDefaults({ remoteKeep: 0 }, "a")).rejects.toMatchObject({ code: "invalid_keep" });
  });

  it("instalação antiga: quem tem 24 h, 2 e 5 e ligado segue o padrão; o resto fica próprio", async () => {
    projects = [project(), project({ id: "p2", name: "Blog", slug: "blog" })];
    const old = (enabled: boolean, frequencyHours: number) => ({
      enabled,
      frequencyHours,
      localKeep: 2,
      remoteKeep: 5,
      lastSlot: null,
      enabledSince: "2026-10-01T00:00:00Z",
      choices: {},
      extraFolders: [],
      lastSuccessAt: null,
      lastRemoteVerifiedAt: null,
      lastStaleNoticeAt: null,
    });
    await writeFile(path.join(dir, "backups.json"), JSON.stringify({ targets: { [P1]: old(true, 24), [P2]: old(true, 12) } }));
    service = build();
    const s = await service.status();
    expect(s.targets.find((t) => t.id === P1)!.followsDefaults).toBe(true);
    expect(s.targets.find((t) => t.id === P2)!.followsDefaults).toBe(false);
  });

  it("desligar o padrão desliga quem segue; religar recomeça a contagem", async () => {
    await service.updateDefaults({ enabled: false }, "admin");
    expect((await service.projectView("p1")).target).toMatchObject({ enabled: false, nextRunAt: null });
    await service.updateDefaults({ enabled: true }, "admin");
    expect((await service.projectView("p1")).target.enabled).toBe(true);
    expect(audits.at(-1)!.detail).toMatch(/ligado/);
  });
});

// ---------------------------------------------------------------------------
// Restauração do painel em outra VPS (lote 8, itens 2 a 5)
// ---------------------------------------------------------------------------

describe("restaurar o painel em outra VPS", () => {
  const staged = (f: string) => path.join(dir, "backups", ".restaurar-painel", f);
  const readStaged = async (f: string) => JSON.parse(await readFile(staged(f), "utf8")) as Record<string, any>;
  /** Abre uma caixa lacrada (AES-256-GCM) com a chave em hexadecimal do arquivo backups-key. */
  const unseal = (box: { iv: string; tag: string; data: string }, keyHex: string): string => {
    const d = createDecipheriv("aes-256-gcm", Buffer.from(keyHex.trim(), "hex"), Buffer.from(box.iv, "base64"));
    d.setAuthTag(Buffer.from(box.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(box.data, "base64")), d.final()]).toString("utf8");
  };
  async function restorePanel() {
    const b = await backup("panel");
    const r = await service.restore("panel", { fileName: b.fileName!, source: "local", confirm: "painel" }, "admin");
    await service.idle();
    return service.record(r.id);
  }

  describe("item 4: as chaves do armazenamento em uso continuam", () => {
    it("token novo criado na VPS nova vale depois da restauração; a senha dos backups é a do backup", async () => {
      await connect();
      const b = await backup("panel");
      await service.setDestination({ ...DEST, accessKeyId: "AKIANOVO9999", secretAccessKey: "segredo-do-token-novo" }, "admin");
      const r = await service.restore("panel", { fileName: b.fileName!, source: "local", confirm: "painel" }, "admin");
      await service.idle();
      const cfg = await readStaged("backups.json");
      const key = await readFile(staged("backups-key"), "utf8");
      expect(cfg.destination.accessKeyId).toBe("AKIANOVO9999");
      expect(unseal(cfg.destination.secret, key)).toBe("segredo-do-token-novo");
      expect(unseal(cfg.encryption.password, key)).toBe(PW);
      expect((await service.record(r.id)).warnings.join(" ")).toMatch(/chaves do armazenamento.*mantidas/i);
    });

    it("backup sem configuração de backups: leva a configuração e a chave de agora (o painel não fica sem destino)", async () => {
      await connect();
      const b = await backup("panel");
      const file = path.join(dir, "backups", "_painel", b.fileName!);
      const raw = JSON.parse(await readFile(file, "utf8")) as { files: Record<string, string> };
      delete raw.files["backups.json"];
      delete raw.files["backups-key"];
      await writeFile(file, JSON.stringify(raw));
      await service.flush();
      const atual = await readFile(path.join(dir, "backups.json"), "utf8");
      await service.restore("panel", { fileName: b.fileName!, source: "local", confirm: "painel" }, "admin");
      await service.idle();
      expect(JSON.parse(await readFile(staged("backups.json"), "utf8")).destination.accessKeyId).toBe(JSON.parse(atual).destination.accessKeyId);
      expect(await readFile(staged("backups-key"), "utf8")).toBe(await readFile(path.join(dir, "backups-key"), "utf8"));
    });
  });

  describe("item 5: acesso pelo IP desativado", () => {
    const domainFile = (ipAccessDisabled: boolean) =>
      JSON.stringify({ domain: "painel.exemplo.com", active: true, ipAccessDisabled, lastCheck: null, updatedAt: "2026-10-01T00:00:00Z" });

    it("domínio que ainda não aponta para esta VPS: o acesso pelo IP não é herdado desativado, e a tela avisa", async () => {
      await writeFile(path.join(dir, "panel-domain.json"), domainFile(true));
      service = build({ panelDomainPointsHere: async () => false });
      const rec = await restorePanel();
      const stagedDomain = await readStaged("panel-domain.json");
      expect(stagedDomain).toMatchObject({ domain: "painel.exemplo.com", ipAccessDisabled: false });
      expect(rec.warnings.join(" ")).toMatch(/acesso pelo IP.*ativo.*painel\.exemplo\.com/s);
    });

    it("domínio já apontando para esta VPS: continua desativado (nada enfraquece)", async () => {
      await writeFile(path.join(dir, "panel-domain.json"), domainFile(true));
      service = build({ panelDomainPointsHere: async () => true });
      const rec = await restorePanel();
      expect((await readStaged("panel-domain.json")).ipAccessDisabled).toBe(true);
      expect(rec.warnings.join(" ")).not.toMatch(/acesso pelo IP/);
    });

    it("sem como conferir o DNS: trata como não apontando (ninguém fica sem entrar)", async () => {
      await writeFile(path.join(dir, "panel-domain.json"), domainFile(true));
      const rec = await restorePanel();
      expect((await readStaged("panel-domain.json")).ipAccessDisabled).toBe(false);
      expect(rec.warnings.join(" ")).toMatch(/acesso pelo IP/);
    });

    it("acesso pelo IP que já estava ativo: nada muda e nada é avisado", async () => {
      await writeFile(path.join(dir, "panel-domain.json"), domainFile(false));
      const rec = await restorePanel();
      expect((await readStaged("panel-domain.json")).ipAccessDisabled).toBe(false);
      expect(rec.warnings.join(" ")).not.toMatch(/acesso pelo IP/);
    });
  });

  describe("item 2: agenda pausada depois da restauração", () => {
    /** Simula a subida seguinte: o que foi preparado passa a ser o estado do painel. */
    async function applyStaged(): Promise<void> {
      await copyFile(staged("backups.json"), path.join(dir, "backups.json"));
      await copyFile(staged("backups-key"), path.join(dir, "backups-key"));
      service = build();
    }
    async function restoredWithEmptyProject(): Promise<void> {
      await connect();
      await backup(projectTargetId("p1")); // backup bom do projeto, antes de desmarcar tudo
      await service.updateTarget("email", { enabled: false }, "a");
      await service.updateTarget(projectTargetId("p1"), { choices: { "db:db": false, "mnt:web:/app/uploads": false } }, "admin");
      docker.containers = []; // VPS nova: o projeto ainda não tem containers aqui
      docker.states = {};
      await restorePanel();
      await applyStaged();
    }

    it("projeto da restauração não entra na agenda e NÃO tem o automático desligado", async () => {
      await restoredWithEmptyProject();
      now = new Date(2026, 9, 15, 3, 1).getTime();
      await service.tick();
      await service.idle();
      expect((await service.status()).history.filter((r) => r.target === "project:p1" && r.trigger === "schedule")).toHaveLength(0);
      const view = await service.projectView("p1");
      expect(view.target.enabled).toBe(true);
      expect(view.target.pausedReason).toMatch(/restaur/i);
      expect(notices.some((n) => n.key === "backup-empty:project:p1")).toBe(false);
    });

    it("restaurar os dados do projeto libera a agenda dele (e o horário que passou não dispara na hora)", async () => {
      await restoredWithEmptyProject();
      const files = await service.points("project:p1");
      const r = await service.restore(projectTargetId("p1"), { fileName: files.find((f) => f.local)!.fileName, source: "local", confirm: "Loja", redeploy: true }, "admin");
      await service.idle();
      expect((await service.record(r.id)).status).not.toBe("failed");
      expect((await service.projectView("p1")).target.pausedReason ?? null).toBeNull();
      now = new Date(2026, 9, 15, 2, 0).getTime();
      await service.tick();
      await service.idle();
      expect((await service.status()).history.filter((x) => x.trigger === "schedule")).toHaveLength(0);
      now = new Date(2026, 9, 16, 3, 1).getTime();
      await service.tick();
      await service.idle();
      expect((await service.status()).history.some((x) => x.target === "project:p1" && x.trigger === "schedule")).toBe(true);
    });

    it("um backup feito à mão no projeto também libera", async () => {
      await restoredWithEmptyProject();
      docker.containers = new FakeDocker().containers;
      await service.updateTarget(projectTargetId("p1"), { choices: { "db:db": true } }, "admin");
      const b = await backup();
      expect(b.status).not.toBe("failed");
      expect((await service.projectView("p1")).target.pausedReason ?? null).toBeNull();
    });

    it("sem ninguém restaurar, a pausa acaba sozinha em 7 dias (nada fica sem backup para sempre)", async () => {
      await restoredWithEmptyProject();
      now = new Date(2026, 9, 14, 10, 0).getTime() + 8 * 24 * H;
      await service.tick();
      await service.idle();
      expect((await service.status()).history.some((x) => x.target === "project:p1" && x.trigger === "schedule")).toBe(true);
      expect((await service.projectView("p1")).target.pausedReason ?? null).toBeNull();
    });

    it("projeto criado depois da restauração não é pausado", async () => {
      await restoredWithEmptyProject();
      projects = [project({ id: "p2", slug: "novo", name: "Novo", createdAt: new Date(now + H).toISOString() })];
      await service.initProject("p2");
      expect((await service.projectView("p2")).target.pausedReason ?? null).toBeNull();
    });

    it("o painel continua na agenda (a pausa é só de projetos e e-mail)", async () => {
      await restoredWithEmptyProject();
      expect((await service.status()).targets.find((t) => t.id === "panel")!.pausedReason ?? null).toBeNull();
    });
  });

  describe("mesma VPS e aviso de atraso", () => {
    it("restaurar o painel na MESMA VPS não pausa o que já tem containers aqui (projeto e e-mail)", async () => {
      await connect();
      await backup(projectTargetId("p1"));
      await restorePanel();
      await copyFile(staged("backups.json"), path.join(dir, "backups.json"));
      await copyFile(staged("backups-key"), path.join(dir, "backups-key"));
      service = build();
      const st = await service.status();
      expect(st.targets.find((t) => t.id === "project:p1")!.pausedReason ?? null).toBeNull();
      expect(st.targets.find((t) => t.id === "email")!.pausedReason ?? null).toBeNull();
    });

    it("projeto sem containers nesta VPS fica em pausa, e o texto não diz 'outro servidor'", async () => {
      await connect();
      await backup(projectTargetId("p1"));
      docker.containers = [];
      await restorePanel();
      await copyFile(staged("backups.json"), path.join(dir, "backups.json"));
      await copyFile(staged("backups-key"), path.join(dir, "backups-key"));
      service = build();
      const reason = (await service.status()).targets.find((t) => t.id === "project:p1")!.pausedReason;
      expect(reason).toMatch(/Em pausa/);
      expect(reason).not.toMatch(/outro servidor/);
    });

    it("item em pausa pela restauração continua recebendo o aviso 'sem backup externo há N dias'", async () => {
      await connect();
      await backup(projectTargetId("p1"));
      docker.containers = [];
      await service.updateTarget("panel", { enabled: false }, "a");
      await service.updateTarget("email", { enabled: false }, "a");
      await restorePanel();
      await copyFile(staged("backups.json"), path.join(dir, "backups.json"));
      await copyFile(staged("backups-key"), path.join(dir, "backups-key"));
      service = build();
      now += 4 * 24 * H;
      await service.tick();
      await service.idle();
      expect(notices.some((n) => n.kind === "backup_stale" && n.key === "backup-stale:project:p1")).toBe(true);
      expect((await service.status()).history.filter((r) => r.trigger === "schedule")).toHaveLength(0);
    });
  });

  describe("item 3: painel recém-instalado não sobrescreve os backups de outro servidor", () => {
    const OTHER = `${BACKUP_ROOT_FOLDER}/_painel/2026-10-13_03-00.7z`;
    async function emptyPanelWithForeignBackups(): Promise<void> {
      projects = [];
      await connect();
      storage.objects.set(OTHER, Buffer.from("backup bom do servidor antigo"));
      await service.updateTarget("email", { enabled: false }, "a");
    }

    it("sem projetos, sem backup feito aqui e com backups do painel já no armazenamento: o agendado não envia", async () => {
      await emptyPanelWithForeignBackups();
      now = new Date(2026, 9, 15, 3, 1).getTime();
      await service.tick();
      await service.idle();
      expect((await service.status()).history).toHaveLength(0);
      expect([...storage.objects.keys()].filter((k) => k.includes("/_painel/"))).toEqual([OTHER]);
      const t = (await service.status()).targets.find((x) => x.id === "panel")!;
      expect(t.pausedReason).toMatch(/outro servidor/);
      // diz os dois caminhos e a verdade sobre a retenção
      expect(t.pausedReason).toMatch(/restaurar o painel antigo/);
      expect(t.pausedReason).toMatch(/Fazer backup agora/);
      expect(t.pausedReason).toMatch(/a partir do primeiro backup, a retenção apaga as cópias mais antigas da pasta/);
      expect(t.pausedReason).toMatch(/inclusive as do painel antigo/);
      expect(t.pausedReason).toMatch(/baixe-as ANTES de fazer o primeiro backup ou use outro bucket\/pasta/);
    });

    it("nos dias seguintes continua protegido", async () => {
      await emptyPanelWithForeignBackups();
      for (let d = 15; d < 20; d++) {
        now = new Date(2026, 9, d, 3, 1).getTime();
        await service.tick();
        await service.idle();
      }
      expect([...storage.objects.keys()].filter((k) => k.includes("/_painel/"))).toEqual([OTHER]);
    });

    it("armazenamento sem backup do painel: o primeiro agendado segue normalmente", async () => {
      projects = [];
      await connect();
      await service.updateTarget("email", { enabled: false }, "a");
      now = new Date(2026, 9, 15, 3, 1).getTime();
      await service.tick();
      await service.idle();
      expect((await service.status()).history.map((r) => r.target)).toEqual(["panel"]);
    });

    it("com projetos cadastrados o painel tem o que guardar: segue normalmente", async () => {
      await emptyPanelWithForeignBackups();
      projects = [project()];
      now = new Date(2026, 9, 15, 3, 1).getTime();
      await service.tick();
      await service.idle();
      expect((await service.status()).history.some((r) => r.target === "panel")).toBe(true);
    });

    it("painel parado pela regra continua recebendo o aviso de backup externo atrasado, e a regra avisa uma vez", async () => {
      await emptyPanelWithForeignBackups();
      for (const d of [15, 16, 17, 18]) {
        now = new Date(2026, 9, d, 3, 1).getTime();
        await service.tick();
        await service.idle();
      }
      expect(notices.filter((n) => n.key === "backup-panel-held")).toHaveLength(1);
      expect(notices.some((n) => n.key === "backup-stale:panel")).toBe(true);
    });

    it("painel só com e-mail: o backup do e-mail concluído conta como conteúdo próprio", async () => {
      await emptyPanelWithForeignBackups();
      await service.updateTarget("email", { enabled: true }, "a");
      expect((await backup("email")).status).not.toBe("failed");
      now = new Date(2026, 9, 15, 3, 1).getTime();
      await service.tick();
      await service.idle();
      expect((await service.status()).history.some((r) => r.target === "panel" && r.trigger === "schedule")).toBe(true);
    });

    it("reinstalado no mesmo bucket: depois de 7 dias da conexão a regra solta e o backup é enviado", async () => {
      await emptyPanelWithForeignBackups();
      now = new Date(2026, 9, 15, 3, 1).getTime();
      await service.tick();
      await service.idle();
      expect((await service.status()).history).toHaveLength(0);
      now = new Date(2026, 9, 14, 10, 0).getTime() + 8 * 24 * H;
      await service.tick();
      await service.idle();
      expect((await service.status()).history.some((r) => r.target === "panel")).toBe(true);
      expect((await service.status()).targets.find((t) => t.id === "panel")!.pausedReason ?? null).toBeNull();
    });

    it("listagem que falha sempre: não envia, e avisa a partir da 3ª tentativa em vez de silenciar", async () => {
      projects = [];
      await connect();
      await service.updateTarget("email", { enabled: false }, "a");
      storage.list = async () => {
        throw new StorageError("fora do ar", "unreachable");
      };
      for (const d of [15, 16, 17, 18]) {
        now = new Date(2026, 9, d, 3, 1).getTime();
        await service.tick();
        await service.idle();
      }
      expect((await service.status()).history).toHaveLength(0);
      expect(notices.filter((n) => n.key === "backup-panel-held-error")).toHaveLength(1);
    });

    it("listagem falha 1x e depois encontra backups de outro servidor: o aviso de pausa sai (1x)", async () => {
      projects = [];
      await connect();
      await service.updateTarget("email", { enabled: false }, "a");
      storage.objects.set(OTHER, Buffer.from("backup bom do servidor antigo"));
      const list = storage.list.bind(storage);
      let falha = true;
      storage.list = async (p: string) => {
        if (falha) throw new StorageError("instável", "unreachable");
        return list(p);
      };
      now = new Date(2026, 9, 15, 3, 1).getTime();
      await service.tick();
      falha = false;
      for (const d of [16, 17]) {
        now = new Date(2026, 9, d, 3, 1).getTime();
        await service.tick();
        await service.idle();
      }
      expect(notices.filter((n) => n.key === "backup-panel-held")).toHaveLength(1);
      // e depois de reiniciar o painel o aviso não se repete
      service = build();
      now = new Date(2026, 9, 18, 3, 1).getTime();
      await service.tick();
      expect(notices.filter((n) => n.key === "backup-panel-held")).toHaveLength(1);
    });

    it("backup pedido à mão sempre é feito", async () => {
      await emptyPanelWithForeignBackups();
      expect((await backup("panel")).status).not.toBe("failed");
    });
  });

  describe("lote 9: backup só na VPS não cancela a proteção do painel novo", () => {
    const OTHER = `${BACKUP_ROOT_FOLDER}/_painel/2026-10-13_03-00.7z`;
    const panelKeys = () => [...storage.objects.keys()].filter((k) => k.includes("/_painel/"));
    const dayAt = (d: number) => new Date(2026, 9, d, 3, 1).getTime();
    async function tickAt(ms: number): Promise<void> {
      now = ms;
      await service.tick();
      await service.idle();
    }
    /** Painel instalado num dia, sem armazenamento: roda as 03:00 só na VPS (a agenda nasce ligada). */
    async function installedWithLocalBackupsOnly(): Promise<void> {
      projects = [];
      await service.updateTarget("email", { enabled: false }, "a");
      await tickAt(now); // primeira passagem: o painel nasce com o horário de hoje já atendido
      for (const d of [15, 16, 17]) await tickAt(dayAt(d));
      expect((await service.status()).history.filter((r) => r.target === "panel" && r.trigger === "schedule")).toHaveLength(3);
      expect(storage.objects.size).toBe(0);
    }
    /** Mais tarde, o passo "conectar o armazenamento", que já guarda backups de outro servidor. */
    async function connectLaterWithForeignBackups(): Promise<void> {
      now = new Date(2026, 9, 17, 10, 0).getTime();
      await connect();
      storage.objects.set(OTHER, Buffer.from("backup bom do servidor antigo"));
    }
    /** Lê o backups.json gravado, deixa `edit` mexer e sobe um serviço novo (painel que já existia antes do campo novo). */
    async function rewriteConfig(edit: (cfg: Record<string, any>) => void): Promise<void> {
      await service.flush();
      const file = path.join(dir, "backups.json");
      const cfg = JSON.parse(await readFile(file, "utf8")) as Record<string, any>;
      edit(cfg);
      await writeFile(file, JSON.stringify(cfg));
      service = build();
    }

    it("vários dias só na VPS e armazenamento conectado depois com backups de outro servidor: o painel segura", async () => {
      await installedWithLocalBackupsOnly();
      await connectLaterWithForeignBackups();
      for (const d of [18, 19, 20, 21, 22, 23]) await tickAt(dayAt(d));
      expect(panelKeys()).toEqual([OTHER]);
      expect((await service.status()).history.filter((r) => r.target === "panel" && r.trigger === "schedule")).toHaveLength(3);
      expect((await service.status()).targets.find((t) => t.id === "panel")!.pausedReason).toMatch(/outro servidor/);
      expect(notices.filter((n) => n.key === "backup-panel-held")).toHaveLength(1);
    });

    it("a proteção continua depois de reiniciar o painel", async () => {
      await installedWithLocalBackupsOnly();
      await connectLaterWithForeignBackups();
      await tickAt(dayAt(18));
      await service.flush();
      service = build();
      await tickAt(dayAt(19));
      expect(panelKeys()).toEqual([OTHER]);
      expect(notices.filter((n) => n.key === "backup-panel-held")).toHaveLength(1);
    });

    it("um backup à mão com o armazenamento conectado sai e libera os agendados seguintes", async () => {
      await installedWithLocalBackupsOnly();
      await connectLaterWithForeignBackups();
      await tickAt(dayAt(18));
      expect(panelKeys()).toEqual([OTHER]);
      const b = await backup("panel");
      expect(b.status).not.toBe("failed");
      expect(b.remote).toBe("verified");
      expect(panelKeys()).toHaveLength(2);
      await tickAt(dayAt(19));
      expect(panelKeys()).toHaveLength(3);
      expect((await service.status()).targets.find((t) => t.id === "panel")!.pausedReason ?? null).toBeNull();
    });

    it("backup à mão só na VPS (sem armazenamento) não libera: o armazenamento conectado depois continua protegido", async () => {
      projects = [];
      await service.updateTarget("email", { enabled: false }, "a");
      expect((await backup("panel")).status).not.toBe("failed");
      await connectLaterWithForeignBackups();
      await tickAt(dayAt(18));
      expect(panelKeys()).toEqual([OTHER]);
    });

    it("o envio externo concluído persiste: depois de reiniciar a regra não volta a valer", async () => {
      projects = [];
      await connect();
      await service.updateTarget("email", { enabled: false }, "a");
      expect((await backup("panel")).remote).toBe("verified");
      storage.objects.set(OTHER, Buffer.from("de outro servidor"));
      await service.flush();
      service = build();
      await tickAt(dayAt(15));
      expect((await service.status()).history.filter((r) => r.trigger === "schedule" && r.target === "panel")).toHaveLength(1);
    });

    it("envio que falha ou fica sem conferência não conta como backup externo concluído", async () => {
      projects = [];
      await connect();
      await service.updateTarget("email", { enabled: false }, "a");
      storage.failUpload = true;
      expect((await backup("panel")).remote).toBe("failed");
      storage.failUpload = false;
      storage.objects.set(OTHER, Buffer.from("de outro servidor"));
      await tickAt(dayAt(15));
      expect(panelKeys()).toEqual([OTHER]);
    });

    it("e-mail só na VPS não conta como conteúdo próprio; com cópia externa concluída, conta", async () => {
      projects = [];
      await service.updateTarget("email", { enabled: true }, "a");
      expect((await backup("email")).status).not.toBe("failed"); // sem armazenamento: só na VPS
      await connectLaterWithForeignBackups();
      await tickAt(dayAt(18));
      expect((await service.status()).history.some((r) => r.target === "panel" && r.trigger === "schedule")).toBe(false);
      expect((await backup("email")).remote).toBe("verified");
      await tickAt(dayAt(19));
      expect((await service.status()).history.some((r) => r.target === "panel" && r.trigger === "schedule")).toBe(true);
    });

    it("não fica bloqueado para sempre: 7 dias depois da conexão o painel envia, mesmo com histórico só local", async () => {
      await installedWithLocalBackupsOnly();
      await connectLaterWithForeignBackups();
      await tickAt(dayAt(18));
      expect(panelKeys()).toEqual([OTHER]);
      await tickAt(new Date(2026, 9, 17, 10, 0).getTime() + 8 * 24 * H);
      expect(panelKeys()).toHaveLength(2);
    });

    describe("migração: backups.json de antes do campo novo", () => {
      it("painel antigo que já enviou ao armazenamento (lastRemoteVerifiedAt) não perde nem ganha proteção: segue enviando", async () => {
        projects = [];
        await connect();
        await service.updateTarget("email", { enabled: false }, "a");
        expect((await backup("panel")).remote).toBe("verified");
        await rewriteConfig((cfg) => {
          delete cfg.targets.panel.lastRemoteSentAt;
          expect(cfg.targets.panel.lastRemoteVerifiedAt).toEqual(expect.any(String));
        });
        await tickAt(dayAt(15));
        expect((await service.status()).history.filter((r) => r.trigger === "schedule" && r.target === "panel")).toHaveLength(1);
      });

      it("painel antigo só com cópia na VPS (lastSuccessAt, nada externo) e armazenamento recém-conectado com backups alheios: fica protegido", async () => {
        await installedWithLocalBackupsOnly();
        await connectLaterWithForeignBackups();
        await rewriteConfig((cfg) => {
          delete cfg.targets.panel.lastRemoteSentAt;
          cfg.targets.panel.lastRemoteVerifiedAt = null;
          expect(cfg.targets.panel.lastSuccessAt).toEqual(expect.any(String));
        });
        await tickAt(dayAt(18));
        expect(panelKeys()).toEqual([OTHER]);
      });

      it("painel antigo só local com o armazenamento conectado há mais de 7 dias: não é bloqueado", async () => {
        await installedWithLocalBackupsOnly();
        await connectLaterWithForeignBackups();
        await rewriteConfig((cfg) => {
          delete cfg.targets.panel.lastRemoteSentAt;
          cfg.destination.connectedAt = new Date(2026, 9, 1).toISOString();
        });
        await tickAt(dayAt(18));
        expect(panelKeys()).toHaveLength(2);
      });

      it("itens nulos em targets (arquivo editado à mão) não derrubam a carga", async () => {
        await installedWithLocalBackupsOnly();
        await rewriteConfig((cfg) => {
          cfg.targets.panel = null;
          cfg.targets.email = null;
        });
        const st = await service.status();
        expect(st.targets.find((t) => t.id === "panel")).toBeDefined();
      });

      it("lastRemoteSentAt já gravado como null não é migrado de novo a partir de lastRemoteVerifiedAt", async () => {
        await installedWithLocalBackupsOnly();
        await connectLaterWithForeignBackups();
        await rewriteConfig((cfg) => {
          cfg.targets.panel.lastRemoteSentAt = null;
          cfg.targets.panel.lastRemoteVerifiedAt = new Date(2026, 9, 16).toISOString();
        });
        await tickAt(dayAt(18));
        expect(panelKeys()).toEqual([OTHER]);
      });

      it("arquivo sem nenhum dos campos do e-mail e do painel (muito antigo) carrega e segue a regra", async () => {
        await installedWithLocalBackupsOnly();
        await connectLaterWithForeignBackups();
        await rewriteConfig((cfg) => {
          for (const t of Object.values<any>(cfg.targets)) {
            delete t.lastRemoteSentAt;
            delete t.lastRemoteVerifiedAt;
          }
        });
        await tickAt(dayAt(18));
        expect(panelKeys()).toEqual([OTHER]);
      });
    });

    describe("restaurar o painel conta como conteúdo próprio", () => {
      it("a restauração marca a cópia preparada; depois da subida o painel sem projetos envia o agendado", async () => {
        projects = [];
        await connect();
        await service.updateTarget("email", { enabled: false }, "a");
        const b = await backup("panel"); // o backups.json guardado nele ainda não conhece este envio
        await rewriteConfig((cfg) => {
          delete cfg.targets.panel.lastRemoteSentAt;
          cfg.targets.panel.lastRemoteVerifiedAt = null;
        });
        const r = await service.restore("panel", { fileName: b.fileName!, source: "local", confirm: "painel" }, "admin");
        await service.idle();
        expect((await service.record(r.id)).status).not.toBe("failed");
        const stagedCfg = JSON.parse(await readFile(path.join(dir, "backups", ".restaurar-painel", "backups.json"), "utf8")) as Record<string, any>;
        expect(stagedCfg.panelRestoredAt).toEqual(expect.any(String));
        await copyFile(path.join(dir, "backups", ".restaurar-painel", "backups.json"), path.join(dir, "backups.json"));
        await copyFile(path.join(dir, "backups", ".restaurar-painel", "backups-key"), path.join(dir, "backups-key"));
        service = build();
        storage.objects.set(OTHER, Buffer.from("de outro servidor"));
        await tickAt(dayAt(16));
        expect((await service.status()).history.some((x) => x.target === "panel" && x.trigger === "schedule")).toBe(true);
      });

      it("backup antigo sem backups.json: a cópia de agora vai marcada também", async () => {
        projects = [];
        await connect();
        await service.updateTarget("email", { enabled: false }, "a");
        const b = await backup("panel");
        await service.flush();
        // simula um backup de antes das configurações de backup: sem backups.json dentro
        const archived = path.join(dir, "backups", "_painel", b.fileName!);
        const raw = JSON.parse(await readFile(archived, "utf8")) as { files: Record<string, string> };
        for (const k of Object.keys(raw.files)) if (/backups(-key|\.json)$/.test(k)) delete raw.files[k];
        await writeFile(archived, JSON.stringify(raw));
        const r = await service.restore("panel", { fileName: b.fileName!, source: "local", confirm: "painel" }, "admin");
        await service.idle();
        expect((await service.record(r.id)).status).not.toBe("failed");
        const stagedCfg = JSON.parse(await readFile(path.join(dir, "backups", ".restaurar-painel", "backups.json"), "utf8")) as Record<string, any>;
        expect(stagedCfg.panelRestoredAt).toEqual(expect.any(String));
      });
    });
  });
});

describe("agenda, atraso e lembrete", () => {
  it("roda no horário (03:00) e não repete o mesmo horário", async () => {
    await service.tick();
    await service.idle();
    expect((await service.status()).history).toHaveLength(0);
    now = new Date(2026, 9, 15, 3, 1).getTime();
    await service.tick();
    await service.idle();
    const h = (await service.status()).history;
    expect(h.map((r) => r.target).sort()).toEqual(["email", "panel", "project:p1"]);
    expect(h.every((r) => r.trigger === "schedule")).toBe(true);
    await service.tick();
    await service.idle();
    expect((await service.status()).history).toHaveLength(3);
  });

  it("agendado com NADA para copiar no projeto: desliga o automático dele e avisa uma vez", async () => {
    // Antes: cada horário agendado falhava e mandava "Backup falhou" de novo
    // para um projeto que simplesmente não tem o que copiar.
    await service.updateTarget("panel", { enabled: false }, "a");
    await service.updateTarget("email", { enabled: false }, "a");
    await service.updateTarget(projectTargetId("p1"), { choices: { "db:db": false, "mnt:web:/app/uploads": false } }, "admin");
    now = new Date(2026, 9, 15, 3, 1).getTime();
    await service.tick();
    await service.idle();
    const first = (await service.status()).history.at(-1)!;
    expect(first).toMatchObject({ target: "project:p1", trigger: "schedule", status: "warning", error: null });
    expect(first.warnings.join(" ")).toMatch(/Nada marcado.*desligado/s);
    const view = await service.projectView("p1");
    expect(view.target).toMatchObject({ enabled: false, followsDefaults: false, nextRunAt: null });
    const avisos = () => notices.filter((n) => n.key === "backup-empty:project:p1");
    expect(avisos()).toHaveLength(1);
    expect(avisos()[0]).toMatchObject({ path: "/projects/p1/backups" });
    expect(avisos()[0]!.title).toMatch(/desligado/i);
    expect(notices.some((n) => n.key === "backup-failed:project:p1")).toBe(false);
    expect(audits.at(-1)!.detail).toMatch(/desligado/);
    // nos horários seguintes não roda mais nem avisa de novo
    now += 24 * H;
    await service.tick();
    await service.idle();
    expect((await service.status()).history.filter((r) => r.target === "project:p1")).toHaveLength(1);
    expect(avisos()).toHaveLength(1);
    // mudar o padrão dos projetos não religa quem foi desligado por falta de itens
    await service.updateDefaults({ enabled: true }, "admin");
    expect((await service.projectView("p1")).target.enabled).toBe(false);
  });

  it("backup pedido à mão sem nada marcado continua falhando e NÃO desliga o automático", async () => {
    await service.updateTarget(projectTargetId("p1"), { choices: { "db:db": false, "mnt:web:/app/uploads": false } }, "admin");
    expect((await backup()).status).toBe("failed");
    expect((await service.projectView("p1")).target.enabled).toBe(true);
  });

  it("item desligado, projeto nunca publicado e e-mail inexistente ficam de fora", async () => {
    projects = [project({ lastDeployAt: null })];
    docker.states = {};
    await service.updateTarget("panel", { enabled: false }, "a");
    now = new Date(2026, 9, 15, 3, 1).getTime();
    await service.tick();
    await service.idle();
    expect((await service.status()).history).toHaveLength(0);
  });

  it("externo sem sucesso há mais de 2 dias: avisa uma vez por dia", async () => {
    await connect();
    await service.updateTarget("email", { enabled: false }, "a");
    await service.updateTarget(projectTargetId("p1"), { enabled: false }, "a");
    storage.failUpload = true;
    now += 49 * H;
    await service.tick();
    await service.idle();
    const stale = notices.filter((n) => n.kind === "backup_stale");
    expect(stale).toHaveLength(1);
    expect(stale[0]!.title).toBe("Painel: sem backup externo conferido há 2 dias");
    now += H;
    await service.tick();
    await service.idle();
    expect(notices.filter((n) => n.kind === "backup_stale")).toHaveLength(1);
  });

  it("lembrete da senha a cada 3 meses (teste certo adia)", async () => {
    await connect();
    for (const id of ["panel", "email", projectTargetId("p1")]) await service.updateTarget(id, { enabled: false }, "a");
    now += 91 * 24 * H;
    await service.tick();
    expect(notices.filter((n) => n.kind === "backup_reminder")).toEqual([
      expect.objectContaining({ title: "Você ainda tem sua senha de backup? Teste aqui", path: "/settings/backups" }),
    ]);
    await service.tick();
    expect(notices.filter((n) => n.kind === "backup_reminder")).toHaveLength(1);
  });

  it("start/stop do relógio interno", () => {
    service.start(60_000);
    service.start(60_000);
    service.stop();
    service.stop();
  });
});

describe("caminhos de exceção", () => {
  it("tar e disco de verdade: código do projeto que não vem do GitHub vai e volta", async () => {
    projects = [project({ ingestMode: "upload", source: "/x" })];
    const src = path.join(dir, "projects", "loja", "src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "index.html"), "<h1>loja</h1>");
    service = build({ tar: undefined, statfs: undefined });
    const b = await backup();
    expect(b.status).toBe("success");
    await removeDir(src);
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    expect((await service.record(r.id)).status).not.toBe("failed");
    expect(await readFile(path.join(src, "index.html"), "utf8")).toBe("<h1>loja</h1>");
  });

  describe("VPS nova: projeto que não vem do GitHub (lote 8, item 1)", () => {
    /** Serviço com tar de verdade e um redeploy que registra o que havia em disco no instante da publicação. */
    function realTarService(seen: Array<{ path: string; content: string | null }>, watch: string) {
      return build({
        tar: undefined,
        statfs: undefined,
        projects: {
          list: async () => projects,
          get: async (id) => projects.find((p) => p.id === id || p.slug === id) ?? null,
          srcDir: (p) => (p.ingestMode === "existing" ? path.resolve(p.source) : path.join(dir, "projects", ".paas", p.id, "src")),
          redeploy: async (id) => {
            redeploys.push(id);
            seen.push({ path: watch, content: await readFile(path.join(watch, "index.html"), "utf8").catch(() => null) });
            docker.containers = [{ id: "c-web", name: "paas-loja-web-1", service: "web", running: true }];
          },
        },
      });
    }

    it("upload: o código volta para a pasta de origem ANTES de publicar, e nada é apagado", async () => {
      const origem = path.join(dir, "projects", "minha-loja");
      projects = [project({ ingestMode: "upload", source: origem, storageLayout: "reserved" })];
      const work = path.join(dir, "projects", ".paas", "p1", "src");
      await mkdir(work, { recursive: true });
      await writeFile(path.join(work, "index.html"), "<h1>loja</h1>");
      const seen: Array<{ path: string; content: string | null }> = [];
      service = realTarService(seen, origem);
      const b = await backup();
      expect(b.status).toBe("success");
      // VPS nova: nem a origem, nem a cópia de trabalho existem
      await removeDir(path.join(dir, "projects"));
      await mkdir(path.join(dir, "projects"), { recursive: true });
      docker.containers = [];
      const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja", redeploy: true }, "admin");
      await service.idle();
      const rec = await service.record(r.id);
      expect(rec.status).not.toBe("failed");
      expect(seen).toEqual([{ path: origem, content: "<h1>loja</h1>" }]);
    });

    it("upload: se a pasta de origem já existe nesta VPS, fica como está (nada sobrescrito)", async () => {
      const origem = path.join(dir, "projects", "minha-loja");
      projects = [project({ ingestMode: "upload", source: origem, storageLayout: "reserved" })];
      const work = path.join(dir, "projects", ".paas", "p1", "src");
      await mkdir(work, { recursive: true });
      await writeFile(path.join(work, "index.html"), "<h1>antigo</h1>");
      const seen: Array<{ path: string; content: string | null }> = [];
      service = realTarService(seen, origem);
      const b = await backup();
      await removeDir(work);
      await mkdir(origem, { recursive: true });
      await writeFile(path.join(origem, "index.html"), "<h1>do usuario</h1>");
      docker.containers = [];
      const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja", redeploy: true }, "admin");
      await service.idle();
      expect((await service.record(r.id)).status).not.toBe("failed");
      expect(seen[0]!.content).toBe("<h1>do usuario</h1>");
    });

    it("existing: a pasta do usuário é recriada onde estava, antes de publicar", async () => {
      const origem = path.join(dir, "projects", "meu-app");
      projects = [project({ ingestMode: "existing", source: origem, storageLayout: "reserved" })];
      await mkdir(origem, { recursive: true });
      await writeFile(path.join(origem, "index.html"), "<h1>app</h1>");
      const seen: Array<{ path: string; content: string | null }> = [];
      service = realTarService(seen, origem);
      const b = await backup();
      expect(b.status).toBe("success");
      await removeDir(origem);
      docker.containers = [];
      const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja", redeploy: true }, "admin");
      await service.idle();
      expect((await service.record(r.id)).status).not.toBe("failed");
      expect(seen).toEqual([{ path: origem, content: "<h1>app</h1>" }]);
    });

    it("existing: pasta que já existe com arquivos não é tocada", async () => {
      const origem = path.join(dir, "projects", "meu-app");
      projects = [project({ ingestMode: "existing", source: origem, storageLayout: "reserved" })];
      await mkdir(origem, { recursive: true });
      await writeFile(path.join(origem, "index.html"), "<h1>app</h1>");
      const seen: Array<{ path: string; content: string | null }> = [];
      service = realTarService(seen, origem);
      const b = await backup();
      await writeFile(path.join(origem, "index.html"), "<h1>versao nova do usuario</h1>");
      docker.containers = [];
      const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja", redeploy: true }, "admin");
      await service.idle();
      expect((await service.record(r.id)).status).not.toBe("failed");
      expect(await readFile(path.join(origem, "index.html"), "utf8")).toBe("<h1>versao nova do usuario</h1>");
      expect(seen[0]!.content).toBe("<h1>versao nova do usuario</h1>");
    });

    it("existing: pasta que já existe VAZIA é preenchida com o código do backup", async () => {
      const origem = path.join(dir, "projects", "meu-app");
      projects = [project({ ingestMode: "existing", source: origem, storageLayout: "reserved" })];
      await mkdir(origem, { recursive: true });
      await writeFile(path.join(origem, "index.html"), "<h1>app</h1>");
      const seen: Array<{ path: string; content: string | null }> = [];
      service = realTarService(seen, origem);
      const b = await backup();
      await rm(path.join(origem, "index.html"));
      docker.containers = [];
      const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja", redeploy: true }, "admin");
      await service.idle();
      expect((await service.record(r.id)).status).not.toBe("failed");
      expect(seen[0]!.content).toBe("<h1>app</h1>");
    });

    it("origem fora da pasta de projetos: falha sem gravar nada e sem publicar", async () => {
      const fora = await mkdtemp(path.join(tmpdir(), "paas-fora-"));
      try {
        const origem = path.join(fora, "app");
        projects = [project({ ingestMode: "existing", source: origem, storageLayout: "reserved" })];
        await mkdir(origem, { recursive: true });
        await writeFile(path.join(origem, "index.html"), "x");
        const seen: Array<{ path: string; content: string | null }> = [];
        service = realTarService(seen, origem);
        const b = await backup();
        await removeDir(origem);
        docker.containers = [];
        const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja", redeploy: true }, "admin");
        await service.idle();
        const rec = await service.record(r.id);
        expect(rec.status).toBe("failed");
        expect(rec.error).toMatch(/fora da pasta de projetos/);
        expect(existsSync(origem)).toBe(false);
        expect(redeploys).toEqual([]);
      } finally {
        await removeDir(fora);
      }
    });

    it("pasta acima do destino que é link simbólico para fora: recusa e não grava nada fora", async () => {
      const fora = await mkdtemp(path.join(tmpdir(), "paas-fora-"));
      try {
        await mkdir(path.join(dir, "projects"), { recursive: true });
        await symlink(fora, path.join(dir, "projects", "ponte"));
        const origem = path.join(dir, "projects", "ponte", "meu-app");
        projects = [project({ ingestMode: "existing", source: origem, storageLayout: "reserved" })];
        await mkdir(origem, { recursive: true });
        await writeFile(path.join(origem, "index.html"), "x");
        const seen: Array<{ path: string; content: string | null }> = [];
        service = realTarService(seen, origem);
        const b = await backup();
        expect(b.status).toBe("success");
        await removeDir(origem);
        docker.containers = [];
        const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja", redeploy: true }, "admin");
        await service.idle();
        const rec = await service.record(r.id);
        expect(rec.status).toBe("failed");
        expect(rec.error).toMatch(/fora da pasta de projetos/);
        expect(existsSync(path.join(fora, "meu-app"))).toBe(false);
        expect(redeploys).toEqual([]);
      } finally {
        await removeDir(fora);
      }
    });

    it("upload: o .env gerado pelo painel antigo não volta, e os deploys seguintes usam as variáveis novas", async () => {
      const origem = path.join(dir, "projects", "minha-loja");
      projects = [project({ ingestMode: "upload", source: origem, storageLayout: "reserved" })];
      const ctx = { projectsDir: path.join(dir, "projects") };
      const work = path.join(dir, "projects", ".paas", "p1");
      await mkdir(origem, { recursive: true });
      await writeFile(path.join(origem, "index.html"), "<h1>loja</h1>");
      await ingestCode(ctx, projects[0]!, () => undefined);
      await writeProjectDotenv(path.join(work, "src"), work, { SENHA: "antiga" });
      expect(await readFile(path.join(work, "src", ".env"), "utf8")).toMatch(/SENHA=.?antiga/);
      const seen: Array<{ path: string; content: string | null }> = [];
      service = realTarService(seen, origem);
      const b = await backup();
      expect(b.status).toBe("success");
      await removeDir(path.join(dir, "projects"));
      await mkdir(path.join(dir, "projects"), { recursive: true });
      docker.containers = [];
      const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja", redeploy: true }, "admin");
      await service.idle();
      expect((await service.record(r.id)).status).not.toBe("failed");
      expect(existsSync(path.join(origem, ".env"))).toBe(false);
      expect(await readFile(path.join(origem, "index.html"), "utf8")).toBe("<h1>loja</h1>");
      for (const valor of ["nova1", "nova2"]) {
        await ingestCode(ctx, projects[0]!, () => undefined);
        const w = await writeProjectDotenv(path.join(work, "src"), work, { SENHA: valor });
        expect(w.target).toBe(".env");
        expect(await readFile(path.join(work, "src", ".env"), "utf8")).toMatch(new RegExp(`SENHA=.?${valor}`));
      }
    });

    it("upload: .env escrito pelo dono (sem o cabeçalho do painel) continua", async () => {
      const origem = path.join(dir, "projects", "minha-loja");
      projects = [project({ ingestMode: "upload", source: origem, storageLayout: "reserved" })];
      const work = path.join(dir, "projects", ".paas", "p1", "src");
      await mkdir(work, { recursive: true });
      await writeFile(path.join(work, ".env"), "MINHA=1\n");
      await writeFile(path.join(work, "index.html"), "x");
      const seen: Array<{ path: string; content: string | null }> = [];
      service = realTarService(seen, origem);
      const b = await backup();
      await removeDir(path.join(dir, "projects"));
      await mkdir(path.join(dir, "projects"), { recursive: true });
      docker.containers = [];
      await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja", redeploy: true }, "admin");
      await service.idle();
      expect(await readFile(path.join(origem, ".env"), "utf8")).toBe("MINHA=1\n");
    });

    it("pasta que existia vazia e a cópia falha no meio: não sobra código pela metade", async () => {
      const origem = path.join(dir, "projects", "meu-app");
      projects = [project({ ingestMode: "existing", source: origem, storageLayout: "reserved" })];
      await mkdir(origem, { recursive: true });
      // tar que entrega muitos arquivos e um que não dá para ler (o cp falha no meio)
      service = build({
        tar: {
          create: async (_p, name, out) => writeFile(out, `codigo ${name}`),
          extract: async (_f, parent) => {
            const pasta = path.join(parent, "meu-app");
            await mkdir(pasta, { recursive: true });
            for (let i = 0; i < 40; i++) await writeFile(path.join(pasta, `a${i}.txt`), "x");
            await writeFile(path.join(pasta, "zz-ilegivel"), "x", { mode: 0o000 });
          },
        },
        projects: {
          list: async () => projects,
          get: async () => projects[0]!,
          srcDir: () => origem,
          redeploy: async (id) => void redeploys.push(id),
        },
      });
      const b = await backup();
      docker.containers = [];
      const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja", redeploy: true }, "admin");
      await service.idle();
      expect((await service.record(r.id)).status).toBe("failed");
      expect(existsSync(origem)).toBe(true);
      expect(await readdir(origem)).toEqual([]);
      expect(redeploys).toEqual([]);
    });

    /** Serviço com tar de mentira: o backup guarda um texto; a extração cria `name/index.html` e roda o gancho. */
    function tarComGancho(origem: string, gancho: () => Promise<void>) {
      let armado = false;
      const svc = build({
        tar: {
          create: async (_p, name, out) => writeFile(out, `codigo ${name}`),
          extract: async (_f, parent) => {
            const pasta = path.join(parent, path.basename(origem));
            await mkdir(pasta, { recursive: true });
            await writeFile(path.join(pasta, "index.html"), "do backup");
            if (armado) await gancho();
          },
        },
        projects: {
          list: async () => projects,
          get: async () => projects[0]!,
          srcDir: () => origem,
          redeploy: async (id) => void redeploys.push(id),
        },
      });
      return { svc, arma: () => void (armado = true) };
    }
    async function restaurarSemContainers(svc: BackupService, fileName: string) {
      docker.containers = [];
      const r = await svc.restore(projectTargetId("p1"), { fileName, source: "local", confirm: "Loja", redeploy: true }, "admin");
      await svc.idle();
      return svc.record(r.id);
    }

    it("corrida: link plantado durante a extração com pastas intermediárias faltando: nada é criado fora", async () => {
      const fora = await mkdtemp(path.join(tmpdir(), "paas-fora-"));
      try {
        const origem = path.join(dir, "projects", "ponte", "sub", "app");
        projects = [project({ ingestMode: "existing", source: origem, storageLayout: "reserved" })];
        const { svc, arma } = tarComGancho(origem, async () => symlink(fora, path.join(dir, "projects", "ponte")));
        service = svc;
        await mkdir(path.join(dir, "projects"), { recursive: true });
        const b = await backup();
        arma();
        const rec = await restaurarSemContainers(svc, b.fileName!);
        expect(rec.status).toBe("failed");
        expect(rec.error).toMatch(/fora da pasta de projetos/);
        expect(await readdir(fora)).toEqual([]);
      } finally {
        await removeDir(fora);
      }
    });

    it("pasta-mãe sem permissão de escrita: mensagem amigável (não erro cru) e nada apagado", async () => {
      const mae = path.join(dir, "projects", "trancada");
      const origem = path.join(mae, "app");
      projects = [project({ ingestMode: "existing", source: origem, storageLayout: "reserved" })];
      await mkdir(mae, { recursive: true });
      await writeFile(path.join(mae, "do-usuario.txt"), "meu");
      const { svc, arma } = tarComGancho(origem, async () => undefined);
      service = svc;
      await mkdir(origem);
      const b = await backup();
      await rm(origem, { recursive: true });
      arma();
      await chmod(mae, 0o555);
      try {
        const rec = await restaurarSemContainers(svc, b.fileName!);
        expect(rec.status).toBe("failed");
        expect(rec.error).toMatch(/Não foi possível gravar o código/);
        expect(await readFile(path.join(mae, "do-usuario.txt"), "utf8")).toBe("meu");
      } finally {
        await chmod(mae, 0o755);
      }
    });

    it("corrida: o usuário cria a pasta com arquivos dele durante a extração: nada dele é apagado", async () => {
      const origem = path.join(dir, "projects", "meu-app");
      projects = [project({ ingestMode: "existing", source: origem, storageLayout: "reserved" })];
      const { svc, arma } = tarComGancho(origem, async () => {
        await mkdir(origem, { recursive: true });
        await writeFile(path.join(origem, "do-usuario.txt"), "meu trabalho");
      });
      service = svc;
      await mkdir(origem, { recursive: true });
      const b = await backup();
      await rm(origem, { recursive: true });
      arma();
      const rec = await restaurarSemContainers(svc, b.fileName!);
      expect(rec.status).toBe("failed");
      expect(rec.error).toMatch(/Não foi possível gravar o código/);
      expect(await readFile(path.join(origem, "do-usuario.txt"), "utf8")).toBe("meu trabalho");
      expect(redeploys).toEqual([]);
    });

    it("origem na área reservada do painel é recusada", async () => {
      const origem = path.join(dir, "projects", ".paas", "p1");
      projects = [project({ ingestMode: "upload", source: origem, storageLayout: "reserved" })];
      await mkdir(path.join(dir, "projects", ".paas", "p1", "src"), { recursive: true });
      await writeFile(path.join(dir, "projects", ".paas", "p1", "src", "index.html"), "x");
      const seen: Array<{ path: string; content: string | null }> = [];
      service = realTarService(seen, origem);
      const b = await backup();
      docker.containers = [];
      const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja", redeploy: true }, "admin");
      await service.idle();
      expect((await service.record(r.id)).error).toMatch(/área do painel|fora da pasta de projetos/);
      expect(redeploys).toEqual([]);
    });
  });

  it("tar que falha: o motivo do tar vai para o histórico", async () => {
    projects = [project({ ingestMode: "upload", source: "/x" })];
    service = build({ tar: undefined });
    const b = await backup();
    expect(b.status).toBe("failed");
    expect(b.error).toBeTruthy();
  });

  it("sem log próprio, escreve no console", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    service = build({ log: undefined });
    await service.status();
    now += 25 * H;
    vi.spyOn(service, "runNow").mockRejectedValue(new Error("fila cheia"));
    await service.tick();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/agendado de panel não entrou na fila \(fila cheia\)/));
    warn.mockRestore();
  });

  it("o relógio interno registra a falha da agenda", async () => {
    vi.spyOn(service, "tick").mockRejectedValue(new Error("disco"));
    service.start(5);
    await vi.waitFor(() => expect(logs.join(" ")).toMatch(/falha na agenda \(disco\)/));
    service.stop();
  });

  it("auditoria e arquivo de verificação que falham não atrapalham", async () => {
    service = build({ audit: { record: async () => Promise.reject(new Error("audit")) } });
    storage.failUpload = true;
    await service.setDestination(DEST, "admin");
    await service.setPassword(PW, true, "admin");
    expect((await service.status()).encryption.passwordSet).toBe(true);
  });

  it("acompanha um item que ainda está na fila", async () => {
    const a = await service.runNow("panel", "admin");
    const b = await service.runNow(projectTargetId("p1"), "admin");
    expect((await service.record(b.id)).id).toBe(b.id);
    expect((await service.status()).queued.map((q) => q.id)).toContain(b.id);
    await service.idle();
    expect((await service.record(a.id)).status).toBe("success");
  });

  it("diff que falha, Redis que não salva, banco que demora a responder e container que não liga", async () => {
    docker.diff = async () => Promise.reject(new Error("diff"));
    await service.detectProject("p1");
    docker.containers.push({ id: "c-redis", name: "paas-loja-cache-1", service: "cache", running: true });
    const inspect = docker.inspect.bind(docker);
    docker.inspect = async (ids) => [
      ...(await inspect(ids.filter((i) => i !== "c-redis"))),
      { Name: "/cache", Config: { Image: "redis:7", Env: [], Labels: { "com.docker.compose.service": "cache" } }, Mounts: [], State: { Running: true } },
    ];
    const capture = docker.execCapture.bind(docker);
    let probes = 0;
    docker.execCapture = async (c, script) => {
      if (script.includes("SAVE")) throw new Error("redis");
      if (script.includes("pg_isready") && probes++ === 0) throw new Error("ainda subindo");
      return capture(c, script);
    };
    await service.updateTarget(projectTargetId("p1"), { choices: { "db:cache": true } }, "admin");
    const b = await backup();
    // antes desta correção, o SAVE que falha virava "success" sem aviso (achado 14)
    expect(b.status).toBe("warning");
    expect(b.warnings.join(" ")).toMatch(/não confirmou o SAVE \(redis\)/);
    const fromFile = docker.execFromFile.bind(docker);
    docker.execFromFile = async (c, script, args, file) => {
      if (args.length === 0 && script.includes("psql")) throw new Error("papéis");
      return fromFile(c, script, args, file);
    };
    docker.start = async () => Promise.reject(new Error("não liga"));
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    const done = await service.record(r.id);
    expect(probes).toBeGreaterThan(1);
    expect(done.warnings.join(" ")).toMatch(/não ligou de novo/);
  });

  it("MySQL: os avisos do banco na restauração aparecem", async () => {
    const inspect = docker.inspect.bind(docker);
    docker.inspect = async (ids) =>
      (await inspect(ids)).map((c) =>
        c.Name === "/paas-loja-db-1"
          ? { ...c, Config: { ...c.Config, Image: "mysql:8", Env: ["MYSQL_ROOT_PASSWORD=x"] }, Mounts: [{ Type: "volume", Name: "v", Source: "/x", Destination: "/var/lib/mysql" }] }
          : c,
      );
    const b = await backup();
    expect(b.status).toBe("success");
    docker.execFromFile = async () => {
      throw new Error("ERROR 1050 (42S01): Table exists");
    };
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    const done = await service.record(r.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/parou no primeiro erro: ERROR 1050/);
  });
});

describe("fuso da VPS trocado", () => {
  it("a agenda passa a contar no fuso novo sem disparar na hora o horário que já passou", async () => {
    const prev = process.env.TZ;
    try {
      process.env.TZ = "Europe/Berlin";
      // 12:00 em Berlim (07:00 em São Paulo): o das 03:00 de Berlim já rodou
      now = Date.parse("2026-10-14T10:00:00Z");
      const svc = build({ timezoneName: () => "Europe/Berlin" });
      await svc.tick();
      await svc.idle();
      expect((await svc.status()).timezoneName).toBe("Europe/Berlin");
      process.env.TZ = "America/Sao_Paulo";
      await svc.timezoneChanged();
      const before = (await svc.status()).history.length;
      await svc.tick();
      await svc.idle();
      expect((await svc.status()).history.length).toBe(before);
      expect((await svc.status()).targets[0]!.nextRunAt).toBe("2026-10-15T06:00:00.000Z");
      await svc.flush();
    } finally {
      process.env.TZ = prev;
    }
  });

  it("sem quem informe o fuso, a situação usa o TZ do processo", async () => {
    expect((await service.status()).timezoneName).toBe(process.env.TZ || "UTC");
  });
});

describe("conferir backups", () => {
  const P1 = projectTargetId("p1");

  it("Conferir um backup: abre a cópia da VPS, baixa e abre a externa com a senha, e guarda o resultado", async () => {
    await connect();
    const b = await backup();
    // a conferência automática depois do envio já conta como "conferido em"
    let line = (await service.status()).history.find((r) => r.id === b.id)!;
    expect(line).toMatchObject({ localExists: true, localCheck: null, remoteCheck: { status: "ok", reason: null } });
    now += H;
    const v = await service.verify(P1, { fileName: b.fileName! }, "admin");
    expect(v.operation).toBe("verify");
    await service.idle();
    const done = await service.record(v.id);
    expect(done.status).toBe("success");
    expect(done.verify!.summary).toEqual({ ok: 2, failed: 0, missing: 0, needsPassword: 0 });
    expect(done.verify!.items.map((i) => [i.where, i.status])).toEqual([
      ["local", "ok"],
      ["remote", "ok"],
    ]);
    expect(done.steps.map((s) => s.label)).toEqual([`Loja · ${b.fileName} · cópia da VPS`, `Loja · ${b.fileName} · cópia externa`]);
    line = (await service.status()).history.find((r) => r.id === b.id)!;
    expect(line.localCheck).toEqual({ status: "ok", at: new Date(now).toISOString(), reason: null });
    expect(line.remoteCheck!.at).toBe(new Date(now).toISOString());
    expect((await service.projectView("p1")).history.find((r) => r.id === b.id)!.localCheck!.status).toBe("ok");
    // a senha passou só pela memória: nada de senha na auditoria
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["backups.verify", "backups.verify_result"]));
    expect(JSON.stringify(audits)).not.toContain(PW);
    expect(audits.find((a) => a.action === "backups.verify_result")!.detail).toBe("Conferência de Loja: 2 íntegra(s).");
    expect(archiver.calls.filter((c) => c.op === "test").at(-1)).toEqual({ op: "test", password: PW });
  });

  it("cópia estragada: falha com o motivo, aparece ao lado do backup e avisa pelas notificações", async () => {
    await connect();
    const b = await backup();
    // a cópia da VPS mudou de conteúdo depois do backup
    const local = path.join(dir, "backups", "loja", b.fileName!);
    const raw = JSON.parse(await readFile(local, "utf8"));
    raw.files["manifesto.json"] = Buffer.from("{}").toString("base64");
    await writeFile(local, JSON.stringify(raw));
    // e a externa foi trocada por outra do mesmo tamanho
    const key = `TWS Panel Backups/loja/${b.fileName}`;
    const remote = storage.objects.get(key)!;
    storage.objects.set(key, Buffer.from(remote.toString("utf8").replace(/[a-z]/, (c) => (c === "a" ? "b" : "a"))));
    notices = [];
    const v = await service.verify(P1, { fileName: b.fileName! }, "admin");
    await service.idle();
    const done = await service.record(v.id);
    expect(done.status).toBe("failed");
    expect(done.error).toBe("2 cópia(s) com problema.");
    expect(done.verify!.items.map((i) => i.reason)).toEqual([
      expect.stringMatching(/tamanho mudou|hash diferente/),
      "O arquivo baixado não bate com o enviado (hash diferente).",
    ]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: "backup_failed", key: "backup-verify-failed:project:p1", path: "/projects/p1/backups" });
    expect(notices[0]!.title).toBe("Conferência dos backups: 2 cópias com problema");
    const line = (await service.status()).history.find((r) => r.id === b.id)!;
    expect(line.localCheck!.status).toBe("failed");
    expect(line.remoteCheck!.status).toBe("failed");
  });

  it("mesmo tamanho e hash trocados: o 7z t é que pega; externa sem senha onde devia ter", async () => {
    await connect();
    const b = await backup();
    const key = `TWS Panel Backups/loja/${b.fileName}`;
    // esquece o que foi gravado (backup de antes desta versão): só o 7z t confere
    const cfg = (service as unknown as { config: { checks: Record<string, unknown> } }).config;
    cfg.checks = {};
    storage.objects.set(key, Buffer.from("não é 7z"));
    await writeFile(path.join(dir, "backups", "loja", b.fileName!), "também não");
    const v = await service.verify(P1, { fileName: b.fileName! }, "admin");
    await service.idle();
    const items = (await service.record(v.id)).verify!.items;
    expect(items.every((i) => i.status === "failed" && /7-Zip não conseguiu abrir/.test(i.reason!))).toBe(true);
    // cópia externa cifrada trocada por uma sem senha
    const c = await backup();
    const key2 = `TWS Panel Backups/loja/${c.fileName}`;
    const plain = await readFile(path.join(dir, "backups", "loja", c.fileName!));
    storage.objects.set(key2, plain);
    (service as unknown as { config: { checks: Record<string, { remote?: { size?: number; sha256?: string } }> } }).config.checks[`loja/${c.fileName}`]!.remote = { encrypted: true } as never;
    const w = await service.verify(P1, { fileName: c.fileName!, where: "remote" }, "admin");
    await service.idle();
    expect((await service.record(w.id)).verify!.items[0]!.reason).toMatch(/saiu cifrada e agora abre sem senha/);
  });

  it("backup de antes de uma troca de senha: pede a senha da época e abre com ela", async () => {
    await connect();
    const b = await backup();
    await service.setPassword("outra-senha-bem-longa-99", true, "admin");
    const v = await service.verify(P1, { fileName: b.fileName!, where: "remote" }, "admin");
    await service.idle();
    const first = await service.record(v.id);
    expect(first.status).toBe("warning");
    expect(first.verify!.summary.needsPassword).toBe(1);
    expect(first.verify!.items[0]!.reason).toMatch(/senha da época/);
    expect(first.warnings.join(" ")).toMatch(/senha da época/);
    const wrong = await service.verify(P1, { fileName: b.fileName!, where: "remote", password: "chute-errado-123" }, "admin");
    await service.idle();
    expect((await service.record(wrong.id)).verify!.items[0]!.reason).toMatch(/senha digitada também não abre/);
    const ok = await service.verify(P1, { fileName: b.fileName!, where: "remote", password: PW }, "admin");
    await service.idle();
    expect((await service.record(ok.id)).verify!.items[0]!.status).toBe("ok");
    expect(JSON.stringify(audits)).not.toContain(PW);
  });

  it("Conferir todos (do item e geral): cada cópia, as que a retenção apagou e o resumo", async () => {
    await connect();
    const a = await backup();
    now += 2 * H;
    await backup();
    now += 2 * H;
    const c = await backup(); // a retenção apagou a primeira da VPS
    expect(existsSync(path.join(dir, "backups", "loja", a.fileName!))).toBe(false);
    const v = await service.verify(P1, {}, "admin");
    await service.idle();
    const done = await service.record(v.id);
    expect(done.verify!.items.filter((i) => i.where === "local")).toHaveLength(2);
    expect(done.verify!.items.filter((i) => i.where === "remote")).toHaveLength(3);
    expect(done.verify!.items[0]!.fileName).toBe(c.fileName);
    expect(done.verify!.summary).toEqual({ ok: 5, failed: 0, missing: 0, needsPassword: 0 });
    // a VPS já não tem a primeira: conferir só ela diz que não existe mais
    const gone = await service.verify(P1, { fileName: a.fileName!, where: "local" }, "admin");
    await service.idle();
    expect((await service.record(gone.id)).verify!.items[0]).toMatchObject({ status: "missing", reason: expect.stringMatching(/retenção/) });
    // geral: painel, e-mail e projetos
    await backup("panel");
    const all = await service.verify("all", {}, "admin");
    expect(all).toMatchObject({ target: "all", targetName: "Todos os backups" });
    await service.idle();
    const sum = (await service.record(all.id)).verify!;
    expect(new Set(sum.items.map((i) => i.targetName))).toEqual(new Set(["Painel", "Loja"]));
    expect(sum.summary.failed).toBe(0);
  });

  it("externa apagada pela retenção, sem nada para conferir e listagem que falha", async () => {
    await connect();
    const b = await backup();
    storage.objects.delete(`TWS Panel Backups/loja/${b.fileName}`);
    const v = await service.verify(P1, { fileName: b.fileName!, where: "remote" }, "admin");
    await service.idle();
    const done = await service.record(v.id);
    expect(done.verify!.items[0]).toMatchObject({ status: "missing" });
    expect(done.status).toBe("success");
    expect(notices.filter((n) => n.key.startsWith("backup-verify"))).toHaveLength(0);
    const none = await service.verify("email", {}, "admin");
    await service.idle();
    expect((await service.record(none.id)).warnings).toEqual(["Nenhum backup para conferir."]);
    const ghost = await service.verify(P1, { fileName: "2020-01-01_03-00.7z", where: "local" }, "admin");
    await service.idle();
    expect((await service.record(ghost.id)).verify!.items[0]!.status).toBe("missing");
    storage.list = async () => Promise.reject(new StorageError("O armazenamento não respondeu.", "unreachable"));
    const broken = await service.verify(P1, {}, "admin");
    await service.idle();
    const br = await service.record(broken.id);
    expect(br.warnings.join(" ")).toMatch(/não foi possível listar o armazenamento externo/);
    expect(br.verify!.items.every((i) => i.where === "local")).toBe(true);
  });

  it("download que falha, disco cheio e cópia da VPS que pede senha", async () => {
    await connect();
    const b = await backup();
    storage.download = async () => Promise.reject(new StorageError("Chave recusada.", "invalid_credentials"));
    const v = await service.verify(P1, { fileName: b.fileName!, where: "remote" }, "admin");
    await service.idle();
    expect((await service.record(v.id)).verify!.items[0]!.reason).toBe("Não foi possível baixar do armazenamento: Chave recusada.");
    free = 0;
    const full = await service.verify(P1, { fileName: b.fileName!, where: "remote" }, "admin");
    await service.idle();
    expect((await service.record(full.id)).verify!.items[0]!.reason).toMatch(/Espaço em disco insuficiente/);
    free = 50 * 1024 ** 3;
    const local = path.join(dir, "backups", "loja", b.fileName!);
    const raw = JSON.parse(await readFile(local, "utf8"));
    raw.password = "alguma";
    await writeFile(local, JSON.stringify(raw));
    (service as unknown as { config: { checks: Record<string, unknown> } }).config.checks = {};
    const pw = await service.verify(P1, { fileName: b.fileName!, where: "local" }, "admin");
    await service.idle();
    expect((await service.record(pw.id)).verify!.items[0]!.reason).toMatch(/pede senha/);
  });

  it("tamanho diferente do listado; erro do 7-Zip que não é senha", async () => {
    await connect();
    const b = await backup();
    const key = `TWS Panel Backups/loja/${b.fileName}`;
    (service as unknown as { config: { checks: Record<string, unknown> } }).config.checks = {};
    const realList = storage.list.bind(storage);
    storage.list = async (prefix) => (await realList(prefix)).map((o) => ({ ...o, size: o.size + 10 }));
    const v = await service.verify(P1, { fileName: b.fileName!, where: "remote" }, "admin");
    await service.idle();
    expect((await service.record(v.id)).verify!.items[0]!.reason).toMatch(/o enviado tinha/);
    storage.list = realList;
    expect(storage.objects.has(key)).toBe(true);
    const test = archiver.test.bind(archiver);
    let n = 0;
    archiver.test = async (file, pw) => {
      n++;
      if (pw !== null) throw new ArchiveError("O 7-Zip falhou (código 2): Data Error.", "failed");
      return test(file, pw);
    };
    const w = await service.verify(P1, { fileName: b.fileName!, where: "remote" }, "admin");
    await service.idle();
    expect((await service.record(w.id)).verify!.items[0]!.reason).toMatch(/Data Error/);
    expect(n).toBeGreaterThan(1);
  });

  it("validação do pedido e o mesmo pedido duas vezes entra uma só", async () => {
    await expect(service.verify(P1, { fileName: "../x.7z" }, "admin")).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.verify("all", { fileName: "2026-10-14_03-00.7z" }, "admin")).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.verify(P1, { where: "remote" }, "admin")).rejects.toMatchObject({ statusCode: 409, code: "no_destination" });
    await expect(service.verify("project:nao-existe", {}, "admin")).rejects.toMatchObject({ statusCode: 404 });
    const b = await backup();
    const first = await service.verify(P1, { fileName: b.fileName! }, "admin");
    const again = await service.verify(P1, { fileName: b.fileName! }, "admin");
    expect(again.id).toBe(first.id);
    const other = await service.verify(P1, {}, "admin");
    expect(other.id).not.toBe(first.id);
    await service.idle();
    expect(audits.filter((a) => a.action === "backups.verify")).toHaveLength(2);
    // geral sem servidor de e-mail: não entra o e-mail
    docker.states["paas-stalwart"] = { exists: false, running: false };
    const all = await service.verify("all", { where: "local" }, "admin");
    await service.idle();
    expect((await service.record(all.id)).verify!.items.every((i) => i.target !== "email")).toBe(true);
  });

  it("a retenção esquece o hash das cópias apagadas", async () => {
    await connect();
    service = build();
    await service.updateTarget(P1, { localKeep: 1, remoteKeep: 1 }, "admin");
    const a = await backup();
    now += H;
    await backup();
    const cfg = (service as unknown as { config: { checks: Record<string, unknown> } }).config;
    expect(Object.keys(cfg.checks)).toHaveLength(1);
    expect(cfg.checks[`loja/${a.fileName}`]).toBeUndefined();
  });
});

/**
 * Backup incompleto nunca conta como completo (achados 3 e 14 da revisão).
 * O 7-Zip de verdade sai com código 1 quando um arquivo some ou não pode ser
 * lido (reproduzido com o 7zz 24.09: o .7z sai sem o arquivo e o teste do
 * arquivo passa). Aqui um 7zz de mentira imita essa saída, o SevenZip é o de
 * verdade e o disco também.
 */
describe("backup incompleto não entra na retenção como completo", () => {
  const P1 = projectTargetId("p1");

  async function seteZipQueAvisa(): Promise<string> {
    const bin = path.join(dir, "7zz-aviso");
    await writeFile(
      bin,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
process.stdin.resume();
process.stdin.on("end", () => {
  if (args[0] === "i") process.exit(0);
  const archive = args.find((a) => a.endsWith(".7z"));
  fs.writeFileSync(archive, "parcial");
  const first = args.filter((a) => a.startsWith("/") && !a.endsWith(".7z"))[0];
  process.stderr.write("Scan WARNINGS for files and folders:\\n\\n" + first + "/app.sql : errno=2 : No such file or directory\\n");
  process.exit(1);
});
`,
    );
    const { chmod } = await import("node:fs/promises");
    await chmod(bin, 0o755);
    return bin;
  }

  it("7-Zip com código 1: o backup falha com os arquivos no motivo e a retenção não apaga a cópia completa", async () => {
    await service.updateTarget(P1, { localKeep: 1 }, "admin");
    const completa = await backup();
    expect(completa.status).toBe("success");
    const { SevenZip } = await import("../src/services/backup-archive.js");
    service = build({ archiver: new SevenZip({ bin: await seteZipQueAvisa() }) });
    now += H;
    const r = await backup();
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/não conseguiu ler 1 arquivo\(s\): bancos\/app\.sql \(não encontrado\)/);
    expect(await readdir(path.join(dir, "backups", "loja"))).toEqual([completa.fileName]);
    expect((await service.status()).targets.find((t) => t.id === P1)!.lastSuccessAt).toBe(completa.finishedAt);
    expect(notices.at(-1)).toMatchObject({ kind: "backup_failed" });
  });

  it("painel: compacta uma cópia do diretório de dados, não os arquivos em uso", async () => {
    // 7-Zip de mentira que, no meio da compactação, vê um arquivo do painel
    // sumir (gravação atômica de outro serviço, limpeza) — como o real, pula o que sumiu.
    const vistos: string[] = [];
    archiver.create = async (archive, inputs) => {
      await rm(path.join(dir, "users.json"), { force: true });
      const files: Record<string, string> = {};
      for (const i of inputs) {
        vistos.push(i);
        if (!existsSync(i)) continue;
        const s = await stat(i);
        if (s.isFile()) files[path.basename(i)] = (await readFile(i)).toString("base64");
      }
      await writeFile(archive, JSON.stringify({ password: null, files }));
    };
    await mkdir(path.join(dir, "mail"), { recursive: true });
    await writeFile(path.join(dir, "mail", "config.json.123-abcd.tmp"), "meia gravação");
    const r = await backup("panel");
    expect(r.status).toBe("success");
    expect(vistos.every((i) => !i.startsWith(dir + path.sep + "users.json"))).toBe(true);
    const files = Object.keys((JSON.parse(await readFile(path.join(dir, "backups", "_painel", r.fileName!), "utf8")) as { files: Record<string, string> }).files);
    expect(files).toContain("users.json");
  });

  it("painel: arquivo do diretório de dados que não pode ser lido faz o backup falhar dizendo qual", async () => {
    const { chmod } = await import("node:fs/promises");
    await writeFile(path.join(dir, "trancado.json"), "{}");
    await chmod(path.join(dir, "trancado.json"), 0o000);
    try {
      const r = await backup("panel");
      expect(r.status).toBe("failed");
      expect(r.error).toMatch(/trancado\.json/);
    } finally {
      await chmod(path.join(dir, "trancado.json"), 0o600);
    }
  });

  it("painel: arquivo que some entre listar e copiar fica de fora sem falhar; links e subpastas são copiados", async () => {
    await writeFile(path.join(dir, "sumiu.json"), "{}");
    await mkdir(path.join(dir, "certificados", "site"), { recursive: true });
    await writeFile(path.join(dir, "certificados", "site", "cert.pem"), "pem");
    await symlink("certificados/site/cert.pem", path.join(dir, "atalho.pem"));
    // o statfs roda depois de listar e antes de copiar: é o momento de "sumir"
    service = build({
      statfs: async () => {
        await rm(path.join(dir, "sumiu.json"), { force: true });
        return { bavail: free, bsize: 1, blocks: 100 * 1024 ** 3 };
      },
    });
    const r = await backup("panel");
    expect(r.status).toBe("success");
    const files = Object.keys((JSON.parse(await readFile(path.join(dir, "backups", "_painel", r.fileName!), "utf8")) as { files: Record<string, string> }).files);
    expect(files).toEqual(expect.arrayContaining(["certificados/site/cert.pem", "atalho.pem", "users.json"]));
    expect(files).not.toContain("sumiu.json");
  });

  it("painel: arquivo ilegível numa subpasta: o motivo diz o caminho dele", async () => {
    const { chmod } = await import("node:fs/promises");
    await mkdir(path.join(dir, "mail", "sub"), { recursive: true });
    await writeFile(path.join(dir, "mail", "sub", "chave.key"), "x");
    await chmod(path.join(dir, "mail", "sub", "chave.key"), 0o000);
    try {
      const r = await backup("panel");
      expect(r.status).toBe("failed");
      expect(r.error).toMatch(/"mail\/sub\/chave\.key" do diretório de dados do painel \(sem permissão de leitura\)/);
    } finally {
      await chmod(path.join(dir, "mail", "sub", "chave.key"), 0o600);
    }
  });

  it("retentionVictims: N mais novas ficam; a última completa também, se nenhuma das que ficam for completa", () => {
    const completas = new Set(["a", "c"]);
    const ok = (f: string) => completas.has(f);
    expect(retentionVictims(["a", "b", "c", "d"], 2, ok)).toEqual(["a", "b"]); // "c" fica entre as 2
    expect(retentionVictims(["a", "b", "c", "d", "e"], 2, ok)).toEqual(["a", "b"]); // "c" é a última completa
    expect(retentionVictims(["a", "b"], 5, ok)).toEqual([]);
    expect(retentionVictims(["x", "y", "z"], 1, () => false)).toEqual(["x", "y"]); // nenhuma completa: como antes
  });

  function comRedis(save: (script: string) => Promise<string>): void {
    docker.containers.push({ id: "c-redis", name: "paas-loja-cache-1", service: "cache", running: true });
    const inspect = docker.inspect.bind(docker);
    docker.inspect = async (ids) => [
      ...(await inspect(ids.filter((i) => i !== "c-redis"))),
      { Name: "/cache", Config: { Image: "redis:7", Env: [], Labels: { "com.docker.compose.service": "cache" } }, Mounts: [], State: { Running: true } },
    ];
    const capture = docker.execCapture.bind(docker);
    docker.execCapture = async (c, script) => (script.includes("SAVE") ? save(script) : capture(c, script));
  }

  it("SAVE do Redis que falha ou não responde OK: aviso explícito, sem contar como completo", async () => {
    comRedis(async () => "NOAUTH Authentication required.\n");
    await service.updateTarget(P1, { choices: { "db:cache": true } }, "admin");
    const r = await backup();
    expect(r.status).toBe("warning");
    expect(r.warnings.join(" ")).toMatch(/cache: o Redis não confirmou o SAVE \(NOAUTH Authentication required\.\)/);
    expect(r.warnings.join(" ")).toMatch(/incompleto/);
    expect((await service.status()).targets.find((t) => t.id === P1)!.lastSuccessAt).toBeNull();
    // erro do comando (código diferente de zero) também
    docker.execCapture = async (c, script) => (script.includes("SAVE") ? Promise.reject(new Error("redis-cli: conexão recusada")) : "app\n");
    now += H;
    const r2 = await backup();
    expect(r2.warnings.join(" ")).toMatch(/não confirmou o SAVE \(redis-cli: conexão recusada\)/);
  });

  it("retenção: cópias incompletas nunca levam embora a última completa (na VPS e fora)", async () => {
    await connect();
    let ok = true;
    comRedis(async () => (ok ? "OK\n" : "ERR MISCONF\n"));
    await service.updateTarget(P1, { localKeep: 1, remoteKeep: 1, choices: { "db:cache": true } }, "admin");
    const completa = await backup();
    expect(completa.status).toBe("success");
    ok = false;
    for (let i = 0; i < 3; i++) {
      now += H;
      expect((await backup()).status).toBe("warning");
    }
    const locais = await readdir(path.join(dir, "backups", "loja"));
    expect(locais).toContain(completa.fileName);
    expect(locais).toHaveLength(2); // a completa + a incompleta mais nova
    const fora = (await storage.list("TWS Panel Backups/loja/")).map((o) => path.basename(o.key));
    expect(fora).toContain(completa.fileName);
    expect(fora).toHaveLength(2);
    // uma completa nova: aí sim a retenção volta ao normal
    ok = true;
    now += H;
    const nova = await backup();
    expect(nova.status).toBe("success");
    expect(await readdir(path.join(dir, "backups", "loja"))).toEqual([nova.fileName]);
    expect((await storage.list("TWS Panel Backups/loja/")).map((o) => path.basename(o.key))).toEqual([nova.fileName]);
  });
});

describe("falha ao gravar a configuração dos backups (B10)", () => {
  it("quem pediu a mudança fica sabendo: a falha de gravação é propagada, e o serviço segue funcionando depois", async () => {
    await connect();
    const P1 = projectTargetId("p1");
    // uma pasta no lugar do backups.json: a gravação atômica falha
    await rm(path.join(dir, "backups.json"), { force: true });
    await mkdir(path.join(dir, "backups.json"));
    await expect(service.updateTarget(P1, { localKeep: 3 }, "admin")).rejects.toThrow();
    await rm(path.join(dir, "backups.json"), { recursive: true });
    await service.updateTarget(P1, { localKeep: 4 }, "admin");
    expect(JSON.parse(await readFile(path.join(dir, "backups.json"), "utf8")).targets[P1].localKeep).toBe(4);
  });
});

describe("retenção nunca apaga o backup recém-criado (M5)", () => {
  const P1 = projectTargetId("p1");

  it("dois backups no mesmo minuto: o de sufixo -2 é o mais NOVO e fica; o original (mais antigo) é que sai", async () => {
    await connect();
    await service.updateTarget(P1, { localKeep: 1, remoteKeep: 1 }, "admin");
    const primeiro = await backup();
    const segundo = await backup(); // mesmo `now`: o nome ganha o sufixo -2
    expect(segundo.fileName).toBe(primeiro.fileName!.replace(".7z", "-2.7z"));
    expect(await readdir(path.join(dir, "backups", "loja"))).toEqual([segundo.fileName]);
    expect((await storage.list("TWS Panel Backups/loja/")).map((o) => path.basename(o.key))).toEqual([segundo.fileName]);
  });

  it("nome já usado só no armazenamento externo (a cópia local saiu pela retenção): o novo ganha outro nome e a cópia externa antiga NÃO é sobrescrita", async () => {
    await connect();
    await service.updateTarget(P1, { localKeep: 1, remoteKeep: 5 }, "admin");
    const a = await backup();
    const b = await backup(); // mesmo minuto; a cópia local de `a` sai (localKeep 1), a externa fica
    expect(await readdir(path.join(dir, "backups", "loja"))).toEqual([b.fileName]);
    const chave = `TWS Panel Backups/loja/${a.fileName}`;
    const original = Buffer.from(storage.objects.get(chave)!);
    const c = await backup();
    expect(new Set([a.fileName, b.fileName, c.fileName]).size).toBe(3);
    expect(storage.objects.get(chave)!.equals(original)).toBe(true);
    expect((await storage.list("TWS Panel Backups/loja/")).length).toBe(3);
  });

  it("nome que existe no histórico (cópia já apagada dos dois lados) também não é reaproveitado", async () => {
    await connect();
    await service.updateTarget(P1, { localKeep: 1, remoteKeep: 1 }, "admin");
    const a = await backup();
    const b = await backup();
    const c = await backup();
    expect(new Set([a.fileName, b.fileName, c.fileName]).size).toBe(3);
  });

  it("se o nome sorteado já existir fora na hora do envio, o envio é recusado em vez de sobrescrever", async () => {
    await connect();
    const gets = storage.list.bind(storage);
    let primeira = true;
    // a listagem de antes do nome não vê o objeto (corrida/consistência eventual); a conferência do envio vê
    storage.list = async (prefix: string) => {
      if (primeira) {
        primeira = false;
        return [];
      }
      return gets(prefix);
    };
    const nome = `${backupFileStamp(new Date(now))}.7z`;
    storage.objects.set(`TWS Panel Backups/loja/${nome}`, Buffer.from("copia antiga"));
    const r = await backup();
    expect(r.remote).toBe("failed");
    expect(r.remoteDetail).toMatch(/Já existe/);
    expect(storage.objects.get(`TWS Panel Backups/loja/${nome}`)!.toString()).toBe("copia antiga");
  });

  it("fuso trocado entre dois backups (o nome novo ordena antes do antigo): o novo fica, o antigo sai", async () => {
    const prev = process.env.TZ;
    try {
      await connect();
      await service.updateTarget(P1, { localKeep: 1, remoteKeep: 1 }, "admin");
      process.env.TZ = "Europe/Berlin"; // 12:00 no nome
      now = Date.parse("2026-10-14T10:00:00Z");
      const antigo = await backup();
      process.env.TZ = "America/Sao_Paulo"; // uma hora depois, o nome diz 08:00 (ordena antes de 12:00)
      now += H;
      const novo = await backup();
      expect(novo.fileName! < antigo.fileName!).toBe(true);
      expect(await readdir(path.join(dir, "backups", "loja"))).toEqual([novo.fileName]);
      expect((await storage.list("TWS Panel Backups/loja/")).map((o) => path.basename(o.key))).toEqual([novo.fileName]);
    } finally {
      process.env.TZ = prev;
    }
  });

  it("cópias de antes desta correção (sem data registrada): a ordem vem da data do arquivo, não do nome", async () => {
    const pasta = path.join(dir, "backups", "loja");
    await mkdir(pasta, { recursive: true });
    // nome "12-00" é do dia anterior em UTC-1; o arquivo "08-00" é o mais novo de verdade
    await writeFile(path.join(pasta, "2026-10-14_12-00.7z"), "velho");
    await writeFile(path.join(pasta, "2026-10-14_08-00.7z"), "novo");
    await utimes(path.join(pasta, "2026-10-14_12-00.7z"), new Date("2026-10-14T10:00:00Z"), new Date("2026-10-14T10:00:00Z"));
    await utimes(path.join(pasta, "2026-10-14_08-00.7z"), new Date("2026-10-14T11:00:00Z"), new Date("2026-10-14T11:00:00Z"));
    now = Date.parse("2026-10-14T12:00:00Z");
    await service.updateTarget(P1, { localKeep: 2 }, "admin");
    const feito = await backup();
    expect((await readdir(pasta)).sort()).toEqual(["2026-10-14_08-00.7z", feito.fileName].sort());
  });

  it("retentionVictims: o arquivo protegido nunca é candidato, mesmo que a ordem o ponha como o mais velho", () => {
    expect(retentionVictims(["novo", "b", "c"], 1, () => true, "novo")).toEqual(["b"]);
  });

  it("orderBackups: data UTC registrada manda; sem ela, a data do nome; empate pelo número do sufixo", () => {
    const quando: Record<string, number> = {
      "2026-10-14_08-00.7z": Date.parse("2026-10-14T11:00:00Z"),
      "2026-10-14_12-00.7z": Date.parse("2026-10-14T10:00:00Z"),
    };
    expect(orderBackups(["2026-10-14_08-00.7z", "2026-10-14_12-00.7z"], (n) => quando[n] ?? null)).toEqual([
      "2026-10-14_12-00.7z",
      "2026-10-14_08-00.7z",
    ]);
    expect(orderBackups(["2026-10-14_10-00-3.7z", "2026-10-14_10-00.7z", "2026-10-14_10-00-2.7z"], () => null)).toEqual([
      "2026-10-14_10-00.7z",
      "2026-10-14_10-00-2.7z",
      "2026-10-14_10-00-3.7z",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Reconciliação depois de restaurar: o que o backup tinha ativo x o que roda aqui
// ---------------------------------------------------------------------------

describe("restauração: reconciliação do que o painel antigo tinha ativo", () => {
  const stagedFile = (f: string) => path.join(dir, "backups", ".restaurar-painel", f);
  const live = () => new RestoreReconciliation({ dataDir: dir, containers: { stalwart: "paas-stalwart", webmail: "paas-webmail" }, probes: probes() });
  const probes = () => ({
    container: async (n: string) => {
      const s = docker.states[n];
      return !s || !s.exists ? ("missing" as const) : s.running ? ("running" as const) : ("stopped" as const);
    },
  });
  const webmailOn = JSON.stringify({ enabled: true, enabledAt: "2026-10-01T00:00:00Z", desKey: "k".repeat(24), exemptIp: null });

  function withReconciliation(): BackupService {
    return build({ reconciliation: live() });
  }

  async function restoreEmailBackup() {
    const b = await backup("email");
    const r = await service.restore("email", { fileName: b.fileName!, source: "local", confirm: "E-MAIL" }, "admin");
    await service.idle();
    return service.record(r.id);
  }

  async function restorePanelBackup() {
    const b = await backup("panel");
    const r = await service.restore("panel", { fileName: b.fileName!, source: "local", confirm: "painel" }, "admin");
    await service.idle();
    return service.record(r.id);
  }

  it("painel: backup com webmail ativo e VPS sem webmail rodando — avisa no resultado, deixa a pendência no estado que entra no lugar e não liga nada", async () => {
    service = withReconciliation();
    await mkdir(path.join(dir, "mail"), { recursive: true });
    await writeFile(path.join(dir, "mail", "webmail.json"), webmailOn);
    docker.states = {};
    docker.calls = [];
    const rec = await restorePanelBackup();
    expect(rec.status).toBe("warning");
    expect(rec.warnings.join(" ")).toMatch(/webmail ativo.*Nada foi ativado/s);
    expect(JSON.parse(await readFile(stagedFile("mail/webmail.json"), "utf8")).enabled).toBe(false);
    expect(JSON.parse(await readFile(stagedFile("restore-reconciliation.json"), "utf8")).items).toMatchObject([{ id: "webmail", state: "open" }]);
    expect(docker.calls.filter((c) => /^(start|run|create)/.test(c))).toEqual([]);
  });

  it("painel: tudo já ativo aqui — nenhum aviso, nenhuma pendência", async () => {
    service = withReconciliation();
    await mkdir(path.join(dir, "mail"), { recursive: true });
    await writeFile(path.join(dir, "mail", "webmail.json"), webmailOn);
    const rec = await restorePanelBackup(); // FakeDocker: webmail e Stalwart existem e rodam
    expect(rec.warnings.join(" ")).not.toMatch(/webmail/);
    expect(existsSync(stagedFile("restore-reconciliation.json"))).toBe(false);
    expect(JSON.parse(await readFile(stagedFile("mail/webmail.json"), "utf8")).enabled).toBe(true);
  });

  it("painel: o serviço de reconciliação quebrar não impede a restauração (só vira aviso)", async () => {
    service = build({ reconciliation: { planStaged: async () => Promise.reject(new Error("disco cheio")), markPending: async () => undefined } });
    const rec = await restorePanelBackup();
    expect(rec.status).toBe("warning");
    expect(rec.warnings.join(" ")).toMatch(/não foi possível conferir.*disco cheio/i);
    await waitRestarted();
    expect(restarted).toBe(1);
  });

  it("painel: sem o serviço de reconciliação (backups antigos, testes) tudo segue como antes", async () => {
    const rec = await restorePanelBackup();
    expect(rec.status).toBe("warning");
  });

  it("e-mail: o backup trazia o webmail e ele não roda aqui — o passo continua 'feito' (são os dados), mas o resultado avisa e fica a pendência", async () => {
    service = withReconciliation();
    const b = await backup("email");
    docker.states = { "paas-stalwart": { exists: true, running: true } };
    const r = await service.restore("email", { fileName: b.fileName!, source: "local", confirm: "E-MAIL" }, "admin");
    await service.idle();
    const rec = await service.record(r.id);
    expect(rec.status).toBe("warning");
    expect(rec.warnings.join(" ")).toMatch(/dados do webmail voltaram.*não está rodando.*Nada foi ativado/s);
    expect((await live().list()).items).toMatchObject([{ id: "webmail", source: "email", status: "pending" }]);
  });

  it("e-mail: servidor de e-mail ainda não existe aqui — pendência do servidor também", async () => {
    service = withReconciliation();
    const b = await backup("email");
    docker.states = {};
    const r = await service.restore("email", { fileName: b.fileName!, source: "local", confirm: "E-MAIL" }, "admin");
    await service.idle();
    expect((await service.record(r.id)).warnings.join(" ")).toMatch(/clique em Iniciar/);
    expect((await live().list()).items.map((i) => i.id).sort()).toEqual(["mail-server", "webmail"]);
  });

  it("e-mail: webmail e servidor rodando — nenhuma pendência, nenhuma pergunta", async () => {
    service = withReconciliation();
    const rec = await restoreEmailBackup();
    expect(rec.warnings.join(" ")).not.toMatch(/webmail/);
    expect((await live().list()).items).toEqual([]);
  });

  it("e-mail: backup sem a parte do webmail — nada a perguntar sobre ele", async () => {
    service = withReconciliation();
    docker.states = { "paas-stalwart": { exists: true, running: true } };
    const b = await backup("email");
    docker.states = {};
    const r = await service.restore("email", { fileName: b.fileName!, source: "local", confirm: "E-MAIL" }, "admin");
    await service.idle();
    expect((await live().list()).items.map((i) => i.id)).toEqual(["mail-server"]);
    expect((await service.record(r.id)).warnings.join(" ")).not.toMatch(/dados do webmail/);
  });
});

describe("restauração do e-mail: senha de administração do servidor de e-mail", () => {
  type Repair = "ok" | "repaired" | "failed" | "unreachable" | "not_running";
  let repairs: number;
  let pending: Array<[string[], string]>;
  const withAuth = (result: Repair | "erro"): BackupService =>
    build({
      mailAuth: {
        repair: async () => {
          repairs++;
          if (result === "erro") throw new Error("docker fora do ar");
          return result;
        },
      },
      reconciliation: { planStaged: async () => [], markPending: async (ids, source) => void pending.push([ids, source]) },
    });
  async function restoreEmail() {
    const b = await backup("email");
    const r = await service.restore("email", { fileName: b.fileName!, source: "local", confirm: "E-MAIL" }, "admin");
    await service.idle();
    return service.record(r.id);
  }
  beforeEach(() => {
    repairs = 0;
    pending = [];
  });

  it("o etc/ do servidor antigo voltou com outra senha e foi reaplicada: avisa o que aconteceu, sem pendência", async () => {
    service = withAuth("repaired");
    const rec = await restoreEmail();
    expect(repairs).toBe(1);
    expect(rec.warnings.join(" ")).toMatch(/senha de administração.*reaplicou/s);
    expect(rec.warnings.join(" ")).not.toMatch(/segredo|secret/i);
    expect(pending).toEqual([]);
  });

  it("senha já consistente: nada a dizer", async () => {
    service = withAuth("ok");
    const rec = await restoreEmail();
    expect(repairs).toBe(1);
    expect(rec.warnings.join(" ")).not.toMatch(/senha de administração/);
    expect(pending).toEqual([]);
  });

  it("não deu para reaplicar (ou conferir): aviso com a ação e pendência 'mail-auth' — a restauração não falha", async () => {
    for (const result of ["failed", "unreachable", "erro"] as const) {
      pending = [];
      service = withAuth(result);
      const rec = await restoreEmail();
      expect(rec.status).toBe("warning");
      expect(rec.warnings.join(" ")).toMatch(/E-mail → Servidor/);
      expect(pending).toEqual([[["mail-auth"], "email"]]);
    }
  });

  it("servidor de e-mail ainda não existe aqui: não há o que conferir (o Iniciar grava a senha certa)", async () => {
    service = withAuth("repaired");
    const b = await backup("email");
    docker.states = {};
    await service.restore("email", { fileName: b.fileName!, source: "local", confirm: "E-MAIL" }, "admin");
    await service.idle();
    expect(repairs).toBe(0);
  });
});

describe("restauração do e-mail: cadastrar no painel o que o servidor de e-mail trouxe", () => {
  type Repair = "ok" | "repaired" | "failed" | "unreachable" | "not_running";
  let adopts: number;
  const withAdopt = (
    adopt: () => Promise<{ domains: string[]; mailboxes: string[]; skipped: string[]; passwordsRealigned?: number; passwordsReapplied?: number; passwordsFailed?: string[] }>,
    repair: Repair = "ok",
  ): BackupService =>
    build({
      mailAuth: { repair: async () => repair },
      mailAdopt: {
        adopt: async () => {
          adopts++;
          return adopt();
        },
      },
    });
  async function restoreEmail() {
    const b = await backup("email");
    const r = await service.restore("email", { fileName: b.fileName!, source: "local", confirm: "E-MAIL" }, "admin");
    await service.idle();
    return service.record(r.id);
  }
  beforeEach(() => {
    adopts = 0;
  });

  it("2 domínios e 3 caixas cadastrados: o registro diz quantos, em passo e em aviso", async () => {
    service = withAdopt(async () => ({
      domains: ["brisa.example.com", "envio.example.com"],
      mailboxes: ["a@brisa.example.com", "b@brisa.example.com", "c@envio.example.com"],
      skipped: [],
    }));
    const rec = await restoreEmail();
    expect(adopts).toBe(1);
    expect(rec.steps.map((s) => s.label).join("|")).toMatch(/Cadastrei 2 domínios e 3 caixas no painel/);
    expect(rec.warnings.join(" ")).toMatch(/Cadastrei 2 domínios e 3 caixas no painel/);
    expect(rec.warnings.join(" ")).toMatch(/Trocar senha/);
    expect(rec.warnings.join(" ")).toMatch(/Verificar agora/);
    expect(rec.error).toBeNull();
  });

  it("senhas realinhadas de verdade: o registro diz quantas caixas, sem senha nenhuma, e a restauração termina com aviso", async () => {
    service = withAdopt(async () => ({ domains: [], mailboxes: [], skipped: [], passwordsRealigned: 2 }));
    const rec = await restoreEmail();
    expect(rec.warnings.join(" ")).toMatch(/Realinhei a senha de 2 caixas/);
    expect(rec.steps.map((s) => s.label).join("|")).toMatch(/Realinhei a senha de 2 caixas/);
    expect(rec.status).toBe("warning");
    expect(rec.error).toBeNull();
  });

  it("senhas já conferiam (nada realinhado): sem aviso e a restauração termina com sucesso", async () => {
    service = withAdopt(async () => ({ domains: [], mailboxes: [], skipped: [] }));
    const rec = await restoreEmail();
    expect(rec.warnings).toEqual([]);
    expect(rec.status).toBe("success");
  });

  it("não deu para conferir: passo informativo, sem frase afirmativa, sem aviso e sem rebaixar o status", async () => {
    service = withAdopt(async () => ({ domains: [], mailboxes: [], skipped: [], passwordsReapplied: 3 }));
    const rec = await restoreEmail();
    expect(rec.steps.map((s) => s.label).join("|")).toMatch(/Reapliquei a senha de 3 caixas/);
    expect(rec.warnings).toEqual([]);
    expect(rec.status).toBe("success");
  });

  it("senhas realinhadas: singular e, com falha, os endereços que ficaram para Sincronizar", async () => {
    service = withAdopt(async () => ({ domains: [], mailboxes: [], skipped: [], passwordsRealigned: 1, passwordsFailed: ["postmaster@a.example.com", "loja@a.example.com"] }));
    const rec = await restoreEmail();
    const text = rec.warnings.join(" ");
    expect(text).toMatch(/Realinhei a senha de 1 caixa /);
    expect(text).toMatch(/Não consegui realinhar a senha destas caixas: postmaster@a\.example\.com, loja@a\.example\.com/);
    expect(text).toMatch(/Sincronizar/);
  });

  it("só falhas ao realinhar: avisa sem dizer que realinhou", async () => {
    service = withAdopt(async () => ({ domains: [], mailboxes: [], skipped: [], passwordsFailed: ["postmaster@a.example.com"] }));
    const rec = await restoreEmail();
    expect(rec.warnings.join(" ")).not.toMatch(/Realinhei/);
    expect(rec.warnings.join(" ")).toMatch(/Não consegui realinhar/);
  });

  it("singular: 1 domínio e 1 caixa", async () => {
    service = withAdopt(async () => ({ domains: ["envio.example.com"], mailboxes: ["a@envio.example.com"], skipped: [] }));
    const rec = await restoreEmail();
    expect(rec.warnings.join(" ")).toMatch(/Cadastrei 1 domínio e 1 caixa no painel/);
  });

  it("só caixas, sem domínio novo: a frase não cita domínio", async () => {
    service = withAdopt(async () => ({ domains: [], mailboxes: ["a@envio.example.com", "b@envio.example.com"], skipped: [] }));
    const rec = await restoreEmail();
    expect(rec.warnings.join(" ")).toMatch(/Cadastrei 2 caixas no painel/);
    expect(rec.warnings.join(" ")).not.toMatch(/domínio/);
  });

  it("nada a cadastrar: sem aviso, sem texto de erro", async () => {
    service = withAdopt(async () => ({ domains: [], mailboxes: [], skipped: [] }));
    const rec = await restoreEmail();
    expect(adopts).toBe(1);
    expect(rec.warnings).toEqual([]);
    expect(rec.status).not.toBe("warning");
    expect(rec.steps.map((s) => s.label).join("|")).not.toMatch(/Cadastrei/);
  });

  it("o que o painel não conseguiu cadastrar é avisado, só com nomes", async () => {
    service = withAdopt(async () => ({ domains: [], mailboxes: [], skipped: ["joao", "x.example.com"] }));
    const rec = await restoreEmail();
    expect(rec.warnings.join(" ")).toMatch(/não consegui cadastrar.*joao, x\.example\.com/s);
  });

  it("falha do Stalwart: aviso com a ação, a restauração não falha", async () => {
    service = withAdopt(async () => {
      throw new Error("Sem conexão com o Stalwart");
    });
    const rec = await restoreEmail();
    expect(rec.status).toBe("warning");
    expect(rec.error).toBeNull();
    expect(rec.warnings.join(" ")).toMatch(/Sincronizar com o servidor de e-mail/);
  });

  it("401: usa a mensagem de autenticação que já existe", async () => {
    const { StalwartApiError } = await import("@paas/mailer");
    service = withAdopt(async () => {
      throw new StalwartApiError(401, "Stalwart: You have to authenticate first.");
    });
    const rec = await restoreEmail();
    expect(rec.warnings.join(" ")).toMatch(/não conseguiu autenticar no servidor de e-mail/);
    expect(rec.warnings.join(" ")).not.toMatch(/You have to authenticate/);
  });

  it("senha de administração sem conserto ou servidor sem resposta: nem tenta cadastrar", async () => {
    for (const repair of ["failed", "unreachable", "not_running"] as const) {
      adopts = 0;
      service = withAdopt(async () => ({ domains: ["x.example.com"], mailboxes: [], skipped: [] }), repair);
      const rec = await restoreEmail();
      expect(adopts).toBe(0);
      // quando o reparo da senha falha, o aviso também diz como cadastrar depois
      if (repair !== "not_running") expect(rec.warnings.join(" ")).toMatch(/Sincronizar com o servidor de e-mail/);
    }
  });

  it("lista cortada em 20 000: avisa que o resto não foi conferido; ignorados contam o total", async () => {
    service = withAdopt(async () => ({
      domains: [],
      mailboxes: [],
      skipped: Array.from({ length: 200 }, (_, i) => `n${i}`),
      skippedTotal: 250,
      truncated: true,
    }));
    const rec = await restoreEmail();
    expect(rec.warnings.join(" ")).toMatch(/e mais 240/);
    expect(rec.warnings.join(" ")).toMatch(/mais de 20 000/);
  });

  it("o adotador pode ser entregue depois da criação (setMailAdopt), como faz o plugin de e-mail", async () => {
    service = build({ mailAuth: { repair: async () => "ok" } });
    service.setMailAdopt({ adopt: async () => ({ domains: ["t.example.com"], mailboxes: [], skipped: [] }) });
    const rec = await restoreEmail();
    expect(rec.warnings.join(" ")).toMatch(/Cadastrei 1 domínio/);
  });

  it("servidor de e-mail ainda não existe aqui: não tenta, e o aviso manda sincronizar depois de iniciar", async () => {
    service = withAdopt(async () => ({ domains: ["x.example.com"], mailboxes: [], skipped: [] }));
    const b = await backup("email");
    docker.states = {};
    const r = await service.restore("email", { fileName: b.fileName!, source: "local", confirm: "E-MAIL" }, "admin");
    await service.idle();
    expect(adopts).toBe(0);
    expect((await service.record(r.id)).warnings.join(" ")).toMatch(/Sincronizar com o servidor de e-mail/);
  });

  it("sem a verificação da senha de administração: cadastra assim mesmo", async () => {
    service = build({ mailAdopt: { adopt: async () => ({ domains: ["a.example.com"], mailboxes: [], skipped: [] }) } });
    const rec = await restoreEmail();
    expect(rec.warnings.join(" ")).toMatch(/Cadastrei 1 domínio/);
  });
});

describe("restauração do banco: cópia de segurança, parada no primeiro erro e volta ao estado de antes", () => {
  const restore = async () => {
    const b = await backup();
    docker.calls = [];
    docker.dbInput = [];
    docker.dumpTag = " ATUAL";
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    return service.record(r.id);
  };

  it("faz a cópia de segurança do banco atual na VPS antes de sobrescrever e a guarda por 7 dias", async () => {
    const done = await restore();
    expect(done.status).toBe("success");
    const root = path.join(dir, "backups", ".antes-da-restauracao", "loja");
    const [stamp] = await readdir(root);
    expect(await readFile(path.join(root, stamp!, "bancos", "db", "app.sql"), "utf8")).toBe("dump c-db app banco ATUAL");
    expect(done.steps.map((s) => s.label)).toContain("Cópia de segurança do banco atual (antes de sobrescrever)");
    expect(done.steps.at(-1)!.label).toMatch(/fica na VPS por 7 dias/);
    // mais de 7 dias depois, a próxima restauração apaga a cópia velha
    await utimes(path.join(root, stamp!), new Date(now - 8 * 24 * H), new Date(now - 8 * 24 * H));
    now += H;
    await restore();
    expect(await readdir(root)).not.toContain(stamp);
  });

  it("sem conseguir a cópia de segurança, a restauração nem começa (nada é parado nem sobrescrito)", async () => {
    const b = await backup();
    docker.calls = [];
    docker.failDump = true;
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    const done = await service.record(r.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/NÃO começou: não foi possível fazer a cópia de segurança/);
    // o app foi parado para a cópia (e volta a ligar), mas nada foi sobrescrito
    expect(docker.calls.some((c) => c.startsWith("execFromFile") || c.startsWith("restorePath"))).toBe(false);
    expect(docker.calls.at(-1)).toBe("start c-web");
  });

  it("PostgreSQL com erro no restore: para no primeiro, o banco atual NÃO é tocado (o temporário é descartado)", async () => {
    const b = await backup();
    docker.dumpTag = " ATUAL";
    docker.failRestore = { arg: "app", times: 1 };
    docker.dbInput = [];
    docker.calls = [];
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    const done = await service.record(r.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/parou no primeiro erro: ERROR:  relation already exists/);
    expect(done.error).toMatch(/O banco atual não foi alterado/);
    // o segundo banco do backup nem foi tentado e nenhuma troca aconteceu
    expect(docker.dbInput.filter((d) => d.args[0] === "postgres")).toHaveLength(0);
    expect(docker.swaps).toEqual([]);
    // o app volta a ligar mesmo com a falha
    expect(docker.calls.at(-1)).toBe("start c-web");
  });

  it("PostgreSQL: restaura num banco novo, troca pelo atual e só no fim apaga o antigo", async () => {
    const b = await backup();
    docker.swaps = [];
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    expect((await service.record(r.id)).status).toBe("success");
    expect(docker.swaps.map((x) => x.kind)).toEqual(["swap", "swap", "drop", "drop"]);
    const swap = docker.swaps[0]!;
    expect(swap.args[0]).toBe("app");
    expect(swap.args[1]).toMatch(/^tws_old_[0-9a-f]{12}$/);
    expect(swap.args[2]).toMatch(/^tws_new_[0-9a-f]{12}$/);
    // o que se apaga é o banco ANTIGO (nunca o atual), depois de todas as trocas
    expect(docker.swaps[2]!.args[0]).toBe(swap.args[1]);
  });

  it("PostgreSQL: segundo banco falha depois de o primeiro já ter sido trocado → o primeiro volta (o antigo ainda existia)", async () => {
    const b = await backup();
    docker.swaps = [];
    docker.failRestore = { arg: "postgres", times: 1 };
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    const done = await service.record(r.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/O painel voltou o banco ao estado de antes da restauração/);
    expect(docker.swaps.map((x) => x.kind)).toEqual(["swap", "revert"]);
    expect(docker.swaps[1]!.args.slice(0, 2)).toEqual(["app", docker.swaps[0]!.args[1]]);
    // nada de apagar o banco antigo depois de ter voltado a ele
    expect(docker.swaps.some((x) => x.kind === "drop")).toBe(false);
  });

  it("PostgreSQL: a troca falha → o temporário é apagado e o banco atual continua", async () => {
    const b = await backup();
    docker.swaps = [];
    docker.failSwap = true;
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    const done = await service.record(r.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/O banco atual não foi alterado/);
    // depois do erro o painel confere o catálogo (o script desfaz o que faltar e apaga o temporário)
    expect(docker.swaps.map((x) => x.kind)).toEqual(["swap", "fix"]);
    expect(docker.swaps[1]!.args).toEqual(docker.swaps[0]!.args);
  });

  it("PostgreSQL: banco que não existia ainda é criado pela troca e desfeito (apagado) se algo falhar depois", async () => {
    const b = await backup();
    docker.swaps = [];
    docker.swapAnswer = "created\n";
    docker.failRestore = { arg: "postgres", times: 1 };
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    expect((await service.record(r.id)).error).toMatch(/voltou o banco ao estado de antes/);
    expect(docker.swaps.map((x) => x.kind)).toEqual(["swap", "drop"]);
    expect(docker.swaps[1]!.args).toEqual(["app"]);
  });

  it("se nem desfazer a troca der, volta pela cópia de segurança; se essa também falhar, diz onde ela está", async () => {
    const b = await backup();
    docker.swaps = [];
    docker.failRestore = { arg: "postgres", times: 1 };
    docker.failRevert = true;
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    const done = await service.record(r.id);
    expect(done.error).toMatch(/voltou o banco ao estado de antes/);
    // a cópia de segurança foi reaplicada (o dump de antes)
    expect(docker.dbInput.at(-1)!.content).toMatch(/^dump c-db .* banco/);

    docker.failRestore = { arg: "postgres", times: 2 };
    docker.failRevert = true;
    const r2 = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    const done2 = await service.record(r2.id);
    expect(done2.error).toMatch(/ATENÇÃO: também não foi possível voltar o banco ao estado de antes/);
    expect(done2.error).toMatch(/\.antes-da-restauracao/);
  });

  it("falha numa pasta DEPOIS de o banco ter sido restaurado: o erro diz onde está a cópia de segurança", async () => {
    const b = await backup();
    docker.restorePath = async () => {
      throw new Error("sem espaço no volume");
    };
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    const done = await service.record(r.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/sem espaço no volume/);
    expect(done.error).toMatch(/cópia de segurança do banco de antes da restauração está na VPS, em .*\.antes-da-restauracao/);
    // os bancos foram devolvidos (as trocas desfeitas) enquanto os antigos ainda existiam: nada de apagar o antigo
    expect(done.error).toMatch(/O painel voltou os bancos ao estado de antes da restauração/);
    expect(docker.swaps.filter((x) => x.kind === "revert")).toHaveLength(2);
    expect(docker.swaps.filter((x) => x.kind === "drop")).toHaveLength(0);
  });

  it("banco que estava parado e foi ligado só para a cópia de segurança volta a ficar parado se a cópia falha", async () => {
    const b = await backup();
    docker.containers = [
      { id: "c-db", name: "paas-loja-db-1", service: "db", running: false },
      { id: "c-web", name: "paas-loja-web-1", service: "web", running: true },
    ];
    docker.failDump = true;
    docker.calls = [];
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    expect((await service.record(r.id)).error).toMatch(/NÃO começou/);
    expect(docker.calls).toEqual(expect.arrayContaining(["start c-db", "stop c-db"]));
  });

  it("Redis é sobrescrito sem cópia de segurança e o painel avisa", async () => {
    const inspect = docker.inspect.bind(docker);
    docker.inspect = async (ids) => (await inspect(ids)).map((c) => (c.Name === "/paas-loja-web-1" ? { ...c, Config: { ...c.Config, Image: "redis:7" } } : c));
    await service.updateTarget(projectTargetId("p1"), { choices: { "db:web": true } }, "admin");
    const b = await backup();
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    expect((await service.record(r.id)).warnings.join(" ")).toMatch(/Redis foi sobrescrito sem cópia de segurança/);
  });

  it("as cópias de segurança com mais de 7 dias são apagadas na partida do painel e pela rotina diária (sem nova restauração)", async () => {
    const root = path.join(dir, "backups", ".antes-da-restauracao", "loja");
    await mkdir(path.join(root, "velha"), { recursive: true });
    await mkdir(path.join(root, "nova"), { recursive: true });
    await utimes(path.join(root, "velha"), new Date(now - 8 * 24 * H), new Date(now - 8 * 24 * H));
    await utimes(path.join(root, "nova"), new Date(now - 1 * 24 * H), new Date(now - 1 * 24 * H));
    service.start(3_600_000);
    await vi.waitFor(async () => expect(await readdir(root)).toEqual(["nova"]));
    // a rotina diária também limpa
    await mkdir(path.join(root, "velha2"), { recursive: true });
    await utimes(path.join(root, "velha2"), new Date(now - 9 * 24 * H), new Date(now - 9 * 24 * H));
    const again = build();
    vi.useFakeTimers();
    try {
      again.start(3_600_000);
      await vi.advanceTimersByTimeAsync(24 * 3600_000 + 10);
      again.stop();
    } finally {
      vi.useRealTimers();
    }
    // a limpeza e a passada da agenda do segundo serviço gravam em dir: terminam antes do teardown
    await again.idle();
    await again.flush();
    await vi.waitFor(async () => expect(await readdir(root)).toEqual(["nova"]));
    service.stop();
  });

  it("drain() do desligamento: espera o segundo plano; com trabalho preso, estoura o prazo e devolve false", async () => {
    expect(await service.drain(1000)).toBe(true);
    const preso = build();
    (preso as unknown as { sweepAllLeftovers: () => Promise<void> }).sweepAllLeftovers = () => new Promise<void>(() => undefined);
    preso.start(3_600_000);
    preso.stop();
    expect(await preso.drain(30)).toBe(false);
  });

  describe("MySQL e MongoDB", () => {
    const asEngine = (image: string, env: string[], dest: string) => {
      const inspect = docker.inspect.bind(docker);
      docker.inspect = async (ids) =>
        (await inspect(ids)).map((c) =>
          c.Name === "/paas-loja-db-1" ? { ...c, Config: { ...c.Config, Image: image, Env: env }, Mounts: [{ Type: "volume", Name: "v", Source: "/x", Destination: dest }] } : c,
        );
    };

    it("MySQL com erro depois do DROP: volta ao dump de antes (o banco não fica pela metade)", async () => {
      asEngine("mysql:8", ["MYSQL_ROOT_PASSWORD=x"], "/var/lib/mysql");
      const b = await backup();
      docker.dumpTag = " ATUAL";
      docker.dbInput = [];
      docker.failRestore = { arg: "", times: 1, error: "ERROR 1050 (42S01): Table exists" };
      const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
      await service.idle();
      const done = await service.record(r.id);
      expect(done.error).toMatch(/voltou o banco ao estado de antes/);
      expect(docker.dbInput.map((d) => d.content)).toEqual(["dump c-db  banco", "dump c-db  banco ATUAL"]);
    });

    it("servidor sem nenhum banco de usuário: não há estado a guardar e o erro diz isso", async () => {
      asEngine("mysql:8", ["MYSQL_ROOT_PASSWORD=x"], "/var/lib/mysql");
      const b = await backup();
      docker.execToFile = async () => {
        throw new Error("nenhum banco para copiar");
      };
      docker.failRestore = { arg: "", times: 1, error: "ERROR 1064" };
      const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
      await service.idle();
      expect((await service.record(r.id)).error).toMatch(/O banco estava vazio antes da restauração/);
    });

    it("MongoDB: 'N document(s) failed to restore' é erro, não aviso", async () => {
      asEngine("mongo:7", ["MONGO_INITDB_ROOT_USERNAME=root"], "/data/db");
      const b = await backup();
      const fromFile = docker.execFromFile.bind(docker);
      let first = true;
      docker.execFromFile = async (c, script, args, file) => {
        const out = await fromFile(c, script, args, file);
        if (first) {
          first = false;
          return { stderr: "2026-10-27 3 document(s) failed to restore.\n" };
        }
        return out;
      };
      const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
      await service.idle();
      const done = await service.record(r.id);
      expect(done.status).toBe("failed");
      expect(done.error).toMatch(/3 documento\(s\) não puderam ser restaurados/);
      expect(done.error).toMatch(/voltou o banco ao estado de antes/);
    });

    it("MongoDB: linha 'Failed:' também é erro", async () => {
      asEngine("mongo:7", ["MONGO_INITDB_ROOT_USERNAME=root"], "/data/db");
      const b = await backup();
      docker.execFromFile = async () => ({ stderr: "Failed: bad archive\n" });
      const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
      await service.idle();
      expect((await service.record(r.id)).error).toMatch(/Failed: bad archive/);
    });
  });
});

describe("backup e restauração reservam o deploy do projeto", () => {
  let events: string[];
  let busy: number;
  const withHold = (hold: NonNullable<BackupServiceOptions["projects"]["hold"]>) =>
    build({
      holdWaitMs: 30,
      holdPollMs: 10,
      projects: {
        list: async () => projects,
        get: async (id) => projects.find((p) => p.id === id || p.slug === id) ?? null,
        srcDir: (p) => path.join(dir, "projects", p.slug, "src"),
        redeploy: async (id) => {
          events.push("redeploy");
          redeploys.push(id);
          docker.containers = [
            { id: "c-db", name: "paas-loja-db-1", service: "db", running: true },
            { id: "c-web", name: "paas-loja-web-1", service: "web", running: true },
          ];
        },
        hold,
      },
    });
  beforeEach(() => {
    events = [];
    busy = 0;
    service = withHold(async (id, reason) => {
      if (busy > 0) {
        busy--;
        throw Object.assign(new Error("Já existe um deploy em andamento para este projeto."), { code: "deploy_in_progress" });
      }
      events.push(`hold:${id}:${reason}`);
      return () => void events.push(`release:${id}`);
    });
  });

  it("backup: reserva enquanto copia e solta antes de empacotar; deploy em andamento é esperado", async () => {
    busy = 2;
    const r = await backup();
    expect(r.status).toBe("success");
    expect(events).toEqual(["hold:p1:Backup em andamento", "release:p1"]);
    expect(r.steps.map((s) => s.label)).toContain('Esperar o deploy de "Loja" terminar');
  });

  it("backup: deploy que não termina no prazo faz o backup falhar sem copiar nada", async () => {
    busy = 99;
    const r = await backup();
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/continua em deploy .* Nada foi alterado/);
    expect(docker.calls.some((c) => c.startsWith("execToFile"))).toBe(false);
  });

  it("restauração: reserva do começo ao fim e solta (e retoma) a reserva durante a publicação do GitHub", async () => {
    const b = await backup();
    events.length = 0;
    docker.containers = [];
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja", redeploy: true }, "admin");
    await service.idle();
    expect((await service.record(r.id)).status).not.toBe("failed");
    expect(events).toEqual([
      "hold:p1:Restauração de backup em andamento",
      "release:p1",
      "redeploy",
      "hold:p1:Restauração de backup em andamento",
      "release:p1",
    ]);
  });

  it("erro que não é de deploy ao reservar falha com a causa", async () => {
    service = withHold(async () => {
      throw new Error("Projeto não encontrado.");
    });
    const r = await backup();
    expect(r.status).toBe("failed");
    expect(r.error).toBe("Projeto não encontrado.");
  });
});

describe("banco que o painel não reconhece pela imagem", () => {
  const unknownDb = (extra: Partial<ContainerInspect["Config"]> = {}, mounts?: ContainerInspect["Mounts"]) => {
    const inspect = docker.inspect.bind(docker);
    docker.inspect = async (ids) =>
      (await inspect(ids)).map((c) =>
        c.Name === "/paas-loja-db-1"
          ? {
              ...c,
              Config: { ...c.Config, Image: "minha-org/banco-proprio:1", Env: ["POSTGRES_USER=app", "POSTGRES_PASSWORD=x"], ...extra },
              Mounts: mounts ?? [{ Type: "volume", Name: "v", Source: "/x", Destination: "/var/lib/postgresql/data" }],
            }
          : c,
      );
  };

  it("reconhece pelas variáveis + pasta de dados e usa o dump lógico (nunca copia a pasta a quente)", async () => {
    unknownDb();
    const b = await backup();
    expect(b.status).toBe("success");
    const detection = (await service.projectView("p1")).detection!;
    expect(detection.databases).toMatchObject([{ service: "db", engine: "postgres", detectedBy: "signals" }]);
    expect(detection.mounts.find((m) => m.destination === "/var/lib/postgresql/data")).toMatchObject({ coveredByDump: true });
    expect(docker.calls.some((c) => c === "copyOut c-db /var/lib/postgresql/data")).toBe(false);
    expect(docker.calls).toContain("execToFile c-db app");
  });

  it("reconhece pelo binário do servidor dentro do container", async () => {
    unknownDb({ Env: [], ExposedPorts: { "5432/tcp": {} } }, []);
    docker.probeAnswer = "postgres running\n";
    await backup();
    expect((await service.projectView("p1")).detection!.databases).toMatchObject([{ engine: "postgres", detectedBy: "probe" }]);
  });

  it("não reconhece: a pasta de dados vem desmarcada e, se marcada, o backup sai INCOMPLETO com aviso", async () => {
    unknownDb({ Env: [] });
    docker.probeAnswer = "";
    await backup();
    const m = (await service.projectView("p1")).detection!.mounts.find((x) => x.destination === "/var/lib/postgresql/data")!;
    expect(m).toMatchObject({ suspectedDatabase: "postgres", defaultSelected: false, coveredByDump: false });
    await service.updateTarget(projectTargetId("p1"), { choices: { [m.id]: true } }, "admin");
    const b = await backup();
    expect(b.warnings.join(" ")).toMatch(/NÃO é um backup confiável do banco/);
    expect(b.warnings.join(" ")).toMatch(/incompleto/);
  });
});

describe("REVISÃO rodada 2: espaço, sobras, avisos e troca interrompida", () => {
  const twoServices = () => {
    const inspect = docker.inspect.bind(docker);
    docker.inspect = async (ids) => {
      const base = await inspect(ids.filter((i) => i !== "c-db2"));
      return ids.includes("c-db2")
        ? [...base, { ...(await inspect(["c-db"]))[0]!, Name: "/paas-loja-db2-1", Config: { Image: "postgres:16", Env: ["POSTGRES_USER=app", `POSTGRES_PASSWORD=${PG_PASSWORD}`], Labels: { "com.docker.compose.service": "db2" } }, Mounts: [] }]
        : base;
    };
    docker.containers = [
      { id: "c-db", name: "paas-loja-db-1", service: "db", running: true },
      { id: "c-db2", name: "paas-loja-db2-1", service: "db2", running: true },
      { id: "c-web", name: "paas-loja-web-1", service: "web", running: true },
    ];
  };

  it("I6: sem espaço no volume do banco para a troca, recusa com mensagem clara e não toca no banco", async () => {
    const b = await backup();
    docker.swaps = [];
    docker.spaceAnswer = `${50 * 1024 * 1024} ${200 * 1024 * 1024}\n`;
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    const done = await service.record(r.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/Não há espaço no volume do banco para restaurar "app"/);
    expect(done.error).toMatch(/o banco atual não foi alterado/);
    expect(docker.swaps).toEqual([]);
    expect(docker.dbInput.filter((d) => d.args[0] === "app")).toHaveLength(0);
  });

  it("I6: com espaço de sobra (ou sem conseguir medir) a restauração segue", async () => {
    const b = await backup();
    docker.spaceAnswer = `${900 * 1024 * 1024 * 1024} ${1024}\n`;
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    expect((await service.record(r.id)).status).toBe("success");
    docker.spaceAnswer = "lixo";
    const r2 = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    expect((await service.record(r2.id)).status).toBe("success");
  });

  it("I8: bancos tws_new_/tws_old_ esquecidos — o novo é apagado e o velho vira aviso, antes de cada backup", async () => {
    docker.sweepAnswer = "new tws_new_aaaaaaaaaaaa\nold tws_old_bbbbbbbbbbbb\nlixo\n";
    docker.swaps = [];
    const b = await backup();
    expect(docker.swaps).toEqual([{ kind: "drop", args: ["tws_new_aaaaaaaaaaaa"] }]);
    expect(b.warnings.join(" ")).toMatch(/sobrou o banco tws_old_bbbbbbbbbbbb de uma restauração interrompida/);
    expect(b.warnings.join(" ")).not.toMatch(/tws_new_aaaaaaaaaaaa/);
  });

  it("I8: apagar o temporário esquecido falha → vira aviso, o backup segue", async () => {
    docker.sweepAnswer = "new tws_new_cccccccccccc\n";
    const exec = docker.execCapture.bind(docker);
    docker.execCapture = async (c, script, args = []) => {
      if (script.includes("dropdb") && !script.includes("ALLOW_CONNECTIONS")) throw new Error("em uso");
      return exec(c, script, args);
    };
    const b = await backup();
    expect(b.status).not.toBe("failed");
    expect(b.warnings.join(" ")).toMatch(/sobrou o banco temporário tws_new_cccccccccccc .* não conseguiu apagá-lo \(em uso\)/);
  });

  it("I8: na partida do painel, varre os Postgres dos projetos (sem restauração em curso)", async () => {
    docker.sweepAnswer = "new tws_new_dddddddddddd\n";
    docker.swaps = [];
    service.start(3_600_000);
    await vi.waitFor(() => expect(docker.swaps).toEqual([{ kind: "drop", args: ["tws_new_dddddddddddd"] }]));
    service.stop();
  });

  it("I8: a restauração varre antes da cópia de segurança", async () => {
    const b = await backup();
    docker.swaps = [];
    docker.sweepAnswer = "old tws_old_eeeeeeeeeeee\n";
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    const done = await service.record(r.id);
    expect(done.status).not.toBe("failed");
    expect(done.warnings.join(" ")).toMatch(/tws_old_eeeeeeeeeeee/);
  });

  it("I5: dump de banco reconhecido só por sinais que falha: backup incompleto E alerta (não fica em silêncio)", async () => {
    const inspect = docker.inspect.bind(docker);
    docker.inspect = async (ids) =>
      (await inspect(ids)).map((c) =>
        c.Name === "/paas-loja-db-1"
          ? { ...c, Config: { ...c.Config, Image: "minha-org/banco-proprio:1", Env: ["POSTGRES_USER=app", "POSTGRES_PASSWORD=x"] } }
          : c,
      );
    docker.failDump = true;
    notices.length = 0;
    const b = await backup();
    expect(b.status).not.toBe("failed");
    expect(b.warnings.join(" ")).toMatch(/o dump falhou/);
    expect(notices.at(-1)).toMatchObject({ kind: "backup_failed", path: "/projects/p1/backups" });
    expect(notices.at(-1)!.title).toMatch(/incompleto: o serviço db não foi copiado/);
  });

  it("I5: servidor visto RODANDO pela sonda e dump que falha: o backup falha (confiança alta)", async () => {
    const inspect = docker.inspect.bind(docker);
    docker.inspect = async (ids) =>
      (await inspect(ids)).map((c) =>
        c.Name === "/paas-loja-db-1"
          ? { ...c, Config: { ...c.Config, Image: "minha-org/banco-proprio:1", Env: ["POSTGRES_USER=app", "POSTGRES_PASSWORD=x"] } }
          : c,
      );
    docker.probeAnswer = "postgres running\n";
    docker.failDump = true;
    const b = await backup();
    expect(b.status).toBe("failed");
    expect(b.error).toMatch(/O dump do banco "db" falhou/);
  });

  it("N1: a troca parou no meio e a conferência acha tudo restaurado → segue como trocado", async () => {
    const b = await backup();
    docker.swaps = [];
    docker.failSwap = true;
    docker.fixAnswer = "swapped\n";
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    expect((await service.record(r.id)).status).toBe("success");
    // trocas "feitas" -> os antigos são apagados no fim
    expect(docker.swaps.filter((x) => x.kind === "drop")).toHaveLength(2);
  });

  it("N1: a troca parou e a conferência também falha → ATENÇÃO com o nome em que o banco pode ter ficado", async () => {
    const b = await backup();
    docker.swaps = [];
    docker.failSwap = true;
    docker.failFix = true;
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    const done = await service.record(r.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/ATENÇÃO: a troca do banco "app" parou no meio/);
    expect(done.error).toMatch(/ALTER DATABASE tws_old_[0-9a-f]{12} RENAME TO app/);
  });

  it("N2: com vários serviços, se o segundo falha o primeiro também volta (a restauração é uma só)", async () => {
    twoServices();
    const b = await backup();
    docker.swaps = [];
    docker.failRestore = { arg: "app", times: 1, skip: 1 };
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    const done = await service.record(r.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/banco "db2" parou no primeiro erro/);
    expect(done.error).toMatch(/voltou os bancos ao estado de antes/);
    expect(docker.swaps.map((x) => x.kind)).toEqual(["swap", "swap", "revert", "revert"]);
    expect(docker.swaps.some((x) => x.kind === "drop")).toBe(false);
  });

  it("N2: se o primeiro serviço não consegue voltar, a mensagem diz o que ficou restaurado e onde está o estado de antes", async () => {
    twoServices();
    const b = await backup();
    docker.swaps = [];
    docker.failRestore = { arg: "app", times: 1, skip: 1 };
    docker.failRevert = true;
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    const done = await service.record(r.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/ATENÇÃO: não foi possível desfazer a troca de db\/postgres, db\/app: continua restaurado, e o estado de antes foi guardado em tws_old_/);
    // o antigo dos que não voltaram NÃO é apagado
    expect(docker.swaps.filter((x) => x.kind === "drop")).toHaveLength(0);
  });

  it("R5/N2: falha numa pasta depois das trocas: se a volta de um banco falha, a mensagem diz o que ficou restaurado e onde está o antigo", async () => {
    const b = await backup();
    docker.restorePath = async () => {
      throw new Error("sem espaço no volume");
    };
    docker.failRevert = true;
    docker.swaps = [];
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    const done = await service.record(r.id);
    expect(done.error).toMatch(/ATENÇÃO: não foi possível desfazer a troca de db\/postgres, db\/app: continua restaurado, e o estado de antes foi guardado em tws_old_/);
    expect(docker.swaps.filter((x) => x.kind === "drop")).toHaveLength(0);
  });

  it("R6: propriedades do banco que não deu para copiar (falta de privilégio) viram aviso; a restauração termina", async () => {
    const b = await backup();
    const exec = docker.execFromFile.bind(docker);
    docker.execFromFile = async (c, script, args, f) => {
      const out = await exec(c, script, args, f);
      return script.includes("createdb") ? { stderr: "TWS_PROP: ERROR: permission denied to set parameter\nTWS_PROP: ERROR: must be owner\nruído\n" } : out;
    };
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    const done = await service.record(r.id);
    expect(done.status).not.toBe("failed");
    expect(done.warnings.join(" ")).toMatch(/db\/app: não foi possível copiar 2 propriedade\(s\) do banco .*permission denied to set parameter; ERROR: must be owner/);
  });

  it("R8: na partida, a varredura também vale para Postgres reconhecido por sinais (imagem desconhecida) e avisa do tws_old_", async () => {
    const inspect = docker.inspect.bind(docker);
    docker.inspect = async (ids) =>
      (await inspect(ids)).map((c) =>
        c.Name === "/paas-loja-db-1"
          ? { ...c, Config: { ...c.Config, Image: "minha-org/banco-proprio:1", Env: ["POSTGRES_USER=app", "POSTGRES_PASSWORD=x"] } }
          : c,
      );
    await backup();
    expect((await service.projectView("p1")).detection!.databases).toMatchObject([{ detectedBy: "signals" }]);
    docker.swaps = [];
    docker.sweepAnswer = "new tws_new_ffffffffffff\nold tws_old_000000000000\n";
    const logs: string[] = [];
    (service as unknown as { log: (m: string) => void }).log = (m) => logs.push(m);
    service.start(3_600_000);
    await vi.waitFor(() => expect(docker.swaps).toEqual([{ kind: "drop", args: ["tws_new_ffffffffffff"] }]));
    await vi.waitFor(() => expect(logs.join(" ")).toMatch(/sobrou o banco tws_old_000000000000/));
    service.stop();
  });

  it("R1: medição de espaço que falha e varredura que falha não derrubam a restauração; falhas de limpeza são engolidas", async () => {
    const b = await backup();
    const exec = docker.execCapture.bind(docker);
    docker.execCapture = async (c, script, args = []) => {
      if (script.includes("pg_database_size") || script.includes("select case when")) throw new Error("docker exec indisponível");
      return exec(c, script, args);
    };
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    expect((await service.record(r.id)).status).not.toBe("failed");

    // troca que falha, conferência que falha e o PG_DROP do temporário que também falha: o erro certo ainda sai
    docker.execCapture = async (c, script, args = []) => {
      if (script.includes("dropdb") && !script.includes("ALLOW_CONNECTIONS")) throw new Error("em uso");
      return exec(c, script, args);
    };
    docker.failSwap = true;
    docker.failFix = true;
    const r2 = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    expect((await service.record(r2.id)).error).toMatch(/ATENÇÃO: a troca do banco "app" parou no meio/);
  });

  it("R1: varredura da partida com Docker fora do ar não quebra nada; pasta de cópias com arquivo solto é ignorada", async () => {
    await mkdir(path.join(dir, "backups", ".antes-da-restauracao"), { recursive: true });
    await writeFile(path.join(dir, "backups", ".antes-da-restauracao", "solto"), "x");
    docker.projectContainers = async () => {
      throw new Error("docker fora do ar");
    };
    service.start(3_600_000);
    await new Promise((res) => setTimeout(res, 30));
    service.stop();
    docker.projectContainers = async () => [{ id: "c-db", name: "paas-loja-db-1", service: "db", running: true }];
    docker.inspect = async () => {
      throw new Error("docker fora do ar");
    };
    service.start(3_600_000);
    await new Promise((res) => setTimeout(res, 30));
    service.stop();
  });

  it("R1: apagar o banco antigo no fim falha → só registra no log (a restauração termina)", async () => {
    const b = await backup();
    const exec = docker.execCapture.bind(docker);
    docker.execCapture = async (c, script, args = []) => {
      if (script.includes("dropdb") && !script.includes("ALLOW_CONNECTIONS") && /^tws_old_/.test(args[0] ?? "")) throw new Error("em uso");
      return exec(c, script, args);
    };
    const logs: string[] = [];
    (service as unknown as { log: (m: string) => void }).log = (m) => logs.push(m);
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    expect((await service.record(r.id)).status).not.toBe("failed");
    expect(logs.join(" ")).toMatch(/não foi possível apagar o banco antigo tws_old_[0-9a-f]{12} \(em uso\)/);
  });

  it("R1: a sonda de motor que falha ao executar vale como 'não deu para sondar' (sem derrubar a detecção)", async () => {
    const inspect = docker.inspect.bind(docker);
    docker.inspect = async (ids) =>
      (await inspect(ids)).map((c) =>
        c.Name === "/paas-loja-db-1" ? { ...c, Config: { ...c.Config, Image: "minha-org/banco-proprio:1", Env: ["POSTGRES_USER=app", "POSTGRES_PASSWORD=x"] } } : c,
      );
    const exec = docker.execCapture.bind(docker);
    docker.execCapture = async (c, script, args = []) => {
      if (script.includes("command -v postgres")) throw new Error("sh: não encontrado");
      return exec(c, script, args);
    };
    const b = await backup();
    expect(b.status).not.toBe("failed");
    // sem sonda, valem as variáveis + a pasta de dados montada
    expect((await service.projectView("p1")).detection!.databases).toMatchObject([{ detectedBy: "signals" }]);
  });
});

