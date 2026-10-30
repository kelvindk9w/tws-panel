/**
 * database-sql.ts — o SQL e os scripts da aba Banco (funções puras).
 *
 * Os scripts rodam DENTRO do container do banco (`sh -c`) e leem as credenciais das variáveis do próprio container
 * (PG_ENV / MY_ENV, as mesmas do backup): nenhuma senha passa pelo painel nem pela linha de comando do `docker exec`.
 * O SQL entra pela entrada padrão. Nomes de tabela só chegam aqui depois de conferidos contra a lista que o banco
 * devolveu e são sempre citados (aspas duplas no PostgreSQL, crases no MySQL/MariaDB).
 */
import { DATABASE_READ_TIMEOUT_SEC, type DatabaseSqlEngine, type DatabaseSqlResult, type DatabaseTable, type DatabaseTableRef } from "@paas/core";
import { MY_ENV, PG_ENV } from "./backup-detect.js";

// ---------------------------------------------------------------------------
// Identificadores
// ---------------------------------------------------------------------------

/** Nome utilizável: sem caractere de controle (nem quebra de linha) e de tamanho razoável. */
export function isSafeName(name: string): boolean {
  // eslint-disable-next-line no-control-regex
  return name.length > 0 && name.length <= 255 && !/[\u0000-\u001f\u007f]/.test(name);
}

export const quotePg = (name: string): string => `"${name.replace(/"/g, '""')}"`;
export const quoteMy = (name: string): string => `\`${name.replace(/`/g, "``")}\``;

/** Nome do banco vindo do ambiente do container: não pode virar opção do cliente. */
export function isSafeDatabaseName(name: string): boolean {
  return isSafeName(name) && !name.startsWith("-");
}

export function tableKey(t: { schema: string | null; name: string }): string {
  return `${t.schema ?? ""}\u0000${t.name}`;
}

/**
 * Confere os pedidos contra as tabelas reais do banco. Devolve as tabelas (sem repetir) ou o primeiro pedido que
 * não existe. No PostgreSQL, sem esquema informado vale o `public`.
 */
export function matchTables(
  engine: DatabaseSqlEngine,
  actual: readonly DatabaseTable[],
  requested: readonly DatabaseTableRef[],
): { ok: true; tables: DatabaseTable[] } | { ok: false; name: string } {
  const byKey = new Map(actual.map((t) => [tableKey(t), t]));
  const chosen = new Map<string, DatabaseTable>();
  for (const ref of requested) {
    const schema = engine === "postgres" ? (ref.schema ?? "public") : null;
    const found = byKey.get(tableKey({ schema, name: ref.name }));
    if (!found) return { ok: false, name: ref.name };
    chosen.set(tableKey(found), found);
  }
  return { ok: true, tables: [...chosen.values()] };
}

// ---------------------------------------------------------------------------
// Scripts (argumento 1 = nome do banco)
// ---------------------------------------------------------------------------

const PG_CONNECT = ["PGCONNECT_TIMEOUT=10", "export PGCONNECT_TIMEOUT"].join("\n");

/** psql contra o banco "$1". `flags`: formato de saída. */
export function pgScript(flags: string): string {
  return [PG_ENV, PG_CONNECT, `exec psql -U "$U" -d "$1" -X -q -v ON_ERROR_STOP=1 ${flags}`].join("\n");
}

/** Cliente mysql/mariadb contra o banco "$1". */
export function myScript(flags: string): string {
  return [MY_ENV, `exec $CLI -u"$U" -D "$1" --connect-timeout=10 ${flags}`].join("\n");
}

export function scriptFor(engine: DatabaseSqlEngine, format: "scalar" | "table" | "exec"): string {
  if (engine === "postgres") return pgScript(format === "scalar" ? "-At" : format === "table" ? "--csv -P null=NULL" : "");
  return myScript(format === "scalar" ? "-N -B" : format === "table" ? "-B" : "");
}

