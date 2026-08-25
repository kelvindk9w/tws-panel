/**
 * Testes do fluxo de autenticação contra uma app Fastify real (inject):
 * criação de admin (Passo 4), login/logout/me, rate limit, troca de senha e
 * a transição setup token → sessão — sempre verificando o ESTADO resultante
 * (cookie emitido, sessão persistida, token invalidado, auditoria gravada).
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE, SETUP_TOKEN_HEADER } from "@paas/core";
import authRoutes from "../src/routes/auth.js";
import setupRoutes from "../src/routes/setup.js";
import {
  buildAuthTestApp,
  closeAuthTestApp,
  sessionCookieOf,
  type AuthTestContext,
} from "./test-utils.js";

const TOKEN = "token-de-teste";
const PASSWORD = "MinhaSenha123";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };

let ctx: AuthTestContext;
let app: FastifyInstance;

beforeEach(async () => {
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  // rotas de mentira para testar o middleware de ponta a ponta
  app.get("/api/protegida", async () => ({ ok: true }));
  app.get("/api/healthz", async () => ({ ok: true }));
  await app.register(authRoutes);
  await app.register(setupRoutes);
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

async function createAdmin() {
  return app.inject({
    method: "POST",
    url: "/api/setup/admin",
    headers: auth,
    payload: { username: "admin", password: PASSWORD },
  });
}

async function login(password = PASSWORD) {
  return app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "admin", password },
  });
}

// ---------------------------------------------------------------------------
// Passo 4 do wizard: POST /api/setup/admin
// ---------------------------------------------------------------------------

describe("POST /api/setup/admin", () => {
  it("cria o admin → 201, setup concluído em disco e auditoria registrada", async () => {
    const res = await createAdmin();
    expect(res.statusCode).toBe(201);
    expect(res.json().user.username).toBe("admin");
    // a resposta NUNCA traz senha nem hash
    expect(JSON.stringify(res.json())).not.toContain(PASSWORD);
    expect(JSON.stringify(res.json())).not.toContain("passwordHash");

    // resultado real: setup-state em disco marcado como concluído
    expect((await ctx.setupState.load()).completed).toBe(true);
    // e o usuário persistido apenas com hash argon2
    const stored = await ctx.userStore.findByUsername("admin");
    expect(stored).not.toBeNull();
    expect(stored!.passwordHash.startsWith("$argon2id$")).toBe(true);
    expect(stored!.passwordHash).not.toContain(PASSWORD);

    const audit = await ctx.auditService.list();
    expect(audit.entries.some((e) => e.action === "setup.admin_created")).toBe(true);
  });

  it("segunda chamada → 409 admin_exists (admin é único)", async () => {
    expect((await createAdmin()).statusCode).toBe(201);
    const second = await app.inject({
      method: "POST",
      url: "/api/setup/admin",
      headers: auth,
      payload: { username: "outro", password: "OutraSenha123" },
    });
    // após a conclusão o wizard inteiro trava com 403 — o 409 só é alcançável
    // na corrida ANTES do state.completed ser gravado; ambos protegem a unicidade
    expect([409, 403]).toContain(second.statusCode);
    expect(await ctx.userStore.findByUsername("outro")).toBeNull();
  });

  it("senha fraca → 400 weak_password e NENHUM usuário criado", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/admin",
      headers: auth,
      payload: { username: "admin", password: "fraca" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("weak_password");
    expect(await ctx.userStore.hasAdmin()).toBe(false);
    expect((await ctx.setupState.load()).completed).toBe(false);
  });

  it("usuário inválido → 400 invalid_username", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/admin",
      headers: auth,
      payload: { username: "a b", password: PASSWORD },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_username");
  });

  it("sem setup token → 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/admin",
      payload: { username: "admin", password: PASSWORD },
    });
    expect(res.statusCode).toBe(401);
  });

  it("admin já existe (criado direto no store) mas setup incompleto → 409 admin_exists", async () => {
    // simula crash entre a criação do usuário e a conclusão do setup:
    // a conta existe, mas setup-state.completed ainda é false
    await ctx.userStore.create("admin", "$argon2id$hash-qualquer");
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/admin",
      headers: auth,
      payload: { username: "outro", password: "OutraSenha123" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("admin_exists");
    // e o setup continua incompleto (nada foi concluído por engano)
    expect((await ctx.setupState.load()).completed).toBe(false);
  });

  // Mudança intencional: a rota agora tem `schema` (Fastify/Ajv), então corpo
  // sem `username`/`password` é recusado ANTES do handler, com o código
  // genérico `invalid_request` (via registerErrorHandler) em vez dos códigos
  // específicos que a validação manual antiga produzia.
  it("sem corpo → 400 invalid_request; senha ausente → 400 invalid_request", async () => {
    const semCorpo = await app.inject({
      method: "POST",
      url: "/api/setup/admin",
      headers: auth,
    });
    expect(semCorpo.statusCode).toBe(400);
    expect(semCorpo.json().error).toBe("invalid_request");

    const semSenha = await app.inject({
      method: "POST",
      url: "/api/setup/admin",
      headers: auth,
      payload: { username: "admin" },
    });
    expect(semSenha.statusCode).toBe(400);
    expect(semSenha.json().error).toBe("invalid_request");
  });
});

// ---------------------------------------------------------------------------
// Transição: setup token invalidado após a conclusão
// ---------------------------------------------------------------------------

describe("setup token após a conclusão", () => {
  it("rotas /api/setup/* → 403 e demais rotas exigem sessão (token não vale mais)", async () => {
    // antes de concluir: token funciona
    expect((await app.inject({ method: "GET", url: "/api/setup/status", headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/protegida", headers: auth })).statusCode).toBe(200);

    await createAdmin();

    // depois: wizard trava (403) e o token não abre mais as outras rotas (401)
    const setupRes = await app.inject({ method: "GET", url: "/api/setup/status", headers: auth });
    expect(setupRes.statusCode).toBe(403);
    expect(setupRes.json().error).toBe("setup_completed");

    const protectedRes = await app.inject({ method: "GET", url: "/api/protegida", headers: auth });
    expect(protectedRes.statusCode).toBe(401);
    expect(protectedRes.json().error).toBe("unauthorized");
  });
});

// ---------------------------------------------------------------------------
// Middleware de sessão
// ---------------------------------------------------------------------------

describe("middleware de auth (setup concluído)", () => {
  beforeEach(async () => {
    await createAdmin();
  });

  it("sem sessão → 401; com sessão → passa", async () => {
    const noSession = await app.inject({ method: "GET", url: "/api/protegida" });
    expect(noSession.statusCode).toBe(401);

    const loginRes = await login();
    const cookie = sessionCookieOf(loginRes);
    const withSession = await app.inject({
      method: "GET",
      url: "/api/protegida",
      headers: { cookie },
    });
    expect(withSession.statusCode).toBe(200);
    expect(withSession.json()).toEqual({ ok: true });
  });

  it("cookie adulterado → 401 (assinatura HMAC rejeitada)", async () => {
    const loginRes = await login();
    const cookie = sessionCookieOf(loginRes);
    // troca o último caractere hex por um DIFERENTE (determinístico)
    const last = cookie[cookie.length - 1];
    const tampered = cookie.slice(0, -1) + (last === "0" ? "1" : "0");
    const res = await app.inject({
      method: "GET",
      url: "/api/protegida",
      headers: { cookie: tampered },
    });
    expect(res.statusCode).toBe(401);
  });

  it("/api/auth/me sem sessão → 401; /api/healthz continua público", async () => {
    expect((await app.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/healthz" })).statusCode).toBe(200);
  });

  it("/api/auth/me ANTES de concluir o setup → 401 setup_incomplete (orienta o guard do front)", async () => {
    await closeAuthTestApp(ctx);
    ctx = await buildAuthTestApp(TOKEN);
    app = ctx.app;
    await app.register(authRoutes);

    const res = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("setup_incomplete");
  });
});

// ---------------------------------------------------------------------------
// Login / logout / me
// ---------------------------------------------------------------------------

describe("POST /api/auth/login", () => {
  beforeEach(async () => {
    await createAdmin();
  });

  it("credenciais corretas → 200, cookie httpOnly SameSite=Lax, sessão persistida e auditoria", async () => {
    const res = await login();
    expect(res.statusCode).toBe(200);
    expect(res.json().user.username).toBe("admin");
    expect(JSON.stringify(res.json())).not.toContain(PASSWORD);

    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");

    // a sessão resolvida por /api/auth/me
    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: sessionCookieOf(res) },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.username).toBe("admin");

    const audit = await ctx.auditService.list();
    expect(audit.entries.some((e) => e.action === "auth.login")).toBe(true);
  });

  it("senha errada → 401 invalid_credentials + auditoria de falha", async () => {
    const res = await login("SenhaErrada123");
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_credentials");
    expect(res.headers["set-cookie"]).toBeUndefined();
    const audit = await ctx.auditService.list();
    expect(audit.entries.some((e) => e.action === "auth.login_failed")).toBe(true);
  });

  it("usuário inexistente → 401 idêntico (não revela se a conta existe)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ninguem", password: PASSWORD },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_credentials");
  });

  it("payload incompleto → 400", async () => {
    for (const payload of [{}, { username: "admin" }, { username: "admin", password: 123 }]) {
      const res = await app.inject({ method: "POST", url: "/api/auth/login", payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("5 falhas seguidas → 429 too_many_attempts com Retry-After; login correto também bloqueia", async () => {
    for (let i = 0; i < 4; i++) {
      const res = await login("SenhaErrada123");
      expect(res.statusCode, `tentativa ${i + 1}`).toBe(401);
    }
    const fifth = await login("SenhaErrada123");
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json().error).toBe("too_many_attempts");
    expect(fifth.json().retryAfterSec).toBeGreaterThan(0);
    expect(fifth.headers["retry-after"]).toBeDefined();

    // durante o lockout, nem a senha certa entra
    const blocked = await login();
    expect(blocked.statusCode).toBe(429);
  });

  it("rate limit é por IP: outro IP não herda o lockout", async () => {
    for (let i = 0; i < 5; i++) await login("SenhaErrada123");
    const otherIp = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "10.9.8.7",
      payload: { username: "admin", password: PASSWORD },
    });
    expect(otherIp.statusCode).toBe(200);
  });
});

describe("POST /api/auth/logout", () => {
  beforeEach(async () => {
    await createAdmin();
  });

  it("logout invalida a sessão de verdade (me passa a dar 401)", async () => {
    const cookie = sessionCookieOf(await login());
    const out = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect(out.statusCode).toBe(200);

    const meAfter = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(meAfter.statusCode).toBe(401);

    const audit = await ctx.auditService.list();
    expect(audit.entries.some((e) => e.action === "auth.logout")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Troca de senha
// ---------------------------------------------------------------------------

describe("POST /api/auth/change-password", () => {
  beforeEach(async () => {
    await createAdmin();
  });

  it("troca a senha e INVALIDA as outras sessões (a atual sobrevive)", async () => {
    const cookieA = sessionCookieOf(await login());
    const cookieB = sessionCookieOf(
      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: "10.1.1.1",
        payload: { username: "admin", password: PASSWORD },
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie: cookieA },
      payload: { currentPassword: PASSWORD, newPassword: "NovaSenha456" },
    });
    expect(res.statusCode).toBe(200);

    // sessão B (outro dispositivo) morreu; sessão A continua válida
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookieB } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookieA } })).statusCode).toBe(200);

    // senha antiga não entra mais; a nova entra
    expect((await login()).statusCode).toBe(401);
    expect((await login("NovaSenha456")).statusCode).toBe(200);

    const audit = await ctx.auditService.list();
    expect(audit.entries.some((e) => e.action === "auth.password_changed")).toBe(true);
  });

  it("senha atual errada → 401 e senha inalterada", async () => {
    const cookie = sessionCookieOf(await login());
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie },
      payload: { currentPassword: "Errada123", newPassword: "NovaSenha456" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_current_password");
    // continua entrando com a senha original
    expect((await login()).statusCode).toBe(200);
  });

  it("nova senha fraca → 400 weak_password", async () => {
    const cookie = sessionCookieOf(await login());
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie },
      payload: { currentPassword: PASSWORD, newPassword: "fraca" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("weak_password");
  });

  it("sem sessão → 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      payload: { currentPassword: PASSWORD, newPassword: "NovaSenha456" },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Casos de borda das rotas de auth
// ---------------------------------------------------------------------------

describe("POST /api/auth/login — casos de borda", () => {
  beforeEach(async () => {
    await createAdmin();
  });

  // Mudança intencional: com `schema` na rota, corpo ausente é recusado pelo
  // Ajv antes do handler → `invalid_request` (não mais `invalid_payload`).
  it("sem corpo algum → 400 invalid_request", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("user-agent é registrado na sessão criada", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "user-agent": "Mozilla/5.0 Teste" },
      payload: { username: "admin", password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const cookie = sessionCookieOf(res);
    const sessionId = cookie.split("=")[1]!.split(".")[0]!;
    const session = await ctx.sessionStore.resolve(cookie.split("=")[1]);
    expect(session?.userAgent).toBe("Mozilla/5.0 Teste");
    expect(session?.id).toBe(sessionId);
  });
});

describe("GET /api/auth/me — casos de borda", () => {
  it("sessão de usuário que não existe mais → 401 e sessão destruída", async () => {
    await createAdmin();
    // sessão "fantasma": criada direto no store para um userId inexistente
    const ghost = await ctx.sessionStore.create({ id: "fantasma", username: "fantasma" });
    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: `${SESSION_COOKIE}=${ghost.cookieValue}` },
    });
    expect(me.statusCode).toBe(401);
    expect(me.json().error).toBe("unauthorized");
    // a sessão foi revogada de verdade: nem o store a reconhece mais
    expect(await ctx.sessionStore.resolve(ghost.cookieValue)).toBeNull();
  });
});

describe("POST /api/auth/change-password — casos de borda", () => {
  // Mudança intencional: com `schema` na rota, corpo sem os dois campos (ou
  // não-objeto) é recusado pelo Ajv antes do handler → `invalid_request`
  // (não mais `invalid_payload`).
  it("payload inválido → 400 invalid_request", async () => {
    await createAdmin();
    const cookie = sessionCookieOf(await login());
    for (const payload of [{}, { currentPassword: PASSWORD }, null]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/change-password",
        headers: { cookie },
        payload: payload as unknown as Record<string, unknown>,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error).toBe("invalid_request");
    }
  });

  it("sessão de usuário inexistente → 401 (sem tocar na senha) e sessão destruída", async () => {
    await createAdmin();
    const ghost = await ctx.sessionStore.create({ id: "fantasma", username: "fantasma" });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie: `${SESSION_COOKIE}=${ghost.cookieValue}` },
      payload: { currentPassword: PASSWORD, newPassword: "NovaSenha456" },
    });
    expect(res.statusCode).toBe(401);
    // a senha do admin de verdade não mudou
    expect((await login()).statusCode).toBe(200);
    // mesmo padrão de /api/auth/me: sessão órfã é revogada de verdade, não
    // deixada viva até expirar por conta própria.
    expect(await ctx.sessionStore.resolve(ghost.cookieValue)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Middleware: servidor sem setup token e rota fora de /api
// ---------------------------------------------------------------------------

describe("middleware de auth (casos extremos)", () => {
  it("rota fora de /api passa direto pelo guard (não é da API)", async () => {
    app.get("/publica", async () => ({ ok: true }));
    const res = await app.inject({ method: "GET", url: "/publica" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("servidor SEM setup token: rotas protegidas → 503 setup_token_missing", async () => {
    await closeAuthTestApp(ctx);
    ctx = await buildAuthTestApp(null);
    app = ctx.app;
    app.get("/api/protegida", async () => ({ ok: true }));

    const res = await app.inject({ method: "GET", url: "/api/protegida" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("setup_token_missing");
    // mesmo com header de token — não há token configurado para conferir
    const comHeader = await app.inject({
      method: "GET",
      url: "/api/protegida",
      headers: { [SETUP_TOKEN_HEADER]: "qualquer" },
    });
    expect(comHeader.statusCode).toBe(503);
  });

  it("POST /api/setup/admin sem servidor token → 503", async () => {
    await closeAuthTestApp(ctx);
    ctx = await buildAuthTestApp(null);
    app = ctx.app;
    await app.register(setupRoutes);

    const res = await app.inject({
      method: "POST",
      url: "/api/setup/admin",
      payload: { username: "admin", password: PASSWORD },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("setup_token_missing");
  });
});
