/**
 * database-service.test.ts — a aba Banco: visão geral, console SQL, esvaziar, zerar, comando do framework e o backup
 * antes da ação. O `docker exec` e o serviço de backups são dublês; aqui se confere o que seria enviado ao banco.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupRecord, DetectedDatabase, Project, ProjectBackupDetection, RestoreCheckView } from "@paas/core";
import { DatabaseService, DatabaseActionError, DB_TIMEOUTS, type DatabaseServiceOptions, type DatabaseAction } from "../src/services/database-service.js";
import type { DbExecResult } from "../src/services/database-docker.js";

const ok = (stdout = ""): DbExecResult => ({ code: 0, stdout, stderr: "", truncated: false, timedOut: false });
const fail = (stderr: string, extra: Partial<DbExecResult> = {}): DbExecResult => ({ code: 1, stdout: "", stderr, truncated: false, timedOut: false, ...extra });

interface Call {
  kind: "sh" | "argv";
  container: string;
  script?: string;
  args?: string[];
  stdin?: string;
  tag?: string;
  engine?: string;
  timeoutMs?: number;
  argv?: readonly string[];
}

const PG_OVERVIEW = JSON.stringify({
  version: "16.2",
  database: "appdb",
  sizeBytes: 9_000_000,
  tables: [
    { schema: "public", name: "users", rows: 10, sizeBytes: 16384 },
    { schema: "public", name: "posts", rows: 5, sizeBytes: 8192 },
    { schema: "audit", name: "log", rows: null, sizeBytes: 8192 },
  ],
});
const MY_OVERVIEW = ["V\t8.0.36", "D\tappdb", "T\tusers\t10\t16384", "T\tposts\t5\t8192", "S\t24576", ""].join("\n");

function db(engine: DetectedDatabase["engine"], extra: Partial<DetectedDatabase> = {}): DetectedDatabase {
  return { id: "db:db", service: "db", engine, image: "x", databaseName: "appdb", user: "app", defaultSelected: true, method: "", ...extra };
}
const detectionOf = (databases: DetectedDatabase[]): ProjectBackupDetection => ({ detectedAt: "2026-10-30T00:00:00Z", databases, mounts: [], unsavedWrites: [], sourceFolder: null, error: null });

const project = (extra: Partial<Project> = {}): Project => ({ id: "p1", name: "Loja", slug: "loja", proxyService: null, ...extra }) as Project;

function record(status: BackupRecord["status"], extra: Partial<BackupRecord> = {}): BackupRecord {
  return { id: "r1", target: "project:p1", targetName: "Loja", operation: "backup", trigger: "manual", status, queuedAt: "", startedAt: null, finishedAt: null, fileName: status === "success" ? "2026-10-30_10-00.7z" : null, sizeBytes: 1, local: true, remote: "none", remoteEncrypted: false, remoteDetail: null, steps: [], warnings: [], error: null, ...extra };
}

let calls: Call[];
let handler: (c: Call) => DbExecResult | Promise<DbExecResult>;
let detection: ProjectBackupDetection | null;
let proj: Project | null;
let containers: Array<{ id: string; name: string; service: string; running: boolean }>;
let containersError: boolean;
let framework: "laravel" | null;
let backupRuns: string[];
let backupSeq: BackupRecord[];
let backupRunError: Error | null;
let restoreSeq: Array<RestoreCheckView | null>;
let busyNow: () => boolean;
let busyIds: string[];
let probeResult: (container: string) => DbExecResult;
let probed: string[];
let audits: Array<{ actor?: string; action: string; target?: string | null; detail: string }>;
let clock: number;
let secrets: string[] | Error;

function make(extra: Partial<DatabaseServiceOptions> = {}): DatabaseService {
  return new DatabaseService({
    projects: {
      get: async () => proj,
      srcDir: () => "/srv/src",
      secrets: async () => {
        if (secrets instanceof Error) throw secrets;
        return secrets;
      },
    },
    docker: {
      projectContainers: async () => {
        if (containersError) throw new Error("docker");
        return containers;
      },
    },
    exec: {
      sh: async (container, script, args, o) => {
        const c: Call = { kind: "sh", container, script, args, stdin: o.stdin, tag: o.tag, engine: o.engine, timeoutMs: o.timeoutMs };
        calls.push(c);
        return handler(c);
      },
      argv: async (container, argv) => {
        if (argv[0] === "test") {
          probed.push(container);
          return probeResult(container);
        }
        const c: Call = { kind: "argv", container, argv };
        calls.push(c);
        return handler(c);
      },
    },
    backups: {
      detection: async () => detection,
      run: async (id) => {
        backupRuns.push(id);
        if (backupRunError) throw backupRunError;
        return backupSeq[0]!;
      },
      record: async () => backupSeq.length > 1 ? backupSeq.splice(1, 1)[0]! : backupSeq[0]!,
      busy: (id) => {
        busyIds.push(id);
        return busyNow();
      },
      restoreCheck: async () => (restoreSeq.length > 1 ? restoreSeq.shift()! : (restoreSeq[0] ?? null)),
    },
    detectFramework: async () => framework,
    audit: { record: async (i) => void audits.push(i) },
    now: () => clock,
    sleep: async () => {
      clock += 1500;
    },
    newId: () => "job1",
    newTag: () => "0123456789abcdef",
    ...extra,
  });
}

beforeEach(() => {
  calls = [];
  handler = () => ok();
  detection = detectionOf([db("postgres")]);
  proj = project();
  containers = [
    { id: "c-db", name: "loja-db-1", service: "db", running: true },
    { id: "c-web", name: "loja-web-1", service: "web", running: true },
  ];
  containersError = false;
  framework = null;
  backupRuns = [];
  backupSeq = [record("success")];
  backupRunError = null;
  restoreSeq = [null];
  busyNow = () => false;
  busyIds = [];
  probeResult = () => ok();
  probed = [];
  audits = [];
  clock = Date.UTC(2026, 9, 30, 12, 0, 0);
  secrets = [];
});

const lastSh = () => [...calls].reverse().find((c) => c.kind === "sh")!;

async function run(service: DatabaseService, action: DatabaseAction, backup: "none" | "full" = "none") {
  const plan = await service.plan("p1", action);
  const job = await service.begin(plan, "kelvin", backup);
  await service.settled();
  return { job, final: service.job("p1", job.id) };
}

describe("visão geral", () => {
  it("PostgreSQL: motor, versão, banco, tamanho e tabelas, lidos em transação somente leitura", async () => {
    handler = () => ok(PG_OVERVIEW);
    const view = await make().overview("p1");
    expect(view).toMatchObject({ state: "ok", engine: "postgres", service: "db", version: "16.2", database: "appdb", sizeBytes: 9_000_000, development: false, framework: null, commands: [] });
    expect(view.tables).toHaveLength(3);
    expect(view.tables[2]).toEqual({ schema: "audit", name: "log", rows: null, sizeBytes: 8192 });
    const call = lastSh();
    expect(call.container).toBe("c-db");
    expect(call.args).toEqual(["appdb"]);
    expect(call.stdin).toContain("BEGIN READ ONLY");
    // nenhuma credencial na linha de comando: só o nome do banco; a senha é lida dentro do container
    expect(JSON.stringify(call.args)).not.toMatch(/pass|senha/i);
    expect(call.script).toContain("POSTGRES_PASSWORD");
  });

  it("MySQL e MariaDB", async () => {
    detection = detectionOf([db("mysql")]);
    handler = () => ok(MY_OVERVIEW);
    expect(await make().overview("p1")).toMatchObject({ state: "ok", engine: "mysql", version: "8.0.36", sizeBytes: 24576 });
    detection = detectionOf([db("mariadb")]);
    expect((await make().overview("p1")).engine).toBe("mariadb");
  });

  it("projeto de desenvolvimento e comandos do Laravel aparecem na visão", async () => {
    proj = project({ development: true });
    framework = "laravel";
    handler = () => ok(PG_OVERVIEW);
    const view = await make().overview("p1");
    expect(view.development).toBe(true);
    expect(view.framework).toBe("laravel");
    expect(view.commands.map((c) => c.id)).toEqual(["laravel-migrate-fresh-seed", "laravel-migrate", "laravel-seed"]);
  });

  it("projeto inexistente: 404", async () => {
    proj = null;
    await expect(make().overview("p1")).rejects.toMatchObject({ statusCode: 404, code: "project_not_found" });
  });

  it("motor sem suporte (MongoDB): estado claro, sem tocar no banco", async () => {
    detection = detectionOf([db("mongo")]);
    const view = await make().overview("p1");
    expect(view).toMatchObject({ state: "unsupported", code: "unsupported_engine", engine: "mongo", service: "db" });
    expect(view.message).toContain("MongoDB");
    expect(calls).toHaveLength(0);
  });

  it("prefere o banco com suporte quando há mais de um", async () => {
    detection = detectionOf([db("redis", { service: "cache", id: "db:cache" }), db("postgres")]);
    handler = () => ok(PG_OVERVIEW);
    expect((await make().overview("p1")).engine).toBe("postgres");
  });

  it("sem banco detectado (SQLite e outros) ou sem detecção alguma", async () => {
    detection = detectionOf([]);
    expect(await make().overview("p1")).toMatchObject({ state: "unsupported", code: "no_database" });
    detection = null;
    const view = await make().overview("p1");
    expect(view.code).toBe("no_database");
    expect(view.message).toContain("SQLite");
  });

  it("detecção que falha conta como sem banco", async () => {
    const service = make({
      backups: { ...make()["opts"].backups, detection: async () => { throw new Error("x"); } },
    });
    expect((await service.overview("p1")).code).toBe("no_database");
  });

  it("MySQL sem nome de banco, ou com nome que viraria opção do cliente", async () => {
    detection = detectionOf([db("mysql", { databaseName: null })]);
    expect((await make().overview("p1")).code).toBe("no_name");
    detection = detectionOf([db("postgres", { databaseName: "-h" })]);
    expect((await make().overview("p1")).code).toBe("no_name");
  });

  it("container do banco parado ou Docker fora do ar", async () => {
    containers = [{ id: "c-db", name: "x", service: "db", running: false }];
    expect((await make().overview("p1")).code).toBe("not_running");
    containersError = true;
    expect((await make().overview("p1")).code).toBe("docker_unavailable");
  });

  it("consulta que falha, passa do prazo, vem cortada ou ilegível vira query_failed, sem texto do banco", async () => {
    for (const r of [fail("FATAL: senha x"), ok("não é json"), { ...ok(PG_OVERVIEW), timedOut: true }, { ...ok(PG_OVERVIEW), truncated: true }]) {
      handler = () => r;
      const view = await make().overview("p1");
      expect(view).toMatchObject({ state: "unavailable", code: "query_failed", database: "appdb" });
      expect(JSON.stringify(view)).not.toContain("senha x");
    }
  });
});

describe("console SQL: leitura", () => {
  it("PostgreSQL: roda em transação somente leitura, com o SQL na entrada padrão, e devolve a tabela", async () => {
    handler = () => ok("id,name\n1,Ana\n2,\u0001TWS_NULL\u0001\n3,NULL\n");
    const r = await make().readQuery("p1", "select id, name from users;");
    // NULL de verdade vira null; o texto 'NULL' continua texto
    expect(r).toEqual({ columns: ["id", "name"], rows: [["1", "Ana"], ["2", null], ["3", "NULL"]], truncated: false, empty: false });
    const call = lastSh();
    expect(call.stdin).toContain("BEGIN READ ONLY");
    expect(call.stdin).toContain("select id, name from users");
    expect(call.args).toEqual(["appdb"]);
    expect(call.script).toContain("--csv");
    expect(call.script).toContain("TWS_NULL");
    expect(call.stdin).toContain("SET LOCAL statement_timeout");
  });

  const xml = (rows: string[]): string => `<?xml version="1.0"?>\n<resultset statement="x">\n${rows.map((r) => `  <row>\n${r}\n  </row>`).join("\n")}\n</resultset>\n`;

  it("MySQL: o texto vai em hexadecimal para um PREPARE, em transação somente leitura, e a saída é XML", async () => {
    detection = detectionOf([db("mysql")]);
    handler = () =>
      ok(xml(['\t<field name="id">1</field>\n\t<field name="name">Ana &amp; &lt;Bia&gt;</field>', '\t<field name="id">2</field>\n\t<field name="name" xsi:nil="true" />', '\t<field name="id">3</field>\n\t<field name="name">NULL</field>', '\t<field name="id">4</field>\n\t<field name="name"></field>']));
    const r = await make().readQuery("p1", "show tables");
    expect(r).toEqual({ columns: ["id", "name"], rows: [["1", "Ana & <Bia>"], ["2", null], ["3", "NULL"], ["4", ""]], truncated: false, empty: false });
    const call = lastSh();
    expect(call.stdin).toContain("START TRANSACTION READ ONLY");
    expect(call.stdin).toContain("SET SESSION sql_mode = '';");
    expect(call.stdin).toContain("PREPARE tws_s FROM @tws_q;");
    expect(call.stdin).toContain(`X'${Buffer.from("show tables").toString("hex")}'`);
    expect(call.script).toContain("--xml");
    // MySQL: a variável vem do motor detectado (max_execution_time, em ms)
    expect(call.script).toContain("max_execution_time=15000");
    expect(call.script).not.toContain("max_statement_time");
    expect(call.script).toContain("lock_wait_timeout=15");
    // a sessão leva a marca que permite cancelá-la no servidor
    expect(call.stdin!.startsWith("DO GET_LOCK('tws-db-0123456789abcdef', 0);\n")).toBe(true);
    expect(call).toMatchObject({ tag: "0123456789abcdef", engine: "mysql" });
  });

  it("MySQL: texto com acentos, emoji e aspas vai inteiro em hexadecimal UTF-8 (sem o cliente tocar nele)", async () => {
    detection = detectionOf([db("mysql")]);
    handler = () => ok("");
    const sql = "select 'ação — 日本語 😀' as t, \"é\" as u";
    await make().readQuery("p1", sql);
    const stdin = lastSh().stdin!;
    const hex = /X'([0-9a-f]+)'/.exec(stdin)![1]!;
    expect(Buffer.from(hex, "hex").toString("utf8")).toBe(sql);
    expect(stdin).toContain("SET NAMES utf8mb4;");
    expect(stdin).not.toContain("ação");
    expect(stdin).not.toContain("日本語");
  });

  it("MariaDB: a variável de prazo é a do MariaDB, pelo motor detectado", async () => {
    detection = detectionOf([db("mariadb")]);
    handler = () => ok("");
    await make().readQuery("p1", "select 1");
    expect(lastSh().script).toContain("max_statement_time=15");
    expect(lastSh().script).not.toContain("max_execution_time");
    expect(lastSh().engine).toBe("mariadb");
  });

  it("MySQL: o texto do usuário nunca chega ao separador do cliente (nem com NO_BACKSLASH_ESCAPES ou ANSI_QUOTES)", async () => {
    detection = detectionOf([db("mariadb")]);
    handler = () => ok("");
    const payloads = [
      "select 'a\\'; set session transaction read write; commit; delete from users; select '",
      `select "a"; delete from users; select "b"`,
      "select 1 /* ; delete from users */",
    ];
    for (const sql of payloads) {
      await make().readQuery("p1", sql).catch(() => undefined);
      const stdin = lastSh().stdin ?? "";
      expect(stdin, sql).not.toMatch(/delete|read write/i);
    }
  });

  it("MySQL: comando que o PREPARE não aceita (erro 1295) vira mensagem clara", async () => {
    detection = detectionOf([db("mysql")]);
    handler = () => fail("ERROR 1295 (HY000) at line 6: This command is not supported in the prepared statement protocol yet");
    await expect(make().readQuery("p1", "show errors")).rejects.toMatchObject({ statusCode: 400, code: "prepare_unsupported" });
    // no PostgreSQL esse erro não existe: segue como erro comum
    detection = detectionOf([db("postgres")]);
    await expect(make().readQuery("p1", "select 1")).rejects.toMatchObject({ code: "query_failed" });
  });

  it("corta em 500 linhas", async () => {
    handler = () => ok(`n\n${Array.from({ length: 600 }, (_v, i) => i).join("\n")}\n`);
    const r = await make().readQuery("p1", "select n from t");
    expect(r.rows).toHaveLength(500);
    expect(r.truncated).toBe(true);
  });

  it("saída acima do teto: descarta a linha pela metade e avisa que foi cortada", async () => {
    handler = () => ({ ...ok("n\n1\n2\n3-pela-meta"), truncated: true, code: null });
    const r = await make().readQuery("p1", "select n from t");
    expect(r.rows).toEqual([["1"], ["2"]]);
    expect(r.truncated).toBe(true);
  });

  it("resultado sem linhas no MySQL (o cliente não imprime nada)", async () => {
    detection = detectionOf([db("mysql")]);
    handler = () => ok("<?xml version=\"1.0\"?>\n<resultset statement=\"x\">\n</resultset>\n");
    expect(await make().readQuery("p1", "select 1 from t where 0")).toMatchObject({ empty: true, rows: [] });
  });

  it("comando de escrita não roda aqui: 400 write_query, sem tocar no banco", async () => {
    await expect(make().readQuery("p1", "delete from users")).rejects.toMatchObject({ statusCode: 400, code: "write_query" });
    await expect(make().readQuery("p1", "select * into novo from users")).rejects.toMatchObject({ code: "write_query" });
    expect(calls).toHaveLength(0);
  });

  it("funções de arquivo e de servidor, INTO OUTFILE em TABLE/VALUES: exigem o fluxo de escrita", async () => {
    await expect(make().readQuery("p1", "select pg_read_file('/etc/passwd')")).rejects.toMatchObject({ code: "write_query", details: { reason: "side_effect" } });
    await expect(make().readQuery("p1", "select pg_terminate_backend(1)")).rejects.toMatchObject({ code: "write_query" });
    detection = detectionOf([db("mysql")]);
    await expect(make().readQuery("p1", "table users into outfile '/tmp/x'")).rejects.toMatchObject({ code: "write_query", details: { reason: "into" } });
    await expect(make().readQuery("p1", "select load_file('/etc/passwd')")).rejects.toMatchObject({ code: "write_query" });
    expect(calls).toHaveLength(0);
  });

  it("no máximo 2 consultas ao mesmo tempo por projeto", async () => {
    const releases: Array<() => void> = [];
    handler = () => new Promise<DbExecResult>((r) => releases.push(() => r(ok("n\n1\n"))));
    const service = make();
    const a = service.readQuery("p1", "select 1");
    const b = service.readQuery("p1", "select 2");
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    await expect(service.readQuery("p1", "select 3")).rejects.toMatchObject({ statusCode: 429, code: "too_many_reads" });
    releases.forEach((r) => r());
    await Promise.all([a, b]);
    // liberou: volta a aceitar
    handler = () => ok("n\n1\n");
    await expect(service.readQuery("p1", "select 4")).resolves.toBeTruthy();
  });

  it("limite de bloqueios e prazo do próprio banco têm mensagem própria", async () => {
    handler = () => fail("ERROR: out of shared memory\nHINT: You might need to increase max_locks_per_transaction.");
    await expect(make().readQuery("p1", "select * from t")).rejects.toMatchObject({ statusCode: 400, code: "too_many_locks" });
    handler = () => fail("ERROR: canceling statement due to statement timeout");
    await expect(make().readQuery("p1", "select * from t")).rejects.toMatchObject({ statusCode: 408, code: "query_timeout" });
  });

  it("recusa mais de uma instrução, comando do cliente, vazio e texto gigante", async () => {
    const s = make();
    await expect(s.readQuery("p1", "select 1; select 2")).rejects.toMatchObject({ code: "sql_multiple" });
    await expect(s.readQuery("p1", "\\! ls")).rejects.toMatchObject({ code: "sql_client_command" });
    await expect(s.readQuery("p1", "-- nada")).rejects.toMatchObject({ code: "sql_empty" });
    await expect(s.readQuery("p1", "select 'x")).rejects.toMatchObject({ code: "sql_unterminated" });
    await expect(s.readQuery("p1", "select 1 /*! x */")).rejects.toMatchObject({ code: "sql_executable_comment" });
    await expect(s.readQuery("p1", `select '${"x".repeat(21_000)}'`)).rejects.toMatchObject({ code: "sql_too_long" });
    expect(calls).toHaveLength(0);
  });

  it("erro do banco: 400 com o início da mensagem; prazo estourado: 408", async () => {
    handler = () => fail('ERROR: relation "x" does not exist\nLINE 1');
    await expect(make().readQuery("p1", "select * from x")).rejects.toMatchObject({ statusCode: 400, code: "query_failed", details: { detail: expect.stringContaining("does not exist") } });
    handler = () => fail("");
    await expect(make().readQuery("p1", "select * from x")).rejects.toMatchObject({ details: { detail: "" } });
    handler = () => ({ ...fail(""), timedOut: true, code: null });
    await expect(make().readQuery("p1", "select count(*) from big")).rejects.toMatchObject({ statusCode: 408, code: "query_timeout" });
  });

  it("banco indisponível: 409 com o motivo", async () => {
    detection = detectionOf([db("mongo")]);
    await expect(make().readQuery("p1", "select 1")).rejects.toMatchObject({ statusCode: 409, code: "unsupported_engine" });
  });
});

