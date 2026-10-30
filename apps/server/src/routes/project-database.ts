/**
 * project-database.ts (rotas) — aba Banco do projeto.
 *  GET  /api/projects/:id/database               visão geral: motor, versão, tabelas, comandos do framework (sessão)
 *  POST /api/projects/:id/database/sql/read      consulta de LEITURA (sessão; o banco impõe somente-leitura)
 *  POST /api/projects/:id/database/truncate      esvaziar tabelas              ┐ senha + 2FA (+ código por e-mail se ligado),
 *  POST /api/projects/:id/database/reset         zerar o banco                  │ nome do projeto digitado e escolha do backup.
 *  POST /api/projects/:id/database/sql/write     SQL de escrita                 │ Respondem 202 com o trabalho (backup opcional +
 *  POST /api/projects/:id/database/command       comando do framework          ┘ ação) que a tela acompanha em GET .../jobs/:jobId
 *  GET  /api/projects/:id/database/jobs/:jobId   andamento e resultado de um trabalho
 *
 * Nenhuma destas rotas é alcançável por token de API (services/token-policy.ts). Tudo que o pedido pode errar
 * (tabela inexistente, SQL com mais de uma instrução, comando fora da lista) é conferido ANTES de pedir a senha,
 * para um código de 2FA (de uso único) não ser gasto à toa. A Auditoria guarda ator, ação e tabelas; nunca SQL
 * nem valores.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  DATABASE_COMMAND_IDS,
  DATABASE_SQL_MAX_LENGTH,
  DATABASE_TRUNCATE_MAX_TABLES,
  type DatabaseActionRequest,
  type DatabaseCommandRequest,
  type DatabaseJobStarted,
  type DatabaseSqlReadRequest,
  type DatabaseSqlWriteRequest,
  type DatabaseTruncateRequest,
} from "@paas/core";
import { registerErrorHandler } from "../plugins/error-handler.js";
import { confirmIdentity } from "../services/confirm-identity.js";
import type { DatabaseAction, DatabasePlan, DatabaseService } from "../services/database-service.js";
import type { HttpError } from "../services/http-error.js";

declare module "fastify" {
  interface FastifyInstance {
    databaseService: DatabaseService;
  }
}

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
} as const;

/** Campos comuns das ações destrutivas. */
const actionFields = {
  currentPassword: { type: "string", minLength: 1, maxLength: 512 },
  code: { type: "string", minLength: 1, maxLength: 64 },
  emailCode: { type: "string", minLength: 1, maxLength: 16 },
  confirm: { type: "string", minLength: 1, maxLength: 200 },
  backup: { type: "string", enum: ["none", "full"] },
} as const;
const actionRequired = ["currentPassword", "confirm", "backup"] as const;

const body = (extra: Record<string, unknown>, required: readonly string[] = []) => ({
  type: "object",
  required: [...actionRequired, ...required],
  additionalProperties: false,
  properties: { ...actionFields, ...extra },
});

const truncateSchema = {
  params: idParams,
  body: body(
    {
      tables: {
        type: "array",
        minItems: 1,
        maxItems: DATABASE_TRUNCATE_MAX_TABLES,
        items: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: { schema: { type: ["string", "null"], maxLength: 255 }, name: { type: "string", minLength: 1, maxLength: 255 } },
        },
      },
      cascade: { type: "boolean" },
    },
    ["tables"],
  ),
} as const;
const resetSchema = { params: idParams, body: body({}) } as const;
const sqlWriteSchema = {
  params: idParams,
  body: body({ sql: { type: "string", minLength: 1, maxLength: DATABASE_SQL_MAX_LENGTH } }, ["sql"]),
} as const;
const commandSchema = {
  params: idParams,
  body: body({ command: { type: "string", enum: [...DATABASE_COMMAND_IDS] }, service: { type: "string", minLength: 1, maxLength: 100 } }, ["command"]),
} as const;
const sqlReadSchema = {
  params: idParams,
  body: {
    type: "object",
    required: ["sql"],
    additionalProperties: false,
    properties: { sql: { type: "string", minLength: 1, maxLength: DATABASE_SQL_MAX_LENGTH } },
  },
} as const;

/** Limite das rotas destrutivas, além do limite de tentativas da senha (action-guard.ts). */
const DESTRUCTIVE_LIMIT = { rateLimit: { max: 10, timeWindow: "1 minute" } } as const;

