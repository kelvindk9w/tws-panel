/**
 * Domínios dinâmicos — as rotas chamadas direto, sem o plugin de autenticação e sem a
 * lista de exclusão de token-policy: a segunda trava (`humanOnly`) precisa barrar sozinha
 * uma sessão de token, mesmo de token de painel inteiro com escopo admin. No painel real
 * a lista de exclusão responde primeiro e esconderia uma falha desta conferência.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dynamicDomainsRoutes from "../src/routes/dynamic-domains.js";
import type { Session } from "../src/services/session-store.js";

type Who = "humano" | "token-painel" | "token-projetos" | "token-dominios" | "ninguem";

const SESSIONS: Record<Exclude<Who, "ninguem">, Session> = {
  humano: { id: "s1", userId: "u", username: "kelvin", createdAt: "", expiresAt: "", ip: null, userAgent: null },
  "token-painel": {
    id: "token:t1", userId: "u", username: "token:a", createdAt: "", expiresAt: "", ip: null, userAgent: null,
    token: { id: "t1", scope: "admin", reach: { kind: "panel" } },
  },
  "token-projetos": {
    id: "token:t2", userId: "u", username: "token:b", createdAt: "", expiresAt: "", ip: null, userAgent: null,
    token: { id: "t2", scope: "write", reach: { kind: "projects", ids: ["p1"], canCreate: false } },
  },
  "token-dominios": {
    id: "token:t3", userId: "u", username: "token:c", createdAt: "", expiresAt: "", ip: null, userAgent: null,
    token: { id: "t3", scope: "write", reach: { kind: "domains", ids: ["p1"] } },
  },
};

const service = {
  view: vi.fn(async () => ({ usage: { names: 0, issuancesLastHour: 0 } })),
  add: vi.fn(async (_id: string, host: string) => ({ created: true, item: { host } })),
  setSuffixes: vi.fn(async () => []),
  limits: vi.fn(async () => ({ maxNamesPerProject: 500, maxIssuancesPerHour: 20, maxIssuancesPerWeekPerDomain: 40 })),
  setLimits: vi.fn(async () => undefined),
};

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  app = Fastify();
  app.decorateRequest("session", null);
  app.addHook("onRequest", async (request) => {
    const who = request.headers["x-quem"] as Who | undefined;
    request.session = who && who !== "ninguem" ? SESSIONS[who] : null;
  });
  app.decorate("dynamicDomains", service as never);
  await app.register(dynamicDomainsRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

const call = (method: "GET" | "PUT" | "POST", url: string, who: Who, payload?: object) =>
  app.inject({ method, url, headers: { "x-quem": who }, ...(payload ? { payload } : {}) });

describe("humanOnly: sufixos e tetos nunca por token (segunda trava)", () => {
  it.each<Who>(["token-painel", "token-projetos", "token-dominios", "ninguem"])("sessão %s é barrada nas três rotas, sem tocar no serviço", async (who) => {
    const responses = [
      await call("PUT", "/api/projects/p1/dynamic-domains/suffixes", who, { suffixes: [{ suffix: "clientes.example", openAll: false }] }),
      await call("GET", "/api/settings/dynamic-domains", who),
      await call("PUT", "/api/settings/dynamic-domains", who, { maxIssuancesPerHour: 5 }),
    ];
    for (const r of responses) {
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe("token_forbidden");
    }
    expect(service.setSuffixes).not.toHaveBeenCalled();
    expect(service.limits).not.toHaveBeenCalled();
    expect(service.setLimits).not.toHaveBeenCalled();
  });

  it("a pessoa (sessão de cookie) passa", async () => {
    expect((await call("PUT", "/api/projects/p1/dynamic-domains/suffixes", "humano", { suffixes: [] })).statusCode).toBe(200);
    expect((await call("GET", "/api/settings/dynamic-domains", "humano")).statusCode).toBe(200);
    expect((await call("PUT", "/api/settings/dynamic-domains", "humano", { maxIssuancesPerWeekPerDomain: 30 })).statusCode).toBe(200);
    expect(service.setLimits).toHaveBeenCalledWith({ maxIssuancesPerWeekPerDomain: 30 });
  });
});

describe("contador global e aviso", () => {
  it("token de um projeto só não vê o contador do servidor; a pessoa e o token de painel veem", async () => {
    await call("GET", "/api/projects/p1/dynamic-domains", "token-dominios");
    await call("GET", "/api/projects/p1/dynamic-domains", "token-projetos");
    await call("GET", "/api/projects/p1/dynamic-domains", "humano");
    await call("GET", "/api/projects/p1/dynamic-domains", "token-painel");
    const hide = service.view.mock.calls.map((c) => (c as unknown as [string, object, { hideGlobalUsage: boolean }])[2].hideGlobalUsage);
    expect(hide).toEqual([true, true, false, false]);
  });

  it("cadastrar um nome de terminação reservada avisa sem recusar; nome comum não traz aviso", async () => {
    const reserved = await call("POST", "/api/projects/p1/dynamic-domains", "humano", { host: "app.cliente.example" });
    expect(reserved.statusCode).toBe(201);
    expect(reserved.json().warning).toBe("reserved_tld");
    const common = await call("POST", "/api/projects/p1/dynamic-domains", "humano", { host: "app.cliente.com.br" });
    expect(common.json().warning).toBeUndefined();
  });
});