describe("esvaziar tabelas", () => {
  it("PostgreSQL: RESTART IDENTITY, sem CASCADE por padrão, nomes conferidos e citados", async () => {
    handler = (c) => (c.stdin?.includes("BEGIN READ ONLY") ? ok(PG_OVERVIEW) : ok());
    const { final } = await run(make(), { kind: "truncate", tables: [{ name: "users" }, { schema: "audit", name: "log" }], cascade: false });
    expect(final).toMatchObject({ status: "success", kind: "truncate", steps: [{ id: "backup", status: "skipped" }, { id: "action", status: "done" }] });
    expect(lastSh().stdin).toContain('TRUNCATE TABLE "public"."users", "audit"."log" RESTART IDENTITY;');
    // prazos do próprio servidor, para o comando não seguir rodando se o painel desistir
    expect(lastSh().stdin).toContain("SET lock_timeout = '15s';");
    expect(lastSh().stdin).toContain("SET statement_timeout = '540s';");
    expect(lastSh().stdin).not.toContain("CASCADE");
  });

  it("PostgreSQL com CASCADE só quando pedido", async () => {
    handler = (c) => (c.stdin?.includes("BEGIN READ ONLY") ? ok(PG_OVERVIEW) : ok());
    await run(make(), { kind: "truncate", tables: [{ name: "users" }], cascade: true });
    expect(lastSh().stdin).toContain("RESTART IDENTITY CASCADE;");
  });

  it("MySQL: desliga a checagem de chaves na sessão e ignora CASCADE", async () => {
    detection = detectionOf([db("mysql")]);
    handler = (c) => (c.stdin?.includes("information_schema.tables") ? ok(MY_OVERVIEW) : ok());
    await run(make(), { kind: "truncate", tables: [{ name: "users" }, { name: "posts" }], cascade: true });
    const sql = lastSh().stdin!;
    expect(sql).toContain("SET FOREIGN_KEY_CHECKS = 0;");
    expect(sql).toContain("TRUNCATE TABLE `users`;");
    expect(sql).toContain("SET FOREIGN_KEY_CHECKS = 1;");
    expect(sql).not.toContain("CASCADE");
    expect(lastSh().script).toContain("lock_wait_timeout=15");
    expect(lastSh().script).toContain("max_execution_time=540000");
  });

  it("tabela que não existe é recusada ANTES de qualquer coisa (sem gastar o código de verificação)", async () => {
    handler = () => ok(PG_OVERVIEW);
    await expect(make().plan("p1", { kind: "truncate", tables: [{ name: "users; drop table users" }], cascade: false })).rejects.toMatchObject({ statusCode: 400, code: "unknown_table" });
    expect(calls.every((c) => !c.stdin?.includes("TRUNCATE"))).toBe(true);
  });

  it("lista vazia, lista grande demais e banco que não responde", async () => {
    handler = () => ok(PG_OVERVIEW);
    await expect(make().plan("p1", { kind: "truncate", tables: [], cascade: false })).rejects.toMatchObject({ code: "no_tables" });
    const many = Array.from({ length: 501 }, (_v, i) => ({ name: `t${i}` }));
    await expect(make().plan("p1", { kind: "truncate", tables: many, cascade: false })).rejects.toMatchObject({ code: "too_many_tables" });
    handler = () => fail("x");
    await expect(make().plan("p1", { kind: "truncate", tables: [{ name: "users" }], cascade: false })).rejects.toMatchObject({ statusCode: 409, code: "query_failed" });
  });

  it("falha do banco vira erro do trabalho, com o motivo, e a Auditoria só guarda o código", async () => {
    handler = (c) => (c.stdin?.includes("BEGIN READ ONLY") ? ok(PG_OVERVIEW) : fail("ERROR: cannot truncate a table referenced in a foreign key constraint"));
    const { final } = await run(make(), { kind: "truncate", tables: [{ name: "users" }], cascade: false });
    expect(final.status).toBe("failed");
    expect(final.error).toMatchObject({ code: "query_failed", detail: expect.stringContaining("foreign key") });
    expect(final.steps[1]!.status).toBe("failed");
    const failed = audits.find((a) => a.action === "database.truncate_failed")!;
    expect(failed.detail).toBe("Falhou (query_failed).");
  });

  it("prazo do painel estourado: diz se o processo foi parado ou se pode ainda estar rodando", async () => {
    handler = (c) => (c.stdin?.includes("BEGIN READ ONLY") ? ok(PG_OVERVIEW) : { ...fail(""), timedOut: true, code: null, stopped: true });
    const { final } = await run(make(), { kind: "truncate", tables: [{ name: "users" }], cascade: false });
    expect(final.error?.code).toBe("timeout");
    expect(final.error?.message).toContain("cancelou o processo e a sessão");
    handler = (c) => (c.stdin?.includes("BEGIN READ ONLY") ? ok(PG_OVERVIEW) : { ...fail(""), timedOut: true, code: null, stopped: false });
    const again = await run(make(), { kind: "truncate", tables: [{ name: "users" }], cascade: false });
    expect(again.final.error?.message).toContain("pode ainda estar rodando");
  });

  it("prazo e limite de bloqueios do próprio banco viram códigos próprios", async () => {
    handler = (c) => (c.stdin?.includes("BEGIN READ ONLY") ? ok(PG_OVERVIEW) : fail("ERROR: canceling statement due to lock timeout"));
    expect((await run(make(), { kind: "truncate", tables: [{ name: "users" }], cascade: false })).final.error?.code).toBe("db_timeout");
    handler = (c) => (c.stdin?.includes("BEGIN READ ONLY") ? ok(PG_OVERVIEW) : fail("ERROR: out of shared memory\nHINT: increase max_locks_per_transaction"));
    const r = await run(make(), { kind: "truncate", tables: [{ name: "users" }], cascade: true });
    expect(r.final.error).toMatchObject({ code: "too_many_locks", detail: expect.stringContaining("max_locks_per_transaction") });
  });

  it("Auditoria: ator, ação e tabelas; nunca SQL", async () => {
    handler = (c) => (c.stdin?.includes("BEGIN READ ONLY") ? ok(PG_OVERVIEW) : ok());
    await run(make(), { kind: "truncate", tables: [{ name: "users" }, { schema: "audit", name: "log" }], cascade: true });
    expect(audits.map((a) => a.action)).toEqual(["database.truncate", "database.truncate_done"]);
    expect(audits[0]).toMatchObject({ actor: "kelvin", target: "loja" });
    expect(audits[0]!.detail).toContain("users, audit.log");
    expect(audits[0]!.detail).toContain("CASCADE");
    expect(audits[0]!.detail).toContain("Backup antes: não");
    expect(audits[0]!.detail).not.toMatch(/TRUNCATE TABLE/);
  });
});

