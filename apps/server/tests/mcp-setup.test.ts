/**
 * mcp-setup.test.ts — o MCP durante a instalação (setup token com PAAS_MCP_SETUP_LEVEL) e a leitura da variável.
 * Painel real SEM conta criada: só o setup token abre a porta, e só se quem instala escolheu um nível.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { McpSession, rpc } from "./helpers/mcp-client.js";
import { SETUP } from "./helpers/real-panel.js";
import { deriveMcpSetupCredential } from "../src/services/setup-token.js";

/** O que a IA recebe na instalação: derivada do setup token, só vale no /mcp. */
const CRED = deriveMcpSetupCredential(SETUP);

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

  async function boot(level: string | null) {
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

  it("sem nível escolhido, o /mcp nem existe durante a instalação (404, e o setup token não abre nada)", async () => {
    const panel = await boot(null);
    expect((await rpc(panel, CRED, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(404);
  });

  it("com o nível escolhido o setup token abre o /mcp MESMO com a chave da tela desligada (ainda não há conta para ligá-la)", async () => {
    const panel = await boot("read");
    expect(panel.mcpSettings.enabled()).toBe(false);
    expect((await rpc(panel, CRED, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(200);
  });

  it("token errado, cookie, Basic e sem credencial recebem 401 (e nunca o WWW-Authenticate que dispara OAuth)", async () => {
    const panel = await boot("read");
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    for (const token of ["tws_pat_" + "x".repeat(43), "outro-valor"]) {
      const res = await rpc(panel, token, ping);
      expect(res.status).toBe(401);
      expect(res.headers["www-authenticate"]).toBeUndefined();
    }
    const semCredencial = await rpc(panel, null, ping);
    expect(semCredencial.status).toBe(401);
    expect(semCredencial.headers["www-authenticate"]).toBeUndefined();
    const cookie = await rpc(panel, null, ping, { headers: { cookie: "paas_session=abc" } });
    expect(cookie.status).toBe(401);
    const basic = await rpc(panel, null, ping, { headers: { authorization: `Basic ${Buffer.from(`admin:${SETUP}`).toString("base64")}` } });
    expect(basic.status).toBe(401);
    // o setup token no cabeçalho do wizard (não é Bearer) também não abre o /mcp
    const cabecalho = await rpc(panel, null, ping, { headers: { "x-setup-token": SETUP } });
    expect(cabecalho.status).toBe(401);
  });

  it("o setup token abre no nível escolhido, com alcance de painel e sem opções", async () => {
    const panel = await boot("read");
    const session = new McpSession(panel, CRED);
    expect((await session.initialize("instalador-ia")).status).toBe(200);
    const info = await session.tool("get_access_info");
    expect(info.isError).toBe(false);
    expect(info.data).toMatchObject({ level: "read" });
    const tools = (await session.call("tools/list")).json.result.tools.map((t: { name: string }) => t.name);
    expect(tools).toContain("list_projects");
    expect(tools).not.toContain("create_project");
    expect(tools).not.toContain("get_env_value");
  });

  it("no nível admin as ferramentas de administração aparecem, e as sensíveis são recusadas: não há quem aprove", async () => {
    const panel = await boot("admin");
    const session = new McpSession(panel, CRED);
    await session.initialize();
    const tools = (await session.call("tools/list")).json.result.tools.map((t: { name: string }) => t.name);
    expect(tools).toContain("create_project");
    expect(tools).toContain("recreate_project");
    const sensitive = await session.tool("recreate_project", { projectId: "inexistente" });
    expect(sensitive.isError).toBe(true);
    expect(sensitive.data).toMatchObject({ error: "approval_unavailable_during_setup", status: 403 });
    // aplicar segurança de verdade: o token do setup não tem a opção, então é recusado antes de pedir aprovação
    const apply = await session.tool("security_apply", { phase: "02", dryRun: false });
    expect(apply.isError).toBe(true);
    expect(apply.data.error).toBe("security_apply_disabled");
    // trocar domínio é sensível: também sem aprovação possível
    const dominio = await session.tool("update_project", { projectId: "inexistente", domain: "outro.example.com" });
    expect(dominio.data.error).toBe("approval_unavailable_during_setup");
    expect(session.session).not.toBe("");
  });

  it("terminada a instalação o setup token deixa de valer e o MCP volta a seguir a chave da tela (desligada: 404)", async () => {
    const panel = await boot("admin");
    const session = new McpSession(panel, CRED);
    await session.initialize();
    const created = await panel.inject({ method: "POST", url: "/api/setup/admin", headers: { [SETUP_TOKEN_HEADER]: SETUP }, payload: { username: "admin", password: "MinhaSenha123" } });
    expect(created.statusCode).toBe(201);
    // a chave da tela começa desligada: a porta some, nem o token de setup nem outro a encontram
    expect(panel.mcpSettings.enabled()).toBe(false);
    expect((await rpc(panel, CRED, { jsonrpc: "2.0", id: 9, method: "ping" })).status).toBe(404);
    // ligada pela tela, o setup token continua sem valer (é um token de API que a pessoa cria)
    await panel.mcpSettings.set(true);
    expect((await rpc(panel, CRED, { jsonrpc: "2.0", id: 9, method: "ping" })).status).toBe(401);
  });

  it("a credencial derivada vale só no /mcp: o setup token cru é recusado ali, e ela não abre /api nem o assistente", async () => {
    const panel = await boot("admin");
    expect(CRED).not.toBe(SETUP);
    // o setup token cru não abre o /mcp
    expect((await rpc(panel, SETUP, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
    // a derivada não abre nenhuma rota da API, nem como Bearer nem em x-setup-token (inclusive o assistente que cria a conta)
    for (const headers of [{ authorization: `Bearer ${CRED}` }, { [SETUP_TOKEN_HEADER]: CRED }]) {
      expect((await panel.inject({ method: "GET", url: "/api/projects", headers })).statusCode).toBe(401);
      expect((await panel.inject({ method: "GET", url: "/api/setup/status", headers })).statusCode).toBe(401);
      const criar = await panel.inject({ method: "POST", url: "/api/setup/admin", headers, payload: { username: "admin", password: "MinhaSenha123" } });
      expect(criar.statusCode).toBe(401);
    }
    // o servidor deixa a credencial num arquivo 0600 ao lado do setup token, e o apaga ao concluir
    const file = path.join(dir, "mcp-setup-credential");
    expect(readFileSync(file, "utf8")).toBe(CRED);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const created = await panel.inject({ method: "POST", url: "/api/setup/admin", headers: { [SETUP_TOKEN_HEADER]: SETUP }, payload: { username: "admin", password: "MinhaSenha123" } });
    expect(created.statusCode).toBe(201);
    expect(existsSync(file)).toBe(false);
  });

  it("se apagar o setup token falhar, a credencial derivada ainda é apagada (cada arquivo no seu try)", async () => {
    const panel = await boot("admin");
    await rm(path.join(dir, "setup-token"), { force: true });
    await mkdir(path.join(dir, "setup-token"));
    expect(existsSync(path.join(dir, "mcp-setup-credential"))).toBe(true);
    const created = await panel.inject({ method: "POST", url: "/api/setup/admin", headers: { [SETUP_TOKEN_HEADER]: SETUP }, payload: { username: "admin", password: "MinhaSenha123" } });
    expect(created.statusCode).toBe(201);
    expect(existsSync(path.join(dir, "mcp-setup-credential"))).toBe(false);
  });

  it("o docker-compose repassa PAAS_MCP_SETUP_LEVEL ao container, vazio por padrão", () => {
    const compose = readFileSync(path.join(__dirname, "../../../docker-compose.yml"), "utf8");
    expect(compose).toMatch(/PAAS_MCP_SETUP_LEVEL:\s*\$\{PAAS_MCP_SETUP_LEVEL:-\}/);
  });
});
