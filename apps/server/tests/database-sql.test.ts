import { describe, expect, it } from "vitest";
import type { DatabaseTable } from "@paas/core";
import {
  MY_OBJECTS_SQL,
  DB_SECONDS,
  KILL_SCRIPT,
  PG_LIMITS,
  PG_NULL_TOKEN,
  PG_RESET_SQL,
  classifyDbError,
  isPrepareUnsupported,
  nullsFromPgCsv,
  parseXmlRows,
  allMyNames,
  cancelScript,
  isTag,
  myScript,
  pgLimits,
  sessionTag,
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
  quoteMy,
  quotePg,
  readSql,
  scriptFor,
  tableKey,
  toSqlResult,
  writeSql,
} from "../src/services/database-sql.js";

const t = (schema: string | null, name: string): DatabaseTable => ({ schema, name, rows: null, sizeBytes: null });

describe("nomes e aspas", () => {
  it("aceita nomes comuns e recusa controle, vazio e gigante", () => {
    expect(isSafeName("users")).toBe(true);
    expect(isSafeName("tabela com espaço")).toBe(true);
    expect(isSafeName("")).toBe(false);
    expect(isSafeName("a\nb")).toBe(false);
    expect(isSafeName("a\u0000b")).toBe(false);
    expect(isSafeName("x".repeat(256))).toBe(false);
  });

  it("nome do banco não pode começar com hífen (viraria opção do cliente)", () => {
    expect(isSafeDatabaseName("app")).toBe(true);
    expect(isSafeDatabaseName("-h")).toBe(false);
    expect(isSafeDatabaseName("a\nb")).toBe(false);
  });

  it("cita dobrando a aspa do próprio banco", () => {
    expect(quotePg('a"b')).toBe('"a""b"');
    expect(quoteMy("a`b")).toBe("`a``b`");
  });
});

describe("matchTables", () => {
  const pgTables = [t("public", "users"), t("public", "posts"), t("audit", "log")];
  it("PostgreSQL: esquema padrão public, sem repetir", () => {
    const r = matchTables("postgres", pgTables, [{ name: "users" }, { schema: "public", name: "users" }, { schema: "audit", name: "log" }]);
    expect(r).toEqual({ ok: true, tables: [pgTables[0], pgTables[2]] });
  });

  it("recusa o que não existe, inclusive no esquema errado", () => {
    expect(matchTables("postgres", pgTables, [{ name: "log" }])).toEqual({ ok: false, name: "log" });
    expect(matchTables("postgres", pgTables, [{ name: "users; drop table users" }])).toMatchObject({ ok: false });
  });

  it("MySQL ignora o esquema do pedido", () => {
    const my = [t(null, "users")];
    expect(matchTables("mysql", my, [{ schema: "x", name: "users" }])).toEqual({ ok: true, tables: my });
    expect(matchTables("mariadb", my, [{ name: "nada" }])).toEqual({ ok: false, name: "nada" });
  });

  it("tableKey separa esquema e nome", () => {
    expect(tableKey({ schema: "a", name: "b" })).not.toBe(tableKey({ schema: "ab", name: "" }));
    expect(tableKey({ schema: null, name: "b" })).toBe("\u0000b");
  });
});

describe("prazos do servidor", () => {
  it("esvaziar e zerar no PostgreSQL levam lock_timeout e statement_timeout", () => {
    expect(PG_LIMITS).toBe("SET lock_timeout = '15s';\nSET statement_timeout = '540s';\n");
    expect(pgTruncateSql([t("public", "u")], false).startsWith(PG_LIMITS)).toBe(true);
    expect(PG_RESET_SQL.startsWith(PG_LIMITS)).toBe(true);
  });

  it("zerar: funções ligadas a um tipo (faixas, deptype 'i') ou a extensão não são apagadas à parte", () => {
    expect(PG_RESET_SQL).toContain("d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype IN ('e', 'i')");
    // o tipo de faixa é apagado por DROP TYPE ... CASCADE, que leva as funções construtoras junto
    expect(PG_RESET_SQL).toContain("t.typtype IN ('e', 'd', 'r')");
  });
});