describe("prazos: o banco desiste antes de o painel parar de esperar", () => {
  it("em toda ação, o limite do banco é menor que o do painel", () => {
    for (const [name, v] of Object.entries(DB_TIMEOUTS)) {
      expect(v.dbSeconds * 1000, name).toBeLessThan(v.panelMs);
    }
  });

  it("escrita no PostgreSQL: 120 s no banco, abaixo dos 150 s do painel", async () => {
    handler = () => ok("");
    await run(make(), { kind: "sql", sql: "update t set a = 1" });
    const c = lastSh();
    expect(c.stdin).toContain("SET statement_timeout = '120s';");
    expect(c.stdin).not.toContain("540s");
    expect(c.timeoutMs).toBe(DB_TIMEOUTS.write.panelMs);
    expect(120_000).toBeLessThan(c.timeoutMs!);
    expect(c.stdin!.startsWith("SET application_name = 'tws-db-0123456789abcdef';\n")).toBe(true);
    expect(c.engine).toBe("postgres");
  });

  it("escrita no MySQL: sessão marcada para o KILL QUERY e prazo do cliente pelo motor", async () => {
    detection = detectionOf([db("mysql")]);
    handler = () => ok("");
    await run(make(), { kind: "sql", sql: "update t set a = 1" });
    const c = lastSh();
    expect(c.stdin!.startsWith("DO GET_LOCK('tws-db-0123456789abcdef', 0);\n")).toBe(true);
    expect(c.script).toContain("lock_wait_timeout=15");
    expect(c.script).toContain("max_execution_time=120000");
    expect(c.timeoutMs).toBe(150_000);
  });

  it("prazo estourado em escrita: o resultado do cancelamento no servidor decide a mensagem", async () => {
    detection = detectionOf([db("mysql")]);
    handler = () => ({ ...fail(""), timedOut: true, code: null, stopped: false });
    expect((await run(make(), { kind: "sql", sql: "update t set a = 1" })).final.error?.message).toContain("pode ainda estar rodando no banco");
    handler = () => ({ ...fail(""), timedOut: true, code: null, stopped: true });
    expect((await run(make(), { kind: "sql", sql: "update t set a = 1" })).final.error?.message).toContain("cancelou");
  });

  it("o Laravel leva a marca no pid, sem engine", async () => {
    framework = "laravel";
    await run(make(), { kind: "command", command: "laravel-seed" });
    expect(probed).toHaveLength(1);
  });
});

