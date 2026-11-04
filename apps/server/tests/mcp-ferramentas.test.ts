/**
 * mcp-ferramentas.test.ts — as ferramentas da Fase 1 no painel real: mesmas rotas e mesmas regras
 * (alcance, nível, validação), variáveis sem vazar valor, nada que apague e tudo na Auditoria.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PASSWORD, startRealPanel, type RealPanel } from "./helpers/real-panel.js";
import { McpSession, enableMcp } from "./helpers/mcp-client.js";

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
const tokens: Record<string, string> = {};
const human = () => ({ cookie: panel.cookie });

/** Uma pessoa aprova o pedido na tela (senha) e a IA repete a chamada com o número. */
async function approveAndRepeat(s: McpSession, tool: string, args: Record<string, unknown>, pending: { data: any }) {
  expect(pending.data.status, JSON.stringify(pending.data)).toBe("approval_required");
  const decided = await panel.app.inject({
    method: "POST",
    url: `/api/mcp/approvals/${pending.data.approvalId}/approve`,
    headers: human(),
    payload: { currentPassword: PASSWORD },
  });
  expect(decided.statusCode).toBe(200);
  return s.tool(tool, { ...args, approvalId: pending.data.approvalId });
}

/** set_env_vars com a aprovação de uma pessoa (toda escrita de variável pelo MCP passa por ela). */
async function setEnv(s: McpSession, args: Record<string, unknown>) {
  const r = await s.tool("set_env_vars", args);
  return r.data?.status === "approval_required" ? approveAndRepeat(s, "set_env_vars", args, r) : r;
}

async function open(name: string, client = "Claude Teste"): Promise<McpSession> {
  const s = new McpSession(panel.app, tokens[name]!);
  await s.initialize(client);
  return s;
}

beforeAll(async () => {
  panel = await startRealPanel();
  A = await panel.createProject("Fazenda", "fazenda.example.com");
  B = await panel.createProject("Loja", "loja.example.com");
  expect(await enableMcp(panel)).toBe(200);
  const make = async (name: string, body: Record<string, unknown>) => {
    const res = await panel.createToken({ name, ...body });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    tokens[name] = res.token;
  };
  await make("painel-admin", { scope: "admin", reach: "panel" });
  await make("painel-leitura", { scope: "read", reach: "panel" });
  await make("painel-escrita", { scope: "write", reach: "panel" });
  await make("projeto-a-escrita", { scope: "write", reach: "projects", projects: [A] });
  await make("projeto-a-admin", { scope: "admin", reach: "projects", projects: [A] });
  await make("cria-projetos", { scope: "admin", reach: "projects", projects: [A], canCreate: true });
  await make("segredos", { scope: "write", reach: "projects", projects: [A], mcp: { secretsRead: true } });
}, 120_000);
afterAll(async () => panel.close());

describe("get_access_info", () => {
  it("diz ao token o que ele pode, sem mostrar nada que ele não tenha", async () => {
    const s = await open("projeto-a-escrita");
    const { data, isError } = await s.tool("get_access_info");
    expect(isError).toBe(false);
    expect(data.token).toBe("projeto-a-escrita");
    expect(data.level).toBe("write");
    expect(data.reach).toEqual({ kind: "projects", projectIds: [A], canCreate: false });
    expect(data.options).toEqual({ securityApply: false, secretsRead: false, skipApproval: false, metrics: false });
    expect(data.securityChanges).toMatch(/simulation/);
    expect(data.secretValues).toMatch(/masked/);
    expect(data.panelVersion).toBeTruthy();
    const painel = await open("painel-admin");
    expect((await painel.tool("get_access_info")).data.reach).toEqual({ kind: "panel" });
  });
});

