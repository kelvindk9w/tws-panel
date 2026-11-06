/**
 * Rotas do certificado do servidor de e-mail e do aviso de MX existente.
 *
 * Validação real (01/10/2026): o Stalwart rodava com autoassinado e o app do
 * projeto recusaria a conexão; e o dono do produto ia cadastrar o domínio
 * principal da empresa (MX em outro provedor). Aqui: o proxy passa a
 * conhecer os hosts de e-mail (para o Caddy emitir o certificado), o estado
 * do certificado tem rota própria, e o 409 do MX chega à interface com o
 * servidor atual e a sugestão de subdomínio.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { SETUP_TOKEN_HEADER, MAIL_DEFAULT_PORTS, type MailDomainSummary } from "@paas/core";
import mailRoutes from "../src/routes/mail.js";
import { MailService } from "../src/services/mail-service.js";
import { httpError } from "../src/services/http-error.js";
import type { ServerConfig } from "../src/config.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };

const SUMMARY: MailDomainSummary = {
  name: "envio.exemplo.com",
  dkimSelector: "paas",
  dkimPublicKey: "abc",
  dkimKeyBits: 2048,
  dmarcStage: "none",
  createdAt: new Date().toISOString(),
  mailboxCount: 1,
  lastVerify: null,
};

let ctx: AuthTestContext;
let app: FastifyInstance;
let deployService: Record<string, ReturnType<typeof vi.fn>>;
const spies: MockInstance[] = [];

function spyOn<M extends keyof MailService>(method: M) {
  const spy = vi.spyOn(MailService.prototype, method as never) as unknown as MockInstance;
  spies.push(spy);
  return spy;
}

beforeEach(async () => {
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  app.decorate("config", {
    dataDir: ctx.dir,
    mailPorts: { ...MAIL_DEFAULT_PORTS },
    mailHostname: null,
    publicIp: null,
    publicIpv6: null,
    panelDomain: null,
  } as unknown as ServerConfig);
  deployService = {
    setEnvProvider: vi.fn(),
    setMailHostsProvider: vi.fn(),
    refreshProxy: vi.fn(async () => undefined),
    getProject: vi.fn(),
  };
  app.decorate("deployService", deployService as unknown as FastifyInstance["deployService"]);
  await app.register(mailRoutes);
});

afterEach(async () => {
  for (const s of spies.splice(0)) s.mockRestore();
  await closeAuthTestApp(ctx);
});

describe("ligação com o proxy", () => {
  it("o proxy pergunta ao módulo de e-mail quais mail.<domínio> servir", async () => {
    expect(deployService.setMailHostsProvider).toHaveBeenCalledOnce();
    const provider = deployService.setMailHostsProvider!.mock.calls[0]![0] as () => Promise<string[]>;
    spyOn("mailHosts").mockResolvedValue(["mail.exemplo.com"]);
    await expect(provider()).resolves.toEqual(["mail.exemplo.com"]);
  });

  it("domínio cadastrado: o proxy é recalculado (bloco novo → o Caddy emite o certificado)", async () => {
    spyOn("addDomain").mockResolvedValue(SUMMARY);
    const sync = spyOn("syncTls").mockResolvedValue("none");
    const res = await app.inject({ method: "POST", url: "/api/mail/domains", headers: auth, payload: { domain: "envio.exemplo.com" } });
    expect(res.statusCode).toBe(201);
    await vi.waitFor(() => expect(deployService.refreshProxy).toHaveBeenCalled());
    await vi.waitFor(() => expect(sync).toHaveBeenCalled());
  });

  it("domínio removido e servidor iniciado também recalculam o proxy", async () => {
    spyOn("removeDomain").mockResolvedValue({ mailboxDeleteFailures: [] });
    spyOn("startServer").mockResolvedValue({} as never);
    spyOn("syncTls").mockResolvedValue("none");
    await app.inject({ method: "DELETE", url: "/api/mail/domains/envio.exemplo.com", headers: auth });
    await app.inject({ method: "POST", url: "/api/mail/server/start", headers: auth });
    await vi.waitFor(() => expect(deployService.refreshProxy).toHaveBeenCalledTimes(2));
  });

  it("falha do proxy em segundo plano é registrada, não derruba a resposta", async () => {
    spyOn("addDomain").mockResolvedValue(SUMMARY);
    deployService.refreshProxy!.mockRejectedValueOnce(new Error("caddy fora do ar"));
    const warn = vi.spyOn(app.log, "warn");
    const res = await app.inject({ method: "POST", url: "/api/mail/domains", headers: auth, payload: { domain: "envio.exemplo.com" } });
    expect(res.statusCode).toBe(201);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("caddy fora do ar")));
  });
});

describe("rede de e-mail por projeto: migração na manutenção do e-mail", () => {
  it("1ª rodada migra (projetos, webmail, limpeza da paas-mail); concluída, as seguintes só conferem o Stalwart nas redes de projeto", async () => {
    Object.assign(deployService, {
      joinMailNetwork: vi.fn(async () => 1),
      sweepSharedMailNetwork: vi.fn(async () => 0),
    });
    const join = spyOn("joinMailNetworks").mockResolvedValueOnce([]).mockResolvedValue(["rede paas-mail-projeto-a sumiu"]);
    spyOn("emailProjectIds").mockResolvedValue(["p1"]);
    spyOn("leaveProjectNetwork").mockResolvedValue(undefined);
    spyOn("addDomain").mockResolvedValue(SUMMARY);
    spyOn("syncTls").mockResolvedValue("none");
    const { WebmailService } = await import("../src/services/webmail-service.js");
    spies.push(vi.spyOn(WebmailService.prototype, "sync").mockResolvedValue(undefined) as unknown as MockInstance);
    const warn = vi.spyOn(app.log, "warn");

    await app.inject({ method: "POST", url: "/api/mail/domains", headers: auth, payload: { domain: "envio.exemplo.com" } });
    await vi.waitFor(() => expect(deployService.sweepSharedMailNetwork).toHaveBeenCalledOnce());
    expect(deployService.joinMailNetwork).toHaveBeenCalledWith("p1", expect.any(Function));
    expect(deployService.sweepSharedMailNetwork).toHaveBeenCalledWith(["paas-stalwart", "paas-webmail", "paas-webmail-prev"], [], expect.any(Function), ["p1"]);

    await app.inject({ method: "POST", url: "/api/mail/domains", headers: auth, payload: { domain: "envio.exemplo.com" } });
    await vi.waitFor(() => expect(join).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("não entrou numa rede de projeto agora (rede paas-mail-projeto-a sumiu)")));
    expect(deployService.sweepSharedMailNetwork).toHaveBeenCalledOnce();
    expect(deployService.joinMailNetwork).toHaveBeenCalledOnce();
  });

  it("rodada incompleta (um projeto falhou): a próxima migra de novo", async () => {
    Object.assign(deployService, {
      joinMailNetwork: vi.fn().mockRejectedValueOnce(new Error("daemon ocupado")).mockResolvedValue(1),
      sweepSharedMailNetwork: vi.fn(async () => 0),
    });
    spyOn("joinMailNetworks").mockResolvedValue([]);
    spyOn("emailProjectIds").mockResolvedValue(["p1"]);
    spyOn("leaveProjectNetwork").mockResolvedValue(undefined);
    spyOn("addDomain").mockResolvedValue(SUMMARY);
    spyOn("syncTls").mockResolvedValue("none");
    const { WebmailService } = await import("../src/services/webmail-service.js");
    spies.push(vi.spyOn(WebmailService.prototype, "sync").mockResolvedValue(undefined) as unknown as MockInstance);

    await app.inject({ method: "POST", url: "/api/mail/domains", headers: auth, payload: { domain: "envio.exemplo.com" } });
    await vi.waitFor(() => expect(deployService.sweepSharedMailNetwork).toHaveBeenCalledWith(expect.anything(), ["p1"], expect.any(Function), ["p1"]));
    await app.inject({ method: "POST", url: "/api/mail/domains", headers: auth, payload: { domain: "envio.exemplo.com" } });
    await vi.waitFor(() => expect(deployService.sweepSharedMailNetwork).toHaveBeenCalledTimes(2));
    expect(deployService.sweepSharedMailNetwork).toHaveBeenLastCalledWith(expect.anything(), [], expect.any(Function), ["p1"]);
  });
});

describe("POST /api/mail/domains — domínio que já recebe e-mail", () => {
  it("409 com o servidor atual e a sugestão de subdomínio no corpo", async () => {
    const err = httpError(409, "domain_receives_mail", "desviaria todo o e-mail");
    err.details = { existingMail: { status: "elsewhere", servers: ["aspmx.l.google.com"], suggestedDomain: "envio.exemplo.com" } };
    spyOn("addDomain").mockRejectedValue(err);
    const res = await app.inject({ method: "POST", url: "/api/mail/domains", headers: auth, payload: { domain: "exemplo.com" } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: "domain_receives_mail",
      message: "desviaria todo o e-mail",
      existingMail: { status: "elsewhere", servers: ["aspmx.l.google.com"], suggestedDomain: "envio.exemplo.com" },
    });
  });

  it("a confirmação explícita chega ao serviço", async () => {
    const add = spyOn("addDomain").mockResolvedValue(SUMMARY);
    spyOn("syncTls").mockResolvedValue("none");
    const res = await app.inject({
      method: "POST",
      url: "/api/mail/domains",
      headers: auth,
      payload: { domain: "exemplo.com", confirmExistingMail: true },
    });
    expect(res.statusCode).toBe(201);
    expect(add).toHaveBeenCalledWith("exemplo.com", { confirmExistingMail: true });
  });

  it("confirmação que não é booleano: 400", async () => {
    const add = spyOn("addDomain");
    const res = await app.inject({
      method: "POST",
      url: "/api/mail/domains",
      headers: auth,
      payload: { domain: "exemplo.com", confirmExistingMail: "sim" },
    });
    expect(res.statusCode).toBe(400);
    expect(add).not.toHaveBeenCalled();
  });
});

describe("GET /api/mail/tls", () => {
  it("devolve o estado do certificado de cada host", async () => {
    const body = { checkedAt: "x", serverRunning: true, hosts: [], syncError: null };
    spyOn("tlsStatus").mockResolvedValue(body);
    const res = await app.inject({ method: "GET", url: "/api/mail/tls", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(body);
  });

  it("erro vira resposta de erro do painel", async () => {
    spyOn("tlsStatus").mockRejectedValue(httpError(409, "mail_not_initialized", "inicie"));
    const res = await app.inject({ method: "GET", url: "/api/mail/tls", headers: auth });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("mail_not_initialized");
  });

  it("sem autenticação: 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/mail/tls" });
    expect(res.statusCode).toBe(401);
  });
});
