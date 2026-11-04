/**
 * database-psql-ambiguity.test.ts — pontos em que o leitor do psql (psqlscan.l) lê diferente do nosso: o painel recusa
 * em vez de adivinhar (defesa em profundidade; o texto do usuário já vai ao psql em hexadecimal).
 */
import { describe, expect, it } from "vitest";
import { analyzeSql, analyzeSqlScript, splitSql } from "../src";

describe("pontos em que o psql lê diferente: recusa em vez de adivinhar (PostgreSQL)", () => {
  const probes = ["SELECT 1$$'$$ \\! id #'", "SELECT 1E'\\' , '\\! id'", "SELECT 1.E'\\' \\! id\n", "select 2$a$ x $a$", "select 12e'x'", "select .5E'x'"];

  it("separador e analisador recusam como 'ambiguous'", () => {
    for (const sql of probes) {
      expect(splitSql(sql, "postgres"), sql).toEqual({ ok: false, code: "ambiguous" });
      expect(analyzeSqlScript(sql, "postgres"), sql).toMatchObject({ ok: false, code: "ambiguous" });
      expect(analyzeSql(sql, "postgres"), sql).toEqual({ ok: false, code: "ambiguous" });
    }
  });

  it("o que NÃO é ambíguo segue valendo: identificador com $, E'..' normal, $$ depois de espaço ou operador", () => {
    for (const sql of ["select a1$b from t", "select E'\\n' as x", "select 1 $$x$$", "select 1+$$x$$", "select (1)$$x$$", "select x.E from t", "select 1 as e, 'a'", "select 5e", "select 1 $", "select 1$ from t", "select 'a'e", "select e'x'"]) {
      expect(splitSql(sql, "postgres"), sql).toMatchObject({ ok: true });
    }
  });

  it("o `--` acaba também no \\r (como no servidor): a sonda COMMIT/DELETE escondida é recusada", () => {
    for (const sql of ["SELECT 1 --x\r; COMMIT; DELETE FROM t", "SELECT 1 --x\r", "select 1\rfrom t", "select 1\f", "select 1\v", "select 1\u0001", "select 'a'\0", "select 1 -- \0x", "select $1$$x$$", "select $12$"]) {
      expect(splitSql(sql, "postgres"), JSON.stringify(sql)).toEqual({ ok: false, code: "ambiguous" });
      expect(analyzeSql(sql, "postgres"), JSON.stringify(sql)).toEqual({ ok: false, code: "ambiguous" });
      expect(analyzeSqlScript(sql, "postgres"), JSON.stringify(sql)).toMatchObject({ ok: false, code: "ambiguous" });
    }
  });

  it("\\r\\n, \\t e controles DENTRO de texto ou de comentário `/* */` continuam valendo", () => {
    for (const sql of ["select 1 --x\r\nfrom t", "select\t1\r\n", "select 'a\rb' as x", "select 1 /* \u0001 */", "select $1 from t where a = $2"]) {
      expect(analyzeSqlScript(sql, "postgres"), JSON.stringify(sql)).toMatchObject({ ok: true });
    }
  });

  it("SET/RESET das opções somente leitura, COMMIT e set_config nunca são leitura", () => {
    for (const sql of ["set default_transaction_read_only = off", "reset default_transaction_read_only", "set transaction_read_only = off", "set session characteristics as transaction read write", "commit", "begin", "end", "select set_config('transaction_read_only', 'off', false)", "alter system set default_transaction_read_only = off"]) {
      expect(analyzeSql(sql, "postgres"), sql).toMatchObject({ ok: true, kind: "write" });
    }
  });

  it("COPY ... FROM STDIN é recusado (consumiria o script); TO STDOUT e COPY de arquivo seguem como escrita", () => {
    expect(analyzeSql("copy t from stdin", "postgres")).toEqual({ ok: false, code: "client_command" });
    expect(analyzeSql("COPY t (a) FROM STDIN WITH (FORMAT csv)", "postgres")).toEqual({ ok: false, code: "client_command" });
    expect(analyzeSql("copy t to stdout", "postgres")).toMatchObject({ ok: true, kind: "write" });
    expect(analyzeSql("copy (select 1) to stdout", "postgres")).toMatchObject({ ok: true });
  });

  it("MySQL: `--` só acaba no \\n e controles não são recusados; o resto não muda", () => {
    expect(splitSql("select 1 -- x\r; select 2", "mysql")).toEqual({ ok: true, pieces: ["select 1 -- x\r; select 2"] });
    expect(analyzeSql("select 1\r\nfrom t", "mysql")).toMatchObject({ ok: true });
  });

  it("tag de dollar quoting de QUALQUER tamanho é lida inteira (sem janela): a sonda de 100 caracteres não esconde instruções", () => {
    const tag = `$L${"x".repeat(100)}$`;
    const probe = `select ${tag} ' ${tag}; set default_transaction_read_only=off; commit; delete from t; --'`;
    const split = splitSql(probe, "postgres");
    expect(split).toMatchObject({ ok: true });
    expect(split.ok && split.pieces).toHaveLength(5);
    expect(analyzeSqlScript(probe, "postgres")).toMatchObject({ ok: true, kind: "write" });
    // uma tag longa que fecha é um texto só; sem fechar, é recusada
    expect(analyzeSql(`select ${tag}a; b${tag}`, "postgres")).toMatchObject({ ok: true, dollar: true });
    expect(analyzeSql(`select ${tag} a`, "postgres")).toEqual({ ok: false, code: "unterminated" });
  });

  it("$nome que não fecha com $ é recusado como ambiguous; $1, $ solto e identificador com $ seguem valendo", () => {
    for (const sql of ["select $abc from t", "select $abc; delete from t", `select $${"y".repeat(200)} 1`]) {
      expect(splitSql(sql, "postgres"), sql).toEqual({ ok: false, code: "ambiguous" });
      expect(analyzeSql(sql, "postgres"), sql).toEqual({ ok: false, code: "ambiguous" });
    }
    for (const sql of ["select $1, $2 from t", "select a$b from t", "select 1 as \"$x\"", "select '$abc'"]) {
      expect(analyzeSql(sql, "postgres"), sql).toMatchObject({ ok: true });
    }
  });

  it("leitura recusa dollar quoting por inteiro (dollar_quote); escrita aceita; MySQL não tem isso", () => {
    expect(analyzeSqlScript("select 1; select $$x$$ as a", "postgres")).toEqual({ ok: false, code: "dollar_quote", index: 2 });
    expect(analyzeSqlScript("select $tag$x$tag$", "postgres")).toMatchObject({ ok: false, code: "dollar_quote", index: 1 });
    expect(analyzeSqlScript("select $$x$$; delete from t", "postgres")).toMatchObject({ ok: true, kind: "write" });
    expect(analyzeSqlScript("do $$ begin null; end $$", "postgres")).toMatchObject({ ok: true, kind: "write" });
    expect(analyzeSqlScript("select '$$' as a", "postgres")).toMatchObject({ ok: true, kind: "read" });
    expect(analyzeSqlScript("select $$x$$", "mysql")).toMatchObject({ ok: true, kind: "read" });
  });

  it("MySQL não tem essas regras (cifrão e E' comuns)", () => {
    expect(splitSql("select 1$$x", "mysql")).toMatchObject({ ok: true });
    expect(analyzeSql("select 1E'x'", "mysql")).toMatchObject({ ok: true });
  });
});
