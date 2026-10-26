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
import { ENV_REVIEW_MAX, MCP_TOOLS, envNameCarriesCode, visibleValue } from "../src/services/mcp-tools.js";
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
      // a pessoa vê o valor NOVO que a IA escreveu: é ele que decide se aprova
      expect(tela.args?.values).toBe("SMTP_HOST [20 caracteres] = atacante.example.com");
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

  it("a tela mostra o valor NOVO inteiro: um trecho malicioso depois de 80 caracteres de enchimento aparece", async () => {
    const s = await open("escrita");
    const malicioso = "--import=data:text/javascript,console.log(1)";
    const valor = "--max-old-space-size=4096 ".repeat(5) + malicioso;
    expect(valor.length).toBeGreaterThan(80);
    const pedido = await s.tool("set_env_vars", { projectId: A, vars: [{ key: "NODE_OPTIONS", value: valor }] });
    expect(pedido.data.status).toBe("approval_required");
    const tela = (await approvals()).find((p) => p.id === pedido.data.approvalId)!;
    expect(tela.args?.values).toBe(`NODE_OPTIONS [${valor.length} caracteres] = ${valor}`);
    expect(tela.args?.values).toContain(malicioso);
    expect(tela.args?.variables).toContain("ALERTA: este nome muda a execução ou a rede");
  });

  it("variável perigosa que já existe: aparece o valor novo, nunca o antigo", async () => {
    await panel.app.deployService.mergeEnv(A, [{ key: "NODE_OPTIONS", value: "--antigo-valor-123" }], { allowOverwrite: true });
    const s = await open("escrita");
    const novo = "--import=data:text/javascript,console.log(2)";
    const pedido = await s.tool("set_env_vars", { projectId: A, vars: [{ key: "NODE_OPTIONS", value: novo }] });
    expect(pedido.data.status).toBe("approval_required");
    const tela = (await approvals()).find((p) => p.id === pedido.data.approvalId)!;
    expect(tela.args?.variables).toContain("substitui um valor existente");
    expect(tela.args?.values).toBe(`NODE_OPTIONS [${novo.length} caracteres] = ${novo}`);
    expect(JSON.stringify(tela.args)).not.toContain("antigo-valor");
  });

  it("valor acima do teto: o servidor recusa abrir o pedido (a aprovação nem é possível)", async () => {
    const s = await open("escrita");
    const antes = (await approvals()).length;
    const valor = "a".repeat(ENV_REVIEW_MAX) + "--import=escondido";
    const recusa = await s.tool("set_env_vars", { projectId: A, vars: [{ key: "HTTP_PROXY", value: valor }] });
    expect(recusa.isError).toBe(true);
    expect(recusa.data.error).toBe("value_too_long_to_review");
    expect((await approvals()).length).toBe(antes);
    // no teto exato ainda cabe
    const cabe = await s.tool("set_env_vars", { projectId: A, vars: [{ key: "HTTP_PROXY", value: "a".repeat(ENV_REVIEW_MAX) }] });
    expect(cabe.data.status).toBe("approval_required");
  });

  it("variável comum que troca um segredo da pessoa também mostra o valor novo (nunca o antigo)", async () => {
    await panel.app.deployService.mergeEnv(A, [{ key: "SEGREDO_R3", value: "valor-antigo-r3" }], { allowOverwrite: true });
    const s = await open("escrita");
    const pedido = await s.tool("set_env_vars", { projectId: A, vars: [{ key: "SEGREDO_R3", value: "valor-novo-r3" }] });
    const tela = (await approvals()).find((p) => p.id === pedido.data.approvalId)!;
    expect(tela.args?.values).toBe("SEGREDO_R3 [13 caracteres] = valor-novo-r3");
    expect(JSON.stringify(tela.args)).not.toContain("antigo");
  });

  it("espaços repetidos e caracteres invisíveis aparecem escritos, e o tamanho é mostrado", () => {
    expect(visibleValue("a    b")).toBe("a\u2420\u00d74b");
    expect(visibleValue("a b")).toBe("a b");
    expect(visibleValue("x\u200by\u202ez\u0000\n\u{e0041}")).toBe("x\\u{200b}y\\u{202e}z\\u{0}\\u{a}\\u{e0041}");
    expect(visibleValue("normal=1")).toBe("normal=1");
  });
});

