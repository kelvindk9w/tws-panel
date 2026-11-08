/**
 * backup-restore-validate.test.ts — a prova de que o dump restaura, sem Docker:
 * os filtros do dump (Postgres e MySQL/MariaDB), os scripts que rodam no
 * container descartável e a orquestração (subir a cópia descartável da mesma
 * imagem, restaurar, conferir, remover a cópia sempre; qualquer falha vira
 * código, nunca texto do banco).
 * O comportamento contra bancos de verdade está em backup-restore-validate-docker.test.ts.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandboxBlankLabels, type BackupDocker } from "../src/services/backup-docker.js";
import {
  RestoreValidationError,
  filterPostgresDump,
  filteredPostgresStream,
  dropTempDatabase,
  isSandboxName,
  isTempName,
  sandboxScripts,
  scanMysqlDump,
  scanPostgresDump,
  validateInSandbox,
  type SandboxInput,
} from "../src/services/backup-restore-validate.js";
import { removeDir } from "./helpers/tmp.js";
import type { Readable } from "node:stream";

/** Entrada do `docker exec -i`: arquivo ou fluxo (o dump filtrado do Postgres vai direto, sem cópia em disco). */
async function readInput(inFile: string | Readable): Promise<string> {
  if (typeof inFile === "string") return readFile(inFile, "utf8");
  let text = "";
  for await (const chunk of inFile) text += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
  return text;
}


let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-rcval-"));
});
afterEach(async () => {
  await removeDir(dir);
});

async function file(name: string, text: string): Promise<string> {
  const f = path.join(dir, name);
  await writeFile(f, text);
  return f;
}

// ---------------------------------------------------------------------------
// Filtro do dump do Postgres
// ---------------------------------------------------------------------------

