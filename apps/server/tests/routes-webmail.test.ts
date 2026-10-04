/**
 * Rotas do webmail (pedido do dono do produto, 04/10/2026): estado, ativar e
 * desativar. Ativar/desativar recalcula o Caddyfile (mail.<domínio> passa a
 * abrir o webmail, ou volta à página do servidor de e-mail) e fica na
 * Auditoria. A cada minuto o painel lê as senhas erradas e, se a lista de
 * bloqueados muda, recalcula o Caddyfile. Docker simulado (WebmailService dublê).
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER, type WebmailStatus } from "@paas/core";
import webmailRoutes from "../src/routes/webmail.js";
import { httpError } from "../src/services/http-error.js";
import type { WebmailService } from "../src/services/webmail-service.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };

const STATUS: WebmailStatus = {
  enabled: true,
  installed: true,
  running: true,
  image: "roundcube/roundcubemail:teste",
  containerName: "paas-webmail",
  mailServerRunning: true,
  tlsVerified: true,
  links: [{ domain: "exemplo.com", host: "mail.exemplo.com", url: "https://mail.exemplo.com/" }],
  blockedIps: 0,
  message: null,
};

let ctx: AuthTestContext;
let app: FastifyInstance;
let webmail: Record<string, ReturnType<typeof vi.fn>>;
let refreshProxy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  refreshProxy = vi.fn(async () => undefined);
  app.decorate("deployService", { refreshProxy } as unknown as FastifyInstance["deployService"]);
  webmail = {
    status: vi.fn(async () => STATUS),
    enable: vi.fn(async () => STATUS),
    disable: vi.fn(async () => ({ ...STATUS, enabled: false, running: false, installed: false })),
    pollFailedLogins: vi.fn(async () => false),
  };
  await app.register(webmailRoutes, { webmail: webmail as unknown as WebmailService });
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
  vi.useRealTimers();
});

async function auditActions(): Promise<string[]> {
  await ctx.auditService.flush();
  return (await ctx.auditService.list()).entries.map((e) => e.action);
}

describe("GET /api/mail/webmail", () => {
  it("devolve o estado", async () => {
    const res = await app.inject({ method: "GET", url: "/api/mail/webmail", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(STATUS);
  });

  it("exige autenticação", async () => {
    const res = await app.inject({ method: "GET", url: "/api/mail/webmail" });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/mail/webmail/enable e /disable", () => {
  it("ativa, recalcula o proxy e registra na auditoria", async () => {
    const res = await app.inject({ method: "POST", url: "/api/mail/webmail/enable", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, status: STATUS });
    expect(webmail.enable).toHaveBeenCalledOnce();
    expect(refreshProxy).toHaveBeenCalledOnce();
    expect(await auditActions()).toContain("mail.webmail.enable");
  });

  it("desativa, recalcula o proxy e registra na auditoria", async () => {
    const res = await app.inject({ method: "POST", url: "/api/mail/webmail/disable", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().status.enabled).toBe(false);
    expect(refreshProxy).toHaveBeenCalledOnce();
    expect(await auditActions()).toContain("mail.webmail.disable");
  });

  it("erro do serviço chega com código e mensagem; nada vai para a auditoria", async () => {
    webmail.enable!.mockRejectedValue(httpError(409, "mail_server_stopped", "O servidor de e-mail está parado."));
    const res = await app.inject({ method: "POST", url: "/api/mail/webmail/enable", headers: auth });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "mail_server_stopped", message: "O servidor de e-mail está parado." });
    expect(refreshProxy).not.toHaveBeenCalled();
    expect(await auditActions()).not.toContain("mail.webmail.enable");
  });

  it("falha ao recalcular o proxy não desfaz a ativação (fica no aviso)", async () => {
    refreshProxy.mockRejectedValue(new Error("caddy fora"));
    const res = await app.inject({ method: "POST", url: "/api/mail/webmail/enable", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().proxyError).toMatch(/caddy fora/);
  });

  it("erro sem código vira 500", async () => {
    webmail.disable!.mockRejectedValue(new Error("docker fora"));
    const res = await app.inject({ method: "POST", url: "/api/mail/webmail/disable", headers: auth });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal_error", message: "docker fora" });
  });
});

describe("leitura das senhas erradas, a cada minuto", () => {
  it("lista de bloqueados mudou: recalcula o proxy; não mudou: não", async () => {
    webmail.pollFailedLogins!.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshProxy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshProxy).toHaveBeenCalledOnce();
  });

  it("falha na leitura não derruba nada", async () => {
    webmail.pollFailedLogins!.mockRejectedValue(new Error("docker fora"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshProxy).not.toHaveBeenCalled();
  });
});