describe("zerar o banco", () => {
  it("PostgreSQL: um comando DO que apaga os objetos e mantém esquemas e extensões", async () => {
    const { final } = await run(make(), { kind: "reset" });
    expect(final.status).toBe("success");
    expect(lastSh().stdin).toContain("DO $tws_reset$");
    expect(lastSh().stdin).not.toMatch(/DROP SCHEMA/i);
    expect(lastSh().stdin).toContain("SET statement_timeout = '540s';");
    // funções e procedimentos de tipos de faixa (deptype 'i') ficam por conta do DROP TYPE
    expect(lastSh().stdin).toContain("d.deptype IN ('e', 'i'))");
    expect(audits[0]!.action).toBe("database.reset");
  });

  it("MySQL: lista o que há e apaga tabelas, visões, rotinas e eventos", async () => {
    detection = detectionOf([db("mariadb")]);
    handler = (c) => (c.stdin?.includes("information_schema.routines") ? ok("T\tusers\tBASE TABLE\nR\tPROCEDURE\tp1\nE\te1\n") : ok());
    const { final } = await run(make(), { kind: "reset" });
    expect(final.status).toBe("success");
    const sql = lastSh().stdin!;
    expect(sql).toContain("DROP TABLE IF EXISTS `users`;");
    expect(sql).toContain("DROP PROCEDURE IF EXISTS `p1`;");
    expect(sql).toContain("DROP EVENT IF EXISTS `e1`;");
  });

  it("MySQL: não consegue listar, nome estranho ou comando recusado", async () => {
    detection = detectionOf([db("mysql")]);
    handler = () => fail("x");
    expect((await run(make(), { kind: "reset" })).final.error?.code).toBe("query_failed");
    handler = (c) => (c.stdin?.includes("information_schema.routines") ? ok("T\ta\tb\tBASE TABLE\n".replace("a\tb", "a\u0001b")) : ok());
    expect((await run(make(), { kind: "reset" })).final.error?.code).toBe("unsafe_name");
    handler = (c) => (c.stdin?.includes("information_schema.routines") ? ok("T\tusers\tBASE TABLE\n") : fail("ERROR 1451 foreign key"));
    expect((await run(make(), { kind: "reset" })).final.error?.detail).toContain("1451");
  });

  it("PostgreSQL recusado pelo banco", async () => {
    handler = () => fail("ERROR: permission denied");
    expect((await run(make(), { kind: "reset" })).final.error).toMatchObject({ code: "query_failed", detail: expect.stringContaining("permission denied") });
  });
});

