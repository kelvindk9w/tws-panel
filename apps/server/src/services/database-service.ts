/**
 * database-service.ts — a aba Banco do projeto: visão geral do banco, esvaziar tabelas, zerar o banco, comando
 * do framework e console SQL.
 *
 * Reaproveita do backup: a detecção do banco (motor, serviço, nome; BackupService.detectProject), as credenciais
 * lidas do ambiente do próprio container (PG_ENV/MY_ENV) e o backup completo do projeto, com a validação por
 * restauração quando ela está ligada. Aqui não há senha de banco: os scripts a leem dentro do container.
 *
 * Ações destrutivas (esvaziar, zerar, SQL de escrita, comando do framework) viram um "trabalho" em segundo plano:
 *   1. (opcional) backup completo do projeto; só segue se terminou bem (e, havendo validação, se ela passou);
 *   2. a ação em si.
 * A tela acompanha o trabalho por GET. Um trabalho por projeto de cada vez. Os trabalhos ficam só na memória.
 *
 * Nada que o banco devolve entra na auditoria: só ator, ação, tabelas e códigos.
 */
import {
  DATABASE_COMMANDS,
  DATABASE_SQL_MAX_LENGTH,
  DATABASE_SQL_MAX_STATEMENTS,
  DATABASE_SQL_ROW_CAP,
  DATABASE_TRUNCATE_MAX_TABLES,
  analyzeSqlScript,
  databaseCommandsFor,
  isDatabaseSqlEngine,
  BACKUP_ENGINE_LABELS,
  type BackupRecord,
  type DatabaseBackupChoice,
  type DatabaseCommandId,
  type DatabaseFramework,
  type DatabaseJob,
  type DatabaseJobKind,
  type DatabaseOverview,
  type DatabaseSqlEngine,
  type DatabaseSqlResult,
  type DatabaseSqlRun,
  type DatabaseStatementResult,
  type SqlScriptAnalysis,
  type DatabaseTable,
  type DatabaseTableRef,
  type DatabaseUnavailableCode,
  type DetectedDatabase,
  type Project,
  type ProjectBackupDetection,
  type RestoreCheckView,
} from "@paas/core";
import { randomBytes } from "node:crypto";
import type { ProjectContainer } from "./backup-docker.js";
import type { DatabaseExecutor, DbExecResult } from "./database-docker.js";
import {
  MY_OBJECTS_SQL,
  MY_OVERVIEW_SQL,
  PG_OVERVIEW_SQL,
  DB_SECONDS,
  PG_RESET_SQL,
  allMyNames,
  isSafeDatabaseName,
  isSafeName,
  matchTables,
  myResetSql,
  myTruncateSql,
  classifyDbError,
  isPrepareUnsupported,
  nullsFromPgCsv,
  parseCsv,
  parseMyObjects,
  parseMyOverview,
  parsePgOverview,
  parseTsv,
  parseXmlRows,
  pgTruncateSql,
  scriptFor,
  sessionTag,
  toSqlResult,
  type ParsedOverview,
} from "./database-sql.js";
import { parseMyScriptOutput, parsePgScriptOutput, readScriptSql, writeScriptSql, type ScriptSegment } from "./database-sql-script.js";
import { buildLogMasker } from "./log-mask.js";
import { httpError, type HttpError } from "./http-error.js";

/** Prazos e tetos. */
const OVERVIEW_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 150_000;
const ACTION_TIMEOUT_MS = 10 * 60_000;
const COMMAND_TIMEOUT_MS = 15 * 60_000;
const OVERVIEW_MAX_BYTES = 4_000_000;
const RESULT_MAX_BYTES = 2_000_000;
const COMMAND_MAX_BYTES = 256_000;
/** Quantos trabalhos ficam na memória por projeto; só os mais recentes guardam saída e resultado. */
const JOBS_KEPT = 5;
const JOBS_WITH_PAYLOAD = 2;
/** Espera máxima do backup antes da ação, somada à da validação por restauração. */
const BACKUP_WAIT_MS = 30 * 60_000;
/** Prazos do servidor de banco (segundos) por tipo de ação: sempre MENORES que os do painel acima. */
const READ_SECONDS = DB_SECONDS.read;
const WRITE_SECONDS = DB_SECONDS.write;
const ACTION_SECONDS = DB_SECONDS.action;
/** Os dois lados juntos, para conferir (teste) que o banco desiste antes de o painel parar de esperar. */
export const DB_TIMEOUTS = {
  overview: { panelMs: OVERVIEW_TIMEOUT_MS, dbSeconds: READ_SECONDS },
  read: { panelMs: READ_TIMEOUT_MS, dbSeconds: READ_SECONDS },
  write: { panelMs: WRITE_TIMEOUT_MS, dbSeconds: WRITE_SECONDS },
  action: { panelMs: ACTION_TIMEOUT_MS, dbSeconds: ACTION_SECONDS },
} as const;
/** Consultas de leitura ao mesmo tempo por projeto. */
const MAX_READS = 2;
/** Depois de um comando do framework que estourou o prazo sem confirmar que parou, novo comando espera. */
const MAY_RUN_MS = 30 * 60_000;

