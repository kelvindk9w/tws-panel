/**
 * Detecção de Next.js com servidor (type=node-server): export × servidor ×
 * standalone, prioridade de compose/Dockerfile, gerenciador de pacotes,
 * lockfile, versão do Node e monorepo. Fixtures em disco, sem executar nada.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectProject } from "../src/detect.js";
import { findNestedNextApps, inspectNextApp } from "../src/next-app.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-detect-next-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const file = (name: string, content: string, base = dir) => writeFile(path.join(base, name), content);
const json = (name: string, data: unknown, base = dir) => file(name, JSON.stringify(data), base);

const NEXT_PKG = { scripts: { build: "next build", start: "next start" }, dependencies: { next: "^15.1.0", react: "^19.0.0" } };

describe("Next.js: export × servidor × standalone", () => {
  it("next sem output → node-server, porta 3000, Node 22, next start", async () => {
    await json("package.json", NEXT_PKG);
    await file("next.config.js", "module.exports = { reactStrictMode: true };\n");
    const r = await detectProject(dir);
    expect(r.type).toBe("node-server");
    expect(r.outputDir).toBeNull();
    expect(r.proxyPort).toBe(3000);
    expect(r.buildCommand).toBe("npm run build");
    expect(r.nodeServer).toEqual({ framework: "next", standalone: false, nodeMajor: 22, nodeSource: "default", lockfile: false });
    expect(r.details.join(" ")).toContain("next start");
    expect(r.details.join(" ")).toContain("Sem lockfile");
  });

  it('output: "export" continua static-node (out/), nunca node-server', async () => {
    await json("package.json", NEXT_PKG);
    await file("next.config.mjs", 'export default { output: "export" };\n');
    const r = await detectProject(dir);
    expect(r.type).toBe("static-node");
    expect(r.outputDir).toBe("out");
    expect(r.nodeServer).toBeUndefined();
  });

  it("output: standalone → node-server com standalone=true", async () => {
    await json("package.json", NEXT_PKG);
    await file("next.config.ts", "import type { NextConfig } from 'next';\nconst c: NextConfig = { output: 'standalone' };\nexport default c;\n");
    const r = await detectProject(dir);
    expect(r.type).toBe("node-server");
    expect(r.nodeServer?.standalone).toBe(true);
    expect(r.details.join(" ")).toContain("node server.js");
  });

  it("next.config.mts também é lido", async () => {
    await json("package.json", NEXT_PKG);
    await file("next.config.mts", "export default { output: 'standalone' };\n");
    expect((await detectProject(dir)).nodeServer?.standalone).toBe(true);
  });

  it("export dentro de comentário não faz o site virar estático", async () => {
    await json("package.json", NEXT_PKG);
    await file("next.config.js", '// output: "export",\nmodule.exports = { /* output: "export" */ };\n');
    expect((await detectProject(dir)).type).toBe("node-server");
  });

  it("output por expressão (process.env) → servidor, com aviso de que o arquivo não é executado", async () => {
    await json("package.json", NEXT_PKG);
    await file("next.config.js", "module.exports = { output: process.env.OUT };\n");
    const r = await detectProject(dir);
    expect(r.type).toBe("node-server");
    expect(r.nodeServer?.standalone).toBe(false);
    expect(r.details.join(" ")).toContain("não executa o arquivo");
  });

  it("sem next.config nenhum também é servidor", async () => {
    await json("package.json", NEXT_PKG);
    expect((await detectProject(dir)).type).toBe("node-server");
  });

  it("next só em devDependencies conta; sem next não é servidor Next", async () => {
    await json("package.json", { scripts: { build: "next build" }, devDependencies: { next: "15.0.0" } });
    expect((await detectProject(dir)).type).toBe("node-server");
    await json("package.json", { scripts: { build: "tsc" }, dependencies: { express: "4" } });
    expect((await detectProject(dir)).type).not.toBe("node-server");
  });

  it("sem script build, o build é o próprio next build", async () => {
    await json("package.json", { dependencies: { next: "15" } });
    const r = await detectProject(dir);
    expect(r.type).toBe("node-server");
    expect(r.buildCommand).toBe("next build");
  });

  it("next.config ilegível não derruba: vira servidor comum", async () => {
    if (process.getuid?.() === 0) return;
    await json("package.json", NEXT_PKG);
    await file("next.config.js", 'module.exports = { output: "standalone" };');
    await chmod(path.join(dir, "next.config.js"), 0o000);
    try {
      const r = await detectProject(dir);
      expect(r.type).toBe("node-server");
      expect(r.nodeServer?.standalone).toBe(false);
    } finally {
      await chmod(path.join(dir, "next.config.js"), 0o644);
    }
  });
});

