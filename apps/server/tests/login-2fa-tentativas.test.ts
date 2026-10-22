/**
 * login-2fa-tentativas.test.ts — aviso de tentativas restantes ao errar o código
 * do app no login: só depois da senha certa, o menor entre conta e IP, só o
 * próximo bloqueio (nunca o nível) e corpo idêntico para quem não provou a senha.
 */
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SETUP_TOKEN_HEADER,
  TWO_FACTOR_LOCK_BASE_MS,
} from "@paas/core";
import authRoutes from "../src/routes/auth.js";
import setupRoutes from "../src/routes/setup.js";
import setupRestartRoutes from "../src/routes/setup-restart.js";
import { TOTP_STEP_SECONDS, totpCode } from "../src/services/totp.js";
import { buildAuthTestApp, closeAuthTestApp, sessionCookieOf, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const PASSWORD = "MinhaSenha123";
const WRONG = "000000";

let ctx: AuthTestContext;
let app: FastifyInstance;
let nowMs: number;
let watchMs: number;

function codeNow(secret: string): string {
  return totpCode(secret, Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS));
}
function nextStep() {
  nowMs += TOTP_STEP_SECONDS * 1000;
}

let ipCounter = 0;
const freshIp = () => `198.51.100.${(ipCounter++ % 250) + 1}`;

function loginFrom(ip: string, payload: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "x-forwarded-for": ip },
    payload: { username: "admin", password: PASSWORD, ...payload },
  });
}

async function enable2fa(): Promise<{ secret: string; recoveryCodes: string[]; cookie: string }> {
  const first = await loginFrom(freshIp());
  expect(first.statusCode).toBe(200);
  const cookie = sessionCookieOf(first);
  const setup = await app.inject({ method: "POST", url: "/api/auth/2fa/setup", headers: { cookie } });
  const { secret } = setup.json() as { secret: string };
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/2fa/enable",
    headers: { cookie },
    payload: { currentPassword: PASSWORD, code: codeNow(secret) },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { secret, recoveryCodes: (res.json() as { recoveryCodes: string[] }).recoveryCodes, cookie };
}

/** 5 códigos errados, cada um de um IP diferente (o IP não conta para o bloqueio da conta). */
async function lockAccount(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await loginFrom(freshIp(), { code: WRONG });
}