export interface DatabaseServiceOptions {
  projects: {
    get(id: string): Promise<Project | null>;
    srcDir(project: Project): string;
    /** Valores das variáveis do projeto (para mascarar a saída de comandos e as mensagens). */
    secrets(project: Project): Promise<string[]>;
  };
  docker: { projectContainers(slug: string): Promise<ProjectContainer[]> };
  exec: DatabaseExecutor;
  backups: {
    /** Detecção guardada do projeto (ou uma nova, se nunca houve). */
    detection(projectId: string): Promise<ProjectBackupDetection | null>;
    /** "Fazer backup agora" do projeto (o mesmo da aba Backups). */
    run(projectId: string, actor: string): Promise<BackupRecord>;
    record(id: string): Promise<BackupRecord>;
    /** Há backup ou teste de restauração DESTE projeto rodando ou na fila (a fila dos outros não conta). */
    busy(projectId: string): boolean;
    restoreCheck(projectId: string): Promise<RestoreCheckView | null>;
  };
  detectFramework(srcDir: string): Promise<DatabaseFramework | null>;
  audit: { record(input: { actor?: string; action: string; target?: string | null; detail: string }): Promise<unknown> };
  now?: () => number;
  /** Espera entre uma consulta e outra do backup (testes usam 0). */
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
  /** Marca (hexadecimal) de cada execução no banco, para cancelá-la no prazo. */
  newTag?: () => string;
}

interface Target {
  engine: DatabaseSqlEngine;
  container: string;
  database: string;
  service: string;
}

type Resolved = { ok: true; target: Target; db: DetectedDatabase } | { ok: false; view: DatabaseOverview };

/** Falha com mensagem para a pessoa (vira o `error` do trabalho). */
export class DatabaseActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    extra: {
      /** Saída do comando (já sem segredos), mostrada mesmo na falha. */
      output?: string | null;
      /** Motivo vindo do banco ou do backup (já sem segredos), em complemento à mensagem. */
      detail?: string | null;
      /** O que o console já tinha executado quando parou (resultados parciais). */
      run?: DatabaseSqlRun | null;
    } = {},
  ) {
    super(message);
    this.output = extra.output ?? null;
    this.detail = extra.detail ?? null;
    this.run = extra.run ?? null;
  }
  readonly output: string | null;
  readonly detail: string | null;
  readonly run: DatabaseSqlRun | null;
}

export type DatabaseAction =
  | { kind: "truncate"; tables: DatabaseTableRef[]; cascade: boolean }
  | { kind: "reset" }
  | { kind: "sql"; sql: string; transaction: boolean }
  | { kind: "command"; command: DatabaseCommandId; service?: string };

/** Ação conferida e pronta para rodar (o pedido já foi validado contra o banco, antes de pedir a senha). */
export interface DatabasePlan {
  project: Project;
  kind: DatabaseJobKind;
  /** Texto para a Auditoria: sem valores nem SQL. */
  audit: { action: string; detail: string };
  run(ctx: { masker: (s: string) => string }): Promise<{ output?: string; run?: DatabaseSqlRun }>;
}

const FIRST_LINES = (text: string, max = 400): string => text.trim().split("\n").slice(-3).join(" ").slice(0, max);

/** Erro HTTP com dados extras no corpo (ex.: `detail`, o motivo do banco, à parte da frase fixa). */
function httpErrorWithData(status: number, code: string, message: string, data: Record<string, unknown>): HttpError {
  const err = httpError(status, code, message);
  err.details = data;
  return err;
}

/** Prazo estourado: diz a verdade sobre o que o painel conseguiu parar. */
function timeoutError(r: DbExecResult, what: string, extra: { output?: string | null; run?: DatabaseSqlRun | null } = {}): DatabaseActionError {
  const tail = r.stopped === true ? "O painel cancelou o processo e a sessão no banco." : "O painel parou de esperar, mas ela pode ainda estar rodando no banco; confira antes de repetir.";
  return new DatabaseActionError("timeout", `${what} passou do prazo. ${tail}`, extra);
}

export class DatabaseService {
  private readonly jobs = new Map<string, DatabaseJob[]>();
  private readonly active = new Set<string>();
  private readonly reads = new Map<string, number>();
  /** Projeto -> até quando um comando do framework pode ainda estar rodando depois do prazo. */
  private readonly mayRun = new Map<string, number>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newId: () => string;
  private readonly newTag: () => string;

  constructor(private readonly opts: DatabaseServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.newId = opts.newId ?? (() => randomBytes(8).toString("hex"));
    this.newTag = opts.newTag ?? (() => randomBytes(8).toString("hex"));
  }

  // -------------------------------------------------------------------------
  // Banco do projeto
  // -------------------------------------------------------------------------

  private unavailable(
    code: DatabaseUnavailableCode,
    message: string,
    project: Project,
    extra: Partial<DatabaseOverview> = {},
    state: DatabaseOverview["state"] = "unavailable",
  ): { ok: false; view: DatabaseOverview } {
    return {
      ok: false,
      view: {
        state,
        code,
        message,
        engine: null,
        service: null,
        version: null,
        database: null,
        sizeBytes: null,
        tables: [],
        framework: null,
        commands: [],
        development: project.development === true,
        ...extra,
      },
    };
  }

