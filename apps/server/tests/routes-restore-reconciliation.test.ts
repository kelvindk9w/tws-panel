/**
 * routes-restore-reconciliation.test.ts — API do aviso "o painel antigo tinha X
 * ativo; ativar agora?" (Dashboard e tela dos backups).
 *  GET  /api/restore-reconciliation              pendências, conferidas no Docker na hora
 *  POST /api/restore-reconciliation/:id/dismiss  "Dispensar"
 *
 * Arquivos e serviço de verdade; só o Docker é um dublê.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETUP_TOKEN_HEADER, type ReconciliationResponse } from "@paas/core";
import authRoutes from "../src/routes/auth.js";
import restoreReconciliationRoutes from "../src/routes/restore-reconciliation.js";
import setupRoutes from "../src/routes/setup.js";
import { RestoreReconciliation, type ContainerProbe } from "../src/services/restore-reconciliation.js";
import { buildAuthTestApp, closeAuthTestApp, sessionCookieOf, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const PASSWORD = "MinhaSenha123";
let ctx: AuthTestContext;
let app: FastifyInstance;
let cookie: string;
let webmail: ContainerProbe;

beforeEach(async () => {
  webmail = "missing";
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  app.decorate(
    "restoreReconciliation",
    new RestoreReconciliation({
      dataDir: ctx.dir,
      containers: { stalwart: "paas-stalwart", webmail: "paas-webmail" },
      probes: { container: async (n) => (n === "paas-webmail" ? webmail : "running") },
    }),
  );
  await app.register(authRoutes);
  await app.register(setupRoutes);
  await app.register(restoreReconciliationRoutes);
  await app.inject({ method: "POST", url: "/api/setup/admin", headers: { [SETUP_TOKEN_HEADER]: TOKEN }, payload: { username: "admin", password: PASSWORD } });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD } });
  cookie = sessionCookieOf(login);
  await mkdir(ctx.dir, { recursive: true });
  await writeFile(
    path.join(ctx.dir, "restore-reconciliation.json"),
    JSON.stringify({ items: [{ id: "webmail", state: "open", source: "panel", since: "2026-10-20T12:00:00.000Z", closedAt: null }] }),
  );
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

const get = () => app.inject({ method: "GET", url: "/api/restore-reconciliation", headers: { cookie } });
const dismiss = (id: string) => app.inject({ method: "POST", url: `/api/restore-reconciliation/${id}/dismiss`, headers: { cookie } });

describe("GET /api/restore-reconciliation", () => {
  it("sem sessão → 401 (nem com o setup token)", async () => {
    expect((await app.inject({ method: "GET", url: "/api/restore-reconciliation" })).statusCode).toBe(401);
    const comToken = await app.inject({ method: "GET", url: "/api/restore-reconciliation", headers: { [SETUP_TOKEN_HEADER]: TOKEN } });
    expect(comToken.statusCode).toBe(401);
  });

  it("lista a pendência com o estado do Docker, sem cache", async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect((res.json() as ReconciliationResponse).items).toMatchObject([{ id: "webmail", status: "pending" }]);
  });

  it("webmail passou a rodar: a pendência some sozinha", async () => {
    webmail = "running";
    expect((await get()).json()).toEqual({ items: [] });
  });
});

describe("POST /api/restore-reconciliation/:id/dismiss", () => {
  it("dispensa, audita e não pergunta de novo", async () => {
    const res = await dismiss("webmail");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [] });
    expect((await get()).json()).toEqual({ items: [] });
    await ctx.auditService.flush();
    expect(await readFile(path.join(ctx.dir, "audit.json"), "utf8")).toMatch(/restore\.reconciliation_dismissed/);
  });

  it("sem sessão → 401; id que não existe → 400; sem pendência aberta → 404", async () => {
    expect((await app.inject({ method: "POST", url: "/api/restore-reconciliation/webmail/dismiss" })).statusCode).toBe(401);
    expect((await dismiss("inventado")).statusCode).toBe(400);
    await dismiss("webmail");
    const again = await dismiss("webmail");
    expect(again.statusCode).toBe(404);
    expect(again.json()).toMatchObject({ error: "reconciliation_not_found" });
  });

  it("erro inesperado do serviço vira mensagem genérica (500)", async () => {
    app.restoreReconciliation.list = async () => Promise.reject(new Error("segredo interno"));
    const res = await get();
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toMatch(/segredo interno/);
  });
});
