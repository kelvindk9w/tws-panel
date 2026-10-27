/**
 * email-code.ts — Configurações → Segurança → Código por e-mail (fator EXTRA, opcional).
 *  GET  /api/auth/email-code          situação (ligado?, endereço mascarado, aviso de caixa na própria VPS)
 *  POST /api/auth/email-code/send     envia um código ao e-mail do administrador (limite de intervalo e por hora)
 *  POST /api/auth/email-code/enable   senha + código do app + código recebido -> liga
 *  POST /api/auth/email-code/disable  senha + código do app + código recebido -> desliga
 *
 * Só sessão humana. Ver services/email-code.ts. Não é recuperação de senha por e-mail:
 * não existe rota pública que receba o código.
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { EMAIL_CODE_ACTIONS, type EmailCodeAction, type EmailCodeToggleRequest } from "@paas/core";
import { registerErrorHandler } from "../plugins/error-handler.js";
import { confirmIdentity } from "../services/confirm-identity.js";
import type { HttpError } from "../services/http-error.js";

const toggleSchema = {
  body: {
    type: "object",
    required: ["currentPassword", "code", "emailCode"],
    additionalProperties: false,
    properties: {
      currentPassword: { type: "string", minLength: 1, maxLength: 512 },
      code: { type: "string", minLength: 1, maxLength: 64 },
      emailCode: { type: "string", minLength: 1, maxLength: 16 },
    },
  },
} as const;

const sendSchema = {
  body: {
    type: ["object", "null"],
    additionalProperties: false,
    properties: { action: { type: "string", enum: Object.keys(EMAIL_CODE_ACTIONS) } },
  },
} as const;

function sendError(reply: FastifyReply, err: unknown, log: (e: unknown) => void): FastifyReply {
  const e = err as Partial<HttpError>;
  if (!e.statusCode) log(err);
  if (e.statusCode === 429 && e.details?.retryAfterSec !== undefined) {
    reply.header("retry-after", String(e.details.retryAfterSec));
  }
  return reply.code(e.statusCode ?? 500).send({
    error: e.code ?? "internal_error",
    message: e.statusCode ? e.message : "Não foi possível concluir agora. Tente de novo em instantes.",
    ...(e.details ?? {}),
  });
}

const emailCodeRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);
  const logError = (err: unknown) => app.log.error({ err }, "código por e-mail: falha inesperada");

  async function currentUser(request: { session: { id: string; userId: string } | null }, reply: FastifyReply) {
    const session = request.session!;
    const user = await app.userStore.findById(session.userId);
    if (!user) {
      await app.sessionStore.destroy(session.id);
      void reply.code(401).send({ error: "unauthorized", message: "Sessão inválida ou expirada." });
      return null;
    }
    return user;
  }

  app.get("/api/auth/email-code", async (request, reply) => {
    const user = await currentUser(request, reply);
    if (!user) return reply;
    return reply.send(await app.emailCode.status(user));
  });

  app.post<{ Body: { action?: EmailCodeAction } | undefined }>("/api/auth/email-code/send", { schema: sendSchema }, async (request, reply) => {
    const user = await currentUser(request, reply);
    if (!user) return reply;
    try {
      return reply.send(await app.emailCode.send(user, request.session!.id, request.body?.action ?? null));
    } catch (err) {
      return sendError(reply, err, logError);
    }
  });

  app.post<{ Body: EmailCodeToggleRequest }>("/api/auth/email-code/enable", { schema: toggleSchema }, async (request, reply) => {
    const early = await currentUser(request, reply);
    if (!early) return reply;
    if (app.emailCode.isEnabled(early)) {
      return reply.code(409).send({ error: "already_enabled", message: "O código por e-mail já está ligado." });
    }
    const status = await app.emailCode.status(early);
    if (!status.canEnable) {
      const message = !status.twoFactorEnabled
        ? "O código por e-mail é um fator extra: ative antes a verificação em duas etapas."
        : !status.address
          ? "Cadastre o seu e-mail em Configurações → Perfil: é para ele que o código é enviado."
          : (status.mailReason ?? "O envio de e-mail do painel não está pronto.");
      return reply.code(409).send({ error: "cannot_enable", message });
    }
    const confirmed = await confirmIdentity(app, request, reply, request.body, { requireTwoFactor: true, emailCode: "always", action: "email.toggle" });
    if (!confirmed) return reply;
    try {
      await app.userStore.setEmailCode(confirmed.user.id, new Date().toISOString());
      confirmed.attempt.success();
      await app.auditService.record({
        actor: confirmed.user.username,
        action: "auth.email_code_enabled",
        detail: "Código por e-mail ligado como fator extra das ações sensíveis de acesso.",
      });
      return reply.send(await app.emailCode.status((await app.userStore.findById(confirmed.user.id))!));
    } catch (err) {
      return sendError(reply, err, logError);
    } finally {
      confirmed.attempt.release();
    }
  });

  app.post<{ Body: EmailCodeToggleRequest }>("/api/auth/email-code/disable", { schema: toggleSchema }, async (request, reply) => {
    const early = await currentUser(request, reply);
    if (!early) return reply;
    if (!app.emailCode.isEnabled(early)) {
      return reply.code(409).send({ error: "not_enabled", message: "O código por e-mail não está ligado." });
    }
    const confirmed = await confirmIdentity(app, request, reply, request.body, { requireTwoFactor: true, emailCode: "if-enabled", action: "email.toggle" });
    if (!confirmed) return reply;
    try {
      await app.userStore.setEmailCode(confirmed.user.id, null);
      app.emailCode.forget(confirmed.user.id);
      confirmed.attempt.success();
      await app.auditService.record({
        actor: confirmed.user.username,
        action: "auth.email_code_disabled",
        detail: "Código por e-mail desligado (senha, código do app e código por e-mail conferidos).",
      });
      return reply.send(await app.emailCode.status((await app.userStore.findById(confirmed.user.id))!));
    } catch (err) {
      return sendError(reply, err, logError);
    } finally {
      confirmed.attempt.release();
    }
  });
};

export default emailCodeRoutes;
