/**
 * Atualização/reinício do painel no meio de um deploy:
 *  - no boot, o job que estava rodando é marcado como interrompido, com o texto verdadeiro sobre o site;
 *  - Next.js: o container anterior (guardado parado) é religado e o proxy volta para a porta dele;
 *  - Dockerfile/estático: nada a religar — o job e a notificação dizem que o site está fora e que é preciso refazer;
 *  - uma só cadeia de novas tentativas do proxy (nova falha reinicia a contagem; sucesso e desligamento limpam).
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { DEPLOY_INTERRUPTED_MESSAGE, DeployService } from "../src/services/deploy-service.js";
import { deployNotification, failedDeployOutcome, type DeployFinished } from "../src/services/notification-sources.js";
import { removeDir } from "./helpers/tmp.js";

let dataDir: string;
let finished: DeployFinished[];
let syncCaddy: ReturnType<typeof vi.fn>;
let recover: ReturnType<typeof vi.fn>;

type Engine = Record<string, unknown>;
const engineOf = (s: DeployService) => (s as unknown as { engine: Engine }).engine;

function build(): DeployService {
  const s = new DeployService(
    { dataDir, projectsDir: path.join(dataDir, "projects"), caddyHttpPort: 80, caddyHttpsPort: 443, panelDomain: null, port: 9000 } as unknown as ServerConfig,
    { audit: { record: vi.fn(async () => ({})) } as never, onDeployFinished: (e) => void finished.push(e as DeployFinished) },
  );
  const engine = engineOf(s);
  engine.syncCaddy = syncCaddy;
  engine.recoverInterruptedDeploy = recover;
  return s;
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-interrompido-"));
  finished = [];
  syncCaddy = vi.fn(async () => undefined);
  recover = vi.fn(async () => ({ outcome: "skipped" }));
});
afterEach(async () => {
  vi.useRealTimers();
  await removeDir(dataDir);
});

const runningJob = (projectId: string, id = "j1") => ({ id, projectId, status: "running", createdAt: "x", startedAt: "x", finishedAt: null, steps: [], log: "início\n", error: null });

/** Cria o projeto, grava um job "running" no disco e devolve um serviço novo (o painel que acabou de reiniciar). */
async function reboot(type: string, published = true, domain = "loja.localhost") {
  const svc = build();
  const p = await svc.createProject({ name: "loja", ingestMode: "git", source: "https://github.com/k/loja", branch: "main", domain });
  const stored = (await svc.getProject(p.id))!;
  stored.detection = { type, warnings: [], details: [] } as never;
  if (published) stored.lastDeployStatus = "success";
  await (svc as unknown as { saveProjects: () => Promise<void> }).saveProjects();
  await writeFile(path.join(dataDir, "deploy-jobs.json"), JSON.stringify({ jobs: [runningJob(p.id)] }));
  syncCaddy.mockClear();
  return { id: p.id, svc: build() };
}

