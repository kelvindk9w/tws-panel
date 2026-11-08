/**
 * backup-restore-check.test.ts — "Validar o backup restaurando numa cópia
 * descartável": depois do backup do projeto, o painel sobe um container NOVO da
 * mesma imagem do banco do projeto (sem rede, sem volumes do projeto, com
 * limites), restaura o dump nele, confere e remove o container; os .tar de
 * volumes, pastas e código são só listados.
 *
 * Docker, 7-Zip e armazenamento são de mentira; o disco é de verdade numa
 * pasta temporária. O que importa aqui: nada do projeto é tocado; o container
 * descartável é sempre removido (e registrado antes de existir); a fila não
 * deixa nada rodar junto; o resultado aparece no projeto e ao lado do backup;
 * falha avisa pelos canais; e nenhum dado nem senha vai para resultado,
 * histórico, auditoria, aviso ou log.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@paas/core";
import { ArchiveError } from "../src/services/backup-archive.js";
import type { ContainerInspect } from "../src/services/backup-detect.js";
import type { BackupDocker, ProjectContainer, SandboxSpec } from "../src/services/backup-docker.js";
import { StorageError, type BackupStorage, type StoredObject } from "../src/services/backup-s3.js";
import { BackupService, projectTargetId, type Archiver, type BackupServiceOptions } from "../src/services/backup-service.js";
import type { NotificationEvent } from "../src/services/notification-service.js";
import { httpError } from "../src/services/http-error.js";
import { removeDir } from "./helpers/tmp.js";
import type { Readable } from "node:stream";

/** Entrada do `docker exec -i`: arquivo ou fluxo (o dump filtrado do Postgres vai direto, sem cópia em disco). */
async function readInput(inFile: string | Readable): Promise<string> {
  if (typeof inFile === "string") return readFile(inFile, "utf8");
  let text = "";
  for await (const chunk of inFile) text += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
  return text;
}


// ---------------------------------------------------------------------------
// Dublês
// ---------------------------------------------------------------------------

class FakeArchiver implements Archiver {
  extracted: Array<{ only: string[] | undefined }> = [];
  listed: string[] = [];
  listFail = new Set<string>();
  async available() {
    return true;
  }
  private async collect(p: string, base: string, out: Record<string, string>): Promise<void> {
    const s = await stat(p);
    if (s.isDirectory()) {
      for (const name of await readdir(p)) await this.collect(path.join(p, name), `${base}/${name}`, out);
    } else out[base] = (await readFile(p)).toString("base64");
  }
  async create(archive: string, inputs: string[], opts: { password?: string | null }) {
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
    await this.read(archive, password);
  }
  async extract(archive: string, outDir: string, password: string | null, only?: string[]) {
    this.extracted.push({ only });
    const files = await this.read(archive, password);
    for (const [rel, b64] of Object.entries(files)) {
      if (only && !only.some((o) => rel === o || rel.startsWith(`${o}/`))) continue;
      await mkdir(path.dirname(path.join(outDir, rel)), { recursive: true });
      await writeFile(path.join(outDir, rel), Buffer.from(b64, "base64"));
    }
  }
  async listTar(archive: string, password: string | null, entry: string) {
    const files = await this.read(archive, password);
    this.listed.push(entry);
    if (!(entry in files) || this.listFail.has(entry)) throw new ArchiveError(`O arquivo ${entry} não é um .tar legível.`, "failed");
    return 3;
  }
}

class FakeStorage implements BackupStorage {
  objects = new Map<string, Buffer>();
  failUpload = false;
  failList = false;
  async test() {}
  async upload(key: string, file: string) {
    if (this.failUpload) throw new StorageError("O armazenamento respondeu com erro 500.", "server_error");
    this.objects.set(key, await readFile(file));
  }
  async download(key: string, file: string) {
    const obj = this.objects.get(key);
    if (!obj) throw new StorageError("Arquivo não encontrado no armazenamento.", "not_found");
    await writeFile(file, obj);
  }
  async list(prefix: string): Promise<StoredObject[]> {
    if (this.failList) throw new StorageError("O armazenamento respondeu com erro 500.", "server_error");
    return [...this.objects.keys()]
      .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
      .sort()
      .map((key) => ({ key, size: this.objects.get(key)!.length, lastModified: null }));
  }
  async listFolders() {
    return [];
  }
  async remove(key: string) {
    this.objects.delete(key);
  }
  describe() {
    return "fake";
  }
}

const DB_SECRET = "senha-do-banco-nao-vaza";
const ROW_DATA = "DADO-PESSOAL-joao@example.com";

/** Dump do pg_dump (o que o painel guarda): uma tabela com 2 linhas, dono e permissão de papéis. */
function pgDump(): string {
  return [
    "--",
    "-- PostgreSQL database dump",
    "--",
    "CREATE TABLE public.animais (",
    "    id integer NOT NULL,",
    "    nome text",
    ");",
    "ALTER TABLE public.animais OWNER TO app;",
    "GRANT SELECT ON TABLE public.animais TO leitor;",
    "COPY public.animais (id, nome) FROM stdin;",
    `1\t${ROW_DATA}`,
    "2\tGRANT ALL ON x TO y;",
    "\\.",
    "-- PostgreSQL database dump complete",
    "",
  ].join("\n");
}

const MY_DUMP = ["-- MySQL dump", "CREATE DATABASE `outro`;", "CREATE TABLE `pedidos` (id int);", `INSERT INTO \`pedidos\` VALUES (1,'${ROW_DATA}');`, "-- Dump completed on 2026-10-14", ""].join("\n");

/** A resposta que o psql daria à conferência: tudo como o dump promete. */
function answerVerify(sql: string, restored: string): string[] {
  const rows = new Map<string, number>();
  let table: string | null = null;
  for (const l of restored.split("\n")) {
    const c = /^COPY (\S+) .*FROM stdin;$/.exec(l);
    if (c) {
      table = c[1]!;
      rows.set(table, 0);
    } else if (l === "\\.") table = null;
    else if (table) rows.set(table, rows.get(table)! + 1);
  }
  const out: string[] = [];
  const stmts = sql.split("\n");
  out.push(`T|${stmts.filter((l) => l.startsWith("select 'E'")).length}`);
  for (const l of stmts) {
    const e = /^select 'E', (\d+),/.exec(l);
    if (e) out.push(`E|${e[1]}|t`);
    const r = /^select 'R', (\d+), count\(\*\) from only (\S+);$/.exec(l);
    if (r) out.push(`R|${r[1]}|${rows.get(r[2]!) ?? 0}`);
  }
  return out;
}

interface Fleet {
  /** slug → containers */
  containers: Record<string, ProjectContainer[]>;
  /** id do container → imagem e banco do ambiente */
  dbs: Record<string, { image: string; dbName: string | null }>;
}

