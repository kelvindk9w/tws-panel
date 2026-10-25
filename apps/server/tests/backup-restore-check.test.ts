/**
 * backup-restore-check.test.ts — "Validar o backup do banco restaurando em
 * outro projeto": depois do backup do projeto de origem (a fazenda em
 * produção), o painel restaura o dump do BANCO no projeto de destino (a
 * fazenda em sandbox) e confere que o banco do destino ficou com tabelas.
 *
 * Docker, 7-Zip e armazenamento são de mentira; o disco é de verdade numa
 * pasta temporária. O que importa aqui: só o dump do banco é restaurado
 * (nada de volumes, arquivos, pastas, .env, e-mail); as salvaguardas barram
 * o que não pode rodar; e nenhum dado nem senha vai para resultado, histórico,
 * auditoria, aviso ou log.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@paas/core";
import { ArchiveError } from "../src/services/backup-archive.js";
import type { ContainerInspect } from "../src/services/backup-detect.js";
import type { BackupDocker, ProjectContainer } from "../src/services/backup-docker.js";
import { StorageError, type BackupStorage, type StoredObject } from "../src/services/backup-s3.js";
import { BackupService, projectTargetId, type Archiver, type BackupServiceOptions } from "../src/services/backup-service.js";
import type { NotificationEvent } from "../src/services/notification-service.js";
import { httpError } from "../src/services/http-error.js";

// ---------------------------------------------------------------------------
// Dublês
// ---------------------------------------------------------------------------

class FakeArchiver implements Archiver {
  extracted: Array<{ only: string[] | undefined }> = [];
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

/** A resposta que o psql daria à conferência: tudo como o dump promete. */
function answerVerify(sql: string, restored: string): string[] {
  const rows = new Map<string, number>();
  let table: string | null = null;
  for (const l of restored.split("\n")) {
    const c = /^COPY (\S+) .*FROM stdin;$/.exec(l);
    if (c) {
      table = c[1]!;
      rows.set(table, 0);
    } else if (l === "\\." ) table = null;
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
  dbs: Record<string, { image: string; dbName: string | null; running?: boolean }>;
}

class FakeDocker implements BackupDocker {
  calls: string[] = [];
  restores: Array<{ container: string; args: string[]; content: string; timeoutMs?: number }> = [];
  prepares: Array<{ container: string; args: string[] }> = [];
  verifies: Array<{ container: string; args: string[]; sql: string }> = [];
  cleanups: Array<{ container: string; args: string[] }> = [];
  fleet: Fleet = {
    containers: {
      fazenda: [
        { id: "s-db", name: "paas-fazenda-db-1", service: "db", running: true },
        { id: "s-web", name: "paas-fazenda-web-1", service: "web", running: true },
      ],
      "fazenda-sandbox": [
        { id: "d-db", name: "paas-fazenda-sandbox-db-1", service: "db", running: true },
        { id: "d-web", name: "paas-fazenda-sandbox-web-1", service: "web", running: true },
      ],
      outro: [{ id: "o-db", name: "paas-outro-db-1", service: "db", running: true }],
    },
    dbs: {
      "s-db": { image: "postgres:16", dbName: "fazenda" },
      "d-db": { image: "postgres:16", dbName: "fazenda_sbx" },
      "o-db": { image: "mysql:8", dbName: "outro" },
    },
  };
  restoreError: Error | null = null;
  /** Cenários da conferência e da limpeza. */
  verifyError: Error | null = null;
  verifyEdit: ((lines: string[]) => string[]) | null = null;
  cleanupAnswer: "GONE" | "LEFT" | "THROW" = "GONE";
  prepareError: Error | null = null;
  dump = pgDump();
  gate: Promise<void> | null = null;
  onRestore: (() => void) | null = null;
  async projectContainers(slug: string) {
    return (this.fleet.containers[slug] ?? []).map((c) => ({ ...c }));
  }
  async inspect(ids: string[]): Promise<ContainerInspect[]> {
    const out: ContainerInspect[] = [];
    for (const [slug, list] of Object.entries(this.fleet.containers)) {
      for (const c of list) {
        if (!ids.includes(c.id)) continue;
        const db = this.fleet.dbs[c.id];
        out.push(
          db
            ? {
                Name: `/${c.name}`,
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
    await writeFile(outFile, script.includes("globals-only") ? "-- papeis\n" : script.includes("pg_dump") ? this.dump : `-- dump\nINSERT INTO t VALUES ('${ROW_DATA}');`);
    return { stderr: "" };
  }
  async execCapture(container: string, script: string, args: string[] = []): Promise<string> {
    this.calls.push(`execCapture ${container}`);
    if (script.includes("# tws-rc:") && script.includes(":prepare")) {
      this.prepares.push({ container, args });
      if (this.prepareError) throw this.prepareError;
      return "";
    }
    if (script.includes("# tws-rc:") && script.includes(":cleanup")) {
      this.cleanups.push({ container, args });
      if (this.cleanupAnswer === "THROW") throw new Error(`psql: ${ROW_DATA}`);
      return `${this.cleanupAnswer}\n`;
    }
    if (script.includes("SAVE")) return "OK\n";
    if (script.includes("pg_database")) return "fazenda\npostgres\n";
    return "";
  }
  async execFromFile(container: string, script: string, args: string[], inFile: string, opts?: { timeoutMs?: number }) {
    this.calls.push(`execFromFile ${container} ${args.join(",")}`);
    const content = await readFile(inFile, "utf8");
    if (script.includes(":verify")) {
      this.verifies.push({ container, args, sql: content });
      if (this.verifyError) throw this.verifyError;
      const out = answerVerify(content, this.restores.at(-1)?.content ?? "");
      return { stderr: "", stdout: `${(this.verifyEdit ? this.verifyEdit(out) : out).join("\n")}\n` };
    }
    this.restores.push({ container, args, content, timeoutMs: opts?.timeoutMs });
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
  async state() {
    return { exists: true, running: true };
  }
  async stop(container: string) {
    this.calls.push(`stop ${container}`);
  }
  async start(container: string) {
    this.calls.push(`start ${container}`);
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
let released: string[];
let tarExtracts: number;
let redeploys: string[];
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
      redeploy: async (id) => void redeploys.push(id),
      hold: async (id) => {
        if (busy.has(id)) throw httpError(409, "deploy_in_progress", "Já existe um deploy em andamento para este projeto.");
        released.push(`hold:${id}`);
        return () => void released.push(`release:${id}`);
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
    restoreCheckTimeoutMs: 1234,
    tar: {
      create: async (_p, name, out) => writeFile(out, `codigo ${name}`),
      extract: async () => void tarExtracts++,
    },
    ...overrides,
  });
}

let service: BackupService;

const SRC = "p1";
const DST = "p2";
const SRC_ID = projectTargetId(SRC);

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
  released = [];
  tarExtracts = 0;
  redeploys = [];
  free = 50 * 1024 ** 3;
  projects = [
    project({ id: SRC, name: "Fazenda", slug: "fazenda" }),
    project({ id: DST, name: "Fazenda Sandbox", slug: "fazenda-sandbox", branch: "sandbox" }),
    project({ id: "p3", name: "Outro", slug: "outro" }),
  ];
  service = build();
  for (const p of projects) await service.detectProject(p.id);
});

afterEach(async () => {
  await service.idle();
  await service.flush();
  await rm(dir, { recursive: true, force: true });
});

async function backup(id = SRC_ID) {
  const r = await service.runNow(id, "admin");
  await service.idle();
  return service.record(r.id);
}

async function enable(frequency: "each" | "daily" | "weekly" = "each") {
  await service.updateRestoreCheck(SRC, { enabled: true, destinationId: DST, frequency, confirm: "Fazenda Sandbox" }, "admin");
}

async function view() {
  return (await service.projectView(SRC)).restoreCheck;
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
// Configuração e destinos elegíveis
// ---------------------------------------------------------------------------

describe("configuração", () => {
  it("vem desligada: o backup padrão não toca em nenhum outro projeto", async () => {
    const v = await view();
    expect(v.settings).toBeNull();
    expect(v.last).toBeNull();
    await backup();
    expect(docker.restores).toEqual([]);
    expect(docker.calls.filter((c) => c.includes("d-db"))).toEqual([]);
    expect((await view()).last).toBeNull();
  });

  it("lista só os destinos elegíveis: outro projeto, mesmo motor, com banco", async () => {
    const v = await view();
    expect(v.unavailableReason).toBeNull();
    expect(v.engine).toBe("postgres");
    expect(v.candidates).toEqual([{ id: DST, name: "Fazenda Sandbox", engine: "postgres" }]);
  });

  it("projeto sem banco detectado: opção indisponível, com motivo", async () => {
    docker.fleet.dbs["s-db"] = { image: "redis:7", dbName: null };
    await service.detectProject(SRC);
    const v = await view();
    expect(v.unavailableReason).toMatch(/banco/i);
    expect(v.unavailableCode).toBe("no_database");
    expect(v.candidates).toEqual([]);
    await expect(service.updateRestoreCheck(SRC, { enabled: true, destinationId: DST, confirm: "Fazenda Sandbox" }, "admin")).rejects.toMatchObject({ code: "restore_check_unavailable" });
  });

  it("banco desmarcado nos itens do backup: indisponível (o backup não leva o banco)", async () => {
    await service.updateTarget(SRC_ID, { choices: { "db:db": false } }, "admin");
    expect((await view()).unavailableReason).toMatch(/marcado|backup/i);
    expect((await view()).unavailableCode).toBe("not_selected");
  });

  it("exige digitar o nome do projeto de destino", async () => {
    for (const confirm of [undefined, "", "Fazenda", "outra coisa"]) {
      await expect(service.updateRestoreCheck(SRC, { enabled: true, destinationId: DST, confirm }, "admin")).rejects.toMatchObject({ code: "confirm_mismatch" });
    }
    expect((await view()).settings).toBeNull();
    await service.updateRestoreCheck(SRC, { enabled: true, destinationId: DST, confirm: "  fazenda sandbox " }, "admin");
    expect((await view()).settings).toEqual({ enabled: true, destinationId: DST, destinationName: "Fazenda Sandbox", frequency: "each" });
  });

  it("o destino nunca é o próprio projeto, nem de outro motor, nem inexistente", async () => {
    await expect(service.updateRestoreCheck(SRC, { enabled: true, destinationId: SRC, confirm: "Fazenda" }, "admin")).rejects.toMatchObject({ code: "invalid_destination" });
    await expect(service.updateRestoreCheck(SRC, { enabled: true, destinationId: "p3", confirm: "Outro" }, "admin")).rejects.toMatchObject({ code: "invalid_destination" });
    await expect(service.updateRestoreCheck(SRC, { enabled: true, destinationId: "zzz", confirm: "x" }, "admin")).rejects.toMatchObject({ statusCode: 404 });
    expect((await view()).settings).toBeNull();
  });

  it("o nome do banco do destino não importa: a prova é feita num banco temporário, e nada do destino é tocado", async () => {
    docker.fleet.dbs["s-db"] = { image: "postgres:16", dbName: "fazenda" };
    docker.fleet.dbs["d-db"] = { image: "postgres:16", dbName: "outro_nome_qualquer" };
    await service.detectProject(SRC);
    await service.detectProject(DST);
    // o outro projeto (MySQL) não aparece: motor diferente do da origem
    expect((await view()).candidates.map((c) => c.id)).toEqual([DST]);
  });

  it("encadeamento proibido: um destino não pode ser origem de outro teste (nunca restaurar em cima da produção)", async () => {
    await enable();
    // o sandbox (destino) tenta ligar o próprio teste apontando para a produção
    await expect(service.updateRestoreCheck(DST, { enabled: true, destinationId: SRC, confirm: "Fazenda" }, "admin")).rejects.toMatchObject({ code: "restore_check_chain" });
    // e a produção (origem de um teste ligado) não aparece como destino de ninguém
    const dstView = (await service.projectView(DST)).restoreCheck;
    expect(dstView.candidates).toEqual([]);
    expect(dstView.unavailableCode).toBe("is_destination");
  });

  it("um projeto que já faz teste ligado não pode ser escolhido como destino", async () => {
    docker.fleet.containers["extra"] = [{ id: "x-db", name: "paas-extra-db-1", service: "db", running: true }];
    docker.fleet.dbs["x-db"] = { image: "postgres:16", dbName: "extra" };
    projects.push(project({ id: "p4", name: "Extra", slug: "extra" }));
    await service.detectProject("p4");
    await service.updateRestoreCheck("p4", { enabled: true, destinationId: DST, confirm: "Fazenda Sandbox" }, "admin");
    // p4 é origem de um teste: não pode ser destino do da fazenda
    await expect(service.updateRestoreCheck(SRC, { enabled: true, destinationId: "p4", confirm: "Extra" }, "admin")).rejects.toMatchObject({ code: "invalid_destination" });
  });

  it("trocar só a frequência não pede a confirmação; desligar guarda o último resultado", async () => {
    await enable();
    await service.updateRestoreCheck(SRC, { enabled: true, frequency: "weekly" }, "admin");
    expect((await view()).settings).toMatchObject({ enabled: true, frequency: "weekly", destinationId: DST });
    await backup();
    await service.updateRestoreCheck(SRC, { enabled: false }, "admin");
    const v = await view();
    expect(v.settings).toMatchObject({ enabled: false });
    expect(v.last?.status).toBe("ok");
    const before = docker.restores.length;
    await backup();
    expect(docker.restores.length).toBe(before);
  });

  it("a auditoria registra ligar e desligar, sem dado nem senha", async () => {
    await enable();
    await service.updateRestoreCheck(SRC, { enabled: false }, "admin");
    await service.flush();
    const mine = audits.filter((a) => a.action === "backups.restore_check");
    expect(mine.length).toBe(2);
    expect(mine[0]!.detail).toContain("Fazenda Sandbox");
    expect(everything()).not.toContain(DB_SECRET);
  });
});

// ---------------------------------------------------------------------------
// Fluxo
// ---------------------------------------------------------------------------

describe("depois do backup", () => {
  it("restaura o dump num banco TEMPORÁRIO do servidor do destino, confere tabelas e linhas e apaga o temporário", async () => {
    await enable();
    await backup();
    await service.idle();
    expect(docker.restores).toHaveLength(1);
    const r = docker.restores[0]!;
    expect(r.container).toBe("d-db");
    // o banco do destino (fazenda_sbx) nem é citado: o dump entra em tws_rc_<id>, com o prazo em segundos dentro do container
    expect(r.args[0]).toMatch(/^tws_rc_[0-9a-f]{16}$/);
    expect(r.args[1]).toBe("1");
    expect(JSON.stringify(docker.calls)).not.toContain("fazenda_sbx");
    // dono e permissão de papéis que podem não existir no destino ficam de fora; os dados passam intactos (inclusive uma linha que parece um GRANT)
    expect(r.content).toContain("CREATE TABLE public.animais");
    expect(r.content).not.toContain("OWNER TO");
    expect(r.content).not.toContain("GRANT SELECT");
    expect(r.content).toContain("2\tGRANT ALL ON x TO y;");
    expect(docker.prepares).toEqual([{ container: "d-db", args: [r.args[0]] }]);
    expect(docker.verifies).toHaveLength(1);
    expect(docker.verifies[0]!.args).toEqual([r.args[0]]);
    expect(docker.verifies[0]!.sql).toContain("to_regclass('public.animais')");
    expect(docker.verifies[0]!.sql).toContain("from only public.animais");
    expect(docker.cleanups).toEqual([{ container: "d-db", args: [r.args[0]] }]);
    const v = await view();
    expect(v.last).toMatchObject({ status: "ok", trigger: "auto", destinationId: DST, destinationName: "Fazenda Sandbox", reasonCode: null, checked: { tables: 1, rows: 2 } });
    expect(typeof v.last!.durationMs).toBe("number");
    expect(v.last!.backupFileName).toMatch(/\.7z$/);
    expect(notices).toEqual([]);
  });

  it("nunca restaura papéis, volumes, arquivos, código, variáveis nem e-mail: só o dump do banco", async () => {
    await enable();
    await backup();
    expect(docker.restores.map((r) => r.content)).toHaveLength(1);
    expect(docker.restores[0]!.content).not.toContain("papeis");
    const bad = docker.calls.filter((c) => /^(copyIn|restorePath|restoreVolume|stop|start)/.test(c));
    expect(bad).toEqual([]);
    expect(tarExtracts).toBe(0);
    expect(redeploys).toEqual([]);
    // só o manifesto e os bancos saem do arquivo (os volumes e o código nem são abertos)
    expect(archiver.extracted.at(-1)!.only).toEqual(["manifesto.json", "bancos"]);
    // o projeto de origem também não é tocado
    expect(docker.calls.filter((c) => c.includes("s-web") && !c.startsWith("copyOut"))).toEqual([]);
  });

  it("segura o destino durante o teste (deploy do destino é recusado) e solta no fim", async () => {
    await enable();
    await backup();
    expect(released).toEqual([`hold:${DST}`, `release:${DST}`]);
  });

  it("entra na fila do BackupService: uma operação por vez", async () => {
    await enable();
    let release!: () => void;
    docker.gate = new Promise<void>((r) => (release = r));
    const first = await service.runNow(SRC_ID, "admin");
    await until(async () => (await service.status()).running?.operation === "restore_check");
    const manual = await service.runNow(projectTargetId("p3"), "admin"); // outro projeto, pedido durante o teste
    const s = await service.status();
    expect(s.running?.operation).toBe("restore_check");
    expect(s.running?.id).not.toBe(first.id);
    expect(s.queued.map((q) => q.id)).toContain(manual.id);
    release();
    await service.idle();
  });

  it("registra a execução no histórico (operação restore_check) e a vê na situação", async () => {
    await enable();
    await backup();
    const s = await service.status();
    const rec = s.history.find((h) => h.operation === "restore_check")!;
    expect(rec).toMatchObject({ target: SRC_ID, status: "success", trigger: "schedule" });
    expect(rec.steps.map((st) => st.label).join("|")).toMatch(/Fazenda Sandbox/);
    const t = s.targets.find((x) => x.id === SRC_ID)!;
    expect(t.restoreCheck).toMatchObject({ enabled: true, last: { status: "ok" } });
  });

  it("o que a conferência devolve nunca vai para o resultado, o histórico, a auditoria, os avisos nem o log", async () => {
    await enable();
    await backup();
    expect(everything()).not.toContain(ROW_DATA);
    expect(everything()).not.toContain(DB_SECRET);
    expect(JSON.stringify(await service.status())).not.toContain(ROW_DATA);
  });

  it("backup que falhou não dispara o teste", async () => {
    await enable();
    docker.execToFile = async () => {
      throw new Error("pg_dump: conexão recusada");
    };
    const r = await backup();
    expect(r.status).toBe("failed");
    expect(docker.restores).toEqual([]);
    expect((await view()).last).toBeNull();
  });

  it("se a cópia externa falhar, valida mesmo assim a cópia da VPS", async () => {
    await service.setDestination({ provider: "r2", endpoint: "https://abc.r2.cloudflarestorage.com", region: "", bucket: "meus-backups", accessKeyId: "AKIAEXEMPLO1234", secretAccessKey: "chave" }, "admin");
    await service.setEncryption(false, "admin");
    storage.failUpload = true;
    await enable();
    const r = await backup();
    expect(r.remote).toBe("failed");
    expect((await view()).last?.status).toBe("ok");
  });

  it("idempotente: pedir o teste duas vezes seguidas roda uma vez só", async () => {
    await enable();
    await backup();
    let release!: () => void;
    docker.gate = new Promise<void>((r) => (release = r));
    const before = docker.restores.length;
    const a = service.runRestoreCheck(SRC, { confirm: "Fazenda Sandbox" }, "admin");
    const b = service.runRestoreCheck(SRC, { confirm: "Fazenda Sandbox" }, "admin");
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.id).toBe(rb.id);
    release();
    await service.idle();
    expect(docker.restores.length - before).toBe(1);
  });
});

describe("frequência", () => {
  it("'no máximo 1 vez por dia' pula o segundo backup do dia e volta no dia seguinte", async () => {
    await enable("daily");
    await backup();
    expect(docker.restores).toHaveLength(1);
    now += 3_600_000 * 3;
    await backup();
    expect(docker.restores).toHaveLength(1);
    now += 3_600_000 * 22;
    await backup();
    expect(docker.restores).toHaveLength(2);
  });

  it("'no máximo 1 vez por semana'", async () => {
    await enable("weekly");
    await backup();
    now += 24 * 3_600_000 * 3;
    await backup();
    expect(docker.restores).toHaveLength(1);
    now += 24 * 3_600_000 * 5;
    await backup();
    expect(docker.restores).toHaveLength(2);
  });

  it("'Testar agora' ignora a frequência", async () => {
    await enable("weekly");
    await backup();
    const r = await service.runRestoreCheck(SRC, { confirm: "Fazenda Sandbox" }, "admin");
    await service.idle();
    expect((await service.record(r.id)).trigger).toBe("manual");
    expect(docker.restores).toHaveLength(2);
    expect((await view()).last?.trigger).toBe("manual");
  });
});

// ---------------------------------------------------------------------------
// Salvaguardas
// ---------------------------------------------------------------------------

describe("salvaguardas: 'não executado', sem tocar em nada", () => {
  async function expectNotRun(code: string) {
    const v = await view();
    expect(v.last).toMatchObject({ status: "not_run", reasonCode: code });
    expect(v.last!.reason).toBeTruthy();
    expect(docker.restores).toEqual([]);
    expect(docker.calls.filter((c) => /^(start|stop|copyIn|restorePath)/.test(c))).toEqual([]);
    const rec = (await service.status()).history.find((h) => h.operation === "restore_check")!;
    expect(rec.status).toBe("warning");
  }

  it("banco do destino parado: não sobe nada", async () => {
    docker.fleet.containers["fazenda-sandbox"]![0]!.running = false;
    await enable();
    await backup();
    await expectNotRun("destination_not_running");
  });

  it("destino sem container nenhum", async () => {
    docker.fleet.containers["fazenda-sandbox"] = [];
    await enable();
    await backup();
    await expectNotRun("destination_not_running");
  });

  it("destino em deploy (ou outra operação): não roda", async () => {
    busy.add(DST);
    await enable();
    await backup();
    await expectNotRun("destination_busy");
  });

  it("o destino mudou de motor depois de ligar", async () => {
    await enable();
    docker.fleet.dbs["d-db"] = { image: "mysql:8", dbName: "fazenda_sbx" };
    await service.detectProject(DST);
    await backup();
    await expectNotRun("destination_no_database");
  });

  it("o destino virou origem de outro teste: não roda (nunca em cima da produção)", async () => {
    await enable();
    // estado inconsistente (ex.: painel restaurado de um backup antigo): destino com teste próprio ligado
    const inner = service as unknown as { target(id: string): { restoreCheck?: unknown } };
    inner.target(projectTargetId(DST)).restoreCheck = { settings: { enabled: true, destinationId: SRC, destinationName: "Fazenda", frequency: "each" }, last: null };
    await backup();
    await expectNotRun("destination_chain");
  });

  it("sem espaço em disco: não roda", async () => {
    await enable();
    let calls = 0;
    service = build({
      statfs: async () => {
        calls++;
        return { bavail: calls > 1 ? 1024 : free, bsize: 1, blocks: 100 * 1024 ** 3 };
      },
    });
    await backup();
    await expectNotRun("no_space");
  });

  it("o backup não tem banco do motor do destino: não executado", async () => {
    await enable();
    await backup();
    docker.restores.length = 0;
    // origem e destino viraram MySQL depois do backup: o teste ainda só existe para Postgres
    docker.fleet.dbs["s-db"] = { image: "mysql:8", dbName: "fazenda" };
    docker.fleet.dbs["d-db"] = { image: "mysql:8", dbName: "fazenda" };
    await service.detectProject(SRC);
    await service.detectProject(DST);
    await service.runRestoreCheck(SRC, { confirm: "Fazenda Sandbox" }, "admin");
    await service.idle();
    expect((await view()).last).toMatchObject({ status: "not_run", reasonCode: "engine_unsupported" });
    expect(docker.restores).toEqual([]);
  });

  it("destino apagado: a opção se desliga, avisa, e nada roda", async () => {
    await enable();
    projects = projects.filter((p) => p.id !== DST);
    await service.forgetProject(DST);
    const v = await view();
    expect(v.settings).toMatchObject({ enabled: false });
    expect(v.notice).toMatchObject({ code: "destination_missing" });
    expect(notices.some((n) => n.key === `restore-check-off:${SRC_ID}`)).toBe(true);
    await backup();
    expect(docker.restores).toEqual([]);
  });

  it("destino apagado sem passar pelo gancho: desliga ao rodar o teste", async () => {
    await enable();
    projects = projects.filter((p) => p.id !== DST);
    await backup();
    const v = await view();
    expect(v.settings?.enabled).toBe(false);
    expect(v.notice?.code).toBe("destination_missing");
    expect(docker.restores).toEqual([]);
  });

  it("destino renomeado: a opção se desliga com aviso (a confirmação era de outro nome)", async () => {
    await enable();
    projects[1] = { ...projects[1]!, name: "Fazenda Homologação" };
    const v = await view();
    expect(v.settings?.enabled).toBe(false);
    expect(v.notice).toMatchObject({ code: "destination_renamed" });
    await backup();
    expect(docker.restores).toEqual([]);
  });

  it("origem apagada: a configuração some junto", async () => {
    await enable();
    await service.forgetProject(SRC);
    const t = (service as unknown as { config: { targets: Record<string, unknown> } }).config.targets;
    expect(t[SRC_ID]).toBeUndefined();
  });
});

describe("falhas: só é 'ok' quando restaurou sem erro e a conferência bateu", () => {
  const leak = async () => {
    const text = JSON.stringify({ v: await view(), s: await service.status(), n: notices, a: audits, l: logs });
    expect(text).not.toContain(ROW_DATA);
    expect(text).not.toContain(DB_SECRET);
  };

  it("restore com erro: 'falhou', motivo curto fixo, aviso nos canais, banco temporário apagado e SEM texto do banco", async () => {
    docker.restoreError = new Error(`psql: connection refused ${ROW_DATA} ${DB_SECRET}`);
    await enable();
    await backup();
    const v = await view();
    expect(v.last).toMatchObject({ status: "failed", reasonCode: "restore_failed", checked: null });
    expect(notices.filter((n) => n.kind === "backup_failed" && n.key === `restore-check-failed:${SRC_ID}`)).toHaveLength(1);
    expect(docker.cleanups).toHaveLength(1);
    expect(docker.verifies).toEqual([]);
    await leak();
  });

  it("falha ao preparar o banco temporário: 'falhou' (e ainda limpa)", async () => {
    docker.prepareError = new Error(`psql: ${ROW_DATA}`);
    await enable();
    await backup();
    expect((await view()).last).toMatchObject({ status: "failed", reasonCode: "restore_failed" });
    expect(docker.restores).toEqual([]);
    expect(docker.cleanups).toHaveLength(1);
    await leak();
  });

  it("uma tabela do dump que não existe depois da restauração: falhou", async () => {
    docker.verifyEdit = (lines) => lines.filter((l) => l !== "E|0|t");
    await enable();
    await backup();
    expect((await view()).last).toMatchObject({ status: "failed", reasonCode: "sanity_failed" });
    expect(notices).toHaveLength(1);
  });

  it("linhas a menos do que o dump promete: falhou", async () => {
    docker.verifyEdit = (lines) => lines.map((l) => (l.startsWith("R|") ? "R|0|1" : l));
    await enable();
    await backup();
    expect((await view()).last).toMatchObject({ status: "failed", reasonCode: "sanity_failed" });
  });

  it("conferência sem a contagem de tabelas, ou com menos tabelas do que o dump cria: falhou", async () => {
    docker.verifyEdit = (lines) => lines.filter((l) => !l.startsWith("T|"));
    await enable();
    await backup();
    expect((await view()).last).toMatchObject({ status: "failed", reasonCode: "sanity_failed" });
    docker.verifyEdit = (lines) => lines.map((l) => (l.startsWith("T|") ? "T|0" : l));
    await service.runRestoreCheck(SRC, { confirm: "Fazenda Sandbox" }, "admin");
    await service.idle();
    expect((await view()).last).toMatchObject({ status: "failed", reasonCode: "sanity_failed" });
  });

  it("a conferência não conseguir rodar também é falha, sem repassar a mensagem", async () => {
    docker.verifyError = new Error(`psql: ${ROW_DATA}`);
    await enable();
    await backup();
    expect((await view()).last).toMatchObject({ status: "failed", reasonCode: "sanity_failed" });
    expect(docker.cleanups).toHaveLength(1);
    await leak();
  });

  it("dump sem tabela nenhuma, ou cortado (sem a marca final do pg_dump): falhou sem tocar no servidor do destino", async () => {
    docker.dump = "-- PostgreSQL database dump\nSELECT 1;\n-- PostgreSQL database dump complete\n";
    await enable();
    await backup();
    expect((await view()).last).toMatchObject({ status: "failed", reasonCode: "sanity_failed" });
    docker.dump = pgDump().replace("-- PostgreSQL database dump complete\n", "");
    await backup();
    expect((await view()).last).toMatchObject({ status: "failed", reasonCode: "sanity_failed" });
    expect(docker.prepares).toEqual([]);
    expect(docker.restores).toEqual([]);
    expect(docker.cleanups).toEqual([]);
  });

  it("passou do prazo: falhou por tempo, o prazo foi passado ao container (em segundos) e ao cliente, e o banco temporário foi limpo", async () => {
    docker.restoreError = new Error("o comando passou do prazo e foi interrompido");
    await enable();
    await backup();
    expect((await view()).last).toMatchObject({ status: "failed", reasonCode: "timeout" });
    // o cliente docker espera um pouco mais que o `timeout` de dentro do container
    expect(docker.restores[0]!.timeoutMs).toBe(1234 + 30_000);
    expect(docker.restores[0]!.args[1]).toBe("1");
    expect(docker.cleanups).toHaveLength(1);
    docker.restoreError = new Error("docker saiu com código 137");
    await service.runRestoreCheck(SRC, { confirm: "Fazenda Sandbox" }, "admin");
    await service.idle();
    expect((await view()).last).toMatchObject({ status: "failed", reasonCode: "timeout" });
  });

  it("não conseguiu apagar o banco temporário: falhou com o aviso para apagar à mão (nunca fica 'ok')", async () => {
    docker.cleanupAnswer = "LEFT";
    await enable();
    await backup();
    expect((await view()).last).toMatchObject({ status: "failed", reasonCode: "cleanup_failed" });
    expect(notices).toHaveLength(1);
    docker.cleanupAnswer = "THROW";
    await service.runRestoreCheck(SRC, { confirm: "Fazenda Sandbox" }, "admin");
    await service.idle();
    expect((await view()).last).toMatchObject({ status: "failed", reasonCode: "cleanup_failed" });
    // a reserva do destino é solta mesmo assim (o banco temporário não atrapalha o deploy do destino)
    expect(released.filter((x) => x.startsWith("release:"))).toHaveLength(2);
    await leak();
  });

  it("erro inesperado dentro do teste: 'falhou' com texto fixo, sem o texto do erro no log", async () => {
    let boom = false;
    service = build({
      projects: {
        list: async () => projects,
        get: async (id) => {
          if (boom) {
            boom = false;
            throw new Error(`inesperado ${ROW_DATA}`);
          }
          return projects.find((p) => p.id === id || p.slug === id) ?? null;
        },
        srcDir: (p) => path.join(dir, "projects", p.slug, "src"),
        redeploy: async () => undefined,
        hold: async () => {
          boom = true;
          return () => undefined;
        },
      },
    });
    await enable();
    await backup();
    expect((await view()).last).toMatchObject({ status: "failed", reasonCode: "restore_failed" });
    expect(logs.some((l) => /erro inesperado/.test(l))).toBe(true);
    await leak();
  });

  it("o dump do backup só tem banco que não é o principal: não adivinha", async () => {
    await enable();
    docker.fleet.dbs["s-db"] = { image: "postgres:16", dbName: "outro_nome" };
    await service.detectProject(SRC);
    await backup();
    // a lista do dump tem "fazenda" e "postgres"; o principal declarado ("outro_nome") não está nela, e "fazenda" é o único que não é o "postgres"
    expect((await view()).last?.status).toBe("ok");
    expect(docker.restores).toHaveLength(1);
  });
});

describe("'Testar agora'", () => {
  it("pede a confirmação digitada e exige a opção ligada", async () => {
    await backup();
    await expect(service.runRestoreCheck(SRC, { confirm: "Fazenda Sandbox" }, "admin")).rejects.toMatchObject({ code: "restore_check_off" });
    await enable();
    await expect(service.runRestoreCheck(SRC, { confirm: "errado" }, "admin")).rejects.toMatchObject({ code: "confirm_mismatch" });
    expect(docker.restores).toEqual([]);
  });

  it("sem nenhum backup ainda: erro claro, nada enfileirado", async () => {
    await enable();
    await expect(service.runRestoreCheck(SRC, { confirm: "Fazenda Sandbox" }, "admin")).rejects.toMatchObject({ code: "no_backup" });
  });

  it("usa o último backup e audita o pedido", async () => {
    await enable();
    const b = await backup();
    docker.restores.length = 0;
    const r = await service.runRestoreCheck(SRC, { confirm: "Fazenda Sandbox" }, "admin");
    await service.idle();
    expect(r.operation).toBe("restore_check");
    expect(docker.restores).toHaveLength(1);
    expect((await view()).last?.backupFileName).toBe(b.fileName);
    await service.flush();
    expect(audits.some((a) => a.action === "backups.restore_check_run")).toBe(true);
  });

  it("só tem a cópia externa cifrada: baixa, abre com a senha guardada e testa", async () => {
    await service.setDestination({ provider: "r2", endpoint: "https://abc.r2.cloudflarestorage.com", region: "", bucket: "meus-backups", accessKeyId: "AKIAEXEMPLO1234", secretAccessKey: "chave" }, "admin");
    await service.setPassword("cavalo-azul-janela-trigo-mesa-41", true, "admin");
    await enable();
    const b = await backup();
    docker.restores.length = 0;
    await rm(path.join(dir, "backups", "fazenda", b.fileName!));
    await service.runRestoreCheck(SRC, { confirm: "Fazenda Sandbox" }, "admin");
    await service.idle();
    expect((await view()).last).toMatchObject({ status: "ok", trigger: "manual" });
    expect(docker.restores).toHaveLength(1);
  });

  it("senha dos backups ausente ou trocada: 'não executado', sem pedir nada nem imprimir", async () => {
    await service.setDestination({ provider: "r2", endpoint: "https://abc.r2.cloudflarestorage.com", region: "", bucket: "meus-backups", accessKeyId: "AKIAEXEMPLO1234", secretAccessKey: "chave" }, "admin");
    await service.setPassword("cavalo-azul-janela-trigo-mesa-41", true, "admin");
    await enable();
    const b = await backup();
    docker.restores.length = 0;
    await rm(path.join(dir, "backups", "fazenda", b.fileName!));
    await service.setPassword("outra-frase-longa-e-diferente-77", true, "admin");
    await service.runRestoreCheck(SRC, { confirm: "Fazenda Sandbox" }, "admin");
    await service.idle();
    expect((await view()).last).toMatchObject({ status: "not_run", reasonCode: "no_password" });
    expect(docker.restores).toEqual([]);
    expect(everything()).not.toContain("cavalo-azul");
    expect(everything()).not.toContain("outra-frase");
  });

  it("a cópia da VPS foi apagada e não há externa: 'sem backup'", async () => {
    await enable();
    const b = await backup();
    await rm(path.join(dir, "backups", "fazenda", b.fileName!));
    await expect(service.runRestoreCheck(SRC, { confirm: "Fazenda Sandbox" }, "admin")).rejects.toMatchObject({ code: "no_backup" });
  });
  it("o armazenamento externo fora do ar na hora de escolher o backup: usa as cópias da VPS, a mais nova primeiro", async () => {
    await service.setDestination({ provider: "r2", endpoint: "https://abc.r2.cloudflarestorage.com", region: "", bucket: "meus-backups", accessKeyId: "AKIAEXEMPLO1234", secretAccessKey: "chave" }, "admin");
    await enable();
    await backup();
    now += 3600_000;
    const second = await backup();
    docker.restores.length = 0;
    storage.failList = true;
    await service.runRestoreCheck(SRC, { confirm: "Fazenda Sandbox" }, "admin");
    await service.idle();
    expect((await view()).last).toMatchObject({ status: "ok", backupFileName: second.fileName });
  });

  it("origem com dois bancos do mesmo motor: usa o dump do serviço que foi detectado como principal", async () => {
    docker.fleet.containers["fazenda"]!.push({ id: "s-db2", name: "paas-fazenda-reports-1", service: "reports", running: true });
    docker.fleet.dbs["s-db2"] = { image: "postgres:16", dbName: "relatorios" };
    await service.detectProject(SRC);
    await enable();
    await backup();
    expect((await view()).last?.status).toBe("ok");
    expect(docker.restores).toHaveLength(1);
  });

});

// ---------------------------------------------------------------------------
// Pedido na fila e configuração que muda
// ---------------------------------------------------------------------------

describe("pedido que espera na fila", () => {
  /** Ocupa a fila com o backup de outro projeto até chamar `release()`. */
  async function blockQueue() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = docker.execToFile.bind(docker);
    docker.execToFile = async (...a: Parameters<FakeDocker["execToFile"]>) => {
      await gate;
      return original(...a);
    };
    const other = await service.runNow(projectTargetId("p3"), "admin");
    await until(async () => (await service.status()).running?.id === other.id);
    return release;
  }

  async function addExtra() {
    docker.fleet.containers["extra"] = [{ id: "x-db", name: "paas-extra-db-1", service: "db", running: true }];
    docker.fleet.dbs["x-db"] = { image: "postgres:16", dbName: "extra" };
    projects.push(project({ id: "p4", name: "Extra", slug: "extra" }));
    await service.detectProject("p4");
  }

  it("desligar a opção enquanto o teste espera: 'não executado' (nada é restaurado)", async () => {
    await enable();
    await backup();
    docker.restores.length = 0;
    const release = await blockQueue();
    await service.runRestoreCheck(SRC, { confirm: "Fazenda Sandbox" }, "admin");
    await service.updateRestoreCheck(SRC, { enabled: false }, "admin");
    release();
    await service.idle();
    expect((await view()).last).toMatchObject({ status: "not_run", reasonCode: "turned_off" });
    expect(docker.restores).toEqual([]);
  });

  it("trocar o destino com um teste na fila: o pedido velho sai como 'não executado' e o novo roda no destino novo", async () => {
    await addExtra();
    await enable();
    await backup();
    docker.restores.length = 0;
    const release = await blockQueue();
    const old = await service.runRestoreCheck(SRC, { confirm: "Fazenda Sandbox" }, "admin");
    await service.updateRestoreCheck(SRC, { enabled: true, destinationId: "p4", confirm: "Extra" }, "admin");
    const fresh = await service.runRestoreCheck(SRC, { confirm: "Extra" }, "admin");
    expect(fresh.id).not.toBe(old.id);
    release();
    await service.idle();
    expect((await service.record(old.id)).status).toBe("warning");
    expect((await service.record(old.id)).warnings.join(" ")).toMatch(/trocado/);
    expect(docker.restores.map((r) => r.container)).toEqual(["x-db"]);
    expect((await view()).last).toMatchObject({ status: "ok", destinationId: "p4", destinationName: "Extra", recordId: fresh.id });
  });

  it("trocar o destino sem novo pedido: o teste da fila não roda no destino novo e o resultado diz o destino pedido", async () => {
    await addExtra();
    await enable();
    await backup();
    docker.restores.length = 0;
    const release = await blockQueue();
    await service.runRestoreCheck(SRC, { confirm: "Fazenda Sandbox" }, "admin");
    await service.updateRestoreCheck(SRC, { enabled: true, destinationId: "p4", confirm: "Extra" }, "admin");
    release();
    await service.idle();
    const last = (await view()).last!;
    expect(last).toMatchObject({ status: "not_run", reasonCode: "settings_changed", destinationName: "Fazenda Sandbox" });
    expect(docker.restores).toEqual([]);
  });

  it("destino renomeado entre o pedido e a execução: a opção se desliga e nada roda", async () => {
    await enable();
    projects[1] = { ...projects[1]!, name: "Fazenda Homologação" };
    await backup();
    expect((await view()).settings?.enabled).toBe(false);
    expect((await view()).last).toMatchObject({ status: "not_run", reasonCode: "destination_renamed" });
    expect(docker.restores).toEqual([]);
  });

  it("backup incompleto não é usado: 'não executado'", async () => {
    await enable();
    const record = await backup();
    docker.restores.length = 0;
    const inner = service as unknown as { enqueueRestoreCheck(id: string, name: string, s: unknown, f: unknown): unknown };
    inner.enqueueRestoreCheck(SRC, "Fazenda", (await view()).settings, { fileName: record.fileName, source: "local", sizeBytes: 100, trigger: "auto", incomplete: true });
    await service.idle();
    expect((await view()).last).toMatchObject({ status: "not_run", reasonCode: "backup_incomplete" });
    expect(docker.restores).toEqual([]);
  });

  it("tamanho do backup desconhecido: mede o arquivo; se não dá para medir, 'não executado'", async () => {
    await enable();
    const record = await backup();
    docker.restores.length = 0;
    const inner = service as unknown as { enqueueRestoreCheck(id: string, name: string, s: unknown, f: unknown): unknown };
    const settings = (await view()).settings;
    inner.enqueueRestoreCheck(SRC, "Fazenda", settings, { fileName: record.fileName, source: "local", sizeBytes: null, trigger: "manual", incomplete: false });
    await service.idle();
    expect((await view()).last?.status).toBe("ok");
    await rm(path.join(dir, "backups", "fazenda", record.fileName!));
    inner.enqueueRestoreCheck(SRC, "Fazenda", settings, { fileName: record.fileName, source: "local", sizeBytes: null, trigger: "manual", incomplete: false });
    await service.idle();
    expect((await view()).last).toMatchObject({ status: "not_run", reasonCode: "backup_unreadable" });
    inner.enqueueRestoreCheck(SRC, "Fazenda", settings, { fileName: record.fileName, source: "remote", sizeBytes: null, trigger: "manual", incomplete: false });
    await service.idle();
    expect((await view()).last).toMatchObject({ status: "not_run", reasonCode: "backup_unreadable" });
  });
});

describe("tamanho do backup externo desconhecido", () => {
  it("usa o tamanho da listagem do armazenamento; sem poder listar, 'não executado'", async () => {
    await service.setDestination({ provider: "r2", endpoint: "https://abc.r2.cloudflarestorage.com", region: "", bucket: "meus-backups", accessKeyId: "AKIAEXEMPLO1234", secretAccessKey: "chave" }, "admin");
    await service.setEncryption(false, "admin");
    await enable();
    const record = await backup();
    const inner = service as unknown as { enqueueRestoreCheck(id: string, name: string, s: unknown, f: unknown): unknown };
    const settings = (await view()).settings;
    const ask = () => inner.enqueueRestoreCheck(SRC, "Fazenda", settings, { fileName: record.fileName, source: "remote", sizeBytes: null, trigger: "manual", incomplete: false });
    ask();
    await service.idle();
    expect((await view()).last?.status).toBe("ok");
    storage.failList = true;
    ask();
    await service.idle();
    expect((await view()).last).toMatchObject({ status: "not_run", reasonCode: "backup_unreadable" });
  });
});

// ---------------------------------------------------------------------------
// Reinício
// ---------------------------------------------------------------------------

describe("reinício do painel no meio do teste", () => {
  it("'em andamento' não fica preso: na subida vira 'falhou' avisando do banco temporário que pode ter sobrado", async () => {
    await enable();
    await backup();
    const cfgFile = path.join(dir, "backups.json");
    const cfg = JSON.parse(await readFile(cfgFile, "utf8"));
    cfg.targets[SRC_ID].restoreCheck.last = { ...cfg.targets[SRC_ID].restoreCheck.last, status: "running", finishedAt: null, durationMs: null, reasonCode: null, reason: null };
    await writeFile(cfgFile, JSON.stringify(cfg));
    service = build();
    const v = await view();
    expect(v.last).toMatchObject({ status: "failed", reasonCode: "panel_restarted" });
    expect(v.last!.reason).toMatch(/tws_rc_/);
    expect(typeof v.last!.finishedAt).toBe("string");
  });

  it("um teste que ainda esperava na fila nem começou: 'não executado', não 'falhou'", async () => {
    await enable();
    await backup();
    docker.restores.length = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = docker.execToFile.bind(docker);
    docker.execToFile = async (...a: Parameters<FakeDocker["execToFile"]>) => {
      await gate;
      return original(...a);
    };
    const other = await service.runNow(projectTargetId("p3"), "admin");
    await until(async () => (await service.status()).running?.id === other.id);
    const queued = await service.runRestoreCheck(SRC, { confirm: "Fazenda Sandbox" }, "admin");
    await service.flush();
    const old = service;
    service = build();
    const v = await view();
    expect(v.last).toMatchObject({ status: "not_run", reasonCode: "restart_before_start" });
    const rec = (await service.status()).history.find((h) => h.id === queued.id)!;
    expect(rec.status).toBe("warning");
    expect(rec.error).toBeNull();
    release();
    await old.idle();
  });

  it("persiste o resultado em disco (sem dados do banco)", async () => {
    await enable();
    await backup();
    await service.flush();
    const raw = await readFile(path.join(dir, "backups.json"), "utf8");
    expect(raw).toContain("restoreCheck");
    expect(raw).not.toContain(ROW_DATA);
    expect(raw).not.toContain(DB_SECRET);
  });
});

// ---------------------------------------------------------------------------
// Bancos temporários: só os que o painel registrou, nunca por nome parecido
// ---------------------------------------------------------------------------

const LEFTOVER = "tws_rc_00000000000000aa";

type TempEntry = { name: string; destinationId: string };

function seedRegistry(entries: TempEntry[]) {
  (service as unknown as { config: { restoreCheckTemp?: TempEntry[] } }).config.restoreCheckTemp = entries;
}
function registry(svc: BackupService = service): TempEntry[] {
  return (svc as unknown as { config: { restoreCheckTemp?: TempEntry[] } }).config.restoreCheckTemp ?? [];
}

describe("bancos temporários registrados", () => {
  it("o nome vai para o registro (em disco) ANTES de o banco ser criado e sai dele depois de apagado", async () => {
    await enable();
    let atPrepare = "";
    const real = docker.execCapture.bind(docker);
    docker.execCapture = async (c, s, a = []) => {
      if (s.includes(":prepare")) atPrepare = `${JSON.stringify(registry())} ${await readFile(path.join(dir, "backups.json"), "utf8")}`;
      return real(c, s, a);
    };
    await backup();
    const name = docker.prepares[0]!.args[0]!;
    // aparece na memória e no arquivo no instante em que o banco vai ser criado
    expect(atPrepare.split(name).length).toBeGreaterThan(2);
    expect(registry()).toEqual([]);
  });

  it("ao desligar a opção, apaga só o registrado (nada por padrão de nome) e esquece", async () => {
    await enable();
    seedRegistry([{ name: LEFTOVER, destinationId: DST }]);
    await service.updateRestoreCheck(SRC, { enabled: false }, "admin");
    expect(docker.cleanups).toEqual([{ container: "d-db", args: [LEFTOVER] }]);
    expect(registry()).toEqual([]);
  });

  it("antes de cada teste apaga o que sobrou de outro, e só o registrado", async () => {
    await enable();
    seedRegistry([{ name: LEFTOVER, destinationId: DST }]);
    await backup();
    expect(docker.cleanups.map((c) => c.args[0])).toEqual([LEFTOVER, docker.prepares[0]!.args[0]]);
    expect(registry()).toEqual([]);
  });

  it("na partida do painel apaga o registrado que sobrou", async () => {
    await enable();
    seedRegistry([{ name: LEFTOVER, destinationId: DST }]);
    await (service as unknown as { persistQuiet(o: { config: boolean }): Promise<void> }).persistQuiet({ config: true });
    await service.flush();
    service = build();
    await view();
    await until(async () => docker.cleanups.length === 1);
    expect(docker.cleanups[0]).toEqual({ container: "d-db", args: [LEFTOVER] });
    await until(async () => registry().length === 0);
  });

  it("não conseguir apagar mantém o nome registrado para tentar de novo", async () => {
    await enable();
    seedRegistry([{ name: LEFTOVER, destinationId: DST }]);
    docker.cleanupAnswer = "LEFT";
    await service.updateRestoreCheck(SRC, { enabled: false }, "admin");
    expect(registry()).toEqual([{ name: LEFTOVER, destinationId: DST }]);
  });

  it("Docker ou a lista de projetos com erro na hora de varrer: o nome continua registrado (nada é esquecido por engano)", async () => {
    await enable();
    seedRegistry([{ name: LEFTOVER, destinationId: DST }]);
    const realContainers = docker.projectContainers.bind(docker);
    docker.projectContainers = async () => Promise.reject(new Error("docker fora do ar"));
    await service.updateRestoreCheck(SRC, { enabled: false }, "admin");
    expect(registry()).toEqual([{ name: LEFTOVER, destinationId: DST }]);
    docker.projectContainers = realContainers;
    await enable();
    seedRegistry([{ name: LEFTOVER, destinationId: DST }]);
    const inner = service as unknown as { opts: { projects: { get(id: string): Promise<unknown> } } };
    const realGet = inner.opts.projects.get.bind(inner.opts.projects);
    inner.opts.projects.get = async (id: string) => (id === DST ? Promise.reject(new Error("falha")) : realGet(id));
    await service.updateRestoreCheck(SRC, { enabled: false }, "admin");
    expect(registry()).toEqual([{ name: LEFTOVER, destinationId: DST }]);
  });

  it("destino que não existe mais: esquece o nome sem tentar apagar nada", async () => {
    await enable();
    seedRegistry([{ name: LEFTOVER, destinationId: "sumiu" }]);
    await service.updateRestoreCheck(SRC, { enabled: false }, "admin");
    expect(docker.cleanups).toEqual([]);
    expect(registry()).toEqual([]);
  });

  it("apagar o projeto de destino tira os nomes dele do registro", async () => {
    await enable();
    seedRegistry([{ name: LEFTOVER, destinationId: DST }]);
    projects = projects.filter((p) => p.id !== DST);
    await service.forgetProject(DST);
    expect(registry()).toEqual([]);
  });
});

describe("somente PostgreSQL nesta etapa", () => {
  it("origem MySQL/MariaDB/Mongo: indisponível com motivo próprio, e o servidor recusa ligar", async () => {
    docker.fleet.dbs["s-db"] = { image: "mysql:8", dbName: "fazenda" };
    await service.detectProject(SRC);
    const v = await view();
    expect(v.unavailableCode).toBe("engine_unsupported");
    expect(v.candidates).toEqual([]);
    await expect(service.updateRestoreCheck(SRC, { enabled: true, destinationId: DST, confirm: "Fazenda Sandbox" }, "admin")).rejects.toMatchObject({ statusCode: 409, code: "restore_check_unavailable" });
  });

  it("destino sem permissão para criar bancos: 'falhou' dizendo que é permissão, sem apagar nada", async () => {
    docker.prepareError = new Error("tws-rc:no-permission");
    await enable();
    await backup();
    const v = await view();
    expect(v.last).toMatchObject({ status: "failed", reasonCode: "destination_permission" });
    expect(docker.cleanups).toEqual([]);
    expect(docker.restores).toEqual([]);
  });

  it("a opção desligada durante o backup: o teste não roda", async () => {
    await enable();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = docker.execToFile.bind(docker);
    docker.execToFile = async (...a: Parameters<FakeDocker["execToFile"]>) => {
      await gate;
      return original(...a);
    };
    const r = await service.runNow(SRC_ID, "admin");
    await until(async () => (await service.status()).running?.id === r.id);
    (service as unknown as { target(id: string): { restoreCheck?: { settings: { enabled: boolean } } } }).target(SRC_ID).restoreCheck!.settings.enabled = false;
    release();
    await service.idle();
    expect(docker.restores).toEqual([]);
  });
});

describe("segurança do banco e do papel descartáveis", () => {
  it("R10: a varredura não apaga o que é de um teste em andamento", async () => {
    await enable();
    await backup();
    const restoresBefore = docker.restores.length;
    const cleanupsBefore = docker.cleanups.length;
    let release!: () => void;
    docker.gate = new Promise<void>((r) => (release = r));
    const queued = await service.runRestoreCheck(SRC, { confirm: "Fazenda Sandbox" }, "admin");
    await until(async () => docker.restores.length === restoresBefore + 1);
    // durante o teste: o nome do teste em andamento está registrado e outros registros também
    const mine = docker.prepares.at(-1)!.args[0]!;
    expect(registry().map((e) => e.name)).toContain(mine);
    seedRegistry([...registry(), { name: LEFTOVER, destinationId: DST }]);
    await service.updateRestoreCheck(SRC, { enabled: false }, "admin");
    await service.beforeDeleteProject(DST);
    expect(docker.cleanups).toHaveLength(cleanupsBefore);
    expect(registry().map((e) => e.name)).toContain(mine);
    release();
    await service.idle();
    expect((await service.record(queued.id))?.id).toBe(queued.id);
    // só depois de terminar: o do teste foi apagado por ele, e o resto na varredura seguinte
    expect(docker.cleanups[cleanupsBefore]!.args).toEqual([mine]);
  });

  it("se o registro do nome não puder ser gravado, nada é criado no destino", async () => {
    await enable();
    (service as unknown as { writeJson: () => Promise<void> }).writeJson = async () => Promise.reject(new Error("disco cheio"));
    await backup();
    expect(docker.prepares).toEqual([]);
    expect(docker.restores).toEqual([]);
    expect(registry()).toEqual([]);
    expect((await view()).last).toMatchObject({ status: "failed", reasonCode: "restore_failed" });
  });

  it("apagar o projeto de destino: antes de apagar, varre o banco temporário registrado dele", async () => {
    await enable();
    seedRegistry([
      { name: LEFTOVER, destinationId: DST },
      { name: "tws_rc_00000000000000bb", destinationId: "outro-projeto" },
    ]);
    await service.beforeDeleteProject(DST);
    expect(docker.cleanups).toEqual([{ container: "d-db", args: [LEFTOVER] }]);
    expect(registry()).toEqual([{ name: "tws_rc_00000000000000bb", destinationId: "outro-projeto" }]);
  });

  it("apagar o projeto de destino sem conseguir apagar o banco temporário: avisa que ele pode ter ficado no volume", async () => {
    await enable();
    seedRegistry([{ name: LEFTOVER, destinationId: DST }]);
    docker.cleanupAnswer = "LEFT";
    await service.beforeDeleteProject(DST);
    projects = projects.filter((p) => p.id !== DST);
    await service.forgetProject(DST);
    expect(notices.some((n) => n.key === `restore-check-leftover:${DST}`)).toBe(true);
    expect(logs.join("\n")).toMatch(/banco\(s\) temporário\(s\)/);
    expect(registry()).toEqual([]);
    expect(everything()).not.toContain(DB_SECRET);
  });

  it("extensão que exige superusuário e dump com comando do psql têm motivo próprio, sem texto do banco", async () => {
    docker.restoreError = new Error(`ERROR: permission denied to create extension "dblink" ${ROW_DATA}`);
    await enable();
    await backup();
    expect((await view()).last).toMatchObject({ status: "failed", reasonCode: "extension_unavailable" });
    expect(JSON.stringify({ v: await view(), n: notices, l: logs })).not.toContain(ROW_DATA);
    docker.restoreError = null;
    docker.dump = pgDump().replace("CREATE TABLE", "\\! id\nCREATE TABLE");
    await backup();
    expect((await view()).last).toMatchObject({ status: "failed", reasonCode: "unsafe_dump" });
  });
});
