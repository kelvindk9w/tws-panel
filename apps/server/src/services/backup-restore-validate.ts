/**
 * backup-restore-validate.ts — a parte que PROVA que um dump de banco restaura:
 * o dump é restaurado num banco DESCARTÁVEL criado no servidor de banco do
 * projeto de destino (nome `tws_rc_<id aleatório>`), com parada no primeiro erro,
 * e depois o painel confere que cada tabela do dump existe e que o número de
 * linhas bate com o do dump. O banco descartável é apagado no fim (também em
 * falha e em prazo estourado), e nada do banco real do destino é tocado: nem
 * tabelas, nem usuários, nem papéis.
 *
 * Neste lote só o PostgreSQL é suportado. MySQL, MariaDB e MongoDB ficam fora
 * (inelegíveis na interface e no servidor) até terem a mesma rigidez: o dump
 * deles leva todos os bancos do servidor e corpos de gatilhos/rotinas com o nome
 * do banco original, e o mongorestore tem de conferir também as falhas de
 * documento. Ver o relatório (proposta para um lote seguinte).
 *
 * Só o painel apaga o que o painel criou: o nome de cada banco descartável é
 * registrado de forma persistente ANTES do CREATE (o serviço guarda em
 * backups.json) e só os nomes registrados são apagados. Nunca se apaga por
 * padrão de nome: bancos reais chamados `tws_rc_...` do destino não são tocados.
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
import { PG_ENV } from "./backup-detect.js";

/** Códigos de falha que a validação devolve (o serviço os traduz em resultado). */
export type ValidationCode = "restore_failed" | "timeout" | "sanity_failed" | "cleanup_failed" | "backup_unreadable" | "destination_permission";

export class RestoreValidationError extends Error {
  constructor(readonly code: ValidationCode) {
    super(code);
  }
}

export interface ValidationResult {
  tables: number;
  /** Linhas conferidas: a soma das linhas dos blocos COPY do dump, iguais às do banco temporário. */
  rows: number;
}

/** Folga entre o prazo dentro do container (que mata a restauração) e o do cliente docker. */
const CLIENT_SLACK_MS = 30_000;

/** Prefixo do nome dos bancos descartáveis. */
export const TEMP_PREFIX = "tws_rc_";

/** Nome que o painel cria: prefixo + 16 hexadecimais aleatórios. Qualquer outro nome nunca é apagado. */
export function isTempName(name: string): boolean {
  return /^tws_rc_[0-9a-f]{16}$/.test(name);
}

// ---------------------------------------------------------------------------
// Scripts (rodam no container do banco, com `sh -c`)
// ---------------------------------------------------------------------------

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
    // $1 = nome do banco temporário (já registrado). Recusa se o usuário não pode criar bancos ou se o nome já existe.
    prepare: [
      "# tws-rc:postgres:prepare",
      PG_ENV,
      `[ "$(psql -U "$U" -d template1 -AtX -c "select rolsuper or rolcreatedb from pg_roles where rolname = current_user")" = "t" ] || { echo "tws-rc:no-permission" >&2; exit 8; }`,
      `[ "$(psql -U "$U" -d template1 -AtX -c "select count(*) from pg_database where datname = '$1'")" = "0" ] || { echo "tws-rc:exists" >&2; exit 9; }`,
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

export function restoreCheckScripts(engine: BackupDatabaseEngine) {
  return engine === "postgres" ? pgScripts() : null;
}

/**
 * Apaga UM banco temporário que o painel registrou (derruba as sessões e confirma
 * que sumiu). Recusa nomes que não tenham a forma que o painel cria.
 */
export async function dropTempDatabase(docker: BackupDocker, container: string, name: string): Promise<boolean> {
  if (!isTempName(name)) return false;
  return docker.execCapture(container, pgScripts().cleanup, [name]).then((o) => o.includes("GONE"), () => false);
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

/** Onde o leitor está no SQL: fora de tudo, ou dentro de um texto, identificador, corpo $tag$ ou comentário (que atravessam linhas). */
interface Lex {
  mode: "normal" | "single" | "escape" | "double" | "dollar" | "block";
  tag: string;
  depth: number;
}

const isWord = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_\u0080-￿]/.test(c);

/** Avança o leitor por uma linha. Textos entre aspas simples (com '' e E'\\'), identificadores entre aspas duplas, $tag$...$tag$ e comentários não confundem. */
function lexLine(line: string, st: Lex): void {
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    const next = line[i + 1];
    switch (st.mode) {
      case "normal":
        if (c === "-" && next === "-") return;
        if (c === "/" && next === "*") {
          st.mode = "block";
          st.depth = 1;
          i++;
        } else if (c === "'") {
          const prev = line[i - 1];
          st.mode = (prev === "E" || prev === "e") && !isWord(line[i - 2]) ? "escape" : "single";
        } else if (c === '"') st.mode = "double";
        else if (c === "$" && !isWord(line[i - 1])) {
          const m = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(line.slice(i));
          if (m) {
            st.mode = "dollar";
            st.tag = m[0];
            i += m[0].length - 1;
          }
        }
        break;
      case "single":
        if (c === "'") {
          if (next === "'") i++;
          else st.mode = "normal";
        }
        break;
      case "escape":
        if (c === "\\") i++;
        else if (c === "'") {
          if (next === "'") i++;
          else st.mode = "normal";
        }
        break;
      case "double":
        if (c === '"') {
          if (next === '"') i++;
          else st.mode = "normal";
        }
        break;
      case "dollar":
        if (c === "$" && line.startsWith(st.tag, i)) {
          st.mode = "normal";
          i += st.tag.length - 1;
        }
        break;
      case "block":
        if (c === "/" && next === "*") {
          st.depth++;
          i++;
        } else if (c === "*" && next === "/") {
          st.depth--;
          i++;
          if (st.depth === 0) st.mode = "normal";
        }
        break;
    }
  }
}

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
 * (bloco COPY), textos, identificadores e corpos de função passam intactos.
 */