class FakeDocker implements BackupDocker {
  calls: string[] = [];
  /** O que entrou na restauração de cada container descartável. */
  restores: Array<{ container: string; content: string; timeoutMs?: number }> = [];
  verifies: Array<{ container: string; sql: string }> = [];
  sandboxes = new Map<string, { spec: SandboxSpec; running: boolean }>();
  runs: SandboxSpec[] = [];
  removed: string[] = [];
  /** Containers com o rótulo que o Docker listaria além dos que existem no mapa. */
  labeled: string[] = [];
  labeledProject: Record<string, string> = {};
  fleet: Fleet = {
    containers: {
      fazenda: [
        { id: "s-db", name: "paas-fazenda-db-1", service: "db", running: true },
        { id: "s-web", name: "paas-fazenda-web-1", service: "web", running: true },
      ],
      outro: [{ id: "o-db", name: "paas-outro-db-1", service: "db", running: true }],
    },
    dbs: {
      "s-db": { image: "postgres:16", dbName: "fazenda" },
      "o-db": { image: "mysql:8", dbName: "outro" },
    },
  };
  runError: Error | null = null;
  ready = true;
  restoreError: Error | null = null;
  verifyError: Error | null = null;
  verifyEdit: ((lines: string[]) => string[]) | null = null;
  removeFails = false;
  listFails = false;
  dump = pgDump();
  myDump = MY_DUMP;
  gate: Promise<void> | null = null;
  onRestore: (() => void) | null = null;
  /** O kernel matou o banco do container descartável por memória. */
  oom = false;
  /** Resposta do passo "space" do container descartável ("" = o container não diz). */
  spaceOut = "";
  async projectContainers(slug: string) {
    return (this.fleet.containers[slug] ?? []).map((c) => ({ ...c }));
  }
  async inspect(ids: string[]): Promise<ContainerInspect[]> {
    const out: ContainerInspect[] = [];
    for (const id of ids) {
      const sb = this.sandboxes.get(id);
      if (sb) out.push({ Name: `/${id}`, Config: { Image: sb.spec.image, Env: [], Labels: {} }, Mounts: [], State: { Running: sb.running, OOMKilled: this.oom } });
    }
    for (const [slug, list] of Object.entries(this.fleet.containers)) {
      for (const c of list) {
        if (!ids.includes(c.id)) continue;
        const db = this.fleet.dbs[c.id];
        out.push(
          db
            ? {
                Name: `/${c.name}`,
                Image: `sha256:${db.image.replace(/\W/g, "")}`,
                Config: {
                  Image: db.image,
                  Env: [`POSTGRES_USER=app`, `POSTGRES_PASSWORD=${DB_SECRET}`, ...(db.dbName ? [`POSTGRES_DB=${db.dbName}`, `MYSQL_DATABASE=${db.dbName}`] : [])],
                  Labels: { "com.docker.compose.service": c.service },
                },
                Mounts: [{ Type: "volume", Name: `paas-${slug}_data`, Source: "/x", Destination: db.image.startsWith("mysql") ? "/var/lib/mysql" : "/var/lib/postgresql/data" }],
                State: { Running: c.running },
              }
            : {
                Name: `/${c.name}`,
                Config: { Image: `paas-${slug}-web`, Env: [], Labels: { "com.docker.compose.service": c.service } },
                Mounts: [{ Type: "volume", Name: `paas-${slug}_uploads`, Source: "/x", Destination: "/app/uploads" }],
                State: { Running: c.running },
              },
        );
      }
    }
    return out;
  }
  async diff(): Promise<string> {
    return "";
  }
  async sizes(items: Array<{ id: string }>) {
    return { sizes: Object.fromEntries(items.map((i) => [i.id, 1000])), files: new Set<string>() };
  }
  async execToFile(container: string, script: string, args: string[], outFile: string) {
    this.calls.push(`execToFile ${container} ${args.join(",")}`);
    await writeFile(outFile, script.includes("globals-only") ? "-- papeis\n" : script.includes("pg_dump") ? this.dump : this.myDump);
    return { stderr: "" };
  }
  async execCapture(container: string, script: string): Promise<string> {
    this.calls.push(`execCapture ${container}${/# tws-rc:\w+:(\w+)/.exec(script)?.[1] ? ` ${/# tws-rc:\w+:(\w+)/.exec(script)![1]}` : ""}`);
    if (script.includes("# tws-rc:") && script.includes(":ready")) return this.ready ? "TWS-READY\n" : "";
    if (script.includes("# tws-rc:") && script.includes(":space")) return this.spaceOut;
    if (script.includes("# tws-rc:") && script.includes(":verify")) {
      if (this.verifyError) throw this.verifyError;
      return "T|1\n";
    }
    if (script.includes("SAVE")) return "OK\n";
    if (script.includes("pg_database")) return "fazenda\npostgres\n";
    return "";
  }
  async execFromFile(container: string, script: string, _args: string[], inFile: string | Readable, opts?: { timeoutMs?: number }) {
    this.calls.push(`execFromFile ${container}`);
    const content = await readInput(inFile);
    if (script.includes(":globals")) return { stderr: "", stdout: "" };
    if (script.includes(":verify")) {
      this.verifies.push({ container, sql: content });
      if (this.verifyError) throw this.verifyError;
      const out = answerVerify(content, this.restores.at(-1)?.content ?? "");
      return { stderr: "", stdout: `${(this.verifyEdit ? this.verifyEdit(out) : out).join("\n")}\n` };
    }
    this.restores.push({ container, content, timeoutMs: opts?.timeoutMs });
    this.onRestore?.();
    if (this.gate) await this.gate;
    if (this.restoreError) throw this.restoreError;
    return { stderr: "", stdout: "" };
  }
  async copyOut(container: string, p: string, outFile: string) {
    this.calls.push(`copyOut ${container} ${p}`);
    await writeFile(outFile, `tar ${container} ${p}`);
  }
  async copyIn(container: string) {
    this.calls.push(`copyIn ${container}`);
  }
  async restorePath(container: string) {
    this.calls.push(`restorePath ${container}`);
  }
  async restoreVolume(volume: string) {
    this.calls.push(`restoreVolume ${volume}`);
  }
  async mergeVolume(volume: string) {
    this.calls.push(`mergeVolume ${volume}`);
  }
  async state(container: string) {
    const sb = this.sandboxes.get(container);
    if (sb) return { exists: true, running: sb.running };
    return { exists: true, running: true };
  }
  async stop(container: string) {
    this.calls.push(`stop ${container}`);
  }
  async start(container: string) {
    this.calls.push(`start ${container}`);
  }
  async runSandbox(spec: SandboxSpec) {
    this.calls.push(`runSandbox ${spec.name}`);
    this.runs.push(spec);
    if (this.runError) throw this.runError;
    this.sandboxes.set(spec.name, { spec, running: true });
  }
  async removeSandbox(name: string) {
    this.calls.push(`removeSandbox ${name}`);
    if (this.removeFails) return false;
    this.removed.push(name);
    this.sandboxes.delete(name);
    this.labeled = this.labeled.filter((n) => n !== name);
    return true;
  }
  async listSandboxes() {
    if (this.listFails) throw new Error("docker fora do ar");
    return [
      ...[...this.sandboxes.values()].map((sb) => ({ name: sb.spec.name, projectId: sb.spec.labels["tws.restore-check.project"] ?? null })),
      ...this.labeled.map((name) => ({ name, projectId: this.labeledProject[name] ?? null })),
    ];
  }
}

function project(partial: Partial<Project>): Project {
  return {
    id: "p1",
    name: "Fazenda",
    slug: "fazenda",
    ingestMode: "git",
    source: "https://github.com/x/fazenda.git",
    branch: "main",
    domain: "fazenda.example.com",
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

let dir: string;
let now: number;
let docker: FakeDocker;
let archiver: FakeArchiver;
let storage: FakeStorage;
let notices: NotificationEvent[];
let audits: Array<{ action: string; detail: string }>;
let logs: string[];
let projects: Project[];
let busy: Set<string>;
let held: string[];
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
      redeploy: async () => undefined,
      hold: async (id) => {
        if (busy.has(id)) throw httpError(409, "deploy_in_progress", "Já existe um deploy em andamento para este projeto.");
        held.push(`hold:${id}`);
        return () => void held.push(`release:${id}`);
      },
    },
    mail: {
      container: "paas-stalwart",
      volume: "v",
      dataPath: "/d",
      etcPath: "/e",
      webmailContainer: "paas-webmail",
      webmailVolume: "w",
      webmailPath: "/w",
    },
    verifyLogin: async () => true,
    notify: (e) => notices.push(e),
    audit: { record: async (e) => void audits.push(e) },
    log: (m) => logs.push(m),
    now: () => now,
    statfs: async () => ({ bavail: free, bsize: 1, blocks: 100 * 1024 ** 3 }),
    readyDelayMs: 1,
    holdWaitMs: 20,
    holdPollMs: 5,
    restoreCheckTimeoutMs: 1234,
    restoreCheckStartTimeoutMs: 50,
    tar: {
      create: async (_p, name, out) => writeFile(out, `codigo ${name}`),
      extract: async () => undefined,
    },
    ...overrides,
  });
}

