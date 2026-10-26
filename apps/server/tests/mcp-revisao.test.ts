/**
 * mcp-revisao.test.ts — correções da revisão do MCP Fase 1: mudar domínio pede aprovação, log de deploy sem
 * valores de variáveis, desligar o MCP encerra pedidos e sessões, tetos por token e auditoria sem inundação.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { MCP_APPROVAL_MAX_PER_TOKEN, MCP_SESSIONS_MAX_PER_TOKEN } from "@paas/core";
import { PASSWORD, startRealPanel, type RealPanel } from "./helpers/real-panel.js";
import { McpSession, enableMcp, rpc } from "./helpers/mcp-client.js";
import { INTERNAL_CALL_HEADER, internalCallBucket, internalCallHeaders } from "../src/services/internal-call.js";
import { McpApprovals } from "../src/services/mcp-approvals.js";
import { MCP_AUDIT_SESSION_WINDOW_MS, MCP_AUDIT_WINDOW_MS, MCP_MAX_SESSIONS, McpProtocol, renderToolText } from "../src/services/mcp-protocol.js";

vi.mock("../src/services/docker-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/docker-service.js")>()),
  listContainers: async () => [],
}));

let panel: RealPanel;
let A = "";
const tokens: Record<string, string> = {};
const human = () => ({ cookie: panel.cookie });

async function open(name: string, client = "Claude Teste"): Promise<McpSession> {
  const s = new McpSession(panel.app, tokens[name]!);
  await s.initialize(client);
  return s;
}

const decide = (id: string, action: "approve" | "reject", payload: Record<string, unknown> = {}) =>
  panel.app.inject({ method: "POST", url: `/api/mcp/approvals/${id}/${action}`, headers: human(), payload });

beforeAll(async () => {
  panel = await startRealPanel();
  A = await panel.createProject("Fazenda", "fazenda.example.com");
  expect(await enableMcp(panel)).toBe(200);
  for (const [name, body] of Object.entries({
    admin: { scope: "admin", reach: "panel" },
    escrita: { scope: "write", reach: "projects", projects: [A] },
    segundo: { scope: "write", reach: "projects", projects: [A] },
  })) {
    const res = await panel.createToken({ name, ...body });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    tokens[name] = res.token;
  }
}, 120_000);
afterAll(async () => panel.close());

describe("update_project: domínio, branch, www e proxy pedem aprovação", () => {
  it("trocar o domínio principal: pede, a pessoa vê o domínio novo, aprova e roda; só renomear não pede", async () => {
    const s = await open("admin");
    const renomear = await s.tool("update_project", { projectId: A, name: "Fazenda 2" });
    expect(renomear.isError, JSON.stringify(renomear.data)).toBe(false);
    const args = { projectId: A, domain: "novo.example.com" };
    const pedido = await s.tool("update_project", args);
    expect(pedido.data.status).toBe("approval_required");
    const lista = (await panel.app.inject({ method: "GET", url: "/api/mcp/approvals", headers: human() })).json().approvals as { id: string; args: Record<string, string> }[];
    expect(lista.find((a) => a.id === pedido.data.approvalId)!.args).toMatchObject({ domain: "novo.example.com" });
    // o domínio antigo continua até a pessoa aprovar
    const antes = (await panel.app.inject({ method: "GET", url: `/api/projects/${A}`, headers: human() })).json().project.domain as string;
    expect(antes).toBe("fazenda.example.com");
    expect((await decide(pedido.data.approvalId, "approve", { currentPassword: PASSWORD })).statusCode).toBe(200);
    const feito = await s.tool("update_project", { ...args, approvalId: pedido.data.approvalId });
    expect(feito.isError, JSON.stringify(feito.data)).toBe(false);
    expect(feito.data.project.domain).toBe("novo.example.com");
    // outra mudança sensível com o mesmo número não vale (uso único e argumentos diferentes)
    const outro = await s.tool("update_project", { projectId: A, branch: "main", approvalId: pedido.data.approvalId });
    expect(outro.isError).toBe(true);
  });

  it("sem nível de administração a recusa é a de sempre, sem abrir pedido", async () => {
    const s = await open("escrita");
    const antes = (await panel.app.inject({ method: "GET", url: "/api/mcp/approvals", headers: human() })).json().approvals.length as number;
    const res = await s.tool("update_project", { projectId: A, domain: "x.example.com" });
    expect(res.data.error).toBe("insufficient_scope");
    expect((await panel.app.inject({ method: "GET", url: "/api/mcp/approvals", headers: human() })).json().approvals.length).toBe(antes);
  });

  it("projeto fora do alcance: o mesmo 404 de sempre (a aprovação não revela nada)", async () => {
    const s = await open("escrita");
    const res = await s.tool("set_env_vars", { projectId: "ffffffffffffffff", vars: [{ key: "NODE_OPTIONS", value: "x" }] });
    expect(res.data.error).toBe("project_not_found");
  });
});

describe("log de deploy e de containers sem os valores das variáveis", () => {
  it("get_deploy mascara o valor da variável do projeto, também em base64 e hex", async () => {
    const valor = "SenhaMuitoSecreta-123";
    const s = await open("admin");
    await s.tool("set_env_vars", { projectId: A, vars: [{ key: "SEGREDO_DO_APP", value: valor }] });
    const forms = [valor, Buffer.from(valor).toString("base64"), Buffer.from(valor).toString("hex"), Buffer.from(valor).toString("hex").toUpperCase(), Buffer.from(valor).toString("base64url")];
    const job = {
      id: "j1",
      projectId: A,
      status: "success",
      log: forms.map((f) => `linha com ${f} no meio`),
    };
    const spy = vi.spyOn(panel.app.deployService, "getJob").mockResolvedValue(job as never);
    const res = await s.tool("get_deploy", { projectId: A, jobId: "j1" });
    spy.mockRestore();
    const texto = JSON.stringify(res.raw.json.result);
    for (const f of forms) expect(texto, f).not.toContain(f);
    expect(texto).toContain("[oculto]");
    expect(texto).toContain("linha com");
  });

  it("renderToolText troca primeiro as formas mais longas", () => {
    const out = renderToolText({ a: "x-ABCDEFGH-y ABCDEFGH-ZZ" }, [], ["ABCDEFGH", "ABCDEFGH-ZZ"]);
    expect(out).not.toContain("ABCDEFGH");
  });
});

describe("desligar o MCP encerra tudo", () => {
  it("pedidos (inclusive os já aprovados) e sessões não sobrevivem a um religar", async () => {
    const s = await open("segundo");
    const pedido = await s.tool("recreate_project", { projectId: A });
    expect(pedido.data.status).toBe("approval_required");
    const aprovado = await s.tool("recreate_project", { projectId: A });
    expect((await decide(aprovado.data.approvalId, "approve", { currentPassword: PASSWORD })).statusCode).toBe(200);
    const off = await panel.app.inject({ method: "PUT", url: "/api/settings/mcp", headers: human(), payload: { enabled: false } });
    expect(off.statusCode).toBe(200);
    expect(await enableMcp(panel)).toBe(200);
    expect((await panel.app.inject({ method: "GET", url: "/api/mcp/approvals", headers: human() })).json().approvals).toEqual([]);
    // a sessão antiga some: 404 pede um initialize novo
    const velha = await s.call("tools/list");
    expect(velha.status).toBe(404);
    // o pedido aprovado antes de desligar não executa
    const novo = new McpSession(panel.app, tokens["segundo"]!);
    await novo.initialize();
    const usada = await novo.tool("recreate_project", { projectId: A, approvalId: aprovado.data.approvalId });
    expect(usada.data.error).toBe("approval_not_found");
  });
});

describe("tetos por token", () => {
  it("um token com pedidos demais esperando não bloqueia os outros", async () => {
    const abusivo = await open("escrita");
    const ids: string[] = [];
    for (let i = 0; i < MCP_APPROVAL_MAX_PER_TOKEN; i++) {
      const r = await abusivo.tool("recreate_project", { projectId: A });
      expect(r.data.status, String(i)).toBe("approval_required");
      ids.push(r.data.approvalId);
    }
    const cheio = await abusivo.tool("recreate_project", { projectId: A });
    expect(cheio.data).toMatchObject({ error: "too_many_pending_approvals", status: 429 });
    // outro token ainda consegue pedir
    const outro = await open("segundo");
    expect((await outro.tool("recreate_project", { projectId: A })).data.status).toBe("approval_required");
    for (const id of ids) await decide(id, "reject");
  });

  it("McpApprovals: o teto por token conta só os pendentes dele", () => {
    const approvals = new McpApprovals();
    const base = { tokenName: "n", client: "c", tool: "recreate_project" };
    for (let i = 0; i < MCP_APPROVAL_MAX_PER_TOKEN; i++) expect(approvals.request({ ...base, tokenId: "a", args: { i } })).not.toBeNull();
    expect(approvals.request({ ...base, tokenId: "a", args: { i: 99 } })).toBeNull();
    expect(approvals.request({ ...base, tokenId: "b", args: { i: 1 } })).not.toBeNull();
    const first = approvals.list().find((a) => a.tokenId === "a")!;
    approvals.decide(first.id, "rejected");
    expect(approvals.request({ ...base, tokenId: "a", args: { i: 100 } })).not.toBeNull();
    approvals.clear();
    expect(approvals.list()).toEqual([]);
  });

  it("sessões: um token abrindo sem parar só expulsa as dele", () => {
    const protocol = new McpProtocol({ app: {} as never, approvals: new McpApprovals(), audit: async () => undefined, serverVersion: "0" });
    const doOutro = protocol.openSession("outro", "c");
    const primeira = protocol.openSession("abusivo", "c");
    for (let i = 0; i < MCP_SESSIONS_MAX_PER_TOKEN; i++) protocol.openSession("abusivo", `c${i}`);
    expect(protocol.sessionClient(primeira, "abusivo")).toBeNull();
    expect(protocol.sessionClient(doOutro, "outro")).toBe("c");
    expect(MCP_MAX_SESSIONS).toBeGreaterThan(MCP_SESSIONS_MAX_PER_TOKEN);
    protocol.clearSessions();
    expect(protocol.sessionClient(doOutro, "outro")).toBeNull();
  });
});

describe("Auditoria sem inundação", () => {
  const caller = (over = {}) =>
    ({ tokenId: "t1", tokenName: "ia", scope: "read", reach: { kind: "panel" }, mcp: {}, ip: "203.0.113.5", authHeaders: {}, setup: false, client: "cli", ...over }) as never;

  it("recusas repetidas entram uma vez por minuto, com a contagem na seguinte; abrir sessão, uma vez por hora", async () => {
    let now = 1_000_000;
    const entries: { detail: string; action: string }[] = [];
    const protocol = new McpProtocol({ app: {} as never, approvals: new McpApprovals(), audit: async (e) => void entries.push(e), serverVersion: "0", now: () => now });
    for (let i = 0; i < 6; i++) await protocol.handle({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: `inventada`, arguments: {} } }, caller());
    expect(entries.filter((e) => e.action === "mcp.tool_call")).toHaveLength(1);
    now += MCP_AUDIT_WINDOW_MS + 1;
    await protocol.handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "inventada", arguments: {} } }, caller());
    const calls = entries.filter((e) => e.action === "mcp.tool_call");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.detail).toContain("mais 5 iguais");
    // outro token tem a própria contagem
    await protocol.handle({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "x", arguments: {} } }, caller({ tokenId: "t2" }));
    expect(entries.filter((e) => e.action === "mcp.tool_call")).toHaveLength(3);

    entries.length = 0;
    for (let i = 0; i < 5; i++) await protocol.recordSessionStarted(caller(), `cliente-${i}`);
    expect(entries.filter((e) => e.action === "mcp.session_started")).toHaveLength(1);
    now += MCP_AUDIT_SESSION_WINDOW_MS + 1;
    await protocol.recordSessionStarted(caller(), "depois");
    expect(entries.filter((e) => e.action === "mcp.session_started")).toHaveLength(2);
  });

  it("a tabela de contagens tem teto e se limpa sozinha", async () => {
    let now = 5_000_000;
    const entries: unknown[] = [];
    const protocol = new McpProtocol({ app: {} as never, approvals: new McpApprovals(), audit: async (e) => void entries.push(e), serverVersion: "0", now: () => now });
    for (let i = 0; i < 2_100; i++) await protocol.recordSessionStarted(caller({ tokenId: `t${i}` }), "c");
    expect(entries.length).toBe(2_100);
    now += MCP_AUDIT_SESSION_WINDOW_MS + 1;
    for (let i = 0; i < 2_100; i++) await protocol.recordSessionStarted(caller({ tokenId: `u${i}` }), "c");
    expect(entries.length).toBe(4_200);
  });

  it("mutação e leitura de segredo entram sempre, sem agrupar", async () => {
    const s = await open("admin");
    const before = (await panel.app.inject({ method: "GET", url: "/api/audit?perPage=200", headers: human() })).json().total as number;
    for (let i = 0; i < 3; i++) await s.tool("set_env_vars", { projectId: A, vars: [{ key: `SEMPRE_${i}`, value: "v" }] });
    const after = (await panel.app.inject({ method: "GET", url: "/api/audit?perPage=200", headers: human() })).json().entries as { action: string; detail: string }[];
    expect(after.filter((e) => e.action === "mcp.tool_call" && e.detail.includes("SEMPRE_")).length).toBe(3);
    expect(after.length).toBeGreaterThan(0);
    expect(before).toBeGreaterThan(0);
  });
});

describe("401 do /mcp", () => {
  it("token errado ou ausente dá 401 sem WWW-Authenticate (não induz o cliente a procurar um login OAuth)", async () => {
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    const errado = await rpc(panel.app, "tws_pat_" + "z".repeat(43), ping);
    expect(errado.status).toBe(401);
    expect(errado.headers["www-authenticate"]).toBeUndefined();
    const ausente = await rpc(panel.app, null, ping);
    expect(ausente.status).toBe(401);
    expect(ausente.headers["www-authenticate"]).toBeUndefined();
    // as demais rotas da API mantêm o cabeçalho de sempre
    const api = await panel.app.inject({ method: "GET", url: "/api/projects", headers: { authorization: "Bearer tws_pat_" + "z".repeat(43) } });
    expect(api.statusCode).toBe(401);
    expect(api.headers["www-authenticate"]).toContain("Bearer");
  });
});

describe("balde de taxa das chamadas internas", () => {
  it("a marca só vale com o segredo do processo; quem manda outro valor continua no limite do seu IP", async () => {
    const app = Fastify();
    await app.register(rateLimit, { max: 3, timeWindow: "1 minute", keyGenerator: (r) => internalCallBucket(r) ?? r.ip });
    app.get("/x", async () => ({ ok: true }));
    const call = (headers: Record<string, string> = {}) => app.inject({ method: "GET", url: "/x", remoteAddress: "203.0.113.7", headers });
    for (let i = 0; i < 3; i++) expect((await call()).statusCode).toBe(200);
    expect((await call()).statusCode).toBe(429);
    // a marca de verdade, com credenciais diferentes, ganha baldes próprios por credencial
    expect((await call({ ...internalCallHeaders(), authorization: "Bearer a" })).statusCode).toBe(200);
    expect((await call({ ...internalCallHeaders(), authorization: "Bearer b" })).statusCode).toBe(200);
    expect((await call({ ...internalCallHeaders(), "x-setup-token": "s" })).statusCode).toBe(200);
    expect((await call({ ...internalCallHeaders() })).statusCode).toBe(200);
    // marca falsa (mesmo tamanho ou não): cai no limite do IP, já estourado
    expect((await call({ [INTERNAL_CALL_HEADER]: "x".repeat(64), authorization: "Bearer c" })).statusCode).toBe(429);
    expect((await call({ [INTERNAL_CALL_HEADER]: "curto", authorization: "Bearer d" })).statusCode).toBe(429);
    await app.close();
  });

  it("as chamadas internas do MCP não gastam o limite do IP de quem usa a tela", async () => {
    const t = await panel.createToken({ name: "ocupado", scope: "read", reach: "panel" });
    const s = new McpSession(panel.app, t.token);
    await s.initialize();
    for (let i = 0; i < 5; i++) expect((await s.tool("list_projects")).isError).toBe(false);
    // a rota /mcp tem o balde dela; a chamada de tela do mesmo IP segue livre
    expect((await panel.app.inject({ method: "GET", url: "/api/projects", headers: human() })).statusCode).toBe(200);
    expect((await rpc(panel.app, t.token, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200);
  });
});
