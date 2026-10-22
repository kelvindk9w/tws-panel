/**
 * ingest.ts — ingestão de código-fonte nos 3 modos (plano §5.1):
 *  - git:      clona o repositório (branch configurável) para data/projects/<slug>/src
 *  - upload:   copia um diretório local para data/projects/<slug>/src
 *  - existing: usa um caminho já existente (modo dev local; src = o próprio path)
 */
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { GitReadCredential, Project } from "@paas/core";
import { run } from "./exec.js";
import { CREDENTIAL_HELPER, GIT_DIR_NAME, GIT_SAFE_CONFIG, gitSafeEnv, sanitizeGitConfig } from "./git-safe.js";
import { isRegularFile, writeFileNoFollow } from "./safe-fs.js";
import { uploadOverlapBlocker } from "./workdir-safety.js";

/** Diretórios/arquivos excluídos ao copiar código no modo upload. */
const UPLOAD_EXCLUDES = new Set(["node_modules", ".git", "dist", "out", "build", ".next", ".turbo"]);

/** Texto que substitui a credencial em qualquer saída visível ao operador. */
const CREDENCIAL_OCULTA = "«credencial oculta»";

/**
 * Sinais de que o git parou por AUTENTICAÇÃO — e só eles.
 *
 * A orientação "cadastre um token de leitura" só é útil quando o repositório
 * de fato pediu credencial. Rede fora do ar, branch inexistente ou URL errada
 * têm outras causas, e sugerir credencial nesses casos manda o operador
 * caçar o problema no lugar errado.
 */
const SINAIS_DE_AUTENTICACAO = [
  /could not read Username/i,
  /could not read Password/i,
  /terminal prompts disabled/i,
  /authentication failed/i,
  /invalid username or password/i,
  /HTTP Basic: Access denied/i,
  /the requested URL returned error: 40[13]/i,
  /remote: (Invalid username or token|Support for password authentication)/i,
];

function pareceFalhaDeAutenticacao(saida: string): boolean {
  return SINAIS_DE_AUTENTICACAO.some((re) => re.test(saida));
}

/**
 * Ambiente do git para uma ingestão, com o segredo (quando existe) chegando
 * SOMENTE por variável de ambiente.
 *
 * Por que não a URL `https://user:token@host/...`: ela vaza duas vezes — no
 * argv (visível no `ps` de qualquer processo do host) e, para sempre, no
 * `remote.origin.url` gravado em texto puro no .git/config do clone.
 *
 * Por que não um script de GIT_ASKPASS (como era): o container do painel monta
 * /tmp SEM permissão de execução (hardening), e o git não conseguia rodar o
 * script — "cannot exec '/tmp/…/askpass.sh': Permission denied" (visto em
 * campo) — então nenhum repositório privado clonava. Agora é um credential
 * helper EM LINHA (`-c credential.helper=!f() {…}; f`), executado pelo shell,
 * que só lê $PAAS_GIT_USERNAME/$PAAS_GIT_PASSWORD: nenhum arquivo é criado, e o
 * argv traz só o nome das variáveis, nunca o token.
 *
 * GIT_ASKPASS vazio + GIT_TERMINAL_PROMPT=0 sempre: o painel pode herdar um
 * GIT_ASKPASS do ambiente (editores injetam o deles), e o git chamaria um
 * programa interativo; assim, a falta de credencial vira erro imediato em vez
 * de travamento.
 */
interface AmbienteGit {
  env: NodeJS.ProcessEnv;
  /** Argumentos `-c …` a pôr antes do subcomando do git (vazio sem credencial). */
  configArgs: string[];
  /** Apaga o segredo de qualquer texto antes de ele virar log ou erro. */
  ocultar: (texto: string) => string;
  temCredencial: boolean;
}

function prepararAmbienteGit(cred: GitReadCredential | null): AmbienteGit {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
  };

  if (!cred) {
    return { env: base, configArgs: [], ocultar: (texto) => texto, temCredencial: false };
  }

  const token = cred.token;
  return {
    env: { ...base, PAAS_GIT_USERNAME: cred.username, PAAS_GIT_PASSWORD: token },
    // o primeiro "credential.helper=" zera helpers herdados (ex.: um store no
    // ~/.gitconfig), para o token nunca ser gravado por outro helper
    configArgs: ["-c", "credential.helper=", "-c", `credential.helper=${CREDENTIAL_HELPER}`],
    ocultar: (texto) => (token ? texto.split(token).join(CREDENCIAL_OCULTA) : texto),
    temCredencial: true,
  };
}

