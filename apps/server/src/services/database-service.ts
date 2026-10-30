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
  DATABASE_SQL_ROW_CAP,
  DATABASE_TRUNCATE_MAX_TABLES,
  analyzeSql,
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
  PG_RESET_SQL,
  allMyNames,
  isSafeDatabaseName,
  isSafeName,
  matchTables,
  myResetSql,
  myTruncateSql,
  parseCsv,
  parseMyObjects,
  parseMyOverview,
  parsePgOverview,
  parseTsv,
  pgTruncateSql,
  readSql,
  scriptFor,
  toSqlResult,
  writeSql,
  type ParsedOverview,
} from "./database-sql.js";
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
/** Quantos trabalhos ficam na memória por projeto. */
const JOBS_KEPT = 10;
/** Espera máxima do backup antes da ação (e da validação). */
const BACKUP_WAIT_MS = 2 * 60 * 60_000;

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
    /** Espera a fila esvaziar (inclusive o teste de restauração que o backup enfileira). */
    idle(): Promise<void>;
    restoreCheck(projectId: string): Promise<RestoreCheckView | null>;
  };
  detectFramework(srcDir: string): Promise<DatabaseFramework | null>;
  audit: { record(input: { actor?: string; action: string; target?: string | null; detail: string }): Promise<unknown> };
  now?: () => number;
  /** Espera entre uma consulta e outra do backup (testes usam 0). */
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
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
    } = {},
  ) {
    super(message);
    this.output = extra.output ?? null;
    this.detail = extra.detail ?? null;
  }
  readonly output: string | null;
  readonly detail: string | null;
}

export type DatabaseAction =
  | { kind: "truncate"; tables: DatabaseTableRef[]; cascade: boolean }
  | { kind: "reset" }
  | { kind: "sql"; sql: string }
  | { kind: "command"; command: DatabaseCommandId };

/** Ação conferida e pronta para rodar (o pedido já foi validado contra o banco, antes de pedir a senha). */
export interface DatabasePlan {
  project: Project;
  kind: DatabaseJobKind;
  /** Texto para a Auditoria: sem valores nem SQL. */
  audit: { action: string; detail: string };
  run(ctx: { masker: (s: string) => string }): Promise<{ output?: string; result?: DatabaseSqlResult }>;
}

const FIRST_LINES = (text: string, max = 400): string => text.trim().split("\n").slice(-3).join(" ").slice(0, max);

/** Erro HTTP com o motivo do banco à parte (`detail`), para a tela mostrar sem misturar com a frase fixa. */
function httpErrorWithDetail(status: number, code: string, message: string, detail: string): HttpError {
  const err = httpError(status, code, message);
  err.details = { detail };
  return err;
}

export class DatabaseService {
  private readonly jobs = new Map<string, DatabaseJob[]>();
  private readonly active = new Set<string>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newId: () => string;

