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

declare module "fastify" {
  interface FastifyInstance {
    securityService: SecurityService;
  }
}

const VALID_PHASES = new Set<string>(SECURITY_PHASES.map((p) => p.id));

function isValidPhase(value: unknown): value is SecurityPhaseId {
  return typeof value === "string" && VALID_PHASES.has(value);
}

const securityRoutes: FastifyPluginAsync = async (app) => {
  const service = new SecurityService(app.config, {
    audit: (action, detail) => {
      void app.auditService.record({ action, detail });
    },
  });
  app.decorate("securityService", service);

  if (app.config.securityTarget !== "host") {
    app.log.warn(
      "Segurança: alvo = %s (modo seguro de dev). Para hardening do host real, defina PAAS_TARGET=host explicitamente.",
      service.targetLabel,
    );
  }

  // Scan completo (cache de 60s). Query ?fresh=1 força re-execução.
  app.get<{ Querystring: { fresh?: string } }>("/api/security/scan", async (request, reply) => {
    const force = request.query.fresh === "1";
    const { report, cached } = await service.scan(force);
    const response: SecurityScanResponse = { report, cached };
    return reply.send(response);
  });

  // Plano de correção a partir do último scan.
  app.post("/api/security/plan", async (_request, reply) => {
    const plan: SecurityPlan = await service.plan();
    return reply.send(plan);
  });

  // Aplica uma fase de hardening (job assíncrono). Ações pré-definidas apenas.
  app.post<{ Body: SecurityApplyRequest }>("/api/security/apply", async (request, reply) => {
    const { phase, dryRun, sshUser, sshPublicKey } = request.body ?? {};
    if (!isValidPhase(phase)) {
      return reply.code(400).send({
        error: "invalid_phase",
        message: `Fase inválida. Valores aceitos: ${[...VALID_PHASES].join(", ")}.`,
      });
    }
    if (typeof dryRun !== "boolean") {
      return reply.code(400).send({
        error: "invalid_dry_run",
        message: "Informe dryRun como boolean.",
      });
    }
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
      const params = {
        ...(sshUser !== undefined ? { sshUser } : {}),
        ...(sshPublicKey !== undefined ? { sshPublicKey: sshPublicKey.trim() } : {}),
      };
      const job = await service.apply(phase, dryRun, params);
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
  });

  // Status e log de um job.
  app.get<{ Params: { id: string } }>("/api/security/jobs/:id", async (request, reply) => {
    const job = service.getJob(request.params.id);
    if (!job) {
      return reply.code(404).send({ error: "job_not_found", message: "Job não encontrado." });
    }
    const response: SecurityJobResponse = { job };
    return reply.send(response);
  });

  // Cancela o rollback agendado após o operador confirmar conectividade.
  app.post<{ Body: { jobId?: string } }>("/api/security/confirm-access", async (request, reply) => {
    const jobId = request.body?.jobId;
    if (typeof jobId !== "string" || jobId.length === 0) {
      return reply.code(400).send({ error: "invalid_job", message: "Informe jobId." });
    }
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
  });

  // Modo manual: comandos exatos da fase + conteúdo do script (copiáveis).
  app.get<{ Params: { phase: string } }>("/api/security/phases/:phase/manual", async (request, reply) => {
    const { phase } = request.params;
    if (!isValidPhase(phase)) {
      return reply.code(400).send({
        error: "invalid_phase",
        message: `Fase inválida. Valores aceitos: ${[...VALID_PHASES].join(", ")}.`,
      });
    }
    const response: SecurityManualCommandsResponse = await service.manualCommands(phase);
    return reply.send(response);
  });

  // Histórico de scans/jobs + índice antes/depois.
  app.get("/api/security/history", async (_request, reply) => {
    const history = await service.history();
    const response: SecurityHistoryResponse = history;
    return reply.send(response);
  });
};

export default securityRoutes;
