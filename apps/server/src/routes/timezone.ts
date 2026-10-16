/**
 * timezone.ts — Configurações → Fuso horário e o passo do assistente de
 * instalação (setup token enquanto a instalação não terminou; sessão depois,
 * pela guarda global de plugins/auth.ts).
 *  GET /api/timezone   fuso em uso, o da VPS, a lista de fusos e os projetos
 *  PUT /api/timezone   "Aplicar na VPS" ({ zone, projects? }) — host bridge, auditado
 *
 * O serviço (timezone-service.ts) é criado em app.ts no escopo raiz.
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { SetTimezoneRequest } from "@paas/core";
import { registerErrorHandler } from "../plugins/error-handler.js";
import type { HttpError } from "../services/http-error.js";
import type { TimezoneService } from "../services/timezone-service.js";

declare module "fastify" {
  interface FastifyInstance {
    timezoneService: TimezoneService;
  }
}

function sendError(reply: FastifyReply, err: unknown, log: (e: unknown) => void): FastifyReply {
  const e = err as Partial<HttpError>;
  if (!e.statusCode) log(err);
  return reply.code(e.statusCode ?? 500).send({
    error: e.code ?? "internal_error",
    message: e.statusCode ? e.message : "Não foi possível concluir agora. Tente de novo em instantes.",
  });
}

const timezoneRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);
  const service = app.timezoneService;
  const logError = (err: unknown) => app.log.error({ err }, "fuso: falha inesperada");

  app.get("/api/timezone", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (_request, reply) => {
    try {
      return reply.send(await service.status());
    } catch (err) {
      return sendError(reply, err, logError);
    }
  });

  app.put<{ Body: SetTimezoneRequest }>(
    "/api/timezone",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["zone"],
          additionalProperties: false,
          properties: {
            zone: { type: "string", minLength: 1, maxLength: 64 },
            projects: { type: "array", maxItems: 200, items: { type: "string", minLength: 1, maxLength: 64 } },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const actor = request.session?.username ?? "assistente de instalação";
        return reply.send(await service.apply(request.body.zone, request.body.projects ?? [], actor));
      } catch (err) {
        return sendError(reply, err, logError);
      }
    },
  );
};

export default timezoneRoutes;
