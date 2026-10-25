/**
 * Caddyfile dos domínios dinâmicos (emissão sob demanda): opções globais com
 * o `ask` do painel, um bloco curinga por sufixo, blocos avulsos e as defesas
 * contra nome repetido (que derrubaria o Caddyfile inteiro).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";
import { CaddyManager, renderCaddyfile, type CaddyDynamic } from "../src/caddy.js";
import { DeployEngine, type EngineContext } from "../src/engine.js";

const ASK = "http://tws-panel:9101/caddy/ask";

function dyn(routes: CaddyDynamic["routes"], askUrl = ASK): { dynamic: CaddyDynamic } {
  return { dynamic: { askUrl, routes } };
}

const route = (over: Partial<CaddyDynamic["routes"][number]> = {}): CaddyDynamic["routes"][number] => ({
  upstream: "saas:80",
  websocket: false,
  suffixes: [],
  hosts: [],
  ...over,
});

describe("renderCaddyfile — domínios dinâmicos", () => {
  it("sem domínio dinâmico o Caddyfile não ganha opções globais nem on_demand", () => {
    const out = renderCaddyfile([{ domain: "a.example.com", upstream: "a:80", websocket: false }]);
    expect(out).not.toContain("on_demand");
    expect(out).not.toContain("ask ");
    expect(out.split("\n").filter((l) => l === "{")).toHaveLength(0);
  });

  it("opções globais com o ask vêm antes de qualquer site, e o bloco usa on_demand", () => {
    const out = renderCaddyfile(
      [{ domain: "saas.example.com", upstream: "saas:80", websocket: false }],
      undefined,
      [],
      [],
      dyn([route({ suffixes: ["example.com"], hosts: ["app.cliente.example"] })]),
    );
    const global = out.indexOf("{\n\ton_demand_tls {\n\t\task http://tws-panel:9101/caddy/ask\n\t}\n}");
    expect(global).toBeGreaterThan(-1);
    expect(global).toBeLessThan(out.indexOf("saas.example.com {"));
    expect(out).toContain("*.example.com,\napp.cliente.example {\n\ttls {\n\t\ton_demand\n\t}\n\treverse_proxy saas:80");
    // o fallback de domínio desconhecido continua por último
    expect(out.indexOf("app.cliente.example {")).toBeLessThan(out.indexOf("http:// {"));
  });

  it("só o sufixo (sem nome avulso) também gera o bloco; websocket mantém o flush", () => {
    const out = renderCaddyfile([], undefined, [], [], dyn([route({ suffixes: ["example.com"], websocket: true })]));
    expect(out).toContain("*.example.com {\n\ttls {\n\t\ton_demand\n\t}\n\treverse_proxy saas:80 {\n\t\tflush_interval -1");
  });

  it("projeto ainda não publicado mostra a página de manutenção, como os demais", () => {
    const out = renderCaddyfile([], undefined, [], [], dyn([route({ hosts: ["a.cliente.example"], published: false })]));
    expect(out).toContain("Site em manutenção");
  });

  it("nome que um site, o painel, o par ou o e-mail já serve não entra de novo", () => {
    const out = renderCaddyfile(
      [{ domain: "saas.example.com", aliases: ["www.saas.example.com"], upstream: "saas:80", websocket: false }],
      { domain: "painel.example.com", upstream: "tws-panel:9000" },
      ["mail.example.com"],
      [],
      {
        ...dyn([route({ hosts: ["saas.example.com", "painel.example.com", "mail.example.com", "novo.cliente.example"] })]),
        redirects: [{ host: "cliente.example", to: "saas.example.com" }],
      },
    );
    for (const name of ["saas.example.com", "painel.example.com", "mail.example.com"]) {
      expect(out.match(new RegExp(`^${name.replace(/\./g, "\\.")}( |,)`, "gm"))).toHaveLength(1);
    }
    expect(out).toContain("novo.cliente.example {");
  });

  it("nome repetido no mesmo ou em outro projeto aparece uma vez só; o primeiro vence", () => {
    const out = renderCaddyfile(
      [],
      undefined,
      [],
      [],
      dyn([route({ upstream: "um:80", hosts: ["x.cliente.example", "x.cliente.example"] }), route({ upstream: "dois:80", hosts: ["x.cliente.example", "y.cliente.example"] })]),
    );
    expect(out.match(/x\.cliente\.example/g)).toHaveLength(1);
    expect(out).toContain("reverse_proxy um:80");
    expect(out).toContain("y.cliente.example {");
    expect(out).toContain("reverse_proxy dois:80");
  });

  it("sufixo repetido fica com o primeiro projeto; nome coberto pelo curinga do PRÓPRIO bloco não ganha bloco exato, o coberto só pelo de outro projeto ganha (o exato vence)", () => {
    const out = renderCaddyfile(
      [],
      undefined,
      [],
      [],
      dyn([
        route({ upstream: "um:80", suffixes: ["example.com"], hosts: ["a.example.com"] }),
        route({ upstream: "dois:80", suffixes: ["example.com", "outro.example"], hosts: ["b.example.com", "c.outro.example", "d.e.example.com"] }),
      ]),
    );
    expect(out.match(/\*\.example\.com/g)).toHaveLength(1);
    expect(out).not.toMatch(/^a\.example\.com/m);
    // M25: o sufixo repetido é do primeiro dono; o segundo projeto não ganha um segundo curinga (conferido pela contagem acima)
    // M1: b.example.com é do projeto 2 e o curinga example.com é do projeto 1: o bloco exato (mais específico) vence
    expect(out).toMatch(/b\.example\.com/);
    expect(out).toMatch(/b\.example\.com[\s\S]*?reverse_proxy dois:80/);
    expect(out).not.toContain("c.outro.example");
    expect(out).toContain("*.outro.example");
    // dois níveis abaixo do sufixo não é coberto: ganha bloco próprio
    expect(out).toContain("d.e.example.com");
  });

  it("descarta nome, sufixo, upstream e URL do ask fora do formato (nada vira diretiva)", () => {
    const hostil = renderCaddyfile(
      [],
      undefined,
      [],
      [],
      dyn([
        route({ hosts: ["ruim.example.com {\n\tbind 0.0.0.0\n}", "sem-ponto", "x.localhost", "UPPER.example.com", ""], suffixes: ["*.example.com", "ruim sufixo", "z.localhost"] }),
        route({ upstream: "sem porta", hosts: ["ok.cliente.example"] }),
      ]),
    );
    expect(hostil).not.toContain("on_demand");
    expect(hostil).not.toContain("bind");
    for (const url of ["http://x/ask\nbind", "https://tws-panel:9101/ask", "http://tws-panel/ask", "http://tws-panel:9101/ask?x=1", "http://tws panel:9101/ask", ""]) {
      const out = renderCaddyfile([], undefined, [], [], dyn([route({ hosts: ["ok.cliente.example"] })], url));
      expect(out).not.toContain("on_demand");
      expect(out).not.toContain("ok.cliente.example");
    }
  });

  it("a URL do ask aceita só o segredo `?k=` (alfanumérico, 16 a 128) e nenhuma outra query", () => {
    const key = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718";
    const ok = renderCaddyfile([], undefined, [], [], dyn([route({ hosts: ["ok.cliente.example"] })], `${ASK}?k=${key}`));
    expect(ok).toContain(`ask ${ASK}?k=${key}`);
    expect(ok).toContain("on_demand");
    for (const query of ["?k=curto", `?k=${key}&x=1`, `?k=${key}}`, `?k=${key}\nbind`, `?k=${"a".repeat(129)}`, "?k=", `?x=${key}`, `?k=${key}#a`]) {
      const out = renderCaddyfile([], undefined, [], [], dyn([route({ hosts: ["ok.cliente.example"] })], `${ASK}${query}`));
      expect(out).not.toContain("on_demand");
    }
  });

  it("rota sem nada a servir não gera bloco nem opções globais", () => {
    const out = renderCaddyfile([], undefined, [], [], dyn([route(), route({ hosts: ["x.localhost"] })]));
    expect(out).not.toContain("on_demand");
  });
});

describe("DeployEngine.syncCaddy — domínios dinâmicos", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paas-caddy-dyn-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  const base = (extra: Partial<EngineContext> = {}): EngineContext => ({
    projectsDir: dir,
    caddyDir: path.join(dir, "caddy"),
    nodeImage: "node:22",
    staticImage: "nginx:alpine",
    caddyHttpPort: 80,
    caddyHttpsPort: 443,
    ...extra,
  });

  const projeto = (over: Partial<Project> = {}): Project =>
    ({
      id: "p1",
      name: "saas",
      slug: "saas",
      ingestMode: "git",
      source: "https://example.com/r.git",
      branch: "main",
      domain: "saas.example.com",
      websocket: true,
      detection: null,
      proxyService: null,
      proxyPort: null,
      createdAt: "",
      updatedAt: "",
      lastDeployAt: null,
      lastDeployStatus: "success",
      deployedBranch: null,
      deployedSource: null,
      ...over,
    }) as Project;

  it("monta a rota do projeto com o upstream dele e repassa ao Caddy", async () => {
    const apply = vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
    const engine = new DeployEngine(
      base({ dynamicDomains: async () => ({ askUrl: ASK, projects: [{ projectId: "p1", suffixes: ["example.com"], hosts: ["a.cliente.example"] }] }) }),
    );
    await engine.syncCaddy([projeto()]);
    expect(apply.mock.calls[0]![3]!.dynamic).toEqual({
      askUrl: ASK,
      routes: [{ upstream: "saas:80", websocket: true, published: true, suffixes: ["example.com"], hosts: ["a.cliente.example"] }],
    });
  });

  it("projeto que não existe mais ou sem nada dinâmico fica de fora; sem rota nenhuma, nem a opção", async () => {
    const apply = vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
    const engine = new DeployEngine(
      base({
        dynamicDomains: async () => ({
          askUrl: ASK,
          projects: [
            { projectId: "sumiu", suffixes: [], hosts: ["a.cliente.example"] },
            { projectId: "p1", suffixes: [], hosts: [] },
          ],
        }),
      }),
    );
    await engine.syncCaddy([projeto()]);
    expect(apply.mock.calls[0]![3]).not.toHaveProperty("dynamic");
  });

  it("sem provedor ou com provedor que devolve null: nada muda", async () => {
    const apply = vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
    await new DeployEngine(base()).syncCaddy([projeto()]);
    await new DeployEngine(base({ dynamicDomains: async () => null })).syncCaddy([projeto()]);
    expect(apply.mock.calls[0]![3]).toEqual({ manual: [], force: false });
    expect(apply.mock.calls[1]![3]).toEqual({ manual: [], force: false });
  });

  it("provedor que falha não derruba o proxy dos sites", async () => {
    const apply = vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
    const logs: string[] = [];
    const engine = new DeployEngine(
      base({
        dynamicDomains: async () => {
          throw new Error("dynamic-domains.json ilegível");
        },
      }),
    );
    await engine.syncCaddy([projeto()], (c) => logs.push(c));
    expect(apply.mock.calls[0]![3]).not.toHaveProperty("dynamic");
    expect(logs.join("")).toContain("dynamic-domains.json ilegível");
  });

  it("falha do provedor com valor que não é Error também é registrada", async () => {
    vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
    const logs: string[] = [];
    const engine = new DeployEngine(
      base({
        dynamicDomains: async () => {
          throw "texto solto";
        },
      }),
    );
    await engine.syncCaddy([projeto()], (c) => logs.push(c));
    expect(logs.join("")).toContain("texto solto");
  });

  it("durante um deploy, a rota do projeto usa o upstream novo (porta ainda não gravada)", async () => {
    const apply = vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
    const engine = new DeployEngine(
      base({ dynamicDomains: async () => ({ askUrl: ASK, projects: [{ projectId: "p1", suffixes: ["example.com"], hosts: [] }] }) }),
    );
    const applyProxy = (engine as unknown as { applyProxy(p: Project, all: Project[], up: string, log: (c: string) => void): Promise<void> }).applyProxy.bind(engine);
    await applyProxy(projeto(), [projeto()], "saas:3100", () => undefined);
    expect(apply.mock.calls[0]![3]!.dynamic!.routes[0]!.upstream).toBe("saas:3100");
  });

  it("issuedCertificates passa pelo Caddy", async () => {
    const lido = new Map();
    const spy = vi.spyOn(CaddyManager.prototype, "issuedCertificates").mockResolvedValue(lido);
    expect(await new DeployEngine(base()).issuedCertificates()).toBe(lido);
    expect(spy).toHaveBeenCalledOnce();
  });
});
