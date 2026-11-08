/**
 * backup-restore-validate.ts — a parte que PROVA que um backup de banco
 * restaura: o dump é restaurado numa cópia DESCARTÁVEL, um container novo da
 * MESMA imagem do banco do projeto (o id da imagem em uso), e depois o painel
 * confere o que foi restaurado.
 *
 * O container descartável:
 *  - não tem rede (`--network none`) nem nenhum volume ou pasta do projeto;
 *    os dados dele ficam num volume anônimo, removido junto com ele;
 *  - tem limite de memória (sem swap extra), de CPU e de processos, e nunca
 *    baixa imagem (`--pull never`): usa a que o projeto já roda;
 *  - sobe sem senha (só o próprio container fala com o banco, pelo socket
 *    local): nenhuma credencial do projeto entra nele;
 *  - leva o rótulo `tws.restore-check=1` e um nome `tws-rc-<16 hexadecimais>`
 *    REGISTRADO de forma persistente ANTES de ser criado; ele é removido no fim
 *    (também em falha e em prazo estourado) e a remoção é CONFIRMADA. Só um
 *    container com o rótulo é removido.
 *
 * O que é conferido, por motor:
 *  - PostgreSQL: o dump termina com a marca do pg_dump; a restauração para no
 *    primeiro erro (ON_ERROR_STOP); cada tabela do dump existe e cada tabela
 *    com COPY tem exatamente as linhas do dump. Os papéis (globals) vão antes,
 *    sem parar em "já existe"; dono e permissões são tirados do dump.
 *  - MySQL/MariaDB: o dump termina com a marca do mysqldump; a restauração
 *    para no primeiro erro (padrão do cliente); há pelo menos tantas tabelas
 *    quanto o dump cria.
 *  - MongoDB: o mongorestore não pode ter documento que falhou; há coleções, e
 *    o total de documentos bate com o que o mongorestore diz ter restaurado.
 * Banco sem nenhuma tabela: "empty_database" (não há o que provar).
 *
 * O que sai daqui para o resto do painel são códigos e números; texto
 * devolvido pelo banco nunca é repassado, porque mensagens de erro podem
 * citar valores de linhas.
 *
 * LEGADO: versões anteriores criavam um banco temporário `tws_rc_<id>` no
 * servidor de banco de OUTRO projeto. `dropTempDatabase` continua aqui só para
 * a varredura apagar o que uma versão antiga deixou registrado.
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
export type ValidationCode =
  | "restore_failed"
  | "timeout"
  | "sanity_failed"
  | "cleanup_failed"
  | "backup_unreadable"
  | "unsafe_dump"
  | "empty_database"
  | "image_unavailable"
  | "sandbox_failed";

export class RestoreValidationError extends Error {
  constructor(readonly code: ValidationCode) {
    super(code);
  }
}

export interface ValidationResult {
  /** Tabelas (ou coleções) restauradas. */
  tables: number;
  /** Linhas (ou documentos) conferidas; null quando o motor não permite comparar com o dump. */
  rows: number | null;
}

/** Prefixo do nome dos containers descartáveis. */
export const SANDBOX_PREFIX = "tws-rc-";

/** Nome que o painel cria: prefixo + 16 hexadecimais aleatórios. Qualquer outro nome nunca é removido. */
export function isSandboxName(name: string): boolean {
  return /^tws-rc-[0-9a-f]{16}$/.test(name);
}

/** Banco onde o dump do Postgres é restaurado dentro do container descartável. */
const PG_DB = "tws_restore_check";

/** Motores que sobem no container descartável. */
export type SandboxEngine = Exclude<BackupDatabaseEngine, "redis">;

// ---------------------------------------------------------------------------
// Scripts (rodam no container descartável, com `sh -c`)
// ---------------------------------------------------------------------------

const MY_CLI = "if command -v mariadb >/dev/null 2>&1; then CLI=mariadb; else CLI=mysql; fi";
const MONGO_SH = "if command -v mongosh >/dev/null 2>&1; then SH=mongosh; else SH=mongo; fi";