/**
 * Erro de um comando git com mensagem SEMPRE acionável.
 *
 * O `run()` já preenche o stderr quando o processo sequer pôde ser executado,
 * mas um comando pode falhar calado (código != 0 e stderr vazio). Nesse caso
 * o operador via só "git clone falhou:" e nada depois — nenhuma pista. O
 * fallback abaixo garante que a mensagem diga ao menos o código de saída e
 * onde olhar.
 */
function falhaGit(
  rotulo: string,
  r: { code: number; stderr: string; stdout?: string },
  ambiente?: AmbienteGit,
): Error {
  const bruto = `${r.stderr}\n${r.stdout ?? ""}`;
  const detalhe = (ambiente?.ocultar(r.stderr) ?? r.stderr).trim();
  const base = detalhe
    ? `${rotulo} falhou: ${detalhe}`
    : `${rotulo} falhou com código ${r.code} e sem nenhuma saída de erro — ` +
      `confirme que o git está instalado na imagem do painel e que o repositório é acessível.`;
  // Só orienta sobre credencial quando o sinal é REALMENTE de autenticação.
  if (!pareceFalhaDeAutenticacao(bruto)) return new Error(base);
  const orientacao = ambiente?.temCredencial
    ? `${base}\n\nA credencial de leitura cadastrada foi recusada pelo servidor do repositório. ` +
      `Confirme se o token não expirou e se ele dá acesso de LEITURA a este repositório ` +
      `(no GitHub, um fine-grained PAT com "Contents: Read" incluindo este repositório).`
    : `${base}\n\nO repositório parece ser PRIVADO: o git pediu autenticação e o painel não tem ` +
      `credencial cadastrada para este projeto. Cadastre um token de LEITURA nas configurações ` +
      `do projeto (no GitHub, um fine-grained PAT com "Contents: Read"). O painel apenas LÊ o ` +
      `repositório — nunca escreve, commita nem faz push.`;
  return new Error(orientacao);
}

export interface IngestContext {
  /** Raiz dos dados de projetos (data/projects). */
  projectsDir: string;
  /**
   * Credencial de LEITURA do repositório privado do projeto (cofre do
   * servidor). undefined/null = repositório público. O valor só existe em
   * memória e no ambiente do processo git — nunca em argv, log ou disco do
   * clone.
   */
  credentialFor?: (project: Project) => Promise<GitReadCredential | null>;
}

/** Pasta reservada ao painel dentro da pasta de projetos (nunca é de usuário: o nome tem ponto no começo e os projetos dentro dela têm id gerado). */
export const RESERVED_DIRNAME = ".paas";

/** `<pasta de projetos>/.paas`. */
export function reservedRoot(ctx: IngestContext): string {
  return path.join(ctx.projectsDir, RESERVED_DIRNAME);
}

/**
 * Diretório de trabalho do projeto: onde o painel guarda o que GERA (clone,
 * repositório do painel, paas.*). Projeto novo: `<projetos>/.paas/<id>`.
 * Projeto de antes da área reservada: `<projetos>/<slug>` (ver Project.storageLayout).
 */
export function projectWorkDir(ctx: IngestContext, project: Project): string {
  if (project.storageLayout === "reserved") {
    if (!/^[A-Za-z0-9_-]+$/.test(project.id)) throw new Error(`Identificador de projeto inválido: ${project.id}`);
    return path.join(reservedRoot(ctx), project.id);
  }
  return path.join(ctx.projectsDir, project.slug);
}

