/**
 * mcp.ts — o MCP do painel (Fase 1): `POST /mcp`, transporte HTTP "streamable" com respostas em JSON.
 *
 *  POST   /mcp   uma mensagem JSON-RPC por vez (initialize, ping, tools/list, tools/call)
 *  GET    /mcp   405 (o painel não abre fluxo SSE para o cliente)
 *  DELETE /mcp   encerra a sessão (cabeçalho Mcp-Session-Id)
 *
 * A autenticação NÃO é feita aqui: o plugin de autenticação (plugins/auth.ts) já rodou antes e só deixa chegar
 * quem trouxe `Authorization: Bearer <token de API>` (nunca cookie), com o MCP ligado em Configurações. Desligado
 * (o padrão), esta rota responde como uma rota que não existe. Navegador: o CSRF/Origin das rotas /api vale aqui
 * também (requisição de outra origem é recusada antes), e o /mcp não tem CORS. As ferramentas chamam as rotas da
 * API com o mesmo token (services/mcp-tools.ts), então alcance, nível, validação e limites de taxa são os mesmos.
 */
import { createHash } from "node:crypto";
import type { FastifyError, FastifyPluginAsync, FastifyRequest } from "fastify";
import { MCP_PATH, SETUP_TOKEN_HEADER } from "@paas/core";
import { SETUP_MCP_SESSION } from "../plugins/auth.js";
import { McpApprovals } from "../services/mcp-approvals.js";
import { RPC, type McpProtocol } from "../services/mcp-protocol.js";
import { McpSettings } from "../services/mcp-settings.js";
import type { McpCaller } from "../services/mcp-tools.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Liga/desliga do MCP (data/mcp-settings.json). */
    mcpSettings: McpSettings;
    /** Aprovações humanas pendentes das ações sensíveis pedidas por uma IA. */
    mcpApprovals: McpApprovals;
    /** Protocolo MCP (sessões e ferramentas). */
    mcp: McpProtocol;
  }
}

const MAX_BODY_BYTES = 1024 * 1024;

const rpcFailure = (code: number, message: string) => ({ jsonrpc: "2.0", id: null, error: { code, message } });

/** Limite por token (e, sem token, por IP): quem erra o token cai no limite próprio da autenticação. */
function rateKey(request: FastifyRequest): string {
  const auth = request.headers.authorization;
  return typeof auth === "string" ? `mcp:${createHash("sha256").update(auth).digest("hex").slice(0, 24)}` : `mcp-ip:${request.ip}`;
}

const mcpRoutes: FastifyPluginAsync = async (app) => {
  // Erro de leitura do corpo (JSON inválido, grande demais, tipo errado) no formato do protocolo.
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const status = error.statusCode ?? 500;
    if (status === 413) return reply.code(413).send(rpcFailure(RPC.invalid, "Mensagem grande demais."));
    if (status >= 400 && status < 500) return reply.code(status === 429 ? 429 : 400).send(rpcFailure(RPC.parse, "Requisição inválida: envie JSON-RPC 2.0 em application/json."));
    return reply.send(error);
  });

  /** Quem chama: o token que o plugin de autenticação aceitou (ou o setup token, no modo de instalação). */
  function callerOf(request: FastifyRequest, client: string): McpCaller {
    const session = request.session!;
    const token = session.token!;
    const setup = session.id === SETUP_MCP_SESSION;
    return {
      tokenId: token.id,
      tokenName: session.username.replace(/^token:/, ""),
      scope: token.scope,
      reach: token.reach,
      mcp: token.mcp,
      ip: request.ip,
      authHeaders: setup ? { [SETUP_TOKEN_HEADER]: app.setupToken ?? "" } : { authorization: String(request.headers.authorization) },
      setup,
      client,
    };
  }

  app.post(
    MCP_PATH,
    { bodyLimit: MAX_BODY_BYTES, config: { rateLimit: { max: 120, timeWindow: "1 minute", keyGenerator: rateKey } } },
    async (request, reply) => {
      const body = request.body;
      const isInitialize = !!body && typeof body === "object" && !Array.isArray(body) && (body as { method?: unknown }).method === "initialize";
      let client = "desconhecido";
      const sessionHeader = request.headers["mcp-session-id"];
      if (!isInitialize && typeof sessionHeader === "string") {
        const known = app.mcp.sessionClient(sessionHeader, request.session!.token!.id);
        // Sessão que o painel não conhece (reiniciou, venceu, é de outro token): o cliente abre outra.
        if (known === null) return reply.code(404).send(rpcFailure(-32001, "Sessão desconhecida: envie initialize de novo."));
        client = known;
      }
      const handled = await app.mcp.handle(body, callerOf(request, client));
      if (handled.sessionId) {
        reply.header("mcp-session-id", handled.sessionId);
        await app.mcp.recordSessionStarted(callerOf(request, client), handled.client ?? client);
      }
      reply.header("cache-control", "no-store");
      if (handled.body === null) return reply.code(202).send();
      return reply.send(handled.body);
    },
  );

  app.get(MCP_PATH, async (_request, reply) =>
    reply.code(405).header("allow", "POST, DELETE").send({ error: "method_not_allowed", message: "O painel só aceita POST no /mcp (sem fluxo SSE)." }),
  );

  app.delete(MCP_PATH, async (request, reply) => {
    const sessionHeader = request.headers["mcp-session-id"];
    const closed = typeof sessionHeader === "string" && app.mcp.closeSession(sessionHeader, request.session!.token!.id);
    return closed ? reply.code(204).send() : reply.code(404).send(rpcFailure(-32001, "Sessão desconhecida."));
  });
};

export default mcpRoutes;
