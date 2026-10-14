/**
 * notifications.ts — Configurações → Notificações (todas com sessão).
 *  GET    /api/notifications                    situação: canais, o que avisa, últimos envios
 *  PUT    /api/notifications/telegram           token do robô ({ token }) — conferido no Telegram, guardado cifrado
 *  POST   /api/notifications/telegram/connect   liga a conversa que mandou /start para o robô
 *  POST   /api/notifications/telegram/test      envia uma mensagem de teste
 *  DELETE /api/notifications/telegram           desconecta (apaga o token)
 *  PUT    /api/notifications/email              endereços que recebem ({ recipients })
 *  POST   /api/notifications/email/test         envia um e-mail de teste para cada endereço
 *  DELETE /api/notifications/email              desliga o e-mail
 *  PUT    /api/notifications/kinds              o que avisa ({ kinds: { tipo: true|false } })
 *
 * O serviço (services/notification-service.ts) é criado em app.ts e
 * decorado no escopo RAIZ: os alertas, o deploy, os vigias e o plugin de
 * e-mail precisam enxergar o mesmo objeto (plugins do Fastify são isolados —
 * foi isso que deixou a blacklist sem rodar). O token nunca volta na resposta.
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  MAX_NOTIFICATION_RECIPIENTS,
  NOTIFICATION_KINDS,
  type EmailRecipientsRequest,
  type NotificationKindsRequest,
  type TelegramTokenRequest,
} from "@paas/core";
import { registerErrorHandler } from "../plugins/error-handler.js";
import type { HttpError } from "../services/http-error.js";
import type { NotificationService } from "../services/notification-service.js";

declare module "fastify" {
  interface FastifyInstance {
    notificationService: NotificationService;
  }
}

const tokenSchema = {
  body: {
    type: "object",
    required: ["token"],
    additionalProperties: false,
    // Formato do @BotFather: <id numérico>:<35 letras, números, _ ou ->.
    properties: { token: { type: "string", minLength: 20, maxLength: 120, pattern: "^\\s*[0-9]{3,20}:[A-Za-z0-9_-]{20,90}\\s*$" } },
  },
} as const;

const emailSchema = {
  body: {
    type: "object",
    required: ["recipients"],
    additionalProperties: false,
    properties: {
      recipients: {
        type: "array",
        minItems: 1,
        maxItems: MAX_NOTIFICATION_RECIPIENTS,
        items: { type: "string", minLength: 1, maxLength: 254 },
      },
    },
  },
} as const;

const kindsSchema = {
  body: {
    type: "object",
    required: ["kinds"],
    additionalProperties: false,
    properties: {
      kinds: {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, { type: "boolean" }])),
      },
    },
  },
} as const;

function sendError(reply: FastifyReply, err: unknown, log: (e: unknown) => void): FastifyReply {
  const e = err as Partial<HttpError>;
  if (!e.statusCode) log(err);
  return reply.code(e.statusCode ?? 500).send({
    error: e.code ?? "internal_error",
    message: e.statusCode ? e.message : "Não foi possível concluir agora. Tente de novo em instantes.",
  });
}

const notificationsRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);
  const service = app.notificationService;
  const logError = (err: unknown) => app.log.error({ err }, "notificações: falha inesperada");

  /** Roda a ação com o nome de quem pediu e responde a situação (ou o erro). */
  const handle =
    (action: (actor: string, body: unknown) => Promise<unknown>) =>
    async (request: { session: { username: string } | null; body: unknown }, reply: FastifyReply) => {
      try {
        // o plugin de auth já garantiu a sessão (sem ela, 401 antes de chegar aqui)
        return reply.send(await action(request.session!.username, request.body));
      } catch (err) {
        return sendError(reply, err, logError);
      }
    };

  app.get("/api/notifications", handle(() => service.status()));

  app.put(
    "/api/notifications/telegram",
    { schema: tokenSchema },
    handle((actor, body) => service.setTelegramToken((body as TelegramTokenRequest).token, actor)),
  );
  app.post("/api/notifications/telegram/connect", handle((actor) => service.connectTelegram(actor)));
  app.post("/api/notifications/telegram/test", handle((actor) => service.testTelegram(actor)));
  app.delete("/api/notifications/telegram", handle((actor) => service.removeTelegram(actor)));

  app.put(
    "/api/notifications/email",
    { schema: emailSchema },
    handle((actor, body) => service.setEmailRecipients((body as EmailRecipientsRequest).recipients, actor)),
  );
  app.post("/api/notifications/email/test", handle((actor) => service.testEmail(actor)));
  app.delete("/api/notifications/email", handle((actor) => service.removeEmail(actor)));

  app.put(
    "/api/notifications/kinds",
    { schema: kindsSchema },
    handle((actor, body) => service.setKinds((body as NotificationKindsRequest).kinds, actor)),
  );
};

export default notificationsRoutes;
