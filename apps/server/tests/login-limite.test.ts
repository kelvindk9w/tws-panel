/**
 * login-limite.test.ts — lote 7, achado M2 (e B14).
 *
 * Antes: `check()` rodava antes de qualquer falha ser registrada, então 60
 * tentativas simultâneas do mesmo IP tinham a senha avaliada todas (e uma
 * senha certa entre elas criaria sessão). Agora a tentativa é reservada ANTES
 * de verificar a senha.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import authRoutes from "../src/routes/auth.js";
import setupRoutes from "../src/routes/setup.js";
import { TrustedProxies } from "../src/services/trusted-proxies.js";
import { LoginLimiter } from "../src/services/login-limiter.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const PASSWORD = "MinhaSenha123";

describe("login concorrente (rota real, argon2 real)", () => {
  let ctx: AuthTestContext;
  let app: FastifyInstance;

  beforeEach(async () => {
    ctx = await buildAuthTestApp("token-de-teste");
    app = ctx.app;
    await app.register(authRoutes);
    await app.register(setupRoutes);
    await app.inject({
      method: "POST",
      url: "/api/setup/admin",
      headers: { "x-setup-token": "token-de-teste" },
      payload: { username: "admin", password: PASSWORD },
    });
  });

  afterEach(async () => {
    await closeAuthTestApp(ctx);
  });

  const tentar = (password: string) =>
    app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password } });

  it("60 tentativas simultâneas: a senha é avaliada no máximo 5 vezes", async () => {
    const respostas = await Promise.all(Array.from({ length: 60 }, () => tentar("SenhaErrada123")));
    const avaliadas = (await ctx.auditService.list()).entries.filter((e) => e.action === "auth.login_failed");
    expect(avaliadas.length).toBeLessThanOrEqual(5);
    expect(respostas.filter((r) => r.statusCode === 401 || r.statusCode === 429).length).toBe(60);
    expect(respostas.filter((r) => r.statusCode === 429).length).toBeGreaterThanOrEqual(55);
  });

  it("a senha CERTA no meio de uma rajada não cria sessão", async () => {
    const lote = Array.from({ length: 30 }, () => tentar("SenhaErrada123"));
    lote.push(tentar(PASSWORD)); // a 31ª, já depois das 5 reservas
    const respostas = await Promise.all(lote);
    expect(respostas[30]!.statusCode).toBe(429);
    expect(respostas.some((r) => r.statusCode === 200)).toBe(false);
    expect(respostas.some((r) => r.headers["set-cookie"] !== undefined)).toBe(false);
  });

  it("depois do bloqueio, o limite segue valendo (nem a senha certa entra)", async () => {
    await Promise.all(Array.from({ length: 10 }, () => tentar("SenhaErrada123")));
    expect((await tentar(PASSWORD)).statusCode).toBe(429);
  });

  it("login normal (uma tentativa por vez) continua entrando e libera a reserva", async () => {
    for (let i = 0; i < 3; i++) expect((await tentar("SenhaErrada123")).statusCode).toBe(401);
    expect((await tentar(PASSWORD)).statusCode).toBe(200);
    // sucesso zera o histórico: mais 4 erros ainda não bloqueiam
    for (let i = 0; i < 4; i++) expect((await tentar("SenhaErrada123")).statusCode).toBe(401);
  });

  it("senha certa, mas sem código de 2FA, conta como tentativa do IP (4 pedem o código, a 5ª bloqueia)", async () => {
    const user = (await ctx.userStore.findByUsername("admin"))!;
    const enable = vi.spyOn(ctx.userStore, "findByUsername").mockResolvedValue({ ...user, twoFactor: { enabled: true } } as never);
    for (let i = 0; i < 4; i++) {
      const res = await tentar(PASSWORD);
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("two_factor_required");
    }
    expect((await tentar(PASSWORD)).statusCode).toBe(429);
    enable.mockRestore();
  });
});

describe("X-Forwarded-For forjado por um par que não é o Caddy (regressão do A4)", () => {
  it("30 tentativas, cada uma com um XFF diferente, caem no limite do IP real", async () => {
    const proxies = new TrustedProxies(async () => ["172.30.0.2"]);
    const ctx = await buildAuthTestApp("token-de-teste", { trustProxy: proxies.isTrusted });
    try {
      await ctx.app.register(authRoutes);
      await ctx.app.register(setupRoutes);
      const codes: number[] = [];
      for (let i = 0; i < 30; i++) {
        const res = await ctx.app.inject({
          method: "POST",
          url: "/api/auth/login",
          remoteAddress: "172.30.0.99",
          headers: { "x-forwarded-for": `203.0.113.${i + 1}` },
          payload: { username: "admin", password: "SenhaErrada123" },
        });
        codes.push(res.statusCode);
      }
      expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(25);
    } finally {
      await closeAuthTestApp(ctx);
    }
  });
});

describe("LoginLimiter", () => {
  afterEach(() => vi.useRealTimers());

  it("reserva: com 5 em andamento, a 6ª é recusada na hora", () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 5; i++) expect(l.check("1.1.1.1").allowed).toBe(true);
    const sexta = l.check("1.1.1.1");
    expect(sexta.allowed).toBe(false);
    expect(sexta.retryAfterSec).toBeGreaterThan(0);
  });

  it("release devolve a reserva sem contar falha", () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 5; i++) l.check("1.1.1.1");
    l.release("1.1.1.1");
    expect(l.check("1.1.1.1").allowed).toBe(true);
    expect(l.check("1.1.1.1").allowed).toBe(false);
  });

  it("release sem reserva e para IP desconhecido não quebra", () => {
    const l = new LoginLimiter();
    l.release("9.9.9.9");
    l.check("1.1.1.1");
    l.release("1.1.1.1");
    l.release("1.1.1.1");
    expect(l.check("1.1.1.1").allowed).toBe(true);
  });

  it("falha converte a reserva em falha; a 5ª trava com lockout progressivo", () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 4; i++) {
      l.check("1.1.1.1");
      expect(l.onFailure("1.1.1.1").allowed).toBe(true);
    }
    l.check("1.1.1.1");
    const trava = l.onFailure("1.1.1.1");
    expect(trava.allowed).toBe(false);
    expect(trava.retryAfterSec).toBe(60);
    expect(l.check("1.1.1.1").allowed).toBe(false);
  });

  it("sucesso zera tudo, inclusive reservas de outros pedidos em andamento", () => {
    const l = new LoginLimiter();
    for (let i = 0; i < 3; i++) l.check("1.1.1.1");
    l.onSuccess("1.1.1.1");
    l.release("1.1.1.1"); // o pedido que terminou depois do sucesso
    for (let i = 0; i < 5; i++) expect(l.check("1.1.1.1").allowed).toBe(true);
  });

  it("poda: IP que só consultou (ou já esfriou) sai do mapa; o teto de IPs rastreados vale", () => {
    vi.useFakeTimers();
    const l = new LoginLimiter(100);
    for (let i = 0; i < 90; i++) {
      l.check(`10.0.0.${i}`);
      l.release(`10.0.0.${i}`);
    }
    vi.advanceTimersByTime(2 * 60_000);
    l.check("1.1.1.1"); // dispara a poda periódica
    expect(l.size()).toBe(1);
    // acima do teto, os mais antigos sem bloqueio saem
    for (let i = 0; i < 300; i++) l.onFailure(`172.16.0.${i % 250}.${i}`);
    expect(l.size()).toBeLessThanOrEqual(100);
  });

  it("a poda não solta quem está bloqueado nem quem tem tentativa em andamento", () => {
    vi.useFakeTimers();
    const l = new LoginLimiter(100);
    for (let i = 0; i < 5; i++) {
      l.check("2.2.2.2");
      l.onFailure("2.2.2.2");
    }
    l.check("3.3.3.3"); // em andamento
    vi.advanceTimersByTime(30_000);
    for (let i = 0; i < 200; i++) l.onFailure(`10.1.${i}.1`);
    expect(l.check("2.2.2.2").allowed).toBe(false);
    l.release("3.3.3.3");
  });
});
