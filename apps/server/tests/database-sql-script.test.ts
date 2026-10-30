/**
 * database-sql-script.test.ts — o console com várias instruções: os scripts de leitura e de escrita (marcas, transação,
 * PREPARE por instrução no MySQL) e a leitura da saída por instrução.
 */
import { describe, expect, it } from "vitest";
import { parseMyScriptOutput, parsePgScriptOutput, readScriptSql, writeScriptSql } from "../src/services/database-sql-script.js";
import { scriptFor } from "../src/services/database-sql.js";

const TAG = "0123456789abcdef";

/** O texto do usuário vai ao psql em hexadecimal (\\gexec); aqui ele volta a texto para conferir o que será executado. */
const plain = (s: string): string => s.replace(/SELECT convert_from\(decode\('([0-9a-f]*)', 'hex'\), 'UTF8'\) \\gexec/g, (_m, h: string) => `${Buffer.from(h, "hex").toString("utf8")}\n;`);

describe("readScriptSql", () => {
  it("PostgreSQL: uma transação somente leitura, as instruções em ordem entre marcas, ROLLBACK no fim", () => {
    const raw = readScriptSql("postgres", ["select 1", "select 'a;b'"], TAG);
    const sql = plain(raw);
    const lines = sql.split("\n");
    expect(lines[0]).toBe("BEGIN READ ONLY;");
    expect(sql).toContain("SET LOCAL statement_timeout = '15s';");
    expect(sql).toContain(`\\echo '${TAG} S 1'\nselect 1\n;\n\\echo '${TAG} E 1' :ROW_COUNT`);
    expect(sql).toContain(`\\echo '${TAG} S 2'\nselect 'a;b'\n;`);
    expect(sql.match(/BEGIN/g)).toHaveLength(1);
    expect(sql.trimEnd().endsWith("ROLLBACK;")).toBe(true);
    // o psql nunca lê o texto do usuário: só hexadecimal + \\gexec
    expect(raw).not.toContain("select 1");
    expect(raw.match(/\\gexec/g)).toHaveLength(2);
  });

  it("MySQL/MariaDB: cada instrução em hexadecimal para o seu PREPARE/EXECUTE; o texto nunca aparece", () => {
    const sql = readScriptSql("mysql", ["select 'ação'", "show tables"], TAG);
    expect(sql).toContain("START TRANSACTION READ ONLY;");
    expect(sql.match(/PREPARE tws_s FROM @tws_q;/g)).toHaveLength(2);
    expect(sql.match(/DEALLOCATE PREPARE tws_s;/g)).toHaveLength(2);
    expect(sql).toContain(`X'${Buffer.from("select 'ação'").toString("hex")}'`);
    expect(sql).not.toContain("show tables");
    expect(sql).toContain(`SELECT '${TAG} S 1' AS tws_m;`);
    // ROW_COUNT logo depois do EXECUTE, antes do DEALLOCATE
    expect(sql.indexOf("EXECUTE tws_s;")).toBeLessThan(sql.indexOf(`'${TAG} E 1'`));
    expect(sql.indexOf(`'${TAG} E 1'`)).toBeLessThan(sql.indexOf("DEALLOCATE PREPARE tws_s;"));
  });

  it("recusa marca que não é hexadecimal (nunca texto do usuário)", () => {
    expect(() => readScriptSql("postgres", ["select 1"], "x'; drop")).toThrow("tag inválida");
  });
});

