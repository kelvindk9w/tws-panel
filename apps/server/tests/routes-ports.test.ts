/**
 * Rotas de portas (modal "Portas"): leitura autenticada do mapa do projeto e
 * de todo o servidor, e a troca com o corpo validado por schema.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SETUP_TOKEN_HEADER } from "@paas/core";
import projectsRoutes from "../src/routes/projects.js";
import { httpError, type DeployService } from "../src/services/deploy-service.js";
import { buildAuthTestApp, closeAuthTestApp, type AuthTestContext } from "./test-utils.js";

const TOKEN = "token-de-teste";
const auth = { [SETUP_TOKEN_HEADER]: TOKEN };

const OVERVIEW = { docker: true, rows: [], reserved: [80, 443] };
const PROJECT_PORTS = { ...OVERVIEW, project: { projectId: "p1", services: [] } };

let ctx: AuthTestContext;
let app: FastifyInstance;
let service: Record<string, ReturnType<typeof vi.fn>>;

async function build(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  service = {
    portsOverview: vi.fn(async () => OVERVIEW),
    projectPorts: vi.fn(async () => PROJECT_PORTS),
    setPort: vi.fn(async () => PROJECT_PORTS),
    setPorts: vi.fn(async () => PROJECT_PORTS),
    ...overrides,
  };
  ctx = await buildAuthTestApp(TOKEN);
  app = ctx.app;
  app.decorate("deployService", service as unknown as DeployService);
  await app.register(projectsRoutes);
}

afterEach(async () => {
  await closeAuthTestApp(ctx);
});

describe("portas", () => {
  it("exigem autenticação", async () => {
    await build();
    for (const [method, url] of [
      ["GET", "/api/ports"],
      ["GET", "/api/projects/p1/ports"],
      ["PUT", "/api/projects/p1/ports"],
      ["PUT", "/api/projects/p1/ports/batch"],
    ] as const) {
      const res = await app.inject({ method, url, payload: method === "PUT" ? { service: "a", original: "1:1", action: "remove" } : undefined });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it("GET /api/ports devolve todas as portas", async () => {
    await build();
    const res = await app.inject({ method: "GET", url: "/api/ports", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(OVERVIEW);
  });

  it("GET /api/projects/:id/ports devolve o projeto e todas", async () => {
    await build();
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/ports", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(PROJECT_PORTS);
    expect(service.projectPorts).toHaveBeenCalledWith("p1");
  });

  it("GET de projeto inexistente: 404 com o código", async () => {
    await build({ projectPorts: vi.fn(async () => Promise.reject(httpError(404, "project_not_found", "Projeto não encontrado."))) });
    const res = await app.inject({ method: "GET", url: "/api/projects/zz/ports", headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("project_not_found");
  });

  it("GET /api/ports com falha inesperada: 500", async () => {
    await build({ portsOverview: vi.fn(async () => Promise.reject(new Error("boom"))) });
    const res = await app.inject({ method: "GET", url: "/api/ports", headers: auth });
    expect(res.statusCode).toBe(500);
  });

  it("PUT troca a porta e devolve o mapa novo", async () => {
    await build();
    const body = { service: "api", original: "127.0.0.1:8010:8010", action: "change", hostPort: 18010, hostIp: "0.0.0.0" };
    const res = await app.inject({ method: "PUT", url: "/api/projects/p1/ports", headers: auth, payload: body });
    expect(res.statusCode).toBe(200);
    expect(service.setPort).toHaveBeenCalledWith("p1", body);
  });

  it("PUT com erro de domínio repassa status e código", async () => {
    await build({ setPort: vi.fn(async () => Promise.reject(httpError(409, "port_in_use", "A porta 9000 é reservada."))) });
    const res = await app.inject({
      method: "PUT",
      url: "/api/projects/p1/ports",
      headers: auth,
      payload: { service: "api", original: "1:1", action: "change", hostPort: 9000 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "port_in_use", message: "A porta 9000 é reservada." });
  });

  it("PUT recusa corpo inválido: porta fora da faixa, endereço, ação e campo desconhecido", async () => {
    await build();
    for (const payload of [
      { service: "api", original: "1:1", action: "change", hostPort: 80 },
      { service: "api", original: "1:1", action: "change", hostPort: 70000 },
      { service: "api", original: "1:1", action: "change", hostIp: "10.0.0.1" },
      { service: "api", original: "1:1", action: "apagar" },
      { service: "api", original: "1:1", action: "remove", extra: true },
      { original: "1:1", action: "remove" },
    ]) {
      const res = await app.inject({ method: "PUT", url: "/api/projects/p1/ports", headers: auth, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(service.setPort).not.toHaveBeenCalled();
  });

  it("PUT /batch grava a lista completa numa chamada", async () => {
    await build();
    const body = {
      ports: [
        { service: "api", original: "127.0.0.1:8010:8010", hostPort: 18010, hostIp: "0.0.0.0" },
        { service: "db", original: "5432:5432", hostPort: null },
        { service: "db", containerPort: 5432, protocol: "tcp", hostPort: 15432, hostIp: "127.0.0.1" },
      ],
    };
    const res = await app.inject({ method: "PUT", url: "/api/projects/p1/ports/batch", headers: auth, payload: body });
    expect(res.statusCode).toBe(200);
    expect(service.setPorts).toHaveBeenCalledWith("p1", body);
  });

  it("PUT /batch com erro nas linhas devolve os erros de cada uma", async () => {
    const err = Object.assign(httpError(400, "invalid_ports", "1 porta com problema."), {
      details: { errors: [{ index: 0, message: "A porta 9000 é reservada." }] },
    });
    await build({ setPorts: vi.fn(async () => Promise.reject(err)) });
    const res = await app.inject({
      method: "PUT",
      url: "/api/projects/p1/ports/batch",
      headers: auth,
      payload: { ports: [{ service: "db", containerPort: 5432, hostPort: 9000 }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_ports", errors: [{ index: 0, message: "A porta 9000 é reservada." }] });
  });

  it("PUT /batch recusa corpo inválido", async () => {
    await build();
    for (const payload of [
      {},
      { ports: "x" },
      { ports: [{ service: "db", containerPort: 5432, hostPort: 80 }] },
      { ports: [{ service: "db", containerPort: 0, hostPort: 15432 }] },
      { ports: [{ service: "db", containerPort: 5432, hostPort: 15432, hostIp: "10.0.0.1" }] },
      { ports: [{ service: "db", containerPort: 5432, hostPort: 15432, protocol: "sctp" }] },
      { ports: [{ service: "db", containerPort: 5432, hostPort: 15432, extra: 1 }] },
      { ports: [{ containerPort: 5432, hostPort: 15432 }] },
      { ports: [{ service: "db", containerPort: 5432 }] },
      { ports: Array.from({ length: 201 }, () => ({ service: "db", containerPort: 5432, hostPort: 15432 })) },
    ]) {
      const res = await app.inject({ method: "PUT", url: "/api/projects/p1/ports/batch", headers: auth, payload });
      expect(res.statusCode, JSON.stringify(payload).slice(0, 80)).toBe(400);
    }
    expect(service.setPorts).not.toHaveBeenCalled();
  });
});