  constructor(private readonly opts: DatabaseServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.newId = opts.newId ?? (() => randomBytes(8).toString("hex"));
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
  private sh(t: Target, format: "scalar" | "table" | "exec", sql: string, o: { timeoutMs: number; maxBytes: number }): Promise<DbExecResult> {
    return this.opts.exec.sh(t.container, scriptFor(t.engine, format), [t.database], { stdin: sql, ...o });
  }

  private async listTables(t: Target): Promise<ParsedOverview | null> {
    const r = await this.sh(t, "scalar", t.engine === "postgres" ? PG_OVERVIEW_SQL : MY_OVERVIEW_SQL, { timeoutMs: OVERVIEW_TIMEOUT_MS, maxBytes: OVERVIEW_MAX_BYTES });
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

  /** Consulta de LEITURA com a sessão normal: o banco recusa escrita e interrompe no prazo. */
  async readQuery(projectId: string, sql: string): Promise<DatabaseSqlResult> {
    const project = await this.requireProject(projectId);
    const target = await this.requireTarget(project);
    const analysis = this.analyze(sql, target.engine);
    if (analysis.kind === "write") {
      throw httpError(
        400,
        "write_query",
        "Este comando altera o banco (ou não é uma consulta de leitura). Ele precisa de senha e código de verificação: use o botão para executar comandos de escrita.",
      );
    }
    const r = await this.sh(target, "table", readSql(target.engine, analysis.statement), { timeoutMs: READ_TIMEOUT_MS, maxBytes: RESULT_MAX_BYTES });
    if (r.timedOut) throw httpError(408, "query_timeout", "A consulta passou do prazo e foi interrompida.");
    if (r.code !== 0 && !r.truncated) throw httpErrorWithDetail(400, "query_failed", "O banco recusou a consulta.", FIRST_LINES(r.stderr));
    return this.resultOf(target.engine, r);
  }

  private resultOf(engine: DatabaseSqlEngine, r: DbExecResult): DatabaseSqlResult {
    // Saída cortada no teto: a última linha pode ter vindo pela metade
    const text = r.truncated ? r.stdout.slice(0, r.stdout.lastIndexOf("\n") + 1) : r.stdout;
    const table = engine === "postgres" ? parseCsv(text) : parseTsv(text);
    return toSqlResult(table, DATABASE_SQL_ROW_CAP, r.truncated);
  }

  private analyze(sql: string, engine: DatabaseSqlEngine) {
    if (sql.length > DATABASE_SQL_MAX_LENGTH) {
      throw httpError(400, "sql_too_long", `O comando passa de ${DATABASE_SQL_MAX_LENGTH} caracteres.`);
    }
    const a = analyzeSql(sql, engine);
    if (a.ok) return a;
    const messages = {
      empty: "Escreva um comando SQL.",
      multiple: "Envie uma instrução SQL por vez (sem vários comandos separados por ponto e vírgula).",
      client_command: "Comandos do cliente do banco (que começam com barra invertida, como \\copy, ou palavras como source e system) não são aceitos.",
      executable_comment: "Comentários executáveis do MySQL (/*! ... */) não são aceitos.",
      unterminated: "O comando tem um texto, identificador ou comentário sem fechar.",
    } as const;
    throw httpError(400, `sql_${a.code}`, messages[a.code]);
  }

  // -------------------------------------------------------------------------
  // Ações destrutivas: conferir (antes de pedir a senha) e executar
  // -------------------------------------------------------------------------

  /** Confere o pedido contra o banco real e devolve a ação pronta. Lança 400/409 sem tocar em nada. */
  async plan(projectId: string, action: DatabaseAction): Promise<DatabasePlan> {
    const project = await this.requireProject(projectId);
    if (this.active.has(project.id)) throw httpError(409, "database_busy", "Já há uma ação no banco deste projeto em andamento. Espere terminar.");
    if (action.kind === "command") return this.planCommand(project, action.command);
    const target = await this.requireTarget(project);
    switch (action.kind) {
      case "truncate":
        return this.planTruncate(project, target, action.tables, action.cascade);
      case "reset":
        return this.planReset(project, target);
      case "sql":
        return this.planSql(project, target, action.sql);
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
        await this.mustRun(t, sql, ACTION_TIMEOUT_MS, masker);
        return {};
      },
    };
  }

  private planReset(project: Project, t: Target): DatabasePlan {
    return {
      project,
      kind: "reset",
      audit: { action: "database.reset", detail: `Zerar o banco "${t.database}" de "${project.name}" (apaga todas as tabelas e objetos; o banco e o usuário ficam).` },
      run: async ({ masker }) => {
        if (t.engine === "postgres") {
          await this.mustRun(t, PG_RESET_SQL, ACTION_TIMEOUT_MS, masker);
          return {};
        }
        const listed = await this.sh(t, "scalar", MY_OBJECTS_SQL, { timeoutMs: OVERVIEW_TIMEOUT_MS, maxBytes: OVERVIEW_MAX_BYTES });
        if (listed.code !== 0 || listed.timedOut || listed.truncated) throw new DatabaseActionError("query_failed", "Não foi possível listar o que há no banco.");
        const objects = parseMyObjects(listed.stdout);
        if (!allMyNames(objects).every(isSafeName)) {
          throw new DatabaseActionError("unsafe_name", "Há objetos com nome que o painel não consegue apagar com segurança. Nada foi alterado.");
        }
        await this.mustRun(t, myResetSql(objects), ACTION_TIMEOUT_MS, masker);
        return {};
      },
    };
  }

  private planSql(project: Project, t: Target, sql: string): DatabasePlan {
    const a = this.analyze(sql, t.engine);
    return {
      project,
      kind: "sql",
      audit: { action: "database.sql_write", detail: `Comando SQL (${a.verb}, ${a.statement.length} caracteres) em "${project.name}". O texto não é registrado.` },
      run: async ({ masker }) => {
        const r = await this.sh(t, "table", writeSql(t.engine, a.statement), { timeoutMs: WRITE_TIMEOUT_MS, maxBytes: RESULT_MAX_BYTES });
        if (r.timedOut) throw new DatabaseActionError("timeout", "O comando passou do prazo e foi interrompido.");
        if (r.code !== 0 && !r.truncated) throw new DatabaseActionError("query_failed", "O banco recusou o comando.", { detail: masker(FIRST_LINES(r.stderr)) });
        return { result: this.resultOf(t.engine, r) };
      },
    };
  }

  private async planCommand(project: Project, id: DatabaseCommandId): Promise<DatabasePlan> {
    const framework = await this.opts.detectFramework(this.opts.projects.srcDir(project)).catch(() => null);
    const def = DATABASE_COMMANDS[id];
    if (!framework || def.framework !== framework) {
      throw httpError(400, "command_not_available", "Este comando não vale para o framework deste projeto.");
    }
    const resolved = await this.resolve(project);
    const dbService = resolved.ok ? resolved.target.service : null;
    let containers: ProjectContainer[];
    try {
      containers = await this.opts.docker.projectContainers(project.slug);
    } catch {
      throw httpError(503, "docker_unavailable", "O Docker não respondeu. Tente de novo em instantes.");
    }
    const entry = project.proxyService ?? project.detection?.proxyService ?? null;
    const apps = containers.filter((c) => c.running && c.service !== dbService);
    const app = apps.find((c) => c.service === entry) ?? apps[0];
    if (!app) throw httpError(409, "app_not_running", "O container do app não está em execução. Inicie o projeto e tente de novo.");
    return {
      project,
      kind: "command",
      audit: { action: "database.command", detail: `Comando do framework em "${project.name}": ${def.argv.join(" ")}.` },
      run: async ({ masker }) => {
        const r = await this.opts.exec.argv(app.id, def.argv, { timeoutMs: COMMAND_TIMEOUT_MS, maxBytes: COMMAND_MAX_BYTES });
        const output = masker([r.stdout, r.stderr].filter((x) => x.trim() !== "").join("\n")).slice(-COMMAND_MAX_BYTES);
        if (r.timedOut) throw new DatabaseActionError("timeout", "O comando passou do prazo e foi interrompido.");
        if (r.code !== 0) throw new DatabaseActionError("command_failed", "O comando terminou com erro. Veja a saída abaixo.", { output, detail: `${r.code ?? "?"}` });
        return { output: r.truncated ? `${output}\n[saída cortada]` : output };
      },
    };
  }

  /** Roda SQL de uma ação e lança se o banco recusar. */
  private async mustRun(t: Target, sql: string, timeoutMs: number, masker: (s: string) => string = (s) => s): Promise<void> {
    const r = await this.sh(t, "exec", sql, { timeoutMs, maxBytes: 100_000 });
    if (r.timedOut) throw new DatabaseActionError("timeout", "A ação passou do prazo e foi interrompida.");
    if (r.code !== 0) throw new DatabaseActionError("query_failed", "O banco recusou a ação.", { detail: masker(FIRST_LINES(r.stderr)) });
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
      output: null,
      result: null,
      error: null,
    };
    const list = this.jobs.get(project.id) ?? [];
    list.unshift(job);
    this.jobs.set(project.id, list.slice(0, JOBS_KEPT));
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
          job.backupFileName = await this.backupFirst(plan.project, actor);
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
        job.result = out.result ?? null;
      } catch (err) {
        step("action", "failed");
        if (err instanceof DatabaseActionError && err.output !== null) job.output = err.output;
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
   */
  private async backupFirst(project: Project, actor: string): Promise<string> {
    let queued: BackupRecord;
    try {
      queued = await this.opts.backups.run(project.id, actor);
    } catch (err) {
      throw new DatabaseActionError("backup_failed", "O backup antes da ação não pôde começar. Nada foi alterado.", { detail: err instanceof Error ? err.message : "" });
    }
    const deadline = this.now() + BACKUP_WAIT_MS;
    let record = queued;
    while (record.status === "queued" || record.status === "running") {
      if (this.now() > deadline) throw new DatabaseActionError("backup_timeout", "O backup antes da ação passou de 2 horas. Nada foi alterado.");
      await this.sleep(1500);
      record = await this.opts.backups.record(queued.id);
    }
    if (record.status !== "success" || !record.fileName) {
      const why = record.status === "failed" ? (record.error ?? "falhou") : (record.warnings[0] ?? "terminou com avisos");
      throw new DatabaseActionError("backup_failed", "O backup antes da ação não terminou bem. Nada foi alterado.", { detail: why.slice(0, 300) });
    }
    // Teste de restauração (se ligado) roda na mesma fila logo depois do backup: espera e confere.
    const view = await this.opts.backups.restoreCheck(project.id).catch(() => null);
    if (view?.settings?.enabled) {
      await this.opts.backups.idle();
      const after = await this.opts.backups.restoreCheck(project.id).catch(() => null);
      const last = after?.last;
      if (last && last.backupFileName === record.fileName && last.status !== "ok") {
        throw new DatabaseActionError("backup_validation_failed", "O backup foi feito, mas a validação por restauração não passou. Nada foi alterado.", { detail: last.reason ?? last.status });
      }
    }
    return record.fileName;
  }
}