describe("console SQL: escrita", () => {
  it("roda o texto como está, devolve o resultado e audita sem o texto", async () => {
    handler = () => ok("id\n7\n");
    const { final } = await run(make(), { kind: "sql", sql: "insert into users (name) values ('segredo') returning id" });
    expect(final.status).toBe("success");
    expect(final.result).toMatchObject({ columns: ["id"], rows: [["7"]] });
    expect(lastSh().stdin).toContain("values ('segredo')");
    expect(lastSh().stdin).toContain("SET lock_timeout = '15s';");
    expect(audits[0]!.action).toBe("database.sql_write");
    expect(audits[0]!.detail).toContain("insert");
    expect(JSON.stringify(audits)).not.toContain("segredo");
  });

  it("recusa mais de uma instrução ANTES de pedir a senha", async () => {
    await expect(make().plan("p1", { kind: "sql", sql: "delete from a; delete from b" })).rejects.toMatchObject({ code: "sql_multiple" });
  });

  it("erro do banco, prazo e saída cortada", async () => {
    handler = () => fail("ERROR: syntax error at or near x");
    expect((await run(make(), { kind: "sql", sql: "drop tablee x" })).final.error).toMatchObject({ code: "query_failed", detail: expect.stringContaining("syntax error") });
    handler = () => fail("");
    expect((await run(make(), { kind: "sql", sql: "drop tablee x" })).final.error?.detail).toBe("");
    handler = () => ({ ...fail(""), timedOut: true, code: null });
    expect((await run(make(), { kind: "sql", sql: "update t set a = 1" })).final.error?.code).toBe("timeout");
    handler = () => ({ ...ok("n\n1\n2-meta"), truncated: true, code: null });
    const r = await run(make(), { kind: "sql", sql: "update t set a = 1 returning n" });
    expect(r.final.status).toBe("success");
    expect(r.final.result?.truncated).toBe(true);
  });

  it("a mensagem de erro sai com os segredos do projeto mascarados", async () => {
    secrets = ["super-senha-123456"];
    handler = () => fail("ERROR: invalid input: super-senha-123456");
    const r = await run(make(), { kind: "sql", sql: "update t set a = 1" });
    expect(r.final.error?.detail).not.toContain("super-senha-123456");
    expect(r.final.error?.detail).toContain("[oculto]");
  });
});

