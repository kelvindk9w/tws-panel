/**
 * deploy-domain-pairs.test.ts — o par com/sem www dos domínios do projeto.
 *
 * O nome digitado é o canônico; o par só redireciona para ele. Aqui: quem tem
 * par, ligar/desligar (padrão ligado), nome já usado por outro projeto ou pelo
 * painel (o par não é criado e nada é tomado), limpeza ao remover o domínio e a
 * conferência periódica que liga o redirecionamento quando o DNS passa a apontar.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainDnsState } from "@paas/core";
import type { ServerConfig } from "../src/config.js";
import { DeployService } from "../src/services/deploy-service.js";

let dataDir: string;
let svc: DeployService;
let sync: ReturnType<typeof vi.fn>;
let dns: Record<string, DomainDnsState>;

function build(withDns = true): DeployService {
  const s = new DeployService(
    {
      dataDir,
      projectsDir: path.join(dataDir, "projects"),
      caddyHttpPort: 80,
      caddyHttpsPort: 443,
      panelDomain: "203-0-113-10.sslip.io",
      port: 9000,
    } as unknown as ServerConfig,
    withDns ? { hostState: async (h: string) => dns[h] ?? "missing" } : {},
  );
  sync = vi.fn(async () => undefined);
  (s as unknown as { engine: { syncCaddy: typeof sync } }).engine.syncCaddy = sync;
  return s;
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-pairs-"));
  dns = {};
  svc = build();
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const base = { ingestMode: "git" as const, source: "https://github.com/k/x", branch: "main" };
const proj = (name: string, domain: string) => svc.createProject({ ...base, name, domain });

describe("domainPairs", () => {
  it("apex e www ganham par; subdomínio e sslip.io não; padrão ligado", async () => {
    const p = await proj("site", "example.com");
    await svc.addDomain(p.id, "www.outro.com.br");
    await svc.addDomain(p.id, "app.example.com");
    await svc.addDomain(p.id, "site.203-0-113-10.sslip.io");
    const rows = await svc.domainPairs(p.id);
    expect(rows.map((r) => [r.domain, r.pair, r.role, r.enabled])).toEqual([
      ["example.com", "www.example.com", "www", true],
      ["www.outro.com.br", "outro.com.br", "apex", true],
    ]);
  });

  it("ativo só com o DNS apontado e o nome livre", async () => {
    const p = await proj("site", "example.com");
    expect((await svc.domainPairs(p.id))[0]).toMatchObject({ state: "missing", active: false });
    dns["www.example.com"] = "pointed";
    // DNS apontado mas o Caddy ainda não aplicou: ainda não está redirecionando
    expect((await svc.domainPairs(p.id))[0]).toMatchObject({ state: "pointed", active: false, enabled: true });
    const engine = (svc as unknown as { engine: { appliedPairs: () => ReadonlySet<string> } }).engine;
    engine.appliedPairs = () => new Set(["www.example.com"]);
    expect((await svc.domainPairs(p.id))[0]).toMatchObject({ state: "pointed", active: true, enabled: true });
    dns["www.example.com"] = "cloudflare";
    expect((await svc.domainPairs(p.id))[0]).toMatchObject({ state: "cloudflare", active: false });
  });

  it("sem consulta de DNS o estado é 'unavailable' e nada fica ativo; consulta que lança também", async () => {
    const semDns = build(false);
    const p = await semDns.createProject({ ...base, name: "site", domain: "example.com" });
    expect((await semDns.domainPairs(p.id))[0]).toMatchObject({ state: "unavailable", active: false });
    const quebrado = new DeployService(
      { dataDir: await mkdtemp(path.join(tmpdir(), "paas-pairs2-")), caddyHttpPort: 80, caddyHttpsPort: 443, panelDomain: null, port: 9000 } as unknown as ServerConfig,
      { hostState: async () => { throw new Error("x"); } },
    );
    (quebrado as unknown as { engine: { syncCaddy: () => Promise<void> } }).engine.syncCaddy = async () => undefined;
    const q = await quebrado.createProject({ ...base, name: "q", domain: "example.com" });
    expect((await quebrado.domainPairs(q.id))[0]!.state).toBe("unavailable");
  });

  it("o par de outro projeto não é tomado: sem alias, com o motivo", async () => {
    const a = await proj("loja", "example.com");
    await proj("blog", "www.example.com");
    const rows = await svc.domainPairs(a.id);
    expect(rows[0]).toMatchObject({ occupiedBy: "other_project", active: false });
    // e o outro lado também: o apex é de a
    const b = (await svc.listProjects()).find((x) => x.name === "blog")!;
    expect((await svc.domainPairs(b.id))[0]).toMatchObject({ pair: "example.com", occupiedBy: "other_project", active: false });
  });

  it("o par já conectado ao mesmo projeto é 'same_project' (não precisa de redirecionamento)", async () => {
    const p = await proj("site", "example.com");
    await svc.addDomain(p.id, "www.example.com");
    dns["www.example.com"] = "pointed";
    const rows = await svc.domainPairs(p.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.occupiedBy === "same_project" && !r.active)).toBe(true);
  });

  it("endereço do painel não vira par: ocupado pelo painel, sem redirecionamento", async () => {
    const p = await proj("site", "example.com");
    svc.setPanelAddresses({ primary: "painel.example.net", aliases: ["www.example.com"] });
    dns["www.example.com"] = "pointed";
    expect((await svc.domainPairs(p.id))[0]).toMatchObject({ occupiedBy: "panel", active: false });
    expect(await svc.occupantOf("painel.example.net", null)).toBe("panel");
  });

  it("domínio do painel cadastrado e ainda sem DNS também é do painel", async () => {
    const p = await proj("site", "example.com");
    svc.setPanelReserved(["www.example.com"]);
    dns["www.example.com"] = "pointed";
    expect((await svc.domainPairs(p.id))[0]).toMatchObject({ occupiedBy: "panel", active: false });
    const ctx = (svc as unknown as { engineCtx: { reservedNames: () => string[] } }).engineCtx;
    expect(ctx.reservedNames()).toEqual(["www.example.com"]);
  });

  it("nome do servidor de e-mail (PAAS_MAIL_HOSTNAME) é do e-mail: o par não o toma", async () => {
    svc.setMailHostsProvider(async () => ["example.org", "mail.example.org"]);
    const p = await proj("site", "www.example.org");
    dns["example.org"] = "pointed";
    expect((await svc.domainPairs(p.id))[0]).toMatchObject({ pair: "example.org", occupiedBy: "mail", active: false });
    expect(await svc.occupantOf("mail.example.org", null)).toBe("mail");
    svc.setMailHostsProvider(async () => { throw new Error("falhou"); });
    expect(await svc.occupantOf("example.org", p.id)).toBeNull();
  });

  it("projeto inexistente: 404", async () => {
    await expect(svc.domainPairs("nao-existe")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("occupantOf", () => {
  it("livre, de outro projeto, do mesmo projeto", async () => {
    const a = await proj("a", "example.com");
    await svc.addDomain(a.id, "x.example.org");
    expect(await svc.occupantOf("livre.example.com", a.id)).toBeNull();
    expect(await svc.occupantOf("example.com", a.id)).toBe("same_project");
    expect(await svc.occupantOf("x.example.org", a.id)).toBe("same_project");
    expect(await svc.occupantOf("example.com", "outro")).toBe("other_project");
    expect(await svc.occupantOf("example.com", null)).toBe("other_project");
  });
});

describe("setDomainPair", () => {
  it("desligar grava, aplica o proxy e audita; ligar de novo volta ao padrão (sem lista vazia)", async () => {
    const p = await proj("site", "example.com");
    await svc.addDomain(p.id, "example.org");
    sync.mockClear();
    const off = await svc.setDomainPair(p.id, "Example.COM", false);
    expect(off.pairOff).toEqual(["example.com"]);
    expect(sync).toHaveBeenCalledTimes(1);
    expect((await svc.domainPairs(p.id))[0]!.enabled).toBe(false);
    expect((await svc.domainPairs(p.id))[0]!.active).toBe(false);

    const both = await svc.setDomainPair(p.id, "example.org", false);
    expect(both.pairOff?.sort()).toEqual(["example.com", "example.org"]);
    const one = await svc.setDomainPair(p.id, "example.com", true);
    expect(one.pairOff).toEqual(["example.org"]);
    const none = await svc.setDomainPair(p.id, "example.org", true);
    expect(none.pairOff).toBeUndefined();
    expect("pairOff" in none).toBe(false);
  });

  it("domínio que não é do projeto: 404; domínio sem par: 400", async () => {
    const p = await proj("site", "example.com");
    await svc.addDomain(p.id, "app.example.com");
    await expect(svc.setDomainPair(p.id, "outro.com", false)).rejects.toMatchObject({ statusCode: 404, code: "domain_not_found" });
    await expect(svc.setDomainPair(p.id, "app.example.com", false)).rejects.toMatchObject({ statusCode: 400, code: "no_pair" });
  });
});

describe("conectar e trocar domínio com a escolha do par", () => {
  it("addDomain sem opção não mexe no par; pair:false desliga só aquele domínio", async () => {
    const p = await proj("site", "example.com");
    expect((await svc.addDomain(p.id, "example.org")).pairOff).toBeUndefined();
    const off = await svc.addDomain(p.id, "example.net", { pair: false });
    expect(off.pairOff).toEqual(["example.net"]);
    const on = await svc.addDomain(p.id, "example.io", { pair: true });
    expect(on.pairOff).toEqual(["example.net"]);
  });

  it("remover o domínio leva a escolha junto: um nome futuro igual começa do padrão", async () => {
    const p = await proj("site", "example.com");
    await svc.addDomain(p.id, "example.org", { pair: false });
    expect((await svc.removeDomain(p.id, "example.org")).pairOff).toBeUndefined();
    const again = await svc.addDomain(p.id, "example.org");
    expect(again.pairOff).toBeUndefined();
    await svc.addDomain(p.id, "example.net", { pair: false });
    await svc.addDomain(p.id, "example.io", { pair: false });
    expect((await svc.removeDomain(p.id, "example.net")).pairOff).toEqual(["example.io"]);
  });

  it("tornar principal não muda a escolha do par", async () => {
    const p = await proj("site", "example.com");
    await svc.addDomain(p.id, "example.org", { pair: false });
    const up = await svc.setPrimaryDomain(p.id, "example.org");
    expect(up.pairOff).toEqual(["example.org"]);
  });

  it("PATCH do domínio com pair:false desliga o par do novo principal; o antigo leva a escolha embora", async () => {
    const p = await proj("site", "site.203-0-113-10.sslip.io");
    sync.mockClear();
    const up = await svc.updateProject(p.id, { domain: "example.com", pair: false });
    expect(up.pairOff).toEqual(["example.com"]);
    expect(sync).toHaveBeenCalledTimes(1);
    // outro PATCH troca o principal de novo: a escolha do antigo sai
    const next = await svc.updateProject(p.id, { domain: "example.org" });
    expect(next.pairOff).toBeUndefined();
  });

  it("PATCH repetido com o mesmo domínio: pair:false liga o proxy uma vez; pair:true volta ao padrão", async () => {
    const p = await proj("site", "example.com");
    sync.mockClear();
    await svc.updateProject(p.id, { domain: "example.com", pair: false });
    expect(sync).toHaveBeenCalledTimes(1);
    await svc.updateProject(p.id, { domain: "example.com", pair: false });
    expect(sync).toHaveBeenCalledTimes(1); // nada mudou
    const back = await svc.updateProject(p.id, { domain: "example.com", pair: true });
    expect(back.pairOff).toBeUndefined();
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("pair sem domain é ignorado; domínio sem alteração não reaplica o proxy", async () => {
    const p = await proj("site", "example.com");
    sync.mockClear();
    const up = await svc.updateProject(p.id, { pair: false, websocket: true });
    expect(up.pairOff).toBeUndefined();
    expect(sync).not.toHaveBeenCalled();
  });

  it("domínio de outro projeto continua recusado (o par não abre brecha)", async () => {
    await proj("a", "example.com");
    const b = await proj("b", "b.example.net");
    await expect(svc.addDomain(b.id, "example.com", { pair: false })).rejects.toMatchObject({ code: "domain_in_use" });
  });
});

describe("reconcilePairs", () => {
  it("reaplica o proxy só quando um par passa a apontar (ou deixa de)", async () => {
    const s = build();
    // o motor real, só sem Docker: troca o apply do Caddy e deixa pairsChanged/pairRedirects de verdade
    const engine = (s as unknown as { engine: { syncCaddy: (p: unknown[]) => Promise<void>; caddy: { apply: () => Promise<void> } } }).engine;
    delete (engine as { syncCaddy?: unknown }).syncCaddy;
    engine.caddy.apply = vi.fn(async () => undefined);
    const applyProxy = vi.spyOn(s as unknown as { applyProxy: () => Promise<void> }, "applyProxy").mockResolvedValue(undefined);
    await s.createProject({ ...base, name: "site", domain: "example.com" });
    applyProxy.mockClear();

    expect(await s.reconcilePairs()).toBe(false);
    expect(applyProxy).not.toHaveBeenCalled();
    dns["www.example.com"] = "pointed";
    expect(await s.reconcilePairs()).toBe(true);
    expect(applyProxy).toHaveBeenCalledTimes(1);
  });
});

describe("domínio digitado em Unicode (a mesma normalização do guia)", () => {
  it("criar projeto e adicionar domínio guardam punycode; o par e o status usam o mesmo nome", async () => {
    const p = await proj("site", "Exämple.com");
    expect(p.domain).toBe("xn--exmple-cua.com");
    const q = await svc.addDomain(p.id, "loja.公司.cn");
    expect(q.aliases).toContain("loja.xn--55qx5d.cn");
    await svc.addDomain(p.id, "example.公司.cn");
    dns["www.example.xn--55qx5d.cn"] = "pointed";
    const rows = await svc.domainPairs(p.id);
    expect(rows.map((r) => r.domain)).toContain("example.xn--55qx5d.cn");
    expect(rows.find((r) => r.domain === "xn--exmple-cua.com")?.pair).toBe("www.xn--exmple-cua.com");
    expect((await svc.setDomainPair(p.id, "exämple.com", false)).pairOff).toEqual(["xn--exmple-cua.com"]);
    const sem = await svc.removeDomain(p.id, "loja.公司.cn");
    expect(sem.aliases).not.toContain("loja.xn--55qx5d.cn");
  });

  it.each(["ä<.com", "exä mple.com", "a:80@x.com", "ä%41.com", "ä\\x.com", `${"ä".repeat(70)}.com`])("entrada inválida %j continua recusada (400)", async (ruim) => {
    await expect(svc.createProject({ ...base, name: "ruim", domain: ruim })).rejects.toMatchObject({ statusCode: 400 });
    const p = await proj("ok", "example.org");
    await expect(svc.addDomain(p.id, ruim)).rejects.toMatchObject({ statusCode: 400 });
  });
});
