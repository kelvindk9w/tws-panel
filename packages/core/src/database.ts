/**
 * database.ts — aba "Banco" do projeto: visão geral do banco (motor, versão, tabelas), esvaziar tabelas,
 * zerar o banco, comando do framework e console SQL.
 *
 * Contrato compartilhado entre servidor e interface, mais o classificador de SQL (`analyzeSql`): ele separa
 * consulta de leitura de comando de escrita e recusa o que não é UMA instrução. O classificador é só a primeira
 * barreira; a leitura é imposta de verdade pelo banco (transação somente leitura) e a escrita pede senha + 2FA.
 */
import type { BackupDatabaseEngine } from "./backups";

/** Motores com suporte completo (visão geral, esvaziar, zerar, console). */
export type DatabaseSqlEngine = "postgres" | "mysql" | "mariadb";
export const DATABASE_SQL_ENGINES: readonly DatabaseSqlEngine[] = ["postgres", "mysql", "mariadb"];

export function isDatabaseSqlEngine(engine: BackupDatabaseEngine | string | null | undefined): engine is DatabaseSqlEngine {
  return engine === "postgres" || engine === "mysql" || engine === "mariadb";
}

/** Linhas devolvidas por uma consulta do console; o resto é cortado. */
export const DATABASE_SQL_ROW_CAP = 500;
/** Tamanho máximo do texto SQL aceito. */
export const DATABASE_SQL_MAX_LENGTH = 20_000;
/** Tabelas por pedido de esvaziar. */
export const DATABASE_TRUNCATE_MAX_TABLES = 500;
/** Prazo de uma consulta de leitura, em segundos (o banco a interrompe). */
export const DATABASE_READ_TIMEOUT_SEC = 15;

// ---------------------------------------------------------------------------
// Comandos do framework (lista fechada; nunca texto livre)
// ---------------------------------------------------------------------------

export type DatabaseFramework = "laravel";

export const DATABASE_COMMAND_IDS = ["laravel-migrate-fresh-seed", "laravel-migrate", "laravel-seed"] as const;
export type DatabaseCommandId = (typeof DATABASE_COMMAND_IDS)[number];

export interface DatabaseCommandInfo {
  id: DatabaseCommandId;
  framework: DatabaseFramework;
  /** Linha de comando exibida (é exatamente o que roda, sem interpretação de shell). */
  display: string;
  /** Apaga as tabelas antes (migrate:fresh): a tela avisa com mais ênfase. */
  dropsData: boolean;
}

/** Argumentos de cada comando (vetor, sem shell). `--force` evita a pergunta de confirmação em produção. */
export const DATABASE_COMMANDS: Readonly<Record<DatabaseCommandId, { framework: DatabaseFramework; argv: readonly string[]; dropsData: boolean }>> = {
  "laravel-migrate-fresh-seed": { framework: "laravel", argv: ["php", "artisan", "migrate:fresh", "--seed", "--force", "--no-interaction", "--no-ansi"], dropsData: true },
  "laravel-migrate": { framework: "laravel", argv: ["php", "artisan", "migrate", "--force", "--no-interaction", "--no-ansi"], dropsData: false },
  "laravel-seed": { framework: "laravel", argv: ["php", "artisan", "db:seed", "--force", "--no-interaction", "--no-ansi"], dropsData: false },
};

export function isDatabaseCommandId(value: unknown): value is DatabaseCommandId {
  return typeof value === "string" && (DATABASE_COMMAND_IDS as readonly string[]).includes(value);
}

/** Comandos que valem para o framework detectado (nenhum se não reconheceu). */
export function databaseCommandsFor(framework: DatabaseFramework | null): DatabaseCommandInfo[] {
  if (!framework) return [];
  return DATABASE_COMMAND_IDS.filter((id) => DATABASE_COMMANDS[id].framework === framework).map((id) => ({
    id,
    framework,
    display: DATABASE_COMMANDS[id].argv.join(" "),
    dropsData: DATABASE_COMMANDS[id].dropsData,
  }));
}