export async function filterPostgresDump(inFile: string, outFile: string): Promise<PostgresScan> {
  const scan: PostgresScan = { tables: [], copyRows: new Map(), complete: false };
  const out = createWriteStream(outFile, { mode: 0o600 });
  const rl = createInterface({ input: createReadStream(inFile), crlfDelay: Infinity });
  const lex: Lex = { mode: "normal", tag: "", depth: 0 };
  let copy: string | null = null;
  try {
    for await (const line of rl) {
      if (copy !== null) {
        if (line === "\\.") copy = null;
        else scan.copyRows.set(copy, (scan.copyRows.get(copy) ?? 0) + 1);
        await writeLine(out, line);
        continue;
      }
      if (lex.mode === "normal") {
        if (line.startsWith("-- PostgreSQL database dump complete")) scan.complete = true;
        if (PG_DROPPED.some((re) => re.test(line))) {
          lexLine(line, lex);
          continue;
        }
        const c = PG_COPY.exec(line);
        if (c) {
          copy = c[1]!;
          scan.copyRows.set(copy, scan.copyRows.get(copy) ?? 0);
        } else {
          const t = PG_CREATE_TABLE.exec(line);
          if (t && !scan.tables.includes(t[1]!)) scan.tables.push(t[1]!);
        }
      }
      lexLine(line, lex);
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
  return `'${s.replace(/'/g, "''")}'`;
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
  /** Pasta própria do teste (arquivos filtrados e conferência). */
  workDir: string;
  /** Arquivo do dump do banco principal. */
  file: string;
  /** Identificador aleatório do teste (16 hexadecimais). */
  id: string;
  timeoutMs: number;
  /** Chamado ANTES do CREATE com o nome do banco temporário: o serviço o guarda de forma persistente. */
  register: (name: string) => Promise<void>;
  /** Chamado quando o banco temporário foi confirmado como apagado (ou nunca foi criado). */
  forget: (name: string) => Promise<void>;
}

/**
 * Restaura o dump num banco descartável do container do destino, confere e
 * apaga o banco descartável. Devolve o que foi conferido; qualquer falha vira
 * RestoreValidationError com um código (nunca texto do banco).
 */
export async function validateRestore(i: ValidateInput): Promise<ValidationResult> {
  const scripts = restoreCheckScripts(i.engine);
  if (!scripts || !/^[0-9a-f]{16}$/.test(i.id)) throw new RestoreValidationError("restore_failed");
  const secs = String(Math.max(1, Math.floor(i.timeoutMs / 1000)));
  const exec = { timeoutMs: i.timeoutMs + CLIENT_SLACK_MS };
  const d = i.docker;
  const name = `${TEMP_PREFIX}${i.id}`;

  const filtered = path.join(i.workDir, "dump-filtrado.sql");
  const scan = await filterPostgresDump(i.file, filtered).catch(() => {
    throw new RestoreValidationError("backup_unreadable");
  });
  if (!scan.complete || scan.tables.length === 0) throw new RestoreValidationError("sanity_failed");

  await i.register(name).catch(() => {
    throw new RestoreValidationError("restore_failed");
  });
  let result: ValidationResult | null = null;
  let failure: RestoreValidationError | null = null;
  /** Nome que já existia antes (nunca deveria): nada foi criado, então nada é apagado. */
  let untouched = false;
  try {
    try {
      await d.execCapture(i.container, scripts.prepare, [name]);
    } catch (err) {
      const text = messageOf(err);
      if (/tws-rc:no-permission/.test(text)) {
        untouched = true;
        throw new RestoreValidationError("destination_permission");
      }
      if (/tws-rc:exists/.test(text)) {
        untouched = true;
        throw new RestoreValidationError("restore_failed");
      }
      throw new RestoreValidationError("restore_failed");
    }
    try {
      await d.execFromFile(i.container, scripts.restore, [name, secs], filtered, exec);
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
    const out = await d.execFromFile(i.container, scripts.verify, [name], sqlFile, exec).catch(() => {
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
  } catch (err) {
    failure = err instanceof RestoreValidationError ? err : new RestoreValidationError("restore_failed");
  }
  if (untouched) await i.forget(name).catch(() => undefined);
  else {
    const gone = await dropTempDatabase(d, i.container, name);
    if (gone) await i.forget(name).catch(() => undefined);
    else failure = new RestoreValidationError("cleanup_failed");
  }
  if (failure) throw failure;
  return result!;
}
