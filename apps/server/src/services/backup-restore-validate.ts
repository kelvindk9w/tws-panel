/**
 * backup-restore-validate.ts — a parte que PROVA que um dump de banco restaura:
 * o dump é restaurado num banco DESCARTÁVEL criado no servidor de banco do
 * projeto de destino (nome `tws_rc_<id>`), com parada no primeiro erro, e depois
 * o painel confere que cada tabela do dump existe e que o número de linhas bate
 * com o do dump. O banco descartável é sempre apagado no fim (também em falha
 * e em prazo estourado), e nada do banco real do destino é tocado: nem tabelas,
 * nem usuários, nem papéis.
 *
 * O que sai daqui para o resto do painel são códigos e números (tabelas e
 * linhas conferidas); texto devolvido pelo banco nunca é repassado, porque
 * mensagens de erro podem citar valores de linhas.
 *
 * Cada passo é um script que roda DENTRO do container do banco (as credenciais
 * vêm das variáveis do próprio container, como no backup). A primeira linha de
 * cada script é um comentário `# tws-rc:<motor>:<passo>` que identifica o passo.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { BackupDatabaseEngine } from "@paas/core";
import type { BackupDocker } from "./backup-docker.js";
import { MY_ENV, PG_ENV, mongoEnv } from "./backup-detect.js";

/** Códigos de falha que a validação devolve (o serviço os traduz em resultado). */
export type ValidationCode = "restore_failed" | "timeout" | "sanity_failed" | "cleanup_failed" | "backup_unreadable";

export class RestoreValidationError extends Error {
  constructor(readonly code: ValidationCode) {
    super(code);
  }
}

export interface ValidationResult {
  tables: number;
  /** Linhas conferidas (Postgres e MongoDB: todas; MySQL/MariaDB: tabelas com dados não vazias). */
  rows: number;
}

/** Folga entre o prazo dentro do container (que mata a restauração) e o do cliente docker. */
const CLIENT_SLACK_MS = 30_000;

// ---------------------------------------------------------------------------
// Scripts (rodam no container do banco, com `sh -c`)
// ---------------------------------------------------------------------------

/** Prefixo do nome dos bancos descartáveis. */
export const TEMP_PREFIX = "tws_rc_";

/** `timeout` do container, quando existe: mata a restauração no prazo, mesmo que o cliente docker já tenha ido embora. */
const TMO = ['TMO=""', 'if command -v timeout >/dev/null 2>&1; then TMO="timeout -s KILL $RC_SECS"; fi'].join("\n");

const PG_DROP = [
  "rc_drop() {",
  `  psql -U "$U" -d template1 -AtX -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$1' and pid <> pg_backend_pid()" >/dev/null 2>&1`,
  `  psql -U "$U" -d template1 -X -q -c "drop database if exists \\"$1\\"" >/dev/null 2>&1`,
  "}",
].join("\n");

function pgScripts() {
  return {
    prepare: [
      "# tws-rc:postgres:prepare",
      PG_ENV,
      PG_DROP,
      // restos de testes anteriores (nome inteiramente nosso)
      `for d in $(psql -U "$U" -d template1 -AtX -c "select datname from pg_database where datname like 'tws\\_rc\\_%'" | grep -E '^tws_rc_[0-9a-f]+$'); do rc_drop "$d"; done`,
      'psql -U "$U" -d template1 -X -q -v ON_ERROR_STOP=1 -c "create database \\"$1\\""',
    ].join("\n"),
    restore: [
      "# tws-rc:postgres:restore",
      PG_ENV,
      'RC_SECS="$2"',
      TMO,
      "PGAPPNAME=tws-restore-check; export PGAPPNAME",
      'exec $TMO psql -U "$U" -d "$1" -X -q -v ON_ERROR_STOP=1',
    ].join("\n"),
    verify: ["# tws-rc:postgres:verify", PG_ENV, 'psql -U "$U" -d "$1" -AtX -q'].join("\n"),
    cleanup: [
      "# tws-rc:postgres:cleanup",
      PG_ENV,
      PG_DROP,
      "for k in 1 2 3; do",
      '  rc_drop "$1"',
      `  [ "$(psql -U "$U" -d template1 -AtX -c "select count(*) from pg_database where datname = '$1'")" = "0" ] && { echo GONE; exit 0; }`,
      "  sleep 1",
      "done",
      "echo LEFT; exit 1",
    ].join("\n"),
  };
}

