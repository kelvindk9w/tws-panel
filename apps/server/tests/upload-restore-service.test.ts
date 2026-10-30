/**
 * upload-restore-service.test.ts — "Restaurar de um arquivo": envio em fluxo para o disco, limite de tamanho e de
 * espaço, formato e motor, limpeza, o caminho do restore (psql, pg_restore, mysql, mongorestore) e o backup antes.
 * O Docker é um dublê que registra o que foi pedido e lê o arquivo que chegaria na entrada padrão do cliente do banco.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupDatabaseEngine, BackupRecord, Project, UploadRestoreStartRequest } from "@paas/core";
import { MONGO_SCRIPT, MYSQL_SCRIPT, UploadRestoreService, uploadRestoreMaxBytes, type UploadRestoreDeps } from "../src/services/upload-restore.js";

const PG_SQL = "-- PostgreSQL database dump\nSET statement_timeout = 0;\nCREATE TABLE t (id int);\nINSERT INTO t VALUES (1);\n";
const MY_SQL = "-- MySQL dump 10.13\n/*!40101 SET @a=1 */;\nCREATE TABLE `t` (id int) ENGINE=InnoDB;\n";
const PGDMP = Buffer.concat([Buffer.from("PGDMP"), Buffer.from([1, 14, 0]), Buffer.alloc(200, 7)]);
const MONGO = Buffer.concat([Buffer.from([0x6d, 0xe2, 0x99, 0x81]), Buffer.alloc(100, 1)]);
const SEVEN_Z = Buffer.concat([Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]), Buffer.alloc(100, 2)]);

const PROJECT = { id: "p1", name: "Loja", slug: "loja" } as unknown as Project;

interface ExecCall {
  container: string;
  script: string;
  args: string[];
  content: Buffer;
  timeoutMs: number | undefined;
}

let dataDir: string;
let calls: string[];
let execs: ExecCall[];
let stopped: string[];
let started: string[];
let held: string[];
let releases: number;
let maintenanceEnded: number;
let audits: Array<{ actor?: string; action: string; target?: string | null; detail: string }>;
let execResult: { stderr: string; stdout?: string } | Error;
let engines: Array<{ service: string; engine: BackupDatabaseEngine; containerId: string | null; running: boolean; databaseName: string | null }>;
let backupRecord: BackupRecord;
let recordFlow: BackupRecord[];
let runNowError: Error | null;
let openResult: { password: string | null } | { needsPassword: true; message: string };
let freeBytes: number;
let extractFn: (archive: string, out: string, pw: string | null, only?: string[]) => Promise<void>;
let listFn: (archive: string, pw: string | null) => Promise<Array<{ path: string; size: number }>>;
let holdError: Error | null;
let svc: UploadRestoreService;
let maxBytes: number;

const record = (partial: Partial<BackupRecord>): BackupRecord =>
  ({ id: "b1", target: "project:p1", targetName: "Loja", operation: "backup", trigger: "manual", status: "queued", fileName: null, warnings: [], error: null, steps: [], ...partial }) as BackupRecord;

function build(over: Partial<UploadRestoreDeps> = {}): UploadRestoreService {
  return new UploadRestoreService({
    dataDir,
    maxBytes,
    docker: {
      execCapture: async (container: string, script: string) => {
        calls.push(`execCapture ${container}`);
        return script.includes("pg_database") ? "app\nloja\n" : "shop\n";
      },
      execFromFile: async (container: string, script: string, args: string[], inFile: string, opts?: { timeoutMs?: number }) => {
        calls.push(`execFromFile ${container}`);
        execs.push({ container, script, args, content: await readFile(inFile), timeoutMs: opts?.timeoutMs });
        if (execResult instanceof Error) throw execResult;
        return execResult;
      },
      projectContainers: async () => [
        { id: "c-db", name: "loja-db", service: "db", running: true },
        { id: "c-app", name: "loja-app", service: "app", running: true },
        { id: "c-off", name: "loja-off", service: "worker", running: false },
      ],
      stop: async (id: string) => void stopped.push(id),
      start: async (id: string) => void started.push(id),
    } as never,
    backups: {
      databaseServices: async () => engines,
      openUploadedArchive: async () => openResult,
      runNow: async (target: string) => {
        calls.push(`runNow ${target}`);
        if (runNowError) throw runNowError;
        return backupRecord;
      },
      record: async () => recordFlow.shift() ?? backupRecord,
    },
    archiver: {
      extract: (archive: string, out: string, pw: string | null, only?: string[]) => extractFn(archive, out, pw, only),
      list: (archive: string, pw: string | null) => listFn(archive, pw),
    },
    projects: {
      get: async (id: string) => (id === "p1" ? PROJECT : null),
      hold: async (id: string, reason?: string) => {
        if (holdError) throw holdError;
        held.push(`${id}:${reason}`);
        return () => void releases++;
      },
      maintenance: () => () => void maintenanceEnded++,
    },
    audit: { record: async (e) => void audits.push(e) },
    statfs: async () => ({ bavail: freeBytes, bsize: 1 }),
    sleep: async () => undefined,
    backupPollMs: 0,
    ...over,
  });
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "upload-restore-"));
  calls = [];
  execs = [];
  stopped = [];
  started = [];
  held = [];
  releases = 0;
  maintenanceEnded = 0;
  audits = [];
  execResult = { stderr: "", stdout: "" };
  engines = [{ service: "db", engine: "postgres", containerId: "c-db", running: true, databaseName: "loja" }];
  backupRecord = record({ status: "success", fileName: "2026-10-30_10-00.7z" });
  recordFlow = [];
  runNowError = null;
  openResult = { password: null };
  freeBytes = 50 * 1024 ** 3;
  extractFn = async () => undefined;
  listFn = async () => [{ path: "manifesto.json", size: 100 }];
  holdError = null;
  maxBytes = 5 * 1024 * 1024;
  svc = build();
});

afterEach(async () => {
  await svc.stop();
  await rm(dataDir, { recursive: true, force: true });
});

const dirOf = () => path.join(dataDir, "uploads", "restore");
const files = async () => (existsSync(dirOf()) ? readdir(dirOf()) : []);
const upload = (data: Buffer | string | Readable, over: Record<string, unknown> = {}) =>
  svc.receive({
    projectId: "p1",
    service: "db",
    actor: "admin",
    stream: data instanceof Readable ? data : Readable.from([Buffer.isBuffer(data) ? data : Buffer.from(data)]),
    contentLength: null,
    ...over,
  });

const startReq = (uploadId: string, over: Partial<UploadRestoreStartRequest> = {}): UploadRestoreStartRequest => ({
  uploadId,
  service: "db",
  database: "loja",
  clean: false,
  backup: "none",
  confirm: "loja",
  currentPassword: "x",
  ...over,
});

async function restoreWith(data: Buffer | string, req: Partial<UploadRestoreStartRequest> = {}, over: Record<string, unknown> = {}) {
  const up = await upload(data, over);
  const plan = await svc.plan("p1", startReq(up.uploadId, req));
  const job = await svc.begin(plan, "admin");
  await svc.settled();
  return { up, job: svc.job("p1", job.id) };
}

