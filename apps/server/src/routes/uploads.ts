/**
 * uploads.ts — código vindo do computador de quem usa o painel.
 *  POST /api/uploads                         (sessão) abre um envio → { id, dir }
 *  PUT  /api/uploads/:id/file?path=<relativo> (sessão) um arquivo, corpo cru
 *  GET  /api/fs/dirs?path=<pasta>             (sessão) subpastas, só dentro da
 *                                             pasta de projetos
 *
 * O arquivo chega cru (application/octet-stream), um por requisição: sem
 * biblioteca de upload a mais. `dir` é usado como origem do projeto (modo
 * "upload"). Ver services/upload-service.ts.
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { registerErrorHandler } from "../plugins/error-handler.js";
import { UPLOAD_MAX_FILE_BYTES, UploadService } from "../services/upload-service.js";

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const e = err as { statusCode?: number; code?: string; message?: string };
  if (!e.statusCode) throw err;
  return reply.code(e.statusCode).send({ error: e.code ?? "error", message: e.message ?? "Erro." });
}

const uploadRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);
  const uploads = new UploadService(app.config.projectsDir);

  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: UPLOAD_MAX_FILE_BYTES },
    (_request, body, done) => done(null, body),
  );

  app.post("/api/uploads", async (_request, reply) => {
    return reply.send(await uploads.begin());
  });

  app.put<{ Params: { id: string }; Querystring: { path: string } }>(
    "/api/uploads/:id/file",
    {
      schema: {
        params: { type: "object", properties: { id: { type: "string", pattern: "^[0-9a-f]{16}$" } }, required: ["id"] },
        querystring: {
          type: "object",
          required: ["path"],
          additionalProperties: false,
          properties: { path: { type: "string", minLength: 1, maxLength: 1024 } },
        },
      },
    },
    async (request, reply) => {
      const body = request.body;
      if (!Buffer.isBuffer(body)) {
        return reply.code(415).send({ error: "invalid_content_type", message: "Envie o arquivo como application/octet-stream." });
      }
      try {
        await uploads.putFile(request.params.id, request.query.path, body);
      } catch (err) {
        return sendError(reply, err);
      }
      return reply.code(204).send();
    },
  );

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
        return reply.send(await uploads.listDirs(request.query.path));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
};

export default uploadRoutes;
