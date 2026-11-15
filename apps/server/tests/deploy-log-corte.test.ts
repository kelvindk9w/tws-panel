/**
 * deploy-log-corte.test.ts — um deploy que escreve mais log do que o limite guarda (build longo sem cache): o job fica
 * com o começo (etapas e guardrails), uma marca dizendo quanto saiu do meio e o fim (o erro final), também no arquivo
 * do histórico. As regras do corte em si estão em packages/core/tests/deploy-log.test.ts.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEPLOY_LOG_MAX_CHARS, parseDeployLogCut, type DeployJob } from "@paas/core";
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
});
