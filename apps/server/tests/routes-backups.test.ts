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
  verify: vi.fn(async () => ({ id: "r3", operation: "verify" })),
  updateDefaults: vi.fn(async () => undefined),
  applyDefaults: vi.fn(async () => ({ applied: [{ id: "p1", name: "Loja" }], missing: [] })),
  useDefaults: vi.fn(async () => undefined),
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

  it("só com o setup token (setup pendente, sem sessão): 401 em todas, nunca 500", async () => {
    const fresh = await buildAuthTestApp(SETUP);
    fresh.app.decorate("backupService", service as unknown as FastifyInstance["backupService"]);
    await fresh.app.register(backupsRoutes);
    const token = { [SETUP_TOKEN_HEADER]: SETUP };
    const routes: Array<["GET" | "PUT" | "POST" | "DELETE", string, unknown?]> = [
      ["GET", "/api/backups"],
      ["PUT", "/api/backups/destination", DEST],
      ["POST", "/api/backups/destination/test"],
      ["DELETE", "/api/backups/destination"],
      ["PUT", "/api/backups/defaults", { frequencyHours: 6 }],
      ["POST", "/api/backups/defaults/apply", { projectIds: ["p1"] }],
      ["POST", "/api/backups/password/reveal", { loginPassword: "x" }],
      ["PUT", "/api/backups/targets/panel", { frequencyHours: 6 }],
      ["POST", "/api/backups/targets/project:p1/use-defaults"],
      ["POST", "/api/backups/targets/panel/run"],
      ["POST", "/api/backups/verify", {}],
      ["GET", "/api/backups/projects/p1"],
      ["GET", "/api/backups/catalog"],
    ];
    for (const [method, url, payload] of routes) {
      const res = await fresh.app.inject({ method, url, headers: token, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.json()).toMatchObject({ error: "unauthorized" });
    }
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    await closeAuthTestApp(fresh);
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

  it("padrão dos projetos, Aplicar também e Voltar ao padrão", async () => {
    const put = await call("PUT", "/api/backups/defaults", { enabled: true, frequencyHours: 6, localKeep: 8, remoteKeep: 30 });
    expect(put.statusCode).toBe(204);
    expect(service.updateDefaults).toHaveBeenCalledWith({ enabled: true, frequencyHours: 6, localKeep: 8, remoteKeep: 30 }, "admin");
    expect((await call("PUT", "/api/backups/defaults", { frequencyHours: 8 })).statusCode).toBe(400);
    expect((await call("PUT", "/api/backups/defaults", { choices: { "db:db": false } })).statusCode).toBe(400);
    expect((await call("PUT", "/api/backups/defaults", { localKeep: 0 })).statusCode).toBe(400);
    const apply = await call("POST", "/api/backups/defaults/apply", { projectIds: ["p1"] });
    expect(apply.json()).toEqual({ applied: [{ id: "p1", name: "Loja" }], missing: [] });
    expect(service.applyDefaults).toHaveBeenCalledWith(["p1"], "admin");
    expect((await call("POST", "/api/backups/defaults/apply", { projectIds: [] })).statusCode).toBe(400);
    expect((await call("POST", "/api/backups/defaults/apply", { projectIds: ["../x"] })).statusCode).toBe(400);
    expect((await call("POST", "/api/backups/targets/project:p1/use-defaults")).statusCode).toBe(204);
    expect(service.useDefaults).toHaveBeenCalledWith("project:p1", "admin");
  });

  it("aba do projeto, detectar de novo e catálogo", async () => {
    expect((await call("GET", "/api/backups/projects/p1")).json()).toEqual({ target: { id: "project:p1" } });
    await call("POST", "/api/backups/projects/p1/detect");
    expect(service.detectProject).toHaveBeenCalledWith("p1");
    expect((await call("GET", "/api/backups/catalog")).json()).toEqual({ panel: [], email: [], projects: [] });
  });

  it("Conferir um, todos do item e todos: corpo validado, sem cache", async () => {
    const one = await call("POST", "/api/backups/targets/project:p1/verify", { fileName: "2026-10-14_03-00.7z" });
    expect(one.json()).toEqual({ id: "r3", operation: "verify" });
    expect(one.headers["cache-control"]).toBe("no-store");
    expect(service.verify).toHaveBeenCalledWith("project:p1", { fileName: "2026-10-14_03-00.7z" }, "admin");
    await call("POST", "/api/backups/targets/panel/verify", {});
    expect(service.verify).toHaveBeenLastCalledWith("panel", {}, "admin");
    await call("POST", "/api/backups/targets/panel/verify");
    expect(service.verify).toHaveBeenLastCalledWith("panel", {}, "admin");
    await call("POST", "/api/backups/targets/email/verify", { fileName: "a.7z", where: "remote", password: "senha-antiga" });
    expect(service.verify).toHaveBeenLastCalledWith("email", { fileName: "a.7z", where: "remote", password: "senha-antiga" }, "admin");
    for (const body of [{ where: "ftp" }, { fileName: "" }, { password: "" }, { cmd: "x" }]) {
      expect((await call("POST", "/api/backups/targets/panel/verify", body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    const all = await call("POST", "/api/backups/verify", {});
    expect(all.statusCode).toBe(200);
    expect(service.verify).toHaveBeenLastCalledWith("all", {}, "admin");
    await call("POST", "/api/backups/verify");
    expect(service.verify).toHaveBeenLastCalledWith("all", {}, "admin");
    expect((await call("POST", "/api/backups/verify", { fileName: "a.7z" })).statusCode).toBe(400);
    service.verify.mockRejectedValueOnce(httpError(409, "no_destination", "Conecte um armazenamento externo."));
    expect((await call("POST", "/api/backups/verify", { where: "remote" })).json().error).toBe("no_destination");
  });

  it("erro inesperado: 500 genérico, sem detalhe interno", async () => {
    service.status.mockRejectedValueOnce(new Error("ENOENT /data/segredo"));
    const res = await call("GET", "/api/backups");
    expect(res.statusCode).toBe(500);
    expect(res.json().message).not.toContain("segredo");
  });
});
