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
  it("aspa que não fecha: só aquela linha é ignorada, as de baixo continuam", () => {
    const r = parseDotenv('A=1\nB="sem fim\nC=3\nD=4');
    expect(r.vars).toEqual([
      { key: "A", value: "1" },
      { key: "C", value: "3" },
      { key: "D", value: "4" },
    ]);
    expect(r.skipped).toEqual([2]);
  });

  it("espaço no fim da primeira linha de um valor multilinha entre aspas é mantido", () => {
    expect(parseDotenv('A="um  \ndois"').vars).toEqual([{ key: "A", value: "um  \ndois" }]);
  });

  it("CRLF, espaços ao redor do =, export, nome minúsculo, = e # dentro de aspas, vazio e NOME sem =", () => {
    const r = parseDotenv(
      ["export  db_url = 'postgres://u:p@h/db?a=b#c'", 'X = "a=b # c"', "VAZIA=", "SOZINHA", "nome.com.ponto=1", "nome-hifen=2", "Y=1"].join(
        "\r\n",
      ),
    );
    expect(r.vars).toEqual([
      { key: "db_url", value: "postgres://u:p@h/db?a=b#c" },
      { key: "X", value: "a=b # c" },
      { key: "VAZIA", value: "" },
      { key: "Y", value: "1" },
    ]);
    expect(r.skipped).toEqual([4, 5, 6]);
  });
});
