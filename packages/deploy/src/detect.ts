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
import { CHOOSABLE_PROJECT_TYPES, type DetectResult, type ProjectType } from "@paas/core";
import { COMPOSE_CANDIDATES } from "./compose-files.js";
import { dockerfileExposePort, readDockerfileText } from "./dockerfile.js";
import { describeComposeServices } from "./compose-services.js";
import { analyzeCompose, guessProxyTarget, servicesWithCustomNetworks } from "./guardrails.js";
import {
  detectPackageManager,
  findNestedNextApps,
  inspectNextApp,
  looksLikeMonorepo,
  PACKAGE_JSON_MAX_BYTES,
  readPackageJson,
  type NextAppInfo,
  type PackageJson,
} from "./next-app.js";
import { NEXT_CONFIG_FILES, NEXT_CONFIG_MAX_CHARS, nextOutputOf } from "./next-config.js";
import { oversizeOf, readRegularFileLimited } from "./safe-fs.js";

/** Teto de leitura de compose e Dockerfile na detecção. */
const TEXT_FILE_MAX_BYTES = 1024 * 1024;

/** Porta em que o servidor Next.js escuta por padrão (o painel a repassa ao container em PORT). */
export const NEXT_DEFAULT_PORT = 3000;

/** Pastas de saída estática conhecidas, em ordem de prioridade. */
const STATIC_OUTPUT_DIRS = ["out", "dist", "build"];

/** O que na raiz indica um app de servidor (que não deveria ser publicado como pasta de arquivos). */
async function serverSideFiles(dir: string, hasDockerfile: boolean, composeFile: string | null): Promise<string[]> {
  const found: string[] = [];
  if (hasDockerfile) found.push("Dockerfile");
  if (composeFile) found.push(composeFile);
  const entries = await readdir(dir);
  if (entries.includes("package.json")) found.push("package.json");
  const php = entries.filter((name) => /\.php$/i.test(name)).sort();
  if (php.length > 0) found.push(php.slice(0, 3).join(", "));
  return found;
}

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

/**
 * Arquivo do código acima do que o painel lê por inteiro (compose e package.json: 1 MB; next.config:
 * 256 KB). Lido cortado viraria YAML/JSON inválido: a detecção e o deploy param com esta mensagem.
 */
export async function sourceFileTooLarge(
  dir: string,
  opts: { composeFile?: string | null; node?: boolean } = {},
): Promise<string | null> {
  const checks: Array<[string, number, string]> = [];
  if (opts.composeFile) checks.push([opts.composeFile, TEXT_FILE_MAX_BYTES, "1 MB"]);
  if (opts.node) {
    checks.push(["package.json", PACKAGE_JSON_MAX_BYTES, "1 MB"]);
    for (const name of NEXT_CONFIG_FILES) checks.push([name, NEXT_CONFIG_MAX_CHARS, "256 KB"]);
  }
  for (const [name, max, label] of checks) {
    if ((await oversizeOf(path.join(dir, name), max)) !== null) {
      return `${name} maior que ${label}: o painel não lê arquivos desse tamanho. Reduza o arquivo (ou tire o que não é configuração dele) e tente de novo.`;
    }
  }
  return null;
}

export interface DetectOptions {
  /** Tipo escolhido à mão (sobrepõe a detecção, depois de validado contra o código). */
  forceType?: ProjectType | null;
  /** Valores das Variáveis salvas do projeto: só conferem credencial fraca no compose; nunca saem. */
  variables?: Readonly<Record<string, string>>;
}

/** O tipo escolhido à mão não combina com o código da pasta (a mensagem diz o que falta). */
export class ForcedTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForcedTypeError";
  }
}

function emptyResult(): DetectResult {
  return {
    type: "unknown",
    composeFile: null,
    outputDir: null,
    packageManager: null,
    buildCommand: null,
    proxyService: null,
    proxyPort: null,
    warnings: [],
    details: [],
  };
}

/** Bibliotecas de interface e empacotadores que, juntos e sem servidor, indicam uma aplicação de página única. */
const SPA_LIBRARIES = ["react", "vue", "svelte", "preact", "solid-js"];
const SPA_BUNDLERS = ["vite", "react-scripts", "@vue/cli-service", "parcel"];
/** Quem renderiza no servidor (ou gera uma página por rota): não é uma página única. */
const SERVER_RENDERED = ["next", "nuxt", "nuxt3", "@sveltejs/kit", "@remix-run/node", "@remix-run/serve", "astro", "gatsby", "@tanstack/start"];

