/**
 * Build sem o plugin buildx: o deploy falha ANTES do build, com a mensagem acionável, e quando o build
 * quebra por "requires BuildKit" o log e o erro trazem a dica certa. Sem Docker: `run` e `runStream` são dublês.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";

type Result = { code: number; stdout: string; stderr: string };
let buildxOk = true;
let inspectErr = "";
let composeModel = "";
let streamOutput = "";
let streamExit = 0;
const streams: Array<{ args: string[]; env: Record<string, string | undefined> | undefined }> = [];

vi.mock("../src/exec.js", () => ({
  run: vi.fn(async (_file: string, args: string[]): Promise<Result> => {
    if (args[0] === "buildx" && args[1] === "inspect") {
      return inspectErr ? { code: 1, stdout: "", stderr: inspectErr } : { code: 0, stdout: "Name: default\n", stderr: "" };
    }
    if (args[0] === "buildx") {
      return buildxOk
        ? { code: 0, stdout: "docker/buildx v0.38.1\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "docker: unknown command: docker buildx\n" };
    }
    if (args.includes("config")) return { code: 0, stdout: composeModel, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }),
  runStream: vi.fn(async (_file: string, args: string[], onData: (c: string) => void, opts?: { env?: Record<string, string | undefined> }) => {
    streams.push({ args, env: opts?.env });
    if (streamOutput) onData(streamOutput);
    return streamExit;
  }),
}));

const { DeployEngine } = await import("../src/engine.js");
const { BUILDX_MISSING_MESSAGE, BUILDX_UNUSABLE_MESSAGE } = await import("../src/buildx.js");

let root: string;
let src: string;

beforeEach(async () => {
  buildxOk = true;
  inspectErr = "";
  streamOutput = "";
  streamExit = 0;
  streams.length = 0;
  root = await mkdtemp(path.join(tmpdir(), "paas-engine-buildx-"));
  src = path.join(root, "projects", "meu-app", "src");
  await mkdir(src, { recursive: true });
  await writeFile(path.join(src, "Dockerfile"), "FROM node:22\nCOPY --chmod=755 . .\nEXPOSE 3000\n");
  await writeFile(path.join(src, "compose.yml"), "services:\n  web:\n    build: .\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function project(type: "dockerfile" | "compose"): Project {
  return {
    id: "p1",
    name: "Meu app",
    slug: "meu-app",
    ingestMode: "existing",
    source: src,
    branch: null,
    domain: "meu-app.localhost",
    websocket: false,
    detection: {
      type,
      composeFile: type === "compose" ? "compose.yml" : null,
      outputDir: null,
      packageManager: null,
      buildCommand: null,
      proxyService: type === "compose" ? "web" : null,
      proxyPort: 3000,
      warnings: [],
      details: [],
    },
    proxyService: null,
    proxyPort: null,
    createdAt: "",
    updatedAt: "",
    lastDeployAt: null,
    lastDeployStatus: null,
    deployedBranch: null,
    deployedSource: null,
  };
}

function engine() {
  return new DeployEngine({
    projectsDir: path.join(root, "projects"),
    caddyDir: path.join(root, "caddy"),
    nodeImage: "node:22",
    staticImage: "nginx:alpine",
    caddyHttpPort: 80,
    caddyHttpsPort: 443,
  });
}

type Privado = {
  deployDockerfile(p: Project, src: string, onLog: (c: string) => void): Promise<string>;
  deployCompose(p: Project, src: string, onLog: (c: string) => void, dotenv: Record<string, string>, extra: Record<string, string>, tz: string | null, override: boolean): Promise<string>;
};
const priv = () => engine() as unknown as Privado;

describe("buildx ausente — Dockerfile", () => {
  it("falha antes do build, com a mensagem acionável", async () => {
    buildxOk = false;
    let log = "";
    await expect(priv().deployDockerfile(project("dockerfile"), src, (c) => (log += c))).rejects.toThrow(BUILDX_MISSING_MESSAGE);
    expect(streams).toHaveLength(0);
    expect(log).toContain("Saúde da máquina");
    expect(log).toContain("unknown command");
  });

  it("plugin presente mas sem pasta gravável para o estado: falha antes do build com a dica de BUILDX_CONFIG", async () => {
    inspectErr = "ERROR: mkdir /app/.docker/buildx/instances: read-only file system";
    let log = "";
    await expect(priv().deployDockerfile(project("dockerfile"), src, (c) => (log += c))).rejects.toThrow(BUILDX_UNUSABLE_MESSAGE);
    expect(streams).toHaveLength(0);
    expect(log).toContain("read-only file system");
  });

  it("DOCKER_CONFIG apontando para pasta não gravável: falha antes do build, sem rodar o docker", async () => {
    const antes = process.env.DOCKER_CONFIG;
    process.env.DOCKER_CONFIG = path.join(src, "Dockerfile", ".docker"); // dentro de um arquivo: não dá para criar
    try {
      let log = "";
      await expect(priv().deployDockerfile(project("dockerfile"), src, (c) => (log += c))).rejects.toThrow(BUILDX_UNUSABLE_MESSAGE);
      expect(streams).toHaveLength(0);
      expect(log).toContain("DOCKER_CONFIG=");
    } finally {
      if (antes === undefined) delete process.env.DOCKER_CONFIG;
      else process.env.DOCKER_CONFIG = antes;
    }
  });

  it("com buildx, o build pede BuildKit no ambiente", async () => {
    await priv().deployDockerfile(project("dockerfile"), src, () => undefined);
    const build = streams.find((s) => s.args.includes("build"))!;
    expect(build.env?.DOCKER_BUILDKIT).toBe("1");
    expect(build.env?.COMPOSE_DOCKER_CLI_BUILD).toBe("1");
  });

  it("build que quebra por 'requires BuildKit' mostra a dica certa", async () => {
    streamOutput = "buildx Docker CLI plugin not found: falling back to the classic builder\nthe --chmod option requires BuildKit\n";
    streamExit = 1;
    let log = "";
    await expect(priv().deployDockerfile(project("dockerfile"), src, (c) => (log += c))).rejects.toThrow(/docker build falhou: O Docker do painel está sem o plugin buildx/);
    expect(log).toContain("✖ O Docker do painel está sem o plugin buildx");
  });

  it("falha comum de build mantém a mensagem com o código de saída", async () => {
    streamOutput = "npm ERR! algo\n";
    streamExit = 2;
    await expect(priv().deployDockerfile(project("dockerfile"), src, () => undefined)).rejects.toThrow("docker build falhou (exit 2).");
  });
});

describe("buildx ausente — compose", () => {
  beforeEach(() => {
    composeModel = JSON.stringify({ name: "paas-meu-app", services: { web: { build: { context: src }, ports: ["3000"] } } });
  });

  it("compose com build: falha antes do up", async () => {
    buildxOk = false;
    await expect(priv().deployCompose(project("compose"), src, () => undefined, {}, {}, null, false)).rejects.toThrow(BUILDX_MISSING_MESSAGE);
    expect(streams.some((s) => s.args.includes("up"))).toBe(false);
  });

  it.each([
    ["dockerfile_inline", { dockerfile_inline: "FROM alpine\nCOPY --chmod=755 a b" }],
    ["contexto remoto (URL)", { context: "https://example.com/meu-app.git" }],
  ])("compose com %s também exige o buildx (fora da lista de alvos do .env)", async (_n, build) => {
    buildxOk = false;
    composeModel = JSON.stringify({ name: "paas-meu-app", services: { web: { build, ports: ["3000"] } } });
    await expect(priv().deployCompose(project("compose"), src, () => undefined, {}, {}, null, true)).rejects.toThrow(BUILDX_MISSING_MESSAGE);
    expect(streams.some((s) => s.args.includes("up"))).toBe(false);
  });

  it("compose só com imagens prontas não precisa do buildx", async () => {
    buildxOk = false;
    composeModel = JSON.stringify({ name: "paas-meu-app", services: { web: { image: "nginx:alpine", ports: ["3000"] } } });
    await writeFile(path.join(src, "compose.yml"), "services:\n  web:\n    image: nginx:alpine\n");
    await priv().deployCompose(project("compose"), src, () => undefined, {}, {}, null, false);
    expect(streams.some((s) => s.args.includes("up"))).toBe(true);
  });

  it("up que quebra por 'requires BuildKit': erro com a dica, sem o diagnóstico de serviços", async () => {
    streamOutput = "failed to solve: the --chmod option requires BuildKit\n";
    streamExit = 1;
    let log = "";
    await expect(priv().deployCompose(project("compose"), src, (c) => (log += c), {}, {}, null, false)).rejects.toThrow(/docker compose up falhou: O Docker do painel está sem o plugin buildx/);
    expect(log).toContain("✖ O Docker do painel está sem o plugin buildx");
    const up = streams.find((s) => s.args.includes("up"))!;
    expect(up.env?.DOCKER_BUILDKIT).toBe("1");
  });
});

describe("buildx ausente — Next.js em servidor", () => {
  it("falha antes de preparar o build: o arquivo com segredos nem chega a ser gravado", async () => {
    buildxOk = false;
    const workDir = path.join(root, "projects", "meu-app");
    await writeFile(path.join(src, "package.json"), JSON.stringify({ scripts: { build: "next build" }, dependencies: { next: "15" } }));
    await writeFile(path.join(src, "package-lock.json"), "{}");
    const p = project("dockerfile");
    p.detection = { ...p.detection!, type: "node-server", packageManager: "npm", buildCommand: "npm run build" };
    const eng = new DeployEngine({
      projectsDir: path.join(root, "projects"),
      caddyDir: path.join(root, "caddy"),
      nodeImage: "node:22",
      staticImage: "nginx:alpine",
      caddyHttpPort: 80,
      caddyHttpsPort: 443,
      totalMemBytes: () => 2 * 1024 ** 3,
    });
    await expect(
      (eng as unknown as { deployNodeServer(p: Project, s: string, l: (c: string) => void, e: Record<string, string>): Promise<string> }).deployNodeServer(p, src, () => undefined, { SEGREDO: "valor-secreto" }),
    ).rejects.toThrow(BUILDX_MISSING_MESSAGE);
    expect(streams).toHaveLength(0);
    expect(existsSync(path.join(workDir, "paas.next.build.env"))).toBe(false);
  });
});
