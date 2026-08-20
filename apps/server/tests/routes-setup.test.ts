/**
 * Testes das rotas de setup (/api/setup/*) contra uma app Fastify real
 * (inject, sem rede): verificação de token, auth do wizard e persistência do
 * avanço de passo — sempre verificando o ESTADO resultante, não só o status.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import setupAuthPlugin from "../src/plugins/setup-auth.js";
import setupRoutes from "../src/routes/setup.js";
import { SETUP_STEPS, SetupStateStore } from "../src/services/setup-state.js";

const TOKEN = "token-de-teste";

let app: FastifyInstance;
let store: SetupStateStore;
let dir: string;

async function buildTestApp(setupToken: string | null = TOKEN): Promise<void> {
  dir = await mkdtemp(path.join(tmpdir(), "paas-routes-setup-"));
  store = new SetupStateStore(dir);
  app = Fastify({ logger: false });
  app.decorate("setupToken", setupToken);
  app.decorate("setupState", store);
  await app.register(setupAuthPlugin);
  await app.register(setupRoutes);
}

afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("POST /api/setup/verify-token", () => {
  beforeEach(() => buildTestApp());

  it("token correto → valid: true", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/verify-token",
      payload: { token: TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: true });
  });

  it("token errado ou ausente → valid: false (sem 401 — é endpoint público)", async () => {
    for (const payload of [{ token: "errado" }, {}, { token: 123 }]) {
      const res = await app.inject({ method: "POST", url: "/api/setup/verify-token", payload });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ valid: false });
    }
  });

  it("servidor sem token configurado → 503 setup_token_missing", async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
    await buildTestApp(null);
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/verify-token",
      payload: { token: TOKEN },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("setup_token_missing");
  });
});

describe("GET /api/setup/status", () => {
  beforeEach(() => buildTestApp());

  it("sem token → 401; com token → estado e passos do wizard", async () => {
    const unauthorized = await app.inject({ method: "GET", url: "/api/setup/status" });
    expect(unauthorized.statusCode).toBe(401);

    const res = await app.inject({
      method: "GET",
      url: "/api/setup/status",
      headers: { [SETUP_TOKEN_HEADER]: TOKEN },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state.currentStep).toBe(0);
    expect(body.steps).toEqual(SETUP_STEPS);
  });

  it("aceita o token também via query string (?token=)", async () => {
    const res = await app.inject({ method: "GET", url: `/api/setup/status?token=${TOKEN}` });
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /api/setup/advance", () => {
  beforeEach(() => buildTestApp());

  it("avança o passo e PERSISTE o novo estado no disco", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/setup/advance",
      headers: { [SETUP_TOKEN_HEADER]: TOKEN },
      payload: { step: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().state.currentStep).toBe(2);
    // resultado real: o store em disco reflete o avanço
    expect((await store.load()).currentStep).toBe(2);
  });

  it("passo inválido → 400 e estado inalterado", async () => {
    for (const step of [-1, 99, 1.5, "dois", null]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/setup/advance",
        headers: { [SETUP_TOKEN_HEADER]: TOKEN },
        payload: { step },
      });
      expect(res.statusCode, JSON.stringify(step)).toBe(400);
      expect(res.json().error).toBe("invalid_step");
    }
    expect((await store.load()).currentStep).toBe(0);
  });

  it("sem token → 401 e estado inalterado", async () => {
    const res = await app.inject({ method: "POST", url: "/api/setup/advance", payload: { step: 1 } });
    expect(res.statusCode).toBe(401);
    expect((await store.load()).currentStep).toBe(0);
  });
});
