/**
 * cloudflare.ts — Configurações → Integrações → Cloudflare (DNS), só com sessão humana.
 *  GET  /api/integrations/cloudflare             situação (conectada? 4 últimos caracteres; nunca o token)
 *  PUT  /api/integrations/cloudflare             conecta/troca o API Token (senha atual + código, se há 2FA)
 *  POST /api/integrations/cloudflare/disconnect  remove o token (senha atual + código, se há 2FA)
 *  GET  /api/integrations/cloudflare/zones       zonas que o token alcança
 *  POST /api/integrations/cloudflare/dns/plan    prévia: criar / já está certo / diferente
 *  POST /api/integrations/cloudflare/dns/apply   aplica SÓ os itens marcados
 *
 * Token de API (mesmo admin) nunca chega aqui: token-policy.ts nega o prefixo inteiro. O valor do token
 * não entra em log nem em auditoria. Regras da integração: services/cloudflare-dns.ts.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type {
  CloudflareApplyRequest,
  CloudflareConnectRequest,
  CloudflareDisconnectRequest,
  CloudflareDnsScope,
} from "@paas/core";
import { registerErrorHandler } from "../plugins/error-handler.js";
import { CloudflareDns } from "../services/cloudflare-dns.js";
import { confirmIdentity } from "../services/confirm-identity.js";
import type { HttpError } from "../services/http-error.js";
import { publicIpFromPanelDomain } from "./domains.js";

declare module "fastify" {
  interface FastifyInstance {
    cloudflareDns: CloudflareDns;
  }
}

const scopeSchema = {
  oneOf: [
    {
      type: "object",
      required: ["kind", "domain"],
      additionalProperties: false,
      properties: { kind: { const: "mail" }, domain: { type: "string", minLength: 1, maxLength: 253 } },
    },
    {
      type: "object",
      required: ["kind", "hosts"],
      additionalProperties: false,
      properties: {
        kind: { const: "hosts" },
        hosts: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", minLength: 1, maxLength: 253 } },
      },
    },
  ],
} as const;

const connectSchema = {
  body: {
    type: "object",
    required: ["token", "currentPassword"],
    additionalProperties: false,
    properties: {
      token: { type: "string", minLength: 1, maxLength: 512 },
      currentPassword: { type: "string", minLength: 1, maxLength: 512 },
      code: { type: "string", minLength: 1, maxLength: 64 },
    },
  },
} as const;

const disconnectSchema = {
  body: {
    type: "object",
    required: ["currentPassword"],
    additionalProperties: false,
    properties: {
      currentPassword: { type: "string", minLength: 1, maxLength: 512 },
      code: { type: "string", minLength: 1, maxLength: 64 },
    },
  },
} as const;

const planSchema = {
  body: {
    type: "object",
    required: ["scope"],
    additionalProperties: false,
    properties: { scope: scopeSchema },
  },
} as const;

const applySchema = {
  body: {
    type: "object",
    required: ["scope", "items"],
    additionalProperties: false,
    properties: {
      scope: scopeSchema,
      items: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 300 } },
    },
  },
} as const;

/** Liga o serviço ao resto do painel (escopo raiz, em app.ts): cofre cifrado, IPs da VPS e auditoria. */
export function buildCloudflareDns(
  app: Pick<FastifyInstance, "config" | "deployService" | "auditService" | "log">,
  extra: Partial<ConstructorParameters<typeof CloudflareDns>[0]> = {},
): CloudflareDns {
  const { config } = app;
  return new CloudflareDns({
    dataDir: config.dataDir,
    vault: app.deployService.credentialVault,
    serverIp: () => config.publicIp ?? publicIpFromPanelDomain(config.panelDomain),
    serverIpv6: () => config.publicIpv6,
    audit: app.auditService,
    log: (m) => app.log.warn(m),
    ...extra,
  });
}

function labelOf(scope: CloudflareDnsScope): string {
  return scope.kind === "mail" ? scope.domain.trim().toLowerCase() : scope.hosts.join(", ");
}

const cloudflareRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);
  const service = app.cloudflareDns;
  const actorOf = (request: FastifyRequest) => request.session?.username ?? "admin";

  /** Só humano: sessão de cookie (a segunda trava, além da política de tokens). */
  function humanOnly(request: FastifyRequest, reply: FastifyReply): boolean {
    if (request.session && !request.session.token) return true;
    void reply.code(403).send({
      error: "token_forbidden",
      message: "A Cloudflare é configurada só pelo painel, com a sua conta (não por um token de API).",
    });
    return false;
  }

  const sendError = (reply: FastifyReply, err: unknown): FastifyReply => {
    const e = err as Partial<HttpError>;
    if (!e.statusCode) throw err;
    return reply.code(e.statusCode).send({ error: e.code ?? "error", message: e.message ?? "Erro." });
  };

  app.get("/api/integrations/cloudflare", async (request, reply) => {
    if (!humanOnly(request, reply)) return reply;
    return reply.send(await service.status());
  });

  app.put<{ Body: CloudflareConnectRequest }>("/api/integrations/cloudflare", { schema: connectSchema }, async (request, reply) => {
    if (!humanOnly(request, reply)) return reply;
    const confirmed = await confirmIdentity(app, request, reply, request.body);
    if (!confirmed) return reply;
    try {
      const response = await service.connect(request.body.token);
      confirmed.attempt.success();
      await app.auditService.record({
        actor: actorOf(request),
        action: "integration.cloudflare_connected",
        detail: `Cloudflare conectada (API Token terminado em …${response.hint ?? ""}); ${response.zones.length} zona(s) alcançada(s).`,
      });
      return reply.send(response);
    } catch (err) {
      return sendError(reply, err);
    } finally {
      confirmed.attempt.release();
    }
  });

  app.post<{ Body: CloudflareDisconnectRequest }>(
    "/api/integrations/cloudflare/disconnect",
    { schema: disconnectSchema },
    async (request, reply) => {
      if (!humanOnly(request, reply)) return reply;
      const confirmed = await confirmIdentity(app, request, reply, request.body);
      if (!confirmed) return reply;
      try {
        const removed = await service.disconnect();
        confirmed.attempt.success();
        if (removed) {
          await app.auditService.record({
            actor: actorOf(request),
            action: "integration.cloudflare_disconnected",
            detail: "Cloudflare desconectada (token removido do painel).",
          });
        }
        return reply.send(await service.status());
      } finally {
        confirmed.attempt.release();
      }
    },
  );

  app.get("/api/integrations/cloudflare/zones", async (request, reply) => {
    if (!humanOnly(request, reply)) return reply;
    try {
      return reply.send({ zones: await service.zoneNames() });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Body: { scope: CloudflareDnsScope } }>("/api/integrations/cloudflare/dns/plan", { schema: planSchema }, async (request, reply) => {
    if (!humanOnly(request, reply)) return reply;
    try {
      return reply.send(await service.plan(await service.desired(request.body.scope)));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Body: CloudflareApplyRequest }>("/api/integrations/cloudflare/dns/apply", { schema: applySchema }, async (request, reply) => {
    if (!humanOnly(request, reply)) return reply;
    try {
      const { scope, items } = request.body;
      return reply.send(await service.apply(await service.desired(scope), items, labelOf(scope), actorOf(request)));
    } catch (err) {
      return sendError(reply, err);
    }
  });
};

export default cloudflareRoutes;
