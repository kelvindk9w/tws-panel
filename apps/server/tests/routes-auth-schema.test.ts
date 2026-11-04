/**
 * Validação de schema das rotas de autenticação (/api/auth/*).
 *
 * Sem `schema` no Fastify essas rotas aceitam qualquer corpo e a checagem
 * fica só a cargo do handler — fácil de esquecer um campo ou deixar passar
 * um payload gigante. Estes testes fixam o contrato: corpo malformado é
 * recusado com 400 `invalid_request` (formato padrão do painel, via
 * registerErrorHandler) e o store correspondente nunca chega a ser
 * consultado.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";
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
  await app.register(authRoutes);
  await app.register(setupRoutes);
  const created = await app.inject({
    method: "POST",
    url: "/api/setup/admin",
    headers: auth,
    payload: { username: "admin", password: PASSWORD },
  });
  if (created.statusCode !== 201) {
    throw new Error(`falha ao preparar admin de teste: ${created.statusCode} ${created.body}`);
  }
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

async function login(password = PASSWORD) {
  return app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "admin", password },
  });
}

describe("POST /api/auth/login — schema", () => {
  it("recusa corpo sem username/password sem consultar o userStore", async () => {
    const spy = vi.spyOn(ctx.userStore, "findByUsername");
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(spy).not.toHaveBeenCalled();
  });

  it("recusa tipo errado em password sem consultar o userStore", async () => {
    const spy = vi.spyOn(ctx.userStore, "findByUsername");
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: 123 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(spy).not.toHaveBeenCalled();
  });

  it("recusa senha vazia", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("recusa propriedade desconhecida no corpo", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: PASSWORD, isAdmin: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("recusa senha maior que o limite de tamanho (defesa contra payload gigante)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "a".repeat(100_000) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("aceita corpo válido e segue até a checagem de credenciais", async () => {
    // credenciais corretas: prova que o corpo passou da validação de schema
    const res = await login();
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /api/auth/change-password — schema", () => {
  it("recusa corpo sem currentPassword/newPassword sem trocar a senha", async () => {
    const cookie = sessionCookieOf(await login());
    const spy = vi.spyOn(ctx.userStore, "updatePassword");
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(spy).not.toHaveBeenCalled();
  });

  it("recusa tipo errado em newPassword", async () => {
    const cookie = sessionCookieOf(await login());
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie },
      payload: { currentPassword: PASSWORD, newPassword: 123 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("recusa propriedade desconhecida no corpo", async () => {
    const cookie = sessionCookieOf(await login());
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie },
      payload: { currentPassword: PASSWORD, newPassword: "NovaSenha456", isAdmin: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("aceita corpo válido e segue até a checagem de senha atual", async () => {
    const cookie = sessionCookieOf(await login());
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie },
      payload: { currentPassword: PASSWORD, newPassword: "NovaSenha456" },
    });
    expect(res.statusCode).toBe(200);
  });
});
