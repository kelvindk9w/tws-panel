/**
 * Testes das rotas de projetos (/api/projects/*) com o DeployService mockado:
 * auth obrigatória, mapeamento de erros de domínio (400/404/409/500) e o
 * fluxo de bloqueio por guardrails com o relatório no corpo do 409.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER, type Project } from "@paas/core";
import projectsRoutes from "../src/routes/projects.js";
import { httpError, type DeployService } from "../src/services/deploy-service.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

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
};

/** Stub do DeployService: métodos configuráveis por teste. */
function makeServiceStub(overrides: Record<string, unknown> = {}) {
  return {
    listContainers: vi.fn(async () => []),
    listProjects: vi.fn(async () => [PROJECT]),
    statusOf: vi.fn(async () => ({ status: "running" as const, containers: [] })),
    projectUrl: vi.fn((p: Project) => `http://${p.domain}`),
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
  app.decorate("deployService", service);
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

  it("sem corpo → createProject recebe {} (rota não quebra)", async () => {
    await build();
    const res = await app.inject({ method: "POST", url: "/api/projects", headers: auth });
    expect(res.statusCode).toBe(201);
    expect(service.createProject).toHaveBeenCalledWith({});
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

  it("repassa guardrailOverride=true quando confirmado explicitamente", async () => {
    await build();
    await app.inject({
      method: "POST",
      url: "/api/projects/p1/deploy",
      headers: auth,
      payload: { guardrailOverride: true },
    });
    expect(service.startDeploy).toHaveBeenCalledWith("p1", { guardrailOverride: true });
  });

  it("bloqueio por guardrails → 409 guardrail_blocked COM o relatório no corpo", async () => {
    const report = {
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

  it("sem corpo → atualiza com objeto vazio (não quebra)", async () => {
    await build();
    const res = await app.inject({ method: "PATCH", url: "/api/projects/p1", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(service.updateProject).toHaveBeenCalledWith("p1", {});
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
