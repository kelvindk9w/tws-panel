/**
 * DeployEngine.deploy com tipo node-server, ponta a ponta com dublês (exec, health check, Caddy):
 * rollback do container antigo, poda só depois de saudável, .env do painel fora do contexto
 * do build e limpeza do segredo mesmo quando o build estoura o tempo.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";

interface Call {
  file: string;
  args: string[];
}
const calls: Call[] = [];
const events: string[] = [];
let startFails = false;

vi.mock("../src/exec.js", () => ({
  run: vi.fn(async (file: string, args: string[]) => {
    calls.push({ file, args });
    events.push(`run:${args.slice(0, 2).join(" ")}`);
    if (args[0] === "start" && startFails) return { code: 1, stdout: "", stderr: "cannot start" };
    return { code: 0, stdout: "", stderr: "" };
  }),
  runStream: vi.fn(async (file: string, args: string[]) => {
    calls.push({ file, args });
    events.push("build");
    return 0;
  }),
}));
const healthMock = vi.hoisted(() => vi.fn());
vi.mock("../src/health-check.js", () => ({ waitHealthy: healthMock }));

const { DeployEngine } = await import("../src/engine.js");
const exec = await import("../src/exec.js");

let root: string;
let projectsDir: string;
let src: string;
let workDir: string;
let engine: InstanceType<typeof DeployEngine>;
let applyMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.mocked(exec.run).mockImplementation(async (file: string, args: string[]) => {
    calls.push({ file, args });
    events.push(`run:${args.slice(0, 2).join(" ")}`);
    return { code: 0, stdout: "", stderr: "" };
  });
  calls.length = 0;
  events.length = 0;
  startFails = false;
  healthMock.mockReset();
  healthMock.mockResolvedValue(undefined);
  root = await mkdtemp(path.join(tmpdir(), "paas-ns-deploy-"));
  projectsDir = path.join(root, "projects");
  workDir = path.join(projectsDir, "loja");
  src = path.join(root, "codigo");
  await mkdir(workDir, { recursive: true });
  await mkdir(src, { recursive: true });
  await writeFile(path.join(src, "package.json"), JSON.stringify({ scripts: { build: "next build" }, dependencies: { next: "15" } }));
  await writeFile(path.join(src, "package-lock.json"), "{}");
  engine = new DeployEngine({
    projectsDir,
    caddyDir: path.join(projectsDir, "caddy"),
    nodeImage: "node:22",
    staticImage: "nginx:alpine",
    caddyHttpPort: 80,
    caddyHttpsPort: 443,
    totalMemBytes: () => 2 * 1024 ** 3,
  });
  applyMock = vi.fn().mockResolvedValue(undefined);
  engine.caddy.apply = applyMock as never;
  engine.caddy.ensureNetwork = vi.fn().mockResolvedValue(undefined) as never;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function project(): Project {
  return {
    id: "p1",
    name: "Loja",
    slug: "loja",
    ingestMode: "existing",
    source: src,
    branch: null,
    domain: "loja.localhost",
    websocket: false,
    detection: {
      type: "node-server",
      composeFile: null,
      outputDir: null,
      packageManager: "npm",
      buildCommand: "npm run build",
      proxyService: null,
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

const deploy = () => {
  const logs: string[] = [];
  const p = project();
  return { logs, result: engine.deploy(p, [p], (c) => logs.push(c)) };
};
const has = (pred: (a: string[]) => boolean) => calls.some((c) => pred(c.args));

describe("deploy node-server — rollback", () => {
  it("saudável: o container antigo (parado) é removido e a imagem anterior podada, nessa ordem, DEPOIS do health check", async () => {
    healthMock.mockImplementation(async () => {
      events.push("health");
    });
    const { result, logs } = deploy();
    await result;
    const idx = (e: string) => events.indexOf(e);
    expect(idx("health")).toBeGreaterThan(idx("run:run -d"));
    expect(idx("run:rm -f")).toBeGreaterThan(-1);
    const lastRm = events.lastIndexOf("run:rm -f");
    expect(lastRm).toBeGreaterThan(idx("health"));
    expect(idx("run:image prune")).toBeGreaterThan(idx("health"));
    expect(idx("run:builder prune")).toBeGreaterThan(idx("run:image prune"));
    expect(has((a) => a[0] === "rm" && a.includes("paas-loja-app-previous"))).toBe(true);
    expect(logs.join("")).toContain("imagem anterior do projeto (sem uso)");
    expect(logs.join("")).not.toContain("religada");
  });

  it("health check reprova: o novo é removido, o antigo volta (rename + start), nada é podado e o erro segue", async () => {
    healthMock.mockRejectedValue(new Error("health check falhou após 60s (HTTP 502)."));
    const { result, logs } = deploy();
    await expect(result).rejects.toThrow(/health check falhou/);
    const seq = calls.map((c) => c.args.slice(0, 3).join(" "));
    const rmNew = seq.lastIndexOf("rm -f paas-loja-app");
    const rename = seq.indexOf("rename paas-loja-app-previous paas-loja-app");
    const start = seq.indexOf("start paas-loja-app");
    expect(rmNew).toBeGreaterThan(seq.indexOf("run -d --name"));
    expect(rename).toBeGreaterThan(rmNew);
    expect(start).toBeGreaterThan(rename);
    expect(has((a) => a[1] === "prune")).toBe(false);
    expect(logs.join("")).toContain("a versão anterior foi religada e o site continua no ar");
  });

  it("falha do Caddy (etapa 4) também religa o antigo", async () => {
    applyMock.mockRejectedValue(new Error("caddy reload falhou"));
    await expect(deploy().result).rejects.toThrow(/caddy/);
    expect(has((a) => a[0] === "start" && a[1] === "paas-loja-app")).toBe(true);
    expect(healthMock).not.toHaveBeenCalled();
  });

  it("não havia versão anterior (rename falha): avisa e não tenta religar nada", async () => {
    healthMock.mockRejectedValue(new Error("sem resposta"));
    vi.mocked(exec.run).mockImplementation(async (_f: string, args: string[]) => {
      calls.push({ file: "docker", args });
      return args[0] === "rename" ? { code: 1, stdout: "", stderr: "x" } : { code: 0, stdout: "", stderr: "" };
    });
    const { result, logs } = deploy();
    await expect(result).rejects.toThrow(/sem resposta/);
    expect(has((a) => a[0] === "start")).toBe(false);
    expect(logs.join("")).toContain("não havia versão anterior para religar");
  });

  it("religar o antigo falha: mensagem honesta com o erro", async () => {
    startFails = true;
    vi.mocked(exec.run).mockImplementation(async (_f: string, args: string[]) => {
      calls.push({ file: "docker", args });
      return args[0] === "start" ? { code: 1, stdout: "", stderr: "cannot start" } : { code: 0, stdout: "", stderr: "" };
    });
    healthMock.mockRejectedValue(new Error("sem resposta"));
    const { result, logs } = deploy();
    await expect(result).rejects.toThrow();
    expect(logs.join("")).toContain("não consegui religar a versão anterior (cannot start)");
  });

  it("os outros tipos não são afetados: sem rename/stop/previous", async () => {
    const p = project();
    p.detection!.type = "dockerfile";
    await writeFile(path.join(src, "Dockerfile"), "FROM scratch\nEXPOSE 3000\n");
    await engine.deploy(p, [p], () => undefined);
    expect(has((a) => a.includes("paas-loja-app-previous"))).toBe(false);
  });
});

describe("deploy node-server — segredos fora do contexto e limpeza", () => {
  const GENERATED = "# Gerado pelo painel (seção Variáveis do projeto) — não editar aqui: edite no painel.";

  it("projeto que era compose: o .env gerado pelo painel é apagado ANTES do build; nada dele entra no contexto", async () => {
    await writeFile(path.join(src, ".env"), `${GENERATED}\nDATABASE_URL='postgres://u:senha-do-compose@db/x'\n`);
    let existiaNoBuild: boolean | null = null;
    vi.mocked(exec.runStream).mockImplementationOnce(async (file: string, args: string[]) => {
      calls.push({ file, args });
      existiaNoBuild = existsSync(path.join(src, ".env"));
      return 0;
    });
    const { result, logs } = deploy();
    await result;
    expect(existiaNoBuild).toBe(false);
    expect(logs.join("")).toContain("Removido do código o .env que o painel gravou");
    const ignore = await readFile(path.join(workDir, "paas.next.Dockerfile.dockerignore"), "utf8");
    expect(ignore.split("\n")).toEqual(expect.arrayContaining([".env", "**/.env", ".env.*", "**/.env.*"]));
    expect(logs.join("")).not.toContain("senha-do-compose");
  });

  it(".env do próprio dono (sem o cabeçalho) não é apagado, mas o .dockerignore o deixa de fora do build", async () => {
    await writeFile(path.join(src, ".env"), "SEGREDO_DO_DONO=1\n");
    const { result, logs } = deploy();
    await result;
    expect(await readFile(path.join(src, ".env"), "utf8")).toBe("SEGREDO_DO_DONO=1\n");
    expect(logs.join("")).not.toContain("Removido do código o .env");
    expect(await readFile(path.join(workDir, "paas.next.Dockerfile.dockerignore"), "utf8")).toContain("\n.env\n");
  });

  it("build estoura o tempo (runStream rejeita): o arquivo do segredo é apagado mesmo assim e o erro segue", async () => {
    vi.mocked(exec.runStream).mockImplementationOnce(async (file: string, args: string[]) => {
      calls.push({ file, args });
      expect(existsSync(path.join(workDir, "paas.next.build.env"))).toBe(true);
      throw new Error('Comando "docker" excedeu o tempo limite de 1800s.');
    });
    await expect(deploy().result).rejects.toThrow(/tempo limite/);
    expect(existsSync(path.join(workDir, "paas.next.build.env"))).toBe(false);
    // nada subiu e o antigo não foi tocado
    expect(has((a) => a[0] === "run")).toBe(false);
    expect(has((a) => a[0] === "rename" || a[0] === "stop")).toBe(false);
  });
});
