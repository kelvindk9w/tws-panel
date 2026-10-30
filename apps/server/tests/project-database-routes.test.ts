/**
 * project-database-routes.test.ts — aba Banco: as rotas com a reautenticação das ações destrutivas (senha + 2FA
 * obrigatório, igual ao terminal e à correção do buildx), o nome do projeto digitado, o limite de requisições e a
 * Auditoria. O banco é um dublê: aqui se confere o que a rota deixa passar.
 */
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETUP_TOKEN_HEADER, type DatabaseJob, type Project } from "@paas/core";
import databaseRoutes from "../src/routes/project-database.js";
import authRoutes from "../src/routes/auth.js";
import setupRoutes from "../src/routes/setup.js";
import { DatabaseService } from "../src/services/database-service.js";
import type { DbExecResult } from "../src/services/database-docker.js";
import { TOTP_STEP_SECONDS, totpCode } from "../src/services/totp.js";
import { buildAuthTestApp, closeAuthTestApp, sessionCookieOf, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const PASSWORD = "MinhaSenha123";
const ok = (stdout = ""): DbExecResult => ({ code: 0, stdout, stderr: "", truncated: false, timedOut: false });
const OVERVIEW = JSON.stringify({ version: "16.2", database: "appdb", sizeBytes: 1000, tables: [{ schema: "public", name: "users", rows: 3, sizeBytes: 8192 }] });

let ctx: AuthTestContext;
let app: FastifyInstance;
let nowMs: number;
let stdins: string[];
let argvs: string[][];
let projectOverride: Partial<Project>;
let framework: "laravel" | null;

async function build() {
  ctx = await buildAuthTestApp(TOKEN, { now: () => nowMs });
  app = ctx.app;
  await app.register(rateLimit, { global: false });
  const project = () => ({ id: "p1", name: "Loja", slug: "loja", proxyService: null, ...projectOverride }) as Project;
  app.decorate(
    "databaseService",
    new DatabaseService({
      projects: { get: async (id) => (id === "p1" ? project() : null), srcDir: () => "/srv/src", secrets: async () => [] },
      docker: {
        projectContainers: async () => [
          { id: "c-db", name: "db", service: "db", running: true },
          { id: "c-web", name: "web", service: "web", running: true },
        ],
      },
      exec: {
        sh: async (_c, _s, _a, o) => {
          stdins.push(o.stdin ?? "");
          if (o.stdin?.includes("BEGIN READ ONLY") && o.stdin.includes("json_build_object")) return ok(OVERVIEW);
          if (o.stdin?.includes("BEGIN READ ONLY")) return ok("n\n1\n");
          return ok();
        },
        argv: async (_c, argv) => {
          argvs.push([...argv]);
          return ok("migrated");
        },
      },
      backups: {
        detection: async () => ({ detectedAt: "", databases: [{ id: "db:db", service: "db", engine: "postgres", image: "postgres", databaseName: "appdb", user: "app", defaultSelected: true, method: "" }], mounts: [], unsavedWrites: [], sourceFolder: null, error: null }),
        run: async () => ({ id: "r1", status: "success", fileName: "b.7z", warnings: [] }) as never,
        record: async () => ({ id: "r1", status: "success", fileName: "b.7z", warnings: [] }) as never,
        busy: () => false,
        restoreCheck: async () => null,
      },
      detectFramework: async () => framework,
      audit: ctx.auditService,
      sleep: async () => undefined,
    }),
  );
  await app.register(authRoutes);
  await app.register(databaseRoutes);
  await app.register(setupRoutes);
  const res = await app.inject({ method: "POST", url: "/api/setup/admin", headers: { [SETUP_TOKEN_HEADER]: TOKEN }, payload: { username: "admin", password: PASSWORD } });
  expect(res.statusCode).toBe(201);
}

beforeEach(async () => {
  nowMs = Date.UTC(2026, 9, 30, 12, 0, 0);
  stdins = [];
  argvs = [];
  projectOverride = {};
  framework = null;
  await build();
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

const codeNow = (secret: string) => totpCode(secret, Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS));
const nextStep = () => (nowMs += TOTP_STEP_SECONDS * 1000);

async function loginCookie(): Promise<string> {
  return sessionCookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD } }));
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

