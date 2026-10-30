/**
 * upload-restore.ts (rotas) — aba Backups do projeto → "Restaurar de um arquivo".
 *  GET    /api/backups/projects/:id/upload-restore                       serviços de banco, limite de tamanho, espaço livre
 *  POST   /api/backups/projects/:id/upload-restore/precheck?service=     confere os primeiros bytes (corpo cru, até 16 KB)
 *  PUT    /api/backups/projects/:id/upload-restore/files?service=&name=  recebe o arquivo (corpo cru, gravado em disco ao chegar)
 *  POST   /api/backups/projects/:id/upload-restore/files/:uploadId/check abre um backup do painel (.7z) e confere o banco
 *  DELETE /api/backups/projects/:id/upload-restore/files/:uploadId       descarta o arquivo enviado
 *  POST   /api/backups/projects/:id/upload-restore                       restaura (senha + 2FA + nome do projeto): 202 com o trabalho
 *  GET    /api/backups/projects/:id/upload-restore/jobs/:jobId           andamento e resultado
 *
 * O envio é só um arquivo parado em disco: a reautenticação (senha e código do app, como a correção do Docker e o
 * terminal; mais o código por e-mail, se ligado) é pedida ao COMEÇAR a restaurar, para o código de uso único não
 * vencer durante um envio longo. Nenhuma destas rotas é alcançável por token de API (services/token-policy.ts).
 * O corpo do envio é `application/octet-stream`, lido como fluxo (não existe plugin de multipart aqui): o tamanho
 * máximo vale na rota (bodyLimit) e de novo no serviço, que também mede o disco.
 */
import type { Readable } from "node:stream";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { UploadRestoreCheckRequest, UploadRestoreStartRequest } from "@paas/core";
import { registerErrorHandler } from "../plugins/error-handler.js";
import { confirmIdentity } from "../services/confirm-identity.js";
import type { HttpError } from "../services/http-error.js";
import type { UploadRestoreService } from "../services/upload-restore.js";

declare module "fastify" {
  interface FastifyInstance {
    uploadRestore: UploadRestoreService;
  }
}

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" } },
} as const;
const uploadParams = {
  type: "object",
  required: ["id", "uploadId"],
  properties: { id: idParams.properties.id, uploadId: { type: "string", pattern: "^[0-9a-f]{24}$" } },
} as const;
const jobParams = {
  type: "object",
  required: ["id", "jobId"],
  properties: { id: idParams.properties.id, jobId: { type: "string", pattern: "^[0-9a-f]{12}$" } },
} as const;
const serviceQuery = {
  type: "object",
  required: ["service"],
  properties: { service: { type: "string", minLength: 1, maxLength: 100 }, name: { type: "string", maxLength: 255 } },
} as const;

const startSchema = {
  params: idParams,
  body: {
    type: "object",
    required: ["uploadId", "service", "clean", "backup", "confirm", "currentPassword"],
    additionalProperties: false,
    properties: {
      uploadId: uploadParams.properties.uploadId,
      service: { type: "string", minLength: 1, maxLength: 100 },
      database: { type: "string", minLength: 1, maxLength: 63 },
      clean: { type: "boolean" },
      backup: { type: "string", enum: ["none", "full"] },
      confirm: { type: "string", minLength: 1, maxLength: 200 },
      backupPassword: { type: "string", minLength: 1, maxLength: 1024 },
      currentPassword: { type: "string", minLength: 1, maxLength: 512 },
      code: { type: "string", minLength: 1, maxLength: 64 },
      emailCode: { type: "string", minLength: 1, maxLength: 16 },
    },
  },
} as const;

const checkSchema = {
  params: uploadParams,
  body: {
    type: "object",
    required: ["service"],
    additionalProperties: false,
    properties: {
      service: { type: "string", minLength: 1, maxLength: 100 },
      database: { type: "string", minLength: 1, maxLength: 63 },
      password: { type: "string", minLength: 1, maxLength: 1024 },
    },
  },
} as const;

/** O começo do arquivo que a tela manda antes de subir o arquivo todo. */
const PRECHECK_MAX_BYTES = 16 * 1024;

function sendError(reply: FastifyReply, err: unknown, log: (e: unknown) => void, unreadBody = false): FastifyReply {
  const e = err as Partial<HttpError>;
  if (e.statusCode && e.code) {
    // Recusa no meio de um envio: fecha a conexão em vez de deixar o navegador continuar subindo GB.
    if (unreadBody) reply.header("connection", "close");
    return reply.code(e.statusCode).send({ error: e.code, message: e.message });
  }
  log(err);
  return reply.code(500).send({ error: "internal_error", message: "Não foi possível concluir agora. Tente de novo em instantes." });
}

async function readSmallBody(stream: NodeJS.ReadableStream, max: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > max) throw Object.assign(new Error("Corpo grande demais para a conferência."), { statusCode: 413, code: "too_large" });
    parts.push(buf);
  }
  return Buffer.concat(parts);
}

const uploadRestoreRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);
  const service = app.uploadRestore;
  const logError = (err: unknown) => app.log.error({ err }, "restaurar de um arquivo: falha inesperada");
  const base = "/api/backups/projects/:id/upload-restore";

  // O corpo cru do arquivo chega como fluxo: nada é lido para a memória pelo Fastify.
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));

  // Só pessoa com sessão: o setup token sozinho não restaura banco de ninguém.
  app.addHook("onRequest", async (request, reply) => {
    if (!request.session) return reply.code(401).send({ error: "unauthorized", message: "Entre no painel para restaurar de um arquivo." });
  });

  const idOf = (request: FastifyRequest) => (request.params as { id: string }).id;

  app.get(base, { schema: { params: idParams } }, async (request, reply) => {
    try {
      return reply.header("cache-control", "no-store").send(await service.options(idOf(request)));
    } catch (err) {
      return sendError(reply, err, logError);
    }
  });

  app.post(
    `${base}/precheck`,
    { bodyLimit: PRECHECK_MAX_BYTES, config: { rateLimit: { max: 30, timeWindow: "1 minute" } }, schema: { params: idParams, querystring: serviceQuery } },
    async (request, reply) => {
      try {
        const q = request.query as { service: string; name?: string };
        const head = await readSmallBody(request.body as NodeJS.ReadableStream, PRECHECK_MAX_BYTES);
        return reply.send(await service.precheck(idOf(request), q.service, head, q.name));
      } catch (err) {
        return sendError(reply, err, logError, true);
      }
    },
  );

  app.put(
    `${base}/files`,
    {
      // A rota aceita um pouco mais que o limite do serviço: quem responde "grande demais" com a mensagem certa é ele.
      bodyLimit: service.limit + 1024 * 1024,
      config: { rateLimit: { max: 6, timeWindow: "1 minute" } },
      schema: { params: idParams, querystring: serviceQuery },
    },
    async (request, reply) => {
      try {
        const q = request.query as { service: string; name?: string };
        const length = request.headers["content-length"];
        const uploaded = await service.receive({
          projectId: idOf(request),
          service: q.service,
          actor: request.session!.username,
          stream: request.body as Readable,
          contentLength: length !== undefined && /^\d+$/.test(length) ? Number(length) : null,
          ...(q.name ? { fileName: q.name } : {}),
        });
        return reply.header("cache-control", "no-store").send(uploaded);
      } catch (err) {
        return sendError(reply, err, logError, true);
      }
    },
  );

  app.post(
    `${base}/files/:uploadId/check`,
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } }, schema: checkSchema },
    async (request, reply) => {
      try {
        const { uploadId } = request.params as { uploadId: string };
        return reply.header("cache-control", "no-store").send(await service.check(idOf(request), uploadId, request.body as UploadRestoreCheckRequest));
      } catch (err) {
        return sendError(reply, err, logError);
      }
    },
  );

  app.delete(`${base}/files/:uploadId`, { config: { rateLimit: { max: 30, timeWindow: "1 minute" } }, schema: { params: uploadParams } }, async (request, reply) => {
    try {
      const { uploadId } = request.params as { uploadId: string };
      await service.cancel(idOf(request), uploadId, request.session!.username);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err, logError);
    }
  });

  app.post(base, { config: { rateLimit: { max: 5, timeWindow: "1 minute" } }, schema: startSchema }, async (request, reply) => {
    // Sobrescreve o banco: só pessoa na tela. Token de API, mesmo de administração, não digita senha nem código.
    if (request.session!.token) {
      return reply.code(403).send({
        error: "token_forbidden",
        message: "Restaurar de um arquivo sobrescreve o banco e pede a sua senha (e o código do 2FA). Faça pelo painel, com a sua conta.",
      });
    }
    const body = request.body as UploadRestoreStartRequest;
    let plan;
    try {
      // Tudo o que o pedido pode errar é conferido ANTES de pedir a senha: um código do 2FA é de uso único.
      plan = await service.plan(idOf(request), body);
    } catch (err) {
      return sendError(reply, err, logError);
    }
    const confirmed = await confirmIdentity(app, request, reply, body, {
      requireTwoFactor: true,
      emailCode: "if-enabled",
      action: "backups.upload-restore",
    });
    if (!confirmed) return reply;
    try {
      const job = await service.begin(plan, confirmed.user.username);
      confirmed.attempt.success();
      return reply.code(202).header("cache-control", "no-store").send(job);
    } catch (err) {
      return sendError(reply, err, logError);
    } finally {
      confirmed.attempt.release();
    }
  });

  app.get(`${base}/jobs/:jobId`, { schema: { params: jobParams } }, async (request, reply) => {
    try {
      const { jobId } = request.params as { jobId: string };
      return reply.header("cache-control", "no-store").send(service.job(idOf(request), jobId));
    } catch (err) {
      return sendError(reply, err, logError);
    }
  });
};

export default uploadRestoreRoutes;