  private async resolve(project: Project): Promise<Resolved> {
    const detection = await this.opts.backups.detection(project.id).catch(() => null);
    const databases = detection?.databases ?? [];
    if (databases.length === 0) {
      return this.unavailable(
        "no_database",
        "O painel não encontrou um banco de dados neste projeto. A aba Banco funciona com PostgreSQL, MySQL e MariaDB; SQLite e outros ainda não têm suporte.",
        project,
        {},
        "unsupported",
      );
    }
    const db = databases.find((d) => isDatabaseSqlEngine(d.engine)) ?? databases[0]!;
    if (!isDatabaseSqlEngine(db.engine)) {
      return this.unavailable(
        "unsupported_engine",
        `O banco deste projeto é ${BACKUP_ENGINE_LABELS[db.engine]}. A aba Banco ainda não tem suporte a ele; hoje funciona com PostgreSQL, MySQL e MariaDB.`,
        project,
        { engine: db.engine, service: db.service },
        "unsupported",
      );
    }
    const here = { engine: db.engine, service: db.service };
    if (!db.databaseName || !isSafeDatabaseName(db.databaseName)) {
      return this.unavailable(
        "no_name",
        "Não foi possível saber o nome do banco: defina MYSQL_DATABASE (ou MARIADB_DATABASE) no serviço do banco e faça o deploy de novo.",
        project,
        here,
      );
    }
    let containers: ProjectContainer[];
    try {
      containers = await this.opts.docker.projectContainers(project.slug);
    } catch {
      return this.unavailable("docker_unavailable", "O Docker não respondeu. Tente de novo em instantes.", project, here);
    }
    const running = containers.find((c) => c.service === db.service && c.running);
    if (!running) {
      return this.unavailable("not_running", `O container do banco (${db.service}) não está em execução. Inicie o projeto e tente de novo.`, project, here);
    }
    return { ok: true, db, target: { engine: db.engine, container: running.id, database: db.databaseName, service: db.service } };
  }

  /** Roda um script no container do banco com o SQL na entrada padrão. */
  private sh(
    t: Target,
    format: "scalar" | "table" | "exec",
    sql: string,
    o: { timeoutMs: number; maxBytes: number; seconds?: number; binary?: boolean },
  ): Promise<DbExecResult> {
    // A sessão leva uma marca para o painel achá-la e cancelá-la no servidor se passar do prazo. Ela é visível no banco (application_name, bloqueios): NÃO é a
    // mesma marca que separa a saída por instrução (já gerada por quem chama).
    const tag = this.newTag();
    return this.opts.exec.sh(t.container, scriptFor(t.engine, format, o.seconds, o.binary === true), [t.database], {
      stdin: sessionTag(t.engine, tag) + sql,
      timeoutMs: o.timeoutMs,
      maxBytes: o.maxBytes,
      tag,
      engine: t.engine,
    });
  }

  private async listTables(t: Target): Promise<ParsedOverview | null> {
    const r = await this.sh(t, "scalar", t.engine === "postgres" ? PG_OVERVIEW_SQL : MY_OVERVIEW_SQL, { timeoutMs: OVERVIEW_TIMEOUT_MS, maxBytes: OVERVIEW_MAX_BYTES, seconds: READ_SECONDS });
    if (r.code !== 0 || r.timedOut || r.truncated) return null;
    return t.engine === "postgres" ? parsePgOverview(r.stdout) : parseMyOverview(r.stdout);
  }

  async overview(projectId: string): Promise<DatabaseOverview> {
    const project = await this.requireProject(projectId);
    const framework = await this.opts.detectFramework(this.opts.projects.srcDir(project)).catch(() => null);
    const resolved = await this.resolve(project);
    if (!resolved.ok) return { ...resolved.view, framework, commands: databaseCommandsFor(framework) };
    const { target, db } = resolved;
    const parsed = await this.listTables(target).catch(() => null);
    if (!parsed) {
      return {
        ...this.unavailable("query_failed", "Não foi possível ler o banco agora. Confira se ele está pronto e tente de novo.", project, { engine: db.engine, service: db.service }).view,
        database: target.database,
        framework,
        commands: databaseCommandsFor(framework),
      };
    }
    return {
      state: "ok",
      code: null,
      message: null,
      engine: db.engine,
      service: db.service,
      version: parsed.version,
      database: parsed.database ?? target.database,
      sizeBytes: parsed.sizeBytes,
      tables: parsed.tables,
      framework,
      commands: databaseCommandsFor(framework),
      development: project.development === true,
    };
  }

  /** Identificação do projeto (id, slug, nome) para a liberação; 404 se não existe. */
  async projectRef(id: string): Promise<{ id: string; slug: string; name: string }> {
    const p = await this.requireProject(id);
    return { id: p.id, slug: p.slug, name: p.name };
  }

  private async requireProject(id: string): Promise<Project> {
    const project = await this.opts.projects.get(id);
    if (!project) throw httpError(404, "project_not_found", "Projeto não encontrado.");
    return project;
  }

