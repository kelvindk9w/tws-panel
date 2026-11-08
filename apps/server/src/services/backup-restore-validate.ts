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
 *  - PostgreSQL: CADA banco do backup (um dump por banco) num banco próprio do
 *    container. O dump termina com a marca do pg_dump; a restauração para no
 *    primeiro erro (ON_ERROR_STOP); cada tabela que o dump cria existe e tem
 *    exatamente as linhas do dump. Tabela que o dump só preenche (as de
 *    configuração de extensão, como spatial_ref_sys do PostGIS, que a própria
 *    extensão cria e já enche) precisa ter PELO MENOS as linhas do dump. Os
 *    papéis (globals) vão antes, sem parar em "já existe"; dono e permissões
 *    são tirados do dump, que vai filtrado DIRETO para o container (sem
 *    segunda cópia em disco).
 *  - MySQL/MariaDB: o dump termina com a marca do mysqldump; a restauração
 *    para no primeiro erro (padrão do cliente); há pelo menos tantas tabelas
 *    quanto o dump cria (a quantidade de linhas não é comparada).
 *  - MongoDB: admin, local e config ficam de fora; o mongorestore não pode ter
 *    documento que falhou; há coleções (views não contam), e o total de
 *    documentos bate com o que o mongorestore diz ter restaurado.
 * Banco sem nenhuma tabela: "empty" (não há o que provar); todos assim:
 * "empty_database".
 *
 * Antes de restaurar, o espaço livre é medido DENTRO do container (no disco
 * do Docker, onde fica o volume anônimo): pelo menos 3x o tamanho dos dumps.
 * Prazo estourado e memória estourada (OOMKilled) são "limite do teste", não
 * defeito do backup. Cancelar remove o container e a restauração para.
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
import { Readable } from "node:stream";
import { once } from "node:events";
import { createInterface } from "node:readline";
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
  | "sandbox_failed"
  | "no_space"
  | "memory_limit"
  | "cancelled";

/** Um banco (um dump) no teste. */
export interface ValidatedDatabase {
  /** Nome do banco (PostgreSQL); null = o dump leva o servidor inteiro. */
  name: string | null;
  status: "ok" | "empty" | "failed";
  tables: number;
  rows: number | null;
}

export class RestoreValidationError extends Error {
  constructor(
    readonly code: ValidationCode,
    /** O que já se sabe de cada banco quando parou (o que falhou fica com status "failed"). */
    readonly databases: ValidatedDatabase[] = [],
  ) {
    super(code);
  }
}

export interface ValidationResult {
  /** Tabelas (ou coleções) restauradas, somando os bancos. */
  tables: number;
  /** Linhas (ou documentos) conferidas; null quando o motor não permite comparar com o dump. */
  rows: number | null;
  databases: ValidatedDatabase[];
}

/** Prefixo do nome dos containers descartáveis. */
export const SANDBOX_PREFIX = "tws-rc-";

/** Nome que o painel cria: prefixo + 16 hexadecimais aleatórios. Qualquer outro nome nunca é removido. */
export function isSandboxName(name: string): boolean {
  return /^tws-rc-[0-9a-f]{16}$/.test(name);
}

/** Banco onde o n-ésimo dump do Postgres é restaurado dentro do container descartável. */
export function sandboxPgDb(n: number): string {
  return `tws_restore_check_${n}`;
}

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
  // só coleções de verdade: views (e as de séries temporais por trás) não contam
  '  s.getCollectionInfos({ type: "collection" }).forEach(function (i) {',
  '    if (i.name.indexOf("system.") === 0) return;',
  "    c++;",
  "    d += s.getCollection(i.name).estimatedDocumentCount();",
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
  /** Conferência: imprime linhas `T|...` (e, no Postgres, `E|...` e `R|...`). Postgres lê o SQL do stdin e recebe o banco em $1. */
  verify: string;
  /** Imprime `F|<KB livres>` do disco onde o banco do container grava (o do Docker). */
  space: string;
  /**
   * Imprime `O|<n>`: quantas vezes o kernel matou um processo do container por falta de memória (cgroup v2,
   * /sys/fs/cgroup/memory.events). No PostgreSQL o morto costuma ser só um processo do banco, e o Docker não
   * marca OOMKilled. Sem o arquivo (cgroup v1), não imprime nada.
   */
  oom: string;
}

