/**
 * Portas no DeployService: lê o compose do código no servidor e UMA listagem
 * do Docker por consulta, guarda a troca no projeto (portOverrides), registra
 * na auditoria e passa as trocas aos guardrails.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DockerContainerInfo } from "@paas/core";
import type { ServerConfig } from "../src/config.js";

const docker = vi.hoisted(() => ({ list: vi.fn<() => Promise<DockerContainerInfo[]>>() }));
vi.mock("../src/services/docker-service.js", () => ({ listContainers: docker.list }));

const { DeployService } = await import("../src/services/deploy-service.js");

let dataDir: string;
let audit: ReturnType<typeof vi.fn>;
let svc: InstanceType<typeof DeployService>;

const COMPOSE = `services:
  api:
    image: app:1
    ports: ["127.0.0.1:8010:8010"]
  db:
    image: postgres:16
    ports: ["5432:5432"]
`;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-ports-"));
  audit = vi.fn(async () => ({}));
  docker.list.mockReset();
  docker.list.mockResolvedValue([
    {
      id: "1",
      name: "paas-loja-api-1",
      image: "app:1",
      state: "running",
      status: "Up",
      managed: true,
      projectSlug: "loja",
      composeProject: "paas-loja",
      service: "api",
      health: null,
      ports: ["127.0.0.1:8010->8010/tcp"],
    },
  ]);
  svc = new DeployService(
    {
      dataDir,
      projectsDir: path.join(dataDir, "projects"),
      caddyHttpPort: 80,
      caddyHttpsPort: 443,
      panelDomain: null,
      port: 9000,
      mailPorts: { smtp: 25, submission: 587, submissions: 465, imap: 143, imaps: 993, http: 8080 },
    } as unknown as ServerConfig,
    { audit: { record: audit } as never },
  );
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function lojaComCodigo() {
  const p = await svc.createProject({ name: "Loja", ingestMode: "git", source: "https://github.com/k/loja", branch: "main", domain: "loja.localhost" });
  const proj = (await svc.getProject(p.id))!;
  proj.detection = {
    type: "compose",
    composeFile: "compose.yaml",
    outputDir: null,
    packageManager: null,
    buildCommand: null,
    proxyService: "api",
    proxyPort: 8010,
    warnings: [],
    details: [],
  };
  const src = path.join(dataDir, "projects", "loja", "src");
  await mkdir(src, { recursive: true });
  await writeFile(path.join(src, "compose.yaml"), COMPOSE);
  return p;
}

describe("DeployService — portas", () => {
  it("projectPorts: o projeto e todas as portas com uma listagem do Docker", async () => {
    const p = await lojaComCodigo();
    const r = await svc.projectPorts(p.id);
    expect(docker.list).toHaveBeenCalledTimes(1);
    expect(r.docker).toBe(true);
    expect(r.project.canChange).toBe(true);
    expect(r.project.services.map((s) => s.name)).toEqual(["api", "db"]);
    expect(r.reserved).toEqual(expect.arrayContaining([80, 443, 2019, 9000, 25, 8080]));
    expect(r.rows.map((row) => `${row.service}:${row.hostPort}:${row.source}`)).toEqual([
      "api:8010:live",
      "db:5432:configured",
    ]);
  });

  it("Docker fora do ar: responde com o que está configurado", async () => {
    const p = await lojaComCodigo();
    docker.list.mockRejectedValue(new Error("sem docker"));
    const r = await svc.portsOverview();
    expect(r.docker).toBe(false);
    expect(r.rows.map((row) => row.hostPort)).toEqual([8010, 5432]);
    expect((await svc.projectPorts(p.id)).project.services[0]!.ports[0]!.applied).toBeNull();
  });

  it("setPort grava a troca no projeto, audita e devolve o mapa novo", async () => {
    const p = await lojaComCodigo();
    const r = await svc.setPort(p.id, { service: "db", original: "5432:5432", action: "remove" });
    expect(r.project.services[1]!.ports[0]).toMatchObject({ published: false });
    expect((await svc.getProject(p.id))!.portOverrides).toEqual({ db: [{ original: "5432:5432", hostPort: null, hostIp: null }] });
    expect(audit).toHaveBeenCalledWith({
      action: "project.port_changed",
      target: "loja",
      detail: 'Projeto "Loja", serviço db: 5432:5432 → publicação removida.',
    });
    const saved = JSON.parse(await readFile(path.join(dataDir, "projects.json"), "utf8"));
    expect(saved.projects[0].portOverrides.db).toHaveLength(1);

    // os guardrails passam a considerar a troca: banco sem porta publicada
    const g = await svc.guardrailsForProject(p.id);
    expect(g.report!.findings.filter((f) => f.rule === "db-port-exposed")).toHaveLength(0);

    // voltar ao compose apaga o campo
    await svc.setPort(p.id, { service: "db", original: "5432:5432", action: "reset" });
    expect((await svc.getProject(p.id))!.portOverrides).toBeUndefined();
  });

  it("setPort recusa porta em uso e não grava nada", async () => {
    const p = await lojaComCodigo();
    await expect(
      svc.setPort(p.id, { service: "db", original: "5432:5432", action: "change", hostPort: 8010 }),
    ).rejects.toMatchObject({ statusCode: 409, code: "port_in_use" });
    expect((await svc.getProject(p.id))!.portOverrides).toBeUndefined();
    expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "project.port_changed" }));
  });

  it("projeto inexistente: 404", async () => {
    await expect(svc.projectPorts("nada")).rejects.toMatchObject({ statusCode: 404 });
  });
});
