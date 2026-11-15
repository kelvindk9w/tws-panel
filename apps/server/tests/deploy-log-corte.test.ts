/**
 * deploy-log-corte.test.ts — um deploy que escreve mais log do que o limite guarda (build longo sem cache): o job fica
 * com o começo (etapas e guardrails), uma marca dizendo quanto saiu do meio e o fim (o erro final), também no arquivo
 * do histórico; o mesmo no reinício com a configuração atual e na recuperação de um deploy interrompido (log relido do
 * disco). As regras do corte em si estão em packages/core/tests/deploy-log.test.ts.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendDeployLog, DEPLOY_LOG_MAX_CHARS, deployLogCutMarker, parseDeployLogCut, type DeployJob } from "@paas/core";
import type { ServerConfig } from "../src/config.js";
import { DeployService } from "../src/services/deploy-service.js";
import { removeDir } from "./helpers/tmp.js";

let dataDir: string;
let svc: DeployService;
type Log = (chunk: string) => void;
let engineDeploy: (project: unknown, all: unknown, log: Log) => Promise<void>;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-deploy-log-corte-"));
  svc = new DeployService(
    { dataDir, projectsDir: path.join(dataDir, "projects"), caddyHttpPort: 80, caddyHttpsPort: 443, panelDomain: null, port: 9000 } as unknown as ServerConfig,
    { audit: { record: vi.fn(async () => ({})) } as never },
  );
  const engine = (svc as unknown as { engine: Record<string, unknown> }).engine;
  Object.assign(engine, {
    deploy: (p: unknown, all: unknown, log: Log) => engineDeploy(p, all, log),
    pinServingPort: async () => undefined,
    settleAbandonedSwap: async () => "clean",
  });
  (svc as unknown as { applyProxy: () => Promise<void> }).applyProxy = async () => undefined;
});

afterEach(async () => {
  await svc.idle();
  await removeDir(dataDir);
});

async function project() {
  const p = await svc.createProject({ name: "loja", ingestMode: "git", source: "https://github.com/k/loja", branch: "main", domain: "loja.localhost" });
  (await svc.getProject(p.id))!.detection = { type: "static", warnings: [], details: [] } as never;
  return p;
}

const START = "=== Etapa 1/5 · Ingestão do código ===\nDetectado: Laravel (PHP 8.3)\n=== Etapa 2/5 · Preparação ===\nGuardrails: nenhum bloqueio\n";

describe("log do deploy acima do limite", () => {
  it("guarda o começo e o fim, com a marca do que saiu, e as etapas seguem o log inteiro", async () => {
    const p = await project();
    let written = START;
    engineDeploy = async (_p, _a, log) => {
      log(START);
      log("=== Etapa 3/5 · Build e subida ===\n");
      written += "=== Etapa 3/5 · Build e subida ===\n";
      // build sem cache: ~1 MB de saída, em pedaços que cortam linhas ao meio
      const build = Array.from({ length: 25_000 }, (_, i) => `#12 ${i} compilando extensão do PHP: ação ✓\n`).join("");
      for (let i = 0; i < build.length; i += 3_000) log(build.slice(i, i + 3_000));
      written += build;
      log("ERROR: failed to solve: exit code 2\n");
      throw new Error("build da imagem falhou");
    };
    const started = await svc.startDeploy(p.id);
    await svc.idle();
    const job = (await svc.getJob(p.id, started.id))!;

    expect(job.status).toBe("failed");
    expect(job.log.length).toBeLessThanOrEqual(DEPLOY_LOG_MAX_CHARS);
    expect(job.log.startsWith(START + "=== Etapa 3/5")).toBe(true);
    expect(job.log.endsWith("ERROR: failed to solve: exit code 2\n\n✖ Deploy falhou: build da imagem falhou\n")).toBe(true);
    const cut = parseDeployLogCut(job.log)!;
    expect(cut).not.toBeNull();
    const total = written.length + "ERROR: failed to solve: exit code 2\n".length + "\n✖ Deploy falhou: build da imagem falhou\n".length;
    expect(cut.head.length + cut.omittedChars + cut.tail.length).toBe(total);
    expect(cut.omittedLines).toBeGreaterThan(10_000);
    // a etapa 3 começou e falhou: o marcador dela estava no começo guardado
    expect(job.steps[2]!.status).toBe("failed");

    // o histórico em disco tem o mesmo log cortado
    const saved = JSON.parse(await readFile(path.join(dataDir, "deploy-jobs.json"), "utf8")) as { jobs: DeployJob[] };
    expect(saved.jobs.find((j) => j.id === job.id)!.log).toBe(job.log);
  });

  it("log que cabe no limite fica intacto, sem marca", async () => {
    const p = await project();
    engineDeploy = async (_p, _a, log) => {
      log(START);
      log("pronto\n");
    };
    const started = await svc.startDeploy(p.id);
    await svc.idle();
    const job = (await svc.getJob(p.id, started.id))!;
    expect(job.status).toBe("success");
    expect(job.log).toContain(START + "pronto\n");
    expect(parseDeployLogCut(job.log)).toBeNull();
  });

  it("frase igual à marca escrita pelo build no começo: o log do job não se confunde", async () => {
    const p = await project();
    const fake = deployLogCutMarker(999_999, 9).slice(1);
    let written = "";
    engineDeploy = async (_p, _a, log) => {
      const out = START + "\n" + fake + Array.from({ length: 25_000 }, (_, i) => `#12 ${i} compilando\n`).join("");
      for (let i = 0; i < out.length; i += 2_000) log(out.slice(i, i + 2_000));
      written = out;
    };
    const started = await svc.startDeploy(p.id);
    await svc.idle();
    const job = (await svc.getJob(p.id, started.id))!;
    // o começo guardado vai até perto do teto do começo e contém a frase do build; a marca de verdade vem depois
    const head = written.slice(0, written.lastIndexOf("\n", 100_000 - 1) + 1);
    expect(job.log.startsWith(head)).toBe(true);
    const rest = job.log.slice(head.length);
    expect(rest).toMatch(/^\n\[… log cortado no meio: \d+ caracteres/);
    expect(job.log.split("log cortado no meio").length - 1).toBe(2); // a frase do build e a marca
  });
});

describe("reinício com a configuração atual", () => {
  it("log longo do reinício também guarda o começo e o fim", async () => {
    const p = await project();
    (await svc.getProject(p.id))!.lastDeployStatus = "success";
    Object.assign((svc as unknown as { engine: Record<string, unknown> }).engine, {
      recreate: async (_p: unknown, log: Log) => {
        for (let i = 0; i < 30_000; i++) log(`recriando ${i}\n`);
        log("Containers recriados.\n");
      },
      syncCaddy: async () => undefined,
    });
    const started = await svc.startRecreate(p.id);
    await svc.idle();
    const job = (await svc.getJob(p.id, started.id))!;
    expect(job.status).toBe("success");
    expect(job.log.startsWith("=== Reinício com a configuração atual")).toBe(true);
    expect(job.log).toContain("recriando 0\n");
    expect(job.log.endsWith("Containers recriados.\n")).toBe(true);
    expect(job.log.length).toBeLessThanOrEqual(DEPLOY_LOG_MAX_CHARS);
    expect(parseDeployLogCut(job.log)!.omittedLines).toBeGreaterThan(1_000);
  });
});

describe("deploy interrompido, relido do disco depois de um reinício do painel", () => {
  it("o log já cortado continua do mesmo jeito: mesmo começo, contadores somando, mensagem final no fim", async () => {
    const p = await project();
    const original = START + Array.from({ length: 30_000 }, (_, i) => `#12 ${i} compilando\n`).join("");
    const cutLog = appendDeployLog("", original);
    const before = parseDeployLogCut(cutLog)!;
    const job = { id: "j1", projectId: p.id, status: "running", createdAt: "x", startedAt: "x", finishedAt: null, steps: [], log: cutLog, error: null };
    await writeFile(path.join(dataDir, "deploy-jobs.json"), JSON.stringify({ jobs: [job] }));
    const extra = Array.from({ length: 2_000 }, (_, i) => `conferindo ${i}\n`).join("");
    const rebooted = new DeployService(
      { dataDir, projectsDir: path.join(dataDir, "projects"), caddyHttpPort: 80, caddyHttpsPort: 443, panelDomain: null, port: 9000 } as unknown as ServerConfig,
      { audit: { record: vi.fn(async () => ({})) } as never },
    );
    Object.assign((rebooted as unknown as { engine: Record<string, unknown> }).engine, {
      recoverInterruptedDeploy: async (_p: unknown, note: Log) => {
        note(extra);
        return { outcome: "down" };
      },
      settleAbandonedSwap: async () => "clean",
      syncCaddy: async () => undefined,
    });
    await rebooted.recoverInterruptedDeploys({ warn: vi.fn() });
    const [after] = await rebooted.listJobs(p.id);
    expect(after!.status).toBe("failed");
    const cut = parseDeployLogCut(after!.log)!;
    expect(cut.head).toBe(before.head);
    expect(cut.omittedChars).toBeGreaterThan(before.omittedChars);
    expect(after!.log.length).toBeLessThanOrEqual(DEPLOY_LOG_MAX_CHARS);
    expect(after!.log).toContain("conferindo 1999\n");
    expect(after!.log).toMatch(/fora do ar/);
  });
});