describe("consulta e alcance (as mesmas regras das rotas)", () => {
  it("list_projects: painel vê todos; token de projetos vê só a lista", async () => {
    const todos = (await (await open("painel-leitura")).tool("list_projects")).data.projects.map((p: any) => p.project.id);
    expect(todos.sort()).toEqual([A, B].sort());
    const so = (await (await open("projeto-a-escrita")).tool("list_projects")).data.projects.map((p: any) => p.project.id);
    expect(so).toEqual([A]);
  });

  it("projeto fora do alcance = o mesmo 404 de um projeto que não existe", async () => {
    const s = await open("projeto-a-escrita");
    const fora = await s.tool("get_project", { projectId: B });
    const inexistente = await s.tool("get_project", { projectId: "ffffffffffffffff" });
    expect(fora.isError).toBe(true);
    expect(fora.data).toEqual(inexistente.data);
    expect(fora.data.status).toBe(404);
    const dentro = await s.tool("get_project", { projectId: A });
    expect(dentro.isError).toBe(false);
    expect(dentro.data.project.id).toBe(A);
    for (const tool of ["list_deploys", "get_project_guardrails", "get_project_https", "get_logs", "list_env_names"]) {
      const res = await s.tool(tool, { projectId: B });
      expect(res.data.error, tool).toBe("project_not_found");
    }
    expect((await s.tool("get_deploy", { projectId: B, jobId: "x" })).data.error).toBe("project_not_found");
  });

  it("token de projetos não alcança o que é do painel (ferramentas nem aparecem)", async () => {
    const s = await open("projeto-a-admin");
    const names = (await s.call("tools/list")).json.result.tools.map((t: { name: string }) => t.name);
    for (const so_painel of ["read_panel_info", "security_apply", "security_plan", "get_security_job", "create_project"]) {
      expect(names).not.toContain(so_painel);
    }
    expect((await s.call("tools/call", { name: "read_panel_info", arguments: { resource: "alerts" } })).json.error.code).toBe(-32602);
  });

  it("read_panel_info lê listagens do painel e recusa filtro estranho", async () => {
    const s = await open("painel-leitura");
    const alerts = await s.tool("read_panel_info", { resource: "alerts", params: { status: "open" } });
    expect(alerts.isError).toBe(false);
    expect((await s.tool("read_panel_info", { resource: "containers" })).isError).toBe(false);
    expect((await s.tool("read_panel_info", { resource: "senhas" })).data.error).toBe("invalid_arguments");
    expect((await s.tool("read_panel_info", { resource: "alerts", params: { "a b": "x" } })).data.error).toBe("invalid_request");
    expect((await s.tool("read_panel_info", { resource: "alerts", params: { status: 5 } })).data.error).toBe("invalid_request");
    const muitos = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`k${String.fromCharCode(97 + i)}`, "v"]));
    expect((await s.tool("read_panel_info", { resource: "alerts", params: muitos })).data.error).toBe("invalid_request");
  });

  it("argumentos fora do formato são recusados antes de chamar a rota", async () => {
    const s = await open("painel-leitura");
    expect((await s.tool("get_project", {})).data.error).toBe("invalid_arguments");
    expect((await s.tool("get_project", { projectId: "" })).data.error).toBe("invalid_arguments");
    expect((await s.tool("get_project", { projectId: A, extra: 1 })).data.error).toBe("invalid_arguments");
    expect((await s.tool("get_logs", { projectId: A, tail: 99999 })).data.error).toBe("invalid_arguments");
    expect((await s.tool("get_logs", { projectId: A, since: "1y" })).data.error).toBe("invalid_arguments");
    const tipo = await s.call("tools/call", { name: "get_project", arguments: "texto" });
    expect(tipo.json.result.isError).toBe(true);
  });

  it("logs, https, deploys, dns e guardrails passam pelas rotas", async () => {
    const s = await open("painel-leitura");
    expect((await s.tool("list_deploys", { projectId: A })).data.jobs).toEqual([]);
    // sem rede nos testes: o relatório de HTTPS (que consulta o Caddy) é substituído
    const https = vi.spyOn(panel.app.deployService, "httpsStatus").mockResolvedValue([] as never);
    expect((await s.tool("get_project_https", { projectId: A })).data).toEqual({ domains: [] });
    https.mockRestore();
    expect((await s.tool("get_project_guardrails", { projectId: A })).raw.json.result.content[0].text).toBeTruthy();
    const dns = await s.tool("check_dns", { domain: "fazenda.example.com", projectId: A });
    expect(dns.isError).toBe(false);
    expect((await s.tool("check_dns", { domain: "fazenda.example.com" })).isError).toBe(false);
    const logs = await s.tool("get_logs", { projectId: A, service: "web", tail: 50, since: "1h" });
    expect(logs.raw.json.result.content[0].text).toBeTruthy();
    expect((await s.tool("get_deploy", { projectId: A, jobId: "inexistente" })).data.error).toBe("job_not_found");
  });
});

