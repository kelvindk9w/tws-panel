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

/** Marca de NULL na saída do psql: um texto 'NULL' de verdade não pode ser confundido com ausência de valor. */
export const PG_NULL_TOKEN = "\u0001TWS_NULL\u0001";

/** psql contra o banco "$1". `flags`: formato de saída. */
export function pgScript(flags: string): string {
  return [PG_ENV, PG_CONNECT, `exec psql -U "$U" -d "$1" -X -q -v ON_ERROR_STOP=1 ${flags}`].join("\n");
}

/**
 * Prazos que o BANCO impõe, em segundos. Cada um é MENOR que o prazo do painel (database-service.ts), para o banco
 * desistir antes de o painel parar de esperar.
 */
export const DB_SECONDS = { read: 15, write: 120, action: 540 } as const;

/**
 * Cliente mysql/mariadb contra o banco "$1". Com `seconds`, a sessão já nasce com os prazos do próprio servidor
 * (`--init-command`): espera de bloqueio (lock_wait_timeout) e tempo de execução, que tem outro nome no MariaDB
 * (max_statement_time, em segundos, vale para qualquer comando) e no MySQL (max_execution_time, em ms, SÓ para
 * SELECT). A variante vem do motor detectado do projeto, não do nome do binário do cliente.
 */
export function myScript(flags: string, seconds?: number, variant: "mysql" | "mariadb" = "mysql"): string {
  let init = "";
  if (seconds !== undefined) {
    const limit = variant === "mariadb" ? `max_statement_time=${seconds}` : `max_execution_time=${seconds * 1000}`;
    init = ` --init-command="SET SESSION lock_wait_timeout=15, ${limit}"`;
  }
  return [MY_ENV, `exec $CLI -u"$U" -D "$1" --connect-timeout=10${init} ${flags}`].join("\n");
}

/**
 * Qual saída o serviço quer: `scalar` (visão geral, sem formatação), `table` (resultado de consulta: CSV no psql,
 * XML no mysql, que distingue NULL de 'NULL') ou `exec` (ação sem resultado). `seconds` = prazo do servidor.
 */