/** Vite/React/Vue/Svelte (ou similares) sem renderização no servidor: o nginx precisa do fallback para o index.html. */
export function looksLikeSpa(pkg: PackageJson): boolean {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const has = (names: string[]) => names.some((n) => deps[n] !== undefined);
  return has(SPA_BUNDLERS) && has(SPA_LIBRARIES) && !has(SERVER_RENDERED);
}

export async function detectProject(dir: string, opts: DetectOptions = {}): Promise<DetectResult> {
  const wanted = opts.forceType;
  if (wanted && !CHOOSABLE_PROJECT_TYPES.includes(wanted)) {
    throw new ForcedTypeError(`O tipo "${wanted}" não pode ser escolhido à mão.`);
  }
  const natural = await detectAutomatically(dir, opts);
  if (!wanted) return natural;
  if (wanted === natural.type) return { ...natural, chosenType: true, detectedType: natural.type };
  const forced = await detectForced(dir, wanted, opts);
  forced.chosenType = true;
  forced.detectedType = natural.type;
  forced.details.unshift(
    `Tipo escolhido por você: ${wanted}` + (natural.type === "unknown" ? "." : ` (a detecção automática diria ${natural.type}).`),
  );
  return forced;
}

/** Compose adotado: serviços, serviço/porta do proxy e avisos. Compose ilegível ou inválido vira aviso crítico. */
async function composeResult(dir: string, composeFile: string, result: DetectResult, opts: DetectOptions): Promise<void> {
  const { warnings, details } = result;
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
    return;
  }
  try {
    warnings.push(...analyzeCompose(content, composeFile, dir, opts.variables));
  } catch {
    warnings.push({
      id: "compose.invalid-yaml",
      severity: "critical",
      message: `Não foi possível interpretar ${composeFile} como YAML válido.`,
    });
    return;
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
}

/** Dockerfile do usuário: build da imagem e porta do EXPOSE do estágio final. */
async function dockerfileResult(dir: string, result: DetectResult, why: string): Promise<DetectResult> {
  result.type = "dockerfile";
  result.details.push(why);
  const expose = await readDockerfilePort(dir);
  result.proxyPort = expose;
  if (expose) result.details.push(`Porta ${expose} detectada via EXPOSE no Dockerfile (imagem final).`);
  else result.details.push("Nenhuma porta EXPOSE no Dockerfile — informe a porta do proxy manualmente.");
  return result;
}

/** Build em container Node cuja saída é uma pasta estática (pasta de saída conhecida ou, sem pistas, dist/). */
async function staticNodeResult(
  dir: string,
  pkg: PackageJson,
  result: DetectResult,
  staticOut: { outputDir: string | null; notes: string[] },
): Promise<DetectResult> {
  result.type = "static-node";
  result.details.push(...staticOut.notes);
  if (staticOut.outputDir) {
    result.outputDir = staticOut.outputDir;
    result.details.push(
      `Pipeline: build em container Node (${result.packageManager}) → servir ${staticOut.outputDir}/ como site estático.`,
    );
  } else {
    // Fallback: build sem pistas de framework — assume dist/ (padrão Vite/CRA).
    await noteNestedNext(dir, pkg, result.details);
    result.outputDir = "dist";
    result.details.push(
      "Nenhuma pista de framework (next.config/vite). Assumindo saída estática em dist/ — se o build gerar outra pasta (out/, build/), ajuste o código ou use Dockerfile.",
    );
  }
  if (looksLikeSpa(pkg)) {
    result.spaSuggested = true;
    result.details.push(
      "Parece uma aplicação de página única (front-end sem servidor): ligue \"Aplicação de página única\" para que um link direto como /painel abra o site em vez de dar 404.",
    );
  }
  return result;
}

