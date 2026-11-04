/**
 * next-app.ts — lê a pasta de um projeto Next.js (só arquivos de texto, nada
 * é executado) e diz como o painel o constrói: gerenciador de pacotes,
 * lockfile, versão do Node e se o next.config pede `output: "standalone"`.
 *
 * Serve à detecção (decidir o tipo) e ao deploy (que lê a pasta DE NOVO na
 * hora do build: o código pode ter mudado desde a última detecção).
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { NodeMajor, NodeVersionSource, PackageManager } from "@paas/core";
import { NEXT_CONFIG_FILES, NEXT_CONFIG_MAX_CHARS, nextOutputOf, type NextOutput } from "./next-config.js";
import { pickNodeMajor } from "./node-version.js";
import { isRealDirectory, readRegularFileLimited } from "./safe-fs.js";

export interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  engines?: { node?: string };
  packageManager?: string;
  workspaces?: unknown;
}

/** Tamanho máximo de um package.json lido (um legítimo tem poucos KB). */
export const PACKAGE_JSON_MAX_BYTES = 1024 * 1024;

/** package.json da pasta: arquivo comum, até 1 MB, JSON de objeto; qualquer outra coisa = null. */
export async function readPackageJson(dir: string): Promise<PackageJson | null> {
  const text = await readRegularFileLimited(path.join(dir, "package.json"), PACKAGE_JSON_MAX_BYTES);
  if (text === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as PackageJson) : null;
  } catch {
    return null;
  }
}

const LOCKFILES: Record<PackageManager, string[]> = {
  pnpm: ["pnpm-lock.yaml"],
  yarn: ["yarn.lock"],
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
};

/** Gerenciador de pacotes: campo `packageManager` > lockfile (pnpm, yarn) > npm. */
export function detectPackageManager(dir: string, pkg: PackageJson): PackageManager {
  const declared = typeof pkg.packageManager === "string" ? pkg.packageManager : "";
  if (declared.startsWith("pnpm")) return "pnpm";
  if (declared.startsWith("yarn")) return "yarn";
  if (declared.startsWith("npm")) return "npm";
  if (existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

/** Nome do lockfile do gerenciador que existe na pasta (null = sem lockfile). */
export function findLockfile(dir: string, pm: PackageManager): string | null {
  return LOCKFILES[pm].find((name) => existsSync(path.join(dir, name))) ?? null;
}

/** Yarn moderno (2+, "berry")? Pelo `packageManager` ou, sem ele, pelo yarn.lock. */
async function isYarnBerry(dir: string, pkg: PackageJson): Promise<boolean> {
  const declared = typeof pkg.packageManager === "string" ? pkg.packageManager : "";
  const m = /^yarn@(\d+)/.exec(declared);
  if (m) return Number(m[1]) >= 2;
  return ((await readRegularFileLimited(path.join(dir, "yarn.lock"), 2048)) ?? "").includes("__metadata:");
}

export interface NextAppInfo {
  /** `next` nas dependências do package.json da raiz. */
  hasNext: boolean;
  /** O que o next.config declara em `output`. */
  output: NextOutput;
  /** Arquivo de configuração lido (null = nenhum). */
  configFile: string | null;
  packageManager: PackageManager;
  yarnBerry: boolean;
  lockfile: string | null;
  hasBuildScript: boolean;
  nodeMajor: NodeMajor;
  nodeSource: NodeVersionSource;
  /** Notas legíveis (pt-BR) sobre o que foi decidido. */
  notes: string[];
}

async function readText(file: string, max: number): Promise<string | undefined> {
  return (await readRegularFileLimited(file, max))?.replace(/^\uFEFF/, "");
}

/** Analisa a pasta. `pkg` ausente = lê o package.json; null (sem package.json) = não é Next. */
export async function inspectNextApp(dir: string, pkg?: PackageJson | null): Promise<NextAppInfo | null> {
  const manifest = pkg === undefined ? await readPackageJson(dir) : pkg;
  if (!manifest) return null;
  const deps = { ...manifest.dependencies, ...manifest.devDependencies };
  const hasNext = typeof deps["next"] === "string";

  let output: NextOutput = "none";
  let configFile: string | null = null;
  for (const name of NEXT_CONFIG_FILES) {
    if (!existsSync(path.join(dir, name))) continue;
    configFile = name;
    const content = await readText(path.join(dir, name), NEXT_CONFIG_MAX_CHARS);
    output = content === undefined ? "none" : nextOutputOf(content);
    break;
  }

  const packageManager = detectPackageManager(dir, manifest);
  const lockfile = findLockfile(dir, packageManager);
  const yarnBerry = packageManager === "yarn" && (await isYarnBerry(dir, manifest));

  const engines = typeof manifest.engines?.node === "string" ? manifest.engines.node : undefined;
  const choice = pickNodeMajor({
    engines,
    nvmrc: await readText(path.join(dir, ".nvmrc"), 256),
    nodeVersionFile: await readText(path.join(dir, ".node-version"), 256),
  });

  return {
    hasNext,
    output,
    configFile,
    packageManager,
    yarnBerry,
    lockfile,
    hasBuildScript: typeof manifest.scripts?.["build"] === "string",
    nodeMajor: choice.major,
    nodeSource: choice.source,
    notes: choice.notes,
  };
}

/**
 * Apps Next.js em subpastas de um monorepo (`apps/*`, `packages/*`): o painel
 * só publica Next.js na RAIZ do repositório, então isto vira um aviso. Olha
 * poucas pastas e só um nível.
 */
export async function findNestedNextApps(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const parent of ["apps", "packages"]) {
    // pasta de verdade: um link `apps -> /outro/lugar` não faz o painel ler fora do repositório
    if (!(await isRealDirectory(path.join(dir, parent)))) continue;
    const names = await readdir(path.join(dir, parent)).catch(() => [] as string[]);
    for (const name of names.slice(0, 30)) {
      if (!(await isRealDirectory(path.join(dir, parent, name)))) continue;
      const nested = await readPackageJson(path.join(dir, parent, name));
      const deps = { ...nested?.dependencies, ...nested?.devDependencies };
      if (typeof deps["next"] === "string") found.push(`${parent}/${name}`);
    }
  }
  return found;
}

/** A raiz parece um monorepo (workspaces, pnpm-workspace.yaml, turbo.json, nx.json)? */
export function looksLikeMonorepo(dir: string, pkg: PackageJson): boolean {
  return (
    pkg.workspaces !== undefined ||
    ["pnpm-workspace.yaml", "turbo.json", "nx.json", "lerna.json"].some((f) => existsSync(path.join(dir, f)))
  );
}
