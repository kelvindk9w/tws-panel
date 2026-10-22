/**
 * POST /api/mail/sync — "Sincronizar com o servidor de e-mail": cadastra no
 * painel os domínios e caixas que o Stalwart já tem (quem restaurou o e-mail
 * antes desta função existir, ou iniciou o servidor depois de restaurar).
 */
import type { FastifyInstance } from "fastify";
import { StalwartApiError } from "@paas/mailer";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { MAIL_DEFAULT_PORTS, SETUP_TOKEN_HEADER } from "@paas/core";
import mailRoutes from "../src/routes/mail.js";
import { MailService } from "../src/services/mail-service.js";
import type { ServerConfig } from "../src/config.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };
let ctx: AuthTestContext;
let app: FastifyInstance;
const spies: MockInstance[] = [];
const record = vi.fn(async () => undefined);

beforeEach(async () => {
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  app.decorate("config", { dataDir: ctx.dir, mailPorts: { ...MAIL_DEFAULT_PORTS }, mailHostname: null, publicIp: null, panelDomain: null } as unknown as ServerConfig);
  app.decorate("deployService", {
    setEnvProvider: vi.fn(),
    setMailHostsProvider: vi.fn(),
    setWebmailProvider: vi.fn(),
    refreshProxy: vi.fn(async () => undefined),
    listProjects: vi.fn(async () => [{ id: "p1", slug: "loja" }]),
  } as unknown as FastifyInstance["deployService"]);
  await app.register(mailRoutes);
  app.auditService.record = record as never;
  record.mockClear();
});
afterEach(async () => {
  for (const s of spies.splice(0)) s.mockRestore();
  await closeAuthTestApp(ctx);
});

const sync = (headers: Record<string, string> = auth) => app.inject({ method: "POST", url: "/api/mail/sync", headers });

