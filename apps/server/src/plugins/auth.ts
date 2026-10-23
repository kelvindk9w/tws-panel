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
 *
 * Token de API (`Authorization: Bearer tws_pat_…`): depois que o setup termina,
 * vira uma "sessão sintética" em request.session (sem cookie, sem gravar em
 * sessions.json; `session.token` marca a origem). Nunca vem de cookie nem da
 * URL; o CSRF/Origin acima vale para ele igual; o escopo e a lista de exclusão
 * (token-policy.ts) são aplicados aqui, por rota, antes de a rota rodar.
 * Com Bearer na requisição o cookie é IGNORADO (a requisição vale o que o
 * token vale, não o que o cookie de um navegador qualquer valeria).
 */
import fp from "fastify-plugin";
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import { sessionCookieName, SETUP_TOKEN_HEADER, SETUP_TOKEN_QUERY } from "@paas/core";
import { sendTooManyAttempts } from "../services/action-guard.js";
import type { ApiTokenStore } from "../services/api-token-store.js";
import type { LoginLimiter } from "../services/login-limiter.js";
import { runWithActor } from "../services/request-actor.js";
import { classifyRoute, scopeCovers } from "../services/token-policy.js";
import { tokenMatches } from "../services/setup-token.js";
import { isCrossSiteWrite } from "../services/same-origin.js";
import type { Session, SessionStore } from "../services/session-store.js";
import type { TwoFactorService } from "../services/two-factor.js";
import type { UserStore } from "../services/user-store.js";
import type { SetupStateStore } from "../services/setup-state.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Setup token carregado na inicialização (null = não configurado). */
    setupToken: string | null;
    /** Descarta o setup token da memória (setup concluído). Age no escopo raiz. */
    revokeSetupToken: () => void;
    /** Avisa quando o setup token é revogado (devolve a função que cancela o aviso). */
    onSetupTokenRevoked: (listener: () => void) => () => void;
    userStore: UserStore;
    twoFactor: TwoFactorService;
    sessionStore: SessionStore;
    setupState: SetupStateStore;
    /** Tokens de API (data/api-tokens.json). Ausente = Bearer nunca vale. */
    apiTokens: ApiTokenStore;
    /** Limite de Bearer inválido por IP (separado do limite do login). */
    tokenLimiter: LoginLimiter;
  }
  interface FastifyRequest {
    /** Sessão resolvida do cookie (null quando ausente/inválida/expirada). */
    session: Session | null;
  }
}

/** Única rota que aceita o token na URL: o WebSocket do navegador não leva cabeçalho. */
const TERMINAL_WS_PATH = "/api/terminal/ws";

function extractToken(request: FastifyRequest): string | null {
  const header = request.headers[SETUP_TOKEN_HEADER];
  if (typeof header === "string" && header.length > 0) return header;
  // Na URL o token iria para logs, histórico e Referer: só onde não há outro jeito.
  if (routePath(request) !== TERMINAL_WS_PATH) return null;
  const query = (request.query as Record<string, unknown> | undefined)?.[SETUP_TOKEN_QUERY];
  if (typeof query === "string" && query.length > 0) return query;
  return null;
}

/**
 * Caminho usado na decisão de acesso: o padrão da rota que o roteador
 * escolheu (ex.: "/api/projects/:id"). Sem rota (404), o caminho do endereço
 * decodificado, sem query e sem esquema/host — nunca o texto bruto.
 */