describe("variáveis: define e substitui, nunca lê sem permissão, nunca apaga", () => {
  it("set_env_vars grava, mescla com o que já existe e não devolve valores", async () => {
    const s = await open("projeto-a-escrita");
    const primeira = await setEnv(s, { projectId: A, vars: [{ key: "API_KEY", value: "segredo-1" }, { key: "MODO", value: "prod" }] });
    expect(primeira.isError).toBe(false);
    expect(primeira.data.set).toEqual(["API_KEY", "MODO"]);
    expect(JSON.stringify(primeira.data)).not.toContain("segredo-1");
    // trocar o valor de uma variável que já existe é sensível: a pessoa aprova, a IA repete
    const args = { projectId: A, vars: [{ key: "API_KEY", value: "segredo-2" }] };
    const pedido = await s.tool("set_env_vars", args);
    expect(JSON.stringify(pedido.data)).not.toContain("segredo-2");
    const segunda = await approveAndRepeat(s, "set_env_vars", args, pedido);
    expect(segunda.isError, JSON.stringify(segunda.data)).toBe(false);
    const nomes = await s.tool("list_env_names", { projectId: A });
    expect(nomes.data.variables.map((v: any) => v.name).sort()).toEqual(["API_KEY", "MODO"]);
    expect(JSON.stringify(nomes.data)).not.toMatch(/segredo/);
    expect(nomes.data.variables[0]).toMatchObject({ hasValue: true, value: "********" });
    // o valor novo valeu (conferido pela tela, que é humana) e MODO continuou
    const humano = await panel.app.inject({ method: "GET", url: `/api/projects/${A}/env`, headers: human() });
    const vars = humano.json().vars as { key: string; value: string }[];
    expect(vars.find((v) => v.key === "API_KEY")?.value).toBe("segredo-2");
    expect(vars.find((v) => v.key === "MODO")?.value).toBe("prod");
  });

  it("get_env_value não existe sem a opção; com ela devolve o valor", async () => {
    const sem = await open("projeto-a-escrita");
    expect((await sem.call("tools/list")).json.result.tools.map((t: any) => t.name)).not.toContain("get_env_value");
    expect((await sem.call("tools/call", { name: "get_env_value", arguments: { projectId: A, name: "API_KEY" } })).json.error.code).toBe(-32602);
    const com = await open("segredos");
    const ok = await com.tool("get_env_value", { projectId: A, name: "API_KEY" });
    expect(ok.isError).toBe(false);
    expect(ok.data.value).toBe("segredo-2");
    expect((await com.tool("get_env_value", { projectId: A, name: "NAO_EXISTE" })).data.error).toBe("env_not_found");
    expect((await com.tool("get_env_value", { projectId: B, name: "API_KEY" })).data.error).toBe("project_not_found");
  });

  it("alcance e nível valem também nas variáveis", async () => {
    const s = await open("projeto-a-escrita");
    expect((await s.tool("set_env_vars", { projectId: B, vars: [{ key: "X", value: "1" }] })).data.error).toBe("project_not_found");
    expect((await s.tool("list_env_names", { projectId: B })).data.error).toBe("project_not_found");
    const leitura = await open("painel-leitura");
    // o token de leitura nem enxerga a ferramenta de escrita
    expect((await leitura.call("tools/call", { name: "set_env_vars", arguments: { projectId: A, vars: [{ key: "X", value: "1" }] } })).json.error.code).toBe(-32602);
    // token de painel inteiro com apelido (slug) do projeto: vale (como na rota); token limitado só vale com o id exato
    const slug = (await panel.app.inject({ method: "GET", url: `/api/projects/${A}`, headers: human() })).json().project.slug as string;
    const painel = await open("painel-escrita");
    expect((await painel.tool("list_env_names", { projectId: slug })).isError).toBe(false);
    expect((await s.tool("list_env_names", { projectId: slug })).data.error).toBe("project_not_found");
  });

  it("toda escrita pede aprovação, inclusive variável nova; a tela mostra o valor novo e nunca o antigo", async () => {
    const s = await open("projeto-a-escrita");
    const nova = await s.tool("set_env_vars", { projectId: A, vars: [{ key: "OPENAI_BASE_URL", value: "https://atacante.example.com/v1" }] });
    expect(nova.data.status).toBe("approval_required");
    const lista = (await panel.app.inject({ method: "GET", url: "/api/mcp/approvals", headers: human() })).json().approvals as { id: string; args: Record<string, string> }[];
    expect(lista.find((a) => a.id === nova.data.approvalId)!.args.values).toContain("OPENAI_BASE_URL [31 caracteres] = https://atacante.example.com/v1");
    await panel.app.inject({ method: "POST", url: `/api/mcp/approvals/${nova.data.approvalId}/reject`, headers: human(), payload: {} });
    expect((await setEnv(s, { projectId: A, vars: [{ key: "NOVA_1", value: "x1" }] })).isError).toBe(false);
    // o mesmo valor de novo não muda nada, mas o pedido também passa pela pessoa
    // esvaziar um valor existente é apagar de fato
    const esvazia = await s.tool("set_env_vars", { projectId: A, vars: [{ key: "NOVA_1", value: "" }] });
    expect(esvazia.data.status).toBe("approval_required");
    const lista2 = (await panel.app.inject({ method: "GET", url: "/api/mcp/approvals", headers: human() })).json().approvals as { id: string; args: Record<string, string> }[];
    const visto = lista2.find((a) => a.id === esvazia.data.approvalId)!;
    expect(visto.args.project).toContain("Fazenda");
    expect(visto.args.variables).toContain("substitui um valor existente");
    expect(visto.args.values).toContain("NOVA_1 [0 caracteres] = ");
    expect(JSON.stringify(visto.args)).not.toContain("x1");
    // sem a aprovação, nada mudou
    const humano = await panel.app.inject({ method: "GET", url: `/api/projects/${A}/env`, headers: human() });
    expect((humano.json().vars as { key: string; value: string }[]).find((v) => v.key === "NOVA_1")?.value).toBe("x1");
    await panel.app.inject({ method: "POST", url: `/api/mcp/approvals/${esvazia.data.approvalId}/reject`, headers: human(), payload: {} });
  });

  it("nomes que carregam código (NODE_OPTIONS, BASH_ENV, LD_PRELOAD, PYTHON*, GIT_*...) pedem aprovação sem 'Ler segredos'", async () => {
    const s = await open("projeto-a-escrita");
    for (const key of ["NODE_OPTIONS", "bash_env", "LD_PRELOAD", "PYTHONSTARTUP", "JAVA_TOOL_OPTIONS", "GIT_SSH_COMMAND", "COMPOSE_FILE", "PATH", "RUBYOPT", "PERL5OPT"]) {
      const pedido = await s.tool("set_env_vars", { projectId: A, vars: [{ key, value: "--import=data:text/javascript,console.log(1)" }] });
      expect(pedido.data.status, key).toBe("approval_required");
      // libera a vaga: cada token tem poucos pedidos pendentes ao mesmo tempo
      await panel.app.inject({ method: "POST", url: `/api/mcp/approvals/${pedido.data.approvalId}/reject`, headers: human(), payload: {} });
    }
    // nome comum também pede (toda escrita pede), mas sem o alerta de nome perigoso
    const comum = await s.tool("set_env_vars", { projectId: A, vars: [{ key: "NODE_ENV", value: "production" }] });
    expect(comum.data.status).toBe("approval_required");
    await panel.app.inject({ method: "POST", url: `/api/mcp/approvals/${comum.data.approvalId}/reject`, headers: human(), payload: {} });
    // com a aprovação da pessoa, grava
    const args = { projectId: A, vars: [{ key: "NODE_OPTIONS", value: "--max-old-space-size=512" }] };
    const pedido = await s.tool("set_env_vars", args);
    expect((await approveAndRepeat(s, "set_env_vars", args, pedido)).isError).toBe(false);
  });

  it("a opção 'Ler segredos' não dispensa a aprovação da escrita de variável", async () => {
    const s = await open("segredos");
    const pedido = await s.tool("set_env_vars", { projectId: A, vars: [{ key: "PYTHONUNBUFFERED", value: "1" }] });
    expect(pedido.data.status).toBe("approval_required");
    await panel.app.inject({ method: "POST", url: `/api/mcp/approvals/${pedido.data.approvalId}/reject`, headers: human(), payload: {} });
  });

  it("token que dispensa a aprovação troca o valor direto", async () => {
    const t = await panel.createToken({ name: "sem-aprovacao-env", scope: "write", reach: "projects", projects: [A], mcp: { skipApproval: true } });
    const s = new McpSession(panel.app, t.token);
    await s.initialize();
    expect((await s.tool("set_env_vars", { projectId: A, vars: [{ key: "MODO", value: "teste" }] })).isError).toBe(false);
    const humano = await panel.app.inject({ method: "GET", url: `/api/projects/${A}/env`, headers: human() });
    expect((humano.json().vars as { key: string; value: string }[]).find((v) => v.key === "MODO")?.value).toBe("teste");
  });

  it("corrida: a gravação sem aprovação recusa trocar o que uma pessoa salvou, em vez de sobrescrever", async () => {
    await panel.app.deployService.mergeEnv(A, [{ key: "CORRIDA", value: "da-pessoa" }], { allowOverwrite: true });
    await expect(panel.app.deployService.mergeEnv(A, [{ key: "CORRIDA", value: "da-ia" }], { allowOverwrite: false })).rejects.toMatchObject({ code: "env_changed" });
    const humano = await panel.app.inject({ method: "GET", url: `/api/projects/${A}/env`, headers: human() });
    expect((humano.json().vars as { key: string; value: string }[]).find((v) => v.key === "CORRIDA")?.value).toBe("da-pessoa");
  });

  it("a mescla não desfaz uma gravação paralela de outra variável", async () => {
    const s = await open("projeto-a-escrita");
    await Promise.all([
      setEnv(s, { projectId: A, vars: [{ key: "PARALELA_IA", value: "a" }] }),
      panel.app.deployService.mergeEnv(A, [{ key: "PARALELA_PESSOA", value: "b" }], { allowOverwrite: true }),
    ]);
    const nomes = (await s.tool("list_env_names", { projectId: A })).data.variables.map((v: any) => v.name);
    expect(nomes).toContain("PARALELA_IA");
    expect(nomes).toContain("PARALELA_PESSOA");
  });

  it("variável inválida volta no mesmo formato do serviço", async () => {
    const s = await open("projeto-a-escrita");
    const ruim = await setEnv(s, { projectId: A, vars: [{ key: "nome inválido!", value: "1" }] });
    expect(ruim.isError).toBe(true);
    expect(ruim.data.status).toBe(400);
  });

  it("falha inesperada do serviço vira erro interno sem vazar detalhe", async () => {
    const s = await open("projeto-a-escrita");
    const spy = vi.spyOn(panel.app.deployService, "getEnv").mockRejectedValueOnce(new Error("disco /segredo/caminho falhou"));
    const res = await s.tool("list_env_names", { projectId: A });
    spy.mockRestore();
    expect(res.data).toMatchObject({ error: "internal_error", status: 500 });
    expect(JSON.stringify(res.data)).not.toContain("/segredo/caminho");
  });
});