describe("recoverInterruptedDeploys", () => {
  it("Next.js: anterior religado — job explica, porta volta, proxy é reaplicado e a notificação diz a verdade", async () => {
    const { id, svc } = await reboot("node-server");
    recover.mockResolvedValue({ outcome: "restored", port: 3100 });
    const warn = vi.fn();
    await svc.recoverInterruptedDeploys({ warn });
    const [job] = await svc.listJobs(id);
    expect(job!.status).toBe("failed");
    expect(job!.error).toMatch(/versão anterior foi religada/);
    expect(job!.log).toMatch(/Deploy interrompido pela atualização do painel/);
    expect((await svc.getProject(id))!.servingPort).toBe(3100);
    expect((await svc.getProject(id))!.lastDeployStatus).toBe("failed");
    expect(syncCaddy).toHaveBeenCalledTimes(1);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ status: "failed", projectType: "node-server", previousRestored: true, interrupted: "restored" });
    const n = deployNotification(finished[0]!)!;
    expect(n.body?.[0]).toMatch(/interrompido pela atualização do painel.*versão anterior foi religada/);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("versão anterior religada"));
  });

  it("Dockerfile: sem anterior — job e notificação dizem que o site está fora e que é preciso refazer o deploy", async () => {
    const { id, svc } = await reboot("dockerfile");
    recover.mockResolvedValue({ outcome: "down" });
    await svc.recoverInterruptedDeploys({ warn: vi.fn() });
    const [job] = await svc.listJobs(id);
    expect(job!.error).toMatch(/fora do ar.*Faça o deploy de novo/);
    expect(job!.log).toContain("fora do ar");
    expect((await svc.getProject(id))!.servingPort).toBeUndefined();
    expect(finished[0]).toMatchObject({ status: "failed", previousRestored: false, interrupted: "down" });
    const n = deployNotification(finished[0]!)!;
    expect(n.title).toBe("Deploy de loja falhou");
    expect(n.body?.[0]).toMatch(/interrompido pela atualização do painel.*fora do ar.*deploy de novo/);
    expect(n.key).toBe(`deploy-failed:${id}`);
  });

  it("nada conferido (compose, container rodando, Docker indisponível): mensagem padrão, sem afirmar o estado do site", async () => {
    const { id, svc } = await reboot("compose");
    recover.mockResolvedValue({ outcome: "skipped" });
    await svc.recoverInterruptedDeploys({ warn: vi.fn() });
    const [job] = await svc.listJobs(id);
    expect(job!.error).toBe(DEPLOY_INTERRUPTED_MESSAGE);
    expect(finished[0]).toMatchObject({ interrupted: "unknown" });
    expect(deployNotification(finished[0]!)!.body?.[0]).toMatch(/interrompido pela atualização do painel/);

    const outra = await reboot("dockerfile", true, "outra.localhost");
    recover.mockRejectedValue(new Error("docker fora"));
    const warn = vi.fn();
    await outra.svc.recoverInterruptedDeploys({ warn });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("docker fora"));
    expect((await outra.svc.listJobs(outra.id))[0]!.error).toBe(DEPLOY_INTERRUPTED_MESSAGE);
  });

  it("sem job interrompido não toca em Docker, Caddy nem notificação; só roda uma vez", async () => {
    const svc = build();
    await svc.recoverInterruptedDeploys({ warn: vi.fn() });
    expect(recover).not.toHaveBeenCalled();
    expect(syncCaddy).not.toHaveBeenCalled();
    expect(finished).toHaveLength(0);

    const r = await reboot("dockerfile", true, "r.localhost");
    recover.mockResolvedValue({ outcome: "down" });
    await r.svc.recoverInterruptedDeploys({ warn: vi.fn() });
    await r.svc.recoverInterruptedDeploys({ warn: vi.fn() });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(finished).toHaveLength(1);
  });

  it("projeto removido depois do job: ignora; quem escuta a notificação e falha não derruba o boot", async () => {
    const r = await reboot("dockerfile", true, "r2.localhost");
    await writeFile(path.join(dataDir, "deploy-jobs.json"), JSON.stringify({ jobs: [runningJob("nao-existe", "j9")] }));
    const svc = build();
    await svc.recoverInterruptedDeploys({ warn: vi.fn() });
    expect(recover).not.toHaveBeenCalled();
    expect(r.id).toBeTruthy();

    const com = await reboot("dockerfile", true, "com.localhost");
    (com.svc as unknown as { hooks: { onDeployFinished: () => void } }).hooks.onDeployFinished = () => {
      throw new Error("boom");
    };
    recover.mockResolvedValue({ outcome: "down" });
    await expect(com.svc.recoverInterruptedDeploys({ warn: vi.fn() })).resolves.toBeUndefined();
  });

  it("estado ilegível (lista de projetos corrompida): só avisa", async () => {
    await writeFile(path.join(dataDir, "projects.json"), "{corrompido");
    const svc = build();
    const warn = vi.fn();
    await svc.recoverInterruptedDeploys({ warn });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("não consegui ler os projetos"));
  });

  it("falha ao gravar o estado e ao reaplicar o proxy só vira aviso/nova tentativa", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { svc } = await reboot("dockerfile");
    recover.mockResolvedValue({ outcome: "down" });
    (svc as unknown as { saveJobs: () => Promise<void> }).saveJobs = async () => {
      throw new Error("disco cheio");
    };
    syncCaddy.mockRejectedValue(new Error("caddy fora"));
    const warn = vi.fn();
    (svc as unknown as { logger: { warn: typeof warn } }).logger = { warn };
    const base = vi.getTimerCount();
    await svc.recoverInterruptedDeploys({ warn });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("disco cheio"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("caddy fora"));
    expect(vi.getTimerCount()).toBe(base + 1);
    svc.dispose();
  });
});

