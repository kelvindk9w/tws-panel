/**
 * database.ts — funções puras da aba Banco do projeto.
 */
import type { DatabaseTable, DatabaseTableRef } from "@paas/core";
import { ApiRequestError } from "@/lib/api";
import { apiErrorText, hasKey, translate } from "@/i18n";
import type { Key } from "@/i18n";

/** Chave estável de uma tabela (esquema + nome) para seleção. */
export function tableId(t: Pick<DatabaseTable, "schema" | "name">): string {
  return `${t.schema ?? ""}\u0000${t.name}`;
}

/** Nome para exibir: `esquema.tabela` quando o esquema não é o padrão. */
export function tableLabel(t: Pick<DatabaseTable, "schema" | "name">): string {
  return t.schema && t.schema !== "public" ? `${t.schema}.${t.name}` : t.name;
}

export function toRef(t: DatabaseTable): DatabaseTableRef {
  return t.schema === null ? { name: t.name } : { schema: t.schema, name: t.name };
}

/**
 * Texto de um erro do servidor nesta aba: frase fixa traduzida pelo código (`database.err.<código>`) e, quando o
 * servidor mandou, o motivo vindo do banco à parte. Sem texto para o código, cai no tratamento geral dos erros da API.
 */
export function dbErrorText(err: unknown, fallback: Key = "database.err.generic"): string {
  if (err instanceof ApiRequestError) {
    const key = `database.err.${err.code}`;
    if (hasKey(key)) return withDetail(translate(key), typeof err.data?.detail === "string" ? err.data.detail : null);
  }
  return apiErrorText(err, fallback);
}

/** Erro de um trabalho (já com `code`, `message` e `detail`). */
export function jobErrorText(error: { code: string; message: string; detail: string | null }): string {
  const key = `database.err.${error.code}`;
  return withDetail(hasKey(key) ? translate(key) : error.message, error.detail);
}

function withDetail(text: string, detail: string | null): string {
  return detail ? `${text} ${translate("database.action.detail", { detail })}` : text;
}
