/**
 * mail-send-routes.ts — rotas do registro de envios por SMTP:
 *
 *  GET  /api/mail/envios/saidas                         todos os envios (filtro por projeto/origem)
 *  POST /api/mail/envios/saidas/:msg/reveal             EXIBIR assunto e corpo de uma mensagem
 *  GET  /api/mail/envios/saidas/settings                retenção e privacidade
 *  PUT  /api/mail/envios/saidas/settings                muda retenção/privacidade (auditado)
 *  GET  /api/projects/:id/email/saidas                  envios SÓ deste projeto
 *  POST /api/projects/:id/email/saidas/:msg/reveal      exibir (só se a mensagem é deste projeto)
 *
 * Listagens nunca devolvem assunto nem corpo. Só "reveal" os devolve, exige
 * sessão e deixa na auditoria quem, quando e o id da mensagem (nunca o texto).
 * Registradas dentro do plugin de e-mail (routes/mail.ts).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { MAIL_SEND_ORIGINS, MAIL_SEND_STATES, type MailSendOrigin, type MailSendState, type UpdateMailSendSettingsRequest } from "@paas/core";
import type { MailSendLogService } from "../services/mail-send-log-service.js";
import type { HttpError } from "../services/http-error.js";

export interface MailSendRouteDeps {
  sends: Pick<MailSendLogService, "list" | "reveal" | "settings" | "updateSettings">;
  /**
   * Pede a leitura do registro de entrega do Stalwart se a última tem mais de 1 min. Não é esperada:
   * a lista responde na hora e o próximo pedido da tela (a cada ~10 s) já vê o resultado.
   */
  refresh?: () => Promise<unknown>;
}

const PROJECT_ID = { type: "string", minLength: 1, maxLength: 64 } as const;
const MESSAGE_ID = { type: "string", pattern: "^[0-9]{1,20}$" } as const;
const DAY = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } as const;

// A coerção de tipos do Ajv está desligada: a query chega como texto.
const listProperties = {
  origin: { type: "string", enum: [...MAIL_SEND_ORIGINS] },
  state: { type: "string", enum: [...MAIL_SEND_STATES] },
  from: DAY,
  to: DAY,
  recipient: { type: "string", maxLength: 100 },
  limit: { type: "string", pattern: "^[1-9][0-9]{0,2}$" },
  offset: { type: "string", pattern: "^[0-9]{1,6}$" },
} as const;

const globalListSchema = {
  querystring: { type: "object", additionalProperties: false, properties: { ...listProperties, projectId: PROJECT_ID } },
} as const;

const projectListSchema = {
  params: { type: "object", required: ["id"], properties: { id: PROJECT_ID } },
  querystring: { type: "object", additionalProperties: false, properties: listProperties },
} as const;

const globalRevealSchema = { params: { type: "object", required: ["msg"], properties: { msg: MESSAGE_ID } } } as const;
const projectRevealSchema = {
  params: { type: "object", required: ["id", "msg"], properties: { id: PROJECT_ID, msg: MESSAGE_ID } },
} as const;

const INT = { type: "integer" } as const;
const settingsSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      metadataDays: INT,
      bodyDays: INT,
      maxBodyKiB: INT,
      maxTotalMiB: INT,
      storeContent: { type: "boolean" },
      project: {
        type: "object",
        required: ["id", "storeContent"],
        additionalProperties: false,
        properties: { id: PROJECT_ID, storeContent: { type: "boolean" } },
      },
    },
  },
} as const;

const projectSettingsSchema = {
  params: { type: "object", required: ["id"], properties: { id: PROJECT_ID } },
  body: {
    type: "object",
    required: ["storeContent"],
    additionalProperties: false,
    properties: { storeContent: { type: "boolean" } },
  },
} as const;

