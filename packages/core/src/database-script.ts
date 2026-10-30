/**
 * database-script.ts — console SQL com VÁRIAS instruções: separa o texto (respeitando textos entre aspas,
 * identificadores, comentários, $tag$…$tag$ e crases) e classifica cada instrução com `analyzeSql`.
 */
import { DATABASE_SQL_MAX_STATEMENTS, analyzeSql, pgAmbiguousAt, type DatabaseSqlEngine, type SqlRefusal } from "./database";

const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
const isWordChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_$\u0080-￿]/.test(c);

/**
 * Separa o texto em instruções, lendo-o como o banco leria: o `;` dentro de texto entre aspas, identificador,
 * comentário, `$tag$…$tag$` (PostgreSQL) ou crases NÃO separa. Pedaços só de espaço/comentário saem. O que não
 * fecha (aspas, comentário, $tag$) devolve `unterminated`. Cada pedaço ainda passa por `analyzeSql`, que recusa
 * qualquer `;` que este leitor tenha deixado passar: um desacordo entre os dois vira recusa, nunca brecha.
 * Os pedaços NÃO incluem o `;` final.
 */
export function splitSql(input: string, engine: DatabaseSqlEngine): { ok: true; pieces: string[] } | { ok: false; code: "unterminated" | "ambiguous" } {
  const mysql = engine !== "postgres";
  const sql = input;
  const n = sql.length;
  const pieces: string[] = [];
  let start = 0;
  let i = 0;
  const push = (end: number) => {
    const piece = sql.slice(start, end).trim();
    if (piece !== "") pieces.push(piece);
  };
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === "-" && next === "-" && (!mysql || sql[i + 2] === undefined || isSpace(sql[i + 2]!))) {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "#" && mysql) {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else if (!mysql && sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else i++;
      }
      if (depth > 0) return { ok: false, code: "unterminated" };
      continue;
    }
    if (!mysql && (c === "'" || c === "$") && pgAmbiguousAt(sql, i)) return { ok: false, code: "ambiguous" };
    if (c === "'" || c === '"' || c === "`") {
      const backslash = mysql ? c !== "`" : c === "'" && /^[eE]$/.test(sql[i - 1] ?? "") && !isWordChar(sql[i - 2]);
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const d = sql[j]!;
        if (backslash && d === "\\") {
          j += 2;
          continue;
        }
        if (d === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        j++;
      }
      if (!closed) return { ok: false, code: "unterminated" };
      i = j;
      continue;
    }
    if (c === "$" && !mysql && !isWordChar(sql[i - 1])) {
      const m = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(sql.slice(i, i + 80));
      if (m) {
        const close = sql.indexOf(m[0], i + m[0].length);
        if (close < 0) return { ok: false, code: "unterminated" };
        i = close + m[0].length;
        continue;
      }
    }
    if (c === ";") {
      push(i);
      start = i + 1;
    }
    i++;
  }
  push(n);
  return { ok: true, pieces };
}

export interface SqlScriptStatement {
  statement: string;
  kind: "read" | "write";
  verb: string;
  reason?: "into" | "side_effect";
}

export type SqlScriptAnalysis =
  | {
      ok: true;
      statements: SqlScriptStatement[];
      /** "write" se QUALQUER instrução altera dados (ou usa INTO/função com efeito): exige a edição liberada. */
      kind: "read" | "write";
    }
  | { ok: false; code: SqlRefusal; /** Instrução (a partir de 1) que causou a recusa, quando há. */ index: number | null };

/**
 * Analisa o texto do console: separa as instruções (`splitSql`), classifica cada uma (`analyzeSql`) e diz se o
 * conjunto é só leitura ou tem escrita. No máximo `DATABASE_SQL_MAX_STATEMENTS` instruções. `DELIMITER` e os
 * comandos do cliente mysql continuam recusados (`client_command`).
 */
export function analyzeSqlScript(input: string, engine: DatabaseSqlEngine): SqlScriptAnalysis {
  const split = splitSql(input, engine);
  if (!split.ok) return { ok: false, code: split.code, index: null };
  if (split.pieces.length > DATABASE_SQL_MAX_STATEMENTS) return { ok: false, code: "too_many", index: null };
  const statements: SqlScriptStatement[] = [];
  for (const [at, piece] of split.pieces.entries()) {
    const a = analyzeSql(piece, engine);
    if (!a.ok) {
      // pedaço só de comentário: ignorado
      if (a.code === "empty") continue;
      return { ok: false, code: a.code, index: at + 1 };
    }
    statements.push({ statement: a.statement, kind: a.kind, verb: a.verb, ...(a.reason ? { reason: a.reason } : {}) });
  }
  if (statements.length === 0) return { ok: false, code: "empty", index: null };
  return { ok: true, statements, kind: statements.some((x) => x.kind === "write") ? "write" : "read" };
}
