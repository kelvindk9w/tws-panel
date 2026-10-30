/**
 * database-sql-script.ts — o console SQL com VÁRIAS instruções: monta o script de leitura (uma transação somente
 * leitura) ou de escrita e separa a saída por instrução, usando marcas que o painel escreve. A marca é uma tag
 * hexadecimal aleatória PRÓPRIA da execução, diferente da tag da sessão (essa aparece em application_name e nos
 * bloqueios do banco, então não serve de segredo).
 *
 * O texto do usuário NUNCA passa pelo leitor do cliente. PostgreSQL: cada instrução vai em hexadecimal e é executada
 * por `SELECT convert_from(decode('<hex>','hex'),'UTF8') \gexec`; o psql só vê o nosso script fixo, então `\!`, `\c`
 * ou `\o` escondidos por diferenças entre o leitor do psql e o nosso são só texto SQL, que o servidor recusa.
 * MySQL/MariaDB em leitura: PREPARE/EXECUTE por instrução.
 *
 * Funções puras. O texto do usuário já passou por `analyzeSqlScript` (cada instrução é UMA instrução).
 */
import type { DatabaseSqlEngine } from "@paas/core";
import { DB_SECONDS, isTag, nullsFromPgCsv, parseCsv, parseXmlRows, pgLimits } from "./database-sql.js";

const markOf = (tag: string): string => {
  if (!isTag(tag)) throw new Error("tag inválida");
  return tag;
};

/** PostgreSQL: cada instrução entre duas marcas, em hexadecimal, executada por \gexec (o psql nunca lê o texto). */
function pgBody(statements: readonly string[], mark: string): string[] {
  return statements.flatMap((st, i) => [
    `\\echo '${mark} S ${i + 1}'`,
    `SELECT convert_from(decode('${Buffer.from(st, "utf8").toString("hex")}', 'hex'), 'UTF8') \\gexec`,
    `\\echo '${mark} E ${i + 1}'`,
  ]);
}

/**
 * Consulta de LEITURA com várias instruções, numa transação somente leitura só.
 * PostgreSQL: o texto vai pela entrada padrão do psql. MySQL/MariaDB: cada instrução em hexadecimal, uma a uma, por
 * PREPARE/EXECUTE (o texto do usuário NUNCA passa pelo separador do cliente), com as marcas como pequenas consultas.
 */
export function readScriptSql(engine: DatabaseSqlEngine, statements: readonly string[], tag: string): string {
  const mark = markOf(tag);
  if (engine === "postgres") {
    return [
      "BEGIN READ ONLY;",
      `SET LOCAL statement_timeout = '${DB_SECONDS.read}s';`,
      "SET LOCAL lock_timeout = '5s';",
      "SET LOCAL standard_conforming_strings = on;",
      ...pgBody(statements, mark),
      "ROLLBACK;",
      "",
    ].join("\n");
  }
  const body = statements.flatMap((st, i) => [
    `SELECT '${mark} S ${i + 1}' AS tws_m;`,
    `SET @tws_q = CONVERT(X'${Buffer.from(st, "utf8").toString("hex")}' USING utf8mb4);`,
    "PREPARE tws_s FROM @tws_q;",
    "EXECUTE tws_s;",
    `SELECT '${mark} E ${i + 1}' AS tws_m, ROW_COUNT() AS tws_n;`,
    "DEALLOCATE PREPARE tws_s;",
  ]);
  return ["SET SESSION TRANSACTION READ ONLY;", "SET NAMES utf8mb4;", "SET SESSION sql_mode = '';", "START TRANSACTION READ ONLY;", ...body, "ROLLBACK;", ""].join("\n");
}

/**
 * Escrita com várias instruções (só com a edição liberada). PostgreSQL: com `transaction`, tudo entre BEGIN e
 * COMMIT; o psql roda com ON_ERROR_STOP, então no primeiro erro ele sai e a transação aberta é desfeita ao fechar a
 * conexão. MySQL/MariaDB: as instruções vão ao cliente (`--binary-mode`), uma após a outra; o DDL confirma sozinho,
 * então não há transação.
 */