export function scriptFor(engine: DatabaseSqlEngine, format: "scalar" | "table" | "exec", seconds?: number, binary = false, readOnly = false): string {
  if (engine === "postgres") {
    const flags = format === "scalar" ? "-At" : format === "table" ? '--csv -P "null=$NT"' : "";
    let script = pgScript(flags);
    // Leitura: a sessão já NASCE somente leitura (além do BEGIN READ ONLY): um COMMIT escondido cai em outra transação somente leitura
    if (readOnly) script = script.replace("exec psql", `PGOPTIONS="\${PGOPTIONS:-} -c default_transaction_read_only=on"\nexport PGOPTIONS\nexec psql`);
    return format === "table" ? script.replace("exec psql", `NT=$(printf '\\001TWS_NULL\\001')\nexec psql`) : script;
  }
  return myScript(format === "scalar" ? "-N -B" : format === "table" ? (binary ? "--xml --binary-mode" : "--xml") : "", seconds, engine === "mariadb" ? "mariadb" : "mysql");
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

/** Prazos do próprio servidor: esperar um bloqueio no máximo 15 s e o comando inteiro no máximo `seconds`. */
export const pgLimits = (seconds: number): string => `SET lock_timeout = '15s';\nSET statement_timeout = '${seconds}s';\n`;
/** Esvaziar e zerar. */
export const PG_LIMITS = pgLimits(DB_SECONDS.action);

export function pgTruncateSql(tables: readonly DatabaseTable[], cascade: boolean): string {
  const list = tables.map((t) => `${quotePg(t.schema ?? "public")}.${quotePg(t.name)}`).join(", ");
  return `${PG_LIMITS}TRUNCATE TABLE ${list} RESTART IDENTITY${cascade ? " CASCADE" : ""};\n`;
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
export const PG_RESET_SQL = `${PG_LIMITS}DO $tws_reset$
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
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype IN ('e', 'i'))
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
 * `statement` já passou por `analyzeSql` (uma instrução só).
 *
 * PostgreSQL: o psql separa o texto pela entrada padrão; o `;` vem numa linha própria para um comentário no fim do
 * texto não o engolir.
 * MySQL/MariaDB: o texto do usuário NUNCA passa pelo separador do cliente (que lê aspas e `\` diferente do
 * servidor conforme o sql_mode e poderia soltar vários comandos). Ele vai em hexadecimal para uma variável e é
 * executado por PREPARE, que só aceita UMA instrução. Antes, `sql_mode=''` tira ANSI_QUOTES e
 * NO_BACKSLASH_ESCAPES da sessão. Alguns comandos não passam pelo PREPARE (erro 1295): ver `isPrepareUnsupported`.
 */
export function readSql(engine: DatabaseSqlEngine, statement: string): string {
  if (engine === "postgres") {
    return `BEGIN READ ONLY;\nSET LOCAL statement_timeout = '${DB_SECONDS.read}s';\nSET LOCAL lock_timeout = '5s';\nSET LOCAL standard_conforming_strings = on;\n${statement}\n;\nROLLBACK;\n`;
  }
  const hex = Buffer.from(statement, "utf8").toString("hex");
  return [
    "SET SESSION TRANSACTION READ ONLY;",
    "SET NAMES utf8mb4;",
    "SET SESSION sql_mode = '';",
    "START TRANSACTION READ ONLY;",
    `SET @tws_q = CONVERT(X'${hex}' USING utf8mb4);`,
    "PREPARE tws_s FROM @tws_q;",
    "EXECUTE tws_s;",
    "DEALLOCATE PREPARE tws_s;",
    "ROLLBACK;",
    "",
  ].join("\n");
}

/** O MySQL/MariaDB não aceita este comando em PREPARE (erro 1295): a consulta de leitura não pode rodar assim. */
export function isPrepareUnsupported(stderr: string): boolean {
  return /\b1295\b|prepared statement protocol/i.test(stderr);
}

/** Comando de escrita (já autorizado com senha + 2FA): roda como está, com prazos do servidor. */
export function writeSql(engine: DatabaseSqlEngine, statement: string): string {
  if (engine === "postgres") return `${pgLimits(DB_SECONDS.write)}SET standard_conforming_strings = on;\n${statement}\n;\n`;
  return `${statement}\n;\n`;
}

/**
 * Erro do banco (stderr) -> código estável para a tela. Prazo do servidor e falta de memória de bloqueios têm
 * texto próprio; o resto fica genérico, com o motivo à parte.
 */
export function classifyDbError(stderr: string): "db_timeout" | "too_many_locks" | null {
  if (/max_locks_per_transaction|out of shared memory/i.test(stderr)) return "too_many_locks";
  if (/statement timeout|lock timeout|Lock wait timeout|maximum statement execution time|max_statement_time|Query execution was interrupted/i.test(stderr)) return "db_timeout";
  return null;
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
  const rows = body.slice(0, cap).map((r) => columns.map((_c, i) => r[i] ?? null));
  return { columns, rows, truncated: cut || body.length > cap, empty: false };
}

const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const unxml = (v: string): string =>
  v.replace(/&(#x[0-9a-f]+|#[0-9]+|lt|gt|amp|quot|apos);/gi, (_m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return XML_ENTITIES[e.toLowerCase()]!;
  });

/**
 * Saída `--xml` do cliente mysql/mariadb: `<row><field name="c">v</field><field name="c" xsi:nil="true" /></row>`.
 * Devolve o cabeçalho (nomes do primeiro registro) + as linhas; NULL vira null (um texto 'NULL' continua texto).
 */
export function parseXmlRows(text: string): Array<Array<string | null>> {
  const rows: Array<Array<string | null>> = [];
  const columns: string[] = [];
  const rowRe = /<row>([\s\S]*?)<\/row>/g;
  const fieldRe = /<field\s+name="([^"]*)"\s*(?:(?:xsi:)?nil="true"\s*\/>|\/>|>([\s\S]*?)<\/field>)/g;
  for (let m = rowRe.exec(text); m !== null; m = rowRe.exec(text)) {
    const cells: Array<string | null> = [];
    for (let f = fieldRe.exec(m[1]!); f !== null; f = fieldRe.exec(m[1]!)) {
      if (rows.length === 0) columns.push(unxml(f[1]!));
      cells.push(f[2] === undefined ? (/nil=/.test(f[0]) ? null : "") : unxml(f[2]));
    }
    rows.push(cells);
  }
  return rows.length === 0 ? [] : [columns, ...rows];
}

/** psql --csv com a marca de NULL: cada célula igual à marca vira null. */
export function nullsFromPgCsv(table: string[][]): Array<Array<string | null>> {
  return table.map((r) => r.map((c) => (c === PG_NULL_TOKEN ? null : c)));
}

// ---------------------------------------------------------------------------
// Marca da sessão e parada do que ficou rodando
// ---------------------------------------------------------------------------

/** Marca única da execução (gerada pelo painel): hexadecimal, nunca texto do usuário. */
export const isTag = (tag: string): boolean => /^[0-9a-f]{8,32}$/.test(tag);

/**
 * Primeira instrução da sessão: marca a conexão para o painel achá-la e cancelá-la se passar do prazo.
 * PostgreSQL: application_name. MySQL/MariaDB: um GET_LOCK nomeado (quem o segura é a conexão; IS_USED_LOCK devolve o
 * id dela). `DO` não imprime nada, então não suja a saída.
 */
export function sessionTag(engine: DatabaseSqlEngine, tag: string): string {
  if (!isTag(tag)) throw new Error("tag inválida");
  return engine === "postgres" ? `SET application_name = 'tws-db-${tag}';\n` : `DO GET_LOCK('tws-db-${tag}', 0);\n`;
}

/**
 * Script (dentro do container do banco) que CANCELA o que a sessão marcada ainda executa e imprime quantas
 * conexões dela continuam ocupadas ("0" = parou, ou já tinha terminado). PostgreSQL: pg_cancel_backend e, se
 * preciso, pg_terminate_backend pelo application_name. MySQL/MariaDB: KILL QUERY no id que segura o lock.
 */
export function cancelScript(engine: DatabaseSqlEngine, tag: string): string {
  if (!isTag(tag)) throw new Error("tag inválida");
  const name = `tws-db-${tag}`;
  if (engine === "postgres") {
    const where = `application_name = '${name}' and pid <> pg_backend_pid()`;
    const q = (sql: string) => `psql -U "$U" -d template1 -AtX -c "${sql}"`;
    return [
      PG_ENV,
      PG_CONNECT,
      `${q(`select pg_cancel_backend(pid) from pg_stat_activity where ${where}`)} >/dev/null 2>&1`,
      "sleep 1",
      `${q(`select pg_terminate_backend(pid) from pg_stat_activity where ${where}`)} >/dev/null 2>&1`,
      "sleep 1",
      q(`select count(*) from pg_stat_activity where ${where}`),
    ].join("\n");
  }
  return [
    MY_ENV,
    // Cliente que falha NÃO é "sem sessão": só o texto NULL (ninguém segura o lock) significa que nada roda
    `ID=$($CLI -u"$U" -N -B -e "select is_used_lock('${name}')") || { echo 1; exit 0; }`,
    'case "$ID" in NULL) echo 0; exit 0;; ""|*[!0-9]*) echo 1; exit 0;; esac',
    '$CLI -u"$U" -e "kill query $ID" >/dev/null 2>&1',
    "sleep 1",
    '$CLI -u"$U" -N -B -e "select count(*) from information_schema.processlist where id = $ID and command <> \'Sleep\'"',
  ].join("\n");
}

/**
 * Script que encerra o processo do cliente/comando gravado em "$1" (arquivo com o pid) e remove o arquivo.
 * Antes de matar confere em /proc/<pid>/cmdline que o argv[0] (só o nome do programa) ainda casa EXATAMENTE com "$2"
 * (expressão para grep -E ancorada, ex.: ^(sh|psql)$; "mysqld" ou "php-fpm" nunca casam com "mysql" ou "php");
 * pid que já não existe ou virou outro processo conta como "parou". Sem /proc legível de um processo vivo, não mata.
 */
/** Programas que o painel pode encerrar: o cliente do banco (ou o `sh` que ainda não deu exec) e o PHP do artisan. */
export const KILL_EXPECT_DB = "^(sh|psql|mysql|mariadb)$";
export const killExpectFor = (program: string): string => `^(sh|${program.replace(/[^A-Za-z0-9_-]/g, "") || "sh"})$`;

export const KILL_SCRIPT = [
  'f="$1"',
  'p=$(cat "$f" 2>/dev/null)',
  'case "$p" in ""|*[!0-9]*) rm -f "$f"; exit 1;; esac',
  'r=0',
  'if [ -d "/proc/$p" ]; then',
  '  if [ -r "/proc/$p/cmdline" ]; then',
  // argv[0] (campo separado por NUL), só o nome do programa: "mysqld", "mariadbd" ou "php-fpm" não casam com "mysql", "mariadb" ou "php"
  "    a0=$(tr '\\000' '\\n' < \"/proc/$p/cmdline\" | head -n 1); a0=${a0##*/}",
  '    if printf "%s\\n" "$a0" | grep -Eq "$2"; then kill -KILL "$p"; r=$?; fi',
  "  else r=1; fi",
  "fi",
  'rm -f "$f"',
  "exit $r",
].join("\n");
