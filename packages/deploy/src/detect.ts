/**
 * detect.ts — detecção automática do tipo de projeto a partir do código-fonte.
 *
 * Perfis (docs/internal/projects-analysis.md):
 *  - static:      HTML puro (index.html na raiz, sem build) — servido como está
 *  - static-node: package.json com build que gera pasta estática (bomb: Next export → out/)
 *  - compose:     tem arquivo compose (trader: compose.prod.yml → painel ADOTA)
 *  - dockerfile:  Dockerfile sem compose
 *  - node-server: servidor Node gerado pelo painel, sem Dockerfile (hoje: Next.js com
 *                 servidor — dependência `next` sem `output: "export"`)
 *  - unknown:     pede configuração manual
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { DetectResult, GuardrailWarning } from "@paas/core";
import { COMPOSE_CANDIDATES } from "./compose-files.js";
import { describeComposeServices } from "./compose-services.js";
import { analyzeCompose, guessProxyTarget, servicesWithCustomNetworks } from "./guardrails.js";
import {
  detectPackageManager,
  findNestedNextApps,
  inspectNextApp,
  looksLikeMonorepo,
  readPackageJson,
  type NextAppInfo,
  type PackageJson,
} from "./next-app.js";
import { NEXT_CONFIG_FILES, NEXT_CONFIG_MAX_CHARS, nextOutputOf } from "./next-config.js";
import { readRegularFileLimited } from "./safe-fs.js";

/** Teto de leitura de compose e Dockerfile na detecção. */
const TEXT_FILE_MAX_BYTES = 1024 * 1024;

/** Porta em que o servidor Next.js escuta por padrão (o painel a repassa ao container em PORT). */
export const NEXT_DEFAULT_PORT = 3000;

/** Pastas de saída estática conhecidas, em ordem de prioridade. */
const STATIC_OUTPUT_DIRS = ["out", "dist", "build"];

/**
 * Indica se o build gera site estático. Sinais:
 *  - next.config.* com output: "export" (gera out/)
 *  - dependência do vite (gera dist/)
 *  - pasta de saída já existente no código
 */
async function detectStaticOutput(
  dir: string,
  pkg: PackageJson,
): Promise<{ outputDir: string | null; notes: string[] }> {
  const notes: string[] = [];

  // Next.js static export → out/
  for (const name of NEXT_CONFIG_FILES) {
    if (!existsSync(path.join(dir, name))) continue;
    const content = (await readRegularFileLimited(path.join(dir, name), NEXT_CONFIG_MAX_CHARS)) ?? "";
    if (nextOutputOf(content) === "export") {
      notes.push(`${name} define output: "export" — build gera a pasta out/ (Next.js static export).`);
      return { outputDir: "out", notes };
    }
    break;
  }

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
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
async function hasRootIndexHtml(dir: string): Promise<boolean> {
  return existsSync(path.join(dir, "index.html"));
}

/** HTML puro: servido como está, sem build (o primeiro teste de quase todo iniciante). */
function staticSite(result: DetectResult, details: string[]): DetectResult {
  result.type = "static";
  details.push(
    "index.html na raiz e nenhum build — site estático: os arquivos vão para o ar como estão " +
      "(sem .git, .env nem outros arquivos ocultos).",
  );
  return result;
}

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
    if (composeFile.startsWith("compose.paas.")) {
      details.push("É o compose feito para o painel: tem prioridade sobre o de produção comum.");
    }
    const content = await readRegularFileLimited(path.join(dir, composeFile), TEXT_FILE_MAX_BYTES);
    if (content === undefined) {
      warnings.push({
        id: "compose.unreadable",
        severity: "critical",
        message: `Não foi possível ler ${composeFile}: precisa ser um arquivo comum (não um link) de até 1 MB.`,
      });
      return result;
    }
    try {
      warnings.push(...analyzeCompose(content, composeFile, dir));
    } catch {
      warnings.push({
        id: "compose.invalid-yaml",
        severity: "critical",
        message: `Não foi possível interpretar ${composeFile} como YAML válido.`,
      });
      return result;
    }
    // Todos os serviços (o painel mostra o que sobe, não só a entrada HTTP).
    result.services = await describeComposeServices(dir, content);
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
  const pkg = await readPackageJson(dir);
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
    const scripts = pkg.scripts ?? {};
    result.packageManager = detectPackageManager(dir, pkg);

    // Next.js com servidor (SSR, rotas de API, middleware, ISR, imagens): o painel gera o
    // Dockerfile. Dockerfile ou compose do usuário continuam com prioridade (acima e abaixo).
    const next = await inspectNextApp(dir, pkg);
    if (next?.hasNext && next.output !== "export" && !hasDockerfile) {
      return nodeServerResult(result, next);
    }

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
        await noteNestedNext(dir, pkg, details);
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
    if (await hasRootIndexHtml(dir)) return staticSite(result, details);
    details.push("package.json sem script de build.");
    await noteNestedNext(dir, pkg, details);
    return result;
  }

  if (await hasRootIndexHtml(dir)) return staticSite(result, details);

  // package.json ausente: Dockerfile sozinho já retornou acima — resta o caso
  // em que nada foi encontrado.
  details.push("Nenhum compose, package.json ou Dockerfile encontrado — configuração manual necessária.");
  return result;
}

