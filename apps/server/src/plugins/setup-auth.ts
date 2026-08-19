import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { SETUP_TOKEN_HEADER, SETUP_TOKEN_QUERY } from "@paas/core";
import { tokenMatches } from "../services/setup-token.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Setup token carregado na inicialização (null = não configurado). */
    setupToken: string | null;
  }
}

function extractToken(request: FastifyRequest): string | null {
  const header = request.headers[SETUP_TOKEN_HEADER];
  if (typeof header === "string" && header.length > 0) return header;
  const query = (request.query as Record<string, unknown> | undefined)?.[SETUP_TOKEN_QUERY];
  if (typeof query === "string" && query.length > 0) return query;
  return null;
}

/**
 * Auth de setup: todo endpoint /api/* (exceto /api/setup/verify-token)
 * exige o setup token até o setup ser concluído.
 */
const setupAuthPlugin: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    if (request.url.startsWith("/api/setup/verify-token")) return;

    if (!app.setupToken) {
      return reply.code(503).send({
        error: "setup_token_missing",
        message:
          "Servidor sem setup token configurado. Defina SETUP_TOKEN ou crie o arquivo de token (veja scripts/install.sh).",
      });
    }

    const provided = extractToken(request);
    if (!provided || !tokenMatches(provided, app.setupToken)) {
      return reply.code(401).send({
        error: "unauthorized",
        message: "Setup token inválido ou ausente.",
      });
    }
  });
};

export default fp(setupAuthPlugin, { name: "setup-auth" });
