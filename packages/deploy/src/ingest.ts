/**
 * ingest.ts — ingestão de código-fonte nos 3 modos (plano §5.1):
 *  - git:      clona o repositório (branch configurável) para data/projects/<slug>/src
 *  - upload:   copia um diretório local para data/projects/<slug>/src
 *  - existing: usa um caminho já existente (modo dev local; src = o próprio path)
 */
import { chmod, cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GitReadCredential, Project } from "@paas/core";
import { run } from "./exec.js";

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
 * SOMENTE por variável de ambiente + GIT_ASKPASS.
 *
 * Por que não a URL `https://user:token@host/...`: ela vaza duas vezes — no
 * argv (visível no `ps` de qualquer processo do host) e, para sempre, no
 * `remote.origin.url` gravado em texto puro no .git/config do clone.
 *
 * GIT_ASKPASS é sempre definido, inclusive SEM credencial (com string vazia):
 * o painel pode herdar um GIT_ASKPASS do ambiente (editores injetam o deles),
 * e aí o git chamaria um programa interativo e o deploy ficaria pendurado
 * para sempre esperando alguém digitar. Com GIT_TERMINAL_PROMPT=0 junto, a
 * falta de credencial vira erro imediato em vez de travamento.
 */
interface AmbienteGit {
  env: NodeJS.ProcessEnv;
  /** Remove o auxiliar do askpass. Idempotente; chamado sempre no finally. */
  limpar: () => Promise<void>;
  /** Apaga o segredo de qualquer texto antes de ele virar log ou erro. */
  ocultar: (texto: string) => string;
  temCredencial: boolean;
}

async function prepararAmbienteGit(cred: GitReadCredential | null): Promise<AmbienteGit> {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    // Nunca travar esperando digitação: não há operador no terminal do painel.
    GIT_TERMINAL_PROMPT: "0",
    // Neutraliza um askpass herdado do ambiente (ver comentário acima).
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
  };

  if (!cred) {
    return {
      env: base,
      limpar: async () => undefined,
      ocultar: (texto) => texto,
      temCredencial: false,
    };
  }

  // O auxiliar precisa de um diretório GRAVÁVEL: o container do painel roda
  // com rootfs somente-leitura e só /data e /tmp aceitam escrita.
  const dir = await mkdtemp(path.join(tmpdir(), "paas-git-cred-"));
  const script = path.join(dir, "askpass.sh");
  // O git chama este programa com a pergunta ("Username for ...") no argv e lê
  // a resposta do stdout. O segredo entra por variável de ambiente do
  // processo, jamais por argumento.
  await writeFile(
    script,
    [
      "#!/bin/sh",
      'case "$1" in',
      "  Username*) printf '%s' \"$PAAS_GIT_USERNAME\" ;;",
      "  *) printf '%s' \"$PAAS_GIT_PASSWORD\" ;;",
      "esac",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 },
  );
  await chmod(script, 0o700).catch(() => undefined);

  const token = cred.token;
  return {
    env: {
      ...base,
      GIT_ASKPASS: script,
      PAAS_GIT_USERNAME: cred.username,
      PAAS_GIT_PASSWORD: token,
    },
    limpar: () => rm(dir, { recursive: true, force: true }),
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

/** Diretório de trabalho do projeto (data/projects/<slug>). */
export function projectWorkDir(ctx: IngestContext, project: Project): string {
  return path.join(ctx.projectsDir, project.slug);
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

async function ingestGit(
  ctx: IngestContext,
  project: Project,
  onLogBruto: (chunk: string) => void,
): Promise<string> {
  const src = projectSrcDir(ctx, project);
  const branch = project.branch ?? "main";

  const cred = (await ctx.credentialFor?.(project)) ?? null;
  const ambiente = await prepararAmbienteGit(cred);
  // Todo texto que sai daqui passa pelo filtro: o log do deploy é transmitido
  // ao operador e persistido em disco, e uma mensagem de erro do git pode
  // ecoar o que recebeu.
  const onLog = (chunk: string) => onLogBruto(ambiente.ocultar(chunk));
  const gitEnv = { env: ambiente.env };

  try {
    if (ambiente.temCredencial) {
      onLog("Usando a credencial de leitura cadastrada para este projeto (acesso somente leitura).\n");
    }

    const inside = await run("git", ["-C", src, "rev-parse", "--is-inside-work-tree"], gitEnv);
    // Um clone existente só pode ser reaproveitado se ainda corresponder ao que
    // está configurado. O clone é --single-branch: se a branch mudou, o checkout
    // falharia porque a nova branch nem existe localmente. E se a URL do
    // repositório mudou, o fetch traria o código do repositório ANTIGO sem erro
    // algum — falha silenciosa. Nos dois casos, re-clonar é a saída correta.
    if (inside.code === 0 && inside.stdout.trim() === "true") {
      const origemAtual = await run("git", ["-C", src, "remote", "get-url", "origin"], gitEnv);
      const branchAtual = await run("git", ["-C", src, "rev-parse", "--abbrev-ref", "HEAD"], gitEnv);
      const mesmoRepositorio = origemAtual.stdout.trim() === project.source;
      const mesmaBranch = branchAtual.stdout.trim() === branch;

      if (!mesmoRepositorio) {
        onLog(
          `Repositório configurado mudou (${origemAtual.stdout.trim()} → ${project.source}). ` +
            `Refazendo o clone do zero…\n`,
        );
      } else if (!mesmaBranch) {
        onLog(
          `Branch configurada mudou (${branchAtual.stdout.trim()} → ${branch}). ` +
            `Refazendo o clone do zero…\n`,
        );
      }

      if (mesmoRepositorio && mesmaBranch) {
        onLog(`Atualizando clone existente (git fetch + checkout ${branch})…\n`);
        // fetch/pull também precisam da credencial: repositório privado não
        // deixa nem atualizar sem autenticar, só o primeiro clone.
        const fetch = await run("git", ["-C", src, "fetch", "--all", "--prune"], {
          ...gitEnv,
          timeoutMs: 600_000,
        });
        if (fetch.code !== 0) throw falhaGit("git fetch", fetch, ambiente);
        const checkout = await run("git", ["-C", src, "checkout", branch], gitEnv);
        if (checkout.code !== 0) throw falhaGit(`git checkout ${branch}`, checkout, ambiente);
        const pull = await run("git", ["-C", src, "pull", "--ff-only", "origin", branch], {
          ...gitEnv,
          timeoutMs: 600_000,
        });
        if (pull.code !== 0) throw falhaGit("git pull", pull, ambiente);
        onLog(pull.stdout);
        return src;
      }
    }

    onLog(`Clonando ${project.source} (branch ${branch})…\n`);
    await rm(src, { recursive: true, force: true });
    // A URL vai como argumento LIMPA, sem credencial embutida: é ela que fica
    // gravada no remote.origin.url do clone.
    const clone = await run(
      "git",
      ["clone", "--branch", branch, "--single-branch", project.source, src],
      { ...gitEnv, timeoutMs: 900_000 },
    );
    if (clone.code !== 0) throw falhaGit("git clone", clone, ambiente);
    onLog(clone.stderr || clone.stdout);
    return src;
  } finally {
    // Sempre — inclusive quando o clone falha — o auxiliar do askpass some.
    await ambiente.limpar().catch(() => undefined);
  }
}

async function ingestUpload(
  ctx: IngestContext,
  project: Project,
  onLog: (chunk: string) => void,
): Promise<string> {
  const from = path.resolve(project.source);
  const to = projectSrcDir(ctx, project);
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
