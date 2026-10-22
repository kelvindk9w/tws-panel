/**
 * backup-restore-validate.test.ts — a prova de que o dump restaura, sem Docker:
 * os filtros do dump (Postgres e MySQL/MariaDB), os scripts que rodam no
 * container do banco e a orquestração (restaurar num banco descartável,
 * conferir, apagar o descartável; qualquer falha vira código, nunca texto do banco).
 * O comportamento contra bancos de verdade está em backup-restore-validate-docker.test.ts.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BackupDocker } from "../src/services/backup-docker.js";
import {
  RestoreValidationError,
  filterMysqlDump,
  filterPostgresDump,
  restoreCheckScripts,
  validateRestore,
  type ValidateInput,
} from "../src/services/backup-restore-validate.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-rcval-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function file(name: string, text: string): Promise<string> {
  const f = path.join(dir, name);
  await writeFile(f, text);
  return f;
}

// ---------------------------------------------------------------------------
// Filtro do dump do Postgres
// ---------------------------------------------------------------------------

describe("filterPostgresDump", () => {
  const dump = [
    "-- PostgreSQL database dump",
    'CREATE TABLE public."Meus Dados" (',
    "    id integer",
    ");",
    "CREATE UNLOGGED TABLE IF NOT EXISTS app.log (x int);",
    "CREATE TABLE app.log (x int);",
    "ALTER TABLE public.\"Meus Dados\" OWNER TO dono;",
    "ALTER SCHEMA app OWNER TO dono;",
    "GRANT ALL ON SCHEMA app TO leitor;",
    "REVOKE ALL ON SCHEMA app FROM PUBLIC;",
    "ALTER DEFAULT PRIVILEGES FOR ROLE dono IN SCHEMA app GRANT SELECT ON TABLES TO leitor;",
    "CREATE FUNCTION app.f() RETURNS void LANGUAGE plpgsql AS $_$",
    "BEGIN",
    "GRANT SELECT ON x TO y;",
    "CREATE TABLE falso (a int);",
    "END;",
    "$_$;",
    'COPY public."Meus Dados" (id) FROM stdin;',
    "1",
    "2",
    "3",
    "\\.",
    "COPY app.log (x) FROM stdin;",
    "\\.",
    "COPY public.t (a) FROM stdin;",
    "GRANT ALL ON y TO z;",
    "CREATE TABLE tambem_falso (a int);",
    "\\.",
    "-- PostgreSQL database dump complete",
    "",
  ].join("\n");

  it("tira só dono e permissões; dados e corpos de função passam intactos", async () => {
    const out = path.join(dir, "out.sql");
    const scan = await filterPostgresDump(await file("in.sql", dump), out);
    const text = await readFile(out, "utf8");
    expect(text).not.toMatch(/OWNER TO|^GRANT ALL ON SCHEMA|^REVOKE|ALTER DEFAULT PRIVILEGES/m);
    expect(text).toContain("GRANT SELECT ON x TO y;"); // dentro do corpo da função
    expect(text).toContain("GRANT ALL ON y TO z;"); // linha de dados do COPY
    expect(text).toContain("CREATE TABLE public.\"Meus Dados\"");
    expect(scan.complete).toBe(true);
  });

  it("devolve as tabelas que o dump cria e as linhas de cada COPY (sem contar o que está em corpo de função ou em dados)", async () => {
    const scan = await filterPostgresDump(await file("in.sql", dump), path.join(dir, "out.sql"));
    expect(scan.tables).toEqual(['public."Meus Dados"', "app.log"]);
    expect([...scan.copyRows]).toEqual([
      ['public."Meus Dados"', 3],
      ["app.log", 0],
      ["public.t", 2],
    ]);
  });

  it("dump cortado: complete é falso", async () => {
    const scan = await filterPostgresDump(await file("in.sql", dump.replace("-- PostgreSQL database dump complete\n", "")), path.join(dir, "out.sql"));
    expect(scan.complete).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Filtro do dump do MySQL/MariaDB
// ---------------------------------------------------------------------------

describe("filterMysqlDump", () => {
  const dump = [
    "/*!40101 SET NAMES utf8mb4 */;",
    "--",
    "-- Current Database: `loja`",
    "--",
    "/*!40000 DROP DATABASE IF EXISTS `loja`*/;",
    "CREATE DATABASE /*!32312 IF NOT EXISTS*/ `loja` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;",
    "USE `loja`;",
    "CREATE TABLE `pedidos` (",
    "  `id` int",
    ");",
    "INSERT INTO `pedidos` VALUES (1),(2);",
    "CREATE TABLE `vazia` (`i` int);",
    "/*!50001 CREATE VIEW `v` AS SELECT 1 AS `id` */;",
    "/*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER t BEFORE INSERT ON pedidos FOR EACH ROW SET NEW.id = 1 */;",
    "--",
    "-- Current Database: `extra`",
    "--",
    "/*!40000 DROP DATABASE IF EXISTS `extra`*/;",
    "CREATE DATABASE /*!32312 IF NOT EXISTS*/ `extra` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;",
    "USE `extra`;",
    "CREATE TABLE `t` (`i` int);",
    "INSERT INTO `t` VALUES (1);",
    "--",
    "-- Current Database: `loja`",
    "--",
    "USE `loja`;",
    "/*!50013 DEFINER=`root`@`localhost` SQL SECURITY DEFINER */",
    "-- Dump completed on 2026-10-22 10:00:00",
    "",
  ].join("\n");

  it("só o banco do projeto, com o nome trocado por um descartável, sem DROP DATABASE nem DEFINER", async () => {
    const out = path.join(dir, "out.sql");
    const scan = await filterMysqlDump(await file("in.sql", dump), out, "abcd1234", "loja");
    const text = await readFile(out, "utf8");
    expect(scan.dbs).toEqual([{ original: "loja", temp: "tws_rc_abcd1234_0", tables: ["pedidos", "vazia", "v"], withData: ["pedidos"] }]);
    expect(text).toContain("CREATE DATABASE /*!32312 IF NOT EXISTS*/ `tws_rc_abcd1234_0`");
    expect(text).toContain("USE `tws_rc_abcd1234_0`;");
    expect(text).not.toMatch(/DROP DATABASE|DEFINER=|extra|`loja`/);
    expect(scan.complete).toBe(true);
  });

  it("sem saber o banco do projeto: todos os do dump, cada um num descartável; o banco que volta (views) usa o mesmo", async () => {
    const out = path.join(dir, "out.sql");
    const scan = await filterMysqlDump(await file("in.sql", dump), out, "abcd1234", null);
    expect(scan.dbs.map((d) => [d.original, d.temp])).toEqual([
      ["loja", "tws_rc_abcd1234_0"],
      ["extra", "tws_rc_abcd1234_1"],
    ]);
    const text = await readFile(out, "utf8");
    expect(text).not.toContain("`extra`");
    expect(text.match(/USE `tws_rc_abcd1234_0`/g)).toHaveLength(2);
  });

  it("dump cortado (sem 'Dump completed'): complete é falso", async () => {
    const scan = await filterMysqlDump(await file("in.sql", dump.replace("-- Dump completed on 2026-10-22 10:00:00\n", "")), path.join(dir, "o.sql"), "abcd1234", "loja");
    expect(scan.complete).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Orquestração com Docker de mentira
// ---------------------------------------------------------------------------

class FakeDb implements Partial<BackupDocker> {
  calls: string[] = [];
  restoreArgs: string[][] = [];
  restoreTimeout: number | undefined;
  restoreText = "";
  verifySql = "";
  restoreError: Error | null = null;
  restoreStderr = "";
  prepareError: Error | null = null;
  verifyError: Error | null = null;
  verifyOut: ((sql: string) => string) | null = null;
  cleanup: string | Error = "GONE\n";
  cleanupArgs: string[][] = [];
  prepareArgs: string[][] = [];
  mongoVerify = "D|tws_rc_x_loja|2|3\n";

  async execCapture(_c: string, script: string, args: string[]): Promise<string> {
    const step = /# tws-rc:(\w+):(\w+)/.exec(script)!;
    this.calls.push(`${step[1]}:${step[2]}`);
    if (step[2] === "prepare") {
      this.prepareArgs.push(args);
      if (this.prepareError) throw this.prepareError;
      return "";
    }
    if (step[2] === "cleanup") {
      this.cleanupArgs.push(args);
      if (this.cleanup instanceof Error) throw this.cleanup;
      // o MongoDB varre os restos com o mesmo script (prefixo curto) antes de restaurar
      return this.cleanup;
    }
    if (step[2] === "verify") {
      if (this.verifyError) throw this.verifyError;
      return this.mongoVerify;
    }
    return "";
  }

  async execFromFile(_c: string, script: string, args: string[], inFile: string, opts?: { timeoutMs?: number }) {
    const step = /# tws-rc:(\w+):(\w+)/.exec(script)!;
    this.calls.push(`${step[1]}:${step[2]}`);
    const text = await readFile(inFile, "utf8").catch(() => "");
    if (step[2] === "verify") {
      this.verifySql = text;
      if (this.verifyError) throw this.verifyError;
      return { stderr: "", stdout: this.verifyOut ? this.verifyOut(text) : defaultVerify(step[1]!, text) };
    }
    this.restoreArgs.push(args);
    this.restoreTimeout = opts?.timeoutMs;
    this.restoreText = text;
    if (this.restoreError) throw this.restoreError;
    return { stderr: this.restoreStderr, stdout: "" };
  }
}

/** A resposta de um banco em que tudo bate. */
function defaultVerify(engine: string, sql: string): string {
  if (engine === "postgres") {
    return sql
      .split("\n")
      .map((l) => {
        const e = /^select 'E', (\d+),/.exec(l);
        if (e) return `E|${e[1]}|t`;
        const r = /^select 'R', (\d+), count/.exec(l);
        if (r) return `R|${r[1]}|2`;
        if (l.startsWith("select 'T'")) return "T|9";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return sql
    .split("\n")
    .map((l) => /^select '([ER])', (\d+),/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => `${m[1]}\t${m[2]}\t1`)
    .join("\n");
}

const PG_DUMP = ["CREATE TABLE public.a (id int);", "COPY public.a (id) FROM stdin;", "1", "2", "\\.", "-- PostgreSQL database dump complete", ""].join("\n");
const MY_DUMP = [
  "-- Current Database: `loja`",
  "CREATE DATABASE `loja`;",
  "USE `loja`;",
  "CREATE TABLE `a` (`i` int);",
  "INSERT INTO `a` VALUES (1);",
  "CREATE TABLE `b` (`i` int);",
  "-- Dump completed on 2026-10-22",
  "",
].join("\n");

async function input(db: FakeDb, engine: ValidateInput["engine"], text: string, over: Partial<ValidateInput> = {}): Promise<ValidateInput> {
  return { docker: db as unknown as BackupDocker, container: "c", engine, content: dir, workDir: dir, file: await file("dump", text), databaseName: "loja", id: "0a1b2c3d", timeoutMs: 5000, ...over };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (err) {
    expect(err).toBeInstanceOf(RestoreValidationError);
    return (err as RestoreValidationError).code;
  }
}

describe("validateRestore: Postgres", () => {
  it("prepara, restaura com o prazo (em segundos no container e com folga no cliente), confere e limpa", async () => {
    const db = new FakeDb();
    expect(await validateRestore(await input(db, "postgres", PG_DUMP))).toEqual({ tables: 1, rows: 2 });
    expect(db.calls).toEqual(["postgres:prepare", "postgres:restore", "postgres:verify", "postgres:cleanup"]);
    expect(db.restoreArgs).toEqual([["tws_rc_0a1b2c3d", "5"]]);
    expect(db.restoreTimeout).toBe(35_000);
    expect(db.cleanupArgs).toEqual([["tws_rc_0a1b2c3d"]]);
  });

  it("restauração com erro, prazo, falha ao preparar, conferência que não roda: códigos; sempre limpa", async () => {
    for (const [setup, expected] of [
      [(d: FakeDb) => (d.restoreError = new Error("psql: ERROR: valor DADO-SECRETO")), "restore_failed"],
      [(d: FakeDb) => (d.restoreError = new Error("o comando passou do prazo e foi interrompido")), "timeout"],
      [(d: FakeDb) => (d.restoreError = new Error("docker saiu com código 137")), "timeout"],
      [(d: FakeDb) => (d.prepareError = new Error("sem permissão")), "restore_failed"],
      [(d: FakeDb) => (d.verifyError = new Error("x")), "sanity_failed"],
    ] as const) {
      const db = new FakeDb();
      setup(db);
      expect(await code(validateRestore(await input(db, "postgres", PG_DUMP)))).toBe(expected);
      expect(db.cleanupArgs).toHaveLength(1);
    }
  });

  it("conferência que não bate (tabela ausente, linhas a mais ou a menos, poucas tabelas, sem total): sanity_failed", async () => {
    for (const edit of [
      (o: string) => o.replace("E|0|t", "E|0|f"),
      (o: string) => o.replace("R|0|2", "R|0|3"),
      (o: string) => o.replace("T|9", "T|0"),
      (o: string) => o.replace("T|9", ""),
    ]) {
      const db = new FakeDb();
      db.verifyOut = (sql) => edit(defaultVerify("postgres", sql));
      expect(await code(validateRestore(await input(db, "postgres", PG_DUMP)))).toBe("sanity_failed");
    }
  });

  it("dump lixo ou cortado: nem toca no servidor; arquivo ilegível: backup_unreadable", async () => {
    const db = new FakeDb();
    expect(await code(validateRestore(await input(db, "postgres", "lixo")))).toBe("sanity_failed");
    expect(await code(validateRestore(await input(db, "postgres", PG_DUMP.replace("-- PostgreSQL database dump complete\n", ""))))).toBe("sanity_failed");
    expect(await code(validateRestore({ ...(await input(db, "postgres", PG_DUMP)), file: path.join(dir, "nao-existe") }))).toBe("backup_unreadable");
    expect(db.calls).toEqual([]);
  });

  it("não conseguir apagar o banco temporário vira cleanup_failed (mesmo se a restauração deu certo, ou falhou antes)", async () => {
    for (const answer of ["LEFT\n", new Error("x")]) {
      const db = new FakeDb();
      db.cleanup = answer;
      expect(await code(validateRestore(await input(db, "postgres", PG_DUMP)))).toBe("cleanup_failed");
      const db2 = new FakeDb();
      db2.cleanup = answer;
      db2.restoreError = new Error("x");
      expect(await code(validateRestore(await input(db2, "postgres", PG_DUMP)))).toBe("cleanup_failed");
    }
  });

  it("identificador inválido, motor sem restauração (Redis): recusa sem tocar em nada", async () => {
    const db = new FakeDb();
    expect(await code(validateRestore({ ...(await input(db, "postgres", PG_DUMP)), id: "x'; drop" }))).toBe("restore_failed");
    expect(await code(validateRestore(await input(db, "redis", PG_DUMP)))).toBe("restore_failed");
    expect(db.calls).toEqual([]);
    expect(restoreCheckScripts("redis")).toBeNull();
  });
});

describe("validateRestore: MySQL e MariaDB", () => {
  it("restaura só o banco do projeto, confere cada tabela e as que têm dados, e limpa pelo id do teste", async () => {
    for (const engine of ["mysql", "mariadb"] as const) {
      const db = new FakeDb();
      expect(await validateRestore(await input(db, engine, MY_DUMP))).toEqual({ tables: 2, rows: 1 });
      expect(db.calls).toEqual(["mysql:prepare", "mysql:restore", "mysql:verify", "mysql:cleanup"]);
      expect(db.restoreArgs).toEqual([["0a1b2c3d", "5"]]);
      expect(db.restoreText).toContain("USE `tws_rc_0a1b2c3d_0`;");
      expect(db.restoreText).not.toContain("`loja`");
      expect(db.verifySql).toContain("table_schema = 'tws_rc_0a1b2c3d_0' and table_name = 'a'");
      expect(db.verifySql).toContain("exists(select 1 from `tws_rc_0a1b2c3d_0`.`a`)");
      expect(db.cleanupArgs).toEqual([["0a1b2c3d"]]);
    }
  });

  it("erro, prazo, preparo, conferência: códigos; tabela ou dados ausentes: sanity_failed", async () => {
    for (const [setup, expected] of [
      [(d: FakeDb) => (d.restoreError = new Error("ERROR 1064")), "restore_failed"],
      [(d: FakeDb) => (d.restoreError = new Error("o comando passou do prazo e foi interrompido")), "timeout"],
      [(d: FakeDb) => (d.prepareError = new Error("x")), "restore_failed"],
      [(d: FakeDb) => (d.verifyError = new Error("x")), "sanity_failed"],
      [(d: FakeDb) => (d.verifyOut = (sql) => defaultVerify("mysql", sql).replace("E\t0\t1", "E\t0\t0")), "sanity_failed"],
      [(d: FakeDb) => (d.verifyOut = (sql) => defaultVerify("mysql", sql).replace("R\t2\t1", "R\t2\t0")), "sanity_failed"],
    ] as const) {
      const db = new FakeDb();
      setup(db);
      expect(await code(validateRestore(await input(db, "mariadb", MY_DUMP)))).toBe(expected);
      expect(db.cleanupArgs).toHaveLength(1);
    }
  });

  it("dump cortado, sem tabelas, ou sem o banco do projeto: nem toca no servidor", async () => {
    const db = new FakeDb();
    expect(await code(validateRestore(await input(db, "mysql", MY_DUMP.replace("-- Dump completed on 2026-10-22\n", ""))))).toBe("sanity_failed");
    expect(await code(validateRestore(await input(db, "mysql", MY_DUMP, { databaseName: "outro" })))).toBe("sanity_failed");
    expect(await code(validateRestore({ ...(await input(db, "mysql", MY_DUMP)), file: path.join(dir, "nao-existe") }))).toBe("backup_unreadable");
    expect(db.calls).toEqual([]);
  });
});

describe("validateRestore: MongoDB", () => {
  const stderr = "2024 done\n3 document(s) restored successfully. 0 document(s) failed to restore.\n";

  it("varre restos, restaura (prazo, banco do projeto opcional), confere coleções e documentos e limpa", async () => {
    const db = new FakeDb();
    db.restoreStderr = stderr;
    expect(await validateRestore(await input(db, "mongo", "archive", { databaseName: null }))).toEqual({ tables: 2, rows: 3 });
    expect(db.calls).toEqual(["mongo:cleanup", "mongo:restore", "mongo:verify", "mongo:cleanup"]);
    expect(db.cleanupArgs).toEqual([["tws_rc_"], ["tws_rc_0a1b2c3d_"]]);
    expect(db.restoreArgs).toEqual([["0a1b2c3d", "5", ""]]);
    const withName = new FakeDb();
    withName.restoreStderr = stderr;
    await validateRestore(await input(withName, "mongo", "archive"));
    expect(withName.restoreArgs).toEqual([["0a1b2c3d", "5", "loja"]]);
  });

  it("o script de restauração exclui admin/config/local, renomeia para o descartável e nunca usa --drop nem a senha na linha de comando", () => {
    const script = (restoreCheckScripts("mongo") as { restore: string }).restore;
    expect(script).toContain("--nsExclude 'admin.*' --nsExclude 'config.*' --nsExclude 'local.*'");
    expect(script).toContain("--nsFrom '$db$.$coll$'");
    expect(script).toContain('"tws_rc_${RC_ID}_\\$db\\$.\\$coll\\$"');
    expect(script).toContain('--nsInclude "$RC_DB.*"');
    expect(script).not.toContain("--drop");
    expect(script).not.toMatch(/--password "\$MP"[^\n]*mongorestore/);
  });

  it("erro, prazo, preparo: códigos; conferência que não bate, sem coleções ou sem o resumo do mongorestore: sanity_failed", async () => {
    for (const [setup, expected] of [
      [(d: FakeDb) => (d.restoreError = new Error("falhou")), "restore_failed"],
      [(d: FakeDb) => (d.restoreError = new Error("o comando passou do prazo e foi interrompido")), "timeout"],
      [(d: FakeDb) => (d.verifyError = new Error("x")), "sanity_failed"],
      [(d: FakeDb) => (d.mongoVerify = "D|tws_rc_x_loja|2|4\n"), "sanity_failed"],
      [(d: FakeDb) => (d.mongoVerify = ""), "sanity_failed"],
      [(d: FakeDb) => (d.restoreStderr = "sem resumo"), "sanity_failed"],
    ] as const) {
      const db = new FakeDb();
      db.restoreStderr = stderr;
      setup(db);
      expect(await code(validateRestore(await input(db, "mongo", "archive")))).toBe(expected);
      expect(db.cleanupArgs.at(-1)).toEqual(["tws_rc_0a1b2c3d_"]);
    }
  });

  it("não conseguir varrer os restos antes: falha sem restaurar (e, sem poder limpar, avisa para apagar à mão)", async () => {
    const db = new FakeDb();
    db.cleanup = new Error("x");
    expect(await code(validateRestore(await input(db, "mongo", "archive")))).toBe("cleanup_failed");
    expect(db.calls.filter((c) => c === "mongo:restore")).toEqual([]);
  });
});

describe("scripts que rodam no container", () => {
  it("cada passo se identifica e termina com GONE/LEFT na limpeza", () => {
    for (const engine of ["postgres", "mysql", "mongo"] as const) {
      const scripts = restoreCheckScripts(engine) as Record<string, string>;
      for (const [step, text] of Object.entries(scripts)) expect(text.startsWith(`# tws-rc:${engine}:${step}`)).toBe(true);
      expect(scripts.cleanup).toMatch(/GONE/);
      expect(scripts.cleanup).toMatch(/LEFT/);
    }
  });

  it("o prazo vale dentro do container: timeout -s KILL, e o Postgres identifica a sessão e a derruba antes de apagar o banco", () => {
    const pg = restoreCheckScripts("postgres") as Record<string, string>;
    expect(pg.restore).toContain('timeout -s KILL $RC_SECS');
    expect(pg.restore).toContain("PGAPPNAME=tws-restore-check");
    expect(pg.restore).toContain("ON_ERROR_STOP=1");
    expect(pg.cleanup).toContain("pg_terminate_backend");
    expect(pg.cleanup).toContain("drop database if exists");
    const my = restoreCheckScripts("mariadb") as Record<string, string>;
    expect(my.restore).toContain("timeout -s KILL");
    expect(my.cleanup).toContain("kill $pid");
    // sem senha na linha de comando
    for (const s of [...Object.values(pg), ...Object.values(my)]) expect(s).not.toMatch(/-p"?\$|--password/);
  });
});
