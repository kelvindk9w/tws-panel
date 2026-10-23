/**
 * Par com/sem www no proxy: quais pares viram redirecionamento (candidatos e
 * DNS), como o Caddyfile os escreve e como o motor os pede a cada sincronização.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainDnsState, Project } from "@paas/core";
import { CaddyManager, renderCaddyfile } from "../src/caddy.js";
import { activePairs, explicitDomains, pairCandidates } from "../src/domain-pairs.js";
import { DeployEngine, type EngineContext } from "../src/engine.js";

function projeto(over: Partial<Project> & { slug: string }): Project {
  return {
    id: over.slug,
    name: over.slug,
    ingestMode: "git",
    source: "https://github.com/k/x",
    branch: "main",
    domain: `${over.slug}.example.com`,
    websocket: false,
    detection: null,
    proxyService: null,
    proxyPort: null,
    createdAt: "",
    updatedAt: "",
    lastDeployAt: null,
    lastDeployStatus: null,
    deployedBranch: null,
    deployedSource: null,
    ...over,
  } as Project;
}

describe("pairCandidates", () => {
  it("apex pede o www e www pede o apex, cada um redirecionando para o digitado", () => {
    const out = pairCandidates([
      projeto({ slug: "a", domain: "example.com" }),
      projeto({ slug: "b", domain: "www.outro.com.br" }),
    ]);
    expect(out).toEqual([
      { host: "www.example.com", to: "example.com", projectId: "a" },
      { host: "outro.com.br", to: "www.outro.com.br", projectId: "b" },
    ]);
  });

  it("subdomínio comum, sslip.io e .localhost não têm par", () => {
    expect(
      pairCandidates([
        projeto({ slug: "a", domain: "app.example.com", aliases: ["blog.example.com", "x.203-0-113-10.sslip.io", "a.localhost"] }),
      ]),
    ).toEqual([]);
  });

  it("adicional também ganha par (o domínio ligado ao projeto, principal ou não)", () => {
    const out = pairCandidates([projeto({ slug: "a", domain: "a.203-0-113-10.sslip.io", aliases: ["example.com.br"] })]);
    expect(out).toEqual([{ host: "www.example.com.br", to: "example.com.br", projectId: "a" }]);
  });

  it("par desligado pela pessoa não é candidato; os outros domínios do projeto seguem", () => {
    const out = pairCandidates([projeto({ slug: "a", domain: "example.com", aliases: ["example.org"], pairOff: ["example.com"] })]);
    expect(out.map((c) => c.host)).toEqual(["www.example.org"]);
  });

  it("nome que um projeto (de outro ou do mesmo) já usa não vira par", () => {
    const out = pairCandidates([
      projeto({ slug: "a", domain: "example.com" }),
      projeto({ slug: "b", domain: "www.example.com" }),
      projeto({ slug: "c", domain: "solo.com", aliases: ["www.solo.com"] }),
    ]);
    expect(out).toEqual([]);
  });

  it("nome reservado (endereços do painel) não vira par", () => {
    const out = pairCandidates([projeto({ slug: "a", domain: "example.com" })], ["www.example.com"]);
    expect(out).toEqual([]);
  });

  it("dois domínios que reclamariam o mesmo par: só o primeiro leva", () => {
    const out = pairCandidates([
      projeto({ slug: "a", domain: "x.203-0-113-10.sslip.io", aliases: ["example.com"] }),
      projeto({ slug: "b", domain: "other.203-0-113-11.sslip.io", aliases: ["example.com"] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.projectId).toBe("a");
  });

  it("explicitDomains junta principal e adicionais de todos os projetos", () => {
    expect(
      [...explicitDomains([projeto({ slug: "a", domain: "a.com", aliases: ["b.com"] }), projeto({ slug: "c", domain: "c.com" })])].sort(),
    ).toEqual(["a.com", "b.com", "c.com"]);
  });
});

describe("activePairs", () => {
  const cands = [
    { host: "www.a.com", to: "a.com", projectId: "a" },
    { host: "www.b.com", to: "b.com", projectId: "b" },
    { host: "www.c.com", to: "c.com", projectId: "c" },
  ];
  const states: Record<string, DomainDnsState> = {
    "www.a.com": "pointed",
    "www.b.com": "cloudflare",
    "www.c.com": "missing",
  };

  it("só o par cujo DNS aponta para a VPS vira redirecionamento", async () => {
    const out = await activePairs(cands, async (h) => states[h]!);
    expect(out).toEqual([{ host: "www.a.com", to: "a.com" }]);
  });

  it("nomes que apontam para outro lugar, Cloudflare laranja ou sem registro ficam de fora", async () => {
    for (const s of ["elsewhere", "cloudflare", "missing"] as const) {
      expect(await activePairs(cands, async () => s)).toEqual([]);
    }
  });

  it("DNS mudo mantém o que já havia e não inventa um novo", async () => {
    const out = await activePairs(cands, async () => "unavailable", new Set(["www.b.com"]));
    expect(out).toEqual([{ host: "www.b.com", to: "b.com" }]);
  });

  it("consulta que lança erro conta como mudo", async () => {
    const out = await activePairs(
      cands,
      async (h) => {
        if (h === "www.a.com") throw new Error("boom");
        return "missing";
      },
      new Set(["www.a.com"]),
    );
    expect(out).toEqual([{ host: "www.a.com", to: "a.com" }]);
  });

  it("sem consulta de DNS ou sem candidatos: nada", async () => {
    expect(await activePairs(cands, undefined)).toEqual([]);
    const probe = vi.fn(async () => "pointed" as const);
    expect(await activePairs([], probe)).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("renderCaddyfile — redirecionamento do par", () => {
  const site = { domain: "example.com", upstream: "paas-x:80", websocket: false };

  it("o par ganha um bloco que redireciona (308) para o canônico, mantendo caminho e consulta", () => {
    const out = renderCaddyfile([site], undefined, [], [], { redirects: [{ host: "www.example.com", to: "example.com" }] });
    expect(out).toContain("\nwww.example.com {\n\tredir https://example.com{uri} 308\n}\n");
    // sem esquema: é o endereço sem http:// que faz o Caddy emitir o certificado
    expect(out).not.toContain("http://www.example.com");
  });

  it("sem redirects o Caddyfile é o de sempre", () => {
    expect(renderCaddyfile([site])).not.toContain("redir");
  });

  it("canônico que não está servido: o redirecionamento sai", () => {
    const out = renderCaddyfile([site], undefined, [], [], { redirects: [{ host: "www.outro.com", to: "outro.com" }] });
    expect(out).not.toContain("www.outro.com");
  });

  it("par que já é nome de um site (de qualquer projeto) ou do painel não gera bloco duplicado", () => {
    const out = renderCaddyfile(
      [site, { domain: "www.example.com", upstream: "paas-y:80", websocket: false }],
      { domain: "painel.example.net", aliases: ["www.example.org"], upstream: "tws-panel:9000" },
      [],
      [],
      {
        redirects: [
          { host: "www.example.com", to: "example.com" },
          { host: "www.example.org", to: "example.com" },
        ],
      },
    );
    expect(out.match(/^www\.example\.com \{/gm)).toHaveLength(1);
    expect(out).not.toContain("redir");
  });

  it("par repetido gera um bloco só", () => {
    const out = renderCaddyfile([site], undefined, [], [], {
      redirects: [
        { host: "www.example.com", to: "example.com" },
        { host: "www.example.com", to: "example.com" },
      ],
    });
    expect(out.match(/^www\.example\.com \{/gm)).toHaveLength(1);
  });

  it("nome com chave, quebra de linha ou fora do formato nunca vira diretiva", () => {
    const out = renderCaddyfile([site], undefined, [], [], {
      redirects: [
        { host: "www.example.com {\n\trespond pwned\n}", to: "example.com" },
        { host: "www.example.com", to: "example.com\n}" },
        { host: "WWW.Example.com", to: "example.com" },
      ],
    });
    expect(out).not.toContain("pwned");
    expect(out).not.toContain("redir");
  });

  it(".localhost e o próprio canônico nunca ganham redirecionamento", () => {
    const out = renderCaddyfile([{ domain: "a.localhost", upstream: "paas-x:80", websocket: false }, site], undefined, [], [], {
      redirects: [
        { host: "www.a.localhost", to: "a.localhost" },
        { host: "localhost", to: "a.localhost" },
        { host: "example.com", to: "example.com" },
      ],
    });
    expect(out).not.toContain("redir");
  });

  it("par com certificado manual usa o par de arquivos dele (tls antes do redir)", () => {
    const out = renderCaddyfile([site], undefined, [], ["www.example.com"], { redirects: [{ host: "www.example.com", to: "example.com" }] });
    const bloco = out.slice(out.indexOf("www.example.com {"));
    expect(bloco.indexOf("\ttls ")).toBeGreaterThan(-1);
    expect(bloco.indexOf("\ttls ")).toBeLessThan(bloco.indexOf("redir"));
  });

  it("mail.<domínio> igual ao par não duplica o bloco e o servidor de e-mail vence o redirecionamento", () => {
    const out = renderCaddyfile([site], undefined, ["www.example.com"], [], { redirects: [{ host: "www.example.com", to: "example.com" }] });
    expect(out.match(/^www\.example\.com \{/gm)).toHaveLength(1);
    expect(out).not.toContain("redir https://example.com{uri} 308");
  });

  it("o bloco do par vem antes do catch-all em HTTP", () => {
    const out = renderCaddyfile([site], undefined, [], [], { redirects: [{ host: "www.example.com", to: "example.com" }] });
    expect(out.indexOf("www.example.com {")).toBeLessThan(out.indexOf("http:// {"));
  });
});

describe("CaddyManager.apply repassa os pares", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paas-caddy-pair-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  function ctx(extra: Partial<EngineContext> = {}): EngineContext {
    return {
      projectsDir: dir,
      caddyDir: path.join(dir, "caddy"),
      nodeImage: "node:22",
      staticImage: "nginx:alpine",
      caddyHttpPort: 80,
      caddyHttpsPort: 443,
      ...extra,
    };
  }

  it("o motor só pede par para domínio cujo DNS aponta, e o passa ao Caddy", async () => {
    const apply = vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
    const hostState = vi.fn(async (h: string): Promise<DomainDnsState> => (h === "www.example.com" ? "pointed" : "missing"));
    const engine = new DeployEngine(ctx({ hostState }));
    await engine.syncCaddy([
      projeto({ slug: "a", domain: "example.com" }),
      projeto({ slug: "b", domain: "other.org" }),
    ]);
    expect(hostState).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[0]![3]).toMatchObject({ redirects: [{ host: "www.example.com", to: "example.com" }] });
  });

  it("sem par apontado a opção redirects nem existe; sem hostState nada é consultado", async () => {
    const apply = vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
    await new DeployEngine(ctx({ hostState: async () => "missing" })).syncCaddy([projeto({ slug: "a", domain: "example.com" })]);
    expect(apply.mock.calls[0]![3]).not.toHaveProperty("redirects");
    await new DeployEngine(ctx()).syncCaddy([projeto({ slug: "a", domain: "example.com" })]);
    expect(apply.mock.calls[1]![3]).not.toHaveProperty("redirects");
  });

  it("os endereços do painel ficam de fora dos candidatos", async () => {
    const apply = vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
    const hostState = vi.fn(async (): Promise<DomainDnsState> => "pointed");
    const engine = new DeployEngine(ctx({ hostState, panelSite: { domain: "painel.example.net", aliases: ["www.example.com"], upstream: "tws-panel:9000" } }));
    await engine.syncCaddy([projeto({ slug: "a", domain: "example.com" })]);
    expect(hostState).not.toHaveBeenCalled();
    expect(apply.mock.calls[0]![3]).not.toHaveProperty("redirects");
  });

  it("o domínio do painel cadastrado e ainda sem DNS conferido também não é tomado pelo par", async () => {
    const apply = vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
    const hostState = vi.fn(async (): Promise<DomainDnsState> => "pointed");
    const engine = new DeployEngine(ctx({ hostState, reservedNames: () => ["www.example.com"] }));
    await engine.syncCaddy([projeto({ slug: "a", domain: "example.com" })]);
    expect(hostState).not.toHaveBeenCalled();
    expect(apply.mock.calls[0]![3]).not.toHaveProperty("redirects");
  });

  it("os nomes do servidor de e-mail (PAAS_MAIL_HOSTNAME e o webmail) não são tomados pelo par", async () => {
    const apply = vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
    const hostState = vi.fn(async (): Promise<DomainDnsState> => "pointed");
    const engine = new DeployEngine(ctx({ hostState, mailHosts: async () => ["example.org", "mail.example.org"] }));
    await engine.syncCaddy([projeto({ slug: "a", domain: "www.example.org" })]);
    expect(hostState).not.toHaveBeenCalled();
    expect(apply.mock.calls[0]![3]).not.toHaveProperty("redirects");
    expect(apply.mock.calls[0]![2]).toEqual(["example.org", "mail.example.org"]);
  });

  it("sem nome reservado o mesmo cenário redireciona (a reserva é o que protege)", async () => {
    const apply = vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
    const engine = new DeployEngine(ctx({ hostState: async () => "pointed", mailHosts: async () => ["mail.example.org"] }));
    await engine.syncCaddy([projeto({ slug: "a", domain: "www.example.org" })]);
    expect(apply.mock.calls[0]![3]).toMatchObject({ redirects: [{ host: "example.org", to: "www.example.org" }] });
  });

  it("o Caddyfile nunca redireciona um nome do servidor de e-mail, mesmo que o par chegue até o renderizador", () => {
    const out = renderCaddyfile(
      [{ domain: "www.example.org", aliases: [], upstream: "app:80" } as never],
      undefined,
      ["example.org"],
      [],
      { redirects: [{ host: "example.org", to: "www.example.org" }] },
    );
    expect(out).not.toContain("redir https://www.example.org");
    expect(out).toContain("example.org {");
  });

  it("o par só vale depois que o Caddy aplicou: aplicação que falha não o registra e a reconferência tenta de novo", async () => {
    const apply = vi.spyOn(CaddyManager.prototype, "apply").mockRejectedValueOnce(new Error("reload falhou")).mockResolvedValue(undefined);
    const engine = new DeployEngine(ctx({ hostState: async () => "pointed" }));
    const projetos = [projeto({ slug: "a", domain: "example.com" })];
    await expect(engine.syncCaddy(projetos)).rejects.toThrow("reload falhou");
    expect(engine.appliedPairs().has("www.example.com")).toBe(false);
    expect(await engine.pairsChanged(projetos)).toBe(true);
    await engine.syncCaddy(projetos);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(engine.appliedPairs().has("www.example.com")).toBe(true);
    expect(await engine.pairsChanged(projetos)).toBe(false);
  });

  it("pairsChanged: nasce quando o DNS passa a apontar, e some quando deixa de; DNS mudo não muda nada", async () => {
    vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
    let state: DomainDnsState = "missing";
    const engine = new DeployEngine(ctx({ hostState: async () => state }));
    const projetos = [projeto({ slug: "a", domain: "example.com" })];
    await engine.syncCaddy(projetos);
    expect(await engine.pairsChanged(projetos)).toBe(false);
    state = "pointed";
    expect(await engine.pairsChanged(projetos)).toBe(true);
    await engine.syncCaddy(projetos);
    expect(await engine.pairsChanged(projetos)).toBe(false);
    state = "unavailable";
    expect(await engine.pairsChanged(projetos)).toBe(false);
    state = "elsewhere";
    expect(await engine.pairsChanged(projetos)).toBe(true);
  });

  it("a opção de redirecionamentos (a mesma do deploy) traz o par do projeto", async () => {
    const engine = new DeployEngine(ctx({ hostState: async () => "pointed" }));
    const priv = engine as unknown as { redirectOptions(p: Project[]): Promise<{ redirects?: unknown[] }> };
    const atual = projeto({ slug: "a", domain: "example.com" });
    expect(await priv.redirectOptions([atual])).toEqual({ redirects: [{ host: "www.example.com", to: "example.com" }] });
  });
});
