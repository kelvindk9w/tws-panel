/**
 * deploy-sugestoes-consumidas.test.ts — o primeiro deploy (com sucesso ou não) encerra a primeira vez das sugestões da
 * tela de Variáveis: a marca fica gravada e nada do .env.example volta como linha.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { DeployService } from "../src/services/deploy-service.js";
import type { DeployFinished } from "../src/services/notification-sources.js";
import { removeDir } from "./helpers/tmp.js";

let dataDir: string;
let finished: DeployFinished[];
let svc: DeployService;
let engineDeploy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-deploy-sug-"));
  finished = [];
  svc = new DeployService(
    { dataDir, projectsDir: path.join(dataDir, "projects"), caddyHttpPort: 80, caddyHttpsPort: 443, panelDomain: null, port: 9000 } as unknown as ServerConfig,
    {
      audit: { record: vi.fn(async () => ({})) } as never,
      onDeployFinished: (e) => void finished.push(e),
    },
  );
  engineDeploy = vi.fn(async () => undefined);
  (svc as unknown as { engine: { deploy: typeof engineDeploy } }).engine.deploy = engineDeploy;
  semDocker(svc);
  (svc as unknown as { applyProxy: () => Promise<void> }).applyProxy = async () => undefined;
});

afterEach(async () => {
  await svc.idle();
  await removeDir(dataDir);
});

/** Sem subprocesso (docker): a leitura da porta e a conferência de sobras são do engine e têm testes próprios. */
function semDocker(s: DeployService): void {
  Object.assign((s as unknown as { engine: object }).engine, { pinServingPort: async () => undefined, settleAbandonedSwap: async () => "clean" });
}

async function project() {
  const p = await svc.createProject({ name: "loja", ingestMode: "git", source: "https://github.com/k/loja", branch: "main", domain: "loja.localhost" });
  const stored = (await svc.getProject(p.id))!;
  stored.detection = { type: "static", warnings: [], details: [] } as never;
  return p;
}

describe("primeiro deploy e a marca das sugestões", () => {
  it("o deploy grava a marca ao começar, e ela fica depois de uma falha", async () => {
    const p = await project();
    expect(await svc.envSuggestionsConsumed(p.id)).toBe(false);
    engineDeploy.mockRejectedValueOnce(new Error("build quebrou"));
    await svc.startDeploy(p.id);
    await svc.idle();
    const stored = (await svc.getProject(p.id))!;
    expect(stored.envSuggestionsConsumedAt).toBeTruthy();
    expect(await svc.envSuggestionsConsumed(p.id)).toBe(true);
  });

  it("deploy com sucesso também", async () => {
    const p = await project();
    await svc.startDeploy(p.id);
    await svc.idle();
    expect((await svc.getProject(p.id))!.envSuggestionsConsumedAt).toBeTruthy();
    expect(await svc.envSuggestionsConsumed(p.id)).toBe(true);
  });
});