// ---------------------------------------------------------------------------
// Visão geral
// ---------------------------------------------------------------------------

export interface DatabaseTable {
  /** Esquema (PostgreSQL); null no MySQL/MariaDB. */
  schema: string | null;
  name: string;
  /** Linhas aproximadas (estatística do banco); null = sem estimativa. */
  rows: number | null;
  sizeBytes: number | null;
}

/** Por que a aba não mostra o banco. */
export type DatabaseUnavailableCode =
  | "no_database" // nenhum banco detectado no projeto
  | "unsupported_engine" // MongoDB, Redis e outros
  | "no_name" // MySQL sem MYSQL_DATABASE
  | "not_running" // container do banco parado
  | "docker_unavailable"
  | "query_failed";

export interface DatabaseOverview {
  /** ok = lido; unsupported = motor sem suporte ainda; unavailable = não foi possível ler agora. */
  state: "ok" | "unsupported" | "unavailable";
  code: DatabaseUnavailableCode | null;
  /** Mensagem curta em português quando state != ok. */
  message: string | null;
  engine: BackupDatabaseEngine | null;
  /** Serviço (compose) do banco. */
  service: string | null;
  version: string | null;
  database: string | null;
  sizeBytes: number | null;
  tables: DatabaseTable[];
  framework: DatabaseFramework | null;
  commands: DatabaseCommandInfo[];
  /** O projeto está marcado como de desenvolvimento (a tela sugere "sem backup" por padrão). */
  development: boolean;
}

// ---------------------------------------------------------------------------
// Ações destrutivas
// ---------------------------------------------------------------------------

/** Cópia de segurança antes da ação: nenhuma, ou o backup completo do projeto (com a validação, se ligada). */
export type DatabaseBackupChoice = "none" | "full";

/** Reautenticação + confirmação digitada + escolha do backup (comum a todas as ações destrutivas). */
export interface DatabaseActionRequest {
  currentPassword: string;
  code?: string;
  emailCode?: string;
  /** Nome do projeto, digitado. */
  confirm: string;
  backup: DatabaseBackupChoice;
}

export interface DatabaseTableRef {
  schema?: string | null;
  name: string;
}

export interface DatabaseTruncateRequest extends DatabaseActionRequest {
  tables: DatabaseTableRef[];
  /** PostgreSQL: também esvazia as tabelas que apontam para estas (CASCADE). */
  cascade?: boolean;
}

export interface DatabaseSqlWriteRequest extends DatabaseActionRequest {
  sql: string;
}

export interface DatabaseCommandRequest extends DatabaseActionRequest {
  command: DatabaseCommandId;
  /** Serviço (container) onde rodar, quando mais de um tem o artisan. */
  service?: string;
}

export type DatabaseJobKind = "truncate" | "reset" | "sql" | "command";
export type DatabaseJobStepId = "backup" | "action";

export interface DatabaseJobStep {
  id: DatabaseJobStepId;
  status: "pending" | "running" | "done" | "failed" | "skipped";
}

export interface DatabaseSqlResult {
  columns: string[];
  rows: Array<Array<string | null>>;
  /** Mais linhas do que o limite (ou saída grande demais): o resto foi cortado. */
  truncated: boolean;
  /** Linhas devolvidas por um comando de escrita não são esperadas; true = executou sem resultado a mostrar. */
  empty: boolean;
}

export interface DatabaseJob {
  id: string;
  projectId: string;
  kind: DatabaseJobKind;
  status: "running" | "success" | "failed";
  startedAt: string;
  finishedAt: string | null;
  steps: DatabaseJobStep[];
  /** Arquivo do backup feito antes (quando pedido). */
  backupFileName: string | null;
  /** Teste de restauração do backup feito antes: passou, ou não foi executado (desligado ou fora da frequência). */
  backupValidation: "passed" | "not_run" | null;
  /** Saída do comando do framework, já sem segredos. */
  output: string | null;
  result: DatabaseSqlResult | null;
  /** `message`: frase fixa em português; `detail`: motivo vindo do banco ou do backup (sem segredos). */
  error: { code: string; message: string; detail: string | null } | null;
}