describe("comando do framework", () => {
  beforeEach(() => {
    framework = "laravel";
  });

  it("roda no container do app (nunca no do banco), sem shell, e devolve a saída mascarada", async () => {
    secrets = ["valor-secreto-9999"];
    handler = () => ok("Dropped all tables successfully. valor-secreto-9999\nSeeded.\n");
    const { final } = await run(make(), { kind: "command", command: "laravel-migrate-fresh-seed" });
    expect(final.status).toBe("success");
    expect(final.output).toContain("Seeded.");
    expect(final.output).not.toContain("valor-secreto-9999");
    const call = calls.find((c) => c.kind === "argv")!;
    expect(call.container).toBe("c-web");
    expect(call.argv).toEqual(["php", "artisan", "migrate:fresh", "--seed", "--force", "--no-interaction", "--no-ansi"]);
    expect(audits[0]!.action).toBe("database.command");
  });

  it("com nginx + php-fpm, escolhe o container que TEM o artisan (não o de entrada)", async () => {
    proj = project({ proxyService: "nginx" });
    containers = [{ id: "c-db", name: "d", service: "db", running: true }, { id: "c-nginx", name: "n", service: "nginx", running: true }, { id: "c-php", name: "p", service: "php", running: true }];
    probeResult = (c) => (c === "c-php" ? ok() : fail("", { code: 1 }));
    await run(make(), { kind: "command", command: "laravel-migrate" });
    expect(probed.sort()).toEqual(["c-nginx", "c-php"]);
    expect(calls.find((c) => c.kind === "argv")!.container).toBe("c-php");
  });

  it("mais de um container com artisan: pede a escolha (409 com os serviços) e aceita o serviço pedido", async () => {
    proj = project({ proxyService: "api" });
    containers = [...containers, { id: "c-api", name: "x", service: "api", running: true }];
    await expect(make().plan("p1", { kind: "command", command: "laravel-migrate" })).rejects.toMatchObject({
      statusCode: 409,
      code: "app_ambiguous",
      details: { services: ["web", "api"], suggested: "api" },
    });
    await run(make(), { kind: "command", command: "laravel-migrate", service: "api" });
    expect(calls.find((c) => c.kind === "argv")!.container).toBe("c-api");
    await expect(make().plan("p1", { kind: "command", command: "laravel-migrate", service: "db" })).rejects.toMatchObject({ statusCode: 400, code: "unknown_service" });
    proj = project();
    await expect(make().plan("p1", { kind: "command", command: "laravel-migrate" })).rejects.toMatchObject({ details: { suggested: null } });
  });

  it("nenhum container com artisan, ou sonda que falha", async () => {
    probeResult = () => fail("", { code: 1 });
    await expect(make().plan("p1", { kind: "command", command: "laravel-seed" })).rejects.toMatchObject({ statusCode: 409, code: "app_artisan_not_found" });
    const service = make({ exec: { ...make()["opts"].exec, argv: async () => { throw new Error("docker"); } } });
    await expect(service.plan("p1", { kind: "command", command: "laravel-seed" })).rejects.toMatchObject({ code: "app_artisan_not_found" });
  });

  it("sem framework reconhecido, ou com o comando de outro framework: 400", async () => {
    framework = null;
    await expect(make().plan("p1", { kind: "command", command: "laravel-seed" })).rejects.toMatchObject({ statusCode: 400, code: "command_not_available" });
  });

  it("app parado ou Docker fora do ar", async () => {
    containers = [{ id: "c-db", name: "x", service: "db", running: true }];
    await expect(make().plan("p1", { kind: "command", command: "laravel-seed" })).rejects.toMatchObject({ statusCode: 409, code: "app_not_running" });
    containersError = true;
    await expect(make().plan("p1", { kind: "command", command: "laravel-seed" })).rejects.toMatchObject({ statusCode: 503, code: "docker_unavailable" });
  });

  it("sem banco detectado o comando ainda vale (qualquer container com artisan)", async () => {
    detection = detectionOf([]);
    probeResult = (c) => (c === "c-db" ? ok() : fail("", { code: 1 }));
    await run(make(), { kind: "command", command: "laravel-seed" });
    expect(calls.find((c) => c.kind === "argv")!.container).toBe("c-db");
  });

  it("dois containers do mesmo serviço (réplicas) contam uma vez", async () => {
    containers = [...containers, { id: "c-web2", name: "w2", service: "web", running: true }, { id: "c-off", name: "o", service: "worker", running: false }];
    await run(make(), { kind: "command", command: "laravel-seed" });
    expect(probed).toEqual(["c-web"]);
  });

  it("falha mostra a saída; prazo e saída cortada", async () => {
    handler = () => ({ code: 1, stdout: "Migrating...", stderr: "SQLSTATE[HY000]", truncated: false, timedOut: false });
    const r = await run(make(), { kind: "command", command: "laravel-migrate" });
    expect(r.final.error).toMatchObject({ code: "command_failed", detail: "1" });
    expect(r.final.output).toContain("SQLSTATE[HY000]");
    handler = () => ({ code: null, stdout: "parcial", stderr: "", truncated: false, timedOut: true, stopped: true });
    const timed = await run(make(), { kind: "command", command: "laravel-migrate" });
    expect(timed.final.error?.code).toBe("timeout");
    expect(timed.final.output).toBe("parcial");
    // parou de verdade: pode rodar de novo
    await expect(make().plan("p1", { kind: "command", command: "laravel-migrate" })).resolves.toBeTruthy();
    handler = () => ({ code: 0, stdout: "x".repeat(10), stderr: "", truncated: true, timedOut: false });
    expect((await run(make(), { kind: "command", command: "laravel-migrate" })).final.output).toContain("[saída cortada]");
    handler = () => ({ code: null, stdout: "", stderr: "", truncated: false, timedOut: false });
    expect((await run(make(), { kind: "command", command: "laravel-migrate" })).final.error?.detail).toBe("?");
  });
});

