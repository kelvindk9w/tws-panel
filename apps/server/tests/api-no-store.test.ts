/**
 * api-no-store.test.ts — lote 7, I3 (parte do cache): nenhuma resposta da API
 * (ex.: GET /api/projects/:id/env, que devolve valores de variáveis) pode
 * ficar guardada em cache do navegador ou de proxy.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

let ctx: AuthTestContext;

beforeEach(async () => {
  ctx = await buildAuthTestApp("token-de-teste");
  ctx.app.get("/api/projects/abc/env", async () => ({ values: { SEGREDO: "x" } }));
  ctx.app.get("/api/com-cache", async (_req, reply) => {
    reply.header("cache-control", "private, max-age=5");
    return { ok: true };
  });
  ctx.app.get("/fora-da-api", async () => "ok");
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

const auth = { [SETUP_TOKEN_HEADER]: "token-de-teste" };

describe("Cache-Control nas respostas da API", () => {
  it("resposta de /api/* sai com no-store, inclusive o 401", async () => {
    const ok = await ctx.app.inject({ method: "GET", url: "/api/projects/abc/env", headers: auth });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["cache-control"]).toBe("no-store");
    const negado = await ctx.app.inject({ method: "GET", url: "/api/projects/abc/env" });
    expect(negado.statusCode).toBe(401);
    expect(negado.headers["cache-control"]).toBe("no-store");
  });

  it("quem já definiu o próprio Cache-Control o mantém", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/com-cache", headers: auth });
    expect(res.headers["cache-control"]).toBe("private, max-age=5");
  });

  it("fora de /api/ (arquivos do site) o cache não é alterado", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/fora-da-api" });
    expect(res.headers["cache-control"]).toBeUndefined();
  });
});