describe("toda escrita de variável pelo MCP passa por uma pessoa", () => {
  it("OPENAI_BASE_URL nova (nome fora de qualquer lista) pede aprovação e mostra o valor", async () => {
    const t = await panel.createToken({ name: "escrita-r4", scope: "write", reach: "projects", projects: [A] });
    const s = new McpSession(panel.app, t.token);
    await s.initialize("c");
    const pedido = await s.tool("set_env_vars", { projectId: A, vars: [{ key: "OPENAI_BASE_URL", value: "https://atacante.example.com/v1" }, { key: "API_URL", value: "https://outro.example.com" }] });
    expect(pedido.data.status).toBe("approval_required");
    const tela = (await approvals()).find((p) => p.id === pedido.data.approvalId)!;
    expect(tela.args?.values).toContain("OPENAI_BASE_URL [31 caracteres] = https://atacante.example.com/v1");
    expect(tela.args?.values).toContain("API_URL");
    expect((await panel.app.deployService.getEnv(A)).some((v) => v.key === "OPENAI_BASE_URL")).toBe(false);
  });

  it("o token que dispensa a aprovação (opção do dono) grava direto", async () => {
    const t = await panel.createToken({ name: "dispensa-r4", scope: "write", reach: "projects", projects: [A], mcp: { skipApproval: true } });
    const s = new McpSession(panel.app, t.token);
    await s.initialize("c");
    expect((await s.tool("set_env_vars", { projectId: A, vars: [{ key: "DIRETA_R4", value: "1" }] })).isError).toBe(false);
  });
});

describe("leitura de segredo e variável repetida", () => {
  it("toda leitura de get_env_value vai para a Auditoria: duas seguidas, duas entradas", async () => {
    const s = await open("segredos");
    await panel.app.deployService.mergeEnv(A, [{ key: "CHAVE_R2", value: "valor-r2-123" }], { allowOverwrite: true });
    const antes = (await panel.app.inject({ method: "GET", url: "/api/audit?perPage=200", headers: human() })).json().entries as { action: string; actor: string; detail: string }[];
    const conta = (list: typeof antes) => list.filter((e) => e.action === "mcp.secret_read" && e.actor === "token:segredos" && e.detail.includes("get_env_value")).length;
    expect((await s.tool("get_env_value", { projectId: A, name: "CHAVE_R2" })).data.value).toBe("valor-r2-123");
    expect((await s.tool("get_env_value", { projectId: A, name: "CHAVE_R2" })).data.value).toBe("valor-r2-123");
    const depois = (await panel.app.inject({ method: "GET", url: "/api/audit?perPage=200", headers: human() })).json().entries as typeof antes;
    expect(conta(depois) - conta(antes)).toBe(2);
  });

  it("mesclar a mesma variável com o mesmo valor não grava nada na Auditoria da variável", async () => {
    const vars = [{ key: "IGUAL_R2", value: "mesmo-valor-1" }];
    await panel.app.deployService.mergeEnv(A, vars, { allowOverwrite: true });
    const total = async () =>
      ((await panel.app.inject({ method: "GET", url: "/api/audit?perPage=200", headers: human() })).json().entries as { action: string }[]).filter((e) => e.action === "project.env_updated").length;
    const antes = await total();
    await panel.app.deployService.mergeEnv(A, vars, { allowOverwrite: false });
    expect(await total()).toBe(antes);
  });
});

