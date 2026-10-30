/**
 * upload-restore-format.test.ts — reconhecimento do formato pelos primeiros bytes, compatibilidade com o motor do
 * banco, .gz lido até o fim e SQL do PostgreSQL sem comandos do psql.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  UploadFormatError,
  assertFormatFitsEngine,
  detectFormat,
  formatLabel,
  scanPostgresSql,
  verifyGzip,
} from "../src/services/upload-restore-format.js";

const PG_SQL = "--\n-- PostgreSQL database dump\n--\nSET statement_timeout = 0;\nCREATE TABLE t (id int);\n";
const MY_SQL = "-- MySQL dump 10.13  Distrib 8.0\n/*!40101 SET @OLD=@@CHARACTER_SET_CLIENT */;\nCREATE TABLE `t` (id int) ENGINE=InnoDB;\n";
const buf = (s: string) => Buffer.from(s, "utf8");

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof UploadFormatError ? err.code : "outro";
  }
}

describe("detectFormat", () => {
  it("PGDMP é o formato personalizado do PostgreSQL, mesmo sem extensão", () => {
    expect(detectFormat(Buffer.concat([buf("PGDMP"), Buffer.from([1, 14, 0, 0, 0])]))).toEqual({ format: "pg_custom", gzip: false, hint: "postgres" });
  });

  it("SQL do PostgreSQL e do MySQL, com a pista do motor", () => {
    expect(detectFormat(buf(PG_SQL))).toEqual({ format: "sql", gzip: false, hint: "postgres" });
    expect(detectFormat(buf(MY_SQL))).toEqual({ format: "sql", gzip: false, hint: "mysql" });
    expect(detectFormat(buf("CREATE TABLE a (id int);\n")).hint).toBeNull();
    // as duas pistas ao mesmo tempo: não dá para dizer
    expect(detectFormat(buf(`${PG_SQL}${MY_SQL}`)).hint).toBeNull();
  });

  it(".gz: abre o começo e reconhece o que está dentro", () => {
    expect(detectFormat(gzipSync(buf(PG_SQL)))).toEqual({ format: "sql", gzip: true, hint: "postgres" });
    expect(detectFormat(gzipSync(Buffer.concat([buf("PGDMP"), Buffer.alloc(20)])))).toMatchObject({ format: "pg_custom", gzip: true });
  });

  it(".gz cortado no meio ainda mostra o começo; lixo com a marca do gzip é recusado", () => {
    const whole = gzipSync(buf(PG_SQL.repeat(2000)));
    expect(detectFormat(whole.subarray(0, 600))).toMatchObject({ format: "sql", gzip: true });
    expect(codeOf(() => detectFormat(Buffer.from([0x1f, 0x8b, 0x00, 0x01, 0x02])))).toBe("corrupt_gzip");
  });

  it("arquivo do MongoDB (--archive) pela marca do arquivo", () => {
    expect(detectFormat(Buffer.from([0x6d, 0xe2, 0x99, 0x81, 0, 0, 0, 0]))).toEqual({ format: "mongo_archive", gzip: false, hint: null });
  });

  it("backup do painel (.7z) só vale sem gzip por fora", () => {
    const sevenZ = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]);
    expect(detectFormat(sevenZ)).toEqual({ format: "panel_backup", gzip: false, hint: null });
    expect(codeOf(() => detectFormat(gzipSync(sevenZ)))).toBe("not_a_dump");
  });

  it("recusa .zip, SQLite, binário qualquer e texto que não é SQL", () => {
    expect(codeOf(() => detectFormat(Buffer.from("PK\x03\x04aaaa", "latin1")))).toBe("zip_not_supported");
    expect(codeOf(() => detectFormat(Buffer.from("PK\x05\x06aaaa", "latin1")))).toBe("zip_not_supported");
    expect(codeOf(() => detectFormat(gzipSync(Buffer.from("PK\x03\x04aaaa", "latin1"))))).toBe("zip_not_supported");
    expect(codeOf(() => detectFormat(Buffer.concat([Buffer.from("SQLite format 3\0", "latin1"), Buffer.alloc(40)])))).toBe("sqlite_not_supported");
    expect(codeOf(() => detectFormat(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2])))).toBe("not_a_dump");
    expect(codeOf(() => detectFormat(buf("Olá, isto é só uma carta.\nAbraços\n")))).toBe("not_a_dump");
  });
});