function mysqlScripts() {
  const list = (like: string) => `$CLI -u"$U" -N -B -e "select schema_name from information_schema.schemata where schema_name like '${like}'"`;
  return {
    prepare: [
      "# tws-rc:mysql:prepare",
      MY_ENV,
      `for d in $(${list("tws\\\\_rc\\\\_%")} | grep -E '^tws_rc_[0-9a-f]+_[0-9]+$'); do $CLI -u"$U" -e "drop database if exists $d"; done`,
      '$CLI -u"$U" -e "select 1" >/dev/null',
    ].join("\n"),
    restore: ["# tws-rc:mysql:restore", MY_ENV, 'RC_SECS="$2"', TMO, 'exec $TMO $CLI -u"$U"'].join("\n"),
    verify: ["# tws-rc:mysql:verify", MY_ENV, '$CLI -u"$U" -N -B'].join("\n"),
    cleanup: [
      "# tws-rc:mysql:cleanup",
      MY_ENV,
      "for k in 1 2 3; do",
      `  for pid in $($CLI -u"$U" -N -B -e "select id from information_schema.processlist where db like 'tws\\\\_rc\\\\_$1\\\\_%' and id <> connection_id()"); do $CLI -u"$U" -e "kill $pid" >/dev/null 2>&1; done`,
      `  for d in $(${list("tws\\\\_rc\\\\_$1\\\\_%")} | grep -E '^tws_rc_[0-9a-f]+_[0-9]+$'); do $CLI -u"$U" -e "drop database if exists $d" >/dev/null 2>&1; done`,
      `  [ "$($CLI -u"$U" -N -B -e "select count(*) from information_schema.schemata where schema_name like 'tws\\\\_rc\\\\_$1\\\\_%'")" = "0" ] && { echo GONE; exit 0; }`,
      "  sleep 1",
      "done",
      "echo LEFT; exit 1",
    ].join("\n"),
  };
}

/** Cliente de shell do MongoDB e credenciais (a senha vai por variável de ambiente, nunca na linha de comando). */
const MONGO_SHELL = [
  'MU="${MONGO_INITDB_ROOT_USERNAME:-}"',
  'MP="${MONGO_INITDB_ROOT_PASSWORD:-}"',
  'if [ -z "$MP" ] && [ -n "${MONGO_INITDB_ROOT_PASSWORD_FILE:-}" ] && [ -r "$MONGO_INITDB_ROOT_PASSWORD_FILE" ]; then MP="$(cat "$MONGO_INITDB_ROOT_PASSWORD_FILE")"; fi',
  "export MU MP",
  "MSH=mongosh; command -v mongosh >/dev/null 2>&1 || MSH=mongo",
].join("\n");

const MONGO_JS_CONNECT = [
  'const cred = process.env.MU ? encodeURIComponent(process.env.MU) + ":" + encodeURIComponent(process.env.MP || "") + "@" : "";',
  'const conn = new Mongo("mongodb://" + cred + "127.0.0.1:27017/?authSource=admin");',
  'const names = () => conn.getDB("admin").adminCommand({ listDatabases: 1, nameOnly: true }).databases.map((d) => d.name).filter((n) => n.startsWith(process.env.RC_PREFIX));',
].join(" ");

