/**
 * Variáveis marcadas como "de build" (públicas): vão ao build estático (arquivo de ambiente 0600 fora do
 * código, apagado ao fim) e ao `docker build`/compose como --build-arg / build.args (só as marcadas E
 * declaradas por ARG). Segredo não marcado NUNCA entra. O log mostra só nomes.
 *
 * Sem Docker: `run` e `runStream` são dublês; o dublê do build lê o arquivo de ambiente na hora.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";

type Result = { code: number; stdout: string; stderr: string };
const calls: string[][] = [];
let model = "{}";
let envFileDuranteOBuild: { path: string; content: string; mode: number } | null = null;
let srcAtual = "";

vi.mock("../src/exec.js", () => ({
  run: vi.fn(async (_file: string, args: string[]): Promise<Result> => {
    calls.push(args);
    if (args.includes("config")) return { code: 0, stdout: model, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }),
  runStream: vi.fn(async (_file: string, args: string[]) => {
    calls.push(args);
    const i = args.indexOf("--env-file");
    if (args.includes("run") && i >= 0) {
      const file = args[i + 1]!;
      envFileDuranteOBuild = { path: file, content: await readFile(file, "utf8"), mode: (await stat(file)).mode & 0o777 };
      await mkdir(path.join(srcAtual, "dist"), { recursive: true });
      await writeFile(path.join(srcAtual, "dist", "index.html"), "<div id=root></div>");
    }
    if (args.includes("run") && i < 0) {
      await mkdir(path.join(srcAtual, "dist"), { recursive: true });
      await writeFile(path.join(srcAtual, "dist", "index.html"), "<div id=root></div>");
    }
    return 0;
  }),
}));
const healthMock = vi.hoisted(() => vi.fn());
vi.mock("../src/health-check.js", () => ({ waitHealthy: healthMock }));

const { DeployEngine } = await import("../src/engine.js");

let root: string;
let projectsDir: string;
let src: string;
let workDir: string;

const PUBLICA = "https://api.example.com/v1";
const SEGREDO = "senha-super-secreta-do-banco";

beforeEach(async () => {
  calls.length = 0;
  envFileDuranteOBuild = null;
  healthMock.mockReset();
  healthMock.mockResolvedValue(undefined);
  root = await mkdtemp(path.join(tmpdir(), "paas-build-vars-"));
  projectsDir = path.join(root, "projects");
  workDir = path.join(projectsDir, "site");
  src = path.join(root, "codigo");
  srcAtual = src;
  await mkdir(workDir, { recursive: true });
  await mkdir(src, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function project(type: "static-node" | "dockerfile" | "compose"): Project {
  return {
    id: "p1",
    name: "Site",
    slug: "site",
    ingestMode: "existing",
    source: src,
    branch: null,
    domain: "site.localhost",
    websocket: false,
    detection: {
      type,
      composeFile: type === "compose" ? "compose.yml" : null,
      outputDir: type === "static-node" ? "dist" : null,
      packageManager: "npm",
      buildCommand: null,
      proxyService: type === "compose" ? "web" : null,
      proxyPort: type === "static-node" ? null : 3000,
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

function engine(env: Record<string, string>, build: Record<string, string>) {
  const e = new DeployEngine({
    projectsDir,
    caddyDir: path.join(projectsDir, "caddy"),
    nodeImage: "node:22",
    staticImage: "nginx:alpine",
    caddyHttpPort: 80,
    caddyHttpsPort: 443,
    envForProject: async () => env,
    buildEnvForProject: async () => build,
  });
  e.caddy.apply = vi.fn().mockResolvedValue(undefined) as never;
  e.caddy.ensureNetwork = vi.fn().mockResolvedValue(undefined) as never;
  return e;
}
async function deploy(type: "static-node" | "dockerfile", env: Record<string, string>, build: Record<string, string>) {
  const logs: string[] = [];
  const p = project(type);
  await engine(env, build).deploy(p, [p], (c) => logs.push(c));
  return logs.join("");
}
const toda = () => calls.flat().join("\n");

describe("build estático (static-node)", () => {
  beforeEach(async () => {
    await writeFile(path.join(src, "package.json"), JSON.stringify({ scripts: { build: "vite build" }, devDependencies: { vite: "5" } }));
  });

  it("só a variável marcada chega ao build, por arquivo de ambiente 0600 fora do código, e o arquivo é apagado ao fim", async () => {
    const log = await deploy("static-node", { VITE_API_URL: PUBLICA, SEGREDO_DB: SEGREDO }, { VITE_API_URL: PUBLICA });
    expect(envFileDuranteOBuild).not.toBeNull();
    expect(envFileDuranteOBuild!.content).toBe(`VITE_API_URL=${PUBLICA}\n`);
    expect(envFileDuranteOBuild!.content).not.toContain(SEGREDO);
    expect(envFileDuranteOBuild!.mode).toBe(0o600);
    expect(envFileDuranteOBuild!.path).toBe(path.join(workDir, "paas.build.env"));
    expect(envFileDuranteOBuild!.path.startsWith(src + path.sep)).toBe(false);
    expect(existsSync(envFileDuranteOBuild!.path)).toBe(false);
    // nenhum valor no argv nem no log; só o nome
    expect(toda()).not.toContain(PUBLICA);
    expect(toda()).not.toContain(SEGREDO);
    expect(log).toContain("VITE_API_URL");
    expect(log).not.toContain(PUBLICA);
    expect(log).not.toContain(SEGREDO);
  });

  it("segredo não marcado nunca entra: sem marcadas, nem há arquivo de ambiente, e o log explica", async () => {
    const log = await deploy("static-node", { SEGREDO_DB: SEGREDO, VITE_API_URL: PUBLICA }, {});
    expect(envFileDuranteOBuild).toBeNull();
    expect(calls.some((a) => a.includes("--env-file"))).toBe(false);
    expect(toda()).not.toContain(SEGREDO);
    expect(log).toMatch(/Nenhuma variável marcada como "de build"/);
    // prefixo público sem marca: aviso com o NOME, sem o valor
    expect(log).toMatch(/Aviso: VITE_API_URL tem prefixo de variável pública, mas NÃO está marcada/);
    expect(log).not.toContain(PUBLICA);
  });

  it("variável marcada com nome reservado ou valor com quebra de linha fica de fora, com o motivo (sem o valor)", async () => {
    const log = await deploy(
      "static-node",
      {},
      { VITE_OK: "1", PATH: "/tmp/mal", NODE_OPTIONS: "--require x", DOCKER_HOST: "tcp://x", HTTPS_PROXY: "http://x", VITE_LINHAS: "a\nb" },
    );
    expect(envFileDuranteOBuild!.content).toBe("VITE_OK=1\n");
    expect(log).toMatch(/PATH ignorada \(nome reservado\)/);
    expect(log).toMatch(/NODE_OPTIONS ignorada/);
    expect(log).toMatch(/DOCKER_HOST ignorada/);
    expect(log).toMatch(/HTTPS_PROXY ignorada/);
    expect(log).toMatch(/VITE_LINHAS ignorada \(valor com quebra de linha\)/);
    expect(log).not.toContain("/tmp/mal");
  });

  it("o arquivo de ambiente também é apagado quando o build falha", async () => {
    const { runStream } = await import("../src/exec.js");
    vi.mocked(runStream).mockImplementationOnce(async (_f: string, args: string[]) => {
      calls.push(args);
      return 1;
    });
    await expect(deploy("static-node", {}, { VITE_OK: "1" })).rejects.toThrow(/build estático falhou/);
    expect(existsSync(path.join(workDir, "paas.build.env"))).toBe(false);
  });
});

describe("docker build (Dockerfile do usuário)", () => {
  /** O `docker build` (a execução do container leva as Variáveis por -e, de propósito). */
  const buildCall = () => calls.find((a) => a[0] === "build")!.join("\n");
  const buildArgs = () => {
    const args = calls.find((a) => a[0] === "build")!;
    return args.flatMap((a, i) => (args[i - 1] === "--build-arg" ? [a] : []));
  };

  it("--build-arg só das marcadas E declaradas por ARG; segredo e marcada sem ARG ficam de fora", async () => {
    await writeFile(path.join(src, "Dockerfile"), "FROM node:22 AS build\nARG VITE_API_URL\nARG OUTRO=1\nFROM nginx\nEXPOSE 80\n");
    const log = await deploy(
      "dockerfile",
      { VITE_API_URL: PUBLICA, SEGREDO_DB: SEGREDO, MARCADA_SEM_ARG: "x" },
      { VITE_API_URL: PUBLICA, MARCADA_SEM_ARG: "x" },
    );
    expect(buildArgs()).toEqual([`VITE_API_URL=${PUBLICA}`]);
    expect(buildCall()).not.toContain(SEGREDO);
    expect(log).toMatch(/passadas como --build-arg: VITE_API_URL\./);
    expect(log).toMatch(/Marcadas como "de build" mas o Dockerfile não declara ARG para: MARCADA_SEM_ARG/);
    expect(log).not.toContain(PUBLICA);
  });

  it("marcada com nome de segredo: passa (a pessoa decidiu), mas o log avisa que o valor fica no histórico da imagem", async () => {
    await writeFile(path.join(src, "Dockerfile"), "FROM node:22\nARG VITE_SECRET_KEY\nARG VITE_API_URL\nEXPOSE 80\n");
    const log = await deploy("dockerfile", { VITE_SECRET_KEY: "valor-x", VITE_API_URL: PUBLICA }, { VITE_SECRET_KEY: "valor-x", VITE_API_URL: PUBLICA });
    expect(log).toMatch(/Atenção: VITE_SECRET_KEY tem nome de segredo/);
    expect(log).not.toContain("valor-x");
  });

  it("ARG declarado mas variável NÃO marcada: não vai (nem o prefixo público muda isso), e há aviso", async () => {
    await writeFile(path.join(src, "Dockerfile"), "FROM node\nARG VITE_API_URL\nARG SEGREDO_DB\nEXPOSE 80\n");
    const log = await deploy("dockerfile", { VITE_API_URL: PUBLICA, SEGREDO_DB: SEGREDO }, {});
    expect(buildArgs()).toEqual([]);
    expect(buildCall()).not.toContain(SEGREDO);
    expect(buildCall()).not.toContain(PUBLICA);
    expect(log).toMatch(/Aviso: VITE_API_URL tem prefixo de variável pública, mas NÃO está marcada/);
    expect(log).not.toMatch(/Aviso: SEGREDO_DB/);
  });

  it("nome reservado marcado é ignorado mesmo declarado por ARG", async () => {
    await writeFile(path.join(src, "Dockerfile"), "FROM node\nARG HTTP_PROXY\nARG VITE_X\nEXPOSE 80\n");
    const log = await deploy("dockerfile", {}, { HTTP_PROXY: "http://x", VITE_X: "1" });
    expect(buildArgs()).toEqual(["VITE_X=1"]);
    expect(log).toMatch(/HTTP_PROXY ignorada \(nome reservado\)/);
  });
});