describe("POST /api/mail/sync", () => {
  it("devolve contagens e nomes, e audita", async () => {
    const adopt = vi.spyOn(MailService.prototype, "adoptFromStalwart").mockResolvedValue({
      domains: ["cassp.example.com"],
      mailboxes: ["contato@cassp.example.com", "postmaster@cassp.example.com"],
      skipped: ["joao"],
    });
    spies.push(adopt as unknown as MockInstance);
    const res = await sync();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      domainCount: 1,
      mailboxCount: 2,
      domains: ["cassp.example.com"],
      mailboxes: ["contato@cassp.example.com", "postmaster@cassp.example.com"],
      skipped: ["joao"],
    });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: "mail.sync", detail: expect.stringContaining("1 domínio") }));
  });

  it("senhas realinhadas: a resposta traz a contagem e a auditoria registra, sem senha", async () => {
    spies.push(
      vi.spyOn(MailService.prototype, "adoptFromStalwart").mockResolvedValue({
        domains: [],
        mailboxes: [],
        skipped: [],
        passwordsRealigned: 3,
        passwordsReapplied: 2,
        passwordsFailed: ["loja@cassp.example.com"],
      }) as unknown as MockInstance,
    );
    const res = await sync();
    expect(res.json()).toMatchObject({ ok: true, passwordsRealigned: 3, passwordsFailed: ["loja@cassp.example.com"] });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "mail.sync", detail: expect.stringMatching(/3 caixa.*realinhada.*2 caixa.*reaplicada.*1 falha/s) }),
    );
  });

  it("só caixas reaplicadas sem conferir: a auditoria registra as contagens", async () => {
    spies.push(
      vi.spyOn(MailService.prototype, "adoptFromStalwart").mockResolvedValue({ domains: [], mailboxes: [], skipped: [], passwordsReapplied: 2 }) as unknown as MockInstance,
    );
    const res = await sync();
    expect(res.json()).toMatchObject({ ok: true, passwordsReapplied: 2 });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "mail.sync", detail: expect.stringMatching(/0 caixa\(s\) realinhada.*2 caixa\(s\) reaplicada.*0 falha/s) }),
    );
  });

  it("nada a cadastrar: resposta com zeros e sem auditoria", async () => {
    spies.push(vi.spyOn(MailService.prototype, "adoptFromStalwart").mockResolvedValue({ domains: [], mailboxes: [], skipped: [] }) as unknown as MockInstance);
    const res = await sync();
    expect(res.json()).toMatchObject({ ok: true, domainCount: 0, mailboxCount: 0 });
    expect(record).not.toHaveBeenCalled();
  });

  it("senha de administração divergente: mail_auth_failed (409), mensagem em português", async () => {
    spies.push(vi.spyOn(MailService.prototype, "adoptFromStalwart").mockRejectedValue(new StalwartApiError(401, "Stalwart: You have to authenticate first.")) as unknown as MockInstance);
    const res = await sync();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "mail_auth_failed" });
    expect(res.body).not.toMatch(/You have to authenticate/);
  });

  it("o reparo automático também falhou: o erro segue com o código próprio e o Dashboard ganha a pendência de reparo", async () => {
    const { mailAuthRepairFailedError } = await import("../src/services/mail-auth-error.js");
    spies.push(vi.spyOn(MailService.prototype, "adoptFromStalwart").mockRejectedValue(mailAuthRepairFailedError("failed")) as unknown as MockInstance);
    const markPending = vi.fn(async () => undefined);
    (app as unknown as Record<string, unknown>).restoreReconciliation = { markPending };
    const res = await sync();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "mail_auth_repair_failed" });
    expect(markPending).toHaveBeenCalledWith(["mail-auth"], "email");
  });

  it("reparo que não terminou também abre a pendência", async () => {
    const { mailAuthRepairIncompleteError } = await import("../src/services/mail-auth-error.js");
    spies.push(vi.spyOn(MailService.prototype, "adoptFromStalwart").mockRejectedValue(mailAuthRepairIncompleteError(new Error("docker fora"), null)) as unknown as MockInstance);
    const markPending = vi.fn(async () => undefined);
    (app as unknown as Record<string, unknown>).restoreReconciliation = { markPending };
    const res = await sync();
    expect(res.json()).toMatchObject({ error: "mail_auth_repair_incomplete" });
    expect(markPending).toHaveBeenCalledWith(["mail-auth"], "email");
  });

  it("401 que sobrou também abre a pendência; falha ao gravá-la não muda a resposta", async () => {
    spies.push(vi.spyOn(MailService.prototype, "adoptFromStalwart").mockRejectedValue(new StalwartApiError(403, "x")) as unknown as MockInstance);
    const markPending = vi.fn(async () => {
      throw new Error("disco cheio");
    });
    (app as unknown as Record<string, unknown>).restoreReconciliation = { markPending };
    const res = await sync();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "mail_auth_failed" });
    expect(markPending).toHaveBeenCalledTimes(1);
  });

  it("Stalwart inacessível: 502 mail_unreachable com texto em português", async () => {
    spies.push(vi.spyOn(MailService.prototype, "adoptFromStalwart").mockRejectedValue(new StalwartApiError(0, "Sem conexão com o Stalwart (fetch failed).")) as unknown as MockInstance);
    const res = await sync();
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "mail_unreachable" });
    expect(res.json().message).toMatch(/servidor de e-mail/);
  });

  it("outros erros do Stalwart: 502 mail_sync_failed com o motivo", async () => {
    spies.push(vi.spyOn(MailService.prototype, "adoptFromStalwart").mockRejectedValue(new StalwartApiError(500, "Stalwart: falhou")) as unknown as MockInstance);
    const res = await sync();
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "mail_sync_failed" });
  });

  it("servidor parado: o erro do serviço segue como está (409 mail_server_stopped)", async () => {
    const { httpError } = await import("../src/services/http-error.js");
    spies.push(vi.spyOn(MailService.prototype, "adoptFromStalwart").mockRejectedValue(httpError(409, "mail_server_stopped", "parado")) as unknown as MockInstance);
    const res = await sync();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("mail_server_stopped");
  });

  it("sem sessão: 401", async () => {
    const res = await sync({});
    expect(res.statusCode).toBe(401);
  });
});
