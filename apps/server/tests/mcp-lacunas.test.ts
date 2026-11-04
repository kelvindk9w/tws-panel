/**
 * mcp-lacunas.test.ts — caminhos de falha do MCP que o uso normal não alcança: ferramenta que lança,
 * disco ilegível ao ler variável, teto de sessões abertas.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startRealPanel, type RealPanel } from "./helpers/real-panel.js";
import { McpSession, enableMcp } from "./helpers/mcp-client.js";
import { MCP_TOOLS } from "../src/services/mcp-tools.js";
import { MCP_MAX_SESSIONS, McpProtocol } from "../src/services/mcp-protocol.js";
import { McpApprovals } from "../src/services/mcp-approvals.js";

vi.mock("../src/services/docker-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/docker-service.js")>()),
  listContainers: async () => [],
}));

let panel: RealPanel;
let A = "";
let token = "";

beforeAll(async () => {
  panel = await startRealPanel();
  A = await panel.createProject("Fazenda", "fazenda.example.com");
  expect(await enableMcp(panel)).toBe(200);
  const res = await panel.createToken({ name: "lacunas", scope: "write", reach: "projects", projects: [A], mcp: { secretsRead: true } });
  expect(res.status).toBe(201);
  token = res.token;
}, 120_000);
afterAll(async () => panel.close());

describe("falhas internas", () => {
  it("ferramenta que lança vira erro interno claro, sem vazar o motivo, e a chamada fica na Auditoria", async () => {
    const s = new McpSession(panel.app, token);
    await s.initialize();
    const tool = MCP_TOOLS.find((t) => t.name === "get_access_info")!;
    const spy = vi.spyOn(tool, "run").mockRejectedValueOnce(new Error("segredo-interno /opt/x"));
    const res = await s.tool("get_access_info");
    spy.mockRestore();
    expect(res.isError).toBe(true);
    expect(res.data).toMatchObject({ error: "internal_error" });
    expect(JSON.stringify(res.raw.json)).not.toContain("segredo-interno");
    const audit = (await panel.app.inject({ method: "GET", url: "/api/audit?perPage=50", headers: { cookie: panel.cookie } })).json().entries as { action: string; detail: string }[];
    expect(audit.some((e) => e.action === "mcp.tool_call" && e.detail.includes("erro internal_error"))).toBe(true);
  });

  it("get_env_value com o armazenamento falhando devolve o erro da falha", async () => {
    const s = new McpSession(panel.app, token);
    await s.initialize();
    const spy = vi.spyOn(panel.app.deployService, "getEnv").mockRejectedValueOnce(new Error("disco ilegível"));
    const res = await s.tool("get_env_value", { projectId: A, name: "API_KEY" });
    spy.mockRestore();
    expect(res.isError).toBe(true);
  });
});

describe("sessões", () => {
  it("passado o teto, a mais antiga sai; sessões ociosas por mais de um dia também", async () => {
    let now = 1_000_000;
    const protocol = new McpProtocol({ app: panel.app, approvals: new McpApprovals(), audit: async () => undefined, serverVersion: "0", now: () => now });
    const first = protocol.openSession("t", "primeira");
    for (let i = 1; i < MCP_MAX_SESSIONS; i++) {
      now += 1;
      protocol.openSession("t", `c${i}`);
    }
    now += 1;
    const extra = protocol.openSession("t", "extra");
    expect(extra).toHaveLength(48);
    expect(protocol.sessionClient(first, "t") !== null).toBe(false);
    expect(protocol.sessionClient(extra, "t") !== null).toBe(true);
    now += 25 * 3_600_000;
    protocol.openSession("t", "depois-de-um-dia");
    expect(protocol.sessionClient(extra, "t") !== null).toBe(false);
  });
});
