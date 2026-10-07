/**
 * routes-panel-domain.test.ts — API de Configurações → Domínio do painel.
 *  GET    /api/settings/panel-domain              situação (com o endereço por onde a página foi aberta)
 *  PUT    /api/settings/panel-domain              cadastrar/trocar o domínio
 *  DELETE /api/settings/panel-domain              remover (o IP volta)
 *  POST   /api/settings/panel-domain/verify       conferir o DNS (certo → domínio entra no proxy)
 *  POST   /api/settings/panel-domain/disable-ip   desativar o acesso pelo IP (Host = domínio novo + digitar o domínio)
 *  POST   /api/settings/panel-domain/enable-ip    reativar o acesso pelo IP
 *
 * O serviço é o de verdade; proxy, certificado e DNS são dublês.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER, type CertificateItem, type PanelDomainStatus } from "@paas/core";
import authRoutes from "../src/routes/auth.js";
import panelDomainRoutes, { buildPanelDomainService } from "../src/routes/panel-domain.js";
import setupRoutes from "../src/routes/setup.js";
import { PanelDomainService } from "../src/services/panel-domain.js";
import { buildAuthTestApp, closeAuthTestApp, sessionCookieOf, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const PASSWORD = "MinhaSenha123";
const IP_HOST = "203-0-113-10.sslip.io";
const DOMAIN = "painel.exemplo.com.br";

let ctx: AuthTestContext;
let app: FastifyInstance;
let cookie: string;
let certValid: boolean;
let applied: Array<{ primary: string; aliases: string[] }>;

beforeEach(async () => {
  certValid = false;
  applied = [];
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  const service = new PanelDomainService({
    dataDir: ctx.dir,
    ipAddress: IP_HOST,
    serverIp: "203.0.113.10",
    serverIpv6: null,
    hostRepoDir: "/opt/tws-panel",
    applyAddresses: async (site) => {
      applied.push(site);
    },
    setReserved: () => undefined,
    certificate: async (host) =>
      ({
        host,
        owner: { kind: "panel", projectId: null, projectName: null },
        mode: "automatic",
        coveredBy: null,
        state: certValid ? "valid" : "issuing",
        issuer: null,
        validTo: null,
        renewsAround: null,
        lastError: null,
        manual: null,
        canRetry: !certValid,
      }) satisfies CertificateItem,
    domainInUse: async () => false,
    resolver: { resolve4: vi.fn(async () => ["203.0.113.10"]), resolve6: vi.fn(async () => []) },
    fallbackResolver: null,
    audit: ctx.auditService,
  });
  await service.init();
  app.decorate("panelDomainService", service);
  await app.register(authRoutes);
  await app.register(setupRoutes);
  await app.register(panelDomainRoutes);
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

function call(method: "GET" | "PUT" | "POST" | "DELETE", url: string, opts: { payload?: unknown; host?: string } = {}) {
  return app.inject({
    method,
    url,
    headers: { cookie, host: opts.host ?? IP_HOST },
    ...(opts.payload !== undefined ? { payload: opts.payload as Record<string, unknown> } : {}),
  });
}

async function activate(): Promise<void> {
  expect((await call("PUT", "/api/settings/panel-domain", { payload: { domain: DOMAIN } })).statusCode).toBe(200);
  expect((await call("POST", "/api/settings/panel-domain/verify")).statusCode).toBe(200);
}

describe("autenticação", () => {
  it("sem sessão: 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/settings/panel-domain" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/settings/panel-domain", () => {
  it("situação com o endereço por onde a página foi aberta (Host)", async () => {
    const res = await call("GET", "/api/settings/panel-domain");
    expect(res.statusCode).toBe(200);
    const s = res.json() as PanelDomainStatus;
    expect(s.ipAddress).toBe(IP_HOST);
    expect(s.openedVia).toBe("ip");
    expect(s.currentHost).toBe(IP_HOST);
    expect(s.reactivateCommand).toMatch(/reativar-acesso-ip\.sh/);
  });

  it("Host com porta: compara só o nome", async () => {
    const s = (await call("GET", "/api/settings/panel-domain", { host: `${IP_HOST}:443` })).json() as PanelDomainStatus;
    expect(s.currentHost).toBe(IP_HOST);
  });
});

describe("PUT /api/settings/panel-domain", () => {
  it.each([
    [{}, "sem domain"],
    [{ domain: DOMAIN, extra: 1 }, "campo a mais"],
    [{ domain: 123 }, "não é texto"],
    [{ domain: "a".repeat(300) }, "longo demais"],
  ])("schema recusa %j (%s) com 400", async (payload, _motivo) => {
    const res = await call("PUT", "/api/settings/panel-domain", { payload });
    expect(res.statusCode).toBe(400);
  });

  it("domínio inválido: 400 com a explicação do serviço", async () => {
    const res = await call("PUT", "/api/settings/panel-domain", { payload: { domain: "203.0.113.10" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_domain" });
  });

  it("cadastra e devolve a situação; a auditoria registra quem fez", async () => {
    const res = await call("PUT", "/api/settings/panel-domain", { payload: { domain: DOMAIN } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as PanelDomainStatus).domain).toBe(DOMAIN);
    await ctx.auditService.flush();
    const { entries } = await ctx.auditService.list(1, 10);
    expect(entries.find((e) => e.action === "panel_domain.set")).toMatchObject({ actor: "admin", target: DOMAIN });
  });
});

describe("verify / disable-ip / enable-ip / DELETE", () => {
  it("verify devolve a conferência do DNS e a situação nova", async () => {
    await call("PUT", "/api/settings/panel-domain", { payload: { domain: DOMAIN } });
    const res = await call("POST", "/api/settings/panel-domain/verify");
    expect(res.statusCode).toBe(200);
    const body = res.json() as { check: { ok: boolean }; status: PanelDomainStatus };
    expect(body.check.ok).toBe(true);
    expect(body.status.addresses).toEqual([DOMAIN, IP_HOST]);
  });

  it("verify sem domínio: 409", async () => {
    const res = await call("POST", "/api/settings/panel-domain/verify");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "no_domain" });
  });

  it("disable-ip: body sem confirm → 400; página aberta pelo IP → 409 com o motivo", async () => {
    await activate();
    certValid = true;
    expect((await call("POST", "/api/settings/panel-domain/disable-ip", { payload: {}, host: DOMAIN })).statusCode).toBe(400);
    const res = await call("POST", "/api/settings/panel-domain/disable-ip", { payload: { confirm: DOMAIN } });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { message: string }).message).toContain(`https://${DOMAIN}`);
  });

  it("disable-ip aberto pelo domínio novo, com certificado e o domínio digitado → só o domínio responde; enable-ip volta", async () => {
    await activate();
    certValid = true;
    const off = await call("POST", "/api/settings/panel-domain/disable-ip", { payload: { confirm: DOMAIN }, host: DOMAIN });
    expect(off.statusCode, off.body).toBe(200);
    expect((off.json() as PanelDomainStatus).addresses).toEqual([DOMAIN]);
    expect(applied.at(-1)).toEqual({ primary: DOMAIN, aliases: [] });
    const on = await call("POST", "/api/settings/panel-domain/enable-ip", { host: DOMAIN });
    expect(on.statusCode).toBe(200);
    expect((on.json() as PanelDomainStatus).addresses).toEqual([DOMAIN, IP_HOST]);
  });

  it("DELETE remove o domínio; sem domínio → 409", async () => {
    await activate();
    const res = await call("DELETE", "/api/settings/panel-domain");
    expect(res.statusCode).toBe(200);
    expect((res.json() as PanelDomainStatus).domain).toBeNull();
    expect((await call("DELETE", "/api/settings/panel-domain")).statusCode).toBe(409);
  });

  it("erro inesperado do proxy: 500 sem detalhe interno", async () => {
    await call("PUT", "/api/settings/panel-domain", { payload: { domain: DOMAIN } });
    const service = app.panelDomainService;
    vi.spyOn(service, "verify").mockRejectedValueOnce(new Error("docker: socket /var/run/docker.sock"));
    const res = await call("POST", "/api/settings/panel-domain/verify");
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("docker.sock");
  });
});

/**
 * Ligação com o resto do painel (app.ts): proxy pelo deployService, nomes
 * em uso por projetos e pelo e-mail, certificado pela página Certificados.
 */
