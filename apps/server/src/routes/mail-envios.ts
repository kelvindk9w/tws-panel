/**
 * mail-envios.ts — rotas da página Envios (E-mail → Envios):
 *
 *  GET  /api/mail/envios/queue                  fila do servidor de e-mail agora
 *  POST /api/mail/envios/queue/:id/retry        tentar agora (última tentativa)
 *  POST /api/mail/envios/queue/:id/cancel       tirar da fila
 *  GET  /api/mail/envios/history                histórico (filtros na query)
 *  GET  /api/mail/envios/volume?tz=180          14 dias, por dia e por projeto
 *  GET  /api/mail/envios/reputation             listas de bloqueio (última conferência)
 *  POST /api/mail/envios/reputation/check       conferir agora
 *  PUT  /api/mail/envios/reputation/dqs         chave DQS da Spamhaus (nunca devolvida)
 *  GET  /api/mail/envios/deliverability         nota "o que está feito / o que falta"
 *  PUT  /api/mail/envios/postmaster             marcações do Postmaster Tools / SNDS
 *
 * Registradas DENTRO do plugin de e-mail (routes/mail.ts), que é quem tem o
 * MailService — fora dele o serviço não é visível (foi isso que deixou a
 * checagem de blacklist sem rodar; ver mail-reputation-service.ts).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { MAIL_DELIVERY_STATES, type MailDeliveryState, type PostmasterMarks } from "@paas/core";
import { deliverabilityScore } from "@paas/mailer";
import type { MailEnviosService } from "../services/mail-envios-service.js";
import type { MailReputationService } from "../services/mail-reputation-service.js";
import type { HttpError } from "../services/http-error.js";

export interface MailEnviosRouteDeps {
  envios: Pick<MailEnviosService, "queue" | "retry" | "cancel" | "history" | "volume" | "summary7d" | "firstEventAt">;
  reputation: Pick<MailReputationService, "state" | "check" | "setDqsKey" | "marks" | "setMarks" | "facts">;
  /** Domínios cadastrados (a nota lista "não verificado" enquanto não há fatos). */
  domainNames(): Promise<string[]>;
  now?: () => number;
}

const MAIL_DOMAIN_PATTERN =
  "^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$";

const queueIdSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", pattern: "^[0-9]{1,20}$" } },
  },
} as const;

// A coerção de tipos do Ajv está desligada: a query chega como texto.
const historySchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      days: { type: "string", pattern: "^([1-9]|[12][0-9]|30)$" },
      state: { type: "string", enum: [...MAIL_DELIVERY_STATES] },
      projectId: { type: "string", minLength: 1, maxLength: 64 },
      mailbox: { type: "string", minLength: 1, maxLength: 254 },
      domain: { type: "string", maxLength: 253, pattern: MAIL_DOMAIN_PATTERN },
      q: { type: "string", maxLength: 100 },
      limit: { type: "string", pattern: "^[1-9][0-9]{0,2}$" },
      offset: { type: "string", pattern: "^[0-9]{1,6}$" },
      refresh: { type: "string", enum: ["0", "1"] },
    },
  },
} as const;

const volumeSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: { tz: { type: "string", pattern: "^-?[0-9]{1,3}$" } },
  },
} as const;

const dqsSchema = {
  body: {
    type: "object",
    required: ["key"],
    additionalProperties: false,
    properties: { key: { type: ["string", "null"], maxLength: 64 } },
  },
} as const;

const DATE_OR_NULL = { type: ["string", "null"], maxLength: 40 } as const;
const postmasterSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: { googleAt: DATE_OR_NULL, microsoftAt: DATE_OR_NULL, spamRateOkAt: DATE_OR_NULL },
  },
} as const;

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const e = err as Partial<HttpError>;
  if (!e.statusCode) {
    return reply.code(500).send({ error: "internal_error", message: "Erro interno." });
  }
  return reply.code(e.statusCode).send({ error: e.code ?? "error", message: e.message ?? "Erro." });
}

interface HistoryQuery {
  days?: string;
  state?: MailDeliveryState;
  projectId?: string;
  mailbox?: string;
  domain?: string;
  q?: string;
  limit?: string;
  offset?: string;
  refresh?: "0" | "1";
}