describe("variante MariaDB x MySQL, pelo motor detectado", () => {
  it("MariaDB usa max_statement_time (s, todos os comandos); MySQL usa max_execution_time (ms, só SELECT)", () => {
    const maria = scriptFor("mariadb", "exec", 120);
    expect(maria).toContain("max_statement_time=120");
    expect(maria).not.toContain("max_execution_time");
    const mysql = scriptFor("mysql", "exec", 120);
    expect(mysql).toContain("max_execution_time=120000");
    expect(mysql).not.toContain("max_statement_time");
    // sem decidir pelo nome do binário do cliente
    expect(maria).not.toContain('case "$CLI"');
    expect(myScript("", 5, "mariadb")).toContain("max_statement_time=5");
    expect(myScript("", 5)).toContain("max_execution_time=5000");
  });
});

describe("prazo do banco x prazo do painel", () => {
  it("escrita no PostgreSQL tem o próprio limite (120 s), não o de esvaziar/zerar (540 s)", () => {
    expect(DB_SECONDS).toEqual({ read: 15, write: 120, action: 540 });
    expect(writeSql("postgres", "update t set a = 1")).toContain("SET statement_timeout = '120s';");
    expect(writeSql("postgres", "update t set a = 1")).not.toContain("540s");
    expect(pgLimits(7)).toBe("SET lock_timeout = '15s';\nSET statement_timeout = '7s';\n");
    expect(pgTruncateSql([t("public", "u")], false)).toContain("statement_timeout = '540s'");
  });
});

describe("marca da sessão e parada no servidor", () => {
  const TAG = "0123456789abcdef";

  it("a marca é hexadecimal e nunca texto livre", () => {
    expect(isTag(TAG)).toBe(true);
    for (const bad of ["", "xyz", "0123456789abcdeg", "1'; drop", "a".repeat(33), "abc"]) {
      expect(isTag(bad)).toBe(false);
      expect(() => sessionTag("postgres", bad)).toThrow();
      expect(() => cancelScript("mysql", bad)).toThrow();
    }
  });

  it("PostgreSQL: application_name; MySQL/MariaDB: GET_LOCK nomeado (DO não imprime nada)", () => {
    expect(sessionTag("postgres", TAG)).toBe(`SET application_name = 'tws-db-${TAG}';\n`);
    expect(sessionTag("mysql", TAG)).toBe(`DO GET_LOCK('tws-db-${TAG}', 0);\n`);
    expect(sessionTag("mariadb", TAG)).toBe(sessionTag("mysql", TAG));
  });

  it("PostgreSQL: cancela e depois encerra os backends com a marca, sem tocar na própria conexão, e conta o que sobrou", () => {
    const s = cancelScript("postgres", TAG);
    expect(s).toContain("POSTGRES_PASSWORD");
    const cancel = s.indexOf("pg_cancel_backend(pid)");
    const terminate = s.indexOf("pg_terminate_backend(pid)");
    const count = s.indexOf("select count(*) from pg_stat_activity");
    expect(cancel).toBeGreaterThan(-1);
    expect(terminate).toBeGreaterThan(cancel);
    expect(count).toBeGreaterThan(terminate);
    expect(s).toContain(`application_name = 'tws-db-${TAG}' and pid <> pg_backend_pid()`);
  });

  it("MySQL/MariaDB: acha a conexão pelo lock, dá KILL QUERY e confere se ela ainda executa algo", () => {
    for (const engine of ["mysql", "mariadb"] as const) {
      const s = cancelScript(engine, TAG);
      expect(s).toContain("MYSQL_PWD");
      expect(s).toContain(`is_used_lock('tws-db-${TAG}')`);
      expect(s).toContain('kill query $ID');
      expect(s).toContain("from information_schema.processlist where id = $ID and command <> 'Sleep'");
      // id que não é número nunca vira comando
      expect(s).toContain("*[!0-9]*) echo 1; exit 0;;");
      // sem conexão com o lock: nada rodando
      expect(s).toContain('""|NULL) echo 0; exit 0;;');
    }
  });

  it("o script de parada confere o /proc/<pid>/cmdline antes de matar e apaga o arquivo do pid", () => {
    expect(KILL_SCRIPT).toContain('tr "\\000" " " < "/proc/$p/cmdline" | grep -Eq "$2"');
    expect(KILL_SCRIPT.indexOf("grep -Eq")).toBeLessThan(KILL_SCRIPT.indexOf("kill -KILL"));
    expect(KILL_SCRIPT).toContain('rm -f "$f"');
    // pid que não é número: não mata nada
    expect(KILL_SCRIPT).toContain('case "$p" in ""|*[!0-9]*) rm -f "$f"; exit 1;; esac');
  });
});

