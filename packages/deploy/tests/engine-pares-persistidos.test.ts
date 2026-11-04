/**
 * Pares com/sem www gravados em disco (sobrevivem ao reinício do painel) e proxy do deploy calculado
 * dentro da fila do Caddy (retrato sempre fresco).
 */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainDnsState, Project } from "@paas/core";
import { CaddyManager } from "../src/caddy.js";
import { loadLastPairs, saveLastPairs } from "../src/domain-pairs.js";
import { DeployEngine, type EngineContext } from "../src/engine.js";

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

type ApplyProxy = (p: Project, all: Project[], up: string, log: () => void) => Promise<void>;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-pares-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const ctx = (extra: Partial<EngineContext> = {}): EngineContext => ({
  projectsDir: path.join(dir, "projects"),
  caddyDir: path.join(dir, "caddy"),
  nodeImage: "node:22",
  staticImage: "nginx:alpine",
  caddyHttpPort: 80,
  caddyHttpsPort: 443,
  ...extra,
});

describe("loadLastPairs / saveLastPairs", () => {
  it("grava e lê de volta; arquivo ausente, ilegível ou torto = nenhum par", async () => {
    const file = path.join(dir, "x", "pairs.json");
    expect(await loadLastPairs(file)).toEqual(new Set());
    expect(await saveLastPairs(file, new Set(["www.example.com", "example.org"]))).toBe(true);
    expect(await loadLastPairs(file)).toEqual(new Set(["www.example.com", "example.org"]));
    await writeFile(file, "{não é json");
    expect(await loadLastPairs(file)).toEqual(new Set());
    await writeFile(file, JSON.stringify({ pairs: [1, "www.example.com", null] }));
    expect(await loadLastPairs(file)).toEqual(new Set(["www.example.com"]));
    await writeFile(file, JSON.stringify({ outra: true }));
    expect(await loadLastPairs(file)).toEqual(new Set());
  });

  it("não consegue gravar (pasta é um arquivo): devolve false e não lança", async () => {
    const ocupado = path.join(dir, "ocupado");
    await writeFile(ocupado, "arquivo");
    expect(await saveLastPairs(path.join(ocupado, "pairs.json"), new Set(["www.example.com"]))).toBe(false);
  });
});

describe("DeployEngine — pares persistidos", () => {
  it("depois do reinício, DNS mudo na primeira recarga mantém o redirecionamento que já funcionava", async () => {
    const apply = vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
    const projetos = [proj("a", { domain: "example.com" })];
    const antes = new DeployEngine(ctx({ hostState: async () => "pointed" }));
    await antes.syncCaddy(projetos);
    const salvo = JSON.parse(await readFile(path.join(dir, "caddy", "pairs.json"), "utf8")) as { pairs: string[] };
    expect(salvo.pairs).toEqual(["www.example.com"]);

    // "reinício": motor novo (memória vazia), DNS sem resposta
    const depois = new DeployEngine(ctx({ hostState: async (): Promise<DomainDnsState> => "unavailable" }));
    await depois.syncCaddy(projetos);
    expect(apply.mock.calls.at(-1)![3]).toMatchObject({ redirects: [{ host: "www.example.com", to: "example.com" }] });
    expect(depois.appliedPairs().has("www.example.com")).toBe(true);
  });

  it("sem arquivo gravado, DNS mudo não inventa par", async () => {
    const apply = vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
    const engine = new DeployEngine(ctx({ hostState: async (): Promise<DomainDnsState> => "unavailable" }));
    await engine.syncCaddy([proj("a", { domain: "example.com" })]);
    expect(apply.mock.calls[0]![3]).not.toHaveProperty("redirects");
  });

  it("só regrava quando os pares mudam; DNS que deixa de apontar remove do arquivo", async () => {
    vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
    let state: DomainDnsState = "pointed";
    const engine = new DeployEngine(ctx({ hostState: async () => state }));
    const projetos = [proj("a", { domain: "example.com" })];
    await engine.syncCaddy(projetos);
    const file = path.join(dir, "caddy", "pairs.json");
    const t1 = (await stat(file)).mtimeMs;
    await new Promise((r) => setTimeout(r, 15));
    await engine.syncCaddy(projetos);
    expect((await stat(file)).mtimeMs).toBe(t1);
    state = "missing";
    await engine.syncCaddy(projetos);
    expect(await loadLastPairs(file)).toEqual(new Set());
  });

  it("gravação do arquivo falha: a aplicação do proxy segue normalmente", async () => {
    vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
    await writeFile(path.join(dir, "caddy"), "sou um arquivo, não uma pasta");
    const engine = new DeployEngine(ctx({ hostState: async () => "pointed" }));
    await expect(engine.syncCaddy([proj("a", { domain: "example.com" })])).resolves.toBeUndefined();
    expect(engine.appliedPairs().has("www.example.com")).toBe(true);
  });
});

describe("DeployEngine.applyProxy — retrato fresco dentro da fila", () => {
  it("um 'desligar' de outro projeto feito enquanto o motor espera os hosts de e-mail não é sobrescrito", async () => {
    const apply = vi.spyOn(CaddyManager.prototype, "apply").mockResolvedValue(undefined);
    let liberar!: () => void;
    const trava = new Promise<void>((r) => (liberar = r));
    const engine = new DeployEngine(
      ctx({
        mailHosts: async () => {
          await trava;
          return [];
        },
      }),
    );
    const a = proj("a");
    const b = proj("b");
    engine.setUpdating("b", true);
    const pronto = (engine as unknown as { applyProxy: ApplyProxy }).applyProxy(a, [a, b], "a:80", () => undefined);
    // enquanto a chamada espera: o deploy de b termina e desliga o aviso
    await Promise.resolve();
    engine.setUpdating("b", false);
    liberar();
    await pronto;
    const [targets] = apply.mock.calls[0]!;
    expect(targets.find((t) => t.domain === "b.example.com")?.updating).toBeUndefined();
  });

  it("entra na mesma fila do syncCaddy: nunca roda junto com ele", async () => {
    const ordem: string[] = [];
    vi.spyOn(CaddyManager.prototype, "apply").mockImplementation(async (targets) => {
      ordem.push(`ini:${targets.length}`);
      await new Promise((r) => setTimeout(r, 10));
      ordem.push(`fim:${targets.length}`);
    });
    const engine = new DeployEngine(ctx());
    const a = proj("a");
    const b = proj("b");
    await Promise.all([engine.syncCaddy([a]), (engine as unknown as { applyProxy: ApplyProxy }).applyProxy(a, [a, b], "a:80", () => undefined)]);
    expect(ordem).toEqual(["ini:1", "fim:1", "ini:2", "fim:2"]);
  });
});