describe("texto da notificação de deploy interrompido", () => {
  it("cada situação diz o que de fato aconteceu com o site", () => {
    expect(failedDeployOutcome({ interrupted: "restored" })).toMatch(/versão anterior foi religada/);
    expect(failedDeployOutcome({ interrupted: "down" })).toMatch(/fora do ar/);
    expect(failedDeployOutcome({ interrupted: "unknown" })).toMatch(/Confira o endereço/);
  });
});

describe("cadeia única de novas tentativas do proxy", () => {
  const retry = (s: DeployService) => (s as unknown as { retryProxy: () => void }).retryProxy();

  it("falhas repetidas não abrem cadeias paralelas: um temporizador, uma tentativa por vez", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const svc = build();
    syncCaddy.mockRejectedValue(new Error("reload falhou"));
    (svc as unknown as { logger: { warn: () => void } }).logger = { warn: () => undefined };
    const base = vi.getTimerCount();
    retry(svc);
    retry(svc);
    retry(svc);
    expect(vi.getTimerCount()).toBe(base + 1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(syncCaddy).toHaveBeenCalledTimes(1);
    // nova falha no meio da cadeia: recomeça a contagem (5 s de novo), sem duplicar
    retry(svc);
    expect(vi.getTimerCount()).toBe(base + 1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(syncCaddy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(syncCaddy).toHaveBeenCalledTimes(4);
    // esgotou: nada pendente
    await vi.advanceTimersByTimeAsync(120_000);
    expect(syncCaddy).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(base);
  });

  it("sucesso encerra a cadeia", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const svc = build();
    (svc as unknown as { logger: { warn: () => void } }).logger = { warn: () => undefined };
    syncCaddy.mockRejectedValueOnce(new Error("x")).mockResolvedValue(undefined);
    const base = vi.getTimerCount();
    retry(svc);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(syncCaddy).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(base);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(syncCaddy).toHaveBeenCalledTimes(2);
  });

  it("outro ajuste do proxy que dá certo limpa a cadeia pendente; dispose também", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const svc = build();
    const base = vi.getTimerCount();
    retry(svc);
    expect(vi.getTimerCount()).toBe(base + 1);
    await (svc as unknown as { applyProxy: () => Promise<boolean> }).applyProxy();
    expect(vi.getTimerCount()).toBe(base);
    retry(svc);
    expect(vi.getTimerCount()).toBe(base + 1);
    svc.dispose();
    expect(vi.getTimerCount()).toBe(base);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(syncCaddy).toHaveBeenCalledTimes(1);
  });

  it("reload recusado pelo Caddy vai para o log do servidor como aviso", async () => {
    const svc = build();
    const warn = vi.fn();
    (svc as unknown as { logger: { warn: typeof warn } }).logger = { warn };
    syncCaddy.mockRejectedValue(new Error("o Caddy recusou a nova configuração; o proxy segue com a anterior (erro de sintaxe)"));
    expect(await (svc as unknown as { applyProxy: () => Promise<boolean> }).applyProxy()).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("o Caddy recusou a nova configuração"));
  });
});
