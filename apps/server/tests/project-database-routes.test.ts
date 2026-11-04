/**
 * project-database-routes.test.ts — aba Banco: leitura com a sessão; LIBERAR a edição (senha + 2FA obrigatório, igual
 * ao terminal) e, liberada, as ações sem pedir tudo de novo (nome do projeto só onde apaga tudo); prazo, renovação com o
 * uso, bloquear agora, sessão que sai, uma liberação por sessão e por projeto, token de API recusado, a configuração e a
 * Auditoria. O banco é um dublê: aqui se confere o que a rota deixa passar.
 */
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { SETUP_TOKEN_HEADER, type DatabaseJob, type DatabaseUnlockStatus, type Project } from "@paas/core";
import databaseRoutes from "../src/routes/project-database.js";
import authRoutes from "../src/routes/auth.js";
import setupRoutes from "../src/routes/setup.js";
import { DatabaseService } from "../src/services/database-service.js";
import { DatabaseSettingsStore } from "../src/services/database-settings.js";
import { DatabaseUnlock } from "../src/services/database-unlock.js";
import type { DbExecResult } from "../src/services/database-docker.js";
import { TOTP_STEP_SECONDS, totpCode } from "../src/services/totp.js";
import { buildAuthTestApp, closeAuthTestApp, sessionCookieOf, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const PASSWORD = "MinhaSenha123";
const ok = (stdout = ""): DbExecResult => ({ code: 0, stdout, stderr: "", truncated: false, timedOut: false });
const OVERVIEW = JSON.stringify({ version: "16.2", database: "appdb", sizeBytes: 1000, tables: [{ schema: "public", name: "users", rows: 3, sizeBytes: 8192 }] });
const MIN = 60_000;

let ctx: AuthTestContext;
let app: FastifyInstance;
let nowMs: number;
/** Relógio monotônico da liberação (a produção usa performance.now). */
let mono: number;
let stdins: string[];
let argvs: string[][];
let projectOverride: Partial<Project>;
let framework: "laravel" | null;
let backupStatus: "success" | "failed";
let settings: DatabaseSettingsStore;

async function build() {
  ctx = await buildAuthTestApp(TOKEN, { now: () => nowMs });
  app = ctx.app;
  await app.register(rateLimit, { global: false });
  // Segunda trava: um cabeçalho de teste transforma a sessão em "sessão de token", como o plugin de auth faz
  app.addHook("onRequest", async (request) => {
    if (request.headers["x-fake-token"] && request.session) request.session = { ...request.session, token: {} as never };
  });
  const project = () => ({ id: "p1", name: "Loja", slug: "loja", proxyService: null, ...projectOverride }) as Project;
  app.decorate(
    "databaseService",
    new DatabaseService({
      projects: { get: async (id) => (id === "p1" || id === "loja" ? project() : null), srcDir: () => "/srv/src", secrets: async () => [] },
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
          if (o.stdin?.includes("BEGIN READ ONLY")) {
            const mark = /echo '([0-9a-f]+) S 1'/.exec(o.stdin)![1];
            return ok(`${mark} S 1\nn\n1\n${mark} E 1 \n`);
          }
          return ok();
        },
        argv: async (_c, argv) => {
          argvs.push([...argv]);
          return ok("migrated");
        },
      },
      backups: {
        detection: async () => ({ detectedAt: "", databases: [{ id: "db:db", service: "db", engine: "postgres", image: "postgres", databaseName: "appdb", user: "app", defaultSelected: true, method: "" }], mounts: [], unsavedWrites: [], sourceFolder: null, error: null }),
        run: async () => ({ id: "r1", status: backupStatus, fileName: backupStatus === "success" ? "b.7z" : null, warnings: [], error: "disco cheio" }) as never,
        record: async () => ({ id: "r1", status: backupStatus, fileName: backupStatus === "success" ? "b.7z" : null, warnings: [], error: "disco cheio" }) as never,
        busy: () => false,
        restoreCheck: async () => null,
      },
      detectFramework: async () => framework,
      audit: ctx.auditService,
      sleep: async () => undefined,
    }),
  );
  settings = new DatabaseSettingsStore(ctx.dir);
  await settings.load();
  app.decorate("databaseSettings", settings);
  const unlock = new DatabaseUnlock({
    settings,
    now: () => mono,
    isSessionActive: (id) => ctx.sessionStore.isActive(id),
    audit: (input) => void ctx.auditService.record(input),
  });
  unlock.watch(ctx.sessionStore);
  app.decorate("databaseUnlock", unlock);
  app.addHook("onClose", async () => unlock.dispose());
  await app.register(authRoutes);
  await app.register(databaseRoutes);
  await app.register(setupRoutes);
  const res = await app.inject({ method: "POST", url: "/api/setup/admin", headers: { [SETUP_TOKEN_HEADER]: TOKEN }, payload: { username: "admin", password: PASSWORD } });
  expect(res.statusCode).toBe(201);
}

