/**
 * aof-repair.ts (rotas) — reparo do arquivo AOF do redis/valkey corrompido (services/aof-repair.ts).
 *
 *  POST /api/projects/:id/aof-repair/measure  { service }            quanto o corte descartaria (nada é alterado)
 *  POST /api/projects/:id/aof-repair          { service, maxBytes }  o reparo confirmado (para, copia, corta, liga)
 *
 * Mesma permissão de parar/iniciar o projeto (sessão do painel ou token de escrita com o projeto no alcance:
 * token-policy-table.ts), limite de pedidos como o "recriar" e o fuso, e um reparo por projeto de cada vez
 * (o segundo pedido recebe 409). O cliente nunca informa container nem caminho: só o nome do serviço.
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { AofMeasureRequest, AofRepairRequest } from "@paas/core";
import { registerErrorHandler } from "../plugins/error-handler.js";
import { DockerUnavailableError } from "../services/docker-service.js";
import type { HttpError } from "../services/http-error.js";

const params = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
} as const;

const service = { type: "string", minLength: 1, maxLength: 63, pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$" } as const;

const measureSchema = {
  params,
  body: { type: "object", required: ["service"], additionalProperties: false, properties: { service } },
} as const;

const repairSchema = {
  params,
  body: {
    type: "object",
    required: ["service", "maxBytes"],
    additionalProperties: false,
    properties: { service, maxBytes: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
  },
} as const;

export const AOF_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const;

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof DockerUnavailableError) return reply.code(503).send({ error: "docker_unavailable", message: "O Docker não respondeu agora. Nada foi alterado." });
  const e = err as Partial<HttpError>;
  if (e.statusCode && e.code) return reply.code(e.statusCode).send({ error: e.code, message: e.message, ...(e.details ?? {}) });
  throw err;
}

const aofRepairRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);

  app.post<{ Params: { id: string }; Body: AofMeasureRequest }>(
    "/api/projects/:id/aof-repair/measure",
    { schema: measureSchema, config: { rateLimit: AOF_RATE_LIMIT } },
    async (request, reply) => {
      const project = await app.deployService.getProject(request.params.id);
      if (!project) return reply.code(404).send({ error: "project_not_found", message: "Projeto não encontrado." });
      try {
        return reply.send(await app.aofRepair.measure(project, request.body.service));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: AofRepairRequest }>(
    "/api/projects/:id/aof-repair",
    { schema: repairSchema, config: { rateLimit: AOF_RATE_LIMIT } },
    async (request, reply) => {
      const project = await app.deployService.getProject(request.params.id);
      if (!project) return reply.code(404).send({ error: "project_not_found", message: "Projeto não encontrado." });
      // sessão de token já traz `token:<nome>` como usuário
      const actor = request.session?.username ?? "operador";
      try {
        return reply.send(await app.aofRepair.repair(project, request.body.service, request.body.maxBytes, actor));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
};

export default aofRepairRoutes;
