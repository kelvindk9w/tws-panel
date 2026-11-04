/**
 * Validação de schema das rotas de setup (/api/setup/*).
 *
 * Sem `schema` no Fastify essas rotas aceitam qualquer corpo e a checagem
 * fica só a cargo do handler. Estes testes fixam o contrato: corpo malformado
 * é recusado com 400 `invalid_request` (formato padrão do painel, via
 * registerErrorHandler) e o store correspondente nunca chega a ser tocado.
 *
 * Exceção: POST /api/setup/verify-token é público e tolera corpo sem `token`
 * (retorna `valid: false`, não erro) — isso é regra de negócio preexistente
 * e não muda aqui. O schema apenas garante que, quando presente, `token` é
 * string dentro de um limite de tamanho.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import setupRoutes from "../src/routes/setup.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };

let ctx: AuthTestContext;
let app: FastifyInstance;

beforeEach(async () => {
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  await app.register(setupRoutes);
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

describe("POST /api/setup/verify-token — schema", () => {
  it("aceita corpo sem token (regra de negócio: valid: false, não erro de schema)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/setup/verify-token", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: false });
  });

  it("recusa tipo errado em token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/verify-token",
      payload: { token: 123 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("recusa token maior que o limite de tamanho (defesa contra payload gigante)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/verify-token",
      payload: { token: "a".repeat(10_000) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("recusa propriedade desconhecida no corpo", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/verify-token",
      payload: { token: TOKEN, extra: "x" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });
});

describe("POST /api/setup/advance — schema", () => {
  it("recusa corpo sem step, sem persistir estado", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/advance",
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect((await ctx.setupState.load()).currentStep).toBe(0);
  });

  it("recusa step fora da faixa válida do wizard", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/advance",
      headers: auth,
      payload: { step: 99 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect((await ctx.setupState.load()).currentStep).toBe(0);
  });

  it("recusa propriedade desconhecida no corpo", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/advance",
      headers: auth,
      payload: { step: 1, force: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("aceita step válido", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/advance",
      headers: auth,
      payload: { step: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().state.currentStep).toBe(2);
  });
});

describe("POST /api/setup/admin — schema", () => {
  it("recusa corpo sem username/password sem criar usuário", async () => {
    const spy = vi.spyOn(ctx.userStore, "create");
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/admin",
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(spy).not.toHaveBeenCalled();
    expect(await ctx.userStore.hasAdmin()).toBe(false);
  });

  it("recusa tipo errado em password sem criar usuário", async () => {
    const spy = vi.spyOn(ctx.userStore, "create");
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/admin",
      headers: auth,
      payload: { username: "admin", password: 123 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(spy).not.toHaveBeenCalled();
  });

  it("recusa propriedade desconhecida no corpo", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/admin",
      headers: auth,
      payload: { username: "admin", password: "SenhaForte123456", role: "root" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("aceita corpo válido e cria o admin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/admin",
      headers: auth,
      payload: { username: "admin", password: "SenhaForte123456" },
    });
    expect(res.statusCode).toBe(201);
  });
});