beforeEach(async () => {
  nowMs = Date.UTC(2026, 9, 30, 12, 0, 0);
  mono = 1_000_000;
  stdins = [];
  argvs = [];
  projectOverride = {};
  framework = null;
  backupStatus = "success";
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

async function ready(existing?: string) {
  const cookie = existing ?? (await loginCookie());
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

const post = (cookie: string | undefined, path: string, payload: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: `/api/projects/p1/database/${path}`, headers: { ...(cookie ? { cookie } : {}), ...headers }, payload });
const status = async (cookie: string, id = "p1") =>
  (await app.inject({ method: "GET", url: `/api/projects/${id}/database/unlock`, headers: { cookie } })).json() as DatabaseUnlockStatus;

/** O texto do usuário vai ao psql em hexadecimal (\\gexec); aqui ele volta a texto para conferir o que será executado. */
const plain = (s: string): string => s
  .replace(/SELECT convert_from\(decode\('([0-9a-f]*)', 'hex'\), 'UTF8'\) \\gexec/g, (_m, h: string) => `${Buffer.from(h, "hex").toString("utf8")}\n;`)
  .replace(/DO \$tws\$ DECLARE c refcursor := 'tws_c'; BEGIN OPEN c FOR EXECUTE convert_from\(decode\('([0-9a-f]*)', 'hex'\), 'UTF8'\); END \$tws\$;\nFETCH ALL FROM tws_c;\nCLOSE tws_c;/g, (_m, h: string) => `${Buffer.from(h, "hex").toString("utf8")}\n;`);
const wrote = () => stdins.some((s) => /TRUNCATE|DO \$tws_reset|update users/.test(plain(s)));

async function pollJob(cookie: string, id: string): Promise<DatabaseJob> {
  for (let i = 0; i < 50; i++) {
    const job = (await app.inject({ method: "GET", url: `/api/projects/p1/database/jobs/${id}`, headers: { cookie } })).json() as DatabaseJob;
    if (job.status !== "running") return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("trabalho não terminou");
}


/** Sessão com 2FA ligado e a edição liberada (sem backup, a menos que se peça). */
async function unlocked(backup: "none" | "full" = "none") {
  const r = await ready();
  const res = await post(r.cookie, "unlock", { ...r.creds(), backup });
  expect(res.statusCode, res.body).toBe(202);
  const job = await pollJob(r.cookie, res.json().job.id);
  return { ...r, job, res };
}

const entries = async () => {
  await ctx.auditService.flush();
  return (await ctx.auditService.list()).entries;
};
const auditActions = async () => (await entries()).map((e) => e.action);
/** Segunda sessão do mesmo usuário (o login normal pediria o código do 2FA). */
async function secondSession(): Promise<string> {
  const user = await ctx.userStore.findByUsername("admin");
  const { cookieValue } = await ctx.sessionStore.create({ id: user!.id, username: "admin" });
  return `paas_session=${cookieValue}`;
}

describe("leitura (sessão normal)", () => {
  it("visão geral e consulta de leitura funcionam só com a sessão, sem senha nem 2FA nem liberação", async () => {
    const cookie = await loginCookie();
    const overview = await app.inject({ method: "GET", url: "/api/projects/p1/database", headers: { cookie } });
    expect(overview.statusCode).toBe(200);
    expect(overview.headers["cache-control"]).toBe("no-store");
    expect(overview.json()).toMatchObject({ state: "ok", engine: "postgres", tables: [{ name: "users", rows: 3 }] });
    const read = await post(cookie, "sql/read", { sql: "select n from t" });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ total: 1, statements: [{ index: 1, result: { columns: ["n"], rows: [["1"]] } }] });
    expect(stdins.at(-1)).toContain("BEGIN READ ONLY");
  });

  it("escrita na rota de leitura: 400 write_query, e nada chega ao banco", async () => {
    const cookie = await loginCookie();
    const res = await post(cookie, "sql/read", { sql: "select 1; delete from users" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "write_query", statement: 2 });
    expect(stdins).toHaveLength(0);
  });

  it("projeto inexistente: 404; trabalho que não existe: 404", async () => {
    const cookie = await loginCookie();
    expect((await app.inject({ method: "GET", url: "/api/projects/zzz/database", headers: { cookie } })).statusCode).toBe(404);
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/database/jobs/nada", headers: { cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("job_not_found");
  });
});

describe("sem sessão e token de API", () => {
  it("toda rota responde 401, inclusive só com o setup token", async () => {
    for (const [method, url] of [
      ["GET", "/api/projects/p1/database"],
      ["GET", "/api/projects/p1/database/jobs/x"],
      ["GET", "/api/projects/p1/database/unlock"],
      ["POST", "/api/projects/p1/database/unlock"],
      ["POST", "/api/projects/p1/database/lock"],
      ["POST", "/api/projects/p1/database/sql/read"],
      ["POST", "/api/projects/p1/database/truncate"],
      ["POST", "/api/projects/p1/database/reset"],
      ["POST", "/api/projects/p1/database/sql/write"],
      ["POST", "/api/projects/p1/database/command"],
      ["GET", "/api/settings/database"],
      ["PUT", "/api/settings/database"],
    ] as const) {
      const res = await app.inject({ method, url, headers: { [SETUP_TOKEN_HEADER]: TOKEN }, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    expect(stdins).toHaveLength(0);
  });

  it("sessão de token: 403 em todas, e nunca usa nem cria liberação", async () => {
    const { cookie } = await unlocked();
    const h = { "x-fake-token": "1" };
    for (const path of ["unlock", "lock", "sql/write", "reset", "truncate", "command", "sql/read"]) {
      const res = await post(cookie, path, {}, h);
      expect(res.statusCode, path).toBe(403);
      expect(res.json().error).toBe("token_forbidden");
    }
    expect((await app.inject({ method: "GET", url: "/api/projects/p1/database/unlock", headers: { cookie, ...h } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/settings/database", headers: { cookie, ...h } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: "/api/settings/database", headers: { cookie, ...h }, payload: { renewOnUse: false } })).statusCode).toBe(403);
    // a liberação da sessão de cookie segue intacta e nada foi alterado
    expect((await status(cookie)).unlocked).toBe(true);
    expect(wrote()).toBe(false);
  });
});

describe("liberar a edição: reautenticação uma vez", () => {
  it("exige 2FA ligado (409), a senha certa (401) e o código do app (400); segue bloqueado", async () => {
    const cookie = await loginCookie();
    let res = await post(cookie, "unlock", { currentPassword: PASSWORD, backup: "none" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("two_factor_required");
    const { cookie: c2, creds } = await ready();
    res = await post(c2, "unlock", { ...creds(), currentPassword: "errada", backup: "none" });
    expect(res.statusCode).toBe(401);
    res = await post(c2, "unlock", { currentPassword: PASSWORD, backup: "none" });
    expect(res.statusCode).toBe(400);
    expect((await status(c2)).unlocked).toBe(false);
  });

  it("projeto inexistente é recusado ANTES de gastar o código; corpo inválido é 400", async () => {
    const { cookie, creds } = await ready();
    const res = await app.inject({ method: "POST", url: "/api/projects/zzz/database/unlock", headers: { cookie }, payload: { ...creds(), backup: "none" } });
    expect(res.statusCode).toBe(404);
    expect((await post(cookie, "unlock", { ...creds() })).statusCode).toBe(400);
    expect((await post(cookie, "unlock", { ...creds(), backup: "parcial" })).statusCode).toBe(400);
    expect((await post(cookie, "unlock", { ...creds(), backup: "none", extra: 1 })).statusCode).toBe(400);
  });

  it("libera: o trabalho conclui, o estado mostra o prazo da configuração e a Auditoria registra", async () => {
    const { cookie, job } = await unlocked();
    expect(job).toMatchObject({ status: "success", kind: "unlock", steps: [{ id: "backup", status: "skipped" }, { id: "action", status: "done" }] });
    const st = await status(cookie);
    expect(st).toMatchObject({ unlocked: true, remainingMs: 30 * MIN, duration: "30m", renewOnUse: true, lastEnd: null });
    expect(st.expiresAt).toMatch(/^\d{4}-/);
    const all = await entries();
    const granted = all.find((e) => e.action === "database.unlock_granted")!;
    expect(granted.actor).toBe("admin");
    expect(granted.detail).toContain("30 min");
    expect(granted.detail).toContain("Loja");
    expect(await auditActions()).toEqual(expect.arrayContaining(["database.unlock", "database.unlock_done"]));
  });

  it("com backup completo antes: o trabalho registra o arquivo e só então libera", async () => {
    const { cookie, job } = await unlocked("full");
    expect(job).toMatchObject({ status: "success", backupFileName: "b.7z" });
    expect((await status(cookie)).unlocked).toBe(true);
  });

  it("Bloquear agora durante o backup cancela a liberação: o trabalho falha e nada é liberado", async () => {
    const { cookie, creds } = await ready();
    let release: () => void = () => undefined;
    const backups = (app.databaseService as unknown as { opts: { backups: { run: unknown } } }).opts.backups;
    backups.run = async () => new Promise((r) => (release = () => r({ id: "r1", status: "success", fileName: "b.7z", warnings: [], error: null })));
    const res = await post(cookie, "unlock", { ...creds(), backup: "full" });
    expect(res.statusCode, res.body).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    expect((await post(cookie, "lock", {})).statusCode).toBe(200);
    release();
    const job = await pollJob(cookie, res.json().job.id);
    expect(job).toMatchObject({ status: "failed", error: { code: "unlock_cancelled" } });
    expect((await status(cookie)).unlocked).toBe(false);
    expect(await auditActions()).not.toContain("database.unlock_granted");
  });

  it("backup que falha aborta: a edição NÃO é liberada", async () => {
    backupStatus = "failed";
    const { cookie, job } = await unlocked("full");
    expect(job).toMatchObject({ status: "failed", error: { code: "backup_failed" } });
    expect((await status(cookie)).unlocked).toBe(false);
    expect(await auditActions()).not.toContain("database.unlock_granted");
  });
});

describe("projeto por id ou por apelido (slug)", () => {
  const postTo = (cookie: string, ref: string, path: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/api/projects/${ref}/database/${path}`, headers: { cookie }, payload });

  it("liberou pelo id: escrever e consultar o estado pelo slug vale", async () => {
    const { cookie } = await unlocked();
    expect((await status(cookie, "loja")).unlocked).toBe(true);
    const res = await postTo(cookie, "loja", "sql/write", { sql: "update users set a = 1" });
    expect(res.statusCode, res.body).toBe(202);
    await pollJob(cookie, res.json().job.id);
    expect(wrote()).toBe(true);
  });

  it("liberou pelo slug: vale para o id; bloquear pelo slug bloqueia para os dois", async () => {
    const r = await ready();
    const un = await postTo(r.cookie, "loja", "unlock", { ...r.creds(), backup: "none" });
    expect(un.statusCode, un.body).toBe(202);
    await pollJob(r.cookie, un.json().job.id);
    expect((await status(r.cookie, "p1")).unlocked).toBe(true);
    expect((await postTo(r.cookie, "loja", "lock", {})).json()).toMatchObject({ unlocked: false });
    expect((await status(r.cookie, "p1")).unlocked).toBe(false);
    const res = await postTo(r.cookie, "p1", "sql/write", { sql: "update users set a = 1" });
    expect(res.statusCode).toBe(403);
  });

  it("projeto que não existe: estado e bloqueio respondem como bloqueado, sem derrubar", async () => {
    const cookie = await loginCookie();
    expect((await status(cookie, "zzz")).unlocked).toBe(false);
    expect((await postTo(cookie, "zzz", "lock", {})).statusCode).toBe(200);
  });
});

describe("ações exigem a edição liberada", () => {
  it("bloqueado: 403 unlock_required em todas, e nada chega ao banco", async () => {
    const { cookie } = await ready();
    const bodies: Array<[string, Record<string, unknown>]> = [
      ["sql/write", { sql: "update users set a = 1" }],
      ["truncate", { tables: [{ name: "users" }], backup: "none" }],
      ["reset", { confirm: "Loja", backup: "none" }],
      ["command", { command: "laravel-migrate" }],
    ];
    for (const [path, payload] of bodies) {
      const res = await post(cookie, path, payload);
      expect(res.statusCode, path).toBe(403);
      expect(res.json().error).toBe("unlock_required");
    }
    expect(wrote()).toBe(false);
  });

  it("campos de senha não existem mais nas ações (400); corpo inválido", async () => {
    const { cookie } = await unlocked();
    expect((await post(cookie, "reset", { confirm: "Loja", backup: "none", currentPassword: PASSWORD })).statusCode).toBe(400);
    expect((await post(cookie, "reset", { confirm: "Loja", backup: "parcial" })).statusCode).toBe(400);
    expect(wrote()).toBe(false);
  });

  it("SQL de escrita roda SEM mais nenhum pedido, com várias instruções e transação por padrão", async () => {
    const { cookie } = await unlocked();
    const res = await post(cookie, "sql/write", { sql: "update users set a = 1; update users set b = 2" });
    expect(res.statusCode, res.body).toBe(202);
    expect((await pollJob(cookie, res.json().job.id)).status).toBe("success");
    expect(stdins.at(-1)).toContain("BEGIN;");
    expect(plain(stdins.at(-1)!)).toContain("update users set b = 2");
    expect(stdins.at(-1)).not.toContain("READ ONLY");
    // sem transação, a pedido
    const res2 = await post(cookie, "sql/write", { sql: "update users set a = 1", transaction: false });
    await pollJob(cookie, res2.json().job.id);
    expect(stdins.at(-1)).not.toContain("BEGIN;");
    // instrução recusada: 400 dizendo qual, antes de qualquer coisa
    const bad = await post(cookie, "sql/write", { sql: "update users set a = 1; \\! ls" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "sql_client_command", statement: 2 });
  });

  it("esvaziar: simples (sem nome), 202, Auditoria com ator e tabelas e sem SQL", async () => {
    const { cookie } = await unlocked();
    const res = await post(cookie, "truncate", { tables: [{ name: "users" }], cascade: true, backup: "none" });
    expect(res.statusCode, res.body).toBe(202);
    expect((await pollJob(cookie, res.json().job.id)).status).toBe("success");
    expect(stdins.at(-1)).toContain('TRUNCATE TABLE "public"."users" RESTART IDENTITY CASCADE;');
    const trunc = (await entries()).filter((e) => e.action.startsWith("database.truncate"));
    expect(trunc.map((e) => e.action)).toEqual(expect.arrayContaining(["database.truncate", "database.truncate_done"]));
    expect(trunc.find((e) => e.action === "database.truncate")!.actor).toBe("admin");
    expect(JSON.stringify(trunc)).not.toContain("TRUNCATE TABLE");
    const bad = await post(cookie, "truncate", { tables: [{ name: "nada" }], backup: "none" });
    expect(bad.json().error).toBe("unknown_table");
  });

  it("zerar o banco pede o nome do projeto digitado (e só ele)", async () => {
    const { cookie } = await unlocked();
    const none = await post(cookie, "reset", { backup: "none" });
    expect(none.statusCode).toBe(400);
    expect(none.json().error).toBe("confirm_mismatch");
    expect((await post(cookie, "reset", { confirm: "loja", backup: "none" })).json().error).toBe("confirm_mismatch");
    expect(wrote()).toBe(false);
    const res = await post(cookie, "reset", { confirm: "Loja", backup: "full" });
    expect(res.statusCode, res.body).toBe(202);
    const job = await pollJob(cookie, res.json().job.id);
    expect(job).toMatchObject({ status: "success", backupFileName: "b.7z" });
    expect(stdins.at(-1)).toContain("DO $tws_reset$");
  });

  it("comando do framework: confirmação simples; migrate:fresh pede o nome do projeto", async () => {
    const { cookie } = await unlocked();
    expect((await post(cookie, "command", { command: "rm -rf /" })).statusCode).toBe(400);
    const none = await post(cookie, "command", { command: "laravel-migrate" });
    expect(none.json().error).toBe("command_not_available");
    framework = "laravel";
    const res = await post(cookie, "command", { command: "laravel-migrate" });
    expect(res.statusCode, res.body).toBe(202);
    expect(await pollJob(cookie, res.json().job.id)).toMatchObject({ status: "success", output: "migrated" });
    expect(argvs.at(-1)).toEqual(["php", "artisan", "migrate", "--force", "--no-interaction", "--no-ansi"]);
    const fresh = await post(cookie, "command", { command: "laravel-migrate-fresh-seed" });
    expect(fresh.statusCode).toBe(400);
    expect(fresh.json().error).toBe("confirm_mismatch");
    const argvCount = argvs.filter((a) => a[0] === "php").length;
    const fresh2 = await post(cookie, "command", { command: "laravel-migrate-fresh-seed", confirm: "Loja" });
    expect(fresh2.statusCode, fresh2.body).toBe(202);
    await pollJob(cookie, fresh2.json().job.id);
    expect(argvs.filter((a) => a[0] === "php")).toHaveLength(argvCount + 1);
  });

  it("duas ações ao mesmo tempo no mesmo projeto: a segunda recebe 409", async () => {
    let release: () => void = () => undefined;
    const { cookie } = await unlocked();
    (app.databaseService as unknown as { opts: { exec: { sh: unknown } } }).opts.exec.sh = async () => new Promise<DbExecResult>((r) => (release = () => r(ok())));
    const first = await post(cookie, "reset", { confirm: "Loja", backup: "none" });
    expect(first.statusCode).toBe(202);
    const second = await post(cookie, "reset", { confirm: "Loja", backup: "none" });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("database_busy");
    release();
  });

  it("409 (já há uma ação rodando) NÃO renova a liberação", async () => {
    const { cookie } = await unlocked();
    (app.databaseService as unknown as { opts: { exec: { sh: unknown } } }).opts.exec.sh = async () => new Promise<DbExecResult>(() => undefined);
    expect((await post(cookie, "reset", { confirm: "Loja", backup: "none" })).statusCode).toBe(202);
    mono += 10 * MIN;
    expect((await post(cookie, "reset", { confirm: "Loja", backup: "none" })).statusCode).toBe(409);
    expect((await status(cookie)).remainingMs).toBe(20 * MIN);
  });

  it("limite de 10 pedidos por minuto nas rotas destrutivas", async () => {
    const cookie = await loginCookie();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await post(cookie, "reset", { confirm: "errado", backup: "none" })).statusCode);
    expect(codes.slice(0, 10).every((c) => c !== 429)).toBe(true);
    expect(codes[10]).toBe(429);
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

describe("ciclo de vida da liberação", () => {
  it("expira no prazo: volta a bloquear, a ação passa a ser 403 e a Auditoria registra o fim", async () => {
    const { cookie } = await unlocked();
    mono += 29 * MIN;
    expect(await status(cookie)).toMatchObject({ unlocked: true, remainingMs: 1 * MIN });
    mono += 2 * MIN;
    expect(await status(cookie)).toMatchObject({ unlocked: false, remainingMs: null, lastEnd: "expired" });
    const res = await post(cookie, "sql/write", { sql: "update users set a = 1" });
    expect(res.statusCode).toBe(403);
    const ended = (await entries()).find((e) => e.action === "database.unlock_ended")!;
    expect(ended.detail).toContain("o prazo acabou");
  });

  it("renovar com o uso: cada comando aceito estende até o prazo cheio", async () => {
    const { cookie } = await unlocked();
    mono += 20 * MIN;
    const res = await post(cookie, "sql/write", { sql: "update users set a = 1" });
    await pollJob(cookie, res.json().job.id);
    expect((await status(cookie)).remainingMs).toBe(30 * MIN);
    mono += 25 * MIN;
    expect((await status(cookie)).unlocked).toBe(true);
  });

  it("um pedido recusado (tabela inexistente) NÃO renova", async () => {
    const { cookie } = await unlocked();
    mono += 20 * MIN;
    await post(cookie, "truncate", { tables: [{ name: "nada" }], backup: "none" });
    expect((await status(cookie)).remainingMs).toBe(10 * MIN);
  });

  it("sem renovar com o uso: o prazo corre do início", async () => {
    await settings.set({ unlockDuration: "30m", renewOnUse: false });
    const { cookie } = await unlocked();
    mono += 20 * MIN;
    const res = await post(cookie, "sql/write", { sql: "update users set a = 1" });
    await pollJob(cookie, res.json().job.id);
    expect((await status(cookie)).remainingMs).toBe(10 * MIN);
    mono += 11 * MIN;
    expect((await status(cookie)).unlocked).toBe(false);
  });

  it("'até a sessão acabar': sem prazo na tela", async () => {
    await settings.set({ unlockDuration: "session", renewOnUse: true });
    const { cookie } = await unlocked();
    mono += 10 * 60 * MIN;
    expect(await status(cookie)).toMatchObject({ unlocked: true, remainingMs: null, expiresAt: null, duration: "session" });
  });

  it("Bloquear agora: volta a bloquear na hora e a ação passa a ser 403", async () => {
    const { cookie } = await unlocked();
    const res = await post(cookie, "lock");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toMatchObject({ unlocked: false, lastEnd: "manual" });
    expect((await post(cookie, "sql/write", { sql: "update users set a = 1" })).statusCode).toBe(403);
    // bloquear de novo é inofensivo
    expect((await post(cookie, "lock")).json().unlocked).toBe(false);
    const ended = (await entries()).find((e) => e.action === "database.unlock_ended")!;
    expect(ended.detail).toContain("bloqueada pelo botão");
  });

  it("sair do painel encerra: outra sessão não herda e a antiga não volta a valer", async () => {
    const { cookie } = await unlocked();
    const second = await secondSession();
    expect((await status(second)).unlocked).toBe(false);
    const oldId = cookie.split("=")[1]!.split(".")[0]!;
    expect(app.databaseUnlock.isUnlocked(oldId, "p1")).toBe(true);
    const out = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect(out.statusCode).toBe(200);
    expect(app.databaseUnlock.isUnlocked(oldId, "p1")).toBe(false);
    expect(app.databaseUnlock.status(oldId, "p1").lastEnd).toBe("session");
    expect((await entries()).some((e) => e.action === "database.unlock_ended" && e.detail.includes("a sessão terminou"))).toBe(true);
  });

  it("é por sessão e por projeto: outra sessão e outro projeto continuam bloqueados", async () => {
    const { cookie } = await unlocked();
    const other = await secondSession();
    expect((await status(other)).unlocked).toBe(false);
    expect((await post(other, "sql/write", { sql: "update users set a = 1" })).statusCode).toBe(403);
    expect((await status(cookie, "p2")).unlocked).toBe(false);
    const res = await app.inject({ method: "POST", url: "/api/projects/p2/database/sql/write", headers: { cookie }, payload: { sql: "update users set a = 1" } });
    expect(res.statusCode).toBe(403);
  });
});

describe("Configurações → Banco de dados", () => {
  const put = (cookie: string, payload: Record<string, unknown>) => app.inject({ method: "PUT", url: "/api/settings/database", headers: { cookie }, payload });

  it("GET devolve o padrão (30 min, renova com o uso) e as opções", async () => {
    const cookie = await loginCookie();
    const res = await app.inject({ method: "GET", url: "/api/settings/database", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({
      settings: { unlockDuration: "30m", renewOnUse: true },
      defaults: { unlockDuration: "30m", renewOnUse: true },
      durations: ["15m", "30m", "1h", "2h", "4h", "session"],
    });
  });

  it("apertar (prazo menor, sem renovar) só pede a sessão, e fica gravado", async () => {
    const cookie = await loginCookie();
    const res = await put(cookie, { unlockDuration: "15m", renewOnUse: false });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().settings).toEqual({ unlockDuration: "15m", renewOnUse: false });
    expect(JSON.parse(await readFile(path.join(ctx.dir, "database-settings.json"), "utf8"))).toEqual({ unlockDuration: "15m", renewOnUse: false });
    const entry = (await entries()).find((e) => e.action === "database.settings_changed")!;
    expect(entry.actor).toBe("admin");
    expect(entry.detail).toContain("30 min → 15 min");
    // sem mudança: nada novo na Auditoria
    await put(cookie, { unlockDuration: "15m" });
    expect((await entries()).filter((e) => e.action === "database.settings_changed")).toHaveLength(1);
  });

  it("afrouxar (prazo maior ou renovar com o uso) pede senha + código; sem eles nada muda", async () => {
    const { cookie, creds } = await ready();
    await put(cookie, { unlockDuration: "15m", renewOnUse: false });
    let res = await put(cookie, { unlockDuration: "4h" });
    expect(res.statusCode).toBe(401);
    res = await put(cookie, { renewOnUse: true });
    expect(res.statusCode).toBe(401);
    res = await put(cookie, { renewOnUse: true, currentPassword: PASSWORD });
    expect(res.statusCode).toBe(400);
    expect(settings.current()).toEqual({ unlockDuration: "15m", renewOnUse: false });
    res = await put(cookie, { unlockDuration: "session", renewOnUse: true, ...creds() });
    expect(res.statusCode, res.body).toBe(200);
    expect(settings.current()).toEqual({ unlockDuration: "session", renewOnUse: true });
  });

  it("valor fora da lista: 400; falha de disco: 500 sem mudar nada", async () => {
    const cookie = await loginCookie();
    expect((await put(cookie, { unlockDuration: "10h" })).statusCode).toBe(400);
    expect((await put(cookie, { renewOnUse: "sim" })).statusCode).toBe(400);
    const orig = settings.set.bind(settings);
    settings.set = async () => {
      throw new Error("disco");
    };
    const res = await put(cookie, { unlockDuration: "15m" });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("storage_write_failed");
    settings.set = orig;
    expect(settings.current().unlockDuration).toBe("30m");
  });

  it("encurtar a duração corta a liberação em curso", async () => {
    const { cookie } = await unlocked();
    expect((await status(cookie)).remainingMs).toBe(30 * MIN);
    await put(cookie, { unlockDuration: "15m" });
    expect((await status(cookie)).remainingMs).toBe(15 * MIN);
  });
});