function mongoScripts() {
  const shell = (js: string) => `${MONGO_SHELL}\nRC_PREFIX="$1"; export RC_PREFIX\n$MSH --nodb --quiet --eval '${js}'`;
  return {
    // $1 = prefixo (tws_rc_ para varrer restos de testes anteriores)
    cleanup: [
      "# tws-rc:mongo:cleanup",
      shell(`${MONGO_JS_CONNECT} names().forEach((n) => conn.getDB(n).dropDatabase()); const left = names().length; print(left === 0 ? "GONE" : "LEFT"); quit(left === 0 ? 0 : 1);`),
    ].join("\n"),
    // $1 = id, $2 = segundos, $3 = banco do projeto (opcional)
    restore: [
      "# tws-rc:mongo:restore",
      'RC_ID="$1"; RC_SECS="$2"; RC_DB="${3:-}"',
      mongoEnv("mongorestore"),
      TMO,
      "set -- \"$@\" --nsExclude 'admin.*' --nsExclude 'config.*' --nsExclude 'local.*'",
      'if [ -n "$RC_DB" ]; then set -- "$@" --nsInclude "$RC_DB.*"; fi',
      `$TMO mongorestore --archive --nsFrom '$db$.$coll$' --nsTo "${TEMP_PREFIX}\${RC_ID}_\\$db\\$.\\$coll\\$" "$@"`,
    ].join("\n"),
    // $1 = prefixo do teste; imprime D|banco|colecoes|documentos
    verify: [
      "# tws-rc:mongo:verify",
      shell(
        `${MONGO_JS_CONNECT} names().forEach((n) => { const d = conn.getDB(n); const cs = d.getCollectionInfos({ type: "collection" }).map((c) => c.name); let docs = 0; cs.forEach((c) => { docs += d.getCollection(c).countDocuments({}); }); print("D|" + n + "|" + cs.length + "|" + docs); });`,
      ),
    ].join("\n"),
  };
}

export function restoreCheckScripts(engine: BackupDatabaseEngine) {
  if (engine === "postgres") return pgScripts();
  if (engine === "mysql" || engine === "mariadb") return mysqlScripts();
  if (engine === "mongo") return mongoScripts();
  return null;
}

// ---------------------------------------------------------------------------
// Leitura do dump (uma passada, linha a linha)
// ---------------------------------------------------------------------------

async function writeLine(out: ReturnType<typeof createWriteStream>, line: string): Promise<void> {
  if (!out.write(`${line}\n`)) await once(out, "drain");
}

async function closeStream(out: ReturnType<typeof createWriteStream>): Promise<void> {
  out.end();
  await once(out, "close");
}

const IDENT_PART = '(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)';
const QUALIFIED = `${IDENT_PART}(?:\\.${IDENT_PART})?`;
const PG_CREATE_TABLE = new RegExp(`^CREATE (?:UNLOGGED )?TABLE (?:IF NOT EXISTS )?(${QUALIFIED})(?:\\s|\\()`);
const PG_COPY = new RegExp(`^COPY (${QUALIFIED}) (?:\\(.*\\) )?FROM stdin;$`);
/** O que não faz sentido num banco descartável: donos e permissões de papéis que podem nem existir neste servidor. */
const PG_DROPPED = [/^ALTER .* OWNER TO .+;$/, /^(GRANT|REVOKE) .*;$/, /^ALTER DEFAULT PRIVILEGES .*;$/];

export interface PostgresScan {
  /** Tabelas que o dump cria (identificador como está no dump). */
  tables: string[];
  /** Tabelas com bloco COPY e quantas linhas o dump leva para cada uma. */
  copyRows: Map<string, number>;
  /** O dump termina com a marca do pg_dump (não foi cortado). */
  complete: boolean;
}

/**
 * Copia o dump do Postgres para `outFile` sem os donos e as permissões (e só
 * isso) e devolve o que o dump promete: tabelas e linhas. Linhas de dados
 * (bloco COPY) e corpos de função ($$...$$) passam intactos.
 */
export async function filterPostgresDump(inFile: string, outFile: string): Promise<PostgresScan> {
  const scan: PostgresScan = { tables: [], copyRows: new Map(), complete: false };
  const out = createWriteStream(outFile, { mode: 0o600 });
  const rl = createInterface({ input: createReadStream(inFile), crlfDelay: Infinity });
  let copy: string | null = null;
  let dollar: string | null = null;
  try {
    for await (const line of rl) {
      if (copy !== null) {
        if (line === "\\.") copy = null;
        else scan.copyRows.set(copy, (scan.copyRows.get(copy) ?? 0) + 1);
        await writeLine(out, line);
        continue;
      }
      if (dollar === null) {
        if (line.startsWith("-- PostgreSQL database dump complete")) scan.complete = true;
        if (PG_DROPPED.some((re) => re.test(line))) continue;
        const c = PG_COPY.exec(line);
        if (c) {
          copy = c[1]!;
          scan.copyRows.set(copy, scan.copyRows.get(copy) ?? 0);
        } else {
          const t = PG_CREATE_TABLE.exec(line);
          if (t && !scan.tables.includes(t[1]!)) scan.tables.push(t[1]!);
        }
      }
      for (const m of line.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)?\$/g)) {
        if (dollar === null) dollar = m[0];
        else if (m[0] === dollar) dollar = null;
      }
      await writeLine(out, line);
    }
  } finally {
    rl.close();
    await closeStream(out);
  }
  return scan;
}

