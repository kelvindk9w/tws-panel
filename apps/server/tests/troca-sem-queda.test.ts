/**
 * Troca sem queda no servidor: ajuste por projeto, fases no job, recuperação no boot e avisos verdadeiros.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zeroDowntimeEnabled, type DeployJob, type Project } from "@paas/core";
import type { ServerConfig } from "../src/config.js";
import { DeployService, swapHealthTimeout } from "../src/services/deploy-service.js";
import { deployNotification, failedDeployOutcome, type DeployFinished } from "../src/services/notification-sources.js";
import { removeDir } from "./helpers/tmp.js";

type Engine = Record<string, unknown>;
const engineOf = (s: DeployService) => (s as unknown as { engine: Engine }).engine;

let dataDir: string;
let finished: DeployFinished[];
let engineDeploy: ReturnType<typeof vi.fn>;
let recover: ReturnType<typeof vi.fn>;
let restored = false;

function build(): DeployService {
  // cada serviço grava no array do SEU teste: um job que sobrou de outro teste não contamina o seguinte
  const sink = finished;
  const s = new DeployService(
    { dataDir, projectsDir: path.join(dataDir, "projects"), caddyHttpPort: 80, caddyHttpsPort: 443, panelDomain: null, port: 9000 } as unknown as ServerConfig,
    { audit: { record: vi.fn(async () => ({})) } as never, onDeployFinished: (e) => void sink.push(e as DeployFinished) },
  );
  const engine = engineOf(s);
  engine.syncCaddy = vi.fn(async () => undefined);
  engine.deploy = engineDeploy;
  engine.recoverInterruptedDeploy = recover;
  engine.takeRestored = () => restored;
  (s as unknown as { takeMailSnapshot: () => Promise<void> }).takeMailSnapshot = async () => undefined;
  return s;
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-troca-"));
  finished = [];
  restored = false;
  engineDeploy = vi.fn(async () => undefined);
  recover = vi.fn(async () => ({ outcome: "skipped" }));
});
afterEach(async () => {
  await removeDir(dataDir);
});

async function project(svc: DeployService, type: string) {
  const p = await svc.createProject({ name: "loja", ingestMode: "git", source: "https://github.com/k/loja", branch: "main", domain: "loja.localhost" });
  const stored = (await svc.getProject(p.id))!;
  stored.detection = { type, warnings: [], details: [] } as never;
  stored.lastDeployStatus = "success";
  return stored;
}

describe("padrão por tipo (zeroDowntimeEnabled)", () => {
  const of = (type: string | null, zeroDowntime?: boolean) => zeroDowntimeEnabled({ detection: type ? ({ type } as never) : null, ...(zeroDowntime === undefined ? {} : { zeroDowntime }) });
  it("ligado para Next.js e estáticos, desligado para Dockerfile; compose e sem tipo nunca", () => {
    expect(of("node-server")).toBe(true);
    expect(of("static")).toBe(true);
    expect(of("static-node")).toBe(true);
    expect(of("dockerfile")).toBe(false);
    expect(of("compose")).toBe(false);
    expect(of(null)).toBe(false);
  });
  it("a escolha da pessoa vale; compose ignora o ajuste", () => {
    expect(of("node-server", false)).toBe(false);
    expect(of("dockerfile", true)).toBe(true);
    expect(of("compose", true)).toBe(false);
  });
});

describe("PAAS_SWAP_HEALTH_TIMEOUT", () => {
  it("segundos válidos viram ms; ausente ou fora de 10..900 usa o padrão do engine", () => {
    expect(swapHealthTimeout("120")).toEqual({ swapHealthTimeoutMs: 120_000 });
    expect(swapHealthTimeout(undefined)).toEqual({});
    expect(swapHealthTimeout("5")).toEqual({});
    expect(swapHealthTimeout("901")).toEqual({});
    expect(swapHealthTimeout("abc")).toEqual({});
    expect(swapHealthTimeout("30.5")).toEqual({});
  });
});

describe("ajuste por projeto", () => {
  it("PATCH zeroDowntime liga e desliga", async () => {
    const svc = build();
    const p = await project(svc, "node-server");
    expect((await svc.updateProject(p.id, { zeroDowntime: false })).zeroDowntime).toBe(false);
    expect((await svc.updateProject(p.id, { zeroDowntime: true })).zeroDowntime).toBe(true);
  });
});

describe("fases no job", () => {
  it("o log da troca vira fases (a atual em andamento, as anteriores concluídas) e terminam com o deploy", async () => {
    const svc = build();
    const p = await project(svc, "node-server");
    let during: Project["detection"] | unknown = null;
    engineDeploy.mockImplementationOnce(async (_p: unknown, _all: unknown, log: (c: string) => void) => {
      log("\n=== Etapa 3/5 · Next.js ===\n");
      log("\n=== Troca sem queda · fase 1/4 · Subindo nova versão ===\n");
      log("\n=== Troca sem queda · fase 2/4 · Verificando saúde ===\n");
      during = (await svc.listJobs(p.id))[0]!.phases?.map((s) => `${s.name}:${s.status}`);
    });
    const job = await svc.startDeploy(p.id);
    await svc.idle();
    expect(during).toEqual(["Subindo nova versão:done", "Verificando saúde:running", "Trocando tráfego:skipped", "Desligando versão anterior:skipped"]);
    const done = (await svc.getJob(p.id, job.id))!;
    expect(done.phases?.map((s) => s.status)).toEqual(["done", "done", "skipped", "skipped"]);
    expect(done.phases![0]!.startedAt).toBeDefined();
    expect(finished).toHaveLength(1);
  });

  it("o job só consta como concluído junto com o fechamento das fases e do horário de fim", async () => {
    const svc = build();
    const p = await project(svc, "node-server");
    engineDeploy.mockImplementationOnce(async (_p: unknown, _all: unknown, log: (c: string) => void) => {
      log("\n=== Troca sem queda · fase 2/4 · Verificando saúde ===\n");
    });
    // o passo depois do engine (aqui, o e-mail aplicado) fica preso: o job ainda não pode constar como concluído
    let release: () => void = () => undefined;
    let reached: () => void = () => undefined;
    const atMail = new Promise<void>((resolve) => (reached = resolve));
    (svc as unknown as { markMailApplied: () => Promise<void> }).markMailApplied = () => {
      reached();
      return new Promise<void>((resolve) => (release = resolve));
    };
    const job = await svc.startDeploy(p.id);
    await atMail;
    const mid = (await svc.getJob(p.id, job.id))!;
    expect(mid.status).toBe("running");
    expect(mid.finishedAt).toBeFalsy();
    expect(mid.phases?.map((s) => s.status)).toEqual(["done", "running", "skipped", "skipped"]);
    release();
    await svc.idle();
    const done = (await svc.getJob(p.id, job.id))!;
    expect(done.status).toBe("success");
    expect(done.finishedAt).toBeTruthy();
    expect(done.phases?.map((s) => s.status)).toEqual(["done", "done", "skipped", "skipped"]);
  });

  it("reinício: o job só consta como concluído depois de desligar o aviso, junto com o fim e as etapas fechadas", async () => {
    const svc = build();
    const p = await project(svc, "node-server");
    engineOf(svc).recreate = vi.fn(async () => undefined);
    const engine = engineOf(svc) as { setUpdating: (id: string, on: boolean) => boolean };
    const real = engine.setUpdating.bind(engine);
    const vistoAoDesligar: { status: string; finishedAt: string | null; steps: string[] }[] = [];
    engine.setUpdating = (id, on) => {
      const j = (svc as unknown as { jobs: DeployJob[] }).jobs[0]!;
      if (!on) vistoAoDesligar.push({ status: j.status, finishedAt: j.finishedAt, steps: j.steps.map((s) => s.status) });
      return real(id, on);
    };
    const job = await svc.startRecreate(p.id);
    await svc.idle();
    expect(vistoAoDesligar).toEqual([{ status: "running", finishedAt: null, steps: ["running"] }]);
    const done = (await svc.getJob(p.id, job.id))!;
    expect(done.status).toBe("success");
    expect(done.finishedAt).toBeTruthy();
    expect(done.steps.map((s) => s.status)).toEqual(["done"]);
  });

  it("falha na fase 2: a fase fica como falha e as seguintes não rodaram; a notificação segue verdadeira", async () => {
    const svc = build();
    const p = await project(svc, "node-server");
    restored = true; // a troca foi desfeita e a anterior segue no ar
    engineDeploy.mockImplementationOnce(async (_p: unknown, _all: unknown, log: (c: string) => void) => {
      log("\n=== Troca sem queda · fase 2/4 · Verificando saúde ===\n");
      throw new Error("a nova versão não ficou saudável; a versão anterior segue no ar");
    });
    const job = await svc.startDeploy(p.id);
    await svc.idle();
    const done = (await svc.getJob(p.id, job.id))!;
    expect(done.phases?.map((s) => s.status)).toEqual(["done", "failed", "skipped", "skipped"]);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ status: "failed", previousRestored: true });
    const body = deployNotification(finished[0]!)!.body?.join(" ");
    expect(body).toContain("versão anterior");
    expect(body).not.toContain("fora do ar");
  });

  it("deploy sem troca não ganha fases", async () => {
    const svc = build();
    const p = await project(svc, "static");
    const job = await svc.startDeploy(p.id);
    await svc.idle();
    expect((await svc.getJob(p.id, job.id))!.phases).toBeUndefined();
    expect(finished).toHaveLength(1);
  });
});

describe("porta do container no ar antes do aviso Atualizando", () => {
  it("pinServingPort roda ANTES de ligar o aviso (que regrava o Caddyfile)", async () => {
    const svc = build();
    const p = await project(svc, "node-server");
    const order: string[] = [];
    const engine = engineOf(svc) as { pinServingPort: (p: unknown) => Promise<void>; setUpdating: (id: string, on: boolean) => boolean };
    engine.pinServingPort = async () => void order.push("pin");
    const real = engine.setUpdating.bind(engine);
    engine.setUpdating = (id, on) => {
      order.push(`updating:${on}`);
      return real(id, on);
    };
    const job = await svc.startDeploy(p.id);
    await svc.idle();
    expect(order.slice(0, 2)).toEqual(["pin", "updating:true"]);
    expect(finished).toHaveLength(1);
  });
});

describe("sobra de uma troca que não conseguiu desfazer", () => {
  it("no deploy: resolvida depois de pinServingPort e ANTES do aviso; recusa do Caddy falha o deploy sem tocar no engine.deploy", async () => {
    const svc = build();
    const p = await project(svc, "node-server");
    const order: string[] = [];
    const engine = engineOf(svc) as { settleAbandonedSwap: unknown; pinServingPort: unknown; setUpdating: (id: string, on: boolean) => boolean };
    engine.pinServingPort = async () => void order.push("pin");
    engine.settleAbandonedSwap = vi.fn(async () => {
      order.push("settle");
      return "refused";
    });
    const real = engine.setUpdating.bind(engine);
    engine.setUpdating = (id, on) => {
      order.push(`updating:${on}`);
      return real(id, on);
    };
    const job = await svc.startDeploy(p.id);
    await svc.idle();
    expect((await svc.getJob(p.id, job.id))!.error).toMatch(/versão nova sobrando.*Nenhum container foi alterado/);
    expect(engineDeploy).not.toHaveBeenCalled();
    expect(order.slice(0, 2)).toEqual(["pin", "settle"]);
    expect(order).not.toContain("updating:true");
    expect(finished).toHaveLength(1);
  });

  it("no boot: atual parada e sobra rodando → o engine promove (e o log da promoção vai ao aviso); falha só avisa", async () => {
    const svc = build();
    await project(svc, "node-server");
    const settle = vi.fn(async (_p: unknown, _all: unknown, onLog: (c: string) => void) => {
      onLog("A versão nova (x-app-next) ficou no ar e a atual não está rodando: promovendo a nova, sem removê-la.\n");
      return "promoted";
    });
    (engineOf(svc) as { settleAbandonedSwap: unknown }).settleAbandonedSwap = settle;
    const warn = vi.fn();
    await svc.recoverInterruptedDeploys({ warn });
    expect(warn.mock.calls.join("\n")).toContain("promovendo a nova, sem removê-la");
    settle.mockResolvedValueOnce("failed");
    await expect(svc.recoverInterruptedDeploys({ warn: vi.fn() })).resolves.toBeUndefined();
  });

  it("no deploy: promoção que falhou (atual parada) falha o job sem rodar o engine.deploy; promovida segue", async () => {
    const svc = build();
    const p = await project(svc, "node-server");
    const settle = vi.fn(async () => "failed");
    (engineOf(svc) as { settleAbandonedSwap: unknown }).settleAbandonedSwap = settle;
    const job = await svc.startDeploy(p.id);
    await svc.idle();
    expect((await svc.getJob(p.id, job.id))!.error).toMatch(/não pôde ser promovida.*sem parar nem remover/);
    expect(engineDeploy).not.toHaveBeenCalled();
    expect(finished).toHaveLength(1);
    settle.mockResolvedValue("promoted");
    const again = await svc.startDeploy(p.id);
    await svc.idle();
    expect(engineDeploy).toHaveBeenCalledTimes(1);
  });

  it("no deploy: sobra resolvida ('cleared') segue para o deploy normal", async () => {
    const svc = build();
    const p = await project(svc, "node-server");
    (engineOf(svc) as { settleAbandonedSwap: unknown }).settleAbandonedSwap = vi.fn(async () => "cleared");
    const job = await svc.startDeploy(p.id);
    await svc.idle();
    expect(engineDeploy).toHaveBeenCalled();
    expect(finished).toHaveLength(1);
  });

  it("no boot, SEM deploy interrompido: confere cada projeto; recusa só avisa, erro do engine também", async () => {
    const svc = build();
    const p = await project(svc, "node-server");
    const settle = vi.fn(async (_p: unknown, _all: unknown, onLog: (c: string) => void) => {
      onLog("✖ O Caddy recusou a configuração (x): a sobra foi mantida como está.\n");
      return "refused";
    });
    (engineOf(svc) as { settleAbandonedSwap: unknown }).settleAbandonedSwap = settle;
    const warn = vi.fn();
    await svc.recoverInterruptedDeploys({ warn });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0]![0]).toMatchObject({ id: p.id });
    expect(warn.mock.calls.join("\n")).toMatch(/Troca sem queda de .*Caddy recusou/);
    expect(recover).not.toHaveBeenCalled();
    settle.mockRejectedValueOnce(new Error("docker fora"));
    const warn2 = vi.fn();
    await svc.recoverInterruptedDeploys({ warn: warn2 });
    expect(warn2.mock.calls.join("\n")).toMatch(/não consegui conferir sobras \(docker fora\)/);
  });
});

describe("parar, iniciar e remover durante um deploy", () => {
  it("recusam com 409 enquanto o job roda; depois que termina, funcionam", async () => {
    const svc = build();
    const p = await project(svc, "node-server");
    const stop = vi.fn(async () => undefined);
    const start = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    Object.assign(engineOf(svc), { stop, start, remove });
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const engineStarted = new Promise<void>((resolve) => (started = resolve));
    engineDeploy.mockImplementationOnce(() => {
      started();
      return new Promise<void>((resolve) => (release = resolve));
    });
    await svc.startDeploy(p.id);
    await engineStarted;
    for (const act of [() => svc.stop(p.id, () => undefined), () => svc.start(p.id, () => undefined), () => svc.deleteProject(p.id, false, () => undefined)]) {
      await expect(act()).rejects.toMatchObject({ statusCode: 409, code: "deploy_in_progress", message: expect.stringContaining("deploy em andamento") });
    }
    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    release();
    await svc.idle();
    expect(finished).toHaveLength(1);
    await svc.stop(p.id, () => undefined);
    expect(stop).toHaveBeenCalled();
  });
});

describe("avisos de deploy que falhou", () => {
  it("anterior segue (troca desfeita) em tipo que não é Next.js; Next.js mantém o texto de sempre", () => {
    expect(failedDeployOutcome({ projectType: "static", hadPublished: true, previousRestored: true })).toMatch(/troca sem queda foi desfeita/);
    expect(failedDeployOutcome({ projectType: "node-server", hadPublished: true, previousRestored: true })).toMatch(/foi religada/);
    expect(failedDeployOutcome({ interrupted: "promoted" })).toMatch(/versão nova já estava saudável e foi mantida/);
  });
});

describe("recoverInterruptedDeploys com a troca", () => {
  const runningJob = (projectId: string) => ({ id: "j1", projectId, status: "running", createdAt: "x", startedAt: "x", finishedAt: null, steps: [], log: "", error: null });

  async function reboot(type: string) {
    const svc = build();
    const p = await project(svc, type);
    p.servingPort = 3100;
    await (svc as unknown as { saveProjects: () => Promise<void> }).saveProjects();
    await writeFile(path.join(dataDir, "deploy-jobs.json"), JSON.stringify({ jobs: [runningJob(p.id)] }));
    return { id: p.id, svc: build() };
  }

  it("nova promovida: o job diz que a versão nova ficou no ar, servingPort sai e a notificação confere", async () => {
    const { id, svc } = await reboot("node-server");
    recover.mockResolvedValue({ outcome: "promoted" });
    const warn = vi.fn();
    await svc.recoverInterruptedDeploys({ warn });
    const job = (await svc.listJobs(id))[0]!;
    expect(job.error).toMatch(/versão nova já estava saudável e foi mantida no ar/);
    expect((await svc.getProject(id))!.servingPort).toBeUndefined();
    expect(finished[0]).toMatchObject({ status: "failed", interrupted: "promoted" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("versão nova mantida"));
  });

  it("anterior religada: Next.js grava a porta da versão antiga", async () => {
    const { id, svc } = await reboot("node-server");
    recover.mockResolvedValue({ outcome: "restored", port: 3200 });
    await svc.recoverInterruptedDeploys({ warn: vi.fn() });
    expect((await svc.getProject(id))!.servingPort).toBe(3200);
    expect(finished[0]).toMatchObject({ interrupted: "restored", previousRestored: true });
  });

  it("anterior religada num Dockerfile: servingPort (coisa do Next.js) não é gravado", async () => {
    const { id, svc } = await reboot("dockerfile");
    (await svc.getProject(id))!.servingPort = null;
    recover.mockResolvedValue({ outcome: "restored", port: 3000 });
    await svc.recoverInterruptedDeploys({ warn: vi.fn() });
    expect((await svc.getProject(id))!.servingPort ?? null).toBeNull();
    expect(finished[0]).toMatchObject({ interrupted: "restored" });
  });
});
