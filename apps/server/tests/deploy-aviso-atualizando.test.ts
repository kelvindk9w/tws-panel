/**
 * Aviso "Atualizando" do proxy e acomodação depois do deploy:
 *  - o aviso liga no início do job (reload sem reiniciar o Caddy) e desliga ao fim, em sucesso OU falha;
 *  - no boot, deploy que ficou "em andamento" no disco faz o Caddyfile ser regravado sem o aviso;
 *  - o status do projeto é "deploying" enquanto o job roda, e o monitoramento só volta a alertar
 *    depois da acomodação (2 min) — falha real continua alertando.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { DEPLOY_SETTLE_MS, DeployService } from "../src/services/deploy-service.js";
import { removeDir } from "./helpers/tmp.js";

type Engine = Record<string, unknown> & { setUpdating: (id: string, on: boolean) => boolean; isUpdating: (id: string) => boolean };

let dataDir: string;
let svc: DeployService;
let syncCaddy: ReturnType<typeof vi.fn>;
let setUpdating: ReturnType<typeof vi.spyOn>;
let engineDeploy: ReturnType<typeof vi.fn>;

const engineOf = (s: DeployService) => (s as unknown as { engine: Engine }).engine;

function build(): DeployService {
  const s = new DeployService(
    { dataDir, projectsDir: path.join(dataDir, "projects"), caddyHttpPort: 80, caddyHttpsPort: 443, panelDomain: null, port: 9000 } as unknown as ServerConfig,
    { audit: { record: vi.fn(async () => ({})) } as never },
  );
  const engine = engineOf(s);
  engine.syncCaddy = syncCaddy;
  engine.deploy = engineDeploy;
  engine.recreate = vi.fn(async () => undefined);
  setUpdating = vi.spyOn(engine, "setUpdating");
  (s as unknown as { takeMailSnapshot: () => Promise<void> }).takeMailSnapshot = async () => undefined;
  return s;
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-aviso-"));
  syncCaddy = vi.fn(async () => undefined);
  engineDeploy = vi.fn(async () => undefined);
  svc = build();
});
afterEach(async () => {
  vi.useRealTimers();
  await removeDir(dataDir);
});

async function project(published = true) {
  const p = await svc.createProject({ name: "loja", ingestMode: "git", source: "https://github.com/k/loja", branch: "main", domain: "loja.localhost" });
  (await svc.getProject(p.id))!.detection = { type: "static", warnings: [], details: [] } as never;
  if (published) (await svc.getProject(p.id))!.lastDeployStatus = "success";
  syncCaddy.mockClear(); // a criação já recarregou o proxy; o que interessa é o que vem depois
  return p;
}

const flags = () => setUpdating.mock.calls.map((c: unknown[]) => c[1]);
const runningJob = (projectId: string) => ({ id: "j1", projectId, status: "running", createdAt: "x", startedAt: "x", finishedAt: null, steps: [], log: "", error: null });

describe("aviso Atualizando no proxy", () => {
  it("liga no início sem reiniciar o Caddy e desliga no sucesso", async () => {
    let during: { updating: boolean; status: string } | null = null;
    const p = await project();
    engineDeploy.mockImplementationOnce(async () => {
      during = { updating: engineOf(svc).isUpdating(p.id), status: (await svc.statusOf((await svc.getProject(p.id))!, [])).status };
    });
    const job = await svc.startDeploy(p.id);
    await vi.waitFor(async () => expect((await svc.getJob(p.id, job.id))?.status).toBe("success"));
    expect(during).toEqual({ updating: true, status: "deploying" });
    expect(syncCaddy.mock.calls[0]![2]).toEqual({ noRestart: true });
    expect(engineOf(svc).isUpdating(p.id)).toBe(false);
    expect(flags()).toContain(true);
    expect(flags().at(-1)).toBe(false);
  });

  it("desliga também quando o deploy falha, e o status volta ao normal", async () => {
    const p = await project();
    engineDeploy.mockRejectedValueOnce(new Error("build quebrou"));
    const job = await svc.startDeploy(p.id);
    await vi.waitFor(async () => expect((await svc.getJob(p.id, job.id))?.status).toBe("failed"));
    expect(engineOf(svc).isUpdating(p.id)).toBe(false);
    // desligar também NUNCA reinicia o Caddy
    expect(syncCaddy.mock.calls.at(-1)![2]).toEqual({ noRestart: true });
    expect((await svc.statusOf((await svc.getProject(p.id))!, [])).status).toBe("error");
  });

  it("falha ao recarregar o Caddy nunca impede o deploy", async () => {
    syncCaddy.mockRejectedValue(new Error("caddy fora"));
    const warn = vi.fn();
    (svc as unknown as { logger: { warn: typeof warn } }).logger = { warn };
    const p = await project();
    const job = await svc.startDeploy(p.id);
    await vi.waitFor(async () => expect((await svc.getJob(p.id, job.id))?.status).toBe("success"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('aviso "Atualizando"'));
  });

  it("reinício com a configuração atual (recreate) também liga e desliga", async () => {
    const p = await project();
    (await svc.getProject(p.id))!.lastDeployStatus = "success";
    const job = await svc.startRecreate(p.id);
    await vi.waitFor(async () => expect((await svc.getJob(p.id, job.id))?.status).toBe("success"));
    expect(flags()).toEqual([true, false]);
  });

  it("parar e iniciar regravam o proxy (parado de propósito não espera o app)", async () => {
    const p = await project();
    const engine = engineOf(svc);
    engine.stop = vi.fn(async () => undefined);
    engine.start = vi.fn(async () => undefined);
    await svc.stop(p.id, () => undefined);
    expect(syncCaddy).toHaveBeenCalledTimes(1);
    expect(syncCaddy.mock.calls[0]![2]).toEqual({ noRestart: true });
    await svc.start(p.id, () => undefined);
    expect(syncCaddy).toHaveBeenCalledTimes(2);
    expect(syncCaddy.mock.calls[1]![2]).toEqual({ noRestart: true });
  });

  it("parar com o reload falhando só avisa (e nunca reinicia o Caddy)", async () => {
    const warn = vi.fn();
    (svc as unknown as { logger: { warn: typeof warn } }).logger = { warn };
    const p = await project();
    engineOf(svc).stop = vi.fn(async () => undefined);
    syncCaddy.mockRejectedValue(new Error("reload falhou"));
    await svc.stop(p.id, () => undefined);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("reload falhou"));
  });

  it("projeto nunca publicado: ligar e desligar o aviso não recarrega o Caddy", async () => {
    const p = await project(false);
    const job = await svc.startDeploy(p.id);
    await vi.waitFor(async () => expect((await svc.getJob(p.id, job.id))?.finishedAt).toBeTruthy());
    // sucesso do primeiro deploy: um único ajuste do proxy (o final, que já publica), nada de reload de aviso
    const noRestartCalls = syncCaddy.mock.calls.filter((c) => (c[2] as { noRestart?: boolean } | undefined)?.noRestart === true);
    expect(noRestartCalls).toHaveLength(0);
  });

  it("falha do reload que desliga o aviso: tenta de novo sozinho, sem reiniciar o Caddy", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const p = await project();
    (await svc.getProject(p.id))!.lastDeployStatus = "success";
    syncCaddy.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("falhou 1")).mockResolvedValueOnce(undefined);
    const job = await svc.startDeploy(p.id);
    await vi.waitFor(async () => expect((await svc.getJob(p.id, job.id))?.finishedAt).toBeTruthy(), { timeout: 2000 });
    await vi.waitFor(() => expect(syncCaddy.mock.calls.length).toBeGreaterThanOrEqual(2));
    const antes = syncCaddy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(syncCaddy.mock.calls.length).toBeGreaterThan(antes);
    expect(syncCaddy.mock.calls.at(-1)![2]).toEqual({ noRestart: true });
  });
});

describe("boot: aviso preso", () => {
  it("deploy 'em andamento' no disco: o boot regrava o Caddyfile sem o aviso, sem reiniciar o Caddy, uma vez só", async () => {
    const p = await project();
    await writeFile(path.join(dataDir, "deploy-jobs.json"), JSON.stringify({ jobs: [runningJob(p.id)] }));
    const rebooted = build();
    syncCaddy.mockClear();
    const warn = vi.fn();
    await rebooted.clearStaleUpdating({ warn });
    expect(syncCaddy).toHaveBeenCalledTimes(1);
    expect(syncCaddy.mock.calls[0]![2]).toEqual({ noRestart: true });
    await rebooted.clearStaleUpdating({ warn });
    expect(syncCaddy).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("sem deploy interrompido o boot não toca no Caddy; falha ao limpar só avisa", async () => {
    const warn = vi.fn();
    await svc.clearStaleUpdating({ warn });
    expect(syncCaddy).not.toHaveBeenCalled();
    const p = await project();
    await writeFile(path.join(dataDir, "deploy-jobs.json"), JSON.stringify({ jobs: [runningJob(p.id)] }));
    const rebooted = build();
    syncCaddy.mockRejectedValueOnce(new Error("sem docker"));
    await rebooted.clearStaleUpdating({ warn });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("sem docker"));
  });

  it("startPanelRoute sem site do painel (túnel) também limpa", async () => {
    const p = await project();
    await writeFile(path.join(dataDir, "deploy-jobs.json"), JSON.stringify({ jobs: [runningJob(p.id)] }));
    const rebooted = build();
    syncCaddy.mockClear();
    rebooted.startPanelRoute({ info: () => undefined, warn: () => undefined });
    await vi.waitFor(() => expect(syncCaddy).toHaveBeenCalledTimes(1));
  });
});

describe("acomodação depois do deploy (monitoramento)", () => {
  it("durante o job e por 2 min depois conta como 'deploying'; passado o prazo, volta ao normal", async () => {
    const p = await project();
    const job = await svc.startDeploy(p.id);
    await vi.waitFor(async () => expect((await svc.getJob(p.id, job.id))?.finishedAt).toBeTruthy());
    expect(svc.intentOf(p.slug)).toBe("deploying");
    const fim = Date.parse((await svc.getJob(p.id, job.id))!.finishedAt!);
    vi.useFakeTimers();
    vi.setSystemTime(fim + DEPLOY_SETTLE_MS - 1000);
    expect(svc.intentOf(p.slug)).toBe("deploying");
    vi.setSystemTime(fim + DEPLOY_SETTLE_MS + 1000);
    expect(svc.intentOf(p.slug)).toBeNull();
  });

  it("deploy que falhou também acomoda; depois disso o monitoramento volta a valer", async () => {
    const p = await project();
    engineDeploy.mockRejectedValueOnce(new Error("x"));
    const job = await svc.startDeploy(p.id);
    await vi.waitFor(async () => expect((await svc.getJob(p.id, job.id))?.finishedAt).toBeTruthy());
    expect(svc.intentOf(p.slug)).toBe("deploying");
    const fim = Date.parse((await svc.getJob(p.id, job.id))!.finishedAt!);
    vi.useFakeTimers();
    vi.setSystemTime(fim + DEPLOY_SETTLE_MS + 1000);
    expect(svc.intentOf(p.slug)).toBeNull();
  });

  it("reservado (entre o clique e o job) já aparece como deploying, mesmo com o Docker lento", async () => {
    const p = await project();
    (svc as unknown as { starting: Set<string> }).starting.add(p.id);
    expect((await svc.statusOf((await svc.getProject(p.id))!, [])).status).toBe("deploying");
    (svc as unknown as { listContainers: () => Promise<never> }).listContainers = async () => {
      throw new Error("docker lento");
    };
    expect(await svc.statusOf((await svc.getProject(p.id))!)).toEqual({ status: "deploying", containers: [] });
  });
});

describe("painel reiniciando: nunca inventa 'parado' sem ler o Docker", () => {
  it("sem Docker e sem deploy, statusOf falha (a tela mostra 'indisponível'), não 'stopped'", async () => {
    const p = await project();
    (svc as unknown as { listContainers: () => Promise<never> }).listContainers = async () => {
      throw new Error("docker fora");
    };
    await expect(svc.statusOf((await svc.getProject(p.id))!)).rejects.toThrow("docker fora");
  });
});