let service: BackupService;

const SRC = "p1";
const SRC_ID = projectTargetId(SRC);
const OTHER = "p3";

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-rcheck-"));
  now = new Date(2026, 9, 14, 10, 0).getTime();
  docker = new FakeDocker();
  archiver = new FakeArchiver();
  storage = new FakeStorage();
  notices = [];
  audits = [];
  logs = [];
  busy = new Set();
  held = [];
  free = 50 * 1024 ** 3;
  projects = [project({ id: SRC, name: "Fazenda", slug: "fazenda" }), project({ id: OTHER, name: "Outro", slug: "outro" })];
  service = build();
  for (const p of projects) await service.detectProject(p.id);
  // o outro projeto só entra no teste quando o caso pede
  await service.updateRestoreCheck(OTHER, { enabled: false }, "admin");
  audits.length = 0;
});

afterEach(async () => {
  await service.idle();
  await service.flush();
  await removeDir(dir);
});

async function backup(id = SRC_ID) {
  const r = await service.runNow(id, "admin");
  await service.idle();
  return service.record(r.id);
}

async function view(id = SRC) {
  return (await service.projectView(id)).restoreCheck;
}

async function lastCheckRecord() {
  return (await service.status()).history.find((h) => h.operation === "restore_check")!;
}

async function testNow(id = SRC) {
  const r = await service.runRestoreCheck(id, "admin");
  await service.idle();
  return service.record(r.id);
}

function sandboxRegistry(svc: BackupService = service): string[] {
  return (svc as unknown as { config: { restoreCheckSandboxes?: string[] } }).config.restoreCheckSandboxes ?? [];
}

async function until(cond: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condição não chegou");
}

const everything = () => JSON.stringify({ audits, notices, logs });

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

describe("configuração", () => {
  it("vem LIGADA (no máximo 1 vez por dia) em quem nunca mexeu, com os limites do container", async () => {
    const v = await view();
    expect(v).toMatchObject({ settings: { enabled: true, frequency: "daily" }, isDefault: true, unavailableCode: null, engine: "postgres", last: null });
    expect(v.limits).toEqual({ memoryMb: 1024, cpus: 1, restoreMinutes: 0 });
    expect((await service.status()).targets.find((t) => t.id === SRC_ID)!.restoreCheck).toEqual({ enabled: true, last: null });
  });

  it("o padrão pode vir desligado (opção do serviço)", async () => {
    service = build({ restoreCheckDefaultEnabled: false });
    expect((await view()).settings.enabled).toBe(false);
    await backup();
    expect(docker.runs).toEqual([]);
  });

  it("desligar, religar e trocar a frequência: auditado, sem confirmação digitada; frequência inválida é recusada", async () => {
    let v = await service.updateRestoreCheck(SRC, { enabled: false }, "admin");
    expect(v).toMatchObject({ settings: { enabled: false, frequency: "daily" }, isDefault: false });
    v = await service.updateRestoreCheck(SRC, { enabled: true, frequency: "weekly" }, "admin");
    expect(v.settings).toEqual({ enabled: true, frequency: "weekly" });
    await service.updateRestoreCheck(SRC, { enabled: true, frequency: "each" }, "admin");
    await service.updateRestoreCheck(SRC, { enabled: true }, "admin");
    expect((await view()).settings.frequency).toBe("each");
    expect(audits.map((a) => a.detail)).toEqual([
      "Fazenda: teste de restauração desligado.",
      "Fazenda: teste de restauração ligado.",
      "Fazenda: frequência do teste de restauração alterada.",
    ]);
    await expect(service.updateRestoreCheck(SRC, { enabled: true, frequency: "hourly" as never }, "admin")).rejects.toMatchObject({ code: "invalid_restore_check_frequency" });
  });

  it("projeto sem banco detectado: confere só os arquivos (engine null); não detectado: indisponível e 'Testar' recusa", async () => {
    docker.fleet.containers.fazenda = [{ id: "s-web", name: "paas-fazenda-web-1", service: "web", running: true }];
    await service.detectProject(SRC);
    expect(await view()).toMatchObject({ engine: null, unavailableCode: null });
    projects.push(project({ id: "p9", name: "Novo", slug: "novo", lastDeployAt: null }));
    const v = await view("p9");
    expect(v).toMatchObject({ unavailableCode: "undetected" });
    expect(v.unavailableReason).toMatch(/detectado/);
    await expect(service.runRestoreCheck("p9", "admin")).rejects.toMatchObject({ code: "restore_check_unavailable" });
  });
});

// ---------------------------------------------------------------------------
// Depois do backup
// ---------------------------------------------------------------------------