async function detectAutomatically(dir: string, opts: DetectOptions): Promise<DetectResult> {
  const result = emptyResult();
  const { warnings, details } = result;

  if (!existsSync(dir)) {
    details.push(`Diretório não encontrado: ${dir}`);
    return result;
  }

  // 1) Compose tem prioridade: o painel ADOTA o compose existente (trader).
  const composeFile = await findComposeFile(dir);
  // com Dockerfile o painel não lê package.json/next.config: só bloqueia o que ele de fato leria
  const tooLarge = await sourceFileTooLarge(dir, {
    composeFile,
    node: !composeFile && !existsSync(path.join(dir, "Dockerfile")),
  });
  if (tooLarge) {
    warnings.push({ id: "source.too-large", severity: "critical", message: tooLarge });
    return result;
  }
  if (composeFile) {
    await composeResult(dir, composeFile, result, opts);
    return result;
  }

  // 2) package.json com build → estático Node (bomb) ou Dockerfile (cacheta).
  const pkg = await readPackageJson(dir);
  const hasDockerfile = existsSync(path.join(dir, "Dockerfile"));

  if (hasDockerfile && !pkg) {
    return dockerfileResult(dir, result, "Dockerfile encontrado sem package.json — pipeline docker build + run.");
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

    const hasBuild = typeof scripts.build === "string";
    if (hasBuild) result.buildCommand = `${result.packageManager === "npm" ? "npm run" : result.packageManager} build`;
    const staticOut = hasBuild ? await detectStaticOutput(dir, pkg) : null;

    // Dockerfile no repositório: é o que o dono escreveu para este projeto e tem prioridade sobre qualquer
    // pista de site estático (Vite, Next export, pasta de saída commitada) e sobre a falta de script de build.
    if (hasDockerfile) {
      if (staticOut?.outputDir) {
        warnings.push({
          id: "detect.dockerfile-priority",
          severity: "warning",
          message:
            `O projeto parece um site estático (saída ${staticOut.outputDir}/), mas tem um Dockerfile: o painel usa o seu Dockerfile ` +
            "(build da imagem e container). Para publicar como site estático sem Docker, escolha o tipo \"Site estático com build\" no assistente.",
        });
        details.push(...staticOut.notes);
      }
      return dockerfileResult(
        dir,
        result,
        hasBuild
          ? "Dockerfile encontrado — pipeline docker build + run (o Dockerfile tem prioridade)."
          : "package.json sem script de build e Dockerfile encontrado — pipeline docker build + run.",
      );
    }

    if (hasBuild) return staticNodeResult(dir, pkg, result, staticOut!);
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

/** Monta o resultado do tipo escolhido à mão, ou explica (ForcedTypeError) o que falta no código. */
async function detectForced(dir: string, type: ProjectType, opts: DetectOptions): Promise<DetectResult> {
  if (!existsSync(dir)) throw new ForcedTypeError(`Diretório não encontrado: ${dir}`);
  const composeFile = await findComposeFile(dir);
  const hasDockerfile = existsSync(path.join(dir, "Dockerfile"));
  const tooLarge = await sourceFileTooLarge(dir, {
    composeFile: type === "compose" ? composeFile : null,
    node: type === "static-node" || type === "node-server",
  });
  if (tooLarge) throw new ForcedTypeError(tooLarge);
  const result = emptyResult();
  switch (type) {
    case "compose":
      if (!composeFile) throw new ForcedTypeError("Não há arquivo compose (compose.yml, docker-compose.yml...) na raiz do projeto.");
      await composeResult(dir, composeFile, result, opts);
      return result;
    case "dockerfile":
      if (!hasDockerfile) throw new ForcedTypeError("Não há Dockerfile na raiz do projeto.");
      return dockerfileResult(dir, result, "Dockerfile encontrado — pipeline docker build + run.");
    case "static":
      if (!(await hasRootIndexHtml(dir))) throw new ForcedTypeError("Não há index.html na raiz do projeto: um site estático sem build precisa dele.");
      {
        const server = await serverSideFiles(dir, hasDockerfile, composeFile);
        if (server.length > 0) {
          result.warnings.push({
            id: "detect.static-publishes-server-files",
            severity: "critical",
            message:
              `Este código tem arquivos de servidor na raiz (${server.join(", ")}). Como site estático, TODOS os arquivos não ocultos da pasta ` +
              "ficam públicos e são entregues como texto (código, configurações, dados). Só escolha este tipo se a pasta inteira puder ser pública.",
          });
        }
      }
      return staticSite(result, result.details);
    case "static-node": {
      const pkg = await readPackageJson(dir);
      if (typeof pkg?.scripts?.build !== "string") {
        throw new ForcedTypeError("O package.json não tem o script \"build\": sem ele não há o que construir para publicar como site estático.");
      }
      result.packageManager = detectPackageManager(dir, pkg);
      result.buildCommand = `${result.packageManager === "npm" ? "npm run" : result.packageManager} build`;
      return staticNodeResult(dir, pkg, result, await detectStaticOutput(dir, pkg));
    }
    default: {
      // node-server
      const pkg = await readPackageJson(dir);
      const next = pkg ? await inspectNextApp(dir, pkg) : null;
      if (!next?.hasNext) throw new ForcedTypeError("O package.json não tem a dependência next: o painel só gera servidor para Next.js.");
      if (next.output === "export") {
        throw new ForcedTypeError('O next.config usa output: "export" (site estático): escolha "Site estático com build".');
      }
      return nodeServerResult(result, next);
    }
  }
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

/** Porta do EXPOSE do último estágio do Dockerfile (a imagem final), ou null. */
async function readDockerfilePort(dir: string): Promise<number | null> {
  return dockerfileExposePort((await readDockerfileText(dir)) ?? "");
}
