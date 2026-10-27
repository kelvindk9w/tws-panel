/**
 * setup-restart.ts — "Recomeçar do zero" pelo painel (Setup concluído).
 *  POST /api/settings/restart-setup  (sessão + senha atual + "recomeçar" + código do 2FA)
 *
 * Mesmo efeito de `scripts/reset-setup.sh --full`: apaga a conta, as sessões e
 * o progresso do assistente. Projetos, domínios, e-mail e histórico de
 * segurança ficam. Gera um token de setup NOVO (o antigo deixa de valer) e
 * devolve o link para continuar direto no assistente.
 *
 * Confirmação forte, pedida pelo dono do produto: senha atual, digitar
 * "recomeçar" e o código da verificação em duas etapas. Sem 2FA ativo o painel
 * não tem um segundo fator para confirmar que é você (envio de e-mail ainda
 * não existe): recusa e aponta o script na VPS.
 *
 * Registrado com fastify-plugin: o token novo precisa trocar o valor GLOBAL
 * (app.setupToken), que o plugin de auth e as rotas de setup leem.
 */
import { randomBytes } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { sessionCookieName } from "@paas/core";
import { verifyPasswordTimingSafe } from "../services/password.js";
import { beginAction, sendTooManyAttempts } from "../services/action-guard.js";
import { checkEmailFactor } from "../services/confirm-identity.js";

export const RESTART_CONFIRMATION = "recomeçar";

interface RestartBody {
  currentPassword: string;
  confirm: string;
  code?: string;
  emailCode?: string;
}

const restartSchema = {
  body: {
    type: "object",
    required: ["currentPassword", "confirm"],
    additionalProperties: false,
    properties: {
      currentPassword: { type: "string", minLength: 1, maxLength: 512 },
      confirm: { type: "string", maxLength: 40 },
      code: { type: "string", minLength: 1, maxLength: 64 },
      emailCode: { type: "string", minLength: 1, maxLength: 16 },
    },
  },
} as const;

const setupRestartRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: RestartBody }>("/api/settings/restart-setup", { schema: restartSchema }, async (request, reply) => {
    const session = request.session!;
    const user = await app.userStore.findById(session.userId);
    if (!user) return reply.code(401).send({ error: "unauthorized", message: "Sessão inválida ou expirada." });

    if (request.body.confirm.trim().toLowerCase() !== RESTART_CONFIRMATION) {
      return reply.code(400).send({ error: "confirmation_mismatch", message: `Digite "${RESTART_CONFIRMATION}" para confirmar.` });
    }
    // Limite por IP e por sessão (senha atual e código): sessão aberta + senha vazada não
    // bastam para adivinhar o código. O mesmo bloqueio progressivo do login.
    const attempt = beginAction(app.actionLimiter, { ip: request.ip, sessionId: request.session!.id }, reply);
    if (!attempt) return reply;
    try {
      if (!(await verifyPasswordTimingSafe(user.passwordHash, request.body.currentPassword))) {
        const failure = attempt.fail();
        if (!failure.allowed) return sendTooManyAttempts(reply, failure.retryAfterSec);
        return reply.code(401).send({ error: "invalid_current_password", message: "A senha atual está incorreta." });
      }
      if (!user.twoFactor) {
        return reply.code(409).send({
          error: "two_factor_required",
          message:
            "Para recomeçar pelo painel, ative antes a verificação em duas etapas (Configurações → Segurança): é ela " +
            "que confirma que é você (o código por e-mail é só um fator extra, não a substitui). Sem ela, o caminho é " +
            "pela VPS: sudo ./scripts/reset-setup.sh --full",
        });
      }
      const blocked = await checkEmailFactor(app, request, reply, user, attempt, request.body.emailCode);
      if (blocked) return reply;
      const outcome = request.body.code ? await app.twoFactor.verifyDetailed(user, request.body.code) : null;
      if (!outcome || outcome.status !== "ok") {
        const failure = attempt.fail();
        if (outcome?.status === "invalid" && outcome.lockedNow) {
          await app.loginWatch.accountLocked(request.ip, { id: user.id, username: user.username }, outcome.lockedNow);
        }
        if (!failure.allowed) return sendTooManyAttempts(reply, failure.retryAfterSec);
        const retryAfterSec =
          outcome?.status === "locked" ? outcome.retryAfterSec : outcome?.status === "invalid" ? outcome.lockedNow?.retryAfterSec : undefined;
        if (retryAfterSec !== undefined) {
          reply.header("retry-after", String(retryAfterSec));
          return reply.code(429).send({
            error: "two_factor_locked",
            message:
              "Verificação em duas etapas temporariamente bloqueada por excesso de códigos errados. " +
              "Tente mais tarde ou use um código de recuperação.",
            retryAfterSec,
          });
        }
        return reply.code(400).send({
          error: "invalid_two_factor_code",
          message: "Código incorreto ou já usado. Digite o código que aparece agora no app.",
        });
      }
      attempt.success();
    } finally {
      attempt.release();
    }

    // Auditoria ANTES de apagar: ela fica num arquivo próprio, que continua.
    await app.auditService.record({
      actor: user.username,
      action: "setup.restarted",
      detail:
        "Assistente de configuração recomeçado pelo painel (senha + verificação em duas etapas): conta, sessões e " +
        "progresso apagados; token de setup novo gerado. Projetos mantidos.",
    });

    const token = randomBytes(24).toString("base64url");
    await writeFile(app.config.setupTokenFile, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(app.config.setupTokenFile, 0o600).catch(() => undefined);
    app.setupToken = token;

    await app.sessionStore.destroyAll();
    await app.apiTokens.revokeAll(); // a conta some: os tokens dela também
    await app.userStore.removeAll();
    await app.setupState.reset();

    const secure = request.protocol === "https";
    reply.clearCookie(sessionCookieName(secure), { path: "/", secure });
    return reply.send({ setupUrl: `/setup?token=${encodeURIComponent(token)}` });
  });
};

export default fp(setupRestartRoutes, { name: "setup-restart" });
