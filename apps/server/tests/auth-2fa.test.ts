/**
 * auth-2fa.test.ts — verificação em duas etapas do login do painel.
 *
 * Com o acesso por HTTPS (padrão da instalação), o painel fica na internet e
 * só a senha o protegia. Aqui: ativar (QR + confirmação com código + senha
 * atual), entrar com código ou com código de recuperação (uso único),
 * reuso de código recusado, desativar, e o segredo cifrado em disco.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import authRoutes from "../src/routes/auth.js";
import setupRoutes from "../src/routes/setup.js";
import { TOTP_STEP_SECONDS, totpCode } from "../src/services/totp.js";
import { buildAuthTestApp, closeAuthTestApp, sessionCookieOf, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const PASSWORD = "MinhaSenha123";

let ctx: AuthTestContext;
let app: FastifyInstance;
/** Relógio controlado: cada código novo precisa de um passo novo (anti-reuso). */
let nowMs: number;

beforeEach(async () => {
  nowMs = Date.UTC(2026, 8, 30, 12, 0, 0);
  ctx = await buildAuthTestApp(TOKEN, { now: () => nowMs });
  app = ctx.app;
  await app.register(authRoutes);
  await app.register(setupRoutes);
  const res = await app.inject({
    method: "POST",
    url: "/api/setup/admin",
    headers: { [SETUP_TOKEN_HEADER]: TOKEN },
    payload: { username: "admin", password: PASSWORD },
  });
  expect(res.statusCode).toBe(201);
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

function codeNow(secret: string): string {
  return totpCode(secret, Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS));
}

function nextStep() {
  nowMs += TOTP_STEP_SECONDS * 1000;
}

async function login(payload: Record<string, string>) {
  return app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD, ...payload } });
}

async function sessionCookie(): Promise<string> {
  const res = await login({});
  expect(res.statusCode).toBe(200);
  return sessionCookieOf(res);
}

/** Ativa o 2FA e devolve o segredo + os códigos de recuperação. */
async function enable(cookie: string): Promise<{ secret: string; recoveryCodes: string[] }> {
  const setup = await app.inject({ method: "POST", url: "/api/auth/2fa/setup", headers: { cookie } });
  expect(setup.statusCode).toBe(200);
  const { secret } = setup.json() as { secret: string };
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/2fa/enable",
    headers: { cookie },
    payload: { currentPassword: PASSWORD, code: codeNow(secret) },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { secret, recoveryCodes: (res.json() as { recoveryCodes: string[] }).recoveryCodes };
}