function sendError(reply: FastifyReply, err: unknown, log: (e: unknown) => void): FastifyReply {
  const e = err as Partial<HttpError>;
  if (e.statusCode && e.code) return reply.code(e.statusCode).send({ error: e.code, message: e.message, ...(e.details ?? {}) });
  log(err);
  return reply.code(500).send({ error: "internal_error", message: "Não foi possível concluir agora. Tente de novo em instantes." });
}

const databaseRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);
  const service = app.databaseService;
  const logError = (err: unknown) => app.log.error({ err }, "banco do projeto: falha inesperada");

  // Só com sessão: o setup token sozinho não chega ao banco de ninguém.
  app.addHook("onRequest", async (request, reply) => {
    if (!request.session) return reply.code(401).send({ error: "unauthorized", message: "Entre no painel para usar a aba Banco." });
  });

  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/database",
    { schema: { params: idParams }, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        reply.header("cache-control", "no-store");
        return reply.send(await service.overview(request.params.id));
      } catch (err) {
        return sendError(reply, err, logError);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: DatabaseSqlReadRequest }>(
    "/api/projects/:id/database/sql/read",
    { schema: sqlReadSchema, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        reply.header("cache-control", "no-store");
        return reply.send(await service.readQuery(request.params.id, request.body.sql));
      } catch (err) {
        return sendError(reply, err, logError);
      }
    },
  );

  app.get<{ Params: { id: string; jobId: string } }>(
    "/api/projects/:id/database/jobs/:jobId",
    {
      schema: {
        params: { type: "object", required: ["id", "jobId"], properties: { id: { type: "string", maxLength: 64 }, jobId: { type: "string", maxLength: 64 } } },
      },
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      try {
        reply.header("cache-control", "no-store");
        return reply.send(service.job(request.params.id, request.params.jobId));
      } catch (err) {
        return sendError(reply, err, logError);
      }
    },
  );

  /**
   * Fluxo comum das ações destrutivas: confere o pedido (sem tocar em nada), confere o nome digitado,
   * confirma a identidade e só então começa o trabalho.
   */
  async function destructive(
    request: FastifyRequest<{ Params: { id: string }; Body: DatabaseActionRequest }>,
    reply: FastifyReply,
    action: DatabaseAction,
  ): Promise<FastifyReply> {
    try {
      const plan: DatabasePlan = await service.plan(request.params.id, action);
      if (request.body.confirm !== plan.project.name) {
        return reply.code(400).send({ error: "confirm_mismatch", message: "Digite o nome do projeto exatamente como ele aparece para confirmar." });
      }
      const confirmed = await confirmIdentity(app, request, reply, request.body, {
        requireTwoFactor: true,
        emailCode: "if-enabled",
        action: "database.write",
      });
      if (!confirmed) return reply;
      try {
        const job = await service.begin(plan, confirmed.user.username, request.body.backup);
        confirmed.attempt.success();
        const started: DatabaseJobStarted = { job };
        return reply.code(202).send(started);
      } finally {
        confirmed.attempt.release();
      }
    } catch (err) {
      return sendError(reply, err, logError);
    }
  }

  app.post<{ Params: { id: string }; Body: DatabaseTruncateRequest }>(
    "/api/projects/:id/database/truncate",
    { schema: truncateSchema, config: DESTRUCTIVE_LIMIT },
    (request, reply) => destructive(request, reply, { kind: "truncate", tables: request.body.tables, cascade: request.body.cascade === true }),
  );

  app.post<{ Params: { id: string }; Body: DatabaseActionRequest }>(
    "/api/projects/:id/database/reset",
    { schema: resetSchema, config: DESTRUCTIVE_LIMIT },
    (request, reply) => destructive(request, reply, { kind: "reset" }),
  );

  app.post<{ Params: { id: string }; Body: DatabaseSqlWriteRequest }>(
    "/api/projects/:id/database/sql/write",
    { schema: sqlWriteSchema, config: DESTRUCTIVE_LIMIT },
    (request, reply) => destructive(request, reply, { kind: "sql", sql: request.body.sql }),
  );

  app.post<{ Params: { id: string }; Body: DatabaseCommandRequest }>(
    "/api/projects/:id/database/command",
    { schema: commandSchema, config: DESTRUCTIVE_LIMIT },
    (request, reply) => destructive(request, reply, { kind: "command", command: request.body.command, service: request.body.service }),
  );
};

export default databaseRoutes;