export interface DatabaseJobStarted {
  job: DatabaseJob;
  alertWarning?: string;
}

export interface DatabaseSqlReadRequest {
  sql: string;
}

// ---------------------------------------------------------------------------
// Classificador de SQL
// ---------------------------------------------------------------------------

export type SqlRefusal = "empty" | "multiple" | "client_command" | "executable_comment" | "unterminated";

export type SqlAnalysis =
  | { ok: true; statement: string; kind: "read" | "write"; verb: string; reason?: "into" | "side_effect" }
  | { ok: false; code: SqlRefusal };

const READ_VERBS = new Set(["select", "show", "explain", "describe", "desc", "values", "table"]);
const WRITE_IN_CTE = new Set(["insert", "update", "delete", "merge", "replace", "into", "truncate"]);
/** Comandos do CLIENTE mysql (rodam no container, não no banco): nunca passam. */
const MYSQL_CLIENT_WORDS = new Set([
  "delimiter", "source", "system", "ego", "go", "exit", "quit", "connect", "charset", "tee", "notee", "pager", "nopager",
  "print", "prompt", "rehash", "status", "warnings", "nowarning", "resetconnection", "use", "edit", "clear", "help",
]);

/**
 * Funções e cláusulas que, mesmo numa transação somente leitura, mexem no servidor ou nos arquivos (o console de
 * leitura roda com o usuário do banco do projeto, que costuma ser superusuário). Quem as usa vira "escrita": passa
 * pela senha + 2FA. Comparação em minúsculas, também para nomes qualificados e entre aspas.
 */
const SIDE_EFFECT_EXACT = new Set([
  // PostgreSQL: sessão, servidor, sequências, estatísticas, arquivos
  "set_config", "nextval", "setval", "lowrite", "pg_stat_file", "pg_terminate_backend", "pg_cancel_backend", "pg_reload_conf",
  "pg_rotate_logfile", "pg_switch_wal", "pg_switch_xlog", "pg_promote", "pg_notify", "pg_export_snapshot", "pg_import_system_collations",
  "pg_start_backup", "pg_stop_backup", "pg_logdir_ls", "pg_extension_config_dump", "pg_stat_statements_reset",
  // PostgreSQL: funções que EXECUTAM o SQL recebido em texto (a consulta escondida em uma string não é vista pelo analisador)
  "ts_stat", "ts_rewrite", "dblink",
  // MySQL / MariaDB
  "load_file", "sleep", "benchmark", "get_lock", "release_lock", "release_all_locks", "is_free_lock", "is_used_lock",
  "master_pos_wait", "source_pos_wait", "master_gtid_wait", "wait_for_executed_gtid_set", "wait_until_sql_thread_after_gtids",
  "sys_exec", "sys_eval", "outfile", "dumpfile",
]);
const SIDE_EFFECT_PREFIX = [
  "pg_read_", "pg_ls_", "pg_file_", "pg_sleep", "pg_advisory_", "pg_try_advisory_", "pg_create_", "pg_drop_", "pg_copy_", "pg_logical_",
  "pg_replication_", "pg_backup_", "pg_wal_replay_", "pg_log_", "pg_stat_reset", "lo_", "dblink",
  // query_to_xml*, query_to_xmlschema, query_to_xml_and_xmlschema, cursor_to_xml*, table_to_xml*, schema_to_xml*, database_to_xml*
  "query_to_xml", "cursor_to_xml", "table_to_xml", "schema_to_xml", "database_to_xml",
];
export function isSideEffectName(name: string): boolean {
  const w = name.toLowerCase();
  return SIDE_EFFECT_EXACT.has(w) || SIDE_EFFECT_PREFIX.some((p) => w.startsWith(p));
}

