/**
 * auth.ts — guarda de autenticação de todas as rotas /api/*.
 *
 * Regras:
 *  - /api/healthz e /api/auth/login: públicos.
 *  - /api/setup/*: enquanto o setup NÃO foi concluído, exigem o setup token;
 *    depois de concluído (conta admin criada), respondem 403 — o wizard trava
 *    e o setup token deixa de ter qualquer utilidade.
 *  - /api/auth/* (me/logout/change-password): exigem sessão válida.
 *  - Demais /api/*: setup concluído → sessão válida; setup pendente → setup
 *    token (o wizard dos passos 1–3 e os E2E ainda operam nessa fase).
 *
 * A sessão é resolvida do cookie em TODA requisição e exposta em
 * request.session (null quando ausente/inválida).
 */
import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import { SESSION_COOKIE, SETUP_TOKEN_HEADER, SETUP_TOKEN_QUERY } from "@paas/core";
import { tokenMatches } from "../services/setup-token.js";
import type { Session, SessionStore } from "../services/session-store.js";
import type { UserStore } from "../services/user-store.js";
import type { SetupStateStore } from "../services/setup-state.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Setup token carregado na inicialização (null = não configurado). */
    setupToken: string | null;
    userStore: UserStore;
    sessionStore: SessionStore;
    setupState: SetupStateStore;
  }
  interface FastifyRequest {
    /** Sessão resolvida do cookie (null quando ausente/inválida/expirada). */
    session: Session | null;
  }
}

function extractToken(request: FastifyRequest): string | null {
  const header = request.headers[SETUP_TOKEN_HEADER];
  if (typeof header === "string" && header.length > 0) return header;
  const query = (request.query as Record<string, unknown> | undefined)?.[SETUP_TOKEN_QUERY];
  if (typeof query === "string" && query.length > 0) return query;
  return null;
}

function requireSetupToken(app: { setupToken: string | null }, request: FastifyRequest, reply: FastifyReply) {
  if (!app.setupToken) {
    return reply.code(503).send({
      error: "setup_token_missing",
      message:
        "Servidor sem setup token configurado. Defina SETUP_TOKEN ou crie o arquivo de token (veja scripts/install.sh).",
    });
  }
  const provided = extractToken(request);
  if (!provided || !tokenMatches(provided, app.setupToken)) {
    return reply.code(401).send({
      error: "unauthorized",
      message: "Setup token inválido ou ausente.",
    });
  }
}

const authPlugin: FastifyPluginAsync = async (app) => {
  await app.register(cookie);
  app.decorateRequest("session", null);

  app.addHook("onRequest", async (request, reply) => {
    // resolve a sessão em toda requisição (barato: HMAC + lookup em memória)
    const cookieValue = request.cookies[SESSION_COOKIE];
    if (cookieValue) {
      request.session = await app.sessionStore.resolve(cookieValue);
    }

    if (!request.url.startsWith("/api/")) return;
    if (request.url === "/api/healthz") return;
    if (request.url.startsWith("/api/auth/login")) return;

    const state = await app.setupState.load();

    // Wizard: trava depois de concluído; antes disso exige o setup token.
    if (request.url.startsWith("/api/setup/")) {
      if (state.completed) {
        return reply.code(403).send({
          error: "setup_completed",
          message: "O setup já foi concluído. Entre com sua conta de administrador.",
        });
      }
      // verify-token é a porta de entrada do wizard: valida o token no corpo.
      if (request.url.startsWith("/api/setup/verify-token")) return;
      return requireSetupToken(app, request, reply);
    }

    // Rotas de conta: exigem sessão. "setup_incomplete" orienta o guard do frontend.
    if (request.url.startsWith("/api/auth/")) {
      if (!request.session) {
        return reply.code(401).send(
          state.completed
            ? { error: "unauthorized", message: "Sessão inválida ou expirada." }
            : { error: "setup_incomplete", message: "Conclua o setup para criar a conta de administrador." },
        );
      }
      return;
    }

    // Demais rotas da API.
    if (state.completed) {
      if (!request.session) {
        return reply.code(401).send({
          error: "unauthorized",
          message: "Sessão inválida ou expirada.",
        });
      }
      return;
    }
    return requireSetupToken(app, request, reply);
  });
};

export default fp(authPlugin, { name: "auth" });
