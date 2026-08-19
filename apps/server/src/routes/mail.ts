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

declare module "fastify" {
  interface FastifyInstance {
    mailService: MailService;
  }
}

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const e = err as Partial<HttpError>;
  return reply.code(e.statusCode ?? 500).send({
    error: e.code ?? "internal_error",
    message: e.message ?? "Erro interno.",
  });
}

const mailRoutes: FastifyPluginAsync = async (app) => {
  const service = new MailService(app.config);
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

  app.post<{ Body: CreateMailDomainRequest }>("/api/mail/domains", async (request, reply) => {
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
  });

  app.delete<{ Params: { domain: string } }>("/api/mail/domains/:domain", async (request, reply) => {
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
  });

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

  app.get<{ Params: { id: string } }>("/api/projects/:id/email", async (request, reply) => {
    const project = await app.deployService.getProject(request.params.id);
    if (!project) {
      return reply.code(404).send({ error: "project_not_found", message: "Projeto não encontrado." });
    }
    const email = await service.projectEmailConfig(project.id);
    const response: ProjectEmailResponse = { email };
    return reply.send(response);
  });

  app.post<{ Params: { id: string }; Body: EnableProjectEmailRequest }>(
    "/api/projects/:id/email",
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

  app.delete<{ Params: { id: string } }>("/api/projects/:id/email", async (request, reply) => {
    const project = await app.deployService.getProject(request.params.id);
    if (!project) {
      return reply.code(404).send({ error: "project_not_found", message: "Projeto não encontrado." });
    }
    const email = await service.disableProjectEmail(project.id);
    const response: ProjectEmailResponse = { email };
    return reply.send(response);
  });
};

export default mailRoutes;
