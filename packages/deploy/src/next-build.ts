/**
 * next-build.ts — a imagem de um projeto Next.js com servidor (type=node-server).
 *
 * O painel GERA o Dockerfile (fora do código do usuário, na pasta de trabalho
 * do projeto) e o passa ao `docker build -f`. Nada é gravado no repositório.
 * Este arquivo só produz TEXTO e argumentos: nenhuma chamada ao Docker, então
 * tudo é testável sem Docker (o engine só executa o que sai daqui).
 *
 * Decisões (ver comoFuncionaSistema/projetos/conceito-next-servidor.json):
 *  - multi-stage: `build` (instala com lockfile congelado e roda `next build`)
 *    e `run` (imagem final mínima, usuário `node`, sem root);
 *  - standalone: `node server.js` com .next/standalone + .next/static + public;
 *    sem standalone: `next start` com o projeto construído;
 *  - NEXT_PUBLIC_* entram no build como ARG (são embutidas no bundle, públicas
 *    por definição, e precisam fazer parte da chave de cache do BuildKit);
 *  - as demais variáveis chegam ao `next build` por um SEGREDO do BuildKit
 *    (`--secret`, montado só durante aquele RUN): não ficam em camada nenhuma;
 *  - NODE_OPTIONS=--max-old-space-size só existe no estágio de build;
 *  - cache de dependências por projeto (`--mount=type=cache`) com id IMPREVISÍVEL
 *    (chave aleatória guardada na pasta de trabalho do projeto): o id de cache
 *    do BuildKit é global no daemon, e um id adivinhável deixaria o Dockerfile de
 *    outro projeto ler ou envenenar o cache;
 *  - imagem final com o código de propriedade de root (somente leitura para o
 *    processo); só `.next/cache` é gravável pelo usuário `node`.
 */