export function routePath(request: FastifyRequest): string {
  const route = request.routeOptions?.url;
  if (route) return route;
  let raw = request.url;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(raw);
  if (scheme) raw = raw.slice(scheme[0].length) || "/";
  raw = raw.split(/[?#]/)[0]!;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

const TOKEN_INVALID = {
  error: "unauthorized",
  message: "Token de API inválido, expirado ou revogado.",
} as const;

type AuthorizationHeader = { kind: "none" } | { kind: "other" } | { kind: "malformed" } | { kind: "bearer"; token: string };

/**
 * Lê o cabeçalho Authorization. Só o esquema Bearer é nosso; outro esquema
 * (ex.: Basic, de um proxy na frente) é ignorado. Bearer fora do formato
 * estrito — sem valor, valor com espaço ou aspas, tamanho absurdo — é malformado.
 */
export function parseAuthorization(value: string | string[] | undefined): AuthorizationHeader {
  if (value === undefined) return { kind: "none" };
  if (Array.isArray(value)) return { kind: "malformed" };
  const scheme = /^\s*([A-Za-z][A-Za-z0-9._~+/-]*)(?:\s|$)/.exec(value)?.[1];
  if (scheme === undefined) return value.trim() === "" ? { kind: "none" } : { kind: "malformed" };
  if (scheme.toLowerCase() !== "bearer") return { kind: "other" };
  const match = /^Bearer ([A-Za-z0-9_-]{1,200})$/i.exec(value);
  return match ? { kind: "bearer", token: match[1]! } : { kind: "malformed" };
}

/** O endereço carrega um token de API (ou parâmetro com cara de token) na query/caminho? */
export function tokenInUrl(rawUrl: string): boolean {
  let decoded = rawUrl;
  try {
    decoded = decodeURIComponent(rawUrl);
  } catch {
    // malformado: confere o texto como veio
  }
  if (/tws_pat_/i.test(rawUrl) || /tws_pat_/i.test(decoded)) return true;
  const at = rawUrl.indexOf("?");
  if (at === -1) return false;
  return rawUrl
    .slice(at + 1)
    .split("&")
    .some((pair) => /^(access_token|api_token|api-token|bearer|authorization)$/i.test(decodeURIComponentSafe(pair.split("=")[0]!)));
}

function decodeURIComponentSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
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

function tokenForbidden(reply: FastifyReply, reason: string) {
  return reply.code(403).send({
    error: "token_forbidden",
    message: `Esta ação não está disponível para tokens de API (${reason}). Use o painel, com a sua conta.`,
  });
}

/**
 * Requisição com `Authorization: Bearer`: valida o token, monta a sessão
 * sintética e aplica escopo + lista de exclusão. Toda falha de autenticação
 * (formato errado, inexistente, vencido, revogado, setup pendente) dá a MESMA
 * resposta, para não virar oráculo; o IP que erra demais é bloqueado.
 */
async function authenticateToken(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  header: AuthorizationHeader,
  routePattern: string,
  setupCompleted: boolean,
) {
  const limiter = app.hasDecorator("tokenLimiter") ? app.tokenLimiter : null;
  if (limiter) {
    const gate = limiter.check(request.ip);
    if (!gate.allowed) return sendTooManyAttempts(reply, gate.retryAfterSec);
  }
  const fail = () => {
    const outcome = limiter?.onFailure(request.ip);
    if (outcome && !outcome.allowed) return sendTooManyAttempts(reply, outcome.retryAfterSec);
    return reply.code(401).header("www-authenticate", 'Bearer realm="tws-panel"').send(TOKEN_INVALID);
  };
  if (header.kind !== "bearer" || !setupCompleted || !app.hasDecorator("apiTokens")) return fail();

  let record;
  try {
    record = await app.apiTokens.resolve(header.token);
  } catch (err) {
    // Disco ilegível: nada é aceito (falha fechada), mas não é culpa de quem chamou.
    limiter?.release(request.ip);
    request.log.error({ err }, "tokens de API ilegíveis; requisição recusada");
    return reply.code(503).send({
      error: "token_store_unavailable",
      message: "Não foi possível ler os tokens de API no servidor. Tente de novo em instantes.",
    });
  }
  if (!record) return fail();
  // Token válido não zera as falhas do IP (senão um acerto intercalado esconderia a tentativa de adivinhar).
  limiter?.release(request.ip);

  request.session = {
    id: `token:${record.id}`,
    userId: record.userId,
    username: `token:${record.name}`,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ip: request.ip,
    userAgent: null,
    token: { id: record.id, scope: record.scope },
  };

  const access = classifyRoute(request.method, routePattern);
  if (access.kind === "denied") return tokenForbidden(reply, access.reason);
  if (!scopeCovers(record.scope, access.scope)) {
    return reply.code(403).send({
      error: "insufficient_scope",
      message: `Este token tem escopo "${record.scope}"; a ação pede "${access.scope}".`,
    });
  }
}

const authPlugin: FastifyPluginAsync = async (app) => {
  await app.register(cookie);
  app.decorateRequest("session", null);
  // Rotas encapsuladas só enxergam uma cópia de `setupToken`: quem revoga
  // precisa escrever no escopo raiz, onde este plugin (fp) roda.
  const revokedListeners = new Set<() => void>();
  app.decorate("revokeSetupToken", () => {
    app.setupToken = null;
    for (const listener of [...revokedListeners]) listener();
  });
  app.decorate("onSetupTokenRevoked", (listener: () => void) => {
    revokedListeners.add(listener);
    return () => void revokedListeners.delete(listener);
  });

  // Nada da API (variáveis de projeto, sessão, segredos) fica em cache de
  // navegador ou proxy; quem já definiu o próprio Cache-Control o mantém.
  app.addHook("onSend", async (request, reply, payload) => {
    if (routePath(request).startsWith("/api/") && !reply.hasHeader("cache-control")) {
      reply.header("cache-control", "no-store");
    }
    return payload;
  });

  /** Conta uma tentativa inválida de token no limite por IP (sem efeito se o limitador não existe). */
  async function countTokenFailure(request: FastifyRequest): Promise<void> {
    if (!app.hasDecorator("tokenLimiter")) return;
    if (app.tokenLimiter.check(request.ip).allowed) app.tokenLimiter.onFailure(request.ip);
  }

  app.addHook("onRequest", async (request, reply) => {
    // CSRF (M1): escrita que o navegador diz vir de outro site/origem nem chega
    // à autenticação nem à rota. Vale para o login também (login CSRF).
    if (
      routePath(request).startsWith("/api/") &&
      isCrossSiteWrite(request, app.hasDecorator("config") ? app.config.allowedOrigins : [])
    ) {
      return reply.code(403).send({
        error: "forbidden_origin",
        message: "Origem não permitida: o pedido não partiu do próprio painel.",
      });
    }

    // Decide pelo caminho que o ROTEADOR usou, não pelo texto bruto: ele
    // decodifica %xx, então "/%61pi/projects" cai na rota "/api/projects".
    // Comparar o endereço bruto deixava esse pedido passar sem login.
    const url = routePath(request);
    const isApi = url.startsWith("/api/");

    // Token de API: só no cabeçalho. Na URL iria para log, histórico e Referer.
    if (isApi && tokenInUrl(request.url)) {
      await countTokenFailure(request);
      return reply.code(400).send({
        error: "token_in_url",
        message: "Não envie o token de API na URL. Use o cabeçalho Authorization: Bearer.",
      });
    }
    const authorization = isApi && url !== "/api/healthz" ? parseAuthorization(request.headers.authorization) : ({ kind: "none" } as const);
    const usesToken = authorization.kind === "bearer" || authorization.kind === "malformed";

    // resolve a sessão em toda requisição (barato: HMAC + lookup em memória).
    // Com Bearer o cookie não conta: a requisição vale só pelo token.
    const cookieValue = request.cookies[sessionCookieName(request.protocol === "https")];
    if (cookieValue && !usesToken) {
      request.session = await app.sessionStore.resolve(cookieValue);
    }

    if (!isApi) return;
    if (url === "/api/healthz") return;
    if (url.startsWith("/api/auth/login")) {
      // Nenhum cookie de sessão sai de uma requisição com token.
      return usesToken ? tokenForbidden(reply, "login só por senha, em pessoa") : undefined;
    }

    // Falha fechada: sem saber se o setup terminou, nem o token nem a sessão
    // valem. Tratar "ilegível" como "não concluído" aceitaria o setup token.
    let state;
    try {
      state = await app.setupState.load();
    } catch (err) {
      request.log.error({ err }, "estado do setup ilegível; requisição recusada");
      return reply.code(503).send({
        error: "setup_state_unavailable",
        message: "Não foi possível ler o estado do setup no servidor. Tente de novo em instantes.",
      });
    }

    if (usesToken) return authenticateToken(app, request, reply, authorization, url, state.completed);

    // Wizard: trava depois de concluído; antes disso exige o setup token.
    if (url.startsWith("/api/setup/")) {
      if (state.completed) {
        return reply.code(403).send({
          error: "setup_completed",
          message: "O setup já foi concluído. Entre com sua conta de administrador.",
        });
      }
      // verify-token é a porta de entrada do wizard: valida o token no corpo.
      if (url.startsWith("/api/setup/verify-token")) return;
      return requireSetupToken(app, request, reply);
    }

    // Rotas de conta: exigem sessão. "setup_incomplete" orienta o guard do frontend.
    if (url.startsWith("/api/auth/")) {
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

  // Requisição de token: tudo que ela dispara (rota, auditoria, tarefa em segundo
  // plano) grava na Auditoria como `token:<nome>`. Em formato de callback de
  // propósito: `done` chamado DENTRO de run() leva o contexto até a rota.
  app.addHook("onRequest", (request, _reply, done) => {
    const actor = request.session?.token ? request.session.username : undefined;
    if (actor) runWithActor(actor, done);
    else done();
  });
};

export default fp(authPlugin, { name: "auth" });
