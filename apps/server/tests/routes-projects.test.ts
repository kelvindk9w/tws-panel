/**
 * Testes das rotas de projetos (/api/projects/*) com o DeployService mockado:
 * auth obrigatória, mapeamento de erros de domínio (400/404/409/500) e o
 * fluxo de bloqueio por guardrails com o relatório no corpo do 409.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER, type GuardrailReport, type Project } from "@paas/core";
import projectsRoutes from "../src/routes/projects.js";
import { httpError, type DeployService } from "../src/services/deploy-service.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";
import { removeDir } from "./helpers/tmp.js";

const TOKEN = "token-de-teste";

const PROJECT: Project = {
  id: "p1",
  name: "Loja",
  slug: "loja",
  ingestMode: "upload",
  source: "/tmp/loja",
  branch: null,
  domain: "loja.localhost",
  websocket: false,
  detection: null,
  proxyService: null,
  proxyPort: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastDeployAt: null,
  lastDeployStatus: null,
  deployedBranch: null,
  deployedSource: null,
};

/** Stub do DeployService: métodos configuráveis por teste. */
function makeServiceStub(overrides: Record<string, unknown> = {}) {
  return {
    listContainers: vi.fn(async () => []),
    listProjects: vi.fn(async () => [PROJECT]),
    statusOf: vi.fn(async () => ({ status: "running" as const, containers: [] })),
    projectUrl: vi.fn((p: Project) => `http://${p.domain}`),
    // Informação pública da credencial (existe? dica?) — o valor do token
    // nunca passa por aqui.
    credentialInfo: vi.fn(async () => ({
      configured: false,
      hint: null,
      username: null,
      updatedAt: null,
    })),
    createProject: vi.fn(async () => PROJECT),
    getProject: vi.fn(async (id: string) => (id === "p1" ? PROJECT : null)),
    updateProject: vi.fn(async () => PROJECT),
    detect: vi.fn(async () => ({ type: "compose" })),
    guardrailsForProject: vi.fn(async () => ({ report: null, note: "sem código" })),
    startDeploy: vi.fn(async () => ({ id: "job-1", projectId: "p1", status: "queued" })),
    getJob: vi.fn(async () => null),
    listJobs: vi.fn(async () => []),
    stop: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    deleteProject: vi.fn(async () => undefined),
    addDomain: vi.fn(async () => PROJECT),
    removeDomain: vi.fn(async () => PROJECT),
    setPrimaryDomain: vi.fn(async () => PROJECT),
    domainPairs: vi.fn(async () => []),
    setDomainPair: vi.fn(async () => PROJECT),
    github: { repoVisibility: vi.fn(async () => "unknown") },
    getEnv: vi.fn(async () => [{ key: "A", value: "1" }]),
    composeVariablesFor: vi.fn(async () => null),
    providedEnvKeys: vi.fn(async () => ["SMTP_HOST"]),
    providedEnvValues: vi.fn(async () => ({ SMTP_HOST: "mail.exemplo.com" })),
    envLinkSources: vi.fn(async () => ({ SMTP_SENHA: "SMTP_PASS" })),
    mailTestInfo: vi.fn(async () => null),
    proxyInfo: vi.fn(async () => ({ network: "paas-net", ip: "172.20.0.2", subnet: "172.20.0.0/16" })),
    envExampleFor: vi.fn(async () => ({ files: [".env.example"], variables: [{ name: "SMTP_USUARIO", file: ".env.example" }] })),
    httpsStatus: vi.fn(async () => [
      { domain: "loja.x.sslip.io", ok: true, issuer: "Let's Encrypt", validTo: "2026-12-30T00:00:00.000Z", error: null },
    ]),
    setEnv: vi.fn(async (_id: string, vars: unknown) => vars),
    missingEnvFor: vi.fn(async () => []),
    revealProvidedEnv: vi.fn(async () => "segredo-da-caixa"),
    ...overrides,
  };
}

let ctx: AuthTestContext;
let app: FastifyInstance;
let service: ReturnType<typeof makeServiceStub>;

async function build(overrides: Record<string, unknown> = {}): Promise<void> {
  service = makeServiceStub(overrides);
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  app.decorate("deployService", service as unknown as DeployService);
  await app.register(projectsRoutes);
}

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

const auth = { [SETUP_TOKEN_HEADER]: TOKEN };

describe("autenticação", () => {
  beforeEach(() => build());

  it("todas as rotas de projetos exigem o setup token", async () => {
    for (const url of ["/api/projects", "/api/projects/p1", "/api/projects/p1/jobs"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json().error).toBe("unauthorized");
    }
  });
});

