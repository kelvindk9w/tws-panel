/**
 * deploy-concurrency.test.ts — um projeto, um deploy por vez.
 *
 * Achado 10 da revisão: a guarda de `startDeploy` só olhava os jobs, e o job
 * só era registrado depois de vários `await` (detecção, variáveis, guardrails,
 * auditoria). Dois pedidos quase juntos (duas abas, ou "Publicar" junto do
 * restore "VPS nova") passavam os dois pela guarda e rodavam dois
 * `compose up` no mesmo clone. O mesmo valia para o reinício (`startRecreate`).
 *
 * Decisão: o segundo pedido é RECUSADO na hora (409 deploy_in_progress), com
 * a mesma mensagem de quando o job já está rodando — não fica esperando.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { DeployService } from "../src/services/deploy-service.js";

let dataDir: string;
let svc: DeployService;
let engineDeploy: ReturnType<typeof vi.fn>;
let engineRecreate: ReturnType<typeof vi.fn>;
/** Auditoria lenta: segura o primeiro pedido no meio do caminho, antes do job existir. */
let auditDelay: number;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-deploy-conc-"));
  auditDelay = 30;
  svc = new DeployService(
    { dataDir, projectsDir: path.join(dataDir, "projects"), caddyHttpPort: 80, caddyHttpsPort: 443, panelDomain: null, port: 9000 } as unknown as ServerConfig,
    { audit: { record: vi.fn(async () => new Promise((r) => setTimeout(() => r({}), auditDelay))) } as never },
  );
  engineDeploy = vi.fn(async () => new Promise<void>((r) => setTimeout(r, 50)));
  engineRecreate = vi.fn(async () => new Promise<void>((r) => setTimeout(r, 50)));
  const engine = (svc as unknown as { engine: { deploy: unknown; recreate: unknown } }).engine;
  engine.deploy = engineDeploy;
  engine.recreate = engineRecreate;
  (svc as unknown as { applyProxy: () => Promise<void> }).applyProxy = async () => undefined;
});

afterEach(async () => {
  await vi.waitFor(async () => {
    const jobs = (svc as unknown as { jobs: { finishedAt: string | null }[] }).jobs;
    expect(jobs.every((j) => j.finishedAt !== null)).toBe(true);
  });
  // as gravações do fim do job (projects.json, deploy-jobs.json) terminam antes de apagar a pasta
  await new Promise((r) => setTimeout(r, 100));
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function project(deployed = false) {
  const p = await svc.createProject({ name: "loja", ingestMode: "git", source: "https://github.com/k/loja", branch: "main", domain: "loja.localhost" });
  const stored = (await svc.getProject(p.id))!;
  stored.detection = { type: "static", warnings: [], details: [] } as never;
  if (deployed) stored.lastDeployStatus = "success";
  return p;
}

function codes(results: PromiseSettledResult<unknown>[]): (string | null)[] {
  return results.map((r) => (r.status === "fulfilled" ? null : (r.reason as { code?: string }).code ?? "erro"));
}

describe("reserva do projeto (teste de restauração de backup)", () => {
  it("enquanto o projeto está reservado, o deploy dele é recusado; ao soltar, volta a valer", async () => {
    const p = await project();
    const release = await svc.holdProject(p.id);
    await expect(svc.startDeploy(p.id)).rejects.toMatchObject({ code: "deploy_in_progress" });
    await expect(svc.holdProject(p.id)).rejects.toMatchObject({ code: "deploy_in_progress" });
    release();
    const job = await svc.startDeploy(p.id);
    expect(job.status).toBeDefined();
  });

  it("projeto que não existe: 404", async () => {
    await expect(svc.holdProject("nao-existe")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("um deploy por projeto", () => {
  it("dois deploys pedidos juntos: um roda, o outro é recusado com 409", async () => {
    const p = await project();
    const results = await Promise.allSettled([svc.startDeploy(p.id), svc.startDeploy(p.id)]);
    expect(codes(results).sort()).toEqual(["deploy_in_progress", null]);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.statusCode).toBe(409);
    expect(rejected.reason.message).toMatch(/Já existe um deploy em andamento/);
    expect(engineDeploy).toHaveBeenCalledTimes(1);
  });

  it("deploy e reinício pedidos juntos: só um passa", async () => {
    const p = await project(true);
    const results = await Promise.allSettled([svc.startDeploy(p.id), svc.startRecreate(p.id)]);
    expect(codes(results).sort()).toEqual(["deploy_in_progress", null]);
    expect(engineDeploy.mock.calls.length + engineRecreate.mock.calls.length).toBe(1);
  });

  it("dois reinícios pedidos juntos: um roda, o outro é recusado", async () => {
    const p = await project(true);
    const results = await Promise.allSettled([svc.startRecreate(p.id), svc.startRecreate(p.id)]);
    expect(codes(results).sort()).toEqual(["deploy_in_progress", null]);
    expect(engineRecreate).toHaveBeenCalledTimes(1);
  });

  it("projetos diferentes não se bloqueiam", async () => {
    const a = await project();
    const b = await svc.createProject({ name: "api", ingestMode: "git", source: "https://github.com/k/api", branch: "main", domain: "api.localhost" });
    (await svc.getProject(b.id))!.detection = { type: "static", warnings: [], details: [] } as never;
    const results = await Promise.allSettled([svc.startDeploy(a.id), svc.startDeploy(b.id)]);
    expect(codes(results)).toEqual([null, null]);
  });

  it("pedido recusado antes de virar job (tipo desconhecido) libera o projeto", async () => {
    const p = await project();
    const stored = (await svc.getProject(p.id))!;
    stored.detection = { type: "unknown", warnings: [], details: [] } as never;
    await expect(svc.startDeploy(p.id)).rejects.toMatchObject({ code: "unknown_type" });
    stored.detection = { type: "static", warnings: [], details: [] } as never;
    await expect(svc.startDeploy(p.id)).resolves.toMatchObject({ status: "running" });
  });

  it("reinício recusado (sem deploy anterior) libera o projeto para o deploy", async () => {
    const p = await project();
    await expect(svc.startRecreate(p.id)).rejects.toMatchObject({ code: "not_deployed" });
    await expect(svc.startDeploy(p.id)).resolves.toMatchObject({ status: "running" });
  });

  it("depois que o deploy termina, um novo deploy é aceito", async () => {
    auditDelay = 0;
    const p = await project();
    const job = await svc.startDeploy(p.id);
    await vi.waitFor(async () => expect((await svc.getJob(p.id, job.id))?.status).toBe("success"));
    await expect(svc.startDeploy(p.id)).resolves.toMatchObject({ status: "running" });
  });
});
