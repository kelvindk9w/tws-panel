/**
 * project-database.ts (rotas) — aba Banco do projeto.
 *  GET  /api/projects/:id/database               visão geral: motor, versão, tabelas, comandos do framework (sessão)
 *  POST /api/projects/:id/database/sql/read      consulta de LEITURA, uma ou várias instruções (sessão; o banco impõe somente-leitura)
 *  GET  /api/projects/:id/database/unlock        a edição está liberada? quanto falta? (sessão)
 *  POST /api/projects/:id/database/unlock        LIBERA a edição: senha + 2FA (+ código por e-mail se ligado), backup completo opcional
 *  POST /api/projects/:id/database/lock          bloqueia de volta agora (sessão)
 *  POST /api/projects/:id/database/truncate      esvaziar tabelas              ┐ só com a edição liberada (nesta sessão e neste
 *  POST /api/projects/:id/database/reset         zerar o banco                  │ projeto); sem senha de novo. Zerar e migrate:fresh
 *  POST /api/projects/:id/database/sql/write     SQL de escrita (várias)        │ pedem o nome do projeto digitado. Respondem 202 com
 *  POST /api/projects/:id/database/command       comando do framework          ┘ o trabalho que a tela acompanha em GET .../jobs/:jobId
 *  GET  /api/projects/:id/database/jobs/:jobId   andamento e resultado de um trabalho
 *  GET  /api/settings/database                   Configurações → Banco de dados: duração da liberação e renovação com o uso (sessão)
 *  PUT  /api/settings/database                   muda; afrouxar (mais longo ou renovar com o uso) pede senha + 2FA, apertar não
 *
 * Nenhuma destas rotas é alcançável por token de API (services/token-policy.ts) e o gancho abaixo recusa de novo;
 * a liberação é da sessão de cookie. Tudo que o pedido pode errar (tabela inexistente, SQL com instrução recusada,
 * comando fora da lista) é conferido ANTES de renovar a liberação ou pedir a senha, para um código de 2FA (de uso
 * único) não ser gasto à toa. A Auditoria guarda ator, ação e tabelas; nunca SQL nem valores.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  DATABASE_COMMANDS,
  DATABASE_COMMAND_IDS,
  DATABASE_SETTINGS_DEFAULT,
  DATABASE_SQL_MAX_LENGTH,
  DATABASE_TRUNCATE_MAX_TABLES,
  DATABASE_UNLOCK_DURATIONS,
  databaseSettingsLoosens,
  type DatabaseActionRequest,
  type DatabaseCommandRequest,
  type DatabaseJobStarted,
  type DatabaseSettings,
  type DatabaseSettingsResponse,
  type DatabaseSqlReadRequest,
  type DatabaseSqlWriteRequest,
  type DatabaseTruncateRequest,
  type DatabaseUnlockRequest,
  type UpdateDatabaseSettingsRequest,
} from "@paas/core";
import { registerErrorHandler } from "../plugins/error-handler.js";
import { confirmIdentity } from "../services/confirm-identity.js";
import type { DatabaseAction, DatabasePlan, DatabaseService } from "../services/database-service.js";
import { DURATION_LABELS, type DatabaseUnlock } from "../services/database-unlock.js";
import type { DatabaseSettingsStore } from "../services/database-settings.js";
import type { HttpError } from "../services/http-error.js";

declare module "fastify" {
  interface FastifyInstance {
    databaseService: DatabaseService;
    databaseUnlock: DatabaseUnlock;
    databaseSettings: DatabaseSettingsStore;
  }
}

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
} as const;

/** Campos da reautenticação (liberar a edição; afrouxar a configuração). */
const reauthFields = {
  currentPassword: { type: "string", minLength: 1, maxLength: 512 },
  code: { type: "string", minLength: 1, maxLength: 64 },
  emailCode: { type: "string", minLength: 1, maxLength: 16 },
} as const;

/** Campos comuns das ações que alteram dados (já com a edição liberada): sem senha. */
const actionFields = {
  confirm: { type: "string", minLength: 1, maxLength: 200 },
  backup: { type: "string", enum: ["none", "full"] },
} as const;

const body = (extra: Record<string, unknown>, required: readonly string[] = []) => ({
  type: "object",
  required: [...required],
  additionalProperties: false,
  properties: { ...actionFields, ...extra },
});

