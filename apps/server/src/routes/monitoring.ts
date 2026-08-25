/**
 * monitoring.ts — rotas da Fase 4: central de alertas, baseline + scan
 * recorrente de segurança e auditoria. O agendador de scans inicia junto
 * com o servidor (dentro do processo — nada de cron/systemd no host).
 */
import type { FastifyPluginAsync } from "fastify";
import {
  ALERT_SEVERITIES,
  ALERT_SOURCES,
  ALERT_STATUSES,
  MONITOR_MIN_INTERVAL_MS,
  type AlertListResponse,
  type AlertResponse,
  type AlertSeverity,
  type AlertSource,
  type AlertStatus,
  type AuditListResponse,
  type BaselineResponse,
  type MonitorConfig,
  type MonitorRunResponse,
  type MonitorStateResponse,
} from "@paas/core";
import { MonitorService } from "../services/monitor-service.js";
import { registerErrorHandler } from "../plugins/error-handler.js";

declare module "fastify" {
  interface FastifyInstance {
    monitorService: MonitorService;
  }
}

// Paginação: os handlers já fazem `Number(...)` manualmente e a coerção de
// tipos do Ajv está desligada globalmente — por isso page/perPage chegam
// como string aqui (não `integer`), restritas por um padrão numérico.
// perPage limitado a 3 dígitos (max 999) para um cliente não pedir a base
// inteira de uma vez; o service ainda garante o teto de 200 por página.
const PAGE_PATTERN = "^[1-9][0-9]{0,5}$";
const PER_PAGE_PATTERN = "^[1-9][0-9]{0,2}$";

const alertsQuerySchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      status: { type: "string", enum: [...ALERT_STATUSES] },
      severity: { type: "string", enum: [...ALERT_SEVERITIES] },
      source: { type: "string", enum: [...ALERT_SOURCES] },
      page: { type: "string", pattern: PAGE_PATTERN },
      perPage: { type: "string", pattern: PER_PAGE_PATTERN },
    },
  },
} as const;

const alertIdParamsSchema = {
  params: {
    type: "object",
    required: ["id"],
    additionalProperties: false,
    properties: {
      id: { type: "string", minLength: 1, maxLength: 64 },
    },
  },
} as const;

const monitorConfigSchema = {
  body: {
    type: "object",
    required: ["intervalMs"],
    additionalProperties: false,
    properties: {
      // MONITOR_MIN_INTERVAL_MS evita busy-loop de scans.
      intervalMs: { type: "integer", minimum: MONITOR_MIN_INTERVAL_MS },
    },
  },
} as const;

const auditQuerySchema = {
  querystring: {
    type: "object",
    additionalProperties: false,
    properties: {
      page: { type: "string", pattern: PAGE_PATTERN },
      perPage: { type: "string", pattern: PER_PAGE_PATTERN },
    },
  },
} as const;

const monitoringRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);
  const alerts = app.alertsService;
  const audit = app.auditService;
  const monitor = new MonitorService(app.config, alerts, (msg) => {
    app.log.warn(msg);
  });
  app.decorate("monitorService", monitor);

  // Inclui o check de blacklist no scan recorrente quando o módulo de e-mail
  // está ativo (há domínios cadastrados).
  monitor.setMailBlacklistHook(async () => {
    const domains = await app.mailService.listDomains();
    if (domains.length === 0) return [];
    const check = await app.mailService.checkBlacklists();
    const listed: string[] = [];
    for (const target of [check.ip, ...check.domains]) {
      if (!target) continue;
      for (const r of target.results) {
        if (r.status === "listed") {
          listed.push(`${target.target} listado em ${r.label} — remoção: ${r.removalUrl ?? "ver provedor da DNSBL"}`);
        }
      }
    }
    return listed;
  });

  await monitor.start();
  app.addHook("onClose", async () => monitor.stop());
  app.log.info(
    "Monitoramento de segurança agendado a cada %d min (alvo: %s).",
    Math.round((await monitor.getState()).config.intervalMs / 60_000),
    app.config.securityTarget === "host" ? "host" : `container:${app.config.securityTargetContainer}`,
  );

  // -------------------------------------------------------------------------
  // Alertas
  // -------------------------------------------------------------------------

  app.get<{
    Querystring: { status?: AlertStatus; severity?: AlertSeverity; source?: AlertSource; page?: string; perPage?: string };
  }>(
    "/api/alerts",
    { schema: alertsQuerySchema },
    async (request, reply) => {
      const { status, severity, source, page, perPage } = request.query;
      const result = await alerts.list({
        ...(status ? { status } : {}),
        ...(severity ? { severity } : {}),
        ...(source ? { source } : {}),
        ...(page ? { page: Number(page) } : {}),
        ...(perPage ? { perPage: Number(perPage) } : {}),
      });
      const response: AlertListResponse = result;
      return reply.send(response);
    },
  );

  const transition = async (
    id: string,
    to: "acknowledged" | "resolved",
  ): Promise<{ status: number; body: unknown }> => {
    const alert = await alerts.setStatus(id, to);
    if (!alert) {
      return { status: 404, body: { error: "alert_not_found", message: "Alerta não encontrado." } };
    }
    const response: AlertResponse = { alert };
    return { status: 200, body: response };
  };

  app.post<{ Params: { id: string } }>(
    "/api/alerts/:id/ack",
    { schema: alertIdParamsSchema },
    async (request, reply) => {
      const { status, body } = await transition(request.params.id, "acknowledged");
      return reply.code(status).send(body);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/alerts/:id/resolve",
    { schema: alertIdParamsSchema },
    async (request, reply) => {
      const { status, body } = await transition(request.params.id, "resolved");
      return reply.code(status).send(body);
    },
  );

  // -------------------------------------------------------------------------
  // Baseline de segurança
  // -------------------------------------------------------------------------

  app.get("/api/security/baseline", async (_request, reply) => {
    const response: BaselineResponse = { baseline: await monitor.getBaseline() };
    return reply.send(response);
  });

  app.post("/api/security/baseline", async (_request, reply) => {
    try {
      const baseline = await monitor.createBaseline();
      await audit.record({
        action: "security.baseline",
        target: baseline.target,
        detail: `Baseline criado: ${baseline.packages.length} pacotes, ${baseline.ports.length} portas, ${Object.keys(baseline.files).length} arquivos rastreados.`,
      });
      const response: BaselineResponse = { baseline };
      return reply.code(201).send(response);
    } catch (err) {
      return reply.code(500).send({
        error: "baseline_failed",
        message: err instanceof Error ? err.message : "Falha ao criar o baseline.",
      });
    }
  });

  // -------------------------------------------------------------------------
  // Scan recorrente (monitor)
  // -------------------------------------------------------------------------

  app.get("/api/security/monitor/last", async (_request, reply) => {
    const response: MonitorStateResponse = await monitor.getState();
    return reply.send(response);
  });

  app.post("/api/security/monitor/run", async (_request, reply) => {
    try {
      const result = await monitor.runNow();
      const response: MonitorRunResponse = { result };
      return reply.send(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Falha ao executar o scan.";
      // Já existe um scan em andamento (lock do MonitorScheduler) → 409, no
      // mesmo padrão do job_conflict do SecurityExecutor — não é uma falha
      // interna, é uma recusa esperada.
      const conflict = message.includes("já existe um scan");
      return reply.code(conflict ? 409 : 500).send({
        error: conflict ? "scan_in_progress" : "monitor_run_failed",
        message,
      });
    }
  });

  app.put<{ Body: { intervalMs: number } }>(
    "/api/security/monitor/config",
    { schema: monitorConfigSchema },
    async (request, reply) => {
      const { intervalMs } = request.body;
      await monitor.setIntervalMs(intervalMs);
      await audit.record({
        action: "monitor.config",
        target: null,
        detail: `Intervalo do scan recorrente alterado para ${Math.round(intervalMs / 60_000)} min.`,
      });
      const config: MonitorConfig = { intervalMs };
      return reply.send({ config });
    },
  );

  // -------------------------------------------------------------------------
  // Auditoria
  // -------------------------------------------------------------------------

  app.get<{ Querystring: { page?: string; perPage?: string } }>(
    "/api/audit",
    { schema: auditQuerySchema },
    async (request, reply) => {
      const page = Number(request.query.page ?? 1);
      const perPage = Number(request.query.perPage ?? 50);
      const response: AuditListResponse = await audit.list(page, perPage);
      return reply.send(response);
    },
  );
};

export default monitoringRoutes;