interface ListQuery {
  projectId?: string;
  origin?: MailSendOrigin;
  state?: MailSendState;
  from?: string;
  to?: string;
  recipient?: string;
  limit?: string;
  offset?: string;
}

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const e = err as Partial<HttpError>;
  if (!e.statusCode) return reply.code(500).send({ error: "internal_error", message: "Erro interno." });
  return reply.code(e.statusCode).send({ error: e.code ?? "error", message: e.message ?? "Erro." });
}

function toFilter(q: ListQuery, projectId?: string) {
  return {
    ...((projectId ?? q.projectId) ? { projectId: (projectId ?? q.projectId)! } : {}),
    ...(q.origin ? { origin: q.origin } : {}),
    ...(q.state ? { state: q.state } : {}),
    ...(q.from ? { from: q.from } : {}),
    ...(q.to ? { to: q.to } : {}),
    ...(q.recipient ? { recipient: q.recipient } : {}),
    ...(q.limit ? { limit: Number(q.limit) } : {}),
    ...(q.offset ? { offset: Number(q.offset) } : {}),
  };
}

export function mailSendRoutes(app: FastifyInstance, deps: MailSendRouteDeps): void {
  const { sends } = deps;
  const refresh = () => void deps.refresh?.().catch(() => undefined);

  // Exibir exige sessão: o guarda de autenticação do painel (plugins/auth.ts) já recusa
  // sem sessão válida depois do setup; aqui só audita quem pediu.
  async function reveal(request: FastifyRequest, reply: FastifyReply, id: string, projectId?: string) {
    try {
      const content = await sends.reveal(id, projectId ? { projectId } : {});
      // Só quem, quando (a auditoria carimba) e o id: nunca o texto.
      await app.auditService.record({
        actor: request.session?.username ?? "operador",
        action: "mail.send.reveal",
        target: id,
        detail: `Assunto e corpo da mensagem ${id} exibidos${projectId ? ` (projeto ${projectId})` : ""}.`,
      });
      return reply.header("cache-control", "no-store").send(content);
    } catch (err) {
      return sendError(reply, err);
    }
  }

  app.get<{ Querystring: ListQuery }>("/api/mail/envios/saidas", { schema: globalListSchema }, async (request, reply) => {
    refresh();
    return reply.send(await sends.list(toFilter(request.query)));
  });

  app.get<{ Params: { id: string }; Querystring: ListQuery }>("/api/projects/:id/email/saidas", { schema: projectListSchema }, async (request, reply) => {
    refresh();
    return reply.send(await sends.list(toFilter(request.query, request.params.id)));
  });

  app.post<{ Params: { msg: string } }>(
    "/api/mail/envios/saidas/:msg/reveal",
    { schema: globalRevealSchema, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => reveal(request, reply, request.params.msg),
  );

  app.post<{ Params: { id: string; msg: string } }>(
    "/api/projects/:id/email/saidas/:msg/reveal",
    { schema: projectRevealSchema, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => reveal(request, reply, request.params.msg, request.params.id),
  );

  app.get("/api/mail/envios/saidas/settings", async (_request, reply) => reply.send(await sends.settings()));

  const change = async (request: FastifyRequest, reply: FastifyReply, body: UpdateMailSendSettingsRequest) => {
    try {
      const value = await sends.updateSettings(body);
      // Só números e liga/desliga: nada de conteúdo.
      await app.auditService.record({
        actor: request.session?.username ?? "operador",
        action: "mail.send.settings",
        target: body.project?.id ?? null,
        detail: `Registro de envios: ${JSON.stringify(body)}.`,
      });
      return reply.send(value);
    } catch (err) {
      return sendError(reply, err);
    }
  };

  app.put<{ Body: UpdateMailSendSettingsRequest }>("/api/mail/envios/saidas/settings", { schema: settingsSchema }, async (request, reply) =>
    change(request, reply, request.body),
  );

  app.put<{ Params: { id: string }; Body: { storeContent: boolean } }>(
    "/api/projects/:id/email/saidas/settings",
    { schema: projectSettingsSchema },
    async (request, reply) => change(request, reply, { project: { id: request.params.id, storeContent: request.body.storeContent } }),
  );
}
