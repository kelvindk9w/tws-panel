/**
 * apps-domain-integration.test.ts — o domínio de aplicações com arquivos reais:
 * o AppsDomainService de verdade (apps-domain.json em disco) ligado ao
 * DeployService de verdade (projects.json em disco). Só o DNS e o Docker/Caddy
 * são dublês.
 *
 *  - base verificada → o endereço gerado cria o projeto, que passa a ocupar o nome;
 *  - o próximo endereço do mesmo nome de projeto é outro (sufixo) e livre;
 *  - o painel reiniciado (serviço novo sobre os mesmos arquivos) continua oferecendo a base;
 *  - colisão com projetos e com o domínio do painel é barrada nos dois sentidos;
 *  - os projetos que já usam a base continuam depois de remover a base.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { buildAppsDomainService } from "../src/routes/apps-domain.js";
import { APPS_DOMAIN_FILE } from "../src/services/apps-domain.js";
import { DeployService } from "../src/services/deploy-service.js";

const IP_HOST = "203-0-113-10.sslip.io";
const BASE = "apps.example.com";

let dataDir: string;
let deploy: DeployService;
let sync: ReturnType<typeof vi.fn>;
let config: Pick<ServerConfig, "dataDir" | "panelDomain" | "publicIp" | "publicIpv6">;

const dns = (answer: () => string[]) => ({
  primary: { resolve4: async () => answer(), resolve6: async () => [] as string[] },
  fallback: null,
});

function build(answer: () => string[] = () => ["203.0.113.10"]) {
  return buildAppsDomainService(
    { config, deployService: deploy, auditService: undefined, log: { warn: vi.fn() } } as unknown as Parameters<typeof buildAppsDomainService>[0],
    dns(answer),
  );
}

async function criar(domain: string, name = "devLink") {
  return deploy.createProject({ name, ingestMode: "git", source: "https://github.com/k/devLink", branch: "main", domain });
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-apps-domain-"));
  config = { dataDir, panelDomain: IP_HOST, publicIp: null, publicIpv6: null };
  deploy = new DeployService({
    dataDir,
    projectsDir: path.join(dataDir, "projects"),
    caddyHttpPort: 80,
    caddyHttpsPort: 443,
    panelDomain: IP_HOST,
    port: 9000,
  } as unknown as ServerConfig);
  sync = vi.fn(async () => undefined);
  (deploy as unknown as { engine: { syncCaddy: typeof sync } }).engine.syncCaddy = sync;
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("domínio de aplicações com o deploy real", () => {
  it("verificar → sugerir → criar o projeto com esse endereço; o proxy recebe o host exato", async () => {
    const svc = build();
    await svc.init();
    expect((await svc.verify(BASE, "admin")).saved).toBe(true);
    const domain = (await svc.suggest("Dev Link"))!;
    expect(domain).toMatch(/^dev-link-[a-hj-km-np-z2-9]{5}\.apps\.example\.com$/);
    const project = await criar(domain, "Dev Link");
    expect(project.domain).toBe(domain);
    const sent = sync.mock.calls.at(-1)![0] as Array<{ domain: string }>;
    expect(sent.map((p) => p.domain)).toEqual([domain]);
    expect(JSON.parse(await readFile(path.join(dataDir, APPS_DOMAIN_FILE), "utf8"))).toMatchObject({ base: BASE, verifiedIp: "203.0.113.10" });
  });

  it("o mesmo nome de projeto de novo gera outro endereço, e nunca um que já está em uso", async () => {
    const svc = build();
    await svc.init();
    await svc.verify(BASE, "admin");
    const seen = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      const domain = (await svc.suggest("loja"))!;
      expect(seen.has(domain)).toBe(false);
      seen.add(domain);
      await criar(domain, `loja ${i}`);
    }
    expect(seen.size).toBe(6);
    expect((await svc.status()).projectsUsingBase).toBe(6);
  });

  it("reiniciar o painel (serviço novo sobre os mesmos arquivos) mantém a base verificada", async () => {
    const first = build();
    await first.init();
    await first.verify(BASE, "admin");
    const again = build(() => []);
    await again.init();
    expect(await again.status()).toMatchObject({ base: BASE, verified: true });
    expect(await again.suggest("x")).toMatch(/\.apps\.example\.com$/);
  });

  it("a base não pode ser o endereço do painel, o domínio de um projeto, nem o painel pelo domínio próprio", async () => {
    await criar("loja.example.com");
    const svc = build();
    await svc.init();
    await expect(svc.verify("loja.example.com", "admin")).rejects.toMatchObject({ code: "domain_in_use" });
    await expect(svc.verify(IP_HOST, "admin")).rejects.toMatchObject({ statusCode: 400 });
    deploy.setPanelReserved(["painel.example.com"]);
    await expect(svc.verify("painel.example.com", "admin")).rejects.toMatchObject({ statusCode: 409 });
  });

  it("um projeto não pode usar um endereço já gerado para outro (e o painel reservado também fica fora)", async () => {
    const svc = build();
    await svc.init();
    await svc.verify(BASE, "admin");
    const domain = (await svc.suggest("a"))!;
    await criar(domain, "a");
    await expect(criar(domain, "b")).rejects.toMatchObject({ code: "domain_in_use" });
  });

  it("remover a base não derruba os projetos que já usam um endereço sob ela", async () => {
    const svc = build();
    await svc.init();
    await svc.verify(BASE, "admin");
    const domain = (await svc.suggest("site"))!;
    const p = await criar(domain, "site");
    await svc.remove("admin");
    expect((await deploy.getProject(p.id))?.domain).toBe(domain);
    expect(await svc.suggest("outro")).toBeNull();
  });

  it("VPS com outro IP depois de restaurar o painel: a base fica a conferir até o registro ser atualizado", async () => {
    const first = build();
    await first.init();
    await first.verify(BASE, "admin");
    config = { ...config, panelDomain: "198-51-100-20.sslip.io" };
    const restored = build(() => ["198.51.100.20"]);
    await restored.init();
    expect(await restored.status()).toMatchObject({ base: BASE, verified: false, needsRecheck: true, serverIp: "198.51.100.20" });
    expect(await restored.suggest("x")).toBeNull();
    const rechecked = await restored.verify(BASE, "admin");
    expect(rechecked.saved).toBe(true);
    expect(await restored.suggest("x")).toMatch(/\.apps\.example\.com$/);
  });
});
