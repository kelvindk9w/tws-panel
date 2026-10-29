/**
 * deploy-override-bloqueios-aceitos.test.ts — o override do deploy fica preso aos bloqueios que a pessoa viu
 * na tela: qualquer bloqueio novo na checagem do deploy é recusado (guardrail_changed) com a lista dos novos,
 * e o engine recebe a lista aceita para repetir a conferência depois da ingestão e sobre o compose resolvido.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guardrailBlockKey, type GuardrailReport } from "@paas/core";
import type { ServerConfig } from "../src/config.js";
import { DeployService } from "../src/services/deploy-service.js";
import { removeDir } from "./helpers/tmp.js";

let dataDir: string;
let srcDir: string;
let svc: DeployService;
let engineDeploy: ReturnType<typeof vi.fn>;
const audits: string[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-deploy-override-"));
  srcDir = path.join(dataDir, "projects", "minha-loja");
  await mkdir(srcDir, { recursive: true });
  await writeFile(path.join(srcDir, "compose.yml"), "services:\n  app:\n    image: app\n    privileged: true\n");
  audits.length = 0;
  svc = new DeployService(
    { dataDir, projectsDir: path.join(dataDir, "projects"), caddyHttpPort: 80, caddyHttpsPort: 443, panelDomain: null, port: 9000 } as unknown as ServerConfig,
    { audit: { record: vi.fn(async (e: { action: string }) => void audits.push(e.action)) } as never, alerts: { create: vi.fn(async () => ({})) } as never },
  );
  engineDeploy = vi.fn(async () => undefined);
  (svc as unknown as { engine: { deploy: typeof engineDeploy } }).engine.deploy = engineDeploy;
  (svc as unknown as { applyProxy: () => Promise<void> }).applyProxy = async () => undefined;
});

afterEach(async () => {
  await removeDir(dataDir);
});

async function project() {
  const p = await svc.createProject({ name: "loja", ingestMode: "existing", source: srcDir, domain: "loja.localhost" });
  const stored = (await svc.getProject(p.id))!;
  stored.detection = { type: "compose", composeFile: "compose.yml", warnings: [], details: [] } as never;
  return p;
}

async function blocks(id: string): Promise<string[]> {
  const { report } = await svc.guardrailsForProject(id);
  return (report as GuardrailReport).findings.filter((f) => f.level === "block").map(guardrailBlockKey);
}

describe("override preso aos bloqueios aceitos", () => {
  it("a lista cobre os bloqueios de agora: o deploy segue e o engine recebe a lista", async () => {
    const p = await project();
    const accepted = await blocks(p.id);
    expect(accepted.length).toBeGreaterThan(0);
    const job = await svc.startDeploy(p.id, { guardrailOverride: true, acceptedBlocks: accepted });
    await vi.waitFor(async () => expect((await svc.getJob(p.id, job.id))?.status).toBe("success"));
    expect(engineDeploy.mock.calls[0]![3]).toMatchObject({ guardrailOverride: true, acceptedBlocks: accepted });
    expect(audits).toContain("guardrail.override");
  });

  it("bloqueio que não está na lista: recusa com guardrail_changed, mostra os novos e não deploya", async () => {
    const p = await project();
    const [first] = await blocks(p.id);
    // a pessoa aceitou outra coisa (ou o código mudou depois): o bloqueio de agora é novo
    await expect(svc.startDeploy(p.id, { guardrailOverride: true, acceptedBlocks: ["porta-antiga|db|compose.yml: db publica 5432"] })).rejects.toMatchObject({
      statusCode: 409,
      code: "guardrail_changed",
      report: expect.objectContaining({ blockers: expect.any(Number) }),
    });
    await expect(svc.startDeploy(p.id, { guardrailOverride: true, acceptedBlocks: [] })).rejects.toThrow(/Novos: \[/);
    expect(engineDeploy).not.toHaveBeenCalled();
    expect(audits).not.toContain("guardrail.override");
    expect(first).toBeTruthy();
  });

  it("lista aceita só com parte dos bloqueios: os que faltam são os novos", async () => {
    await writeFile(path.join(srcDir, "compose.yml"), "services:\n  app:\n    image: app\n    privileged: true\n    pid: host\n");
    const p = await project();
    const all = await blocks(p.id);
    expect(all.length).toBeGreaterThan(1);
    await expect(svc.startDeploy(p.id, { guardrailOverride: true, acceptedBlocks: [all[0]!] })).rejects.toMatchObject({ code: "guardrail_changed" });
    const job = await svc.startDeploy(p.id, { guardrailOverride: true, acceptedBlocks: all });
    await vi.waitFor(async () => expect((await svc.getJob(p.id, job.id))?.status).toBe("success"));
  });
});
