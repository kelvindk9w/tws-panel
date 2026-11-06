/**
 * docker-cleanup.ts (rotas) — Configurações → Limpeza do Docker.
 *
 *  GET  /api/docker-cleanup            configuração, última verificação, histórico e se há aviso
 *  POST /api/docker-cleanup/scan       "Verificar agora" (só leitura)
 *  POST /api/docker-cleanup/run        "Limpar agora" (exige confirm: true; auditado)
 *  PUT  /api/docker-cleanup/settings   liga/desliga a limpeza automática e ajusta os limites (auditado)
 *
 * Só a leitura é aberta a token; verificar, limpar e configurar são da pessoa, na sessão do painel.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  DOCKER_CLEANUP_FREQUENCIES,
  DOCKER_CLEANUP_LIMITS,
  validateDockerCleanupSettings,
  type DockerCleanupBlock,
  type RunDockerCleanupRequest,
  type UpdateDockerCleanupSettingsRequest,
} from "@paas/core";
import { registerErrorHandler } from "../plugins/error-handler.js";
import { DockerCleanupBlockedError, type DockerCleanupService } from "../services/docker-cleanup-service.js";

declare module "fastify" {
  interface FastifyInstance {
    dockerCleanup: DockerCleanupService;
  }
}

const BLOCK_MESSAGE: Record<DockerCleanupBlock, string> = {
  deploy: "Há um deploy em andamento. Espere terminar para limpar.",
  backup: "Há um backup ou uma restauração em andamento. Espere terminar para limpar.",
  cleaning: "Já existe uma verificação ou limpeza em andamento.",
  docker_unavailable: "O Docker não respondeu.",
};

const L = DOCKER_CLEANUP_LIMITS;
const int = (min: number, max: number) => ({ type: "integer", minimum: min, maximum: max }) as const;

const settingsBody = {
  type: "object",
  required: ["settings"],
  additionalProperties: false,
  properties: {
    settings: {
      type: "object",
      required: ["enabled", "frequency", "minAgeDays", "diskTriggerPercent", "warnGainGb", "warnDiskPercent"],
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        frequency: { type: "string", enum: [...DOCKER_CLEANUP_FREQUENCIES] },
        minAgeDays: int(L.minAgeDays.min, L.minAgeDays.max),
        diskTriggerPercent: { anyOf: [int(L.diskTriggerPercent.min, L.diskTriggerPercent.max), { type: "null" }] },
        warnGainGb: int(L.warnGainGb.min, L.warnGainGb.max),
        warnDiskPercent: int(L.warnDiskPercent.min, L.warnDiskPercent.max),
      },
    },
  },
} as const;

const runBody = {
  type: "object",
  required: ["confirm"],
  additionalProperties: false,
  properties: { confirm: { const: true } },
} as const;

const dockerCleanupRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);
  const limit = { rateLimit: { max: 30, timeWindow: "1 minute" } };
  const noStore = (reply: FastifyReply) => reply.header("cache-control", "no-store");

  /** Só a pessoa, na sessão do painel (a tabela de tokens já nega; esta é a segunda trava). */
  const personOnly = (request: FastifyRequest, reply: FastifyReply): string | null => {
    if (!request.session || request.session.token) {
      void reply.code(403).send({ error: "token_forbidden", message: "A limpeza do Docker é feita só pelo painel, com a sua conta." });
      return null;
    }
    return request.session.username;
  };

  const blocked = (reply: FastifyReply, reason: DockerCleanupBlock) => reply.code(409).send({ error: `cleanup_${reason}`, message: BLOCK_MESSAGE[reason] });
  const unavailable = (reply: FastifyReply) => reply.code(503).send({ error: "docker_unavailable", message: BLOCK_MESSAGE.docker_unavailable });

  app.get("/api/docker-cleanup", { config: limit }, async (_request, reply) => noStore(reply).send(app.dockerCleanup.state()));

  app.post("/api/docker-cleanup/scan", { config: limit }, async (request, reply) => {
    if (personOnly(request, reply) === null) return reply;
    try {
      const scan = await app.dockerCleanup.scan();
      if (!scan) return unavailable(reply);
      return noStore(reply).send(app.dockerCleanup.state());
    } catch (err) {
      if (err instanceof DockerCleanupBlockedError) return blocked(reply, err.reason);
      throw err;
    }
  });

  app.post<{ Body: RunDockerCleanupRequest }>("/api/docker-cleanup/run", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } }, schema: { body: runBody } }, async (request, reply) => {
    const actor = personOnly(request, reply);
    if (actor === null) return reply;
    try {
      const record = await app.dockerCleanup.run("manual", actor);
      if (!record) return unavailable(reply);
      const gb = Math.round((record.freedBytes / 1024 ** 3) * 10) / 10;
      await app.auditService.record({
        actor,
        action: "docker_cleanup.run",
        detail: `Limpeza do Docker (manual): ${gb} GB liberados, ${record.removedImages.length} imagem(ns) removida(s)${record.errors.length > 0 ? `, ${record.errors.length} falha(s)` : ""}.`,
      });
      return noStore(reply).send({ record, state: app.dockerCleanup.state() });
    } catch (err) {
      if (err instanceof DockerCleanupBlockedError) return blocked(reply, err.reason);
      throw err;
    }
  });

  app.put<{ Body: UpdateDockerCleanupSettingsRequest }>("/api/docker-cleanup/settings", { config: limit, schema: { body: settingsBody } }, async (request, reply) => {
    const actor = personOnly(request, reply);
    if (actor === null) return reply;
    const checked = validateDockerCleanupSettings(request.body.settings);
    if (!checked.ok) return reply.code(400).send({ error: "invalid_settings", message: "Valores fora dos limites permitidos." });
    const before = app.dockerCleanup.settings();
    let state;
    try {
      state = await app.dockerCleanup.updateSettings(checked.value);
    } catch (err) {
      request.log.error({ err }, "falha ao gravar a configuração da limpeza do Docker");
      return reply.code(500).send({ error: "storage_write_failed", message: "Não foi possível salvar no servidor. Nada foi alterado." });
    }
    const v = checked.value;
    await app.auditService.record({
      actor,
      action: "docker_cleanup.settings_changed",
      detail: `Limpeza automática do Docker: ${before.enabled ? "ligada" : "desligada"} → ${v.enabled ? "ligada" : "desligada"}; frequência ${v.frequency}; idade mínima ${v.minAgeDays} dia(s); disco ${v.diskTriggerPercent === null ? "sem gatilho" : `${v.diskTriggerPercent}%`}.`,
    });
    return noStore(reply).send(state);
  });
};

export default dockerCleanupRoutes;
