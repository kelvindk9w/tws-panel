/**
 * Build estático (static-node) cuja pasta de saída é — ou contém — um link
 * simbólico (achado M8 da auditoria). O nginx do projeto monta a pasta de
 * saída e o daemon do Docker resolve o link NO HOST: `dist -> /opt/tws-projects`
 * publicaria na internet o código de todos os outros projetos.
 *
 * Sem Docker: `run` e `runStream` são dublês que registram os argumentos.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";

type Result = { code: number; stdout: string; stderr: string };
const calls: string[][] = [];

vi.mock("../src/exec.js", () => ({
  run: vi.fn(async (_file: string, args: string[]): Promise<Result> => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "" };
  }),
  runStream: vi.fn(async (_file: string, args: string[]) => {
    calls.push(args);
    return 0;
  }),
}));

const { DeployEngine } = await import("../src/engine.js");

let root: string;
let projectsDir: string;
let src: string;
let fora: string;

beforeEach(async () => {
  calls.length = 0;
  root = await mkdtemp(path.join(tmpdir(), "paas-static-link-"));
  projectsDir = path.join(root, "projects");
  src = path.join(projectsDir, "site", "src");
  fora = path.join(root, "outro-projeto");
  await mkdir(src, { recursive: true });
  await mkdir(fora, { recursive: true });
  await writeFile(path.join(fora, "codigo-secreto.txt"), "SEGREDO");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function project(outputDir = "dist"): Project {
  return {
    id: "p1",
    name: "Site",
    slug: "site",
    ingestMode: "git",
    source: "https://example.com/x.git",
    branch: "main",
    domain: "site.localhost",
    websocket: false,
    detection: {
      type: "static-node",
      composeFile: null,
      outputDir,
      packageManager: "npm",
      buildCommand: null,
      proxyService: null,
      proxyPort: null,
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

async function deployStatic(p: Project): Promise<string> {
  const e = engine() as unknown as { deployStatic(p: Project, src: string, onLog: (c: string) => void): Promise<string> };
  return e.deployStatic(p, src, () => undefined);
}

/** Pasta que o nginx recebeu (o `-v origem:/usr/share/nginx/html:ro`). */
function pastaMontada(): string | null {
  for (const args of calls) {
    const i = args.findIndex((a) => a.endsWith(":/usr/share/nginx/html:ro"));
    if (i >= 0) return args[i]!.replace(":/usr/share/nginx/html:ro", "");
  }
  return null;
}

describe("static-node — pasta de saída do build com link simbólico (M8)", () => {
  it("dist que é link para fora do src: o deploy falha e nada é montado no nginx", async () => {
    await symlink(fora, path.join(src, "dist"));
    await expect(deployStatic(project())).rejects.toThrow(/link simbólico|fora do código/i);
    expect(pastaMontada()).toBeNull();
    expect(calls.some((a) => a.includes("run") && a.includes("nginx:alpine"))).toBe(false);
  });

  it("dist que é link para outra pasta DENTRO do src também é recusado (só pasta de verdade)", async () => {
    await mkdir(path.join(src, "build-real"));
    await symlink(path.join(src, "build-real"), path.join(src, "dist"));
    await expect(deployStatic(project())).rejects.toThrow(/link simbólico/i);
    expect(pastaMontada()).toBeNull();
  });

  it("saída por um caminho com '..' ou por uma pasta-link no meio do caminho é recusada", async () => {
    await expect(deployStatic(project("../../../outro-projeto"))).rejects.toThrow(/fora do código/i);
    await mkdir(path.join(fora, "dist"));
    await symlink(fora, path.join(src, "pub"));
    await expect(deployStatic(project("pub/dist"))).rejects.toThrow(/fora do código/i);
    expect(pastaMontada()).toBeNull();
  });

  it("saída que é o próprio código (.) ou um arquivo comum é recusada", async () => {
    await expect(deployStatic(project("."))).rejects.toThrow(/fora do código|próprio código/i);
    await writeFile(path.join(src, "dist"), "arquivo");
    await expect(deployStatic(project())).rejects.toThrow(/não é uma pasta/i);
  });

  it("saída que não existe depois do build: erro claro", async () => {
    await expect(deployStatic(project())).rejects.toThrow(/não gerou a pasta/i);
  });

  it("dist de verdade: o nginx recebe uma CÓPIA criada pelo painel, sem os links simbólicos de dentro", async () => {
    await mkdir(path.join(src, "dist", "assets"), { recursive: true });
    await writeFile(path.join(src, "dist", "index.html"), "<h1>oi</h1>");
    await writeFile(path.join(src, "dist", "assets", "app.js"), "1");
    await writeFile(path.join(src, "dist", ".nojekyll"), "");
    await symlink("/etc/passwd", path.join(src, "dist", "passwd"));
    await symlink(fora, path.join(src, "dist", "assets", "outro"));

    const upstream = await deployStatic(project());

    expect(upstream).toBe("site:80");
    const montada = pastaMontada()!;
    expect(montada).toBe(path.join(projectsDir, "site", "site"));
    expect(montada.startsWith(src)).toBe(false);
    expect(await readFile(path.join(montada, "index.html"), "utf8")).toBe("<h1>oi</h1>");
    expect(await readFile(path.join(montada, "assets", "app.js"), "utf8")).toBe("1");
    // arquivo oculto não vai para o ar (só .well-known é mantida)
    expect(existsSync(path.join(montada, ".nojekyll"))).toBe(false);
    expect(existsSync(path.join(montada, "passwd"))).toBe(false);
    expect(existsSync(path.join(montada, "assets", "outro"))).toBe(false);
  });
});
