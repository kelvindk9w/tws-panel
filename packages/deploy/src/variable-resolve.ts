/**
 * variable-resolve.ts — troca `${NOME}` e `$NOME` do compose pelo valor das Variáveis salvas do projeto,
 * só para a conferência de credenciais fracas (weak-credentials).
 *
 * O resultado é usado para DECIDIR e depois descartado: nenhuma mensagem, log ou resposta carrega o
 * valor — só o nome da variável (`names`).
 */

export interface ResolvedValue {
  /** Texto com as variáveis conhecidas substituídas. */
  text: string;
  /** Nomes das variáveis que entraram (sem os valores). */
  names: string[];
}

const REFERENCE = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-?+])?[^}]*\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Substitui as referências a variáveis que existem (e não estão vazias) em `variables`. Referência a
 * variável desconhecida fica como está (o padrão `:-x` do compose NÃO é aplicado: o valor real pode
 * vir de um `.env` do repositório, e adivinhar causaria bloqueio indevido). `$$` vira `$`.
 */
export function resolveWithVariables(value: string, variables: Readonly<Record<string, string>> | undefined): ResolvedValue {
  if (!variables || !value.includes("$")) return { text: value, names: [] };
  const names: string[] = [];
  const text = value.replace(REFERENCE, (match: string, braced: string | undefined, op: string | undefined, bare: string | undefined) => {
    if (match === "$$") return "$";
    const name = braced ?? bare;
    if (!name || op?.includes("+")) return match;
    if (!Object.prototype.hasOwnProperty.call(variables, name) || variables[name] === "") return match;
    if (!names.includes(name)) names.push(name);
    return variables[name]!;
  });
  return { text, names };
}
