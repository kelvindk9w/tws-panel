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
];

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