function oomScript(engine: string): string {
  return [`# tws-rc:${engine}:oom`, `awk '$1 == "oom_kill" {print "O|" $2}' /sys/fs/cgroup/memory.events 2>/dev/null`, "exit 0"].join("\n");
}

/** Espaço livre na pasta de dados do banco do container (ou na raiz, se a imagem usa outra). */
function spaceScript(engine: string, dir: string): string {
  return [`# tws-rc:${engine}:space`, `D="${dir}"`, '[ -d "$D" ] || D=/', `df -Pk "$D" 2>/dev/null | awk 'NR==2 {print "F|" $4}'`, "exit 0"].join("\n");
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
        restore: ["# tws-rc:postgres:restore", 'createdb -U postgres "$1" || exit 1', 'exec psql -U postgres -d "$1" -X -q -v ON_ERROR_STOP=1'].join("\n"),
        verify: ["# tws-rc:postgres:verify", 'psql -U postgres -d "$1" -AtX -q'].join("\n"),
        space: spaceScript("postgres", "${PGDATA:-/var/lib/postgresql/data}"),
        oom: oomScript("postgres"),
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
        space: spaceScript(engine, "/var/lib/mysql"),
        oom: oomScript(engine),
      };
    case "mongo":
      return {
        env: { ALLOW_EMPTY_PASSWORD: "yes" },
        ready: ["# tws-rc:mongo:ready", MONGO_SH, `[ "$($SH --quiet --eval 'db.adminCommand({ ping: 1 }).ok' 2>/dev/null)" = "1" ] && echo TWS-READY`, "exit 0"].join("\n"),
        // admin, local e config ficam de fora dos dois lados: nem restaurados, nem contados
        restore: ["# tws-rc:mongo:restore", "exec mongorestore --archive --drop --nsExclude='admin.*' --nsExclude='local.*' --nsExclude='config.*'"].join("\n"),
        verify: ["# tws-rc:mongo:verify", MONGO_SH, `$SH --quiet --eval '${MONGO_COUNT}'`].join("\n"),
        space: spaceScript("mongo", "/data/db"),
        oom: oomScript("mongo"),
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

function emptyScan(): PostgresScan {
  return { tables: [], copyRows: new Map(), complete: false, unsafe: false };
}

/**
 * Lê o dump do Postgres linha a linha e devolve as linhas que vão para o
 * banco: sem os donos e as permissões (e só isso). Linhas de dados (bloco
 * COPY), textos, identificadores e corpos de função passam intactos. `scan`
 * vai sendo preenchido com o que o dump promete: tabelas e linhas.
 */
async function* postgresLines(inFile: string, scan: PostgresScan): AsyncGenerator<string> {
  const rl = createInterface({ input: createReadStream(inFile), crlfDelay: Infinity });
  const lex: Lex = { mode: "normal", tag: "", depth: 0, meta: false };
  let copy: string | null = null;
  try {
    for await (const line of rl) {
      if (copy !== null) {
        if (line === "\\.") copy = null;
        else scan.copyRows.set(copy, (scan.copyRows.get(copy) ?? 0) + 1);
        yield line;
        continue;
      }
      if (lex.mode === "normal") {
        if (line.startsWith("-- PostgreSQL database dump complete")) scan.complete = true;
        // \restrict e \unrestrict (pg_dump recente) só existem como uma linha inteira com uma chave alfanumérica
        if (/^\\(?:un)?restrict [A-Za-z0-9]+$/.test(line)) {
          yield line;
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
      yield line;
    }
  } finally {
    rl.close();
  }
}

/** Só lê o dump do Postgres: o que ele promete, sem gravar nada. */
export async function scanPostgresDump(inFile: string): Promise<PostgresScan> {
  const scan = emptyScan();
  for await (const _ of postgresLines(inFile, scan)) {
    // só a leitura importa
  }
  return scan;
}

/** Copia o dump do Postgres filtrado (sem donos e permissões) para `outFile` e devolve o que ele promete. */
export async function filterPostgresDump(inFile: string, outFile: string): Promise<PostgresScan> {
  const scan = emptyScan();
  const out = createWriteStream(outFile, { mode: 0o600 });
  try {
    for await (const line of postgresLines(inFile, scan)) await writeLine(out, line);
  } finally {
    await closeStream(out);
  }
  return scan;
}

/** O dump do Postgres filtrado como um fluxo (em blocos de ~64 KB), direto para o `docker exec`: sem segunda cópia em disco. */
export function filteredPostgresStream(inFile: string): Readable {
  const scan = emptyScan();
  return Readable.from(
    (async function* () {
      let buf = "";
      for await (const line of postgresLines(inFile, scan)) {
        buf += `${line}\n`;
        if (buf.length >= 65_536) {
          yield buf;
          buf = "";
        }
      }
      if (buf) yield buf;
    })(),
    { objectMode: false },
  );
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

/** Um dump a restaurar. */
export interface SandboxDump {
  file: string;
  /** Nome do banco (PostgreSQL: um dump por banco); null = o dump leva o servidor inteiro. */
  name: string | null;
}

export interface SandboxInput {
  docker: BackupDocker;
  engine: SandboxEngine;
  /** Imagem do banco do projeto (o id dela, de preferência). */
  image: string;
  /** Os dumps do serviço. PostgreSQL: cada banco num banco próprio do container; os outros motores: um só. */
  dumps: SandboxDump[];
  /** Postgres: arquivo dos papéis (pg_dumpall --globals-only), quando o backup tem. */
  globalsFile?: string | null;
  /** Identificador aleatório do teste (16 hexadecimais). */
  id: string;
  /** Projeto de origem (vai num rótulo do container, para quem olhar o `docker ps`). */
  projectId: string;
  /** Prazo da restauração (todos os dumps somados). */
  timeoutMs: number;
  /** Prazo para o banco do container ficar pronto. */
  startTimeoutMs: number;
  /** Espera entre as tentativas de falar com o banco que está subindo. */
  pollMs: number;
  limits: { memoryMb: number; cpus: number; pids: number };
  /** Espaço livre exigido no disco do Docker (medido dentro do container) antes de restaurar; 0 = não confere. */
  spaceBytes?: number;
  /** Quando o container não diz o espaço livre: a melhor medida disponível (lança se não há espaço). */
  fallbackSpace?: () => Promise<void>;
  /** O teste foi cancelado? (o serviço já removeu o container; aqui só para de seguir). */
  cancelled?: () => boolean;
  /** Chamado ANTES de criar o container com o nome dele: o serviço o guarda de forma persistente. */
  register: (name: string) => Promise<void>;
  /** Chamado quando o container foi confirmado como removido (ou nunca foi criado). */
  forget: (name: string) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Planned {
  dump: SandboxDump;
  db: ValidatedDatabase;
  pg: PostgresScan | null;
  myTables: number;
}

/**
 * Sobe o container descartável, restaura nele cada dump, confere e remove o
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
  const databases = (): ValidatedDatabase[] => plan.map((p) => ({ ...p.db }));

  // 1. O que cada dump promete (antes de criar qualquer coisa; nada é gravado).
  const plan: Planned[] = [];
  for (const dump of i.dumps) {
    const db: ValidatedDatabase = { name: dump.name, status: "ok", tables: 0, rows: null };
    if (i.engine === "postgres") {
      const pg = await scanPostgresDump(dump.file).catch(() => {
        throw new RestoreValidationError("backup_unreadable");
      });
      if (pg.unsafe) throw new RestoreValidationError("unsafe_dump");
      if (!pg.complete) throw new RestoreValidationError("sanity_failed", [{ ...db, status: "failed" }]);
      if (pg.tables.length === 0) db.status = "empty";
      plan.push({ dump, db, pg, myTables: 0 });
    } else if (i.engine === "mysql" || i.engine === "mariadb") {
      const my = await scanMysqlDump(dump.file).catch(() => {
        throw new RestoreValidationError("backup_unreadable");
      });
      if (!my.complete) throw new RestoreValidationError("sanity_failed", [{ ...db, status: "failed" }]);
      if (my.tables === 0) db.status = "empty";
      plan.push({ dump, db, pg: null, myTables: my.tables });
    } else {
      plan.push({ dump, db, pg: null, myTables: 0 });
    }
  }
  if (plan.length === 0 || plan.every((p) => p.db.status === "empty")) throw new RestoreValidationError("empty_database", databases());

  // 2. O nome fica registrado ANTES de o container existir.
  await i.register(name).catch(() => {
    throw new RestoreValidationError("restore_failed");
  });
  let failure: RestoreValidationError | null = null;
  let current: Planned | null = null;
  const stopIfCancelled = () => {
    if (i.cancelled?.()) throw new RestoreValidationError("cancelled");
  };
  /** Contador oom_kill do cgroup do container agora; null = sem o arquivo (cgroup v1) ou sem resposta. */
  const oomKills = async (): Promise<number | null> => {
    const out = await d.execCapture(name, scripts.oom, []).catch(() => "");
    const m = /^O\|(\d+)$/m.exec(out);
    return m ? Number(m[1]) : null;
  };
  let oomBefore: number | null = null;
  /** Por que um comando no container falhou: cancelado, memória estourada, prazo ou o próprio backup. */
  const execFailure = async (err: unknown, otherwise: ValidationCode): Promise<RestoreValidationError> => {
    if (i.cancelled?.()) return new RestoreValidationError("cancelled");
    let oom = false;
    try {
      oom = (await d.inspect([name]))[0]?.State?.OOMKilled === true;
    } catch {
      // sem a resposta do Docker: vale o que a falha disse
    }
    // o kernel matou um processo do banco por memória (o container segue de pé): o contador do cgroup subiu
    if (!oom && oomBefore !== null) {
      const after = await oomKills();
      oom = after !== null && after > oomBefore;
    }
    if (oom) return new RestoreValidationError("memory_limit");
    return new RestoreValidationError(isTimeout(err) ? "timeout" : otherwise);
  };
  try {
    // 3. Sobe a cópia descartável e espera o servidor definitivo.
    try {
      await d.runSandbox({ name, image: i.image, env: scripts.env, labels: { "tws.restore-check.project": i.projectId }, ...i.limits });
    } catch (err) {
      throw new RestoreValidationError(isMissingImage(err) ? "image_unavailable" : "sandbox_failed");
    }
    stopIfCancelled();
    // Prazo pelo relógio e também pelo número de tentativas (o relógio pode não andar, como num teste).
    const deadline = now() + i.startTimeoutMs;
    const maxTries = Math.max(1, Math.ceil(i.startTimeoutMs / Math.max(1, i.pollMs)));
    for (let tries = 1; ; tries++) {
      const out = await d.execCapture(name, scripts.ready, []).catch(() => "");
      if (out.includes("TWS-READY")) break;
      stopIfCancelled();
      const st = await d.state(name);
      if (!st.running || now() >= deadline || tries >= maxTries) throw new RestoreValidationError("sandbox_failed");
      await sleep(i.pollMs);
    }

    // 4. Espaço no disco do Docker, medido onde o banco do container grava.
    if (i.spaceBytes && i.spaceBytes > 0) {
      const out = await d.execCapture(name, scripts.space, []).catch(() => "");
      const kb = Number(/^F\|(\d+)$/m.exec(out)?.[1] ?? NaN);
      if (Number.isFinite(kb)) {
        if (kb * 1024 < i.spaceBytes) throw new RestoreValidationError("no_space");
      } else if (i.fallbackSpace) {
        await i.fallbackSpace().catch(() => {
          throw new RestoreValidationError("no_space");
        });
      }
    }

    // 5. Restaura e confere cada dump (para no primeiro erro). O prazo vale para todos juntos.
    oomBefore = await oomKills();
    const restoreDeadline = now() + i.timeoutMs;
    const exec = () => ({ timeoutMs: Math.max(1000, restoreDeadline - now()) });
    if (scripts.globals && i.globalsFile) await d.execFromFile(name, scripts.globals, [], i.globalsFile, exec()).catch(() => undefined);
    for (const [n, p] of plan.entries()) {
      if (p.db.status === "empty") continue;
      current = p;
      stopIfCancelled();
      const dbArgs = p.pg ? [sandboxPgDb(n)] : [];
      let restoreErr = "";
      try {
        const input = p.pg ? filteredPostgresStream(p.dump.file) : p.dump.file;
        restoreErr = (await d.execFromFile(name, scripts.restore, dbArgs, input, exec())).stderr;
      } catch (err) {
        throw await execFailure(err, "restore_failed");
      }
      if (i.engine === "mongo" && mongoFailed(restoreErr)) throw new RestoreValidationError("restore_failed");

      if (p.pg) {
        const pg = p.pg;
        // Exato só nas tabelas que o dump CRIA; as que ele só preenche (configuração de extensão, como a
        // spatial_ref_sys do PostGIS, criada e preenchida pela própria extensão) precisam ter pelo menos as do dump.
        const created = new Set(pg.tables);
        const copies = [...pg.copyRows.entries()];
        const sql = [
          `select 'T', count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r','p') and n.nspname !~ '^pg_' and n.nspname <> 'information_schema';`,
          ...pg.tables.map((t, k) => `select 'E', ${k}, to_regclass(${sqlLiteral(t)}) is not null;`),
          ...copies.map(([t], k) => `select 'R', ${k}, count(*) from only ${t};`),
        ].join("\n");
        let stdout = "";
        try {
          stdout = (await d.execFromFile(name, scripts.verify, dbArgs, Readable.from([sql]), exec())).stdout ?? "";
        } catch (err) {
          throw await execFailure(err, "sanity_failed");
        }
        const lines = stdout.split("\n").map((l) => l.trim().split("|"));
        const exists = new Set(lines.filter((l) => l[0] === "E" && l[2] === "t").map((l) => Number(l[1])));
        const counts = new Map(lines.filter((l) => l[0] === "R").map((l) => [Number(l[1]), Number(l[2])]));
        const total = lines.find((l) => l[0] === "T");
        if (!total || !(Number(total[1]) >= pg.tables.length)) throw new RestoreValidationError("sanity_failed");
        if (pg.tables.some((_, k) => !exists.has(k))) throw new RestoreValidationError("sanity_failed");
        let rows = 0;
        for (const [k, [table, expected]] of copies.entries()) {
          const got = counts.get(k);
          if (got === undefined || (created.has(table) ? got !== expected : !(got >= expected))) throw new RestoreValidationError("sanity_failed");
          rows += expected;
        }
        p.db.tables = pg.tables.length;
        p.db.rows = rows;
      } else {
        let out = "";
        try {
          out = await d.execCapture(name, scripts.verify, []);
        } catch (err) {
          throw await execFailure(err, "sanity_failed");
        }
        const line = out
          .split("\n")
          .map((l) => l.trim().split("|"))
          .find((l) => l[0] === "T");
        const tables = Number(line?.[1]);
        if (!line || !Number.isInteger(tables)) throw new RestoreValidationError("sanity_failed");
        if (i.engine === "mongo") {
          const docs = Number(line[2]);
          if (tables === 0) {
            p.db.status = "empty";
          } else {
            const expected = mongoRestored(restoreErr);
            if (!Number.isInteger(docs) || (expected !== null && docs !== expected)) throw new RestoreValidationError("sanity_failed");
            p.db.tables = tables;
            p.db.rows = docs;
          }
        } else {
          if (tables < p.myTables) throw new RestoreValidationError("sanity_failed");
          p.db.tables = tables;
          p.db.rows = null;
        }
      }
      current = null;
    }
    if (plan.every((p) => p.db.status === "empty")) throw new RestoreValidationError("empty_database");
  } catch (err) {
    failure = err instanceof RestoreValidationError ? err : new RestoreValidationError("restore_failed");
    // limite do teste (prazo, memória), cancelamento ou espaço não dizem nada do backup: só o defeito marca o banco
    if (current && (failure.code === "restore_failed" || failure.code === "sanity_failed")) current.db.status = "failed";
  }

  // 6. Remove o container (e os volumes anônimos dele), sempre, e confirma.
  const gone = await d.removeSandbox(name).catch(() => false);
  if (gone) await i.forget(name).catch(() => undefined);
  else failure = new RestoreValidationError("cleanup_failed");
  if (failure) throw new RestoreValidationError(failure.code, databases());
  const done = plan.filter((p) => p.db.status === "ok");
  const rows = done.some((p) => p.db.rows === null) ? null : done.reduce((a, p) => a + (p.db.rows ?? 0), 0);
  return { tables: done.reduce((a, p) => a + p.db.tables, 0), rows, databases: databases() };
}
