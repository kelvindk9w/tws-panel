/**
 * login-2fa-tentativas.test.ts — aviso de tentativas restantes ao errar o código
 * do app no login: só depois da senha certa, o menor entre conta e IP, só o
 * próximo bloqueio (nunca o nível) e corpo idêntico para quem não provou a senha.
 */
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/** Congela só o Date (o limitador do IP usa Date.now): sem depender do relógio real sob carga. */
function freezeClock(): number {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(nowMs);
  return nowMs;
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
  vi.useRealTimers();
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

  it("caminho do dono em um IP só (código do app): a sequência é verdadeira até o bloqueio, que diz o maior tempo", async () => {
    await enable2fa();
    const ip = "203.0.113.77";
    expect((await loginFrom(ip)).json().error).toBe("two_factor_required");
    const textos: string[] = [];
    for (const left of [4, 3, 2, 1]) {
      const r = (await loginFrom(ip, { code: WRONG })).json() as Body;
      expect(r.attemptsLeft).toBe(left);
      expect(r.limit).toBe("account");
      expect(r.nextLockSec).toBe(300);
      textos.push(String(r.message));
    }
    expect(textos[3]).toBe("Código incorreto. Resta 1 tentativa antes de bloquear o código do app por 5 minutos.");
    // o aviso "resta 1" precede o bloqueio real; os dois bloqueios chegam juntos e vale o maior tempo
    const quinta = await loginFrom(ip, { code: WRONG });
    expect(quinta.statusCode).toBe(429);
    expect(quinta.json().error).toBe("two_factor_locked");
    expect(quinta.json().retryAfterSec).toBe(300);
    expect(Number(quinta.headers["retry-after"])).toBe(300);
  });

  it("60 pedidos do mesmo IP: a conta fica 5 min e a resposta de bloqueio diz 5 min, não 60 s", async () => {
    await enable2fa();
    const respostas = await Promise.all(Array.from({ length: 60 }, () => loginFrom("203.0.113.78", { code: WRONG })));
    const locked = respostas.filter((r) => r.json().error === "two_factor_locked");
    for (const r of locked) expect(r.json().retryAfterSec).toBeGreaterThanOrEqual(60);
    const tf = (await ctx.userStore.findByUsername("admin"))!.twoFactor!;
    expect(tf.lockedUntil! - nowMs).toBe(TWO_FACTOR_LOCK_BASE_MS);
  });

  it("caminho do dono com o código de recuperação errado: texto neutro, só o IP, e passado 1 min o dono entra", async () => {
    const { recoveryCodes } = await enable2fa();
    const ip = "203.0.113.79";
    const base = freezeClock();
    try {
      const textos: string[] = [];
      for (const left of [4, 3, 2, 1]) {
        const r = (await loginFrom(ip, { code: "aaaaa-bbbbb" })).json() as Body;
        expect(r.attemptsLeft).toBe(left);
        expect(r.limit).toBe("ip");
        expect(r.nextLockSec).toBe(60);
        textos.push(String(r.message));
      }
      expect(textos[0]).toBe("Código incorreto. Restam 4 tentativas antes de um bloqueio temporário de 1 minuto.");
      expect(textos[3]).toBe("Código incorreto. Resta 1 tentativa antes de um bloqueio temporário de 1 minuto.");
      expect(textos.join(" ")).not.toMatch(/código do app/);
      const quinta = await loginFrom(ip, { code: "aaaaa-bbbbb" });
      expect(quinta.statusCode).toBe(429);
      expect(quinta.json().error).toBe("too_many_attempts");
      const tf = (await ctx.userStore.findByUsername("admin"))!.twoFactor!;
      expect(tf.failedCodes ?? 0).toBe(0);
      vi.setSystemTime(base + 61_000);
      const ok = await loginFrom(ip, { code: recoveryCodes[0]! });
      expect(ok.statusCode, ok.body).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("código com menos de 6 dígitos também só usa o limite do IP (texto neutro)", async () => {
    await enable2fa();
    const r = (await loginFrom("203.0.113.80", { code: "123" })).json() as Body;
    expect(r.limit).toBe("ip");
    expect(r.message).toBe("Código incorreto. Restam 4 tentativas antes de um bloqueio temporário de 1 minuto.");
    const tf = (await ctx.userStore.findByUsername("admin"))!.twoFactor!;
    expect(tf.failedCodes ?? 0).toBe(0);
  });

  it("depois de 1 min o IP volta a 5, mas a conta guarda os erros: o aviso passa a ser o da conta", async () => {
    await enable2fa();
    const ip = "203.0.113.81";
    const base = freezeClock();
    try {
      await loginFrom(ip, { code: WRONG });
      await loginFrom(ip, { code: WRONG });
      vi.setSystemTime(base + 61_000);
      const r = (await loginFrom(ip, { code: WRONG })).json() as Body;
      expect(r.attemptsLeft).toBe(2);
      expect(r.limit).toBe("account");
    } finally {
      vi.useRealTimers();
    }
  });

  it("não revela o nível de reincidência: após um bloqueio vencido o corpo tem os mesmos campos e nunca 'nível'", async () => {
    await enable2fa();
    await lockAccount();
    nowMs += TWO_FACTOR_LOCK_BASE_MS + 1000;
    const r = (await loginFrom(freshIp(), { code: WRONG })).json() as Body;
    expect(Object.keys(r).sort()).toEqual(["attemptsLeft", "error", "limit", "message", "nextLockSec"]);
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
    expect(r.limit).toBe("ip");
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

describe("paralelismo, bloqueio duplo e aviso da conta", () => {
  it("60 pedidos paralelos do mesmo IP (recuperação errada): os números mostrados nunca sobem nem repetem", async () => {
    await enable2fa();
    for (let rodada = 0; rodada < 5; rodada += 1) {
      const ip = `203.0.113.${100 + rodada}`;
      const respostas = await Promise.all(Array.from({ length: 60 }, () => loginFrom(ip, { code: "aaaaa-bbbbb" })));
      const avisos = respostas.filter((r) => r.json().error === "invalid_two_factor_code").map((r) => r.json() as Body);
      const lefts = avisos.map((a) => a.attemptsLeft as number);
      expect(Math.max(...lefts, 0)).toBeLessThanOrEqual(4);
      expect(new Set(lefts).size).toBe(lefts.length);
      for (const a of avisos) expect(a.nextLockSec).toBe(60);
    }
  });

  it("bloqueio duplo com o IP em nível alto: two_factor_locked com o tempo do IP (maior) e sem prometer a recuperação", async () => {
    await enable2fa();
    const ip = "203.0.113.120";
    const base = freezeClock();
    try {
      for (const lock of [60, 120, 240]) {
        for (let i = 0; i < 5; i += 1) await loginFrom(ip, { code: "aaaaa-bbbbb" });
        vi.setSystemTime(Date.now() + (lock + 1) * 1000);
      }
      let ultima;
      for (let i = 0; i < 5; i += 1) ultima = await loginFrom(ip, { code: WRONG });
      expect(ultima!.statusCode).toBe(429);
      const b = ultima!.json() as Body;
      expect(b.error).toBe("two_factor_locked");
      expect(b.retryAfterSec).toBe(480);
      expect(b.limit).toBe("ip");
      expect(b.message).toBe(
        "Verificação em duas etapas e login deste endereço temporariamente bloqueados por excesso de tentativas. Aguarde ou tente de outro lugar.",
      );
      expect(String(b.message)).not.toMatch(/recuperação/);
      expect(Number(ultima!.headers["retry-after"])).toBe(480);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bloqueio só da conta (IPs diferentes) continua oferecendo o código de recuperação, sem campo limit", async () => {
    await enable2fa();
    let ultima;
    for (let i = 0; i < 5; i += 1) ultima = await loginFrom(freshIp(), { code: WRONG });
    const b = ultima!.json() as Body;
    expect(b.message).toMatch(/código de recuperação/);
    expect(b.limit).toBeUndefined();
  });

  it("IP menor com a conta perto do bloqueio: o aviso cita a conta; passado o minuto, o 5º erro bloqueia (caso reproduzido)", async () => {
    await enable2fa();
    const ip = "203.0.113.130";
    const base = freezeClock();
    try {
      await loginFrom(ip, { password: "SenhaErrada123", code: WRONG });
      const um = (await loginFrom(ip, { code: WRONG })).json() as Body;
      const dois = (await loginFrom(ip, { code: WRONG })).json() as Body;
      const tres = (await loginFrom(ip, { code: WRONG })).json() as Body;
      expect(um.accountLeft).toBeUndefined();
      expect(dois.accountLeft).toBeUndefined();
      expect([um.attemptsLeft, dois.attemptsLeft, tres.attemptsLeft]).toEqual([3, 2, 1]);
      expect(tres.limit).toBe("ip");
      expect(tres.accountLeft).toBe(2);
      expect(tres.accountLockSec).toBe(300);
      expect(tres.message).toBe(
        "Código incorreto. Resta 1 tentativa antes de um bloqueio temporário de 1 minuto. O código do app também está perto de bloquear: restam 2 tentativas antes de bloquear por 5 minutos (o erro que dispara o bloqueio do IP também conta).",
      );
      const quarta = await loginFrom(ip, { code: WRONG });
      expect(quarta.json().error).toBe("too_many_attempts");
      const tf = (await ctx.userStore.findByUsername("admin"))!.twoFactor!;
      expect(tf.failedCodes).toBe(4);
      vi.setSystemTime(base + 61_000);
      const quinta = await loginFrom(ip, { code: WRONG });
      expect(quinta.json().error).toBe("two_factor_locked");
    } finally {
      vi.useRealTimers();
    }
  });

  it("empate em 1 com o IP em nível alto: mostra o IP e avisa a conta no singular", async () => {
    await enable2fa();
    const ip = "203.0.113.131";
    const base = freezeClock();
    try {
      for (const lock of [60, 120, 240]) {
        for (let i = 0; i < 5; i += 1) await loginFrom(ip, { code: "aaaaa-bbbbb" });
        vi.setSystemTime(Date.now() + (lock + 1) * 1000);
      }
      let r: Body = {};
      for (let i = 0; i < 4; i += 1) r = (await loginFrom(ip, { code: WRONG })).json() as Body;
      expect(r.limit).toBe("ip");
      expect(r.attemptsLeft).toBe(1);
      expect(r.nextLockSec).toBe(480);
      expect(r.accountLeft).toBe(1);
      expect(String(r.message)).toContain("resta 1 tentativa antes de bloquear por 5 minutos");
    } finally {
      vi.useRealTimers();
    }
  });
});