describe("backup antes da ação", () => {
  const truncate: DatabaseAction = { kind: "truncate", tables: [{ name: "users" }], cascade: false };
  beforeEach(() => {
    handler = (c) => (c.stdin?.includes("BEGIN READ ONLY") ? ok(PG_OVERVIEW) : ok());
  });

  it("backup bem-sucedido: a ação roda depois e o arquivo fica no trabalho", async () => {
    backupSeq = [record("queued"), record("running"), record("success")];
    const { final } = await run(make(), truncate, "full");
    expect(backupRuns).toEqual(["p1"]);
    expect(final).toMatchObject({ status: "success", backupFileName: "2026-10-30_10-00.7z", steps: [{ id: "backup", status: "done" }, { id: "action", status: "done" }] });
    expect(calls.some((c) => c.stdin?.includes("TRUNCATE"))).toBe(true);
    expect(audits[0]!.detail).toContain("Backup antes: completo");
  });

  it("backup que falha: a ação NÃO roda e a mensagem diz que nada foi alterado", async () => {
    backupSeq = [record("failed", { error: "sem espaço em disco" })];
    const { final } = await run(make(), truncate, "full");
    expect(final.status).toBe("failed");
    expect(final.error).toMatchObject({ code: "backup_failed", detail: "sem espaço em disco" });
    expect(final.error!.message).toContain("Nada foi alterado");
    expect(final.steps).toEqual([{ id: "backup", status: "failed" }, { id: "action", status: "pending" }]);
    expect(calls.some((c) => c.stdin?.includes("TRUNCATE"))).toBe(false);
    expect(audits.find((a) => a.action === "database.truncate_failed")!.detail).toContain("nada foi alterado");
  });

  it("backup com aviso não vale (pode estar incompleto)", async () => {
    backupSeq = [record("warning", { warnings: ["pasta incompleta"], fileName: "x.7z" })];
    const { final } = await run(make(), truncate, "full");
    expect(final.error?.detail).toContain("pasta incompleta");
    backupSeq = [record("warning", { warnings: [] })];
    expect((await run(make(), truncate, "full")).final.error?.code).toBe("backup_failed");
    backupSeq = [record("failed", { error: null })];
    expect((await run(make(), truncate, "full")).final.error?.detail).toBe("falhou");
  });

  it("o backup nem entra na fila (ex.: projeto ainda sem deploy)", async () => {
    backupRunError = new Error("Faça o primeiro deploy do projeto antes do backup.");
    const { final } = await run(make(), truncate, "full");
    expect(final.error).toMatchObject({ code: "backup_failed", detail: expect.stringContaining("primeiro deploy") });
    backupRunError = new Error("x");
    expect((await run(make(), truncate, "full")).final.error?.code).toBe("backup_failed");
    backupRunError = "texto" as unknown as Error;
    expect((await run(make(), truncate, "full")).final.error?.detail).toBe("");
  });

  it("backup que não termina em 30 minutos", async () => {
    backupSeq = [record("running")];
    const service = make({
      sleep: async () => {
        clock += 20 * 60_000;
      },
    });
    const { final } = await run(service, truncate, "full");
    expect(final.error).toMatchObject({ code: "backup_timeout" });
    expect(final.error!.message).toContain("30 minutos");
  });

  describe("validação por restauração", () => {
    const FILE = "2026-10-30_10-00.7z";
    const view = (status: "ok" | "failed" | "not_run" | "running", file: string | null): RestoreCheckView =>
      ({ settings: { enabled: true }, last: { status, backupFileName: file, reason: "o dump não restaurou" } }) as unknown as RestoreCheckView;

    it("espera o resultado DESTE arquivo (ainda rodando -> ok) e registra que passou", async () => {
      restoreSeq = [view("ok", "antigo.7z"), view("ok", "antigo.7z"), view("running", FILE), view("ok", FILE)];
      busyNow = () => true;
      const { final } = await run(make(), truncate, "full");
      expect(final).toMatchObject({ status: "success", backupValidation: "passed" });
    });

    it("validação que falhou: a ação NÃO roda", async () => {
      restoreSeq = [view("ok", "antigo.7z"), view("failed", FILE)];
      const bad = await run(make(), truncate, "full");
      expect(bad.final.error).toMatchObject({ code: "backup_validation_failed", detail: "o dump não restaurou" });
      expect(bad.final.steps[0]!.status).toBe("failed");
      expect(calls.some((c) => c.stdin?.includes("TRUNCATE"))).toBe(false);
    });

    it("sem teste para este arquivo (fila vazia) ou marcado como não executado: segue e registra 'não executada'", async () => {
      restoreSeq = [view("ok", "antigo.7z")];
      busyNow = () => false;
      expect((await run(make(), truncate, "full")).final).toMatchObject({ status: "success", backupValidation: "not_run" });
      // só a fila DESTE projeto conta
      expect(busyIds).toEqual(["p1"]);
      restoreSeq = [view("ok", "antigo.7z"), view("not_run", FILE)];
      expect((await run(make(), truncate, "full")).final).toMatchObject({ status: "success", backupValidation: "not_run" });
    });

    it("validação que não termina no prazo: aborta, sem rodar a ação", async () => {
      restoreSeq = [view("ok", "antigo.7z"), view("running", FILE)];
      busyNow = () => true;
      const service = make({
        sleep: async () => {
          clock += 20 * 60_000;
        },
      });
      const { final } = await run(service, truncate, "full");
      expect(final.error).toMatchObject({ code: "backup_timeout" });
      expect(final.error!.message).toContain("validação");
      expect(calls.some((c) => c.stdin?.includes("TRUNCATE"))).toBe(false);
    });

    it("consulta do resultado que falha no meio da espera conta como sem resultado", async () => {
      let n = 0;
      const service = make({
        backups: {
          ...make()["opts"].backups,
          run: async () => backupSeq[0]!,
          record: async () => backupSeq[0]!,
          restoreCheck: async () => {
            if (n++ === 0) return view("ok", "antigo.7z");
            throw new Error("x");
          },
        },
      });
      expect((await run(service, truncate, "full")).final.backupValidation).toBe("not_run");
    });
  });

  it("validação desligada: segue e registra 'não executada'", async () => {
    restoreSeq = [{ settings: { enabled: false }, last: null } as unknown as RestoreCheckView];
    const { final } = await run(make(), truncate, "full");
    expect(final).toMatchObject({ status: "success", backupValidation: "not_run" });
  });

  it("consulta da validação que falha não derruba a ação", async () => {
    const service = make({ backups: { ...make()["opts"].backups, run: async () => backupSeq[0]!, record: async () => backupSeq[0]!, restoreCheck: async () => { throw new Error("x"); } } });
    expect((await run(service, truncate, "full")).final.status).toBe("success");
  });
});