describe("filterPostgresDump", () => {
  const dump = [
    "-- PostgreSQL database dump",
    'CREATE TABLE public."Meus Dados" (',
    "    id integer",
    ");",
    "CREATE UNLOGGED TABLE IF NOT EXISTS app.log (x int);",
    "CREATE TABLE app.log (x int);",
    "ALTER TABLE public.\"Meus Dados\" OWNER TO dono;",
    "ALTER SCHEMA app OWNER TO dono;",
    "GRANT ALL ON SCHEMA app TO leitor;",
    "REVOKE ALL ON SCHEMA app FROM PUBLIC;",
    "ALTER DEFAULT PRIVILEGES FOR ROLE dono IN SCHEMA app GRANT SELECT ON TABLES TO leitor;",
    "CREATE FUNCTION app.f() RETURNS void LANGUAGE plpgsql AS $_$",
    "BEGIN",
    "GRANT SELECT ON x TO y;",
    "CREATE TABLE falso (a int);",
    "END;",
    "$_$;",
    'COPY public."Meus Dados" (id) FROM stdin;',
    "1",
    "2",
    "3",
    "\\.",
    "COPY app.log (x) FROM stdin;",
    "\\.",
    "COPY public.t (a) FROM stdin;",
    "GRANT ALL ON y TO z;",
    "CREATE TABLE tambem_falso (a int);",
    "\\.",
    "-- PostgreSQL database dump complete",
    "",
  ].join("\n");

  it("tira só dono e permissões; dados e corpos de função passam intactos", async () => {
    const out = path.join(dir, "out.sql");
    const scan = await filterPostgresDump(await file("in.sql", dump), out);
    const text = await readFile(out, "utf8");
    expect(text).not.toMatch(/OWNER TO|^GRANT ALL ON SCHEMA|^REVOKE|ALTER DEFAULT PRIVILEGES/m);
    expect(text).toContain("GRANT SELECT ON x TO y;"); // dentro do corpo da função
    expect(text).toContain("GRANT ALL ON y TO z;"); // linha de dados do COPY
    expect(text).toContain("CREATE TABLE public.\"Meus Dados\"");
    expect(scan.complete).toBe(true);
  });

  it("devolve as tabelas que o dump cria e as linhas de cada COPY (sem contar o que está em corpo de função ou em dados)", async () => {
    const scan = await filterPostgresDump(await file("in.sql", dump), path.join(dir, "out.sql"));
    expect(scan.tables).toEqual(['public."Meus Dados"', "app.log"]);
    expect([...scan.copyRows]).toEqual([
      ['public."Meus Dados"', 3],
      ["app.log", 0],
      ["public.t", 2],
    ]);
  });

  it("dump cortado: complete é falso", async () => {
    const scan = await filterPostgresDump(await file("in.sql", dump.replace("-- PostgreSQL database dump complete\n", "")), path.join(dir, "out.sql"));
    expect(scan.complete).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Leitor do dump: textos, identificadores e corpos que atravessam linhas
// ---------------------------------------------------------------------------

describe("filterPostgresDump: textos e corpos com $$ ou aspas não confundem o leitor", () => {
  async function scanOf(lines: string[]) {
    const out = path.join(dir, "o.sql");
    const scan = await filterPostgresDump(await file("i.sql", lines.join("\n")), out);
    return { scan, text: await readFile(out, "utf8") };
  }
  const END = "-- PostgreSQL database dump complete";

  it("COMMENT/DEFAULT com '$$' ou '$tag$' dentro de um texto entre aspas simples", async () => {
    const { scan } = await scanOf([
      "CREATE TABLE public.a (x text DEFAULT '$$');",
      "COMMENT ON TABLE public.a IS 'custa $5 e $tag$ nao abre nada';",
      "CREATE TABLE public.b (y int);",
      "ALTER TABLE public.b OWNER TO dono;",
      END,
    ]);
    expect(scan.tables).toEqual(["public.a", "public.b"]);
  });

  it("texto E'...' com barra e aspa escapadas, e '' dentro de texto comum", async () => {
    const { scan, text } = await scanOf([
      "COMMENT ON TABLE public.a IS E'termina com \\' $$ ainda texto';",
      "COMMENT ON COLUMN public.a.x IS 'it''s $$ ainda texto';",
      "CREATE TABLE public.a (x int);",
      "ALTER TABLE public.a OWNER TO dono;",
      END,
    ]);
    expect(scan.tables).toEqual(["public.a"]);
    expect(text).not.toContain("OWNER TO");
  });

  it("identificador entre aspas duplas com aspas simples ou $$ dentro", async () => {
    const { scan } = await scanOf(['CREATE TABLE public."it\'s $$" (a int);', "CREATE TABLE public.b (a int);", END]);
    expect(scan.tables).toEqual(['public."it\'s $$"', "public.b"]);
  });

  it("texto que atravessa várias linhas: o que parece GRANT/CREATE TABLE dentro dele não conta nem é cortado", async () => {
    const { scan, text } = await scanOf([
      "COMMENT ON TABLE public.a IS 'linha 1",
      "GRANT ALL ON x TO y;",
      "CREATE TABLE falso (a int);",
      "fim';",
      "CREATE TABLE public.a (x int);",
      END,
    ]);
    expect(scan.tables).toEqual(["public.a"]);
    expect(text).toContain("GRANT ALL ON x TO y;");
  });

  it("corpo $tag$ de função e comentários (-- e /* */) com aspas soltas", async () => {
    const { scan } = await scanOf([
      "-- aspas soltas ' aqui",
      "/* e aqui ' $$ */",
      "CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $fn$ select 'x'; $fn$;",
      "CREATE FUNCTION g() RETURNS void LANGUAGE plpgsql AS $$",
      "BEGIN",
      "CREATE TABLE falsa (a int);",
      "END;",
      "$$;",
      "/* bloco /* aninhado */ ainda comentário",
      "CREATE TABLE falsa2 (a int); */",
      "CREATE TABLE public.real (a int);",
      END,
    ]);
    expect(scan.tables).toEqual(["public.real"]);
  });
});

// ---------------------------------------------------------------------------
// Lacunas do leitor: $ colado a palavra, tag que só fecha com a mesma tag, $1, comandos do psql
// ---------------------------------------------------------------------------

describe("filterPostgresDump: $ e tags", () => {
  const END = "-- PostgreSQL database dump complete";
  async function tablesOf(lines: string[]) {
    return (await filterPostgresDump(await file("l.sql", lines.join("\n")), path.join(dir, "lo.sql"))).tables;
  }

  it("L09: $ colado a uma palavra (identificador como t$a$b) não abre corpo", async () => {
    expect(await tablesOf(["CREATE TABLE public.t$a$b (i int);", "CREATE TABLE public.depois (i int);", END])).toEqual(["public.t$a$b", "public.depois"]);
    expect(await tablesOf(["COMMENT ON TABLE public.x IS 'a';", "SELECT abc$$def;", "CREATE TABLE public.depois (i int);", END])).toEqual(["public.depois"]);
  });

  it("L11: o corpo $tag$ só fecha com a MESMA tag; outra tag e $$ dentro dele são texto", async () => {
    expect(
      await tablesOf([
        "CREATE FUNCTION public.f() RETURNS void LANGUAGE plpgsql AS $a$",
        "BEGIN EXECUTE $b$ CREATE TABLE falsa1 (i int); $b$; END; $$ CREATE TABLE falsa2 (i int); $$",
        "$a$;",
        "CREATE TABLE public.real (i int);",
        END,
      ]),
    ).toEqual(["public.real"]);
  });

  it("L11: funções com $1/$2 (parâmetros) não abrem corpo nenhum", async () => {
    expect(
      await tablesOf([
        "CREATE FUNCTION public.soma(integer, integer) RETURNS integer LANGUAGE sql AS $body$ select $1 + $2; $body$;",
        "CREATE FUNCTION public.dobro(integer) RETURNS integer LANGUAGE sql AS 'select $1 * 2';",
        "CREATE TABLE public.real (i int);",
        END,
      ]),
    ).toEqual(["public.real"]);
  });
});

describe("filterPostgresDump: comandos do psql (barra invertida) são recusados", () => {
  const END = "-- PostgreSQL database dump complete";
  const unsafe = async (lines: string[]) => (await filterPostgresDump(await file("m.sql", lines.join("\n")), path.join(dir, "mo.sql"))).unsafe;

  it("\\!, \\copy, \\gexec no meio da linha e \\. fora de COPY", async () => {
    expect(await unsafe(["CREATE TABLE a (i int);", "\\! id", END])).toBe(true);
    expect(await unsafe(["CREATE TABLE a (i int);", "\\copy a to program 'x'", END])).toBe(true);
    expect(await unsafe(["CREATE TABLE a (i int);", "select 1 \\gexec", END])).toBe(true);
    expect(await unsafe(["CREATE TABLE a (i int);", "\\.", END])).toBe(true);
  });

  it("barra dentro de texto, E'...', corpo, comentário, dados de COPY e \\restrict/\\unrestrict do pg_dump não contam", async () => {
    expect(
      await unsafe([
        "\\restrict AbC123xyz",
        "CREATE TABLE a (i text DEFAULT 'a\\b');",
        "COMMENT ON TABLE a IS E'tem \\\\ e \\' dentro';",
        "CREATE FUNCTION f() RETURNS void LANGUAGE sql AS $$ select '\\!'; $$;",
        "-- \\! num comentário",
        "/* \\! em bloco */",
        "COPY a (i) FROM stdin;",
        "\\! dado",
        "\\.",
        "\\unrestrict AbC123xyz",
        END,
      ]),
    ).toBe(false);
  });

  it("\\restrict com mais do que a chave não é aceito", async () => {
    expect(await unsafe(["\\restrict abc; \\! id", END])).toBe(true);
  });
});
// ---------------------------------------------------------------------------
// Orquestração com Docker de mentira (o container descartável)
// ---------------------------------------------------------------------------

/** Docker de mentira: guarda cada passo, na ordem, e responde como o banco responderia. */
class FakeSandbox implements Partial<BackupDocker> {
  calls: string[] = [];
  runs: Array<Parameters<BackupDocker["runSandbox"]>[0]> = [];
  inputs: Record<string, string> = {};
  timeouts: Record<string, number | undefined> = {};
  runError: Error | null = null;
  /** Quantas tentativas até o banco ficar pronto (Infinity = nunca). */
  readyAfter = 1;
  readyTries = 0;
  running = true;
  restoreError: Error | null = null;
  restoreStderr = "";
  verifyError: Error | null = null;
  verifyOut: ((sql: string) => string) | null = null;
  removed: string[] = [];
  removeAnswer: boolean | Error = true;
  /** Resposta do passo "space" (KB livres no disco do Docker). */
  spaceOut = "F|99999999\n";
  /** O kernel matou o banco por memória (State.OOMKilled). */
  oom = false;
  /** Argumentos de cada passo (o banco do Postgres vai em $1). */
  args: Record<string, string[][]> = {};
  /** O que entrou como fluxo (true) ou como caminho de arquivo (false), por passo. */
  streamed: Record<string, boolean> = {};

  async inspect() {
    return [{ State: { Running: true, OOMKilled: this.oom } }] as never;
  }
  async runSandbox(spec: Parameters<BackupDocker["runSandbox"]>[0]) {
    this.calls.push("run");
    this.runs.push(spec);
    if (this.runError) throw this.runError;
  }
  async state() {
    return { exists: true, running: this.running };
  }
  private step(script: string): string {
    return /# tws-rc:\w+:(\w+)/.exec(script)![1]!;
  }
  async execCapture(_c: string, script: string): Promise<string> {
    const step = this.step(script);
    this.calls.push(step);
    if (step === "ready") return ++this.readyTries >= this.readyAfter ? "TWS-READY\n" : "";
    if (step === "space") return this.spaceOut;
    if (this.verifyError) throw this.verifyError;
    return this.verifyOut ? this.verifyOut("") : "T|3|5\n";
  }
  async execFromFile(_c: string, script: string, args: string[], inFile: string | Readable, opts?: { timeoutMs?: number }) {
    const step = this.step(script);
    this.calls.push(step);
    (this.args[step] ??= []).push(args);
    this.streamed[step] = typeof inFile !== "string";
    const text = await readInput(inFile).catch(() => "");
    this.inputs[step] = step === "restore" && this.inputs[step] !== undefined ? this.inputs[step] + text : text;
    this.timeouts[step] = opts?.timeoutMs;
    if (step === "verify") {
      if (this.verifyError) throw this.verifyError;
      return { stderr: "", stdout: this.verifyOut ? this.verifyOut(text) : defaultVerify(text) };
    }
    if (step === "restore" && this.restoreError) throw this.restoreError;
    return { stderr: step === "restore" ? this.restoreStderr : "", stdout: "" };
  }
  async removeSandbox(name: string) {
    this.calls.push("remove");
    this.removed.push(name);
    if (this.removeAnswer instanceof Error) throw this.removeAnswer;
    return this.removeAnswer;
  }
}

/** A resposta de um Postgres em que tudo bate. */
function defaultVerify(sql: string): string {
  return sql
    .split("\n")
    .map((l) => {
      const e = /^select 'E', (\d+),/.exec(l);
      if (e) return `E|${e[1]}|t`;
      const r = /^select 'R', (\d+), count/.exec(l);
      if (r) return `R|${r[1]}|2`;
      if (l.startsWith("select 'T'")) return "T|9";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

const PG_DUMP = [
  "CREATE TABLE public.a (id int);",
  "ALTER TABLE public.a OWNER TO app;",
  "COPY public.a (id) FROM stdin;",
  "1",
  "2",
  "\\.",
  "-- PostgreSQL database dump complete",
  "",
].join("\n");
const MY_DUMP = ["-- MySQL dump", "CREATE DATABASE `loja`;", "CREATE TABLE `a` (id int);", "CREATE TABLE `b` (id int);", "/*!50001 CREATE TABLE `v` (x int) */;", "-- Dump completed on 2026-10-14", ""].join("\n");
const ID = "0a1b2c3d4e5f6a7b";
const NAME = `tws-rc-${ID}`;

let registry: string[];
let order: string[];
let clock: number;

async function input(db: FakeSandbox, text: string, over: Partial<SandboxInput> = {}): Promise<SandboxInput> {
  return {
    docker: db as unknown as BackupDocker,
    engine: "postgres",
    image: "sha256:abc",
    dumps: [{ file: await file("dump", text), name: "app" }],
    id: ID,
    projectId: "p1",
    timeoutMs: 5000,
    startTimeoutMs: 1000,
    pollMs: 100,
    limits: { memoryMb: 1024, cpus: 1, pids: 512 },
    spaceBytes: 1024,
    register: async (n) => {
      registry.push(n);
      order.push(`register ${n}`);
    },
    forget: async (n) => {
      registry = registry.filter((x) => x !== n);
      order.push(`forget ${n}`);
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    ...over,
  };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (err) {
    expect(err).toBeInstanceOf(RestoreValidationError);
    return (err as RestoreValidationError).code;
  }
}

describe("validateInSandbox: Postgres", () => {
  beforeEach(() => {
    registry = [];
    order = [];
    clock = 0;
  });

  it("registra o nome ANTES de criar, sobe a cópia da mesma imagem sem rede e com limites, espera ficar pronta, restaura, confere e remove", async () => {
    const db = new FakeSandbox();
    db.readyAfter = 3;
    const real = db.runSandbox.bind(db);
    db.runSandbox = async (spec) => {
      order.push("docker run");
      return real(spec);
    };
    const globals = await file("globals.sql", "CREATE ROLE app;\n");
    expect(await validateInSandbox(await input(db, PG_DUMP, { globalsFile: globals }))).toMatchObject({ tables: 1, rows: 2 });
    expect(db.calls).toEqual(["run", "ready", "ready", "ready", "space", "globals", "restore", "verify", "remove"]);
    expect(db.runs[0]).toMatchObject({ name: NAME, image: "sha256:abc", memoryMb: 1024, cpus: 1, pids: 512, labels: { "tws.restore-check.project": "p1" } });
    // sem senha nenhuma: o container não tem rede, só ele fala com o banco
    expect(db.runs[0]!.env).toEqual({ POSTGRES_HOST_AUTH_METHOD: "trust", ALLOW_EMPTY_PASSWORD: "yes" });
    expect(db.inputs.globals).toBe("CREATE ROLE app;\n");
    // dono e permissões saem do dump; os dados ficam
    expect(db.inputs.restore).not.toContain("OWNER TO");
    expect(db.inputs.restore).toContain("COPY public.a");
    // o dump filtrado vai direto para o container, sem segunda cópia em disco; cada banco no seu banco do container
    expect(db.streamed.restore).toBe(true);
    expect(db.args.restore).toEqual([["tws_restore_check_0"]]);
    expect(db.args.verify).toEqual([["tws_restore_check_0"]]);
    expect(db.timeouts.restore).toBe(5000);
    expect(db.removed).toEqual([NAME]);
    expect(order).toEqual([`register ${NAME}`, "docker run", `forget ${NAME}`]);
    expect(registry).toEqual([]);
  });

  it("restauração com erro, prazo, conferência que não roda ou não bate: códigos; sempre remove e esquece", async () => {
    const cases: Array<[(db: FakeSandbox) => void, string]> = [
      [(db) => (db.restoreError = new Error("ERROR: relation x")), "restore_failed"],
      [(db) => (db.restoreError = new Error("o comando passou do prazo e foi interrompido")), "timeout"],
      [(db) => (db.verifyError = new Error("x")), "sanity_failed"],
      [(db) => (db.verifyOut = (sql) => defaultVerify(sql).replace("E|0|t", "E|0|f")), "sanity_failed"],
      [(db) => (db.verifyOut = (sql) => defaultVerify(sql).replace("R|0|2", "R|0|1")), "sanity_failed"],
      [(db) => (db.verifyOut = (sql) => defaultVerify(sql).replace("T|9", "T|0")), "sanity_failed"],
      [(db) => (db.verifyOut = (sql) => defaultVerify(sql).replace("T|9", "")), "sanity_failed"],
    ];
    for (const [setup, expected] of cases) {
      registry = [];
      const db = new FakeSandbox();
      setup(db);
      expect(await code(validateInSandbox(await input(db, PG_DUMP)))).toBe(expected);
      expect(db.removed).toEqual([NAME]);
      expect(registry).toEqual([]);
    }
  });

  it("imagem que não está na VPS, container que não sobe, que para ou que não fica pronto no prazo", async () => {
    const cases: Array<[(db: FakeSandbox) => void, string, number]> = [
      [(db) => (db.runError = new Error("Error response from daemon: No such image: sha256:abc")), "image_unavailable", 0],
      [(db) => (db.runError = new Error("Error response from daemon: conflict")), "sandbox_failed", 0],
      [(db) => ((db.readyAfter = Infinity), (db.running = false)), "sandbox_failed", 1],
      [(db) => (db.readyAfter = Infinity), "sandbox_failed", 10],
    ];
    for (const [setup, expected, tries] of cases) {
      registry = [];
      clock = 0;
      const db = new FakeSandbox();
      setup(db);
      expect(await code(validateInSandbox(await input(db, PG_DUMP)))).toBe(expected);
      expect(db.readyTries).toBe(tries);
      // mesmo sem ter subido, a remoção é tentada (o nome estava registrado)
      expect(db.removed).toEqual([NAME]);
      expect(db.calls).not.toContain("restore");
      expect(registry).toEqual([]);
    }
  });

  it("dump lixo, cortado, vazio ou com comando do psql: nem cria nada nem registra; arquivo ilegível: backup_unreadable", async () => {
    for (const [text, expected] of [
      ["CREATE TABLE public.a (id int);\n", "sanity_failed"],
      ["-- PostgreSQL database dump complete\n", "empty_database"],
      ["CREATE TABLE public.a (i int);\n\\! id\n-- PostgreSQL database dump complete\n", "unsafe_dump"],
    ] as const) {
      const db = new FakeSandbox();
      expect(await code(validateInSandbox(await input(db, text)))).toBe(expected);
      expect(db.calls).toEqual([]);
      expect(order).toEqual([]);
    }
    const db = new FakeSandbox();
    expect(await code(validateInSandbox({ ...(await input(db, PG_DUMP)), dumps: [{ file: path.join(dir, "nao-existe"), name: "app" }] }))).toBe("backup_unreadable");
    expect(await code(validateInSandbox({ ...(await input(db, PG_DUMP)), dumps: [] }))).toBe("empty_database");
    expect(db.calls).toEqual([]);
  });

  it("não conseguir confirmar a remoção vira cleanup_failed e o nome continua REGISTRADO (a varredura tenta de novo)", async () => {
    for (const answer of [false, new Error("docker fora do ar")]) {
      registry = [];
      const db = new FakeSandbox();
      db.removeAnswer = answer;
      expect(await code(validateInSandbox(await input(db, PG_DUMP)))).toBe("cleanup_failed");
      expect(registry).toEqual([NAME]);
    }
  });

  it("não conseguir registrar o nome: nada é criado; identificador inválido: recusa sem tocar em nada", async () => {
    const db = new FakeSandbox();
    expect(
      await code(
        validateInSandbox(
          await input(db, PG_DUMP, {
            register: async () => {
              throw new Error("disco cheio");
            },
          }),
        ),
      ),
    ).toBe("restore_failed");
    expect(db.calls).toEqual([]);
    for (const id of ["0A1B2C3D4E5F6A7B", "abc", `${ID};x`]) expect(await code(validateInSandbox(await input(db, PG_DUMP, { id })))).toBe("restore_failed");
    expect(db.calls).toEqual([]);
  });

  it("sem os papéis no backup: restaura direto; erro ao aplicar os papéis não para o teste", async () => {
    const db = new FakeSandbox();
    expect(await validateInSandbox(await input(db, PG_DUMP, { spaceBytes: 0 }))).toMatchObject({ tables: 1, rows: 2 });
    expect(db.calls).not.toContain("globals");
    // sem espaço exigido: nem mede
    expect(db.calls).not.toContain("space");
    const db2 = new FakeSandbox();
    const real = db2.execFromFile.bind(db2);
    db2.execFromFile = async (c, script, args, f, o) => {
      if (script.includes(":globals")) throw new Error("role exists");
      return real(c, script, args, f, o);
    };
    expect(await validateInSandbox(await input(db2, PG_DUMP, { globalsFile: await file("g.sql", "x") }))).toMatchObject({ tables: 1, rows: 2 });
  });

  it("sem now/sleep próprios usa o relógio e a espera de verdade", async () => {
    const db = new FakeSandbox();
    db.readyAfter = 2;
    const i = await input(db, PG_DUMP, { pollMs: 1 });
    delete i.now;
    delete i.sleep;
    expect(await validateInSandbox(i)).toMatchObject({ tables: 1, rows: 2 });
  });
});

describe("validateInSandbox: MySQL/MariaDB e MongoDB", () => {
  beforeEach(() => {
    registry = [];
    order = [];
    clock = 0;
  });

  it("MySQL: confere que há pelo menos as tabelas que o dump cria; sem comparar linhas", async () => {
    for (const engine of ["mysql", "mariadb"] as const) {
      const db = new FakeSandbox();
      db.verifyOut = () => "T|3\n";
      expect(await validateInSandbox(await input(db, MY_DUMP, { engine }))).toEqual({ tables: 3, rows: null, databases: [{ name: "app", status: "ok", tables: 3, rows: null }] });
      expect(db.calls).toEqual(["run", "ready", "space", "restore", "verify", "remove"]);
      expect(db.inputs.restore).toBe(MY_DUMP);
      expect(db.streamed.restore).toBe(false);
      expect(db.runs[0]!.env).toMatchObject({ MYSQL_ALLOW_EMPTY_PASSWORD: "yes", MARIADB_ALLOW_EMPTY_ROOT_PASSWORD: "1" });
    }
    const db = new FakeSandbox();
    db.verifyOut = () => "T|1\n";
    expect(await code(validateInSandbox(await input(db, MY_DUMP, { engine: "mysql" })))).toBe("sanity_failed");
    db.verifyOut = () => "nada\n";
    expect(await code(validateInSandbox(await input(db, MY_DUMP, { engine: "mysql" })))).toBe("sanity_failed");
    db.verifyError = new Error("x");
    expect(await code(validateInSandbox(await input(db, MY_DUMP, { engine: "mysql" })))).toBe("sanity_failed");
  });

  it("MySQL: dump cortado ou sem tabelas não sobe nada; arquivo ilegível", async () => {
    const db = new FakeSandbox();
    expect(await code(validateInSandbox(await input(db, "CREATE TABLE `a` (i int);\n", { engine: "mysql" })))).toBe("sanity_failed");
    expect(await code(validateInSandbox(await input(db, "-- Dump completed\n", { engine: "mysql" })))).toBe("empty_database");
    expect(await code(validateInSandbox({ ...(await input(db, MY_DUMP, { engine: "mysql" })), dumps: [{ file: path.join(dir, "nao"), name: null }] }))).toBe("backup_unreadable");
    expect(db.calls).toEqual([]);
  });

  it("MongoDB: documentos que falharam derrubam; coleções e documentos batem com o que o mongorestore diz", async () => {
    const ok = new FakeSandbox();
    ok.restoreStderr = "5 document(s) restored successfully. 0 document(s) failed to restore.\n";
    expect(await validateInSandbox(await input(ok, "arquivo-binario", { engine: "mongo" }))).toMatchObject({ tables: 3, rows: 5 });
    expect(ok.runs[0]!.env).toEqual({ ALLOW_EMPTY_PASSWORD: "yes" });
    const cases: Array<[(db: FakeSandbox) => void, string]> = [
      [(db) => (db.restoreStderr = "3 document(s) restored successfully. 2 document(s) failed to restore.\n"), "restore_failed"],
      [(db) => (db.restoreStderr = "Failed: x.y: error\n"), "restore_failed"],
      [(db) => ((db.restoreStderr = "9 document(s) restored successfully. 0 document(s) failed to restore.\n"), (db.verifyOut = () => "T|3|5\n")), "sanity_failed"],
      [(db) => (db.verifyOut = () => "T|0|0\n"), "empty_database"],
      [(db) => (db.verifyError = new Error("x")), "sanity_failed"],
      [(db) => (db.verifyOut = () => "T|2|x\n"), "sanity_failed"],
    ];
    for (const [setup, expected] of cases) {
      const db = new FakeSandbox();
      setup(db);
      expect(await code(validateInSandbox(await input(db, "arquivo", { engine: "mongo" })))).toBe(expected);
      expect(db.removed).toEqual([NAME]);
    }
    // sem a contagem no texto do mongorestore: só exige coleções
    const quiet = new FakeSandbox();
    expect(await validateInSandbox(await input(quiet, "arquivo", { engine: "mongo" }))).toMatchObject({ tables: 3, rows: 5 });
  });

  it("scanMysqlDump conta CREATE TABLE (não a estrutura provisória de view) e a marca final", async () => {
    expect(await scanMysqlDump(await file("m.sql", MY_DUMP))).toEqual({ tables: 2, complete: true });
  });
});

const POSTGIS_DUMP = [
  "CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;",
  "CREATE TABLE public.lugares (id int, geom public.geometry);",
  "COPY public.lugares (id, geom) FROM stdin;",
  "1\t0101000000000000000000F03F000000000000F03F",
  "\\.",
  "COPY public.spatial_ref_sys (srid, auth_name, auth_srid, srtext, proj4text) FROM stdin;",
  "\\.",
  "-- PostgreSQL database dump complete",
  "",
].join("\n");

describe("validateInSandbox: extensões, vários bancos, espaço, limites e cancelamento", () => {
  beforeEach(() => {
    registry = [];
    order = [];
    clock = 0;
  });

  it("PostGIS: a spatial_ref_sys (criada e preenchida pela extensão) não reprova; a tabela do dump continua exata", async () => {
    const answer = (n: number) => (sql: string) =>
      sql
        .split("\n")
        .map((l) => {
          const e = /^select 'E', (\d+),/.exec(l);
          if (e) return `E|${e[1]}|t`;
          if (/^select 'R', 0, count\(\*\) from only public\.lugares;$/.test(l)) return `R|0|${n}`;
          if (/^select 'R', 1, count\(\*\) from only public\.spatial_ref_sys;$/.test(l)) return "R|1|8500";
          if (l.startsWith("select 'T'")) return "T|2";
          return "";
        })
        .filter(Boolean)
        .join("\n");
    const db = new FakeSandbox();
    db.verifyOut = answer(1);
    expect(await validateInSandbox(await input(db, POSTGIS_DUMP))).toEqual({ tables: 1, rows: 1, databases: [{ name: "app", status: "ok", tables: 1, rows: 1 }] });
    expect(db.inputs.restore).toContain("CREATE EXTENSION IF NOT EXISTS postgis");
    // a tabela que o dump cria continua exata
    const off = new FakeSandbox();
    off.verifyOut = answer(2);
    expect(await code(validateInSandbox(await input(off, POSTGIS_DUMP)))).toBe("sanity_failed");
    // tabela só preenchida pelo dump com MENOS linhas que o dump: falha; sem a resposta: falha
    const fewer = new FakeSandbox();
    fewer.verifyOut = (sql) => answer(1)(sql).replace("R|1|8500", "R|1|0");
    const withRows = POSTGIS_DUMP.replace("FROM stdin;\n\\.\n-- PostgreSQL", "FROM stdin;\n900913\tEPSG\t900913\tx\ty\n\\.\n-- PostgreSQL");
    expect(await code(validateInSandbox(await input(fewer, withRows)))).toBe("sanity_failed");
    const missing = new FakeSandbox();
    missing.verifyOut = (sql) => answer(1)(sql).replace("R|1|8500", "");
    expect(await code(validateInSandbox(await input(missing, POSTGIS_DUMP)))).toBe("sanity_failed");
  });

  it("vários bancos do Postgres: cada um no seu banco do container; o sem tabelas aparece como vazio, não some", async () => {
    const db = new FakeSandbox();
    const empty = await file("vazio", "-- PostgreSQL database dump complete\n");
    const i = await input(db, PG_DUMP);
    const res = await validateInSandbox({ ...i, dumps: [{ file: empty, name: "postgres" }, ...i.dumps, { file: await file("b", PG_DUMP), name: "relatorios" }] });
    expect(res).toEqual({
      tables: 2,
      rows: 4,
      databases: [
        { name: "postgres", status: "empty", tables: 0, rows: null },
        { name: "app", status: "ok", tables: 1, rows: 2 },
        { name: "relatorios", status: "ok", tables: 1, rows: 2 },
      ],
    });
    expect(db.args.restore).toEqual([["tws_restore_check_1"], ["tws_restore_check_2"]]);
    expect(db.calls.filter((c) => c === "run")).toHaveLength(1);
    // todos sem tabelas: não sobe nada e diz quais
    const none = new FakeSandbox();
    const err = await validateInSandbox({ ...i, docker: none as unknown as BackupDocker, dumps: [{ file: empty, name: "app" }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestoreValidationError);
    expect((err as RestoreValidationError).code).toBe("empty_database");
    expect((err as RestoreValidationError).databases).toEqual([{ name: "app", status: "empty", tables: 0, rows: null }]);
    expect(none.calls).toEqual([]);
  });

  it("o banco que falha fica marcado como falhou; os anteriores, como ok", async () => {
    const db = new FakeSandbox();
    let n = 0;
    db.verifyOut = (sql) => (++n === 2 ? defaultVerify(sql).replace("R|0|2", "R|0|1") : defaultVerify(sql));
    const i = await input(db, PG_DUMP);
    const err = (await validateInSandbox({ ...i, dumps: [...i.dumps, { file: await file("b", PG_DUMP), name: "b" }] }).catch((e: unknown) => e)) as RestoreValidationError;
    expect(err.code).toBe("sanity_failed");
    expect(err.databases.map((d) => [d.name, d.status])).toEqual([
      ["app", "ok"],
      ["b", "failed"],
    ]);
  });

  it("espaço: medido DENTRO do container (disco do Docker); pouco espaço não restaura; sem a medida, usa a de reserva", async () => {
    const small = new FakeSandbox();
    small.spaceOut = "F|10\n";
    expect(await code(validateInSandbox(await input(small, PG_DUMP, { spaceBytes: 1024 * 1024 })))).toBe("no_space");
    expect(small.calls).not.toContain("restore");
    expect(small.removed).toEqual([NAME]);
    const enough = new FakeSandbox();
    enough.spaceOut = "F|2048\n";
    expect(await validateInSandbox(await input(enough, PG_DUMP, { spaceBytes: 1024 * 1024 }))).toMatchObject({ tables: 1 });
    let fallback = 0;
    const blind = new FakeSandbox();
    blind.spaceOut = "";
    expect(await validateInSandbox(await input(blind, PG_DUMP, { spaceBytes: 1, fallbackSpace: async () => void fallback++ }))).toMatchObject({ tables: 1 });
    expect(fallback).toBe(1);
    const blindFull = new FakeSandbox();
    blindFull.spaceOut = "";
    const full = async () => {
      throw new Error("sem espaço");
    };
    expect(await code(validateInSandbox(await input(blindFull, PG_DUMP, { spaceBytes: 1, fallbackSpace: full })))).toBe("no_space");
    // sem medida nenhuma: segue (a falha de disco, se houver, aparece na restauração)
    const none = new FakeSandbox();
    none.spaceOut = "";
    expect(await validateInSandbox(await input(none, PG_DUMP, { spaceBytes: 1 }))).toMatchObject({ tables: 1 });
  });

  it("memória estourada (OOMKilled) e prazo: limite do teste, não defeito do backup; o banco não fica como 'falhou'", async () => {
    for (const where of ["restore", "verify"] as const) {
      const db = new FakeSandbox();
      db.oom = true;
      if (where === "restore") db.restoreError = new Error("docker saiu com código 137");
      else db.verifyError = new Error("server closed the connection");
      const err = (await validateInSandbox(await input(db, PG_DUMP)).catch((e: unknown) => e)) as RestoreValidationError;
      expect(err.code).toBe("memory_limit");
      expect(err.databases[0]!.status).toBe("ok");
      expect(db.removed).toEqual([NAME]);
    }
    const slow = new FakeSandbox();
    slow.restoreError = new Error("o comando passou do prazo e foi interrompido");
    const err = (await validateInSandbox(await input(slow, PG_DUMP)).catch((e: unknown) => e)) as RestoreValidationError;
    expect(err.code).toBe("timeout");
    expect(err.databases[0]!.status).toBe("ok");
    // sem a resposta do Docker sobre a memória: vale o erro da restauração
    const blind = new FakeSandbox();
    blind.inspect = async () => {
      throw new Error("x");
    };
    blind.restoreError = new Error("ERROR: x");
    expect(await code(validateInSandbox(await input(blind, PG_DUMP)))).toBe("restore_failed");
  });

  it("cancelado: para no próximo passo (depois de subir, esperando ficar pronto, ou com a restauração interrompida) e remove", async () => {
    let flag = false;
    const after = new FakeSandbox();
    const real = after.runSandbox.bind(after);
    after.runSandbox = async (spec) => {
      await real(spec);
      flag = true;
    };
    expect(await code(validateInSandbox(await input(after, PG_DUMP, { cancelled: () => flag })))).toBe("cancelled");
    expect(after.calls).toEqual(["run", "remove"]);
    flag = false;
    const waiting = new FakeSandbox();
    waiting.readyAfter = Infinity;
    const realReady = waiting.execCapture.bind(waiting);
    waiting.execCapture = async (c, script) => {
      const out = await realReady(c, script);
      flag = true;
      return out;
    };
    expect(await code(validateInSandbox(await input(waiting, PG_DUMP, { cancelled: () => flag })))).toBe("cancelled");
    flag = false;
    const mid = new FakeSandbox();
    mid.restoreError = new Error("Error response from daemon: No such container");
    const realRestore = mid.execFromFile.bind(mid);
    mid.execFromFile = async (...a: Parameters<typeof realRestore>) => {
      flag = true;
      return realRestore(...a);
    };
    const err = (await validateInSandbox(await input(mid, PG_DUMP, { cancelled: () => flag })).catch((e: unknown) => e)) as RestoreValidationError;
    expect(err.code).toBe("cancelled");
    expect(err.databases[0]!.status).toBe("ok");
    // cancelado entre um banco e outro
    flag = false;
    const between = new FakeSandbox();
    let verifies = 0;
    between.verifyOut = (sql) => {
      verifies++;
      flag = true;
      return defaultVerify(sql);
    };
    const i = await input(between, PG_DUMP, { cancelled: () => flag });
    expect(await code(validateInSandbox({ ...i, dumps: [...i.dumps, { file: await file("b2", PG_DUMP), name: "b" }] }))).toBe("cancelled");
    expect(verifies).toBe(1);
  });

  it("MongoDB sem coleção nenhuma depois de restaurar: empty_database", async () => {
    const db = new FakeSandbox();
    db.verifyOut = () => "T|0|0\n";
    const err = (await validateInSandbox(await input(db, "arquivo", { engine: "mongo" })).catch((e: unknown) => e)) as RestoreValidationError;
    expect(err.code).toBe("empty_database");
    expect(err.databases).toEqual([{ name: "app", status: "empty", tables: 0, rows: null }]);
  });

  it("scanPostgresDump e o fluxo filtrado dizem e entregam o mesmo que o filtro em arquivo", async () => {
    const src = await file("pg.sql", PG_DUMP);
    const out = path.join(dir, "out.sql");
    const viaFile = await filterPostgresDump(src, out);
    const scan = await scanPostgresDump(src);
    expect(scan).toEqual(viaFile);
    expect(await readInput(filteredPostgresStream(src))).toBe(await readFile(out, "utf8"));
    // blocos grandes saem em pedaços, sem perder linha
    const big = ["CREATE TABLE public.a (id int);", "COPY public.a (id) FROM stdin;", ...Array.from({ length: 20_000 }, (_, k) => String(k)), "\\.", "-- PostgreSQL database dump complete", ""].join("\n");
    const bigFile = await file("big.sql", big);
    const streamed = await readInput(filteredPostgresStream(bigFile));
    expect(streamed.split("\n")).toHaveLength(big.split("\n").length);
    expect((await scanPostgresDump(bigFile)).copyRows.get("public.a")).toBe(20_000);
  });
});

describe("dropTempDatabase (legado) e nomes: só o que tem a forma exata de um nome do painel", () => {
  it("recusa nomes parecidos sem tocar no servidor; apaga e confirma o nome exato", async () => {
    const calls: string[][] = [];
    let answer: string | Error = "GONE\n";
    const db = {
      execCapture: async (_c: string, script: string, args: string[]) => {
        expect(script).toContain("# tws-rc:postgres:cleanup");
        calls.push(args);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    } as unknown as BackupDocker;
    const OLD = `tws_rc_${ID}`;
    for (const n of ["tws_rc_cafe", "tws_rc_meu_app", "tws_rc_0A1B2C3D4E5F6A7B", `${OLD}x`, `x${OLD}`, "postgres", `${OLD};drop`]) {
      expect(isTempName(n)).toBe(false);
      expect(await dropTempDatabase(db, "c", n)).toBe(false);
    }
    expect(calls).toEqual([]);
    expect(isTempName(OLD)).toBe(true);
    expect(await dropTempDatabase(db, "c", OLD)).toBe(true);
    answer = "LEFT\n";
    expect(await dropTempDatabase(db, "c", OLD)).toBe(false);
    answer = new Error("x");
    expect(await dropTempDatabase(db, "c", OLD)).toBe(false);
    for (const n of ["tws-rc-cafe", `${NAME}x`, "tws-rc-0A1B2C3D4E5F6A7B", "paas-loja-db-1"]) expect(isSandboxName(n)).toBe(false);
    expect(isSandboxName(NAME)).toBe(true);
  });
});

describe("scripts do container descartável", () => {
  it("cada passo se identifica; nenhum usa senha; o pronto distingue o servidor definitivo do temporário da imagem", () => {
    for (const engine of ["postgres", "mysql", "mariadb", "mongo"] as const) {
      const s = sandboxScripts(engine);
      for (const step of ["ready", "restore", "verify", "space"] as const) expect(s[step].startsWith(`# tws-rc:${engine}:${step}`)).toBe(true);
      expect(s.space).toContain("df -Pk");
      for (const text of [s.ready, s.restore, s.verify, s.globals ?? ""]) expect(text).not.toMatch(/--password|-p"?\$|PGPASSWORD/);
      expect(s.ready).toContain("TWS-READY");
    }
    const pg = sandboxScripts("postgres");
    expect(pg.ready).toContain("show listen_addresses");
    expect(pg.restore).toContain("ON_ERROR_STOP=1");
    expect(pg.globals).toBeDefined();
    expect(sandboxScripts("mysql").ready).toContain("@@skip_networking");
    expect(sandboxScripts("mongo").restore).not.toContain("--quiet");
    // MongoDB: admin, local e config fora dos dois lados; views não contam como coleção
    for (const ns of ["admin", "local", "config"]) expect(sandboxScripts("mongo").restore).toContain(`--nsExclude='${ns}.*'`);
    expect(sandboxScripts("mongo").verify).toContain('getCollectionInfos({ type: "collection" })');
    expect(sandboxScripts("mongo").verify).toContain('["admin", "local", "config"]');
  });
});

describe("rótulos do container descartável", () => {
  it("os do painel e do compose saem VAZIOS, inclusive os herdados da imagem do banco; o de origem do teste fica", () => {
    const args = sandboxBlankLabels({
      "paas.project": "vitima",
      "paas.extra": "x",
      "com.docker.compose.project": "paas-vitima",
      "com.docker.compose.depends_on": "web",
      "tws.restore-check.project": "forjado",
      "tws.restore-check.algo": "x",
      "org.opencontainers.image.title": "postgres",
    });
    const keys = args.filter((_, k) => k % 2 === 1);
    expect(args.filter((_, k) => k % 2 === 0).every((a) => a === "--label")).toBe(true);
    expect(keys).toEqual([
      "com.docker.compose.depends_on=",
      "com.docker.compose.project=",
      "com.docker.compose.service=",
      "paas.extra=",
      "paas.managed=",
      "paas.project=",
      "tws.restore-check.algo=",
    ]);
    // sem rótulos na imagem: ainda zera os do compose e do painel
    expect(sandboxBlankLabels(null).filter((_, k) => k % 2 === 1)).toEqual(["com.docker.compose.project=", "com.docker.compose.service=", "paas.managed=", "paas.project="]);
  });
});
