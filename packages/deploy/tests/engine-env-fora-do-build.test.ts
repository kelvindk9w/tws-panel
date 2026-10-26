/**
 * O `.env` que o painel grava em `src` (as Variáveis do projeto) NUNCA entra no contexto de um build do
 * usuário: um Dockerfile com `COPY . .` e sem `.dockerignore` que o exclua levaria todos os segredos para
 * uma camada da imagem. O painel gera um `<Dockerfile>.dockerignore` mesclado só durante o build, sem
 * apagar nem alterar o `.dockerignore` do usuário, e restaura tudo ao fim (mesmo se o build falhar).
 *
 * Sem Docker: `run` e `runStream` são dublês. Na hora do build o dublê lê a pasta e calcula, com as regras
 * de ignore que o BuildKit aplicaria, QUAIS arquivos entrariam no contexto.
 */
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";

type Result = { code: number; stdout: string; stderr: string };
let model = "{}";
let buildExit = 0;
/** O que cada build enxergou: arquivos que entrariam no contexto e o texto dos arquivos de ignore. */
const builds: Array<{ args: string[]; context: string[]; ignores: Record<string, string> }> = [];

/** Avaliação mínima do .dockerignore (a última regra que casa vence; `!` desfaz; `*` e prefixo de pasta). */
function ignorado(rel: string, rules: string): boolean {
  let out = false;
  for (const raw of rules.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    const pattern = (negate ? line.slice(1) : line).replace(/^\//, "");
    const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}(/.*)?$`);
    if (regex.test(rel)) out = !negate;
  }
  return out;
}

async function contextoDe(dir: string, ignoreFile: string): Promise<string[]> {
  const rules = existsSync(ignoreFile) ? await readFile(ignoreFile, "utf8") : existsSync(path.join(dir, ".dockerignore")) ? await readFile(path.join(dir, ".dockerignore"), "utf8") : "";
  const files: string[] = [];
  const walk = async (rel: string) => {
    for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (ignorado(r, rules)) continue;
      if (entry.isDirectory()) await walk(r);
      else files.push(r);
    }
  };
  await walk("");
  return files.sort();
}

async function registraBuild(args: string[], src: string): Promise<void> {
  const ignores: Record<string, string> = {};
  for (const name of await readdir(src)) {
    if (name.endsWith(".dockerignore")) ignores[name] = await readFile(path.join(src, name), "utf8");
  }
  const dockerfile = args.includes("build") ? path.join(src, "Dockerfile") : path.join(src, "Dockerfile");
  builds.push({ args, context: await contextoDe(src, `${dockerfile}.dockerignore`), ignores });
}

let srcAtual = "";
vi.mock("../src/exec.js", () => ({
  run: vi.fn(async (_file: string, args: string[]): Promise<Result> => {
    if (args.includes("config")) return { code: 0, stdout: model, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }),
  runStream: vi.fn(async (_file: string, args: string[]) => {
    if (args.includes("build") || args.includes("up")) await registraBuild(args, srcAtual);
    return buildExit;
  }),
}));

const { DeployEngine } = await import("../src/engine.js");
const { GENERATED_HEADER, writeProjectDotenv } = await import("../src/project-dotenv.js");

let root: string;
let projectsDir: string;
let src: string;
let workDir: string;

beforeEach(async () => {
  builds.length = 0;
  buildExit = 0;
  root = await mkdtemp(path.join(tmpdir(), "paas-env-build-"));
  projectsDir = path.join(root, "projects");
  workDir = path.join(projectsDir, "loja");
  src = path.join(workDir, "src");
  srcAtual = src;
  await mkdir(src, { recursive: true });
  await writeFile(path.join(src, "Dockerfile"), "FROM node:22\nCOPY . .\nEXPOSE 3000\n");
  await writeFile(path.join(src, "app.js"), "console.log(1)");
  await mkdir(path.join(src, "node_modules"));
  await writeFile(path.join(src, "node_modules", "x.js"), "x");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function project(type: "dockerfile" | "compose"): Project {
  return {
    id: "p1",
    name: "Loja",
    slug: "loja",
    ingestMode: "git",
    source: "https://example.com/loja.git",
    branch: "main",
    domain: "loja.localhost",
    websocket: false,
    detection: {
      type,
      composeFile: type === "compose" ? "compose.yml" : null,
      outputDir: null,
      packageManager: null,
      buildCommand: null,
      proxyService: type === "compose" ? "web" : null,
      proxyPort: type === "compose" ? 3000 : 3000,
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
    projectsDir,
    caddyDir: path.join(projectsDir, "caddy"),
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
const deployDockerfile = (log: string[] = []) => (engine() as unknown as Privado).deployDockerfile(project("dockerfile"), src, (c) => log.push(c));
const deployCompose = (dotenv: Record<string, string>, log: string[] = []) =>
  (engine() as unknown as Privado).deployCompose(project("compose"), src, (c) => log.push(c), dotenv, {}, null, false);

/** Um `.env` com o cabeçalho do painel e um segredo, sem o registro do hash (como o de uma versão antiga ou editado). */
const dotenvDoPainel = () => writeFile(path.join(src, ".env"), `${GENERATED_HEADER}\nSEGREDO='valor-secreto'\n`);

describe("Dockerfile do usuário — o .env do painel fica fora do contexto", () => {
  it("com COPY . . e sem .dockerignore: o .env não entra, o resto entra, e o painel não deixa arquivo para trás", async () => {
    await dotenvDoPainel();
    const log: string[] = [];
    await deployDockerfile(log);
    expect(builds).toHaveLength(1);
    expect(builds[0]!.context).toContain("app.js");
    expect(builds[0]!.context).toContain("Dockerfile");
    expect(builds[0]!.context).not.toContain(".env");
    expect(log.join("")).toMatch(/\.env gravado pelo painel.*fora do contexto/);
    // depois do build: nada sobrou, e o .env (das Variáveis) continua lá
    expect(existsSync(path.join(src, "Dockerfile.dockerignore"))).toBe(false);
    expect(existsSync(path.join(src, ".dockerignore"))).toBe(false);
    expect(await readFile(path.join(src, ".env"), "utf8")).toContain("valor-secreto");
  });

  it("o .dockerignore do usuário vale junto (node_modules continua fora) e nunca é alterado nem apagado", async () => {
    await dotenvDoPainel();
    const seu = "node_modules\n.git\n!.env\n";
    await writeFile(path.join(src, ".dockerignore"), seu);
    await deployDockerfile();
    const visto = builds[0]!;
    expect(visto.context).not.toContain("node_modules/x.js");
    // mesmo com `!.env` no ignore dele, a exclusão do painel vem por último e vence
    expect(visto.context).not.toContain(".env");
    expect(visto.ignores["Dockerfile.dockerignore"]).toContain(seu.trim());
    expect(visto.ignores["Dockerfile.dockerignore"]!.trimEnd().split("\n").slice(-3, -1)).toContain(".env");
    expect(await readFile(path.join(src, ".dockerignore"), "utf8")).toBe(seu);
  });

  it("um <Dockerfile>.dockerignore do usuário é mesclado e volta como estava (sem o bloco do painel)", async () => {
    await dotenvDoPainel();
    await writeFile(path.join(src, "Dockerfile.dockerignore"), "*.log\n");
    await deployDockerfile();
    expect(builds[0]!.ignores["Dockerfile.dockerignore"]).toMatch(/^\*\.log\n/);
    expect(builds[0]!.context).not.toContain(".env");
    expect(await readFile(path.join(src, "Dockerfile.dockerignore"), "utf8")).toBe("*.log\n");
  });

  it("um <Dockerfile>.dockerignore que era link simbólico volta a ser o mesmo link", async () => {
    await dotenvDoPainel();
    await writeFile(path.join(src, "ignore-real"), "*.log\n");
    await symlink("ignore-real", path.join(src, "Dockerfile.dockerignore"));
    await deployDockerfile();
    expect(builds[0]!.context).not.toContain(".env");
    expect((await lstat(path.join(src, "Dockerfile.dockerignore"))).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(src, "ignore-real"), "utf8")).toBe("*.log\n");
  });

  it("build que falha também restaura os arquivos", async () => {
    await dotenvDoPainel();
    await writeFile(path.join(src, ".dockerignore"), "node_modules\n");
    buildExit = 1;
    await expect(deployDockerfile()).rejects.toThrow(/docker build falhou/);
    expect(existsSync(path.join(src, "Dockerfile.dockerignore"))).toBe(false);
    expect(await readFile(path.join(src, ".dockerignore"), "utf8")).toBe("node_modules\n");
  });

  it("sobra de um build interrompido (bloco do painel já no arquivo) não se acumula", async () => {
    await dotenvDoPainel();
    await deployDockerfile();
    const primeira = builds[0]!.ignores["Dockerfile.dockerignore"]!;
    // simula a sobra: o arquivo temporário ficou na pasta depois de uma queda
    await writeFile(path.join(src, "Dockerfile.dockerignore"), primeira);
    await deployDockerfile();
    const segunda = builds[1]!.ignores["Dockerfile.dockerignore"]!;
    expect(segunda.match(/TWS Panel \(temporário/g)).toHaveLength(1);
    // e o que volta para a pasta é o conteúdo do usuário, sem o bloco
    expect(await readFile(path.join(src, "Dockerfile.dockerignore"), "utf8")).not.toMatch(/TWS Panel/);
  });

  it("o .env do dono do repositório (sem o cabeçalho do painel) não é mexido: o build pode lê-lo de propósito", async () => {
    await writeFile(path.join(src, ".env"), "VITE_PUBLICA=1\n");
    await deployDockerfile();
    expect(builds[0]!.context).toContain(".env");
    expect(builds[0]!.ignores).toEqual({});
  });

  it("sem .env nenhum, nada é gravado na pasta", async () => {
    await deployDockerfile();
    expect(builds[0]!.ignores).toEqual({});
  });

  it("projeto que foi compose: o .env que o painel gravou (hash registrado) é apagado antes do build", async () => {
    await mkdir(workDir, { recursive: true });
    await writeProjectDotenv(src, workDir, { SEGREDO: "valor-secreto" });
    expect(existsSync(path.join(src, ".env"))).toBe(true);
    const log: string[] = [];
    await deployDockerfile(log);
    expect(existsSync(path.join(src, ".env"))).toBe(false);
    expect(builds[0]!.context).not.toContain(".env");
    expect(log.join("")).toMatch(/Removido do código o \.env que o painel gravou/);
  });
});

describe("compose com build: — o .env do painel fica fora do contexto que é a pasta do código", () => {
  const modelo = (services: Record<string, unknown>) => JSON.stringify({ name: "paas-loja", services });

  it("serviço que constrói da raiz: o .env gravado pelas Variáveis não entra no contexto", async () => {
    await writeFile(path.join(src, "compose.yml"), "services:\n  web:\n    build: .\n");
    model = modelo({ web: { build: { context: src, dockerfile: "Dockerfile" } } });
    await deployCompose({ SEGREDO: "valor-secreto" });
    const up = builds.find((b) => b.args.includes("up"))!;
    expect(up.context).toContain("app.js");
    expect(up.context).not.toContain(".env");
    expect(existsSync(path.join(src, "Dockerfile.dockerignore"))).toBe(false);
    expect(await readFile(path.join(src, ".env"), "utf8")).toContain("valor-secreto");
  });

  it("contexto numa subpasta (build: ./api) não tem o .env: nada é gravado lá; Dockerfile em outra pasta também é alcançado", async () => {
    await mkdir(path.join(src, "api"));
    await writeFile(path.join(src, "api", "Dockerfile"), "FROM node\n");
    await mkdir(path.join(src, "docker"));
    await writeFile(path.join(src, "docker", "web.Dockerfile"), "FROM node\nCOPY . .\n");
    await writeFile(path.join(src, "compose.yml"), "services:\n  web:\n    build: .\n");
    model = modelo({
      api: { build: { context: path.join(src, "api") } },
      web: { build: { context: src, dockerfile: "docker/web.Dockerfile" } },
      img: { image: "redis" },
      inline: { build: { context: src, dockerfile_inline: "FROM alpine" } },
    });
    let vistoDuranteOUp: string[] = [];
    const { runStream } = await import("../src/exec.js");
    vi.mocked(runStream).mockImplementationOnce(async (_f: string, args: string[]) => {
      vistoDuranteOUp = (await readdir(path.join(src, "docker"))).concat(await readdir(path.join(src, "api")));
      await registraBuild(args, src);
      return 0;
    });
    await deployCompose({ SEGREDO: "valor-secreto" });
    expect(vistoDuranteOUp).toContain("web.Dockerfile.dockerignore");
    expect(vistoDuranteOUp).not.toContain("Dockerfile.dockerignore");
    expect(await readdir(path.join(src, "docker"))).toEqual(["web.Dockerfile"]);
    expect(await readdir(path.join(src, "api"))).toEqual(["Dockerfile"]);
  });

  it("sem build: no compose, ou sem Variáveis (sem .env do painel), nada é gravado", async () => {
    await writeFile(path.join(src, "compose.yml"), "services:\n  web:\n    image: nginx\n");
    model = modelo({ web: { image: "nginx" } });
    await deployCompose({ SEGREDO: "x" });
    expect(builds[0]!.ignores).toEqual({});
    builds.length = 0;
    model = modelo({ web: { build: { context: src } } });
    await rm(path.join(src, ".env"), { force: true });
    await deployCompose({});
    expect(builds[0]!.ignores).toEqual({});
  });

  it("build do compose que falha restaura os arquivos e segue o fluxo de erro do compose", async () => {
    await writeFile(path.join(src, "compose.yml"), "services:\n  web:\n    build: .\n");
    await writeFile(path.join(src, ".dockerignore"), "node_modules\n");
    model = modelo({ web: { build: { context: src } } });
    buildExit = 1;
    await expect(deployCompose({ SEGREDO: "x" })).rejects.toThrow();
    expect(existsSync(path.join(src, "Dockerfile.dockerignore"))).toBe(false);
    expect(await readFile(path.join(src, ".dockerignore"), "utf8")).toBe("node_modules\n");
  });
});
