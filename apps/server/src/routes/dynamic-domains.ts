/**
 * dynamic-domains.ts (rotas) — Domínios dinâmicos do projeto (SaaS multi-cliente).
 *
 *  GET    /api/projects/:id/dynamic-domains            lista (busca, estado, paginação) + contadores
 *  POST   /api/projects/:id/dynamic-domains            cadastra um nome ({ host }); repetir é seguro (200)
 *  GET    /api/projects/:id/dynamic-domains/:host      um nome (estado do certificado)
 *  DELETE /api/projects/:id/dynamic-domains/:host      remove o nome
 *  PUT    /api/projects/:id/dynamic-domains/suffixes   sufixos do projeto (SÓ a pessoa, no painel)
 *  GET    /api/settings/dynamic-domains                tetos e faixas (SÓ a pessoa)
 *  PUT    /api/settings/dynamic-domains                muda os tetos (SÓ a pessoa)
 *
 * Token: os quatro primeiros aceitam o token "domínios deste projeto" (alcance
 * "domains": listar = read, cadastrar/remover = write) e os tokens de painel ou
 * de projetos com o nível equivalente. Sufixos e tetos são da pessoa: a lista de
 * exclusão (token-policy.ts) barra qualquer token, e a conferência abaixo é a
 * segunda trava. Regras em services/dynamic-domains.ts.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  DYNAMIC_DOMAIN_LIMIT_DEFAULTS,
  DYNAMIC_DOMAIN_LIMIT_RANGE,
  DYNAMIC_MAX_SUFFIXES,
  DYNAMIC_NAME_STATES,
  DYNAMIC_PAGE_SIZES,
  type AddDynamicDomainRequest,
  type AddDynamicDomainResponse,
  type DynamicDomainLimits,
  type DynamicDomainSettingsResponse,
  type DynamicDomainsResponse,
  type DynamicNameState,
  type UpdateDynamicSuffixesRequest,
} from "@paas/core";
import { registerErrorHandler } from "../plugins/error-handler.js";
import type { DynamicDomainsService } from "../services/dynamic-domains.js";
import type { HttpError } from "../services/http-error.js";
import { maskedForLimitedToken } from "../services/reach-masks.js";

declare module "fastify" {
  interface FastifyInstance {
    dynamicDomains: DynamicDomainsService;
  }
}

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
} as const;

const hostParams = {
  type: "object",
  required: ["id", "host"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 64 },
    host: { type: "string", minLength: 3, maxLength: 253 },
  },
} as const;

const listSchema = {
  params: idParams,
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      q: { type: "string", maxLength: 100 },
      state: { type: "string", enum: [...DYNAMIC_NAME_STATES] },
      // a coerção de tipos do Ajv está desligada: número chega como texto
      page: { type: "string", pattern: "^[1-9][0-9]{0,5}$" },
      pageSize: { type: "string", enum: DYNAMIC_PAGE_SIZES.map(String) },
    },
  },
} as const;

const addSchema = {
  params: idParams,
  body: {
    type: "object",
    required: ["host"],
    additionalProperties: false,
    // o conteúdo do nome é conferido pelo serviço (mensagem própria); aqui só o tamanho
    properties: { host: { type: "string", minLength: 1, maxLength: 400 } },
  },
} as const;

const suffixesSchema = {
  params: idParams,
  body: {
    type: "object",
    required: ["suffixes"],
    additionalProperties: false,
    properties: {
      suffixes: {
        type: "array",
        maxItems: DYNAMIC_MAX_SUFFIXES + 5,
        items: {
          type: "object",
          required: ["suffix", "openAll"],
          additionalProperties: false,
          properties: { suffix: { type: "string", minLength: 1, maxLength: 400 }, openAll: { type: "boolean" } },
        },
      },
    },
  },
} as const;

const settingsSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      // sem "integer": a faixa e o inteiro são conferidos pelo serviço, com mensagem em português
      maxNamesPerProject: { type: "number" },
      maxIssuancesPerHour: { type: "number" },
    },
  },
} as const;

function sendError(request: FastifyRequest, reply: FastifyReply, err: unknown): FastifyReply {
  const e = maskedForLimitedToken(request, err) as Partial<HttpError>;
  return reply.code(e.statusCode ?? 500).send({
    error: e.code ?? "internal_error",
    message: e.statusCode ? (e.message ?? "Erro.") : "Erro interno ao tratar os domínios dinâmicos.",
    ...(e.details ?? {}),
  });
}

/** Só humano: sessão de cookie. Token (mesmo admin) nunca muda sufixos nem tetos. */
function humanOnly(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.session && !request.session.token) return true;
  void reply.code(403).send({
    error: "token_forbidden",
    message: "Sufixos e tetos dos domínios dinâmicos são alterados só pelo painel, com a sua conta (não por token).",
  });
  return false;
}

const dynamicDomainsRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  registerErrorHandler(app);
  const service = () => app.dynamicDomains;

  app.get<{ Params: { id: string }; Querystring: { q?: string; state?: DynamicNameState; page?: string; pageSize?: string } }>(
    "/api/projects/:id/dynamic-domains",
    { schema: listSchema },
    async (request, reply) => {
      try {
        const q = request.query;
        const body: DynamicDomainsResponse = await service().view(request.params.id, {
          q: q.q,
          state: q.state,
          page: q.page ? Number(q.page) : undefined,
          pageSize: q.pageSize ? Number(q.pageSize) : undefined,
        });
        return reply.send(body);
      } catch (err) {
        return sendError(request, reply, err);
      }
    },
  );

  app.post<{ Params: { id: string }; Body: AddDynamicDomainRequest }>(
    "/api/projects/:id/dynamic-domains",
    { schema: addSchema, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        const { item, created } = await service().add(request.params.id, request.body.host);
        const body: AddDynamicDomainResponse = { item };
        return reply.code(created ? 201 : 200).send(body);
      } catch (err) {
        return sendError(request, reply, err);
      }
    },
  );

  app.get<{ Params: { id: string; host: string } }>(
    "/api/projects/:id/dynamic-domains/:host",
    { schema: { params: hostParams } },
    async (request, reply) => {
      try {
        const body: AddDynamicDomainResponse = { item: await service().one(request.params.id, request.params.host) };
        return reply.send(body);
      } catch (err) {
        return sendError(request, reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string; host: string } }>(
    "/api/projects/:id/dynamic-domains/:host",
    { schema: { params: hostParams } },
    async (request, reply) => {
      try {
        await service().remove(request.params.id, request.params.host);
        return reply.send({ ok: true });
      } catch (err) {
        return sendError(request, reply, err);
      }
    },
  );

  app.put<{ Params: { id: string }; Body: UpdateDynamicSuffixesRequest }>(
    "/api/projects/:id/dynamic-domains/suffixes",
    { schema: suffixesSchema },
    async (request, reply) => {
      if (!humanOnly(request, reply)) return reply;
      try {
        return reply.send({ suffixes: await service().setSuffixes(request.params.id, request.body.suffixes) });
      } catch (err) {
        return sendError(request, reply, err);
      }
    },
  );

  const settingsBody = async (): Promise<DynamicDomainSettingsResponse> => ({
    limits: await service().limits(),
    defaults: { ...DYNAMIC_DOMAIN_LIMIT_DEFAULTS },
    range: DYNAMIC_DOMAIN_LIMIT_RANGE,
  });

  app.get("/api/settings/dynamic-domains", async (request, reply) => {
    if (!humanOnly(request, reply)) return reply;
    try {
      return reply.send(await settingsBody());
    } catch (err) {
      return sendError(request, reply, err);
    }
  });

  app.put<{ Body: Partial<DynamicDomainLimits> }>("/api/settings/dynamic-domains", { schema: settingsSchema }, async (request, reply) => {
    if (!humanOnly(request, reply)) return reply;
    try {
      await service().setLimits(request.body);
      return reply.send(await settingsBody());
    } catch (err) {
      return sendError(request, reply, err);
    }
  });
};

export default dynamicDomainsRoutes;