describe("scripts", () => {
  it("PostgreSQL lê a credencial do ambiente do container e não leva SQL nem senha na linha de comando", () => {
    for (const fmt of ["scalar", "table", "exec"] as const) {
      const s = scriptFor("postgres", fmt);
      expect(s).toContain("POSTGRES_PASSWORD");
      expect(s).toContain('exec psql -U "$U" -d "$1"');
      const line = s.split("\n").find((l) => l.startsWith("exec psql"))!;
      expect(line).not.toMatch(/ -c | -W|--password|PGPASSWORD/);
    }
    expect(scriptFor("postgres", "scalar")).toContain("-At");
    expect(scriptFor("postgres", "table")).toContain("--csv");
    // NULL marcado com um texto que não aparece em dados reais
    expect(scriptFor("postgres", "table")).toContain("TWS_NULL");
    expect(scriptFor("postgres", "table")).toContain('-P "null=$NT"');
    expect(scriptFor("postgres", "scalar")).not.toContain("TWS_NULL");
  });

  it("MySQL/MariaDB: prazos do servidor na sessão (variante pelo cliente) e saída XML nas consultas", () => {
    const s = scriptFor("mysql", "table", 15);
    expect(s).toContain("--xml");
    expect(s).toContain('--init-command="SET SESSION lock_wait_timeout=15, max_execution_time=15000"');
    expect(s).not.toContain("max_statement_time");
    // sem prazo (visão geral): nada de init-command
    expect(scriptFor("mysql", "scalar")).not.toContain("init-command");
  });

  it("MySQL/MariaDB usa MYSQL_PWD do ambiente e nunca -p", () => {
    for (const fmt of ["scalar", "table", "exec"] as const) {
      const s = scriptFor("mysql", fmt);
      expect(s).toContain("MYSQL_PWD");
      expect(s).toContain('-D "$1"');
      expect(s).not.toMatch(/ -p\S/);
    }
    expect(scriptFor("mariadb", "scalar")).toContain("-N -B");
  });
});

