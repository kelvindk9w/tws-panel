/**
 * Migração da rede do proxy por projeto (subida do painel): cada projeto sai da paas-net, dividida, para a rede do
 * proxy dele; falha de um projeto não para os outros, projeto com deploy em andamento fica para a próxima rodada e,
 * no fim, quem sobrou na paas-net é avisado (nunca removido às cegas).
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeployEngine } from "@paas/deploy";
import type { ServerConfig } from "../src/config.js";
import { DeployService } from "../src/services/deploy-service.js";
import { removeDir } from "./helpers/tmp.js";

let dataDir: string;
let svc: DeployService;
const engineOf = (s: DeployService) => (s as unknown as { engine: DeployEngine }).engine;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-proxy-migration-"));
  svc = new DeployService({
    dataDir,
    projectsDir: path.join(dataDir, "projects"),
    caddyHttpPort: 80,
    caddyHttpsPort: 443,
    panelDomain: null,
    port: 9000,
  } as unknown as ServerConfig);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await removeDir(dataDir);
});

const projeto = (name: string) => svc.createProject({ name, ingestMode: "git", source: `https://github.com/k/${name}`, branch: "main", domain: `${name}.example.com` });

describe("DeployService.migrateProxyNetworks", () => {
  it("leva cada projeto para a rede dele e, sem falha, confere quem sobrou na paas-net", async () => {
    const a = await projeto("loja");
    const b = await projeto("blog");
    const migrate = vi.spyOn(engineOf(svc), "migrateProxyNetwork").mockImplementation(async (p, onLog) => {
      onLog?.(`Rede do proxy: paas-${p.slug}-web-1 passou da paas-net (dividida com outros projetos) para paas-proxy-${p.slug}.\n`);
      return 1;
    });
    const left = vi.spyOn(engineOf(svc), "sharedProxyNetworkContainers").mockResolvedValue([]);
    const logs: string[] = [];
    await expect(svc.migrateProxyNetworks((m) => logs.push(m))).resolves.toEqual([]);
    expect(migrate.mock.calls.map(([p]) => p.slug)).toEqual([a.slug, b.slug]);
    expect(left).toHaveBeenCalledTimes(1);
    // a linha do motor chega sem a quebra do fim
    expect(logs).toContain("Rede do proxy: paas-loja-web-1 passou da paas-net (dividida com outros projetos) para paas-proxy-loja.");
  });

  it("falha num projeto: os outros seguem; o que falhou volta na lista e a sobra na paas-net não é conferida", async () => {
    const a = await projeto("loja");
    await projeto("blog");
    vi.spyOn(engineOf(svc), "migrateProxyNetwork").mockImplementation(async (p) => {
      if (p.slug === "loja") throw new Error("docker ocupado");
      return 0;
    });
    const left = vi.spyOn(engineOf(svc), "sharedProxyNetworkContainers").mockResolvedValue([]);
    const logs: string[] = [];
    await expect(svc.migrateProxyNetworks((m) => logs.push(m))).resolves.toEqual([a.id]);
    expect(logs.join("\n")).toMatch(/não consegui passar o projeto loja para a rede dele \(docker ocupado\); ele segue na paas-net, no ar/);
    expect(left).not.toHaveBeenCalled();
  });

  it("projeto com deploy em andamento fica para a próxima rodada (o próprio deploy já o leva)", async () => {
    const a = await projeto("loja");
    (svc as unknown as { starting: Set<string> }).starting.add(a.id);
    const migrate = vi.spyOn(engineOf(svc), "migrateProxyNetwork").mockResolvedValue(0);
    await expect(svc.migrateProxyNetworks(() => undefined)).resolves.toEqual([a.id]);
    expect(migrate).not.toHaveBeenCalled();
  });

  it("avisa quem sobrou na paas-net (sem tirar ninguém) e não quebra se a conferência falhar", async () => {
    await projeto("loja");
    vi.spyOn(engineOf(svc), "migrateProxyNetwork").mockResolvedValue(0);
    const left = vi.spyOn(engineOf(svc), "sharedProxyNetworkContainers").mockResolvedValue(["solto-1"]);
    const logs: string[] = [];
    await svc.migrateProxyNetworks((m) => logs.push(m));
    expect(logs.join("\n")).toMatch(/ainda estão na paas-net \(que agora é só do proxy\): solto-1\..*docker network disconnect paas-net <container>/s);
    left.mockRejectedValue(new Error("x"));
    logs.length = 0;
    await expect(svc.migrateProxyNetworks((m) => logs.push(m))).resolves.toEqual([]);
    expect(logs.join("\n")).toMatch(/não consegui conferir quem sobrou na paas-net \(x\)/);
  });

  it("não conseguiu ler os projetos: devolve falha (a próxima rodada tenta) sem lançar", async () => {
    vi.spyOn(svc, "listProjects").mockRejectedValue(new Error("disco"));
    const logs: string[] = [];
    await expect(svc.migrateProxyNetworks((m) => logs.push(m))).resolves.toEqual(["*"]);
    expect(logs.join("\n")).toMatch(/não consegui ler os projetos \(disco\)/);
  });
});
