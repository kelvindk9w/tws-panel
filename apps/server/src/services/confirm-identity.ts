/**
 * confirm-identity.ts — "é a pessoa mesmo?": senha atual e, com 2FA, o código. Usado por tudo que
 * AUMENTA poder a partir de uma sessão aberta (criar/ampliar token de API, liberar a conta GitHub
 * para um projeto). Mesmo limite por IP e por sessão das outras rotas que pedem isso.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { beginAction, sendTooManyAttempts } from "./action-guard.js";
import { verifyPasswordTimingSafe } from "./password.js";

/**
 * Confirma que é a pessoa: senha atual e, com 2FA, o código (mesmo limite por IP e por sessão
 * das outras rotas que pedem isso). Devolve a conta e a tentativa, ou null depois de já ter
 * respondido o erro. Quem chama marca `attempt.success()` e SEMPRE `attempt.release()`.
 */
export async function confirmIdentity(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  credentials: { currentPassword?: string | undefined; code?: string | undefined },
) {
  const session = request.session!;
  const user = await app.userStore.findById(session.userId);
  if (!user) {
    await app.sessionStore.destroy(session.id);
    void reply.code(401).send({ error: "unauthorized", message: "Sessão inválida ou expirada." });
    return null;
  }
  const attempt = beginAction(app.actionLimiter, { ip: request.ip, sessionId: session.id }, reply);
  if (!attempt) return null;
  const refuse = (send: () => unknown) => {
    send();
    attempt.release();
    return null;
  };
  if (!credentials.currentPassword || !(await verifyPasswordTimingSafe(user.passwordHash, credentials.currentPassword))) {
    const failure = attempt.fail();
    if (!failure.allowed) return refuse(() => sendTooManyAttempts(reply, failure.retryAfterSec));
    return refuse(() => reply.code(401).send({ error: "invalid_current_password", message: "A senha atual está incorreta." }));
  }
  if (user.twoFactor) {
    // Sessão roubada + senha vazada não bastam para criar uma chave de longa duração.
    const outcome = credentials.code ? await app.twoFactor.verifyDetailed(user, credentials.code) : null;
    if (!outcome || outcome.status !== "ok") {
      const failure = attempt.fail();
      if (outcome?.status === "invalid" && outcome.lockedNow) {
        await app.loginWatch.accountLocked(request.ip, { id: user.id, username: user.username }, outcome.lockedNow);
      }
      if (!failure.allowed) return refuse(() => sendTooManyAttempts(reply, failure.retryAfterSec));
      const retryAfterSec =
        outcome?.status === "locked" ? outcome.retryAfterSec : outcome?.status === "invalid" ? outcome.lockedNow?.retryAfterSec : undefined;
      if (retryAfterSec !== undefined) {
        reply.header("retry-after", String(retryAfterSec));
        return refuse(() =>
          reply.code(429).send({
            error: "two_factor_locked",
            message:
              "Verificação em duas etapas temporariamente bloqueada por excesso de códigos errados. " +
              "Tente mais tarde ou use um código de recuperação.",
            retryAfterSec,
          }),
        );
      }
      return refuse(() =>
        reply.code(400).send({
          error: "invalid_two_factor_code",
          message: "Código incorreto ou já usado. Digite o código que aparece agora no app.",
        }),
      );
    }
  }
  return { user, attempt };
}
