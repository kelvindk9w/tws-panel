/**
 * Validação de schema das rotas de projetos.
 *
 * Sem `schema` no Fastify a API aceita qualquer corpo e a validação fica a
 * cargo dos services — inconsistente e fácil de esquecer. Estes testes fixam o
 * contrato: corpo malformado é recusado com 400 no formato de erro do painel
 * ({ error, message }) e o service nunca chega a ser chamado.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER, type Project } from "@paas/core";
import projectsRoutes from "../src/routes/projects.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };

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

let ctx: AuthTestContext;
let app: FastifyInstance;
let createProject: ReturnType<typeof vi.fn>;
let updateProject: ReturnType<typeof vi.fn>;
let deleteProjectMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  createProject = vi.fn(async () => PROJECT);
  updateProject = vi.fn(async () => PROJECT);
  deleteProjectMock = vi.fn(async () => undefined);
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  app.decorate("deployService", {
    listContainers: vi.fn(async () => []),
    listProjects: vi.fn(async () => [PROJECT]),
    statusOf: vi.fn(async () => ({ status: "running" as const, containers: [] })),
    projectUrl: vi.fn(() => "http://loja.localhost"),
    createProject,
    updateProject,
    getProject: vi.fn(async () => PROJECT),
    startDeploy: vi.fn(async () => ({ id: "job-1", projectId: "p1", status: "queued" })),
    deleteProject: deleteProjectMock,
  } as unknown as FastifyInstance["deployService"]);
  await app.register(projectsRoutes);
});

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

describe("POST /api/projects — schema", () => {
  it("aceita corpo válido", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: auth,
      payload: {
        name: "Loja",
        ingestMode: "git",
        source: "https://github.com/usuario/repo.git",
        branch: "main",
        domain: "loja.localhost",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(createProject).toHaveBeenCalledOnce();
  });

  it("recusa corpo sem os campos obrigatórios sem chamar o service", async () => {
    const res = await app.inject({ method: "POST", url: "/api/projects", headers: auth, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(createProject).not.toHaveBeenCalled();
  });

  it("recusa tipo errado em campo conhecido", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: auth,
      payload: { name: 123, ingestMode: "git", source: "https://x/y.git", domain: "a.localhost" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(createProject).not.toHaveBeenCalled();
  });

  it("recusa modo de ingestão fora da lista", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: auth,
      payload: { name: "X", ingestMode: "ftp", source: "https://x/y.git", domain: "a.localhost" },
    });
    expect(res.statusCode).toBe(400);
    expect(createProject).not.toHaveBeenCalled();
  });

  it("recusa propriedade desconhecida no corpo", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: auth,
      payload: {
        name: "X",
        ingestMode: "git",
        source: "https://x/y.git",
        domain: "a.localhost",
        isAdmin: true,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(createProject).not.toHaveBeenCalled();
  });

  it("não vaza o jargão do validador na mensagem", async () => {
    const res = await app.inject({ method: "POST", url: "/api/projects", headers: auth, payload: {} });
    const { message } = res.json();
    expect(message).not.toMatch(/must have required property/i);
    expect(message).not.toMatch(/body\//);
  });

  it("nomeia o campo obrigatório ausente, para a UI poder orientar", async () => {
    const res = await app.inject({ method: "POST", url: "/api/projects", headers: auth, payload: {} });
    expect(res.json().message).toMatch(/name/);
  });

  it("nomeia o campo com tipo errado", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: auth,
      payload: { name: 123, ingestMode: "git", source: "https://x/y.git", domain: "a.localhost" },
    });
    expect(res.json().message).toMatch(/name/);
  });

  it("nomeia a propriedade desconhecida recusada", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: auth,
      payload: {
        name: "X",
        ingestMode: "git",
        source: "https://x/y.git",
        domain: "a.localhost",
        isAdmin: true,
      },
    });
    expect(res.json().message).toMatch(/isAdmin/);
  });
});

describe("PATCH /api/projects/:id — schema", () => {
  it("recusa proxyPort não numérico", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/projects/p1",
      headers: auth,
      payload: { proxyPort: "oitenta" },
    });
    expect(res.statusCode).toBe(400);
    expect(updateProject).not.toHaveBeenCalled();
  });

  it("aceita o payload real do wizard, que limpa os overrides com null", async () => {
    // Reproduz apps/web/src/pages/NewProjectPage.tsx:167-172 — ao deixar os
    // campos de override em branco, a UI envia null para limpá-los. O schema
    // precisa aceitar null nesses campos, senão o último passo do wizard quebra.
    const res = await app.inject({
      method: "PATCH",
      url: "/api/projects/p1",
      headers: auth,
      payload: {
        domain: "loja.localhost",
        websocket: false,
        proxyService: null,
        proxyPort: null,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(updateProject).toHaveBeenCalledOnce();
  });

  it("recusa porta fora da faixa válida", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/projects/p1",
      headers: auth,
      payload: { proxyPort: 99999 },
    });
    expect(res.statusCode).toBe(400);
    expect(updateProject).not.toHaveBeenCalled();
  });
});

describe("POST /api/projects/:id/deploy — schema", () => {
  it("aceita o payload real do botão de deploy", async () => {
    // apps/web/src/pages/ProjectDetailPage.tsx:325
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p1/deploy",
      headers: auth,
      payload: { guardrailOverride: true },
    });
    expect(res.statusCode).toBe(202);
  });

  it("recusa guardrailOverride não booleano", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p1/deploy",
      headers: auth,
      payload: { guardrailOverride: "sim" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("recusa campo desconhecido no corpo do deploy", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p1/deploy",
      headers: auth,
      payload: { guardrailOverride: true, forcaBruta: 1 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("params de projeto — schema", () => {
  it("recusa id acima do tamanho máximo antes de consultar o service", async () => {
    // 100 chars: acima do maxLength (64) do schema e abaixo do limite de URL do
    // Fastify — acima dele o servidor responde 414 antes de qualquer validação.
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${"a".repeat(100)}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("aceita id em formato normal", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/p1", headers: auth });
    expect(res.statusCode).toBe(200);
  });
});

describe("DELETE /api/projects/:id — schema", () => {
  it("aceita deleteSource=true (apaga o código-fonte do disco)", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/projects/p1?deleteSource=true",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(deleteProjectMock).toHaveBeenCalledWith("p1", true, expect.any(Function));
  });

  it("aceita deleteSource=false", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/projects/p1?deleteSource=false",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(deleteProjectMock).toHaveBeenCalledWith("p1", false, expect.any(Function));
  });

  it("recusa valor fora de true/false em deleteSource", async () => {
    // O parâmetro decide se o código-fonte é apagado do disco: qualquer valor
    // ambíguo deve ser recusado, não interpretado como false por omissão.
    const res = await app.inject({
      method: "DELETE",
      url: "/api/projects/p1?deleteSource=talvez",
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(deleteProjectMock).not.toHaveBeenCalled();
  });

  it("recusa querystring desconhecida", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/projects/p1?deleteEverything=true",
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(deleteProjectMock).not.toHaveBeenCalled();
  });
});
