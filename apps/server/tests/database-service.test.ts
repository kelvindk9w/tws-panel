/**
 * database-service.test.ts — a aba Banco: visão geral, console SQL, esvaziar, zerar, comando do framework e o backup
 * antes da ação. O `docker exec` e o serviço de backups são dublês; aqui se confere o que seria enviado ao banco.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { BackupRecord, DetectedDatabase, Project, ProjectBackupDetection, RestoreCheckView } from "@paas/core";
import { DatabaseService, DatabaseActionError, type DatabaseServiceOptions, type DatabaseAction } from "../src/services/database-service.js";
import type { DbExecResult } from "../src/services/database-docker.js";

const ok = (stdout = ""): DbExecResult => ({ code: 0, stdout, stderr: "", truncated: false, timedOut: false });
const fail = (stderr: string, extra: Partial<DbExecResult> = {}): DbExecResult => ({ code: 1, stdout: "", stderr, truncated: false, timedOut: false, ...extra });

interface Call {
  kind: "sh" | "argv";
  container: string;
  script?: string;
  args?: string[];
  stdin?: string;
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
let restoreView: RestoreCheckView | null;
let restoreAfter: RestoreCheckView | null;
let idleCalls: number;
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
        const c: Call = { kind: "sh", container, script, args, stdin: o.stdin };
        calls.push(c);
        return handler(c);
      },
      argv: async (container, argv) => {
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
      idle: async () => {
        idleCalls++;
      },
      restoreCheck: async () => (idleCalls > 0 ? restoreAfter : restoreView),
    },
    detectFramework: async () => framework,
    audit: { record: async (i) => void audits.push(i) },
    now: () => clock,
    sleep: async () => {
      clock += 1500;
    },
    newId: () => "job1",
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
  restoreView = null;
  restoreAfter = null;
  idleCalls = 0;
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
    handler = () => ok("id,name\n1,Ana\n2,NULL\n");
    const r = await make().readQuery("p1", "select id, name from users;");
    expect(r).toEqual({ columns: ["id", "name"], rows: [["1", "Ana"], ["2", null]], truncated: false, empty: false });
    const call = lastSh();
    expect(call.stdin).toContain("BEGIN READ ONLY");
    expect(call.stdin).toContain("select id, name from users");
    expect(call.args).toEqual(["appdb"]);
    expect(call.script).toContain("--csv");
  });

  it("MySQL: START TRANSACTION READ ONLY e saída em TSV", async () => {
    detection = detectionOf([db("mysql")]);
    handler = () => ok("id\tname\n1\tAna\n");
    const r = await make().readQuery("p1", "show tables");
    expect(r.rows).toEqual([["1", "Ana"]]);
    expect(lastSh().stdin).toContain("START TRANSACTION READ ONLY");
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
    handler = () => ok("");
    expect(await make().readQuery("p1", "select 1 from t where 0")).toMatchObject({ empty: true, rows: [] });
  });

  it("comando de escrita não roda aqui: 400 write_query, sem tocar no banco", async () => {
    await expect(make().readQuery("p1", "delete from users")).rejects.toMatchObject({ statusCode: 400, code: "write_query" });
    await expect(make().readQuery("p1", "select * into novo from users")).rejects.toMatchObject({ code: "write_query" });
    expect(calls).toHaveLength(0);
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
    await expect(make().readQuery("p1", "select pg_sleep(99)")).rejects.toMatchObject({ statusCode: 408, code: "query_timeout" });
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

  it("prazo estourado", async () => {
    handler = (c) => (c.stdin?.includes("BEGIN READ ONLY") ? ok(PG_OVERVIEW) : { ...fail(""), timedOut: true, code: null });
    const { final } = await run(make(), { kind: "truncate", tables: [{ name: "users" }], cascade: false });
    expect(final.error?.code).toBe("timeout");
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

describe("zerar o banco", () => {
  it("PostgreSQL: um comando DO que apaga os objetos e mantém esquemas e extensões", async () => {
    const { final } = await run(make(), { kind: "reset" });
    expect(final.status).toBe("success");
    expect(lastSh().stdin).toContain("DO $tws_reset$");
    expect(lastSh().stdin).not.toMatch(/DROP SCHEMA/i);
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

  it("usa o serviço de entrada do projeto quando há vários", async () => {
    proj = project({ proxyService: "api" });
    containers = [...containers, { id: "c-api", name: "x", service: "api", running: true }];
    await run(make(), { kind: "command", command: "laravel-migrate" });
    expect(calls.find((c) => c.kind === "argv")!.container).toBe("c-api");
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

  it("sem banco detectado o comando ainda vale (o app é o primeiro container em execução)", async () => {
    detection = detectionOf([]);
    await run(make(), { kind: "command", command: "laravel-seed" });
    expect(calls.find((c) => c.kind === "argv")!.container).toBe("c-db");
  });

  it("falha mostra a saída; prazo e saída cortada", async () => {
    handler = () => ({ code: 1, stdout: "Migrating...", stderr: "SQLSTATE[HY000]", truncated: false, timedOut: false });
    const r = await run(make(), { kind: "command", command: "laravel-migrate" });
    expect(r.final.error).toMatchObject({ code: "command_failed", detail: "1" });
    expect(r.final.output).toContain("SQLSTATE[HY000]");
    handler = () => ({ code: null, stdout: "", stderr: "", truncated: false, timedOut: true });
    expect((await run(make(), { kind: "command", command: "laravel-migrate" })).final.error?.code).toBe("timeout");
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

  it("backup que não termina em 2 horas", async () => {
    backupSeq = [record("running")];
    const service = make({
      sleep: async () => {
        clock += 60 * 60_000;
      },
    });
    const { final } = await run(service, truncate, "full");
    expect(final.error?.code).toBe("backup_timeout");
  });

  it("validação por restauração ligada: espera a fila e só segue se passou para este arquivo", async () => {
    const view = (status: "ok" | "failed", file: string | null): RestoreCheckView =>
      ({ settings: { enabled: true }, last: { status, backupFileName: file, reason: "o dump não restaurou" } }) as unknown as RestoreCheckView;
    restoreView = view("ok", "antigo.7z");
    restoreAfter = view("ok", "2026-10-30_10-00.7z");
    expect((await run(make(), truncate, "full")).final.status).toBe("success");
    expect(idleCalls).toBe(1);

    idleCalls = 0;
    restoreAfter = view("failed", "2026-10-30_10-00.7z");
    const bad = await run(make(), truncate, "full");
    expect(bad.final.error).toMatchObject({ code: "backup_validation_failed", detail: "o dump não restaurou" });
    expect(bad.final.steps[0]!.status).toBe("failed");

    // validação de OUTRO arquivo (a frequência pulou esta): não bloqueia
    idleCalls = 0;
    restoreAfter = view("failed", "outro.7z");
    expect((await run(make(), truncate, "full")).final.status).toBe("success");

    // sem resultado da validação (consulta falhou)
    idleCalls = 0;
    restoreAfter = null;
    expect((await run(make(), truncate, "full")).final.status).toBe("success");
  });

  it("validação desligada: não espera a fila", async () => {
    restoreView = { settings: { enabled: false }, last: null } as unknown as RestoreCheckView;
    await run(make(), truncate, "full");
    expect(idleCalls).toBe(0);
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

  it("guarda só os 10 últimos por projeto", async () => {
    let n = 0;
    const service = make({ newId: () => `j${n++}` });
    for (let i = 0; i < 12; i++) await run(service, { kind: "reset" });
    expect(() => service.job("p1", "j0")).toThrow();
    expect(service.job("p1", "j11").status).toBe("success");
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