describe("depois do backup", () => {
  it("sobe uma cópia descartável da MESMA imagem, restaura o dump, confere, remove a cópia e lista os volumes", async () => {
    const b = await backup();
    expect(docker.runs).toHaveLength(1);
    const spec = docker.runs[0]!;
    expect(spec.name).toMatch(/^tws-rc-[0-9a-f]{16}$/);
    // o id da imagem em uso pelo banco do projeto, não o nome com a etiqueta
    expect(spec.image).toBe("sha256:postgres16");
    expect(spec).toMatchObject({ memoryMb: 1024, cpus: 1, pids: 512, labels: { "tws.restore-check.project": SRC } });
    expect(JSON.stringify(spec)).not.toContain(DB_SECRET);
    // os DOIS bancos do backup (fazenda e postgres), no mesmo container descartável, cada um no seu banco
    expect(docker.restores).toEqual([
      { container: spec.name, content: expect.any(String), timeoutMs: 1234 },
      { container: spec.name, content: expect.any(String), timeoutMs: 1234 },
    ]);
    const r = docker.restores[0]!;
    expect(r.content).toContain("CREATE TABLE public.animais");
    expect(r.content).not.toContain("OWNER TO");
    expect(r.content).toContain("2\tGRANT ALL ON x TO y;");
    expect(docker.verifies[0]!.sql).toContain("to_regclass('public.animais')");
    expect(docker.removed).toEqual([spec.name]);
    expect(sandboxRegistry()).toEqual([]);
    expect(archiver.listed).toEqual(["volumes/web__app_uploads.tar"]);
    const v = await view();
    expect(v.last).toMatchObject({
      status: "ok",
      trigger: "auto",
      engine: "postgres",
      image: "postgres:16",
      reasonCode: null,
      backupFileName: b.fileName,
      checked: { tables: 2, rows: 4, files: 1 },
      databases: [
        { service: "db", engine: "postgres", name: "fazenda", status: "ok", tables: 1, rows: 2 },
        { service: "db", engine: "postgres", name: "postgres", status: "ok", tables: 1, rows: 2 },
      ],
    });
    expect(typeof v.last!.durationMs).toBe("number");
    expect(notices).toEqual([]);
    // ao lado do backup, no histórico do projeto
    const hist = (await service.projectView(SRC)).history.find((h) => h.operation === "backup")!;
    expect(hist.restoreCheck).toMatchObject({ status: "ok", reasonCode: null });
  });

  it("nunca toca no projeto: nem containers, nem volumes, nem redes; só o manifesto e os dumps saem no disco", async () => {
    await backup();
    const touched = docker.calls.filter((c) => /^(copyIn|restorePath|restoreVolume|mergeVolume|stop|start)/.test(c));
    expect(touched).toEqual([]);
    // tudo o que roda no teste roda no container descartável
    const after = docker.calls.slice(docker.calls.findIndex((c) => c.startsWith("runSandbox")));
    expect(after.filter((c) => /s-db|s-web|paas-fazenda/.test(c))).toEqual([]);
    expect(archiver.extracted.at(-1)!.only).toEqual(["manifesto.json", "bancos"]);
  });

  it("NÃO reserva o projeto: só o backup reserva; deploy, recriar e a limpeza do Docker não esperam o teste", async () => {
    await backup();
    // só o par do backup
    expect(held).toEqual([`hold:${SRC}`, `release:${SRC}`]);
    let release!: () => void;
    docker.gate = new Promise<void>((r) => (release = r));
    const before = docker.restores.length;
    const p = service.runRestoreCheck(SRC, "admin");
    await until(async () => docker.restores.length > before);
    // com o teste rodando: a limpeza do Docker não vê "backup em andamento"
    expect(service.isBusy()).toBe(false);
    expect(held).toEqual([`hold:${SRC}`, `release:${SRC}`]);
    release();
    await p;
  });

  it("projeto em deploy: o teste roda mesmo assim (não mexe no projeto)", async () => {
    const b = await backup();
    docker.runs.length = 0;
    busy.add(SRC);
    const rec = await testNow();
    expect(rec.status).toBe("success");
    expect((await view()).last).toMatchObject({ status: "ok", backupFileName: b.fileName });
    expect(docker.runs).toHaveLength(1);
  });

  it("um deploy que troca o container do banco no meio: o teste segue com a imagem que já pegou", async () => {
    await backup();
    let release!: () => void;
    docker.gate = new Promise<void>((r) => (release = r));
    const before = docker.restores.length;
    const p = service.runRestoreCheck(SRC, "admin");
    await until(async () => docker.restores.length > before);
    docker.fleet.dbs["s-db"] = { image: "postgres:17", dbName: "fazenda" };
    docker.fleet.containers.fazenda = [{ id: "s-db", name: "paas-fazenda-db-1", service: "db", running: true }];
    release();
    await p;
    await service.idle();
    expect(docker.runs.at(-1)!.image).toBe("sha256:postgres16");
    expect((await view()).last).toMatchObject({ status: "ok", image: "postgres:16" });
  });

  it("entra na fila do BackupService: uma operação por vez, nunca junto de outro backup ou restauração", async () => {
    let release!: () => void;
    docker.gate = new Promise<void>((r) => (release = r));
    await service.runNow(SRC_ID, "admin");
    await until(async () => (await service.status()).running?.operation === "restore_check");
    const other = await service.runNow(projectTargetId(OTHER), "admin");
    const s = await service.status();
    expect(s.running?.operation).toBe("restore_check");
    expect(s.queued.map((q) => q.id)).toContain(other.id);
    expect((await view()).last?.status).toBe("running");
    release();
    await service.idle();
  });

  it("registra a execução no histórico (operação restore_check) e a vê na situação", async () => {
    await backup();
    const rec = await lastCheckRecord();
    expect(rec).toMatchObject({ target: SRC_ID, status: "success", trigger: "schedule" });
    expect(rec.steps.map((st) => st.label).join("|")).toMatch(/cópia descartável \(postgres:16\)/);
    expect((await service.status()).targets.find((x) => x.id === SRC_ID)!.restoreCheck).toMatchObject({ enabled: true, last: { status: "ok" } });
  });

  it("o que o banco devolve nunca vai para o resultado, o histórico, a auditoria, os avisos nem o log", async () => {
    await backup();
    docker.restoreError = new Error(`ERROR: duplicate key ${ROW_DATA}`);
    await testNow();
    expect(everything()).not.toContain(ROW_DATA);
    expect(everything()).not.toContain(DB_SECRET);
    expect(JSON.stringify(await service.status())).not.toContain(ROW_DATA);
    expect(await readFile(path.join(dir, "backups.json"), "utf8")).not.toContain(ROW_DATA);
  });

  it("backup que falhou não dispara o teste; a cópia externa falhando não impede", async () => {
    const real = docker.execToFile.bind(docker);
    docker.execToFile = async () => {
      throw new Error("pg_dump: conexão recusada");
    };
    expect((await backup()).status).toBe("failed");
    expect(docker.runs).toEqual([]);
    docker.execToFile = real;
    await service.setDestination({ provider: "r2", endpoint: "https://abc.r2.cloudflarestorage.com", region: "", bucket: "meus-backups", accessKeyId: "AKIAEXEMPLO1234", secretAccessKey: "chave" }, "admin");
    await service.setEncryption(false, "admin");
    storage.failUpload = true;
    expect((await backup()).remote).toBe("failed");
    expect((await view()).last?.status).toBe("ok");
  });

  it("idempotente: pedir o teste duas vezes seguidas roda uma vez só", async () => {
    await backup();
    let release!: () => void;
    docker.gate = new Promise<void>((r) => (release = r));
    const before = docker.runs.length;
    const [a, b] = await Promise.all([service.runRestoreCheck(SRC, "admin"), service.runRestoreCheck(SRC, "admin")]);
    expect(a.id).toBe(b.id);
    release();
    await service.idle();
    expect(docker.runs.length - before).toBe(1);
  });

  it("MySQL/MariaDB: a mesma imagem do projeto, restaurado e conferido (sem comparar linhas)", async () => {
    await service.updateRestoreCheck(OTHER, { enabled: true }, "admin");
    await backup(projectTargetId(OTHER));
    expect(docker.runs.at(-1)!.image).toBe("sha256:mysql8");
    expect((await view(OTHER)).last).toMatchObject({ status: "ok", engine: "mysql", checked: { tables: 1, rows: null, files: 0 } });
  });

  it("projeto sem banco no backup: só os volumes são conferidos, nada sobe", async () => {
    docker.fleet.containers.fazenda = [{ id: "s-web", name: "paas-fazenda-web-1", service: "web", running: true }];
    await service.detectProject(SRC);
    await backup();
    expect(docker.runs).toEqual([]);
    expect((await view()).last).toMatchObject({ status: "ok", engine: null, checked: { tables: 0, rows: null, files: 1 } });
  });
});

