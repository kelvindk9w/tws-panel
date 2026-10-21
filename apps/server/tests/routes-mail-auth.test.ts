/**
 * routes-mail-auth.test.ts — o 401 cru do Stalwart ("You have to authenticate
 * first.") vira uma mensagem que diz o que fazer, e há uma ação para reaplicar
 * a configuração do servidor de e-mail (POST /api/mail/server/repair-auth).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
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
function spy<T extends object, M extends keyof T>(proto: T, method: M) {
  const s = vi.spyOn(proto, method as never) as unknown as MockInstance;
  spies.push(s);
  return s;
}

beforeEach(async () => {
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  app.decorate("config", { dataDir: ctx.dir, mailPorts: { ...MAIL_DEFAULT_PORTS }, mailHostname: null, publicIp: null, panelDomain: null } as unknown as ServerConfig);
  app.decorate("deployService", {
    setEnvProvider: vi.fn(),
    setMailHostsProvider: vi.fn(),
    setWebmailProvider: vi.fn(),
    refreshProxy: vi.fn(async () => undefined),
  } as unknown as FastifyInstance["deployService"]);
  await app.register(mailRoutes);
});
afterEach(async () => {
  for (const s of spies.splice(0)) s.mockRestore();
  await closeAuthTestApp(ctx);
});

const changePassword = () =>
  app.inject({ method: "PUT", url: "/api/mail/mailboxes/contato@exemplo.com/password", headers: auth, payload: { generate: true } });

describe("401 do Stalwart", () => {
  it("trocar a senha de uma caixa com a senha de administração divergente: mensagem útil, sem o texto cru", async () => {
    spy(MailService.prototype, "changeMailboxPassword").mockRejectedValue(new StalwartApiError(401, "Stalwart: You have to authenticate first."));
    const res = await changePassword();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "mail_auth_failed" });
    expect(res.json().message).toMatch(/não conseguiu autenticar no servidor de e-mail/);
    expect(res.json().message).toMatch(/E-mail/);
    expect(res.body).not.toMatch(/You have to authenticate/);
  });

  it("outro erro do Stalwart segue como estava", async () => {
    spy(MailService.prototype, "changeMailboxPassword").mockRejectedValue(new StalwartApiError(500, "Stalwart: falhou"));
    const res = await changePassword();
    expect(res.json().message).toBe("Stalwart: falhou");
  });
});

describe("POST /api/mail/server/repair-auth", () => {
  it("reaplica a configuração, audita e devolve o resultado (sem senha nenhuma)", async () => {
    spy(MailService.prototype, "repairAdminAuth").mockResolvedValue("repaired");
    const res = await app.inject({ method: "POST", url: "/api/mail/server/repair-auth", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, result: "repaired" });
    await ctx.auditService.flush();
    expect(await readFile(path.join(ctx.dir, "audit.json"), "utf8")).toMatch(/mail\.server\.repair_auth/);
  });

  it("não deu: 409 com a orientação de parar e iniciar", async () => {
    spy(MailService.prototype, "repairAdminAuth").mockResolvedValue("failed");
    const res = await app.inject({ method: "POST", url: "/api/mail/server/repair-auth", headers: auth });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "mail_auth_repair_failed" });
  });

  it("servidor sem resposta ou parado: não finge sucesso (o botão precisa mostrar o erro)", async () => {
    spy(MailService.prototype, "repairAdminAuth").mockResolvedValueOnce("unreachable");
    const a = await app.inject({ method: "POST", url: "/api/mail/server/repair-auth", headers: auth });
    expect(a.statusCode).toBe(502);
    expect(a.json()).toMatchObject({ error: "mail_unreachable" });
    spy(MailService.prototype, "repairAdminAuth").mockResolvedValueOnce("not_running");
    const b = await app.inject({ method: "POST", url: "/api/mail/server/repair-auth", headers: auth });
    expect(b.statusCode).toBe(409);
    expect(b.json()).toMatchObject({ error: "mail_server_stopped" });
  });

  it("senha já certa: 200 sem reiniciar", async () => {
    spy(MailService.prototype, "repairAdminAuth").mockResolvedValueOnce("ok");
    const res = await app.inject({ method: "POST", url: "/api/mail/server/repair-auth", headers: auth });
    expect(res.json()).toEqual({ ok: true, result: "ok" });
  });
});
