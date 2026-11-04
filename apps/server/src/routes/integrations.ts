/**
 * integrations.ts — contas externas conectadas ao painel.
 *  GET    /api/integrations/github        (sessão) status da conta do GitHub
 *  PUT    /api/integrations/github        (sessão) conecta (token somente leitura)
 *  DELETE /api/integrations/github        (sessão) desconecta
 *  GET    /api/integrations/github/repos  (sessão) repositórios da conta
 *
 * O token nunca volta pela API nem vai para a auditoria (ver
 * services/github-integration.ts).
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { registerErrorHandler } from "../plugins/error-handler.js";

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const e = err as { statusCode?: number; code?: string; message?: string };
  if (!e.statusCode) throw err;
  return reply.code(e.statusCode).send({ error: e.code ?? "error", message: e.message ?? "Erro." });
}

const integrationRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);
  const github = () => app.deployService.github;

  app.get("/api/integrations/github", async (_request, reply) => reply.send(await github().status()));

  app.put<{ Body: { token: string } }>(
    "/api/integrations/github",
    {
      schema: {
        body: {
          type: "object",
          required: ["token"],
          additionalProperties: false,
          properties: { token: { type: "string", minLength: 1, maxLength: 512 } },
        },
      },
    },
    async (request, reply) => {
      try {
        const status = await github().connect(request.body.token);
        await app.auditService.record({
          action: "integration.github_connected",
          target: status.login ?? undefined,
          detail: `Conta do GitHub "${status.login}" conectada (token somente leitura).`,
        });
        return reply.send(status);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete("/api/integrations/github", async (_request, reply) => {
    const before = await github().status();
    await github().disconnect();
    if (before.connected) {
      await app.auditService.record({
        action: "integration.github_disconnected",
        target: before.login ?? undefined,
        detail: `Conta do GitHub "${before.login}" desconectada.`,
      });
    }
    return reply.send({ ok: true });
  });

  app.get("/api/integrations/github/repos", async (_request, reply) => {
    try {
      return reply.send({ repos: await github().repos() });
    } catch (err) {
      return sendError(reply, err);
    }
  });
};

export default integrationRoutes;
