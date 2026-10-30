/**
 * upload-restore-format.ts — "Restaurar de um arquivo": o que o arquivo enviado É, conferido pelos primeiros bytes
 * (a extensão não decide nada), e se serve ao motor do banco escolhido. Também a leitura que prova que um .gz abre até
 * o fim e que um SQL do PostgreSQL não leva comandos do cliente psql (barra invertida: \!, \copy, \o... rodariam um shell
 * dentro do container do banco).
 *
 * Nada aqui guarda nem devolve o CONTEÚDO do arquivo: só o formato, um motor provável e códigos de erro.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants as zlibConstants, createGunzip, gunzipSync } from "node:zlib";
import type { BackupDatabaseEngine, UploadRestoreFormat } from "@paas/core";
import { lexLine, type Lex } from "./backup-restore-validate.js";

/** Quantos bytes do começo bastam para reconhecer o formato (e, num .gz, para ler o começo do que está dentro). */
export const FORMAT_HEAD_BYTES = 8192;
/** Teto do que se descompacta do começo de um .gz (um arquivo malicioso poderia expandir centenas de vezes). */
const GUNZIP_HEAD_LIMIT = 16 * 1024 * 1024;

export type UploadFormatErrorCode =
  | "zip_not_supported"
  | "sqlite_not_supported"
  | "corrupt_gzip"
  | "not_a_dump"
  | "wrong_engine"
  | "unsupported_engine"
  | "unsafe_sql";

/** Erro com mensagem para a pessoa (a rota o devolve como 400). */
export class UploadFormatError extends Error {
  /** Como um erro HTTP: a rota o devolve como 400 sem conversão. */
  readonly statusCode = 400;
  constructor(
    readonly code: UploadFormatErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UploadFormatError";
  }
}

export interface DetectedFormat {
  format: UploadRestoreFormat;
  /** O arquivo inteiro está compactado com gzip (o que está dentro é `format`). */
  gzip: boolean;
  /** Pelo texto do SQL: de qual motor ele parece vir (null = não dá para dizer). */
  hint: "postgres" | "mysql" | null;
}

const PGDMP = Buffer.from("PGDMP", "latin1");
/** Número mágico do arquivo `mongodump --archive` (0x8199e26d, gravado em little-endian). */
const MONGO_ARCHIVE_MAGIC = Buffer.from([0x6d, 0xe2, 0x99, 0x81]);
const SEVEN_Z_MAGIC = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");

const startsWith = (buf: Buffer, magic: Buffer): boolean => buf.length >= magic.length && buf.subarray(0, magic.length).equals(magic);

