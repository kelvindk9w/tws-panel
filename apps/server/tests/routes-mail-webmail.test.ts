/**
 * Módulo de e-mail ↔ webmail: o módulo cria o serviço do webmail, registra
 * as rotas dele, conta ao proxy se o webmail está ativado e faz o webmail
 * acompanhar o servidor de e-mail (parou → para; sincronização → sobe e
 * regrava a configuração). Docker simulado (métodos dublês).
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { MAIL_DEFAULT_PORTS, SETUP_TOKEN_HEADER, type MailServerStatus } from "@paas/core";
import mailRoutes from "../src/routes/mail.js";
import { MailService } from "../src/services/mail-service.js";
import { WebmailService } from "../src/services/webmail-service.js";
import type { ServerConfig } from "../src/config.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };

const STOPPED = { installed: true, running: false } as MailServerStatus;

let ctx: AuthTestContext;
let app: FastifyInstance;
let deployService: Record<string, ReturnType<typeof vi.fn>>;
const spies: MockInstance[] = [];

function spy<T extends object, M extends keyof T>(proto: T, method: M) {
  const s = vi.spyOn(proto, method as never) as unknown as MockInstance;
  spies.push(s);
  return s;
}

beforeEach(async () => {
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  app.decorate("config", {
    dataDir: ctx.dir,
    mailPorts: { ...MAIL_DEFAULT_PORTS },
    mailHostname: null,
    publicIp: null,
    panelDomain: null,
  } as unknown as ServerConfig);
  deployService = {
    setEnvProvider: vi.fn(),
    setMailHostsProvider: vi.fn(),
    setWebmailProvider: vi.fn(),
    refreshProxy: vi.fn(async () => undefined),
  };
  app.decorate("deployService", deployService as unknown as FastifyInstance["deployService"]);
  await app.register(mailRoutes);
});

afterEach(async () => {
  for (const s of spies.splice(0)) s.mockRestore();
  await closeAuthTestApp(ctx);
});

describe("webmail dentro do módulo de e-mail", () => {
  it("o proxy pergunta ao webmail se está ativado", async () => {
    expect(deployService.setWebmailProvider).toHaveBeenCalledOnce();
    const provider = deployService.setWebmailProvider!.mock.calls[0]![0] as () => Promise<unknown>;
    spy(WebmailService.prototype, "proxyState").mockResolvedValue({ upstream: "paas-webmail:8000", blockedIps: [] });
    await expect(provider()).resolves.toEqual({ upstream: "paas-webmail:8000", blockedIps: [] });
  });

  it("as rotas do webmail estão registradas", async () => {
    spy(WebmailService.prototype, "status").mockResolvedValue({ enabled: false } as never);
    const res = await app.inject({ method: "GET", url: "/api/mail/webmail", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false });
  });

  it("parar o servidor de e-mail para o webmail junto", async () => {
    spy(MailService.prototype, "stopServer").mockResolvedValue(STOPPED);
    const follow = spy(WebmailService.prototype, "followMailServer").mockResolvedValue(undefined);
    const res = await app.inject({ method: "POST", url: "/api/mail/server/stop", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(follow).toHaveBeenCalledWith(false);
  });

  it("iniciar o servidor de e-mail: a sincronização em segundo plano sobe o webmail (se ativado)", async () => {
    spy(MailService.prototype, "startServer").mockResolvedValue({ ...STOPPED, running: true });
    spy(MailService.prototype, "mailHosts").mockResolvedValue(["mail.exemplo.com"]);
    spy(MailService.prototype, "syncTls").mockResolvedValue("none");
    const sync = spy(WebmailService.prototype, "sync").mockResolvedValue(undefined);
    const res = await app.inject({ method: "POST", url: "/api/mail/server/start", headers: auth });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(sync).toHaveBeenCalled());
  });
});