describe("GET /api/projects", () => {
  beforeEach(() => build());

  it("retorna os projetos com status calculado e URL", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects", headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]).toMatchObject({
      status: "running",
      url: "http://loja.localhost",
      project: { id: "p1", slug: "loja" },
    });
  });
});

describe("POST /api/projects", () => {
  it("cria projeto → 201 com o projeto e status", async () => {
    await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: auth,
      payload: { name: "Loja", ingestMode: "upload", source: "/tmp/loja", domain: "loja.localhost" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().project.id).toBe("p1");
    expect(service.createProject).toHaveBeenCalledOnce();
  });

  it("erro de domínio (409 domain_in_use) → mesmo status e código no corpo", async () => {
    await build({
      createProject: vi.fn(async () => {
        throw httpError(409, "domain_in_use", "O domínio já está em uso por outro projeto.");
      }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: auth,
      payload: { name: "Loja", ingestMode: "upload", source: "/tmp/loja", domain: "loja.localhost" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "domain_in_use" });
  });

  it("erro inesperado → 500 internal_error sem vazar detalhes", async () => {
    await build({
      createProject: vi.fn(async () => {
        throw new Error("falha interna inesperada");
      }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: auth,
      payload: { name: "Loja", ingestMode: "upload", source: "/tmp/loja", domain: "loja.localhost" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("internal_error");
  });

  it("sem corpo → 400 pelo schema, sem chegar ao service", async () => {
    // Mudança deliberada: a rota passou a validar o corpo por schema (Fastify),
    // então requisição sem corpo é recusada antes do service. Nenhum cliente do
    // painel faz POST /api/projects sem corpo.
    await build();
    const res = await app.inject({ method: "POST", url: "/api/projects", headers: auth });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(service.createProject).not.toHaveBeenCalled();
  });

  it("erro não-Error (throw de string) → 500 com mensagem genérica", async () => {
    await build({
      createProject: vi.fn(async () => {
        // eslint-disable-next-line no-throw-literal -- exercita o fallback do sendError
        throw "falha crua";
      }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: auth,
      payload: { name: "Loja", ingestMode: "upload", source: "/tmp/loja", domain: "loja.localhost" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal_error", message: "Erro interno." });
  });
});

describe("GET /api/projects/:id", () => {
  beforeEach(() => build());

  it("projeto inexistente → 404 project_not_found", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/xyz", headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("project_not_found");
  });

  it("projeto existente → 200 com status e URL", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/p1", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "running", url: "http://loja.localhost" });
  });
});

describe("POST /api/projects/:id/deploy", () => {
  it("inicia o job → 202 e repassa guardrailOverride=false por padrão", async () => {
    await build();
    const res = await app.inject({ method: "POST", url: "/api/projects/p1/deploy", headers: auth });
    expect(res.statusCode).toBe(202);
    expect(res.json().job).toMatchObject({ id: "job-1", status: "queued" });
    expect(service.startDeploy).toHaveBeenCalledWith("p1", { guardrailOverride: false });
  });

  it("guardrailOverride=true SEM sessão de login (só o setup token) é recusado e o deploy não roda", async () => {
    await build();
    service.startDeploy.mockClear();
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p1/deploy",
      headers: auth,
      payload: { guardrailOverride: true, acceptedBlocks: [], currentPassword: "x", code: "123456" },
    });
    expect(res.statusCode).toBe(401);
    expect(service.startDeploy).not.toHaveBeenCalled();
  });

  it("bloqueio por guardrails → 409 guardrail_blocked COM o relatório no corpo", async () => {
    const report: GuardrailReport = {
      ranAt: new Date().toISOString(),
      dir: "/tmp/loja",
      findings: [
        { rule: "db-port-exposed", level: "block", title: "Porta de banco", evidence: "compose.yml: db", fix: "remova" },
      ],
      blockers: 1,
      warnings: 0,
      infos: 0,
    };
    await build({
      startDeploy: vi.fn(async () => {
        const err = httpError(409, "guardrail_blocked", "Deploy bloqueado pelos guardrails.");
        err.report = report;
        throw err;
      }),
    });
    const res = await app.inject({ method: "POST", url: "/api/projects/p1/deploy", headers: auth });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe("guardrail_blocked");
    expect(body.report.blockers).toBe(1);
    expect(body.report.findings[0].rule).toBe("db-port-exposed");
  });

  it("variáveis obrigatórias faltando → 422 missing_env COM a lista no corpo", async () => {
    await build({
      startDeploy: vi.fn(async () => {
        const err = httpError(422, "missing_env", "Faltam 2 variáveis.");
        err.missing = ["KYC_MODO", "PIX_CHAVE"];
        throw err;
      }),
    });
    const res = await app.inject({ method: "POST", url: "/api/projects/p1/deploy", headers: auth });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "missing_env", missing: ["KYC_MODO", "PIX_CHAVE"] });
  });
});

describe("jobs e ciclo de vida", () => {
  beforeEach(() => build());

  it("GET /api/projects/:id/jobs/:jobId → 404 quando o job não existe", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/jobs/nope", headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("job_not_found");
  });

  it("POST /:id/stop agrega o log do serviço na resposta", async () => {
    await closeAuthTestApp(ctx);
    await build({
      stop: vi.fn(async (_id: string, onLog: (chunk: string) => void) => {
        onLog("parando containers…\n");
        onLog("feito.\n");
      }),
    });
    const res = await app.inject({ method: "POST", url: "/api/projects/p1/stop", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, log: "parando containers…\nfeito.\n" });
  });

  it("DELETE /:id agrega o log da remoção na resposta", async () => {
    await closeAuthTestApp(ctx);
    await build({
      deleteProject: vi.fn(async (_id: string, _deleteSource: boolean, onLog: (chunk: string) => void) => {
        onLog("removendo containers…\n");
        onLog("domínio removido.\n");
      }),
    });
    const res = await app.inject({ method: "DELETE", url: "/api/projects/p1", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, log: "removendo containers…\ndomínio removido.\n" });
  });

  it("DELETE /:id apaga também as liberações do banco do projeto (e só as dele)", async () => {
    await closeAuthTestApp(ctx);
    await build();
    const forgotten: string[] = [];
    app.decorate("databaseUnlock", { forgetProject: (id: string) => void forgotten.push(id) } as unknown as FastifyInstance["databaseUnlock"]);
    const res = await app.inject({ method: "DELETE", url: "/api/projects/p1", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(forgotten).toEqual(["p1"]);
  });

  it("DELETE /:id?deleteSource=true repassa o flag de remoção do código", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/projects/p1?deleteSource=true",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(service.deleteProject).toHaveBeenCalledWith("p1", true, expect.any(Function));
  });
});

describe("PATCH /api/projects/:id", () => {
  it("atualiza e retorna o projeto com status recalculado", async () => {
    await build();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/projects/p1",
      headers: auth,
      payload: { domain: "shop.localhost" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "running", project: { id: "p1" } });
    expect(service.updateProject).toHaveBeenCalledWith("p1", { domain: "shop.localhost" });
  });

  it("aceita a marca de projeto de desenvolvimento (boolean) e recusa outro tipo", async () => {
    await build();
    const ok = await app.inject({ method: "PATCH", url: "/api/projects/p1", headers: auth, payload: { development: true } });
    expect(ok.statusCode).toBe(200);
    expect(service.updateProject).toHaveBeenCalledWith("p1", { development: true });
    const bad = await app.inject({ method: "PATCH", url: "/api/projects/p1", headers: auth, payload: { development: "sim" } });
    expect(bad.statusCode).toBe(400);
  });

  it("sem corpo → 400 pelo schema, sem chegar ao service", async () => {
    // Mudança deliberada, mesmo motivo do POST: o corpo passou a ser validado
    // por schema. Um PATCH sem corpo não tem semântica útil.
    await build();
    const res = await app.inject({ method: "PATCH", url: "/api/projects/p1", headers: auth });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(service.updateProject).not.toHaveBeenCalled();
  });

  it("projeto inexistente → 404 mapeado do erro de domínio", async () => {
    await build({
      updateProject: vi.fn(async () => {
        throw httpError(404, "project_not_found", "Projeto não encontrado.");
      }),
    });
    const res = await app.inject({
      method: "PATCH",
      url: "/api/projects/xyz",
      headers: auth,
      payload: { domain: "x.localhost" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("project_not_found");
  });
});

describe("POST /api/projects/:id/detect e GET /:id/guardrails", () => {
  it("detect retorna a detecção do serviço", async () => {
    await build();
    const res = await app.inject({ method: "POST", url: "/api/projects/p1/detect", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().detection).toEqual({ type: "compose" });
  });

  it("detect com o tipo escolhido à mão repassa a escolha; null volta ao automático; sem corpo não escolhe nada", async () => {
    const detect = vi.fn(async () => ({ type: "static-node" }));
    await build({ detect });
    const post = async (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/api/projects/p1/detect", headers: auth, payload });
    expect((await post({ type: "static-node" })).statusCode).toBe(200);
    expect(detect).toHaveBeenLastCalledWith("p1", { type: "static-node" });
    await post({ type: null });
    expect(detect).toHaveBeenLastCalledWith("p1", { type: null });
    await post({});
    expect(detect).toHaveBeenLastCalledWith("p1", {});
    await app.inject({ method: "POST", url: "/api/projects/p1/detect", headers: auth });
    expect(detect).toHaveBeenLastCalledWith("p1", {});
  });

  it("detect recusa tipo que não pode ser escolhido (unknown, inventado) e campo extra", async () => {
    const detect = vi.fn(async () => ({ type: "compose" }));
    await build({ detect });
    for (const payload of [{ type: "unknown" }, { type: "php" }, { type: "static", extra: 1 }]) {
      const res = await app.inject({ method: "POST", url: "/api/projects/p1/detect", headers: auth, payload });
      expect(res.statusCode).toBe(400);
    }
    expect(detect).not.toHaveBeenCalled();
  });

  it("detect: escolha que não combina com o código → 422 invalid_type", async () => {
    await build({
      detect: vi.fn(async () => {
        throw httpError(422, "invalid_type", "Não há Dockerfile na raiz do projeto.");
      }),
    });
    const res = await app.inject({ method: "POST", url: "/api/projects/p1/detect", headers: auth, payload: { type: "dockerfile" } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("invalid_type");
  });

  it("detect em projeto inexistente → 404 mapeado", async () => {
    await build({
      detect: vi.fn(async () => {
        throw httpError(404, "project_not_found", "Projeto não encontrado.");
      }),
    });
    const res = await app.inject({ method: "POST", url: "/api/projects/xyz/detect", headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("project_not_found");
  });

  it("guardrails retorna relatório e nota", async () => {
    await build();
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/guardrails", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ report: null, note: "sem código" });
  });

  it("guardrails com erro inesperado → 500 sem vazar detalhes", async () => {
    await build({
      guardrailsForProject: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/guardrails", headers: auth });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("internal_error");
  });
});

describe("jobs e ciclo de vida (complementos)", () => {
  it("GET /jobs/:jobId retorna o job quando existe", async () => {
    await build({
      getJob: vi.fn(async () => ({ id: "job-9", projectId: "p1", status: "success" })),
    });
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/jobs/job-9", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().job).toMatchObject({ id: "job-9", status: "success" });
  });

  it("GET /jobs lista o histórico de deploys", async () => {
    await build({
      listJobs: vi.fn(async () => [{ id: "job-1" }, { id: "job-2" }]),
    });
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/jobs", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().jobs).toHaveLength(2);
  });

  it("GET /jobs em projeto inexistente → 404 project_not_found (mesmo contrato das outras rotas :id)", async () => {
    await build({
      listJobs: vi.fn(async () => {
        throw new Error("listJobs não deveria ser chamado para projeto inexistente");
      }),
    });
    const res = await app.inject({ method: "GET", url: "/api/projects/xyz/jobs", headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("project_not_found");
    expect(service.listJobs).not.toHaveBeenCalled();
  });

  it("parar e iniciar pelo painel avisam o monitoramento (reinício manual não é 'reinício sem parar'); projeto inexistente não avisa", async () => {
    const note = vi.fn();
    await closeAuthTestApp(ctx);
    service = makeServiceStub({ stop: vi.fn(async () => undefined), start: vi.fn(async () => undefined) });
    ctx = await buildAuthTestApp(TOKEN);
    app = ctx.app;
    app.decorate("deployService", service as unknown as DeployService);
    app.decorate("metrics", { collector: { noteManualAction: note } } as unknown as FastifyInstance["metrics"]);
    await app.register(projectsRoutes);
    expect((await app.inject({ method: "POST", url: "/api/projects/p1/stop", headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/projects/p1/start", headers: auth })).statusCode).toBe(200);
    expect(note.mock.calls).toEqual([["loja"], ["loja"]]);
    await app.inject({ method: "POST", url: "/api/projects/nao-existe/stop", headers: auth });
    expect(note).toHaveBeenCalledTimes(2);
  });

  it("POST /:id/stop com erro → status do erro de domínio e log parcial", async () => {
    await build({
      stop: vi.fn(async (_id: string, onLog: (chunk: string) => void) => {
        onLog("parando…\n");
        throw httpError(409, "deploy_in_progress", "Há um deploy em andamento.");
      }),
    });
    const res = await app.inject({ method: "POST", url: "/api/projects/p1/stop", headers: auth });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("deploy_in_progress");
  });

  it("POST /:id/start agrega o log; erro → mapeado", async () => {
    await build({
      start: vi.fn(async (_id: string, onLog: (chunk: string) => void) => {
        onLog("subindo…\n");
      }),
    });
    const okRes = await app.inject({ method: "POST", url: "/api/projects/p1/start", headers: auth });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.json()).toEqual({ ok: true, log: "subindo…\n" });

    await closeAuthTestApp(ctx);
    await build({
      start: vi.fn(async () => {
        throw httpError(404, "project_not_found", "Projeto não encontrado.");
      }),
    });
    const notFound = await app.inject({ method: "POST", url: "/api/projects/xyz/start", headers: auth });
    expect(notFound.statusCode).toBe(404);
  });

  it("DELETE /:id com erro → mapeado; sem query → deleteSource=false", async () => {
    await build({
      deleteProject: vi.fn(async () => {
        throw httpError(409, "deploy_in_progress", "Há um deploy em andamento.");
      }),
    });
    const res = await app.inject({ method: "DELETE", url: "/api/projects/p1", headers: auth });
    expect(res.statusCode).toBe(409);
    expect(service.deleteProject).toHaveBeenCalledWith("p1", false, expect.any(Function));
  });
});

describe("rotas de domínios do projeto", () => {
  it("conectar, tornar principal e remover chamam o serviço e devolvem o projeto", async () => {
    await build({
      addDomain: vi.fn(async () => ({ ...PROJECT, aliases: ["loja.example.com"] })),
      setPrimaryDomain: vi.fn(async () => PROJECT),
      removeDomain: vi.fn(async () => PROJECT),
    });
    const add = await app.inject({ method: "POST", url: "/api/projects/p1/domains", headers: auth, payload: { domain: "loja.example.com" } });
    expect(add.statusCode, add.body).toBe(200);
    expect(add.json().project.aliases).toEqual(["loja.example.com"]);
    expect(service.addDomain).toHaveBeenCalledWith("p1", "loja.example.com");
    const prim = await app.inject({ method: "POST", url: "/api/projects/p1/domains/loja.example.com/primary", headers: auth });
    expect(prim.statusCode).toBe(200);
    expect(service.setPrimaryDomain).toHaveBeenCalledWith("p1", "loja.example.com");
    const del = await app.inject({ method: "DELETE", url: "/api/projects/p1/domains/loja.example.com", headers: auth });
    expect(del.statusCode).toBe(200);
    expect(service.removeDomain).toHaveBeenCalledWith("p1", "loja.example.com");
  });

  it("erro do serviço vira a resposta dele (ex.: domínio em uso)", async () => {
    await build({ addDomain: vi.fn(async () => { throw Object.assign(new Error("O domínio x já está em uso."), { statusCode: 409, code: "domain_in_use" }); }) });
    const res = await app.inject({ method: "POST", url: "/api/projects/p1/domains", headers: auth, payload: { domain: "x.com" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("domain_in_use");
  });
});

describe("rotas do par (com/sem www) dos domínios", () => {
  it("lista o par de cada domínio do projeto", async () => {
    const pairs = [{ domain: "example.com", pair: "www.example.com", role: "www", enabled: true, state: "pointed", active: true }];
    await build({ domainPairs: vi.fn(async () => pairs) });
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/domains/pairs", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pairs });
    expect(service.domainPairs).toHaveBeenCalledWith("p1");
  });

  it("projeto inexistente: o erro do serviço volta", async () => {
    await build({ domainPairs: vi.fn(async () => { throw Object.assign(new Error("não existe"), { statusCode: 404, code: "not_found" }); }) });
    const res = await app.inject({ method: "GET", url: "/api/projects/zz/domains/pairs", headers: auth });
    expect(res.statusCode).toBe(404);
  });

  it("ligar e desligar chamam o serviço com o booleano; corpo inválido é recusado", async () => {
    await build({ setDomainPair: vi.fn(async () => PROJECT) });
    const off = await app.inject({ method: "PUT", url: "/api/projects/p1/domains/example.com/pair", headers: auth, payload: { enabled: false } });
    expect(off.statusCode, off.body).toBe(200);
    expect(service.setDomainPair).toHaveBeenCalledWith("p1", "example.com", false);
    const on = await app.inject({ method: "PUT", url: "/api/projects/p1/domains/example.com/pair", headers: auth, payload: { enabled: true } });
    expect(on.statusCode).toBe(200);
    expect(service.setDomainPair).toHaveBeenLastCalledWith("p1", "example.com", true);
    for (const payload of [{}, { enabled: "sim" }, { enabled: true, extra: 1 }]) {
      const bad = await app.inject({ method: "PUT", url: "/api/projects/p1/domains/example.com/pair", headers: auth, payload });
      expect(bad.statusCode).toBe(400);
    }
  });

  it("erro do serviço (domínio sem par) volta como veio", async () => {
    await build({ setDomainPair: vi.fn(async () => { throw Object.assign(new Error("sem par"), { statusCode: 400, code: "no_pair" }); }) });
    const res = await app.inject({ method: "PUT", url: "/api/projects/p1/domains/app.example.com/pair", headers: auth, payload: { enabled: false } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("no_pair");
  });

  it("conectar com pair:false repassa a escolha; sem pair, o serviço recebe só o domínio", async () => {
    await build({ addDomain: vi.fn(async () => PROJECT) });
    await app.inject({ method: "POST", url: "/api/projects/p1/domains", headers: auth, payload: { domain: "example.com", pair: false } });
    expect(service.addDomain).toHaveBeenCalledWith("p1", "example.com", { pair: false });
    await app.inject({ method: "POST", url: "/api/projects/p1/domains", headers: auth, payload: { domain: "example.com" } });
    expect(service.addDomain).toHaveBeenLastCalledWith("p1", "example.com");
    const bad = await app.inject({ method: "POST", url: "/api/projects/p1/domains", headers: auth, payload: { domain: "example.com", pair: "não" } });
    expect(bad.statusCode).toBe(400);
  });

  it("conectar com parent repassa rótulo e pai, sozinhos ou com pair:false; parent não-texto é 400", async () => {
    await build({ addDomain: vi.fn(async () => PROJECT) });
    const url = "/api/projects/p1/domains";
    const ok = await app.inject({ method: "POST", url, headers: auth, payload: { domain: "api", parent: "example.com" } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(service.addDomain).toHaveBeenLastCalledWith("p1", "api", { parent: "example.com" });
    await app.inject({ method: "POST", url, headers: auth, payload: { domain: "api", parent: "example.com", pair: false } });
    expect(service.addDomain).toHaveBeenLastCalledWith("p1", "api", { pair: false, parent: "example.com" });
    await app.inject({ method: "POST", url, headers: auth, payload: { domain: "@", parent: "example.com" } });
    expect(service.addDomain).toHaveBeenLastCalledWith("p1", "@", { parent: "example.com" });
    const bad = await app.inject({ method: "POST", url, headers: auth, payload: { domain: "api", parent: 5 } });
    expect(bad.statusCode).toBe(400);
  });

  it("PATCH aceita pair junto com o domínio", async () => {
    await build();
    const res = await app.inject({ method: "PATCH", url: "/api/projects/p1", headers: auth, payload: { domain: "example.com", pair: false } });
    expect(res.statusCode, res.body).toBe(200);
    expect(service.updateProject).toHaveBeenCalledWith("p1", { domain: "example.com", pair: false });
  });
});

describe("GET /api/projects/:id/repo-visibility", () => {
  it("pergunta ao GitHub (sem token) se o repositório do projeto é público", async () => {
    const repoVisibility = vi.fn(async () => "public");
    const git = { ...PROJECT, ingestMode: "git" as const, source: "https://github.com/kelvin/catalog" };
    await build({ github: { repoVisibility }, getProject: vi.fn(async () => git) });
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/repo-visibility", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ visibility: "public" });
    expect(repoVisibility).toHaveBeenCalledWith("https://github.com/kelvin/catalog");
  });

  it("origem que não é git: \"unknown\", sem consultar ninguém", async () => {
    const repoVisibility = vi.fn(async () => "public");
    await build({ github: { repoVisibility } });
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/repo-visibility", headers: auth });
    expect(res.json()).toEqual({ visibility: "unknown" });
    expect(repoVisibility).not.toHaveBeenCalled();
  });
});

describe("rotas de variáveis do projeto", () => {
  it("lê e salva a lista inteira", async () => {
    await build();
    const get = await app.inject({ method: "GET", url: "/api/projects/p1/env", headers: auth });
    expect(get.json()).toEqual({
      vars: [{ key: "A", value: "1" }],
      compose: null,
      provided: ["SMTP_HOST"],
      // valores do que o painel fornece (a senha nunca vem: providedEnvValues a tira)
      providedValues: { SMTP_HOST: "mail.exemplo.com" },
      links: { SMTP_SENHA: "SMTP_PASS" },
      example: { files: [".env.example"], variables: [{ name: "SMTP_USUARIO", file: ".env.example" }] },
      // caixa de teste de e-mail desligada
      mailTest: null,
      // cartão Rede e proxy
      proxy: { network: "paas-net", ip: "172.20.0.2", subnet: "172.20.0.0/16" },
    });
    const vars = [{ key: "DATABASE_URL", value: "postgres://x" }];
    const put = await app.inject({ method: "PUT", url: "/api/projects/p1/env", headers: auth, payload: { vars } });
    expect(put.statusCode, put.body).toBe(200);
    expect(service.setEnv).toHaveBeenCalledWith("p1", vars);
  });

  it("a marca \"de build\" chega ao serviço; só booleano é aceito", async () => {
    await build();
    const vars = [{ key: "VITE_API_URL", value: "https://api.example.com", build: true }, { key: "SEGREDO", value: "x" }];
    expect((await app.inject({ method: "PUT", url: "/api/projects/p1/env", headers: auth, payload: { vars } })).statusCode).toBe(200);
    expect(service.setEnv).toHaveBeenCalledWith("p1", vars);
    const bad = await app.inject({ method: "PUT", url: "/api/projects/p1/env", headers: auth, payload: { vars: [{ key: "A", value: "1", build: "sim" }] } });
    expect(bad.statusCode).toBe(400);
  });

  it("lista vazia é aceita (Apagar todas) e passa de 200 variáveis (um .env real de ~260)", async () => {
    await build();
    const vazia = await app.inject({ method: "PUT", url: "/api/projects/p1/env", headers: auth, payload: { vars: [] } });
    expect(vazia.statusCode, vazia.body).toBe(200);
    expect(service.setEnv).toHaveBeenLastCalledWith("p1", []);
    const muitas = Array.from({ length: 260 }, (_, i) => ({ key: `VAR_${i}`, value: "x" }));
    const grande = await app.inject({ method: "PUT", url: "/api/projects/p1/env", headers: auth, payload: { vars: muitas } });
    expect(grande.statusCode, grande.body).toBe(200);
    const demais = Array.from({ length: 1001 }, (_, i) => ({ key: `VAR_${i}`, value: "x" }));
    expect((await app.inject({ method: "PUT", url: "/api/projects/p1/env", headers: auth, payload: { vars: demais } })).statusCode).toBe(200); // o teto é do serviço (mensagem clara), não do schema
  });

  it("salvar com obrigatória faltando e marca de build recusada passa e devolve os avisos", async () => {
    await build({ missingEnvFor: vi.fn(async () => ["DB_PASS", "KYC_MODO"]) });
    const vars = [{ key: "PATH", value: "/x", build: true }, { key: "A", value: "1" }];
    const res = await app.inject({ method: "PUT", url: "/api/projects/p1/env", headers: auth, payload: { vars } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ vars, missing: ["DB_PASS", "KYC_MODO"], buildIssues: [{ name: "PATH", reason: "nome reservado" }] });
  });

  it("se o cálculo dos avisos falhar depois de gravar, responde sucesso sem avisos", async () => {
    await build({ missingEnvFor: vi.fn(async () => { throw new Error("mail.json corrompido"); }) });
    const vars = [{ key: "A", value: "1" }];
    const res = await app.inject({ method: "PUT", url: "/api/projects/p1/env", headers: auth, payload: { vars } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ vars, missing: [], buildIssues: [] });
    expect(service.setEnv).toHaveBeenCalledWith("p1", vars);
  });

  it("de ponta a ponta com o armazenamento real: 1001 → mensagem clara; nome inválido → 400; tudo certo → 200", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { ProjectEnvStore } = await import("../src/services/project-env.js");
    const dir = await mkdtemp(join(tmpdir(), "paas-rota-env-"));
    try {
      const store = new ProjectEnvStore(dir);
      await build({ setEnv: vi.fn(async (id: string, vars: Array<{ key: string; value: string }>) => store.set(id, vars)) });
      const put = (vars: unknown) => app.inject({ method: "PUT", url: "/api/projects/p1/env", headers: auth, payload: { vars } });
      const demais = await put(Array.from({ length: 1001 }, (_, i) => ({ key: `VAR_${i}`, value: "x" })));
      expect(demais.statusCode).toBe(400);
      expect(demais.json()).toMatchObject({ error: "too_many_env_vars", message: "No máximo 1000 variáveis." });
      const ruim = await put([{ key: "1RUIM", value: "x" }]);
      expect(ruim.statusCode).toBe(400);
      expect(ruim.json()).toMatchObject({ error: "invalid_env_key" });
      expect((await put([{ key: "OK", value: "1" }])).statusCode).toBe(200);
      expect(await store.get("p1")).toEqual([{ key: "OK", value: "1" }]);
    } finally {
      await removeDir(dir);
    }
  });

  it("corpo fora do formato → 400 antes de chegar ao serviço", async () => {
    await build();
    const res = await app.inject({ method: "PUT", url: "/api/projects/p1/env", headers: auth, payload: { vars: [{ key: "A" }] } });
    expect(res.statusCode).toBe(400);
    expect(service.setEnv).not.toHaveBeenCalled();
  });
});

/**
 * Mudança de decisão do dono do produto (04/10/2026): o olho da seção
 * Variáveis mostra qualquer variável, inclusive a senha da caixa. A listagem
 * (GET /env) continua sem ela; o valor vem por esta rota, uma variável por vez.
 */
describe("GET /api/projects/:id/env/provided/:name", () => {
  it("devolve o valor de uma variável fornecida pelo painel", async () => {
    await build();
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/env/provided/SMTP_PASS", headers: auth });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ name: "SMTP_PASS", value: "segredo-da-caixa" });
    expect(service.revealProvidedEnv).toHaveBeenCalledWith("p1", "SMTP_PASS");
  });

  it("nome fora do padrão → 400 antes de chegar ao serviço", async () => {
    await build();
    for (const nome of ["1ABC", "A-B", "A%20B"]) {
      const res = await app.inject({ method: "GET", url: `/api/projects/p1/env/provided/${nome}`, headers: auth });
      expect(res.statusCode, nome).toBe(400);
    }
    // nome longo demais: o próprio roteador recusa (414, parâmetro > 100 caracteres)
    const longo = await app.inject({ method: "GET", url: `/api/projects/p1/env/provided/${"A".repeat(129)}`, headers: auth });
    expect(longo.statusCode).toBeGreaterThanOrEqual(400);
    expect(service.revealProvidedEnv).not.toHaveBeenCalled();
  });

  it("erros do serviço (404 não fornecida, 429 limite) passam com o código", async () => {
    await build({ revealProvidedEnv: vi.fn(async () => Promise.reject(httpError(429, "reveal_rate_limited", "Espere."))) });
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/env/provided/SMTP_PASS", headers: auth });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe("reveal_rate_limited");
  });

  it("exige login", async () => {
    await build();
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/env/provided/SMTP_PASS" });
    expect(res.statusCode).toBe(401);
  });
});

describe("HTTPS do projeto", () => {
  it("GET /api/projects/:id/https devolve o estado do certificado de cada domínio", async () => {
    await build();
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/https", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      domains: [{ domain: "loja.x.sslip.io", ok: true, issuer: "Let's Encrypt", validTo: "2026-12-30T00:00:00.000Z", error: null }],
    });
  });

  it("exige login", async () => {
    await build();
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/https" });
    expect(res.statusCode).toBe(401);
  });
});

describe("backups na criação e na remoção do projeto", () => {
  it("'Fazer backup: sim/não' vai para o serviço de backups (sem escolha, o padrão dos projetos) e o projeto apagado é esquecido", async () => {
    await build();
    const order: string[] = [];
    const backups = {
      initProject: vi.fn(async () => undefined),
      beforeDeleteProject: vi.fn(async () => void order.push("antes")),
      forgetProject: vi.fn(async () => void order.push("depois")),
    };
    await closeAuthTestApp(ctx);
    service = makeServiceStub();
    ctx = await buildAuthTestApp(TOKEN);
    app = ctx.app;
    app.decorate("deployService", service as unknown as DeployService);
    app.decorate("backupService", backups as unknown as FastifyInstance["backupService"]);
    await app.register(projectsRoutes);
    const body = { name: "Loja", ingestMode: "git", source: "https://github.com/x/y.git", domain: "loja.localhost" };
    expect((await app.inject({ method: "POST", url: "/api/projects", headers: auth, payload: body })).statusCode).toBe(201);
    // sem a escolha: segue o padrão dos projetos
    expect(backups.initProject).toHaveBeenLastCalledWith("p1", undefined);
    await app.inject({ method: "POST", url: "/api/projects", headers: auth, payload: { ...body, backup: true } });
    expect(backups.initProject).toHaveBeenLastCalledWith("p1", true);
    await app.inject({ method: "POST", url: "/api/projects", headers: auth, payload: { ...body, backup: false } });
    expect(backups.initProject).toHaveBeenLastCalledWith("p1", false);
    expect((await app.inject({ method: "POST", url: "/api/projects", headers: auth, payload: { ...body, backup: "sim" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: "/api/projects/p1", headers: auth })).statusCode).toBeLessThan(300);
    expect(backups.forgetProject).toHaveBeenCalledWith("p1");
    // os bancos temporários do teste de restauração são varridos ANTES de o projeto sumir
    expect(backups.beforeDeleteProject).toHaveBeenCalledWith("p1");
    expect(order).toEqual(["antes", "depois"]);
    // falha na varredura não impede apagar o projeto
    backups.beforeDeleteProject.mockRejectedValueOnce(new Error("docker fora"));
    expect((await app.inject({ method: "DELETE", url: "/api/projects/p1", headers: auth })).statusCode).toBeLessThan(300);
    expect(backups.forgetProject).toHaveBeenCalledTimes(2);
  });

  it("sem o serviço de backups (instalação de teste) a criação continua", async () => {
    await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: auth,
      payload: { name: "Loja", ingestMode: "git", source: "https://github.com/x/y.git", domain: "loja.localhost", backup: true },
    });
    expect(res.statusCode).toBe(201);
  });
});
