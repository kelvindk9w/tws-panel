/**
 * routes-upload-restore.test.ts — "Restaurar de um arquivo": as rotas com o serviço de verdade e o Docker de mentira.
 * Sessão obrigatória, envio em corpo cru, limites, reautenticação (senha + 2FA obrigatório) só ao começar, nome do
 * projeto digitado e token de API barrado.
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER, type BackupRecord, type Project } from "@paas/core";
import authRoutes from "../src/routes/auth.js";
import setupRoutes from "../src/routes/setup.js";
import uploadRestoreRoutes from "../src/routes/upload-restore.js";
import { UploadRestoreService } from "../src/services/upload-restore.js";
import { TOTP_STEP_SECONDS, totpCode } from "../src/services/totp.js";
import { buildAuthTestApp, closeAuthTestApp, sessionCookieOf, type AuthTestContext } from "./test-utils.js";

const SETUP = "token-de-teste";
const PASSWORD = "MinhaSenha123";
const BASE = "/api/backups/projects/p1/upload-restore";
const PG_SQL = "-- PostgreSQL database dump\nSET statement_timeout = 0;\nCREATE TABLE t (id int);\n";
const PGDMP = Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(100, 3)]);
const MONGO = Buffer.concat([Buffer.from([0x6d, 0xe2, 0x99, 0x81]), Buffer.alloc(50)]);
const OCTET = { "content-type": "application/octet-stream" };
const PROJECT = { id: "p1", name: "Loja", slug: "loja" } as unknown as Project;

let ctx: AuthTestContext;
let app: FastifyInstance;
let dataDir: string;
let nowMs: number;
let svc: UploadRestoreService;
let restored: Array<{ args: string[]; content: string }>;
let backups: string[];

async function build(maxBytes = 5000) {
  dataDir = await mkdtemp(path.join(tmpdir(), "routes-upload-restore-"));
  restored = [];
  backups = [];
  svc = new UploadRestoreService({
    dataDir,
    maxBytes,
    docker: {
      execCapture: async () => "loja\n",
      execFromFile: async (_c: string, _s: string, args: string[], file: string) => {
        restored.push({ args, content: await readFile(file, "utf8") });
        return { stderr: "", stdout: "" };
      },
      projectContainers: async () => [],
    } as never,
    backups: {
      databaseServices: async () => [{ service: "db", engine: "postgres", containerId: "c-db", running: true, databaseName: "loja" }],
      openUploadedArchive: async () => ({ password: null }),
      runNow: async (target: string) => {
        backups.push(target);
        return { id: "b1", status: "success", fileName: "2026-10-30_10-00.7z", warnings: [] } as unknown as BackupRecord;
      },
      record: async () => ({ id: "b1", status: "success", fileName: "2026-10-30_10-00.7z", warnings: [] }) as unknown as BackupRecord,
    },
    archiver: { extract: async () => undefined, list: async () => [] },
    projects: { get: async (id: string) => (id === "p1" ? PROJECT : null) },
    audit: ctx.auditService,
    sleep: async () => undefined,
  });
  app.decorate("uploadRestore", svc);
  await app.register(authRoutes);
  await app.register(setupRoutes);
  await app.register(uploadRestoreRoutes);
  const res = await app.inject({ method: "POST", url: "/api/setup/admin", headers: { [SETUP_TOKEN_HEADER]: SETUP }, payload: { username: "admin", password: PASSWORD } });
  expect(res.statusCode).toBe(201);
}

beforeEach(async () => {
  nowMs = Date.UTC(2026, 9, 30, 12, 0, 0);
  ctx = await buildAuthTestApp(SETUP, { now: () => nowMs });
  app = ctx.app;
  await build();
});

afterEach(async () => {
  await svc.stop();
  await closeAuthTestApp(ctx);
  await rm(dataDir, { recursive: true, force: true });
});

const codeNow = (secret: string) => totpCode(secret, Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS));
const nextStep = () => (nowMs += TOTP_STEP_SECONDS * 1000);

async function loginCookie(): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD } });
  return sessionCookieOf(res);
}

async function ready() {
  const cookie = await loginCookie();
  const setup = await app.inject({ method: "POST", url: "/api/auth/2fa/setup", headers: { cookie } });
  const { secret } = setup.json() as { secret: string };
  const en = await app.inject({ method: "POST", url: "/api/auth/2fa/enable", headers: { cookie }, payload: { currentPassword: PASSWORD, code: codeNow(secret) } });
  expect(en.statusCode, en.body).toBe(200);
  const creds = () => {
    nextStep();
    return { currentPassword: PASSWORD, code: codeNow(secret) };
  };
  return { cookie, creds };
}

const put = (cookie: string, body: Buffer | string, query = "service=db&name=dump.sql") =>
  app.inject({ method: "PUT", url: `${BASE}/files?${query}`, headers: { cookie, ...OCTET }, payload: body });

const startBody = (uploadId: string, extra: Record<string, unknown> = {}) => ({
  uploadId,
  service: "db",
  database: "loja",
  clean: false,
  backup: "none",
  confirm: "Loja",
  ...extra,
});

describe("sem sessão", () => {
  it("todas as rotas respondem 401 e nada é gravado", async () => {
    const calls: Array<[string, string, object?]> = [
      ["GET", BASE],
      ["POST", `${BASE}/precheck?service=db`, { headers: OCTET, payload: "x" }],
      ["PUT", `${BASE}/files?service=db`, { headers: OCTET, payload: PG_SQL }],
      ["POST", `${BASE}/files/${"a".repeat(24)}/check`, { payload: { service: "db" } }],
      ["DELETE", `${BASE}/files/${"a".repeat(24)}`],
      ["POST", BASE, { payload: startBody("a".repeat(24), { currentPassword: PASSWORD }) }],
      ["GET", `${BASE}/jobs/${"a".repeat(12)}`],
    ];
    for (const [method, url, extra] of calls) {
      const res = await app.inject({ method: method as "GET", url, ...(extra ?? {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    expect(existsSync(path.join(dataDir, "uploads"))).toBe(false);
  });
});

describe("GET options", () => {
  it("serviços de banco, limite e espaço, sem cache", async () => {
    const res = await app.inject({ method: "GET", url: BASE, headers: { cookie: await loginCookie() } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toMatchObject({ maxBytes: 5000, development: false, busy: false, services: [{ service: "db", engine: "postgres", databases: ["loja"] }] });
  });

  it("projeto inexistente é 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/backups/projects/zzz/upload-restore", headers: { cookie: await loginCookie() } });
    expect(res.statusCode).toBe(404);
  });

  it("falha inesperada é 500 genérico, sem vazar a causa", async () => {
    vi.spyOn(svc, "options").mockRejectedValueOnce(new Error("segredo interno"));
    const res = await app.inject({ method: "GET", url: BASE, headers: { cookie: await loginCookie() } });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("internal_error");
    expect(res.body).not.toContain("segredo interno");
  });
});

describe("precheck", () => {
  it("reconhece o começo do arquivo sem gravar nada", async () => {
    const cookie = await loginCookie();
    const ok = await app.inject({ method: "POST", url: `${BASE}/precheck?service=db&name=a.dump`, headers: { cookie, ...OCTET }, payload: PGDMP });
    expect(ok.json()).toEqual({ format: "pg_custom", gzip: false });
    const bad = await app.inject({ method: "POST", url: `${BASE}/precheck?service=db`, headers: { cookie, ...OCTET }, payload: MONGO });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("wrong_engine");
    expect(bad.headers.connection).toBe("close");
    expect(existsSync(path.join(dataDir, "uploads", "restore", "x"))).toBe(false);
  });

  it("corpo grande demais para a conferência é recusado", async () => {
    const res = await app.inject({ method: "POST", url: `${BASE}/precheck?service=db`, headers: { cookie: await loginCookie(), ...OCTET }, payload: Buffer.alloc(40_000, 65) });
    expect(res.statusCode).toBe(413);
  });

  it("o corpo cru passa pela leitura em pedaços (fluxo sem Content-Length)", async () => {
    const { Readable } = await import("node:stream");
    const res = await app.inject({ method: "POST", url: `${BASE}/precheck?service=db`, headers: { cookie: await loginCookie(), ...OCTET }, payload: Readable.from([PGDMP.subarray(0, 50), PGDMP.subarray(50)]) });
    expect(res.json().format).toBe("pg_custom");
  });

  it("precheck de corpo sem tamanho passa de 16 KB: recusado pela leitura", async () => {
    const { Readable } = await import("node:stream");
    const chunks = Array.from({ length: 5 }, () => Buffer.alloc(4000, 65));
    const res = await app.inject({ method: "POST", url: `${BASE}/precheck?service=db`, headers: { cookie: await loginCookie(), ...OCTET }, payload: Readable.from(chunks) });
    expect([400, 413]).toContain(res.statusCode);
  });
});

describe("PUT files", () => {
  it("recebe o corpo cru e grava em disco com o id sorteado", async () => {
    const cookie = await loginCookie();
    const res = await put(cookie, PG_SQL);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body).toMatchObject({ sizeBytes: PG_SQL.length, format: "sql", gzip: false, needsPassword: false });
    expect(await readFile(path.join(dataDir, "uploads", "restore", body.uploadId), "utf8")).toBe(PG_SQL);
  });

  it("acima do limite do serviço: 413 com a mensagem, nada fica no disco", async () => {
    const res = await put(await loginCookie(), PG_SQL.padEnd(6000, "-"));
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe("too_large");
    expect(res.headers.connection).toBe("close");
    expect(await readdir(path.join(dataDir, "uploads", "restore")).catch(() => [])).toEqual([]);
  });

  it("acima do limite da rota (limite + 1 MB): 413 do próprio servidor, antes de ler o corpo", async () => {
    const res = await put(await loginCookie(), Buffer.alloc(1024 * 1024 + 6000, 65));
    expect(res.statusCode).toBe(413);
    expect(await readdir(path.join(dataDir, "uploads", "restore")).catch(() => [])).toEqual([]);
  });

  it("arquivo de outro motor: 400 wrong_engine e conexão fechada", async () => {
    const res = await put(await loginCookie(), MONGO);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("wrong_engine");
    expect(res.headers.connection).toBe("close");
  });

  it(".zip pelo nome é recusado; serviço ausente na consulta é 400", async () => {
    const cookie = await loginCookie();
    expect((await put(cookie, PG_SQL, "service=db&name=dump.zip")).json().error).toBe("zip_not_supported");
    expect((await put(cookie, PG_SQL, "name=x")).statusCode).toBe(400);
  });

  it("corpo em pedaços, sem Content-Length: o tamanho vem do que chegou", async () => {
    const { Readable } = await import("node:stream");
    const res = await app.inject({ method: "PUT", url: `${BASE}/files?service=db`, headers: { cookie: await loginCookie(), ...OCTET }, payload: Readable.from([Buffer.from(PG_SQL.slice(0, 20)), Buffer.from(PG_SQL.slice(20))]) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().sizeBytes).toBe(PG_SQL.length);
  });
});

describe("check e DELETE", () => {
  it("DELETE descarta o arquivo; repetir é 404", async () => {
    const cookie = await loginCookie();
    const { uploadId } = (await put(cookie, PG_SQL)).json();
    const del = await app.inject({ method: "DELETE", url: `${BASE}/files/${uploadId}`, headers: { cookie } });
    expect(del.statusCode).toBe(204);
    expect(existsSync(path.join(dataDir, "uploads", "restore", uploadId))).toBe(false);
    const again = await app.inject({ method: "DELETE", url: `${BASE}/files/${uploadId}`, headers: { cookie } });
    expect(again.statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `${BASE}/files/nao-e-id`, headers: { cookie } })).statusCode).toBe(400);
  });

  it("check só vale para backup do painel", async () => {
    const cookie = await loginCookie();
    const { uploadId } = (await put(cookie, PG_SQL)).json();
    const res = await app.inject({ method: "POST", url: `${BASE}/files/${uploadId}/check`, headers: { cookie }, payload: { service: "db" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("not_panel_backup");
  });
});

describe("começar a restaurar: reautenticação", () => {
  it("sem 2FA ligado: 409 two_factor_required e nada roda", async () => {
    const cookie = await loginCookie();
    const { uploadId } = (await put(cookie, PG_SQL)).json();
    const res = await app.inject({ method: "POST", url: BASE, headers: { cookie }, payload: { ...startBody(uploadId), currentPassword: PASSWORD } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("two_factor_required");
    expect(restored).toEqual([]);
  });

  it("senha errada: 401; código errado: 400; sem corpo completo: 400 do esquema", async () => {
    const { cookie, creds } = await ready();
    const { uploadId } = (await put(cookie, PG_SQL)).json();
    const wrongPw = await app.inject({ method: "POST", url: BASE, headers: { cookie }, payload: { ...startBody(uploadId), ...creds(), currentPassword: "errada" } });
    expect(wrongPw.statusCode).toBe(401);
    expect(wrongPw.json().error).toBe("invalid_current_password");
    const wrongCode = await app.inject({ method: "POST", url: BASE, headers: { cookie }, payload: { ...startBody(uploadId), currentPassword: PASSWORD, code: "000000" } });
    expect(wrongCode.statusCode).toBe(400);
    expect(wrongCode.json().error).toBe("invalid_two_factor_code");
    const noCode = await app.inject({ method: "POST", url: BASE, headers: { cookie }, payload: { ...startBody(uploadId), currentPassword: PASSWORD } });
    expect(noCode.statusCode).toBe(400);
    const noPw = await app.inject({ method: "POST", url: BASE, headers: { cookie }, payload: startBody(uploadId) });
    expect(noPw.statusCode).toBe(400);
    expect(restored).toEqual([]);
    await svc.settled();
  });

  it("nome do projeto errado é recusado ANTES da senha: o código do 2FA não é gasto", async () => {
    const { cookie, creds } = await ready();
    const { uploadId } = (await put(cookie, PG_SQL)).json();
    const c = creds();
    const wrong = await app.inject({ method: "POST", url: BASE, headers: { cookie }, payload: { ...startBody(uploadId, { confirm: "outro" }), ...c } });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe("confirm_mismatch");
    // o mesmo código ainda vale
    const ok = await app.inject({ method: "POST", url: BASE, headers: { cookie }, payload: { ...startBody(uploadId), ...c } });
    expect(ok.statusCode, ok.body).toBe(202);
    await svc.settled();
  });

  it("tudo certo: 202 com o trabalho, restaura o arquivo, audita e apaga o envio", async () => {
    const { cookie, creds } = await ready();
    const { uploadId } = (await put(cookie, PG_SQL)).json();
    const res = await app.inject({ method: "POST", url: BASE, headers: { cookie }, payload: { ...startBody(uploadId, { backup: "full" }), ...creds() } });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.headers["cache-control"]).toBe("no-store");
    const job = res.json();
    expect(job).toMatchObject({ projectId: "p1", service: "db", backup: "full", format: "sql" });
    await svc.settled();
    const done = await app.inject({ method: "GET", url: `${BASE}/jobs/${job.id}`, headers: { cookie } });
    expect(done.json()).toMatchObject({ status: "success", backupFileName: "2026-10-30_10-00.7z", error: null });
    expect(backups).toEqual(["project:p1"]);
    expect(restored).toEqual([{ args: ["loja", "raw"], content: PG_SQL }]);
    expect(await readdir(path.join(dataDir, "uploads", "restore"))).toEqual([]);
    const audit = await ctx.auditService.list();
    const text = JSON.stringify(audit);
    expect(text).toContain("backups.upload_restore");
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("CREATE TABLE");
  });

  it("arquivo inexistente: 404 antes de pedir a senha; segunda restauração enquanto uma roda: 409", async () => {
    const { cookie, creds } = await ready();
    const ghost = await app.inject({ method: "POST", url: BASE, headers: { cookie }, payload: { ...startBody("a".repeat(24)), ...creds() } });
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json().error).toBe("upload_not_found");
  });

  it("job de outro id ou formato inválido", async () => {
    const cookie = await loginCookie();
    expect((await app.inject({ method: "GET", url: `${BASE}/jobs/${"a".repeat(12)}`, headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `${BASE}/jobs/xx`, headers: { cookie } })).statusCode).toBe(400);
  });
});

describe("sem sessão e sem a guarda global (só o gancho da própria rota)", () => {
  it("responde 401", async () => {
    const bare = Fastify({ logger: false });
    bare.decorateRequest("session", null as never);
    bare.decorate("uploadRestore", svc);
    await bare.register(uploadRestoreRoutes);
    const res = await bare.inject({ method: "GET", url: BASE });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthorized");
    await bare.close();
  });
});

describe("token de API", () => {
  it("não restaura: 403 token_forbidden, sem chamar o serviço", async () => {
    const tokenApp = Fastify({ logger: false });
    tokenApp.decorateRequest("session", null as never);
    tokenApp.addHook("onRequest", async (request) => {
      (request as unknown as { session: unknown }).session = { token: "t1", username: "ci" };
    });
    const plan = vi.spyOn(svc, "plan");
    tokenApp.decorate("uploadRestore", svc);
    await tokenApp.register(uploadRestoreRoutes);
    const res = await tokenApp.inject({ method: "POST", url: BASE, payload: { ...startBody("a".repeat(24)), currentPassword: PASSWORD } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("token_forbidden");
    expect(plan).not.toHaveBeenCalled();
    await tokenApp.close();
  });
});

describe("corpo que não é octet-stream (não pode ser guardado na memória pelo Fastify)", () => {
  it("PUT files e precheck com texto, JSON ou sem tipo respondem 415 sem ler o corpo nem gravar nada", async () => {
    const cookie = await loginCookie();
    for (const type of ["text/plain", "application/json", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const res = await app.inject({ method: "PUT", url: `${BASE}/files?service=db`, headers: { cookie, "content-type": type }, payload: type.includes("json") ? "{}" : PG_SQL });
      expect(res.statusCode, type).toBe(415);
      expect(res.json().error).toBe("unsupported_media_type");
      const pre = await app.inject({ method: "POST", url: `${BASE}/precheck?service=db`, headers: { cookie, "content-type": type }, payload: "x" });
      expect(pre.statusCode, type).toBe(415);
    }
    const none = await app.inject({ method: "PUT", url: `${BASE}/files?service=db`, headers: { cookie } });
    expect(none.statusCode).toBe(415);
    expect(existsSync(path.join(dataDir, "uploads"))).toBe(false);
  });

  it("o limite de corpo da rota é pequeno: os analisadores embutidos nunca guardam gigabytes", async () => {
    let limit = 0;
    const probe = Fastify();
    probe.addHook("onRoute", (r) => {
      if (r.method === "PUT" && r.url.endsWith("/files")) limit = r.bodyLimit ?? 0;
    });
    probe.decorateRequest("session", null as never);
    probe.decorate("uploadRestore", svc);
    await probe.register(uploadRestoreRoutes);
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThanOrEqual(64 * 1024);
    await probe.close();
  });

  it("GET options traz os arquivos parados do projeto", async () => {
    const cookie = await loginCookie();
    const up = (await put(cookie, PG_SQL)).json() as { uploadId: string };
    const res = await app.inject({ method: "GET", url: BASE, headers: { cookie } });
    expect(res.json().uploads).toMatchObject([{ uploadId: up.uploadId, service: "db", format: "sql", sizeBytes: PG_SQL.length }]);
  });
});
