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
import { buildVarProblem, isSecretVariableName } from "@paas/core";

// a regra mora no core: a tela mostra o mesmo aviso que o deploy aplica
export { buildVarProblem };

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
