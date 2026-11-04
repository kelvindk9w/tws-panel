/**
 * mcp-aprovacao.test.ts — ações sensíveis (recriar, aplicar segurança de verdade): a IA pede, a PESSOA aprova na
 * tela (senha), a IA repete a chamada e só então roda — uma vez, para os mesmos argumentos e o mesmo token.
 * Também: simulação como padrão da segurança, opção de dispensar a aprovação e métricas por token.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SecurityService } from "../src/services/security-service.js";
import { PASSWORD, startRealPanel, type RealPanel } from "./helpers/real-panel.js";
import { McpSession, enableMcp } from "./helpers/mcp-client.js";

vi.mock("../src/services/docker-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/docker-service.js")>()),
  listContainers: async () => [],
}));

let panel: RealPanel;
let A = "";
let B = "";
const tokens: Record<string, string> = {};
const human = () => ({ cookie: panel.cookie });

const open = async (name: string, client = "Cliente de Teste") => {
  const s = new McpSession(panel.app, tokens[name]!);
  await s.initialize(client);
  return s;
};
const approvals = async () => (await panel.app.inject({ method: "GET", url: "/api/mcp/approvals", headers: human() })).json().approvals as any[];
const decide = (id: string, action: "approve" | "reject", payload: Record<string, unknown> = {}) =>
  panel.app.inject({ method: "POST", url: `/api/mcp/approvals/${id}/${action}`, headers: human(), payload });

const FAKE_JOB = { id: "job-seg", phase: "02", title: "SSH", status: "running", dryRun: false, rollbackDeadline: null, log: "" };

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
  await make("pede", { scope: "write", reach: "panel" });
  await make("outro", { scope: "write", reach: "panel" });
  await make("dispensa", { scope: "write", reach: "panel", mcp: { skipApproval: true } });
  await make("seguranca-simula", { scope: "admin", reach: "panel" });
  await make("seguranca-aplica", { scope: "admin", reach: "panel", mcp: { securityApply: true } });
  await make("seguranca-aplica-direto", { scope: "admin", reach: "panel", mcp: { securityApply: true, skipApproval: true } });
  await make("metricas-painel", { scope: "read", reach: "panel", mcp: { metrics: true } });
  await make("metricas-projeto", { scope: "read", reach: "projects", projects: [A], mcp: { metrics: true } });
  await make("metricas-projeto-host", { scope: "read", reach: "projects", projects: [A], hostMetrics: true, mcp: { metrics: true } });
  await make("sem-metricas", { scope: "read", reach: "projects", projects: [A], hostMetrics: true });
}, 120_000);
afterAll(async () => panel.close());

describe("recriar o projeto pede aprovação humana", () => {
  it("fluxo completo: pede, pessoa aprova com a senha, a IA repete e roda UMA vez", async () => {
    const recreate = vi.spyOn(panel.app.deployService, "startRecreate").mockResolvedValue({ id: "job-r", status: "running" } as never);
    const ia = await open("pede", "Claude Teste");
    const pedido = await ia.tool("recreate_project", { projectId: A });
    expect(pedido.isError).toBe(false);
    expect(pedido.data.status).toBe("approval_required");
    expect(pedido.data.approvalId).toMatch(/^[0-9a-f]{32}$/);
    expect(recreate).not.toHaveBeenCalled();
    const id = pedido.data.approvalId as string;

    // a pessoa vê o pedido (quem pediu, qual ferramenta, os argumentos)
    const lista = await approvals();
    expect(lista[0]).toMatchObject({ id, tokenName: "pede", client: "Claude Teste 1.0", tool: "recreate_project", status: "pending", args: { project: expect.stringContaining(A) } });

    // enquanto ninguém decidiu, repetir não executa
    expect((await ia.tool("get_approval", { approvalId: id })).data.status).toBe("pending");
    const cedo = await ia.tool("recreate_project", { projectId: A, approvalId: id });
    expect(cedo.data).toMatchObject({ error: "approval_pending", status: 409 });

    // senha errada ou ausente: não aprova
    expect((await decide(id, "approve")).statusCode).toBe(401);
    expect((await decide(id, "approve", { currentPassword: "errada" })).statusCode).toBe(401);
    expect((await approvals()).find((a) => a.id === id).status).toBe("pending");

    const aprovado = await decide(id, "approve", { currentPassword: PASSWORD });
    expect(aprovado.statusCode).toBe(200);
    expect(aprovado.json().approval.status).toBe("approved");
    expect((await ia.tool("get_approval", { approvalId: id })).data.status).toBe("approved");

    const feito = await ia.tool("recreate_project", { projectId: A, approvalId: id });
    expect(feito.isError).toBe(false);
    expect(feito.data.job.id).toBe("job-r");
    expect(recreate).toHaveBeenCalledTimes(1);

    // uma execução só
    const outra = await ia.tool("recreate_project", { projectId: A, approvalId: id });
    expect(outra.data.error).toBe("approval_used");
    expect(recreate).toHaveBeenCalledTimes(1);
    recreate.mockRestore();
  });

  it("a aprovação vale para os mesmos argumentos e o mesmo token", async () => {
    const recreate = vi.spyOn(panel.app.deployService, "startRecreate").mockResolvedValue({ id: "job-x", status: "running" } as never);
    const ia = await open("pede");
    const id = (await ia.tool("recreate_project", { projectId: A })).data.approvalId as string;
    expect((await decide(id, "approve", { currentPassword: PASSWORD })).statusCode).toBe(200);
    // outro projeto com a aprovação do primeiro: recusado, e a aprovação continua valendo para o original
    expect((await ia.tool("recreate_project", { projectId: B, approvalId: id })).data.error).toBe("approval_mismatch");
    // outro token não enxerga nem usa o pedido
    const outro = await open("outro");
    expect((await outro.tool("get_approval", { approvalId: id })).data.error).toBe("approval_not_found");
    expect((await outro.tool("recreate_project", { projectId: A, approvalId: id })).data.error).toBe("approval_not_found");
    expect(recreate).not.toHaveBeenCalled();
    expect((await ia.tool("recreate_project", { projectId: A, approvalId: id })).isError).toBe(false);
    expect(recreate).toHaveBeenCalledTimes(1);
    recreate.mockRestore();
  });

  it("a pessoa recusa e a IA é avisada", async () => {
    const ia = await open("pede");
    const id = (await ia.tool("recreate_project", { projectId: A })).data.approvalId as string;
    const recusado = await decide(id, "reject");
    expect(recusado.statusCode).toBe(200);
    expect(recusado.json().approval.status).toBe("rejected");
    expect((await ia.tool("recreate_project", { projectId: A, approvalId: id })).data.error).toBe("approval_rejected");
    // decidir de novo: já foi decidido
    expect((await decide(id, "reject")).statusCode).toBe(409);
    expect((await decide(id, "approve", { currentPassword: PASSWORD })).statusCode).toBe(409);
    expect((await decide("0".repeat(32), "reject")).statusCode).toBe(404);
    expect((await decide("0".repeat(32), "approve", { currentPassword: PASSWORD })).statusCode).toBe(404);
  });

  it("a IA não aprova o que ela mesma pediu: as rotas de decisão são só da pessoa", async () => {
    const ia = await open("pede");
    const id = (await ia.tool("recreate_project", { projectId: A })).data.approvalId as string;
    for (const action of ["approve", "reject"]) {
      for (const t of Object.values(tokens)) {
        const res = await panel.app.inject({ method: "POST", url: `/api/mcp/approvals/${id}/${action}`, headers: { authorization: `Bearer ${t}` }, payload: { currentPassword: PASSWORD } });
        expect(res.statusCode).toBe(403);
      }
    }
    expect((await approvals()).find((a) => a.id === id).status).toBe("pending");
  });

  it("token que dispensa a aprovação executa direto (e a opção fica no registro)", async () => {
    const recreate = vi.spyOn(panel.app.deployService, "startRecreate").mockResolvedValue({ id: "job-d", status: "running" } as never);
    const ia = await open("dispensa");
    const res = await ia.tool("recreate_project", { projectId: A });
    expect(res.data.job.id).toBe("job-d");
    expect(recreate).toHaveBeenCalledTimes(1);
    recreate.mockRestore();
  });

  it("a fila de pendentes tem teto e o painel aprova/recusa/audita", async () => {
    const audit = (await panel.app.inject({ method: "GET", url: "/api/audit?perPage=200", headers: human() })).json().entries as any[];
    expect(audit.some((e) => e.action === "mcp.approval_approved" && e.actor === "admin")).toBe(true);
    expect(audit.some((e) => e.action === "mcp.approval_rejected" && e.detail.includes('"pede"'))).toBe(true);
    expect(audit.some((e) => e.action === "mcp.tool_call" && e.detail.includes("aprovação pedida"))).toBe(true);
    expect(audit.some((e) => e.action === "mcp.tool_call" && e.detail.includes("negado (aprovação used)"))).toBe(true);
  });

});

describe("mudanças de segurança: simulação por padrão", () => {
  it("dryRun é o padrão, não pede aprovação e vai pela rota", async () => {
    const apply = vi.spyOn(SecurityService.prototype, "apply").mockResolvedValue({ ...FAKE_JOB, dryRun: true } as never);
    const ia = await open("seguranca-simula");
    const sem = await ia.tool("security_apply", { phase: "02" });
    expect(sem.isError, JSON.stringify(sem.data)).toBe(false);
    expect(apply).toHaveBeenLastCalledWith("02", true, undefined);
    const explicito = await ia.tool("security_apply", { phase: "03", dryRun: true });
    expect(explicito.isError).toBe(false);
    expect(apply).toHaveBeenLastCalledWith("03", true, undefined);
    apply.mockRestore();
  });

  it("aplicar de verdade sem a opção do token é recusado", async () => {
    const apply = vi.spyOn(SecurityService.prototype, "apply").mockResolvedValue(FAKE_JOB as never);
    const ia = await open("seguranca-simula");
    const res = await ia.tool("security_apply", { phase: "02", dryRun: false });
    expect(res.data).toMatchObject({ error: "security_apply_disabled", status: 403 });
    expect(apply).not.toHaveBeenCalled();
    apply.mockRestore();
  });

  it("com a opção ligada, aplicar de verdade ainda pede aprovação humana", async () => {
    const apply = vi.spyOn(SecurityService.prototype, "apply").mockResolvedValue(FAKE_JOB as never);
    const ia = await open("seguranca-aplica");
    const pedido = await ia.tool("security_apply", { phase: "02", dryRun: false, sshUser: "deploy" });
    expect(pedido.data.status).toBe("approval_required");
    expect(apply).not.toHaveBeenCalled();
    const id = pedido.data.approvalId as string;
    expect((await approvals()).find((a) => a.id === id).args).toEqual({ phase: "02", dryRun: false, sshUser: "deploy" });
    expect((await decide(id, "approve", { currentPassword: PASSWORD })).statusCode).toBe(200);
    // mudar a fase depois de aprovado não vale
    expect((await ia.tool("security_apply", { phase: "03", dryRun: false, sshUser: "deploy", approvalId: id })).data.error).toBe("approval_mismatch");
    const feito = await ia.tool("security_apply", { phase: "02", dryRun: false, sshUser: "deploy", approvalId: id });
    expect(feito.isError).toBe(false);
    expect(apply).toHaveBeenCalledWith("02", false, { sshUser: "deploy" });
    apply.mockRestore();
  });

  it("com aplicar e dispensar aprovação ligados, roda direto; as regras da rota continuam (usuário inválido)", async () => {
    const apply = vi.spyOn(SecurityService.prototype, "apply").mockResolvedValue(FAKE_JOB as never);
    const ia = await open("seguranca-aplica-direto");
    expect((await ia.tool("security_apply", { phase: "02", dryRun: false })).isError).toBe(false);
    expect(apply).toHaveBeenCalledTimes(1);
    const ruim = await ia.tool("security_apply", { phase: "02", dryRun: false, sshUser: "root" });
    expect(ruim.data.error).toBe("invalid_ssh_user");
    expect(apply).toHaveBeenCalledTimes(1);
    apply.mockRestore();
  });

  it("plano, relatório e job de segurança só para token de painel", async () => {
    const plan = vi.spyOn(SecurityService.prototype, "plan").mockResolvedValue({ steps: [] } as never);
    const ia = await open("seguranca-simula");
    expect((await ia.tool("security_plan")).data).toEqual({ steps: [] });
    plan.mockRestore();
    expect((await ia.tool("get_security_job", { jobId: "nao-existe" })).data.error).toBe("job_not_found");
    const limitado = await open("metricas-projeto");
    const nomes = (await limitado.call("tools/list")).json.result.tools.map((t: any) => t.name);
    expect(nomes).not.toContain("security_plan");
    expect(nomes).not.toContain("get_security_job");
  });
});

describe("métricas: desligadas por padrão, por token", () => {
  it("sem a opção nenhuma ferramenta de métricas aparece (nem para token do painel inteiro)", async () => {
    for (const name of ["pede", "sem-metricas", "seguranca-simula"]) {
      const nomes = (await (await open(name)).call("tools/list")).json.result.tools.map((t: any) => t.name);
      for (const m of ["get_metrics_summary", "get_host_metrics", "get_project_metrics"]) expect(nomes).not.toContain(m);
    }
    const s = await open("sem-metricas");
    expect((await s.call("tools/call", { name: "get_project_metrics", arguments: { projectId: A } })).json.error.code).toBe(-32602);
  });

  it("com a opção, token do painel vê o projeto e a VPS; token de projetos só o projeto, a menos que o alcance inclua o monitoramento", async () => {
    const painel = await open("metricas-painel");
    const nomesPainel = (await painel.call("tools/list")).json.result.tools.map((t: any) => t.name);
    expect(nomesPainel).toEqual(expect.arrayContaining(["get_metrics_summary", "get_host_metrics", "get_project_metrics"]));
    const projeto = await open("metricas-projeto");
    const nomesProjeto = (await projeto.call("tools/list")).json.result.tools.map((t: any) => t.name);
    expect(nomesProjeto).toContain("get_project_metrics");
    expect(nomesProjeto).not.toContain("get_host_metrics");
    expect(nomesProjeto).not.toContain("get_metrics_summary");
    const host = await open("metricas-projeto-host");
    expect((await host.call("tools/list")).json.result.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(["get_host_metrics", "get_metrics_summary"]));
  });

  it("as consultas passam pelas rotas de métricas (alcance incluído)", async () => {
    const painel = await open("metricas-painel");
    const resumo = await painel.tool("get_metrics_summary");
    expect(typeof resumo.isError).toBe("boolean");
    expect(typeof (await painel.tool("get_host_metrics", { range: "1h" })).isError).toBe("boolean");
    expect(typeof (await painel.tool("get_host_metrics")).isError).toBe("boolean");
    expect(typeof (await painel.tool("get_project_metrics", { projectId: A, range: "7d" })).isError).toBe("boolean");
    expect(typeof (await painel.tool("get_project_metrics", { projectId: A })).isError).toBe("boolean");
    const projeto = await open("metricas-projeto");
    expect((await projeto.tool("get_project_metrics", { projectId: B })).data.error).toBe("project_not_found");
    expect((await painel.tool("get_project_metrics", { projectId: A, range: "10y" })).data.error).toBe("invalid_arguments");
  });
});

describe("fila de pedidos", () => {
  it("pedidos pendentes demais: a IA recebe aviso e nada novo é aberto", async () => {
    const ia = await open("outro");
    let limite: any = null;
    for (let i = 0; i < 60 && !limite; i++) {
      const r = await ia.tool("recreate_project", { projectId: A });
      if (r.isError) limite = r.data;
    }
    expect(limite).toMatchObject({ error: "too_many_pending_approvals", status: 429 });
  });
});
