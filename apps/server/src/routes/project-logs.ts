/**
 * project-logs.ts (rotas) — GET /api/projects/:id/logs: o que os containers do
 * projeto escrevem (aba Logs). Somente leitura; a leitura NÃO é auditada (o
 * padrão do painel audita mudanças e a revelação de conteúdo sensível, não
 * consultas — a aba atualiza sozinha a cada poucos segundos e a auditoria
 * viraria ruído). O texto já sai mascarado (services/log-mask.ts).
 */
import type { FastifyPluginAsync } from "fastify";
import { PROJECT_LOGS_SINCE, type ProjectLogsSince } from "@paas/core";
import { registerErrorHandler } from "../plugins/error-handler.js";
import { DockerUnavailableError } from "../services/docker-service.js";
import type { HttpError } from "../services/http-error.js";

// A coerção de tipos do Ajv está desligada: a query chega como texto.
const logsSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
  },
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      service: { type: "string", minLength: 1, maxLength: 63, pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$" },
      tail: { type: "string", pattern: "^([1-9][0-9]{0,2}|1[0-9]{3}|2000)$" },
      since: { type: "string", enum: [...PROJECT_LOGS_SINCE] },
    },
  },
} as const;

const projectLogsRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);

  app.get<{ Params: { id: string }; Querystring: { service?: string; tail?: string; since?: ProjectLogsSince } }>(
    "/api/projects/:id/logs",
    { schema: logsSchema, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      // Cliente que fecha a conexão antes da resposta: a leitura é cancelada e a vaga volta quando ela para.
      // Ligado ANTES de qualquer espera (projeto, variáveis): quem desiste cedo também cancela.
      const gone = new AbortController();
      reply.raw.once("close", () => {
        if (!reply.raw.writableFinished) gone.abort();
      });
      if (request.raw.destroyed || request.socket?.destroyed) gone.abort();
      const project = await app.deployService.getProject(request.params.id);
      if (!project) return reply.code(404).send({ error: "project_not_found", message: "Projeto não encontrado." });
      const { service, tail, since } = request.query;
      let secrets: string[];
      try {
        secrets = await app.deployService.logSecretValues(project);
      } catch {
        // Falha fechada: sem as variáveis não há como mascarar, então nenhum log sai.
        request.log.error("não foi possível ler as variáveis do projeto para mascarar os logs");
        return reply.code(503).send({
          error: "log_masking_unavailable",
          message: "Não foi possível proteger os segredos agora, então os logs não foram lidos. Tente de novo em instantes.",
        });
      }
      // Desistiu enquanto o projeto e as variáveis eram lidos: nem começa a ler os containers.
      if (gone.signal.aborted) return reply.code(499).send({ error: "client_closed", message: "O pedido foi cancelado." });
      try {
        const response = await app.projectLogs.read(
          project,
          { ...(service !== undefined ? { service } : {}), ...(tail !== undefined ? { tail: Number(tail) } : {}), ...(since !== undefined ? { since } : {}) },
          secrets,
          { actor: request.session?.id ?? "anon", human: !request.session?.token, signal: gone.signal },
        );
        return reply.send(response);
      } catch (err) {
        if (err instanceof DockerUnavailableError) {
          return reply.code(503).send({ error: "docker_unavailable", message: err.message });
        }
        const e = err as Partial<HttpError>;
        if (e.statusCode && e.code) return reply.code(e.statusCode).send({ error: e.code, message: e.message });
        throw err;
      }
    },
  );
};

export default projectLogsRoutes;
