/**
 * mcp-setup.test.ts — o MCP durante a instalação (setup token com PAAS_MCP_SETUP_LEVEL) e a leitura da variável.
 * Painel real SEM conta criada: só o setup token abre a porta, e só se quem instala escolheu um nível.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { McpSession, rpc } from "./helpers/mcp-client.js";
import { SETUP } from "./helpers/real-panel.js";

const KEYS = ["RATE_LIMIT_MAX", "PAAS_DATA_DIR", "SETUP_TOKEN_FILE", "PAAS_PUBLIC_IP", "LOG_LEVEL", "DOCKER_HOST", "DOCKER_SOCKET_PATH", "PAAS_PROJECTS_DIR", "PAAS_MCP_SETUP_LEVEL"] as const;

describe("PAAS_MCP_SETUP_LEVEL (config)", () => {
  const saved = process.env.PAAS_MCP_SETUP_LEVEL;
  afterEach(() => {
    if (saved === undefined) delete process.env.PAAS_MCP_SETUP_LEVEL;
    else process.env.PAAS_MCP_SETUP_LEVEL = saved;
  });

  it("só read, write e admin valem (sem diferenciar maiúsculas); o resto é desligado", () => {
    for (const [value, expected] of [["read", "read"], [" Write ", "write"], ["ADMIN", "admin"], ["root", null], ["", null], ["todos", null]] as const) {
      process.env.PAAS_MCP_SETUP_LEVEL = value;
      expect(loadConfig().mcpSetupLevel, value).toBe(expected);
    }
    delete process.env.PAAS_MCP_SETUP_LEVEL;
    expect(loadConfig().mcpSetupLevel).toBeNull();
  });
});

describe("MCP com o setup token", () => {
  let dir: string;
  let app: FastifyInstance | null = null;
  const saved: Record<string, string | undefined> = {};

  async function boot(level: string | null, enable = true) {
    dir = await mkdtemp(path.join(tmpdir(), "paas-mcp-setup-"));
    await writeFile(path.join(dir, "setup-token"), SETUP);
    for (const k of KEYS) saved[k] = process.env[k];
    Object.assign(process.env, {
      RATE_LIMIT_MAX: "1000000",
      PAAS_DATA_DIR: dir,
      SETUP_TOKEN_FILE: path.join(dir, "setup-token"),
      PAAS_PUBLIC_IP: "203.0.113.10",
      LOG_LEVEL: "silent",
      DOCKER_HOST: "unix:///nonexistent/docker.sock",
      DOCKER_SOCKET_PATH: "/nonexistent/docker.sock",
      PAAS_PROJECTS_DIR: path.join(dir, "projects"),
    });
    if (level === null) delete process.env.PAAS_MCP_SETUP_LEVEL;
    else process.env.PAAS_MCP_SETUP_LEVEL = level;
    app = await buildApp();
    await app.ready();
    if (enable) await app.mcpSettings.set(true);
    return app;
  }

  beforeEach(() => {
    app = null;
  });
  afterEach(async () => {
    await app?.close();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("sem nível escolhido, o setup token não abre o /mcp (401)", async () => {
    const panel = await boot(null);
    const res = await rpc(panel, SETUP, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(res.status).toBe(401);
  });

  it("com MCP desligado nem o setup token enxerga a porta (404)", async () => {
    const panel = await boot("admin", false);
    expect((await rpc(panel, SETUP, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(404);
  });

  it("token errado = 401; o certo abre no nível escolhido, com alcance de painel e sem opções", async () => {
    const panel = await boot("read");
    expect((await rpc(panel, "tws_pat_" + "x".repeat(43), { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    expect((await rpc(panel, "outro-valor", { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    const session = new McpSession(panel, SETUP);
    expect((await session.initialize("instalador-ia")).status).toBe(200);
    const info = await session.tool("get_access_info");
    expect(info.isError).toBe(false);
    expect(info.data).toMatchObject({ level: "read" });
    const tools = (await session.call("tools/list")).json.result.tools.map((t: { name: string }) => t.name);
    expect(tools).toContain("list_projects");
    expect(tools).not.toContain("create_project");
    expect(tools).not.toContain("get_env_value");
  });

  it("no nível admin as ferramentas de administração aparecem, e as sensíveis não têm como ser aprovadas", async () => {
    const panel = await boot("admin");
    const session = new McpSession(panel, SETUP);
    await session.initialize();
    const tools = (await session.call("tools/list")).json.result.tools.map((t: { name: string }) => t.name);
    expect(tools).toContain("create_project");
    expect(tools).toContain("recreate_project");
    const sensitive = await session.tool("recreate_project", { project: "inexistente" });
    expect(sensitive.isError).toBe(true);
  });
});