const MONGO_COUNT = [
  "var c = 0, d = 0;",
  "db.adminCommand({ listDatabases: 1 }).databases.forEach(function (x) {",
  '  if (["admin", "local", "config"].indexOf(x.name) >= 0) return;',
  "  var s = db.getSiblingDB(x.name);",
  "  s.getCollectionNames().forEach(function (n) {",
  '    if (n.indexOf("system.") === 0) return;',
  "    c++;",
  "    d += s.getCollection(n).estimatedDocumentCount();",
  "  });",
  "});",
  'print("T|" + c + "|" + d);',
].join(" ");

export interface SandboxScripts {
  /** Variáveis do container (sem senha: ele não tem rede). */
  env: Record<string, string>;
  /** Imprime TWS-READY quando o servidor DEFINITIVO está de pé (não o temporário do script de início da imagem). */
  ready: string;
  /** Postgres: papéis do backup (stdin), sem parar em "já existe". */
  globals?: string;
  /** Restaura o dump (stdin), parando no primeiro erro. */
  restore: string;
  /** Conferência: imprime linhas `T|...` (e, no Postgres, `E|...` e `R|...`). Postgres lê o SQL do stdin. */
  verify: string;
}

export function sandboxScripts(engine: SandboxEngine): SandboxScripts {
  switch (engine) {
    case "postgres":
      return {
        env: { POSTGRES_HOST_AUTH_METHOD: "trust", ALLOW_EMPTY_PASSWORD: "yes" },
        // o servidor temporário do script de início da imagem não escuta em rede (listen_addresses vazio); o definitivo escuta
        ready: [
          "# tws-rc:postgres:ready",
          'L="$(psql -U postgres -d postgres -AtX -c "show listen_addresses" 2>/dev/null)" || exit 0',
          '[ -n "$L" ] && echo TWS-READY',
          "exit 0",
        ].join("\n"),
        globals: ["# tws-rc:postgres:globals", "psql -U postgres -d postgres -X -q >/dev/null 2>&1", "exit 0"].join("\n"),
        restore: [
          "# tws-rc:postgres:restore",
          `createdb -U postgres ${PG_DB} || exit 1`,
          `exec psql -U postgres -d ${PG_DB} -X -q -v ON_ERROR_STOP=1`,
        ].join("\n"),
        verify: ["# tws-rc:postgres:verify", `psql -U postgres -d ${PG_DB} -AtX -q`].join("\n"),
      };
    case "mysql":
    case "mariadb":
      return {
        env: { MYSQL_ALLOW_EMPTY_PASSWORD: "yes", MARIADB_ALLOW_EMPTY_ROOT_PASSWORD: "1", ALLOW_EMPTY_PASSWORD: "yes" },
        // o servidor temporário do script de início roda com --skip-networking; o definitivo não
        ready: [
          `# tws-rc:${engine}:ready`,
          MY_CLI,
          `[ "$($CLI -uroot -N -B -e 'select @@skip_networking' 2>/dev/null)" = "0" ] && echo TWS-READY`,
          "exit 0",
        ].join("\n"),
        restore: [`# tws-rc:${engine}:restore`, MY_CLI, 'exec $CLI -uroot'].join("\n"),
        verify: [
          `# tws-rc:${engine}:verify`,
          MY_CLI,
          `$CLI -uroot -N -B -e "select concat('T|', count(*)) from information_schema.tables where table_schema not in ('mysql','information_schema','performance_schema','sys')"`,
        ].join("\n"),
      };
    case "mongo":
      return {
        env: { ALLOW_EMPTY_PASSWORD: "yes" },
        ready: ["# tws-rc:mongo:ready", MONGO_SH, `[ "$($SH --quiet --eval 'db.adminCommand({ ping: 1 }).ok' 2>/dev/null)" = "1" ] && echo TWS-READY`, "exit 0"].join("\n"),
        restore: ["# tws-rc:mongo:restore", "exec mongorestore --archive --drop"].join("\n"),
        verify: ["# tws-rc:mongo:verify", MONGO_SH, `$SH --quiet --eval '${MONGO_COUNT}'`].join("\n"),
      };
  }
}