describe("criar projeto e domínio", () => {
  it("token com 'pode criar' cria o projeto e ele entra na lista do token; token sem isso nem vê a ferramenta", async () => {
    const s = await open("cria-projetos");
    const criado = await s.tool("create_project", { name: "Blog", source: "https://example.com/blog.git", domain: "blog.example.com", backup: false });
    expect(criado.isError, JSON.stringify(criado.data)).toBe(false);
    const id = criado.data.project.id as string;
    const lista = (await s.tool("list_projects")).data.projects.map((p: any) => p.project.id);
    expect(lista).toContain(id);
    expect((await s.tool("get_project", { projectId: id })).isError).toBe(false);
    const sem = await open("projeto-a-admin");
    expect((await sem.call("tools/list")).json.result.tools.map((t: any) => t.name)).not.toContain("create_project");
  });

  it("create_project só aceita repositório Git e recusa campo desconhecido", async () => {
    const s = await open("painel-admin");
    expect((await s.tool("create_project", { name: "X", source: "https://example.com/x.git", domain: "x.example.com", ingestMode: "folder" })).data.error).toBe("invalid_arguments");
    const ok = await s.tool("create_project", { name: "Painel Novo", source: "https://example.com/novo.git", domain: "novo.example.com", backup: false });
    expect(ok.isError).toBe(false);
  });

  it("add_domain pede nível de administração (a rota decide); update_project muda o nome", async () => {
    const escrita = await open("projeto-a-escrita");
    expect((await escrita.call("tools/list")).json.result.tools.map((t: any) => t.name)).not.toContain("add_domain");
    const admin = await open("projeto-a-admin");
    const dom = await admin.tool("add_domain", { projectId: A, domain: "extra.example.com", pair: false });
    expect(dom.isError, JSON.stringify(dom.data)).toBe(false);
    expect(dom.data.project.domains ?? dom.data.project.domain).toBeTruthy();
    expect((await admin.tool("add_domain", { projectId: B, domain: "fora.example.com" })).data.error).toBe("project_not_found");
    const nome = await escrita.tool("update_project", { projectId: A, name: "Fazenda Nova" });
    expect(nome.isError).toBe(false);
    expect(nome.data.project.name).toBe("Fazenda Nova");
    // trocar o domínio é mudança de tráfego: a rota exige administração e o MCP não contorna
    const dominio = await escrita.tool("update_project", { projectId: A, domain: "outro.example.com" });
    expect(dominio.isError).toBe(true);
    expect(dominio.data.error).toBe("insufficient_scope");
  });
});

