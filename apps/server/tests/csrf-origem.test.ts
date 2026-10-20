/**
 * csrf-origem.test.ts — lote 7, achado M1.
 *
 * O `sslip.io` não está na lista de sufixos públicos: qualquer `*.sslip.io`
 * conta como "mesmo site" do painel e o navegador manda o cookie de sessão
 * (SameSite=Lax não ajuda). A defesa é o servidor recusar escrita cujo pedido
 * o navegador marca como vindo de outro site/origem — antes de qualquer rota.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "@paas/core";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const HOST = "painel.exemplo.com";
let ctx: AuthTestContext;
let app: FastifyInstance;
let cookie: string;
let executou: number;

beforeEach(async () => {
  ctx = await buildAuthTestApp("token-de-teste");
  app = ctx.app;
  executou = 0;
  app.post("/api/muda-estado", async () => {
    executou += 1;
    return { ok: true };
  });
  app.get("/api/le-estado", async () => ({ ok: true }));
  app.delete("/api/apaga", async () => {
    executou += 1;
    return { ok: true };
  });
  await ctx.setupState.complete();
  const user = await ctx.userStore.create("admin", "hash-qualquer");
  const created = await ctx.sessionStore.create(user, { ip: "1.1.1.1", userAgent: null });
  cookie = `${SESSION_COOKIE}=${created.cookieValue}`;
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

function post(headers: Record<string, string>, url = "/api/muda-estado") {
  return app.inject({ method: "POST", url, headers: { host: HOST, cookie, ...headers } });
}

describe("escrita vinda de outro site é recusada (M1)", () => {
  it.each([
    ["Sec-Fetch-Site: same-site (outro *.sslip.io)", { "sec-fetch-site": "same-site" }],
    ["Sec-Fetch-Site: cross-site", { "sec-fetch-site": "cross-site" }],
    ["Origin de outro host", { origin: "https://6-6-6-6.sslip.io" }],
    ["Origin: null", { origin: "null" }],
    ["Origin malformado", { origin: "lixo" }],
    ["Sec-Fetch-Site de valor desconhecido", { "sec-fetch-site": "qualquer-coisa" }],
    ["Origin igual, mas Sec-Fetch-Site same-site", { origin: `https://${HOST}`, "sec-fetch-site": "same-site" }],
  ])("POST com %s → 403 e a rota nem executa", async (_nome, headers) => {
    const res = await post(headers);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden_origin");
    expect(executou).toBe(0);
  });

  it("DELETE e login também passam pela mesma guarda", async () => {
    const del = await app.inject({
      method: "DELETE",
      url: "/api/apaga",
      headers: { host: HOST, cookie, "sec-fetch-site": "same-site" },
    });
    expect(del.statusCode).toBe(403);
    expect(executou).toBe(0);
    const login = await post({ "sec-fetch-site": "cross-site" }, "/api/auth/login");
    expect(login.statusCode).toBe(403);
  });

  it("a recusa vale mesmo sem sessão (login CSRF) e com rota inexistente", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/nao-existe",
      headers: { host: HOST, "sec-fetch-site": "cross-site" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("o que continua passando", () => {
  it.each([
    ["Sec-Fetch-Site: same-origin", { "sec-fetch-site": "same-origin" }],
    ["Sec-Fetch-Site: none (digitado/atalho)", { "sec-fetch-site": "none" }],
    ["Origin igual ao host do painel", { origin: `https://${HOST}` }],
    ["Origin igual, com Sec-Fetch-Site same-origin", { origin: `https://${HOST}`, "sec-fetch-site": "same-origin" }],
    ["cliente sem cabeçalho de navegador (curl, scripts)", {}],
  ])("POST com %s → 200", async (_nome, headers) => {
    const res = await post(headers);
    expect(res.statusCode).toBe(200);
    expect(executou).toBe(1);
  });

  it("leitura (GET) vinda de outro site não é barrada: CSRF é sobre escrita", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/le-estado",
      headers: { host: HOST, cookie, "sec-fetch-site": "cross-site" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("fora de /api/ a guarda não se aplica", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/fora",
      headers: { host: HOST, "sec-fetch-site": "cross-site" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("ALLOWED_ORIGINS", () => {
  it("origem extra liberada pelo operador passa; outras continuam barradas", async () => {
    const apps = await buildAuthTestApp("token-de-teste");
    try {
      apps.app.decorate("config", { allowedOrigins: ["https://outro.exemplo.com"] } as never);
      apps.app.post("/api/muda-estado", async () => ({ ok: true }));
      await apps.setupState.complete();
      const user = await apps.userStore.create("admin", "x");
      const c = await apps.sessionStore.create(user, { ip: "1.1.1.1", userAgent: null });
      const headers = { host: HOST, cookie: `${SESSION_COOKIE}=${c.cookieValue}` };
      const liberada = await apps.app.inject({
        method: "POST",
        url: "/api/muda-estado",
        headers: { ...headers, origin: "https://outro.exemplo.com", "sec-fetch-site": "cross-site" },
      });
      expect(liberada.statusCode).toBe(200);
      const barrada = await apps.app.inject({
        method: "POST",
        url: "/api/muda-estado",
        headers: { ...headers, origin: "https://atacante.exemplo.com", "sec-fetch-site": "cross-site" },
      });
      expect(barrada.statusCode).toBe(403);
    } finally {
      await closeAuthTestApp(apps);
    }
  });
});