  /** Resolve o banco ou lança 409 com o motivo (para ações e consultas). */
  private async requireTarget(project: Project): Promise<Target> {
    const r = await this.resolve(project);
    if (!r.ok) throw httpError(409, r.view.code ?? "database_unavailable", r.view.message ?? "O banco do projeto não está disponível.");
    return r.target;
  }

  // -------------------------------------------------------------------------
  // Console SQL: leitura
  // -------------------------------------------------------------------------

  /**
   * Console, LEITURA com a sessão normal: uma ou várias instruções, todas de leitura, numa transação somente leitura
   * (o banco recusa escrita e interrompe no prazo). Se QUALQUER instrução altera dados, 400 `write_query`: a tela
   * pede a liberação da edição. Cada instrução devolve o seu resultado.
   */
  async readQuery(projectId: string, sql: string): Promise<DatabaseSqlRun> {
    const project = await this.requireProject(projectId);
    const target = await this.requireTarget(project);
    const analysis = this.analyze(sql, target.engine);
    const firstWrite = analysis.statements.findIndex((x) => x.kind === "write");
    if (firstWrite >= 0) {
      throw httpErrorWithData(
        400,
        "write_query",
        "Este texto altera o banco, usa INTO/OUTFILE ou uma função que mexe em arquivos ou no servidor (ou não é uma consulta de leitura). Libere a edição do banco para executá-lo.",
        { reason: analysis.statements[firstWrite]!.reason ?? null, statement: firstWrite + 1 },
      );
    }
    if ((this.reads.get(project.id) ?? 0) >= MAX_READS) {
      throw httpError(429, "too_many_reads", "Já há consultas em andamento neste projeto. Espere terminar.");
    }
    this.reads.set(project.id, (this.reads.get(project.id) ?? 0) + 1);
    const statements = analysis.statements.map((x) => x.statement);
    const mark = this.newTag();
    let r: DbExecResult;
    try {
      r = await this.sh(target, "table", readScriptSql(target.engine, statements, mark), { timeoutMs: READ_TIMEOUT_MS, maxBytes: RESULT_MAX_BYTES, seconds: READ_SECONDS });
    } finally {
      const left = (this.reads.get(project.id) ?? 1) - 1;
      if (left > 0) this.reads.set(project.id, left);
      else this.reads.delete(project.id);
    }
    if (r.timedOut) throw httpError(408, "query_timeout", "A consulta passou do prazo e foi interrompida.");
    const run = this.runOf(target.engine, analysis, r, mark, false);
    if (r.code !== 0 && !r.truncated) {
      const failed = this.failedStatement(run, analysis);
      if (target.engine !== "postgres" && isPrepareUnsupported(r.stderr)) {
        throw httpErrorWithData(400, "prepare_unsupported", "Este comando não pode ser executado pelo console de leitura do MySQL/MariaDB. Libere a edição do banco para executá-lo.", { statement: failed });
      }
      const kind = classifyDbError(r.stderr);
      if (kind === "db_timeout") throw httpError(408, "query_timeout", "A consulta passou do prazo e foi interrompida.");
      if (kind === "too_many_locks") throw httpError(400, "too_many_locks", "A consulta tocou em objetos demais de uma vez (limite max_locks_per_transaction do banco).");
      throw httpErrorWithData(400, "query_failed", failed === null ? "O banco recusou a consulta." : `O banco recusou a instrução ${failed}.`, { detail: FIRST_LINES(r.stderr), statement: failed });
    }
    return run;
  }

  /** Separa a saída por instrução e monta o resultado do console. */
  private runOf(engine: DatabaseSqlEngine, analysis: Extract<SqlScriptAnalysis, { ok: true }>, r: DbExecResult, mark: string, transaction: boolean): DatabaseSqlRun {
    const total = analysis.statements.length;
    let segments: ScriptSegment[];
    if (engine === "postgres") {
      // Saída cortada no teto: a última linha pode ter vindo pela metade
      const text = r.truncated ? r.stdout.slice(0, r.stdout.lastIndexOf("\n") + 1) : r.stdout;
      segments = parsePgScriptOutput(text, mark, total);
    } else {
      segments = parseMyScriptOutput(r.stdout, mark, total);
    }
    const statements: DatabaseStatementResult[] = [];
    for (const seg of segments) {
      if (!seg.started) continue;
      const st = analysis.statements[seg.index - 1]!;
      const table = seg.ended || r.truncated ? toSqlResult(seg.table, DATABASE_SQL_ROW_CAP, r.truncated && !seg.ended) : null;
      statements.push({
        index: seg.index,
        verb: st.verb,
        kind: st.kind,
        result: table === null || table.empty ? null : table,
        affected: seg.affected,
      });
    }
    return { statements, total, truncated: r.truncated, transaction };
  }

  /** Instrução (a partir de 1) que estava rodando quando o banco recusou: a última aberta e não fechada. */
  private failedStatement(run: DatabaseSqlRun, analysis: Extract<SqlScriptAnalysis, { ok: true }>): number | null {
    const last = run.statements[run.statements.length - 1];
    if (!last) return analysis.statements.length === 1 ? 1 : null;
    return last.index;
  }