/** Texto que parece SQL: comentário, SET, CREATE, INSERT, COPY, USE... numa linha inteira. */
const SQL_MARKER = /(^|\n)\s*(--|\/\*|set\s|create\s|insert\s|drop\s|begin\b|start\s+transaction|copy\s|use\s|lock\s|alter\s|select\s|delete\s|update\s|truncate\s|\\connect|\\restrict)/i;
const PG_SIGNS = /-- PostgreSQL database dump|pg_catalog\.set_config|SET statement_timeout|\bFROM stdin;|CREATE EXTENSION|SET default_tablespace|\\restrict /;
const MYSQL_SIGNS = /-- MySQL dump|-- MariaDB dump|\/\*!\d{5}|\bENGINE=\w+|LOCK TABLES `|-- Server version/;

/**
 * Reconhece o formato pelos primeiros bytes (`FORMAT_HEAD_BYTES` ou menos, se o arquivo é menor). Lança UploadFormatError para arquivo que não é um dump.
 */
export function detectFormat(head: Buffer): DetectedFormat {
  let buf = head;
  let gzip = false;
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
    gzip = true;
    try {
      buf = gunzipSync(head, { finishFlush: zlibConstants.Z_SYNC_FLUSH, maxOutputLength: GUNZIP_HEAD_LIMIT }).subarray(0, FORMAT_HEAD_BYTES);
    } catch {
      throw new UploadFormatError("corrupt_gzip", "O arquivo .gz está corrompido ou incompleto: não abre. Gere o dump de novo e envie outra vez.");
    }
  }
  if (startsWith(buf, PGDMP)) return { format: "pg_custom", gzip, hint: "postgres" };
  if (startsWith(buf, MONGO_ARCHIVE_MAGIC)) return { format: "mongo_archive", gzip, hint: null };
  if (startsWith(buf, Buffer.from("PK\x03\x04", "latin1")) || startsWith(buf, Buffer.from("PK\x05\x06", "latin1"))) {
    throw new UploadFormatError("zip_not_supported", "Arquivo .zip não é aceito. Extraia o dump (.sql, .dump, .backup) e envie-o, ou compacte só ele com gzip (.sql.gz).");
  }
  if (startsWith(buf, SQLITE_MAGIC)) {
    throw new UploadFormatError("sqlite_not_supported", "Este arquivo é um banco SQLite, não um dump de PostgreSQL, MySQL/MariaDB ou MongoDB.");
  }
  if (!gzip && startsWith(buf, SEVEN_Z_MAGIC)) return { format: "panel_backup", gzip: false, hint: null };
  if (buf.includes(0)) {
    throw new UploadFormatError("not_a_dump", "Este arquivo é binário e não é um dump reconhecido (PostgreSQL .dump/.backup, SQL, MongoDB --archive ou backup do painel).");
  }
  // o corte do começo pode partir um caractere UTF-8 no meio: o decodificador troca por "�", sem problema para os marcadores
  const text = buf.toString("utf8");
  if (!SQL_MARKER.test(text)) {
    throw new UploadFormatError("not_a_dump", "O conteúdo não parece um dump SQL (não achei comandos como CREATE, INSERT, COPY ou comentários de dump no começo do arquivo).");
  }
  const hint = MYSQL_SIGNS.test(text) && !PG_SIGNS.test(text) ? "mysql" : PG_SIGNS.test(text) && !MYSQL_SIGNS.test(text) ? "postgres" : null;
  return { format: "sql", gzip, hint };
}

const FAMILY: Record<BackupDatabaseEngine, "postgres" | "mysql" | "mongo" | "redis"> = {
  postgres: "postgres",
  mysql: "mysql",
  mariadb: "mysql",
  mongo: "mongo",
  redis: "redis",
};

const ENGINE_NAME: Record<UploadRestoreFormat, string> = {
  pg_custom: "PostgreSQL (formato personalizado)",
  sql: "SQL",
  mongo_archive: "MongoDB (--archive)",
  panel_backup: "backup do painel",
};

/** O arquivo serve a este motor? Lança wrong_engine/unsupported_engine com a explicação. */
export function assertFormatFitsEngine(engine: BackupDatabaseEngine, d: DetectedFormat): void {
  const family = FAMILY[engine];
  if (family === "redis") throw new UploadFormatError("unsupported_engine", "Redis não é suportado na restauração por arquivo.");
  if (d.format === "panel_backup") return; // o motor do conteúdo é conferido depois de abrir o backup
  const label = (name: string) => `Este arquivo parece ser ${name}, mas o serviço escolhido é ${engineLabel(engine)}.`;
  if (family === "postgres") {
    if (d.format === "mongo_archive") throw new UploadFormatError("wrong_engine", label("um arquivo do MongoDB"));
    if (d.format === "sql" && d.hint === "mysql") throw new UploadFormatError("wrong_engine", label("um dump de MySQL/MariaDB"));
    return;
  }
  if (family === "mysql") {
    if (d.format === "pg_custom") throw new UploadFormatError("wrong_engine", label("um dump do PostgreSQL (formato personalizado)"));
    if (d.format === "mongo_archive") throw new UploadFormatError("wrong_engine", label("um arquivo do MongoDB"));
    if (d.format === "sql" && d.hint === "postgres") throw new UploadFormatError("wrong_engine", label("um dump do PostgreSQL"));
    return;
  }
  // mongo
  if (d.format === "pg_custom") throw new UploadFormatError("wrong_engine", label("um dump do PostgreSQL (formato personalizado)"));
  if (d.format === "sql") throw new UploadFormatError("wrong_engine", label(`um dump ${d.hint === "mysql" ? "de MySQL/MariaDB" : d.hint === "postgres" ? "do PostgreSQL" : "SQL"}`));
}

function engineLabel(engine: BackupDatabaseEngine): string {
  return { postgres: "PostgreSQL", mysql: "MySQL", mariadb: "MariaDB", mongo: "MongoDB", redis: "Redis" }[engine];
}

export function formatLabel(format: UploadRestoreFormat): string {
  return ENGINE_NAME[format];
}

/** Lê o .gz até o fim, sem guardar nada: prova que ele abre inteiro (arquivo cortado ou corrompido falha). */
export async function verifyGzip(file: string): Promise<void> {
  const sink = new Writable({ write: (_chunk, _enc, cb) => cb() });
  try {
    await pipeline(createReadStream(file), createGunzip(), sink);
  } catch {
    throw new UploadFormatError("corrupt_gzip", "O arquivo .gz está corrompido ou foi cortado antes do fim. Gere o dump de novo e envie outra vez.");
  }
}

const PG_COPY_START = /^COPY .+ FROM stdin;$/i;

/**
 * SQL do PostgreSQL com comando do cliente psql (barra invertida fora de texto, comentário e bloco COPY)? Só
 * `\restrict`/`\unrestrict` do pg_dump recente passam. Lê o arquivo (descompactando se for .gz) de ponta a ponta, o que
 * também prova que o .gz abre inteiro.
 */
export async function scanPostgresSql(file: string, gzip: boolean): Promise<void> {
  const raw = createReadStream(file);
  const input = gzip ? raw.pipe(createGunzip()) : raw;
  const failure = new Promise<never>((_resolve, reject) => {
    raw.on("error", reject);
    if (gzip) input.on("error", reject);
  });
  const lex: Lex = { mode: "normal", tag: "", depth: 0, meta: false };
  const rl = createInterface({ input, crlfDelay: Infinity });
  const reading = (async () => {
    let copy = false;
    for await (const line of rl) {
      if (copy) {
        if (line === "\\.") copy = false;
        continue;
      }
      if (lex.mode === "normal") {
        if (/^\\(?:un)?restrict [A-Za-z0-9]+$/.test(line)) continue;
        if (PG_COPY_START.test(line)) {
          copy = true;
          continue;
        }
      }
      lexLine(line, lex);
      if (lex.meta) return true;
    }
    return false;
  })();
  let unsafe: boolean;
  try {
    unsafe = await Promise.race([reading, failure]);
  } catch {
    throw new UploadFormatError("corrupt_gzip", "Não foi possível ler o arquivo até o fim (.gz corrompido ou cortado). Gere o dump de novo e envie outra vez.");
  } finally {
    rl.close();
    raw.destroy();
    input.destroy();
  }
  if (unsafe) {
    throw new UploadFormatError(
      "unsafe_sql",
      "O SQL tem comandos do cliente psql (linhas com barra invertida, como \\connect ou \\!), que o painel não executa por segurança. Gere o dump de novo sem eles (pg_dump sem -C) ou remova essas linhas.",
    );
  }
}