const post = (cookie: string | undefined, path: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/api/projects/p1/database/${path}`, ...(cookie ? { headers: { cookie } } : {}), payload });

const base = (extra: Record<string, unknown> = {}) => ({ confirm: "Loja", backup: "none", ...extra });
const wrote = () => stdins.some((s) => /TRUNCATE|DO \$tws_reset|update users/.test(s));

describe("leitura (sessão normal)", () => {
  it("visão geral e consulta de leitura funcionam só com a sessão, sem senha nem 2FA", async () => {
    const cookie = await loginCookie();
    const overview = await app.inject({ method: "GET", url: "/api/projects/p1/database", headers: { cookie } });
    expect(overview.statusCode).toBe(200);
    expect(overview.headers["cache-control"]).toBe("no-store");
    expect(overview.json()).toMatchObject({ state: "ok", engine: "postgres", tables: [{ name: "users", rows: 3 }] });
    const read = await post(cookie, "sql/read", { sql: "select n from t" });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ columns: ["n"], rows: [["1"]] });
    expect(stdins.at(-1)).toContain("BEGIN READ ONLY");
  });

  it("escrita na rota de leitura: 400 write_query, e nada chega ao banco", async () => {
    const cookie = await loginCookie();
    const res = await post(cookie, "sql/read", { sql: "delete from users" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("write_query");
    expect(stdins).toHaveLength(0);
  });

  it("projeto inexistente: 404", async () => {
    const cookie = await loginCookie();
    expect((await app.inject({ method: "GET", url: "/api/projects/zzz/database", headers: { cookie } })).statusCode).toBe(404);
  });

  it("trabalho que não existe: 404", async () => {
    const cookie = await loginCookie();
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/database/jobs/nada", headers: { cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("job_not_found");
  });
});

describe("sem sessão", () => {
  it("toda rota responde 401, inclusive só com o setup token", async () => {
    for (const [method, url] of [
      ["GET", "/api/projects/p1/database"],
      ["GET", "/api/projects/p1/database/jobs/x"],
      ["POST", "/api/projects/p1/database/sql/read"],
      ["POST", "/api/projects/p1/database/truncate"],
      ["POST", "/api/projects/p1/database/reset"],
      ["POST", "/api/projects/p1/database/sql/write"],
      ["POST", "/api/projects/p1/database/command"],
    ] as const) {
      const res = await app.inject({ method, url, headers: { [SETUP_TOKEN_HEADER]: TOKEN }, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    expect(stdins).toHaveLength(0);
  });
});

describe("reautenticação das ações destrutivas", () => {
  it("exige 2FA ligado (409), a senha certa (401) e o código do app (400); nada é alterado", async () => {
    const cookie = await loginCookie();
    let res = await post(cookie, "reset", base({ currentPassword: PASSWORD }));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("two_factor_required");
    const { cookie: c2, creds } = await ready();
    res = await post(c2, "reset", base({ ...creds(), currentPassword: "errada" }));
    expect(res.statusCode).toBe(401);
    res = await post(c2, "reset", base({ currentPassword: PASSWORD }));
    expect(res.statusCode).toBe(400);
    expect(wrote()).toBe(false);
  });

  it("nome do projeto errado: 400 SEM gastar o código de verificação (o mesmo código ainda vale)", async () => {
    const { cookie, creds } = await ready();
    const c = creds();
    const bad = await post(cookie, "reset", { ...c, confirm: "loja", backup: "none" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("confirm_mismatch");
    const good = await post(cookie, "reset", { ...c, confirm: "Loja", backup: "none" });
    expect(good.statusCode, good.body).toBe(202);
  });

  it("corpo inválido: sem confirm, backup fora da lista, campo extra", async () => {
    const { cookie, creds } = await ready();
    expect((await post(cookie, "reset", { ...creds(), backup: "none" })).statusCode).toBe(400);
    expect((await post(cookie, "reset", { ...creds(), confirm: "Loja", backup: "parcial" })).statusCode).toBe(400);
    expect((await post(cookie, "reset", { ...creds(), confirm: "Loja", backup: "none", extra: 1 })).statusCode).toBe(400);
    expect(wrote()).toBe(false);
  });

  it("limite de 10 pedidos por minuto nas rotas destrutivas", async () => {
    const cookie = await loginCookie();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await post(cookie, "reset", { currentPassword: "x", confirm: "errado", backup: "none" })).statusCode);
    expect(codes.slice(0, 10).every((c) => c !== 429)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});

async function pollJob(cookie: string, id: string): Promise<DatabaseJob> {
  for (let i = 0; i < 50; i++) {
    const job = (await app.inject({ method: "GET", url: `/api/projects/p1/database/jobs/${id}`, headers: { cookie } })).json() as DatabaseJob;
    if (job.status !== "running") return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("trabalho não terminou");
}

describe("ações com reautenticação", () => {
  it("esvaziar: 202, trabalho acompanhável e Auditoria com ator e tabelas (sem SQL)", async () => {
    const { cookie, creds } = await ready();
    const res = await post(cookie, "truncate", base({ ...creds(), tables: [{ name: "users" }], cascade: true }));
    expect(res.statusCode, res.body).toBe(202);
    const job = await pollJob(cookie, res.json().job.id);
    expect(job).toMatchObject({ status: "success", kind: "truncate" });
    expect(stdins.at(-1)).toContain('TRUNCATE TABLE "public"."users" RESTART IDENTITY CASCADE;');
    const entries = (await ctx.auditService.list()).entries.filter((e) => e.action.startsWith("database."));
    expect(entries.map((e) => e.action)).toEqual(expect.arrayContaining(["database.truncate", "database.truncate_done"]));
    const start = entries.find((e) => e.action === "database.truncate")!;
    expect(start.actor).toBe("admin");
    expect(start.detail).toContain("users");
    expect(JSON.stringify(entries)).not.toContain("TRUNCATE TABLE");
  });

  it("tabela inexistente: 400 antes da senha, sem gastar o código", async () => {
    const { cookie, creds } = await ready();
    const c = creds();
    const bad = await post(cookie, "truncate", base({ ...c, tables: [{ name: "nada" }] }));
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("unknown_table");
    const good = await post(cookie, "truncate", base({ ...c, tables: [{ name: "users" }] }));
    expect(good.statusCode, good.body).toBe(202);
  });

  it("zerar o banco", async () => {
    const { cookie, creds } = await ready();
    const res = await post(cookie, "reset", base(creds()));
    expect(res.statusCode).toBe(202);
    expect((await pollJob(cookie, res.json().job.id)).status).toBe("success");
    expect(stdins.at(-1)).toContain("DO $tws_reset$");
  });

  it("SQL de escrita pede a mesma reautenticação e recusa mais de uma instrução antes da senha", async () => {
    const { cookie, creds } = await ready();
    const multi = await post(cookie, "sql/write", base({ ...creds(), sql: "update users set a = 1; drop table users" }));
    expect(multi.statusCode).toBe(400);
    expect(multi.json().error).toBe("sql_multiple");
    const res = await post(cookie, "sql/write", base({ ...creds(), sql: "update users set a = 1" }));
    expect(res.statusCode, res.body).toBe(202);
    expect((await pollJob(cookie, res.json().job.id)).status).toBe("success");
    expect(stdins.at(-1)).toContain("update users set a = 1");
    expect(stdins.at(-1)).not.toContain("READ ONLY");
  });

  it("comando do framework: só ids da lista; sem framework reconhecido, 400", async () => {
    const { cookie, creds } = await ready();
    expect((await post(cookie, "command", base({ ...creds(), command: "rm -rf /" }))).statusCode).toBe(400);
    const none = await post(cookie, "command", base({ ...creds(), command: "laravel-migrate" }));
    expect(none.statusCode).toBe(400);
    expect(none.json().error).toBe("command_not_available");
    framework = "laravel";
    const res = await post(cookie, "command", base({ ...creds(), command: "laravel-migrate" }));
    expect(res.statusCode, res.body).toBe(202);
    const job = await pollJob(cookie, res.json().job.id);
    expect(job).toMatchObject({ status: "success", output: "migrated" });
    expect(argvs.at(-1)).toEqual(["php", "artisan", "migrate", "--force", "--no-interaction", "--no-ansi"]);
  });

  it("backup completo antes: o trabalho registra o arquivo", async () => {
    const { cookie, creds } = await ready();
    const res = await post(cookie, "reset", base({ ...creds(), backup: "full" }));
    const job = await pollJob(cookie, res.json().job.id);
    expect(job).toMatchObject({ status: "success", backupFileName: "b.7z" });
  });

  it("duas ações ao mesmo tempo no mesmo projeto: a segunda recebe 409", async () => {
    let release: () => void = () => undefined;
    (app.databaseService as unknown as { opts: { exec: { sh: unknown } } }).opts.exec.sh = async () => new Promise<DbExecResult>((r) => (release = () => r(ok())));
    const { cookie, creds } = await ready();
    const first = await post(cookie, "reset", base(creds()));
    expect(first.statusCode).toBe(202);
    const second = await post(cookie, "reset", base(creds()));
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("database_busy");
    release();
  });

  it("erro inesperado vira 500 genérico, sem detalhe", async () => {
    (app.databaseService as unknown as { overview: unknown }).overview = async () => {
      throw new Error("segredo interno");
    };
    const cookie = await loginCookie();
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/database", headers: { cookie } });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("segredo interno");
  });
});