beforeEach(async () => {
  nowMs = Date.UTC(2026, 9, 22, 12, 0, 0);
  watchMs = nowMs;
  ctx = await buildAuthTestApp(TOKEN, { now: () => nowMs, watchNow: () => watchMs, trustProxy: true });
  app = ctx.app;
  app.decorate("config", { setupTokenFile: path.join(ctx.dir, "setup-token") } as never);
  await app.register(authRoutes);
  await app.register(setupRoutes);
  await app.register(setupRestartRoutes);
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


type Body = Record<string, unknown>;

describe("tentativas restantes no código errado", () => {
  it("conta: 4, 3, 2, 1 restantes (de IPs diferentes) e a 5ª bloqueia; 1 no singular", async () => {
    await enable2fa();
    const lefts: unknown[] = [];
    const msgs: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await loginFrom(freshIp(), { code: WRONG });
      expect(r.statusCode).toBe(401);
      const b = r.json() as Body;
      expect(b.error).toBe("invalid_two_factor_code");
      lefts.push(b.attemptsLeft);
      msgs.push(String(b.message));
      expect(b.nextLockSec).toBe(TWO_FACTOR_LOCK_BASE_MS / 1000);
    }
    expect(lefts).toEqual([4, 3, 2, 1]);
    expect(msgs[0]).toBe("Código incorreto. Restam 4 tentativas antes de bloquear o código do app por 5 minutos.");
    expect(msgs[3]).toBe("Código incorreto. Resta 1 tentativa antes de bloquear o código do app por 5 minutos.");
    const fifth = await loginFrom(freshIp(), { code: WRONG });
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json().attemptsLeft).toBeUndefined();
  });

  it("IP: mostra o menor dos dois (aqui o do IP, com o bloqueio do IP) sem dizer qual é", async () => {
    await enable2fa();
    const ip = "203.0.113.77";
    // 1º passo (pede o código) já conta 1 no IP; depois cada código errado conta mais 1
    expect((await loginFrom(ip)).json().error).toBe("two_factor_required");
    const a = (await loginFrom(ip, { code: WRONG })).json() as Body;
    expect(a.attemptsLeft).toBe(3);
    expect(a.nextLockSec).toBe(60);
    expect(a.message).toBe("Código incorreto. Restam 3 tentativas antes de bloquear o código do app por 1 minuto.");
    const b = (await loginFrom(ip, { code: WRONG })).json() as Body;
    expect(b.attemptsLeft).toBe(2);
    expect(Object.keys(b).sort()).toEqual(["attemptsLeft", "error", "message", "nextLockSec"]);
  });

  it("não revela o nível de reincidência: após um bloqueio vencido o corpo tem os mesmos campos e nunca 'nível'", async () => {
    await enable2fa();
    await lockAccount();
    nowMs += TWO_FACTOR_LOCK_BASE_MS + 1000;
    const r = (await loginFrom(freshIp(), { code: WRONG })).json() as Body;
    expect(Object.keys(r).sort()).toEqual(["attemptsLeft", "error", "message", "nextLockSec"]);
    expect(JSON.stringify(r)).not.toMatch(/level|nivel|nível|reincid/i);
    // só o PRÓXIMO bloqueio: 10 min, sem dizer que é o 2º
    expect(r.nextLockSec).toBe((TWO_FACTOR_LOCK_BASE_MS * 2) / 1000);
    expect(r.attemptsLeft).toBe(4);
  });

  it("código de recuperação errado não mexe na conta: só o limite do IP aparece", async () => {
    await enable2fa();
    const r = (await loginFrom("203.0.113.90", { code: "aaaaa-bbbbb" })).json() as Body;
    expect(r.error).toBe("invalid_two_factor_code");
    expect(r.attemptsLeft).toBe(4);
    const tf = (await ctx.userStore.findByUsername("admin"))!.twoFactor!;
    expect(tf.failedCodes ?? 0).toBe(0);
  });

  it("quem não provou a senha não ganha nada: usuário inexistente e senha errada têm corpo idêntico, sem contagem", async () => {
    await enable2fa();
    await loginFrom(freshIp(), { code: WRONG }); // conta com 1 erro guardado
    const inexistente = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "x-forwarded-for": freshIp() },
      payload: { username: "ninguem", password: "SenhaErrada123", code: WRONG },
    });
    const senhaErrada = await loginFrom(freshIp(), { password: "SenhaErrada123", code: WRONG });
    const semCodigo = await loginFrom(freshIp(), { password: "SenhaErrada123" });
    for (const r of [inexistente, senhaErrada, semCodigo]) {
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ error: "invalid_credentials", message: "Credenciais inválidas." });
    }
    expect(inexistente.body).toBe(senhaErrada.body);
    expect(senhaErrada.body).toBe(semCodigo.body);
    expect(inexistente.body).not.toMatch(/attemptsLeft|nextLockSec|tentativa/);
  });

  it("conta bloqueada + senha errada segue igual ao usuário inexistente (sem contagem nem bloqueio)", async () => {
    await enable2fa();
    await lockAccount();
    const senhaErrada = await loginFrom(freshIp(), { password: "SenhaErrada123", code: WRONG });
    const inexistente = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "x-forwarded-for": freshIp() },
      payload: { username: "ninguem", password: "SenhaErrada123", code: WRONG },
    });
    expect(senhaErrada.statusCode).toBe(401);
    expect(senhaErrada.body).toBe(inexistente.body);
  });

  it("o primeiro passo (senha certa, pede o código) não traz contagem", async () => {
    await enable2fa();
    const r = await loginFrom(freshIp());
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe("two_factor_required");
    expect(r.json().attemptsLeft).toBeUndefined();
  });
});
