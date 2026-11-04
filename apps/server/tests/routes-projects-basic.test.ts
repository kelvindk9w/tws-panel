/**
 * Carregamento progressivo: as versões "básicas" da lista e do projeto saem só do cadastro
 * (sem Docker) e respeitam o alcance do token; a lista completa monta todos os projetos na
 * ordem do cadastro; e a listagem de containers de várias telas ao mesmo tempo vira uma
 * única consulta ao Docker (com erro repassado a todos e sem guardar nada depois).
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DockerContainerInfo } from "@paas/core";
import { startRealPanel, type RealPanel } from "./helpers/real-panel.js";
import { removeDir } from "./helpers/tmp.js";

const dockerMock = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../src/services/docker-service.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/docker-service.js")>();
  return { ...real, listContainers: dockerMock.list };
});
const { DeployService } = await import("../src/services/deploy-service.js");

const MISSING = "0000000000000000";
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe("rotas básicas (sem Docker) com painel de verdade", () => {
  let panel: RealPanel;
  let A = "";
  let B = "";
  let tokenA = "";
  let tokenPanel = "";
  const human = () => ({ cookie: panel.cookie });

  beforeAll(async () => {
    dockerMock.list.mockReset();
    dockerMock.list.mockResolvedValue([]);
    panel = await startRealPanel();
    A = await panel.createProject("Fazenda", "fazenda.example.com");
    B = await panel.createProject("Loja", "loja.example.com");
    tokenA = (await panel.createToken({ name: "so-a", reach: "projects", projects: [A] })).token;
    tokenPanel = (await panel.createToken({ name: "painel", reach: "panel" })).token;
  }, 120_000);
  afterAll(async () => panel.close());

  it("GET /api/projects/basic: sessão vê todos, com URL e a credencial na versão pública, sem consultar o Docker", async () => {
    dockerMock.list.mockClear();
    const res = await panel.app.inject({ method: "GET", url: "/api/projects/basic", headers: human() });
    expect(res.statusCode).toBe(200);
    const items = res.json().projects as Array<{ project: { id: string }; url: string; credential: Record<string, unknown> }>;
    expect(items.map((p) => p.project.id).sort()).toEqual([A, B].sort());
    for (const item of items) {
      expect(typeof item.url).toBe("string");
      // só existência e dica: nunca o valor do token
      expect(item.credential).not.toHaveProperty("token");
      expect(item.credential).toHaveProperty("configured");
    }
    expect(res.json().projects[0]).not.toHaveProperty("status");
    expect(res.json().projects[0]).not.toHaveProperty("containers");
    expect(dockerMock.list).not.toHaveBeenCalled();
  });

  it("GET /api/projects/basic: token limitado só vê o seu projeto; token de painel inteiro vê todos", async () => {
    const limited = await panel.app.inject({ method: "GET", url: "/api/projects/basic", headers: bearer(tokenA) });
    expect(limited.statusCode).toBe(200);
    expect(limited.json().projects.map((p: { project: { id: string } }) => p.project.id)).toEqual([A]);
    expect(limited.body).not.toContain("loja.example.com");
    const all = await panel.app.inject({ method: "GET", url: "/api/projects/basic", headers: bearer(tokenPanel) });
    expect(all.json().projects).toHaveLength(2);
  });

  it("GET /api/projects/basic exige autenticação", async () => {
    const res = await panel.app.inject({ method: "GET", url: "/api/projects/basic" });
    expect(res.statusCode).toBe(401);
  });

  it("GET /api/projects/:id/basic: o projeto do alcance abre, sem Docker", async () => {
    dockerMock.list.mockClear();
    const res = await panel.app.inject({ method: "GET", url: `/api/projects/${A}/basic`, headers: bearer(tokenA) });
    expect(res.statusCode).toBe(200);
    expect(res.json().project.id).toBe(A);
    expect(res.json().credential).not.toHaveProperty("token");
    expect(res.json()).not.toHaveProperty("status");
    expect(dockerMock.list).not.toHaveBeenCalled();
  });

  it("GET /api/projects/:id/basic: fora do alcance e inexistente dão o mesmo 404", async () => {
    const outside = await panel.app.inject({ method: "GET", url: `/api/projects/${B}/basic`, headers: bearer(tokenA) });
    const missing = await panel.app.inject({ method: "GET", url: `/api/projects/${MISSING}/basic`, headers: bearer(tokenA) });
    expect(outside.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(outside.body).toBe(missing.body);
    const humanMissing = await panel.app.inject({ method: "GET", url: `/api/projects/${MISSING}/basic`, headers: human() });
    expect(humanMissing.statusCode).toBe(404);
    expect(humanMissing.json().error).toBe("project_not_found");
  });

  it("GET /api/projects (completa) monta todos os projetos, com status, na ordem do cadastro", async () => {
    const basic = await panel.app.inject({ method: "GET", url: "/api/projects/basic", headers: human() });
    const full = await panel.app.inject({ method: "GET", url: "/api/projects", headers: human() });
    expect(full.statusCode).toBe(200);
    const ids = (r: typeof full) => r.json().projects.map((p: { project: { id: string } }) => p.project.id);
    expect(ids(full)).toEqual(ids(basic));
    expect(full.json().projects[0].status).toBeDefined();
  });
});

describe("DeployService.listContainers (junta consultas simultâneas)", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "paas-coalesce-"));
    dockerMock.list.mockReset();
  });
  afterEach(async () => {
    await removeDir(dataDir);
  });
  const make = () =>
    new DeployService(
      { dataDir, projectsDir: path.join(dataDir, "projects"), caddyHttpPort: 80, caddyHttpsPort: 443, panelDomain: null, port: 9000 } as unknown as import("../src/config.js").ServerConfig,
      { audit: { record: vi.fn(async () => ({})) } as never },
    );

  it("três pedidos ao mesmo tempo viram uma só consulta ao Docker; o seguinte consulta de novo", async () => {
    let release!: (v: DockerContainerInfo[]) => void;
    dockerMock.list.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const svc = make();
    const all = Promise.all([svc.listContainers(), svc.listContainers(), svc.listContainers()]);
    release([]);
    await all;
    expect(dockerMock.list).toHaveBeenCalledTimes(1);
    // prazo próprio, mais curto que o padrão de 5 minutos
    expect(dockerMock.list.mock.calls[0]?.[1]).toBeLessThan(300_000);
    dockerMock.list.mockResolvedValueOnce([]);
    await svc.listContainers();
    expect(dockerMock.list).toHaveBeenCalledTimes(2);
  });

  it("falha do Docker chega a todos que esperavam, libera a vaga e a próxima chamada tenta de novo", async () => {
    dockerMock.list.mockRejectedValueOnce(new Error("sem docker"));
    const svc = make();
    const results = await Promise.allSettled([svc.listContainers(), svc.listContainers()]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(dockerMock.list).toHaveBeenCalledTimes(1);
    dockerMock.list.mockResolvedValueOnce([]);
    await expect(svc.listContainers()).resolves.toEqual([]);
    expect(dockerMock.list).toHaveBeenCalledTimes(2);
  });
});