// ---------------------------------------------------------------------------
// LEGADO: banco temporário no servidor de outro projeto (versões anteriores)
// ---------------------------------------------------------------------------

/** Prefixo do nome dos bancos temporários das versões anteriores. */
export const TEMP_PREFIX = "tws_rc_";

/** Nome que uma versão anterior do painel criou: prefixo + 16 hexadecimais. Qualquer outro nome nunca é apagado. */
export function isTempName(name: string): boolean {
  return /^tws_rc_[0-9a-f]{16}$/.test(name);
}

const PG_LEGACY_CLEANUP = [
  "# tws-rc:postgres:cleanup",
  PG_ENV,
  "rc_exists() {",
  `  psql -U "$U" -d template1 -AtX -c "select (select count(*) from pg_database where datname = '$1') + (select count(*) from pg_roles where rolname = '$1')"`,
  "}",
  "rc_drop() {",
  `  psql -U "$U" -d template1 -AtX -c "select pg_terminate_backend(pid) from pg_stat_activity where (datname = '$1' or usename = '$1') and pid <> pg_backend_pid()" >/dev/null 2>&1`,
  `  psql -U "$U" -d template1 -X -q -c "drop database if exists \\"$1\\"" >/dev/null 2>&1`,
  `  if [ "$(psql -U "$U" -d template1 -AtX -c "select count(*) from pg_roles where rolname = '$1'")" != "0" ]; then`,
  `    psql -U "$U" -d template1 -X -q -c "drop role if exists \\"$1\\"" >/dev/null 2>&1 || {`,
  `      for d in $(psql -U "$U" -d template1 -AtX -c "select datname from pg_database where datallowconn and datname <> 'template0'"); do`,
  `        psql -U "$U" -d "$d" -X -q -c "drop owned by \\"$1\\"" >/dev/null 2>&1`,
  "      done",
  `      psql -U "$U" -d template1 -X -q -c "drop role if exists \\"$1\\"" >/dev/null 2>&1`,
  "    }",
  "  fi",
  "}",
  "for k in 1 2 3; do",
  '  rc_drop "$1"',
  '  [ "$(rc_exists "$1")" = "0" ] && { echo GONE; exit 0; }',
  "  sleep 1",
  "done",
  "echo LEFT; exit 1",
].join("\n");

/**
 * Apaga UM banco temporário (e o papel de mesmo nome) que uma versão anterior
 * do painel registrou no servidor de outro projeto, e confirma que sumiu.
 * Recusa nomes que não tenham a forma que o painel criava.
 */
export async function dropTempDatabase(docker: BackupDocker, container: string, name: string): Promise<boolean> {
  if (!isTempName(name)) return false;
  return docker.execCapture(container, PG_LEGACY_CLEANUP, [name]).then((o) => o.includes("GONE"), () => false);
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
/** `COPY tabela (colunas) FROM stdin;`: a lista de colunas é só identificadores (um `.*` aceitaria `(x) TO stdout; -- (y) FROM stdin;`). */
export const PG_COPY = new RegExp(`^COPY (${QUALIFIED}) (?:\\(${IDENT_PART}(?:, ?${IDENT_PART})*\\) )?FROM stdin;$`);
/** O que não faz sentido num banco descartável: donos e permissões de papéis que podem nem existir neste servidor. */
const PG_DROPPED = [/^ALTER .* OWNER TO .+;$/, /^(GRANT|REVOKE) .*;$/, /^ALTER DEFAULT PRIVILEGES .*;$/];

/** Onde o leitor está no SQL: fora de tudo, ou dentro de um texto, identificador, corpo $tag$ ou comentário (que atravessam linhas). */
export interface Lex {
  mode: "normal" | "single" | "escape" | "double" | "dollar" | "block";
  tag: string;
  depth: number;
  /** Viu uma barra invertida fora de texto, identificador, corpo e comentário: comando do cliente psql. */
  meta: boolean;
}

const isWord = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_\u0080-￿]/.test(c);

