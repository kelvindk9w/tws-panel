/**
 * metrics.ts (rotas) — monitoramento de recursos.
 *
 *  GET /api/metrics/summary        semáforo do painel (host, projetos, proteções)
 *  GET /api/metrics/host?range=    séries do host
 *  GET /api/projects/:id/metrics   séries do projeto (por serviço e soma)
 *  GET /api/metrics/settings       retenção em uso e espaço ocupado
 *  PUT /api/metrics/settings       muda a retenção (só a pessoa, nunca token)
 *
 * Alcance para token (token-policy-table.ts): as duas rotas da VPS exigem token
 * de painel inteiro OU a opção "pode ver o monitoramento da VPS"; a do projeto
 * é de projeto (fora do alcance = o mesmo 404 de projeto inexistente). Somente
 * leitura, sem auditoria (a tela atualiza sozinha); só a troca de retenção é auditada.
 */
import type { FastifyPluginAsync } from "fastify";
import {
  METRICS_RANGES,
  type DeployMark,
  METRICS_RETENTION_DEFAULT,
  METRICS_RETENTION_LIMITS,
  validateMetricsRetention,
  type MetricsRange,
  type MetricsRetention,
  type MetricsSettingsResponse,
  type UpdateMetricsSettingsRequest,
} from "@paas/core";
import { registerErrorHandler } from "../plugins/error-handler.js";
import { MetricsBusyError } from "../services/metrics-query.js";
import { limitedProjectIds } from "../services/request-reach.js";

const rangeQuery = {
  type: "object",
  additionalProperties: false,
  properties: { range: { type: "string", enum: [...METRICS_RANGES] } },
} as const;

const settingsBody = {
  type: "object",
  required: ["retention"],
  additionalProperties: false,
  properties: {
    retention: {
      type: "object",
      required: ["minuteHours", "hourDays", "dayDays"],
      additionalProperties: false,
      properties: {
        minuteHours: { type: "integer", minimum: METRICS_RETENTION_LIMITS.minuteHours.min, maximum: METRICS_RETENTION_LIMITS.minuteHours.max },
        hourDays: { type: "integer", minimum: METRICS_RETENTION_LIMITS.hourDays.min, maximum: METRICS_RETENTION_LIMITS.hourDays.max },
        dayDays: { type: "integer", minimum: METRICS_RETENTION_LIMITS.dayDays.min, maximum: METRICS_RETENTION_LIMITS.dayDays.max },
      },
    },
  },
} as const;

/** Certificado com problema: igual ao vigia de certificados (não emitido, vencido, automático que não renovou). */
const certificateProblem = (i: { state: string; mode: string }) => i.state === "failed" || i.state === "expired" || (i.state === "expiring" && i.mode === "automatic");

/** Certificados e backups mudam devagar e custam consulta ao proxy: guardados por 5 minutos. */
export const PROTECTIONS_TTL_MS = 5 * 60_000;

const metricsRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);
  const limit = { rateLimit: { max: 120, timeWindow: "1 minute" } };

  const busy = (reply: import("fastify").FastifyReply) =>
    reply.code(429).send({ error: "metrics_busy", message: new MetricsBusyError().message });

  let protections: { at: number; value: Promise<unknown> } | null = null;
  const loadProtections = async () => {
    const [certs, backups] = await Promise.allSettled([app.certificateService.list(), app.backupService.facts()]);
    return {
      certificates:
        certs.status === "fulfilled" ? { total: certs.value.items.length, problems: certs.value.items.filter(certificateProblem).length } : null,
      backups: backups.status === "fulfilled" ? { destinationConnected: backups.value.destinationConnected, lastFailure: backups.value.lastFailure !== null, ...(backups.value.lastFailureAt ? { lastFailureAt: backups.value.lastFailureAt } : {}) } : null,
    };
  };

  app.get("/api/metrics/summary", { config: limit }, async (request, reply) => {
    try {
      // slugs dos projetos que o token enxerga (null = todos): o semáforo não lista projeto de fora do alcance
      const ids = limitedProjectIds(request);
      const visible = ids === null ? null : new Set((await app.deployService.listProjects()).filter((p) => ids.has(p.id)).map((p) => p.slug));
      const response = await app.metrics.query.summary({
        visible,
        protections: () => {
          const now = Date.now();
          if (!protections || now - protections.at > PROTECTIONS_TTL_MS) protections = { at: now, value: loadProtections() };
          return protections.value as ReturnType<typeof loadProtections>;
        },
      });
      return reply.send(response);
    } catch (err) {
      if (err instanceof MetricsBusyError) return busy(reply);
      throw err;
    }
  });

  app.get<{ Querystring: { range?: MetricsRange } }>("/api/metrics/host", { schema: { querystring: rangeQuery }, config: limit }, async (request, reply) => {
    try {
      return reply.send(await app.metrics.query.host(request.query.range ?? "24h"));
    } catch (err) {
      if (err instanceof MetricsBusyError) return busy(reply);
      throw err;
    }
  });

  app.get<{ Params: { id: string }; Querystring: { range?: MetricsRange } }>(
    "/api/projects/:id/metrics",
    {
      schema: { params: { type: "object", required: ["id"], properties: { id: { type: "string", minLength: 1, maxLength: 64 } } }, querystring: rangeQuery },
      config: limit,
    },
    async (request, reply) => {
      const project = await app.deployService.getProject(request.params.id);
      if (!project) return reply.code(404).send({ error: "project_not_found", message: "Projeto não encontrado." });
      try {
        const response = await app.metrics.query.project(project.slug, request.query.range ?? "24h");
        // marcas de deploy da janela (deploys do projeto que se sobrepõem a ela) e últimos tempos de subida
        const nowSec = Math.floor(Date.now() / 1000);
        const deploys: DeployMark[] = [];
        for (const j of await app.deployService.listJobs(project.id)) {
          const t = j.startedAt === null ? Number.NaN : Math.floor(Date.parse(j.startedAt) / 1000);
          if (!Number.isFinite(t)) continue;
          const end = j.finishedAt === null ? null : Math.floor(Date.parse(j.finishedAt) / 1000);
          if (t > response.to || (end ?? nowSec) < response.from) continue;
          deploys.push({ id: j.id, t, end: end !== null && Number.isFinite(end) ? end : null, kind: j.kind === "recreate" ? "recreate" : "deploy", status: j.status });
        }
        return reply.send({ ...response, deploys, startups: app.metrics.startups.list(project.slug, 20) });
      } catch (err) {
        if (err instanceof MetricsBusyError) return busy(reply);
        throw err;
      }
    },
  );

  const settingsView = async (): Promise<MetricsSettingsResponse> => ({
    retention: app.metrics.settings.current(),
    defaults: { ...METRICS_RETENTION_DEFAULT },
    limits: METRICS_RETENTION_LIMITS,
    usage: await app.metrics.store.usage(),
    collector: app.metrics.collector.status(),
  });

  app.get("/api/metrics/settings", async (_request, reply) => reply.header("cache-control", "no-store").send(await settingsView()));

  app.put<{ Body: UpdateMetricsSettingsRequest }>("/api/metrics/settings", { schema: { body: settingsBody } }, async (request, reply) => {
    // Só a pessoa, na sessão do painel: a lista de exclusão dos tokens já barra, esta é a segunda trava.
    if (!request.session || request.session.token) {
      return reply.code(403).send({ error: "token_forbidden", message: "A retenção das métricas é alterada só pelo painel, com a sua conta." });
    }
    const checked = validateMetricsRetention(request.body.retention);
    if (!checked.ok) {
      return reply.code(400).send({
        error: checked.error,
        message:
          checked.error === "retention_order"
            ? "A retenção por dia não pode ser menor que a retenção por hora."
            : "Valor de retenção fora dos limites permitidos.",
      });
    }
    const before: MetricsRetention = app.metrics.settings.current();
    try {
      await app.metrics.settings.set(checked.value);
    } catch (err) {
      request.log.error({ err }, "falha ao gravar a retenção das métricas");
      return reply.code(500).send({ error: "storage_write_failed", message: "Não foi possível salvar a retenção no servidor. Nada foi alterado." });
    }
    // reduzir a retenção apaga o excedente já, em vez de esperar a próxima poda (de hora em hora)
    await app.metrics.store.prune(Math.floor(Date.now() / 1000)).catch((err: unknown) => request.log.warn({ err }, "poda das métricas falhou"));
    await app.auditService.record({
      actor: request.session.username,
      action: "metrics.settings_changed",
      detail: `Retenção das métricas: minuto ${before.minuteHours} h → ${checked.value.minuteHours} h; hora ${before.hourDays} d → ${checked.value.hourDays} d; dia ${before.dayDays} d → ${checked.value.dayDays} d.`,
    });
    return reply.header("cache-control", "no-store").send(await settingsView());
  });
};

export default metricsRoutes;
