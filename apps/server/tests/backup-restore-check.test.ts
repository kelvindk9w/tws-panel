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

interface Fleet {
  /** slug → containers */
  containers: Record<string, ProjectContainer[]>;
  /** id do container → imagem e banco do ambiente */
  dbs: Record<string, { image: string; dbName: string | null; running?: boolean }>;
}

class FakeDocker implements BackupDocker {
  calls: string[] = [];
  restores: Array<{ container: string; args: string[]; content: string; timeoutMs?: number }> = [];
  sanity: Array<{ container: string; args: string[] }> = [];
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
  sanityCount = "3\n";
  restoreStderr = "";
  restoreError: Error | null = null;
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
    await writeFile(outFile, `${script.includes("globals-only") ? "-- papeis\n" : "-- dump\n"}INSERT INTO t VALUES ('${ROW_DATA}');`);
    return { stderr: "" };
  }
  async execCapture(container: string, script: string, args: string[] = []): Promise<string> {
    this.calls.push(`execCapture ${container}`);
    if (script.includes("information_schema.tables")) {
      this.sanity.push({ container, args });
      if (this.sanityCount === "THROW") throw new Error(`psql: ${ROW_DATA}`);
      return this.sanityCount;
    }
    if (script.includes("SAVE")) return "OK\n";
    if (script.includes("pg_database")) return "fazenda\npostgres\n";
    return "";
  }
  async execFromFile(container: string, script: string, args: string[], inFile: string, opts?: { timeoutMs?: number }) {
    this.calls.push(`execFromFile ${container} ${args.join(",")}`);
    this.restores.push({ container, args, content: await readFile(inFile, "utf8"), timeoutMs: opts?.timeoutMs });
    this.onRestore?.();
    if (this.gate) await this.gate;
    if (this.restoreError) throw this.restoreError;
    return { stderr: this.restoreStderr };
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

  it("MySQL/MariaDB/Mongo: bancos com nomes diferentes não são elegíveis (o dump recria o banco com o nome original)", async () => {
    docker.fleet.dbs["s-db"] = { image: "mysql:8", dbName: "fazenda" };
    docker.fleet.dbs["d-db"] = { image: "mysql:8", dbName: "fazenda_sbx" };
    await service.detectProject(SRC);
    await service.detectProject(DST);
    expect((await view()).candidates).toEqual([]);
    docker.fleet.dbs["d-db"] = { image: "mysql:8", dbName: "fazenda" };
    await service.detectProject(DST);
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
  it("restaura o dump do banco no banco do destino e confere que há tabelas", async () => {
    await enable();
    await backup();
    await service.idle();
    expect(docker.restores).toHaveLength(1);
    const r = docker.restores[0]!;
    expect(r.container).toBe("d-db");
    // o Postgres do destino recebe o dump no banco DO DESTINO (fazenda_sbx), não cria "fazenda" ao lado
    expect(r.args).toEqual(["fazenda_sbx"]);
    expect(r.content).toContain("-- dump");
    expect(docker.sanity).toEqual([{ container: "d-db", args: ["fazenda_sbx"] }]);
    const v = await view();
    expect(v.last).toMatchObject({ status: "ok", trigger: "auto", destinationId: DST, destinationName: "Fazenda Sandbox", reasonCode: null });
    expect(typeof v.last!.durationMs).toBe("number");
    expect(v.last!.backupFileName).toMatch(/\.7z$/);
    expect(notices).toEqual([]);
  });

  it("nunca restaura papéis, volumes, arquivos, código, variáveis nem e-mail: só o dump do banco", async () => {
    await enable();
    await backup();
    expect(docker.restores.map((r) => r.content.split("\n")[0])).toEqual(["-- dump"]); // sem _papeis.sql
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

  it("avisos do banco viram só uma contagem, sem o texto", async () => {
    docker.restoreStderr = `ERROR:  role "x" does not exist\nERROR: invalid input '${ROW_DATA}'\n`;
    await enable();
    await backup();
    const v = await view();
    expect(v.last).toMatchObject({ status: "ok", dbWarnings: 2 });
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
    await expectNotRun("engine_mismatch");
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
    // origem e destino viraram MySQL depois do backup; o backup guardado é de Postgres
    docker.fleet.dbs["s-db"] = { image: "mysql:8", dbName: "fazenda" };
    docker.fleet.dbs["d-db"] = { image: "mysql:8", dbName: "fazenda" };
    await service.detectProject(SRC);
    await service.detectProject(DST);
    await service.runRestoreCheck(SRC, { confirm: "Fazenda Sandbox" }, "admin");
    await service.idle();
    expect((await view()).last).toMatchObject({ status: "not_run", reasonCode: "no_database_in_backup" });
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

describe("falhas", () => {
  it("restore com erro: resultado 'falhou', motivo curto, aviso nos canais e SEM texto do banco", async () => {
    docker.restoreError = new Error(`psql: connection refused ${ROW_DATA} ${DB_SECRET}`);
    await enable();
    await backup();
    const v = await view();
    expect(v.last).toMatchObject({ status: "failed", reasonCode: "restore_failed" });
    expect(v.last!.reason).toMatch(/incompleto/);
    expect(notices.filter((n) => n.kind === "backup_failed" && n.key === `restore-check-failed:${SRC_ID}`)).toHaveLength(1);
    const text = JSON.stringify({ v, s: await service.status(), n: notices, a: audits, l: logs });
    expect(text).not.toContain(ROW_DATA);
    expect(text).not.toContain(DB_SECRET);
  });

  it("o banco do destino sem tabela nenhuma depois do restore: falhou", async () => {
    docker.sanityCount = "0\n";
    await enable();
    await backup();
    expect((await view()).last).toMatchObject({ status: "failed", reasonCode: "sanity_failed" });
    expect(notices).toHaveLength(1);
  });

  it("a conferência do destino falhar também é falha, sem repassar a mensagem", async () => {
    docker.sanityCount = "THROW";
    await enable();
    await backup();
    expect((await view()).last).toMatchObject({ status: "failed", reasonCode: "sanity_failed" });
    expect(everything()).not.toContain(ROW_DATA);
  });

  it("passou do prazo: falhou por tempo; o prazo foi passado ao comando de restauração", async () => {
    docker.restoreError = new Error("o comando passou do prazo e foi interrompido");
    await enable();
    await backup();
    expect((await view()).last).toMatchObject({ status: "failed", reasonCode: "timeout" });
    expect(docker.restores[0]!.timeoutMs).toBe(1234);
  });

  it("o dump do backup só tem banco que não é o principal: não adivinha", async () => {
    await enable();
    docker.fleet.dbs["s-db"] = { image: "postgres:16", dbName: "outro_nome" };
    await service.detectProject(SRC);
    await backup();
    // a lista do dump tem "fazenda" e "postgres"; o principal declarado ("outro_nome") não está nela, e "fazenda" é o único que não é o "postgres"
    expect((await view()).last?.status).toBe("ok");
    expect(docker.restores[0]!.args).toEqual(["fazenda_sbx"]);
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
// Reinício
// ---------------------------------------------------------------------------

describe("reinício do painel no meio do teste", () => {
  it("'em andamento' não fica preso: na subida vira 'falhou' avisando que o banco de teste pode estar incompleto", async () => {
    await enable();
    await backup();
    const cfgFile = path.join(dir, "backups.json");
    const cfg = JSON.parse(await readFile(cfgFile, "utf8"));
    cfg.targets[SRC_ID].restoreCheck.last = { ...cfg.targets[SRC_ID].restoreCheck.last, status: "running", finishedAt: null, durationMs: null, reasonCode: null, reason: null };
    await writeFile(cfgFile, JSON.stringify(cfg));
    service = build();
    const v = await view();
    expect(v.last).toMatchObject({ status: "failed", reasonCode: "panel_restarted" });
    expect(v.last!.reason).toMatch(/incompleto/);
    expect(typeof v.last!.finishedAt).toBe("string");
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