describe("Auditoria: contagem de repetições e histórico de segurança", () => {
  const caller = { tokenId: "t1", tokenName: "ia", scope: "read", reach: { kind: "panel" }, mcp: {}, ip: "203.0.113.5", authHeaders: {}, setup: false, client: "cli" } as never;

  it("a contagem de repetidas é gravada ao fechar a janela, mesmo que o ataque pare; ferramentas inventadas diferentes entram na mesma contagem do token", async () => {
    let now = 1_000_000;
    const entries: { detail: string }[] = [];
    const protocol = new McpProtocol({ app: {} as never, approvals: new McpApprovals(), audit: async (e) => void entries.push(e), serverVersion: "0", now: () => now });
    const call = (name: string) => protocol.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }, caller);
    for (let i = 0; i < 4; i++) await call("inventada_a");
    await call("inventada_b");
    expect(entries).toHaveLength(1);
    now += MCP_AUDIT_WINDOW_MS + 1;
    await protocol.flushAudit();
    expect(entries).toHaveLength(2);
    expect(entries[1]!.detail).toContain("mais 4 iguais");
    await protocol.flushAudit();
    expect(entries).toHaveLength(2);
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
    // cotas independentes: a humana (1, 3, 5) cabe; a de token (metade do teto) fica com o ruído mais novo
    expect(trimArchive(todas, 3).map((e) => e.id)).toEqual(["1", "3", "4", "5"]);
    // 22 mil chamadas inventadas (ruído) não apagam a leitura de um segredo, um deploy nem a ação aprovada, todos antigos e do mesmo token
    const rastro = [
      { ...entry(1, "mcp.secret_read"), actor: "token:ia" },
      { ...entry(2, "deploy.blocked"), actor: "token:ia" },
      { ...entry(3, "mcp.tool_changed"), actor: "token:ia" },
      { ...entry(4, "mcp.approval_approved"), actor: "kelvin" },
      { ...entry(5, "auth.login"), actor: "kelvin" },
    ];
    const muitas = [...rastro, ...Array.from({ length: 22_000 }, (_, i) => ({ ...entry(100 + i, "mcp.tool_call"), actor: "token:ia" }))];
    const cortadas = trimArchive(muitas, 20_000);
    expect(cortadas).toHaveLength(10_003);
    expect(cortadas.slice(0, 5).map((e) => e.id)).toEqual(["1", "2", "3", "4", "5"]);
    // 30 mil escritas protegidas de um token (renomear sem parar) não apagam o login humano nem o `mcp.enabled` antigos
    const humano = [{ ...entry(1, "auth.login"), actor: "kelvin" }, { ...entry(2, "mcp.enabled"), actor: "kelvin" }, { ...entry(3, "mcp.enabled"), actor: "token:ia" }];
    const escritas = Array.from({ length: 30_000 }, (_, i) => ({ ...entry(100 + i, "mcp.tool_changed"), actor: "token:ia" }));
    const sobra = trimArchive([...humano, ...escritas], 20_000);
    expect(sobra.slice(0, 3).map((e) => e.id)).toEqual(["1", "2", "3"]);
    expect(sobra.filter((e) => e.action === "mcp.tool_changed")).toHaveLength(10_000);
    expect(sobra.at(-1)!.id).toBe(String(100 + 29_999));
    // dentro da cota de token, o ruído sai antes das escritas
    const misto = [{ ...entry(1, "mcp.tool_changed"), actor: "token:ia" }, ...Array.from({ length: 11 }, (_, i) => ({ ...entry(10 + i, "mcp.tool_call"), actor: "token:ia" }))];
    expect(trimArchive(misto, 20).map((e) => e.id)[0]).toBe("1");
    expect(trimArchive(misto, 20)).toHaveLength(10);
    // só segurança acima do teto: saem as mais antigas
    expect(trimArchive([entry(1, "auth.login"), entry(2, "auth.login"), entry(3, "auth.login")], 2).map((e) => e.id)).toEqual(["2", "3"]);

    const dir = await mkdtemp(path.join(tmpdir(), "paas-audit-r2-"));
    try {
      const audit = new AuditService(dir, { maxEntries: 3, maxArchivedEntries: 4 });
      await audit.record({ actor: "x", action: "auth.login", detail: "primeiro" });
      for (let i = 0; i < 12; i++) await audit.record({ actor: "x", action: "mcp.tool_call", detail: `ruido ${i}` });
      await audit.record({ actor: "x", action: "mcp.disabled", detail: "desligou" });
      for (let i = 0; i < 12; i++) await audit.record({ actor: "x", action: "mcp.tool_call", detail: `ruido b${i}` });
      // as cotas valem também no arquivo ativo (o que a tela mostra): o histórico humano continua à vista
      const tela = (await audit.list(1, 200)).entries.map((e) => e.action);
      expect(tela).toContain("auth.login");
      expect(tela).toContain("mcp.disabled");
      expect(tela.filter((a) => a === "mcp.tool_call").length).toBeLessThanOrEqual(1);
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

describe("escape de espaços que não se veem", () => {
  it("NBSP, braille em branco, hangul de preenchimento e afins viram escape; 3000 NBSP viram um aviso só", () => {
    const nbsp = "\u00a0".repeat(3000);
    const out = visibleValue(`--title="app${nbsp}" --import=x`);
    expect(out).toBe('--title="app\\u{a0}\u00d73000" --import=x');
    expect(out.length).toBeLessThan(60);
    expect(visibleValue("a\u2800b")).toBe("a\\u{2800}b");
    expect(visibleValue("a\u3164b\uffa0c")).toBe("a\\u{3164}b\\u{ffa0}c");
    expect(visibleValue("a\u2003\u2002b")).toBe("a\\u{2003}\\u{2002}b");
    // espaço comum isolado fica; misturado com invisível, tudo é escrito
    expect(visibleValue("a b")).toBe("a b");
    expect(visibleValue("a \u00a0b")).toBe("a\\u{20}\\u{a0}b");
  });
});

describe("escrita repetida pelo mesmo token", () => {
  it("renomear sem parar grava uma entrada por minuto, com a contagem depois; leitura de segredo não se agrega", async () => {
    const t = await panel.createToken({ name: "renomeia", scope: "write", reach: "projects", projects: [A] });
    const s = new McpSession(panel.app, t.token);
    await s.initialize("c");
    for (let i = 0; i < 6; i++) expect((await s.tool("update_project", { projectId: A, name: `Fazenda ${i}` })).isError).toBe(false);
    const lista = async () => ((await panel.app.inject({ method: "GET", url: "/api/audit?perPage=200", headers: human() })).json().entries as { action: string; actor: string; detail: string }[]).filter((e) => e.actor === "token:renomeia" && e.action === "mcp.tool_changed");
    const todas = await lista();
    expect(todas.filter((e) => !/iguais/.test(e.detail))).toHaveLength(1);
    expect(todas.filter((e) => /mais 5 iguais/.test(e.detail))).toHaveLength(1);
  });
});

describe("add_domain e os tetos de certificados", () => {
  it("o MCP passa pela rota, que gasta a mesma cota semanal dos domínios dinâmicos: depois do teto, 429", async () => {
    const put = (payload: Record<string, number>) => panel.app.inject({ method: "PUT", url: "/api/settings/dynamic-domains", headers: human(), payload });
    expect((await put({ maxIssuancesPerWeekPerDomain: 1 })).statusCode).toBe(200);
    try {
      const t = await panel.createToken({ name: "dominios-r5", scope: "admin", reach: "panel" });
      const s = new McpSession(panel.app, t.token);
      await s.initialize("c");
      const um = await s.tool("add_domain", { projectId: A, domain: "um.apps-r5.example.org", pair: false });
      expect(um.isError, JSON.stringify(um.data)).toBe(false);
      const dois = await s.tool("add_domain", { projectId: A, domain: "dois.apps-r5.example.org", pair: false });
      expect(dois.isError).toBe(true);
      expect(dois.data).toMatchObject({ status: 429, error: "weekly_limit" });
      // outro domínio registrável tem a própria cota
      expect((await s.tool("add_domain", { projectId: A, domain: "um.outro-r5.example.net", pair: false })).isError).toBe(false);
    } finally {
      await put({ maxIssuancesPerWeekPerDomain: 49 });
    }
  });
});
