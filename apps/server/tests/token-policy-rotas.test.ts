/**
 * token-policy-rotas.test.ts — TODA rota /api/* do painel real tem uma
 * classificação conhecida para tokens de API (leitura, escrita, admin ou
 * proibida). Rota nova sem decisão aqui reprova: ninguém ganha acesso por token
 * por esquecimento.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyRoute, scopeCovers, DENIED_ROUTES, ADMIN_ROUTES } from "../src/services/token-policy.js";
import { EXPECTED_ROUTE_ACCESS } from "./token-policy-table.js";

const registered = vi.hoisted(() => new Set<string>());

vi.mock("fastify", async (importOriginal) => {
  const real = await importOriginal<typeof import("fastify")>();
  const wrapped = (opts?: Parameters<typeof real.default>[0]) => {
    const app = real.default(opts as never);
    app.addHook("onRoute", (route) => {
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) registered.add(`${method} ${route.url}`);
    });
    return app;
  };
  return { ...real, default: wrapped };
});

const saved: Record<string, string | undefined> = {};
let dir = "";

beforeEach(async () => {
  vi.resetModules();
  dir = await mkdtemp(path.join(tmpdir(), "paas-policy-"));
  await writeFile(path.join(dir, "setup-token"), "token-de-teste");
  for (const [k, v] of Object.entries({
    PAAS_DATA_DIR: dir,
    SETUP_TOKEN_FILE: path.join(dir, "setup-token"),
    PAAS_PUBLIC_IP: "203.0.113.10",
    LOG_LEVEL: "silent",
  })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(dir, { recursive: true, force: true });
});

describe("classificação de todas as rotas da API para token", () => {
  it("as rotas registradas no painel real são exatamente as da tabela, com a mesma classificação", async () => {
    registered.clear();
    const { buildApp } = await import("../src/app.js");
    const app = await buildApp();
    try {
      await app.ready();
    } finally {
      await app.close();
    }
    const apiRoutes = [...registered]
      .filter((r) => r.split(" ")[1]!.startsWith("/api/") && !r.startsWith("HEAD ") && !r.startsWith("OPTIONS "))
      .sort();
    expect(apiRoutes).toEqual(Object.keys(EXPECTED_ROUTE_ACCESS).sort());
    for (const route of apiRoutes) {
      const [method, pattern] = route.split(" ") as [string, string];
      const got = classifyRoute(method, pattern);
      expect(got.kind === "denied" ? "denied" : got.scope, route).toBe(EXPECTED_ROUTE_ACCESS[route]);
    }
  }, 60_000);
});

describe("classifyRoute", () => {
  it("sem padrão de rota ou fora de /api/: nega (fecha por omissão)", () => {
    expect(classifyRoute("GET", undefined).kind).toBe("denied");
    expect(classifyRoute("GET", "/").kind).toBe("denied");
    expect(classifyRoute("GET", "/assets/app.js").kind).toBe("denied");
  });

  it("por método: GET e HEAD leem, o resto escreve", () => {
    expect(classifyRoute("GET", "/api/projects")).toEqual({ kind: "scope", scope: "read" });
    expect(classifyRoute("head", "/api/projects")).toEqual({ kind: "scope", scope: "read" });
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(classifyRoute(m, "/api/projects")).toEqual({ kind: "scope", scope: "write" });
    }
  });

  it("HEAD vale as mesmas listas do GET (não é uma porta lateral)", () => {
    expect(classifyRoute("HEAD", "/api/mail/mailboxes/:id/credentials").kind).toBe("denied");
    expect(classifyRoute("HEAD", "/api/fs/dirs")).toEqual({ kind: "scope", scope: "admin" });
    expect(classifyRoute("HEAD", "/api/integrations/github/repos").kind).toBe("denied");
  });

  it("a exclusão vale para qualquer método e vence a lista de admin", () => {
    for (const m of ["GET", "POST", "PUT", "DELETE", "PATCH"]) {
      expect(classifyRoute(m, "/api/terminal/ws").kind).toBe("denied");
      expect(classifyRoute(m, "/api/terminal/info").kind).toBe("denied");
      expect(classifyRoute(m, "/api/settings/restart-setup").kind).toBe("denied");
      expect(classifyRoute(m, "/api/settings/api-tokens").kind).toBe("denied");
      expect(classifyRoute(m, "/api/settings/api-tokens/:id").kind).toBe("denied");
      expect(classifyRoute(m, "/api/auth/change-password").kind).toBe("denied");
      expect(classifyRoute(m, "/api/projects/:id/env").kind).toBe("denied");
    }
  });

  it("prefixo '/*' cobre o que vem depois, mas não um irmão de nome parecido", () => {
    expect(classifyRoute("GET", "/api/terminal/qualquer/coisa").kind).toBe("denied");
    expect(classifyRoute("GET", "/api/terminals")).toEqual({ kind: "scope", scope: "read" });
    expect(classifyRoute("POST", "/api/security/plan")).toEqual({ kind: "scope", scope: "admin" });
    expect(classifyRoute("GET", "/api/security/scan")).toEqual({ kind: "scope", scope: "read" });
  });

  it("'!GET' do domínio do painel: ler é leitura, mudar é admin", () => {
    expect(classifyRoute("GET", "/api/settings/panel-domain")).toEqual({ kind: "scope", scope: "read" });
    expect(classifyRoute("PUT", "/api/settings/panel-domain")).toEqual({ kind: "scope", scope: "admin" });
    expect(classifyRoute("DELETE", "/api/settings/apps-domain")).toEqual({ kind: "scope", scope: "admin" });
  });

  it("toda regra das duas listas tem motivo e está exercida pela tabela", () => {
    for (const rule of [...DENIED_ROUTES, ...ADMIN_ROUTES]) expect(rule.reason, rule.pattern).toBeTruthy();
    const keys = Object.keys(EXPECTED_ROUTE_ACCESS);
    for (const rule of DENIED_ROUTES) {
      // regras do plugin que não existem como rota (login/logout do cookie existem; o prefixo cobre o resto)
      const hit = keys.some((k) => {
        const [m, p] = k.split(" ") as [string, string];
        return (rule.method === "*" || rule.method === m) && (rule.pattern.endsWith("/*") ? p.startsWith(rule.pattern.slice(0, -1)) : p === rule.pattern);
      });
      expect(hit, `${rule.method} ${rule.pattern}`).toBe(true);
    }
  });
});

describe("scopeCovers", () => {
  it("admin cobre write e read; write cobre read; read só read", () => {
    expect(scopeCovers("admin", "admin") && scopeCovers("admin", "write") && scopeCovers("admin", "read")).toBe(true);
    expect(scopeCovers("write", "write") && scopeCovers("write", "read")).toBe(true);
    expect(scopeCovers("write", "admin")).toBe(false);
    expect(scopeCovers("read", "read")).toBe(true);
    expect(scopeCovers("read", "write")).toBe(false);
    expect(scopeCovers("read", "admin")).toBe(false);
  });
});