describe("Next.js: prioridade de compose e Dockerfile", () => {
  it("compose vence o Next.js", async () => {
    await json("package.json", NEXT_PKG);
    await file("compose.yml", "services:\n  web:\n    build: .\n    ports: ['3000:3000']\n");
    const r = await detectProject(dir);
    expect(r.type).toBe("compose");
    expect(r.nodeServer).toBeUndefined();
  });

  it("Dockerfile do usuário vence o Next.js (pipeline dockerfile, porta do EXPOSE)", async () => {
    await json("package.json", NEXT_PKG);
    await file("Dockerfile", "FROM node:22\nEXPOSE 4000\n");
    const r = await detectProject(dir);
    expect(r.type).toBe("dockerfile");
    expect(r.proxyPort).toBe(4000);
    expect(r.nodeServer).toBeUndefined();
  });

  it("Dockerfile + output standalone: continua Dockerfile", async () => {
    await json("package.json", NEXT_PKG);
    await file("next.config.js", "module.exports = { output: 'standalone' }");
    await file("Dockerfile", "FROM node:22\n");
    expect((await detectProject(dir)).type).toBe("dockerfile");
  });
});

describe("Next.js: gerenciador de pacotes e lockfile", () => {
  it.each([
    ["pnpm-lock.yaml", "pnpm", "pnpm build"],
    ["yarn.lock", "yarn", "yarn build"],
    ["package-lock.json", "npm", "npm run build"],
    ["npm-shrinkwrap.json", "npm", "npm run build"],
  ])("lockfile %s → %s", async (lock, pm, build) => {
    await json("package.json", NEXT_PKG);
    await file(lock, "");
    const r = await detectProject(dir);
    expect(r.packageManager).toBe(pm);
    expect(r.buildCommand).toBe(build);
    expect(r.nodeServer?.lockfile).toBe(true);
    expect(r.details.join(" ")).toContain(`Instalação congelada pelo ${lock}`);
  });

  it("packageManager declarado vence o lockfile", async () => {
    await json("package.json", { ...NEXT_PKG, packageManager: "pnpm@10.0.0" });
    await file("package-lock.json", "{}");
    const r = await detectProject(dir);
    expect(r.packageManager).toBe("pnpm");
    expect(r.nodeServer?.lockfile).toBe(false); // pnpm declarado, mas só existe lockfile do npm
  });

  it("lockfile do pnpm vence o do yarn quando os dois existem", async () => {
    await json("package.json", NEXT_PKG);
    await file("pnpm-lock.yaml", "");
    await file("yarn.lock", "");
    expect((await detectProject(dir)).packageManager).toBe("pnpm");
  });

  it("yarn moderno é reconhecido pelo packageManager ou pelo __metadata do yarn.lock", async () => {
    await json("package.json", { ...NEXT_PKG, packageManager: "yarn@4.5.0" });
    expect((await inspectNextApp(dir))?.yarnBerry).toBe(true);
    await json("package.json", { ...NEXT_PKG, packageManager: "yarn@1.22.22" });
    expect((await inspectNextApp(dir))?.yarnBerry).toBe(false);
    await json("package.json", NEXT_PKG);
    await file("yarn.lock", "__metadata:\n  version: 8\n");
    expect((await inspectNextApp(dir))?.yarnBerry).toBe(true);
    await file("yarn.lock", "# yarn lockfile v1\n");
    expect((await inspectNextApp(dir))?.yarnBerry).toBe(false);
  });

  it("yarn declarado sem yarn.lock não é berry", async () => {
    await json("package.json", { ...NEXT_PKG, packageManager: "yarn" });
    expect((await inspectNextApp(dir))?.yarnBerry).toBe(false);
  });
});