describe("frequência e 'Testar restauração'", () => {
  it("'no máximo 1 vez por dia' (padrão) pula o segundo backup do dia e volta no dia seguinte", async () => {
    await backup();
    now += 3_600_000 * 3;
    await backup();
    expect(docker.runs).toHaveLength(1);
    now += 3_600_000 * 22;
    await backup();
    expect(docker.runs).toHaveLength(2);
  });

  it("'no máximo 1 vez por dia' conta também o 'não executado' (não repete a cada backup um teste que não roda)", async () => {
    docker.runError = new Error("Error response from daemon: No such image: sha256:postgres16");
    await backup();
    expect((await view()).last).toMatchObject({ status: "not_run", reasonCode: "image_unavailable" });
    const checks = async () => (await service.status()).history.filter((h) => h.operation === "restore_check").length;
    const before = await checks();
    now += 3_600_000 * 3;
    await backup();
    expect(await checks()).toBe(before);
    now += 3_600_000 * 22;
    await backup();
    expect(await checks()).toBe(before + 1);
  });

  it("'no máximo 1 vez por semana' e 'após cada backup'", async () => {
    await service.updateRestoreCheck(SRC, { enabled: true, frequency: "weekly" }, "admin");
    await backup();
    now += 24 * 3_600_000 * 3;
    await backup();
    expect(docker.runs).toHaveLength(1);
    now += 24 * 3_600_000 * 5;
    await backup();
    expect(docker.runs).toHaveLength(2);
    await service.updateRestoreCheck(SRC, { enabled: true, frequency: "each" }, "admin");
    await backup();
    expect(docker.runs).toHaveLength(3);
  });

  it("'Testar restauração' ignora a frequência e vale mesmo com a opção desligada; audita o pedido", async () => {
    await backup();
    await service.updateRestoreCheck(SRC, { enabled: false }, "admin");
    const rec = await testNow();
    expect(rec.trigger).toBe("manual");
    expect(docker.runs).toHaveLength(2);
    expect((await view()).last).toMatchObject({ status: "ok", trigger: "manual" });
    expect(audits.at(-1)).toMatchObject({ action: "backups.restore_check_run" });
  });

  it("sem nenhum backup ainda: erro claro, nada enfileirado; cópia da VPS apagada e sem externa: idem", async () => {
    await expect(service.runRestoreCheck(SRC, "admin")).rejects.toMatchObject({ code: "no_backup" });
    const b = await backup();
    await rm(path.join(dir, "backups", "fazenda", b.fileName!));
    await expect(service.runRestoreCheck(SRC, "admin")).rejects.toMatchObject({ code: "no_backup" });
  });

  it("só tem a cópia externa cifrada: baixa, abre com a senha guardada e testa; senha trocada: 'não executado'", async () => {
    await service.setDestination({ provider: "r2", endpoint: "https://abc.r2.cloudflarestorage.com", region: "", bucket: "meus-backups", accessKeyId: "AKIAEXEMPLO1234", secretAccessKey: "chave" }, "admin");
    await service.setPassword("cavalo-azul-janela-trigo-mesa-41", true, "admin");
    const b = await backup();
    await rm(path.join(dir, "backups", "fazenda", b.fileName!));
    await testNow();
    expect((await view()).last).toMatchObject({ status: "ok", trigger: "manual", checked: { files: 1 } });
    await service.setPassword("outra-frase-longa-e-diferente-77", true, "admin");
    await testNow();
    expect((await view()).last).toMatchObject({ status: "not_run", reasonCode: "no_password" });
    expect(everything()).not.toContain("cavalo-azul");
    expect(everything()).not.toContain("outra-frase");
  });

  it("o armazenamento externo fora do ar na hora de escolher o backup: usa as cópias da VPS, a mais nova primeiro", async () => {
    await service.setDestination({ provider: "r2", endpoint: "https://abc.r2.cloudflarestorage.com", region: "", bucket: "meus-backups", accessKeyId: "AKIAEXEMPLO1234", secretAccessKey: "chave" }, "admin");
    await backup();
    now += 3600_000;
    const second = await backup();
    storage.failList = true;
    await testNow();
    expect((await view()).last).toMatchObject({ status: "ok", backupFileName: second.fileName });
  });
});

// ---------------------------------------------------------------------------
// Falhas e 'não executado'
// ---------------------------------------------------------------------------

describe("falhas: só é 'ok' quando restaurou sem erro e a conferência bateu", () => {
  beforeEach(async () => {
    await service.updateRestoreCheck(SRC, { enabled: false }, "admin");
    await backup();
    docker.runs.length = 0;
    notices.length = 0;
  });

  async function expectFailed(code: string) {
    const rec = await testNow();
    expect(rec.status).toBe("failed");
    const v = await view();
    expect(v.last).toMatchObject({ status: "failed", reasonCode: code, checked: null });
    expect(rec.error).toBe(v.last!.reason);
    expect(notices.at(-1)).toMatchObject({ kind: "backup_failed", key: `restore-check-failed:${SRC_ID}`, path: `/projects/${SRC}/backups` });
    const hist = (await service.projectView(SRC)).history.find((h) => h.operation === "backup")!;
    expect(hist.restoreCheck).toMatchObject({ status: "failed", reasonCode: code });
  }

  it("restore com erro: 'falhou', motivo fixo, aviso nos canais, container removido", async () => {
    docker.restoreError = new Error("ERROR: syntax");
    await expectFailed("restore_failed");
    expect(docker.removed).toHaveLength(1);
    expect(sandboxRegistry()).toEqual([]);
  });

  /** Limite do teste: "não executado", com o motivo, sem alerta de falha. */
  async function expectLimit(code: string) {
    const rec = await testNow();
    expect(rec.status).toBe("warning");
    expect((await view()).last).toMatchObject({ status: "not_run", reasonCode: code });
    expect((await view()).last!.reason).toMatch(/não indica defeito|não rodou/);
    expect(notices).toEqual([]);
    expect(docker.sandboxes.size).toBe(0);
  }

  it("passou do prazo ou da memória: 'não executado — limite do teste', sem alerta; o container foi removido", async () => {
    docker.restoreError = new Error("o comando passou do prazo e foi interrompido");
    await expectLimit("timeout");
    docker.oom = true;
    docker.restoreError = new Error("docker saiu com código 137");
    await expectLimit("memory_limit");
  });

  it("a conferência não bate ou não roda", async () => {
    docker.verifyEdit = (lines) => lines.map((l) => l.replace(/^R\|0\|2$/, "R|0|1"));
    await expectFailed("sanity_failed");
    docker.verifyEdit = null;
    docker.verifyError = new Error(ROW_DATA);
    await expectFailed("sanity_failed");
  });

  it("dump com comando do psql: recusado sem subir nada", async () => {
    docker.dump = pgDump().replace("-- PostgreSQL database dump complete", "\\! id\n-- PostgreSQL database dump complete");
    now += 60_000;
    await backup();
    docker.runs.length = 0;
    await expectFailed("unsafe_dump");
    expect(docker.runs).toEqual([]);
  });

  it("o container descartável não fica pronto (ou a imagem não sobe): 'não executado', sem alerta, e é removido", async () => {
    docker.ready = false;
    await expectLimit("sandbox_failed");
    expect(docker.removed).toHaveLength(1);
    docker.ready = true;
    docker.runError = new Error("Error response from daemon: invalid");
    await expectLimit("sandbox_failed");
  });

  it("pouco espaço no disco do Docker (medido dentro do container): 'não executado', nada restaurado", async () => {
    docker.spaceOut = "F|1\n";
    docker.restores.length = 0;
    await expectLimit("no_space");
    expect(docker.restores).toEqual([]);
  });

  it("um .tar de volume que não abre: 'falhou' (o banco passou, mas o backup não está bom)", async () => {
    archiver.listFail.add("volumes/web__app_uploads.tar");
    await expectFailed("volume_check_failed");
  });

  it("não conseguiu confirmar a remoção: 'falhou' e o nome fica registrado; a próxima varredura remove", async () => {
    docker.removeFails = true;
    await expectFailed("cleanup_failed");
    const left = sandboxRegistry();
    expect(left).toHaveLength(1);
    await service.flush();
    expect(await readFile(path.join(dir, "backups.json"), "utf8")).toContain(left[0]!);
    docker.removeFails = false;
    await testNow();
    expect(docker.removed).toContain(left[0]);
    expect(sandboxRegistry()).toEqual([]);
  });

  it("erro inesperado dentro do teste: 'falhou' com texto fixo, sem o texto do erro no log", async () => {
    const inner = service as unknown as { step: (r: unknown, label: string) => void };
    const real = inner.step.bind(service);
    inner.step = (r, label) => {
      if (label === "Conferir o projeto") throw new Error(ROW_DATA);
      real(r, label);
    };
    const rec = await testNow();
    expect(rec.status).toBe("failed");
    expect((await view()).last).toMatchObject({ status: "failed", reasonCode: "restore_failed" });
    expect(logs.join("|")).toContain("terminou com erro inesperado");
    expect(logs.join("|")).not.toContain(ROW_DATA);
  });
});