  private analyze(sql: string, engine: DatabaseSqlEngine): Extract<SqlScriptAnalysis, { ok: true }> {
    if (sql.length > DATABASE_SQL_MAX_LENGTH) {
      throw httpError(400, "sql_too_long", `O comando passa de ${DATABASE_SQL_MAX_LENGTH} caracteres.`);
    }
    const a = analyzeSqlScript(sql, engine);
    if (a.ok) return a;
    const messages = {
      empty: "Escreva um comando SQL.",
      multiple: "Há mais de uma instrução onde só cabe uma.",
      client_command:
        "Comandos do cliente do banco (que começam com barra invertida, como \\copy, ou palavras como source, system e DELIMITER) não são aceitos. Funções e procedimentos do MySQL que precisam de DELIMITER não rodam aqui.",
      executable_comment: "Comentários executáveis do MySQL (/*! ... */) não são aceitos.",
      unterminated: "O comando tem um texto, identificador ou comentário sem fechar.",
      ambiguous: "O texto tem um trecho que o PostgreSQL e o cliente poderiam ler de formas diferentes (como 1$$ ou 1E'). Separe com um espaço.",
      too_many: `No máximo ${DATABASE_SQL_MAX_STATEMENTS} instruções por vez.`,
    } as const;
    throw httpErrorWithData(400, `sql_${a.code}`, a.index === null ? messages[a.code] : `Instrução ${a.index}: ${messages[a.code]}`, { statement: a.index });
  }

  // -------------------------------------------------------------------------
  // Ações destrutivas: conferir (antes de pedir a senha) e executar
  // -------------------------------------------------------------------------

  /** Confere o pedido contra o banco real e devolve a ação pronta. Lança 400/409 sem tocar em nada. */
  async plan(projectId: string, action: DatabaseAction): Promise<DatabasePlan> {
    const project = await this.requireProject(projectId);
    if (this.active.has(project.id)) throw httpError(409, "database_busy", "Já há uma ação no banco deste projeto em andamento. Espere terminar.");
    if (action.kind === "command") return this.planCommand(project, action.command, action.service);
    const target = await this.requireTarget(project);
    switch (action.kind) {
      case "truncate":
        return this.planTruncate(project, target, action.tables, action.cascade);
      case "reset":
        return this.planReset(project, target);
      case "sql":
        return this.planSql(project, target, action.sql, action.transaction);
    }
  }

  private async planTruncate(project: Project, t: Target, requested: DatabaseTableRef[], cascade: boolean): Promise<DatabasePlan> {
    if (requested.length === 0) throw httpError(400, "no_tables", "Escolha pelo menos uma tabela.");
    if (requested.length > DATABASE_TRUNCATE_MAX_TABLES) throw httpError(400, "too_many_tables", `No máximo ${DATABASE_TRUNCATE_MAX_TABLES} tabelas por vez.`);
    const actual = await this.listTables(t).catch(() => null);
    if (!actual) throw httpError(409, "query_failed", "Não foi possível ler a lista de tabelas do banco agora.");
    const matched = matchTables(t.engine, actual.tables, requested);
    if (!matched.ok) throw httpError(400, "unknown_table", `A tabela "${matched.name.slice(0, 80)}" não existe neste banco. Atualize a lista e tente de novo.`);
    const tables = matched.tables;
    const label = tables.map((x) => (x.schema && x.schema !== "public" ? `${x.schema}.${x.name}` : x.name));
    const withCascade = t.engine === "postgres" && cascade;
    return {
      project,
      kind: "truncate",
      audit: {
        action: "database.truncate",
        detail: `Esvaziar ${tables.length} tabela(s) de "${project.name}": ${label.join(", ").slice(0, 600)}${withCascade ? " (com CASCADE)" : ""}.`,
      },
      run: async ({ masker }) => {
        const sql = t.engine === "postgres" ? pgTruncateSql(tables, withCascade) : myTruncateSql(tables);
        await this.mustRun(t, sql, ACTION_TIMEOUT_MS, masker, ACTION_SECONDS);
        return {};
      },
    };
  }

  private planReset(project: Project, t: Target): DatabasePlan {
    return {
      project,
      kind: "reset",
      audit: { action: "database.reset", detail: `Zerar o banco "${t.database}" de "${project.name}" (apaga tabelas, visões, sequências, tipos, funções e rotinas; o banco, os usuários, as permissões e as extensões ficam).` },
      run: async ({ masker }) => {
        if (t.engine === "postgres") {
          await this.mustRun(t, PG_RESET_SQL, ACTION_TIMEOUT_MS, masker);
          return {};
        }
        const listed = await this.sh(t, "scalar", MY_OBJECTS_SQL, { timeoutMs: OVERVIEW_TIMEOUT_MS, maxBytes: OVERVIEW_MAX_BYTES, seconds: READ_SECONDS });
        if (listed.code !== 0 || listed.timedOut || listed.truncated) throw new DatabaseActionError("query_failed", "Não foi possível listar o que há no banco.");
        const objects = parseMyObjects(listed.stdout);
        if (!allMyNames(objects).every(isSafeName)) {
          throw new DatabaseActionError("unsafe_name", "Há objetos com nome que o painel não consegue apagar com segurança. Nada foi alterado.");
        }
        await this.mustRun(t, myResetSql(objects), ACTION_TIMEOUT_MS, masker, ACTION_SECONDS);
        return {};
      },
    };
  }

