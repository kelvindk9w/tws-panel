/**
 * panel-domain.ts — Configurações → Domínio do painel (todas com sessão).
 *  GET    /api/settings/panel-domain              situação + por onde a página foi aberta
 *  PUT    /api/settings/panel-domain              cadastrar/trocar o domínio ({ domain })
 *  DELETE /api/settings/panel-domain              remover (o acesso pelo IP volta)
 *  POST   /api/settings/panel-domain/verify       conferir o DNS; certo → o domínio entra no proxy
 *  POST   /api/settings/panel-domain/disable-ip   desativar o acesso pelo IP ({ confirm: <domínio> })
 *  POST   /api/settings/panel-domain/enable-ip    reativar o acesso pelo IP
 *
 * "Por onde a página foi aberta" é o Host do pedido (request.hostname, sem
 * porta). Atrás do Caddy é o nome que o navegador usou; o Caddy não repassa
 * X-Forwarded-Host vindo de fora. Regras e gravação: services/panel-domain.ts.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import type { PanelDomainDisableIpRequest, PanelDomainSetRequest } from "@paas/core";
import { publicResolver, systemResolver } from "@paas/mailer";
import { registerErrorHandler } from "../plugins/error-handler.js";
import type { HttpError } from "../services/http-error.js";
import { PanelDomainService, type PanelDomainResolver } from "../services/panel-domain.js";
import { publicIpFromPanelDomain } from "./domains.js";

declare module "fastify" {
  interface FastifyInstance {
    panelDomainService: PanelDomainService;
  }
}

const setSchema = {
  body: {
    type: "object",
    required: ["domain"],
    additionalProperties: false,
    properties: { domain: { type: "string", minLength: 1, maxLength: 270 } },
  },
} as const;

const disableSchema = {
  body: {
    type: "object",
    required: ["confirm"],
    additionalProperties: false,
    properties: { confirm: { type: "string", maxLength: 270 } },
  },
} as const;

function sendError(reply: FastifyReply, err: unknown, log: (e: unknown) => void): FastifyReply {
  const e = err as Partial<HttpError>;
  if (!e.statusCode) log(err);
  return reply.code(e.statusCode ?? 500).send({
    error: e.code ?? "internal_error",
    message: e.statusCode
      ? (e.message ?? "Erro.")
      : "Não foi possível aplicar no proxy agora. Nada mudou no endereço do painel; tente de novo em instantes.",
  });
}

const panelDomainRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);
  const service = app.panelDomainService;
  const actorOf = (username: string | undefined) => username ?? "admin";
  const logError = (err: unknown) => app.log.error({ err }, "domínio do painel: falha inesperada");

  app.get("/api/settings/panel-domain", async (request, reply) => {
    return reply.send(await service.status(request.hostname));
  });

  app.put<{ Body: PanelDomainSetRequest }>("/api/settings/panel-domain", { schema: setSchema }, async (request, reply) => {
    try {
      await service.setDomain(request.body.domain, actorOf(request.session?.username));
      return reply.send(await service.status(request.hostname));
    } catch (err) {
      return sendError(reply, err, logError);
    }
  });

  app.delete("/api/settings/panel-domain", async (request, reply) => {
    try {
      await service.removeDomain(actorOf(request.session?.username));
      return reply.send(await service.status(request.hostname));
    } catch (err) {
      return sendError(reply, err, logError);
    }
  });

  app.post("/api/settings/panel-domain/verify", async (request, reply) => {
    try {
      return reply.send(await service.verify(actorOf(request.session?.username), request.hostname));
    } catch (err) {
      return sendError(reply, err, logError);
    }
  });

  app.post<{ Body: PanelDomainDisableIpRequest }>(
    "/api/settings/panel-domain/disable-ip",
    { schema: disableSchema },
    async (request, reply) => {
      try {
        return reply.send(await service.disableIp(request.body.confirm, request.hostname, actorOf(request.session?.username)));
      } catch (err) {
        return sendError(reply, err, logError);
      }
    },
  );

  app.post("/api/settings/panel-domain/enable-ip", async (request, reply) => {
    try {
      return reply.send(await service.enableIp(actorOf(request.session?.username), request.hostname));
    } catch (err) {
      return sendError(reply, err, logError);
    }
  });
};

/**
 * Liga o serviço ao resto do painel (escopo raiz, em app.ts): proxy e
 * projetos pelo deployService, certificado pela página Certificados, DNS
 * público com o do sistema de reserva (como a verificação do e-mail).
 */
export function buildPanelDomainService(
  app: Pick<FastifyInstance, "config" | "deployService" | "certificateService" | "auditService" | "log">,
  resolvers: { primary: PanelDomainResolver; fallback: PanelDomainResolver | null } = {
    primary: publicResolver(),
    fallback: systemResolver(),
  },
): PanelDomainService {
  const { config, deployService: deploy } = app;
  return new PanelDomainService({
    dataDir: config.dataDir,
    ipAddress: config.panelDomain,
    serverIp: config.publicIp ?? publicIpFromPanelDomain(config.panelDomain),
    serverIpv6: config.publicIpv6,
    hostRepoDir: config.hostRepoDir,
    applyAddresses: async (site, { reload }) => {
      deploy.setPanelAddresses(site);
      if (reload) await deploy.refreshProxy();
    },
    setReserved: (names) => deploy.setPanelReserved(names),
    certificate: async (host) => (await app.certificateService.list({ host, kind: "panel" })).items[0] ?? null,
    domainInUse: async (domain) =>
      (await deploy.listProjects()).some((p) => p.domain === domain || (p.aliases ?? []).includes(domain)) ||
      (await deploy.mailHosts().catch(() => [] as string[])).includes(domain),
    resolver: resolvers.primary,
    fallbackResolver: resolvers.fallback,
    audit: app.auditService,
    log: (m) => app.log.warn(m),
  });
}

export default panelDomainRoutes;