describe("publicar e operar", () => {
  it("deploy_project, restart_project e recreate_project chamam as rotas (e o override de guardrail não existe)", async () => {
    const admin = await open("painel-admin");
    // a regra da rota vale: projeto sem tipo detectado não faz deploy (o mesmo 409 de quem usa a tela)
    const bloqueado = await admin.tool("deploy_project", { projectId: A });
    expect(bloqueado.isError).toBe(true);
    expect(bloqueado.data).toMatchObject({ status: 409, error: "unknown_type" });
    const iniciar = vi.spyOn(panel.app.deployService, "startDeploy").mockResolvedValue({ id: "job1", status: "running" } as never);
    const deploy = await admin.tool("deploy_project", { projectId: A });
    expect(iniciar).toHaveBeenCalledWith(A, { guardrailOverride: false });
    iniciar.mockRestore();
    expect(deploy.isError, JSON.stringify(deploy.data)).toBe(false);
    expect(deploy.data.job.id).toBe("job1");
    expect((await admin.tool("deploy_project", { projectId: A, guardrailOverride: true })).data.error).toBe("invalid_arguments");
    const fora = await (await open("projeto-a-escrita")).tool("deploy_project", { projectId: B });
    expect(fora.data.error).toBe("project_not_found");
    const restart = await admin.tool("restart_project", { projectId: A });
    expect(typeof restart.isError).toBe("boolean");
    expect((await (await open("projeto-a-escrita")).tool("restart_project", { projectId: B })).data.error).toBe("project_not_found");
  });

  it("restart_project avisa que o projeto ficou parado se o start falhar", async () => {
    const admin = await open("painel-admin");
    const spy = vi.spyOn(panel.app.deployService, "stop").mockResolvedValue(undefined as never);
    const start = vi.spyOn(panel.app.deployService, "start").mockRejectedValue(Object.assign(new Error("sem docker"), { statusCode: 500, code: "docker_down" }));
    const res = await admin.tool("restart_project", { projectId: A });
    spy.mockRestore();
    start.mockRestore();
    expect(res.isError).toBe(true);
    expect(res.data.message).toMatch(/parado/);
    const spyStop = vi.spyOn(panel.app.deployService, "stop").mockResolvedValue(undefined as never);
    const spyStart = vi.spyOn(panel.app.deployService, "start").mockResolvedValue(undefined as never);
    const certo = await admin.tool("restart_project", { projectId: A });
    spyStop.mockRestore();
    spyStart.mockRestore();
    expect(certo.data).toEqual({ restarted: true });
  });
});

