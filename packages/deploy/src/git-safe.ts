/**
 * git-safe.ts — como o painel roda o git sobre código que o PRÓPRIO PROJETO
 * consegue gravar.
 *
 * A pasta `src` é montada com escrita nos containers do projeto (`./:/app` num
 * compose, o build estático). Um app invadido planta então hooks, `core.fsmonitor`,
 * `core.sshCommand`, filtros e `insteadOf` no `.git` de `src`, e o próximo
 * deploy os executaria DENTRO do container do painel (com o docker.sock ao
 * alcance — achado A2 da auditoria).
 *
 * Duas defesas, as duas necessárias:
 *  1. o repositório git do painel mora FORA de `src` (`<pasta do projeto>/repo.git`,
 *     que nenhum container de projeto enxerga) e todo comando recebe
 *     `--git-dir`/`--work-tree` explícitos: o `.git` de `src` nunca é lido;
 *  2. todo comando roda com hooks e fsmonitor desligados, sem a configuração
 *     do sistema nem a do usuário, e sem o transporte `ext::`.
 */
import path from "node:path";

/** Nome do repositório git do painel, dentro da pasta do projeto (ao lado de `src`). */
export const GIT_DIR_NAME = "repo.git";

/** Configuração que vale para QUALQUER git do painel (vem antes do subcomando). */
export const GIT_SAFE_CONFIG: readonly string[] = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "protocol.file.allow=user",
  "-c",
  "core.attributesFile=/dev/null",
  // segunda defesa, caso o repo.git/config seja adulterado: nada que execute programa ou troque a origem
  // core.sshCommand NÃO entra aqui: vazio, o git o executaria como comando e quebraria clones por ssh;
  // ele é removido do config por sanitizeGitConfig.
  "-c",
  "core.gitProxy=",
  "-c",
  "credential.helper=",
];

/**
 * Chaves do `repo.git/config` que executam programa ou trocam o destino do fetch. `-c` só consegue
 * zerar chaves de valor único; `url.<base>.insteadOf` e as demais ficam no arquivo, então elas são
 * REMOVIDAS dele antes de cada ingestão (o painel só precisa de remote.origin.url/fetch).
 */
const CHAVES_PERIGOSAS =
  "^(url\\..*|include.*|credential\\..*|filter\\..*|alias\\..*|http\\..*|protocol\\..*|uploadpack\\..*" +
  "|core\\.(sshcommand|gitproxy|alternaterefscommand|fsmonitor|hookspath|pager|editor|askpass|attributesfile|excludesfile)" +
  "|remote\\..*\\.(uploadpack|receivepack|proxy|proxyauthmethod|vcs|pushurl))$";

type Executar = (file: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => Promise<{ code: number; stdout: string }>;

/** Remove do repositório do painel as chaves de configuração que executariam algo ou redirecionariam o fetch. */
export async function sanitizeGitConfig(gitDir: string, run: Executar, env: NodeJS.ProcessEnv): Promise<string[]> {
  const base = [...GIT_SAFE_CONFIG, "--git-dir", gitDir, "config", "--local"];
  const listed = await run("git", [...base, "--name-only", "--get-regexp", CHAVES_PERIGOSAS], { env });
  if (listed.code !== 0) return [];
  const removed: string[] = [];
  for (const key of new Set(listed.stdout.split("\n").map((l) => l.trim()).filter(Boolean))) {
    const out = await run("git", [...base, "--unset-all", key], { env });
    if (out.code === 0) removed.push(key);
  }
  return removed;
}

/**
 * Credential helper EM LINHA: só responde ao "get" e só lê $PAAS_GIT_USERNAME /
 * $PAAS_GIT_PASSWORD do ambiente. Nenhum arquivo é criado e o argv traz só o
 * nome das variáveis, nunca o token (ver ingest.ts e git-access.ts).
 */
export const CREDENTIAL_HELPER =
  '!f() { test "$1" = get && printf \'username=%s\\npassword=%s\\n\' "$PAAS_GIT_USERNAME" "$PAAS_GIT_PASSWORD"; }; f';

/**
 * Só COM credencial: um 301/302 não pode levar o cabeçalho de autenticação a outro
 * endereço. Sem credencial o redirecionamento segue como sempre (GitLab sem `.git`,
 * repositório renomeado): não há segredo a proteger.
 */
export const NO_REDIRECT_CONFIG: readonly string[] = ["-c", "http.followRedirects=false"];

/** Variáveis do git que mudariam de onde ele lê repositório e configuração. */
const GIT_ENV_REMOVIDAS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_EXEC_PATH",
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "GIT_SSH",
  "GIT_PROXY_COMMAND",
] as const;

/**
 * Ambiente do processo git: o do painel menos o que redireciona o git, sem
 * `/etc/gitconfig` nem `~/.gitconfig`.
 */
export function gitSafeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of GIT_ENV_REMOVIDAS) delete env[name];
  for (const name of Object.keys(env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name)) delete env[name];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
  };
}

/** `--git-dir`/`--work-tree` do repositório do painel para a pasta `src`. */
export function gitLocation(workDir: string, src: string): string[] {
  return ["--git-dir", path.join(workDir, GIT_DIR_NAME), "--work-tree", src];
}
