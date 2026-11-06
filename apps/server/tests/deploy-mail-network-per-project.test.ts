/**
 * Rede de e-mail por projeto no DeployService: o deploy pede ao módulo de e-mail que ligue o Stalwart à rede do
 * projeto; desativar o e-mail tira o projeto (e o Stalwart) da rede dele e a apaga; a limpeza da paas-mail poupa os
 * containers dos projetos cuja migração falhou. Sem Docker: o engine é observado por dublês.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";
import type { ServerConfig } from "../src/config.js";
import { DeployService } from "../src/services/deploy-service.js";
import { removeDir } from "./helpers/tmp.js";

let dataDir: string;
let svc: DeployService;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-dmn-"));
  svc = new DeployService({ dataDir, projectsDir: path.join(dataDir, "projects"), caddyHttpPort: 80, caddyHttpsPort: 443, panelDomain: null, port: 9000 } as unknown as ServerConfig, {});
});
afterEach(async () => {
  await svc.idle();
  await removeDir(dataDir);
  delete process.env.PAAS_MAIL_SUBNET_POOL;
});

const projeto = (name: string) => svc.createProject({ name, ingestMode: "git", source: `https://github.com/k/${name}`, branch: "main", domain: `${name}.localhost` });
type Ctx = { joinMailServer: (network: string) => Promise<void>; mailSubnetPool?: string };
const ctx = (s: DeployService = svc) => (s as unknown as { engineCtx: Ctx }).engineCtx;
type Engine = {
  removeMailNetwork(p: Project, log?: (m: string) => void): Promise<number>;
  sweepSharedMailNetwork(keep: readonly string[], skip: ReadonlySet<string>, log?: (m: string) => void): Promise<number>;
  projectContainers(p: Project, opts?: { withTemporary?: boolean }): Promise<string[]>;
};
const engine = () => (svc as unknown as { engine: Engine }).engine;

describe("ligação do Stalwart à rede do projeto", () => {
  it("sem módulo de e-mail, nada a fazer; registrado, o deploy chama o módulo com a rede do projeto", async () => {
    await expect(ctx().joinMailServer("paas-mail-projeto-a")).resolves.toBeUndefined();
    const seen: string[] = [];
    svc.setMailServerJoiner(async (network) => void seen.push(network));
    await ctx().joinMailServer("paas-mail-projeto-a");
    expect(seen).toEqual(["paas-mail-projeto-a"]);
  });

  it("falha do módulo sobe (o engine para o deploy antes do up)", async () => {
    svc.setMailServerJoiner(async () => {
      throw new Error("daemon ocupado");
    });
    await expect(ctx().joinMailServer("paas-mail-projeto-a")).rejects.toThrow(/daemon ocupado/);
  });

  it("PAAS_MAIL_SUBNET_POOL chega ao engine; sem ela, o engine usa a faixa padrão", async () => {
    expect(ctx().mailSubnetPool).toBeUndefined();
    process.env.PAAS_MAIL_SUBNET_POOL = "172.30.0.0/16";
    const outro = new DeployService({ dataDir, projectsDir: path.join(dataDir, "projects"), caddyHttpPort: 80, caddyHttpsPort: 443, panelDomain: null, port: 9000 } as unknown as ServerConfig, {});
    expect(ctx(outro).mailSubnetPool).toBe("172.30.0.0/16");
    await outro.idle();
  });
});

describe("desativar o e-mail do projeto", () => {
  it("tira o projeto da rede de e-mail dele na hora; projeto que não existe: 0", async () => {
    const p = await projeto("projeto-a");
    const remove = vi.spyOn(engine(), "removeMailNetwork").mockResolvedValue(3);
    const logs: string[] = [];
    await expect(svc.leaveMailNetwork(p.id, (m) => logs.push(m))).resolves.toBe(3);
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ slug: "projeto-a" }), expect.any(Function));
    await expect(svc.leaveMailNetwork("nao-existe")).resolves.toBe(0);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe("limpeza da paas-mail", () => {
  it("poupa os containers (inclusive os temporários de troca) dos projetos cuja migração falhou agora", async () => {
    const a = await projeto("projeto-a");
    const containers = vi.spyOn(engine(), "projectContainers").mockImplementation(async (p) => (p.slug === "projeto-a" ? ["aaaaaaaaaaaa", "bbbbbbbbbbbb"] : ["cccccccccccc"]));
    const sweep = vi.spyOn(engine(), "sweepSharedMailNetwork").mockResolvedValue(2);
    await expect(svc.sweepSharedMailNetwork(["paas-stalwart"], [a.id, "sumiu"])).resolves.toBe(2);
    expect(containers).toHaveBeenCalledWith(expect.objectContaining({ slug: "projeto-a" }), { withTemporary: true });
    expect(sweep).toHaveBeenCalledWith(["paas-stalwart"], new Set(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]), undefined);
  });
});