  /** Console, ESCRITA (edição liberada): várias instruções; no PostgreSQL, em transação se pedido; para no primeiro erro. */
  private planSql(project: Project, t: Target, sql: string, transaction: boolean): DatabasePlan {
    const a = this.analyze(sql, t.engine);
    const useTx = t.engine === "postgres" && transaction;
    const verbs = [...new Set(a.statements.map((x) => x.verb))].join(", ");
    const chars = a.statements.reduce((n, x) => n + x.statement.length, 0);
    return {
      project,
      kind: "sql",
      audit: {
        action: "database.sql_write",
        detail: `Comandos SQL (${a.statements.length} instrução(ões): ${verbs}; ${chars} caracteres${useTx ? "; em transação" : ""}) em "${project.name}". O texto não é registrado.`,
      },
      run: async ({ masker }) => {
        const mark = this.newTag();
        const r = await this.sh(t, "table", writeScriptSql(t.engine, a.statements.map((x) => x.statement), mark, useTx), {
          timeoutMs: WRITE_TIMEOUT_MS,
          maxBytes: RESULT_MAX_BYTES,
          seconds: WRITE_SECONDS,
          binary: true,
        });
        const run = this.runOf(t.engine, a, r, mark, useTx);
        if (r.timedOut) throw timeoutError(r, "O comando", { run });
        if (r.code !== 0 && !r.truncated) {
          const failed = this.failedStatement(run, a);
          const base = this.dbFailure(r, "O banco recusou o comando.", masker);
          if (base.code !== "query_failed") throw new DatabaseActionError(base.code, base.message, { detail: base.detail, run });
          const where = failed === null ? "" : ` Parou na instrução ${failed} de ${a.statements.length}.`;
          const undone = failed !== null && t.engine === "postgres" ? (useTx ? " Nada foi gravado: a transação foi desfeita." : " As anteriores já foram gravadas.") : t.engine !== "postgres" && failed !== null && failed > 1 ? " As anteriores já foram executadas." : "";
          const detail = failed === null ? base.detail : base.detail ? `Instrução ${failed}: ${base.detail}` : `Instrução ${failed}`;
          throw new DatabaseActionError("statement_failed", `O banco recusou o comando.${where}${undone}`, { detail, run });
        }
        return { run };
      },
    };
  }

  /**
   * "Liberar edição": a ação do trabalho é só conceder a liberação (depois do backup completo opcional, que se falhar
   * a aborta: a edição NÃO é liberada). `grant` é chamada na hora certa pelo trabalho.
   */
  async planUnlock(projectId: string, detail: string, grant: () => void): Promise<DatabasePlan> {
    const project = await this.requireProject(projectId);
    if (this.active.has(project.id)) throw httpError(409, "database_busy", "Já há uma ação no banco deste projeto em andamento. Espere terminar.");
    return {
      project,
      kind: "unlock",
      audit: { action: "database.unlock", detail: `Pedido para liberar a edição do banco de "${project.name}"${detail ? ` ${detail}` : ""}.` },
      run: async () => {
        grant();
        return {};
      },
    };
  }