// ---------------------------------------------------------------------------
// Visão geral
// ---------------------------------------------------------------------------

export const PG_OVERVIEW_SQL = `BEGIN READ ONLY;
SET LOCAL statement_timeout = '${DATABASE_READ_TIMEOUT_SEC}s';
select json_build_object(
  'version', current_setting('server_version'),
  'database', current_database(),
  'sizeBytes', pg_database_size(current_database()),
  'tables', coalesce((
    select json_agg(json_build_object(
      'schema', n.nspname,
      'name', c.relname,
      'rows', case when c.reltuples < 0 then null else c.reltuples::bigint end,
      'sizeBytes', pg_total_relation_size(c.oid)
    ) order by n.nspname, c.relname)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and not c.relispartition
      and n.nspname not in ('pg_catalog', 'information_schema')
      and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp\\_%'
  ), '[]'::json)
);
ROLLBACK;
`;

export const MY_OVERVIEW_SQL = `SET SESSION TRANSACTION READ ONLY;
SELECT 'V', VERSION();
SELECT 'D', DATABASE();
SELECT 'T', table_name, IFNULL(table_rows, ''), IFNULL(data_length + index_length, '') FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type NOT IN ('VIEW', 'SYSTEM VIEW', 'SEQUENCE') ORDER BY table_name;
SELECT 'S', IFNULL(SUM(data_length + index_length), 0) FROM information_schema.tables WHERE table_schema = DATABASE();
`;

export interface ParsedOverview {
  version: string | null;
  database: string | null;
  sizeBytes: number | null;
  tables: DatabaseTable[];
}

const toNumber = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};

/** Resposta do script do PostgreSQL (um JSON). Devolve null se não for o que se espera. */
export function parsePgOverview(stdout: string): ParsedOverview | null {
  try {
    const raw = JSON.parse(stdout.trim()) as Record<string, unknown>;
    const list = Array.isArray(raw.tables) ? (raw.tables as Array<Record<string, unknown>>) : [];
    return {
      version: typeof raw.version === "string" ? raw.version : null,
      database: typeof raw.database === "string" ? raw.database : null,
      sizeBytes: toNumber(raw.sizeBytes),
      tables: list.map((t) => ({
        schema: typeof t.schema === "string" ? t.schema : null,
        name: String(t.name),
        rows: toNumber(t.rows),
        sizeBytes: toNumber(t.sizeBytes),
      })),
    };
  } catch {
    return null;
  }
}

/** Resposta do script do MySQL/MariaDB (linhas marcadas V, D, T e S, separadas por tab). */
export function parseMyOverview(stdout: string): ParsedOverview | null {
  const out: ParsedOverview = { version: null, database: null, sizeBytes: null, tables: [] };
  let seen = false;
  for (const row of parseTsv(stdout, false)) {
    const [tag, a, b, c] = row as string[];
    if (tag === "V") out.version = a ?? null;
    else if (tag === "D") out.database = a ?? null;
    else if (tag === "S") out.sizeBytes = toNumber(a);
    else if (tag === "T" && a !== undefined) out.tables.push({ schema: null, name: a, rows: toNumber(b), sizeBytes: toNumber(c) });
    else continue;
    seen = true;
  }
  return seen ? out : null;
}

// ---------------------------------------------------------------------------
// Esvaziar tabelas
// ---------------------------------------------------------------------------

export function pgTruncateSql(tables: readonly DatabaseTable[], cascade: boolean): string {
  const list = tables.map((t) => `${quotePg(t.schema ?? "public")}.${quotePg(t.name)}`).join(", ");
  return `SET lock_timeout = '15s';\nTRUNCATE TABLE ${list} RESTART IDENTITY${cascade ? " CASCADE" : ""};\n`;
}

