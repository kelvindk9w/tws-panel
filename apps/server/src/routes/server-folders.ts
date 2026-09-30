/**
 * server-folders.ts — navegação nas pastas do servidor.
 *  GET /api/fs/dirs?path=<pasta>  (sessão) subpastas, só dentro da pasta de projetos
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { registerErrorHandler } from "../plugins/error-handler.js";
import { ServerFolders } from "../services/server-folders.js";

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const e = err as { statusCode?: number; code?: string; message?: string };
  if (!e.statusCode) throw err;
  return reply.code(e.statusCode).send({ error: e.code ?? "error", message: e.message ?? "Erro." });
}

const serverFolderRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);
  const folders = new ServerFolders(app.config.projectsDir);

  app.get<{ Querystring: { path?: string } }>(
    "/api/fs/dirs",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { path: { type: "string", minLength: 1, maxLength: 1024 } },
        },
      },
    },
    async (request, reply) => {
      try {
        return reply.send(await folders.listDirs(request.query.path));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
};

export default serverFolderRoutes;
