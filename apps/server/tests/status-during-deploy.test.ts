/**
 * Estado do projeto durante o deploy: o Docker ocupado recriando containers
 * pode não responder à listagem. Durante o deploy isso é esperado — o
 * projeto continua "deploying" (sem lista de containers) em vez de a página
 * receber um erro a cada consulta (era o texto vermelho que piscava acima do
 * menu do projeto). Fora do deploy, a falha continua aparecendo.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/docker-service.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/docker-service.js")>();
  return {
    ...real,
    listContainers: vi.fn(async () => {
      throw new real.DockerUnavailableError("não foi possível listar containers via Docker: tempo esgotado");
    }),
  };
});

const { DeployService } = await import("../src/services/deploy-service.js");
type ServerConfig = import("../src/config.js").ServerConfig;

let dataDir: string;
let svc: InstanceType<typeof DeployService>;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-status-"));
  svc = new DeployService(
    { dataDir, projectsDir: path.join(dataDir, "projects"), caddyHttpPort: 80, caddyHttpsPort: 443, panelDomain: null, port: 9000 } as unknown as ServerConfig,
    { audit: { record: vi.fn(async () => ({})) } as never },
  );
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("statusOf com o Docker sem responder", () => {
  it("durante o deploy: estado normal (deploying), sem containers", async () => {
    const p = await svc.createProject({ name: "loja", ingestMode: "git", source: "https://github.com/k/loja", branch: "main", domain: "loja.localhost" });
    (svc as unknown as { jobs: Array<{ projectId: string; status: string }> }).jobs.push({ projectId: p.id, status: "running" });
    expect(await svc.statusOf(p)).toEqual({ status: "deploying", containers: [] });
  });

  it("fora do deploy: a falha continua visível", async () => {
    const p = await svc.createProject({ name: "loja", ingestMode: "git", source: "https://github.com/k/loja", branch: "main", domain: "loja.localhost" });
    await expect(svc.statusOf(p)).rejects.toThrow(/não foi possível listar containers/);
  });
});