/** MySQL/MariaDB: sem chave estrangeira na sessão durante a operação (e de volta ao final). */
export function myTruncateSql(tables: readonly DatabaseTable[]): string {
  return ["SET FOREIGN_KEY_CHECKS = 0;", ...tables.map((t) => `TRUNCATE TABLE ${quoteMy(t.name)};`), "SET FOREIGN_KEY_CHECKS = 1;", ""].join("\n");
}

// ---------------------------------------------------------------------------
// Zerar o banco
// ---------------------------------------------------------------------------

/**
 * PostgreSQL: apaga os OBJETOS de todos os esquemas de usuário e mantém os esquemas, o dono, as permissões e as
 * extensões. Não usa `DROP SCHEMA public CASCADE`: isso levaria junto as extensões instaladas em `public`
 * (pgcrypto, uuid-ossp...), o dono e as permissões do esquema, e o recriar de volta exigiria adivinhá-los.
 * Roda como UM comando (DO) — ou apaga tudo, ou nada. Fica de fora o que pertence a uma extensão.
 */
export const PG_RESET_SQL = `SET lock_timeout = '15s';
DO $tws_reset$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS s, c.relname AS o, c.relkind AS k
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S', 'c') AND NOT c.relispartition
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('e', 'a', 'i'))
    ORDER BY CASE c.relkind WHEN 'v' THEN 0 WHEN 'm' THEN 0 WHEN 'f' THEN 1 WHEN 'r' THEN 2 WHEN 'p' THEN 2 WHEN 'S' THEN 3 ELSE 4 END
  LOOP
    EXECUTE format('DROP %s IF EXISTS %I.%I CASCADE',
      CASE r.k WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' WHEN 'S' THEN 'SEQUENCE' WHEN 'c' THEN 'TYPE' ELSE 'TABLE' END,
      r.s, r.o);
  END LOOP;
  FOR r IN
    SELECT n.nspname AS s, p.proname AS o, p.prokind AS k, pg_get_function_identity_arguments(p.oid) AS a
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('DROP %s IF EXISTS %I.%I(%s) CASCADE',
      CASE r.k WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END, r.s, r.o, r.a);
  END LOOP;
  FOR r IN
    SELECT n.nspname AS s, t.typname AS o, t.typtype AS k
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typtype IN ('e', 'd', 'r') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('DROP %s IF EXISTS %I.%I CASCADE', CASE r.k WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, r.s, r.o);
  END LOOP;
END
$tws_reset$;
`;

export const MY_OBJECTS_SQL = `SELECT 'T', table_name, table_type FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type <> 'SYSTEM VIEW';
SELECT 'R', routine_type, routine_name FROM information_schema.routines WHERE routine_schema = DATABASE();
SELECT 'E', event_name FROM information_schema.events WHERE event_schema = DATABASE();
`;

export interface MyObjects {
  tables: string[];
  views: string[];
  sequences: string[];
  routines: Array<{ type: "PROCEDURE" | "FUNCTION"; name: string }>;
  events: string[];
}

export function parseMyObjects(stdout: string): MyObjects {
  const out: MyObjects = { tables: [], views: [], sequences: [], routines: [], events: [] };
  for (const [tag, a, b] of parseTsv(stdout, false) as string[][]) {
    if (tag === "T" && a !== undefined) {
      if (b === "VIEW") out.views.push(a);
      else if (b === "SEQUENCE") out.sequences.push(a);
      else out.tables.push(a);
    } else if (tag === "R" && b !== undefined) out.routines.push({ type: a === "PROCEDURE" ? "PROCEDURE" : "FUNCTION", name: b });
    else if (tag === "E" && a !== undefined) out.events.push(a);
  }
  return out;
}

export function allMyNames(o: MyObjects): string[] {
  return [...o.tables, ...o.views, ...o.sequences, ...o.routines.map((r) => r.name), ...o.events];
}

