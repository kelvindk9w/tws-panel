/**
 * upload-restore-format.ts — "Restaurar de um arquivo": o que o arquivo enviado É, conferido pelos primeiros bytes
 * (a extensão não decide nada), e se serve ao motor do banco escolhido. Também a leitura que prova que um .gz abre até
 * o fim e que um SQL do PostgreSQL ou do MySQL não leva comandos do cliente (psql com barra invertida, mysql \!, system,
 * source... rodariam um shell dentro do container do banco).
 *
 * Nada aqui guarda nem devolve o CONTEÚDO do arquivo: só o formato, um motor provável e códigos de erro.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants as zlibConstants, createGunzip, gunzipSync } from "node:zlib";
import type { BackupDatabaseEngine, UploadRestoreFormat } from "@paas/core";
import { PG_COPY, lexLine, type Lex } from "./backup-restore-validate.js";

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
  | "unsafe_sql"
  | "multi_database";

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

const UNREADABLE = "Não foi possível ler o arquivo até o fim (.gz corrompido ou cortado). Gere o dump de novo e envie outra vez.";

/**
 * Lê o arquivo (descompactando se for .gz) linha a linha, sem guardá-lo, e para na primeira linha em que `visit` devolve
 * algo. Ler até o fim também prova que o .gz abre inteiro.
 */
async function scanLines<T>(file: string, gzip: boolean, visit: (line: string) => T | undefined): Promise<T | undefined> {
  const raw = createReadStream(file);
  const input = gzip ? raw.pipe(createGunzip()) : raw;
  const failure = new Promise<never>((_resolve, reject) => {
    raw.on("error", reject);
    if (gzip) input.on("error", reject);
  });
  const rl = createInterface({ input, crlfDelay: Infinity });
  const reading = (async (): Promise<T | undefined> => {
    for await (const line of rl) {
      const found = visit(line);
      if (found !== undefined) return found;
    }
    return undefined;
  })();
  try {
    return await Promise.race([reading, failure]);
  } catch {
    throw new UploadFormatError("corrupt_gzip", UNREADABLE);
  } finally {
    rl.close();
    raw.destroy();
    input.destroy();
  }
}

/**
 * SQL do PostgreSQL com comando do cliente psql (barra invertida fora de texto, comentário e bloco COPY)? Só `\restrict`/`\unrestrict` do pg_dump recente passam. O bloco COPY só
 * começa numa linha que é de fato `COPY tabela (colunas) FROM stdin;` e em que o leitor termina fora de texto e de
 * comentário: qualquer outra coisa continua sendo lida como comando (um `-- FROM stdin;` não esconde o resto do arquivo).
 */
export async function scanPostgresSql(file: string, gzip: boolean): Promise<void> {
  const lex: Lex = { mode: "normal", tag: "", depth: 0, meta: false };
  let copy = false;
  const unsafe = await scanLines(file, gzip, (line) => {
    if (copy) {
      if (line === "\\.") copy = false;
      return undefined;
    }
    const startsCopy = lex.mode === "normal" && PG_COPY.test(line);
    if (lex.mode === "normal" && /^\\(?:un)?restrict [A-Za-z0-9]+$/.test(line)) return undefined;
    lexLine(line, lex);
    if (lex.meta) return true;
    if (startsCopy && lex.mode === "normal") copy = true;
    return undefined;
  });
  if (unsafe) {
    throw new UploadFormatError(
      "unsafe_sql",
      "O SQL tem comandos do cliente psql (linhas com barra invertida, como \\connect ou \\!), que o painel não executa por segurança. Gere o dump de novo sem eles (pg_dump sem -C) ou remova essas linhas.",
    );
  }
}

