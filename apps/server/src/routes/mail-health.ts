/**
 * mail-health.ts — rotas da saúde de entregabilidade do domínio de e-mail:
 *
 *  GET  /api/mail/domains/:domain/health         plano de registros + última verificação
 *  POST /api/mail/domains/:domain/health/check   "Verificar agora" (verificação ao vivo)
 *
 * Registradas DENTRO do plugin de e-mail (routes/mail.ts), que é quem tem o
 * MailService. Nenhuma rota recebe destino de rede: o alvo é sempre o domínio
 * da URL, que precisa estar cadastrado.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { MailHealthService } from "../services/mail-health-service.js";
import { mailAuthError } from "../services/mail-auth-error.js";
import type { HttpError } from "../services/http-error.js";

const MAIL_DOMAIN_PATTERN =
  "^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$";

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
  return reply.code(e.statusCode ?? 500).send({
    error: e.code ?? "internal_error",
    message: e.message ?? "Erro interno.",
  });
}

export function mailHealthRoutes(app: FastifyInstance, health: Pick<MailHealthService, "state" | "check">): void {
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
}