describe("envio em fluxo para o disco", () => {
  it("grava na pasta de dados (não em /tmp), com id sorteado, só para o dono, e devolve o formato", async () => {
    const up = await upload(PG_SQL);
    expect(up).toMatchObject({ sizeBytes: PG_SQL.length, format: "sql", gzip: false, needsPassword: false });
    const names = await files();
    expect(names).toEqual([up.uploadId]);
    expect(up.uploadId).toMatch(/^[0-9a-f]{24}$/);
    const file = path.join(dirOf(), up.uploadId);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).toBe(PG_SQL);
    expect(file.startsWith(tmpdir() + path.sep + "upload-restore-")).toBe(true);
    expect(file.startsWith("/tmp/") && !file.includes("upload-restore-")).toBe(false);
  });

  it("recebe aos pedaços, sem juntar tudo antes: o arquivo cresce enquanto o corpo chega", async () => {
    const stream = new PassThrough();
    const pending = upload(stream);
    stream.write(Buffer.from(PG_SQL));
    // o primeiro pedaço já está no disco antes de o corpo terminar
    await vi.waitFor(async () => expect((await files()).length).toBe(1));
    await vi.waitFor(async () => expect((await stat(path.join(dirOf(), (await files())[0]!))).size).toBe(PG_SQL.length));
    stream.write(Buffer.from("SELECT 1;\n"));
    stream.end();
    const up = await pending;
    expect(up.sizeBytes).toBe(PG_SQL.length + 10);
  });

  it("reconhece pelos bytes, não pela extensão: PGDMP, .sql.gz, MongoDB e backup do painel", async () => {
    expect((await upload(PGDMP, { fileName: "dump.sql" })).format).toBe("pg_custom");
    await svc.sweep(0);
    expect(await upload(gzipSync(Buffer.from(PG_SQL)), { fileName: "x.bin" })).toMatchObject({ format: "sql", gzip: true });
    await svc.sweep(0);
    engines = [{ service: "db", engine: "mongo", containerId: "c-db", running: true, databaseName: null }];
    expect((await upload(MONGO)).format).toBe("mongo_archive");
    await svc.sweep(0);
    engines = [{ service: "db", engine: "postgres", containerId: "c-db", running: true, databaseName: "loja" }];
    expect(await upload(SEVEN_Z)).toMatchObject({ format: "panel_backup", needsPassword: false });
  });

  it("backup do painel cifrado sem senha conhecida: pede a senha", async () => {
    openResult = { needsPassword: true, message: "cifrado" };
    expect((await upload(SEVEN_Z)).needsPassword).toBe(true);
  });

  it("passa do tamanho máximo no meio do envio: 413 e nenhum arquivo parcial fica", async () => {
    svc = build({ maxBytes: 100_000 });
    const big = Readable.from([Buffer.from(PG_SQL), Buffer.alloc(60_000, 65), Buffer.alloc(60_000, 65)]);
    await expect(upload(big)).rejects.toMatchObject({ statusCode: 413, code: "too_large" });
    expect(await files()).toEqual([]);
  });

  it("Content-Length acima do máximo: recusa antes de gravar qualquer coisa", async () => {
    await expect(upload(PG_SQL, { contentLength: maxBytes + 1 })).rejects.toMatchObject({ statusCode: 413, code: "too_large" });
    expect(await files()).toEqual([]);
  });

  it("sem espaço no disco para o tamanho anunciado: 507 antes de gravar", async () => {
    freeBytes = 500 * 1024 * 1024;
    await expect(upload(PG_SQL, { contentLength: 1024 })).rejects.toMatchObject({ statusCode: 507, code: "no_space" });
    expect(await files()).toEqual([]);
  });

  it("o disco é conferido de tempos em tempos: com folga o envio segue; quando acaba, interrompe e apaga o parcial", async () => {
    const body = (n: number) => Readable.from([Buffer.from(PG_SQL.padEnd(9000, "-")), ...Array.from({ length: n }, () => Buffer.alloc(4000, 32))]);
    svc = build({ spaceCheckBytes: 5000 });
    await expect(upload(body(5))).resolves.toMatchObject({ sizeBytes: 9000 + 5 * 4000 });
    await svc.sweep(0);
    let n = 0;
    svc = build({ spaceCheckBytes: 5000, statfs: async () => ({ bavail: n++ === 0 ? 50 * 1024 ** 3 : 100 * 1024 * 1024, bsize: 1 }) });
    await expect(upload(body(5))).rejects.toMatchObject({ statusCode: 507, code: "no_space" });
    expect(await files()).toEqual([]);
  });

  it("envio maior que o começo reconhecido (mais de 8 KB) é gravado inteiro", async () => {
    const big = PG_SQL.padEnd(100_000, "-");
    const up = await upload(big);
    expect(up.sizeBytes).toBe(100_000);
    expect((await stat(path.join(dirOf(), up.uploadId))).size).toBe(100_000);
  });

  it("sem as dependências opcionais usa o disco, o relógio e a espera de verdade", async () => {
    svc = new UploadRestoreService({ ...(svc["deps"] as UploadRestoreDeps), maxBytes: undefined, statfs: undefined, sleep: undefined, now: undefined, backupPollMs: undefined });
    expect(svc.limit).toBe(10 * 1024 ** 3);
    const up = await upload(PG_SQL);
    expect(up.format).toBe("sql");
    await svc["sleep"](1);
    expect((await svc.options("p1")).freeBytes).toBeGreaterThan(0);
  });

  it("disco que não dá para medir: o envio segue", async () => {
    svc = build({ statfs: async () => Promise.reject(new Error("sem statfs")) });
    await expect(upload(PG_SQL, { contentLength: PG_SQL.length })).resolves.toMatchObject({ format: "sql" });
  });

  it("arquivo errado para o motor é recusado já nos primeiros bytes e nada fica no disco", async () => {
    engines = [{ service: "db", engine: "mysql", containerId: "c-db", running: true, databaseName: "shop" }];
    await expect(upload(PGDMP)).rejects.toMatchObject({ statusCode: 400, code: "wrong_engine" });
    await expect(upload(PG_SQL)).rejects.toMatchObject({ code: "wrong_engine" });
    await expect(upload(MONGO)).rejects.toMatchObject({ code: "wrong_engine" });
    engines = [{ service: "db", engine: "postgres", containerId: "c-db", running: true, databaseName: "loja" }];
    await expect(upload(MY_SQL)).rejects.toMatchObject({ code: "wrong_engine" });
    await expect(upload(MONGO)).rejects.toMatchObject({ code: "wrong_engine" });
    expect(await files()).toEqual([]);
  });

  it("recusa .zip (pelo nome e pelos bytes), binário, SQLite, vazio e .gz corrompido", async () => {
    await expect(upload(PG_SQL, { fileName: "dump.ZIP" })).rejects.toMatchObject({ code: "zip_not_supported" });
    await expect(upload(Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), Buffer.alloc(50)]))).rejects.toMatchObject({ code: "zip_not_supported" });
    await expect(upload(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0]))).rejects.toMatchObject({ code: "not_a_dump" });
    await expect(upload(Buffer.concat([Buffer.from("SQLite format 3\0", "latin1"), Buffer.alloc(30)]))).rejects.toMatchObject({ code: "sqlite_not_supported" });
    await expect(upload(Buffer.alloc(0))).rejects.toMatchObject({ code: "empty_file" });
    const whole = gzipSync(Buffer.from(PG_SQL.repeat(3000)));
    await expect(upload(whole.subarray(0, whole.length - 20))).rejects.toMatchObject({ code: "corrupt_gzip" });
    expect(await files()).toEqual([]);
  });

  it("SQL do PostgreSQL com comando do psql é recusado depois de lido por inteiro", async () => {
    await expect(upload(`${PG_SQL}\\! id\n`)).rejects.toMatchObject({ code: "unsafe_sql" });
    expect(await files()).toEqual([]);
  });

  it("o cliente desiste no meio: o arquivo parcial é apagado", async () => {
    const stream = new PassThrough();
    const pending = upload(stream);
    stream.write(Buffer.from(PG_SQL));
    await vi.waitFor(async () => expect((await files()).length).toBe(1));
    stream.destroy(new Error("aborted"));
    await expect(pending).rejects.toThrow();
    expect(await files()).toEqual([]);
  });

  it("Content-Length diferente do que chegou: envio incompleto", async () => {
    await expect(upload(PG_SQL, { contentLength: PG_SQL.length + 50 })).rejects.toMatchObject({ code: "incomplete_upload" });
    expect(await files()).toEqual([]);
  });

  it("serviço que não é banco do projeto, projeto inexistente, Redis fora", async () => {
    await expect(upload(PG_SQL, { service: "cache" })).rejects.toMatchObject({ code: "unknown_service" });
    await expect(upload(PG_SQL, { projectId: "nope" })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("só dois arquivos esperando por projeto: um envio novo substitui o mais antigo parado", async () => {
    const first = await upload(PG_SQL);
    const second = await upload(PG_SQL);
    const third = await upload(PG_SQL);
    expect(await files()).toEqual([second.uploadId, third.uploadId].sort());
    expect(await files()).not.toContain(first.uploadId);
  });

  it("com os dois arquivos em uso (restauração em curso) não há o que substituir: 409", async () => {
    const a = await upload(PG_SQL);
    const b = await upload(PG_SQL);
    svc["uploads"].get(a.uploadId)!.inUse = true;
    svc["uploads"].get(b.uploadId)!.inUse = true;
    await expect(upload(PG_SQL)).rejects.toMatchObject({ statusCode: 409, code: "upload_busy" });
    svc["running"].add("p1");
    await expect(upload(PG_SQL)).rejects.toMatchObject({ statusCode: 409, code: "upload_busy" });
  });

  it("dois envios ao mesmo tempo contam juntos (o terceiro é recusado)", async () => {
    const a = new PassThrough();
    const b = new PassThrough();
    const pa = upload(a);
    const pb = upload(b);
    await vi.waitFor(() => expect(svc["receiving"].get("p1")).toBe(2));
    await expect(upload(PG_SQL, { actor: "outra" })).rejects.toMatchObject({ code: "upload_busy" });
    a.end(PG_SQL);
    b.end(PG_SQL);
    await Promise.all([pa, pb]);
  });
});

describe("cancelar e limpar", () => {
  it("cancelar apaga o arquivo e audita; id desconhecido ou de outro projeto é 404", async () => {
    const up = await upload(PG_SQL);
    await svc.cancel("p1", up.uploadId, "admin");
    expect(await files()).toEqual([]);
    expect(audits.map((a) => a.action)).toContain("backups.upload_restore_cancelled");
    await expect(svc.cancel("p1", up.uploadId, "admin")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("não cancela enquanto a restauração usa o arquivo", async () => {
    const up = await upload(PG_SQL);
    let release!: () => void;
    execResult = new Error("x");
    const gate = new Promise<void>((r) => (release = r));
    svc = build({ docker: { ...(svc["deps"].docker as object), execFromFile: async () => (await gate, { stderr: "" }), projectContainers: async () => [], execCapture: async () => "" } as never });
    // o arquivo do svc antigo não existe no novo: reenvia
    const up2 = await upload(PG_SQL);
    const plan = await svc.plan("p1", startReq(up2.uploadId));
    await svc.begin(plan, "admin");
    await expect(svc.cancel("p1", up2.uploadId, "admin")).rejects.toMatchObject({ statusCode: 409, code: "upload_in_use" });
    release();
    await svc.settled();
    expect(up.uploadId).not.toBe(up2.uploadId);
  });

  it("a varredura apaga o que tem mais de 24 h e deixa o recente e o que está em uso", async () => {
    const old = path.join(dirOf(), "a".repeat(24));
    const oldWork = path.join(dirOf(), `${"b".repeat(24)}.work`);
    await mkdir(dirOf(), { recursive: true });
    await writeFile(old, "x");
    await mkdir(oldWork, { recursive: true });
    const fresh = await upload(PG_SQL);
    const past = new Date(Date.now() - 25 * 3600_000);
    await utimes(old, past, past);
    await utimes(oldWork, past, past);
    expect(await svc.sweep()).toBe(2);
    expect(await files()).toEqual([fresh.uploadId]);
    // arquivo enviado e esquecido por mais de 24 h (relógio andou)
    svc = build({ now: () => Date.now() + 48 * 3600_000 });
    expect(await svc.sweep()).toBe(1);
    expect(await files()).toEqual([]);
  });

  it("a varredura não mexe no que um trabalho em andamento usa", async () => {
    const up = await upload(PG_SQL);
    svc["uploads"].get(up.uploadId)!.inUse = true;
    const past = new Date(Date.now() - 48 * 3600_000);
    await utimes(path.join(dirOf(), up.uploadId), past, past);
    expect(await svc.sweep()).toBe(0);
    expect(await files()).toEqual([up.uploadId]);
  });

  it("na partida apaga tudo o que ficou de antes; sem a pasta, nada a fazer", async () => {
    expect(await svc.sweep(0)).toBe(0);
    await mkdir(dirOf(), { recursive: true });
    await writeFile(path.join(dirOf(), "restos"), "x");
    svc.start(10_000_000);
    await vi.waitFor(async () => expect(await files()).toEqual([]));
    await svc.stop();
  });

  it("a limpeza se repete no intervalo e uma falha dela não derruba nada", async () => {
    const sweep = vi.spyOn(svc, "sweep").mockRejectedValue(new Error("disco"));
    svc.start(5);
    await vi.waitFor(() => expect(sweep.mock.calls.length).toBeGreaterThanOrEqual(3));
    await svc.stop();
  });

  it("falha na limpeza da partida vai para o log, sem derrubar", async () => {
    const log = vi.fn();
    svc = build({ log });
    vi.spyOn(svc, "sweep").mockRejectedValueOnce(new Error("disco"));
    svc.start(10_000_000);
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    await svc.stop();
  });

  it("PAAS_UPLOAD_RESTORE_MAX_BYTES: valor válido vale; vazio, lixo ou pequeno demais volta ao padrão de 10 GB", () => {
    expect(uploadRestoreMaxBytes({ PAAS_UPLOAD_RESTORE_MAX_BYTES: "2147483648" })).toBe(2 * 1024 ** 3);
    for (const v of [undefined, "", "abc", "10", "-5"]) expect(uploadRestoreMaxBytes({ PAAS_UPLOAD_RESTORE_MAX_BYTES: v })).toBe(10 * 1024 ** 3);
    expect(uploadRestoreMaxBytes()).toBeGreaterThan(0);
  });
});

describe("tela: opções", () => {
  it("lista os bancos do servidor (o script já tira os temporários do painel), o limite e o espaço livre", async () => {
    engines = [
      { service: "db", engine: "postgres", containerId: "c-db", running: true, databaseName: "loja" },
      { service: "my", engine: "mariadb", containerId: "c-my", running: true, databaseName: "shop" },
      { service: "mongo", engine: "mongo", containerId: "c-mo", running: true, databaseName: null },
      { service: "off", engine: "postgres", containerId: null, running: false, databaseName: null },
    ];
    const o = await svc.options("p1");
    expect(o.maxBytes).toBe(maxBytes);
    expect(o.freeBytes).toBe(freeBytes);
    expect(o.development).toBe(false);
    expect(o.busy).toBe(false);
    expect(o.services.map((s) => [s.service, s.databases])).toEqual([["db", ["app", "loja"]], ["my", ["shop"]], ["mongo", []], ["off", []]]);
    await expect(svc.options("nope")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("projeto marcado como de desenvolvimento aparece assim (gancho do feat/aba-banco)", async () => {
    const dev = { ...PROJECT, development: true } as unknown as Project;
    svc = build({ projects: { get: async () => dev } });
    expect((await svc.options("p1")).development).toBe(true);
  });

  it("espaço que não dá para medir é null", async () => {
    svc = build({ statfs: async () => Promise.reject(new Error("x")) });
    expect((await svc.options("p1")).freeBytes).toBeNull();
  });

  it("precheck: confere os primeiros bytes sem gravar nada", async () => {
    expect(await svc.precheck("p1", "db", PGDMP, "a.dump")).toEqual({ format: "pg_custom", gzip: false });
    await expect(svc.precheck("p1", "db", MONGO, undefined)).rejects.toMatchObject({ code: "wrong_engine" });
    await expect(svc.precheck("p1", "db", PGDMP, "a.zip")).rejects.toMatchObject({ code: "zip_not_supported" });
    await expect(svc.precheck("p1", "nada", PGDMP, undefined)).rejects.toMatchObject({ code: "unknown_service" });
    expect(await files()).toEqual([]);
  });
});

describe("planejar (tudo conferido antes de pedir a senha)", () => {
  it("o nome do projeto digitado tem de bater", async () => {
    const up = await upload(PG_SQL);
    await expect(svc.plan("p1", startReq(up.uploadId, { confirm: "outro" }))).rejects.toMatchObject({ code: "confirm_mismatch" });
    await expect(svc.plan("p1", startReq(up.uploadId, { confirm: "  LOJA " }))).resolves.toMatchObject({ database: "loja" });
  });

  it("arquivo inexistente, de outro projeto ou serviço trocado", async () => {
    const up = await upload(PG_SQL);
    await expect(svc.plan("p1", startReq("f".repeat(24)))).rejects.toMatchObject({ code: "upload_not_found" });
    await expect(svc.plan("p1", startReq(up.uploadId, { service: "x" }))).rejects.toMatchObject({ code: "unknown_service" });
    engines = [
      { service: "db", engine: "postgres", containerId: "c-db", running: true, databaseName: "loja" },
      { service: "my", engine: "mysql", containerId: "c-my", running: true, databaseName: "shop" },
    ];
    // enviado para o Postgres e agora apontado para o MySQL: o motor é conferido de novo
    const pg = await upload(PGDMP);
    await expect(svc.plan("p1", startReq(pg.uploadId, { service: "my", database: "shop" }))).rejects.toMatchObject({ code: "wrong_engine" });
  });

  it("banco parado não restaura", async () => {
    const up = await upload(PG_SQL);
    engines = [{ service: "db", engine: "postgres", containerId: "c-db", running: false, databaseName: "loja" }];
    await expect(svc.plan("p1", startReq(up.uploadId))).rejects.toMatchObject({ statusCode: 409, code: "database_stopped" });
  });

  it("banco de destino: nome válido e existente; PostgreSQL exige um; MySQL aceita sem", async () => {
    const up = await upload(PG_SQL);
    await expect(svc.plan("p1", startReq(up.uploadId, { database: "bad name;" }))).rejects.toMatchObject({ code: "invalid_database" });
    await expect(svc.plan("p1", startReq(up.uploadId, { database: "naoexiste" }))).rejects.toMatchObject({ code: "unknown_database" });
    const { database: _drop, ...noDb } = startReq(up.uploadId);
    engines = [{ service: "db", engine: "postgres", containerId: "c-db", running: true, databaseName: null }];
    await expect(svc.plan("p1", noDb)).rejects.toMatchObject({ code: "database_required" });
    engines = [{ service: "db", engine: "mysql", containerId: "c-db", running: true, databaseName: null }];
    const my = await upload(MY_SQL);
    await expect(svc.plan("p1", { ...noDb, uploadId: my.uploadId })).resolves.toMatchObject({ database: null });
  });

  it("sem conseguir listar os bancos, segue com o nome pedido", async () => {
    svc = build({ docker: { execCapture: async () => Promise.reject(new Error("x")) } as never });
    const up = await upload(PG_SQL);
    await expect(svc.plan("p1", startReq(up.uploadId))).resolves.toMatchObject({ database: "loja" });
  });

  it("backup do painel cifrado pede a senha antes de ir adiante", async () => {
    openResult = { needsPassword: true, message: "cifrado" };
    const up = await upload(SEVEN_Z);
    await expect(svc.plan("p1", startReq(up.uploadId))).rejects.toMatchObject({ code: "password_required" });
    await expect(svc.plan("p1", startReq(up.uploadId, { backupPassword: "segredo" }))).resolves.toBeTruthy();
  });

  it("uma restauração por arquivo por vez no projeto", async () => {
    const a = await upload(PG_SQL);
    const b = await upload(PG_SQL);
    const plan = await svc.plan("p1", startReq(a.uploadId));
    svc["uploads"].get(a.uploadId)!.inUse = false;
    svc["running"].add("p1");
    await expect(svc.plan("p1", startReq(b.uploadId))).rejects.toMatchObject({ code: "upload_busy" });
    await expect(svc.begin(plan, "admin")).rejects.toMatchObject({ code: "upload_busy" });
    svc["running"].delete("p1");
  });
});

describe("restaurar", () => {
  it("PostgreSQL SQL: despeja o arquivo na entrada do psql, sem o nome do arquivo na linha de comando, e apaga o envio", async () => {
    const { up, job } = await restoreWith(PG_SQL, {}, { fileName: "meu dump; rm -rf $HOME.sql" });
    expect(job.status).toBe("success");
    expect(execs).toHaveLength(1);
    expect(execs[0]!.container).toBe("c-db");
    expect(execs[0]!.args).toEqual(["loja", "raw"]);
    expect(execs[0]!.script).toContain("psql");
    expect(execs[0]!.script).toContain("ON_ERROR_STOP=1 --single-transaction");
    expect(execs[0]!.script).not.toContain("rm -rf");
    expect(execs[0]!.args.join(" ")).not.toContain("dump");
    expect(execs[0]!.content.toString()).toBe(PG_SQL);
    expect(execs[0]!.timeoutMs).toBeGreaterThan(60 * 60_000);
    expect(await files()).toEqual([]);
    expect(svc["uploads"].has(up.uploadId)).toBe(false);
    expect(job.finishedAt).not.toBeNull();
    expect(job.error).toBeNull();
  });

  it(".sql.gz: manda o arquivo compactado e avisa o script (gzip -dc dentro do container)", async () => {
    const gz = gzipSync(Buffer.from(PG_SQL));
    const { job } = await restoreWith(gz);
    expect(job.status).toBe("success");
    expect(execs[0]!.args).toEqual(["loja", "gz"]);
    expect(execs[0]!.script).toContain("gzip -dc");
    expect(execs[0]!.content.equals(gz)).toBe(true);
  });

  it("formato personalizado: pg_restore, com e sem limpar antes", async () => {
    let r = await restoreWith(PGDMP, { clean: true });
    expect(r.job).toMatchObject({ status: "success", clean: true, format: "pg_custom" });
    expect(execs[0]!.script).toContain("pg_restore");
    expect(execs[0]!.script).toContain("--clean --if-exists");
    expect(execs[0]!.script).toContain("--no-owner");
    expect(execs[0]!.args).toEqual(["loja", "raw", "clean"]);
    r = await restoreWith(PGDMP, { clean: false });
    expect(execs[1]!.args).toEqual(["loja", "raw", "keep"]);
    expect(r.job.status).toBe("success");
  });

  it("MySQL/MariaDB: cliente mysql com ou sem banco de destino", async () => {
    engines = [{ service: "db", engine: "mariadb", containerId: "c-db", running: true, databaseName: "shop" }];
    let r = await restoreWith(MY_SQL, { database: "shop" });
    expect(r.job.status).toBe("success");
    expect(execs[0]!.script).toContain('$CLI --binary-mode -u"$U"');
    expect(execs[0]!.args).toEqual(["shop", "raw"]);
    engines = [{ service: "db", engine: "mysql", containerId: "c-db", running: true, databaseName: null }];
    r = await restoreWith(MY_SQL, { database: undefined });
    expect(r.job.status).toBe("success");
    expect(execs[1]!.args).toEqual(["", "raw"]);
  });

  it("MongoDB: mongorestore --archive, com --drop só se pediu limpar", async () => {
    engines = [{ service: "db", engine: "mongo", containerId: "c-db", running: true, databaseName: null }];
    const r = await restoreWith(MONGO, { clean: true, database: undefined });
    expect(r.job.status).toBe("success");
    expect(execs[0]!.script).toContain("mongorestore --archive");
    expect(execs[0]!.args).toEqual(["raw", "clean", ""]);
    await restoreWith(gzipSync(MONGO), { clean: false, database: undefined });
    expect(execs[1]!.args).toEqual(["gz", "keep", ""]);
  });

  it("MongoDB: 'N document(s) failed to restore' conta como falha mesmo com saída 0", async () => {
    engines = [{ service: "db", engine: "mongo", containerId: "c-db", running: true, databaseName: null }];
    execResult = { stderr: "2 document(s) failed to restore\n" };
    const { job } = await restoreWith(MONGO, { database: undefined });
    expect(job.status).toBe("failed");
    expect(job.error?.message).toContain("2 documento(s)");
    expect(job.output).toContain("failed to restore");
  });

  it("para o app durante a restauração, deixa o banco ligado, reserva o deploy e religa tudo no fim", async () => {
    const { job } = await restoreWith(PG_SQL);
    expect(job.status).toBe("success");
    expect(stopped).toEqual(["c-app"]);
    expect(started).toEqual(["c-app"]);
    expect(held).toEqual(["p1:Restauração de arquivo em andamento"]);
    expect(releases).toBe(1);
    expect(maintenanceEnded).toBe(1);
  });

  it("falha do cliente: o trabalho falha com a mensagem, o app volta, o envio é apagado", async () => {
    execResult = new Error("ERROR: relation \"t\" already exists");
    const { job } = await restoreWith(PG_SQL);
    expect(job.status).toBe("failed");
    expect(job.error?.code).toBe("restore_failed");
    expect(job.error?.message).toContain("already exists");
    expect(job.error?.message).toContain("desfez tudo");
    expect(started).toEqual(["c-app"]);
    expect(releases).toBe(1);
    expect(await files()).toEqual([]);
    expect(audits.map((a) => a.action)).toContain("backups.upload_restore_failed");
  });

  it("falha em MySQL não promete desfazer", async () => {
    engines = [{ service: "db", engine: "mysql", containerId: "c-db", running: true, databaseName: "shop" }];
    execResult = new Error("ERROR 1064");
    const { job } = await restoreWith(MY_SQL, { database: "shop" });
    expect(job.error?.message).not.toContain("desfez");
  });

  it("a saída do cliente é guardada com limite", async () => {
    execResult = { stderr: "e".repeat(50_000), stdout: "ok\n" };
    const { job } = await restoreWith(PG_SQL);
    expect(job.output!.length).toBe(20_000);
    expect(job.output!.endsWith("e")).toBe(true);
  });

  it("projeto em deploy: a reserva falha, nada é alterado e o app não chega a parar", async () => {
    holdError = new Error("O projeto continua em deploy.");
    const { job } = await restoreWith(PG_SQL);
    expect(job).toMatchObject({ status: "failed", error: { code: "project_busy" } });
    expect(job.error?.message).toContain("Nada foi alterado");
    expect(execs).toEqual([]);
    expect(stopped).toEqual([]);
    expect(await files()).toEqual([]);
  });

  it("sem reserva nem manutenção disponíveis (dependências opcionais) a restauração segue", async () => {
    svc = build({ projects: { get: async () => PROJECT } });
    const { job } = await restoreWith(PG_SQL);
    expect(job.status).toBe("success");
  });

  it("auditoria: quem, projeto, serviço, tamanho e formato; nunca o nome do arquivo, o conteúdo nem a senha", async () => {
    await restoreWith(PG_SQL, { backupPassword: "senha-secreta" }, { fileName: "segredo-do-cliente.sql" });
    const text = JSON.stringify(audits);
    expect(audits.map((a) => a.action)).toEqual(["backups.upload_restore_uploaded", "backups.upload_restore", "backups.upload_restore_done"]);
    expect(audits.every((a) => a.actor === "admin" && a.target === "loja")).toBe(true);
    expect(text).toContain(`${PG_SQL.length} bytes`);
    expect(text).toContain("SQL");
    for (const leak of ["segredo-do-cliente", "senha-secreta", "CREATE TABLE", "INSERT"]) expect(text).not.toContain(leak);
  });

  it("job desconhecido é 404", async () => {
    expect(() => svc.job("p1", "nada")).toThrow(/não encontrado/);
  });

  it("mantém só os trabalhos mais recentes", async () => {
    for (let i = 0; i < 4; i++) await restoreWith(PG_SQL);
    expect(svc["jobs"].get("p1")).toHaveLength(3);
  });
});

describe("backup completo antes", () => {
  it("roda o backup do projeto, espera terminar e só então restaura", async () => {
    recordFlow = [record({ status: "running" }), record({ status: "success", fileName: "2026-10-30_10-00.7z" })];
    backupRecord = record({ status: "queued" });
    const { job } = await restoreWith(PG_SQL, { backup: "full" });
    expect(job.status).toBe("success");
    expect(job.backupFileName).toBe("2026-10-30_10-00.7z");
    expect(calls.indexOf("runNow project:p1")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("runNow project:p1")).toBeLessThan(calls.indexOf("execFromFile c-db"));
    // o app só para depois do backup (o backup tem a própria reserva)
    expect(held).toHaveLength(1);
  });

  it("sem backup pedido, o backup não roda", async () => {
    await restoreWith(PG_SQL, { backup: "none" });
    expect(calls.some((c) => c.startsWith("runNow"))).toBe(false);
  });

  it("backup que falha aborta: nada é restaurado e o app nunca parou", async () => {
    backupRecord = record({ status: "failed", error: "sem espaço em disco" });
    const { job } = await restoreWith(PG_SQL, { backup: "full" });
    expect(job).toMatchObject({ status: "failed", error: { code: "backup_failed" } });
    expect(job.error?.message).toContain("sem espaço em disco");
    expect(job.error?.message).toContain("Nada foi alterado");
    expect(execs).toEqual([]);
    expect(stopped).toEqual([]);
    expect(await files()).toEqual([]);
  });

  it("backup que termina com aviso também aborta", async () => {
    backupRecord = record({ status: "warning", fileName: "x.7z", warnings: ["Redis sem SAVE"] });
    const { job } = await restoreWith(PG_SQL, { backup: "full" });
    expect(job.error?.message).toContain("Redis sem SAVE");
    backupRecord = record({ status: "warning", fileName: "x.7z", warnings: [] });
    expect((await restoreWith(PG_SQL, { backup: "full" })).job.error?.message).toContain("terminou com avisos");
    expect(execs).toEqual([]);
  });

  it("backup que não consegue começar aborta", async () => {
    runNowError = new Error("7-Zip ausente");
    const { job } = await restoreWith(PG_SQL, { backup: "full" });
    expect(job.error).toMatchObject({ code: "backup_failed" });
    expect(job.error?.message).toContain("7-Zip ausente");
    expect(execs).toEqual([]);
  });

  it("backup que passa do prazo aborta", async () => {
    backupRecord = record({ status: "running" });
    let t = 0;
    svc = build({ backupWaitMs: 1000, now: () => (t += 600) });
    const { job } = await restoreWith(PG_SQL, { backup: "full" });
    expect(job.error?.code).toBe("backup_timeout");
    expect(execs).toEqual([]);
  });
});

describe("backup do painel (.7z) enviado", () => {
  const manifest = (items: unknown[]) => JSON.stringify({ version: 1, kind: "project", items });

  function extracting(items: unknown[], files: Record<string, string | Buffer> = {}) {
    listFn = async () => [{ path: "manifesto.json", size: 100 }, ...Object.entries(files).map(([p, data]) => ({ path: p, size: data.length }))];
    extractFn = async (_a, out, _pw, only) => {
      await mkdir(out, { recursive: true });
      await writeFile(path.join(out, "manifesto.json"), manifest(items));
      for (const rel of only ?? []) {
        const data = files[rel];
        if (data === undefined) continue;
        await mkdir(path.dirname(path.join(out, rel)), { recursive: true });
        await writeFile(path.join(out, rel), data);
      }
    };
  }

  it("check: abre o backup e lista os bancos do tipo certo", async () => {
    extracting([{ type: "database", service: "db", engine: "postgres", databases: [{ name: "app", file: "bancos/db/app.sql" }, { name: "loja", file: "bancos/db/loja.sql" }] }, { type: "mount" }]);
    const up = await upload(SEVEN_Z);
    expect(await svc.check("p1", up.uploadId, { service: "db" })).toEqual({ ok: true, databases: ["app", "loja"] });
    expect(await files()).toEqual([up.uploadId]);
  });

  it("check: banco MySQL do backup (sem lista de bancos) devolve lista vazia", async () => {
    engines = [{ service: "db", engine: "mysql", containerId: "c-db", running: true, databaseName: "shop" }];
    extracting([{ type: "database", service: "db", engine: "mariadb", file: "bancos/db.sql" }]);
    const up = await upload(SEVEN_Z);
    expect(await svc.check("p1", up.uploadId, { service: "db" })).toEqual({ ok: true, databases: [] });
  });

  it("check: arquivo que não é backup de projeto, sem banco do tipo ou sem manifesto", async () => {
    const up = await upload(SEVEN_Z);
    extracting([{ type: "database", service: "my", engine: "mysql", file: "bancos/my.sql" }]);
    await expect(svc.check("p1", up.uploadId, { service: "db" })).rejects.toMatchObject({ code: "no_matching_database" });
    extracting([]);
    await expect(svc.check("p1", up.uploadId, { service: "db" })).rejects.toMatchObject({ code: "no_matching_database" });
    extractFn = async (_a, out) => {
      await mkdir(out, { recursive: true });
      await writeFile(path.join(out, "manifesto.json"), "{ruim");
    };
    await expect(svc.check("p1", up.uploadId, { service: "db" })).rejects.toMatchObject({ code: "invalid_backup" });
    extractFn = async (_a, out) => {
      await mkdir(out, { recursive: true });
      await writeFile(path.join(out, "manifesto.json"), "{}");
    };
    await expect(svc.check("p1", up.uploadId, { service: "db" })).rejects.toMatchObject({ code: "invalid_backup" });
    extractFn = async () => {
      throw new Error("7-Zip falhou");
    };
    await expect(svc.check("p1", up.uploadId, { service: "db" })).rejects.toMatchObject({ code: "invalid_backup" });
  });

  it("check: cifrado sem senha pede a senha; com a senha certa deixa de pedir", async () => {
    openResult = { needsPassword: true, message: "cifrado" };
    const up = await upload(SEVEN_Z);
    expect(up.needsPassword).toBe(true);
    await expect(svc.check("p1", up.uploadId, { service: "db" })).rejects.toMatchObject({ code: "password_required" });
    openResult = { password: "boa" };
    extracting([{ type: "database", service: "db", engine: "postgres", databases: [{ name: "loja", file: "bancos/db/loja.sql" }] }]);
    await svc.check("p1", up.uploadId, { service: "db", password: "boa" });
    expect(svc["uploads"].get(up.uploadId)!.needsPassword).toBe(false);
  });

  it("check: só vale para backup do painel e não com a restauração em curso", async () => {
    const sql = await upload(PG_SQL);
    await expect(svc.check("p1", sql.uploadId, { service: "db" })).rejects.toMatchObject({ code: "not_panel_backup" });
    await expect(svc.check("p1", "e".repeat(24), { service: "db" })).rejects.toMatchObject({ code: "upload_not_found" });
    svc["uploads"].get(sql.uploadId)!.detected = { format: "panel_backup", gzip: false, hint: null };
    svc["uploads"].get(sql.uploadId)!.inUse = true;
    await expect(svc.check("p1", sql.uploadId, { service: "db" })).rejects.toMatchObject({ code: "upload_in_use" });
  });

  it("restaura o dump de dentro do backup (o banco de mesmo nome) e apaga também a pasta de trabalho", async () => {
    extracting([{ type: "database", service: "db", engine: "postgres", databases: [{ name: "app", file: "bancos/db/app.sql" }, { name: "loja", file: "bancos/db/loja.sql" }] }], {
      "bancos/db/app.sql": "-- PostgreSQL database dump\nCREATE TABLE a (id int);\n",
      "bancos/db/loja.sql": PG_SQL,
    });
    const { job } = await restoreWith(SEVEN_Z, { database: "loja" });
    expect(job.status).toBe("success");
    expect(job.format).toBe("panel_backup");
    expect(execs[0]!.content.toString()).toBe(PG_SQL);
    expect(execs[0]!.args).toEqual(["loja", "raw"]);
    expect(await files()).toEqual([]);
  });

  it("MySQL e MongoDB de dentro do backup", async () => {
    engines = [{ service: "db", engine: "mysql", containerId: "c-db", running: true, databaseName: "shop" }];
    extracting([{ type: "database", service: "outro", engine: "mariadb", file: "bancos/x.sql" }], { "bancos/x.sql": MY_SQL });
    expect((await restoreWith(SEVEN_Z, { database: "shop" })).job.status).toBe("success");
    engines = [{ service: "db", engine: "mongo", containerId: "c-db", running: true, databaseName: null }];
    extracting([{ type: "database", service: "db", engine: "mongo", file: "bancos/db.archive" }], { "bancos/db.archive": MONGO });
    expect((await restoreWith(SEVEN_Z, { database: undefined })).job.status).toBe("success");
    expect(execs[1]!.content.equals(MONGO)).toBe(true);
  });

  it("vários bancos do mesmo tipo: escolhe pelo nome do serviço; sem coincidência, pede para resolver", async () => {
    const items = [
      { type: "database", service: "a", engine: "postgres", databases: [{ name: "loja", file: "bancos/a/loja.sql" }] },
      { type: "database", service: "db", engine: "postgres", databases: [{ name: "loja", file: "bancos/db/loja.sql" }] },
    ];
    extracting(items, { "bancos/a/loja.sql": "-- PostgreSQL database dump\nSELECT 'a';\n", "bancos/db/loja.sql": PG_SQL });
    expect((await restoreWith(SEVEN_Z)).job.status).toBe("success");
    expect(execs[0]!.content.toString()).toBe(PG_SQL);
    extracting(items.map((i) => ({ ...i, service: `${i.service}x` })), {});
    const { job } = await restoreWith(SEVEN_Z);
    expect(job.error?.code).toBe("ambiguous_backup");
  });

  it("Postgres com vários bancos no backup e nenhum com o nome do destino", async () => {
    extracting([{ type: "database", service: "db", engine: "postgres", databases: [{ name: "a", file: "bancos/a.sql" }, { name: "b", file: "bancos/b.sql" }] }], {});
    const { job } = await restoreWith(SEVEN_Z, { database: "loja" });
    expect(job.error?.code).toBe("ambiguous_backup");
    expect(job.error?.message).toContain("a, b");
  });

  it("Postgres com um banco só no backup: usa esse, mesmo com outro nome", async () => {
    extracting([{ type: "database", service: "db", engine: "postgres", databases: [{ name: "origem", file: "bancos/o.sql" }] }], { "bancos/o.sql": PG_SQL });
    expect((await restoreWith(SEVEN_Z)).job.status).toBe("success");
  });

  it("caminho do manifesto fora da pasta, com .., ausente ou link: falha sem restaurar", async () => {
    for (const file of ["../fora.sql", "/etc/passwd", "bancos/nao-existe.sql", 42]) {
      extracting([{ type: "database", service: "db", engine: "mysql", file }], {});
      engines = [{ service: "db", engine: "mysql", containerId: "c-db", running: true, databaseName: "shop" }];
      const { job } = await restoreWith(SEVEN_Z, { database: "shop" });
      expect(job.status, String(file)).toBe("failed");
      expect(job.error?.code).toBe("invalid_backup");
    }
    expect(execs).toEqual([]);
  });

  it("dump de dentro do backup que não serve ao motor ou não é dump", async () => {
    engines = [{ service: "db", engine: "mysql", containerId: "c-db", running: true, databaseName: "shop" }];
    extracting([{ type: "database", service: "db", engine: "mysql", file: "bancos/x.sql" }], { "bancos/x.sql": PGDMP });
    expect((await restoreWith(SEVEN_Z, { database: "shop" })).job.error?.code).toBe("wrong_engine");
    extracting([{ type: "database", service: "db", engine: "mysql", file: "bancos/x.sql" }], { "bancos/x.sql": SEVEN_Z });
    expect((await restoreWith(SEVEN_Z, { database: "shop" })).job.error?.code).toBe("not_a_dump");
    engines = [{ service: "db", engine: "postgres", containerId: "c-db", running: true, databaseName: "loja" }];
    extracting([{ type: "database", service: "db", engine: "postgres", file: "bancos/x.sql" }], { "bancos/x.sql": `${PG_SQL}\\! id\n` });
    expect((await restoreWith(SEVEN_Z)).job.error?.code).toBe("unsafe_sql");
  });

  it("não há espaço para abrir o backup: falha sem tocar no banco", async () => {
    extracting([{ type: "database", service: "db", engine: "postgres", databases: [{ name: "loja", file: "bancos/db/loja.sql" }] }], { "bancos/db/loja.sql": PG_SQL });
    const up = await upload(SEVEN_Z);
    freeBytes = 1024;
    const plan = await svc.plan("p1", startReq(up.uploadId));
    const job = await svc.begin(plan, "admin");
    await svc.settled();
    expect(svc.job("p1", job.id).error?.code).toBe("no_space");
  });

  it("senha errada ao abrir na hora de restaurar", async () => {
    const up = await upload(SEVEN_Z);
    openResult = { needsPassword: true, message: "A senha digitada não abre este backup." };
    const plan = await svc.plan("p1", startReq(up.uploadId, { backupPassword: "errada" }));
    const job = await svc.begin(plan, "admin");
    await svc.settled();
    expect(svc.job("p1", job.id).error).toMatchObject({ code: "password_required" });
    expect(execs).toEqual([]);
  });

  it("pasta do backup que é link para fora da pasta de trabalho não é seguida", async () => {
    engines = [{ service: "db", engine: "mysql", containerId: "c-db", running: true, databaseName: "shop" }];
    const outside = path.join(dataDir, "fora");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "x.sql"), MY_SQL);
    listFn = async () => [
      { path: "manifesto.json", size: 100 },
      { path: "bancos/db/x.sql", size: 10 },
    ];
    extractFn = async (_a, out) => {
      await mkdir(path.join(out, "bancos"), { recursive: true });
      await writeFile(path.join(out, "manifesto.json"), manifest([{ type: "database", service: "db", engine: "mysql", file: "bancos/db/x.sql" }]));
      await symlink(outside, path.join(out, "bancos", "db"));
    };
    const { job } = await restoreWith(SEVEN_Z, { database: "shop" });
    expect(job).toMatchObject({ status: "failed", error: { code: "invalid_backup" } });
    expect(execs).toEqual([]);
  });

  it("7-Zip que falha ao abrir na hora de restaurar", async () => {
    extractFn = async () => {
      throw new Error("arquivo corrompido");
    };
    const { job } = await restoreWith(SEVEN_Z);
    expect(job.error).toMatchObject({ code: "invalid_backup" });
    expect(job.error?.message).toContain("arquivo corrompido");
  });
});

describe("falhas fora do cliente do banco", () => {
  it("erro sem código (o Docker não para o app) vira falha genérica e o que já parou volta a ligar", async () => {
    svc = build({ docker: { ...(svc["deps"].docker as object), stop: async () => Promise.reject(new Error("docker caiu")) } as never });
    const { job } = await restoreWith(PG_SQL);
    expect(job).toMatchObject({ status: "failed", error: { code: "restore_failed" } });
    expect(job.error?.message).toContain("docker caiu");
  });

  it("rejeição que não é um Error também vira mensagem", async () => {
    svc = build({ docker: { ...(svc["deps"].docker as object), execFromFile: async () => Promise.reject("texto solto") } as never });
    const { job } = await restoreWith(PG_SQL);
    expect(job.error?.message).toContain("texto solto");
  });

  it("backup que falhou sem dizer o motivo", async () => {
    backupRecord = record({ status: "failed", error: null });
    const { job } = await restoreWith(PG_SQL, { backup: "full" });
    expect(job.error?.message).toContain("falhou");
  });
});

// ---------------------------------------------------------------------------
// Revisão: comandos do cliente, trocas de banco, COPY escondido, 7z limitado, arquivos esquecidos, MongoDB, envio parado
// ---------------------------------------------------------------------------

const PAD = "-- preenchimento para passar do começo reconhecido\n".repeat(400);
const bsonDb = (name: string): Buffer => {
  const len = Buffer.alloc(4);
  len.writeInt32LE(name.length + 1);
  return Buffer.concat([Buffer.from([0x02]), Buffer.from("db\0"), len, Buffer.from(`${name}\0`)]);
};
const mongoWith = (...names: string[]): Buffer => Buffer.concat([MONGO, ...names.map((n) => Buffer.concat([bsonDb(n), Buffer.alloc(20, 3)]))]);

describe("MySQL/MariaDB: comandos do cliente, troca de banco e bancos de sistema", () => {
  beforeEach(() => {
    engines = [{ service: "db", engine: "mysql", containerId: "c-db", running: true, databaseName: "shop" }];
  });

  it.each(["\\! id", "system id", "SYSTEM id", "source /etc/passwd", "\\. /tmp/x.sql", "  \\! id", "pager sh", "tee /tmp/x", "edit", "\\P sh", "\\T /tmp/y"])(
    "linha '%s' no meio do arquivo é recusada (o arquivo todo é lido, não só o começo)",
    async (line) => {
      await expect(upload(`${MY_SQL}${PAD}${line}\nSELECT 1;\n`)).rejects.toMatchObject({ statusCode: 400, code: "unsafe_sql" });
      expect(await files()).toEqual([]);
    },
  );

  it("o mesmo vale dentro de um .sql.gz", async () => {
    await expect(upload(gzipSync(`${MY_SQL}${PAD}\\! id\n`))).rejects.toMatchObject({ code: "unsafe_sql" });
  });

  it.each(["USE `outro`;", "CREATE DATABASE `x`;", "CREATE DATABASE /*!32312 IF NOT EXISTS*/ `x` /*!40100 DEFAULT CHARACTER SET utf8 */;", "DROP DATABASE IF EXISTS x;", "create schema y;", "/*!50001 CREATE DATABASE z */;"])(
    "'%s' (dump com --databases) é recusado com a explicação de como gerar de um banco só",
    async (line) => {
      await expect(upload(`${MY_SQL}${line}\n`)).rejects.toMatchObject({ code: "multi_database" });
    },
  );

  it.each([
    "INSERT INTO `mysql`.`user` VALUES (1);",
    "INSERT IGNORE INTO mysql.db VALUES (1);",
    "UPDATE mysql.user SET Host='%';",
    "DELETE FROM `sys`.`x`;",
    "DROP TABLE IF EXISTS `mysql`.`user`;",
    "LOCK TABLES `information_schema`.`x` WRITE;",
    "GRANT ALL ON *.* TO 'a'@'%';",
    "CREATE USER 'a'@'%' IDENTIFIED BY 'x';",
    "ALTER USER root IDENTIFIED BY 'x';",
    "SET PASSWORD FOR a = 'x';",
  ])("'%s' (mexe em contas ou bancos de sistema) é recusado", async (line) => {
    await expect(upload(`${MY_SQL}${line}\n`)).rejects.toMatchObject({ code: "unsafe_sql" });
  });

  it("dump normal passa, inclusive com 'mysql.com', 'use' e 'source' dentro de texto de dados", async () => {
    const ok = `${MY_SQL}INSERT INTO \`t\` VALUES ('veja mysql.com', 'use isto', 'source: x', 'system call');\nINSERT INTO t VALUES ('\\\\! no meio');\n`;
    expect((await upload(ok)).format).toBe("sql");
  });

  it("o cliente roda com --binary-mode (desliga os comandos do cliente mesmo que algum passe)", () => {
    expect(MYSQL_SCRIPT).toContain("--binary-mode");
  });
});

describe("PostgreSQL: COPY escondido em comentário e comandos que rodam fora do banco", () => {
  const HEAD = "-- PostgreSQL database dump\n";
  const evil = "SET x = 0;\nCOPY (SELECT 1) TO STDOUT; -- FROM stdin;\n\\! id > /tmp/pwned\nSELECT 2;\n";

  it("o COPY ... TO STDOUT com '-- FROM stdin;' no fim não esconde o comando que vem depois (sonda do revisor)", async () => {
    await expect(upload(HEAD + evil)).rejects.toMatchObject({ code: "unsafe_sql" });
  });

  it("lista de colunas que esconde outro comando também não passa por COPY de verdade", async () => {
    await expect(upload(`${HEAD}COPY t (x) TO stdout; -- (y) FROM stdin;\n\\! id\n`)).rejects.toMatchObject({ code: "unsafe_sql" });
  });

  it("COPY dentro de comentário de bloco ou de texto não abre o bloco de dados", async () => {
    await expect(upload(`${HEAD}/* COPY t FROM stdin;\n*/ SELECT 1;\n\\! id\n`)).rejects.toMatchObject({ code: "unsafe_sql" });
    await expect(upload(`${HEAD}SELECT $$\nCOPY t FROM stdin;\n$$;\n\\! id\n`)).rejects.toMatchObject({ code: "unsafe_sql" });
  });

  it("COPY de verdade (do pg_dump) com colunas, dados com barras e '\\.' no fim continua valendo", async () => {
    const dump = `${HEAD}CREATE TABLE public.t (id int, "Nome x" text);\nCOPY public.t (id, "Nome x") FROM stdin;\n1\ta\\tb\\\\! c\n2\t\\N\n\\.\nSELECT 1;\n`;
    expect((await upload(dump)).format).toBe("sql");
    expect((await upload(`${HEAD}COPY t FROM stdin;\n\\! dentro dos dados\n\\.\n`)).format).toBe("sql");
  });

  it("dump --inserts legítimo com 'program', 'lo_import' e 'FROM PROGRAM' nos dados e em comentários passa (só comando do psql é bloqueado)", async () => {
    const dump = `${HEAD}INSERT INTO t VALUES (1, 'Welcome to program X');\nCOMMENT ON TABLE t IS 'Imported from program Y';\nINSERT INTO t VALUES (2, 'use COPY FROM PROGRAM com cuidado e lo_import também');\n-- to program Z\nCREATE TABLE lo_export_log (id int);\n`;
    expect((await upload(dump)).format).toBe("sql");
  });
});

describe("backup do painel (.7z): extração limitada", () => {
  const items = [{ type: "database", service: "db", engine: "postgres", databases: [{ name: "loja", file: "bancos/db/loja.sql" }] }];
  const manifest = JSON.stringify({ version: 1, kind: "project", items });

  it("extrai só o manifesto e o UM dump escolhido, nunca a pasta bancos inteira", async () => {
    const extracted: Array<string[] | undefined> = [];
    listFn = async () => [
      { path: "manifesto.json", size: manifest.length },
      { path: "bancos/db/loja.sql", size: PG_SQL.length },
      { path: "bancos/db/outro.sql", size: 9_000_000_000 },
      { path: "volumes/x.tar", size: 9_000_000_000 },
    ];
    extractFn = async (_a, out, _pw, only) => {
      extracted.push(only);
      await mkdir(path.join(out, "bancos", "db"), { recursive: true });
      await writeFile(path.join(out, "manifesto.json"), manifest);
      if (only?.includes("bancos/db/loja.sql")) await writeFile(path.join(out, "bancos", "db", "loja.sql"), PG_SQL);
    };
    const { job } = await restoreWith(SEVEN_Z);
    expect(job.status).toBe("success");
    expect(extracted).toEqual([["manifesto.json"], ["bancos/db/loja.sql"]]);
  });

  it("dump que não cabe no disco (pelo tamanho que ele terá) falha antes de extrair", async () => {
    listFn = async () => [
      { path: "manifesto.json", size: manifest.length },
      { path: "bancos/db/loja.sql", size: 40 * 1024 ** 3 },
    ];
    let dumpExtracted = false;
    extractFn = async (_a, out, _pw, only) => {
      await mkdir(out, { recursive: true });
      await writeFile(path.join(out, "manifesto.json"), manifest);
      if (only?.includes("bancos/db/loja.sql")) dumpExtracted = true;
    };
    freeBytes = 10 * 1024 ** 3;
    const { job } = await restoreWith(SEVEN_Z);
    expect(job.error?.code).toBe("no_space");
    expect(job.error?.message).toContain("GB");
    expect(dumpExtracted).toBe(false);
    expect(await files()).toEqual([]);
  });

  it("sem manifesto na lista, com manifesto enorme ou com a listagem falhando: backup inválido, nada é extraído", async () => {
    let extracts = 0;
    extractFn = async () => void extracts++;
    const up = await upload(SEVEN_Z);
    listFn = async () => [{ path: "bancos/x.sql", size: 1 }];
    await expect(svc.check("p1", up.uploadId, { service: "db" })).rejects.toMatchObject({ code: "invalid_backup" });
    listFn = async () => [{ path: "manifesto.json", size: 64 * 1024 * 1024 }];
    await expect(svc.check("p1", up.uploadId, { service: "db" })).rejects.toMatchObject({ code: "invalid_backup" });
    listFn = async () => {
      throw new Error("7-Zip não abriu");
    };
    await expect(svc.check("p1", up.uploadId, { service: "db" })).rejects.toThrow("7-Zip não abriu");
    expect(extracts).toBe(0);
  });
});

describe("arquivos esquecidos no projeto", () => {
  it("as opções listam os arquivos parados (do mais antigo ao mais novo), sem os que estão em uso", async () => {
    const a = await upload(PG_SQL);
    const b = await upload(PG_SQL);
    svc["uploads"].get(a.uploadId)!.createdAt = 1_000;
    svc["uploads"].get(b.uploadId)!.createdAt = 2_000;
    let o = await svc.options("p1");
    expect(o.uploads.map((u) => u.uploadId)).toEqual([a.uploadId, b.uploadId]);
    expect(o.uploads[0]).toEqual({ uploadId: a.uploadId, service: "db", sizeBytes: PG_SQL.length, format: "sql", gzip: false, createdAt: new Date(1_000).toISOString() });
    svc["uploads"].get(a.uploadId)!.inUse = true;
    o = await svc.options("p1");
    expect(o.uploads.map((u) => u.uploadId)).toEqual([b.uploadId]);
  });

  it("descartar pela tela apaga o arquivo e ele some da lista", async () => {
    const a = await upload(PG_SQL);
    await svc.cancel("p1", a.uploadId, "admin");
    expect((await svc.options("p1")).uploads).toEqual([]);
  });

  it("o arquivo descartado entre conferir e começar não é restaurado (404)", async () => {
    const a = await upload(PG_SQL);
    const plan = await svc.plan("p1", startReq(a.uploadId));
    await svc.cancel("p1", a.uploadId, "admin");
    await expect(svc.begin(plan, "admin")).rejects.toMatchObject({ statusCode: 404, code: "upload_not_found" });
    expect(svc["running"].has("p1")).toBe(false);
  });
});

describe("MongoDB: bancos de sistema e renomear o banco do arquivo", () => {
  beforeEach(() => {
    engines = [{ service: "db", engine: "mongo", containerId: "c-db", running: true, databaseName: "loja" }];
  });

  it("o script nunca restaura admin, config nem local e impede o shell de expandir os asteriscos", () => {
    expect(MONGO_SCRIPT).toContain("set -f");
    for (const d of ["admin", "config", "local"]) expect(MONGO_SCRIPT).toContain(`--nsExclude=${d}.*`);
    expect(MONGO_SCRIPT).toContain("--nsFrom=");
  });

  it("arquivo de um banco só com outro nome vai para o banco do serviço", async () => {
    const { job } = await restoreWith(mongoWith("app"), { database: undefined });
    expect(job.status).toBe("success");
    expect(execs[0]!.args).toEqual(["raw", "keep", "loja"]);
  });

  it("mesmo nome, vários bancos ou só bancos de sistema: os nomes do arquivo ficam", async () => {
    await restoreWith(mongoWith("loja"), { database: undefined });
    await restoreWith(mongoWith("app", "outro"), { database: undefined });
    await restoreWith(mongoWith("admin", "config"), { database: undefined });
    expect(execs.map((e) => e.args[2])).toEqual(["", "", ""]);
  });

  it("banco de sistema no arquivo não conta: 'app' + 'admin' ainda é um banco só", async () => {
    await restoreWith(mongoWith("admin", "app", "local"), { database: undefined });
    expect(execs[0]!.args[2]).toBe("loja");
  });

  it("serviço sem banco principal conhecido não renomeia", async () => {
    engines = [{ service: "db", engine: "mongo", containerId: "c-db", running: true, databaseName: null }];
    await restoreWith(mongoWith("app"), { database: undefined });
    expect(execs[0]!.args[2]).toBe("");
  });

  it("também em .gz, e o gz corrompido continua sendo recusado", async () => {
    await restoreWith(gzipSync(mongoWith("app")), { database: undefined });
    expect(execs[0]!.args).toEqual(["gz", "keep", "loja"]);
    await expect(upload(Buffer.concat([gzipSync(mongoWith("app")).subarray(0, 40)]))).rejects.toMatchObject({ code: "corrupt_gzip" });
  });

  it("de dentro de um backup do painel", async () => {
    listFn = async () => [
      { path: "manifesto.json", size: 100 },
      { path: "bancos/db.archive", size: 100 },
    ];
    extractFn = async (_a, out, _pw, only) => {
      await mkdir(path.join(out, "bancos"), { recursive: true });
      await writeFile(path.join(out, "manifesto.json"), JSON.stringify({ items: [{ type: "database", service: "db", engine: "mongo", file: "bancos/db.archive" }] }));
      if (only?.includes("bancos/db.archive")) await writeFile(path.join(out, "bancos", "db.archive"), mongoWith("origem"));
    };
    await restoreWith(SEVEN_Z, { database: undefined });
    expect(execs[0]!.args).toEqual(["raw", "keep", "loja"]);
  });
});

describe("falha da restauração: saída e dica", () => {
  it("o final do que o cliente escreveu fica como saída da falha", async () => {
    execResult = Object.assign(new Error("psql: ERROR"), { stderr: `${"x".repeat(30_000)}\nERROR: syntax error at line 9\n` });
    const { job } = await restoreWith(PG_SQL);
    expect(job.status).toBe("failed");
    expect(job.output).toContain("syntax error at line 9");
    expect(job.output!.length).toBeLessThanOrEqual(20_000);
  });

  it("papel inexistente no dump traz a dica de --no-owner --no-acl", async () => {
    execResult = Object.assign(new Error('psql: ERROR: role "app_owner" does not exist'), { stderr: 'ERROR:  role "app_owner" does not exist\n' });
    const { job } = await restoreWith(PG_SQL);
    expect(job.error?.message).toContain("--no-owner --no-acl");
    expect(job.output).toContain("app_owner");
  });

  it("erro sem stderr (ex.: prazo) fica sem saída", async () => {
    execResult = new Error("o comando passou do prazo e foi interrompido");
    const { job } = await restoreWith(PG_SQL);
    expect(job.output).toBeNull();
    expect(job.error?.message).not.toContain("--no-owner");
  });
});

describe("envio parado e limite de envios ao mesmo tempo", () => {
  it("sem receber nenhum byte por idleMs, o envio é interrompido (408) e o parcial é apagado", async () => {
    svc = build({ idleMs: 40 });
    const stream = new PassThrough();
    const pending = upload(stream);
    stream.write(Buffer.from(PG_SQL));
    await expect(pending).rejects.toMatchObject({ statusCode: 408, code: "upload_stalled" });
    expect(await files()).toEqual([]);
    expect(svc["receiving"].size).toBe(0);
  });

  it("enquanto os bytes chegam, o relógio recomeça e o envio termina", async () => {
    svc = build({ idleMs: 150 });
    const stream = new PassThrough();
    const pending = upload(stream);
    for (const part of [PG_SQL.slice(0, 20), PG_SQL.slice(20, 40), PG_SQL.slice(40)]) {
      stream.write(part);
      await new Promise((r) => setTimeout(r, 60));
    }
    stream.end();
    expect((await pending).sizeBytes).toBe(PG_SQL.length);
  });

  it("no máximo maxConcurrent envios ao mesmo tempo em todo o painel: o seguinte recebe 429", async () => {
    svc = build({ maxConcurrent: 2 });
    const a = new PassThrough();
    const b = new PassThrough();
    const pa = upload(a);
    const pb = upload(b);
    await vi.waitFor(() => expect(svc["receiving"].get("p1")).toBe(2));
    await expect(upload(PG_SQL)).rejects.toMatchObject({ statusCode: 429, code: "too_many_uploads" });
    a.end(PG_SQL);
    b.end(PG_SQL);
    await Promise.all([pa, pb]);
    expect((await upload(PG_SQL)).format).toBe("sql");
  });
});

describe("vagas de envio por pessoa e relógio do envio parado", () => {
  it("uma pessoa ocupa no máximo 2 das 3 vagas; outra pessoa ainda consegue a terceira", async () => {
    const streams = [new PassThrough(), new PassThrough()];
    const pending = streams.map((st) => upload(st));
    await vi.waitFor(() => expect(svc["receivingBy"].get("admin")).toBe(2));
    await expect(upload(PG_SQL)).rejects.toMatchObject({ statusCode: 429, code: "too_many_uploads" });
    // outra pessoa não esbarra no limite da primeira (aqui só o limite do projeto vale)
    await expect(upload(PG_SQL, { actor: "outra" })).rejects.toMatchObject({ statusCode: 409, code: "upload_busy" });
    streams.forEach((st) => st.end(PG_SQL));
    await Promise.all(pending);
    expect(svc["receivingBy"].size).toBe(0);
  });

  it("depois que o corpo chegou, a validação demorada não conta como envio parado", async () => {
    svc = build({ idleMs: 60 });
    const slow = vi.spyOn(svc as unknown as { validate: () => Promise<void> }, "validate").mockImplementation(() => new Promise((r) => setTimeout(r, 200)));
    const up = await upload(PG_SQL);
    expect(up.sizeBytes).toBe(PG_SQL.length);
    expect(slow).toHaveBeenCalled();
  });
});