describe("Auditoria", () => {
  it("toda chamada fica registrada com o token e o nome do cliente; variáveis só por nome", async () => {
    // token novo: a abertura de sessão só entra na Auditoria uma vez por hora por token
    const novo = await panel.createToken({ name: "auditado", scope: "write", reach: "projects", projects: [A], mcp: { skipApproval: true } });
    tokens["auditado"] = novo.token;
    const s = await open("auditado", "Cliente Auditado");
    await s.tool("set_env_vars", { projectId: A, vars: [{ key: "SO_O_NOME", value: "valor-que-nao-pode-aparecer" }] });
    await s.tool("list_projects");
    await s.call("tools/call", { name: "nao_existe", arguments: {} });
    const res = await panel.app.inject({ method: "GET", url: "/api/audit?perPage=200", headers: human() });
    const entries = res.json().entries as { actor: string; action: string; detail: string; target: string | null }[];
    const mcp = entries.filter((e) => (e.action === "mcp.tool_call" || e.action === "mcp.tool_changed") && e.actor === "token:auditado");
    // só o que muda algo e as recusas entram; consultar (list_projects) não enche a Auditoria
    expect(mcp.length).toBeGreaterThanOrEqual(2);
    // consultas repetidas: uma entrada só por minuto (com a contagem depois), não uma por chamada
    for (let i = 0; i < 5; i++) await s.tool("list_projects");
    const depois = (await panel.app.inject({ method: "GET", url: "/api/audit?perPage=200", headers: human() })).json().entries as { actor: string; action: string; detail: string }[];
    const lista = depois.filter((e) => e.actor === "token:auditado" && e.detail.includes("list_projects"));
    expect(lista.filter((e) => !e.detail.includes("iguais"))).toHaveLength(1);
    expect(lista.filter((e) => /mais [0-9]+ iguais/.test(e.detail))).toHaveLength(1);
    expect(mcp.some((e) => e.action === "mcp.tool_changed" && e.detail.includes('"Cliente Auditado 1.0"') && e.detail.includes("set_env_vars") && e.detail.includes("SO_O_NOME"))).toBe(true);
    expect(mcp.some((e) => e.detail.includes("negado"))).toBe(true);
    expect(entries.some((e) => e.action === "mcp.session_started" && e.detail.includes("Cliente Auditado"))).toBe(true);
    expect(JSON.stringify(entries)).not.toContain("valor-que-nao-pode-aparecer");
    // a rota por trás também grava como o token
    expect(entries.some((e) => e.action === "project.env_updated" && e.actor === "token:auditado")).toBe(true);
  });
});

