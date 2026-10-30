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

  it("MySQL não tem essas regras (cifrão e E' comuns)", () => {
    expect(splitSql("select 1$$x", "mysql")).toMatchObject({ ok: true });
    expect(analyzeSql("select 1E'x'", "mysql")).toMatchObject({ ok: true });
  });
});