const unlockSchema = {
  params: idParams,
  body: {
    type: "object",
    required: ["currentPassword", "backup"],
    additionalProperties: false,
    properties: { ...reauthFields, backup: { type: "string", enum: ["none", "full"] } },
  },
} as const;
const settingsSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      ...reauthFields,
      unlockDuration: { type: "string", enum: [...DATABASE_UNLOCK_DURATIONS] },
      renewOnUse: { type: "boolean" },
    },
  },
} as const;

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
  body: body({ sql: { type: "string", minLength: 1, maxLength: DATABASE_SQL_MAX_LENGTH }, transaction: { type: "boolean" } }, ["sql"]),
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

  // Só com sessão: o setup token sozinho não chega ao banco de ninguém. E nunca token de API: a liberação da edição
  // é de uma sessão de cookie (a lista de exclusão dos tokens já barra; esta é a segunda trava).
  app.addHook("onRequest", async (request, reply) => {
    if (!request.session) return reply.code(401).send({ error: "unauthorized", message: "Entre no painel para usar a aba Banco." });
    if (request.session.token) {
      return reply.code(403).send({ error: "token_forbidden", message: "O banco do projeto é administrado só pelo painel, com a sua conta (não por um token)." });
    }
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
   * Fluxo comum das ações que alteram dados: exige a edição LIBERADA (nesta sessão e neste projeto), confere o pedido
   * (sem tocar em nada), confere o nome digitado nas ações que apagam tudo (zerar, migrate:fresh), renova a
   * liberação (se a configuração manda) e só então começa o trabalho.
   */
  async function destructive(
    request: FastifyRequest<{ Params: { id: string }; Body: DatabaseActionRequest }>,
    reply: FastifyReply,
    action: DatabaseAction,
  ): Promise<FastifyReply> {
    try {
      const session = request.session!;
      if (!app.databaseUnlock.isUnlocked(session.id, request.params.id)) {
        return reply.code(403).send({
          error: "unlock_required",
          message: "Libere a edição do banco para rodar comandos que alteram dados.",
        });
      }
      const plan: DatabasePlan = await service.plan(request.params.id, action);
      const wipesAll = action.kind === "reset" || (action.kind === "command" && DATABASE_COMMANDS[action.command].dropsData);
      if (wipesAll && request.body.confirm !== plan.project.name) {
        return reply.code(400).send({ error: "confirm_mismatch", message: "Digite o nome do projeto exatamente como ele aparece para confirmar." });
      }
      app.databaseUnlock.use(session.id, request.params.id);
      const job = await service.begin(plan, session.username, request.body.backup ?? "none");
      const started: DatabaseJobStarted = { job };
      return reply.code(202).send(started);
    } catch (err) {
      return sendError(reply, err, logError);
    }
  }

  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/database/unlock",
    { schema: { params: idParams }, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => reply.header("cache-control", "no-store").send(app.databaseUnlock.status(request.session!.id, request.params.id)),
  );

  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/database/lock",
    { schema: { params: idParams }, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      app.databaseUnlock.lock(request.session!.id, request.params.id);
      return reply.header("cache-control", "no-store").send(app.databaseUnlock.status(request.session!.id, request.params.id));
    },
  );

  app.post<{ Params: { id: string }; Body: DatabaseUnlockRequest }>(
    "/api/projects/:id/database/unlock",
    { schema: unlockSchema, config: DESTRUCTIVE_LIMIT },
    async (request, reply) => {
      try {
        const session = request.session!;
        const label = DURATION_LABELS[app.databaseSettings.current().unlockDuration];
        // Confere o projeto ANTES de gastar o código de 2FA; a liberação em si acontece depois do backup (se pedido).
        const grantFor = async (): Promise<DatabasePlan> => {
          const found = await service.projectRef(request.params.id);
          return service.planUnlock(request.params.id, `(por ${label})`, () => {
            app.databaseUnlock.grant(session.id, found, session.username);
          });
        };
        const plan = await grantFor();
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
    },
  );

  const settingsView = (): DatabaseSettingsResponse => ({
    settings: app.databaseSettings.current(),
    defaults: { ...DATABASE_SETTINGS_DEFAULT },
    durations: DATABASE_UNLOCK_DURATIONS,
  });

  app.get("/api/settings/database", async (_request, reply) => reply.header("cache-control", "no-store").send(settingsView()));

  app.put<{ Body: UpdateDatabaseSettingsRequest }>("/api/settings/database", { schema: settingsSchema }, async (request, reply) => {
    const before: DatabaseSettings = app.databaseSettings.current();
    const next: DatabaseSettings = {
      unlockDuration: request.body.unlockDuration ?? before.unlockDuration,
      renewOnUse: request.body.renewOnUse ?? before.renewOnUse,
    };
    let actor = request.session!.username;
    let attempt: { success(): void; release(): void } | null = null;
    // Alongar a janela ou ligar a renovação é um rebaixamento de segurança: pede senha + 2FA (como ligar o MCP).
    // Encurtar ou desligar a renovação só pede a sessão.
    if (databaseSettingsLoosens(before, next)) {
      const confirmed = await confirmIdentity(app, request, reply, request.body, { emailCode: "if-enabled", action: "database.write" });
      if (!confirmed) return reply;
      attempt = confirmed.attempt;
      actor = confirmed.user.username;
    }
    try {
      if (next.unlockDuration !== before.unlockDuration || next.renewOnUse !== before.renewOnUse) {
        try {
          await app.databaseSettings.set(next);
        } catch (err) {
          request.log.error({ err }, "falha ao gravar a configuração do banco de dados");
          return reply.code(500).send({ error: "storage_write_failed", message: "Não foi possível salvar a alteração no servidor. Nada foi alterado." });
        }
        attempt?.success();
        await app.auditService.record({
          actor,
          action: "database.settings_changed",
          detail: `Liberação da edição do banco: ${DURATION_LABELS[before.unlockDuration]} → ${DURATION_LABELS[next.unlockDuration]}; renovar com o uso: ${before.renewOnUse ? "sim" : "não"} → ${next.renewOnUse ? "sim" : "não"}.`,
        });
      }
      return reply.header("cache-control", "no-store").send(settingsView());
    } finally {
      attempt?.release();
    }
  });

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
    (request, reply) => destructive(request, reply, { kind: "sql", sql: request.body.sql, transaction: request.body.transaction !== false }),
  );

  app.post<{ Params: { id: string }; Body: DatabaseCommandRequest }>(
    "/api/projects/:id/database/command",
    { schema: commandSchema, config: DESTRUCTIVE_LIMIT },
    (request, reply) => destructive(request, reply, { kind: "command", command: request.body.command, service: request.body.service }),
  );
};

export default databaseRoutes;
