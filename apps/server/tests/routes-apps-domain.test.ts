/**
 * routes-apps-domain.test.ts — API de Configurações → Domínio de aplicações
 * e o endereço automático do assistente de projeto.
 *  GET    /api/settings/apps-domain          situação (base, registros a criar, conferência)
 *  POST   /api/settings/apps-domain/verify   confere o DNS e SÓ ENTÃO salva ({ domain })
 *  DELETE /api/settings/apps-domain          remove a base
 *  GET    /api/domains/suggest               endereço automático (apps quando configurado)
 *
 * O serviço é o de verdade; DNS e projetos são dublês.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER, type AppsDomainStatus, type AppsDomainVerifyResponse } from "@paas/core";
import appsDomainRoutes, { buildAppsDomainService } from "../src/routes/apps-domain.js";
import authRoutes from "../src/routes/auth.js";
import domainsRoutes from "../src/routes/domains.js";
import setupRoutes from "../src/routes/setup.js";
import { AppsDomainService } from "../src/services/apps-domain.js";
import { buildAuthTestApp, closeAuthTestApp, sessionCookieOf, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const PASSWORD = "MinhaSenha123";
const IP_HOST = "203-0-113-10.sslip.io";
const PANEL = "painel.example.com";
const BASE = "apps.example.com";

let ctx: AuthTestContext;
let app: FastifyInstance;
let cookie: string;
let dnsAnswer: string[];
let taken: Set<string>;

beforeEach(async () => {
  dnsAnswer = ["203.0.113.10"];
  taken = new Set();
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  app.decorate("config", { ...app.config, panelDomain: IP_HOST } as never);
  const service = new AppsDomainService({
    dataDir: ctx.dir,
    ipAddress: IP_HOST,
    serverIp: "203.0.113.10",
    serverIpv6: null,
    panelHosts: () => [IP_HOST, PANEL],
    domainInUse: async (d) => taken.has(d),
    countUsingBase: async () => 0,
    resolver: { resolve4: vi.fn(async () => dnsAnswer), resolve6: vi.fn(async () => [] as string[]) },
    fallbackResolver: null,
    audit: ctx.auditService,
  });
  await service.init();
  app.decorate("appsDomainService", service);
  await app.register(authRoutes);
  await app.register(setupRoutes);
  await app.register(appsDomainRoutes);
  await app.register(domainsRoutes);
  await app.inject({
    method: "POST",
    url: "/api/setup/admin",
    headers: { [SETUP_TOKEN_HEADER]: TOKEN },
    payload: { username: "admin", password: PASSWORD },
  });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD } });
  cookie = sessionCookieOf(login);
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

function call(method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { cookie, host: IP_HOST },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

describe("autenticação", () => {
  it.each([
    ["GET", "/api/settings/apps-domain"],
    ["POST", "/api/settings/apps-domain/verify"],
    ["DELETE", "/api/settings/apps-domain"],
  ] as const)("%s %s sem sessão: 401", async (method, url) => {
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/settings/apps-domain", () => {
  it("sem base: nada configurado", async () => {
    const res = await call("GET", "/api/settings/apps-domain");
    expect(res.statusCode).toBe(200);
    expect(res.json() as AppsDomainStatus).toMatchObject({ mode: "https", base: null, verified: false, serverIp: "203.0.113.10", records: [] });
  });
});

describe("POST /api/settings/apps-domain/verify", () => {
  it.each([
    [{}, "sem domain"],
    [{ domain: BASE, extra: 1 }, "campo a mais"],
    [{ domain: 123 }, "não é texto"],
    [{ domain: "" }, "vazio"],
    [{ domain: "a".repeat(300) }, "longo demais"],
  ])("schema recusa %j (%s) com 400", async (payload, _motivo) => {
    const res = await call("POST", "/api/settings/apps-domain/verify", payload);
    expect(res.statusCode).toBe(400);
  });

  it("DNS certo: salva e devolve a conferência, os registros e o status", async () => {
    const res = await call("POST", "/api/settings/apps-domain/verify", { domain: "Apps.Example.com" });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as AppsDomainVerifyResponse;
    expect(body.saved).toBe(true);
    expect(body.check.ok).toBe(true);
    expect(body.status).toMatchObject({ base: BASE, verified: true, records: [{ type: "A", name: `*.${BASE}`, value: "203.0.113.10" }] });
    expect((await call("GET", "/api/settings/apps-domain")).json()).toMatchObject({ base: BASE, verified: true });
    await ctx.auditService.flush();
    const { entries } = await ctx.auditService.list(1, 10);
    expect(entries.find((e) => e.action === "apps_domain.set")).toMatchObject({ actor: "admin", target: BASE });
  });

  it("DNS errado: 200 com saved=false e o motivo, nada salvo", async () => {
    dnsAnswer = [];
    const res = await call("POST", "/api/settings/apps-domain/verify", { domain: BASE });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AppsDomainVerifyResponse;
    expect(body.saved).toBe(false);
    expect(body.check.problem).toBe("missing");
    expect(body.status.base).toBeNull();
  });

  it.each([
    ["apps.example.com;rm -rf /", 400, "invalid_domain"],
    ["apps.example.com\nrespond 200", 400, "invalid_domain"],
    ["203.0.113.10", 400, "invalid_domain"],
    ["apps.foo.internal", 400, "reserved_domain"],
    [PANEL, 409, "panel_domain"],
    [IP_HOST, 400, "reserved_domain"],
  ])("base hostil/reservada %j → %i %s", async (domain, status, code) => {
    const res = await call("POST", "/api/settings/apps-domain/verify", { domain });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ error: code });
  });

  it("base já usada por um projeto: 409 domain_in_use", async () => {
    taken.add(BASE);
    const res = await call("POST", "/api/settings/apps-domain/verify", { domain: BASE });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "domain_in_use" });
  });

  it("erro inesperado: 500 sem detalhe interno", async () => {
    vi.spyOn(app.appsDomainService, "verify").mockRejectedValueOnce(new Error("EACCES /data/apps-domain.json"));
    const res = await call("POST", "/api/settings/apps-domain/verify", { domain: BASE });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("EACCES");
  });
});

describe("DELETE /api/settings/apps-domain", () => {
  it("remove; sem base → 409", async () => {
    await call("POST", "/api/settings/apps-domain/verify", { domain: BASE });
    const res = await call("DELETE", "/api/settings/apps-domain");
    expect(res.statusCode).toBe(200);
    expect((res.json() as AppsDomainStatus).base).toBeNull();
    expect((await call("DELETE", "/api/settings/apps-domain")).statusCode).toBe(409);
  });
});

describe("GET /api/domains/suggest com domínio de aplicações", () => {
  it("base verificada: o endereço automático é <projeto>-<sufixo>.<base>, sem IP, e o sslip fica como alternativa de teste", async () => {
    await call("POST", "/api/settings/apps-domain/verify", { domain: BASE });
    const res = await call("GET", "/api/domains/suggest?name=Dev%20Link");
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { auto: string; kind: string; appsBase: string; testAddress: string | null; publicIp: string | null };
    expect(body.auto).toMatch(/^dev-link-[a-z0-9]{5}\.apps\.example\.com$/);
    expect(body.kind).toBe("apps");
    expect(body.appsBase).toBe(BASE);
    expect(body.testAddress).toBe(`dev-link.${IP_HOST}`);
    expect(body.auto).not.toContain("sslip");
    expect((body as unknown as { provisional: string }).provisional).toMatch(/^dev-link-[a-z0-9]{5}\.localhost$/);
  });

  it("nome repetido: cada sugestão traz um provisório novo, diferente do endereço de teste fixo", async () => {
    await call("POST", "/api/settings/apps-domain/verify", { domain: BASE });
    const a = (await call("GET", "/api/domains/suggest?name=loja")).json() as { provisional: string; testAddress: string };
    const b = (await call("GET", "/api/domains/suggest?name=loja")).json() as { provisional: string };
    expect(a.provisional).not.toBe(b.provisional);
    expect(a.provisional).not.toBe(a.testAddress);
  });

  it("base verificada e painel sem sslip: sem endereço de teste, mas com provisório", async () => {
    await call("POST", "/api/settings/apps-domain/verify", { domain: BASE });
    (app.config as { panelDomain: string | null }).panelDomain = "painel.example.com";
    const body = (await call("GET", "/api/domains/suggest?name=loja")).json() as { kind: string; testAddress: string | null; provisional: string };
    expect(body.kind).toBe("apps");
    expect(body.testAddress).toBeNull();
    expect(body.provisional).toMatch(/^loja-[a-z0-9]{5}\.localhost$/);
  });

  it("sem base: continua o sslip de sempre, com o formato antigo da resposta", async () => {
    const res = await call("GET", "/api/domains/suggest?name=Dev%20Link");
    expect(res.json()).toEqual({ auto: `dev-link.${IP_HOST}`, publicIp: "203.0.113.10", panelPublic: true });
  });

  it("panelPublic vem do servidor: painel com domínio público é público; painel em localhost sem IP público não é", async () => {
    (app.config as { panelDomain: string | null }).panelDomain = PANEL;
    expect(((await call("GET", "/api/domains/suggest?name=x")).json() as { panelPublic: boolean }).panelPublic).toBe(true);
    (app.config as { panelDomain: string | null }).panelDomain = "localhost";
    const antes = process.env.PAAS_PUBLIC_IP;
    delete process.env.PAAS_PUBLIC_IP;
    try {
      expect(((await call("GET", "/api/domains/suggest?name=x")).json() as { panelPublic: boolean }).panelPublic).toBe(false);
    } finally {
      if (antes !== undefined) process.env.PAAS_PUBLIC_IP = antes;
    }
  });

  it("com base verificada a resposta também traz panelPublic", async () => {
    await call("POST", "/api/settings/apps-domain/verify", { domain: BASE });
    expect(((await call("GET", "/api/domains/suggest?name=x")).json() as { panelPublic: boolean }).panelPublic).toBe(true);
  });

  it("base salva mas a conferir (VPS com outro IP): volta ao sslip", async () => {
    await call("POST", "/api/settings/apps-domain/verify", { domain: BASE });
    const svc = new AppsDomainService({
      dataDir: ctx.dir,
      ipAddress: IP_HOST,
      serverIp: "198.51.100.1",
      serverIpv6: null,
      panelHosts: () => [],
      domainInUse: async () => false,
      countUsingBase: async () => 0,
      resolver: { resolve4: async () => [], resolve6: async () => [] },
      fallbackResolver: null,
    });
    await svc.init();
    (app.appsDomainService as unknown as { suggest: AppsDomainService["suggest"] }).suggest = svc.suggest.bind(svc);
    const res = await call("GET", "/api/domains/suggest?name=site");
    expect((res.json() as { kind?: string }).kind).toBeUndefined();
    expect((res.json() as { auto: string }).auto).toContain("sslip.io");
  });
});

/** Ligação com o resto do painel (app.ts). */
describe("buildAppsDomainService", () => {
  function fakeApp(over: { publicIp?: string | null; mailHostsFail?: boolean; hostPanel?: boolean } = {}) {
    const deployService = {
      panelHosts: vi.fn(() => [IP_HOST]),
      isPanelHost: vi.fn((d: string) => d === IP_HOST || d === PANEL),
      listProjects: vi.fn(async () => [
        { domain: "loja.example.com", aliases: ["www.loja.example.com"] },
        { domain: "blog-aaaaa.apps.example.com" },
        { domain: "x.example.com", aliases: ["y-bbbbb.apps.example.com"] },
      ]),
      mailHosts: vi.fn(async () => (over.mailHostsFail ? Promise.reject(new Error("sem e-mail")) : ["mail.example.com"])),
    };
    return {
      deployService,
      app: {
        config: { dataDir: ctx.dir, panelDomain: IP_HOST, publicIp: over.publicIp ?? null, publicIpv6: null },
        deployService,
        auditService: ctx.auditService,
        log: { warn: vi.fn() },
      } as unknown as Parameters<typeof buildAppsDomainService>[0],
    };
  }
  const dns = () => ({
    primary: { resolve4: vi.fn(async () => ["203.0.113.10"]), resolve6: vi.fn(async () => [] as string[]) },
    fallback: null,
  });

  it("recusa nomes de projeto, do e-mail e do painel; conta os projetos que usam a base", async () => {
    const f = fakeApp();
    const svc = buildAppsDomainService(f.app, dns());
    await svc.init();
    await expect(svc.verify("www.loja.example.com", "admin")).rejects.toMatchObject({ code: "domain_in_use" });
    await expect(svc.verify("mail.example.com", "admin")).rejects.toMatchObject({ code: "domain_in_use" });
    await expect(svc.verify("sub.mail.example.com", "admin")).resolves.toBeDefined();
    // domínio do painel cadastrado e ainda sem DNS (só reservado) e endereço ativo do painel
    await expect(svc.verify(PANEL, "admin")).rejects.toMatchObject({ statusCode: 409 });
    await expect(svc.verify(IP_HOST, "admin")).rejects.toMatchObject({ statusCode: 400 });
    const ok = await svc.verify(BASE, "admin");
    expect(ok.status.projectsUsingBase).toBe(2);
    expect(ok.status.serverIp).toBe("203.0.113.10");
  });

  it("PAAS_PUBLIC_IP vence; e-mail fora do ar não impede", async () => {
    const f = fakeApp({ publicIp: "198.51.100.20", mailHostsFail: true });
    const svc = buildAppsDomainService(f.app, dns());
    await svc.init();
    expect((await svc.status()).serverIp).toBe("198.51.100.20");
    await expect(svc.verify("apps2.example.com", "admin")).resolves.toBeDefined();
  });

  it("resolvedores padrão quando não informados", async () => {
    const svc = buildAppsDomainService(fakeApp().app);
    await svc.init();
    expect((await svc.status()).base).toBeNull();
  });
});