  private async planCommand(project: Project, id: DatabaseCommandId, service?: string): Promise<DatabasePlan> {
    const framework = await this.opts.detectFramework(this.opts.projects.srcDir(project)).catch(() => null);
    const def = DATABASE_COMMANDS[id];
    if (!framework || def.framework !== framework) {
      throw httpError(400, "command_not_available", "Este comando não vale para o framework deste projeto.");
    }
    if ((this.mayRun.get(project.id) ?? 0) > this.now()) {
      throw httpError(409, "command_may_be_running", "Um comando anterior passou do prazo e pode ainda estar rodando no container do app. Espere alguns minutos ou reinicie o projeto.");
    }
    const resolved = await this.resolve(project);
    const dbService = resolved.ok ? resolved.target.service : null;
    let containers: ProjectContainer[];
    try {
      containers = await this.opts.docker.projectContainers(project.slug);
    } catch {
      throw httpError(503, "docker_unavailable", "O Docker não respondeu. Tente de novo em instantes.");
    }
    // Um container por serviço, fora o do banco
    const candidates: ProjectContainer[] = [];
    for (const c of containers) if (c.running && c.service !== dbService && !candidates.some((x) => x.service === c.service)) candidates.push(c);
    if (candidates.length === 0) throw httpError(409, "app_not_running", "O container do app não está em execução. Inicie o projeto e tente de novo.");
    // Só serve o container que tem o `artisan` (com nginx + php-fpm, o de entrada é o nginx)
    const probes = await Promise.all(
      candidates.map(async (c) => {
        const r = await this.opts.exec.argv(c.id, ["test", "-f", "artisan"], { timeoutMs: 10_000, maxBytes: 1_000, tag: this.newTag() }).catch(() => null);
        return r?.code === 0 ? c : null;
      }),
    );
    const withArtisan = probes.filter((c): c is ProjectContainer => c !== null);
    if (withArtisan.length === 0) {
      throw httpError(409, "app_artisan_not_found", "Não encontrei o arquivo artisan em nenhum container do projeto que esteja em execução.");
    }
    let target: ProjectContainer;
    if (service !== undefined) {
      const chosen = withArtisan.find((c) => c.service === service);
      if (!chosen) throw httpError(400, "unknown_service", "Esse serviço não está em execução ou não tem o artisan.");
      target = chosen;
    } else if (withArtisan.length === 1) {
      target = withArtisan[0]!;
    } else {
      const entry = project.proxyService ?? project.detection?.proxyService ?? null;
      throw httpErrorWithData(409, "app_ambiguous", "Mais de um container do projeto tem o artisan. Escolha em qual rodar o comando.", {
        services: withArtisan.map((c) => c.service),
        suggested: withArtisan.some((c) => c.service === entry) ? entry : null,
      });
    }
    return {
      project,
      kind: "command",
      audit: { action: "database.command", detail: `Comando do framework em "${project.name}" (serviço ${target.service}): ${def.argv.join(" ")}.` },
      run: async ({ masker }) => {
        const r = await this.opts.exec.argv(target.id, def.argv, { timeoutMs: COMMAND_TIMEOUT_MS, maxBytes: COMMAND_MAX_BYTES, tag: this.newTag() });
        const output = masker([r.stdout, r.stderr].filter((x) => x.trim() !== "").join("\n")).slice(-COMMAND_MAX_BYTES);
        if (r.timedOut) {
          // Sem confirmar que parou, outro comando no mesmo projeto espera (duas migrações juntas se atropelam).
          if (r.stopped !== true) this.mayRun.set(project.id, this.now() + MAY_RUN_MS);
          throw timeoutError(r, "O comando", { output });
        }
        if (r.code !== 0) throw new DatabaseActionError("command_failed", "O comando terminou com erro. Veja a saída abaixo.", { output, detail: `${r.code ?? "?"}` });
        return { output: r.truncated ? `${output}\n[saída cortada]` : output };
      },
    };
  }

  /** Falha do banco numa ação: prazo e limite de bloqueios têm código próprio; o resto leva o motivo à parte. */
  private dbFailure(r: DbExecResult, message: string, masker: (s: string) => string): DatabaseActionError {
    const detail = masker(FIRST_LINES(r.stderr));
    const kind = classifyDbError(r.stderr);
    if (kind === "db_timeout") return new DatabaseActionError("db_timeout", "O banco interrompeu a ação por passar do prazo (ou por esperar um bloqueio demais).", { detail });
    if (kind === "too_many_locks") return new DatabaseActionError("too_many_locks", "A ação tocou em objetos demais de uma vez (limite max_locks_per_transaction do banco).", { detail });
    return new DatabaseActionError("query_failed", message, { detail });
  }

  /** Roda SQL de uma ação e lança se o banco recusar. */
  private async mustRun(t: Target, sql: string, timeoutMs: number, masker: (s: string) => string, seconds?: number): Promise<void> {
    const r = await this.sh(t, "exec", sql, { timeoutMs, maxBytes: 100_000, seconds });
    if (r.timedOut) throw timeoutError(r, "A ação");
    if (r.code !== 0) throw this.dbFailure(r, "O banco recusou a ação.", masker);
  }

  // -------------------------------------------------------------------------
  // Trabalhos
  // -------------------------------------------------------------------------

  /** Começa o trabalho em segundo plano (backup opcional + ação) e devolve o estado inicial. */
  async begin(plan: DatabasePlan, actor: string, backup: DatabaseBackupChoice): Promise<DatabaseJob> {
    const { project } = plan;
    if (this.active.has(project.id)) throw httpError(409, "database_busy", "Já há uma ação no banco deste projeto em andamento. Espere terminar.");
    this.active.add(project.id);
    const job: DatabaseJob = {
      id: this.newId(),
      projectId: project.id,
      kind: plan.kind,
      status: "running",
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: null,
      steps: [
        { id: "backup", status: backup === "full" ? "pending" : "skipped" },
        { id: "action", status: "pending" },
      ],
      backupFileName: null,
      backupValidation: null,
      output: null,
      run: null,
      error: null,
    };
    const list = this.jobs.get(project.id) ?? [];
    list.unshift(job);
    const kept = list.slice(0, JOBS_KEPT);
    // Saída e resultado só ficam nos mais recentes (cada um pode ter centenas de KB)
    kept.slice(JOBS_WITH_PAYLOAD).forEach((j) => {
      j.output = null;
      j.run = null;
    });
    this.jobs.set(project.id, kept);
    await this.audit(actor, plan.audit.action, project, `${plan.audit.detail} Backup antes: ${backup === "full" ? "completo" : "não"}.`);
    void this.execute(job, plan, actor, backup);
    return this.snapshot(job);
  }

  private snapshot(job: DatabaseJob): DatabaseJob {
    return structuredClone(job);
  }

  job(projectId: string, jobId: string): DatabaseJob {
    const job = this.jobs.get(projectId)?.find((j) => j.id === jobId);
    if (!job) throw httpError(404, "job_not_found", "Trabalho não encontrado (a lista é zerada quando o painel reinicia).");
    return this.snapshot(job);
  }