describe("buildPanelDomainService", () => {
  function fakeApp(over: { publicIp?: string | null; mailHostsFail?: boolean } = {}) {
    const deployService = {
      setPanelAddresses: vi.fn(),
      setPanelReserved: vi.fn(),
      refreshProxy: vi.fn(async () => undefined),
      listProjects: vi.fn(async () => [
        { domain: "loja.exemplo.com.br", aliases: ["www.loja.exemplo.com.br"] },
        { domain: "x.exemplo.com.br" },
      ]),
      mailHosts: vi.fn(async () => (over.mailHostsFail ? Promise.reject(new Error("sem e-mail")) : ["mail.exemplo.com.br"])),
    };
    const certificateService = {
      list: vi.fn(async ({ host }: { host: string }) => ({ items: host === DOMAIN ? [{ host, state: "valid" }] : [] })),
    };
    return {
      deployService,
      app: {
        config: {
          dataDir: ctx.dir,
          panelDomain: IP_HOST,
          publicIp: over.publicIp ?? null,
          publicIpv6: null,
          hostRepoDir: "/opt/tws-panel",
        },
        deployService,
        certificateService,
        auditService: ctx.auditService,
        log: { warn: vi.fn() },
      } as unknown as Parameters<typeof buildPanelDomainService>[0],
    };
  }
  const dns = () => ({
    primary: { resolve4: vi.fn(async () => ["203.0.113.10"]), resolve6: vi.fn(async () => [] as string[]) },
    fallback: null,
  });

  it("IP do registro A vem do endereço sslip.io; proxy só recarrega quando muda; recusa nomes de projeto e do e-mail", async () => {
    const f = fakeApp();
    const svc = buildPanelDomainService(f.app, dns());
    await svc.init();
    expect(f.deployService.setPanelAddresses).toHaveBeenCalledWith({ primary: IP_HOST, aliases: [] });
    expect(f.deployService.refreshProxy).not.toHaveBeenCalled();
    expect((await svc.status(IP_HOST)).serverIp).toBe("203.0.113.10");
    await expect(svc.setDomain("www.loja.exemplo.com.br", "admin")).rejects.toMatchObject({ code: "domain_in_use" });
    await expect(svc.setDomain("mail.exemplo.com.br", "admin")).rejects.toMatchObject({ code: "domain_in_use" });
    await svc.setDomain(DOMAIN, "admin");
    expect(f.deployService.setPanelReserved).toHaveBeenLastCalledWith([DOMAIN]);
    await svc.verify("admin", IP_HOST);
    expect(f.deployService.refreshProxy).toHaveBeenCalledTimes(1);
    expect((await svc.status(IP_HOST)).certificate).toMatchObject({ host: DOMAIN, state: "valid" });
  });

  it("PAAS_PUBLIC_IP vence; e-mail fora do ar não impede cadastrar", async () => {
    const f = fakeApp({ publicIp: "198.51.100.20", mailHostsFail: true });
    const svc = buildPanelDomainService(f.app, dns());
    await svc.init();
    expect((await svc.status(IP_HOST)).serverIp).toBe("198.51.100.20");
    await expect(svc.setDomain(DOMAIN, "admin")).resolves.toMatchObject({ domain: DOMAIN });
  });

  it("certificado sem item (nome ainda não servido) → null; resolvedores padrão quando não informados", async () => {
    const f = fakeApp();
    const svc = buildPanelDomainService(f.app);
    await svc.init();
    await svc.setDomain("acesso.exemplo.com.br", "admin");
    expect((await svc.status(IP_HOST)).certificate).toBeNull();
  });
});
