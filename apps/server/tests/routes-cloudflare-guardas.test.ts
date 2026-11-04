/**
 * routes-cloudflare-guardas.test.ts — as travas das rotas da Cloudflare que a política de tokens normalmente
 * barra antes (segunda trava: sessão de token nunca administra a integração), o ator padrão da auditoria
 * e o comportamento diante de erro inesperado do serviço (500, sem vazar detalhe).
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AJV_OPTIONS } from "../src/ajv-options.js";
import cloudflareRoutes from "../src/routes/cloudflare.js";

let app: FastifyInstance;
let actors: Array<string | undefined>;
let mode: "token" | "anonymous-name";

beforeEach(async () => {
  actors = [];
  mode = "token";
  app = Fastify({ logger: false, ajv: AJV_OPTIONS });
  app.decorateRequest("session", null as never);
  app.addHook("onRequest", async (request) => {
    (request as unknown as { session: unknown }).session = mode === "token" ? { token: "t1" } : { id: "s1" };
  });
  const stub = {
    status: async () => ({ connected: true }),
    zoneNames: async () => ["example.com"],
    desired: async () => [],
    plan: async () => {
      throw new Error("falha interna com detalhe");
    },
    apply: async (_d: unknown, _i: unknown, _l: string, actor?: string) => {
      actors.push(actor);
      return { results: [], created: 0, updated: 0, skipped: 0, failed: 0 };
    },
  };
  app.decorate("cloudflareDns", stub as never);
  await app.register(cloudflareRoutes);
});

afterEach(async () => {
  await app.close();
});

const scope = { kind: "hosts", hosts: ["a.example.com"] };

describe("guardas das rotas da Cloudflare", () => {
  it("sessão de token de API recebe 403 em todas as rotas", async () => {
    const calls: Array<[string, string, object | undefined]> = [
      ["GET", "/api/integrations/cloudflare", undefined],
      ["PUT", "/api/integrations/cloudflare", { token: "x", currentPassword: "y" }],
      ["POST", "/api/integrations/cloudflare/disconnect", { currentPassword: "y" }],
      ["GET", "/api/integrations/cloudflare/zones", undefined],
      ["POST", "/api/integrations/cloudflare/dns/plan", { scope }],
      ["POST", "/api/integrations/cloudflare/dns/apply", { scope, items: [] }],
    ];
    for (const [method, url, payload] of calls) {
      const res = await app.inject({ method: method as "GET", url, ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error).toBe("token_forbidden");
    }
  });

  it("sessão humana sem nome de usuário: a auditoria usa o ator 'admin'", async () => {
    mode = "anonymous-name";
    const res = await app.inject({ method: "POST", url: "/api/integrations/cloudflare/dns/apply", payload: { scope, items: [] } });
    expect(res.statusCode).toBe(200);
    expect(actors).toEqual(["admin"]);
  });

  it("erro inesperado do serviço vira 500 sem repetir o detalhe interno", async () => {
    mode = "anonymous-name";
    const res = await app.inject({ method: "POST", url: "/api/integrations/cloudflare/dns/plan", payload: { scope } });
    expect(res.statusCode).toBe(500);
  });

  it("itens do apply com campo extra ou status inventado são recusados (400)", async () => {
    mode = "anonymous-name";
    const base = { id: "a", status: "create", fingerprint: "f" };
    for (const item of [{ ...base, extra: 1 }, { ...base, status: "qualquer" }, { id: "a", status: "create" }]) {
      const res = await app.inject({ method: "POST", url: "/api/integrations/cloudflare/dns/apply", payload: { scope, items: [item] } });
      expect(res.statusCode).toBe(400);
    }
  });
});
