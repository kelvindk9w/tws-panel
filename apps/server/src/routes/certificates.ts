/**
 * certificates.ts — rotas da página Certificados.
 *
 *  GET    /api/certificates                  lista (filtros: kind, project, host)
 *  POST   /api/certificates/:host/retry      "Tentar emitir agora" (1/min por nome)
 *  PUT    /api/certificates/:host/manual     instala certificado manual (a chave nunca volta)
 *  DELETE /api/certificates/:host/manual     volta para o automático
 *
 * Regras em services/certificate-service.ts.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import type {
  CertificateItemResponse,
  CertificateListResponse,
  CertificateOwnerKind,
  CertificateRetryResponse,
  InstallManualCertificateRequest,
} from "@paas/core";
import { publicResolver } from "@paas/mailer";
import { registerErrorHandler } from "../plugins/error-handler.js";
import { CertificateService } from "../services/certificate-service.js";
import { ManualCertificateStore } from "../services/certificate-store.js";
import type { HttpError } from "../services/http-error.js";

declare module "fastify" {
  interface FastifyInstance {
    certificateStore: ManualCertificateStore;
    certificateService: CertificateService;
  }
}

/** Mesma regra de nome do Caddyfile (SAFE_DOMAIN_RE), nas duas caixas. */
const HOST_SCHEMA = {
  type: "string",
  minLength: 3,
  maxLength: 253,
  pattern: "^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$",
} as const;

const hostParams = {
  params: {
    type: "object",
    required: ["host"],
    additionalProperties: false,
    properties: { host: HOST_SCHEMA },
  },
} as const;

const listSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: { type: "string", enum: ["panel", "project", "mail"] },
      project: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" },
      host: HOST_SCHEMA,
    },
  },
} as const;

const manualSchema = {
  ...hostParams,
  body: {
    type: "object",
    required: ["certificate", "privateKey"],
    additionalProperties: false,
    properties: {
      // cadeia completa cabe com folga; acima disso não é um certificado de site
      certificate: { type: "string", minLength: 1, maxLength: 65_536 },
      privateKey: { type: "string", minLength: 1, maxLength: 16_384 },
    },
  },
} as const;

/** Conferência dos certificados manuais (alertas de 30 e 7 dias). */
const EXPIRY_CHECK_MS = 6 * 60 * 60 * 1000;

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const e = err as Partial<HttpError>;
  return reply.code(e.statusCode ?? 500).send({
    error: e.code ?? "internal_error",
    message: e.statusCode ? (e.message ?? "Erro.") : "Erro interno ao tratar o certificado.",
    ...(e.details ?? {}),
  });
}

export interface CertificatesRoutesOptions {
  /** Serviço pronto (testes); sem ele, é montado a partir da app. */
  service?: CertificateService;
}

const certificatesRoutes: FastifyPluginAsync<CertificatesRoutesOptions> = async (app, opts) => {
  registerErrorHandler(app);
  // Em produção o serviço nasce no escopo raiz (app.ts): a verificação de DNS
  // do e-mail pede a emissão por ele, com o mesmo limite de 1 por minuto.
  const service =
    opts.service ?? (app.hasDecorator("certificateService") ? app.certificateService : buildCertificateService(app));
  if (!app.hasDecorator("certificateService")) app.decorate("certificateService", service);

  const runExpiryCheck = () => {
    service.checkExpiryAlerts().catch((err: unknown) =>
      app.log.warn(`Certificados: falha ao conferir vencimentos (${err instanceof Error ? err.message : String(err)}).`),
    );
  };
  const first = setTimeout(runExpiryCheck, 60_000);
  first.unref();
  const timer = setInterval(runExpiryCheck, EXPIRY_CHECK_MS);
  timer.unref();
  app.addHook("onClose", async () => {
    clearTimeout(first);
    clearInterval(timer);
  });

  app.get<{ Querystring: { kind?: CertificateOwnerKind; project?: string; host?: string } }>(
    "/api/certificates",
    { schema: listSchema },
    async (request, reply) => {
      try {
        const q = request.query;
        const body: CertificateListResponse = await service.list({
          ...(q.kind ? { kind: q.kind } : {}),
          ...(q.project ? { projectId: q.project } : {}),
          ...(q.host ? { host: q.host } : {}),
        });
        return reply.send(body);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: { host: string } }>(
    "/api/certificates/:host/retry",
    { schema: hostParams },
    async (request, reply) => {
      try {
        const body: CertificateRetryResponse = await service.retry(request.params.host);
        return reply.code(202).send(body);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.put<{ Params: { host: string }; Body: InstallManualCertificateRequest }>(
    "/api/certificates/:host/manual",
    { schema: manualSchema },
    async (request, reply) => {
      try {
        const item = await service.installManual(request.params.host, request.body.certificate, request.body.privateKey);
        const body: CertificateItemResponse = { item };
        return reply.send(body);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete<{ Params: { host: string } }>(
    "/api/certificates/:host/manual",
    { schema: hostParams },
    async (request, reply) => {
      try {
        const body: CertificateItemResponse = { item: await service.removeManual(request.params.host) };
        return reply.send(body);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
};

/** Liga o serviço ao proxy e ao e-mail (os dois pelo deployService). */
export function buildCertificateService(app: FastifyInstance): CertificateService {
  const store = app.hasDecorator("certificateStore") ? app.certificateStore : new ManualCertificateStore(app.config.dataDir);
  // O e-mail chega pelo deployService (escopo raiz): o mailService fica
  // encapsulado no plugin das rotas de e-mail.
  const deploy = app.deployService;
  const resolver = publicResolver();
  return new CertificateService(
    store,
    {
      listProjects: () => deploy.listProjects(),
      panelDomain: () => deploy.panelSite?.domain ?? null,
      mailHosts: () => deploy.mailHosts(),
      proxyRunning: () => deploy.proxyRunning(),
      servedCertificate: (host) => deploy.servedCertificate(host),
      caddyLogs: () => deploy.proxyLogs(),
      refreshProxy: (o) => deploy.refreshProxy(undefined, o),
      removeManualFiles: (host) => deploy.removeManualCertificateFiles(host),
      syncMailTls: () => deploy.syncMailTls(),
      resolve4: (host) => resolver.resolve4(host),
    },
    {
      audit: app.auditService,
      ...(app.hasDecorator("alertsService") ? { alerts: app.alertsService } : {}),
      log: (m) => app.log.warn(m),
    },
  );
}

export default certificatesRoutes;
