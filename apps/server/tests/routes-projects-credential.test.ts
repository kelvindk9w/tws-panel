/**
 * API da credencial de LEITURA do repositório privado de um projeto.
 *
 * Contrato inegociável: o valor do token NUNCA volta pela API. As respostas
 * podem dizer que existe uma credencial e, no máximo, os 4 últimos caracteres
 * como dica. A auditoria registra o FATO (definida/removida), nunca o valor.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER, type Project, type ProjectCredentialInfo } from "@paas/core";
import projectsRoutes from "../src/routes/projects.js";
import { httpError, type DeployService } from "../src/services/deploy-service.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const SEGREDO = "tok-fake-de-teste-supersecreto-42";

const PROJECT: Project = {
  id: "p1",
  name: "Loja",
  slug: "loja",
  ingestMode: "git",
  source: "https://github.com/usuario/repo.git",
  branch: "main",
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

const INFO_COM_CREDENCIAL: ProjectCredentialInfo = {
  configured: true,
  hint: SEGREDO.slice(-4),
  username: "x-access-token",
  updatedAt: new Date().toISOString(),
};

const INFO_SEM_CREDENCIAL: ProjectCredentialInfo = {
  configured: false,
  hint: null,
  username: null,
  updatedAt: null,
};

function makeServiceStub(overrides: Record<string, unknown> = {}) {
  return {
    listContainers: vi.fn(async () => []),
    listProjects: vi.fn(async () => [PROJECT]),
    statusOf: vi.fn(async () => ({ status: "running" as const, containers: [] })),
    projectUrl: vi.fn((p: Project) => `http://${p.domain}`),
    createProject: vi.fn(async () => PROJECT),
    getProject: vi.fn(async (id: string) => (id === "p1" ? PROJECT : null)),
    updateProject: vi.fn(async () => PROJECT),
    credentialInfo: vi.fn(async () => INFO_COM_CREDENCIAL),
    setCredential: vi.fn(async () => INFO_COM_CREDENCIAL),
    removeCredential: vi.fn(async () => true),
    detect: vi.fn(async () => ({ type: "compose" })),
    guardrailsForProject: vi.fn(async () => ({ report: null, note: null })),
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
  app.decorate("deployService", service as unknown as DeployService);
  await app.register(projectsRoutes);
}

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

const auth = { [SETUP_TOKEN_HEADER]: TOKEN };

describe("PUT /api/projects/:id/credential", () => {
  it("define a credencial e devolve só existência + dica", async () => {
    await build();
    const res = await app.inject({
      method: "PUT",
      url: "/api/projects/p1/credential",
      headers: auth,
      payload: { token: SEGREDO },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().credential).toEqual(INFO_COM_CREDENCIAL);
    expect(service.setCredential).toHaveBeenCalledWith("p1", { token: SEGREDO });
  });

  it("aceita username explícito", async () => {
    await build();
    const res = await app.inject({
      method: "PUT",
      url: "/api/projects/p1/credential",
      headers: auth,
      payload: { token: SEGREDO, username: "meu-usuario" },
    });
    expect(res.statusCode).toBe(200);
    expect(service.setCredential).toHaveBeenCalledWith("p1", {
      token: SEGREDO,
      username: "meu-usuario",
    });
  });

  it("exige o token no corpo (400 de schema)", async () => {
    await build();
    const res = await app.inject({
      method: "PUT",
      url: "/api/projects/p1/credential",
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("recusa campo desconhecido no corpo", async () => {
    await build();
    const res = await app.inject({
      method: "PUT",
      url: "/api/projects/p1/credential",
      headers: auth,
      payload: { token: SEGREDO, escopo: "write" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("projeto inexistente → 404 com o código de domínio", async () => {
    await build({
      setCredential: vi.fn(async () => {
        throw httpError(404, "project_not_found", "Projeto não encontrado.");
      }),
    });
    const res = await app.inject({
      method: "PUT",
      url: "/api/projects/p9/credential",
      headers: auth,
      payload: { token: SEGREDO },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("project_not_found");
  });

  it("exige autenticação", async () => {
    await build();
    const res = await app.inject({
      method: "PUT",
      url: "/api/projects/p1/credential",
      payload: { token: SEGREDO },
    });
    expect(res.statusCode).toBe(401);
  });

  it("audita mesmo quando o cofre não sabe o usuário nem a dica do token", async () => {
    // Credencial guardada sem username e sem dica: a auditoria continua
    // registrando o fato, com marcadores no lugar dos dados ausentes.
    await build({
      setCredential: vi.fn(async () => ({ ...INFO_COM_CREDENCIAL, username: null, hint: null })),
    });
    const res = await app.inject({
      method: "PUT",
      url: "/api/projects/p1/credential",
      headers: auth,
      payload: { token: SEGREDO },
    });
    expect(res.statusCode).toBe(200);
    await ctx.auditService.flush();
    const { entries } = await ctx.auditService.list();
    const registro = entries.find((e) => e.action === "project.credential.set");
    expect(registro?.detail).toContain('usuário "-"');
    expect(registro?.detail).toContain("terminado em ????");
  });

  it("audita o FATO de a credencial ter sido definida — nunca o valor", async () => {
    await build();
    await app.inject({
      method: "PUT",
      url: "/api/projects/p1/credential",
      headers: auth,
      payload: { token: SEGREDO },
    });
    await ctx.auditService.flush();
    const { entries } = await ctx.auditService.list();
    const registro = entries.find((e) => e.action === "project.credential.set");
    expect(registro).toBeTruthy();
    expect(JSON.stringify(entries)).not.toContain(SEGREDO);
  });
});

describe("DELETE /api/projects/:id/credential", () => {
  it("remove a credencial", async () => {
    await build();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/projects/p1/credential",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, credential: INFO_SEM_CREDENCIAL });
    expect(service.removeCredential).toHaveBeenCalledWith("p1");
  });

  it("projeto inexistente → 404", async () => {
    await build({
      removeCredential: vi.fn(async () => {
        throw httpError(404, "project_not_found", "Projeto não encontrado.");
      }),
    });
    const res = await app.inject({
      method: "DELETE",
      url: "/api/projects/p9/credential",
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });

  it("remover credencial de projeto que não tinha nenhuma responde sucesso", async () => {
    await build({ removeCredential: vi.fn(async () => false) });
    const res = await app.inject({
      method: "DELETE",
      url: "/api/projects/p1/credential",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, credential: INFO_SEM_CREDENCIAL });
  });

  it("a auditoria distingue remoção real de remoção sem credencial cadastrada", async () => {
    // Projeto COM credencial: o registro diz que ela saiu do cofre.
    await build();
    await app.inject({ method: "DELETE", url: "/api/projects/p1/credential", headers: auth });
    await ctx.auditService.flush();
    const comCredencial = (await ctx.auditService.list()).entries.find(
      (e) => e.action === "project.credential.remove",
    );
    expect(comCredencial?.detail).toContain("removida do cofre");
    await closeAuthTestApp(ctx);

    // Projeto SEM credencial: o registro diz que não havia nada cadastrado.
    await build({ removeCredential: vi.fn(async () => false) });
    await app.inject({ method: "DELETE", url: "/api/projects/p1/credential", headers: auth });
    await ctx.auditService.flush();
    const semCredencial = (await ctx.auditService.list()).entries.find(
      (e) => e.action === "project.credential.remove",
    );
    expect(semCredencial?.detail).toContain("não tinha nenhuma cadastrada");
  });

  it("audita o FATO da remoção", async () => {
    await build();
    await app.inject({ method: "DELETE", url: "/api/projects/p1/credential", headers: auth });
    await ctx.auditService.flush();
    const { entries } = await ctx.auditService.list();
    expect(entries.some((e) => e.action === "project.credential.remove")).toBe(true);
  });
});

describe("o segredo nunca aparece em NENHUMA resposta da API de projetos", () => {
  it("listagem, detalhe, criação e atualização só expõem configured/hint", async () => {
    await build();
    const respostas = [
      await app.inject({ method: "GET", url: "/api/projects", headers: auth }),
      await app.inject({ method: "GET", url: "/api/projects/p1", headers: auth }),
      await app.inject({
        method: "POST",
        url: "/api/projects",
        headers: auth,
        payload: {
          name: "Loja",
          ingestMode: "git",
          source: "https://github.com/usuario/repo.git",
          domain: "loja.localhost",
        },
      }),
      await app.inject({
        method: "PATCH",
        url: "/api/projects/p1",
        headers: auth,
        payload: { name: "Loja 2" },
      }),
      await app.inject({
        method: "PUT",
        url: "/api/projects/p1/credential",
        headers: auth,
        payload: { token: SEGREDO },
      }),
      await app.inject({ method: "DELETE", url: "/api/projects/p1/credential", headers: auth }),
    ];
    for (const res of respostas) {
      expect(res.statusCode, res.body).toBeLessThan(400);
      expect(res.body).not.toContain(SEGREDO);
      expect(res.body).not.toMatch(/"token"/);
    }
  });

  it("a listagem informa a existência da credencial de cada projeto", async () => {
    await build();
    const res = await app.inject({ method: "GET", url: "/api/projects", headers: auth });
    expect(res.json().projects[0].credential).toEqual(INFO_COM_CREDENCIAL);
  });
});
