/**
 * backup-restore-validate.test.ts — a prova de que o dump restaura, sem Docker:
 * os filtros do dump (Postgres e MySQL/MariaDB), os scripts que rodam no
 * container do banco e a orquestração (restaurar num banco descartável,
 * conferir, apagar o descartável; qualquer falha vira código, nunca texto do banco).
 * O comportamento contra bancos de verdade está em backup-restore-validate-docker.test.ts.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BackupDocker } from "../src/services/backup-docker.js";
import {
  RestoreValidationError,
  filterPostgresDump,
  dropTempDatabase,
  isTempName,
  restoreCheckScripts,
  validateRestore,
  type ValidateInput,
} from "../src/services/backup-restore-validate.js";
import { removeDir } from "./helpers/tmp.js";

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
// Orquestração com Docker de mentira
// ---------------------------------------------------------------------------

class FakeDb implements Partial<BackupDocker> {
  calls: string[] = [];
  restoreArgs: string[][] = [];
  restoreTimeout: number | undefined;
  restoreText = "";
  verifySql = "";
  restoreError: Error | null = null;
  prepareError: Error | null = null;
  verifyError: Error | null = null;
  verifyOut: ((sql: string) => string) | null = null;
  cleanup: string | Error = "GONE\n";
  cleanupArgs: string[][] = [];
  prepareArgs: string[][] = [];

  async execCapture(_c: string, script: string, args: string[]): Promise<string> {
    const step = /# tws-rc:(\w+):(\w+)/.exec(script)!;
    this.calls.push(`${step[1]}:${step[2]}`);
    if (step[2] === "prepare") {
      this.prepareArgs.push(args);
      if (this.prepareError) throw this.prepareError;
      return "";
    }
    this.cleanupArgs.push(args);
    if (this.cleanup instanceof Error) throw this.cleanup;
    return this.cleanup;
  }

  async execFromFile(_c: string, script: string, args: string[], inFile: string, opts?: { timeoutMs?: number }) {
    const step = /# tws-rc:(\w+):(\w+)/.exec(script)!;
    this.calls.push(`${step[1]}:${step[2]}`);
    const text = await readFile(inFile, "utf8").catch(() => "");
    if (step[2] === "verify") {
      this.verifySql = text;
      if (this.verifyError) throw this.verifyError;
      return { stderr: "", stdout: this.verifyOut ? this.verifyOut(text) : defaultVerify(text) };
    }
    this.restoreArgs.push(args);
    this.restoreTimeout = opts?.timeoutMs;
    this.restoreText = text;
    if (this.restoreError) throw this.restoreError;
    return { stderr: "", stdout: "" };
  }
}

/** A resposta de um banco em que tudo bate. */
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

const PG_DUMP = ["CREATE TABLE public.a (id int);", "COPY public.a (id) FROM stdin;", "1", "2", "\\.", "-- PostgreSQL database dump complete", ""].join("\n");
const ID = "0a1b2c3d4e5f6a7b";
const NAME = `tws_rc_${ID}`;

let registry: string[];
let order: string[];

