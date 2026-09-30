/**
 * settings-preferences.test.ts — preferências de interface da conta
 * (Configurações → Aparência). A primeira: onde fica o menu de navegação —
 * topo (padrão), lateral esquerda ou lateral direita. Guardada no servidor,
 * com a conta: vale em qualquer computador e chega junto com /api/auth/me,
 * antes de o painel ser desenhado (sem piscar no formato errado).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
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

function put(payload: unknown, withCookie = true) {
  return app.inject({
    method: "PUT",
    url: "/api/settings/preferences",
    headers: withCookie ? { cookie } : {},
    payload: payload as Record<string, unknown>,
  });
}

describe("preferências de interface", () => {
  it("conta nova: /api/auth/me traz o menu no topo (o formato de sempre)", async () => {
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.json().preferences).toEqual({ navLayout: "top" });
  });

  it("trocar para a lateral esquerda: responde, grava em disco e o /me passa a trazer", async () => {
    const res = await put({ navLayout: "left" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ preferences: { navLayout: "left" } });
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.json().preferences.navLayout).toBe("left");
    const raw = JSON.parse(await readFile(path.join(ctx.dir, "users.json"), "utf8")) as {
      users: Array<{ preferences?: unknown }>;
    };
    expect(raw.users[0]!.preferences).toEqual({ navLayout: "left" });
  });

  it("valor fora da lista ou campo desconhecido → 400, nada muda", async () => {
    expect((await put({ navLayout: "bottom" })).statusCode).toBe(400);
    expect((await put({ navLayout: "left", cor: "azul" })).statusCode).toBe(400);
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.json().preferences.navLayout).toBe("top");
  });

  it("sem sessão → 401", async () => {
    expect((await put({ navLayout: "right" }, false)).statusCode).toBe(401);
  });
});
