/**
 * routes-backups.test.ts — API de Configurações → Backups e da aba Backups do
 * projeto: sessão obrigatória, validação dos corpos, quem pediu (actor),
 * Cache-Control: no-store onde a senha passa e o formato dos erros.
 * O serviço é um dublê (a regra está em backup-service.test.ts).
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import authRoutes from "../src/routes/auth.js";
import backupsRoutes from "../src/routes/backups.js";
import setupRoutes from "../src/routes/setup.js";
import { httpError } from "../src/services/http-error.js";
import { buildAuthTestApp, closeAuthTestApp, sessionCookieOf, type AuthTestContext } from "./test-utils.js";

const SETUP = "token-de-teste";
const PASSWORD = "MinhaSenha123";

let ctx: AuthTestContext;
let app: FastifyInstance;
let cookie: string;

const service = {
  status: vi.fn(async () => ({ ok: "status" })),
  setDestination: vi.fn(async () => ({ ok: "dest" })),
  testDestination: vi.fn(async () => ({ ok: "test" })),
  removeDestination: vi.fn(async () => ({ ok: "rm" })),
  setEncryption: vi.fn(async () => ({ ok: "enc" })),
  setPassword: vi.fn(async () => ({ ok: "pw" })),
  suggestPassword: vi.fn(() => "frase-sugerida-123"),
  revealPassword: vi.fn(async () => "a-senha-dos-backups"),
  testPassword: vi.fn(async () => ({ ok: true, message: "certa" })),
  updateTarget: vi.fn(async () => undefined),
  runNow: vi.fn(async () => ({ id: "r1" })),
  points: vi.fn(async () => [{ fileName: "2026-10-14_03-00.7z" }]),
  restore: vi.fn(async () => ({ id: "r2" })),
  record: vi.fn(async () => ({ id: "r1", status: "running" })),
  projectView: vi.fn(async () => ({ target: { id: "project:p1" } })),
  detectProject: vi.fn(async () => ({})),
  catalog: vi.fn(async () => ({ panel: [], email: [], projects: [] })),
};

beforeEach(async () => {
  for (const fn of Object.values(service)) fn.mockClear();
  ctx = await buildAuthTestApp(SETUP);
  app = ctx.app;
  app.decorate("backupService", service as unknown as FastifyInstance["backupService"]);
  await app.register(authRoutes);
  await app.register(setupRoutes);
  await app.register(backupsRoutes);
  await app.inject({
    method: "POST",
    url: "/api/setup/admin",
    headers: { [SETUP_TOKEN_HEADER]: SETUP },
    payload: { username: "admin", password: PASSWORD },
  });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD } });
  cookie = sessionCookieOf(login);
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

function call(method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: unknown) {
  return app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
}

const DEST = { provider: "r2", endpoint: "https://abc.r2.cloudflarestorage.com", region: "auto", bucket: "meus-backups", accessKeyId: "AKIA1234", secretAccessKey: "s" };

describe("rotas de backups", () => {
  it("sem sessão: 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/backups" });
    expect(res.statusCode).toBe(401);
  });

  it("situação, destino, teste e desconectar", async () => {
    expect((await call("GET", "/api/backups")).json()).toEqual({ ok: "status" });
    expect((await call("PUT", "/api/backups/destination", DEST)).statusCode).toBe(200);
    expect(service.setDestination).toHaveBeenCalledWith(DEST, "admin");
    expect((await call("PUT", "/api/backups/destination", { ...DEST, bucket: "Maiúsculo" })).statusCode).toBe(400);
    expect((await call("PUT", "/api/backups/destination", { ...DEST, extra: 1 })).statusCode).toBe(400);
    expect((await call("PUT", "/api/backups/destination", { ...DEST, provider: "drive" })).statusCode).toBe(400);
    expect((await call("POST", "/api/backups/destination/test")).json()).toEqual({ ok: "test" });
    expect((await call("DELETE", "/api/backups/destination")).json()).toEqual({ ok: "rm" });
  });

  it("criptografia e senha", async () => {
    await call("PUT", "/api/backups/encryption", { enabled: false });
    expect(service.setEncryption).toHaveBeenCalledWith(false, "admin");
    await call("PUT", "/api/backups/password", { password: "frase-bem-comprida", acknowledged: true });
    expect(service.setPassword).toHaveBeenCalledWith("frase-bem-comprida", true, "admin");
    expect((await call("PUT", "/api/backups/password", { password: "x" })).statusCode).toBe(400);
    const suggest = await call("GET", "/api/backups/password/suggest");
    expect(suggest.json()).toEqual({ password: "frase-sugerida-123" });
    expect(suggest.headers["cache-control"]).toBe("no-store");
  });

  it("ver a senha: confirma a senha de login, no-store", async () => {
    const res = await call("POST", "/api/backups/password/reveal", { loginPassword: PASSWORD });
    expect(res.json()).toEqual({ password: "a-senha-dos-backups" });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(service.revealPassword).toHaveBeenCalledWith(expect.any(String), PASSWORD, "admin");
    expect((await call("POST", "/api/backups/password/reveal", {})).statusCode).toBe(400);
    service.revealPassword.mockRejectedValueOnce(httpError(401, "invalid_login_password", "Senha de login incorreta."));
    const denied = await call("POST", "/api/backups/password/reveal", { loginPassword: "x" });
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toEqual({ error: "invalid_login_password", message: "Senha de login incorreta." });
    const t = await call("POST", "/api/backups/password/test", { password: "frase" });
    expect(t.json()).toEqual({ ok: true, message: "certa" });
  });

  it("itens: configurar, fazer agora, datas e restaurar", async () => {
    const put = await call("PUT", "/api/backups/targets/project:p1", { frequencyHours: 12, choices: { "db:db": false } });
    expect(put.statusCode).toBe(204);
    expect(service.updateTarget).toHaveBeenCalledWith("project:p1", { frequencyHours: 12, choices: { "db:db": false } }, "admin");
    expect((await call("PUT", "/api/backups/targets/project:p1", { frequencyHours: 8 })).statusCode).toBe(400);
    expect((await call("PUT", "/api/backups/targets/outra-coisa", {})).statusCode).toBe(400);
    expect((await call("POST", "/api/backups/targets/panel/run")).json()).toEqual({ id: "r1" });
    expect(service.runNow).toHaveBeenCalledWith("panel", "admin");
    expect((await call("GET", "/api/backups/targets/email/points")).json()).toEqual({ points: [{ fileName: "2026-10-14_03-00.7z" }] });
    const restore = await call("POST", "/api/backups/targets/project:p1/restore", { fileName: "2026-10-14_03-00.7z", source: "local", confirm: "Loja" });
    expect(restore.json()).toEqual({ id: "r2" });
    expect((await call("POST", "/api/backups/targets/project:p1/restore", { fileName: "x", source: "ftp", confirm: "" })).statusCode).toBe(400);
    expect((await call("GET", "/api/backups/records/r1")).json()).toEqual({ id: "r1", status: "running" });
  });

  it("aba do projeto, detectar de novo e catálogo", async () => {
    expect((await call("GET", "/api/backups/projects/p1")).json()).toEqual({ target: { id: "project:p1" } });
    await call("POST", "/api/backups/projects/p1/detect");
    expect(service.detectProject).toHaveBeenCalledWith("p1");
    expect((await call("GET", "/api/backups/catalog")).json()).toEqual({ panel: [], email: [], projects: [] });
  });

  it("erro inesperado: 500 genérico, sem detalhe interno", async () => {
    service.status.mockRejectedValueOnce(new Error("ENOENT /data/segredo"));
    const res = await call("GET", "/api/backups");
    expect(res.statusCode).toBe(500);
    expect(res.json().message).not.toContain("segredo");
  });
});