async function input(db: FakeDb, text: string, over: Partial<ValidateInput> = {}): Promise<ValidateInput> {
  return {
    docker: db as unknown as BackupDocker,
    container: "c",
    engine: "postgres",
    workDir: dir,
    file: await file("dump", text),
    id: ID,
    timeoutMs: 5000,
    register: async (n) => {
      registry.push(n);
      order.push(`register ${n}`);
    },
    forget: async (n) => {
      registry = registry.filter((x) => x !== n);
      order.push(`forget ${n}`);
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

describe("validateRestore: Postgres", () => {
  beforeEach(() => {
    registry = [];
    order = [];
  });

  it("registra o nome ANTES de criar, prepara, restaura com o prazo (segundos no container, folga no cliente), confere, limpa e só então esquece", async () => {
    const db = new FakeDb();
    const real = db.execCapture.bind(db);
    db.execCapture = async (c, script, args) => {
      order.push(`docker ${/# tws-rc:\w+:(\w+)/.exec(script)![1]}`);
      return real(c, script, args);
    };
    expect(await validateRestore(await input(db, PG_DUMP))).toEqual({ tables: 1, rows: 2 });
    expect(db.calls).toEqual(["postgres:prepare", "postgres:restore", "postgres:verify", "postgres:cleanup"]);
    expect(db.restoreArgs).toEqual([[NAME, "5"]]);
    expect(db.restoreTimeout).toBe(35_000);
    expect(db.cleanupArgs).toEqual([[NAME]]);
    expect(order).toEqual([`register ${NAME}`, "docker prepare", "docker cleanup", `forget ${NAME}`]);
    expect(registry).toEqual([]);
  });

  it("restauração com erro, prazo, falha ao preparar, conferência que não roda: códigos; sempre limpa e esquece", async () => {
    for (const [setup, expected] of [
      [(d: FakeDb) => (d.restoreError = new Error("psql: ERROR: valor DADO-SECRETO")), "restore_failed"],
      [(d: FakeDb) => (d.restoreError = new Error("o comando passou do prazo e foi interrompido")), "timeout"],
      [(d: FakeDb) => (d.restoreError = new Error("docker saiu com código 137")), "timeout"],
      [(d: FakeDb) => (d.prepareError = new Error("sem espaço")), "restore_failed"],
      [(d: FakeDb) => (d.verifyError = new Error("x")), "sanity_failed"],
    ] as const) {
      registry = [];
      const db = new FakeDb();
      setup(db);
      expect(await code(validateRestore(await input(db, PG_DUMP)))).toBe(expected);
      expect(db.cleanupArgs).toHaveLength(1);
      expect(registry).toEqual([]);
    }
  });

  it("sem permissão para criar bancos: destination_permission; nome que já existe: falha; em nenhum dos dois se apaga nada", async () => {
    const noPerm = new FakeDb();
    noPerm.prepareError = new Error("tws-rc:no-permission");
    expect(await code(validateRestore(await input(noPerm, PG_DUMP)))).toBe("destination_permission");
    const exists = new FakeDb();
    exists.prepareError = new Error("tws-rc:exists");
    expect(await code(validateRestore(await input(exists, PG_DUMP)))).toBe("restore_failed");
    for (const db of [noPerm, exists]) {
      expect(db.cleanupArgs).toEqual([]);
      expect(db.restoreArgs).toEqual([]);
    }
    expect(registry).toEqual([]);
  });

  it("conferência que não bate (tabela ausente, linhas a mais ou a menos, poucas tabelas, sem total): sanity_failed", async () => {
    for (const edit of [
      (o: string) => o.replace("E|0|t", "E|0|f"),
      (o: string) => o.replace("R|0|2", "R|0|3"),
      (o: string) => o.replace("T|9", "T|0"),
      (o: string) => o.replace("T|9", ""),
    ]) {
      const db = new FakeDb();
      db.verifyOut = (sql) => edit(defaultVerify(sql));
      expect(await code(validateRestore(await input(db, PG_DUMP)))).toBe("sanity_failed");
    }
  });

  it("dump lixo ou cortado: nem toca no servidor nem registra nada; arquivo ilegível: backup_unreadable", async () => {
    const db = new FakeDb();
    expect(await code(validateRestore(await input(db, "lixo")))).toBe("sanity_failed");
    expect(await code(validateRestore(await input(db, PG_DUMP.replace("-- PostgreSQL database dump complete\n", ""))))).toBe("sanity_failed");
    expect(await code(validateRestore({ ...(await input(db, PG_DUMP)), file: path.join(dir, "nao-existe") }))).toBe("backup_unreadable");
    expect(db.calls).toEqual([]);
    expect(order).toEqual([]);
  });

  it("não conseguir apagar o banco temporário vira cleanup_failed e o nome continua REGISTRADO (a varredura tenta de novo)", async () => {
    for (const answer of ["LEFT\n", new Error("x")]) {
      registry = [];
      const db = new FakeDb();
      db.cleanup = answer;
      expect(await code(validateRestore(await input(db, PG_DUMP)))).toBe("cleanup_failed");
      expect(registry).toEqual([NAME]);
      registry = [];
      const db2 = new FakeDb();
      db2.cleanup = answer;
      db2.restoreError = new Error("x");
      expect(await code(validateRestore(await input(db2, PG_DUMP)))).toBe("cleanup_failed");
    }
  });

  it("não conseguir registrar o nome: nada é criado", async () => {
    const db = new FakeDb();
    expect(await code(validateRestore(await input(db, PG_DUMP, { register: async () => Promise.reject(new Error("disco cheio")) })))).toBe("restore_failed");
    expect(db.calls).toEqual([]);
  });

  it("identificador inválido, motor que não é Postgres: recusa sem tocar em nada", async () => {
    const db = new FakeDb();
    expect(await code(validateRestore({ ...(await input(db, PG_DUMP)), id: "x'; drop" }))).toBe("restore_failed");
    expect(await code(validateRestore({ ...(await input(db, PG_DUMP)), id: "0a1b2c3d" }))).toBe("restore_failed");
    for (const engine of ["redis", "mysql", "mariadb", "mongo"] as const) {
      expect(await code(validateRestore({ ...(await input(db, PG_DUMP)), engine }))).toBe("restore_failed");
      expect(restoreCheckScripts(engine)).toBeNull();
    }
    expect(db.calls).toEqual([]);
  });
});

describe("dropTempDatabase e isTempName: só o que tem a forma exata de um nome do painel", () => {
  it("recusa nomes parecidos sem tocar no servidor", async () => {
    const db = new FakeDb();
    for (const n of ["tws_rc_cafe", "tws_rc_cafe_0", "tws_rc_meu_app", "tws_rc_0A1B2C3D4E5F6A7B", `${NAME}x`, `x${NAME}`, "postgres", `${NAME};drop`]) {
      expect(isTempName(n)).toBe(false);
      expect(await dropTempDatabase(db as unknown as BackupDocker, "c", n)).toBe(false);
    }
    expect(db.calls).toEqual([]);
    expect(isTempName(NAME)).toBe(true);
    expect(await dropTempDatabase(db as unknown as BackupDocker, "c", NAME)).toBe(true);
    db.cleanup = "LEFT\n";
    expect(await dropTempDatabase(db as unknown as BackupDocker, "c", NAME)).toBe(false);
    db.cleanup = new Error("x");
    expect(await dropTempDatabase(db as unknown as BackupDocker, "c", NAME)).toBe(false);
  });
});

describe("scripts que rodam no container", () => {
  it("cada passo se identifica; a limpeza termina com GONE/LEFT e só apaga o nome recebido (nunca varre por padrão)", () => {
    const scripts = restoreCheckScripts("postgres") as Record<string, string>;
    for (const [step, text] of Object.entries(scripts)) expect(text.startsWith(`# tws-rc:postgres:${step}`)).toBe(true);
    expect(scripts.cleanup).toMatch(/GONE/);
    expect(scripts.cleanup).toMatch(/LEFT/);
    for (const text of Object.values(scripts)) expect(text).not.toMatch(/like 'tws|datname like/);
  });

  it("o prazo vale dentro do container, a sessão é identificada e derrubada antes de apagar, e o preparo recusa sem permissão ou nome existente", () => {
    const pg = restoreCheckScripts("postgres") as Record<string, string>;
    expect(pg.restore).toContain("timeout -s KILL $RC_SECS");
    expect(pg.restore).toContain("PGAPPNAME=tws-restore-check");
    expect(pg.restore).toContain("ON_ERROR_STOP=1");
    expect(pg.cleanup).toContain("pg_terminate_backend");
    expect(pg.cleanup).toContain("drop database if exists");
    expect(pg.prepare).toContain("rolsuper or (rolcreatedb and rolcreaterole)");
    expect(pg.prepare).toContain("tws-rc:no-permission");
    expect(pg.prepare).toContain("tws-rc:exists");
    for (const s of Object.values(pg)) expect(s).not.toMatch(/-p"?\$|--password/);
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

  it("validateRestore: dump com comando do psql vira unsafe_dump sem tocar no servidor nem registrar nada", async () => {
    const db = new FakeDb();
    registry = [];
    order = [];
    expect(await code(validateRestore(await input(db, ["CREATE TABLE public.a (i int);", "\\! id", END, ""].join("\n"))))).toBe("unsafe_dump");
    expect(db.calls).toEqual([]);
    expect(order).toEqual([]);
  });

  it("validateRestore: extensão que exige superusuário (ou ausente) vira extension_unavailable; limpa e esquece", async () => {
    for (const msg of [
      'ERROR:  permission denied to create extension "dblink"',
      'ERROR:  extension "postgis" is not available',
      'ERROR:  could not open extension control file "/x/foo.control"',
    ]) {
      registry = [];
      const db = new FakeDb();
      db.restoreError = new Error(msg);
      expect(await code(validateRestore(await input(db, PG_DUMP)))).toBe("extension_unavailable");
      expect(db.cleanupArgs).toHaveLength(1);
      expect(registry).toEqual([]);
    }
  });
});
