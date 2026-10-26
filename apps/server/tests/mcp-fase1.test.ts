/**
 * mcp-fase1.test.ts — o /mcp do painel real (sem Docker, sem rede): desligado por padrão, autenticação só por
 * token, protocolo, ferramentas que chamam as mesmas rotas, alcance e nível, aprovação humana e Auditoria.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PASSWORD, startRealPanel, type RealPanel } from "./helpers/real-panel.js";
import { McpSession, enableMcp, rpc } from "./helpers/mcp-client.js";

vi.mock("../src/services/docker-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/docker-service.js")>()),
  listContainers: async () => [],
}));
vi.mock("node:dns/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:dns/promises")>();
  const resolve4 = async () => {
    throw Object.assign(new Error("sem DNS nos testes"), { code: "ENOTFOUND" });
  };
  return { ...real, resolve4, default: { ...(real as unknown as { default: object }).default, resolve4 } };
});

let panel: RealPanel;
let A = "";
let B = "";
let adminPanel = "";

beforeAll(async () => {
  panel = await startRealPanel();
  A = await panel.createProject("Fazenda", "fazenda.example.com");
  B = await panel.createProject("Loja", "loja.example.com");
  adminPanel = (await panel.createToken({ name: "ia-painel", scope: "admin", reach: "panel" })).token;
}, 120_000);
afterAll(async () => panel.close());

describe("desligado por padrão", () => {
  it("o /mcp não existe (404) com ou sem token, até alguém ligar em Configurações", async () => {
    expect((await rpc(panel.app, adminPanel, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(404);
    expect((await rpc(panel.app, null, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(404);
    expect((await rpc(panel.app, adminPanel, null, { method: "GET" })).status).toBe(404);
  });

  it("ligar exige a senha; sem ela nada muda", async () => {
    const semSenha = await panel.app.inject({ method: "PUT", url: "/api/settings/mcp", headers: { cookie: panel.cookie }, payload: { enabled: true } });
    expect(semSenha.statusCode).toBe(401);
    const errada = await panel.app.inject({
      method: "PUT",
      url: "/api/settings/mcp",
      headers: { cookie: panel.cookie },
      payload: { enabled: true, currentPassword: "errada" },
    });
    expect(errada.statusCode).toBe(401);
    expect((await panel.app.inject({ method: "GET", url: "/api/settings/mcp", headers: { cookie: panel.cookie } })).json()).toEqual({ enabled: false, path: "/mcp" });
  });

  it("token nenhum liga ou desliga o MCP", async () => {
    const res = await panel.app.inject({
      method: "PUT",
      url: "/api/settings/mcp",
      headers: { authorization: `Bearer ${adminPanel}` },
      payload: { enabled: true, currentPassword: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
    expect((await panel.app.inject({ method: "GET", url: "/api/mcp/approvals", headers: { authorization: `Bearer ${adminPanel}` } })).statusCode).toBe(403);
  });
});

describe("ligado", () => {
  beforeAll(async () => {
    expect(await enableMcp(panel)).toBe(200);
  });

  it("só aceita token: sem token e com cookie dão 401", async () => {
    const semToken = await rpc(panel.app, null, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(semToken.status).toBe(401);
    const comCookie = await rpc(panel.app, null, { jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { cookie: panel.cookie } });
    expect(comCookie.status).toBe(401);
    const falso = await rpc(panel.app, "tws_pat_" + "A".repeat(43), { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(falso.status).toBe(401);
  });

  it("initialize negocia a versão, abre sessão e diz o nome do servidor", async () => {
    const s = new McpSession(panel.app, adminPanel);
    const res = await s.initialize("Claude Teste");
    expect(res.status).toBe(200);
    expect(res.json.result.protocolVersion).toBe("2025-06-18");
    expect(res.json.result.serverInfo.name).toBe("tws-panel");
    expect(res.json.result.capabilities.tools).toBeDefined();
    expect(s.session).toMatch(/^[0-9a-f]{48}$/);
    const velha = await rpc(
      panel.app,
      adminPanel,
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01", clientInfo: { name: "x" } } },
    );
    expect(velha.json.result.protocolVersion).toBe("2025-06-18");
    expect(velha.json.result.serverInfo.version).toBeTruthy();
  });

  it("ping, notificação (202) e método desconhecido", async () => {
    const s = new McpSession(panel.app, adminPanel);
    await s.initialize();
    expect((await s.call("ping")).json.result).toEqual({});
    const note = await rpc(panel.app, adminPanel, { jsonrpc: "2.0", method: "notifications/initialized" }, { session: s.session });
    expect(note.status).toBe(202);
    expect((await s.call("resources/list")).json.error.code).toBe(-32601);
  });

  it("mensagens inválidas: lote, não-JSON-RPC, JSON quebrado", async () => {
    expect((await rpc(panel.app, adminPanel, [{ jsonrpc: "2.0", id: 1, method: "ping" }])).json.error.code).toBe(-32600);
    expect((await rpc(panel.app, adminPanel, { id: 1, method: "ping" })).json.error.code).toBe(-32600);
    expect((await rpc(panel.app, adminPanel, "{quebrado")).json.error.code).toBe(-32700);
    expect((await rpc(panel.app, adminPanel, 42)).json.error.code).toBe(-32600);
  });

  it("GET dá 405 e DELETE encerra a sessão", async () => {
    const s = new McpSession(panel.app, adminPanel);
    await s.initialize();
    const get = await rpc(panel.app, adminPanel, null, { method: "GET" });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe("POST, DELETE");
    expect((await rpc(panel.app, adminPanel, null, { method: "DELETE", session: s.session })).status).toBe(204);
    // sessão encerrada: o cliente precisa abrir outra
    expect((await s.call("ping")).status).toBe(404);
    expect((await rpc(panel.app, adminPanel, null, { method: "DELETE", session: s.session })).status).toBe(404);
  });

  it("sessão de outro token é desconhecida", async () => {
    const outro = (await panel.createToken({ name: "outro", scope: "read", reach: "panel" })).token;
    const s = new McpSession(panel.app, adminPanel);
    await s.initialize();
    const res = await rpc(panel.app, outro, { jsonrpc: "2.0", id: 1, method: "ping" }, { session: s.session });
    expect(res.status).toBe(404);
  });

  it("tools/list mostra só o que o token pode usar", async () => {
    const leitura = (await panel.createToken({ name: "so-le", scope: "read", reach: "panel" })).token;
    const s = new McpSession(panel.app, leitura);
    await s.initialize();
    const names = (await s.call("tools/list")).json.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("list_projects");
    expect(names).toContain("get_access_info");
    for (const escrita of ["deploy_project", "create_project", "set_env_vars", "recreate_project", "security_apply", "add_domain"]) {
      expect(names).not.toContain(escrita);
    }
    // nada que apague
    expect(names.filter((n: string) => /delete|remove|destroy|drop|prune/.test(n))).toEqual([]);
    const admin = new McpSession(panel.app, adminPanel);
    await admin.initialize();
    const todas = (await admin.call("tools/list")).json.result.tools.map((t: { name: string }) => t.name);
    expect(todas).toEqual(expect.arrayContaining(["create_project", "deploy_project", "recreate_project", "security_apply", "add_domain", "set_env_vars"]));
    expect(todas.filter((n: string) => /delete|remove|destroy|drop|prune/.test(n))).toEqual([]);
    // opções desligadas escondem as ferramentas
    for (const escondida of ["get_env_value", "get_host_metrics", "get_metrics_summary", "get_project_metrics"]) expect(todas).not.toContain(escondida);
  });

  it("ferramenta que o token não enxerga é 'desconhecida' (sem pista)", async () => {
    const leitura = (await panel.createToken({ name: "so-le-2", scope: "read", reach: "panel" })).token;
    const s = new McpSession(panel.app, leitura);
    await s.initialize();
    const proibida = await s.call("tools/call", { name: "deploy_project", arguments: { projectId: A } });
    const inexistente = await s.call("tools/call", { name: "nao_existe", arguments: {} });
    expect(proibida.json.error.code).toBe(-32602);
    expect(proibida.json.error.message).toBe(inexistente.json.error.message);
  });
});
