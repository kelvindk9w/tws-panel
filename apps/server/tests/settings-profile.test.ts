/**
 * settings-profile.test.ts — Configurações → Perfil: nome de exibição,
 * e-mail e usuário de login. Trocar o usuário de login muda o que se digita
 * no login: exige a senha atual e fica na auditoria. A sessão atual continua.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import authRoutes from "../src/routes/auth.js";
import settingsRoutes from "../src/routes/settings.js";
import setupRoutes from "../src/routes/setup.js";
import { buildAuthTestApp, closeAuthTestApp, sessionCookieOf, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const PASSWORD = "MinhaSenha123";
let ctx: AuthTestContext;
let app: FastifyInstance;
let cookie: string;

beforeEach(async () => {
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  await app.register(authRoutes);
  await app.register(setupRoutes);
  await app.register(settingsRoutes);
  await app.inject({
    method: "POST",
    url: "/api/setup/admin",
    headers: { [SETUP_TOKEN_HEADER]: TOKEN },
    payload: { username: "admin", password: PASSWORD },
  });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD } });
  cookie = sessionCookieOf(login);
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

function put(payload: Record<string, unknown>) {
  return app.inject({ method: "PUT", url: "/api/settings/profile", headers: { cookie }, payload });
}

async function me() {
  return (await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).json();
}

describe("Configurações → Perfil", () => {
  it("conta nova: sem nome de exibição nem e-mail", async () => {
    expect((await me()).user).toMatchObject({ username: "admin", displayName: null, email: null });
  });

  it("nome de exibição e e-mail: salvam sem pedir senha e aparecem no /me", async () => {
    const res = await put({ displayName: "Kelvin Medeiros", email: "kelvin@exemplo.com" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().user).toMatchObject({ username: "admin", displayName: "Kelvin Medeiros", email: "kelvin@exemplo.com" });
    expect((await me()).user.displayName).toBe("Kelvin Medeiros");
  });

  it("apagar o nome ou o e-mail (texto vazio) volta a null", async () => {
    await put({ displayName: "Kelvin", email: "kelvin@exemplo.com" });
    const res = await put({ displayName: "", email: "" });
    expect(res.json().user).toMatchObject({ displayName: null, email: null });
  });

  it("e-mail inválido → 400 e nada muda", async () => {
    const res = await put({ email: "não é e-mail" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_email");
    expect((await me()).user.email).toBeNull();
  });

  it("trocar o usuário de login exige a senha atual", async () => {
    const sem = await put({ username: "kelvin" });
    expect(sem.statusCode).toBe(400);
    expect(sem.json().error).toBe("current_password_required");
    const errada = await put({ username: "kelvin", currentPassword: "OutraSenha999" });
    expect(errada.statusCode).toBe(401);
    expect((await me()).user.username).toBe("admin");
  });

  it("com a senha certa: troca, a sessão atual segue valendo, o login passa a ser com o nome novo e fica na auditoria", async () => {
    const res = await put({ username: "kelvin", currentPassword: PASSWORD });
    expect(res.statusCode, res.body).toBe(200);
    expect((await me()).user.username).toBe("kelvin");
    const novo = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "kelvin", password: PASSWORD } });
    expect(novo.statusCode).toBe(200);
    const antigo = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD } });
    expect(antigo.statusCode).toBe(401);
    const audit = await ctx.auditService.list();
    expect(audit.entries.some((e) => e.action === "auth.username_changed")).toBe(true);
  });

  it("usuário de login inválido → 400", async () => {
    const res = await put({ username: "a b", currentPassword: PASSWORD });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_username");
  });

  it("sem sessão → 401", async () => {
    const res = await app.inject({ method: "PUT", url: "/api/settings/profile", payload: { displayName: "x" } });
    expect(res.statusCode).toBe(401);
  });
});
