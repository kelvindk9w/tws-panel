/**
 * routes-misc-schema.test.ts — validação de schema Fastify nas rotas de
 * domínios, docker, saúde e terminal (WS).
 *
 * Complementa os testes funcionais já existentes (routes-domains.test.ts,
 * routes-health.test.ts, routes-terminal.test.ts): aqui o foco é o CONTRATO
 * de entrada — querystring malformada é recusada em 400 no formato padrão
 * do painel ({ error: "invalid_request", message }), sem chegar ao handler
 * nem a nenhum service externo (DNS, docker, PTY).
 *
 * docker.ts e health.ts não têm entrada nenhuma: os testes aqui só provam
 * que registrar o error handler padronizado não quebra o funcionamento
 * normal das rotas.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";

const { resolve4 } = vi.hoisted(() => ({
  resolve4: vi.fn<(name: string) => Promise<string[]>>(),
}));

vi.mock("node:dns/promises", () => ({
  default: { resolve4 },
}));

import domainsRoutes from "../src/routes/domains.js";
import dockerRoutes from "../src/routes/docker.js";
import healthRoutes from "../src/routes/health.js";
import terminalRoutes from "../src/routes/terminal.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };

let ctx: AuthTestContext;
let app: FastifyInstance;

afterEach(async () => {
  if (ctx) await closeAuthTestApp(ctx);
});

describe("GET /api/domains/check — schema da querystring", () => {
  beforeEach(async () => {
    resolve4.mockReset();
    ctx = await buildAuthTestApp(TOKEN);
    app = ctx.app;
    await app.register(domainsRoutes);
  });

  it("recusa domínio com caractere inválido (não é hostname) sem consultar o DNS", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/domains/check?domain=${encodeURIComponent("app exemplo.com!")}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(resolve4).not.toHaveBeenCalled();
  });

  it("recusa domínio com mais de 253 caracteres", async () => {
    const huge = `${"a".repeat(250)}.com`; // 254 caracteres
    const res = await app.inject({
      method: "GET",
      url: `/api/domains/check?domain=${huge}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(resolve4).not.toHaveBeenCalled();
  });

  it("recusa parâmetro desconhecido na querystring", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/domains/check?domain=app.exemplo.com&foo=bar",
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(resolve4).not.toHaveBeenCalled();
  });

  it("aceita domínio válido normalmente (schema não bloqueia caso legítimo)", async () => {
    resolve4.mockResolvedValue(["203.0.113.10"]);
    const res = await app.inject({
      method: "GET",
      url: "/api/domains/check?domain=app.exemplo.com",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("GET /api/docker/containers — sem entrada", () => {
  beforeEach(async () => {
    ctx = await buildAuthTestApp(TOKEN);
    app = ctx.app;
    await app.register(dockerRoutes);
  });

  it("responde normalmente (error handler padronizado registrado não interfere)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/docker/containers", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().containers)).toBe(true);
  });
});

describe("GET /api/healthz e /api/health/scan — sem entrada", () => {
  beforeEach(async () => {
    ctx = await buildAuthTestApp(TOKEN);
    app = ctx.app;
    await app.register(healthRoutes);
  });

  it("/api/healthz segue público e 200", async () => {
    const res = await app.inject({ method: "GET", url: "/api/healthz" });
    expect(res.statusCode).toBe(200);
  });

  it(
    "/api/health/scan segue funcionando normalmente com o error handler registrado",
    { timeout: 30_000 },
    async () => {
      const res = await app.inject({ method: "GET", url: "/api/health/scan", headers: auth });
      expect(res.statusCode).toBe(200);
    },
  );
});

describe("GET /api/terminal/ws — schema da querystring (handshake)", () => {
  beforeEach(async () => {
    ctx = await buildAuthTestApp(TOKEN);
    app = ctx.app;
    await app.register(terminalRoutes);
  });

  it("recusa clientId com caractere inválido antes do upgrade (400)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/terminal/ws?token=${TOKEN}&clientId=${encodeURIComponent("aba 1!")}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
  });

  it("recusa clientId maior que o limite", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/terminal/ws?token=${TOKEN}&clientId=${"a".repeat(200)}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
  });

  it("recusa parâmetro desconhecido na querystring do handshake", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/terminal/ws?token=${TOKEN}&clientId=aba-1&extra=x`,
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
  });

  it("aceita token e clientId válidos (passa da validação de schema)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/terminal/ws?token=${TOKEN}&clientId=aba-1`,
      headers: auth,
    });
    // Sem upgrade real de WS, a rota responde 404 (comportamento do
    // @fastify/websocket para requisição sem cabeçalhos de upgrade) — o que
    // importa aqui é que NÃO foi 400: o schema aceitou o par válido antes de
    // chegar nessa camada.
    expect(res.statusCode).not.toBe(400);
  });
});
