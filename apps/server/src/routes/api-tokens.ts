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
  API_TOKEN_MAX_PROJECTS,
  API_TOKEN_REACHES,
  API_TOKEN_MAX_ACTIVE,
  API_TOKEN_MAX_TTL_HOURS,
  API_TOKEN_MIN_TTL_HOURS,
  API_TOKEN_NAME_MAX_LENGTH,
  API_TOKEN_SCOPES,
  validateApiTokenName,
  type CreateApiTokenRequest,
  type CreateApiTokenResponse,
  type ListApiTokensResponse,
  type UpdateApiTokenReachRequest,
  type UpdateApiTokenReachResponse,
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
      reach: { type: "string", enum: [...API_TOKEN_REACHES] },
      projects: { type: "array", maxItems: API_TOKEN_MAX_PROJECTS, items: { type: "string", minLength: 1, maxLength: 64 } },
      canCreate: { type: "boolean" },
      expiresInHours: { type: "integer", minimum: API_TOKEN_MIN_TTL_HOURS, maximum: API_TOKEN_MAX_TTL_HOURS },
      currentPassword: { type: "string", minLength: 1, maxLength: 512 },
      code: { type: "string", minLength: 1, maxLength: 64 },
    },
  },
} as const;

const updateReachSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", pattern: "^[0-9a-f]{16}$" } },
  },
  body: {
    type: "object",
    required: ["projects", "canCreate"],
    additionalProperties: false,
    properties: {
      projects: { type: "array", maxItems: API_TOKEN_MAX_PROJECTS, items: { type: "string", minLength: 1, maxLength: 64 } },
      canCreate: { type: "boolean" },
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

  /**
   * Confirma que é a pessoa: senha atual e, com 2FA, o código (mesmo limite por IP e por sessão
   * das outras rotas que pedem isso). Devolve a conta e a tentativa, ou null depois de já ter
   * respondido o erro. Quem chama marca `attempt.success()` e SEMPRE `attempt.release()`.
   */
  async function confirmIdentity(
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

  /** Os ids existem como projetos (id exato, não apelido)? Devolve os que não existem. */
  async function unknownProjects(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const known = new Set((await app.deployService.listProjects()).map((p) => p.id));
    return ids.filter((id) => !known.has(id));
  }

  const invalidReach = (reply: FastifyReply, message: string) => reply.code(400).send({ error: "invalid_token_reach", message });

  const describeReach = (info: { reach: string; projects: string[]; canCreate: boolean }) =>
    info.reach === "panel"
      ? "alcance: painel inteiro"
      : `alcance: ${info.projects.length} projeto(s) (${info.projects.join(", ") || "nenhum ainda"})${info.canCreate ? ", pode criar projetos" : ""}`;

  app.post<{ Body: CreateApiTokenRequest }>("/api/settings/api-tokens", { schema: createSchema }, async (request, reply) => {
    if (!humanOnly(request, reply)) return reply;
    const name = request.body.name.trim();
    if (!validateApiTokenName(name)) {
      return reply.code(400).send({
        error: "invalid_token_name",
        message: `Nome inválido: até ${API_TOKEN_NAME_MAX_LENGTH} caracteres, só letras, números, espaço, ponto, hífen e sublinhado.`,
      });
    }
    // Alcance conferido antes de pedir a senha: pedido malformado não gasta tentativa.
    const reach = request.body.reach ?? "panel";
    const projects = [...new Set(request.body.projects ?? [])];
    const canCreate = request.body.canCreate === true;
    if (reach === "panel" && (projects.length > 0 || canCreate)) {
      return invalidReach(reply, "Token de painel inteiro não tem lista de projetos nem 'pode criar projetos'.");
    }
    if (reach === "projects" && projects.length === 0 && !canCreate) {
      return invalidReach(reply, "Escolha ao menos um projeto, ou permita que o token crie projetos novos.");
    }
    if ((await unknownProjects(projects)).length > 0) {
      return invalidReach(reply, "Um dos projetos escolhidos não existe. Atualize a lista e escolha de novo.");
    }

    const confirmed = await confirmIdentity(request, reply, request.body);
    if (!confirmed) return reply;
    const { user, attempt } = confirmed;
    try {
      let created;
      try {
        created = await app.apiTokens.create({
          name,
          scope: request.body.scope,
          ttlHours: request.body.expiresInHours ?? API_TOKEN_DEFAULT_TTL_HOURS,
          userId: user.id,
          reach,
          projects,
          canCreate,
        });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "too_many_tokens" || code === "token_name_taken") {
          return reply.code(409).send({ error: code, message: (err as Error).message });
        }
        if (code === "invalid_token_reach") return invalidReach(reply, (err as Error).message);
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
      // Só nome, escopo, alcance e validade: o valor do token nunca é gravado.
      await app.auditService.record({
        actor: user.username,
        action: "auth.api_token_created",
        target: created.info.id,
        detail: `Token de API "${created.info.name}" criado (escopo ${created.info.scope}, ${describeReach(created.info)}, vale até ${created.info.expiresAt}).`,
      });
      const response: CreateApiTokenResponse = created;
      return reply.code(201).header("cache-control", "no-store").send(response);
    } finally {
      attempt.release();
    }
  });

  // Editar a lista de projetos de um token existente. Aumentar o alcance (projeto novo na lista ou
  // ligar "pode criar") pede senha/2FA como a criação: uma sessão aberta e esquecida não pode dar
  // a um token poder que a pessoa não deu. Reduzir não pede: tirar acesso é sempre seguro e
  // precisa ser rápido (é o que se faz com pressa quando algo parece errado).
  app.patch<{ Params: { id: string }; Body: UpdateApiTokenReachRequest }>(
    "/api/settings/api-tokens/:id",
    { schema: updateReachSchema },
    async (request, reply) => {
      if (!humanOnly(request, reply)) return reply;
      let current;
      try {
        current = (await app.apiTokens.list()).find((t) => t.id === request.params.id);
      } catch (err) {
        request.log.error({ err }, "tokens de API ilegíveis");
        return reply.code(503).send({
          error: "token_store_unavailable",
          message: "Não foi possível ler os tokens de API no servidor. Tente de novo em instantes.",
        });
      }
      if (!current || current.status !== "active") {
        return reply.code(404).send({ error: "not_found", message: "Token não encontrado, revogado ou vencido." });
      }
      if (current.reach !== "projects") {
        return reply.code(409).send({
          error: "token_reach_not_editable",
          message: "Token de painel inteiro não tem lista de projetos. Crie outro token com alcance de projetos.",
        });
      }
      const projects = [...new Set(request.body.projects)];
      const canCreate = request.body.canCreate;
      if (projects.length === 0 && !canCreate) {
        return invalidReach(reply, "Escolha ao menos um projeto, ou permita que o token crie projetos novos. Para encerrar o acesso, revogue o token.");
      }
      const added = projects.filter((id) => !current.projects.includes(id));
      if ((await unknownProjects(added)).length > 0) {
        return invalidReach(reply, "Um dos projetos escolhidos não existe. Atualize a lista e escolha de novo.");
      }
      const widens = added.length > 0 || (canCreate && !current.canCreate);
      let attempt: { success(): void; release(): void } | null = null;
      let actor = request.session!.username;
      if (widens) {
        const confirmed = await confirmIdentity(request, reply, request.body);
        if (!confirmed) return reply;
        attempt = confirmed.attempt;
        actor = confirmed.user.username;
      }
      try {
        let info;
        try {
          info = await app.apiTokens.updateReach(request.params.id, { projects, canCreate });
        } catch (err) {
          if ((err as { code?: string }).code === "invalid_token_reach") return invalidReach(reply, (err as Error).message);
          if (!isStorageWriteFailure(err)) throw err;
          request.log.error({ err }, "falha ao gravar o alcance do token de API");
          return reply.code(500).send({
            error: "storage_write_failed",
            message: "Não foi possível salvar a alteração no servidor. Nada foi alterado.",
          });
        }
        if (!info) return reply.code(404).send({ error: "not_found", message: "Token não encontrado, revogado ou vencido." });
        attempt?.success();
        await app.auditService.record({
          actor,
          action: "auth.api_token_reach_changed",
          target: info.id,
          detail: `Token de API "${info.name}" alterado (${describeReach(current)} → ${describeReach(info)}).`,
        });
        const response: UpdateApiTokenReachResponse = { info };
        return reply.header("cache-control", "no-store").send(response);
      } finally {
        attempt?.release();
      }
    },
  );

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
