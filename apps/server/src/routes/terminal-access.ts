/**
 * terminal-access.ts — habilitar e desligar o terminal web depois do setup.
 *  GET  /api/terminal/access          estado desta sessão (exigido? habilitado? quanto falta?)
 *  POST /api/terminal/access/enable   habilita: senha + 2FA (+ código por e-mail, se ligado)
 *  POST /api/terminal/access/disable  desliga agora (sem reautenticação: desligar só reduz poder)
 *
 * Só sessão humana (nenhum token de API ou de MCP alcança estas rotas: services/token-policy-table.ts)
 * e, por segurança em profundidade, as rotas também recusam a sessão sintética de token.
 *
 * Durante o assistente de instalação (setup não concluído) o terminal segue com o setup token e nada
 * aqui se aplica: `required` é false e habilitar responde 409.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { TerminalAccessStatus, TerminalEnableRequest, TerminalEnableResponse } from "@paas/core";
import { registerErrorHandler } from "../plugins/error-handler.js";
import { confirmIdentity } from "../services/confirm-identity.js";

const enableSchema = {
  body: {
    type: "object",
    required: ["currentPassword"],
    additionalProperties: false,
    properties: {
      currentPassword: { type: "string", minLength: 1, maxLength: 512 },
      code: { type: "string", minLength: 1, maxLength: 64 },
      emailCode: { type: "string", minLength: 1, maxLength: 16 },
    },
  },
} as const;

const terminalAccessRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);

  /** Setup concluído? Estado ilegível conta como concluído (falha fechada: o terminal exige habilitação). */
  const setupCompleted = async (): Promise<boolean> => {
    try {
      return (await app.setupState.load()).completed;
    } catch {
      return true;
    }
  };

  const refuseToken = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (!request.session?.token) return false;
    void reply.code(403).send({ error: "token_forbidden", message: "O terminal web só pode ser habilitado por uma pessoa, no painel." });
    return true;
  };

  async function statusFor(request: FastifyRequest): Promise<TerminalAccessStatus> {
    const session = request.session;
    const required = (await setupCompleted()) && !!session && !session.token;
    const user = session ? await app.userStore.findById(session.userId) : null;
    const base = {
      twoFactorEnabled: Boolean(user?.twoFactor),
      emailCodeEnabled: Boolean(user?.emailCodeEnabledAt),
    };
    if (!required || !session) {
      return {
        required: false,
        enabled: true,
        expiresAt: null,
        idleExpiresAt: null,
        remainingMs: 0,
        idleRemainingMs: 0,
        windowMs: app.terminalGate.windowMs,
        idleMs: app.terminalGate.idleMs,
        lastEnd: null,
        ...base,
      };
    }
    return { required: true, ...app.terminalGate.status(session.id), ...base };
  }

  app.get("/api/terminal/access", async (request, reply) => {
    if (refuseToken(request, reply)) return reply;
    return reply.send(await statusFor(request));
  });

  app.post<{ Body: TerminalEnableRequest }>("/api/terminal/access/enable", { schema: enableSchema }, async (request, reply) => {
    if (refuseToken(request, reply)) return reply;
    if (!(await setupCompleted())) {
      return reply.code(409).send({
        error: "terminal_gate_not_required",
        message: "O terminal só precisa ser habilitado depois que o assistente de instalação terminar.",
      });
    }
    const confirmed = await confirmIdentity(app, request, reply, request.body, {
      requireTwoFactor: true,
      emailCode: "if-enabled",
      action: "terminal.enable",
    });
    if (!confirmed) return reply;
    try {
      app.terminalGate.enable(request.session!.id, confirmed.user.username);
      const minutes = Math.max(1, Math.round(app.terminalGate.windowMs / 60_000));
      const alertWarning = await app.emailCode.alertAccessChange(
        confirmed.user,
        `terminal web habilitado por até ${minutes} min (com ele, quem tem a sessão age como o usuário de administração da VPS)`,
        request.ip,
      );
      confirmed.attempt.success();
      const response: TerminalEnableResponse = { ...(await statusFor(request)), ...(alertWarning ? { alertWarning } : {}) };
      return reply.send(response);
    } finally {
      confirmed.attempt.release();
    }
  });

  app.post("/api/terminal/access/disable", async (request, reply) => {
    if (refuseToken(request, reply)) return reply;
    if (request.session) app.terminalGate.disable(request.session.id, "manual");
    return reply.send(await statusFor(request));
  });
};

export default terminalAccessRoutes;