const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
const isWordStart = (c: string | undefined): boolean => c !== undefined && /[A-Za-z_\u0080-￿]/.test(c);
const isWordChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_$\u0080-￿]/.test(c);

/**
 * Lê o texto como o banco e o cliente leriam: textos entre aspas, identificadores, $tag$…$tag$, comentários.
 * Devolve a primeira palavra, se é UMA instrução só e se tem cara de escrita. Recusa barra invertida fora de
 * texto (comando do cliente psql/mysql), comentário executável do MySQL (`/*!`) e mais de uma instrução.
 */
export function analyzeSql(input: string, engine: DatabaseSqlEngine): SqlAnalysis {
  const mysql = engine !== "postgres";
  const sql = input;
  const n = sql.length;
  const words: string[] = [];
  /** Identificadores entre aspas (PostgreSQL "x", MySQL `x`), sem as aspas. */
  const idents: string[] = [];
  let unicodeIdent = false;
  let i = 0;
  let terminated = -1;
  let hasContent = false;

  const content = (): SqlRefusal | null => {
    if (terminated >= 0) return "multiple";
    hasContent = true;
    return null;
  };

  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (isSpace(c)) {
      i++;
      continue;
    }
    // Comentários
    if (c === "-" && next === "-" && (!mysql || sql[i + 2] === undefined || isSpace(sql[i + 2]!))) {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "#" && mysql) {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      if (sql[i + 2] === "!" || (mysql && sql[i + 2] === "M" && sql[i + 3] === "!")) return { ok: false, code: "executable_comment" };
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
    // A partir daqui é conteúdo da instrução
    if (c === ";") {
      if (terminated >= 0 || !hasContent) return { ok: false, code: hasContent ? "multiple" : "empty" };
      terminated = i;
      i++;
      continue;
    }
    const refusal = content();
    if (refusal) return { ok: false, code: refusal };
    if (c === "\\") return { ok: false, code: "client_command" };
    // Textos e identificadores entre aspas
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
      if (c === "`" || (c === '"' && !mysql)) {
        idents.push(sql.slice(i + 1, j - 1).split(c + c).join(c));
        // PostgreSQL U&"..." escreve o nome com \XXXX: não dá para conferir a lista; trata como efeito colateral
        if (c === '"' && sql[i - 1] === "&" && /^[uU]$/.test(sql[i - 2] ?? "")) unicodeIdent = true;
      }
      i = j;
      continue;
    }
    // PostgreSQL: $tag$ … $tag$
    if (c === "$" && !mysql && !isWordChar(sql[i - 1])) {
      const m = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(sql.slice(i, i + 80));
      if (m) {
        const close = sql.indexOf(m[0], i + m[0].length);
        if (close < 0) return { ok: false, code: "unterminated" };
        i = close + m[0].length;
        continue;
      }
    }
    if (isWordStart(c)) {
      let j = i + 1;
      while (isWordChar(sql[j])) j++;
      words.push(sql.slice(i, j).toLowerCase());
      i = j;
      continue;
    }
    i++;
  }

  if (!hasContent || words.length === 0) return { ok: false, code: "empty" };
  const verb = words[0]!;
  if (mysql && MYSQL_CLIENT_WORDS.has(verb)) return { ok: false, code: "client_command" };
  const end = terminated >= 0 ? terminated : n;
  const statement = sql.slice(0, end).trim();
  let read = READ_VERBS.has(verb);
  let reason: "into" | "side_effect" | undefined;
  if (read && words.includes("into")) {
    read = false;
    reason = "into";
  }
  if (verb === "with") read = !words.some((w) => WRITE_IN_CTE.has(w));
  if (read && (unicodeIdent || words.some(isSideEffectName) || idents.some(isSideEffectName))) {
    read = false;
    reason = "side_effect";
  }
  return { ok: true, statement, kind: read ? "read" : "write", verb, ...(reason ? { reason } : {}) };
}