/** Comandos do CLIENTE mysql: \! e system rodam um shell; source e \. leem outro arquivo; pager/tee/edit rodam programas. */
const MYSQL_CLIENT_COMMAND = /^\s*(?:\\[!.PTe]|(?:system|source|pager|tee|edit)(?:\s|;|$))/i;
/** O dump muda de banco ou cria/apaga bancos (mysqldump --databases / --all-databases). */
const MYSQL_DB_SWITCH = /^\s*(?:USE\s|(?:CREATE|DROP)\s+(?:DATABASE|SCHEMA)\b|\/\*!\d+\s+(?:CREATE|DROP)\s+(?:DATABASE|SCHEMA)\b)/i;
/** Mexe em contas ou nas tabelas dos bancos de sistema (mysql, sys, information_schema, performance_schema). */
const MYSQL_SYSTEM =
  /^\s*(?:(?:GRANT|REVOKE|CREATE\s+USER|ALTER\s+USER|DROP\s+USER|RENAME\s+USER|SET\s+PASSWORD)\b|(?:INSERT\s+(?:IGNORE\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE|LOCK\s+TABLES|TRUNCATE(?:\s+TABLE)?)\s+`?(?:mysql|sys|information_schema|performance_schema)`?\s*\.)/i;

/**
 * Dump de MySQL/MariaDB sem comandos do cliente (o `mysql` os executaria dentro do container), sem troca de banco e sem
 * mexer nos bancos de sistema. Lê o arquivo inteiro, linha a linha.
 */
export async function scanMysqlSql(file: string, gzip: boolean): Promise<void> {
  const found = await scanLines<"client" | "switch" | "system">(file, gzip, (line) => {
    if (MYSQL_CLIENT_COMMAND.test(line)) return "client";
    if (MYSQL_DB_SWITCH.test(line)) return "switch";
    if (MYSQL_SYSTEM.test(line)) return "system";
    return undefined;
  });
  if (found === "client") {
    throw new UploadFormatError(
      "unsafe_sql",
      "O SQL tem comandos do cliente mysql (linhas que começam com \\!, \\., system, source, pager, tee ou edit), que o painel não executa por segurança. Gere o dump de novo ou remova essas linhas.",
    );
  }
  if (found === "switch") {
    throw new UploadFormatError(
      "multi_database",
      "O dump troca ou cria bancos (USE, CREATE DATABASE): o painel restaura num banco só, o escolhido. Gere o dump de um único banco, com mysqldump NOME_DO_BANCO (sem --databases nem --all-databases).",
    );
  }
  if (found === "system") {
    throw new UploadFormatError("unsafe_sql", "O dump mexe em contas de usuário ou nos bancos de sistema (mysql, sys, information_schema, performance_schema), o que o painel não restaura. Gere o dump só do banco da sua aplicação.");
  }
}

/** Bancos que o MongoDB não deve receber de um arquivo (mongorestore --nsExclude). */
export const MONGO_SYSTEM_DATABASES = ["admin", "config", "local"] as const;

/**
 * Nomes de banco que um arquivo `mongodump --archive` traz, lidos dos documentos de metadados (campo BSON `db`, texto).
 * Lê o arquivo inteiro (descompactando o .gz de fora), em blocos. Um campo `db` nos DADOS pode aparecer como nome extra:
 * por isso o resultado só serve para decidir se há um banco só (com mais de um, o painel não renomeia nada).
 */
export async function scanMongoDatabases(file: string, gzip: boolean): Promise<string[]> {
  const raw = createReadStream(file);
  const input = gzip ? raw.pipe(createGunzip()) : raw;
  const names = new Set<string>();
  const KEY = Buffer.from([0x02, 0x64, 0x62, 0x00]); // tipo texto, "db", fim do nome
  let carry: Buffer = Buffer.alloc(0);
  try {
    await pipeline(
      input,
      new Writable({
        write: (chunk: Buffer, _enc, cb) => {
          const buf = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
          let from = 0;
          let keep = buf.length;
          for (;;) {
            const at = buf.indexOf(KEY, from);
            if (at < 0) {
              keep = Math.max(from, buf.length - KEY.length + 1);
              break;
            }
            if (at + 8 > buf.length) {
              keep = at;
              break;
            }
            const len = buf.readInt32LE(at + 4);
            if (len > 0 && len <= 128) {
              if (at + 8 + len > buf.length) {
                keep = at;
                break;
              }
              const name = buf.subarray(at + 8, at + 8 + len - 1).toString("utf8");
              if (buf[at + 8 + len - 1] === 0 && /^[A-Za-z0-9_-]{1,64}$/.test(name) && names.size < 64) names.add(name);
            }
            from = at + KEY.length;
          }
          carry = Buffer.from(buf.subarray(keep));
          cb();
        },
      }),
    );
  } catch {
    throw new UploadFormatError("corrupt_gzip", UNREADABLE);
  }
  return [...names];
}
