/**
 * DeployEngine.start/stop — erros de domínio quando não há containers.
 *
 * Bug: start/stop lançavam `Error` genérico (sem statusCode/code) quando o
 * projeto não tinha containers. sendError() (routes/projects.ts) trata
 * qualquer erro sem essas propriedades como 500 internal_error, então a
 * mensagem acionável ("faça um deploy primeiro") nunca chegava ao cliente
 * com o status/código corretos. Os dois métodos devem lançar um erro no
 * mesmo formato usado pelo resto do domínio (statusCode + code + message
 * em pt-BR).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@paas/core";
import { DeployEngine, type EngineContext } from "../src/engine.js";

let projectsDir: string;
let engine: DeployEngine;

beforeEach(async () => {
  projectsDir = await mkdtemp(path.join(tmpdir(), "paas-engine-lifecycle-"));
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

/** Projeto "fantasma": slug único, garantidamente sem containers no Docker local. */
function projetoFantasma(): Project {
  return {
    id: "p1",
    name: "App Fantasma",
    slug: `fantasma-${randomBytes(4).toString("hex")}`,
    ingestMode: "existing",
    source: projectsDir,
    branch: null,
    domain: "fantasma.localhost",
    websocket: false,
    detection: null,
    proxyService: null,
    proxyPort: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastDeployAt: null,
    lastDeployStatus: null,
    deployedBranch: null,
    deployedSource: null,
  };
}

describe("DeployEngine.start — sem containers", () => {
  it("lança erro de domínio 409 no_containers (não um Error genérico)", async () => {
    const project = projetoFantasma();
    await expect(engine.start(project, () => {})).rejects.toMatchObject({
      statusCode: 409,
      code: "no_containers",
    });
  });

  it("mensagem é acionável em pt-BR", async () => {
    const project = projetoFantasma();
    await expect(engine.start(project, () => {})).rejects.toThrow(/fa[cç]a um deploy primeiro/i);
  });
});

describe("DeployEngine.stop — sem containers", () => {
  it("lança erro de domínio 409 no_containers (mesmo padrão do start)", async () => {
    const project = projetoFantasma();
    await expect(engine.stop(project, () => {})).rejects.toMatchObject({
      statusCode: 409,
      code: "no_containers",
    });
  });

  it("mensagem é acionável em pt-BR", async () => {
    const project = projetoFantasma();
    await expect(engine.stop(project, () => {})).rejects.toThrow(/fa[cç]a um deploy primeiro/i);
  });
});