describe("ativar a verificação em duas etapas", () => {
  it("setup devolve segredo e URI do QR com o nome do painel; nada muda até confirmar", async () => {
    const cookie = await sessionCookie();
    const res = await app.inject({ method: "POST", url: "/api/auth/2fa/setup", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { secret: string; otpauthUri: string };
    expect(body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(body.otpauthUri).toContain(`secret=${body.secret}`);
    expect(body.otpauthUri).toContain("issuer=TWS%20Panel");

    const status = await app.inject({ method: "GET", url: "/api/auth/2fa", headers: { cookie } });
    expect(status.json()).toEqual({ enabled: false, recoveryCodesLeft: 0 });
    expect((await login({})).statusCode).toBe(200); // login segue só com senha
  });

  it("confirmar com código certo + senha atual: ativa, devolve 10 códigos de recuperação e audita", async () => {
    const cookie = await sessionCookie();
    const { recoveryCodes } = await enable(cookie);
    expect(recoveryCodes).toHaveLength(10);
    const status = await app.inject({ method: "GET", url: "/api/auth/2fa", headers: { cookie } });
    expect(status.json()).toEqual({ enabled: true, recoveryCodesLeft: 10 });
    const audit = await ctx.auditService.list();
    expect(audit.entries.some((e) => e.action === "auth.2fa_enabled")).toBe(true);
  });

  it("código errado ou senha atual errada: não ativa", async () => {
    const cookie = await sessionCookie();
    const setup = await app.inject({ method: "POST", url: "/api/auth/2fa/setup", headers: { cookie } });
    const { secret } = setup.json() as { secret: string };
    const errado = await app.inject({
      method: "POST",
      url: "/api/auth/2fa/enable",
      headers: { cookie },
      payload: { currentPassword: PASSWORD, code: "000000" === codeNow(secret) ? "111111" : "000000" },
    });
    expect(errado.statusCode).toBe(400);
    expect(errado.json().error).toBe("invalid_two_factor_code");
    const senhaErrada = await app.inject({
      method: "POST",
      url: "/api/auth/2fa/enable",
      headers: { cookie },
      payload: { currentPassword: "OutraSenha999", code: codeNow(secret) },
    });
    expect(senhaErrada.statusCode).toBe(401);
    const status = await app.inject({ method: "GET", url: "/api/auth/2fa", headers: { cookie } });
    expect(status.json().enabled).toBe(false);
  });

  it("confirmar sem ter começado o setup → 409", async () => {
    const cookie = await sessionCookie();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/2fa/enable",
      headers: { cookie },
      payload: { currentPassword: PASSWORD, code: "123456" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no_pending_setup");
  });

  it("o segredo fica cifrado em disco (users.json não contém o segredo nem os códigos)", async () => {
    const cookie = await sessionCookie();
    const { secret, recoveryCodes } = await enable(cookie);
    const raw = await readFile(path.join(ctx.dir, "users.json"), "utf8");
    expect(raw).not.toContain(secret);
    for (const c of recoveryCodes) expect(raw).not.toContain(c);
  });

  it("sem sessão → 401", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/2fa/setup" });
    expect(res.statusCode).toBe(401);
  });
});

describe("login com a verificação em duas etapas ativa", () => {
  it("senha certa sem código → 401 two_factor_required, sem sessão", async () => {
    await enable(await sessionCookie());
    const res = await login({});
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("two_factor_required");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("senha certa + código certo → entra; o mesmo código não vale de novo", async () => {
    const { secret } = await enable(await sessionCookie());
    nextStep();
    const code = codeNow(secret);
    const ok = await login({ code });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.headers["set-cookie"]).toBeDefined();
    const reuso = await login({ code });
    expect(reuso.statusCode).toBe(401);
    expect(reuso.json().error).toBe("invalid_two_factor_code");
  });

  it("senha ERRADA + código certo → invalid_credentials (o código não ajuda quem não sabe a senha)", async () => {
    const { secret } = await enable(await sessionCookie());
    nextStep();
    const res = await login({ password: "SenhaErrada999", code: codeNow(secret) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_credentials");
  });

  it("código errado conta como tentativa falha (limite por IP) e é auditado", async () => {
    await enable(await sessionCookie());
    for (let i = 0; i < 4; i += 1) {
      expect((await login({ code: "000000" })).statusCode).toBe(401);
    }
    expect((await login({ code: "000000" })).statusCode).toBe(429);
    const audit = await ctx.auditService.list();
    expect(audit.entries.some((e) => e.action === "auth.2fa_failed")).toBe(true);
  });

  it("código de recuperação entra UMA vez e o saldo diminui", async () => {
    const cookie = await sessionCookie();
    const { recoveryCodes } = await enable(cookie);
    const first = recoveryCodes[0]!;
    const ok = await login({ code: first.toUpperCase() });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await login({ code: first })).statusCode).toBe(401);
    const status = await app.inject({ method: "GET", url: "/api/auth/2fa", headers: { cookie: sessionCookieOf(ok) } });
    expect(status.json().recoveryCodesLeft).toBe(9);
  });
});

describe("desativar a verificação em duas etapas", () => {
  it("com senha atual + código: desativa, audita, e o login volta a ser só com senha", async () => {
    const cookie = await sessionCookie();
    const { secret } = await enable(cookie);
    nextStep();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/2fa/disable",
      headers: { cookie },
      payload: { currentPassword: PASSWORD, code: codeNow(secret) },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await login({})).statusCode).toBe(200);
    const audit = await ctx.auditService.list();
    expect(audit.entries.some((e) => e.action === "auth.2fa_disabled")).toBe(true);
  });

  it("sem o código certo não desativa (sessão roubada não basta)", async () => {
    const cookie = await sessionCookie();
    await enable(cookie);
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/2fa/disable",
      headers: { cookie },
      payload: { currentPassword: PASSWORD, code: "000000" },
    });
    expect(res.statusCode).toBe(400);
    expect((await login({})).json().error).toBe("two_factor_required");
  });
});