describe("'não executado': nada sobe, nada é avisado", () => {
  beforeEach(async () => {
    await service.updateRestoreCheck(SRC, { enabled: false }, "admin");
    await backup();
    docker.runs.length = 0;
    notices.length = 0;
  });

  async function expectNotRun(code: string) {
    const rec = await testNow();
    expect(rec.status).toBe("warning");
    expect((await view()).last).toMatchObject({ status: "not_run", reasonCode: code });
    expect(notices).toEqual([]);
    const hist = (await service.projectView(SRC)).history.find((h) => h.operation === "backup")!;
    expect(hist.restoreCheck).toMatchObject({ status: "not_run", reasonCode: code });
  }

  it("a imagem do banco não está na VPS (container do banco não existe) ou o Docker diz que não tem a imagem", async () => {
    docker.fleet.containers.fazenda = [{ id: "s-web", name: "paas-fazenda-web-1", service: "web", running: true }];
    await expectNotRun("image_unavailable");
    expect(docker.runs).toEqual([]);
    docker.fleet.containers.fazenda = [{ id: "s-db", name: "paas-fazenda-db-1", service: "db", running: false }];
    docker.runError = new Error("Error response from daemon: No such image: sha256:postgres16");
    await expectNotRun("image_unavailable");
  });

  it("banco do backup sem tabela nenhuma e sem arquivos: 'não executado' dizendo quais bancos estão vazios", async () => {
    docker.dump = "-- PostgreSQL database dump\n-- PostgreSQL database dump complete\n";
    now += 60_000;
    await backup();
    docker.runs.length = 0;
    const inner = service as unknown as { openBackup: (...a: unknown[]) => Promise<unknown> };
    const real = inner.openBackup.bind(service);
    inner.openBackup = async (...a: unknown[]) => {
      const o = (await real(...a)) as { manifest: { items: Array<{ type: string }> } };
      o.manifest.items = o.manifest.items.filter((i) => i.type === "database");
      return o;
    };
    await expectNotRun("empty_database");
    expect(docker.runs).toEqual([]);
    expect((await view()).last!.databases).toEqual([
      { service: "db", engine: "postgres", name: "fazenda", status: "empty", tables: 0, rows: null },
      { service: "db", engine: "postgres", name: "postgres", status: "empty", tables: 0, rows: null },
    ]);
  });

  it("banco sem tabelas, mas com volumes: 'ok' pelos arquivos, e a tela diz que o banco estava vazio", async () => {
    docker.dump = "-- PostgreSQL database dump\n-- PostgreSQL database dump complete\n";
    now += 60_000;
    await backup();
    docker.runs.length = 0;
    const rec = await testNow();
    expect(rec.status).toBe("success");
    const last = (await view()).last!;
    expect(last).toMatchObject({ status: "ok", checked: { tables: 0, rows: null, files: 1 } });
    expect(last.databases!.map((d) => d.status)).toEqual(["empty", "empty"]);
  });

  it("sem espaço em disco", async () => {
    free = 0;
    await expectNotRun("no_space");
  });

  it("dois serviços de banco: testa os dois, um container descartável para cada, sem adivinhar qual é o principal", async () => {
    docker.fleet.containers.fazenda!.push({ id: "s-db2", name: "paas-fazenda-reports-1", service: "reports", running: true });
    docker.fleet.dbs["s-db2"] = { image: "postgres:15", dbName: "relatorios" };
    await service.detectProject(SRC);
    expect((await view()).engines).toEqual(["postgres"]);
    now += 60_000;
    await backup();
    docker.runs.length = 0;
    const rec = await testNow();
    expect(rec.status).toBe("success");
    expect(docker.runs.map((r) => r.image)).toEqual(["sha256:postgres16", "sha256:postgres15"]);
    expect([...new Set((await view()).last!.databases!.map((d) => d.service))]).toEqual(["db", "reports"]);
    // se o segundo serviço não tem mais container: 'não executado' (imagem ausente), dizendo o que já passou
    docker.fleet.containers.fazenda = docker.fleet.containers.fazenda!.filter((c) => c.id !== "s-db2");
    await expectNotRun("image_unavailable");
    expect((await view()).last!.databases!.map((d) => d.service)).toEqual(["db", "db"]);
  });

  it("backup incompleto; tamanho que não dá para medir", async () => {
    const record = (await service.status()).history.find((h) => h.operation === "backup")!;
    const inner = service as unknown as { enqueueRestoreCheck(id: string, name: string, f: unknown): unknown };
    inner.enqueueRestoreCheck(SRC, "Fazenda", { fileName: record.fileName, source: "local", sizeBytes: 100, trigger: "manual", incomplete: true });
    await service.idle();
    expect((await view()).last).toMatchObject({ status: "not_run", reasonCode: "backup_incomplete" });
    inner.enqueueRestoreCheck(SRC, "Fazenda", { fileName: record.fileName, source: "local", sizeBytes: null, trigger: "manual", incomplete: false });
    await service.idle();
    expect((await view()).last?.status).toBe("ok");
    inner.enqueueRestoreCheck(SRC, "Fazenda", { fileName: "2026-01-01_03-00.7z", source: "local", sizeBytes: null, trigger: "manual", incomplete: false });
    await service.idle();
    expect((await view()).last).toMatchObject({ status: "not_run", reasonCode: "backup_unreadable" });
    inner.enqueueRestoreCheck(SRC, "Fazenda", { fileName: "2026-01-01_03-00.7z", source: "remote", sizeBytes: null, trigger: "manual", incomplete: false });
    await service.idle();
    expect((await view()).last).toMatchObject({ status: "not_run", reasonCode: "backup_unreadable" });
    inner.enqueueRestoreCheck(SRC, "Fazenda", { fileName: "2026-01-01_03-00.7z", source: "local", sizeBytes: 10, trigger: "manual", incomplete: false });
    await service.idle();
    expect((await view()).last).toMatchObject({ status: "not_run", reasonCode: "backup_unreadable" });
  });

  it("backup sem banco nem arquivos para conferir", async () => {
    docker.fleet.containers.fazenda = [];
    const inner = service as unknown as { openBackup: (...a: unknown[]) => Promise<unknown> };
    const real = inner.openBackup.bind(service);
    inner.openBackup = async (...a: unknown[]) => {
      const o = (await real(...a)) as { manifest: { items: unknown[] } };
      o.manifest.items = [];
      return o;
    };
    await expectNotRun("nothing_to_check");
  });

  it("caminho inválido de um .tar no manifesto: 'falhou' sem ler nada", async () => {
    const inner = service as unknown as { openBackup: (...a: unknown[]) => Promise<unknown> };
    const real = inner.openBackup.bind(service);
    inner.openBackup = async (...a: unknown[]) => {
      const o = (await real(...a)) as { manifest: { items: Array<{ type: string; file?: string }> } };
      o.manifest.items = o.manifest.items.filter((i) => i.type !== "database").map((i) => ({ ...i, file: "volumes/../../etc.tar" }));
      return o;
    };
    const rec = await testNow();
    expect(rec.status).toBe("failed");
    expect((await view()).last).toMatchObject({ status: "failed", reasonCode: "backup_unreadable" });
  });

  it("dump do banco com caminho fora da pasta do backup: 'não executado'", async () => {
    const inner = service as unknown as { openBackup: (...a: unknown[]) => Promise<unknown> };
    const real = inner.openBackup.bind(service);
    inner.openBackup = async (...a: unknown[]) => {
      const o = (await real(...a)) as { manifest: { items: Array<{ type: string; databases?: unknown[] }> } };
      o.manifest.items = o.manifest.items.map((i) => (i.type === "database" ? { ...i, databases: [{ name: "fazenda", file: "../x.sql" }] } : i));
      return o;
    };
    await expectNotRun("backup_unreadable");
  });

  it("dump do Postgres só com o banco postgres: testa ele mesmo; sem nenhum dump: o serviço aparece vazio", async () => {
    const inner = service as unknown as { openBackup: (...a: unknown[]) => Promise<unknown> };
    const real = inner.openBackup.bind(service);
    let keep: (d: { name: string }) => boolean = (d) => d.name === "postgres";
    let onlyDb = false;
    inner.openBackup = async (...a: unknown[]) => {
      const o = (await real(...a)) as { manifest: { items: Array<{ type: string; databases?: Array<{ name: string; file: string }> }> } };
      o.manifest.items = o.manifest.items
        .filter((i) => !onlyDb || i.type === "database")
        .map((i) => (i.type === "database" ? { ...i, databases: i.databases!.filter(keep) } : i));
      return o;
    };
    expect((await testNow()).status).toBe("success");
    expect((await view()).last!.databases!.map((d) => d.name)).toEqual(["postgres"]);
    keep = () => false;
    onlyDb = true;
    await expectNotRun("empty_database");
    expect((await view()).last!.databases).toEqual([{ service: "db", engine: "postgres", name: null, status: "empty", tables: 0, rows: null }]);
  });
});

