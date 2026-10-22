/**
 * login-2fa-travas.test.ts — travas do login com verificação em duas etapas
 * (análise do fluxo de login): bloqueio progressivo POR CONTA no código de 6
 * dígitos, saída pelo código de recuperação, aviso ao dono (Auditoria +
 * Alertas), limite nas rotas com sessão aberta, /64 do IPv6 e o aviso do
 * proxy da Cloudflare. Rota real, argon2 real, TOTP real, IPs diferentes.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SETUP_TOKEN_HEADER,
  TWO_FACTOR_LOCK_BASE_MS,
  TWO_FACTOR_LOCK_MAX_MS,
} from "@paas/core";
import authRoutes from "../src/routes/auth.js";
import setupRoutes from "../src/routes/setup.js";
import setupRestartRoutes from "../src/routes/setup-restart.js";
import { alertNotification } from "../src/services/notification-sources.js";
import { TOTP_STEP_SECONDS, totpCode } from "../src/services/totp.js";
import { TwoFactorService, looksLikeTotp, twoFactorLockRemainingSec } from "../src/services/two-factor.js";
import { UserStore } from "../src/services/user-store.js";
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

describe("bloqueio por conta no código de 6 dígitos", () => {
  it("5 erros vindos de IPs diferentes bloqueiam a conta: nem o código CERTO entra", async () => {
    const { secret } = await enable2fa();
    for (let i = 0; i < 4; i += 1) {
      const r = await loginFrom(freshIp(), { code: WRONG });
      expect(r.statusCode).toBe(401);
      expect(r.json().error).toBe("invalid_two_factor_code");
    }
    const fifth = await loginFrom(freshIp(), { code: WRONG });
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json().error).toBe("two_factor_locked");
    expect(Number(fifth.headers["retry-after"])).toBe(TWO_FACTOR_LOCK_BASE_MS / 1000);

    nextStep();
    const certo = await loginFrom(freshIp(), { code: codeNow(secret) });
    expect(certo.statusCode).toBe(429);
    expect(certo.json().error).toBe("two_factor_locked");
    expect(certo.headers["set-cookie"]).toBeUndefined();
  });

  it("a resposta do bloqueio é a mesma com senha certa ou errada (não confirma a senha)", async () => {
    await enable2fa();
    await lockAccount();
    const certa = await loginFrom(freshIp(), { code: "123456" });
    const errada = await loginFrom(freshIp(), { code: "123456", password: "SenhaErrada999" });
    expect(certa.statusCode).toBe(429);
    expect(errada.statusCode).toBe(429);
    expect(errada.json().error).toBe(certa.json().error);
    expect(errada.json().message).toBe(certa.json().message);
    // sem código de 6 dígitos a resposta continua a de sempre
    const semCodigo = await loginFrom(freshIp(), { password: "SenhaErrada999" });
    expect(semCodigo.json().error).toBe("invalid_credentials");
  });

  it("durante o bloqueio o código de recuperação entra, e o login bem-sucedido zera o bloqueio", async () => {
    const { secret, recoveryCodes } = await enable2fa();
    await lockAccount();
    const ok = await loginFrom(freshIp(), { code: recoveryCodes[0]! });
    expect(ok.statusCode, ok.body).toBe(200);
    // o bloqueio acabou: o código do app volta a valer na hora
    nextStep();
    const totp = await loginFrom(freshIp(), { code: codeNow(secret) });
    expect(totp.statusCode, totp.body).toBe(200);
    const tf = (await ctx.userStore.findByUsername("admin"))!.twoFactor!;
    expect(tf.lockedUntil).toBeUndefined();
    expect(tf.failedCodes).toBeUndefined();
    expect(tf.lockLevel).toBeUndefined();
  });

  it("erros do código de recuperação não contam para o bloqueio da conta", async () => {
    await enable2fa();
    for (let i = 0; i < 12; i += 1) {
      const r = await loginFrom(freshIp(), { code: "aaaaa-bbbbb" });
      expect(r.json().error).toBe("invalid_two_factor_code");
    }
    const tf = (await ctx.userStore.findByUsername("admin"))!.twoFactor!;
    expect(tf.failedCodes ?? 0).toBe(0);
  });

  it("um acerto no meio zera a contagem de erros", async () => {
    const { secret } = await enable2fa();
    for (let i = 0; i < 4; i += 1) await loginFrom(freshIp(), { code: WRONG });
    nextStep();
    expect((await loginFrom(freshIp(), { code: codeNow(secret) })).statusCode).toBe(200);
    for (let i = 0; i < 4; i += 1) expect((await loginFrom(freshIp(), { code: WRONG })).statusCode).toBe(401);
  });

  it("corrida: 60 pedidos simultâneos de 60 IPs conferem no máximo 5 códigos", async () => {
    await enable2fa();
    const respostas = await Promise.all(
      Array.from({ length: 60 }, (_, i) => loginFrom(`203.0.113.${i + 1}`, { code: WRONG })),
    );
    const audit = (await ctx.auditService.list()).entries.filter((e) => e.action === "auth.2fa_failed");
    expect(audit.length).toBe(5);
    expect(respostas.filter((r) => r.json().error === "invalid_two_factor_code").length).toBe(4);
    expect(respostas.filter((r) => r.json().error === "two_factor_locked").length).toBe(56);
    expect(respostas.some((r) => r.statusCode === 200)).toBe(false);
  });

  it("corrida: 200 IPs com o código certo no meio de uma rajada de errados nunca passam de 5 conferências erradas", async () => {
    const { secret } = await enable2fa();
    nextStep();
    const certo = codeNow(secret);
    const lote = Array.from({ length: 200 }, (_, i) =>
      loginFrom(`192.0.2.${(i % 250) + 1}`, { code: i % 40 === 0 ? certo : WRONG }),
    );
    const respostas = await Promise.all(lote);
    const entraram = respostas.filter((r) => r.statusCode === 200).length;
    const erradas = (await ctx.auditService.list()).entries.filter((e) => e.action === "auth.2fa_failed").length;
    expect(entraram).toBeLessThanOrEqual(1); // o mesmo código nunca vale duas vezes
    // 5 erros bloqueiam; só um acerto zera a contagem e libera mais 5
    expect(erradas).toBeLessThanOrEqual(5 * (entraram + 1));
  });

  it("o bloqueio sobrevive ao reinício (mesmo diretório de dados) e users.json segue 0600", async () => {
    await enable2fa();
    await lockAccount();
    const store2 = new UserStore(ctx.dir);
    const user = (await store2.findByUsername("admin"))!;
    expect(twoFactorLockRemainingSec(user.twoFactor, nowMs)).toBe(TWO_FACTOR_LOCK_BASE_MS / 1000);
    const service2 = new TwoFactorService(ctx.dir, store2, { now: () => nowMs });
    const outcome = await service2.verifyDetailed(user, "123456");
    expect(outcome).toEqual({ status: "locked", retryAfterSec: TWO_FACTOR_LOCK_BASE_MS / 1000 });
    expect((await stat(path.join(ctx.dir, "users.json"))).mode & 0o777).toBe(0o600);
  });

  it("users.json antigo (sem os campos novos) carrega e funciona", async () => {
    const { secret } = await enable2fa();
    const user = (await ctx.userStore.findByUsername("admin"))!;
    expect(user.twoFactor!.failedCodes).toBeUndefined();
    nextStep();
    expect((await loginFrom(freshIp(), { code: codeNow(secret) })).statusCode).toBe(200);
  });

  it("o bloqueio dobra a cada reincidência e para em 24 h; o nível esfria depois de 24 h", async () => {
    await enable2fa();
    const user = (await ctx.userStore.findByUsername("admin"))!;
    const svc = ctx.twoFactor;
    const durations: number[] = [];
    for (let nivel = 0; nivel < 12; nivel += 1) {
      let last: Awaited<ReturnType<typeof svc.verifyDetailed>> = { status: "invalid" };
      for (let i = 0; i < 5; i += 1) last = await svc.verifyDetailed(user, WRONG);
      expect(last.status).toBe("invalid");
      const lockedNow = (last as { lockedNow?: { retryAfterSec: number } }).lockedNow!;
      durations.push(lockedNow.retryAfterSec * 1000);
      nowMs += lockedNow.retryAfterSec * 1000 + 1; // espera vencer
    }
    expect(durations.slice(0, 4)).toEqual([5, 10, 20, 40].map((m) => m * 60_000));
    expect(Math.max(...durations)).toBe(TWO_FACTOR_LOCK_MAX_MS);
    expect(durations.at(-1)).toBe(TWO_FACTOR_LOCK_MAX_MS);
    // 24 h sem erro depois do último bloqueio: volta ao nível 0
    nowMs += TWO_FACTOR_LOCK_MAX_MS + 1000;
    let last: Awaited<ReturnType<typeof svc.verifyDetailed>> = { status: "invalid" };
    for (let i = 0; i < 5; i += 1) last = await svc.verifyDetailed(user, WRONG);
    expect((last as { lockedNow?: { retryAfterSec: number } }).lockedNow!.retryAfterSec * 1000).toBe(TWO_FACTOR_LOCK_BASE_MS);
  });

  it("looksLikeTotp só aceita 6 dígitos (com ou sem espaço)", () => {
    expect(looksLikeTotp("123 456")).toBe(true);
    expect(looksLikeTotp("12345")).toBe(false);
    expect(looksLikeTotp("abcde-fghij")).toBe(false);
    expect(twoFactorLockRemainingSec(null, nowMs)).toBe(0);
  });
});

describe("Auditoria e aviso ao dono", () => {
  it("bloqueio gera auditoria e Alerta crítico imediato, sem senha nem código", async () => {
    await enable2fa();
    await lockAccount();
    const audit = (await ctx.auditService.list()).entries;
    expect(audit.some((e) => e.action === "auth.2fa_locked")).toBe(true);
    const { alerts } = await ctx.alertsService.list({ source: "login" });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.severity).toBe("critical");
    expect(alerts[0]!.title).toMatch(/bloqueada/);
    const tudo = JSON.stringify([audit, alerts]);
    expect(tudo).not.toContain(PASSWORD);
    expect(tudo).not.toContain(WRONG);
    expect(JSON.stringify(alerts)).not.toMatch(/198\.51\.100\.\d+(?!\d*\/)/); // IP só mascarado nos alertas
    expect(alerts[0]!.detail).toMatch(/198\.51\.100\.0\/24/);
  });

  it("o aviso vira notificação do tipo 'segurança'", async () => {
    await enable2fa();
    await lockAccount();
    const { alerts } = await ctx.alertsService.list({ source: "login" });
    const event = alertNotification(alerts[0]!);
    expect(event.kind).toBe("security");
    expect(event.path).toBe("/alerts");
    expect(JSON.stringify(event)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it("senha certa sem código: só vira evento se o login não for concluído; agrupado a cada 15 min", async () => {
    const { secret } = await enable2fa();
    // login legítimo: primeiro passo + código no mesmo IP → nenhum aviso
    const ipDono = "192.0.2.10";
    expect((await loginFrom(ipDono)).json().error).toBe("two_factor_required");
    nextStep();
    expect((await loginFrom(ipDono, { code: codeNow(secret) })).statusCode).toBe(200);
    watchMs += 10 * 60_000;
    await ctx.loginWatch.sweep();
    expect((await ctx.alertsService.list({ source: "login" })).total).toBe(0);
    expect(ctx.loginWatch.pending()).toBe(0);

    // abandonado: 3 IPs só digitam a senha
    for (const ip of ["203.0.113.5", "203.0.113.77", "2001:db8:1:2::9"]) {
      expect((await loginFrom(ip)).json().error).toBe("two_factor_required");
    }
    expect(ctx.loginWatch.pending()).toBe(3);
    watchMs += 6 * 60_000;
    await ctx.loginWatch.sweep();
    const depois = await ctx.alertsService.list({ source: "login" });
    expect(depois.total).toBe(1); // 1 alerta por tipo, não 3
    expect(depois.alerts[0]!.detail).toMatch(/1 ocorrência/);
    const audit = (await ctx.auditService.list()).entries.filter((e) => e.action === "auth.2fa_abandoned");
    expect(audit).toHaveLength(3);

    // nova rajada dentro da janela de 15 min: acumula e sai UM resumo depois
    for (const ip of ["198.18.0.1", "198.18.0.2"]) await loginFrom(ip);
    watchMs += 6 * 60_000;
    await ctx.loginWatch.sweep();
    expect((await ctx.alertsService.list({ source: "login" })).alerts[0]!.detail).toMatch(/1 ocorrência/); // ainda não resumiu
    watchMs += 10 * 60_000;
    await ctx.loginWatch.sweep();
    const final = await ctx.alertsService.list({ source: "login" });
    expect(final.total).toBe(1); // o alerta aberto foi atualizado, não duplicado
    expect(final.alerts[0]!.detail).toMatch(/4 ocorrência/);
    expect(JSON.stringify(final)).not.toContain(PASSWORD);
    expect(final.alerts[0]!.detail).toMatch(/2001:db8:1:2::\/64/);
  });

  it("senha certa com código errado e login nunca concluído vira 'wrong_code' na auditoria", async () => {
    await enable2fa();
    await loginFrom("203.0.113.20", { code: WRONG });
    await loginFrom("203.0.113.20", { code: WRONG });
    watchMs += 6 * 60_000;
    await ctx.loginWatch.sweep();
    const audit = (await ctx.auditService.list()).entries.filter((e) => e.action === "auth.2fa_wrong_code");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).toMatch(/2 vez/);
    const { alerts } = await ctx.alertsService.list({ source: "login" });
    expect(alerts[0]!.title).toMatch(/digitado errado/);
  });

  it("vários erros antes de entrar já geram evento, mesmo com o login concluído", async () => {
    const { secret } = await enable2fa();
    for (let i = 0; i < 3; i += 1) await loginFrom("203.0.113.30", { code: WRONG });
    nextStep();
    expect((await loginFrom("203.0.113.30", { code: codeNow(secret) })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect((await ctx.auditService.list()).entries.some((e) => e.action === "auth.2fa_wrong_code")).toBe(true);
  });

  it("falha ao gravar o alerta não derruba o login", async () => {
    const { secret } = await enable2fa();
    ctx.alertsService.create = async () => {
      throw new Error("disco cheio");
    };
    await lockAccount();
    nextStep();
    // a conta está bloqueada, mas a rota respondeu normalmente (429), sem 500
    expect((await loginFrom(freshIp(), { code: codeNow(secret) })).statusCode).toBe(429);
  });
});

describe("limite por IP: passo da senha e IPv6", () => {
  it("senha certa sem código conta como tentativa do IP", async () => {
    await enable2fa();
    const ip = "203.0.113.99";
    for (let i = 0; i < 4; i += 1) expect((await loginFrom(ip)).statusCode).toBe(401);
    expect((await loginFrom(ip)).statusCode).toBe(429);
  });

  it("endereços IPv6 do mesmo /64 dividem o contador; /64 diferente não", async () => {
    await enable2fa();
    const codigos: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      codigos.push((await loginFrom(`2001:db8:aaaa:1::${(i + 1).toString(16)}`, { password: "SenhaErrada999" })).statusCode);
    }
    expect(codigos.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(codigos.slice(4).every((c) => c === 429)).toBe(true);
    expect((await loginFrom("2001:db8:aaaa:2::1", { password: "SenhaErrada999" })).statusCode).toBe(401);
  });
});

describe("rotas com a sessão aberta", () => {
  it("trocar senha: 5 senhas atuais erradas bloqueiam (429), mesmo com outra sessão", async () => {
    const login = await loginFrom(freshIp());
    const cookie = sessionCookieOf(login);
    const cookie2 = sessionCookieOf(await loginFrom(freshIp()));
    const tentar = (c: string, currentPassword: string) =>
      app.inject({
        method: "POST",
        url: "/api/auth/change-password",
        headers: { cookie: c },
        payload: { currentPassword, newPassword: "NovaSenha456xyz" },
      });
    for (let i = 0; i < 4; i += 1) expect((await tentar(cookie, "Errada123456")).statusCode).toBe(401);
    const quinta = await tentar(cookie, "Errada123456");
    expect(quinta.statusCode).toBe(429);
    expect(quinta.json().error).toBe("too_many_attempts");
    expect(quinta.headers["retry-after"]).toBeDefined();
    // a conta está travada, não a sessão: a outra sessão e a senha certa também esperam
    expect((await tentar(cookie2, PASSWORD)).statusCode).toBe(429);
  });

  it("trocar senha: senha fraca não conta como erro; sucesso zera a contagem", async () => {
    const cookie = sessionCookieOf(await loginFrom(freshIp()));
    const tentar = (currentPassword: string, newPassword = "NovaSenha456xyz") =>
      app.inject({ method: "POST", url: "/api/auth/change-password", headers: { cookie }, payload: { currentPassword, newPassword } });
    for (let i = 0; i < 8; i += 1) expect((await tentar(PASSWORD, "fraca")).statusCode).toBe(400);
    for (let i = 0; i < 3; i += 1) expect((await tentar("Errada123456")).statusCode).toBe(401);
    expect((await tentar(PASSWORD)).statusCode).toBe(200);
    for (let i = 0; i < 4; i += 1) expect((await tentar("Errada123456")).statusCode).toBe(401);
  });

  it("desativar 2FA: códigos errados travam a conta (400 → 429) e o código de recuperação ainda desativa", async () => {
    const { recoveryCodes, cookie } = await enable2fa();
    const tentar = (code: string, currentPassword = PASSWORD) =>
      app.inject({ method: "POST", url: "/api/auth/2fa/disable", headers: { cookie }, payload: { currentPassword, code } });
    for (let i = 0; i < 4; i += 1) expect((await tentar(WRONG)).statusCode).toBe(400);
    const quinta = await tentar(WRONG);
    expect(quinta.statusCode).toBe(429);
    // o bloqueio da conta também vale para o login de qualquer IP
    expect((await loginFrom(freshIp(), { code: "123456" })).json().error).toBe("two_factor_locked");
    // limite da ação (por conta) estourou junto: espera vencer
    await new Promise((r) => setTimeout(r, 5));
    expect((await tentar(recoveryCodes[0]!)).statusCode).toBe(429);
    expect((await ctx.alertsService.list({ source: "login" })).total).toBe(1);
  });

  it("desativar 2FA: senha atual errada repetida → 429", async () => {
    const { cookie } = await enable2fa();
    const tentar = (code: string, currentPassword: string) =>
      app.inject({ method: "POST", url: "/api/auth/2fa/disable", headers: { cookie }, payload: { currentPassword, code } });
    for (let i = 0; i < 4; i += 1) expect((await tentar(WRONG, "Errada123456")).statusCode).toBe(401);
    expect((await tentar(WRONG, "Errada123456")).statusCode).toBe(429);
  });

  it("ativar 2FA: senha errada e código errado repetidos → 429", async () => {
    const cookie = sessionCookieOf(await loginFrom(freshIp()));
    await app.inject({ method: "POST", url: "/api/auth/2fa/setup", headers: { cookie } });
    const tentar = (currentPassword: string, code: string) =>
      app.inject({ method: "POST", url: "/api/auth/2fa/enable", headers: { cookie }, payload: { currentPassword, code } });
    for (let i = 0; i < 4; i += 1) expect((await tentar(PASSWORD, WRONG)).statusCode).toBe(400);
    const quinta = await tentar(PASSWORD, WRONG);
    expect(quinta.statusCode).toBe(429);
    expect((await tentar("Errada123456", WRONG)).statusCode).toBe(429);
  });

  it("ativar 2FA: conflito (sem setup) não conta como erro", async () => {
    const cookie = sessionCookieOf(await loginFrom(freshIp()));
    for (let i = 0; i < 8; i += 1) {
      const r = await app.inject({
        method: "POST",
        url: "/api/auth/2fa/enable",
        headers: { cookie },
        payload: { currentPassword: PASSWORD, code: "123456" },
      });
      expect(r.statusCode).toBe(409);
    }
  });

  it("recomeçar o assistente: senha atual errada repetida → 429", async () => {
    const { cookie } = await enable2fa();
    const tentar = (currentPassword: string, code?: string) =>
      app.inject({
        method: "POST",
        url: "/api/settings/restart-setup",
        headers: { cookie },
        payload: { currentPassword, confirm: "recomeçar", ...(code ? { code } : {}) },
      });
    for (let i = 0; i < 4; i += 1) expect((await tentar("Errada123456", WRONG)).statusCode).toBe(401);
    expect((await tentar("Errada123456", WRONG)).statusCode).toBe(429);

  });

  it("recomeçar o assistente: 5 códigos errados bloqueiam o código da conta", async () => {
    const { cookie } = await enable2fa();
    const tentar = (code?: string) =>
      app.inject({
        method: "POST",
        url: "/api/settings/restart-setup",
        headers: { cookie },
        payload: { currentPassword: PASSWORD, confirm: "recomeçar", ...(code ? { code } : {}) },
      });
    expect((await tentar()).statusCode).toBe(400); // sem código
    for (let i = 0; i < 3; i += 1) expect((await tentar(WRONG)).statusCode).toBe(400);
    const ultimo = await tentar(WRONG);
    expect(ultimo.statusCode).toBe(429);
    // 1 pedido sem código + 4 códigos errados = 5 falhas da ação → too_many_attempts
    expect(["too_many_attempts", "two_factor_locked"]).toContain(ultimo.json().error);
  });
});

describe("recomeçar: bloqueio da conta aparece como two_factor_locked", () => {
  it("com a conta já bloqueada, o código de 6 dígitos recebe 429 two_factor_locked", async () => {
    const { cookie, secret } = await enable2fa();
    await lockAccount();
    nextStep();
    const r = await app.inject({
      method: "POST",
      url: "/api/settings/restart-setup",
      headers: { cookie },
      payload: { currentPassword: PASSWORD, confirm: "recomeçar", code: codeNow(secret) },
    });
    expect(r.statusCode).toBe(429);
    expect(r.json().error).toBe("two_factor_locked");
    expect(r.headers["retry-after"]).toBeDefined();
  });

  it("o código de recuperação recomeça mesmo com a conta bloqueada", async () => {
    const { cookie, recoveryCodes } = await enable2fa();
    await lockAccount();
    const r = await app.inject({
      method: "POST",
      url: "/api/settings/restart-setup",
      headers: { cookie },
      payload: { currentPassword: PASSWORD, confirm: "recomeçar", code: recoveryCodes[0]! },
    });
    expect(r.statusCode, r.body).toBe(200);
  });
});

describe("arquivo users.json", () => {
  it("guarda só contadores do bloqueio (sem senha nem código)", async () => {
    await enable2fa();
    await loginFrom(freshIp(), { code: WRONG });
    const raw = await readFile(path.join(ctx.dir, "users.json"), "utf8");
    expect(raw).toContain('"failedCodes": 1');
    expect(raw).not.toContain(PASSWORD);
  });
});