export function mailEnviosRoutes(app: FastifyInstance, deps: MailEnviosRouteDeps): void {
  const { envios, reputation } = deps;
  const now = deps.now ?? Date.now;

  // ---------------------------------------------------------------------------
  // Fila agora
  // ---------------------------------------------------------------------------

  app.get("/api/mail/envios/queue", async (_request, reply) => reply.send(await envios.queue()));

  for (const action of ["retry", "cancel"] as const) {
    app.post<{ Params: { id: string } }>(`/api/mail/envios/queue/:id/${action}`, { schema: queueIdSchema }, async (request, reply) => {
      try {
        const result = await envios[action](request.params.id);
        await app.auditService.record({
          action: `mail.queue.${action}`,
          target: request.params.id,
          detail: action === "retry" ? "Tentar agora (última tentativa) na fila do e-mail." : "Mensagem tirada da fila do e-mail.",
        });
        return reply.send(result);
      } catch (err) {
        return sendError(reply, err);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Histórico e volume
  // ---------------------------------------------------------------------------

  app.get<{ Querystring: HistoryQuery }>("/api/mail/envios/history", { schema: historySchema }, async (request, reply) => {
    const q = request.query;
    const response = await envios.history({
      days: Number(q.days ?? 7),
      ...(q.state ? { state: q.state } : {}),
      ...(q.projectId ? { projectId: q.projectId } : {}),
      ...(q.mailbox ? { mailbox: q.mailbox } : {}),
      ...(q.domain ? { domain: q.domain } : {}),
      ...(q.q ? { q: q.q } : {}),
      ...(q.limit ? { limit: Math.min(Number(q.limit), 500) } : {}),
      ...(q.offset ? { offset: Number(q.offset) } : {}),
      refresh: q.refresh === "1",
    });
    return reply.send(response);
  });

  app.get<{ Querystring: { tz?: string } }>("/api/mail/envios/volume", { schema: volumeSchema }, async (request, reply) => {
    const tz = Number(request.query.tz ?? 0);
    if (tz < -840 || tz > 840) {
      return reply.code(400).send({ error: "invalid_request", message: "Campo inválido: tz." });
    }
    return reply.send(await envios.volume({ days: 14, tzOffsetMinutes: tz }));
  });

  // ---------------------------------------------------------------------------
  // Reputação
  // ---------------------------------------------------------------------------

  app.get("/api/mail/envios/reputation", async (_request, reply) => reply.send(await reputation.state()));

  app.post("/api/mail/envios/reputation/check", async (_request, reply) => {
    try {
      return reply.send(await reputation.check({ manual: true }));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put<{ Body: { key: string | null } }>("/api/mail/envios/reputation/dqs", { schema: dqsSchema }, async (request, reply) => {
    try {
      await reputation.setDqsKey(request.body.key);
      // A chave nunca vai para a auditoria nem volta na resposta.
      await app.auditService.record({
        action: request.body.key ? "mail.dqs.set" : "mail.dqs.clear",
        target: null,
        detail: request.body.key ? "Chave DQS da Spamhaus cadastrada." : "Chave DQS da Spamhaus apagada.",
      });
      return reply.send(await reputation.state());
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---------------------------------------------------------------------------
  // Nota de entregabilidade
  // ---------------------------------------------------------------------------

  app.get("/api/mail/envios/deliverability", async (_request, reply) => {
    const [facts, state, volume7d, firstSendAt, marks, names] = await Promise.all([
      reputation.facts(),
      reputation.state(),
      envios.summary7d(),
      envios.firstEventAt(),
      reputation.marks(),
      deps.domainNames(),
    ]);
    const domains = facts?.domains ?? names.map((name) => ({ name, dnsOk: null, dnsTotal: null, ptr: null }));
    const score = deliverabilityScore({
      now: new Date(now()),
      domains,
      factsAt: facts?.at ?? null,
      tls: facts?.tls ?? null,
      blacklist: state.lastCheck,
      volume7d,
      firstSendAt,
      marks,
    });
    return reply.send({ ...score, marks, factsAt: facts?.at ?? null });
  });

  app.put<{ Body: Partial<PostmasterMarks> }>("/api/mail/envios/postmaster", { schema: postmasterSchema }, async (request, reply) => {
    try {
      return reply.send({ marks: await reputation.setMarks(request.body) });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