describe("Next.js: versão do Node", () => {
  it("engines.node, .nvmrc e .node-version, nessa ordem", async () => {
    await json("package.json", { ...NEXT_PKG, engines: { node: ">=24" } });
    await file(".nvmrc", "20\n");
    let r = await detectProject(dir);
    expect(r.nodeServer).toMatchObject({ nodeMajor: 24, nodeSource: "engines" });

    await json("package.json", NEXT_PKG);
    r = await detectProject(dir);
    expect(r.nodeServer).toMatchObject({ nodeMajor: 20, nodeSource: "nvmrc" });

    await rm(path.join(dir, ".nvmrc"));
    await file(".node-version", "v24.2.0");
    r = await detectProject(dir);
    expect(r.nodeServer).toMatchObject({ nodeMajor: 24, nodeSource: "node-version" });
    expect(r.details.join(" ")).toContain(".node-version → Node 24");
  });

  it("versão fora do que o painel oferece volta ao Node 22 e avisa", async () => {
    await json("package.json", { ...NEXT_PKG, engines: { node: "^16" } });
    const r = await detectProject(dir);
    expect(r.nodeServer?.nodeMajor).toBe(22);
    expect(r.details.join(" ")).toContain("20, 22, 24");
  });

  it("engines.node que não é texto é ignorado", async () => {
    await json("package.json", { ...NEXT_PKG, engines: { node: 22 } });
    expect((await detectProject(dir)).nodeServer).toMatchObject({ nodeMajor: 22, nodeSource: "default" });
  });
});

describe("Next.js em monorepo / package.json estranho", () => {
  it("monorepo com Next em apps/web: sem next na raiz, avisa que o painel só publica na raiz", async () => {
    await json("package.json", { scripts: { build: "turbo build" }, workspaces: ["apps/*"] });
    await mkdir(path.join(dir, "apps", "web"), { recursive: true });
    await json("package.json", NEXT_PKG, path.join(dir, "apps", "web"));
    const r = await detectProject(dir);
    expect(r.type).not.toBe("node-server");
    expect(r.details.join(" ")).toContain("Monorepo: há Next.js em apps/web");
  });

  it("o aviso aparece também sem script de build na raiz (turbo.json) e olha packages/", async () => {
    await json("package.json", { name: "raiz" });
    await file("turbo.json", "{}");
    await mkdir(path.join(dir, "packages", "site"), { recursive: true });
    await json("package.json", { devDependencies: { next: "15" } }, path.join(dir, "packages", "site"));
    const r = await detectProject(dir);
    expect(r.type).toBe("unknown");
    expect(r.details.join(" ")).toContain("packages/site");
  });

  it("sem sinal de monorepo na raiz, ou sem Next nas subpastas, nada de aviso", async () => {
    await json("package.json", { scripts: { build: "make" } });
    await mkdir(path.join(dir, "apps", "web"), { recursive: true });
    await json("package.json", NEXT_PKG, path.join(dir, "apps", "web"));
    expect((await detectProject(dir)).details.join(" ")).not.toContain("Monorepo");
    await file("pnpm-workspace.yaml", "packages: ['apps/*']\n");
    await json("package.json", { dependencies: { express: "4" } }, path.join(dir, "apps", "web"));
    expect((await detectProject(dir)).details.join(" ")).not.toContain("Monorepo");
  });

  it("findNestedNextApps ignora subpasta ilegível e não explode sem apps/", async () => {
    expect(await findNestedNextApps(dir)).toEqual([]);
    await mkdir(path.join(dir, "apps", "quebrado"), { recursive: true });
    await file("package.json", "{ não é json", path.join(dir, "apps", "quebrado"));
    expect(await findNestedNextApps(dir)).toEqual([]);
  });

  it("package.json que não é um objeto JSON não é projeto Node", async () => {
    await file("package.json", "[1,2]");
    expect(await inspectNextApp(dir)).toBeNull();
    expect((await detectProject(dir)).type).toBe("unknown");
  });

  it("inspectNextApp sem package.json devolve null", async () => {
    expect(await inspectNextApp(dir)).toBeNull();
  });
});
