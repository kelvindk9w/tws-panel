/**
 * proxy-network.test.ts — IP do Caddy e sub-rede da rede do proxy de cada projeto (paas-proxy-<slug>): leitura do `docker network inspect`, cache curto, as
 * variáveis PAAS_PROXY_* entregues no deploy (a do usuário com o mesmo nome vence; site estático não recebe) e o cartão
 * "Rede e proxy" da seção Variáveis.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";
import type { DeployEngine } from "@paas/deploy";
import type { ServerConfig } from "../src/config.js";
import { DeployService } from "../src/services/deploy-service.js";
import { ProxyNetwork, inspectNetwork, parseProxyNetwork, proxyNetworkDefaults, proxyNetworkOf } from "../src/services/proxy-network.js";
import { removeDir } from "./helpers/tmp.js";

const INSPECT = JSON.stringify({
  Name: "paas-proxy-api",
  IPAM: { Config: [{ Subnet: "fd00::/64" }, { Subnet: "172.20.0.0/16", Gateway: "172.20.0.1" }] },
  Containers: {
    a1: { Name: "meu-app", IPv4Address: "172.20.0.5/16" },
    b2: { Name: "paas-caddy", IPv4Address: "172.20.0.2/16" },
  },
});

describe("parseProxyNetwork", () => {
  it("acha o IP do Caddy (sem a máscara) e a sub-rede IPv4", () => {
    expect(parseProxyNetwork(INSPECT)).toEqual({ ip: "172.20.0.2", subnet: "172.20.0.0/16" });
  });

  it("Caddy fora da rede: só a sub-rede", () => {
    const json = JSON.stringify({ IPAM: { Config: [{ Subnet: "172.21.0.0/16" }] }, Containers: {} });
    expect(parseProxyNetwork(json)).toEqual({ ip: null, subnet: "172.21.0.0/16" });
  });

  it("sem Containers/IPAM, endereço estranho ou JSON quebrado: nulos", () => {
    expect(parseProxyNetwork("{}")).toEqual({ ip: null, subnet: null });
    expect(parseProxyNetwork("null")).toEqual({ ip: null, subnet: null });
    expect(parseProxyNetwork("não é json")).toEqual({ ip: null, subnet: null });
    const odd = JSON.stringify({ IPAM: { Config: null }, Containers: { x: { Name: "paas-caddy", IPv4Address: "fe80::1/64" } } });
    expect(parseProxyNetwork(odd)).toEqual({ ip: null, subnet: null });
    expect(parseProxyNetwork(JSON.stringify({ Containers: { x: { Name: "paas-caddy" } } })).ip).toBeNull();
  });
});

describe("ProxyNetwork", () => {
  it("cache curto por rede: não consulta o Docker de novo dentro da janela; fresh ignora o cache", async () => {
    let t = 1_000;
    const inspect = vi.fn(async (_network: string) => INSPECT);
    const net = new ProxyNetwork(inspect, 10_000, () => t);
    expect(await net.facts("paas-proxy-api")).toEqual({ ip: "172.20.0.2", subnet: "172.20.0.0/16" });
    expect(inspect).toHaveBeenLastCalledWith("paas-proxy-api");
    t += 5_000;
    await net.facts("paas-proxy-api");
    expect(inspect).toHaveBeenCalledTimes(1);
    // outra rede (outro projeto) tem o seu próprio valor
    await net.facts("paas-proxy-blog");
    expect(inspect).toHaveBeenCalledTimes(2);
    await net.facts("paas-proxy-api", true);
    expect(inspect).toHaveBeenCalledTimes(3);
    t += 11_000;
    await net.facts("paas-proxy-api");
    expect(inspect).toHaveBeenCalledTimes(4);
  });

  it("sem o IP do Caddy (rede ainda não criada) não guarda: a próxima leitura já vê a rede nova", async () => {
    let json = "{}";
    const inspect = vi.fn(async () => json);
    const net = new ProxyNetwork(inspect, 10_000, () => 1_000);
    expect(await net.facts("paas-proxy-api")).toEqual({ ip: null, subnet: null });
    json = INSPECT;
    expect(await net.facts("paas-proxy-api")).toEqual({ ip: "172.20.0.2", subnet: "172.20.0.0/16" });
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("env(): as duas variáveis; sem Docker, nenhuma (nunca lança)", async () => {
    expect(await new ProxyNetwork(async () => INSPECT).env("paas-proxy-api")).toEqual({ PAAS_PROXY_IP: "172.20.0.2", PAAS_PROXY_SUBNET: "172.20.0.0/16" });
    const down = new ProxyNetwork(async () => {
      throw new Error("sem docker");
    });
    expect(await down.facts("paas-proxy-api")).toEqual({ ip: null, subnet: null });
    expect(await down.env("paas-proxy-api")).toEqual({});
  });

  it("proxyNetworkOf: a rede do proxy do projeto; slug fora da allowlist cai na paas-net (só leitura)", () => {
    expect(proxyNetworkOf("api")).toBe("paas-proxy-api");
    expect(proxyNetworkOf("Fora Do Padrão")).toBe("paas-net");
  });

  it("o leitor real, sem Docker alcançável, devolve nulos em vez de lançar", async () => {
    const saved = process.env.DOCKER_HOST;
    process.env.DOCKER_HOST = "unix:///nonexistent.sock";
    try {
      expect(await new ProxyNetwork(inspectNetwork).facts("paas-proxy-api")).toEqual({ ip: null, subnet: null });
    } finally {
      if (saved === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = saved;
    }
  });

  it("nos testes o leitor padrão é simulado (não consulta o Docker da máquina)", async () => {
    expect(proxyNetworkDefaults.inspect).not.toBe(inspectNetwork);
    expect(await new ProxyNetwork().facts("paas-proxy-api")).toEqual({ ip: null, subnet: null });
  });

  it("o serviço usa o leitor injetado", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paas-proxy-inj-"));
    try {
      const injected = new ProxyNetwork(async () => INSPECT);
      const s = new DeployService({ dataDir: dir, projectsDir: path.join(dir, "projects"), caddyHttpPort: 80, caddyHttpsPort: 443, panelDomain: null, port: 9000 } as unknown as ServerConfig, { proxyNetwork: injected });
      expect(s.proxyNet).toBe(injected);
    } finally {
      await removeDir(dir);
    }
  });
});

/** O motor do serviço (privado): os testes trocam a criação da rede do proxy, que fala com o Docker. */
const engineOf = (s: DeployService) => (s as unknown as { engine: DeployEngine }).engine;