describe("writeScriptSql", () => {
  it("PostgreSQL com transação: limites, BEGIN, instruções, COMMIT", () => {
    const raw = writeScriptSql("postgres", ["update a set x = 1", "delete from b"], TAG, true);
    expect(raw).not.toContain("update a");
    const sql = plain(raw);
    expect(sql).toContain("SET lock_timeout = '15s';");
    expect(sql).toContain("SET statement_timeout = '120s';");
    expect(sql.indexOf("BEGIN;")).toBeGreaterThan(sql.indexOf("SET standard_conforming_strings = on;"));
    expect(sql.indexOf("update a set x = 1")).toBeGreaterThan(sql.indexOf("BEGIN;"));
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("PostgreSQL: texto com barra invertida ou $$ de sondagem nunca aparece no script (só hexadecimal)", () => {
    for (const probe of ["SELECT 1$$'$$ \\! id #'", "SELECT 1E'\\' , '\\! id'", "SELECT 1.E'\\' \\! id\n"]) {
      for (const sql of [readScriptSql("postgres", [probe], TAG), writeScriptSql("postgres", [probe], TAG, true)]) {
        expect(sql).not.toContain("\\!");
        expect(sql).not.toContain("id");
        for (const l of sql.split("\n").filter((x) => x.startsWith("\\"))) expect(l).toMatch(/^\\echo '/);
      }
    }
  });

  it("PostgreSQL sem transação: só as instruções", () => {
    const sql = writeScriptSql("postgres", ["update a set x = 1"], TAG, false);
    expect(sql).not.toMatch(/BEGIN|COMMIT/);
  });

  it("MySQL: instruções como estão, com marcas e ROW_COUNT; transação ignorada", () => {
    const sql = writeScriptSql("mariadb", ["create table t (id int)", "insert into t values (1)"], TAG, true);
    expect(sql).not.toMatch(/BEGIN|COMMIT|START TRANSACTION/);
    expect(sql).toContain(`SELECT '${TAG} S 1' AS tws_m;\ncreate table t (id int)\n;\nSELECT '${TAG} E 1' AS tws_m, ROW_COUNT() AS tws_n;`);
  });
});

describe("scriptFor com --binary-mode", () => {
  it("só nas escritas do MySQL em formato de tabela", () => {
    expect(scriptFor("mysql", "table", 120, true)).toContain("--xml --binary-mode");
    expect(scriptFor("mysql", "table", 15)).not.toContain("--binary-mode");
    expect(scriptFor("postgres", "table", 120, true)).not.toContain("--binary-mode");
  });
});

describe("parsePgScriptOutput", () => {
  const out = [
    `${TAG} S 1`,
    "id,name",
    '1,"Ana, a ""Bia"""',
    "2,\u0001TWS_NULL\u0001",
    `${TAG} E 1 2`,
    `${TAG} S 2`,
    `${TAG} E 2 5`,
    `${TAG} S 3`,
    `${TAG} E 3 :ROW_COUNT`,
    "",
  ].join("\n");

  it("separa por instrução: tabela CSV, NULL pela marca, linhas afetadas (ou nada no psql antigo)", () => {
    const [a, b, c] = parsePgScriptOutput(out, TAG, 3);
    expect(a).toMatchObject({ started: true, ended: true, affected: 2, table: [["id", "name"], ["1", 'Ana, a "Bia"'], ["2", null]] });
    expect(b).toMatchObject({ started: true, ended: true, affected: 5, table: [] });
    expect(c).toMatchObject({ ended: true, affected: null });
  });

  it("instrução aberta e não fechada (o banco recusou) e as que nem começaram", () => {
    const segs = parsePgScriptOutput(`${TAG} S 1\n${TAG} E 1 0\n${TAG} S 2\nx\n`, TAG, 3);
    expect(segs.map((s) => [s.started, s.ended])).toEqual([[true, true], [true, false], [false, false]]);
  });

  it("marcas de outra execução, de instrução fora da conta e linhas soltas são ignoradas", () => {
    const segs = parsePgScriptOutput(`solta\n${TAG} S 9\nffffffffffffffff S 1\n${TAG} S 1\nn\n1\n${TAG} E 1 1\n`, TAG, 1);
    expect(segs[0]).toMatchObject({ table: [["n"], ["1"]], affected: 1 });
  });

  it("campo com quebra de linha dentro do CSV continua inteiro", () => {
    const segs = parsePgScriptOutput(`${TAG} S 1\nt\n"a\nb"\n${TAG} E 1 1\n`, TAG, 1);
    expect(segs[0]!.table).toEqual([["t"], ["a\nb"]]);
  });
});

describe("parseMyScriptOutput", () => {
  const marker = (kind: "S" | "E", n: number, rows?: number) =>
    `<resultset statement="SELECT">\n  <row>\n\t<field name="tws_m">${TAG} ${kind} ${n}</field>${rows === undefined ? "" : `\n\t<field name="tws_n">${rows}</field>`}\n  </row>\n</resultset>\n`;
  const data = (rows: string[]) => `<resultset statement="EXECUTE tws_s">\n${rows.map((r) => `  <row>\n\t<field name="c">${r}</field>\n  </row>`).join("\n")}\n</resultset>\n`;

  it("separa por instrução, com linhas afetadas; ROW_COUNT negativo (SELECT) não conta", () => {
    const out = marker("S", 1) + data(["a", "b"]) + marker("E", 1, -1) + marker("S", 2) + marker("E", 2, 4);
    const [a, b] = parseMyScriptOutput(out, TAG, 2);
    expect(a).toMatchObject({ started: true, ended: true, affected: null, table: [["c"], ["a"], ["b"]] });
    expect(b).toMatchObject({ started: true, ended: true, affected: 4, table: [] });
  });

  it("só o primeiro conjunto de resultados da instrução fica", () => {
    const out = marker("S", 1) + data(["a"]) + data(["z"]) + marker("E", 1, 0);
    expect(parseMyScriptOutput(out, TAG, 1)[0]!.table).toEqual([["c"], ["a"]]);
  });

  it("marca de outra execução e conjunto de resultados solto são ignorados; aberta e não fechada", () => {
    const other = `<resultset statement="x">\n  <row>\n\t<field name="tws_m">ffffffffffffffff S 1</field>\n  </row>\n</resultset>\n`;
    const out = data(["solto"]) + other + marker("S", 1);
    const [a] = parseMyScriptOutput(out, TAG, 1);
    expect(a).toMatchObject({ started: true, ended: false, table: [] });
  });
});