export function writeScriptSql(engine: DatabaseSqlEngine, statements: readonly string[], tag: string, transaction: boolean): string {
  const mark = markOf(tag);
  if (engine === "postgres") {
    return [
      pgLimits(DB_SECONDS.write).trimEnd(),
      "SET standard_conforming_strings = on;",
      ...(transaction ? ["BEGIN;"] : []),
      ...pgBody(statements, mark),
      ...(transaction ? ["COMMIT;"] : []),
      "",
    ].join("\n");
  }
  const body = statements.flatMap((st, i) => [`SELECT '${mark} S ${i + 1}' AS tws_m;`, st, ";", `SELECT '${mark} E ${i + 1}' AS tws_m, ROW_COUNT() AS tws_n;`]);
  return [...body, ""].join("\n");
}

/** O que a saída trouxe de UMA instrução. */
export interface ScriptSegment {
  index: number;
  /** A marca de abertura apareceu. */
  started: boolean;
  /** A marca de fechamento apareceu (a instrução terminou). */
  ended: boolean;
  table: Array<Array<string | null>>;
  affected: number | null;
}

const emptySegment = (index: number): ScriptSegment => ({ index, started: false, ended: false, table: [], affected: null });
const affectedOf = (text: string | null | undefined): number | null => (typeof text === "string" && /^\d+$/.test(text.trim()) ? Number(text.trim()) : null);
const segmentsFor = (total: number): ScriptSegment[] => Array.from({ length: total }, (_x, i) => emptySegment(i + 1));

/** Saída do psql (--csv) separada pelas marcas. O texto de um segmento é CSV; NULL vem pela marca própria. */
export function parsePgScriptOutput(stdout: string, tag: string, total: number): ScriptSegment[] {
  const re = new RegExp(`^${markOf(tag)} ([SE]) (\\d+)(?: .*)?$`);
  const segments = segmentsFor(total);
  let current: ScriptSegment | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current) current.table = nullsFromPgCsv(parseCsv(buf.length > 0 ? `${buf.join("\n")}\n` : ""));
    buf = [];
  };
  const lines = stdout.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    const m = re.exec(line);
    const seg = m ? segments[Number(m[2]) - 1] : undefined;
    if (m && seg) {
      flush();
      if (m[1] === "S") {
        current = seg;
        seg.started = true;
      } else {
        // :ROW_COUNT do psql 15+ depois de \\gexec é a contagem do SELECT de fora (sempre 1): nunca mostrar número errado
        seg.ended = true;
        current = null;
      }
    } else if (current) buf.push(line);
  }
  flush();
  return segments;
}

/**
 * Saída `--xml` do cliente mysql/mariadb com as marcas (pequenas consultas `tws_m`/`tws_n`). Só as LINHAS de cada
 * conjunto de resultados importam (o atributo `statement` do cabeçalho é ignorado). Fica o primeiro conjunto de
 * resultados da instrução; ROW_COUNT() negativo (SELECT) não é "linhas afetadas".
 */
export function parseMyScriptOutput(stdout: string, tag: string, total: number): ScriptSegment[] {
  const re = new RegExp(`^${markOf(tag)} ([SE]) (\\d+)$`);
  const segments = segmentsFor(total);
  let current: ScriptSegment | null = null;
  for (const chunk of stdout.split("</resultset>")) {
    const table = parseXmlRows(chunk);
    const first = table[1];
    const m = table[0]?.[0] === "tws_m" && first?.[0] ? re.exec(first[0]) : null;
    const seg = m ? segments[Number(m[2]) - 1] : undefined;
    if (m && seg) {
      if (m[1] === "S") {
        current = seg;
        seg.started = true;
      } else {
        seg.ended = true;
        seg.affected = affectedOf(first?.[1]);
        current = null;
      }
    } else if (current && table.length > 0 && current.table.length === 0) current.table = table;
  }
  return segments;
}
