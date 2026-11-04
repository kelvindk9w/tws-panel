/**
 * docker-build.ts — Saúde da VPS → Docker e BuildKit.
 *  GET  /api/health/docker-build       o buildx no Docker do painel e no da VPS (e a origem do Docker da VPS)
 *  POST /api/health/docker-build/fix   instala o plugin buildx no Docker da VPS (pacote certo pela origem)
 *
 * A correção mexe no sistema da VPS (instala pacote), então pede o mesmo que as ações de acesso à VPS: senha do
 * painel + código do app (2FA obrigatório) + (quando o usuário ligou) o código por e-mail. Só sessão humana:
 * nenhum token de API alcança estas rotas (services/token-policy-table.ts).
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { DockerBuildFixResponse, DockerBuildStatusResponse } from "@paas/core";
import { registerErrorHandler } from "../plugins/error-handler.js";
import { confirmIdentity } from "../services/confirm-identity.js";
import type { DockerBuildService } from "../services/docker-build-service.js";
import type { HttpError } from "../services/http-error.js";

declare module "fastify" {
  interface FastifyInstance {
    dockerBuildService: DockerBuildService;
  }
}

function sendError(reply: FastifyReply, err: unknown, log: (e: unknown) => void): FastifyReply {
  const e = err as Partial<HttpError>;
  if (!e.statusCode) log(err);
  return reply.code(e.statusCode ?? 500).send({
    error: e.code ?? "internal_error",
    message: e.statusCode
      ? e.code === "host_failed"
        ? `${e.message} Se o código por e-mail estiver ligado, peça outro para tentar de novo: o anterior já foi usado.`
        : e.message
      : "Não foi possível concluir agora. Tente de novo em instantes.",
  });
}

const dockerBuildRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);
  const logError = (err: unknown) => app.log.error({ err }, "docker e buildkit: falha inesperada");

  app.get("/api/health/docker-build", async (_request, reply) => {
    try {
      const status: DockerBuildStatusResponse = await app.dockerBuildService.status();
      return reply.send(status);
    } catch (err) {
      return sendError(reply, err, logError);
    }
  });

  app.post<{ Body: { currentPassword: string; code?: string; emailCode?: string } }>(
    "/api/health/docker-build/fix",
    {
      schema: {
        body: {
          type: "object",
          required: ["currentPassword"],
          additionalProperties: false,
          properties: {
            currentPassword: { type: "string", minLength: 1, maxLength: 512 },
            code: { type: "string", minLength: 1, maxLength: 64 },
            emailCode: { type: "string", minLength: 1, maxLength: 16 },
          },
        },
      },
    },
    async (request, reply) => {
      const confirmed = await confirmIdentity(app, request, reply, request.body, {
        requireTwoFactor: true,
        emailCode: "if-enabled",
        action: "docker.buildx",
      });
      if (!confirmed) return reply;
      try {
        const status = await app.dockerBuildService.fix(confirmed.user.username);
        const alertWarning = await app.emailCode.alertAccessChange(confirmed.user, "plugin buildx instalado no Docker da VPS", request.ip);
        confirmed.attempt.success();
        const body: DockerBuildFixResponse = { status, ...(alertWarning ? { alertWarning } : {}) };
        return reply.send(body);
      } catch (err) {
        return sendError(reply, err, logError);
      } finally {
        confirmed.attempt.release();
      }
    },
  );
};

export default dockerBuildRoutes;
