/**
 * database-script.test.ts — console com várias instruções: o separador (textos, comentários, $$, crases, instrução
 * final sem ';'), a classificação do conjunto e as configurações da liberação da edição.
 */
import { describe, expect, it } from "vitest";
import {
  DATABASE_SETTINGS_DEFAULT,
  DATABASE_SQL_MAX_STATEMENTS,
  DATABASE_UNLOCK_DURATIONS,
  analyzeSqlScript,
  databaseSettingsLoosens,
  databaseUnlockMs,
  isDatabaseUnlockDuration,
  splitSql,
} from "../src";

const pieces = (sql: string, engine: "postgres" | "mysql" = "postgres") => {
  const r = splitSql(sql, engine);
  if (!r.ok) throw new Error(r.code);
  return r.pieces;
};

describe("splitSql", () => {
  it("separa por ';' e aceita a última instrução sem ';'", () => {
    expect(pieces("select 1; select 2;select 3")).toEqual(["select 1", "select 2", "select 3"]);
    expect(pieces("select 1")).toEqual(["select 1"]);
    expect(pieces("  select 1 ;; ; select 2 ;  ")).toEqual(["select 1", "select 2"]);
    expect(pieces("")).toEqual([]);
    expect(pieces("  \n ; ")).toEqual([]);
  });

  it("o ';' dentro de texto entre aspas, identificador ou crases não separa", () => {
    expect(pieces("select 'a;b'; select \"c;d\"")).toEqual(["select 'a;b'", 'select "c;d"']);
    expect(pieces("select 'it''s;ok'; select 2")).toEqual(["select 'it''s;ok'", "select 2"]);
    expect(pieces("select `a;b` from t; select 2", "mysql")).toEqual(["select `a;b` from t", "select 2"]);
    expect(pieces("select \"x\"\"y;z\"; select 2", "mysql")).toEqual(['select "x""y;z"', "select 2"]);
  });

  it("barra invertida: no MySQL escapa a aspa; no PostgreSQL só em E'...'", () => {
    expect(pieces("select 'a\\';b'; select 2", "mysql")).toEqual(["select 'a\\';b'", "select 2"]);
    expect(pieces("select E'a\\';b'; select 2")).toEqual(["select E'a\\';b'", "select 2"]);
    // texto comum do PostgreSQL: a barra não escapa, a aspa fecha e o ';' separa
    expect(pieces("select 'a\\'; select 2")).toEqual(["select 'a\\'", "select 2"]);
  });

  it("comentários de linha e de bloco escondem o ';'", () => {
    expect(pieces("select 1 -- ; nada\n; select 2 /* ; */ ; select 3")).toEqual(["select 1 -- ; nada", "select 2 /* ; */", "select 3"]);
    expect(pieces("select 1 # x ; y\n; select 2", "mysql")).toEqual(["select 1 # x ; y", "select 2"]);
    expect(pieces("select 1 -- x;\n; select 2", "mysql")).toEqual(["select 1 -- x;", "select 2"]);
    // no MySQL, "--" sem espaço depois não é comentário
    expect(pieces("select 1--1; select 2", "mysql")).toEqual(["select 1--1", "select 2"]);
    // blocos aninhados só no PostgreSQL
    expect(pieces("select /* a /* b ; */ c */ 1; select 2")).toEqual(["select /* a /* b ; */ c */ 1", "select 2"]);
    expect(pieces("/* só comentário */; select 1")).toEqual(["/* só comentário */", "select 1"]);
  });

  it("corpo entre $$ (e $tag$) com ';' é uma instrução só", () => {
    const fn = "create function f() returns int as $$ begin select 1; return 2; end; $$ language plpgsql";
    expect(pieces(`${fn}; select f()`)).toEqual([fn, "select f()"]);
    expect(pieces("do $body$ begin perform 1; end $body$; select 2")).toEqual(["do $body$ begin perform 1; end $body$", "select 2"]);
    // '$' dentro de palavra ou parâmetro $1 não abre corpo
    expect(pieces("select a$b; select $1")).toEqual(["select a$b", "select $1"]);
    // no MySQL '$$' não tem significado especial
    expect(pieces("select 1 as $$; select 2", "mysql")).toEqual(["select 1 as $$", "select 2"]);
  });

  it("o que não fecha é recusado", () => {
    expect(splitSql("select 'x; select 2", "postgres")).toEqual({ ok: false, code: "unterminated" });
    expect(splitSql('select "x; select 2', "mysql")).toEqual({ ok: false, code: "unterminated" });
    expect(splitSql("select 1 /* x", "postgres")).toEqual({ ok: false, code: "unterminated" });
    expect(splitSql("select $$ x; select 2", "postgres")).toEqual({ ok: false, code: "unterminated" });
    expect(splitSql("select /* a /* b */ c", "postgres")).toEqual({ ok: false, code: "unterminated" });
  });
});

