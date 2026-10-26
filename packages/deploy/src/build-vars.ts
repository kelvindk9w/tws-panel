/**
 * build-vars.ts — as Variáveis marcadas como "de build" (públicas: vão para o JavaScript do site).
 *
 * A pessoa marca, na seção Variáveis, quais variáveis entram no build (VITE_*, NEXT_PUBLIC_*, PUBLIC_*,
 * REACT_APP_* são sugeridas, nunca marcadas sozinhas). Só as marcadas vão:
 *  - ao build estático (container Node, por um arquivo de ambiente 0600 fora do código);
 *  - ao `docker build` do Dockerfile do usuário e aos `build:` do compose, como `--build-arg` / `build.args`,
 *    e só as que o Dockerfile declara com `ARG` (o Docker avisa e ignora o resto, e uma variável não declarada
 *    não chegaria ao build de qualquer jeito).
 * Segredo não marcado nunca entra. Os valores não vão ao log: só os nomes.
 */
import { isSecretVariableName } from "@paas/core";
import { BUILD_VAR_MAX_CHARS, RESERVED_BUILD_NAMES, RESERVED_PREFIXES, SHELL_NAME } from "./next-build.js";

/** Nomes que mudariam o comportamento do Docker ou da rede do build. */
const EXTRA_RESERVED = new Set([
  "HTTP_PROXY", "HTTPS_PROXY", "FTP_PROXY", "NO_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "ftp_proxy", "no_proxy", "all_proxy",
  "TZ", "LANG", "LC_ALL", "SSH_AUTH_SOCK", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
]);
const EXTRA_PREFIXES = ["DOCKER_", "BUILDKIT_", "COMPOSE_", "GIT_", "SSL_", "CURL_"];

/** Por que o painel não aceita `name` como variável de build (null = aceita). */
export function buildVarProblem(name: string, value?: string): string | null {
  if (!SHELL_NAME.test(name)) return "nome inválido";
  if (RESERVED_BUILD_NAMES.has(name) || EXTRA_RESERVED.has(name)) return "nome reservado";
  if ([...RESERVED_PREFIXES, ...EXTRA_PREFIXES].some((prefix) => name.startsWith(prefix))) return "nome reservado";
  if (value !== undefined) {
    if (value.length > BUILD_VAR_MAX_CHARS) return "valor grande demais";
    if (/[\r\n\0]/.test(value)) return "valor com quebra de linha";
  }
  return null;
}

export interface SelectedBuildVars {
  /** Nome → valor das marcadas que podem ir ao build. */
  vars: Record<string, string>;
  /** Marcadas que ficaram de fora (só os nomes, com o motivo). */
  skipped: Array<{ name: string; reason: string }>;
}

/** Aviso para o log quando um nome marcado "de build" parece de segredo ("" se nenhum parece). */
export function secretLookingNote(names: readonly string[]): string {
  const suspicious = names.filter((n) => isSecretVariableName(n));
  if (suspicious.length === 0) return "";
  return ` Atenção: ${suspicious.join(", ")} tem nome de segredo; o valor fica no JavaScript do site ou no histórico da imagem (docker history). Desmarque se não puder ser público.`;
}

/** Das variáveis marcadas como de build, as que o painel aceita passar ao build. */
export function selectBuildVars(marked: Readonly<Record<string, string>> | undefined): SelectedBuildVars {
  const vars: Record<string, string> = {};
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const name of Object.keys(marked ?? {}).sort()) {
    const reason = buildVarProblem(name, marked![name]!);
    if (reason) skipped.push({ name, reason });
    else vars[name] = marked![name]!;
  }
  return { vars, skipped };
}

/** As marcadas que o Dockerfile declara com ARG (as demais não chegariam ao build). */
export function buildArgsFor(
  selected: Readonly<Record<string, string>>,
  declared: readonly string[],
): { args: Record<string, string>; notDeclared: string[] } {
  const args: Record<string, string> = {};
  const notDeclared: string[] = [];
  for (const name of Object.keys(selected)) {
    if (declared.includes(name)) args[name] = selected[name]!;
    else notDeclared.push(name);
  }
  return { args, notDeclared };
}

/** Conteúdo de um `--env-file` do Docker: `NOME=valor` por linha, literal (sem aspas nem interpolação). */
export function renderBuildEnvFile(vars: Readonly<Record<string, string>>): string {
  return Object.entries(vars)
    .map(([name, value]) => `${name}=${value}\n`)
    .join("");
}