export interface MysqlDb {
  original: string;
  temp: string;
  tables: string[];
  /** Tabelas para as quais o dump traz INSERT (precisam ter linhas depois). */
  withData: string[];
}

export interface MysqlScan {
  dbs: MysqlDb[];
  complete: boolean;
}

const MY_MARKER = /^-- Current Database: `([^`]+)`/;
const MY_CREATE_TABLE = /^CREATE TABLE (?:IF NOT EXISTS )?`([^`]+)`/;
const MY_VIEW = /^\/\*!50001 CREATE (?:ALGORITHM=\S+ )?VIEW `([^`]+)`/;
const MY_INSERT = /^INSERT INTO `([^`]+)`/;
const MY_DEFINER = /DEFINER\s*=\s*`[^`]*`@`[^`]*`/g;

/**
 * Copia para `outFile` só o banco do projeto (`only`; sem ele, todos os do
 * dump), com o nome trocado para um banco descartável e sem DEFINER (o usuário
 * dono pode não existir no destino). O restante do servidor do destino (outros
 * bancos, mysql.user, tabelas de sistema) nem aparece no arquivo.
 */
export async function filterMysqlDump(inFile: string, outFile: string, id: string, only: string | null): Promise<MysqlScan> {
  const scan: MysqlScan = { dbs: [], complete: false };
  const out = createWriteStream(outFile, { mode: 0o600 });
  const rl = createInterface({ input: createReadStream(inFile), crlfDelay: Infinity });
  let current: MysqlDb | null = null;
  let skipping = false;
  try {
    for await (const raw of rl) {
      if (raw.startsWith("-- Dump completed")) scan.complete = true;
      const marker = MY_MARKER.exec(raw);
      if (marker) {
        const name = marker[1]!;
        skipping = only !== null && name !== only;
        // o mesmo banco aparece de novo mais adiante (para as views): continua no mesmo descartável
        current = skipping ? null : (scan.dbs.find((d) => d.original === name) ?? { original: name, temp: `${TEMP_PREFIX}${id}_${scan.dbs.length}`, tables: [], withData: [] });
        if (current && !scan.dbs.includes(current)) scan.dbs.push(current);
        if (skipping) continue;
        await writeLine(out, `-- Current Database: \`${current!.temp}\``);
        continue;
      }
      if (skipping) continue;
      const line = raw.replace(MY_DEFINER, "");
      if (current) {
        if (/^\/\*!?\d* ?DROP DATABASE IF EXISTS/.test(line) || /^\/\*!40000 DROP DATABASE IF EXISTS/.test(line)) continue;
        if (/^CREATE DATABASE /.test(line) || /^USE `/.test(line)) {
          await writeLine(out, line.replace(`\`${current.original}\``, `\`${current.temp}\``));
          continue;
        }
        const t = MY_CREATE_TABLE.exec(line) ?? MY_VIEW.exec(line);
        if (t && !current.tables.includes(t[1]!)) current.tables.push(t[1]!);
        const ins = MY_INSERT.exec(line);
        if (ins && !current.withData.includes(ins[1]!)) current.withData.push(ins[1]!);
      }
      await writeLine(out, line);
    }
  } finally {
    rl.close();
    await closeStream(out);
  }
  return scan;
}

// ---------------------------------------------------------------------------
// Orquestração
// ---------------------------------------------------------------------------

function sqlLiteral(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : "";
}

/** Prazo estourado: o cliente docker foi interrompido ou o `timeout` do container matou o comando (código 137). */
function isTimeout(err: unknown): boolean {
  return /prazo|código 137/.test(messageOf(err));
}

