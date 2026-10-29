/**
 * Detecção com o tipo escolhido à mão no assistente: valida contra o código, é lembrada pelo projeto
 * e é abandonada (com aviso) quando o código muda e ela deixa de combinar. Também: a opção "aplicação
 * de página única" e a senha fraca por trás de uma Variável salva (só o NOME aparece).
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { removeDir } from "./helpers/tmp.js";

const code = vi.hoisted(() => ({ files: {} as Record<string, string> }));

vi.mock("@paas/deploy", async (importOriginal) => {
  const real = await importOriginal<typeof import("@paas/deploy")>();
  return {
    ...real,
    ingestCode: vi.fn(async (ctx: Parameters<typeof real.ingestCode>[0], project: Parameters<typeof real.ingestCode>[1]) => {
      const src = real.projectSrcDir(ctx, project);
      await removeDir(src);
      await mkdir(src, { recursive: true });
      for (const [name, content] of Object.entries(code.files)) await writeFile(path.join(src, name), content, "utf8");
      return src;
    }),
  };
});

const { DeployService } = await import("../src/services/deploy-service.js");

const VITE = JSON.stringify({ scripts: { build: "vite build" }, devDependencies: { vite: "5" }, dependencies: { react: "18" } });
let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "paas-detect-tipo-"));
  code.files = { "package.json": VITE, Dockerfile: "FROM nginx:alpine\nEXPOSE 80\n" };
});
afterEach(async () => {
  await removeDir(dataDir);
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

async function projeto(svc: InstanceType<typeof DeployService>) {
  return svc.createProject({
    name: "Loja",
    ingestMode: "git",
    source: "https://github.com/usuario/loja.git",
    branch: "main",
    domain: "loja.localhost",
  });
}

describe("tipo escolhido à mão", () => {
  it("sem escolha: o Dockerfile vence o Vite (com aviso); escolhendo static-node vale a escolha e ela fica gravada", async () => {
    const svc = servico();
    const p = await projeto(svc);
    const auto = await svc.detect(p.id);
    expect(auto.type).toBe("dockerfile");
    expect(auto.warnings.map((w) => w.id)).toContain("detect.dockerfile-priority");
    expect(p.typeOverride).toBeUndefined();

    const chosen = await svc.detect(p.id, { type: "static-node" });
    expect(chosen).toMatchObject({ type: "static-node", chosenType: true, detectedType: "dockerfile", spaSuggested: true });
    expect(p.typeOverride).toBe("static-node");
    expect(p.detection?.type).toBe("static-node");

    // a detecção seguinte (sem corpo) respeita a escolha de antes
    expect((await svc.detect(p.id)).type).toBe("static-node");
  });

  it("escolha que não combina com o código: 422 invalid_type e nada muda", async () => {
    code.files = { "package.json": VITE };
    const svc = servico();
    const p = await projeto(svc);
    await svc.detect(p.id);
    await expect(svc.detect(p.id, { type: "dockerfile" })).rejects.toMatchObject({
      statusCode: 422,
      code: "invalid_type",
      message: expect.stringMatching(/Dockerfile na raiz/),
    });
    expect(p.typeOverride).toBeUndefined();
    expect(p.detection?.type).toBe("static-node");
  });

  it("voltar ao automático (type: null) apaga a escolha", async () => {
    const svc = servico();
    const p = await projeto(svc);
    await svc.detect(p.id, { type: "static-node" });
    const back = await svc.detect(p.id, { type: null });
    expect(back.type).toBe("dockerfile");
    expect(p.typeOverride).toBeNull();
  });

  it("o código mudou e a escolha antiga não combina mais: volta ao automático, avisa e esquece a escolha", async () => {
    const svc = servico();
    const p = await projeto(svc);
    await svc.detect(p.id, { type: "static-node" });
    code.files = { Dockerfile: "FROM nginx\nEXPOSE 8080\n" };
    const after = await svc.detect(p.id);
    expect(after.type).toBe("dockerfile");
    expect(after.chosenType).toBeUndefined();
    const warning = after.warnings.find((w) => w.id === "detect.type-override-dropped");
    expect(warning?.message).toMatch(/static-node.*não combina mais/);
    expect(p.typeOverride).toBeNull();
  });

  it("um erro que não é de tipo escolhido segue como erro", async () => {
    const svc = servico();
    const p = await projeto(svc);
    code.files = {};
    const spy = vi.spyOn(await import("@paas/deploy"), "detectProject").mockRejectedValueOnce(new Error("boom"));
    await expect(svc.detect(p.id)).rejects.toThrow("boom");
    spy.mockRestore();
  });
});

describe("aplicação de página única e senha fraca por Variável", () => {
  it("PATCH spa liga e desliga a opção do projeto", async () => {
    const svc = servico();
    const p = await projeto(svc);
    expect((await svc.updateProject(p.id, { spa: true })).spa).toBe(true);
    expect((await svc.updateProject(p.id, { spa: false })).spa).toBe(false);
  });

  it("a detecção do compose confere o valor salvo da Variável e cita só o nome", async () => {
    code.files = { "compose.yml": "services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: ${DB_PASSWORD}\n" };
    const svc = servico();
    const p = await projeto(svc);
    await svc.setEnv(p.id, [{ key: "DB_PASSWORD", value: "123" }]);
    const detection = await svc.detect(p.id);
    const weak = detection.warnings.find((w) => w.id === "compose.weak-credentials");
    expect(weak?.message).toMatch(/POSTGRES_PASSWORD.*Variável DB_PASSWORD/);
    expect(JSON.stringify(detection)).not.toMatch(/"123"|\b123\b/);
  });
});
