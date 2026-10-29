/**
 * confirm-identity.ts — "é a pessoa mesmo?": senha atual e, com 2FA, o código. Usado por tudo que
 * AUMENTA poder a partir de uma sessão aberta (criar/ampliar token de API, liberar a conta GitHub
 * para um projeto). Mesmo limite por IP e por sessão das outras rotas que pedem isso.
 */
import type { EmailCodeAction } from "@paas/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { beginAction, sendTooManyAttempts } from "./action-guard.js";
import { verifyPasswordTimingSafe } from "./password.js";
import { EmailCodeService } from "./email-code.js";
import type { ActionAttempt } from "./action-guard.js";
import type { StoredUser } from "./user-store.js";

export interface ConfirmIdentityOptions {
  /** Ações de acesso à VPS só valem com a verificação em duas etapas ligada (409 two_factor_required sem ela). */
  requireTwoFactor?: boolean;
  /**
   * "if-enabled": quando o usuário ligou o código por e-mail, a ação o exige também
   * (Configurações → Segurança). "always": exige sempre (é o que liga o fator). "never" (padrão): não olha o código por e-mail.
   */
  emailCode?: "if-enabled" | "always" | "never";
  /** Para qual ação o código por e-mail vale (ele fica preso à ação pedida). */
  action?: EmailCodeAction;
}

/**
 * Código por e-mail (fator extra opcional), quando o usuário o ligou. Conferido SEM consumir: quem chama
 * ainda confere o código do app e só consome (app.emailCode.consume) depois de tudo certo. Devolve false se
 * passou (ou se o fator está desligado) e, se não passou, já respondeu o erro e devolve true (quem chama só
 * retorna). Nunca devolve o `reply`: ele é "thenable" e um `await` o trataria como sucesso.
 */
export async function checkEmailFactor(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  user: StoredUser,
  attempt: ActionAttempt,
  emailCode: string | undefined,
  action: EmailCodeAction,
  force = false,
): Promise<boolean> {
  if (!force && !app.emailCode.isEnabled(user)) return false;
  const check = await app.emailCode.check(user, request.session!.id, emailCode, action);
  const failure = EmailCodeService.failureMessage(check);
  if (!failure) return false;
  // sem código pedido ainda não é tentativa errada; erro de verdade conta no limite
  const counts = check.status === "invalid" || check.status === "exhausted";
  if (counts) {
    const limited = attempt.fail();
    if (!limited.allowed) {
      sendTooManyAttempts(reply, limited.retryAfterSec);
      return true;
    }
    await app.auditService.record({
      actor: user.username,
      action: "auth.email_code_failed",
      detail: `Código por e-mail incorreto, de ${request.ip}.`,
    });
  } else {
    attempt.release();
  }
  void reply.code(400).send({ ...failure, ...(check.status === "invalid" ? { attemptsLeft: check.attemptsLeft } : {}) });
  return true;
}

/**
 * Confirma que é a pessoa: senha atual e, com 2FA, o código (mesmo limite por IP e por sessão
 * das outras rotas que pedem isso). Devolve a conta e a tentativa, ou null depois de já ter
 * respondido o erro. Quem chama marca `attempt.success()` e SEMPRE `attempt.release()`.
 */
export async function confirmIdentity(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  credentials: { currentPassword?: string | undefined; code?: string | undefined; emailCode?: string | undefined },
  options: ConfirmIdentityOptions = {},
) {
  if ((options.emailCode === "if-enabled" || options.emailCode === "always") && !options.action) {
    throw new Error("confirmIdentity: com código por e-mail a ação é obrigatória");
  }
  const session = request.session;
  if (!session) {
    // sem sessão (ex.: pedido só com o setup token) não há de quem confirmar a identidade: 401, nunca 500
    void reply.code(401).send({ error: "unauthorized", message: "Entre no painel para confirmar esta ação." });
    return null;
  }
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
  if (options.requireTwoFactor && !user.twoFactor) {
    return refuse(() =>
      reply.code(409).send({
        error: "two_factor_required",
        message:
          "Esta ação mexe no acesso à VPS e exige a verificação em duas etapas. Ative-a em Configurações → Segurança e tente de novo.",
      }),
    );
  }
  const useEmail = options.emailCode === "if-enabled" || options.emailCode === "always";
  if (useEmail) {
    const blocked = await checkEmailFactor(app, request, reply, user, attempt, credentials.emailCode, options.action!, options.emailCode === "always");
    if (blocked) {
      attempt.release();
      return null;
    }
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
  if (useEmail) app.emailCode.consume(user, session.id);
  return { user, attempt };
}
