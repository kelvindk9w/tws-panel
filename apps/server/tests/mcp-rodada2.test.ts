/**
 * mcp-rodada2.test.ts — correções da segunda revisão do MCP Fase 1: variável do painel pede aprovação, nomes
 * perigosos (proxy, certificado, JVM, gerenciadores), tela de aprovação com o valor escrito pela IA, leitura de
 * segredo sempre auditada, contagem de repetições que não se perde, log de deploy sem os valores do painel,
 * base64 em todos os alinhamentos e histórico de segurança que o ruído do MCP não empurra para fora.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startRealPanel, type RealPanel } from "./helpers/real-panel.js";
import { McpSession, enableMcp } from "./helpers/mcp-client.js";
import { MCP_TOOLS, envNameCarriesCode } from "../src/services/mcp-tools.js";
import { AuditService, isAuditNoise, trimArchive } from "../src/services/audit-service.js";
import { MCP_AUDIT_WINDOW_MS, McpProtocol } from "../src/services/mcp-protocol.js";
import { McpApprovals } from "../src/services/mcp-approvals.js";
import { secretForms } from "../src/services/log-mask.js";

vi.mock("../src/services/docker-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/docker-service.js")>()),
  listContainers: async () => [],
}));

let panel: RealPanel;
let A = "";
const tokens: Record<string, string> = {};
const human = () => ({ cookie: panel.cookie });

async function open(name: string): Promise<McpSession> {
  const s = new McpSession(panel.app, tokens[name]!);
  await s.initialize("Cliente R2");
  return s;
}
const approvals = async () =>
  (await panel.app.inject({ method: "GET", url: "/api/mcp/approvals", headers: human() })).json().approvals as { id: string; args?: Record<string, string> }[];

beforeAll(async () => {
  panel = await startRealPanel();
  A = await panel.createProject("Fazenda", "fazenda.example.com");
  expect(await enableMcp(panel)).toBe(200);
  for (const [name, body] of Object.entries({
    escrita: { scope: "write", reach: "projects", projects: [A] },
    segredos: { scope: "write", reach: "projects", projects: [A], mcp: { secretsRead: true } },
  })) {
    const res = await panel.createToken({ name, ...body });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    tokens[name] = res.token;
  }
}, 120_000);
afterAll(async () => panel.close());

describe("variável que o painel fornece no deploy", () => {
  it("SMTP_HOST pelo MCP pede aprovação, sem mostrar o valor, e sem aprovação nem a gravação direta passa", async () => {
    const spy = vi.spyOn(panel.app.deployService, "providedEnvKeys").mockResolvedValue(["SMTP_HOST", "SMTP_PASS"]);
    try {
      const s = await open("escrita");
      const args = { projectId: A, vars: [{ key: "SMTP_HOST", value: "atacante.example.com" }] };
      const pedido = await s.tool("set_env_vars", args);
      expect(pedido.data.status).toBe("approval_required");
      const tela = (await approvals()).find((p) => p.id === pedido.data.approvalId)!;
      expect(tela.args?.variables).toContain("substitui um valor existente");
      expect(tela.args?.values).toBe("os valores não são mostrados");
      expect(JSON.stringify(tela.args)).not.toContain("atacante");
      const env = await panel.app.deployService.getEnv(A);
      expect(env.some((v) => v.key === "SMTP_HOST")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("se a aprovação some entre o pedido e a execução, a própria gravação recusa a variável do painel", async () => {
    const spy = vi.spyOn(panel.app.deployService, "providedEnvKeys").mockResolvedValue(["SMTP_PASS"]);
    try {
      const tool = MCP_TOOLS.find((t) => t.name === "set_env_vars")!;
      const caller = { reach: { kind: "panel" }, scope: "write" };
      const args = { projectId: A, vars: [{ key: "SMTP_PASS", value: "x" }] };
      const sem = await tool.run({ app: panel.app, caller, approved: false } as never, args);
      expect(sem).toMatchObject({ ok: false, status: 409, error: "env_provided" });
      const com = await tool.run({ app: panel.app, caller, approved: true } as never, args);
      expect(com.ok).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("nomes de variável que redirecionam a rede ou o interpretador", () => {
  it("proxy, certificados, JVM e gerenciadores de pacote contam como código", () => {
    for (const name of [
      "HTTP_PROXY", "https_proxy", "ALL_PROXY", "no_proxy", "FTP_PROXY", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "NODE_DEBUG",
      "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSL_NO_VERIFY", "PYTHONHTTPSVERIFY",
      "CATALINA_OPTS", "JAVA_OPTS", "MAVEN_OPTS", "GRADLE_OPTS", "COMPOSER_AUTH", "PIP_INDEX_URL", "UV_INDEX_URL", "YARN_NPM_REGISTRY_SERVER",
      "PNPM_HOME", "BUNDLE_GEMFILE", "GEM_HOME", "HOSTALIASES", "RES_OPTIONS", "LOCALDOMAIN", "pip_extra_index_url",
    ]) expect(envNameCarriesCode(name), name).toBe(true);
    for (const name of ["API_KEY", "DATABASE_URL", "PORT", "SMTP_HOST", "MODO"]) expect(envNameCarriesCode(name), name).toBe(false);
  });

  it("a tela mostra o valor que a IA escreveu (cortado) para nome perigoso; segredo existente só mostra o nome", async () => {
    const s = await open("escrita");
    const longo = "http://proxy.example.com:3128/" + "x".repeat(200);
    const pedido = await s.tool("set_env_vars", { projectId: A, vars: [{ key: "HTTPS_PROXY", value: longo }] });
    expect(pedido.data.status).toBe("approval_required");
    const tela = (await approvals()).find((p) => p.id === pedido.data.approvalId)!;
    expect(tela.args?.values).toContain("HTTPS_PROXY = http://proxy.example.com:3128/");
    expect(tela.args?.values!.length).toBeLessThan(longo.length);
    expect(tela.args?.values).toContain("…");
    expect(tela.args?.variables).toContain("redirecionar a rede");
  });
});

describe("leitura de segredo e variável repetida", () => {
  it("toda leitura de get_env_value vai para a Auditoria: duas seguidas, duas entradas", async () => {
    const s = await open("segredos");
    await s.tool("set_env_vars", { projectId: A, vars: [{ key: "CHAVE_R2", value: "valor-r2-123" }] });
    const antes = (await panel.app.inject({ method: "GET", url: "/api/audit?perPage=200", headers: human() })).json().entries as { action: string; actor: string; detail: string }[];
    const conta = (list: typeof antes) => list.filter((e) => e.actor === "token:segredos" && e.detail.includes("get_env_value")).length;
    expect((await s.tool("get_env_value", { projectId: A, name: "CHAVE_R2" })).data.value).toBe("valor-r2-123");
    expect((await s.tool("get_env_value", { projectId: A, name: "CHAVE_R2" })).data.value).toBe("valor-r2-123");
    const depois = (await panel.app.inject({ method: "GET", url: "/api/audit?perPage=200", headers: human() })).json().entries as typeof antes;
    expect(conta(depois) - conta(antes)).toBe(2);
  });

  it("repetir a mesma variável com o mesmo valor não grava nada na Auditoria da variável", async () => {
    const s = await open("escrita");
    const vars = [{ key: "IGUAL_R2", value: "mesmo-valor-1" }];
    expect((await s.tool("set_env_vars", { projectId: A, vars })).isError).toBe(false);
    const total = async () =>
      ((await panel.app.inject({ method: "GET", url: "/api/audit?perPage=200", headers: human() })).json().entries as { action: string }[]).filter((e) => e.action === "project.env_updated").length;
    const antes = await total();
    expect((await s.tool("set_env_vars", { projectId: A, vars })).isError).toBe(false);
    expect(await total()).toBe(antes);
  });
});

describe("Auditoria: contagem de repetições e histórico de segurança", () => {
  const caller = { tokenId: "t1", tokenName: "ia", scope: "read", reach: { kind: "panel" }, mcp: {}, ip: "203.0.113.5", authHeaders: {}, setup: false, client: "cli" } as never;

  it("a contagem de repetidas é gravada ao fechar a janela, mesmo que o ataque pare; ferramentas diferentes têm chaves próprias", async () => {
    let now = 1_000_000;
    const entries: { detail: string }[] = [];
    const protocol = new McpProtocol({ app: {} as never, approvals: new McpApprovals(), audit: async (e) => void entries.push(e), serverVersion: "0", now: () => now });
    const call = (name: string) => protocol.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }, caller);
    for (let i = 0; i < 4; i++) await call("inventada_a");
    await call("inventada_b");
    expect(entries).toHaveLength(2);
    now += MCP_AUDIT_WINDOW_MS + 1;
    await protocol.flushAudit();
    expect(entries).toHaveLength(3);
    expect(entries[2]!.detail).toContain("mais 3 iguais");
    await protocol.flushAudit();
    expect(entries).toHaveLength(3);
  });

  it("o timer da janela grava a contagem sozinho", async () => {
    vi.useFakeTimers();
    try {
      const entries: { detail: string }[] = [];
      const protocol = new McpProtocol({ app: {} as never, approvals: new McpApprovals(), audit: async (e) => void entries.push(e), serverVersion: "0" });
      const call = () => protocol.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x_y", arguments: {} } }, caller);
      await call();
      await call();
      await call();
      expect(entries).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(MCP_AUDIT_WINDOW_MS + 200);
      expect(entries).toHaveLength(2);
      expect(entries[1]!.detail).toContain("mais 2 iguais");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ao estourar o teto do arquivo morto saem primeiro as entradas de ruído do MCP", async () => {
    const entry = (i: number, action: string) => ({ id: String(i), at: "2026-10-26T00:00:00Z", actor: "a", action, target: null, detail: "" });
    expect(isAuditNoise("mcp.tool_call")).toBe(true);
    expect(isAuditNoise("mcp.approval_approved")).toBe(false);
    const todas = [entry(1, "auth.login"), entry(2, "mcp.tool_call"), entry(3, "mcp.enabled"), entry(4, "mcp.tool_call"), entry(5, "auth.api_token_created")];
    expect(trimArchive(todas, 10)).toHaveLength(5);
    expect(trimArchive(todas, 3).map((e) => e.id)).toEqual(["1", "3", "5"]);
    // só segurança acima do teto: saem as mais antigas
    expect(trimArchive([entry(1, "auth.login"), entry(2, "auth.login"), entry(3, "auth.login")], 2).map((e) => e.id)).toEqual(["2", "3"]);

    const dir = await mkdtemp(path.join(tmpdir(), "paas-audit-r2-"));
    try {
      const audit = new AuditService(dir, { maxEntries: 3, maxArchivedEntries: 4 });
      await audit.record({ actor: "x", action: "auth.login", detail: "primeiro" });
      for (let i = 0; i < 12; i++) await audit.record({ actor: "x", action: "mcp.tool_call", detail: `ruido ${i}` });
      await audit.record({ actor: "x", action: "mcp.disabled", detail: "desligou" });
      for (let i = 0; i < 12; i++) await audit.record({ actor: "x", action: "mcp.tool_call", detail: `ruido b${i}` });
      const { readFile } = await import("node:fs/promises");
      const arquivo = JSON.parse(await readFile(path.join(dir, "audit.1.json"), "utf8")).entries as { action: string }[];
      expect(arquivo.some((e) => e.action === "auth.login")).toBe(true);
      expect(arquivo.some((e) => e.action === "mcp.disabled")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("máscara dos logs", () => {
  it("o log de deploy também esconde os valores que o painel fornece (SMTP_PASS)", async () => {
    const valor = "SenhaDaCaixaDoPainel-9";
    const s = await open("escrita");
    const logSecrets = vi.spyOn(panel.app.deployService, "logSecretValues").mockResolvedValue([valor]);
    const job = { id: "j2", projectId: A, status: "success", log: [`SMTP_PASS=${valor}`, `outra ${valor} linha`] };
    const spy = vi.spyOn(panel.app.deployService, "getJob").mockResolvedValue(job as never);
    const res = await s.tool("get_deploy", { projectId: A, jobId: "j2" });
    spy.mockRestore();
    expect(JSON.stringify(res.raw.json.result)).not.toContain(valor);
    // sem saber os valores, o log não sai
    logSecrets.mockRejectedValue(new Error("cofre quebrado"));
    const spy2 = vi.spyOn(panel.app.deployService, "getJob").mockResolvedValue(job as never);
    const falha = await s.tool("get_deploy", { projectId: A, jobId: "j2" });
    spy2.mockRestore();
    logSecrets.mockRestore();
    expect(falha.isError).toBe(true);
    expect(falha.data.error).toBe("logs_unavailable");
    expect(JSON.stringify(falha.raw.json.result)).not.toContain(valor);
  });

  it("o valor emendado depois de 1 ou 2 bytes de outro texto, em base64, também é reconhecido", () => {
    const valor = "SenhaMuitoSecreta-123";
    const formas = secretForms([valor]);
    for (const prefixo of ["", "a", "ab"]) {
      for (const sufixo of ["", "z", "zz"]) {
        const b64 = Buffer.from(prefixo + valor + sufixo).toString("base64");
        expect(formas.some((f) => b64.includes(f)), `${prefixo}|${sufixo}`).toBe(true);
      }
    }
  });
});