/** MySQL/MariaDB: tabelas, visões, sequências, rotinas e eventos do banco, com a checagem de chaves desligada. */
export function myResetSql(o: MyObjects): string {
  const lines = ["SET FOREIGN_KEY_CHECKS = 0;"];
  if (o.views.length > 0) lines.push(`DROP VIEW IF EXISTS ${o.views.map(quoteMy).join(", ")};`);
  if (o.tables.length > 0) lines.push(`DROP TABLE IF EXISTS ${o.tables.map(quoteMy).join(", ")};`);
  if (o.sequences.length > 0) lines.push(`DROP SEQUENCE IF EXISTS ${o.sequences.map(quoteMy).join(", ")};`);
  for (const r of o.routines) lines.push(`DROP ${r.type} IF EXISTS ${quoteMy(r.name)};`);
  for (const e of o.events) lines.push(`DROP EVENT IF EXISTS ${quoteMy(e)};`);
  lines.push("SET FOREIGN_KEY_CHECKS = 1;", "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Console SQL
// ---------------------------------------------------------------------------

/**
 * Consulta de LEITURA: o banco recusa qualquer escrita (transação somente leitura) e interrompe no prazo.
 * `statement` já passou por `analyzeSql` (uma instrução só); o `;` vem numa linha própria para um comentário
 * no fim do texto não o engolir.
 */
export function readSql(engine: DatabaseSqlEngine, statement: string): string {
  if (engine === "postgres") {
    return `BEGIN READ ONLY;\nSET LOCAL statement_timeout = '${DATABASE_READ_TIMEOUT_SEC}s';\nSET LOCAL standard_conforming_strings = on;\n${statement}\n;\nROLLBACK;\n`;
  }
  const timeout = engine === "mariadb" ? `SET SESSION max_statement_time = ${DATABASE_READ_TIMEOUT_SEC};` : `SET SESSION max_execution_time = ${DATABASE_READ_TIMEOUT_SEC * 1000};`;
  return `SET SESSION TRANSACTION READ ONLY;\n${timeout}\nSTART TRANSACTION READ ONLY;\n${statement}\n;\nROLLBACK;\n`;
}

/** Comando de escrita (já autorizado com senha + 2FA): roda como está, com um prazo maior. */
export function writeSql(engine: DatabaseSqlEngine, statement: string): string {
  if (engine === "postgres") return `SET statement_timeout = '120s';\nSET standard_conforming_strings = on;\n${statement}\n;\n`;
  return `${statement}\n;\n`;
}

// ---------------------------------------------------------------------------
// Leitura da saída
// ---------------------------------------------------------------------------

const MYSQL_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0", "\\": "\\" };

/** Saída `-B` do cliente mysql: tab entre colunas, `\n`, `\t`, `\\` escapados. `NULL` vira null quando `nulls`. */
export function parseTsv(text: string, nulls = true): Array<Array<string | null>> {
  const rows: Array<Array<string | null>> = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    rows.push(
      line.split("\t").map((cell) => {
        if (nulls && cell === "NULL") return null;
        return cell.replace(/\\([ntr0\\])/g, (_m, ch: string) => MYSQL_ESCAPES[ch]!);
      }),
    );
  }
  return rows;
}

/** CSV (RFC 4180) do `psql --csv`: aspas duplas, `""` dentro de campo e quebra de linha dentro de campo. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') {
      quoted = true;
      started = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
      started = true;
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      started = false;
    } else if (c !== "\r") {
      field += c;
      started = true;
    }
  }
  if (started || field !== "") {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Cabeçalho + linhas viram o resultado da tela, cortado em `cap` linhas. */
export function toSqlResult(table: Array<Array<string | null>>, cap: number, cut: boolean): DatabaseSqlResult {
  if (table.length === 0) return { columns: [], rows: [], truncated: cut, empty: true };
  const columns = (table[0] as Array<string | null>).map((c) => c ?? "");
  const body = table.slice(1);
  const rows = body.slice(0, cap).map((r) => columns.map((_c, i) => (r[i] === "NULL" ? null : (r[i] ?? null))));
  return { columns, rows, truncated: cut || body.length > cap, empty: false };
}