describe("SQL gerado", () => {
  it("overview do PostgreSQL é somente leitura", () => {
    expect(readSql("postgres", "select 1")).toContain("BEGIN READ ONLY");
  });

  it("leitura PostgreSQL: transação somente leitura, prazo, e o ; em linha própria", () => {
    const sql = readSql("postgres", "select 1 -- x");
    expect(sql).toContain("BEGIN READ ONLY;");
    expect(sql).toContain("SET LOCAL statement_timeout = '15s'");
    expect(sql).toContain("standard_conforming_strings = on");
    expect(sql).toContain("select 1 -- x\n;\nROLLBACK;");
  });

  it("leitura MySQL/MariaDB: o texto vai em hexadecimal para um PREPARE, em transação somente leitura", () => {
    const my = readSql("mysql", "select 'a\\'; delete from users; select '");
    expect(my).toContain("SET SESSION TRANSACTION READ ONLY;");
    expect(my).toContain("START TRANSACTION READ ONLY;");
    expect(my).toContain("SET SESSION sql_mode = '';");
    expect(my).toContain("SET NAMES utf8mb4;");
    expect(my).toContain("PREPARE tws_s FROM @tws_q;\nEXECUTE tws_s;\nDEALLOCATE PREPARE tws_s;\nROLLBACK;");
    // nada do texto do usuário aparece em claro: o separador do cliente não tem o que separar
    expect(my).not.toContain("delete");
    expect(my).toContain(Buffer.from("select 'a\\'; delete from users; select '", "utf8").toString("hex"));
    expect(readSql("mariadb", "select 1")).toBe(readSql("mysql", "select 1"));
  });

  it("erro 1295 do PREPARE é reconhecido", () => {
    expect(isPrepareUnsupported("ERROR 1295 (HY000) at line 6: This command is not supported in the prepared statement protocol yet")).toBe(true);
    expect(isPrepareUnsupported("ERROR 1064 (42000): syntax error")).toBe(false);
  });

  it("erros do banco: prazo, bloqueios e o resto", () => {
    expect(classifyDbError("ERROR: canceling statement due to statement timeout")).toBe("db_timeout");
    expect(classifyDbError("ERROR: canceling statement due to lock timeout")).toBe("db_timeout");
    expect(classifyDbError("ERROR 1205 (HY000): Lock wait timeout exceeded")).toBe("db_timeout");
    expect(classifyDbError("ERROR 1969 (70100): Query execution was interrupted (max_statement_time exceeded)")).toBe("db_timeout");
    expect(classifyDbError("ERROR 3024 (HY000): Query execution was interrupted, maximum statement execution time exceeded")).toBe("db_timeout");
    expect(classifyDbError("ERROR: out of shared memory\nHINT: increase max_locks_per_transaction.")).toBe("too_many_locks");
    expect(classifyDbError("ERROR: syntax error")).toBeNull();
  });

  it("escrita roda como está, com ; em linha própria", () => {
    expect(writeSql("postgres", "update t set a = 1")).toContain("update t set a = 1\n;\n");
    expect(writeSql("postgres", "x")).toContain("statement_timeout");
    expect(writeSql("postgres", "x")).toContain("lock_timeout");
    expect(writeSql("mysql", "update t set a = 1")).toBe("update t set a = 1\n;\n");
  });

  it("esvaziar no PostgreSQL: RESTART IDENTITY, CASCADE só se pedido, nomes citados", () => {
    const tables = [t("public", "users"), t("audit", 'we"ird')];
    const plain = pgTruncateSql(tables, false);
    expect(plain).toContain('TRUNCATE TABLE "public"."users", "audit"."we""ird" RESTART IDENTITY;');
    expect(plain).not.toContain("CASCADE");
    expect(pgTruncateSql(tables, true)).toContain("RESTART IDENTITY CASCADE;");
    expect(pgTruncateSql([t(null, "x")], false)).toContain('"public"."x"');
  });

  it("esvaziar no MySQL: sem checagem de chave estrangeira na sessão e de volta no fim", () => {
    const sql = myTruncateSql([t(null, "users"), t(null, "a`b")]);
    expect(sql.split("\n")).toEqual(["SET FOREIGN_KEY_CHECKS = 0;", "TRUNCATE TABLE `users`;", "TRUNCATE TABLE `a``b`;", "SET FOREIGN_KEY_CHECKS = 1;", ""]);
  });

  it("zerar o PostgreSQL mantém esquemas, dono e extensões (não usa DROP SCHEMA)", () => {
    expect(PG_RESET_SQL).not.toMatch(/DROP SCHEMA/i);
    expect(PG_RESET_SQL).toContain("deptype IN ('e', 'a', 'i')");
    expect(PG_RESET_SQL).toContain("deptype = 'e'");
    expect(PG_RESET_SQL).toContain("DO $tws_reset$");
  });

  it("zerar o MySQL: visões, tabelas, sequências, rotinas e eventos", () => {
    expect(MY_OBJECTS_SQL).toContain("information_schema.events");
    const objects = parseMyObjects(
      ["T\tusers\tBASE TABLE", "T\tv_users\tVIEW", "T\tseq\tSEQUENCE", "T\thist\tSYSTEM VERSIONED", "R\tPROCEDURE\tp1", "R\tFUNCTION\tf1", "E\tev1", "X\tzzz", ""].join("\n"),
    );
    expect(objects).toEqual({
      tables: ["users", "hist"],
      views: ["v_users"],
      sequences: ["seq"],
      routines: [
        { type: "PROCEDURE", name: "p1" },
        { type: "FUNCTION", name: "f1" },
      ],
      events: ["ev1"],
    });
    expect(allMyNames(objects)).toEqual(["users", "hist", "v_users", "seq", "p1", "f1", "ev1"]);
    const sql = myResetSql(objects);
    expect(sql).toContain("DROP VIEW IF EXISTS `v_users`;");
    expect(sql).toContain("DROP TABLE IF EXISTS `users`, `hist`;");
    expect(sql).toContain("DROP SEQUENCE IF EXISTS `seq`;");
    expect(sql).toContain("DROP PROCEDURE IF EXISTS `p1`;");
    expect(sql).toContain("DROP FUNCTION IF EXISTS `f1`;");
    expect(sql).toContain("DROP EVENT IF EXISTS `ev1`;");
    expect(sql.startsWith("SET FOREIGN_KEY_CHECKS = 0;")).toBe(true);
    // banco vazio: só liga e desliga a checagem
    expect(myResetSql(parseMyObjects(""))).toBe("SET FOREIGN_KEY_CHECKS = 0;\nSET FOREIGN_KEY_CHECKS = 1;\n");
  });
});

