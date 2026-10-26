/**
 * mcp-client.ts — cliente MCP mínimo para os testes: fala JSON-RPC com o /mcp do painel real (app.inject).
 */
import type { FastifyInstance } from "fastify";
import { PASSWORD, type RealPanel } from "./real-panel.js";

export interface RpcResult {
  status: number;
  headers: Record<string, unknown>;
  json: any;
}

export async function rpc(
  app: FastifyInstance,
  token: string | null,
  body: unknown,
  extra: { headers?: Record<string, string>; session?: string; method?: "POST" | "GET" | "DELETE" } = {},
): Promise<RpcResult> {
  const res = await app.inject({
    method: extra.method ?? "POST",
    url: "/mcp",
    headers: {
      ...(extra.method === "GET" || extra.method === "DELETE" ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(extra.session ? { "mcp-session-id": extra.session } : {}),
      ...(extra.headers ?? {}),
    },
    ...(extra.method === "GET" || extra.method === "DELETE" ? {} : { payload: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  let json: unknown = null;
  try {
    json = res.json();
  } catch {
    json = res.body;
  }
  return { status: res.statusCode, headers: res.headers as Record<string, unknown>, json };
}

/** Liga o MCP pela rota da tela (senha) e devolve o status. */
export async function enableMcp(panel: RealPanel): Promise<number> {
  const res = await panel.app.inject({
    method: "PUT",
    url: "/api/settings/mcp",
    headers: { cookie: panel.cookie },
    payload: { enabled: true, currentPassword: PASSWORD },
  });
  return res.statusCode;
}

export class McpSession {
  session = "";
  private id = 0;
  constructor(
    private readonly app: FastifyInstance,
    private readonly token: string,
  ) {}

  async initialize(clientName = "teste-ia"): Promise<RpcResult> {
    const res = await rpc(this.app, this.token, {
      jsonrpc: "2.0",
      id: ++this.id,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName, version: "1.0" } },
    });
    this.session = String(res.headers["mcp-session-id"] ?? "");
    return res;
  }

  call(method: string, params?: unknown): Promise<RpcResult> {
    return rpc(this.app, this.token, { jsonrpc: "2.0", id: ++this.id, method, ...(params === undefined ? {} : { params }) }, { session: this.session });
  }

  /** tools/call; devolve o texto já como objeto e se foi erro. */
  async tool(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; data: any; raw: RpcResult }> {
    const raw = await this.call("tools/call", { name, arguments: args });
    const result = raw.json?.result;
    const text = result?.content?.[0]?.text as string | undefined;
    let data: unknown = text;
    try {
      data = text === undefined ? undefined : JSON.parse(text);
    } catch {
      // texto cortado
    }
    return { isError: result?.isError === true, data, raw };
  }
}