describe("variáveis PAAS_PROXY_* no deploy e cartão Rede e proxy", () => {
  let dataDir: string;
  let svc: DeployService;
  type Fn = (p: unknown) => Promise<Record<string, string>>;
  const ctx = () => (svc as unknown as { engineCtx: { envForProject: Fn; injectEnvForProject: Fn } }).engineCtx;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "paas-proxy-"));
    svc = new DeployService(
      { dataDir, projectsDir: path.join(dataDir, "projects"), caddyHttpPort: 80, caddyHttpsPort: 443, panelDomain: null, port: 9000 } as unknown as ServerConfig,
      {},
    );
    vi.spyOn(svc.proxyNet, "facts").mockResolvedValue({ ip: "172.20.0.2", subnet: "172.20.0.0/16" });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await removeDir(dataDir);
  });

  const projeto = () => svc.createProject({ name: "api", ingestMode: "git", source: "https://github.com/k/api", branch: "main", domain: "api.example.com" });
  const setType = (id: string, type: string) => {
    const list = (svc as unknown as { projects: Project[] }).projects;
    list.find((p) => p.id === id)!.detection = { type } as never;
  };

  it("entrega o valor de agora a cada deploy, junto das variáveis do usuário", async () => {
    const p = await projeto();
    await svc.setEnv(p.id, [{ key: "DATABASE_URL", value: "postgres://x" }]);
    expect(await ctx().envForProject(p)).toEqual({ PAAS_PROXY_IP: "172.20.0.2", PAAS_PROXY_SUBNET: "172.20.0.0/16", DATABASE_URL: "postgres://x" });
    vi.spyOn(svc.proxyNet, "env").mockResolvedValue({ PAAS_PROXY_IP: "172.20.0.9", PAAS_PROXY_SUBNET: "172.20.0.0/16" });
    expect((await ctx().envForProject(p)).PAAS_PROXY_IP).toBe("172.20.0.9");
    // não vai para todos os serviços do compose
    expect(await ctx().injectEnvForProject(p)).toEqual({});
  });

  it("valor do usuário com o mesmo nome vence; salvo vazio não apaga o do painel", async () => {
    const p = await projeto();
    await svc.setEnv(p.id, [
      { key: "PAAS_PROXY_SUBNET", value: "10.0.0.0/8" },
      { key: "PAAS_PROXY_IP", value: "" },
    ]);
    const env = await ctx().envForProject(p);
    expect(env.PAAS_PROXY_SUBNET).toBe("10.0.0.0/8");
    expect(env.PAAS_PROXY_IP).toBe("172.20.0.2");
    expect((await svc.proxyInfo(p.id)).overridden).toEqual(["PAAS_PROXY_SUBNET"]);
  });

  it("Docker sem resposta: as variáveis somem (não viram vazias)", async () => {
    const p = await projeto();
    vi.spyOn(svc.proxyNet, "env").mockResolvedValue({});
    expect(await ctx().envForProject(p)).toEqual({});
  });

  it("site estático não recebe as variáveis", async () => {
    const p = await projeto();
    setType(p.id, "static");
    expect(await ctx().envForProject(p)).toEqual({});
    expect((await svc.proxyInfo(p.id)).delivered).toBe(false);
  });

  it("proxyInfo: IP, sub-rede, cabeçalhos reais do Caddy e o nome do app na rede", async () => {
    const p = await projeto();
    setType(p.id, "dockerfile");
    const info = await svc.proxyInfo(p.id);
    expect(info).toMatchObject({ network: "paas-proxy-api", ip: "172.20.0.2", subnet: "172.20.0.0/16", delivered: true, compose: false, overridden: [] });
    expect(info.variables).toEqual(["PAAS_PROXY_IP", "PAAS_PROXY_SUBNET"]);
    expect(info.headers).toEqual(["X-Forwarded-For", "X-Forwarded-Proto", "X-Forwarded-Host"]);
    expect(info.upstream).toMatch(/^[a-z0-9-]+:\d+$/);
  });

  it("proxyInfo: avisa quando algo do projeto ainda está na paas-net esperando o deploy (falha ao ler: sem aviso)", async () => {
    const p = await projeto();
    setType(p.id, "dockerfile");
    const of = vi.spyOn(engineOf(svc), "sharedProxyNetworkContainersOf").mockResolvedValue(["paas-api"]);
    expect((await svc.proxyInfo(p.id)).awaitingMove).toBe(true);
    of.mockResolvedValue([]);
    expect((await svc.proxyInfo(p.id)).awaitingMove).toBe(false);
    of.mockRejectedValue(new Error("docker"));
    expect((await svc.proxyInfo(p.id)).awaitingMove).toBe(false);
  });

  async function composeWith(compose: string) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const p = await projeto();
    const src = path.join(dataDir, "projects", ".paas", p.id, "src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "compose.paas.yaml"), compose);
    (svc as unknown as { projects: Project[] }).projects.find((x) => x.id === p.id)!.detection = {
      type: "compose", composeFile: "compose.paas.yaml", proxyService: "web", proxyPort: 80, warnings: [], details: [],
    } as never;
    return p;
  }
  const CITA = "services:\n  web:\n    image: nginx:1.27\n    environment:\n      A: ${PAAS_PROXY_IP:?defina}\n      B: ${OUTRA:?defina}\n";

  it("compose que cita PAAS_PROXY_*: fornecida (lista e valor) e não conta como faltando", async () => {
    const p = await composeWith(CITA);
    expect(await svc.providedEnvKeys(p.id)).toEqual(["PAAS_PROXY_IP"]);
    expect(await svc.providedEnvValues(p.id)).toEqual({ PAAS_PROXY_IP: "172.20.0.2" });
    expect(await svc.missingEnvFor(p.id)).toEqual(["OUTRA"]);
    expect((await svc.proxyInfo(p.id)).compose).toBe(true);
  });

  it("não citada, não aparece como fornecida", async () => {
    const p = await composeWith("services:\n  web:\n    image: nginx:1.27\n    environment:\n      B: ${OUTRA:-x}\n");
    expect(await svc.providedEnvKeys(p.id)).toEqual([]);
  });

  it("Docker sem resposta: a citada conta como faltando e o deploy explica que o painel não leu a rede", async () => {
    const p = await composeWith(CITA);
    vi.spyOn(svc.proxyNet, "env").mockResolvedValue({});
    // a rede do proxy do projeto é criada (com o Caddy) antes de desistir; aqui ela falha, como sem Docker
    const ensure = vi.spyOn(engineOf(svc), "ensureProxyNetwork").mockRejectedValue(new Error("sem docker"));
    expect(await svc.providedEnvKeys(p.id)).toEqual([]);
    expect(await svc.missingEnvFor(p.id)).toEqual(["OUTRA", "PAAS_PROXY_IP"]);
    await expect(svc.startDeploy(p.id)).rejects.toMatchObject({
      statusCode: 422,
      code: "missing_env",
      message: expect.stringContaining("não conseguiu ler a rede do proxy do projeto (paas-proxy-api)"),
    });
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it("primeiro deploy: a rede do proxy ainda não existe; o painel a cria e lê PAAS_PROXY_* de novo antes de recusar", async () => {
    const p = await composeWith(CITA);
    const env = vi.spyOn(svc.proxyNet, "env").mockResolvedValue({});
    const ensure = vi.spyOn(engineOf(svc), "ensureProxyNetwork").mockImplementation(async () => {
      env.mockResolvedValue({ PAAS_PROXY_IP: "10.214.3.2", PAAS_PROXY_SUBNET: "10.214.3.0/26" });
      return "paas-proxy-api";
    });
    expect(await svc.missingEnvFor(p.id)).toEqual(["OUTRA", "PAAS_PROXY_IP"]);
    // depois de criar a rede, só a variável do próprio projeto continua faltando
    await expect(svc.startDeploy(p.id)).rejects.toMatchObject({ code: "missing_env", missing: ["OUTRA"] });
    expect(ensure).toHaveBeenCalledWith(expect.objectContaining({ slug: "api" }));
    expect(env).toHaveBeenCalledWith("paas-proxy-api");
  });

  it("a citada no .env.example também é fornecida", async () => {
    const { writeFile } = await import("node:fs/promises");
    const p = await composeWith("services:\n  web:\n    image: nginx:1.27\n");
    await writeFile(path.join(dataDir, "projects", ".paas", p.id, "src", ".env.example"), "PAAS_PROXY_SUBNET=\n");
    expect(await svc.providedEnvKeys(p.id)).toEqual(["PAAS_PROXY_SUBNET"]);
  });

  // O cartão de fornecidas segue a lista da tela: com exemplo de produção, a citação só no .env.example não conta.
  it("com .env.prod.example, a citada só no .env.example não é fornecida; a citada no de produção é", async () => {
    const { writeFile } = await import("node:fs/promises");
    const p = await composeWith("services:\n  web:\n    image: nginx:1.27\n");
    const src = path.join(dataDir, "projects", ".paas", p.id, "src");
    await writeFile(path.join(src, ".env.example"), "PAAS_PROXY_SUBNET=\n");
    await writeFile(path.join(src, ".env.prod.example"), "APP_URL=\n");
    expect(await svc.providedEnvKeys(p.id)).toEqual([]);
    await writeFile(path.join(src, ".env.prod.example"), "APP_URL=\nPAAS_PROXY_IP=\n");
    expect(await svc.providedEnvKeys(p.id)).toEqual(["PAAS_PROXY_IP"]);
  });

  it("site estático não tem PAAS_PROXY_* fornecidas", async () => {
    const p = await projeto();
    setType(p.id, "static");
    expect(await svc.providedEnvKeys(p.id)).toEqual([]);
  });
});
