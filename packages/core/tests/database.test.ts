import { describe, expect, it } from "vitest";
import { analyzeSql, databaseCommandsFor, isDatabaseCommandId, isDatabaseSqlEngine } from "../src/database";

const pg = (sql: string) => analyzeSql(sql, "postgres");
const my = (sql: string) => analyzeSql(sql, "mysql");

describe("motores e comandos", () => {
  it("reconhece os motores com suporte", () => {
    expect(isDatabaseSqlEngine("postgres")).toBe(true);
    expect(isDatabaseSqlEngine("mysql")).toBe(true);
    expect(isDatabaseSqlEngine("mariadb")).toBe(true);
    expect(isDatabaseSqlEngine("mongo")).toBe(false);
    expect(isDatabaseSqlEngine(null)).toBe(false);
  });

  it("só aceita ids da lista fechada de comandos", () => {
    expect(isDatabaseCommandId("laravel-migrate")).toBe(true);
    expect(isDatabaseCommandId("rm -rf /")).toBe(false);
    expect(isDatabaseCommandId(3)).toBe(false);
  });

  it("lista os comandos do framework e nada sem framework", () => {
    expect(databaseCommandsFor(null)).toEqual([]);
    const list = databaseCommandsFor("laravel");
    expect(list.map((c) => c.id)).toEqual(["laravel-migrate-fresh-seed", "laravel-migrate", "laravel-seed"]);
    expect(list[0]).toMatchObject({ dropsData: true, display: "php artisan migrate:fresh --seed --force --no-interaction --no-ansi" });
    expect(list[1]!.dropsData).toBe(false);
  });
});

describe("analyzeSql: leitura e escrita", () => {
  it.each([
    ["select 1", "select"],
    ["  SELECT * FROM users;  ", "select"],
    ["show tables", "show"],
    ["explain select 1", "explain"],
    ["describe users", "describe"],
    ["desc users", "desc"],
    ["values (1)", "values"],
    ["table users", "table"],
    ["with a as (select 1) select * from a", "with"],
    ["(select 1) union (select 2)", "select"],
  ])("%s é leitura", (sql, verb) => {
    const r = my(sql);
    expect(r).toMatchObject({ ok: true, kind: "read", verb });
  });

  it.each([
    "insert into t values (1)",
    "update t set a = 1",
    "delete from t",
    "drop table t",
    "create table t (a int)",
    "truncate t",
    "select * into novo from t",
    "with a as (delete from t returning *) select * from a",
    "with a as (select 1) insert into t select * from a",
  ])("%s é escrita", (sql) => {
    expect(pg(sql)).toMatchObject({ ok: true, kind: "write" });
  });

  it("devolve a instrução sem o ponto e vírgula final", () => {
    expect(pg("select 1;  ")).toMatchObject({ ok: true, statement: "select 1" });
    expect(pg("select 1; -- fim")).toMatchObject({ ok: true, statement: "select 1" });
    expect(pg("select 1; /* fim */")).toMatchObject({ ok: true, statement: "select 1" });
  });

  it("palavras dentro de texto ou comentário não contam", () => {
    expect(pg("select 'insert into x; drop' as a")).toMatchObject({ kind: "read" });
    expect(pg("select 1 -- into x")).toMatchObject({ kind: "read" });
    expect(pg("select 1 /* delete */")).toMatchObject({ kind: "read" });
    expect(pg('select "into" from t')).toMatchObject({ kind: "read" });
  });
});

