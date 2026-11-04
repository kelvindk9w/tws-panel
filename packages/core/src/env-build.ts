/**
 * env-build.ts — limites e regras das Variáveis de um projeto, compartilhados pelo servidor, pelo deploy e pela tela.
 *
 * Uma fonte só: o servidor valida com estes números, o deploy decide o que vai ao build com estas regras e a tela
 * avisa (antes mesmo de salvar, e ao recarregar) com as mesmas duas coisas.
 */

/** No máximo estas variáveis por projeto (um .env real passa de 200). */
export const ENV_MAX_VARS = 1000;
/** Corpo do pedido de salvar (padrão do Fastify: 1 MiB). */
export const ENV_MAX_BODY_BYTES = 1024 * 1024;
/** Tamanho máximo do valor de uma variável. */
export const ENV_MAX_VALUE_CHARS = 32 * 1024;

export const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Valor maior que isto não vai ao build (um segredo legítimo é curto; PEM e JSON de serviço cabem). */
export const BUILD_VAR_MAX_CHARS = 32 * 1024;

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

/** Nomes que mudariam o comportamento do Docker ou da rede do build. */
const EXTRA_RESERVED = new Set([
  "HTTP_PROXY", "HTTPS_PROXY", "FTP_PROXY", "NO_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "ftp_proxy", "no_proxy", "all_proxy",
  "TZ", "LANG", "LC_ALL", "SSH_AUTH_SOCK", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
]);
const EXTRA_PREFIXES = ["DOCKER_", "BUILDKIT_", "COMPOSE_", "GIT_", "SSL_", "CURL_"];

export type BuildVarProblemCode = "name" | "reserved" | "size" | "newline";

/** Código do motivo pelo qual `name` não vai ao build (null = vai). A tela traduz o código; o log usa o texto. */
export function buildVarProblemCode(name: string, value?: string): BuildVarProblemCode | null {
  if (!SHELL_NAME.test(name)) return "name";
  if (RESERVED_BUILD_NAMES.has(name) || EXTRA_RESERVED.has(name)) return "reserved";
  if ([...RESERVED_PREFIXES, ...EXTRA_PREFIXES].some((prefix) => name.startsWith(prefix))) return "reserved";
  if (value !== undefined) {
    if (value.length > BUILD_VAR_MAX_CHARS) return "size";
    if (/[\r\n\0]/.test(value)) return "newline";
  }
  return null;
}

const PROBLEM_TEXT: Record<BuildVarProblemCode, string> = {
  name: "nome inválido",
  reserved: "nome reservado",
  size: "valor grande demais",
  newline: "valor com quebra de linha",
};

/** Por que o painel não aceita `name` como variável de build (null = aceita). */
export function buildVarProblem(name: string, value?: string): string | null {
  const code = buildVarProblemCode(name, value);
  return code ? PROBLEM_TEXT[code] : null;
}
