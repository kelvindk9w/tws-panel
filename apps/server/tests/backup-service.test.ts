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
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";
import { ArchiveError } from "../src/services/backup-archive.js";
import type { ContainerInspect } from "../src/services/backup-detect.js";
import type { BackupDocker, ProjectContainer } from "../src/services/backup-docker.js";
import { StorageError, type BackupStorage, type StoredObject } from "../src/services/backup-s3.js";
import { BackupService, projectTargetId, type Archiver, type BackupServiceOptions } from "../src/services/backup-service.js";
import type { NotificationEvent } from "../src/services/notification-service.js";

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
    await writeFile(outFile, `dump ${container} ${args.join(",")} ${script.includes("globals-only") ? "papeis" : "banco"}`);
    return { stderr: "" };
  }
  async execCapture(container: string, script: string) {
    this.calls.push(`execCapture ${container}`);
    return script.includes("pg_database") ? "app\npostgres\n" : "";
  }
  async execFromFile(container: string, script: string, args: string[], inFile: string) {
    this.calls.push(`execFromFile ${container} ${args.join(",")}`);
    this.dbInput.push({ container, args, content: await readFile(inFile, "utf8") });
    return { stderr: script.includes("pg_dumpall") ? "" : args[0] === "postgres" ? "ERROR:  relation already exists\n" : "" };
  }
  async copyOut(container: string, p: string, outFile: string) {
    this.calls.push(`copyOut ${container} ${p}`);
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
let restarted: number;
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
    restartPanel: () => void restarted++,
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
  restarted = 0;
  free = 50 * 1024 ** 3;
  await writeFile(path.join(dir, "users.json"), '{"users":[]}');
  service = build();
});

afterEach(async () => {
  await service.idle();
  await service.flush();
  await rm(dir, { recursive: true, force: true });
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
      await rm(otherDir, { recursive: true, force: true });
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
    const r = await backup("panel");
    expect(r.status).toBe("success");
    const files = Object.keys(
      (JSON.parse(await readFile(path.join(dir, "backups", "_painel", r.fileName!), "utf8")) as { files: Record<string, string> }).files,
    );
    expect(files).toEqual(expect.arrayContaining(["users.json", "mail/domains.json", "backups-key", "manifesto.json"]));
    expect(files.some((f) => f.startsWith("backups/") || f.endsWith(".tmp"))).toBe(false);
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
    expect(done.status).toBe("warning"); // o banco "postgres" respondeu com um ERROR
    expect(done.warnings.join(" ")).toMatch(/aviso\(s\) do banco/);
    expect(docker.calls[0]).toBe("stop c-web");
    expect(docker.calls).toEqual(expect.arrayContaining(["execFromFile c-db app", "execFromFile c-db postgres", "restorePath c-web /app/uploads"]));
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
    await new Promise((res) => setTimeout(res, 20));
    expect(restarted).toBe(1);
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
    await rm(src, { recursive: true, force: true });
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    expect((await service.record(r.id)).status).not.toBe("failed");
    expect(await readFile(path.join(src, "index.html"), "utf8")).toBe("<h1>loja</h1>");
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
    expect(b.status).toBe("success");
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
    docker.execFromFile = async () => ({ stderr: "ERROR 1050 (42S01): Table exists\n" });
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    expect((await service.record(r.id)).warnings.join(" ")).toMatch(/db: 1 aviso\(s\) do banco/);
  });
});
