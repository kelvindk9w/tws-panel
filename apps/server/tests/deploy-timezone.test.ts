/**
 * deploy-timezone.test.ts — campo "Fuso horário" do projeto: a escolha
 * (padrão da imagem, igual ao da VPS, um fuso específico), quem já define TZ
 * no próprio projeto, o aviso de reiniciar e o reinício que recria os
 * containers sem baixar código. O Docker é um dublê.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DockerContainerInfo, Project } from "@paas/core";
import type { ServerConfig } from "../src/config.js";

const containers: DockerContainerInfo[] = [];
const probe = vi.fn(async (_id: string, zone: string | null) => ({ tz: zone, zoneinfo: zone ? false : null }));
vi.mock("../src/services/docker-service.js", () => ({
  listContainers: vi.fn(async () => containers),
  containerTimezone: (id: string, zone: string | null) => probe(id, zone),
}));

const { DeployService } = await import("../src/services/deploy-service.js");

let dataDir: string;
let projectsDir: string;
let svc: InstanceType<typeof DeployService>;
const record = vi.fn(async () => ({}));

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-dtz-"));
  projectsDir = path.join(dataDir, "projects");
  await mkdir(projectsDir, { recursive: true });
  record.mockClear();
  probe.mockClear();
  containers.length = 0;
  svc = new DeployService(
    { dataDir, projectsDir, caddyHttpPort: 80, caddyHttpsPort: 443, panelDomain: null, port: 9000 } as unknown as ServerConfig,
    { audit: { record } as never },
  );
  svc.setHostTimezoneProvider(() => "America/Sao_Paulo");
});

afterEach(async () => {
  // o fim do job grava projects.json e depois deploy-jobs.json em segundo
  // plano: espera a última gravação antes de apagar a pasta (a gravação é
  // atômica, e um rename numa pasta já apagada falharia fora do teste)
  const jobs = (svc as unknown as { jobs: { id: string }[] }).jobs;
  if (jobs.length > 0) {
    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(path.join(dataDir, "deploy-jobs.json"), "utf8")) as { jobs: { finishedAt: string | null }[] };
      expect(saved.jobs.length).toBe(jobs.length);
      expect(saved.jobs.every((j) => j.finishedAt)).toBe(true);
    });
  }
  await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

const COMPOSE = `services:
  web:
    image: node:22
  worker:
    image: node:22
    environment:
      TZ: Europe/Lisbon
  cron:
    image: alpine:3
    env_file: ./cron.env
  db:
    image: postgres:17
    env_file: .env
`;

async function composeProject(): Promise<Project> {
  const dir = path.join(projectsDir, "loja");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "compose.yml"), COMPOSE);
  await writeFile(path.join(dir, "cron.env"), "TZ=Asia/Tokyo\n");
  const p = await svc.createProject({ name: "Loja", ingestMode: "existing", source: dir, domain: "loja.localhost" });
  p.detection = { type: "compose", composeFile: "compose.yml", proxyService: "web", proxyPort: 3000 } as Project["detection"];
  return p;
}

type Ctx = { timezoneForProject: (p: Project) => Promise<string | null> };
const ctxOf = (s: unknown) => (s as { engineCtx: Ctx }).engineCtx;

describe("escolha do fuso", () => {
  it("padrão da imagem não injeta; igual ao da VPS acompanha; específico; site estático nunca", async () => {
    const p = await composeProject();
    expect(await ctxOf(svc).timezoneForProject(p)).toBeNull();
    await svc.setProjectTimezone(p.id, { mode: "host" }, "admin");
    expect(await ctxOf(svc).timezoneForProject(p)).toBe("America/Sao_Paulo");
    svc.setHostTimezoneProvider(() => "America/Manaus");
    expect(await ctxOf(svc).timezoneForProject(p)).toBe("America/Manaus");
    await svc.setProjectTimezone(p.id, { mode: "zone", zone: "Europe/Lisbon" });
    expect(await ctxOf(svc).timezoneForProject(p)).toBe("Europe/Lisbon");
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: "project.timezone", actor: "admin", detail: 'Fuso horário de "Loja": igual ao da VPS.' }));
    await svc.setProjectTimezone(p.id, { mode: "image" });
    expect(p.timezone).toBeUndefined();
    p.timezone = { mode: "host" };
    p.detection = { ...p.detection!, type: "static" };
    expect(await ctxOf(svc).timezoneForProject(p)).toBeNull();
  });

  it("recusa fuso fora da lista e modo desconhecido", async () => {
    const p = await composeProject();
    await expect(svc.setProjectTimezone(p.id, { mode: "zone", zone: "Asia/Calcutta" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.setProjectTimezone(p.id, { mode: "zone" })).rejects.toMatchObject({ code: "invalid_timezone" });
    await expect(svc.setProjectTimezone(p.id, { mode: "outro" as never })).rejects.toMatchObject({ code: "invalid_timezone" });
    await expect(svc.setProjectTimezone("nao-existe", { mode: "host" })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("visão do fuso do projeto", () => {
  it("mostra quem já define TZ, o aviso de reiniciar e a base de fusos de cada container", async () => {
    const p = await composeProject();
    await svc.setEnv(p.id, [{ key: "TZ", value: "America/Bahia" }]);
    await svc.setProjectTimezone(p.id, { mode: "host" });
    p.lastDeployStatus = "success";
    containers.push(
      { id: "c1", name: "paas-loja-web-1", image: "node:22-alpine", state: "running", status: "Up", managed: true, projectSlug: "loja", composeProject: "paas-loja", service: "web" } as DockerContainerInfo,
      { id: "c2", name: "paas-loja-db-1", image: "postgres", state: "exited", status: "Exited", managed: true, projectSlug: "loja", composeProject: "paas-loja", service: "db" } as DockerContainerInfo,
      { id: "c3", name: "outro", image: "x", state: "running", status: "Up", managed: false, projectSlug: null, composeProject: null } as DockerContainerInfo,
    );
    const view = await svc.timezoneView(p.id);
    expect(view).toMatchObject({
      setting: { mode: "host" },
      effectiveZone: "America/Sao_Paulo",
      hostZone: "America/Sao_Paulo",
      appliedZone: null,
      pendingRestart: true,
      supported: true,
    });
    expect(view.definedByProject).toEqual([
      { service: "worker", value: "Europe/Lisbon", where: "compose" },
      { service: "cron", value: "Asia/Tokyo", where: "env_file" },
      { service: "db", value: "America/Bahia", where: "variables" },
    ]);
    expect(view.services).toEqual([
      { service: "web", container: "paas-loja-web-1", running: true, tz: "America/Sao_Paulo", zoneinfo: false },
      { service: "db", container: "paas-loja-db-1", running: false, tz: null, zoneinfo: null },
    ]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(view.options.length).toBeGreaterThan(400);
    // já aplicado: nada pendente
    p.timezoneApplied = "America/Sao_Paulo";
    expect((await svc.timezoneView(p.id)).pendingRestart).toBe(false);
  });

  it("Dockerfile: o TZ das Variáveis conta como do projeto; estático não aceita fuso; nunca publicado não pede reinício", async () => {
    const p = await composeProject();
    p.detection = { type: "dockerfile", proxyPort: 3000 } as Project["detection"];
    await svc.setEnv(p.id, [{ key: "TZ", value: "UTC" }]);
    await svc.setProjectTimezone(p.id, { mode: "zone", zone: "America/Recife" });
    const view = await svc.timezoneView(p.id);
    expect(view.definedByProject).toEqual([{ service: "app", value: "UTC", where: "variables" }]);
    expect(view.pendingRestart).toBe(false);
    await svc.setEnv(p.id, []);
    expect((await svc.timezoneView(p.id)).definedByProject).toEqual([]);
    p.detection = { type: "static" } as Project["detection"];
    expect(await svc.timezoneView(p.id)).toMatchObject({ supported: false, definedByProject: [], effectiveZone: null });
  });

  it("Next.js com servidor (node-server) também aceita fuso e conta o TZ das Variáveis como do projeto", async () => {
    const p = await composeProject();
    p.detection = { type: "node-server", proxyPort: 3000 } as Project["detection"];
    await svc.setEnv(p.id, [{ key: "TZ", value: "UTC" }]);
    await svc.setProjectTimezone(p.id, { mode: "zone", zone: "America/Recife" });
    const view = await svc.timezoneView(p.id);
    expect(view.supported).toBe(true);
    expect(view.effectiveZone).toBe("America/Recife");
    expect(view.definedByProject).toEqual([{ service: "app", value: "UTC", where: "variables" }]);
  });

  it("compose sem a pasta do código ou com arquivo ilegível: nada definido", async () => {
    const p = await composeProject();
    await rm(path.join(projectsDir, "loja", "compose.yml"));
    expect((await svc.timezoneView(p.id)).definedByProject).toEqual([]);
    p.source = path.join(projectsDir, "sumiu");
    p.ingestMode = "git";
    expect((await svc.timezoneView(p.id)).definedByProject).toEqual([]);
  });
});

describe("reiniciar com o fuso novo", () => {
  it("só depois do primeiro deploy; recria, guarda o fuso aplicado e audita", async () => {
    const p = await composeProject();
    await svc.setProjectTimezone(p.id, { mode: "host" });
    await expect(svc.startRecreate(p.id)).rejects.toMatchObject({ statusCode: 409, code: "not_deployed" });
    p.lastDeployStatus = "success";
    const recreate = vi.fn(async (_p: Project, onLog: (c: string) => void) => onLog("Containers recriados.\n"));
    (svc as unknown as { engine: { recreate: typeof recreate } }).engine.recreate = recreate;
    const job = await svc.startRecreate(p.id, "admin");
    expect(job.kind).toBe("recreate");
    await vi.waitFor(async () => expect((await svc.getJob(p.id, job.id))?.status).toBe("success"));
    expect(p.timezoneApplied).toBe("America/Sao_Paulo");
    const done = (await svc.getJob(p.id, job.id))!;
    expect(done.log).toContain("Containers recriados.");
    expect(done.steps.every((s) => s.status === "done")).toBe(true);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: "project.recreate", actor: "admin" }));
  });

  it("falha no reinício fica no job; com outro em andamento, 409", async () => {
    const p = await composeProject();
    p.deployedSource = p.source;
    let release!: () => void;
    const recreate = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          release = () => reject(new Error("a imagem de um serviço não existe mais no servidor"));
        }),
    );
    (svc as unknown as { engine: { recreate: typeof recreate } }).engine.recreate = recreate;
    const job = await svc.startRecreate(p.id);
    await expect(svc.startRecreate(p.id)).rejects.toMatchObject({ statusCode: 409, code: "deploy_in_progress" });
    release();
    await vi.waitFor(async () => expect((await svc.getJob(p.id, job.id))?.status).toBe("failed"));
    const failed = (await svc.getJob(p.id, job.id))!;
    expect(failed.error).toMatch(/não existe mais/);
    expect(failed.log).toContain("✖ Reinício falhou");
    expect(failed.steps[0]!.status).toBe("failed");
    expect(p.timezoneApplied).toBeUndefined();
  });
});
