/**
 * Rotas do e-mail de teste da página do domínio:
 *  - POST /api/mail/domains/:domain/test-email  { to }  → envia (202)
 *  - GET  /api/mail/domains/:domain/test-email/:id     → destino da mensagem
 * Autenticadas como as outras de /api/mail, com schema (um endereço só) e
 * registro na auditoria. O MailService é espionado: sem Docker nem SMTP.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { SETUP_TOKEN_HEADER, MAIL_DEFAULT_PORTS, type MailTestStatus } from "@paas/core";
import mailRoutes from "../src/routes/mail.js";
import { MailService } from "../src/services/mail-service.js";
import { httpError } from "../src/services/http-error.js";
import type { ServerConfig } from "../src/config.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };
const DOMAIN = "envio.exemplo.com.br";

const STATUS: MailTestStatus = {
  id: "0123456789abcdef",
  domain: DOMAIN,
  from: `postmaster@${DOMAIN}`,
  to: "pessoa@gmail.com",
  sentAt: "2026-10-01T12:00:00.000Z",
  checkedAt: "2026-10-01T12:00:00.000Z",
  state: "queued",
  detail: null,
  nextRetryAt: null,
  confirmed: false,
  final: false,
};

let ctx: AuthTestContext;
let app: FastifyInstance;
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
  app.decorate("deployService", {
    setEnvProvider: vi.fn(),
    setMailHostsProvider: vi.fn(),
    refreshProxy: vi.fn(async () => undefined),
    getProject: vi.fn(),
  } as unknown as FastifyInstance["deployService"]);
  await app.register(mailRoutes);
});

afterEach(async () => {
  for (const s of spies.splice(0)) s.mockRestore();
  await closeAuthTestApp(ctx);
});

describe("POST /api/mail/domains/:domain/test-email", () => {
  it("envia, responde 202 com o acompanhamento e registra na auditoria", async () => {
    const send = spyOn("sendTestEmail").mockResolvedValue(STATUS);
    const record = vi.spyOn(app.auditService, "record");
    const res = await app.inject({
      method: "POST",
      url: `/api/mail/domains/${DOMAIN}/test-email`,
      headers: auth,
      payload: { to: "pessoa@gmail.com" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ test: STATUS });
    expect(send).toHaveBeenCalledWith(DOMAIN, "pessoa@gmail.com");
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "mail.test.send", target: DOMAIN, detail: expect.stringContaining("pessoa@gmail.com") }),
    );
  });

  it.each([
    ["sem o campo", {}],
    ["não é e-mail", { to: "sem-arroba" }],
    ["dois destinatários", { to: "a@gmail.com, b@gmail.com" }],
    ["lista", { to: ["a@gmail.com"] }],
    ["quebra de linha", { to: "a@gmail.com\r\nRCPT TO:<b@gmail.com>" }],
    ["campo extra", { to: "a@gmail.com", cc: "b@gmail.com" }],
  ])("%s: 400 e nada é enviado", async (_label, payload) => {
    const send = spyOn("sendTestEmail");
    const res = await app.inject({ method: "POST", url: `/api/mail/domains/${DOMAIN}/test-email`, headers: auth, payload });
    expect(res.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("limite de frequência: 429 com a mensagem do serviço, sem auditoria", async () => {
    spyOn("sendTestEmail").mockRejectedValue(httpError(429, "test_rate_limited", "Aguarde 20 s para enviar outro e-mail de teste."));
    const record = vi.spyOn(app.auditService, "record");
    const res = await app.inject({
      method: "POST",
      url: `/api/mail/domains/${DOMAIN}/test-email`,
      headers: auth,
      payload: { to: "pessoa@gmail.com" },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: "test_rate_limited", message: "Aguarde 20 s para enviar outro e-mail de teste." });
    expect(record).not.toHaveBeenCalledWith(expect.objectContaining({ action: "mail.test.send" }));
  });

  it("sem autenticação: 401", async () => {
    const res = await app.inject({ method: "POST", url: `/api/mail/domains/${DOMAIN}/test-email`, payload: { to: "a@gmail.com" } });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/mail/domains/:domain/test-email/:id", () => {
  it("devolve o destino atual da mensagem", async () => {
    const status = spyOn("testEmailStatus").mockResolvedValue({ ...STATUS, state: "delivered", final: true, confirmed: true });
    const res = await app.inject({ method: "GET", url: `/api/mail/domains/${DOMAIN}/test-email/${STATUS.id}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().test.state).toBe("delivered");
    expect(status).toHaveBeenCalledWith(DOMAIN, STATUS.id);
  });

  it("id fora do formato: 400; teste desconhecido: 404", async () => {
    const status = spyOn("testEmailStatus").mockRejectedValue(httpError(404, "test_not_found", "Teste não encontrado."));
    const bad = await app.inject({ method: "GET", url: `/api/mail/domains/${DOMAIN}/test-email/..%2F..%2Fx`, headers: auth });
    expect(bad.statusCode).toBe(400);
    expect(status).not.toHaveBeenCalled();
    const missing = await app.inject({ method: "GET", url: `/api/mail/domains/${DOMAIN}/test-email/${STATUS.id}`, headers: auth });
    expect(missing.statusCode).toBe(404);
  });

  it("sem autenticação: 401", async () => {
    const res = await app.inject({ method: "GET", url: `/api/mail/domains/${DOMAIN}/test-email/${STATUS.id}` });
    expect(res.statusCode).toBe(401);
  });
});