import { createHmac, randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { NODE_SERVER_IMAGES, type NodeMajor, type PackageManager } from "@paas/core";
import { readRegularFileLimited, writeFileNoFollow } from "./safe-fs.js";

// ---------------------------------------------------------------------------
// Variáveis
// ---------------------------------------------------------------------------

const PUBLIC_NAME = /^NEXT_PUBLIC_[A-Za-z0-9_]{1,100}$/;
export const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Valor maior que isto não vai ao build (um segredo legítimo é curto; PEM e JSON de serviço cabem). */
export const BUILD_VAR_MAX_CHARS = 32 * 1024;
/** No máximo estas NEXT_PUBLIC_ no build (cada uma vira um ARG). */
export const MAX_PUBLIC_VARS = 100;

/**
 * Nomes que o painel (ou o Next.js) define e que uma variável do usuário não
 * pode alterar no build: mudariam o ambiente do `next build` ou do shell.
 */
export const RESERVED_BUILD_NAMES = new Set([
  "PATH", "HOME", "USER", "SHELL", "PWD", "OLDPWD", "IFS", "ENV", "BASH_ENV", "PS1", "TERM", "SHLVL", "_",
  "NODE_ENV", "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED",
  "PORT", "HOSTNAME", "NEXT_TELEMETRY_DISABLED", "CI", "COREPACK_HOME", "PAAS_BUILD_ENV_HASH",
]);

export const RESERVED_PREFIXES = ["LD_", "DYLD_", "npm_", "NPM_CONFIG_", "YARN_", "PNPM_", "COREPACK_", "BASH_FUNC_"];

export interface BuildVars {
  /** NEXT_PUBLIC_*: vão ao build como ARG (públicas por definição). */
  publicVars: Record<string, string>;
  /** As demais: vão ao `next build` por segredo do BuildKit. */
  secretVars: Record<string, string>;
  /** Nomes que NÃO entram no build (reservados, inválidos ou grandes demais), só para o log. */
  skipped: string[];
}

/** Separa as variáveis do projeto em públicas (NEXT_PUBLIC_), de segredo e as que ficam de fora do build. */
export function splitBuildVars(vars: Record<string, string>): BuildVars {
  const publicVars: Record<string, string> = {};
  const secretVars: Record<string, string> = {};
  const skipped: string[] = [];
  for (const name of Object.keys(vars).sort()) {
    const value = vars[name]!;
    if (PUBLIC_NAME.test(name)) {
      if (value.length > BUILD_VAR_MAX_CHARS || Object.keys(publicVars).length >= MAX_PUBLIC_VARS) skipped.push(name);
      else publicVars[name] = value;
    } else if (
      !SHELL_NAME.test(name) ||
      name.startsWith("NEXT_PUBLIC_") ||
      RESERVED_BUILD_NAMES.has(name) ||
      RESERVED_PREFIXES.some((p) => name.startsWith(p)) ||
      value.length > BUILD_VAR_MAX_CHARS
    ) {
      skipped.push(name);
    } else {
      secretVars[name] = value;
    }
  }
  return { publicVars, secretVars, skipped };
}

/** `export NOME='valor'` por linha, escapando aspas simples; NUL sai (truncaria o valor no shell). */
export function renderSecretEnv(secretVars: Record<string, string>): string {
  return Object.entries(secretVars)
    .map(([name, value]) => `export ${name}='${value.replace(/\0/g, "").replace(/'/g, "'\\''")}'\n`)
    .join("");
}

/**
 * Impressão curta do conteúdo do segredo: entra no build como ARG só para invalidar o cache quando ele
 * muda. É um HMAC com a chave do projeto (não um sha256 solto): quem lê o cache ou o histórico do build
 * não consegue testar palpites de um segredo fraco contra ela.
 */
export function secretFingerprint(content: string, key: string): string {
  return createHmac("sha256", key).update(content).digest("hex").slice(0, 16);
}

const CACHE_KEY_FILE = "paas.next.cache-key";
const CACHE_KEY = /^[0-9a-f]{32}$/;

/**
 * Chave aleatória do projeto (32 hex), guardada na pasta de trabalho do painel (0600, fora do código do
 * usuário). Nomeia o cache de dependências e assina a impressão do segredo. Nasce no primeiro build e
 * acompanha o projeto; some junto com a pasta dele.
 */
export async function projectBuildKey(workDir: string): Promise<string> {
  const file = path.join(workDir, CACHE_KEY_FILE);
  const current = (await readRegularFileLimited(file, 64))?.trim();
  if (current !== undefined && CACHE_KEY.test(current)) return current;
  const key = randomBytes(16).toString("hex");
  await mkdir(workDir, { recursive: true });
  await writeFileNoFollow(file, `${key}\n`, 0o600);
  return key;
}

// ---------------------------------------------------------------------------
// Memória
// ---------------------------------------------------------------------------

/** Piso do heap do `next build` (abaixo disso o Next.js quase sempre estoura). */
export const NEXT_HEAP_MIN_MB = 768;
/** Teto: acima de 4 GB o ganho some e o build passa a disputar a VPS inteira. */
export const NEXT_HEAP_MAX_MB = 4096;

/** `--max-old-space-size` (MB) do build: 60% da RAM do servidor, entre o piso e o teto. */
export function nextHeapMb(totalMemBytes: number): number {
  const mb = Math.round((totalMemBytes / (1024 * 1024)) * 0.6);
  if (!Number.isFinite(mb)) return NEXT_HEAP_MIN_MB;
  return Math.min(NEXT_HEAP_MAX_MB, Math.max(NEXT_HEAP_MIN_MB, mb));
}

// ---------------------------------------------------------------------------
// Dockerfile
// ---------------------------------------------------------------------------

export interface NextDockerfileSpec {
  /** Slug do projeto (já validado pelo painel): aparece no nome do cache de dependências. */
  slug: string;
  /** Chave aleatória do projeto (projectBuildKey): torna o id do cache imprevisível. */
  cacheKey: string;
  nodeMajor: NodeMajor;
  packageManager: PackageManager;
  yarnBerry: boolean;
  /** Existe lockfile: instalação congelada. */
  lockfile: boolean;
  standalone: boolean;
  /** package.json tem script `build` (senão roda `next build` direto). */
  hasBuildScript: boolean;
  /** Heap do `next build`, em MB. */
  heapMb: number;
  /** Nomes das NEXT_PUBLIC_ que entram como ARG. */
  publicNames: string[];
  port: number;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

interface InstallPlan {
  /** Linhas ENV/RUN de preparo do gerenciador (corepack). */
  prepare: string[];
  env: string[];
  cacheId: string;
  cacheTarget: string;
  command: string;
}

function installPlan(spec: NextDockerfileSpec): InstallPlan {
  const id = `paas-${spec.slug}-${spec.packageManager}-${spec.cacheKey}`;
  switch (spec.packageManager) {
    case "pnpm":
      return {
        prepare: ["RUN corepack enable"],
        env: ["npm_config_store_dir=/pnpm-store"],
        cacheId: id,
        cacheTarget: "/pnpm-store",
        command: spec.lockfile ? "pnpm install --frozen-lockfile" : "pnpm install",
      };
    case "yarn":
      return {
        prepare: ["RUN corepack enable"],
        env: ["YARN_CACHE_FOLDER=/yarn-cache"],
        cacheId: id,
        cacheTarget: "/yarn-cache",
        command: !spec.lockfile ? "yarn install" : spec.yarnBerry ? "yarn install --immutable" : "yarn install --frozen-lockfile",
      };
    case "npm":
      return {
        prepare: [],
        env: [],
        cacheId: id,
        cacheTarget: "/root/.npm",
        command: spec.lockfile ? "npm ci --no-audit --no-fund" : "npm install --no-audit --no-fund",
      };
  }
}

function buildCommand(spec: NextDockerfileSpec): string {
  if (!spec.hasBuildScript) return "./node_modules/.bin/next build";
  return spec.packageManager === "npm" ? "npm run build" : `${spec.packageManager} run build`;
}

/** Marcador que o painel procura no log para explicar o erro (ver explainBuildFailure). */
export const STANDALONE_MISSING_MARK = "nao gerou .next/standalone/server.js";

export const NEXT_DOCKERFILE_NAME = "paas.next.Dockerfile";

/** O Dockerfile do Next.js com servidor. Lança se a especificação tiver algo fora do formato esperado (injeção). */
export function renderNextDockerfile(spec: NextDockerfileSpec): string {
  if (!SLUG.test(spec.slug)) throw new Error(`slug inválido para o Dockerfile gerado: ${JSON.stringify(spec.slug)}`);
  const image = NODE_SERVER_IMAGES[spec.nodeMajor];
  if (!image) throw new Error(`Node ${String(spec.nodeMajor)} não tem imagem no painel.`);
  if (!CACHE_KEY.test(spec.cacheKey)) throw new Error("chave de cache inválida para o Dockerfile gerado.");
  if (!Number.isInteger(spec.heapMb) || spec.heapMb < 128 || spec.heapMb > 65536) throw new Error("heap do build inválido.");
  if (!Number.isInteger(spec.port) || spec.port < 1 || spec.port > 65535) throw new Error("porta inválida para o Dockerfile gerado.");
  for (const name of spec.publicNames) {
    if (!PUBLIC_NAME.test(name)) throw new Error(`nome de variável pública inválido: ${JSON.stringify(name)}`);
  }

  const install = installPlan(spec);
  const lines: string[] = [
    "# Gerado pelo TWS Panel a cada deploy — NÃO é gravado no seu repositório e não deve ser editado.",
    "# Para controlar a imagem você mesmo, coloque um Dockerfile (ou compose) na raiz do projeto: ele tem prioridade.",
    "",
    "# ---------- build ----------",
    `FROM ${image} AS build`,
    "WORKDIR /app",
    "ENV NEXT_TELEMETRY_DISABLED=1 CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0" + install.env.map((e) => ` ${e}`).join(""),
    ...install.prepare,
    "COPY . .",
    `RUN --mount=type=cache,id=${install.cacheId},target=${install.cacheTarget} ${install.command}`,
  ];
  // NEXT_PUBLIC_*: argumentos de build (públicos por definição; fazem parte da chave de cache)
  for (const name of [...spec.publicNames].sort()) lines.push(`ARG ${name}`, `ENV ${name}=$${name}`);
  lines.push(
    // muda quando o conteúdo do segredo muda, sem revelá-lo: o BuildKit não considera segredos na chave de cache
    "ARG PAAS_BUILD_ENV_HASH",
    "ENV PAAS_BUILD_ENV_HASH=$PAAS_BUILD_ENV_HASH",
    `ENV NODE_OPTIONS=--max-old-space-size=${spec.heapMb}`,
    `RUN --mount=type=secret,id=paasenv set -a && . /run/secrets/paasenv && set +a && ${buildCommand(spec)}`,
    "RUN mkdir -p public",
  );
  if (spec.standalone) {
    lines.push(
      `RUN test -f .next/standalone/server.js || { echo "[TWS Panel] O next.config pede output standalone, mas o build ${STANDALONE_MISSING_MARK} (em monorepo o caminho muda). Use um Dockerfile proprio." >&2; exit 1; }`,
    );
  }
  // o processo final é o usuário `node`: tudo que ele precisa ler tem de ser legível (arquivo 0600 do repositório)
  lines.push("RUN chmod -R a+rX /app");
  lines.push(
    "",
    "# ---------- run (imagem final mínima, sem root) ----------",
    `FROM ${image} AS run`,
    "WORKDIR /app",
    `ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=${spec.port}`,
  );
  if (spec.standalone) {
    lines.push(
      "COPY --from=build /app/.next/standalone ./",
      "COPY --from=build /app/.next/static ./.next/static",
      "COPY --from=build /app/public ./public",
    );
  } else {
    lines.push("COPY --from=build /app ./");
  }
  lines.push(
    // o código fica de root (somente leitura para o processo); só o cache do Next.js (imagens) é gravável
    "RUN mkdir -p .next/cache && chown -R node:node .next/cache",
    "USER node",
    `EXPOSE ${spec.port}`,
    `HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node","-e","fetch('http://127.0.0.1:'+(process.env.PORT||${spec.port}),{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]`,
    spec.standalone
      ? 'CMD ["node","server.js"]'
      : 'CMD ["node","node_modules/next/dist/bin/next","start","-H","0.0.0.0"]',
    "",
  );
  return lines.join("\n");
}

/** `.dockerignore` ao lado do Dockerfile gerado (vale no lugar do .dockerignore do repositório). */
export const NEXT_DOCKERIGNORE = [
  "# Gerado pelo TWS Panel",
  ".git",
  "**/.git",
  "node_modules",
  "**/node_modules",
  ".next",
  "**/.next",
  // arquivos .env do repositório (e o que o painel gravou) nunca entram no build: as variáveis
  // vêm das Variáveis do projeto (NEXT_PUBLIC_ como argumento, o resto como segredo)
  ".env",
  "**/.env",
  ".env.*",
  "**/.env.*",
  "*.log",
  ".DS_Store",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// docker build
// ---------------------------------------------------------------------------

export interface NextBuildArgsInput {
  image: string;
  slug: string;
  dockerfile: string;
  secretFile: string;
  context: string;
  publicVars: Record<string, string>;
  fingerprint: string;
}

/** Argumentos do `docker build` (sem shell: cada item é um argv). */
export function nextBuildArgs(input: NextBuildArgsInput): string[] {
  return [
    "build",
    "--progress=plain",
    "-f",
    input.dockerfile,
    "-t",
    input.image,
    "--label",
    "paas.managed=true",
    "--label",
    `paas.project=${input.slug}`,
    "--secret",
    `id=paasenv,src=${input.secretFile}`,
    ...Object.entries(input.publicVars).flatMap(([name, value]) => ["--build-arg", `${name}=${value}`]),
    "--build-arg",
    `PAAS_BUILD_ENV_HASH=${input.fingerprint}`,
    input.context,
  ];
}

export interface PreparedNextBuild {
  args: string[];
  /** Heap do `next build` em MB (para explicar uma falta de memória). */
  heapMb: number;
  dockerfile: string;
  /** Apaga o arquivo do segredo (chamar sempre, com sucesso ou erro). */
  cleanup: () => Promise<void>;
  /** Linhas para o log do deploy (só NOMES de variáveis, nunca valores). */
  notes: string[];
}

export interface PrepareNextBuildInput extends Omit<NextDockerfileSpec, "publicNames" | "heapMb" | "cacheKey"> {
  workDir: string;
  src: string;
  image: string;
  /** Variáveis do projeto (as do painel, incluindo as do e-mail). */
  vars: Record<string, string>;
  /** RAM total do servidor, em bytes (define o heap do build). */
  totalMemBytes: number;
}

function inside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Grava, na pasta de trabalho do painel (NUNCA dentro de `src`), o Dockerfile
 * gerado, o `.dockerignore` e o arquivo do segredo (0600), e monta o argv.
 */
export async function prepareNextBuild(input: PrepareNextBuildInput): Promise<PreparedNextBuild> {
  const dockerfile = path.join(input.workDir, NEXT_DOCKERFILE_NAME);
  const secretFile = path.join(input.workDir, "paas.next.build.env");
  for (const file of [dockerfile, secretFile, `${dockerfile}.dockerignore`]) {
    if (inside(input.src, file)) {
      throw new Error("A pasta de trabalho do painel fica dentro do código do projeto: o Dockerfile gerado não pode ser gravado ali.");
    }
  }
  const { publicVars, secretVars, skipped } = splitBuildVars(input.vars);
  const heapMb = nextHeapMb(input.totalMemBytes);
  const cacheKey = await projectBuildKey(input.workDir);
  const text = renderNextDockerfile({ ...input, cacheKey, publicNames: Object.keys(publicVars), heapMb });
  const secret = renderSecretEnv(secretVars);

  await mkdir(input.workDir, { recursive: true });
  await writeFileNoFollow(dockerfile, text, 0o644);
  await writeFileNoFollow(`${dockerfile}.dockerignore`, NEXT_DOCKERIGNORE, 0o644);
  await writeFileNoFollow(secretFile, secret, 0o600);

  const notes = [
    `Heap do next build: ${heapMb} MB POR PROCESSO (--max-old-space-size, 60% da RAM do servidor; mínimo ${NEXT_HEAP_MIN_MB}, máximo ${NEXT_HEAP_MAX_MB}). O Next.js usa vários processos no build: não é um teto de memória total.`,
  ];
  const publicNames = Object.keys(publicVars);
  notes.push(
    publicNames.length > 0
      ? `NEXT_PUBLIC_ no build (ficam embutidas no JavaScript do site, públicas por definição): ${publicNames.join(", ")}.`
      : "Nenhuma NEXT_PUBLIC_ nas Variáveis do projeto: o site é construído sem elas.",
  );
  const secretNames = Object.keys(secretVars);
  if (secretNames.length > 0) {
    notes.push(
      `Variáveis disponíveis ao next build por segredo do BuildKit (não entram em camada nenhuma da imagem): ${secretNames.join(", ")}.`,
    );
  }
  if (skipped.length > 0) notes.push(`Fora do build (nome reservado, inválido ou valor grande demais; seguem só na execução): ${skipped.join(", ")}.`);

  return {
    dockerfile,
    heapMb,
    notes,
    args: nextBuildArgs({
      image: input.image,
      slug: input.slug,
      dockerfile,
      secretFile,
      context: input.src,
      publicVars,
      fingerprint: secretFingerprint(secret, cacheKey),
    }),
    cleanup: () => rm(secretFile, { force: true }),
  };
}

// ---------------------------------------------------------------------------
// Falhas
// ---------------------------------------------------------------------------

/** Quanto do fim do log o painel guarda para explicar uma falha de build. */
export const BUILD_LOG_TAIL_CHARS = 200_000;

/** Guarda só o fim do que um processo imprime (o log de um build pode ter dezenas de MB). */
export class TailBuffer {
  private parts: string[] = [];
  private size = 0;
  constructor(private readonly max: number = BUILD_LOG_TAIL_CHARS) {}

  push(chunk: string): void {
    this.parts.push(chunk);
    this.size += chunk.length;
    if (this.size > this.max * 2) {
      const text = this.parts.join("").slice(-this.max);
      this.parts = [text];
      this.size = text.length;
    }
  }

  toString(): string {
    return this.parts.join("").slice(-this.max);
  }
}

export type BuildFailureKind = "oom" | "lockfile" | "standalone";

const OOM = [
  "JavaScript heap out of memory",
  "Reached heap limit",
  "Allocation failed",
  "exit code: 137",
  "signal: killed",
  "SIGKILL",
  "Killed",
  "ENOMEM",
  "Cannot allocate memory",
];
const LOCKFILE = [
  "ERR_PNPM_OUTDATED_LOCKFILE",
  "ERR_PNPM_LOCKFILE_CONFIG_MISMATCH",
  "ERR_PNPM_NO_LOCKFILE",
  "can only install packages when your package.json and package-lock.json",
  "Your lockfile needs to be updated",
  "The lockfile would have been modified",
  "YN0028",
];

export interface BuildFailure {
  kind: BuildFailureKind;
  /** Texto pt-BR para o log e para o erro do deploy. */
  message: string;
}

/** Lê o fim do log de um build que falhou e diz, em português, o que provavelmente aconteceu. */
export function explainBuildFailure(output: string, ctx: { heapMb: number; packageManager: PackageManager }): BuildFailure | null {
  const text = output.length > BUILD_LOG_TAIL_CHARS ? output.slice(-BUILD_LOG_TAIL_CHARS) : output;
  if (text.includes(STANDALONE_MISSING_MARK)) {
    return {
      kind: "standalone",
      message:
        'O next.config pede output "standalone", mas o build não gerou .next/standalone/server.js. ' +
        "Em monorepo (outputFileTracingRoot) o caminho muda; nesse caso use um Dockerfile seu. Se o output vem de uma expressão, escreva o valor direto no arquivo.",
    };
  }
  if (LOCKFILE.some((m) => text.includes(m))) {
    return {
      kind: "lockfile",
      message:
        `O lockfile não bate com o package.json (o painel instala com o lockfile congelado). Rode "${ctx.packageManager} install" no seu computador, ` +
        "commite o lockfile atualizado e faça o deploy de novo.",
    };
  }
  if (OOM.some((m) => text.includes(m))) {
    return {
      kind: "oom",
      message:
        `O build ficou sem memória (o painel limita o heap do Node a ${ctx.heapMb} MB por processo, e o Next.js usa vários). O next build é o passo mais pesado de um deploy. ` +
        "O que fazer: crie um arquivo de swap na VPS (2 GB já ajudam), use um plano com mais RAM, pare outros containers pesados durante o deploy " +
        "ou, no Next.js 15+, ative experimental.webpackMemoryOptimizations e limite experimental.cpus (menos processos de build em paralelo) no next.config para reduzir o pico. Depois faça o deploy de novo.",
    };
  }
  return null;
}
