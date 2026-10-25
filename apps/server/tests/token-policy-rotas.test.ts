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
import { checkReach, classifyRoute, classifyRules, projectOfTarget, reachOfRoute, refineAccess, scopeCovers, DENIED_ROUTES, ADMIN_ROUTES } from "../src/services/token-policy.js";
import { EXPECTED_ROUTE_ACCESS, EXPECTED_ROUTE_REACH } from "../src/services/token-policy-table.js";

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
    // a dimensão "alcance" cobre exatamente as mesmas rotas (rota nova sem decisão de alcance reprova)
    expect(Object.keys(EXPECTED_ROUTE_REACH).sort()).toEqual(apiRoutes);
    for (const route of apiRoutes) {
      const [method, pattern] = route.split(" ") as [string, string];
      const got = classifyRoute(method, pattern);
      expect(got.kind === "denied" ? "denied" : got.scope, route).toBe(EXPECTED_ROUTE_ACCESS[route]);
      // as regras sozinhas (sem a tabela) dão a mesma resposta: tabela e regras não divergem
      const rules = classifyRules(method, pattern);
      expect(rules, route).toEqual(got);
    }
  }, 60_000);
});

describe("classifyRoute", () => {
  it("sem padrão de rota ou fora de /api/: nega (fecha por omissão)", () => {
    expect(classifyRoute("GET", undefined).kind).toBe("denied");
    expect(classifyRoute("GET", "/").kind).toBe("denied");
    expect(classifyRoute("GET", "/assets/app.js").kind).toBe("denied");
  });

  it("rota fora da tabela é negada em execução, qualquer método (falha fechada)", () => {
    for (const m of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
      expect(classifyRoute(m, "/api/rota-nova-sem-decisao"), m).toEqual({
        kind: "denied",
        reason: "rota ainda sem classificação para tokens",
      });
    }
    // existe na tabela só com outro método: o método novo também é negado
    expect(classifyRoute("DELETE", "/api/projects").kind).toBe("denied");
    expect(classifyRoute("GET", "/api/projects")).toEqual({ kind: "scope", scope: "read" });
    expect(classifyRoute("HEAD", "/api/projects")).toEqual({ kind: "scope", scope: "read" });
  });

  it("por método: GET e HEAD leem, o resto escreve", () => {
    expect(classifyRules("GET", "/api/projects")).toEqual({ kind: "scope", scope: "read" });
    expect(classifyRules("head", "/api/projects")).toEqual({ kind: "scope", scope: "read" });
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(classifyRules(m, "/api/projects/:id/stop")).toEqual({ kind: "scope", scope: "write" });
    }
  });

  it("HEAD vale as mesmas listas do GET (não é uma porta lateral)", () => {
    expect(classifyRules("HEAD", "/api/mail/mailboxes/:id/credentials").kind).toBe("denied");
    expect(classifyRules("HEAD", "/api/fs/dirs")).toEqual({ kind: "scope", scope: "admin" });
    expect(classifyRules("HEAD", "/api/integrations/github/repos").kind).toBe("denied");
  });

  it("a exclusão vale para qualquer método e vence a lista de admin", () => {
    for (const m of ["GET", "POST", "PUT", "DELETE", "PATCH"]) {
      expect(classifyRules(m, "/api/terminal/ws").kind).toBe("denied");
      expect(classifyRules(m, "/api/terminal/info").kind).toBe("denied");
      expect(classifyRules(m, "/api/settings/restart-setup").kind).toBe("denied");
      expect(classifyRules(m, "/api/settings/api-tokens").kind).toBe("denied");
      expect(classifyRules(m, "/api/settings/api-tokens/:id").kind).toBe("denied");
      expect(classifyRules(m, "/api/auth/change-password").kind).toBe("denied");
      expect(classifyRules(m, "/api/projects/:id/env").kind).toBe("denied");
    }
  });

  it("prefixo '/*' cobre o que vem depois, mas não um irmão de nome parecido", () => {
    expect(classifyRules("GET", "/api/terminal/qualquer/coisa").kind).toBe("denied");
    expect(classifyRules("GET", "/api/terminals")).toEqual({ kind: "scope", scope: "read" });
    expect(classifyRules("POST", "/api/security/plan")).toEqual({ kind: "scope", scope: "admin" });
    expect(classifyRules("GET", "/api/security/scan")).toEqual({ kind: "scope", scope: "read" });
  });

  it("'!GET' do domínio do painel: ler é leitura, mudar é admin", () => {
    expect(classifyRules("GET", "/api/settings/panel-domain")).toEqual({ kind: "scope", scope: "read" });
    expect(classifyRules("PUT", "/api/settings/panel-domain")).toEqual({ kind: "scope", scope: "admin" });
    expect(classifyRules("DELETE", "/api/settings/apps-domain")).toEqual({ kind: "scope", scope: "admin" });
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

describe("refineAccess (campos, parâmetros e consulta apertam, nunca afrouxam)", () => {
  const patch = (body: unknown) => refineAccess(classifyRoute("PATCH", "/api/projects/:id"), "PATCH", "/api/projects/:id", { body });
  const admin = { kind: "scope", scope: "admin" };

  it("PATCH do projeto: repositório, branch, domínio ou proxy exigem admin; nome e websocket seguem como escrita", () => {
    for (const body of [{ source: "x" }, { branch: "b" }, { domain: "d" }, { proxyService: "s" }, { proxyService: null }, { proxyPort: 1 }, { proxyPort: null }]) {
      expect(patch(body), JSON.stringify(body)).toEqual(admin);
    }
    expect(patch({ name: "Novo", websocket: true })).toEqual({ kind: "scope", scope: "write" });
    expect(patch(undefined)).toEqual({ kind: "scope", scope: "write" });
    expect(patch("texto")).toEqual({ kind: "scope", scope: "write" });
  });

  it("restaurar o alvo panel é proibido; os outros alvos seguem admin", () => {
    const base = classifyRoute("POST", "/api/backups/targets/:target/restore");
    const r = (target: string) => refineAccess(base, "POST", "/api/backups/targets/:target/restore", { params: { target } });
    expect(r("panel").kind).toBe("denied");
    expect(r("email")).toEqual(admin);
    expect(r("project:abc")).toEqual(admin);
  });

  it("testar acesso ao Git com token digitado ou da conta é proibido; sem token segue escrita", () => {
    const base = classifyRoute("POST", "/api/projects/check-git-access");
    const r = (body: unknown) => refineAccess(base, "POST", "/api/projects/check-git-access", { body });
    expect(r({ source: "https://exemplo.test/a.git", token: "x" }).kind).toBe("denied");
    expect(r({ source: "https://exemplo.test/a.git", token: "" }).kind).toBe("denied");
    expect(r({ source: "https://exemplo.test/a.git", useAccount: true }).kind).toBe("denied");
    expect(r({ source: "https://exemplo.test/a.git", useAccount: false })).toEqual({ kind: "scope", scope: "write" });
    expect(r({ source: "https://exemplo.test/a.git" })).toEqual({ kind: "scope", scope: "write" });
  });

  it("varredura de segurança nova (fresh) exige admin; a em cache segue leitura", () => {
    const base = classifyRoute("GET", "/api/security/scan");
    const r = (query: unknown) => refineAccess(base, "GET", "/api/security/scan", { query });
    expect(r({ fresh: "1" })).toEqual(admin);
    expect(r({ fresh: "0" })).toEqual({ kind: "scope", scope: "read" });
    expect(r({})).toEqual({ kind: "scope", scope: "read" });
    expect(r(undefined)).toEqual({ kind: "scope", scope: "read" });
  });

  it("nunca afrouxa: proibida continua proibida", () => {
    const denied = classifyRoute("PUT", "/api/projects/:id/env");
    expect(refineAccess(denied, "PUT", "/api/projects/:id/env", { body: {} })).toBe(denied);
  });

  it("tudo que muda a exposição à internet (domínios, portas, webmail) é admin; ler continua leitura", () => {
    const admin = { kind: "scope", scope: "admin" };
    for (const [m, p] of [
      ["POST", "/api/projects/:id/domains"],
      ["DELETE", "/api/projects/:id/domains/:domain"],
      ["POST", "/api/projects/:id/domains/:domain/primary"],
      ["PUT", "/api/projects/:id/domains/:domain/port"],
      ["PUT", "/api/projects/:id/domains/:domain/pair"],
      ["PUT", "/api/projects/:id/ports"],
      ["PUT", "/api/projects/:id/ports/batch"],
      ["POST", "/api/mail/webmail/enable"],
      ["POST", "/api/mail/webmail/disable"],
    ] as const) {
      expect(classifyRoute(m, p), `${m} ${p}`).toEqual(admin);
    }
    expect(classifyRoute("GET", "/api/projects/:id/domains/pairs")).toEqual({ kind: "scope", scope: "read" });
    expect(classifyRoute("GET", "/api/projects/:id/ports")).toEqual({ kind: "scope", scope: "read" });
  });

  it("e-mail dos projetos (links), chave DQS e destinos de aviso: classificação fixa", () => {
    expect(classifyRoute("PUT", "/api/projects/:id/email/links").kind).toBe("denied");
    expect(classifyRoute("PUT", "/api/mail/envios/reputation/dqs").kind).toBe("denied");
    expect(classifyRoute("POST", "/api/projects")).toEqual(admin);
    for (const [m, p] of [["PUT", "/api/notifications/email"], ["DELETE", "/api/notifications/email"], ["DELETE", "/api/notifications/telegram"], ["POST", "/api/notifications/telegram/connect"]] as const) {
      expect(classifyRoute(m, p), `${m} ${p}`).toEqual(admin);
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

describe("alcance por projeto (Fase 0b)", () => {
  const ids = { kind: "projects", ids: ["aaaa", "bbbb"], canCreate: false } as const;
  const creator = { kind: "projects", ids: ["aaaa"], canCreate: true } as const;
  const panel = { kind: "panel" } as const;

  it("rota fora da tabela, sem padrão ou HEAD: alcance do painel (fecha) / HEAD vale o GET", () => {
    expect(reachOfRoute("GET", undefined)).toBe("panel");
    expect(reachOfRoute("GET", "/api/rota-nova-sem-decisao")).toBe("panel");
    expect(reachOfRoute("DELETE", "/api/projects")).toBe("panel");
    expect(reachOfRoute("HEAD", "/api/projects/:id")).toBe("project");
    expect(reachOfRoute("post", "/api/projects")).toBe("create");
  });

  it("toda rota de alcance 'project' tem o parâmetro :id e toda de 'target' tem :target", () => {
    for (const [route, reach] of Object.entries(EXPECTED_ROUTE_REACH)) {
      if (reach === "project") expect(route, route).toMatch(/:id(\/|$)/);
      if (reach === "target") expect(route, route).toContain(":target");
    }
  });

  it("rotas do painel/servidor nunca estão marcadas como de projeto (lista fixa do que o token limitado pode alcançar)", () => {
    const allowed = Object.entries(EXPECTED_ROUTE_REACH)
      .filter(([, reach]) => reach !== "panel")
      .map(([route]) => route)
      .sort();
    for (const route of allowed) {
      const pattern = route.split(" ")[1]!;
      expect(
        pattern.startsWith("/api/projects") ||
          pattern.startsWith("/api/backups/projects/") ||
          pattern.startsWith("/api/backups/targets/") ||
          ["/api/backups/records/:id", "/api/domains/check", "/api/domains/suggest", "/api/auth/me", "/api/healthz", "/api/version", "/api/metrics/host", "/api/metrics/summary"].includes(pattern),
        route,
      ).toBe(true);
    }
    // a lista exata de e-mail/domínio/segurança/usuários/configurações/terminal continua de painel
    for (const route of Object.keys(EXPECTED_ROUTE_REACH)) {
      const pattern = route.split(" ")[1]!;
      if (/^\/api\/(mail|security|settings|auth\/(2fa|login|logout|change-password)|terminal|setup|notifications|integrations|certificates|alerts|audit|onboarding|fs|timezone|restore-reconciliation|docker|ports|health\/scan|metrics\/settings)/.test(pattern)) {
        expect(EXPECTED_ROUTE_REACH[route], route).toBe("panel");
      }
    }
  });

  it("token de painel inteiro passa por qualquer alcance", () => {
    for (const r of ["panel", "project", "target", "scoped", "create", "host", "open"] as const) {
      expect(checkReach(panel, r, { id: "zzzz" }), r).toEqual({ kind: "allow" });
    }
  });

  it("limitado: rota do painel é 403; aberta e 'scoped' passam; criar só com 'pode criar'", () => {
    expect(checkReach(ids, "panel", {}).kind).toBe("forbidden");
    expect(checkReach(ids, "open", {})).toEqual({ kind: "allow" });
    expect(checkReach(ids, "scoped", {})).toEqual({ kind: "allow" });
    expect(checkReach(ids, "create", {}).kind).toBe("forbidden");
    expect(checkReach(creator, "create", {})).toEqual({ kind: "allow" });
  });

  it("monitoramento da VPS: as duas rotas de leitura são 'host'; retenção é do painel e proibida a token; do projeto é 'project'", () => {
    expect(Object.entries(EXPECTED_ROUTE_REACH).filter(([, r]) => r === "host").map(([k]) => k).sort()).toEqual(["GET /api/metrics/host", "GET /api/metrics/summary"]);
    expect(EXPECTED_ROUTE_REACH["GET /api/metrics/settings"]).toBe("panel");
    expect(EXPECTED_ROUTE_REACH["PUT /api/metrics/settings"]).toBe("panel");
    expect(EXPECTED_ROUTE_ACCESS["PUT /api/metrics/settings"]).toBe("denied");
    expect(EXPECTED_ROUTE_REACH["GET /api/projects/:id/metrics"]).toBe("project");
    for (const k of ["GET /api/metrics/host", "GET /api/metrics/summary", "GET /api/metrics/settings", "GET /api/projects/:id/metrics"]) expect(EXPECTED_ROUTE_ACCESS[k]).toBe("read");
  });

  it("limitado: projeto da lista passa; fora dela, ausente ou de tipo estranho é 404", () => {
    expect(checkReach(ids, "project", { id: "bbbb" })).toEqual({ kind: "allow" });
    expect(checkReach(ids, "project", { id: "cccc" })).toEqual({ kind: "not_found" });
    expect(checkReach(ids, "project", {})).toEqual({ kind: "not_found" });
    expect(checkReach(ids, "project", undefined)).toEqual({ kind: "not_found" });
    expect(checkReach(ids, "project", { id: ["aaaa"] })).toEqual({ kind: "not_found" });
    expect(checkReach(ids, "project", { id: "AAAA" })).toEqual({ kind: "not_found" });
  });

  it("limitado: alvo de backup project:<id> segue a lista; panel, email e lixo são do painel (403)", () => {
    expect(checkReach(ids, "target", { target: "project:aaaa" })).toEqual({ kind: "allow" });
    expect(checkReach(ids, "target", { target: "project:cccc" })).toEqual({ kind: "not_found" });
    for (const target of ["panel", "email", "project:", "projectaaaa", undefined, 5]) {
      expect(checkReach(ids, "target", { target }).kind, String(target)).toBe("forbidden");
    }
    expect(projectOfTarget("project:abc")).toBe("abc");
    expect(projectOfTarget("project:")).toBeNull();
    expect(projectOfTarget("panel")).toBeNull();
  });

  it("limitado: criar projeto só de repositório remoto e nunca trocar a fonte; painel inteiro segue como era", () => {
    const base = classifyRoute("POST", "/api/projects");
    const create = (body: unknown, reach: Parameters<typeof refineAccess>[4]) => refineAccess(base, "POST", "/api/projects", { body }, reach);
    expect(create({ ingestMode: "git" }, ids)).toEqual({ kind: "scope", scope: "admin" });
    for (const mode of ["upload", "existing", undefined, 5]) {
      expect(create({ ingestMode: mode }, ids).kind, String(mode)).toBe("denied");
    }
    expect(create({ ingestMode: "existing" }, panel)).toEqual({ kind: "scope", scope: "admin" });
    expect(create({ ingestMode: "existing" }, undefined)).toEqual({ kind: "scope", scope: "admin" });

    const patchBase = classifyRoute("PATCH", "/api/projects/:id");
    const patch = (body: unknown, reach: Parameters<typeof refineAccess>[4]) => refineAccess(patchBase, "PATCH", "/api/projects/:id", { body }, reach);
    expect(patch({ source: "https://example.com/a.git" }, ids).kind).toBe("denied");
    expect(patch({ source: "https://example.com/a.git" }, panel)).toEqual({ kind: "scope", scope: "admin" });
    expect(patch({ domain: "app.example.com" }, ids)).toEqual({ kind: "scope", scope: "admin" });
    expect(patch({ name: "x" }, ids)).toEqual({ kind: "scope", scope: "write" });
  });
});
