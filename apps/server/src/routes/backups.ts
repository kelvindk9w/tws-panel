/**
 * backups.ts — Configurações → Backups e a aba Backups do projeto (todas com sessão;
 * só com o setup token, sem sessão, respondem 401).
 *  GET    /api/backups                          situação: destino, criptografia, itens, fila, histórico
 *  PUT    /api/backups/destination              armazenamento S3/R2 (testa antes de salvar; a chave secreta fica cifrada)
 *  POST   /api/backups/destination/test         "Testar conexão"
 *  DELETE /api/backups/destination              desconecta (os backups lá continuam lá)
 *  PUT    /api/backups/encryption               liga/desliga a criptografia da cópia externa
 *  PUT    /api/backups/password                 define/troca a senha ({ password, acknowledged })
 *  GET    /api/backups/password/suggest         "Sugerir uma frase forte"
 *  POST   /api/backups/password/reveal          ver a senha, confirmando a senha de login
 *  POST   /api/backups/password/test            "Testar minha senha"
 *  PUT    /api/backups/defaults                 "Padrão dos projetos" (frequência, cópias, ligado)
 *  POST   /api/backups/defaults/apply           "Aplicar também nestes projetos" ({ projectIds })
 *  PUT    /api/backups/targets/:target          frequência, retenção, ligado, itens marcados, pastas extras
 *  POST   /api/backups/targets/:target/use-defaults  "Voltar ao padrão" (só projeto)
 *  POST   /api/backups/targets/:target/run      "Fazer backup agora"
 *  GET    /api/backups/targets/:target/points   datas disponíveis para restaurar (VPS e externo)
 *  POST   /api/backups/targets/:target/restore  restaurar (confirmação digitando o nome)
 *  POST   /api/backups/targets/:target/verify   "Conferir" um backup ({ fileName }) ou todos do item (sem fileName)
 *  POST   /api/backups/verify                   "Conferir todos" de todos os itens
 *  GET    /api/backups/records/:id              progresso de um backup/restauração
 *  GET    /api/backups/projects/:id             aba Backups do projeto
 *  POST   /api/backups/projects/:id/detect      detectar de novo
 *  PUT    /api/backups/projects/:id/restore-check      ligar/desligar "Validar o backup do banco restaurando em outro projeto"
 *  POST   /api/backups/projects/:id/restore-check/run  "Testar agora" (confirmação digitada: nome do projeto de destino)
 *  GET    /api/backups/catalog                  "Restaurar de outro servidor": o que existe no armazenamento
 *
 * :target = "panel", "email" ou "project:<id>". O serviço (backup-service.ts)
 * é criado em app.ts no escopo raiz. Senha e chave secreta só entram: a
 * senha sai apenas na revelação (com Cache-Control: no-store).
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  BACKUP_FREQUENCIES,
  MAX_BACKUP_KEEP,
  MAX_BACKUP_PASSWORD_LENGTH,
  type BackupApplyDefaultsRequest,
  type BackupDefaultsRequest,
  type BackupDestinationRequest,
  type BackupPasswordRequest,
  type BackupRestoreRequest,
  type BackupTargetSettingsRequest,
  type BackupVerifyRequest,
  RESTORE_CHECK_FREQUENCIES,
  type RestoreCheckRunRequest,
  type RestoreCheckSettingsRequest,
} from "@paas/core";
import { registerErrorHandler } from "../plugins/error-handler.js";
import { confirmIdentity } from "../services/confirm-identity.js";
import { httpError, type HttpError } from "../services/http-error.js";
import { maskProjectBackupView } from "../services/reach-masks.js";
import { limitedProjectIds } from "../services/request-reach.js";
import type { Session } from "../services/session-store.js";
import { projectOfTarget } from "../services/token-policy.js";
import type { BackupService } from "../services/backup-service.js";

declare module "fastify" {
  interface FastifyInstance {
    backupService: BackupService;
  }
}

const TARGET = { type: "string", pattern: "^(panel|email|project:[A-Za-z0-9_-]{1,64})$" } as const;
const targetParams = { type: "object", required: ["target"], properties: { target: TARGET } } as const;
const idParams = { type: "object", required: ["id"], properties: { id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" } } } as const;

const destinationSchema = {
  body: {
    type: "object",
    required: ["provider", "endpoint", "region", "bucket", "accessKeyId"],
    additionalProperties: false,
    properties: {
      provider: { type: "string", enum: ["r2", "s3"] },
      endpoint: { type: "string", minLength: 8, maxLength: 300 },
      region: { type: "string", maxLength: 64, pattern: "^[A-Za-z0-9-]*$" },
      bucket: { type: "string", minLength: 3, maxLength: 63, pattern: "^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$" },
      accessKeyId: { type: "string", minLength: 3, maxLength: 200, pattern: "^\\S+$" },
      secretAccessKey: { type: "string", maxLength: 300 },
    },
  },
} as const;

const defaultsSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      frequencyHours: { type: "integer", enum: [...BACKUP_FREQUENCIES] },
      localKeep: { type: "integer", minimum: 1, maximum: MAX_BACKUP_KEEP },
      remoteKeep: { type: "integer", minimum: 1, maximum: MAX_BACKUP_KEEP },
    },
  },
} as const;

const applyDefaultsSchema = {
  body: {
    type: "object",
    required: ["projectIds"],
    additionalProperties: false,
    properties: {
      projectIds: {
        type: "array",
        minItems: 1,
        maxItems: 500,
        items: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
      },
    },
  },
} as const;

const settingsSchema = {
  params: targetParams,
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      frequencyHours: { type: "integer", enum: [...BACKUP_FREQUENCIES] },
      localKeep: { type: "integer", minimum: 1, maximum: MAX_BACKUP_KEEP },
      remoteKeep: { type: "integer", minimum: 1, maximum: MAX_BACKUP_KEEP },
      choices: {
        type: "object",
        maxProperties: 200,
        propertyNames: { maxLength: 300 },
        additionalProperties: { type: "boolean" },
      },
      extraFolders: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          required: ["service", "path"],
          additionalProperties: false,
          properties: {
            service: { type: "string", minLength: 1, maxLength: 100 },
            path: { type: "string", minLength: 2, maxLength: 300 },
          },
        },
      },
    },
  },
} as const;

const restoreSchema = {
  params: targetParams,
  body: {
    type: "object",
    required: ["fileName", "source", "confirm"],
    additionalProperties: false,
    properties: {
      fileName: { type: "string", minLength: 1, maxLength: 64 },
      source: { type: "string", enum: ["local", "remote"] },
      confirm: { type: "string", maxLength: 200 },
      redeploy: { type: "boolean" },
      password: { type: "string", maxLength: MAX_BACKUP_PASSWORD_LENGTH },
      // Restaurar um PROJETO sobrescreve o banco atual: reautenticação (senha de login e, com 2FA, o código).
      currentPassword: { type: "string", minLength: 1, maxLength: 512 },
      code: { type: "string", minLength: 1, maxLength: 64 },
    },
  },
} as const;

/** Corpo do "Conferir": a senha da época só entra (nunca é guardada nem auditada). */
const verifyBody = {
  type: "object",
  additionalProperties: false,
  properties: {
    fileName: { type: "string", minLength: 1, maxLength: 64 },
    where: { type: "string", enum: ["local", "remote", "both"] },
    password: { type: "string", minLength: 1, maxLength: MAX_BACKUP_PASSWORD_LENGTH },
  },
} as const;