describe("trabalhos", () => {
  beforeEach(() => {
    handler = (c) => (c.stdin?.includes("BEGIN READ ONLY") ? ok(PG_OVERVIEW) : ok());
  });

  it("um por projeto: pedir outro enquanto roda dá 409 database_busy", async () => {
    let release: () => void = () => undefined;
    handler = (c) => (c.stdin?.includes("BEGIN READ ONLY") ? ok(PG_OVERVIEW) : new Promise<DbExecResult>((r) => (release = () => r(ok()))));
    const service = make();
    const plan = await service.plan("p1", { kind: "truncate", tables: [{ name: "users" }], cascade: false });
    const job = await service.begin(plan, "kelvin", "none");
    expect(job.status).toBe("running");
    await expect(service.plan("p1", { kind: "reset" })).rejects.toMatchObject({ statusCode: 409, code: "database_busy" });
    await expect(service.begin(plan, "kelvin", "none")).rejects.toMatchObject({ code: "database_busy" });
    release();
    await service.settled();
    expect(service.job("p1", job.id).status).toBe("success");
    // liberado: pode pedir de novo
    await expect(service.plan("p1", { kind: "reset" })).resolves.toBeTruthy();
  });

  it("trabalho inexistente: 404", () => {
    expect(() => make().job("p1", "nada")).toThrow(expect.objectContaining({ statusCode: 404 }));
  });

  it("guarda só os 5 últimos por projeto, e saída/resultado só dos 2 mais recentes", async () => {
    let n = 0;
    const service = make({ newId: () => `j${n++}` });
    handler = () => ok("n\n1\n");
    for (let i = 0; i < 7; i++) await run(service, { kind: "sql", sql: "update t set a = 1 returning n" });
    expect(() => service.job("p1", "j0")).toThrow();
    expect(() => service.job("p1", "j1")).toThrow();
    expect(service.job("p1", "j6")).toMatchObject({ status: "success", result: { rows: [["1"]] } });
    expect(service.job("p1", "j5").result).not.toBeNull();
    expect(service.job("p1", "j4").result).toBeNull();
    expect(service.job("p1", "j2")).toMatchObject({ status: "success", result: null, output: null });
  });

  it("comando que passou do prazo sem confirmar que parou: outro comando espera (409)", async () => {
    framework = "laravel";
    handler = () => ({ code: null, stdout: "", stderr: "", truncated: false, timedOut: true, stopped: false });
    const service = make();
    expect((await run(service, { kind: "command", command: "laravel-migrate" })).final.error?.code).toBe("timeout");
    await expect(service.plan("p1", { kind: "command", command: "laravel-migrate" })).rejects.toMatchObject({ statusCode: 409, code: "command_may_be_running" });
    // passado o prazo de segurança, libera
    clock += 31 * 60_000;
    await expect(service.plan("p1", { kind: "command", command: "laravel-migrate" })).resolves.toBeTruthy();
  });

  it("variáveis do projeto ilegíveis não impedem a ação; erro inesperado vira falha genérica", async () => {
    secrets = new Error("sem chave");
    expect((await run(make(), { kind: "reset" })).final.status).toBe("success");
    handler = () => {
      throw new Error("explodiu com segredo");
    };
    const r = await run(make(), { kind: "reset" });
    expect(r.final.error).toEqual({ code: "failed", message: "A ação não pôde ser concluída.", detail: null });
  });

  it("sem relógio, espera e gerador de id injetados: usa os do sistema", async () => {
    handler = async () => {
      await new Promise((r) => setTimeout(r, 15));
      return ok();
    };
    const base = make();
    const service = new DatabaseService({ ...base["opts"], now: undefined, sleep: undefined, newId: undefined });
    const plan = await service.plan("p1", { kind: "reset" });
    const job = await service.begin(plan, "kelvin", "none");
    expect(job.id).toMatch(/^[0-9a-f]{16}$/);
    expect(Date.parse(job.startedAt)).toBeGreaterThan(Date.UTC(2026, 0, 1));
    await service.settled();
    expect(service.job("p1", job.id).status).toBe("success");
  });

  it("detecção do framework e leitura das tabelas que explodem não derrubam a visão nem o pedido", async () => {
    const boom = make({ detectFramework: async () => { throw new Error("x"); } });
    handler = () => ok(PG_OVERVIEW);
    expect((await boom.overview("p1")).framework).toBeNull();
    framework = "laravel";
    await expect(boom.plan("p1", { kind: "command", command: "laravel-seed" })).rejects.toMatchObject({ code: "command_not_available" });
    handler = () => {
      throw new Error("docker caiu");
    };
    expect((await make().overview("p1")).code).toBe("query_failed");
    await expect(make().plan("p1", { kind: "truncate", tables: [{ name: "users" }], cascade: false })).rejects.toMatchObject({ code: "query_failed" });
  });

  it("falha na Auditoria não derruba a ação", async () => {
    const service = make({ audit: { record: async () => { throw new Error("disco"); } } });
    expect((await run(service, { kind: "reset" })).final.status).toBe("success");
  });

  it("DatabaseActionError carrega código, mensagem e saída", () => {
    const e = new DatabaseActionError("x", "y", { output: "saída", detail: "d" });
    expect([e.code, e.message, e.output, e.detail]).toEqual(["x", "y", "saída", "d"]);
    expect(new DatabaseActionError("x", "y")).toMatchObject({ output: null, detail: null });
  });
});
