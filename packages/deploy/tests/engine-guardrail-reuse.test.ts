/**
 * DeployEngine.deploy — reaproveitamento do relatório de guardrails (Fase 4).
 *
 * Bug: runGuardrails rodava até 3x por deploy (preview sob demanda +
 * pré-check em startDeploy + revalidação pós-ingestão no engine), sem
 * nenhum cache entre elas — custo desnecessário em repositórios grandes.
 *
 * A revalidação pós-ingestão (aqui, em engine.deploy) existe porque o código
 * pode mudar DEPOIS do clone/pull (modos git/upload) — essa checagem não pode
 * ser eliminada. Mas no modo "existing", ingestCode() não copia nem altera
 * nada: o diretório escaneado no pré-check de startDeploy é byte-a-byte o
 * mesmo que o engine veria depois da "ingestão". Nesse caso (e só nesse), o
 * chamador pode passar o relatório já calculado via
 * `opts.precomputedGuardrailReport` e o engine deve confiar nele em vez de
 * escanear a árvore de novo.
 *
 * Este teste prova o reaproveitamento de forma comportamental (não só que a
 * opção existe): o diretório real tem uma violação block (privileged: true)
 * que faria o deploy ser abortado por guardrails. Ao passar um relatório
 * pré-computado dizendo "sem bloqueios", o deploy DEVE avançar além da fase
 * de guardrails (falhando depois, por outro motivo — proxyPort ausente —,
 * o que prova que o scan real nunca rodou de novo).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GuardrailReport, Project } from "@paas/core";
import { DeployEngine, type EngineContext } from "../src/engine.js";

let projectsDir: string;
let srcDir: string;
let engine: DeployEngine;

beforeEach(async () => {
  projectsDir = await mkdtemp(path.join(tmpdir(), "paas-engine-guardrail-cache-"));
  srcDir = path.join(projectsDir, "src");
  await mkdir(srcDir, { recursive: true });
  // Violação block real: container privilegiado (mesma regra de rules.ts).
  await writeFile(
    path.join(srcDir, "compose.yml"),
    "services:\n  app:\n    image: app\n    privileged: true\n",
  );

  const ctx: EngineContext = {
    projectsDir,
    caddyDir: path.join(projectsDir, "caddy"),
    nodeImage: "node:22",
    staticImage: "nginx:alpine",
    caddyHttpPort: 80,
    caddyHttpsPort: 443,
  };
  engine = new DeployEngine(ctx);
});

afterEach(async () => {
  await rm(projectsDir, { recursive: true, force: true });
});

function projetoExisting(): Project {
  return {
    id: "p1",
    name: "Projeto Existing",
    slug: `existing-${randomBytes(4).toString("hex")}`,
    ingestMode: "existing",
    source: srcDir,
    branch: null,
    domain: "existing.localhost",
    websocket: false,
    detection: {
      type: "dockerfile",
      composeFile: null,
      outputDir: null,
      packageManager: null,
      buildCommand: null,
      proxyService: null,
      proxyPort: null, // de propósito: deployDockerfile falha rápido sem docker
      warnings: [],
      details: [],
    },
    proxyService: null,
    proxyPort: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastDeployAt: null,
    lastDeployStatus: null,
  } as Project;
}

const cleanReport: GuardrailReport = {
  ranAt: new Date().toISOString(),
  dir: "/tmp/nao-importa",
  findings: [],
  blockers: 0,
  warnings: 0,
  infos: 0,
};

describe("DeployEngine.deploy — reaproveitamento de guardrails (modo existing)", () => {
  it("sem relatório pré-computado, escaneia de verdade e bloqueia (privileged: true)", async () => {
    const project = projetoExisting();
    const logs: string[] = [];
    await expect(
      engine.deploy(project, [project], (c) => logs.push(c)),
    ).rejects.toThrow(/guardrail_blocked/);
  });

  it("com relatório pré-computado 'limpo', NÃO re-escaneia — avança além dos guardrails", async () => {
    const project = projetoExisting();
    const logs: string[] = [];
    // Se o engine reescaneasse o diretório real, encontraria o `privileged:
    // true` e abortaria com guardrail_blocked. Como recebe um relatório
    // pré-computado dizendo "sem bloqueios", ele deve confiar nele e falhar
    // só depois, por proxyPort ausente — prova de que o scan não rodou.
    await expect(
      engine.deploy(project, [project], (c) => logs.push(c), {
        precomputedGuardrailReport: cleanReport,
      }),
    ).rejects.toThrow(/porta exposta/i);

    const joined = logs.join("");
    expect(joined).not.toContain("guardrail_blocked");
    expect(joined).toContain("Reaproveitando checagem de guardrails");
    expect(joined).toContain("Etapa 2/5");
  });
});
