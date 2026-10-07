/**
 * routes-notifications.test.ts — API de Configurações → Notificações.
 *  GET    /api/notifications                    situação (canais, tipos, histórico)
 *  PUT    /api/notifications/telegram           token do robô ({ token })
 *  POST   /api/notifications/telegram/connect   ligar a conversa (depois do /start)
 *  POST   /api/notifications/telegram/test      enviar teste
 *  DELETE /api/notifications/telegram           desconectar
 *  PUT    /api/notifications/email              endereços ({ recipients })
 *  POST   /api/notifications/email/test         enviar teste
 *  DELETE /api/notifications/email              desligar o e-mail
 *  PUT    /api/notifications/kinds              o que avisa ({ kinds })
 *
 * Serviço de verdade; Telegram e e-mail simulados.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER, type NotificationsStatus } from "@paas/core";
import authRoutes from "../src/routes/auth.js";
import notificationsRoutes from "../src/routes/notifications.js";
import setupRoutes from "../src/routes/setup.js";
import { NotificationService } from "../src/services/notification-service.js";
import { TelegramError, type TelegramClient } from "../src/services/telegram-client.js";
import { buildAuthTestApp, closeAuthTestApp, sessionCookieOf, type AuthTestContext } from "./test-utils.js";

const SETUP = "token-de-teste";
const PASSWORD = "MinhaSenha123";
const BOT = "123456789:AAEXEMPLOxxxxxxxxxxxxxxxxxxxxxxxxxx";

let ctx: AuthTestContext;
let app: FastifyInstance;
let cookie: string;
let service: NotificationService;
let telegram: TelegramClient;
let mailSent: string[];

beforeEach(async () => {
  ctx = await buildAuthTestApp(SETUP);
  app = ctx.app;
  mailSent = [];
  telegram = {
    getMe: vi.fn(async (token: string) => {
      if (token !== BOT) throw new TelegramError("invalid_token", "O Telegram não reconheceu o token.", true);
      return { username: "meu_painel_bot", name: "Avisos" };
    }),
    findLatestChat: vi.fn(async () => ({ chatId: "42", title: "Maria", type: "private" })),
    sendMessage: vi.fn(async () => undefined),
  };
  service = new NotificationService({ dataDir: ctx.dir, telegram, audit: ctx.auditService, log: () => undefined });
  service.setEmailSender({
    readiness: async () => ({ ready: true, reason: null, from: "postmaster@envio.exemplo.com.br" }),
    send: async (m) => void mailSent.push(m.to),
  });
  app.decorate("notificationService", service);
  await app.register(authRoutes);
  await app.register(setupRoutes);
  await app.register(notificationsRoutes);
  await app.inject({
    method: "POST",
    url: "/api/setup/admin",
    headers: { [SETUP_TOKEN_HEADER]: SETUP },
    payload: { username: "admin", password: PASSWORD },
  });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: PASSWORD } });
  cookie = sessionCookieOf(login);
});

afterEach(async () => {
  await service.flush();
  await closeAuthTestApp(ctx);
});

function call(method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

describe("autenticação", () => {
  it("sem sessão: 401", async () => {
    expect((await app.inject({ method: "GET", url: "/api/notifications" })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: "/api/notifications/telegram", payload: { token: BOT } })).statusCode).toBe(401);
  });
});

describe("Telegram", () => {
  it("fluxo completo: token → conectar → testar → desconectar; o token nunca volta", async () => {
    const put = await call("PUT", "/api/notifications/telegram", { token: BOT });
    expect(put.statusCode).toBe(200);
    expect(put.body).not.toContain("AAEXEMPLO");
    expect((put.json() as NotificationsStatus).telegram.state).toBe("awaiting_chat");

    const conn = await call("POST", "/api/notifications/telegram/connect");
    expect(conn.statusCode).toBe(200);
    expect((conn.json() as NotificationsStatus).telegram).toMatchObject({ state: "connected", chatTitle: "Maria" });

    const test = await call("POST", "/api/notifications/telegram/test");
    expect(test.statusCode).toBe(200);
    expect((test.json() as NotificationsStatus).telegram.testedAt).not.toBeNull();

    const get = await call("GET", "/api/notifications");
    expect(get.body).not.toContain("AAEXEMPLO");
    expect(get.body).not.toContain("123456789");

    const del = await call("DELETE", "/api/notifications/telegram");
    expect((del.json() as NotificationsStatus).telegram.state).toBe("none");

    await ctx.auditService.flush();
    const audit = await ctx.auditService.list();
    const actions = audit.entries.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "notifications.telegram_token",
        "notifications.telegram_connected",
        "notifications.test",
        "notifications.telegram_removed",
      ]),
    );
    expect(audit.entries.find((e) => e.action === "notifications.telegram_token")?.actor).toBe("admin");
    expect(JSON.stringify(audit)).not.toContain("AAEXEMPLO");
  });

  it.each([
    [{}, "sem token"],
    [{ token: BOT, extra: 1 }, "campo a mais"],
    [{ token: 123 }, "não é texto"],
    [{ token: "sem-dois-pontos" }, "formato errado"],
    [{ token: `${BOT}${"x".repeat(200)}` }, "longo demais"],
  ])("schema recusa %j (%s) com 400, sem ecoar o valor", async (payload, _motivo) => {
    const res = await call("PUT", "/api/notifications/telegram", payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_request" });
    expect(res.body).not.toContain("AAEXEMPLO");
  });

  it("token que o Telegram recusa: 400 invalid_token com explicação", async () => {
    const res = await call("PUT", "/api/notifications/telegram", { token: "111:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_token" });
  });

  it("conectar antes do /start: 409 com o passo a passo", async () => {
    await call("PUT", "/api/notifications/telegram", { token: BOT });
    vi.mocked(telegram.findLatestChat).mockResolvedValueOnce(null);
    const res = await call("POST", "/api/notifications/telegram/connect");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "telegram_no_chat" });
    expect(res.json().message).toMatch(/\/start/);
  });

  it("teste que falha: 502", async () => {
    await call("PUT", "/api/notifications/telegram", { token: BOT });
    await call("POST", "/api/notifications/telegram/connect");
    vi.mocked(telegram.sendMessage).mockRejectedValueOnce(new TelegramError("blocked", "Robô bloqueado.", true));
    const res = await call("POST", "/api/notifications/telegram/test");
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "telegram_send_failed", message: "Robô bloqueado." });
  });
});

describe("E-mail", () => {
  it("salva endereços, testa e desliga", async () => {
    const put = await call("PUT", "/api/notifications/email", { recipients: ["a@exemplo.org", "b@exemplo.org"] });
    expect(put.statusCode).toBe(200);
    expect((put.json() as NotificationsStatus).email.recipients).toEqual(["a@exemplo.org", "b@exemplo.org"]);
    const test = await call("POST", "/api/notifications/email/test");
    expect(test.statusCode).toBe(200);
    expect(mailSent).toEqual(["a@exemplo.org", "b@exemplo.org"]);
    const del = await call("DELETE", "/api/notifications/email");
    expect((del.json() as NotificationsStatus).email.recipients).toEqual([]);
  });

  it.each([
    [{}, "sem lista"],
    [{ recipients: [] }, "lista vazia"],
    [{ recipients: ["a@exemplo.org"], extra: true }, "campo a mais"],
    [{ recipients: Array.from({ length: 6 }, (_, i) => `p${i}@exemplo.org`) }, "mais de 5"],
    [{ recipients: ["x".repeat(300)] }, "endereço longo demais"],
  ])("schema recusa %j (%s) com 400", async (payload, _motivo) => {
    expect((await call("PUT", "/api/notifications/email", payload)).statusCode).toBe(400);
  });

  it("endereço inválido: 400 do serviço", async () => {
    const res = await call("PUT", "/api/notifications/email", { recipients: ["não é e-mail"] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_recipient" });
  });

  it("teste sem endereço: 409", async () => {
    expect((await call("POST", "/api/notifications/email/test")).statusCode).toBe(409);
  });
});

describe("tipos", () => {
  it("liga/desliga e devolve a situação", async () => {
    const res = await call("PUT", "/api/notifications/kinds", { kinds: { panel: true, disk: false } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as NotificationsStatus).kinds).toMatchObject({ panel: true, disk: false });
  });

  it.each([
    [{}, "sem kinds"],
    [{ kinds: { inventado: true } }, "tipo desconhecido"],
    [{ kinds: { panel: "sim" } }, "não é booleano"],
  ])("schema recusa %j (%s) com 400", async (payload, _motivo) => {
    expect((await call("PUT", "/api/notifications/kinds", payload)).statusCode).toBe(400);
  });
});

describe("erro inesperado", () => {
  it("vira 500 genérico, sem detalhe interno", async () => {
    vi.spyOn(service, "status").mockRejectedValueOnce(new Error("EACCES /data/notifications.json"));
    const res = await call("GET", "/api/notifications");
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("EACCES");
  });
});