// ---------------------------------------------------------------------------
// Fila, desligar e reinício
// ---------------------------------------------------------------------------

describe("pedido que espera na fila e reinício do painel", () => {
  /** Ocupa a fila com o backup de outro projeto até chamar `release()`. */
  async function occupy(): Promise<{ release: () => void; other: { id: string } }> {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = docker.execToFile.bind(docker);
    docker.execToFile = async (...a: Parameters<FakeDocker["execToFile"]>) => {
      docker.execToFile = original;
      await gate;
      return original(...a);
    };
    const other = await service.runNow(projectTargetId(OTHER), "admin");
    await until(async () => (await service.status()).running?.id === other.id);
    return { release, other };
  }

  it("desligar a opção enquanto o teste automático espera: 'não executado' (nada sobe)", async () => {
    await service.updateRestoreCheck(SRC, { enabled: true, frequency: "each" }, "admin");
    await backup();
    docker.runs.length = 0;
    const { release } = await occupy();
    await service.runNow(SRC_ID, "admin");
    const inner = service as unknown as { queueAutoRestoreCheck(r: unknown): Promise<void> };
    const last = (await service.status()).history.find((h) => h.operation === "backup" && h.target === SRC_ID && h.status === "success")!;
    await inner.queueAutoRestoreCheck(last);
    await service.updateRestoreCheck(SRC, { enabled: false }, "admin");
    release();
    await service.idle();
    expect((await view()).last).toMatchObject({ status: "not_run", reasonCode: "turned_off" });
    expect(docker.runs).toEqual([]);
  });

  it("'em andamento' não fica preso: na subida vira 'falhou', e o container que sobrou é removido", async () => {
    await backup();
    const cfgFile = path.join(dir, "backups.json");
    await service.flush();
    const cfg = JSON.parse(await readFile(cfgFile, "utf8"));
    cfg.targets[SRC_ID].restoreCheck.last = { ...cfg.targets[SRC_ID].restoreCheck.last, status: "running", finishedAt: null, durationMs: null, reasonCode: null, reason: null };
    cfg.restoreCheckSandboxes = ["tws-rc-00000000000000aa", "paas-fazenda-db-1"];
    await writeFile(cfgFile, JSON.stringify(cfg));
    docker.labeled = ["tws-rc-00000000000000bb", "meu-container"];
    service = build();
    const v = await view();
    expect(v.last).toMatchObject({ status: "failed", reasonCode: "panel_restarted" });
    expect(v.last!.reason).toMatch(/tws-rc-/);
    await until(async () => sandboxRegistry().length === 0 && docker.removed.includes("tws-rc-00000000000000aa") && docker.removed.includes("tws-rc-00000000000000bb"));
    // só o que tem a forma exata do nome do teste (o registro com outro nome é descartado na carga)
    expect(docker.removed).toEqual(expect.arrayContaining(["tws-rc-00000000000000aa", "tws-rc-00000000000000bb"]));
    expect(docker.removed).not.toContain("paas-fazenda-db-1");
    expect(docker.removed).not.toContain("meu-container");
  });

  it("varredura: com o Docker sem lista, tenta os registrados; remoção que falha mantém o nome", async () => {
    const reg = (service as unknown as { config: { restoreCheckSandboxes: string[] } }).config;
    reg.restoreCheckSandboxes = ["tws-rc-00000000000000cc"];
    const sweep = () => (service as unknown as { sweepSandboxes: () => Promise<void> }).sweepSandboxes();
    docker.listFails = true;
    docker.removeFails = true;
    await sweep();
    expect(sandboxRegistry()).toEqual(["tws-rc-00000000000000cc"]);
    docker.removeFails = false;
    const realRemove = docker.removeSandbox.bind(docker);
    docker.removeSandbox = async () => {
      throw new Error("docker fora do ar");
    };
    await sweep();
    expect(sandboxRegistry()).toEqual(["tws-rc-00000000000000cc"]);
    docker.removeSandbox = realRemove;
    await sweep();
    expect(sandboxRegistry()).toEqual([]);
  });

  it("a varredura não mexe enquanto um teste roda", async () => {
    await backup();
    let release!: () => void;
    docker.gate = new Promise<void>((r) => (release = r));
    const p = service.runRestoreCheck(SRC, "admin");
    await until(async () => docker.sandboxes.size === 1);
    const name = [...docker.sandboxes.keys()][0]!;
    await service.updateRestoreCheck(SRC, { enabled: false }, "admin");
    expect(docker.removed).not.toContain(name);
    release();
    await p;
    await service.idle();
    expect(docker.removed).toContain(name);
  });

  it("desligar a opção só varre os containers descartáveis DESTE projeto", async () => {
    docker.labeled = ["tws-rc-00000000000000a1", "tws-rc-00000000000000b2", "tws-rc-00000000000000c3"];
    docker.labeledProject = { "tws-rc-00000000000000a1": SRC, "tws-rc-00000000000000b2": OTHER };
    await service.updateRestoreCheck(SRC, { enabled: false }, "admin");
    expect(docker.removed).toEqual(["tws-rc-00000000000000a1"]);
  });

  it("desligar outro projeto durante um teste: varre o dele, nunca o container do teste em andamento", async () => {
    await backup();
    let release!: () => void;
    docker.gate = new Promise<void>((r) => (release = r));
    const before = docker.restores.length;
    const p = service.runRestoreCheck(SRC, "admin");
    await until(async () => docker.restores.length > before);
    const name = [...docker.sandboxes.keys()][0]!;
    docker.labeled = ["tws-rc-00000000000000b2"];
    docker.labeledProject = { "tws-rc-00000000000000b2": OTHER };
    const removedBefore = docker.removed.length;
    try {
      await service.updateRestoreCheck(OTHER, { enabled: false }, "admin");
      expect(docker.removed.slice(removedBefore)).toEqual(["tws-rc-00000000000000b2"]);
      expect(docker.removed).not.toContain(name);
    } finally {
      release();
      await p;
      await service.idle();
    }
  });

  it("um teste que ainda esperava na fila nem começou: 'não executado', não 'falhou'", async () => {
    await backup();
    const { release } = await occupy();
    const queued = await service.runRestoreCheck(SRC, "admin");
    await service.flush();
    const old = service;
    service = build();
    expect((await view()).last).toMatchObject({ status: "not_run", reasonCode: "restart_before_start" });
    const rec = (await service.status()).history.find((h) => h.id === queued.id)!;
    expect(rec.status).toBe("warning");
    release();
    await old.idle();
  });

  it("não conseguir registrar o nome em disco: nada é criado", async () => {
    await backup();
    docker.runs.length = 0;
    const inner = service as unknown as { persist: (w: unknown) => Promise<void> };
    const real = inner.persist.bind(service);
    let fail = false;
    inner.persist = async (w) => {
      if (fail) throw new Error("disco cheio");
      return real(w);
    };
    const realRun = archiver.extract.bind(archiver);
    archiver.extract = async (...a: Parameters<FakeArchiver["extract"]>) => {
      await realRun(...a);
      fail = true;
    };
    const rec = await testNow();
    fail = false;
    expect(rec.status).toBe("failed");
    expect(docker.runs).toEqual([]);
    expect(sandboxRegistry()).toEqual([]);
  });
});