export interface ValidateInput {
  docker: BackupDocker;
  container: string;
  engine: BackupDatabaseEngine;
  /** Pasta com os dumps extraídos. */
  content: string;
  /** Pasta própria do teste (arquivos filtrados e conferência). */
  workDir: string;
  /** Postgres: arquivo do dump do banco principal. MySQL/MariaDB/MongoDB: o arquivo do item. */
  file: string;
  /** Nome do banco do projeto, quando se sabe (MySQL/MariaDB e MongoDB restauram só ele). */
  databaseName: string | null;
  /** Identificador do teste (hexadecimal, 8 caracteres). */
  id: string;
  timeoutMs: number;
}

/**
 * Restaura o dump num banco descartável do container do destino, confere e
 * apaga o banco descartável. Devolve o que foi conferido; qualquer falha vira
 * RestoreValidationError com um código (nunca texto do banco).
 */
export async function validateRestore(i: ValidateInput): Promise<ValidationResult> {
  if (!/^[0-9a-f]{8}$/.test(i.id)) throw new RestoreValidationError("restore_failed");
  const scripts = restoreCheckScripts(i.engine);
  if (!scripts) throw new RestoreValidationError("restore_failed");
  const secs = String(Math.max(1, Math.floor(i.timeoutMs / 1000)));
  const exec = { timeoutMs: i.timeoutMs + CLIENT_SLACK_MS };
  const d = i.docker;
  let result: ValidationResult | null = null;
  let failure: RestoreValidationError | null = null;
  const prefix = `${TEMP_PREFIX}${i.id}`;
  /** Nome dos bancos a apagar no fim: pelo prefixo do teste, o que cobre também o que foi criado pela metade. */
  const cleanupArgs = i.engine === "postgres" ? [prefix] : i.engine === "mongo" ? [`${prefix}_`] : [i.id];
  let started = false;
  try {
    if (i.engine === "postgres") {
      const filtered = path.join(i.workDir, "dump-filtrado.sql");
      const scan = await filterPostgresDump(i.file, filtered).catch(() => {
        throw new RestoreValidationError("backup_unreadable");
      });
      if (!scan.complete || scan.tables.length === 0) throw new RestoreValidationError("sanity_failed");
      started = true;
      await d.execCapture(i.container, (scripts as ReturnType<typeof pgScripts>).prepare, [prefix]).catch(() => {
        throw new RestoreValidationError("restore_failed");
      });
      try {
        await d.execFromFile(i.container, (scripts as ReturnType<typeof pgScripts>).restore, [prefix, secs], filtered, exec);
      } catch (err) {
        throw new RestoreValidationError(isTimeout(err) ? "timeout" : "restore_failed");
      }
      const sql = [
        `select 'T', count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p') and n.nspname !~ '^pg_' and n.nspname <> 'information_schema';`,
        ...scan.tables.map((t, n) => `select 'E', ${n}, to_regclass(${sqlLiteral(t)}) is not null;`),
        ...[...scan.copyRows.keys()].map((t, n) => `select 'R', ${n}, count(*) from only ${t};`),
      ].join("\n");
      const sqlFile = path.join(i.workDir, "conferir.sql");
      await writeFile(sqlFile, sql, { mode: 0o600 });
      const out = await d.execFromFile(i.container, (scripts as ReturnType<typeof pgScripts>).verify, [prefix], sqlFile, exec).catch(() => {
        throw new RestoreValidationError("sanity_failed");
      });
      const lines = (out.stdout ?? "").split("\n").map((l) => l.trim().split("|"));
      const exists = new Set(lines.filter((l) => l[0] === "E" && l[2] === "t").map((l) => Number(l[1])));
      const counts = new Map(lines.filter((l) => l[0] === "R").map((l) => [Number(l[1]), Number(l[2])]));
      const total = lines.find((l) => l[0] === "T");
      if (!total || !(Number(total[1]) >= scan.tables.length)) throw new RestoreValidationError("sanity_failed");
      if (scan.tables.some((_, n) => !exists.has(n))) throw new RestoreValidationError("sanity_failed");
      let rows = 0;
      for (const [n, expected] of [...scan.copyRows.values()].entries()) {
        if (counts.get(n) !== expected) throw new RestoreValidationError("sanity_failed");
        rows += expected;
      }
      result = { tables: scan.tables.length, rows };
    } else if (i.engine === "mysql" || i.engine === "mariadb") {
      const s = scripts as ReturnType<typeof mysqlScripts>;
      const filtered = path.join(i.workDir, "dump-filtrado.sql");
      const scan = await filterMysqlDump(i.file, filtered, i.id, i.databaseName).catch(() => {
        throw new RestoreValidationError("backup_unreadable");
      });
      const tables = scan.dbs.reduce((n, db) => n + db.tables.length, 0);
      if (!scan.complete || tables === 0) throw new RestoreValidationError("sanity_failed");
      started = true;
      await d.execCapture(i.container, s.prepare, []).catch(() => {
        throw new RestoreValidationError("restore_failed");
      });
      try {
        await d.execFromFile(i.container, s.restore, [i.id, secs], filtered, exec);
      } catch (err) {
        throw new RestoreValidationError(isTimeout(err) ? "timeout" : "restore_failed");
      }
      const queries: string[] = [];
      const index: Array<{ kind: "E" | "R" }> = [];
      for (const db of scan.dbs) {
        for (const t of db.tables) {
          queries.push(`select 'E', ${index.length}, count(*) from information_schema.tables where table_schema = ${sqlLiteral(db.temp)} and table_name = ${sqlLiteral(t)};`);
          index.push({ kind: "E" });
        }
        for (const t of db.withData) {
          queries.push(`select 'R', ${index.length}, exists(select 1 from \`${db.temp}\`.\`${t.replace(/`/g, "``")}\`);`);
          index.push({ kind: "R" });
        }
      }
      const sqlFile = path.join(i.workDir, "conferir.sql");
      await writeFile(sqlFile, queries.join("\n"), { mode: 0o600 });
      const out = await d.execFromFile(i.container, s.verify, [], sqlFile, exec).catch(() => {
        throw new RestoreValidationError("sanity_failed");
      });
      const got = new Map((out.stdout ?? "").split("\n").map((l) => l.trim().split("\t")).filter((l) => l.length === 3).map((l) => [Number(l[1]), l[2]!]));
      if (index.some((_, n) => got.get(n) !== "1")) throw new RestoreValidationError("sanity_failed");
      result = { tables, rows: scan.dbs.reduce((n, db) => n + db.withData.length, 0) };
    } else {
      const s = scripts as ReturnType<typeof mongoScripts>;
      started = true;
      await d.execCapture(i.container, s.cleanup, [TEMP_PREFIX]).catch(() => {
        throw new RestoreValidationError("restore_failed");
      });
      let restored: { stderr: string };
      try {
        restored = await d.execFromFile(i.container, s.restore, [i.id, secs, i.databaseName ?? ""], i.file, exec);
      } catch (err) {
        throw new RestoreValidationError(isTimeout(err) ? "timeout" : "restore_failed");
      }
      const out = await d.execCapture(i.container, s.verify, [`${prefix}_`]).catch(() => {
        throw new RestoreValidationError("sanity_failed");
      });
      const dbs = out.split("\n").map((l) => l.trim().split("|")).filter((l) => l[0] === "D" && l.length === 4);
      const collections = dbs.reduce((n, l) => n + Number(l[2]), 0);
      const docs = dbs.reduce((n, l) => n + Number(l[3]), 0);
      const said = /(\d+) document\(s\) restored successfully/.exec(restored.stderr);
      if (collections === 0 || !said || Number(said[1]) !== docs) throw new RestoreValidationError("sanity_failed");
      result = { tables: collections, rows: docs };
    }
  } catch (err) {
    failure = err instanceof RestoreValidationError ? err : new RestoreValidationError("restore_failed");
  } finally {
    if (started) {
      const gone = await d.execCapture(i.container, scripts.cleanup, cleanupArgs).then((o) => o.includes("GONE"), () => false);
      if (!gone) failure = new RestoreValidationError("cleanup_failed");
    }
  }
  if (failure) throw failure;
  return result!;
}