describe("limites e saída", () => {
  it("o limite de taxa da rota vale para a ferramenta (recriar: 10 por minuto)", async () => {
    const t = await panel.createToken({ name: "sem-aprovacao-limite", scope: "write", reach: "panel", mcp: { skipApproval: true } });
    const s = new McpSession(panel.app, t.token);
    await s.initialize();
    let limitado = false;
    for (let i = 0; i < 14 && !limitado; i++) {
      const r = await s.tool("recreate_project", { projectId: A });
      if (r.isError && r.data.status === 429) limitado = true;
    }
    expect(limitado).toBe(true);
  });

  it("a saída nunca leva um token e é cortada no teto", async () => {
    const { renderToolText, MCP_MAX_OUTPUT_CHARS } = await import("../src/services/mcp-protocol.js");
    const token = "tws_pat_" + "B".repeat(43);
    expect(renderToolText({ x: `veja ${token} aqui` })).not.toContain(token);
    expect(renderToolText({ x: "abc-segredo-abc" }, ["segredo-abc"])).not.toContain("segredo-abc");
    expect(renderToolText({ x: "curto-demais" }, ["curto"])).toContain("curto");
    const longo = renderToolText({ x: "a".repeat(MCP_MAX_OUTPUT_CHARS + 500) });
    expect(longo.length).toBeLessThan(MCP_MAX_OUTPUT_CHARS + 300);
    expect(longo).toMatch(/cortada/);
    expect(renderToolText(undefined)).toBe("null");
  });
});

void PASSWORD;
