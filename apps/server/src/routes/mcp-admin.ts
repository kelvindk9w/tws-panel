/**
 * mcp-admin.ts — Configurações → Acesso por IA: o liga/desliga do MCP e as aprovações das ações sensíveis.
 *  GET  /api/settings/mcp                      (só a pessoa) estado do MCP
 *  PUT  /api/settings/mcp                      (só a pessoa) liga (senha + 2FA) ou desliga
 *  GET  /api/mcp/approvals                     (só a pessoa) pedidos das IAs
 *  POST /api/mcp/approvals/:id/approve         (só a pessoa) aprova (senha + 2FA)
 *  POST /api/mcp/approvals/:id/reject          (só a pessoa) recusa
 *
 * Só sessão humana: a lista de exclusão dos tokens já barra no plugin de autenticação, e a conferência abaixo
 * é a segunda trava. A IA nunca aprova o que ela mesma pediu.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  MCP_PATH,
  type DecideMcpApprovalRequest,
  type McpApprovalInfo,
  type McpApprovalListResponse,
  type McpSettingsResponse,
  type UpdateMcpSettingsRequest,
} from "@paas/core";
import { registerErrorHandler } from "../plugins/error-handler.js";
import { confirmIdentity } from "../services/confirm-identity.js";

const credentials = {
  currentPassword: { type: "string", minLength: 1, maxLength: 512 },
  code: { type: "string", minLength: 1, maxLength: 64 },
} as const;

const settingsSchema = {
  body: { type: "object", required: ["enabled"], additionalProperties: false, properties: { enabled: { type: "boolean" }, ...credentials } },
} as const;

const decideSchema = {
  params: { type: "object", required: ["id"], properties: { id: { type: "string", pattern: "^[0-9a-f]{32}$" } } },
  body: { type: ["object", "null"], additionalProperties: false, properties: { ...credentials } },
} as const;

const mcpAdminRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);

  function humanOnly(request: FastifyRequest, reply: FastifyReply): boolean {
    if (request.session && !request.session.token) return true;
    void reply.code(403).send({
      error: "token_forbidden",
      message: "O acesso por IA é administrado só pelo painel, com a sua conta (não por um token).",
    });
    return false;
  }

  const view = (): McpSettingsResponse => ({ enabled: app.mcpSettings.enabled(), path: MCP_PATH });

  app.get("/api/settings/mcp", async (request, reply) => {
    if (!humanOnly(request, reply)) return reply;
    return reply.header("cache-control", "no-store").send(view());
  });

  app.put<{ Body: UpdateMcpSettingsRequest }>("/api/settings/mcp", { schema: settingsSchema }, async (request, reply) => {
    if (!humanOnly(request, reply)) return reply;
    const { enabled } = request.body;
    let actor = request.session!.username;
    let attempt: { success(): void; release(): void } | null = null;
    // Ligar abre uma porta nova na internet: pede a senha (e o código, com 2FA). Desligar é sempre livre.
    if (enabled && !app.mcpSettings.enabled()) {
      const confirmed = await confirmIdentity(app, request, reply, request.body);
      if (!confirmed) return reply;
      attempt = confirmed.attempt;
      actor = confirmed.user.username;
    }
    try {
      if (enabled !== app.mcpSettings.enabled()) {
        try {
          await app.mcpSettings.set(enabled);
        } catch (err) {
          request.log.error({ err }, "falha ao gravar a configuração do MCP");
          return reply.code(500).send({ error: "storage_write_failed", message: "Não foi possível salvar a alteração no servidor. Nada foi alterado." });
        }
        // Desligar encerra tudo: pedidos de aprovação (inclusive os já aprovados) e sessões abertas não sobrevivem a um religar.
        if (!enabled) {
          app.mcpApprovals.clear();
          app.mcp.clearSessions();
        }
        attempt?.success();
        await app.auditService.record({
          actor,
          action: enabled ? "mcp.enabled" : "mcp.disabled",
          detail: enabled ? "Acesso por IA (MCP) ligado." : "Acesso por IA (MCP) desligado.",
        });
      }
      return reply.header("cache-control", "no-store").send(view());
    } finally {
      attempt?.release();
    }
  });

  app.get("/api/mcp/approvals", async (request, reply) => {
    if (!humanOnly(request, reply)) return reply;
    const response: McpApprovalListResponse = { approvals: app.mcpApprovals.list() };
    return reply.header("cache-control", "no-store").send(response);
  });

  /** Mesma resposta para pedido inexistente e para pedido que já não está pendente. */
  const gone = (reply: FastifyReply, reason: "not_found" | "not_pending") =>
    reply.code(reason === "not_found" ? 404 : 409).send(
      reason === "not_found"
        ? { error: "approval_not_found", message: "Pedido não encontrado (o painel esquece os pedidos ao reiniciar)." }
        : { error: "approval_not_pending", message: "Este pedido já foi decidido ou venceu." },
    );

  app.post<{ Params: { id: string }; Body: DecideMcpApprovalRequest | null }>(
    "/api/mcp/approvals/:id/approve",
    { schema: decideSchema },
    async (request, reply) => {
      if (!humanOnly(request, reply)) return reply;
      const pending = app.mcpApprovals.list().find((a) => a.id === request.params.id);
      if (!pending) return gone(reply, "not_found");
      if (pending.status !== "pending") return gone(reply, "not_pending");
      // Aprovar dá poder a uma ação sensível: senha e, com 2FA, o código.
      const confirmed = await confirmIdentity(app, request, reply, request.body ?? {});
      if (!confirmed) return reply;
      try {
        const decided = app.mcpApprovals.decide(request.params.id, "approved");
        if (!decided.ok) return gone(reply, decided.reason);
        confirmed.attempt.success();
        await audit(confirmed.user.username, "mcp.approval_approved", decided.info);
        return reply.header("cache-control", "no-store").send({ approval: decided.info });
      } finally {
        confirmed.attempt.release();
      }
    },
  );

  app.post<{ Params: { id: string } }>("/api/mcp/approvals/:id/reject", { schema: { params: decideSchema.params } }, async (request, reply) => {
    if (!humanOnly(request, reply)) return reply;
    const decided = app.mcpApprovals.decide(request.params.id, "rejected");
    if (!decided.ok) return gone(reply, decided.reason);
    await audit(request.session!.username, "mcp.approval_rejected", decided.info);
    return reply.header("cache-control", "no-store").send({ approval: decided.info });
  });

  function audit(actor: string, action: string, info: McpApprovalInfo) {
    return app.auditService.record({
      actor,
      action,
      target: info.tool,
      detail: `Pedido da IA (token "${info.tokenName}", cliente "${info.client}", ferramenta ${info.tool}) ${action === "mcp.approval_approved" ? "aprovado" : "recusado"}.`,
    });
  }
};

export default mcpAdminRoutes;
