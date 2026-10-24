/**
 * auth.ts — rotas de autenticação do painel:
 *  POST /api/auth/login            (público; limite por IP e, no código de 6 dígitos, por conta)
 *  POST /api/auth/logout           (sessão)
 *  GET  /api/auth/me               (sessão)
 *  POST /api/auth/change-password  (sessão; invalida as demais sessões)
 *  GET  /api/auth/2fa              (sessão; verificação em duas etapas: status)
 *  POST /api/auth/2fa/setup        (sessão; segredo + QR, nada muda ainda)
 *  POST /api/auth/2fa/enable       (sessão + senha atual + código do app)
 *  POST /api/auth/2fa/disable      (sessão + senha atual + código)
 *
 * A senha NUNCA aparece em logs nem em respostas. Todas as respostas levam
 * Cache-Control: no-store (além dos headers do helmet).
 *
 * Falha de gravação (users.json/sessions.json) nunca vira sucesso: os stores
 * desfazem a alteração em memória e rejeitam com `storage_write_failed`, e a
 * rota responde 500 dizendo o que NÃO foi feito — sem detalhe do disco.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  sessionCookieName,
  SESSION_TTL_MS,
  passwordStrengthErrors,
  DEFAULT_USER_PREFERENCES,
  type AuthMeResponse,
  type ChangePasswordRequest,
  type LoginRequest,
  type LoginResponse,
  type TwoFactorConfirmRequest,
  type TwoFactorEnableResponse,
  type TwoFactorSetupResponse,
  type TwoFactorStatusResponse,
} from "@paas/core";
import { hashPassword, verifyPasswordTimingSafe } from "../services/password.js";
import { attemptsText, durationText } from "../services/login-messages.js";
import { LoginLimiter } from "../services/login-limiter.js";
import { registerErrorHandler } from "../plugins/error-handler.js";
import { publicUser } from "../services/public-user.js";
import { TwoFactorError } from "../services/two-factor.js";
import { beginAction, sendTooManyAttempts } from "../services/action-guard.js";

// Schemas de validação. `additionalProperties: false` recusa campo
// desconhecido no corpo. `maxLength` em toda string é defesa contra payload
// gigante — nunca menor que 200 na senha, para não recusar senha legítima.
const loginSchema = {
  body: {
    type: "object",
    required: ["username", "password"],
    additionalProperties: false,
    properties: {
      username: { type: "string", minLength: 1, maxLength: 100 },
      password: { type: "string", minLength: 1, maxLength: 512 },
      code: { type: "string", minLength: 1, maxLength: 64 },
    },
  },
} as const;

const twoFactorConfirmSchema = {
  body: {
    type: "object",
    required: ["currentPassword", "code"],
    additionalProperties: false,
    properties: {
      currentPassword: { type: "string", minLength: 1, maxLength: 512 },
      code: { type: "string", minLength: 1, maxLength: 64 },
    },
  },
} as const;

const changePasswordSchema = {
  body: {
    type: "object",
    required: ["currentPassword", "newPassword"],
    additionalProperties: false,
    properties: {
      currentPassword: { type: "string", minLength: 1, maxLength: 512 },
      newPassword: { type: "string", minLength: 1, maxLength: 512 },
    },
  },
} as const;

/** Erro de gravação dos stores (ver persist() em user-store/session-store). */
function isStorageWriteFailure(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "storage_write_failed";
}

/** A conta é citada junto do aviso do IP quando restam este tanto de erros ou menos. */
const ACCOUNT_NEAR = 2;

const authRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);
  const limiter = new LoginLimiter();
  const lockedMessage =
    "Verificação em duas etapas temporariamente bloqueada por excesso de códigos errados. " +
    "Tente mais tarde ou use um código de recuperação.";

  const lockedBothMessage =
    "Verificação em duas etapas e login deste endereço temporariamente bloqueados por excesso de tentativas. " +
    "Aguarde ou tente de outro lugar.";

  /**
   * `ipAlso`: o IP também está bloqueado (os dois bloqueios chegaram juntos). Aí o
   * código de recuperação NÃO é saída por este IP, então a mensagem não a promete.
   */
  function twoFactorLocked(reply: FastifyReply, retryAfterSec: number, ipAlso = false): FastifyReply {
    reply.header("retry-after", String(retryAfterSec));
    return reply.code(429).send({
      error: "two_factor_locked",
      message: ipAlso ? lockedBothMessage : lockedMessage,
      retryAfterSec,
      ...(ipAlso ? { limit: "ip" } : {}),
    });
  }

  /**
   * 401 do código errado, com o aviso do bloqueio. Só é chamado depois de a senha
   * estar certa. Mostra o MENOR entre o que resta na conta e no IP (empate: o de
   * bloqueio mais longo) e a duração do PRÓXIMO bloqueio. Quem já provou a senha
   * pode deduzir pela duração qual limite é (IP: 60·2^k s; conta: 300·2^k s) e o
   * nível; por isso o corpo diz `limit` com franqueza. Quando o menor é o do IP,
   * o texto é neutro: o bloqueio do IP trava o login inteiro, não só o código do app.
   */
  function invalidTwoFactorCode(
    reply: FastifyReply,
    byIp: { attemptsLeft: number; nextLockSec: number },
    account: { attemptsLeft: number; nextLockSec: number } | undefined,
  ): FastifyReply {
    const useAccount =
      account !== undefined &&
      (account.attemptsLeft < byIp.attemptsLeft ||
        (account.attemptsLeft === byIp.attemptsLeft && account.nextLockSec > byIp.nextLockSec));
    const worst = useAccount ? account : byIp;
    const limit = useAccount ? "account" : "ip";
    const tail = useAccount
      ? `antes de bloquear o código do app por ${durationText(worst.nextLockSec)}`
      : `antes de um bloqueio temporário de ${durationText(worst.nextLockSec)}`;
    // IP menor, mas a conta já está perto do próprio bloqueio (5 min): avisa também,
    // para que o fim do bloqueio do IP não pareça "recomeçar do zero".
    const near = !useAccount && account !== undefined && account.attemptsLeft <= ACCOUNT_NEAR;
    const nearText = near
      ? ` O código do app também está perto de bloquear: ${attemptsText(account.attemptsLeft).toLowerCase()} antes de bloquear por ${durationText(account.nextLockSec)} (o erro que dispara o bloqueio do IP também conta).`
      : "";
    return reply.code(401).send({
      error: "invalid_two_factor_code",
      message: `Código incorreto. ${attemptsText(worst.attemptsLeft)} ${tail}.${nearText}`,
      attemptsLeft: worst.attemptsLeft,
      nextLockSec: worst.nextLockSec,
      limit,
      ...(near ? { accountLeft: account.attemptsLeft, accountLockSec: account.nextLockSec } : {}),
    });
  }

  // respostas de auth nunca devem ser cacheadas
  app.addHook("onSend", async (_request, reply) => {
    reply.header("cache-control", "no-store");
  });

  app.post<{ Body: LoginRequest }>(
    "/api/auth/login",
    { schema: loginSchema },
    async (request, reply) => {
    const ip = request.ip;
    const gate = limiter.check(ip);
    if (!gate.allowed) {
      reply.header("retry-after", String(gate.retryAfterSec));
      return reply.code(429).send({
        error: "too_many_attempts",
        message: `Muitas tentativas. Aguarde ${gate.retryAfterSec}s e tente novamente.`,
        retryAfterSec: gate.retryAfterSec,
      });
    }

    // A tentativa já está reservada (check). Toda saída abaixo a converte em
    // falha, sucesso ou a devolve (release) — nunca fica reservada para sempre.
    let settled = false;
    const settle = <T>(fn: () => T): T => {
      settled = true;
      return fn();
    };
    try {
      const { username, password } = request.body ?? {};
      if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
        return reply.code(400).send({
          error: "invalid_payload",
          message: "Informe usuário e senha.",
        });
      }

      const user = await app.userStore.findByUsername(username);
      // verificação em tempo constante: usuário inexistente custa o mesmo que existente
      const ok = await verifyPasswordTimingSafe(user?.passwordHash ?? null, password);
      if (!user || !ok) {
        const failure = settle(() => limiter.onFailure(ip));
        await app.auditService.record({
          actor: "anon",
          action: "auth.login_failed",
          target: username,
          detail: `Login falho de ${ip}.`,
        });
        if (!failure.allowed) {
          return sendTooManyAttempts(reply, failure.retryAfterSec);
        }
        // Senha errada (ou usuário inexistente) é SEMPRE 401 invalid_credentials,
        // mesmo com o código de 6 dígitos da conta bloqueado: o bloqueio só
        // aparece a quem já acertou a senha, então não revela que o usuário existe.
        return reply.code(401).send({
          error: "invalid_credentials",
          message: "Credenciais inválidas.",
        });
      }

      // Verificação em duas etapas: a senha certa não basta. O código só é
      // conferido DEPOIS da senha — quem não sabe a senha não chega até aqui.
      let twoFactorNote = "";
      const watched = { id: user.id, username: user.username };
      if (user.twoFactor) {
        const code = request.body.code;
        if (code === undefined) {
          // Primeiro passo (a tela pede o código): abre uma pendência — se o
          // login não for concluído, vira aviso.
          // Senha certa à espera do código: NÃO conta falha no IP (a reserva é
          // devolvida no finally). Quem tem a senha não ganha nada repetindo este
          // passo, e contá-lo gastava as tentativas do dono antes do primeiro erro.
          app.loginWatch.passwordAccepted(ip, watched);
          return reply.code(401).send({
            error: "two_factor_required",
            message: "Digite o código de 6 dígitos do seu app autenticador.",
          });
        }
        const outcome = await app.twoFactor.verifyDetailed(user, code);
        if (outcome.status !== "ok") {
          const failure = settle(() => limiter.onFailure(ip));
          // A contagem do IP é lida AGORA, antes de qualquer await: pedidos paralelos
          // do mesmo IP podem zerar a lista de falhas (bloqueio) enquanto este grava a auditoria.
          const ipLeft = limiter.remaining(ip);
          app.loginWatch.codeRejected(ip, watched);
          if (outcome.status === "locked") {
            // Nada foi conferido (nem o código certo passa): sem auditoria por
            // tentativa, só o contador do IP. O bloqueio em si já foi auditado.
            if (!failure.allowed) return sendTooManyAttempts(reply, failure.retryAfterSec);
            return twoFactorLocked(reply, outcome.retryAfterSec);
          }
          await app.auditService.record({
            actor: "anon",
            action: "auth.2fa_failed",
            target: user.username,
            detail: `Código de verificação em duas etapas incorreto, de ${ip}.`,
          });
          if (outcome.lockedNow) {
            await app.loginWatch.accountLocked(ip, watched, outcome.lockedNow);
          }
          if (!failure.allowed) {
            // os dois bloqueios de uma vez: diz o MAIOR tempo (é o que vale para o código do app)
            if (outcome.lockedNow) {
              return twoFactorLocked(reply, Math.max(outcome.lockedNow.retryAfterSec, failure.retryAfterSec), true);
            }
            return sendTooManyAttempts(reply, failure.retryAfterSec);
          }
          if (outcome.lockedNow) return twoFactorLocked(reply, outcome.lockedNow.retryAfterSec);
          return invalidTwoFactorCode(reply, ipLeft, outcome.account);
        }
        app.loginWatch.completed(ip, watched);
        twoFactorNote =
          outcome.method === "recovery"
            ? ` Com código de recuperação (restam ${outcome.recoveryCodesLeft}).`
            : " Com verificação em duas etapas.";
      }

      settle(() => limiter.onSuccess(ip));
      let created;
      try {
        created = await app.sessionStore.create(user, {
          ip,
          userAgent: request.headers["user-agent"] ?? null,
        });
      } catch (err) {
        if (!isStorageWriteFailure(err)) throw err;
        request.log.error({ err }, "falha ao gravar a sessão do login");
        return reply.code(500).send({
          error: "storage_write_failed",
          message:
            "Não foi possível salvar a sessão no servidor. O login não foi concluído; tente novamente.",
        });
      }
      const { session, cookieValue } = created;
      const secure = request.protocol === "https";
      reply.setCookie(sessionCookieName(secure), cookieValue, {
        path: "/",
        httpOnly: true,
        // Strict + prefixo __Host- em HTTPS: ver SESSION_COOKIE_SECURE (core/auth.ts).
        sameSite: "strict",
        secure,
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
      });
      await app.auditService.record({
        actor: user.username,
        action: "auth.login",
        detail: `Login bem-sucedido de ${ip}.${twoFactorNote}`,
      });
      const response: LoginResponse = {
        ok: true,
        user: publicUser(user),
        expiresAt: session.expiresAt,
      };
      return reply.send(response);

    } finally {
      if (!settled) limiter.release(ip);
    }
    },
  );

  app.post("/api/auth/logout", async (request, reply) => {
    if (request.session) {
      try {
        await app.sessionStore.destroy(request.session.id);
      } catch (err) {
        if (!isStorageWriteFailure(err)) throw err;
        request.log.error({ err }, "falha ao gravar a revogação da sessão no logout");
        // O cookie fica: apagá-lo faria o navegador parecer deslogado enquanto
        // a sessão continua valendo no servidor para quem tiver o cookie.
        return reply.code(500).send({
          error: "storage_write_failed",
          message:
            "Não foi possível salvar o encerramento da sessão no servidor. Nada foi alterado: " +
            "a sessão continua válida. Tente sair novamente.",
        });
      }
      await app.auditService.record({
        actor: request.session.username,
        action: "auth.logout",
        detail: "Sessão encerrada pelo usuário.",
      });
    }
    const secure = request.protocol === "https";
    reply.clearCookie(sessionCookieName(secure), { path: "/", secure });
    return reply.send({ ok: true });
  });

  app.get("/api/auth/me", async (request, reply) => {
    const session = request.session!; // garantido pelo plugin de auth
    const user = await app.userStore.findById(session.userId);
    if (!user) {
      // usuário removido/recriado: a sessão não vale mais
      await app.sessionStore.destroy(session.id);
      return reply.code(401).send({ error: "unauthorized", message: "Sessão inválida ou expirada." });
    }
    const response: AuthMeResponse = {
      user: publicUser(user),
      session: { expiresAt: session.expiresAt },
      preferences: { ...DEFAULT_USER_PREFERENCES, ...user.preferences },
    };
    return reply.send(response);
  });

  app.post<{ Body: ChangePasswordRequest }>(
    "/api/auth/change-password",
    { schema: changePasswordSchema },
    async (request, reply) => {
    const session = request.session!;
    const { currentPassword, newPassword } = request.body ?? {};
    if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
      return reply.code(400).send({
        error: "invalid_payload",
        message: "Informe a senha atual e a nova senha.",
      });
    }

    const user = await app.userStore.findById(session.userId);
    if (!user) {
      // usuário removido/recriado: mesmo padrão de /api/auth/me — a sessão
      // não vale mais e não pode ficar viva até expirar por conta própria.
      await app.sessionStore.destroy(session.id);
      return reply.code(401).send({ error: "unauthorized", message: "Sessão inválida ou expirada." });
    }

    // Limite por IP e por sessão: sessão aberta + senha vazada não bastam para adivinhar a senha atual.
    const attempt = beginAction(app.actionLimiter, { ip: request.ip, sessionId: request.session!.id }, reply);
    if (!attempt) return reply;
    try {
      const currentOk = await verifyPasswordTimingSafe(user.passwordHash, currentPassword);
      if (!currentOk) {
        const failure = attempt.fail();
        if (!failure.allowed) return sendTooManyAttempts(reply, failure.retryAfterSec);
        return reply.code(401).send({
          error: "invalid_current_password",
          message: "A senha atual está incorreta.",
        });
      }

      const errors = passwordStrengthErrors(newPassword);
      if (errors.length > 0) {
        return reply.code(400).send({
          error: "weak_password",
          message: `Senha fraca: ${errors.join(", ")}.`,
        });
      }

      try {
        await app.userStore.updatePassword(user.id, await hashPassword(newPassword));
      } catch (err) {
        if (!isStorageWriteFailure(err)) throw err;
        request.log.error({ err }, "falha ao gravar a nova senha");
        return reply.code(500).send({
          error: "storage_write_failed",
          message:
            "Não foi possível salvar a nova senha no servidor. Nada foi alterado: a senha atual " +
            "continua valendo e nenhuma sessão foi encerrada.",
        });
      }

      // invalida as OUTRAS sessões — a atual continua válida.
      //
      // Se ESTA gravação falhar, a senha nova já está no disco e fica: desfazê-la
      // seria outra gravação sujeita à mesma falha, e quem troca a senha por
      // suspeita de vazamento não deve voltar à senha antiga. A resposta não é
      // sucesso e diz exatamente o que ficou pendente: as outras sessões podem
      // continuar válidas (em memória e no disco, de forma consistente).
      let revoked: number;
      try {
        revoked = await app.sessionStore.destroyOthersForUser(user.id, session.id);
      } catch (err) {
        if (!isStorageWriteFailure(err)) throw err;
        request.log.error({ err }, "senha trocada, mas falha ao gravar a revogação das outras sessões");
        await app.auditService.record({
          actor: user.username,
          action: "auth.password_changed",
          detail:
            "Senha alterada, mas não foi possível invalidar as sessões anteriores (falha de gravação) — " +
            "elas podem continuar válidas.",
        });
        return reply.code(500).send({
          error: "sessions_not_revoked",
          message:
            "A senha foi alterada, mas não foi possível encerrar as outras sessões no servidor: elas " +
            "podem continuar válidas. Troque a senha novamente (usando a nova como atual) para " +
            "tentar encerrá-las.",
        });
      }
      // Quem troca a senha por suspeita de vazamento não quer chave de longa duração viva: tokens de API caem junto.
      let tokensRevoked = 0;
      try {
        tokensRevoked = await app.apiTokens.revokeAll();
      } catch (err) {
        request.log.error({ err }, "senha trocada, mas falha ao revogar os tokens de API");
        await app.auditService.record({
          actor: user.username,
          action: "auth.password_changed",
          detail: "Senha alterada, mas não foi possível revogar os tokens de API (falha de leitura ou gravação) — revogue-os em Acesso por IA.",
        });
        return reply.code(500).send({
          error: "tokens_not_revoked",
          message:
            "A senha foi alterada, mas não foi possível revogar os tokens de API: revogue-os em Configurações → Acesso por IA.",
        });
      }
      await app.auditService.record({
        actor: user.username,
        action: "auth.password_changed",
        detail: `Senha alterada; ${revoked} sessão(ões) anterior(es) e ${tokensRevoked} token(s) de API invalidado(s).`,
      });
      attempt.success();
      return reply.send({ ok: true });
    } finally {
      attempt.release();
    }
    },
  );

  // ------------------------------------------------ verificação em duas etapas

  /** Usuário da sessão; responde 401 (e encerra a sessão) se ele não existe mais. */
  async function sessionUser(request: FastifyRequest, reply: FastifyReply) {
    const session = request.session!;
    const user = await app.userStore.findById(session.userId);
    if (!user) {
      await app.sessionStore.destroy(session.id);
      await reply.code(401).send({ error: "unauthorized", message: "Sessão inválida ou expirada." });
      return null;
    }
    return user;
  }

  function twoFactorFailure(reply: FastifyReply, err: unknown) {
    if (!(err instanceof TwoFactorError)) throw err;
    const status = err.code === "invalid_two_factor_code" ? 400 : 409;
    return reply.code(status).send({ error: err.code, message: err.message });
  }

  app.get("/api/auth/2fa", async (request, reply) => {
    const user = await sessionUser(request, reply);
    if (!user) return reply;
    const response: TwoFactorStatusResponse = app.twoFactor.status(user);
    return reply.send(response);
  });

  app.post("/api/auth/2fa/setup", async (request, reply) => {
    const user = await sessionUser(request, reply);
    if (!user) return reply;
    try {
      const response: TwoFactorSetupResponse = app.twoFactor.beginSetup(user);
      return reply.send(response);
    } catch (err) {
      return twoFactorFailure(reply, err);
    }
  });

  app.post<{ Body: TwoFactorConfirmRequest }>(
    "/api/auth/2fa/enable",
    { schema: twoFactorConfirmSchema },
    async (request, reply) => {
      const user = await sessionUser(request, reply);
      if (!user) return reply;
      const attempt = beginAction(app.actionLimiter, { ip: request.ip, sessionId: request.session!.id }, reply);
      if (!attempt) return reply;
      try {
        if (!(await verifyPasswordTimingSafe(user.passwordHash, request.body.currentPassword))) {
          const failure = attempt.fail();
          if (!failure.allowed) return sendTooManyAttempts(reply, failure.retryAfterSec);
          return reply.code(401).send({ error: "invalid_current_password", message: "A senha atual está incorreta." });
        }
        let recoveryCodes: string[];
        try {
          recoveryCodes = await app.twoFactor.enable(user, request.body.code);
        } catch (err) {
          if (isStorageWriteFailure(err)) {
            request.log.error({ err }, "falha ao gravar a verificação em duas etapas");
            return reply.code(500).send({
              error: "storage_write_failed",
              message: "Não foi possível salvar no servidor. Nada foi alterado: o login continua só com a senha.",
            });
          }
          // código errado do app conta como falha; conflito (já ativa, setup expirado) não
          if (err instanceof TwoFactorError && err.code === "invalid_two_factor_code") {
            const failure = attempt.fail();
            if (!failure.allowed) return sendTooManyAttempts(reply, failure.retryAfterSec);
          }
          return twoFactorFailure(reply, err);
        }
        attempt.success();
        await app.auditService.record({
          actor: user.username,
          action: "auth.2fa_enabled",
          detail: "Verificação em duas etapas ativada (10 códigos de recuperação gerados).",
        });
        const response: TwoFactorEnableResponse = { recoveryCodes };
        return reply.send(response);
      } finally {
        attempt.release();
      }
    },
  );

  app.post<{ Body: TwoFactorConfirmRequest }>(
    "/api/auth/2fa/disable",
    { schema: twoFactorConfirmSchema },
    async (request, reply) => {
      const user = await sessionUser(request, reply);
      if (!user) return reply;
      const attempt = beginAction(app.actionLimiter, { ip: request.ip, sessionId: request.session!.id }, reply);
      if (!attempt) return reply;
      try {
        if (!(await verifyPasswordTimingSafe(user.passwordHash, request.body.currentPassword))) {
          const failure = attempt.fail();
          if (!failure.allowed) return sendTooManyAttempts(reply, failure.retryAfterSec);
          return reply.code(401).send({ error: "invalid_current_password", message: "A senha atual está incorreta." });
        }
        if (!user.twoFactor) {
          return reply.code(409).send({ error: "not_enabled", message: "A verificação em duas etapas não está ativa." });
        }
        // Sessão roubada + senha vazada não bastam: desligar exige o código
        // (com o mesmo bloqueio por conta do login).
        const outcome = await app.twoFactor.verifyDetailed(user, request.body.code);
        if (outcome.status !== "ok") {
          const failure = attempt.fail();
          if (outcome.status === "invalid" && outcome.lockedNow) {
            await app.loginWatch.accountLocked(request.ip, { id: user.id, username: user.username }, outcome.lockedNow);
          }
          if (!failure.allowed) return sendTooManyAttempts(reply, failure.retryAfterSec);
          if (outcome.status === "locked") return twoFactorLocked(reply, outcome.retryAfterSec);
          if (outcome.lockedNow) return twoFactorLocked(reply, outcome.lockedNow.retryAfterSec);
          return reply.code(400).send({
            error: "invalid_two_factor_code",
            message: "Código incorreto ou já usado. Digite o código que aparece agora no app.",
          });
        }
        const fresh = (await app.userStore.findById(user.id)) ?? user;
        await app.twoFactor.disable(fresh);
        attempt.success();
        await app.auditService.record({
          actor: user.username,
          action: "auth.2fa_disabled",
          detail: "Verificação em duas etapas desativada.",
        });
        return reply.send({ ok: true });
      } finally {
        attempt.release();
      }
    },
  );
};

export default authRoutes;