describe("compose com build:", () => {
  type Privado = {
    deployCompose(p: Project, src: string, onLog: (c: string) => void, dotenv: Record<string, string>, extra: Record<string, string>, tz: string | null, override: boolean, build: Record<string, string>): Promise<string>;
  };

  it("build.args no override só das marcadas declaradas por ARG de cada serviço; $ do valor é dobrado", async () => {
    await mkdir(path.join(src, "front"));
    await writeFile(path.join(src, "front", "Dockerfile"), "FROM node\nARG VITE_API_URL\nARG VITE_COM_CIFRAO\n");
    await writeFile(path.join(src, "Dockerfile"), "FROM node\nARG SO_NA_RAIZ\n");
    await writeFile(path.join(src, "compose.yml"), "services:\n  web:\n    build: ./front\n  api:\n    build: .\n");
    model = JSON.stringify({
      name: "paas-site",
      services: {
        web: { build: { context: path.join(src, "front") } },
        api: { build: { context: src, dockerfile: "Dockerfile" } },
      },
    });
    const logs: string[] = [];
    await (engine({}, {}) as unknown as Privado).deployCompose(
      project("compose"),
      src,
      (c) => logs.push(c),
      { SEGREDO_DB: SEGREDO },
      {},
      null,
      false,
      { VITE_API_URL: PUBLICA, VITE_COM_CIFRAO: "a$b", SO_NA_RAIZ: "1", NAO_DECLARADA: "x" },
    );
    const override = await readFile(path.join(workDir, "paas.override.yml"), "utf8");
    expect(override).toContain("build:");
    expect(override).toContain(PUBLICA);
    expect(override).toContain("a$$b");
    expect(override).not.toContain("NAO_DECLARADA");
    expect(override).not.toContain(SEGREDO);
    const log = logs.join("");
    expect(log).toMatch(/serviço web como args: VITE_API_URL, VITE_COM_CIFRAO/);
    expect(log).toMatch(/serviço api como args: SO_NA_RAIZ/);
    expect(log).toMatch(/nenhum Dockerfile do compose declara ARG para: NAO_DECLARADA/);
    expect(log).not.toContain(PUBLICA);
    expect(log).not.toContain(SEGREDO);
  });

  it("sem marcadas, o override não tem build; Dockerfile fora do código ou ilegível não entra", async () => {
    await writeFile(path.join(src, "compose.yml"), "services:\n  web:\n    build: .\n");
    model = JSON.stringify({ name: "paas-site", services: { web: { build: { context: src } } } });
    await (engine({}, {}) as unknown as Privado).deployCompose(project("compose"), src, () => undefined, {}, {}, null, false, {});
    expect(await readFile(path.join(workDir, "paas.override.yml"), "utf8")).not.toContain("build:");
    // marcada, mas o serviço não tem Dockerfile legível
    await (engine({}, {}) as unknown as Privado).deployCompose(project("compose"), src, () => undefined, {}, {}, null, false, { VITE_X: "1" });
    expect(await readFile(path.join(workDir, "paas.override.yml"), "utf8")).not.toContain("build:");
  });

  it("só nomes problemáticos marcados: o log explica e nada vai ao override", async () => {
    await writeFile(path.join(src, "compose.yml"), "services:\n  web:\n    build: .\n");
    await writeFile(path.join(src, "Dockerfile"), "FROM node\nARG PATH\n");
    model = JSON.stringify({ name: "paas-site", services: { web: { build: { context: src } } } });
    const logs: string[] = [];
    await (engine({}, {}) as unknown as Privado).deployCompose(project("compose"), src, (c) => logs.push(c), {}, {}, null, false, { PATH: "/x" });
    expect(logs.join("")).toMatch(/PATH ignorada \(nome reservado\)/);
    expect(await readFile(path.join(workDir, "paas.override.yml"), "utf8")).not.toContain("build:");
  });
});