/** Servidor Node (Next.js) gerado pelo painel: preenche o resultado e explica o que será feito. */
function nodeServerResult(result: DetectResult, next: NextAppInfo): DetectResult {
  const { details } = result;
  const pm = next.packageManager;
  result.type = "node-server";
  result.packageManager = pm;
  result.proxyPort = NEXT_DEFAULT_PORT;
  result.buildCommand = next.hasBuildScript ? `${pm === "npm" ? "npm run" : pm} build` : "next build";
  result.nodeServer = {
    framework: "next",
    standalone: next.output === "standalone",
    nodeMajor: next.nodeMajor,
    nodeSource: next.nodeSource,
    lockfile: next.lockfile !== null,
  };
  details.push(
    `Next.js com servidor (sem output: "export"): o painel gera o Dockerfile (fora do seu repositório), constrói a imagem e roda o servidor na porta ${NEXT_DEFAULT_PORT}.`,
  );
  details.push(
    next.output === "standalone"
      ? `${next.configFile} define output: "standalone" — imagem final mínima, roda "node server.js".`
      : 'Sem output: "standalone": o servidor roda com "next start" e a imagem leva o projeto inteiro. Para uma imagem bem menor, ' +
          "acrescente output: \"standalone\" ao next.config.",
  );
  if (next.output === "dynamic") {
    details.push(
      `O output do ${next.configFile} é uma expressão: o painel não executa o arquivo e a tratou como servidor comum. ` +
        'Se ela resulta em "export", o site é estático — escreva o valor direto no arquivo.',
    );
  }
  details.push(...next.notes);
  if (next.lockfile) {
    details.push(`Instalação congelada pelo ${next.lockfile} (${pm}).`);
  } else {
    details.push(
      `Sem lockfile do ${pm}: a instalação das dependências não é reproduzível (cada deploy pode trazer versões novas). Commite o lockfile.`,
    );
  }
  return result;
}

/** Monorepo com Next.js em subpasta: o painel só publica Next.js na raiz do repositório. */
async function noteNestedNext(dir: string, pkg: PackageJson, details: string[]): Promise<void> {
  if (!looksLikeMonorepo(dir, pkg)) return;
  const nested = await findNestedNextApps(dir);
  if (nested.length === 0) return;
  details.push(
    `Monorepo: há Next.js em ${nested.join(", ")}. O painel só publica Next.js na raiz do repositório; ` +
      "para um app em subpasta use um Dockerfile ou compose seu (veja o guia de Next.js).",
  );
}

/** Lê a primeira porta EXPOSE de um Dockerfile (heurística simples). */
async function readDockerfilePort(dir: string): Promise<number | null> {
  const content = (await readRegularFileLimited(path.join(dir, "Dockerfile"), TEXT_FILE_MAX_BYTES)) ?? "";
  const match = /^\s*EXPOSE\s+(\d+)/im.exec(content);
  return match ? Number(match[1]) : null;
}
