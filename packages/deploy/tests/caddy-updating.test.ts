/**
 * Aviso "Atualizando" no proxy central: enquanto um deploy roda, o visitante de um
 * site que já esteve no ar vê "volta em instantes" (503 + Retry-After, atualização
 * a cada 5 s, sem recurso externo). Fora do deploy, as páginas de sempre.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";
import { CaddyManager, PROJECT_DOWN_PAGE, PROJECT_PENDING_PAGE, PROJECT_UPDATING_PAGE, renderCaddyfile } from "../src/caddy.js";
import { DeployEngine, caddyTargetsFor, type EngineContext } from "../src/engine.js";

const alvo = { domain: "loja.example.com", upstream: "paas-loja:3000", websocket: false };
const count = (text: string, part: string) => text.split(part).length - 1;

describe("página Atualizando", () => {
  it("atualiza a cada 5 s, tem a linha em inglês e nenhum recurso externo", () => {
    expect(PROJECT_UPDATING_PAGE).toContain('<meta http-equiv="refresh" content="5">');
    expect(PROJECT_UPDATING_PAGE).toContain("Atualizando");
    expect(PROJECT_UPDATING_PAGE).toContain("Updating");
    expect(PROJECT_UPDATING_PAGE).not.toMatch(/<(script|link|img|iframe)\b/i);
    expect(PROJECT_UPDATING_PAGE).not.toMatch(/src=|url\(/);
  });

  it("projeto atualizando: 503 com a página nova, Retry-After e sem cache", () => {
    const out = renderCaddyfile([{ ...alvo, published: true, updating: true }]);
    expect(out).toContain(`respond \`${PROJECT_UPDATING_PAGE}\` 503`);
    expect(out).toContain('header Retry-After "5"');
    expect(out).toContain('header Cache-Control "no-store"');
    expect(out).not.toContain(PROJECT_DOWN_PAGE);
  });

  it("fora do deploy mantém a página de indisponível, sem Retry-After", () => {
    const out = renderCaddyfile([{ ...alvo, published: true }]);
    expect(out).toContain(`respond \`${PROJECT_DOWN_PAGE}\` 503`);
    expect(out).not.toContain("Retry-After");
  });

  it("nunca publicado continua com 'em manutenção', mesmo no primeiro deploy", () => {
    const out = renderCaddyfile([{ ...alvo, published: false, updating: true }]);
    expect(out).toContain(`respond \`${PROJECT_PENDING_PAGE}\` 503`);
    expect(out).not.toContain(PROJECT_UPDATING_PAGE);
  });

  it("só o projeto atualizando muda; o vizinho segue com a página normal", () => {
    const out = renderCaddyfile([
      { ...alvo, published: true, updating: true },
      { domain: "blog.example.com", upstream: "paas-blog:80", websocket: false, published: true },
    ]);
    expect(count(out, PROJECT_UPDATING_PAGE)).toBe(1);
    expect(count(out, PROJECT_DOWN_PAGE)).toBe(1);
  });

  it("domínio dinâmico do projeto atualizando também mostra o aviso, mantendo on_demand", () => {
    const out = renderCaddyfile([], undefined, [], [], {
      dynamic: {
        askUrl: "http://tws-panel:9101/caddy/ask",
        routes: [{ upstream: "paas-loja:3000", websocket: false, published: true, updating: true, suffixes: ["example.com"], hosts: [] }],
      },
    });
    expect(out).toContain(PROJECT_UPDATING_PAGE);
    expect(out).toContain("on_demand");
  });

  it("o webmail não ganha o aviso", () => {
    const out = renderCaddyfile([{ ...alvo, published: true, updating: true }], undefined, ["mail.example.com"], [], {
      webmail: { upstream: "paas-webmail:8000" },
    });
    expect(count(out, PROJECT_UPDATING_PAGE)).toBe(1);
  });
});

describe("espera pelo app (lb_try_duration)", () => {
  it("projeto no ar espera o app voltar por alguns segundos antes da página de erro", () => {
    const out = renderCaddyfile([{ ...alvo, published: true }]);
    expect(out).toContain("lb_try_duration 20s");
    expect(out).toContain("lb_try_interval 300ms");
  });

  it("websocket mantém flush_interval e também espera", () => {
    const out = renderCaddyfile([{ ...alvo, websocket: true, published: true }]);
    expect(out).toContain("flush_interval -1");
    expect(out).toContain("lb_try_duration 20s");
  });

  it("projeto parado de propósito não espera: página na hora", () => {
    const out = renderCaddyfile([{ ...alvo, published: true, stopped: true }]);
    expect(out).not.toContain("lb_try_duration");
    expect(out).toContain("reverse_proxy paas-loja:3000 {");
  });

  it("com o aviso ligado a espera é curta (3 s); sem ele, 20 s", () => {
    const on = renderCaddyfile([{ ...alvo, published: true, updating: true }]);
    expect(on).toContain("lb_try_duration 3s");
    expect(on).not.toContain("lb_try_duration 20s");
    expect(renderCaddyfile([{ ...alvo, published: true }])).toContain("lb_try_duration 20s");
  });

  it("stream_close_delay mantém WebSockets vivos num reload: projetos (parados ou não) e painel", () => {
    const out = renderCaddyfile(
      [
        { ...alvo, published: true, websocket: true },
        { domain: "b.example.com", upstream: "paas-b:80", websocket: false, published: true, stopped: true },
      ],
      { domain: "203-0-113-10.sslip.io", upstream: "tws-panel:9000" },
    );
    expect(count(out, "stream_close_delay 5m")).toBe(3);
  });

  it("domínio dinâmico espera, e parado não", () => {
    const rota = { upstream: "paas-loja:3000", websocket: false, published: true, suffixes: ["example.com"], hosts: [] };
    const dyn = (stopped: boolean) =>
      renderCaddyfile([], undefined, [], [], { dynamic: { askUrl: "http://tws-panel:9101/caddy/ask", routes: [{ ...rota, stopped }] } });
    expect(dyn(false)).toContain("lb_try_duration 20s");
    expect(dyn(true)).not.toContain("lb_try_duration");
  });

  it("o painel e o webmail não esperam", () => {
    const out = renderCaddyfile([], { domain: "203-0-113-10.sslip.io", upstream: "tws-panel:9000" }, ["mail.example.com"], [], {
      webmail: { upstream: "paas-webmail:8000" },
    });
    expect(out).not.toContain("lb_try_duration");
  });

  it("a página de indisponível atualiza a cada 10 s", () => {
    expect(PROJECT_DOWN_PAGE).toContain('<meta http-equiv="refresh" content="10">');
  });

  it("caddyTargetsFor marca projeto parado", () => {
    const [t] = caddyTargetsFor([proj("a", { stoppedAt: "2026-11-01T00:00:00.000Z" })], (p) => `${p.slug}:80`);
    expect(t?.stopped).toBe(true);
  });
});

const proj = (slug: string, over: Partial<Project> = {}): Project =>
  ({
    id: slug,
    slug,
    name: slug,
    ingestMode: "git",
    source: "https://example.com/r.git",
    branch: "main",
    domain: `${slug}.example.com`,
    websocket: false,
    detection: null,
    lastDeployStatus: "success",
    deployedSource: "x",
    ...over,
  }) as unknown as Project;

describe("caddyTargetsFor com o aviso", () => {
  it("marca só os projetos que o predicado diz estarem atualizando", () => {
    const targets = caddyTargetsFor([proj("a"), proj("b")], (p) => `${p.slug}:80`, (p) => p.id === "a");
    expect(targets.find((t) => t.domain === "a.example.com")?.updating).toBe(true);
    expect(targets.find((t) => t.domain === "b.example.com")?.updating).toBeUndefined();
  });
});

describe("DeployEngine — aviso Atualizando", () => {
  afterEach(() => vi.restoreAllMocks());
  const ctx = (extra: Partial<EngineContext> = {}): EngineContext => ({
    projectsDir: "/nonexistent/projects",
    caddyDir: "/nonexistent/caddy",
    nodeImage: "node:22",
    staticImage: "nginx:alpine",
    caddyHttpPort: 80,
    caddyHttpsPort: 443,
    ...extra,
  });

  it("setUpdating liga e desliga e diz se algo mudou", () => {
    const engine = new DeployEngine(ctx());
    expect(engine.isUpdating("a")).toBe(false);
    expect(engine.setUpdating("a", true)).toBe(true);
    expect(engine.setUpdating("a", true)).toBe(false);
    expect(engine.isUpdating("a")).toBe(true);
    expect(engine.setUpdating("a", false)).toBe(true);
    expect(engine.setUpdating("a", false)).toBe(false);
    expect(engine.isUpdating("a")).toBe(false);
  });

  it("syncCaddy leva o aviso aos alvos e às rotas dinâmicas; ao desligar, o Caddyfile volta ao normal", async () => {
    const apply = vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
    const engine = new DeployEngine(
      ctx({ dynamicDomains: async () => ({ askUrl: "http://tws-panel:9101/caddy/ask", projects: [{ projectId: "a", suffixes: ["example.com"], hosts: [] }] }) }),
    );
    const projetos = [proj("a"), proj("b")];
    engine.setUpdating("a", true);
    await engine.syncCaddy(projetos, undefined, { noRestart: true });
    const [targets, , , opts] = apply.mock.calls[0]!;
    expect(targets.find((t) => t.domain === "a.example.com")?.updating).toBe(true);
    expect(targets.find((t) => t.domain === "b.example.com")?.updating).toBeUndefined();
    expect(opts?.dynamic?.routes[0]?.updating).toBe(true);
    expect(opts?.noRestart).toBe(true);

    engine.setUpdating("a", false);
    await engine.syncCaddy(projetos);
    const [after, , , optsAfter] = apply.mock.calls[1]!;
    expect(after.every((t) => t.updating === undefined)).toBe(true);
    expect(optsAfter?.dynamic?.routes[0]).not.toHaveProperty("updating");
    expect(optsAfter).not.toHaveProperty("noRestart");
  });
});

describe("DeployEngine — syncCaddy em fila", () => {
  afterEach(() => vi.restoreAllMocks());
  it("cada Caddyfile é calculado na vez da chamada: o aviso de agora nunca é sobrescrito por um cálculo antigo", async () => {
    const vistos: Array<boolean | undefined> = [];
    vi.spyOn(CaddyManager.prototype, "apply").mockImplementation(async (targets) => {
      await new Promise((r) => setTimeout(r, 5));
      vistos.push(targets[0]?.updating);
    });
    const engine = new DeployEngine({
      projectsDir: "/nonexistent/projects",
      caddyDir: "/nonexistent/caddy",
      nodeImage: "node:22",
      staticImage: "nginx:alpine",
      caddyHttpPort: 80,
      caddyHttpsPort: 443,
    });
    const projetos = [proj("a")];
    engine.setUpdating("a", true);
    const first = engine.syncCaddy(projetos);
    engine.setUpdating("a", false);
    const second = engine.syncCaddy(projetos);
    engine.setUpdating("a", true);
    const third = engine.syncCaddy(projetos);
    await Promise.all([first, second, third]);
    // a ordem das aplicações é a das chamadas, e a última reflete o estado mais novo
    expect(vistos.at(-1)).toBe(true);
    expect(vistos).toHaveLength(3);
  });
});