describe("analyzeSql: recusas", () => {
  it("vazio ou só comentário", () => {
    expect(pg("")).toEqual({ ok: false, code: "empty" });
    expect(pg("   ")).toEqual({ ok: false, code: "empty" });
    expect(pg("-- nada")).toEqual({ ok: false, code: "empty" });
    expect(pg("/* nada */")).toEqual({ ok: false, code: "empty" });
    expect(pg(";")).toEqual({ ok: false, code: "empty" });
    expect(pg("123")).toEqual({ ok: false, code: "empty" });
  });

  it("mais de uma instrução", () => {
    expect(pg("select 1; select 2")).toEqual({ ok: false, code: "multiple" });
    expect(pg("select 1;; ")).toEqual({ ok: false, code: "multiple" });
    expect(pg("select 1; commit")).toEqual({ ok: false, code: "multiple" });
    expect(pg("select 1; 2")).toEqual({ ok: false, code: "multiple" });
  });

  it("barra invertida fora de texto é comando do cliente", () => {
    expect(pg("select 1 \\g")).toEqual({ ok: false, code: "client_command" });
    expect(my("select 1 \\! ls")).toEqual({ ok: false, code: "client_command" });
    expect(pg("\\copy t from '/etc/passwd'")).toEqual({ ok: false, code: "client_command" });
  });

  it("comandos do cliente mysql", () => {
    for (const w of ["delimiter //", "source /x.sql", "system ls", "use outro", "status"]) {
      expect(my(w)).toEqual({ ok: false, code: "client_command" });
    }
    // no PostgreSQL essas palavras são só SQL comum (escrita)
    expect(pg("use x")).toMatchObject({ ok: true, kind: "write" });
  });

  it("comentário executável do MySQL e do MariaDB", () => {
    expect(my("select 1 /*! ; drop table t */")).toEqual({ ok: false, code: "executable_comment" });
    expect(my("select 1 /*M! ; drop table t */")).toEqual({ ok: false, code: "executable_comment" });
    expect(pg("select 1 /*! x */")).toEqual({ ok: false, code: "executable_comment" });
    // /*M! no PostgreSQL é comentário comum
    expect(pg("select 1 /*M! x */")).toMatchObject({ ok: true });
  });

  it("textos, identificadores e comentários sem fim", () => {
    expect(pg("select 'abc")).toEqual({ ok: false, code: "unterminated" });
    expect(pg('select "abc')).toEqual({ ok: false, code: "unterminated" });
    expect(my("select `abc")).toEqual({ ok: false, code: "unterminated" });
    expect(pg("select 1 /* abc")).toEqual({ ok: false, code: "unterminated" });
    expect(pg("select $a$ abc")).toEqual({ ok: false, code: "unterminated" });
  });
});

describe("analyzeSql: o que o leitor de cada banco entende", () => {
  it("aspas duplicadas dentro do texto", () => {
    expect(pg("select 'it''s; ok'")).toMatchObject({ ok: true, kind: "read" });
    expect(pg('select "a""b;"')).toMatchObject({ ok: true });
    expect(my("select `a``b;`")).toMatchObject({ ok: true });
  });

  it("MySQL: barra invertida escapa a aspa; PostgreSQL só em E'...'", () => {
    expect(my("select 'a\\'; drop table t; --'")).toMatchObject({ ok: true, kind: "read" });
    expect(my('select "a\\"; x"')).toMatchObject({ ok: true });
    // PostgreSQL comum: a barra é só um caractere e o texto termina na aspa seguinte
    expect(pg("select 'a\\'; drop table t")).toEqual({ ok: false, code: "multiple" });
    expect(pg("select E'a\\'; x'")).toMatchObject({ ok: true });
    expect(pg("select e'a\\'; x'")).toMatchObject({ ok: true });
    // letra E que faz parte de outra palavra não liga o escape
    expect(pg("select abcE'x\\'; drop table t")).toEqual({ ok: false, code: "multiple" });
  });

  it("PostgreSQL: $tag$ ... $tag$ e comentário aninhado", () => {
    expect(pg("select $$a; b$$")).toMatchObject({ ok: true });
    expect(pg("select $t$ a; $$ b $t$")).toMatchObject({ ok: true });
    expect(pg("select 1 /* a /* b */ ; c */")).toMatchObject({ ok: true, statement: "select 1 /* a /* b */ ; c */" });
    // $ dentro de palavra ou sem etiqueta fechada não abre texto
    expect(pg("select a$b$ from t")).toMatchObject({ ok: true });
    expect(pg("select $1")).toMatchObject({ ok: true });
  });

  it("MySQL: -- só é comentário com espaço depois; # é comentário; bloco não aninha", () => {
    expect(my("select 1 -- ; x")).toMatchObject({ ok: true, kind: "read" });
    expect(my("select 1 --")).toMatchObject({ ok: true });
    expect(my("select 1--1; select 2")).toEqual({ ok: false, code: "multiple" });
    expect(my("select 1 # ; x")).toMatchObject({ ok: true });
    expect(my("select 1 /* a /* b */ ; select 2")).toEqual({ ok: false, code: "multiple" });
    // no PostgreSQL # é operador
    expect(pg("select 1 # 2; select 3")).toEqual({ ok: false, code: "multiple" });
  });
});
