/**
 * dotenv-parse.test.ts — leitura do arquivo .env importado na seção Variáveis.
 * O arquivo é lido no navegador; só o resultado (nome/valor) vai para a lista.
 */
import { describe, expect, it } from "vitest";
import { parseDotenv } from "@/lib/dotenv";

describe("parseDotenv", () => {
  it("lê KEY=valor, ignora comentários e linhas vazias, aceita export", () => {
    const r = parseDotenv("# banco\nPOSTGRES_USER=casa\n\nexport NODE_ENV=production\r\n");
    expect(r.vars).toEqual([
      { key: "POSTGRES_USER", value: "casa" },
      { key: "NODE_ENV", value: "production" },
    ]);
    expect(r.skipped).toEqual([]);
  });

  it("aspas: simples é literal; duplas aceita \\n e \\\"; comentário só fora das aspas", () => {
    const r = parseDotenv(
      ["A='tem # e $HOME'", 'B="linha1\\nlinha2 \\"x\\""', "C=valor # comentário", "D=sem#comentario", "E="].join("\n"),
    );
    expect(r.vars).toEqual([
      { key: "A", value: "tem # e $HOME" },
      { key: "B", value: 'linha1\nlinha2 "x"' },
      { key: "C", value: "valor" },
      { key: "D", value: "sem#comentario" },
      { key: "E", value: "" },
    ]);
  });

  it("valor entre aspas em várias linhas (ex.: chave privada)", () => {
    const r = parseDotenv('KEY="-----BEGIN-----\nabc\n-----END-----"\nOUTRA=1');
    expect(r.vars).toEqual([
      { key: "KEY", value: "-----BEGIN-----\nabc\n-----END-----" },
      { key: "OUTRA", value: "1" },
    ]);
  });

  it("nome repetido: vale o último; linhas inválidas são contadas pelo número", () => {
    const r = parseDotenv("A=1\nisso não é variável\n1X=2\nA=3\n");
    expect(r.vars).toEqual([{ key: "A", value: "3" }]);
    expect(r.skipped).toEqual([2, 3]);
  });

  it("ignora o BOM do início do arquivo", () => {
    expect(parseDotenv("﻿A=1").vars).toEqual([{ key: "A", value: "1" }]);
  });
});
