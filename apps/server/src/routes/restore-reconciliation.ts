/**
 * restore-reconciliation.ts — "O painel antigo tinha X ativo. Ativar agora?"
 * (Dashboard e tela dos backups; todas com sessão).
 *  GET  /api/restore-reconciliation              pendências, conferidas no Docker na hora
 *  POST /api/restore-reconciliation/:id/dismiss  "Dispensar"
 *
 * Só informa: ativar o webmail, o e-mail ou o domínio continua nas telas de
 * sempre (E-mail, Configurações → Domínio do painel). Regras:
 * services/restore-reconciliation.ts.
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { RECONCILIATION_IDS } from "@paas/core";
import { registerErrorHandler } from "../plugins/error-handler.js";
import type { HttpError } from "../services/http-error.js";
import type { RestoreReconciliation } from "../services/restore-reconciliation.js";

declare module "fastify" {
  interface FastifyInstance {
    restoreReconciliation: RestoreReconciliation;
  }
}

const dismissSchema = {
  params: {
    type: "object",
    required: ["id"],
    additionalProperties: false,
    properties: { id: { type: "string", enum: [...RECONCILIATION_IDS] } },
  },
} as const;

function sendError(reply: FastifyReply, err: unknown, log: (e: unknown) => void): FastifyReply {
  const e = err as Partial<HttpError>;
  if (!e.statusCode) log(err);
  return reply.code(e.statusCode ?? 500).send({
    error: e.code ?? "internal_error",
    message: e.statusCode ? e.message : "Não foi possível concluir agora. Tente de novo em instantes.",
  });
}

const restoreReconciliationRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);
  const service = app.restoreReconciliation;

  // Com o setup pendente o plugin de auth deixa passar só com o setup token, sem sessão: aqui isso vira 401.
  app.addHook("onRequest", async (request, reply) => {
    if (!request.session) {
      return reply.code(401).send({ error: "unauthorized", message: "Entre com a conta de administrador para ver estes avisos." });
    }
  });

  app.get("/api/restore-reconciliation", async (_request, reply) => {
    try {
      reply.header("cache-control", "no-store");
      return reply.send(await service.list());
    } catch (err) {
      return sendError(reply, err, (e) => app.log.error({ err: e }, "reconciliação: falha inesperada"));
    }
  });

  app.post<{ Params: { id: string } }>("/api/restore-reconciliation/:id/dismiss", { schema: dismissSchema }, async (request, reply) => {
    try {
      const result = await service.dismiss(request.params.id);
      await app.auditService.record({
        actor: request.session!.username,
        action: "restore.reconciliation_dismissed",
        target: request.params.id,
        detail: `Aviso da restauração dispensado: o painel antigo tinha "${request.params.id}" ativo e a pessoa escolheu não ativar agora.`,
      });
      reply.header("cache-control", "no-store");
      return reply.send(result);
    } catch (err) {
      return sendError(reply, err, (e) => app.log.error({ err: e }, "reconciliação: falha inesperada"));
    }
  });
};

export default restoreReconciliationRoutes;
