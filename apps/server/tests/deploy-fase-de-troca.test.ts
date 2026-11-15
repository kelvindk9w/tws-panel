/**
 * Fase de troca do deploy no DeployService: quando o motor avisa que os containers do app começam a ser parados
 * ou recriados (opts.onReplaceStart), o painel regrava o Caddyfile na hora, com a espera curta pelos cabeçalhos
 * do app ligada (CaddyTarget.replacing). Antes disso (build) e depois do job, sem ela. O reload é só um ajuste:
 * falha nunca derruba o deploy. O motor tem testes próprios para o MOMENTO da troca (engine-fase-de-troca).
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";
import type { ServerConfig } from "../src/config.js";
import { DeployService } from "../src/services/deploy-service.js";
import { removeDir } from "./helpers/tmp.js";

type Engine = Record<string, unknown> & {
  setUpdating: (id: string, on: boolean) => boolean;
  setReplacing: (id: string, on: boolean) => boolean;
  isReplacing: (id: string) => boolean;
};
type ReplaceOpts = { onReplaceStart?: () => Promise<void> } | undefined;

let dataDir: string;
let svc: DeployService;
let syncCaddy: ReturnType<typeof vi.fn>;
/** Fase de troca de cada reload do Caddy, na ordem. */
let fasesNoReload: boolean[];
let projetoId = "";

const engineOf = (s: DeployService) => (s as unknown as { engine: Engine }).engine;

/** Faz o que o motor faz ao começar a troca: liga a fase e chama o gancho de quem pediu o deploy. */
async function simulaTroca(projectId: string, opts: ReplaceOpts): Promise<void> {
  if (!engineOf(svc).setReplacing(projectId, true)) return;
  await opts?.onReplaceStart?.();
}

function build(): DeployService {
  const s = new DeployService(
    { dataDir, projectsDir: path.join(dataDir, "projects"), caddyHttpPort: 80, caddyHttpsPort: 443, panelDomain: null, port: 9000 } as unknown as ServerConfig,
    { audit: { record: vi.fn(async () => ({})) } as never },
  );
  const engine = engineOf(s);
  engine.syncCaddy = syncCaddy;
  engine.deploy = vi.fn(async (p: Project, _all: Project[], _log: unknown, opts: ReplaceOpts) => simulaTroca(p.id, opts));
  engine.recreate = vi.fn(async (p: Project, _log: unknown, opts: ReplaceOpts) => simulaTroca(p.id, opts));
  engine.pinServingPort = async () => undefined;
  engine.settleAbandonedSwap = async () => "clean";
  (s as unknown as { takeMailSnapshot: () => Promise<void> }).takeMailSnapshot = async () => undefined;
  return s;
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-fase-troca-"));
  fasesNoReload = [];
  syncCaddy = vi.fn(async () => {
    fasesNoReload.push(engineOf(svc).isReplacing(projetoId));
  });
  svc = build();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await svc.idle();
  await removeDir(dataDir);
});

async function project(published = true) {
  const p = await svc.createProject({ name: "loja", ingestMode: "git", source: "https://github.com/k/loja", branch: "main", domain: "loja.localhost" });
  (await svc.getProject(p.id))!.detection = { type: "compose", proxyPort: 80, warnings: [], details: [] } as never;
  if (published) (await svc.getProject(p.id))!.lastDeployStatus = "success";
  projetoId = p.id;
  syncCaddy.mockClear();
  fasesNoReload = [];
  return p;
}

const jobs = () => (svc as unknown as { jobs: { status: string; log: string }[] }).jobs;

describe("deploy: reload do Caddy quando os containers começam a ser trocados", () => {
  it("o motor recebe o gancho; ao chamá-lo o Caddyfile é regravado já com a fase de troca, e ela some no fim do job", async () => {
    const p = await project();
    await svc.startDeploy(p.id);
    await svc.idle();
    const opts = (engineOf(svc).deploy as ReturnType<typeof vi.fn>).mock.calls[0]![3] as ReplaceOpts;
    expect(typeof opts?.onReplaceStart).toBe("function");
    // aviso ligado (sem a fase), troca (com a fase), fim do deploy (sem ela)
    expect(fasesNoReload[0]).toBe(false);
    expect(fasesNoReload).toContain(true);
    expect(fasesNoReload.at(-1)).toBe(false);
    expect(engineOf(svc).isReplacing(p.id)).toBe(false);
    expect(jobs().at(-1)!.status).toBe("success");
  });

  it("reload da troca que falha não derruba o deploy: só avisa no log do servidor", async () => {
    const p = await project();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    syncCaddy.mockImplementation(async () => {
      if (engineOf(svc).isReplacing(p.id)) throw new Error("Caddy fora do ar");
    });
    await svc.startDeploy(p.id);
    await svc.idle();
    expect(jobs().at(-1)!.status).toBe("success");
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("troca dos containers");
  });

  it("projeto nunca publicado: a troca não recarrega o Caddy (a página é 'em manutenção' de todo jeito)", async () => {
    const p = await project(false);
    await svc.startDeploy(p.id);
    await svc.idle();
    expect(fasesNoReload).not.toContain(true);
  });
});

describe("reinício com a configuração atual (recreate)", () => {
  it("também passa o gancho e regrava o Caddyfile com a fase de troca", async () => {
    const p = await project();
    await svc.startRecreate(p.id);
    await svc.idle();
    const opts = (engineOf(svc).recreate as ReturnType<typeof vi.fn>).mock.calls[0]![2] as ReplaceOpts;
    expect(typeof opts?.onReplaceStart).toBe("function");
    expect(fasesNoReload).toContain(true);
    expect(engineOf(svc).isReplacing(p.id)).toBe(false);
  });
});
