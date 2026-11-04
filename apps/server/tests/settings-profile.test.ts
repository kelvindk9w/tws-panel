/**
 * settings-profile.test.ts — Configurações → Perfil: nome de exibição,
 * e-mail e usuário de login. Trocar o usuário de login muda o que se digita
 * no login: exige a senha atual e fica na auditoria. A sessão atual continua.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("nome de exibição salva sem senha; o e-mail pede a senha; os dois aparecem no /me", async () => {
    const res = await put({ displayName: "Kelvin Medeiros", email: "kelvin@exemplo.com", currentPassword: PASSWORD });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().user).toMatchObject({ username: "admin", displayName: "Kelvin Medeiros", email: "kelvin@exemplo.com" });
    expect((await me()).user.displayName).toBe("Kelvin Medeiros");
  });

  it("apagar o nome ou o e-mail (texto vazio) volta a null", async () => {
    await put({ displayName: "Kelvin", email: "kelvin@exemplo.com", currentPassword: PASSWORD });
    const res = await put({ displayName: "", email: "", currentPassword: PASSWORD });
    expect(res.json().user).toMatchObject({ displayName: null, email: null });
  });

  it("trocar ou apagar o e-mail sem a senha (ou com a errada) é recusado e nada muda", async () => {
    const sem = await put({ email: "atacante@example.net" });
    expect(sem.statusCode).toBe(401);
    expect(sem.json().error).toBe("invalid_current_password");
    const errada = await put({ email: "atacante@example.net", currentPassword: "errada" });
    expect(errada.statusCode).toBe(401);
    expect((await me()).user.email).toBeNull();
    // só o nome não pede senha
    expect((await put({ displayName: "Só o nome" })).statusCode).toBe(200);
  });

  it("trocar o e-mail avisa o endereço ANTIGO; sem e-mail antigo não há a quem avisar", async () => {
    const sent: Array<{ to: string; text: string }> = [];
    ctx.emailCode.setMailer({
      readiness: async () => ({ ready: true, reason: null, from: "postmaster@example.com" }),
      send: async (m) => void sent.push({ to: m.to, text: m.text }),
      isHostedAddress: async () => false,
    });
    const primeiro = await put({ email: "dono@example.com", currentPassword: PASSWORD });
    expect(primeiro.statusCode, primeiro.body).toBe(200);
    expect(primeiro.json().alertWarning).toBeUndefined();
    await ctx.emailCode.idle();
    expect(sent).toHaveLength(0);
    const troca = await put({ email: "novo@example.net", currentPassword: PASSWORD });
    expect(troca.statusCode, troca.body).toBe(200);
    await ctx.emailCode.idle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("dono@example.com");
    expect(sent[0]!.text).toMatch(/e-mail do perfil trocado para n\*\*\*@example\.net/);
    const apagar = await put({ email: "", currentPassword: PASSWORD });
    expect(apagar.statusCode).toBe(200);
    await ctx.emailCode.idle();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.to).toBe("novo@example.net");
    expect(sent[1]!.text).toMatch(/e-mail do perfil removido/);
  });

  it("se o aviso ao endereço antigo não puder sair, a resposta diz e a auditoria registra (a troca vale)", async () => {
    await put({ email: "dono@example.com", currentPassword: PASSWORD });
    ctx.emailCode.setMailer({
      readiness: async () => ({ ready: false, reason: "sem SMTP", from: null }),
      send: async () => undefined,
      isHostedAddress: async () => false,
    });
    const troca = await put({ email: "novo@example.net", currentPassword: PASSWORD });
    expect(troca.statusCode).toBe(200);
    expect(troca.json().alertWarning).toMatch(/Alerta por e-mail não enviado: o envio de e-mail do painel não está pronto \(sem SMTP\)/);
    expect((await me()).user.email).toBe("novo@example.net");
    await vi.waitFor(async () => expect(JSON.stringify(await ctx.auditService.list())).toContain("auth.access_alert_skipped"));
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
