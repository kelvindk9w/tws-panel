/**
 * apps-domain.ts — Configurações → Domínio de aplicações (todas com sessão).
 *  GET    /api/settings/apps-domain          situação (base, registros a criar, última conferência)
 *  POST   /api/settings/apps-domain/verify   confere o DNS (rótulo aleatório sob a base) e SÓ ENTÃO salva ({ domain })
 *  DELETE /api/settings/apps-domain          remove a base (projetos que já usam um endereço sob ela não mudam)
 *
 * Regras e gravação: services/apps-domain.ts. O endereço automático gerado
 * para os projetos sai de GET /api/domains/suggest (routes/domains.ts).
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import type { AppsDomainVerifyRequest } from "@paas/core";
import { publicResolver, systemResolver } from "@paas/mailer";
import { registerErrorHandler } from "../plugins/error-handler.js";
import { AppsDomainService } from "../services/apps-domain.js";
import type { HttpError } from "../services/http-error.js";
import type { PanelDomainResolver } from "../services/panel-domain.js";
import { publicIpFromPanelDomain } from "./domains.js";

declare module "fastify" {
  interface FastifyInstance {
    appsDomainService: AppsDomainService;
  }
}

const verifySchema = {
  body: {
    type: "object",
    required: ["domain"],
    additionalProperties: false,
    properties: { domain: { type: "string", minLength: 1, maxLength: 270 } },
  },
} as const;

function sendError(reply: FastifyReply, err: unknown, log: (e: unknown) => void): FastifyReply {
  const e = err as Partial<HttpError>;
  if (!e.statusCode) log(err);
  return reply.code(e.statusCode ?? 500).send({
    error: e.code ?? "internal_error",
    message: e.statusCode ? (e.message ?? "Erro.") : "Não foi possível concluir agora. Nada foi alterado; tente de novo em instantes.",
  });
}

const appsDomainRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);
  const service = app.appsDomainService;
  const actorOf = (username: string | undefined) => username ?? "admin";
  const logError = (err: unknown) => app.log.error({ err }, "domínio de aplicações: falha inesperada");

  app.get("/api/settings/apps-domain", async (_request, reply) => reply.send(await service.status()));

  app.post<{ Body: AppsDomainVerifyRequest }>("/api/settings/apps-domain/verify", { schema: verifySchema }, async (request, reply) => {
    try {
      return reply.send(await service.verify(request.body.domain, actorOf(request.session?.username)));
    } catch (err) {
      return sendError(reply, err, logError);
    }
  });

  app.delete("/api/settings/apps-domain", async (request, reply) => {
    try {
      return reply.send(await service.remove(actorOf(request.session?.username)));
    } catch (err) {
      return sendError(reply, err, logError);
    }
  });
};

/**
 * Liga o serviço ao resto do painel (escopo raiz, em app.ts): nomes em uso
 * pelos projetos, pelo painel e pelo e-mail, e o DNS público com o do sistema
 * de reserva (como a verificação do domínio do painel).
 */
export function buildAppsDomainService(
  app: Pick<FastifyInstance, "config" | "deployService" | "auditService" | "log">,
  resolvers: { primary: PanelDomainResolver; fallback: PanelDomainResolver | null } = {
    primary: publicResolver(),
    fallback: systemResolver(),
  },
): AppsDomainService {
  const { config, deployService: deploy } = app;
  const projectNames = async () => {
    const projects = await deploy.listProjects();
    return projects.flatMap((p) => [p.domain, ...(p.aliases ?? [])]);
  };
  return new AppsDomainService({
    dataDir: config.dataDir,
    ipAddress: config.panelDomain,
    serverIp: config.publicIp ?? publicIpFromPanelDomain(config.panelDomain),
    serverIpv6: config.publicIpv6,
    panelHosts: () => [...deploy.panelHosts(), ...(config.panelDomain ? [config.panelDomain] : [])],
    domainInUse: async (domain) =>
      deploy.isPanelHost(domain) ||
      (await projectNames()).includes(domain) ||
      (await deploy.mailHosts().catch(() => [] as string[])).includes(domain),
    countUsingBase: async (base) => (await projectNames()).filter((d) => d.endsWith(`.${base}`)).length,
    resolver: resolvers.primary,
    fallbackResolver: resolvers.fallback,
    audit: app.auditService,
    log: (m) => app.log.warn(m),
  });
}

export default appsDomainRoutes;
