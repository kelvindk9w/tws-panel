/**
 * detect.ts — detecção automática do tipo de projeto a partir do código-fonte.
 *
 * Perfis (docs/projects-analysis.md):
 *  - static-node: package.json com build que gera pasta estática (bomb: Next export → out/)
 *  - compose:     tem arquivo compose (trader: compose.prod.yml → painel ADOTA)
 *  - dockerfile:  Dockerfile sem compose
 *  - unknown:     pede configuração manual
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { DetectResult, GuardrailWarning, PackageManager } from "@paas/core";
import { analyzeCompose, guessProxyTarget, servicesWithCustomNetworks } from "./guardrails.js";

/** Candidatos de arquivo compose, em ordem de prioridade (produção primeiro). */
const COMPOSE_CANDIDATES = [
  "compose.prod.yml",
  "compose.prod.yaml",
  "compose.production.yml",
  "docker-compose.prod.yml",
  "docker-compose.prod.yaml",
  "docker-compose.production.yml",
  "compose.yml",
  "compose.yaml",
  "docker-compose.yml",
  "docker-compose.yaml",
];

/** Pastas de saída estática conhecidas, em ordem de prioridade. */
const STATIC_OUTPUT_DIRS = ["out", "dist", "build"];

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function detectPackageManager(dir: string, pkg: Record<string, unknown>): Promise<PackageManager> {
  const declared = typeof pkg.packageManager === "string" ? pkg.packageManager : "";
  if (declared.startsWith("pnpm")) return "pnpm";
  if (declared.startsWith("yarn")) return "yarn";
  if (declared.startsWith("npm")) return "npm";
  if (existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

/**
 * Indica se o build gera site estático. Sinais:
 *  - next.config.* com output: "export" (gera out/)
 *  - dependência do vite (gera dist/)
 *  - pasta de saída já existente no código
 */
async function detectStaticOutput(
  dir: string,
  pkg: Record<string, unknown>,
): Promise<{ outputDir: string | null; notes: string[] }> {
  const notes: string[] = [];

  // Next.js static export → out/
  const files = await readdir(dir).catch(() => [] as string[]);
  const nextConfig = files.find((f) => /^next\.config\.(js|mjs|cjs|ts)$/.test(f));
  if (nextConfig) {
    const content = await readFile(path.join(dir, nextConfig), "utf8").catch(() => "");
    if (/output\s*:\s*["']export["']/.test(content)) {
      notes.push(`${nextConfig} define output: "export" — build gera a pasta out/ (Next.js static export).`);
      return { outputDir: "out", notes };
    }
  }

  const deps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
  };
  if (deps["vite"]) {
    notes.push("Projeto Vite detectado — build gera a pasta dist/ por padrão.");
    return { outputDir: "dist", notes };
  }

  // Pasta de saída já presente no código (ex.: build commitado)
  for (const candidate of STATIC_OUTPUT_DIRS) {
    if (existsSync(path.join(dir, candidate, "index.html"))) {
      notes.push(`Pasta ${candidate}/ com index.html já presente no código.`);
      return { outputDir: candidate, notes };
    }
  }

  return { outputDir: null, notes };
}

async function findComposeFile(dir: string): Promise<string | null> {
  for (const candidate of COMPOSE_CANDIDATES) {
    if (existsSync(path.join(dir, candidate))) return candidate;
  }
  return null;
}

/** Analisa um diretório de código-fonte e classifica o tipo de projeto. */
export async function detectProject(dir: string): Promise<DetectResult> {
  const warnings: GuardrailWarning[] = [];
  const details: string[] = [];

  const result: DetectResult = {
    type: "unknown",
    composeFile: null,
    outputDir: null,
    packageManager: null,
    buildCommand: null,
    proxyService: null,
    proxyPort: null,
    warnings,
    details,
  };

  if (!existsSync(dir)) {
    details.push(`Diretório não encontrado: ${dir}`);
    return result;
  }

  // 1) Compose tem prioridade: o painel ADOTA o compose existente (trader).
  const composeFile = await findComposeFile(dir);
  if (composeFile) {
    result.type = "compose";
    result.composeFile = composeFile;
    details.push(`Arquivo ${composeFile} encontrado — o painel adota o compose existente sem reescrevê-lo.`);
    const content = await readFile(path.join(dir, composeFile), "utf8");
    try {
      warnings.push(...analyzeCompose(content, composeFile));
    } catch {
      warnings.push({
        id: "compose.invalid-yaml",
        severity: "critical",
        message: `Não foi possível interpretar ${composeFile} como YAML válido.`,
      });
      return result;
    }
    const guess = guessProxyTarget(content);
    result.proxyService = guess.service;
    result.proxyPort = guess.port;
    details.push(...guess.notes);
    const customNetworks = servicesWithCustomNetworks(content);
    if (customNetworks.length > 0) {
      warnings.push({
        id: "compose.custom-networks",
        severity: "info",
        message: `Serviços com redes próprias (${customNetworks.join(", ")}): verifique se o serviço web fica acessível na rede ${"paas-net"} após o override do painel.`,
      });
    }
    return result;
  }

  // 2) package.json com build → estático Node (bomb) ou Dockerfile (cacheta).
  const pkg = await readJson(path.join(dir, "package.json"));
  const hasDockerfile = existsSync(path.join(dir, "Dockerfile"));

  if (hasDockerfile && !pkg) {
    result.type = "dockerfile";
    details.push("Dockerfile encontrado sem package.json — pipeline docker build + run.");
    const expose = await readDockerfilePort(dir);
    result.proxyPort = expose;
    if (expose) details.push(`Porta ${expose} detectada via EXPOSE no Dockerfile.`);
    else details.push("Nenhuma porta EXPOSE no Dockerfile — informe a porta do proxy manualmente.");
    return result;
  }

  if (pkg) {
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    result.packageManager = await detectPackageManager(dir, pkg);
    if (typeof scripts.build === "string") {
      result.buildCommand = `${result.packageManager === "npm" ? "npm run" : result.packageManager} build`;
      const staticOut = await detectStaticOutput(dir, pkg);
      details.push(...staticOut.notes);
      if (staticOut.outputDir) {
        result.type = "static-node";
        result.outputDir = staticOut.outputDir;
        details.push(
          `Pipeline: build em container Node (${result.packageManager}) → servir ${staticOut.outputDir}/ como site estático.`,
        );
        return result;
      }
      if (!hasDockerfile) {
        // Fallback: build sem pistas de framework — assume dist/ (padrão Vite/CRA).
        result.type = "static-node";
        result.outputDir = "dist";
        details.push(
          "Nenhuma pista de framework (next.config/vite). Assumindo saída estática em dist/ — se o build gerar outra pasta (out/, build/), ajuste o código ou use Dockerfile.",
        );
        return result;
      }
      if (hasDockerfile) {
        result.type = "dockerfile";
        details.push("Build presente mas sem saída estática conhecida; Dockerfile encontrado — usando pipeline docker.");
        const expose = await readDockerfilePort(dir);
        result.proxyPort = expose;
        return result;
      }
    }
    details.push("package.json sem script de build.");
    return result;
  }

  // package.json ausente: Dockerfile sozinho já retornou acima — resta o caso
  // em que nada foi encontrado.
  details.push("Nenhum compose, package.json ou Dockerfile encontrado — configuração manual necessária.");
  return result;
}

/** Lê a primeira porta EXPOSE de um Dockerfile (heurística simples). */
async function readDockerfilePort(dir: string): Promise<number | null> {
  const content = await readFile(path.join(dir, "Dockerfile"), "utf8").catch(() => "");
  const match = /^\s*EXPOSE\s+(\d+)/im.exec(content);
  return match ? Number(match[1]) : null;
}
