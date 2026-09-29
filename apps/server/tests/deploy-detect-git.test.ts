/**
 * Detecção de projeto em modo git — defeito da validação real (29/09/2026).
 *
 * O assistente de novo projeto cria o projeto e pede a detecção logo em
 * seguida, mas no modo git o código só era baixado no primeiro deploy: a
 * detecção respondia "código ainda não ingerido" e NENHUM repositório git
 * (público ou privado) passava do passo 1. Agora a detecção baixa o código
 * primeiro — pelo mesmo caminho do deploy, com a credencial de leitura.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";

const ingest = vi.hoisted(() => ({ fail: null as Error | null, calls: 0 }));

vi.mock("@paas/deploy", async (importOriginal) => {
  const real = await importOriginal<typeof import("@paas/deploy")>();
  return {
    ...real,
    ingestCode: vi.fn(async (ctx: Parameters<typeof real.ingestCode>[0], project: Parameters<typeof real.ingestCode>[1]) => {
      ingest.calls += 1;
      if (ingest.fail) throw ingest.fail;
      const src = real.projectSrcDir(ctx, project);
      await mkdir(src, { recursive: true });
      await writeFile(path.join(src, "Dockerfile"), "FROM nginx:alpine\nEXPOSE 80\n", "utf8");
      return src;
    }),
  };
});

const { DeployService } = await import("../src/services/deploy-service.js");

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-detect-git-"));
  ingest.fail = null;
  ingest.calls = 0;
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function servico() {
  return new DeployService({
    dataDir,
    projectsDir: path.join(dataDir, "projects"),
    caddyHttpPort: 80,
    caddyHttpsPort: 443,
    panelDomain: null,
    port: 9000,
  } as unknown as ServerConfig);
}

async function projetoGit(svc: InstanceType<typeof DeployService>) {
  return svc.createProject({
    name: "Cassino",
    ingestMode: "git",
    source: "https://github.com/usuario/cassino.git",
    branch: "main",
    domain: "cassino.localhost",
  });
}

describe("detecção em modo git", () => {
  it("baixa o código antes de detectar (não exige um deploy antes)", async () => {
    const svc = servico();
    const project = await projetoGit(svc);
    const detection = await svc.detect(project.id);
    expect(ingest.calls).toBe(1);
    expect(detection.type).not.toBe("unknown");
  });

  /**
   * Nova tentativa no assistente com a URL corrigida: a detecção precisa olhar
   * o repositório CONFIGURADO, não o que foi baixado antes. A ingestão já troca
   * de repositório/branch quando eles mudam (e só faz fetch quando não mudam).
   */
  it("sempre sincroniza com o repositório configurado antes de detectar", async () => {
    const svc = servico();
    const project = await projetoGit(svc);
    await svc.detect(project.id);
    await svc.updateProject(project.id, { source: "https://github.com/usuario/cassino-certo.git" });
    await svc.detect(project.id);
    expect(ingest.calls).toBe(2);
  });

  it("falha no clone vira erro legível (422), com a orientação do git preservada", async () => {
    ingest.fail = new Error("git clone falhou: Authentication failed\n\nO repositório parece ser PRIVADO: cadastre um token de LEITURA");
    const svc = servico();
    const project = await projetoGit(svc);
    await expect(svc.detect(project.id)).rejects.toMatchObject({
      statusCode: 422,
      code: "clone_failed",
      message: expect.stringMatching(/não foi possível baixar o código.*PRIVADO/is),
    });
  });
});
