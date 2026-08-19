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

declare module "fastify" {
  interface FastifyInstance {
    monitorService: MonitorService;
  }
}

const monitoringRoutes: FastifyPluginAsync = async (app) => {
  const alerts = app.alertsService;
  const audit = app.auditService;
  const monitor = new MonitorService(app.config, alerts);
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
    Querystring: { status?: string; severity?: string; source?: string; page?: string; perPage?: string };
  }>("/api/alerts", async (request, reply) => {
    const { status, severity, source, page, perPage } = request.query;
    if (status && !ALERT_STATUSES.includes(status as AlertStatus)) {
      return reply.code(400).send({ error: "invalid_status", message: `Status inválido. Aceitos: ${ALERT_STATUSES.join(", ")}.` });
    }
    if (severity && !ALERT_SEVERITIES.includes(severity as AlertSeverity)) {
      return reply.code(400).send({ error: "invalid_severity", message: `Severidade inválida. Aceitas: ${ALERT_SEVERITIES.join(", ")}.` });
    }
    if (source && !ALERT_SOURCES.includes(source as AlertSource)) {
      return reply.code(400).send({ error: "invalid_source", message: `Origem inválida. Aceitas: ${ALERT_SOURCES.join(", ")}.` });
    }
    const result = await alerts.list({
      ...(status ? { status: status as AlertStatus } : {}),
      ...(severity ? { severity: severity as AlertSeverity } : {}),
      ...(source ? { source: source as AlertSource } : {}),
      ...(page ? { page: Number(page) } : {}),
      ...(perPage ? { perPage: Number(perPage) } : {}),
    });
    const response: AlertListResponse = result;
    return reply.send(response);
  });

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

  app.post<{ Params: { id: string } }>("/api/alerts/:id/ack", async (request, reply) => {
    const { status, body } = await transition(request.params.id, "acknowledged");
    return reply.code(status).send(body);
  });

  app.post<{ Params: { id: string } }>("/api/alerts/:id/resolve", async (request, reply) => {
    const { status, body } = await transition(request.params.id, "resolved");
    return reply.code(status).send(body);
  });

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
      return reply.code(500).send({
        error: "monitor_run_failed",
        message: err instanceof Error ? err.message : "Falha ao executar o scan.",
      });
    }
  });

  app.put<{ Body: { intervalMs?: number } }>("/api/security/monitor/config", async (request, reply) => {
    const intervalMs = request.body?.intervalMs;
    if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs) || intervalMs < MONITOR_MIN_INTERVAL_MS) {
      return reply.code(400).send({
        error: "invalid_interval",
        message: `intervalMs inválido — mínimo ${MONITOR_MIN_INTERVAL_MS / 1000}s.`,
      });
    }
    await monitor.setIntervalMs(Math.round(intervalMs));
    await audit.record({
      action: "monitor.config",
      target: null,
      detail: `Intervalo do scan recorrente alterado para ${Math.round(intervalMs / 60_000)} min.`,
    });
    const config: MonitorConfig = { intervalMs: Math.round(intervalMs) };
    return reply.send({ config });
  });

  // -------------------------------------------------------------------------
  // Auditoria
  // -------------------------------------------------------------------------

  app.get<{ Querystring: { page?: string; perPage?: string } }>("/api/audit", async (request, reply) => {
    const page = Number(request.query.page ?? 1);
    const perPage = Number(request.query.perPage ?? 50);
    const response: AuditListResponse = await audit.list(
      Number.isFinite(page) ? page : 1,
      Number.isFinite(perPage) ? perPage : 50,
    );
    return reply.send(response);
  });
};

export default monitoringRoutes;
