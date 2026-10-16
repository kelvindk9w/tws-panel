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
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";
import { ArchiveError } from "../src/services/backup-archive.js";
import type { ContainerInspect } from "../src/services/backup-detect.js";
import type { BackupDocker, ProjectContainer } from "../src/services/backup-docker.js";
import { StorageError, type BackupStorage, type StoredObject } from "../src/services/backup-s3.js";
import { BackupService, projectTargetId, retentionVictims, type Archiver, type BackupServiceOptions } from "../src/services/backup-service.js";
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
  async execCapture(container: string, script: string): Promise<string> {
    this.calls.push(`execCapture ${container}`);
    if (script.includes("SAVE")) return "OK\n";
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
    // A detecção (docker diff) roda antes, para saber as pastas de agora.
    expect(docker.calls.filter((c) => !c.startsWith("diff"))[0]).toBe("stop c-web");
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
    docker.execFromFile = async () => ({ stderr: "ERROR 1050 (42S01): Table exists\n" });
    const r = await service.restore(projectTargetId("p1"), { fileName: b.fileName!, source: "local", confirm: "Loja" }, "admin");
    await service.idle();
    expect((await service.record(r.id)).warnings.join(" ")).toMatch(/db: 1 aviso\(s\) do banco/);
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
