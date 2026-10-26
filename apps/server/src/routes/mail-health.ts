/**
 * mail-health.ts — rotas da saúde de entregabilidade do domínio de e-mail:
 *
 *  GET  /api/mail/domains/:domain/health         plano de registros + última verificação
 *  POST /api/mail/domains/:domain/health/check   "Verificar agora" (verificação ao vivo)
 *  PUT    /api/mail/domains/:domain/health/ack/:id   "Marcar como ciente" (PTR, porta 25), com motivo opcional
 *  DELETE /api/mail/domains/:domain/health/ack/:id   desmarca
 *
 * Registradas DENTRO do plugin de e-mail (routes/mail.ts), que é quem tem o
 * MailService. Nenhuma rota recebe destino de rede: o alvo é sempre o domínio
 * da URL, que precisa estar cadastrado.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { MAIL_HEALTH_ACK_REASON_MAX } from "@paas/core";
import type { MailHealthService } from "../services/mail-health-service.js";
import { mailAuthError } from "../services/mail-auth-error.js";
import type { HttpError } from "../services/http-error.js";

const MAIL_DOMAIN_PATTERN =
  "^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+\\.?$";

const domainParams = {
  params: {
    type: "object",
    required: ["domain"],
    properties: { domain: { type: "string", minLength: 1, maxLength: 253, pattern: MAIL_DOMAIN_PATTERN } },
  },
} as const;

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  err = mailAuthError(err) ?? err;
  const e = err as Partial<HttpError>;
  const retryAfter = typeof e.details?.retryAfter === "number" ? e.details.retryAfter : undefined;
  if (retryAfter !== undefined) void reply.header("Retry-After", String(retryAfter));
  return reply.code(e.statusCode ?? 500).send({
    error: e.code ?? "internal_error",
    message: e.message ?? "Erro interno.",
    ...(retryAfter !== undefined ? { retryAfter } : {}),
  });
}

const ackParams = {
  params: {
    type: "object",
    required: ["domain", "id"],
    properties: {
      domain: { type: "string", minLength: 1, maxLength: 253, pattern: MAIL_DOMAIN_PATTERN },
      id: { type: "string", minLength: 1, maxLength: 40, pattern: "^[a-z0-9_]+$" },
    },
  },
} as const;

export function mailHealthRoutes(
  app: FastifyInstance,
  health: Pick<MailHealthService, "state" | "check" | "acknowledge" | "unacknowledge">,
): void {
  app.get<{ Params: { domain: string } }>("/api/mail/domains/:domain/health", { schema: domainParams }, async (request, reply) => {
    try {
      return reply.send(await health.state(request.params.domain));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { domain: string } }>(
    "/api/mail/domains/:domain/health/check",
    { schema: domainParams, config: { rateLimit: { max: 6, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        const report = await health.check(request.params.domain, { manual: true });
        await app.auditService.record({
          action: "mail.health.check",
          target: report.domain,
          detail: `Verificação de entregabilidade: ${report.level}.`,
        });
        return reply.send({ ...(await health.state(request.params.domain)), report });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.put<{ Params: { domain: string; id: string }; Body: { reason?: string } | undefined }>(
    "/api/mail/domains/:domain/health/ack/:id",
    {
      schema: {
        ...ackParams,
        body: {
          anyOf: [
            { type: "null" },
            { type: "object", additionalProperties: false, properties: { reason: { type: "string", maxLength: MAIL_HEALTH_ACK_REASON_MAX } } },
          ],
        },
      },
    },
    async (request, reply) => {
      try {
        const state = await health.acknowledge(request.params.domain, request.params.id, {
          reason: request.body?.reason ?? null,
          by: request.session?.username ?? null,
        });
        const reason = (request.body?.reason ?? "").trim();
        await app.auditService.record({
          action: "mail.health.ack",
          target: request.params.id,
          detail: `Item "${request.params.id}" da saúde do e-mail marcado como ciente${reason ? ` (motivo: ${reason})` : ""}.`,
        });
        return reply.send(state);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete<{ Params: { domain: string; id: string } }>("/api/mail/domains/:domain/health/ack/:id", { schema: ackParams }, async (request, reply) => {
    try {
      const state = await health.unacknowledge(request.params.domain, request.params.id);
      await app.auditService.record({
        action: "mail.health.unack",
        target: request.params.id,
        detail: `Marcação de ciente do item "${request.params.id}" da saúde do e-mail removida.`,
      });
      return reply.send(state);
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
