/**
 * server-logs.ts (rotas) — GET /api/server-logs: página "Logs do servidor" (painel, proxy, servidor de e-mail,
 * Docker e SSH da VPS). Somente leitura.
 *
 * Acesso: SÓ sessão. Nenhum token de API alcança (services/token-policy-table.ts: "denied"); o journal do SSH traz
 * endereços IP de quem tentou entrar. Limite de 30 pedidos por minuto. A leitura é AUDITADA (quem, quando, fonte e
 * tamanho do pedido — nunca o conteúdo), no máximo uma entrada por pessoa e fonte por minuto, porque a tela repete o
 * pedido ao trocar de filtro e a auditoria viraria ruído.
 */
import type { FastifyPluginAsync } from "fastify";
import { PROJECT_LOGS_SINCE, SERVER_LOG_SOURCE_IDS, type ProjectLogsSince } from "@paas/core";
import { registerErrorHandler } from "../plugins/error-handler.js";
import { DockerUnavailableError } from "../services/docker-service.js";
import type { HttpError } from "../services/http-error.js";

declare module "fastify" {
  interface FastifyInstance {
    serverLogs: import("../services/server-logs.js").ServerLogsService;
  }
}

const AUDIT_EVERY_MS = 60_000;
const AUDIT_MAX_KEYS = 200;

// A coerção de tipos do Ajv está desligada: a query chega como texto.
const schema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      source: { type: "string", enum: [...SERVER_LOG_SOURCE_IDS] },
      tail: { type: "string", pattern: "^([1-9][0-9]{0,2}|1[0-9]{3}|2000)$" },
      since: { type: "string", enum: [...PROJECT_LOGS_SINCE] },
    },
  },
} as const;

const serverLogsRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);
  const audited = new Map<string, number>();

  app.get<{ Querystring: { source?: string; tail?: string; since?: ProjectLogsSince } }>(
    "/api/server-logs",
    { schema, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const gone = new AbortController();
      reply.raw.once("close", () => {
        if (!reply.raw.writableEnded) gone.abort();
      });
      if (reply.raw.destroyed) gone.abort();
      const { source, tail, since } = request.query;
      const actor = request.session?.username ?? "operador";
      try {
        const response = await app.serverLogs.read(
          { ...(source !== undefined ? { source } : {}), ...(tail !== undefined ? { tail: Number(tail) } : {}), ...(since !== undefined ? { since } : {}) },
          { actor: request.session?.id ?? "anon", human: !request.session?.token, signal: gone.signal },
        );
        const key = `${actor}|${source ?? "all"}`;
        const now = Date.now();
        if (now - (audited.get(key) ?? 0) >= AUDIT_EVERY_MS) {
          if (audited.size >= AUDIT_MAX_KEYS) audited.clear();
          audited.set(key, now);
          await app.auditService
            .record({
              actor,
              action: "server-logs.read",
              target: source ?? "all",
              detail: `Logs do servidor lidos (fonte: ${source ?? "containers do painel"}, ${response.lines.length} linhas, período: ${response.since ?? "todo o disponível"}).`,
            })
            .catch(() => undefined);
        }
        return reply.header("cache-control", "no-store").send(response);
      } catch (err) {
        if (err instanceof DockerUnavailableError) return reply.code(503).send({ error: "docker_unavailable", message: err.message });
        const e = err as Partial<HttpError>;
        if (e.statusCode && e.code) return reply.code(e.statusCode).send({ error: e.code, message: e.message });
        throw err;
      }
    },
  );
};

export default serverLogsRoutes;
