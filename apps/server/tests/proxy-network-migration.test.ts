/**
 * Migração da rede do proxy por projeto (subida do painel): cada projeto sai da paas-net, dividida, para a rede do
 * proxy dele; falha de um projeto não para os outros, projeto com deploy em andamento fica para a próxima rodada e,
 * no fim, quem sobrou na paas-net é avisado (nunca removido às cegas).
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectSrcDir, type DeployEngine } from "@paas/deploy";
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
      return { moved: 1, held: [] };
    });
    const left = vi.spyOn(engineOf(svc), "sharedProxyNetworkContainers").mockResolvedValue([]);
    const sync = vi.spyOn(engineOf(svc), "syncCaddy").mockResolvedValue();
    const logs: string[] = [];
    await expect(svc.migrateProxyNetworks((m) => logs.push(m))).resolves.toEqual([]);
    expect(migrate.mock.calls.map(([p]) => p.slug)).toEqual([a.slug, b.slug]);
    // na subida, quem recebeu PAAS_PROXY_* da paas-net fica nela (o motor confere)
    expect(migrate.mock.calls.every(([, , opts]) => opts?.keepIfProxyEnv === true)).toBe(true);
    // alguém passou: o Caddy recarrega UMA vez, forçado, no fim do lote (fecha os keep-alives pela paas-net)
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.mock.calls[0]![2]).toEqual({ force: true });
    expect(left).toHaveBeenCalledTimes(1);
    // a linha do motor chega sem a quebra do fim
    expect(logs).toContain("Rede do proxy: paas-loja-web-1 passou da paas-net (dividida com outros projetos) para paas-proxy-loja.");
  });

  it("falha num projeto: os outros seguem; o que falhou volta na lista e a sobra na paas-net não é conferida", async () => {
    const a = await projeto("loja");
    await projeto("blog");
    vi.spyOn(engineOf(svc), "migrateProxyNetwork").mockImplementation(async (p) => {
      if (p.slug === "loja") throw new Error("docker ocupado");
      return { moved: 0, held: [] };
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
    const migrate = vi.spyOn(engineOf(svc), "migrateProxyNetwork").mockResolvedValue({ moved: 0, held: [] });
    await expect(svc.migrateProxyNetworks(() => undefined)).resolves.toEqual([a.id]);
    expect(migrate).not.toHaveBeenCalled();
  });

  it("avisa quem sobrou na paas-net (sem tirar ninguém) e não quebra se a conferência falhar", async () => {
    await projeto("loja");
    vi.spyOn(engineOf(svc), "migrateProxyNetwork").mockResolvedValue({ moved: 0, held: [] });
    const sync = vi.spyOn(engineOf(svc), "syncCaddy").mockResolvedValue();
    const left = vi.spyOn(engineOf(svc), "sharedProxyNetworkContainers").mockResolvedValue(["solto-1"]);
    const logs: string[] = [];
    await svc.migrateProxyNetworks((m) => logs.push(m));
    expect(logs.join("\n")).toMatch(/ainda estão na paas-net \(que agora é só do proxy\): solto-1\..*docker network disconnect paas-net <container>/s);
    left.mockRejectedValue(new Error("x"));
    logs.length = 0;
    await expect(svc.migrateProxyNetworks((m) => logs.push(m))).resolves.toEqual([]);
    expect(logs.join("\n")).toMatch(/não consegui conferir quem sobrou na paas-net \(x\)/);
    // ninguém passou: nada a recarregar
    expect(sync).not.toHaveBeenCalled();
  });

  it("projeto que recebeu PAAS_PROXY_* fica na paas-net, entra no resumo e não é dado como sobra desconhecida", async () => {
    await projeto("loja");
    vi.spyOn(engineOf(svc), "migrateProxyNetwork").mockResolvedValue({ moved: 0, held: ["paas-loja"] });
    vi.spyOn(engineOf(svc), "sharedProxyNetworkContainers").mockResolvedValue(["paas-loja", "solto-1"]);
    const sync = vi.spyOn(engineOf(svc), "syncCaddy").mockResolvedValue();
    const logs: string[] = [];
    await expect(svc.migrateProxyNetworks((m) => logs.push(m))).resolves.toEqual([]);
    const all = logs.join("\n");
    expect(all).toMatch(/1 projeto\(s\) ficaram na paas-net esperando um novo deploy: loja\./);
    expect(all).toMatch(/ainda estão na paas-net \(que agora é só do proxy\): solto-1\./);
    expect(sync).not.toHaveBeenCalled();
  });

  it("reload do Caddy que falha no fim só avisa", async () => {
    await projeto("loja");
    vi.spyOn(engineOf(svc), "migrateProxyNetwork").mockResolvedValue({ moved: 1, held: [] });
    vi.spyOn(engineOf(svc), "sharedProxyNetworkContainers").mockResolvedValue([]);
    vi.spyOn(engineOf(svc), "syncCaddy").mockRejectedValue(new Error("caddy fora"));
    const logs: string[] = [];
    await expect(svc.migrateProxyNetworks((m) => logs.push(m))).resolves.toEqual([]);
    expect(logs.join("\n")).toMatch(/não consegui recarregar o Caddy depois da migração \(caddy fora\)/);
  });

  describe("compose", () => {
    const composeProjeto = async (name: string, compose: string, example?: string, prodExample?: string) => {
      const p = await projeto(name);
      const stored = (await svc.getProject(p.id))!;
      stored.detection = { type: "compose", composeFile: "compose.yml", warnings: [], details: [] } as never;
      const src = projectSrcDir({ projectsDir: path.join(dataDir, "projects") }, stored);
      await mkdir(src, { recursive: true });
      await writeFile(path.join(src, "compose.yml"), compose);
      if (example) await writeFile(path.join(src, ".env.example"), example);
      if (prodExample !== undefined) await writeFile(path.join(src, ".env.prod.example"), prodExample);
      return stored;
    };

    it("compose que cita PAAS_PROXY_IP fica na paas-net (sem chamar a migração) e o motivo vai para o log", async () => {
      await composeProjeto("loja", "services:\n  web:\n    image: nginx\n    environment:\n      TRUSTED: ${PAAS_PROXY_IP}\n");
      const migrate = vi.spyOn(engineOf(svc), "migrateProxyNetwork").mockResolvedValue({ moved: 0, held: [] });
      vi.spyOn(engineOf(svc), "sharedProxyNetworkContainersOf").mockResolvedValue(["paas-loja-web-1"]);
      vi.spyOn(engineOf(svc), "sharedProxyNetworkContainers").mockResolvedValue(["paas-loja-web-1"]);
      const logs: string[] = [];
      await expect(svc.migrateProxyNetworks((m) => logs.push(m))).resolves.toEqual([]);
      expect(migrate).not.toHaveBeenCalled();
      const all = logs.join("\n");
      expect(all).toMatch(/o projeto loja segue na paas-net, no ar: o compose ou o \.env\.example dele cita PAAS_PROXY_IP/);
      expect(all).toMatch(/Refaça o deploy do projeto para ele passar para a rede própria/);
      expect(all).not.toMatch(/ainda estão na paas-net/);
    });

    it(".env.example que cita PAAS_PROXY_SUBNET também segura", async () => {
      await composeProjeto("loja", "services:\n  web:\n    image: nginx\n", "PAAS_PROXY_SUBNET=\n");
      const migrate = vi.spyOn(engineOf(svc), "migrateProxyNetwork").mockResolvedValue({ moved: 0, held: [] });
      vi.spyOn(engineOf(svc), "sharedProxyNetworkContainersOf").mockResolvedValue(["paas-loja-web-1"]);
      vi.spyOn(engineOf(svc), "sharedProxyNetworkContainers").mockResolvedValue([]);
      const logs: string[] = [];
      await svc.migrateProxyNetworks((m) => logs.push(m));
      expect(migrate).not.toHaveBeenCalled();
      expect(logs.join("\n")).toMatch(/cita PAAS_PROXY_SUBNET/);
    });

    // A tela sugere só o exemplo de produção quando ele existe, mas a proteção olha os dois: um app que lê o .env montado
    // como arquivo pode usar a PAAS_PROXY_* citada só no .env.example de desenvolvimento.
    it(".env.example cita PAAS_PROXY_IP e o .env.prod.example não: o projeto continua segurado", async () => {
      await composeProjeto("loja", "services:\n  web:\n    image: nginx\n", "PAAS_PROXY_IP=\nDEV_SLOT=1\n", "APP_URL=\n");
      const migrate = vi.spyOn(engineOf(svc), "migrateProxyNetwork").mockResolvedValue({ moved: 0, held: [] });
      vi.spyOn(engineOf(svc), "sharedProxyNetworkContainersOf").mockResolvedValue(["paas-loja-web-1"]);
      vi.spyOn(engineOf(svc), "sharedProxyNetworkContainers").mockResolvedValue([]);
      const logs: string[] = [];
      await svc.migrateProxyNetworks((m) => logs.push(m));
      expect(migrate).not.toHaveBeenCalled();
      expect(logs.join("\n")).toMatch(/o projeto loja segue na paas-net, no ar: .*cita PAAS_PROXY_IP/);
    });

    it(".env.prod.example cita PAAS_PROXY_SUBNET e o .env.example não: também segura", async () => {
      await composeProjeto("loja", "services:\n  web:\n    image: nginx\n", "DEV_SLOT=1\n", "PAAS_PROXY_SUBNET=\n");
      const migrate = vi.spyOn(engineOf(svc), "migrateProxyNetwork").mockResolvedValue({ moved: 0, held: [] });
      vi.spyOn(engineOf(svc), "sharedProxyNetworkContainersOf").mockResolvedValue(["paas-loja-web-1"]);
      vi.spyOn(engineOf(svc), "sharedProxyNetworkContainers").mockResolvedValue([]);
      const logs: string[] = [];
      await svc.migrateProxyNetworks((m) => logs.push(m));
      expect(migrate).not.toHaveBeenCalled();
      expect(logs.join("\n")).toMatch(/cita PAAS_PROXY_SUBNET/);
    });

    it("exemplos de produção e de desenvolvimento sem PAAS_PROXY_*: segue para a migração", async () => {
      await composeProjeto("loja", "services:\n  web:\n    image: nginx\n", "DEV_SLOT=1\n", "APP_URL=\n");
      const migrate = vi.spyOn(engineOf(svc), "migrateProxyNetwork").mockResolvedValue({ moved: 0, held: [] });
      vi.spyOn(engineOf(svc), "sharedProxyNetworkContainers").mockResolvedValue([]);
      await svc.migrateProxyNetworks(() => undefined);
      expect(migrate).toHaveBeenCalledTimes(1);
    });

    it("compose que declara a paas-net: fica nela e o log diz o que tirar do compose", async () => {
      await composeProjeto("loja", "services:\n  web:\n    image: nginx\n    networks: [proxy]\nnetworks:\n  proxy:\n    external: true\n    name: paas-net\n");
      const migrate = vi.spyOn(engineOf(svc), "migrateProxyNetwork").mockResolvedValue({ moved: 0, held: [] });
      vi.spyOn(engineOf(svc), "sharedProxyNetworkContainersOf").mockResolvedValue(["paas-loja-web-1"]);
      vi.spyOn(engineOf(svc), "sharedProxyNetworkContainers").mockResolvedValue([]);
      const logs: string[] = [];
      await svc.migrateProxyNetworks((m) => logs.push(m));
      expect(migrate).not.toHaveBeenCalled();
      expect(logs.join("\n")).toMatch(/o compose dele declara a paas-net.*Tire do compose a rede que aponta para paas-net/s);
    });

    it("compose sem nada disso segue para a migração; nada dele na paas-net não entra no resumo", async () => {
      await composeProjeto("loja", "services:\n  web:\n    image: nginx\n");
      const migrate = vi.spyOn(engineOf(svc), "migrateProxyNetwork").mockResolvedValue({ moved: 0, held: [] });
      vi.spyOn(engineOf(svc), "sharedProxyNetworkContainers").mockResolvedValue([]);
      await svc.migrateProxyNetworks(() => undefined);
      expect(migrate).toHaveBeenCalledTimes(1);
    });

    it("compose que cita, mas sem nada na paas-net: não há o que segurar nem avisar", async () => {
      await composeProjeto("loja", "services:\n  web:\n    image: nginx\n    environment:\n      T: ${PAAS_PROXY_IP}\n");
      vi.spyOn(engineOf(svc), "sharedProxyNetworkContainersOf").mockRejectedValue(new Error("x"));
      vi.spyOn(engineOf(svc), "sharedProxyNetworkContainers").mockResolvedValue([]);
      const logs: string[] = [];
      await svc.migrateProxyNetworks((m) => logs.push(m));
      expect(logs.join("\n")).not.toMatch(/segue na paas-net|esperando um novo deploy/);
    });
  });

  it("não conseguiu ler os projetos: devolve falha (a próxima rodada tenta) sem lançar", async () => {
    vi.spyOn(svc, "listProjects").mockRejectedValue(new Error("disco"));
    const logs: string[] = [];
    await expect(svc.migrateProxyNetworks((m) => logs.push(m))).resolves.toEqual(["*"]);
    expect(logs.join("\n")).toMatch(/não consegui ler os projetos \(disco\)/);
  });
});
