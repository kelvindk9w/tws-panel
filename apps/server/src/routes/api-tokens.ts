/**
 * api-tokens.ts — Configurações → Acesso por IA (tokens de API).
 *  GET    /api/settings/api-tokens        (sessão humana) lista, sem valor nem hash
 *  POST   /api/settings/api-tokens        (sessão humana + senha atual + código, se há 2FA) cria; o valor sai SÓ aqui
 *  DELETE /api/settings/api-tokens/:id    (sessão humana) revoga, valendo na hora
 *
 * SÓ sessão humana: um token nunca cria, lista nem revoga outro (a lista de
 * exclusão em token-policy.ts já barra no plugin de autenticação; a conferência
 * abaixo é a segunda trava, caso alguém mexa naquela lista). O valor do token
 * nunca vai para log nem para a Auditoria.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  API_TOKEN_DEFAULT_TTL_HOURS,
  API_TOKEN_MAX_ACTIVE,
  API_TOKEN_MAX_TTL_HOURS,
  API_TOKEN_MIN_TTL_HOURS,
  API_TOKEN_NAME_MAX_LENGTH,
  API_TOKEN_SCOPES,
  validateApiTokenName,
  type CreateApiTokenRequest,
  type CreateApiTokenResponse,
  type ListApiTokensResponse,
} from "@paas/core";
import { registerErrorHandler } from "../plugins/error-handler.js";
import { beginAction, sendTooManyAttempts } from "../services/action-guard.js";
import { verifyPasswordTimingSafe } from "../services/password.js";

const createSchema = {
  body: {
    type: "object",
    required: ["name", "scope", "currentPassword"],
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1, maxLength: API_TOKEN_NAME_MAX_LENGTH + 20 },
      scope: { type: "string", enum: [...API_TOKEN_SCOPES] },
      expiresInHours: { type: "integer", minimum: API_TOKEN_MIN_TTL_HOURS, maximum: API_TOKEN_MAX_TTL_HOURS },
      currentPassword: { type: "string", minLength: 1, maxLength: 512 },
      code: { type: "string", minLength: 1, maxLength: 64 },
    },
  },
} as const;

const idSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", pattern: "^[0-9a-f]{16}$" } },
  },
} as const;

function isStorageWriteFailure(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "storage_write_failed";
}

const apiTokenRoutes: FastifyPluginAsync = async (app) => {
  registerErrorHandler(app);

  /** Só humano: sessão de cookie. Token (mesmo admin) nunca administra tokens. */
  function humanOnly(request: FastifyRequest, reply: FastifyReply): boolean {
    if (request.session && !request.session.token) return true;
    void reply.code(403).send({
      error: "token_forbidden",
      message: "Tokens de API são administrados só pelo painel, com a sua conta (não por outro token).",
    });
    return false;
  }

  app.get("/api/settings/api-tokens", async (request, reply) => {
    if (!humanOnly(request, reply)) return reply;
    try {
      const response: ListApiTokensResponse = { tokens: await app.apiTokens.list(), maxActive: API_TOKEN_MAX_ACTIVE };
      return reply.header("cache-control", "no-store").send(response);
    } catch (err) {
      request.log.error({ err }, "tokens de API ilegíveis");
      return reply.code(503).send({
        error: "token_store_unavailable",
        message: "Não foi possível ler os tokens de API no servidor. Tente de novo em instantes.",
      });
    }
  });

  app.post<{ Body: CreateApiTokenRequest }>("/api/settings/api-tokens", { schema: createSchema }, async (request, reply) => {
    if (!humanOnly(request, reply)) return reply;
    const session = request.session!;
    const name = request.body.name.trim();
    if (!validateApiTokenName(name)) {
      return reply.code(400).send({
        error: "invalid_token_name",
        message: `Nome inválido: até ${API_TOKEN_NAME_MAX_LENGTH} caracteres, só letras, números, espaço, ponto, hífen e sublinhado.`,
      });
    }
    const user = await app.userStore.findById(session.userId);
    if (!user) {
      await app.sessionStore.destroy(session.id);
      return reply.code(401).send({ error: "unauthorized", message: "Sessão inválida ou expirada." });
    }

    // Mesmo limite das outras rotas que pedem senha/código com a sessão aberta.
    const attempt = beginAction(app.actionLimiter, { ip: request.ip, sessionId: session.id }, reply);
    if (!attempt) return reply;
    try {
      if (!(await verifyPasswordTimingSafe(user.passwordHash, request.body.currentPassword))) {
        const failure = attempt.fail();
        if (!failure.allowed) return sendTooManyAttempts(reply, failure.retryAfterSec);
        return reply.code(401).send({ error: "invalid_current_password", message: "A senha atual está incorreta." });
      }
      if (user.twoFactor) {
        // Sessão roubada + senha vazada não bastam para criar uma chave de longa duração.
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
      }

      let created;
      try {
        created = await app.apiTokens.create({
          name,
          scope: request.body.scope,
          ttlHours: request.body.expiresInHours ?? API_TOKEN_DEFAULT_TTL_HOURS,
          userId: user.id,
        });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "too_many_tokens" || code === "token_name_taken") {
          return reply.code(409).send({ error: code, message: (err as Error).message });
        }
        if (isStorageWriteFailure(err)) {
          request.log.error({ err }, "falha ao gravar o token de API");
          return reply.code(500).send({
            error: "storage_write_failed",
            message: "Não foi possível salvar o token no servidor. Nada foi criado.",
          });
        }
        return reply.code(503).send({
          error: "token_store_unavailable",
          message: "Não foi possível ler os tokens de API no servidor. Tente de novo em instantes.",
        });
      }
      attempt.success();
      // Só nome, escopo e validade: o valor do token nunca é gravado.
      await app.auditService.record({
        actor: user.username,
        action: "auth.api_token_created",
        target: created.info.id,
        detail: `Token de API "${created.info.name}" criado (escopo ${created.info.scope}, vale até ${created.info.expiresAt}).`,
      });
      const response: CreateApiTokenResponse = created;
      return reply.code(201).header("cache-control", "no-store").send(response);
    } finally {
      attempt.release();
    }
  });

  app.delete<{ Params: { id: string } }>("/api/settings/api-tokens/:id", { schema: idSchema }, async (request, reply) => {
    if (!humanOnly(request, reply)) return reply;
    let revoked;
    try {
      revoked = await app.apiTokens.revoke(request.params.id);
    } catch (err) {
      if (!isStorageWriteFailure(err)) throw err;
      request.log.error({ err }, "falha ao gravar a revogação do token de API");
      return reply.code(500).send({
        error: "storage_write_failed",
        message: "Não foi possível salvar a revogação no servidor. Nada foi alterado: o token continua valendo. Tente de novo.",
      });
    }
    if (!revoked) return reply.code(404).send({ error: "not_found", message: "Token não encontrado ou já revogado." });
    await app.auditService.record({
      actor: request.session!.username,
      action: "auth.api_token_revoked",
      target: revoked.id,
      detail: `Token de API "${revoked.name}" revogado.`,
    });
    return reply.send({ ok: true });
  });
};

export default apiTokenRoutes;