/** a e b são o mesmo caminho, ou um está dentro do outro (caminhos já resolvidos). */
export function pathsOverlap(a: string, b: string): boolean {
  const within = (root: string, p: string) => {
    const rel = path.relative(root, p);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  return within(a, b) || within(b, a);
}

/** Diretório do código-fonte efetivo do projeto. */
export function projectSrcDir(ctx: IngestContext, project: Project): string {
  if (project.ingestMode === "existing") {
    return path.resolve(project.source);
  }
  return path.join(projectWorkDir(ctx, project), "src");
}

/**
 * Sincroniza o código-fonte conforme o modo de ingestão.
 * Retorna o diretório do código pronto para build.
 */
export async function ingestCode(
  ctx: IngestContext,
  project: Project,
  onLog: (chunk: string) => void,
): Promise<string> {
  switch (project.ingestMode) {
    case "git":
      return ingestGit(ctx, project, onLog);
    case "upload":
      return ingestUpload(ctx, project, onLog);
    case "existing":
      onLog(`Modo "existing": usando código diretamente de ${path.resolve(project.source)}\n`);
      return projectSrcDir(ctx, project);
  }
}

/** Diretório do repositório git do painel para o projeto (fora de `src`, ver git-safe.ts). */
export function projectGitDir(ctx: IngestContext, project: Project): string {
  return path.join(projectWorkDir(ctx, project), GIT_DIR_NAME);
}

/**
 * Deixa em `src/.git` só um ponteiro para o repositório do painel (o operador
 * continua usando `git status` ali). O que estiver lá — um clone antigo ou o
 * que um app invadido plantou — sai de `src` sem seguir link simbólico e o painel
 * nunca mais o lê. Uma PASTA `.git` (o clone do usuário, com histórico e commits
 * locais) não é apagada: vai para `<pasta do projeto>/.git-antigo-<data>`, fora
 * do `src` que os containers gravam. Link ou outro tipo de arquivo é removido.
 */
async function substituirGitDeSrcPorPonteiro(src: string, gitDir: string, onLog: (chunk: string) => void): Promise<void> {
  const ponteiro = path.join(src, ".git");
  if (!(await isRegularFile(ponteiro))) {
    const info = await lstat(ponteiro).catch(() => null);
    if (info?.isDirectory()) {
      const guardado = path.join(path.dirname(src), `.git-antigo-${new Date().toISOString().replace(/[:.]/g, "-")}`);
      await rename(ponteiro, guardado);
      onLog(`O .git que estava no código foi guardado em ${guardado} (o painel passou a usar o próprio repositório, fora do código). Apague quando não precisar mais.\n`);
    } else {
      await rm(ponteiro, { recursive: true, force: true });
    }
  }
  await writeFileNoFollow(ponteiro, `gitdir: ${gitDir}\n`, 0o644);
}

async function ingestGit(
  ctx: IngestContext,
  project: Project,
  onLogBruto: (chunk: string) => void,
): Promise<string> {
  const src = projectSrcDir(ctx, project);
  const gitDir = projectGitDir(ctx, project);
  const branch = project.branch ?? "main";
  if (project.source.startsWith("-")) {
    throw new Error("Fonte de código inválida: o endereço do repositório não pode começar com \"-\".");
  }

  const cred = (await ctx.credentialFor?.(project)) ?? null;
  const ambiente = prepararAmbienteGit(cred);
  // Todo git do painel aponta para o repositório DELE (fora de `src`), com
  // hooks e fsmonitor desligados: nada que esteja em `src` é executado nem
  // lido como configuração (git-safe.ts, achado A2).
  const git = (args: string[]) => [
    ...GIT_SAFE_CONFIG,
    ...ambiente.configArgs,
    "--git-dir",
    gitDir,
    "--work-tree",
    src,
    ...args,
  ];
  // Todo texto que sai daqui passa pelo filtro: o log do deploy é transmitido
  // ao operador e persistido em disco, e uma mensagem de erro do git pode
  // ecoar o que recebeu.
  const onLog = (chunk: string) => onLogBruto(ambiente.ocultar(chunk));
  const gitEnv = { env: gitSafeEnv(ambiente.env) };

  if (ambiente.temCredencial) {
    onLog("Usando a credencial de leitura cadastrada para este projeto (acesso somente leitura).\n");
  }

  await mkdir(src, { recursive: true });
  await substituirGitDeSrcPorPonteiro(src, gitDir, onLog);

  const novo = !existsSync(path.join(gitDir, "HEAD"));
  if (!novo) {
    const removidas = await sanitizeGitConfig(gitDir, run, gitEnv.env);
    if (removidas.length > 0) onLog(`Aviso: ${removidas.length} chave(s) do repositório do painel foram removidas por segurança (${removidas.join(", ")}).\n`);
  }
  if (novo) {
    const init = await run("git", git(["init", "-q"]), gitEnv);
    if (init.code !== 0) throw falhaGit("git init", init, ambiente);
  }
  // Um repositório já existente só é reaproveitado como está se ainda
  // corresponder ao que está configurado: se a URL mudou, o fetch traria o
  // código do repositório ANTIGO sem erro algum; se a branch mudou, o
  // checkout precisa trocar a branch. Nos dois casos o código novo entra por
  // cima (checkout forçado), SEM apagar o que não é versionado (dados,
  // uploads, .env): ele mora em `src` e é do projeto.
  const origemAtual = (await run("git", git(["config", "--get", "remote.origin.url"]), gitEnv)).stdout.trim();
  const branchAtual = (await run("git", git(["symbolic-ref", "-q", "--short", "HEAD"]), gitEnv)).stdout.trim();
  const temBranch = (await run("git", git(["rev-parse", "-q", "--verify", `refs/heads/${branch}`]), gitEnv)).code === 0;
  const mesmoRepositorio = origemAtual === project.source;
  const mesmaBranch = branchAtual === branch && temBranch;

  for (const [chave, valor] of [
    ["remote.origin.url", project.source],
    ["remote.origin.fetch", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
  ] as const) {
    const set = await run("git", git(["config", chave, valor]), gitEnv);
    if (set.code !== 0) throw falhaGit("git config", set, ambiente);
  }

  if (novo) {
    onLog(`Baixando ${project.source} (branch ${branch})…\n`);
  } else if (!mesmoRepositorio) {
    onLog(`Repositório configurado mudou (${origemAtual} → ${project.source}). Trocando o código…\n`);
  } else if (!mesmaBranch) {
    onLog(`Branch configurada mudou (${branchAtual} → ${branch}). Trocando o código…\n`);
  } else {
    onLog(`Atualizando clone existente (git fetch + merge ${branch})…\n`);
  }

  // fetch também precisa da credencial: repositório privado não deixa nem
  // atualizar sem autenticar, só o primeiro clone.
  const fetch = await run("git", git(["fetch", "--prune", "origin"]), { ...gitEnv, timeoutMs: 900_000 });
  if (fetch.code !== 0) throw falhaGit("git fetch", fetch, ambiente);

  const remoto = `refs/remotes/origin/${branch}`;
  if (!novo && mesmoRepositorio && mesmaBranch) {
    const merge = await run("git", git(["merge", "--ff-only", remoto]), { ...gitEnv, timeoutMs: 600_000 });
    if (merge.code !== 0) throw falhaGit("git pull", merge, ambiente);
    onLog(merge.stdout);
    return src;
  }
  const checkout = await run("git", git(["checkout", "-q", "-f", "-B", branch, remoto]), {
    ...gitEnv,
    timeoutMs: 600_000,
  });
  if (checkout.code !== 0) throw falhaGit(`git checkout ${branch}`, checkout, ambiente);
  onLog(checkout.stderr || checkout.stdout || "Código baixado.\n");
  return src;
}

async function ingestUpload(
  ctx: IngestContext,
  project: Project,
  onLog: (chunk: string) => void,
): Promise<string> {
  const from = path.resolve(project.source);
  const to = projectSrcDir(ctx, project);
  // a cópia apaga `to` antes de copiar: se a origem é (ou contém, ou está
  // dentro de) a pasta do painel para este projeto, o código do usuário se perderia
  const blocker = await uploadOverlapBlocker(ctx, project);
  if (blocker) throw new Error(blocker);
  onLog(`Copiando ${from} → ${to} (excluindo ${[...UPLOAD_EXCLUDES].join(", ")})…\n`);
  await rm(to, { recursive: true, force: true });
  await cp(from, to, {
    recursive: true,
    filter: (srcPath) => {
      const base = path.basename(srcPath);
      return !UPLOAD_EXCLUDES.has(base);
    },
  });
  onLog("Cópia concluída.\n");
  return to;
}