/** Avança o leitor por uma linha. Textos entre aspas simples (com '' e E'\\'), identificadores entre aspas duplas, $tag$...$tag$ e comentários não confundem. */
export function lexLine(line: string, st: Lex): void {
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    const next = line[i + 1];
    switch (st.mode) {
      case "normal":
        if (c === "-" && next === "-") return;
        if (c === "\\") st.meta = true;
        else if (c === "/" && next === "*") {
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
  /** O dump tem comandos do cliente psql (barra invertida), que rodariam shell no container: recusado. Só `\restrict`/`\unrestrict` do pg_dump recente são aceitos. */
  unsafe: boolean;
}

/**
 * Copia o dump do Postgres para `outFile` sem os donos e as permissões (e só
 * isso) e devolve o que o dump promete: tabelas e linhas. Linhas de dados
 * (bloco COPY), textos, identificadores e corpos de função passam intactos.
 */
export async function filterPostgresDump(inFile: string, outFile: string): Promise<PostgresScan> {
  const scan: PostgresScan = { tables: [], copyRows: new Map(), complete: false, unsafe: false };
  const out = createWriteStream(outFile, { mode: 0o600 });
  const rl = createInterface({ input: createReadStream(inFile), crlfDelay: Infinity });
  const lex: Lex = { mode: "normal", tag: "", depth: 0, meta: false };
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
        // \restrict e \unrestrict (pg_dump recente) só existem como uma linha inteira com uma chave alfanumérica
        if (/^\\(?:un)?restrict [A-Za-z0-9]+$/.test(line)) {
          await writeLine(out, line);
          continue;
        }
        if (PG_DROPPED.some((re) => re.test(line))) {
          lexLine(line, lex);
          if (lex.meta) scan.unsafe = true;
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
      if (lex.meta) scan.unsafe = true;
      await writeLine(out, line);
    }
  } finally {
    rl.close();
    await closeStream(out);
  }
  return scan;
}

export interface MysqlScan {
  /** Tabelas que o dump cria (`CREATE TABLE \`...\``; a estrutura provisória de views, dentro de comentário condicional, não conta). */
  tables: number;
  /** O dump termina com a marca do mysqldump/mariadb-dump (não foi cortado). */
  complete: boolean;
}

/** Lê o dump do MySQL/MariaDB uma vez: quantas tabelas ele cria e se terminou. */
export async function scanMysqlDump(inFile: string): Promise<MysqlScan> {
  const scan: MysqlScan = { tables: 0, complete: false };
  const rl = createInterface({ input: createReadStream(inFile), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line.startsWith("CREATE TABLE `")) scan.tables++;
      else if (line.startsWith("-- Dump completed")) scan.complete = true;
    }
  } finally {
    rl.close();
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

/** Prazo estourado: o cliente docker foi interrompido. */
function isTimeout(err: unknown): boolean {
  return /prazo|código 137/.test(messageOf(err));
}

/** A imagem não está na VPS (`--pull never`). */
function isMissingImage(err: unknown): boolean {
  return /no such image|not found locally|pull access denied|manifest unknown/i.test(messageOf(err));
}

/** mongorestore pode sair com código 0 e ainda assim ter falhado em documentos. */
function mongoFailed(stderr: string): boolean {
  const m = /(\d+) document\(s\) failed to restore/i.exec(stderr);
  return (m !== null && Number(m[1]) > 0) || stderr.split("\n").some((l) => /\bFailed:/.test(l));
}

/** Quantos documentos o mongorestore diz ter restaurado (null = não disse). */
function mongoRestored(stderr: string): number | null {
  const m = /(\d+) document\(s\) restored successfully/i.exec(stderr);
  return m ? Number(m[1]) : null;
}

export interface SandboxInput {
  docker: BackupDocker;
  engine: SandboxEngine;
  /** Imagem do banco do projeto (o id dela, de preferência). */
  image: string;
  /** Pasta própria do teste (arquivos filtrados e conferência). */
  workDir: string;
  /** Arquivo do dump do banco principal. */
  file: string;
  /** Postgres: arquivo dos papéis (pg_dumpall --globals-only), quando o backup tem. */
  globalsFile?: string | null;
  /** Identificador aleatório do teste (16 hexadecimais). */
  id: string;
  /** Projeto de origem (vai num rótulo do container, para quem olhar o `docker ps`). */
  projectId: string;
  /** Prazo da restauração. */
  timeoutMs: number;
  /** Prazo para o banco do container ficar pronto. */
  startTimeoutMs: number;
  /** Espera entre as tentativas de falar com o banco que está subindo. */
  pollMs: number;
  limits: { memoryMb: number; cpus: number; pids: number };
  /** Chamado ANTES de criar o container com o nome dele: o serviço o guarda de forma persistente. */
  register: (name: string) => Promise<void>;
  /** Chamado quando o container foi confirmado como removido (ou nunca foi criado). */
  forget: (name: string) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Sobe o container descartável, restaura o dump nele, confere e remove o
 * container (sempre). Devolve o que foi conferido; qualquer falha vira
 * RestoreValidationError com um código (nunca texto do banco).
 */
export async function validateInSandbox(i: SandboxInput): Promise<ValidationResult> {
  if (!/^[0-9a-f]{16}$/.test(i.id)) throw new RestoreValidationError("restore_failed");
  const scripts = sandboxScripts(i.engine);
  const now = i.now ?? Date.now;
  const sleep = i.sleep ?? defaultSleep;
  const d = i.docker;
  const name = `${SANDBOX_PREFIX}${i.id}`;
  const exec = { timeoutMs: i.timeoutMs };

  // 1. O que o dump promete (antes de criar qualquer coisa).
  let input = i.file;
  let pg: PostgresScan | null = null;
  let myTables = 0;
  if (i.engine === "postgres") {
    input = path.join(i.workDir, "dump-filtrado.sql");
    pg = await filterPostgresDump(i.file, input).catch(() => {
      throw new RestoreValidationError("backup_unreadable");
    });
    if (pg.unsafe) throw new RestoreValidationError("unsafe_dump");
    if (!pg.complete) throw new RestoreValidationError("sanity_failed");
    if (pg.tables.length === 0) throw new RestoreValidationError("empty_database");
  } else if (i.engine === "mysql" || i.engine === "mariadb") {
    const my = await scanMysqlDump(i.file).catch(() => {
      throw new RestoreValidationError("backup_unreadable");
    });
    if (!my.complete) throw new RestoreValidationError("sanity_failed");
    if (my.tables === 0) throw new RestoreValidationError("empty_database");
    myTables = my.tables;
  }

  // 2. O nome fica registrado ANTES de o container existir.
  await i.register(name).catch(() => {
    throw new RestoreValidationError("restore_failed");
  });
  let result: ValidationResult | null = null;
  let failure: RestoreValidationError | null = null;
  try {
    // 3. Sobe a cópia descartável e espera o servidor definitivo.
    try {
      await d.runSandbox({ name, image: i.image, env: scripts.env, labels: { "tws.restore-check.project": i.projectId }, ...i.limits });
    } catch (err) {
      throw new RestoreValidationError(isMissingImage(err) ? "image_unavailable" : "sandbox_failed");
    }
    // Prazo pelo relógio e também pelo número de tentativas (o relógio pode não andar, como num teste).
    const deadline = now() + i.startTimeoutMs;
    const maxTries = Math.max(1, Math.ceil(i.startTimeoutMs / Math.max(1, i.pollMs)));
    for (let tries = 1; ; tries++) {
      const out = await d.execCapture(name, scripts.ready, []).catch(() => "");
      if (out.includes("TWS-READY")) break;
      const st = await d.state(name);
      if (!st.running || now() >= deadline || tries >= maxTries) throw new RestoreValidationError("sandbox_failed");
      await sleep(i.pollMs);
    }

    // 4. Restaura (para no primeiro erro).
    if (scripts.globals && i.globalsFile) await d.execFromFile(name, scripts.globals, [], i.globalsFile, exec).catch(() => undefined);
    let restoreErr = "";
    try {
      restoreErr = (await d.execFromFile(name, scripts.restore, [], input, exec)).stderr;
    } catch (err) {
      throw new RestoreValidationError(isTimeout(err) ? "timeout" : "restore_failed");
    }
    if (i.engine === "mongo" && mongoFailed(restoreErr)) throw new RestoreValidationError("restore_failed");

    // 5. Confere.
    if (pg) {
      const sql = [
        `select 'T', count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p') and n.nspname !~ '^pg_' and n.nspname <> 'information_schema';`,
        ...pg.tables.map((t, n) => `select 'E', ${n}, to_regclass(${sqlLiteral(t)}) is not null;`),
        ...[...pg.copyRows.keys()].map((t, n) => `select 'R', ${n}, count(*) from only ${t};`),
      ].join("\n");
      const sqlFile = path.join(i.workDir, "conferir.sql");
      await writeFile(sqlFile, sql, { mode: 0o600 });
      const out = await d.execFromFile(name, scripts.verify, [], sqlFile, exec).catch(() => {
        throw new RestoreValidationError("sanity_failed");
      });
      const lines = (out.stdout ?? "").split("\n").map((l) => l.trim().split("|"));
      const exists = new Set(lines.filter((l) => l[0] === "E" && l[2] === "t").map((l) => Number(l[1])));
      const counts = new Map(lines.filter((l) => l[0] === "R").map((l) => [Number(l[1]), Number(l[2])]));
      const total = lines.find((l) => l[0] === "T");
      if (!total || !(Number(total[1]) >= pg.tables.length)) throw new RestoreValidationError("sanity_failed");
      if (pg.tables.some((_, n) => !exists.has(n))) throw new RestoreValidationError("sanity_failed");
      let rows = 0;
      for (const [n, expected] of [...pg.copyRows.values()].entries()) {
        if (counts.get(n) !== expected) throw new RestoreValidationError("sanity_failed");
        rows += expected;
      }
      result = { tables: pg.tables.length, rows };
    } else {
      const out = await d.execCapture(name, scripts.verify, []).catch(() => {
        throw new RestoreValidationError("sanity_failed");
      });
      const line = out
        .split("\n")
        .map((l) => l.trim().split("|"))
        .find((l) => l[0] === "T");
      const tables = Number(line?.[1]);
      if (!line || !Number.isInteger(tables)) throw new RestoreValidationError("sanity_failed");
      if (i.engine === "mongo") {
        const docs = Number(line[2]);
        if (tables === 0) throw new RestoreValidationError("empty_database");
        const expected = mongoRestored(restoreErr);
        if (!Number.isInteger(docs) || (expected !== null && docs !== expected)) throw new RestoreValidationError("sanity_failed");
        result = { tables, rows: docs };
      } else {
        if (tables < myTables) throw new RestoreValidationError("sanity_failed");
        result = { tables, rows: null };
      }
    }
  } catch (err) {
    failure = err instanceof RestoreValidationError ? err : new RestoreValidationError("restore_failed");
  }

  // 6. Remove o container (e os volumes anônimos dele), sempre, e confirma.
  const gone = await d.removeSandbox(name).catch(() => false);
  if (gone) await i.forget(name).catch(() => undefined);
  else failure = new RestoreValidationError("cleanup_failed");
  if (failure) throw failure;
  return result!;
}
