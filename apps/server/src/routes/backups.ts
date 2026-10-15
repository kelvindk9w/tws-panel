/**
 * backups.ts — Configurações → Backups e a aba Backups do projeto (todas com sessão).
 *  GET    /api/backups                          situação: destino, criptografia, itens, fila, histórico
 *  PUT    /api/backups/destination              armazenamento S3/R2 (testa antes de salvar; a chave secreta fica cifrada)
 *  POST   /api/backups/destination/test         "Testar conexão"
 *  DELETE /api/backups/destination              desconecta (os backups lá continuam lá)
 *  PUT    /api/backups/encryption               liga/desliga a criptografia da cópia externa
 *  PUT    /api/backups/password                 define/troca a senha ({ password, acknowledged })
 *  GET    /api/backups/password/suggest         "Sugerir uma frase forte"
 *  POST   /api/backups/password/reveal          ver a senha, confirmando a senha de login
 *  POST   /api/backups/password/test            "Testar minha senha"
 *  PUT    /api/backups/targets/:target          frequência, retenção, ligado, itens marcados, pastas extras
 *  POST   /api/backups/targets/:target/run      "Fazer backup agora"
 *  GET    /api/backups/targets/:target/points   datas disponíveis para restaurar (VPS e externo)
 *  POST   /api/backups/targets/:target/restore  restaurar (confirmação digitando o nome)
 *  GET    /api/backups/records/:id              progresso de um backup/restauração
 *  GET    /api/backups/projects/:id             aba Backups do projeto
 *  POST   /api/backups/projects/:id/detect      detectar de novo
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
  type BackupDestinationRequest,
  type BackupPasswordRequest,
  type BackupRestoreRequest,
  type BackupTargetSettingsRequest,
} from "@paas/core";
import { registerErrorHandler } from "../plugins/error-handler.js";
import type { HttpError } from "../services/http-error.js";
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
    },
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

  type Req = { session: { username: string; userId: string } | null; body: unknown; params: unknown };
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
    handle((req, actor) => service.restore(target(req), req.body as BackupRestoreRequest & { password?: string }, actor), {
      noStore: true,
    }),
  );

  app.get("/api/backups/records/:id", { schema: { params: idParams } }, handle((req) => service.record((req.params as { id: string }).id)));

  app.get("/api/backups/projects/:id", { schema: { params: idParams } }, handle((req) => service.projectView((req.params as { id: string }).id)));
  app.post(
    "/api/backups/projects/:id/detect",
    { schema: { params: idParams } },
    handle(async (req) => {
      const id = (req.params as { id: string }).id;
      await service.detectProject(id);
      return service.projectView(id);
    }),
  );

  app.get("/api/backups/catalog", handle(() => service.catalog()));
};

export default backupsRoutes;