describe("Cancelar teste", () => {
  it("rodando: remove o container descartável na hora; termina 'não executado — cancelado', sem alerta; auditado", async () => {
    await backup();
    notices.length = 0;
    let release!: () => void;
    docker.gate = new Promise<void>((r) => (release = r));
    const before = docker.restores.length;
    const queued = await service.runRestoreCheck(SRC, "admin");
    await until(async () => docker.restores.length > before);
    const name = [...docker.sandboxes.keys()][0]!;
    // a restauração em curso cai quando o container some
    docker.restoreError = new Error("Error response from daemon: No such container");
    const v = await service.cancelRestoreCheck(SRC, "admin");
    expect(v.last?.status).toBe("running");
    expect(docker.removed).toContain(name);
    release();
    await service.idle();
    const last = (await view()).last!;
    expect(last).toMatchObject({ status: "not_run", reasonCode: "cancelled" });
    expect((await service.record(queued.id)).status).toBe("warning");
    expect(notices).toEqual([]);
    expect(docker.sandboxes.size).toBe(0);
    expect(sandboxRegistry()).toEqual([]);
    expect(audits.map((a) => a.action)).toContain("backups.restore_check_cancel");
  });

  it("cancelado antes de subir o container (abrindo o backup): para sem criar nada", async () => {
    await backup();
    docker.runs.length = 0;
    const realExtract = archiver.extract.bind(archiver);
    archiver.extract = async (...a: Parameters<FakeArchiver["extract"]>) => {
      await realExtract(...a);
      await service.cancelRestoreCheck(SRC, "admin");
    };
    const rec = await testNow();
    expect(rec.status).toBe("warning");
    expect((await view()).last).toMatchObject({ status: "not_run", reasonCode: "cancelled" });
    expect(docker.runs).toEqual([]);
  });

  it("cancelado lendo os volumes: para antes do próximo .tar", async () => {
    await backup();
    const realList = archiver.listTar.bind(archiver);
    let first = true;
    archiver.listTar = async (...a: Parameters<FakeArchiver["listTar"]>) => {
      if (first) await service.cancelRestoreCheck(SRC, "admin");
      first = false;
      return realList(...a);
    };
    const inner = service as unknown as { openBackup: (...a: unknown[]) => Promise<unknown> };
    const real = inner.openBackup.bind(service);
    inner.openBackup = async (...a: unknown[]) => {
      const o = (await real(...a)) as { manifest: { items: Array<{ type: string; file?: string }> } };
      const tar = o.manifest.items.find((x) => x.type === "mount")!;
      o.manifest.items = [tar, { ...tar }];
      return o;
    };
    await testNow();
    expect((await view()).last).toMatchObject({ status: "not_run", reasonCode: "cancelled" });
  });

  it("na fila: sai da fila sem rodar; nada na fila nem rodando: 409", async () => {
    await backup();
    docker.runs.length = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = docker.execToFile.bind(docker);
    docker.execToFile = async (...a: Parameters<FakeDocker["execToFile"]>) => {
      docker.execToFile = original;
      await gate;
      return original(...a);
    };
    const other = await service.runNow(projectTargetId(OTHER), "admin");
    await until(async () => (await service.status()).running?.id === other.id);
    const queued = await service.runRestoreCheck(SRC, "admin");
    const v = await service.cancelRestoreCheck(SRC, "admin");
    expect(v.last).toMatchObject({ status: "not_run", reasonCode: "cancelled" });
    expect((await service.record(queued.id)).status).toBe("warning");
    expect((await service.status()).queued).not.toContainEqual(expect.objectContaining({ id: queued.id }));
    const hist = (await service.projectView(SRC)).history.find((h) => h.operation === "backup")!;
    expect(hist.restoreCheck).toMatchObject({ status: "not_run", reasonCode: "cancelled" });
    release();
    await service.idle();
    expect(docker.runs.filter((r) => r.labels["tws.restore-check.project"] === SRC)).toEqual([]);
    await expect(service.cancelRestoreCheck(SRC, "admin")).rejects.toMatchObject({ statusCode: 409, code: "restore_check_not_running" });
  });

  it("um backup na fila e um teste rodando: a limpeza do Docker espera o backup, não o teste", async () => {
    await backup();
    let release!: () => void;
    docker.gate = new Promise<void>((r) => (release = r));
    const before = docker.restores.length;
    await service.runRestoreCheck(SRC, "admin");
    await until(async () => docker.restores.length > before);
    expect(service.isBusy()).toBe(false);
    await service.runNow(projectTargetId(OTHER), "admin");
    expect(service.isBusy()).toBe(true);
    release();
    await service.idle();
  });
});

describe("versão anterior (teste no servidor de outro projeto)", () => {
  it("a configuração antiga vira a nova: destino e códigos que não existem mais somem; o banco temporário registrado é apagado", async () => {
    await service.updateRestoreCheck(SRC, { enabled: true }, "admin");
    await service.flush();
    const cfgFile = path.join(dir, "backups.json");
    const cfg = JSON.parse(await readFile(cfgFile, "utf8"));
    cfg.targets[SRC_ID].restoreCheck = {
      settings: { enabled: true, destinationId: OTHER, destinationName: "Outro", frequency: "nunca" },
      last: { status: "failed", reasonCode: "destination_permission", reason: "texto antigo", startedAt: "2026-10-01T00:00:00Z", finishedAt: null, durationMs: null, backupFileName: null, checked: null, recordId: null, trigger: "auto" },
      notice: { code: "destination_renamed", text: "x", at: "y" },
    };
    cfg.restoreCheckTemp = [{ name: "tws_rc_00000000000000aa", destinationId: OTHER }, { name: "meu_banco", destinationId: OTHER }];
    await writeFile(cfgFile, JSON.stringify(cfg));
    docker.fleet.containers.outro = [{ id: "o-pg", name: "paas-outro-db-1", service: "db", running: true }];
    docker.fleet.dbs["o-pg"] = { image: "postgres:16", dbName: "outro" };
    const cleaned: string[] = [];
    const real = docker.execCapture.bind(docker);
    docker.execCapture = async (c, script, args?: string[]) => {
      if (script.includes(":cleanup")) {
        cleaned.push(`${c} ${(args ?? []).join(",")}`);
        return "GONE\n";
      }
      return real(c, script);
    };
    service = build();
    const v = await view();
    expect(v.settings).toEqual({ enabled: true, frequency: "daily" });
    expect(v.last).toMatchObject({ reasonCode: null, reason: "texto antigo" });
    expect(v).not.toHaveProperty("notice");
    await service.detectProject(OTHER);
    await service.beforeDeleteProject(OTHER);
    expect(cleaned[0]).toBe("o-pg tws_rc_00000000000000aa");
    // apagar o projeto que tinha restos antigos esquece os nomes
    await service.forgetProject(OTHER);
  });
});