describe("analyzeSqlScript", () => {
  it("tudo leitura -> leitura; qualquer escrita -> escrita", () => {
    const read = analyzeSqlScript("select 1; show tables; explain select 2", "mysql");
    expect(read).toMatchObject({ ok: true, kind: "read" });
    expect(read.ok && read.statements.map((s) => s.verb)).toEqual(["select", "show", "explain"]);
    const mixed = analyzeSqlScript("select 1; delete from t; select 2", "postgres");
    expect(mixed).toMatchObject({ ok: true, kind: "write" });
    expect(mixed.ok && mixed.statements.map((s) => s.kind)).toEqual(["read", "write", "read"]);
  });

  it("função com efeito e INTO/OUTFILE viram escrita, com o motivo da instrução", () => {
    const a = analyzeSqlScript("select 1; select pg_read_file('/etc/passwd')", "postgres");
    expect(a.ok && a.kind).toBe("write");
    expect(a.ok && a.statements[1]).toMatchObject({ kind: "write", reason: "side_effect" });
    const b = analyzeSqlScript("table t into outfile '/tmp/x'", "mysql");
    expect(b.ok && b.statements[0]).toMatchObject({ kind: "write", reason: "into" });
  });

  it("instrução recusada: devolve o código e o número dela", () => {
    expect(analyzeSqlScript("select 1; \\! ls", "postgres")).toEqual({ ok: false, code: "client_command", index: 2 });
    expect(analyzeSqlScript("select 1; select 2 /*! x */", "mysql")).toEqual({ ok: false, code: "executable_comment", index: 2 });
    expect(analyzeSqlScript("select 1; source /tmp/x.sql", "mysql")).toEqual({ ok: false, code: "client_command", index: 2 });
    expect(analyzeSqlScript("delimiter //\nselect 1//", "mysql")).toEqual({ ok: false, code: "client_command", index: 1 });
    expect(analyzeSqlScript("select 'x", "mysql")).toEqual({ ok: false, code: "unterminated", index: null });
  });

  it("vazio e só comentários -> empty; pedaço só de comentário no meio é ignorado", () => {
    expect(analyzeSqlScript("", "postgres")).toEqual({ ok: false, code: "empty", index: null });
    expect(analyzeSqlScript("-- nada", "postgres")).toEqual({ ok: false, code: "empty", index: null });
    const a = analyzeSqlScript("select 1; -- meio\n; select 2", "postgres");
    expect(a.ok && a.statements.map((s) => s.statement)).toEqual(["select 1", "select 2"]);
    const b = analyzeSqlScript("select 1; /* x */; select 2", "postgres");
    expect(b.ok && b.statements).toHaveLength(2);
  });

  it("no máximo 50 instruções", () => {
    const many = (n: number) => Array.from({ length: n }, () => "select 1").join(";");
    expect(analyzeSqlScript(many(DATABASE_SQL_MAX_STATEMENTS), "postgres")).toMatchObject({ ok: true });
    expect(analyzeSqlScript(many(DATABASE_SQL_MAX_STATEMENTS + 1), "postgres")).toEqual({ ok: false, code: "too_many", index: null });
  });

  it("função com ';' no corpo (PostgreSQL) segue como uma instrução de escrita", () => {
    const a = analyzeSqlScript("create function f() returns int as $$ select 1; $$ language sql; select f()", "postgres");
    expect(a.ok && a.statements.map((s) => s.verb)).toEqual(["create", "select"]);
    expect(a.ok && a.kind).toBe("write");
  });
});

describe("liberação da edição: duração e configuração", () => {
  it("duração em ms e validação", () => {
    expect(DATABASE_UNLOCK_DURATIONS).toEqual(["15m", "30m", "1h", "2h", "4h", "session"]);
    expect(databaseUnlockMs("15m")).toBe(15 * 60_000);
    expect(databaseUnlockMs("4h")).toBe(4 * 3_600_000);
    expect(databaseUnlockMs("session")).toBeNull();
    expect(isDatabaseUnlockDuration("1h")).toBe(true);
    expect(isDatabaseUnlockDuration("3h")).toBe(false);
    expect(isDatabaseUnlockDuration(30)).toBe(false);
    expect(DATABASE_SETTINGS_DEFAULT).toEqual({ unlockDuration: "30m", renewOnUse: true });
  });

  it("afrouxar = prazo maior ou renovar com o uso ligado; apertar não", () => {
    const base = { unlockDuration: "30m", renewOnUse: false } as const;
    expect(databaseSettingsLoosens(base, { ...base, unlockDuration: "1h" })).toBe(true);
    expect(databaseSettingsLoosens(base, { ...base, unlockDuration: "session" })).toBe(true);
    expect(databaseSettingsLoosens(base, { ...base, renewOnUse: true })).toBe(true);
    expect(databaseSettingsLoosens(base, { ...base, unlockDuration: "15m" })).toBe(false);
    expect(databaseSettingsLoosens(base, base)).toBe(false);
    expect(databaseSettingsLoosens({ unlockDuration: "session", renewOnUse: true }, { unlockDuration: "session", renewOnUse: true })).toBe(false);
    expect(databaseSettingsLoosens({ unlockDuration: "session", renewOnUse: true }, { unlockDuration: "4h", renewOnUse: false })).toBe(false);
  });
});
