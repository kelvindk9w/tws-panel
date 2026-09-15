/**
 * auth.ts — rotas de autenticação do painel:
 *  POST /api/auth/login            (público, rate limited por IP)
 *  POST /api/auth/logout           (sessão)
 *  GET  /api/auth/me               (sessão)
 *  POST /api/auth/change-password  (sessão; invalida as demais sessões)
 *
 * A senha NUNCA aparece em logs nem em respostas. Todas as respostas levam
 * Cache-Control: no-store (além dos headers do helmet).
 *
 * Falha de gravação (users.json/sessions.json) nunca vira sucesso: os stores
 * desfazem a alteração em memória e rejeitam com `storage_write_failed`, e a
 * rota responde 500 dizendo o que NÃO foi feito — sem detalhe do disco.
 */
import type { FastifyPluginAsync } from "fastify";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  passwordStrengthErrors,
  type AuthMeResponse,
  type ChangePasswordRequest,
  type LoginRequest,
  type LoginResponse,
} from "@paas/core";
import { hashPassword, verifyPasswordTimingSafe } from "../services/password.js";
import { LoginLimiter } from "../services/login-limiter.js";
import { registerErrorHandler } from "../plugins/error-handler.js";

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

const authRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);
  const limiter = new LoginLimiter();

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
      const failure = limiter.onFailure(ip);
      await app.auditService.record({
        actor: "anon",
        action: "auth.login_failed",
        target: username,
        detail: `Login falho de ${ip}.`,
      });
      if (!failure.allowed) {
        reply.header("retry-after", String(failure.retryAfterSec));
        return reply.code(429).send({
          error: "too_many_attempts",
          message: `Muitas tentativas. Aguarde ${failure.retryAfterSec}s e tente novamente.`,
          retryAfterSec: failure.retryAfterSec,
        });
      }
      return reply.code(401).send({
        error: "invalid_credentials",
        message: "Credenciais inválidas.",
      });
    }

    limiter.onSuccess(ip);
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
    reply.setCookie(SESSION_COOKIE, cookieValue, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: request.protocol === "https",
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    await app.auditService.record({
      actor: user.username,
      action: "auth.login",
      detail: `Login bem-sucedido de ${ip}.`,
    });
    const response: LoginResponse = {
      ok: true,
      user: { username: user.username, createdAt: user.createdAt },
      expiresAt: session.expiresAt,
    };
    return reply.send(response);
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
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
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
      user: { username: user.username, createdAt: user.createdAt },
      session: { expiresAt: session.expiresAt },
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

    const currentOk = await verifyPasswordTimingSafe(user.passwordHash, currentPassword);
    if (!currentOk) {
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
    await app.auditService.record({
      actor: user.username,
      action: "auth.password_changed",
      detail: `Senha alterada; ${revoked} sessão(ões) anterior(es) invalidada(s).`,
    });
    return reply.send({ ok: true });
    },
  );
};

export default authRoutes;