  /** Espera o trabalho terminar (testes). */
  async settled(): Promise<void> {
    while (this.active.size > 0) await this.sleep(1);
  }

  private async execute(job: DatabaseJob, plan: DatabasePlan, actor: string, backup: DatabaseBackupChoice): Promise<void> {
    const step = (id: "backup" | "action", status: DatabaseJob["steps"][number]["status"]) => {
      job.steps.find((s) => s.id === id)!.status = status;
    };
    let masker: (s: string) => string = (s) => s;
    try {
      masker = buildLogMasker(await this.opts.projects.secrets(plan.project).catch(() => []));
      if (backup === "full") {
        step("backup", "running");
        try {
          const done = await this.backupFirst(plan.project, actor);
          job.backupFileName = done.fileName;
          job.backupValidation = done.validation;
        } catch (err) {
          step("backup", "failed");
          throw err;
        }
        step("backup", "done");
      }
      step("action", "running");
      try {
        const out = await plan.run({ masker });
        job.output = out.output ?? null;
        job.run = out.run ?? null;
      } catch (err) {
        step("action", "failed");
        if (err instanceof DatabaseActionError) {
          if (err.output !== null) job.output = err.output;
          job.run = err.run;
        }
        throw err;
      }
      step("action", "done");
      // A Auditoria entra ANTES de o trabalho aparecer como concluído: quem vê "concluído" já encontra o registro.
      await this.audit(actor, `${plan.audit.action}_done`, plan.project, "Concluído.");
      job.status = "success";
    } catch (err) {
      const e = err instanceof DatabaseActionError ? err : new DatabaseActionError("failed", "A ação não pôde ser concluída.");
      job.error = { code: e.code, message: e.message, detail: e.detail === null ? null : masker(e.detail) };
      await this.audit(actor, `${plan.audit.action}_failed`, plan.project, `Falhou (${e.code}).${job.steps.find((s) => s.id === "backup")?.status === "failed" ? " O backup anterior não terminou; nada foi alterado." : ""}`);
      job.status = "failed";
    } finally {
      job.finishedAt = new Date(this.now()).toISOString();
      this.active.delete(plan.project.id);
    }
  }

  private async audit(actor: string, action: string, project: Project, detail: string): Promise<void> {
    await this.opts.audit.record({ actor, action, target: project.slug, detail }).catch(() => undefined);
  }

  /**
   * Backup completo do projeto pela mesma fila da aba Backups. Só devolve se terminou SEM aviso e, havendo a
   * validação por restauração ligada, se ela passou para este mesmo arquivo; caso contrário lança e a ação não roda.
   * Tudo (backup + validação) tem um único prazo. Sem validação ligada (ou que o painel não rodou para este arquivo,
   * ex.: já houve uma dentro da frequência), a ação segue e o trabalho registra "validação não executada".
   */
  private async backupFirst(project: Project, actor: string): Promise<{ fileName: string; validation: "passed" | "not_run" }> {
    let queued: BackupRecord;
    try {
      queued = await this.opts.backups.run(project.id, actor);
    } catch (err) {
      throw new DatabaseActionError("backup_failed", "O backup antes da ação não pôde começar. Nada foi alterado.", { detail: err instanceof Error ? err.message : "" });
    }
    const deadline = this.now() + BACKUP_WAIT_MS;
    let record = queued;
    while (record.status === "queued" || record.status === "running") {
      if (this.now() > deadline) throw new DatabaseActionError("backup_timeout", "O backup antes da ação passou de 30 minutos. Nada foi alterado.");
      await this.sleep(1500);
      record = await this.opts.backups.record(queued.id);
    }
    if (record.status !== "success" || !record.fileName) {
      const why = record.status === "failed" ? (record.error ?? "falhou") : (record.warnings[0] ?? "terminou com avisos");
      throw new DatabaseActionError("backup_failed", "O backup antes da ação não terminou bem. Nada foi alterado.", { detail: why.slice(0, 300) });
    }
    const fileName = record.fileName;
    // Teste de restauração (se ligado) roda na mesma fila logo depois do backup: espera o resultado DESTE arquivo.
    const view = await this.opts.backups.restoreCheck(project.id).catch(() => null);
    if (!view?.settings?.enabled) return { fileName, validation: "not_run" };
    for (;;) {
      const last = (await this.opts.backups.restoreCheck(project.id).catch(() => null))?.last;
      if (last && last.backupFileName === fileName) {
        if (last.status === "ok") return { fileName, validation: "passed" };
        if (last.status === "failed") {
          throw new DatabaseActionError("backup_validation_failed", "O backup foi feito, mas a validação por restauração não passou. Nada foi alterado.", { detail: last.reason ?? last.status });
        }
        if (last.status === "not_run") return { fileName, validation: "not_run" };
      } else if (!this.opts.backups.busy(project.id)) {
        // Nada deste projeto na fila e não houve teste para este arquivo
        return { fileName, validation: "not_run" };
      }
      if (this.now() > deadline) throw new DatabaseActionError("backup_timeout", "A validação do backup passou de 30 minutos. Nada foi alterado.");
      await this.sleep(1500);
    }
  }
}