function sendError(reply: FastifyReply, err: unknown, log: (e: unknown) => void): FastifyReply {
  const e = err as Partial<HttpError>;
  if (!e.statusCode) log(err);
  return reply.code(e.statusCode ?? 500).send({
    error: e.code ?? "internal_error",
    message: e.statusCode ? e.message : "Não foi possível concluir agora. Tente de novo em instantes.",
  });
}

const backupsRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);
  const service = app.backupService;
  const logError = (err: unknown) => app.log.error({ err }, "backups: falha inesperada");

  // Backups pedem uma conta: quem fez o pedido vai para a auditoria e "Ver a
  // senha" confere a senha de login. Com o setup pendente, o plugin de auth
  // deixa passar só com o setup token, sem sessão: aqui isso vira 401.
  app.addHook("onRequest", async (request, reply) => {
    if (!request.session) {
      return reply.code(401).send({
        error: "unauthorized",
        message: "Entre com a conta de administrador para usar os backups.",
      });
    }
  });

  type Req = { session: Session | null; body: unknown; params: unknown };
  const handle =
    (action: (req: Req, actor: string) => Promise<unknown>, opts: { noStore?: boolean } = {}) =>
    async (request: Req, reply: FastifyReply) => {
      try {
        const result = await action(request, request.session!.username);
        if (opts.noStore) reply.header("cache-control", "no-store");
        if (result === undefined) return reply.code(204).send();
        return reply.send(result);
      } catch (err) {
        return sendError(reply, err, logError);
      }
    };
  const target = (req: Req) => (req.params as { target: string }).target;

  app.get("/api/backups", handle(() => service.status()));

  app.put(
    "/api/backups/destination",
    { schema: destinationSchema },
    handle((req, actor) => service.setDestination(req.body as BackupDestinationRequest, actor)),
  );
  app.post("/api/backups/destination/test", handle((_req, actor) => service.testDestination(actor)));
  app.delete("/api/backups/destination", handle((_req, actor) => service.removeDestination(actor)));

  app.put(
    "/api/backups/encryption",
    {
      schema: {
        body: { type: "object", required: ["enabled"], additionalProperties: false, properties: { enabled: { type: "boolean" } } },
      },
    },
    handle((req, actor) => service.setEncryption((req.body as { enabled: boolean }).enabled, actor)),
  );

  app.put(
    "/api/backups/password",
    {
      schema: {
        body: {
          type: "object",
          required: ["password", "acknowledged"],
          additionalProperties: false,
          properties: {
            password: { type: "string", minLength: 1, maxLength: MAX_BACKUP_PASSWORD_LENGTH },
            acknowledged: { type: "boolean" },
          },
        },
      },
    },
    handle((req, actor) => {
      const body = req.body as BackupPasswordRequest;
      return service.setPassword(body.password, body.acknowledged, actor);
    }),
  );

  app.get("/api/backups/password/suggest", handle(async () => ({ password: service.suggestPassword() }), { noStore: true }));

  app.post(
    "/api/backups/password/reveal",
    {
      config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
      schema: {
        body: {
          type: "object",
          required: ["loginPassword"],
          additionalProperties: false,
          properties: { loginPassword: { type: "string", minLength: 1, maxLength: 1024 } },
        },
      },
    },
    handle(
      async (req, actor) => ({
        password: await service.revealPassword(req.session!.userId, (req.body as { loginPassword: string }).loginPassword, actor),
      }),
      { noStore: true },
    ),
  );

  app.post(
    "/api/backups/password/test",
    {
      config: { rateLimit: { max: 20, timeWindow: "15 minutes" } },
      schema: {
        body: {
          type: "object",
          required: ["password"],
          additionalProperties: false,
          properties: { password: { type: "string", minLength: 1, maxLength: MAX_BACKUP_PASSWORD_LENGTH } },
        },
      },
    },
    handle((req, actor) => service.testPassword((req.body as { password: string }).password, actor), { noStore: true }),
  );

  app.put(
    "/api/backups/defaults",
    { schema: defaultsSchema },
    handle(async (req, actor) => {
      await service.updateDefaults(req.body as BackupDefaultsRequest, actor);
    }),
  );
  app.post(
    "/api/backups/defaults/apply",
    { schema: applyDefaultsSchema },
    handle((req, actor) => service.applyDefaults((req.body as BackupApplyDefaultsRequest).projectIds, actor)),
  );
  app.post(
    "/api/backups/targets/:target/use-defaults",
    { schema: { params: targetParams } },
    handle(async (req, actor) => {
      await service.useDefaults(target(req), actor);
    }),
  );

  app.put(
    "/api/backups/targets/:target",
    { schema: settingsSchema },
    handle(async (req, actor) => {
      await service.updateTarget(target(req), req.body as BackupTargetSettingsRequest, actor);
    }),
  );
  app.post(
    "/api/backups/targets/:target/run",
    { schema: { params: targetParams } },
    handle((req, actor) => service.runNow(target(req), actor)),
  );
  app.get(
    "/api/backups/targets/:target/points",
    { schema: { params: targetParams } },
    handle(async (req) => ({ points: await service.points(target(req)) })),
  );
  app.post(
    "/api/backups/targets/:target/restore",
    { schema: restoreSchema },
    async (request, reply) => {
      const { currentPassword, code, ...body } = request.body as BackupRestoreRequest & { password?: string };
      const id = (request.params as { target: string }).target;
      // Projeto: a restauração sobrescreve o banco atual. Além da palavra digitada, a senha de login e, com 2FA,
      // o código (como as outras ações sensíveis). Só pessoa na tela: token de API não tem como digitá-los.
      let confirmed: Awaited<ReturnType<typeof confirmIdentity>> = null;
      if (id.startsWith("project:")) {
        if (!request.session || request.session.token) {
          return reply.code(403).send({
            error: "token_forbidden",
            message: "Restaurar um projeto sobrescreve o banco dele e pede a sua senha (e o código do 2FA). Faça pelo painel, com a sua conta.",
          });
        }
        confirmed = await confirmIdentity(app, request, reply, { currentPassword, code });
        if (!confirmed) return reply;
      }
      try {
        const result = await service.restore(id, body, request.session!.username);
        confirmed?.attempt.success();
        return reply.header("cache-control", "no-store").send(result);
      } catch (err) {
        return sendError(reply, err, logError);
      } finally {
        confirmed?.attempt.release();
      }
    },
  );

  app.post(
    "/api/backups/targets/:target/verify",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } }, schema: { params: targetParams, body: verifyBody } },
    handle((req, actor) => service.verify(target(req), (req.body ?? {}) as BackupVerifyRequest, actor), { noStore: true }),
  );
  app.post(
    "/api/backups/verify",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: { body: { ...verifyBody, properties: { where: verifyBody.properties.where, password: verifyBody.properties.password } } },
    },
    handle((req, actor) => service.verify("all", (req.body ?? {}) as BackupVerifyRequest, actor), { noStore: true }),
  );

  // Token limitado: só registros de backup de projetos do alcance dele; os outros respondem como inexistentes.
  app.get(
    "/api/backups/records/:id",
    { schema: { params: idParams } },
    handle(async (req) => {
      const record = await service.record((req.params as { id: string }).id);
      const ids = limitedProjectIds(req);
      if (ids !== null) {
        const owner = projectOfTarget(record.target);
        if (owner === null || !ids.has(owner)) throw httpError(404, "not_found", "Registro de backup não encontrado.");
      }
      return record;
    }),
  );

  app.get("/api/backups/projects/:id", { schema: { params: idParams } }, handle(async (req) => maskProjectBackupView(req, await service.projectView((req.params as { id: string }).id))));
  app.post(
    "/api/backups/projects/:id/detect",
    { schema: { params: idParams } },
    handle(async (req) => {
      const id = (req.params as { id: string }).id;
      await service.detectProject(id);
      return maskProjectBackupView(req, await service.projectView(id));
    }),
  );

  app.put(
    "/api/backups/projects/:id/restore-check",
    {
      schema: {
        params: idParams,
        body: {
          type: "object",
          required: ["enabled"],
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            destinationId: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
            frequency: { type: "string", enum: [...RESTORE_CHECK_FREQUENCIES] },
            confirm: { type: "string", maxLength: 200 },
          },
        },
      },
    },
    handle((req, actor) => service.updateRestoreCheck((req.params as { id: string }).id, req.body as RestoreCheckSettingsRequest, actor), { noStore: true }),
  );
  app.post(
    "/api/backups/projects/:id/restore-check/run",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        params: idParams,
        body: { type: "object", required: ["confirm"], additionalProperties: false, properties: { confirm: { type: "string", maxLength: 200 } } },
      },
    },
    handle((req, actor) => service.runRestoreCheck((req.params as { id: string }).id, req.body as RestoreCheckRunRequest, actor), { noStore: true }),
  );

  app.get("/api/backups/catalog", handle(() => service.catalog()));
};

export default backupsRoutes;
