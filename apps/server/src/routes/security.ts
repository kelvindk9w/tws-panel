import type { FastifyPluginAsync } from "fastify";
import {
  SECURITY_PHASES,
  isValidSshPublicKey,
  isValidSshUsername,
  type SecurityApplyRequest,
  type SecurityApplyResponse,
  type SecurityConfirmAccessResponse,
  type SecurityHistoryResponse,
  type SecurityJobResponse,
  type SecurityManualCommandsResponse,
  type SecurityPhaseId,
  type SecurityPlan,
  type SecurityScanResponse,
} from "@paas/core";
import { SecurityService } from "../services/security-service.js";
import { registerErrorHandler } from "../plugins/error-handler.js";

declare module "fastify" {
  interface FastifyInstance {
    securityService: SecurityService;
  }
}

// Fases de hardening válidas (mesmo conjunto fechado usado no plano/aplicação).
const PHASE_IDS = SECURITY_PHASES.map((p) => p.id);

// Schemas de validação. `additionalProperties: false` no corpo recusa campo
// desconhecido — as regras de negócio específicas (ex.: sshUser/sshPublicKey
// só valem na fase 01, formato da chave SSH) continuam no handler, pois não
// são só verificação de tipo.
const scanSchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      fresh: { type: "string", enum: ["0", "1"] },
    },
  },
} as const;

const applySchema = {
  body: {
    type: "object",
    required: ["phase", "dryRun"],
    additionalProperties: false,
    properties: {
      phase: { type: "string", enum: PHASE_IDS, maxLength: 2 },
      dryRun: { type: "boolean" },
      sshUser: { type: "string", minLength: 1, maxLength: 32 },
      sshPublicKey: { type: "string", minLength: 1, maxLength: 2048 },
    },
  },
} as const;

const jobParamsSchema = {
  params: {
    type: "object",
    required: ["id"],
    additionalProperties: false,
    properties: {
      id: { type: "string", minLength: 1, maxLength: 64 },
    },
  },
} as const;

const confirmAccessSchema = {
  body: {
    type: "object",
    required: ["jobId"],
    additionalProperties: false,
    properties: {
      jobId: { type: "string", minLength: 1, maxLength: 64 },
    },
  },
} as const;

const manualPhaseSchema = {
  params: {
    type: "object",
    required: ["phase"],
    additionalProperties: false,
    properties: {
      phase: { type: "string", enum: PHASE_IDS, maxLength: 2 },
    },
  },
} as const;

const securityRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);
  const service = new SecurityService(app.config, {
    audit: (action, detail) => {
      void app.auditService.record({ action, detail });
    },
    terminal: app.terminalService,
    // Timing por check do scanner no log do servidor (sem conteúdo).
    log: (msg) => {
      app.log.info(msg);
    },
  });
  app.decorate("securityService", service);

  // Restaura jobs persistidos de uma execução anterior do painel — sem isso,
  // um restart durante "awaiting_confirmation" fazia este mesmo GET
  // /api/security/jobs/:id responder 404 enquanto o rollback agendado no
  // alvo seguia rodando de forma independente. Roda antes de o plugin
  // aceitar tráfego (Fastify aguarda a registração terminar).
  await service.restoreJobsFromDisk();

  if (app.config.securityTarget !== "host") {
    app.log.warn(
      "Segurança: alvo = %s (modo seguro de dev). Para hardening do host real, defina PAAS_TARGET=host explicitamente.",
      service.targetLabel,
    );
  }

  // Último relatório conhecido (imediato, nunca dispara scan novo).
  // Query ?fresh=1 força re-execução; refreshing sinaliza scan em andamento.
  app.get<{ Querystring: { fresh?: string } }>(
    "/api/security/scan",
    { schema: scanSchema },
    async (request, reply) => {
      const force = request.query.fresh === "1";
      const { report, cached, refreshing } = await service.scan(force);
      const response: SecurityScanResponse = { report, cached, refreshing };
      return reply.send(response);
    },
  );

  // Plano de correção a partir do último scan.
  app.post("/api/security/plan", async (_request, reply) => {
    const plan: SecurityPlan = await service.plan();
    return reply.send(plan);
  });

  // Aplica uma fase de hardening (job assíncrono). Ações pré-definidas apenas.
  app.post<{ Body: SecurityApplyRequest }>(
    "/api/security/apply",
    { schema: applySchema },
    async (request, reply) => {
      const { phase, dryRun, sshUser, sshPublicKey } = request.body;
      // Parâmetros da Fase 01 (usuário não-root + chave pública do operador).
      if ((sshUser !== undefined || sshPublicKey !== undefined) && phase !== "01") {
        return reply.code(400).send({
          error: "invalid_params",
          message: "sshUser/sshPublicKey só se aplicam à fase 01.",
        });
      }
      if (sshUser !== undefined && !isValidSshUsername(sshUser)) {
        return reply.code(400).send({
          error: "invalid_ssh_user",
          message: "Nome de usuário inválido (minúsculas, sem espaços, nunca root).",
        });
      }
      if (sshPublicKey !== undefined && !isValidSshPublicKey(sshPublicKey)) {
        return reply.code(400).send({
          error: "invalid_ssh_key",
          message: "Chave pública inválida. Cole uma chave ssh-ed25519 ou ssh-rsa (conteúdo do .pub).",
        });
      }
      try {
        const hasParams = sshUser !== undefined || sshPublicKey !== undefined;
        const params = {
          ...(sshUser !== undefined ? { sshUser } : {}),
          ...(sshPublicKey !== undefined ? { sshPublicKey: sshPublicKey.trim() } : {}),
        };
        const job = await service.apply(phase, dryRun, hasParams ? params : undefined);
        await app.auditService.record({
          action: "hardening.apply",
          target: phase,
          detail:
            `Fase de hardening "${job.title}" iniciada (dryRun=${dryRun}).` +
            (sshPublicKey !== undefined ? ` Chave SSH do operador instalada para "${sshUser ?? "deploy"}".` : ""),
        });
        const response: SecurityApplyResponse = { job };
        return reply.code(202).send(response);
      } catch (err) {
        return reply.code(409).send({
          error: "job_conflict",
          message: err instanceof Error ? err.message : "Não foi possível iniciar o job.",
        });
      }
    },
  );

  // Status e log de um job.
  app.get<{ Params: { id: string } }>(
    "/api/security/jobs/:id",
    { schema: jobParamsSchema },
    async (request, reply) => {
      const job = service.getJob(request.params.id);
      if (!job) {
        return reply.code(404).send({ error: "job_not_found", message: "Job não encontrado." });
      }
      const response: SecurityJobResponse = { job };
      return reply.send(response);
    },
  );

  // Cancela o rollback agendado após o operador confirmar conectividade.
  app.post<{ Body: { jobId: string } }>(
    "/api/security/confirm-access",
    { schema: confirmAccessSchema },
    async (request, reply) => {
      const { jobId } = request.body;
      try {
        const job = await service.confirmAccess(jobId);
        const response: SecurityConfirmAccessResponse = { confirmed: true, job };
        return reply.send(response);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Falha ao confirmar acesso.";
        const notFound = message.includes("não encontrado");
        return reply.code(notFound ? 404 : 409).send({
          error: notFound ? "job_not_found" : "confirm_failed",
          message,
        });
      }
    },
  );

  // Modo manual: comandos exatos da fase + conteúdo do script (copiáveis).
  app.get<{ Params: { phase: SecurityPhaseId } }>(
    "/api/security/phases/:phase/manual",
    { schema: manualPhaseSchema },
    async (request, reply) => {
      const { phase } = request.params;
      const response: SecurityManualCommandsResponse = await service.manualCommands(phase);
      return reply.send(response);
    },
  );

  // Histórico de scans/jobs + índice antes/depois.
  app.get("/api/security/history", async (_request, reply) => {
    const history = await service.history();
    const response: SecurityHistoryResponse = history;
    return reply.send(response);
  });
};

export default securityRoutes;