describe("leitura da visão geral", () => {
  it("PostgreSQL: JSON com tabelas, estimativa ausente e valores inválidos", () => {
    const out = JSON.stringify({
      version: "16.2",
      database: "app",
      sizeBytes: 8_000_000,
      tables: [
        { schema: "public", name: "users", rows: 10, sizeBytes: 16384 },
        { schema: null, name: "x", rows: null, sizeBytes: "oops" },
      ],
    });
    expect(parsePgOverview(`${out}\n`)).toEqual({
      version: "16.2",
      database: "app",
      sizeBytes: 8_000_000,
      tables: [
        { schema: "public", name: "users", rows: 10, sizeBytes: 16384 },
        { schema: null, name: "x", rows: null, sizeBytes: null },
      ],
    });
    expect(parsePgOverview(JSON.stringify({ version: 1, database: 2, sizeBytes: -5, tables: "x" }))).toEqual({ version: null, database: null, sizeBytes: null, tables: [] });
    expect(parsePgOverview("não é json")).toBeNull();
  });

  it("MySQL: linhas marcadas por V, D, T e S", () => {
    const out = ["V\t8.0.36", "D\tapp", "T\tusers\t120\t65536", "T\tempty\t\t", "S\t131072", "ruído", ""].join("\n");
    expect(parseMyOverview(out)).toEqual({
      version: "8.0.36",
      database: "app",
      sizeBytes: 131072,
      tables: [
        { schema: null, name: "users", rows: 120, sizeBytes: 65536 },
        { schema: null, name: "empty", rows: null, sizeBytes: null },
      ],
    });
    expect(parseMyOverview("")).toBeNull();
    expect(parseMyOverview("T")).toBeNull();
  });
});

describe("leitura do resultado", () => {
  it("TSV do mysql -B: escapes, NULL e linhas vazias", () => {
    expect(parseTsv("a\tb\nx\\ty\tNULL\n\n1\\\\2\t\\n\n")).toEqual([
      ["a", "b"],
      ["x\ty", null],
      ["1\\2", "\n"],
    ]);
    expect(parseTsv("NULL", false)).toEqual([["NULL"]]);
  });

  it("CSV do psql: aspas, vírgula e quebra de linha dentro do campo, CRLF e último registro sem quebra", () => {
    expect(parseCsv('a,b\n1,"x,y"\n"l1\nl2","q""q"\r\n,\n')).toEqual([
      ["a", "b"],
      ["1", "x,y"],
      ["l1\nl2", 'q"q'],
      ["", ""],
    ]);
    expect(parseCsv("a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv('""')).toEqual([[""]]);
  });

  it("NULL do psql vem com marca própria; o texto 'NULL' continua texto", () => {
    expect(nullsFromPgCsv([["a"], [PG_NULL_TOKEN], ["NULL"]])).toEqual([["a"], [null], ["NULL"]]);
  });

  it("XML do cliente mysql: NULL, texto vazio, entidades, caracteres numéricos e linha cortada", () => {
    const xml = `<?xml version="1.0"?>
<resultset statement="select ..." xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <row>
\t<field name="id">1</field>
\t<field name="t">a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#65;&#x42; &#999999999;</field>
\t<field name="n" xsi:nil="true" />
\t<field name="v">NULL</field>
\t<field name="e"></field>
\t<field name="x" />
  </row>
  <row>
\t<field name="id">2</field>
\t<field name="t">linha
dois</field>
\t<field name="n">z</field>
\t<field name="v">&desconhecida;</field>
\t<field name="e">q</field>
\t<field name="x" nil="true"/>
  </row>
  <row>
\t<field name="id">3</field>`;
    const table = parseXmlRows(xml);
    expect(table[0]).toEqual(["id", "t", "n", "v", "e", "x"]);
    expect(table[1]).toEqual(["1", "a & b <c> \"d\" 'e' AB ", null, "NULL", "", ""]);
    expect(table[2]).toEqual(["2", "linha\ndois", "z", "&desconhecida;", "q", null]);
    expect(table).toHaveLength(3);
    expect(parseXmlRows("")).toEqual([]);
    expect(parseXmlRows('<?xml version="1.0"?>\n<resultset statement="x">\n</resultset>')).toEqual([]);
  });

  it("resultado: cabeçalho, corte nas linhas e saída cortada", () => {
    expect(toSqlResult([], 500, false)).toEqual({ columns: [], rows: [], truncated: false, empty: true });
    expect(toSqlResult([["a", "b"], ["1", null], ["2"], ["3", "z"]], 2, false)).toEqual({
      columns: ["a", "b"],
      rows: [["1", null], ["2", null]],
      truncated: true,
      empty: false,
    });
    expect(toSqlResult([["a"], ["1"]], 5, true)).toMatchObject({ truncated: true, rows: [["1"]] });
    expect(toSqlResult([[null, "b"]], 5, false)).toMatchObject({ columns: ["", "b"], rows: [] });
  });
});
