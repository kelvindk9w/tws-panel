/**
 * mail.ts — rotas do módulo de e-mail (Fase 3, plano §5.3).
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type {
  CreateMailDomainRequest,
  CreateMailboxRequest,
  DnsChecklistResponse,
  DnsVerifyResponse,
  EnableProjectEmailRequest,
  MailDomainListResponse,
  MailDomainResponse,
  MailboxCredentialsResponse,
  MailboxListResponse,
  MailboxResponse,
  MailServerActionResponse,
  MailServerStatus,
  ProjectEmailResponse,
} from "@paas/core";
import { MailService } from "../services/mail-service.js";
import { httpError, type HttpError } from "../services/deploy-service.js";
import { registerErrorHandler } from "../plugins/error-handler.js";

declare module "fastify" {
  interface FastifyInstance {
    mailService: MailService;
  }
}

// -----------------------------------------------------------------------------
// Schemas de validação.
//
// Param `:domain`: o valor vira nome de diretório e argumento de comando no
// Stalwart (ver MailService/StalwartManager) — o caso mais sensível deste
// arquivo. O pattern abaixo espelha a MESMA regra de hostname usada em
// normalizeMailDomain (apps/server/src/services/mail-service.ts), para que a
// recusa aconteça já na borda HTTP e não só no service. normalizeMailDomain
// testa o valor após trim + minúsculas; aqui aceitamos as duas caixas para
// não restringir o conjunto de domínios aceitos além do que o service aceita.
const MAIL_DOMAIN_PATTERN =
  "^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$";

const MAIL_DOMAIN_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 253,
  pattern: MAIL_DOMAIN_PATTERN,
} as const;

const domainParamSchema = {
  params: {
    type: "object",
    required: ["domain"],
    properties: { domain: MAIL_DOMAIN_SCHEMA },
  },
} as const;

const createMailDomainSchema = {
  body: {
    type: "object",
    required: ["domain"],
    additionalProperties: false,
    properties: { domain: MAIL_DOMAIN_SCHEMA },
  },
} as const;

// Local-part de caixa (parte antes do @): mesmo alfabeto aceito por
// normalizeLocalPart (mail-service.ts), nas duas caixas pelo mesmo motivo do
// domínio acima — o service normaliza para minúsculas antes de validar.
const MAILBOX_LOCAL_PART_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$",
} as const;

// Senha de caixa: o service (createMailbox) recusa senha com menos de 8
// caracteres — mesmo mínimo aqui, para recusar já na borda. maxLength alto
// (200) para não impedir senhas geradas por gerenciadores externos.
const MAILBOX_PASSWORD_SCHEMA = {
  type: "string",
  minLength: 8,
  maxLength: 200,
} as const;

// Id de caixa (endereço completo, ex.: vendas@exemplo.com, por vezes
// URL-encoded). 90 fica abaixo do teto padrão de param do Fastify (100, que
// responde 414 antes do schema) e é generoso para qualquer endereço real.
const MAILBOX_ID_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 90,
} as const;

const createMailboxSchema = {
  params: {
    type: "object",
    required: ["domain"],
    properties: { domain: MAIL_DOMAIN_SCHEMA },
  },
  body: {
    type: "object",
    required: ["localPart"],
    additionalProperties: false,
    properties: {
      localPart: MAILBOX_LOCAL_PART_SCHEMA,
      password: MAILBOX_PASSWORD_SCHEMA,
    },
  },
} as const;

const mailboxParamSchema = {
  params: {
    type: "object",
    required: ["domain", "id"],
    properties: {
      domain: MAIL_DOMAIN_SCHEMA,
      id: MAILBOX_ID_SCHEMA,
    },
  },
} as const;

const mailboxIdParamSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: { id: MAILBOX_ID_SCHEMA },
  },
} as const;

// Id de projeto: mesmo limite usado em projects.ts (updateProjectSchema).
const projectIdParamSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
  },
} as const;

const enableProjectEmailSchema = {
  params: projectIdParamSchema.params,
  body: {
    type: "object",
    required: ["domain"],
    additionalProperties: false,
    properties: { domain: MAIL_DOMAIN_SCHEMA },
  },
} as const;

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const e = err as Partial<HttpError>;
  return reply.code(e.statusCode ?? 500).send({
    error: e.code ?? "internal_error",
    message: e.message ?? "Erro interno.",
  });
}

const mailRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);
  // O sink de auditoria precisa ser injetado aqui: sem ele, deleteMailbox
  // remove a caixa sem deixar registro na trilha, ao contrário de criar
  // domínio e criar caixa.
  const service = new MailService(app.config, { audit: app.auditService });
  app.decorate("mailService", service);

  // Conecta a injeção SMTP ao fluxo de deploy da Fase 2.
  app.deployService.setEnvProvider(service.envForProject);

  // -------------------------------------------------------------------------
  // Servidor Stalwart
  // -------------------------------------------------------------------------

  app.get("/api/mail/status", async (_request, reply) => {
    try {
      const status: MailServerStatus = await service.status();
      return reply.send(status);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/mail/server/start", async (_request, reply) => {
    try {
      const status = await service.startServer();
      const response: MailServerActionResponse = { ok: true, status };
      return reply.send(response);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post("/api/mail/server/stop", async (_request, reply) => {
    try {
      const status = await service.stopServer();
      const response: MailServerActionResponse = { ok: true, status };
      return reply.send(response);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // -------------------------------------------------------------------------
  // Domínios
  // -------------------------------------------------------------------------

  app.get("/api/mail/domains", async (_request, reply) => {
    const domains = await service.listDomains();
    const response: MailDomainListResponse = { domains };
    return reply.send(response);
  });

  app.post<{ Body: CreateMailDomainRequest }>(
    "/api/mail/domains",
    { schema: createMailDomainSchema },
    async (request, reply) => {
      try {
        const name = request.body?.domain ?? "";
        const domain = await service.addDomain(name);
        await app.auditService.record({
          action: "mail.domain.add",
          target: domain.name,
          detail: `Domínio de e-mail ${domain.name} provisionado (DKIM ${domain.dkimKeyBits}-bit).`,
        });
        const response: MailDomainResponse = { domain };
        return reply.code(201).send(response);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete<{ Params: { domain: string } }>(
    "/api/mail/domains/:domain",
    { schema: domainParamSchema },
    async (request, reply) => {
      try {
        await service.removeDomain(request.params.domain);
        await app.auditService.record({
          action: "mail.domain.remove",
          target: request.params.domain,
          detail: `Domínio de e-mail ${request.params.domain} removido.`,
        });
        return reply.send({ ok: true });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // Check de blacklist (Fase 4): IP público + domínios contra as DNSBLs.
  app.get("/api/mail/blacklist", async (_request, reply) => {
    try {
      const response = await service.checkBlacklists();
      return reply.send(response);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get<{ Params: { domain: string } }>(
    "/api/mail/domains/:domain/dns",
    { schema: domainParamSchema },
    async (request, reply) => {
      try {
        const response: DnsChecklistResponse = await service.dnsChecklist(request.params.domain);
        return reply.send(response);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: { domain: string } }>(
    "/api/mail/domains/:domain/verify",
    { schema: domainParamSchema },
    async (request, reply) => {
      try {
        const response: DnsVerifyResponse = await service.verifyDomain(request.params.domain);
        return reply.send(response);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Caixas de e-mail
  // -------------------------------------------------------------------------

  app.get<{ Params: { domain: string } }>(
    "/api/mail/domains/:domain/mailboxes",
    { schema: domainParamSchema },
    async (request, reply) => {
      try {
        const mailboxes = await service.listMailboxes(request.params.domain);
        const response: MailboxListResponse = { mailboxes };
        return reply.send(response);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post<{ Params: { domain: string }; Body: CreateMailboxRequest }>(
    "/api/mail/domains/:domain/mailboxes",
    { schema: createMailboxSchema },
    async (request, reply) => {
      try {
        const { mailbox, password } = await service.createMailbox(
          request.params.domain,
          request.body?.localPart ?? "",
          request.body?.password,
        );
        await app.auditService.record({
          action: "mail.mailbox.create",
          target: `${mailbox.localPart}@${request.params.domain}`,
          detail: `Caixa de e-mail ${mailbox.localPart}@${request.params.domain} criada.`,
        });
        const response: MailboxResponse = { mailbox, password };
        return reply.code(201).send(response);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete<{ Params: { domain: string; id: string } }>(
    "/api/mail/domains/:domain/mailboxes/:id",
    { schema: mailboxParamSchema },
    async (request, reply) => {
      try {
        await service.deleteMailbox(request.params.domain, request.params.id);
        return reply.send({ ok: true });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/mail/mailboxes/:id/credentials",
    { schema: mailboxIdParamSchema },
    async (request, reply) => {
      try {
        const credentials = await service.mailboxCredentials(request.params.id);
        const response: MailboxCredentialsResponse = { credentials };
        return reply.send(response);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // E-mail de projeto (injeção SMTP)
  // -------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/email",
    { schema: projectIdParamSchema },
    async (request, reply) => {
      const project = await app.deployService.getProject(request.params.id);
      if (!project) {
        return reply.code(404).send({ error: "project_not_found", message: "Projeto não encontrado." });
      }
      const email = await service.projectEmailConfig(project.id);
      const response: ProjectEmailResponse = { email };
      return reply.send(response);
    },
  );

  app.post<{ Params: { id: string }; Body: EnableProjectEmailRequest }>(
    "/api/projects/:id/email",
    { schema: enableProjectEmailSchema },
    async (request, reply) => {
      try {
        const project = await app.deployService.getProject(request.params.id);
        if (!project) {
          throw httpError(404, "project_not_found", "Projeto não encontrado.");
        }
        const email = await service.enableProjectEmail(project, request.body?.domain ?? "");
        const response: ProjectEmailResponse = { email };
        return reply.send(response);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/projects/:id/email",
    { schema: projectIdParamSchema },
    async (request, reply) => {
      const project = await app.deployService.getProject(request.params.id);
      if (!project) {
        return reply.code(404).send({ error: "project_not_found", message: "Projeto não encontrado." });
      }
      const email = await service.disableProjectEmail(project.id);
      const response: ProjectEmailResponse = { email };
      return reply.send(response);
    },
  );
};

export default mailRoutes;