describe("assertFormatFitsEngine", () => {
  const sql = (hint: "postgres" | "mysql" | null) => ({ format: "sql" as const, gzip: false, hint });
  const custom = { format: "pg_custom" as const, gzip: false, hint: "postgres" as const };
  const mongo = { format: "mongo_archive" as const, gzip: false, hint: null };
  const panel = { format: "panel_backup" as const, gzip: false, hint: null };

  it("PostgreSQL aceita SQL e personalizado; recusa MongoDB e SQL do MySQL", () => {
    expect(codeOf(() => assertFormatFitsEngine("postgres", sql("postgres")))).toBeNull();
    expect(codeOf(() => assertFormatFitsEngine("postgres", sql(null)))).toBeNull();
    expect(codeOf(() => assertFormatFitsEngine("postgres", custom))).toBeNull();
    expect(codeOf(() => assertFormatFitsEngine("postgres", mongo))).toBe("wrong_engine");
    expect(codeOf(() => assertFormatFitsEngine("postgres", sql("mysql")))).toBe("wrong_engine");
  });

  it("MySQL e MariaDB aceitam SQL; recusam PGDMP (o caso do arquivo do PostgreSQL), MongoDB e SQL do PostgreSQL", () => {
    for (const engine of ["mysql", "mariadb"] as const) {
      expect(codeOf(() => assertFormatFitsEngine(engine, sql("mysql")))).toBeNull();
      expect(codeOf(() => assertFormatFitsEngine(engine, custom))).toBe("wrong_engine");
      expect(codeOf(() => assertFormatFitsEngine(engine, mongo))).toBe("wrong_engine");
      expect(codeOf(() => assertFormatFitsEngine(engine, sql("postgres")))).toBe("wrong_engine");
    }
  });

  it("MongoDB só aceita o arquivo --archive", () => {
    expect(codeOf(() => assertFormatFitsEngine("mongo", mongo))).toBeNull();
    expect(codeOf(() => assertFormatFitsEngine("mongo", custom))).toBe("wrong_engine");
    expect(codeOf(() => assertFormatFitsEngine("mongo", sql("postgres")))).toBe("wrong_engine");
    expect(codeOf(() => assertFormatFitsEngine("mongo", sql("mysql")))).toBe("wrong_engine");
    expect(codeOf(() => assertFormatFitsEngine("mongo", sql(null)))).toBe("wrong_engine");
  });

  it("backup do painel passa (o motor do conteúdo é conferido depois de abrir); Redis nunca", () => {
    expect(codeOf(() => assertFormatFitsEngine("postgres", panel))).toBeNull();
    expect(codeOf(() => assertFormatFitsEngine("redis", sql(null)))).toBe("unsupported_engine");
  });

  it("a mensagem diz o que o arquivo parece ser e o que o serviço é", () => {
    try {
      assertFormatFitsEngine("mysql", custom);
    } catch (err) {
      expect((err as Error).message).toContain("PostgreSQL");
      expect((err as Error).message).toContain("MySQL");
    }
    expect(formatLabel("pg_custom")).toContain("PostgreSQL");
  });
});

describe("leitura do arquivo inteiro", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "upload-format-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const put = async (name: string, data: Buffer | string) => {
    const f = path.join(dir, name);
    await writeFile(f, data);
    return f;
  };

  it("verifyGzip: abre até o fim; cortado ou corrompido falha", async () => {
    const whole = gzipSync(buf(PG_SQL.repeat(5000)));
    await expect(verifyGzip(await put("ok.gz", whole))).resolves.toBeUndefined();
    await expect(verifyGzip(await put("cortado.gz", whole.subarray(0, whole.length - 30)))).rejects.toMatchObject({ code: "corrupt_gzip" });
    await expect(verifyGzip(await put("lixo.gz", Buffer.from("isto não é gzip")))).rejects.toMatchObject({ code: "corrupt_gzip" });
  });

  it("scanPostgresSql: dump comum passa, com COPY, \\restrict, texto e comentários com barra", async () => {
    const sql = [
      "\\restrict AbC123",
      "SET statement_timeout = 0;",
      "-- comentário com \\barra",
      "COPY public.t (id, note) FROM stdin;",
      "1\tlinha com \\N e \\t dentro",
      "\\.",
      "INSERT INTO t VALUES (2, 'texto com \\ barra');",
      "CREATE FUNCTION f() RETURNS int AS $$ select '\\'::int $$ LANGUAGE sql;",
      "CREATE FUNCTION g() RETURNS text AS $body$",
      "\\ dentro de um corpo de função de várias linhas não é comando do psql",
      "$body$ LANGUAGE sql;",
      "\\unrestrict AbC123",
    ].join("\n");
    await expect(scanPostgresSql(await put("ok.sql", sql), false)).resolves.toBeUndefined();
    await expect(scanPostgresSql(await put("ok.sql.gz", gzipSync(buf(sql))), true)).resolves.toBeUndefined();
  });

  it("scanPostgresSql: comando do psql (\\!, \\connect, \\copy) é recusado", async () => {
    for (const line of ["\\! rm -rf /", "\\connect outro", "\\copy t from '/etc/passwd'"]) {
      const f = await put("x.sql", `SET x = 1;\n${line}\n`);
      await expect(scanPostgresSql(f, false), line).rejects.toMatchObject({ code: "unsafe_sql" });
    }
    await expect(scanPostgresSql(await put("y.sql.gz", gzipSync(buf("\\! id\n"))), true)).rejects.toMatchObject({ code: "unsafe_sql" });
  });

  it("scanPostgresSql: .gz cortado ou arquivo que não existe vira erro claro", async () => {
    const whole = gzipSync(buf(PG_SQL.repeat(5000)));
    await expect(scanPostgresSql(await put("c.gz", whole.subarray(0, 40)), true)).rejects.toMatchObject({ code: "corrupt_gzip" });
    await expect(scanPostgresSql(path.join(dir, "nao-existe.sql"), false)).rejects.toMatchObject({ code: "corrupt_gzip" });
  });
});
