/**
 * GET/POST /api/projects/.../update-status — alerta de "nova atualização" (só aviso).
 * Autenticadas, com schema, sem o cliente escolher URL/branch, "Verificar agora" com limite
 * por projeto e resposta sem segredos.
 */
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER, type ProjectUpdateStatus } from "@paas/core";
import projectsRoutes from "../src/routes/projects.js";
import { httpError, type DeployService } from "../src/services/deploy-service.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";

const STATUS: ProjectUpdateStatus = {
  projectId: "p1",
  state: "update_available",
  branch: "main",
  remoteCommit: "bbbbbbb",
  deployedCommit: "aaaaaaa",
  reason: null,
  checkedAt: "2026-10-22T10:00:00.000Z",
};

let ctx: AuthTestContext;
let app: FastifyInstance;
let updateStatus: ReturnType<typeof vi.fn>;
let updateStatuses: ReturnType<typeof vi.fn>;

async function build(withRateLimit = false): Promise<void> {
  updateStatus = vi.fn(async (id: string) => {
    if (id !== "p1" && id !== "p2") throw httpError(404, "project_not_found", "Projeto não encontrado.");
    return { ...STATUS, projectId: id };
  });
  updateStatuses = vi.fn(async () => [STATUS]);
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  if (withRateLimit) await app.register(rateLimit, { max: 200, timeWindow: "1 minute" });
  app.decorate("deployService", { updateStatus, updateStatuses } as unknown as DeployService);
  await app.register(projectsRoutes);
}

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

const auth = { [SETUP_TOKEN_HEADER]: TOKEN };

describe("autenticação", () => {
  it("as três rotas exigem sessão", async () => {
    await build();
    for (const [method, url] of [
      ["GET", "/api/projects/update-status"],
      ["GET", "/api/projects/p1/update-status"],
      ["POST", "/api/projects/p1/update-status/check"],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, url).toBe(401);
    }
    expect(updateStatus).not.toHaveBeenCalled();
    expect(updateStatuses).not.toHaveBeenCalled();
  });
});

describe("GET /api/projects/update-status", () => {
  it("lista o estado de todos os projetos (a rota fixa não é confundida com :id)", async () => {
    await build();
    const res = await app.inject({ method: "GET", url: "/api/projects/update-status", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ statuses: [STATUS] });
    expect(updateStatuses).toHaveBeenCalledTimes(1);
  });

  it("erro inesperado vira resposta de erro, sem derrubar", async () => {
    await build();
    updateStatuses.mockRejectedValueOnce(new Error("boom"));
    const res = await app.inject({ method: "GET", url: "/api/projects/update-status", headers: auth });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("internal_error");
  });
});

describe("GET /api/projects/:id/update-status", () => {
  it("devolve o estado do projeto, sem forçar consulta", async () => {
    await build();
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/update-status", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: STATUS });
    expect(updateStatus).toHaveBeenCalledWith("p1");
  });

  it("projeto inexistente: 404", async () => {
    await build();
    const res = await app.inject({ method: "GET", url: "/api/projects/nada/update-status", headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("project_not_found");
  });
});

describe("POST /api/projects/:id/update-status/check", () => {
  it("força nova consulta, sem corpo", async () => {
    await build();
    const res = await app.inject({ method: "POST", url: "/api/projects/p1/update-status/check", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: STATUS });
    expect(updateStatus).toHaveBeenCalledWith("p1", { force: true });
  });

  it("o cliente não escolhe endereço nem branch: corpo com campo é recusado e nada é consultado", async () => {
    await build();
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/p1/update-status/check",
      headers: auth,
      payload: { source: "http://169.254.169.254/", branch: "x" },
    });
    expect(res.statusCode).toBe(400);
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it("projeto inexistente: 404", async () => {
    await build();
    const res = await app.inject({ method: "POST", url: "/api/projects/nada/update-status/check", headers: auth });
    expect(res.statusCode).toBe(404);
  });

  it("limite por projeto: 6 por minuto num projeto não bloqueia outro", async () => {
    await build(true);
    const post = (id: string) =>
      app.inject({ method: "POST", url: `/api/projects/${id}/update-status/check`, headers: auth });
    for (let i = 0; i < 6; i++) expect((await post("p1")).statusCode).toBe(200);
    expect((await post("p1")).statusCode).toBe(429);
    expect((await post("p2")).statusCode).toBe(200);
  });

  it("a resposta não carrega segredos", async () => {
    await build();
    const res = await app.inject({ method: "POST", url: "/api/projects/p1/update-status/check", headers: auth });
    expect(Object.keys(res.json().status).sort()).toEqual([
      "branch",
      "checkedAt",
      "deployedCommit",
      "projectId",
      "reason",
      "remoteCommit",
      "state",
    ]);
  });
});
