/**
 * deploy-notify.test.ts — o DeployService avisa quem escuta (o serviço de
 * notificações, ligado em app.ts) quando um deploy termina, com o resultado
 * anterior: é assim que "falhou" e "voltou a funcionar" viram aviso.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { DeployService } from "../src/services/deploy-service.js";
import type { DeployFinished } from "../src/services/notification-sources.js";

let dataDir: string;
let finished: DeployFinished[];
let svc: DeployService;
let engineDeploy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-deploy-notify-"));
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
  (svc as unknown as { applyProxy: () => Promise<void> }).applyProxy = async () => undefined;
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function project() {
  const p = await svc.createProject({ name: "loja", ingestMode: "git", source: "https://github.com/k/loja", branch: "main", domain: "loja.localhost" });
  const stored = (await svc.getProject(p.id))!;
  stored.detection = { type: "static", warnings: [], details: [] } as never;
  return p;
}

describe("gancho onDeployFinished", () => {
  it("falha, depois sucesso: avisa os dois com o resultado anterior", async () => {
    const p = await project();
    engineDeploy.mockRejectedValueOnce(new Error("build quebrou"));
    await svc.startDeploy(p.id);
    await vi.waitFor(() => expect(finished).toHaveLength(1));
    expect(finished[0]).toEqual({ projectId: p.id, projectName: "loja", status: "failed", previousStatus: null });
    await svc.startDeploy(p.id);
    await vi.waitFor(() => expect(finished).toHaveLength(2));
    expect(finished[1]).toEqual({ projectId: p.id, projectName: "loja", status: "success", previousStatus: "failed" });
  });

  it("quem escuta e falha não muda o resultado do deploy", async () => {
    const log = vi.fn();
    const s = new DeployService(
      { dataDir, projectsDir: path.join(dataDir, "projects"), caddyHttpPort: 80, caddyHttpsPort: 443, panelDomain: null, port: 9000 } as unknown as ServerConfig,
      {
        onDeployFinished: () => {
          log();
          throw new Error("boom");
        },
      },
    );
    (s as unknown as { engine: { deploy: () => Promise<void> } }).engine.deploy = async () => undefined;
    (s as unknown as { applyProxy: () => Promise<void> }).applyProxy = async () => undefined;
    const p = await s.createProject({ name: "api", ingestMode: "git", source: "https://github.com/k/api", branch: "main", domain: "api.localhost" });
    (await s.getProject(p.id))!.detection = { type: "static", warnings: [], details: [] } as never;
    const job = await s.startDeploy(p.id);
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    await vi.waitFor(async () => expect((await s.getJob(p.id, job.id))?.status).toBe("success"));
  });
});
