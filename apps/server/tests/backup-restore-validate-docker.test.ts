/**
 * backup-restore-validate-docker.test.ts — a validação do dump com bancos de
 * VERDADE (Postgres, MariaDB e MongoDB): o dump sai do container de origem com
 * os scripts de backup do painel e é restaurado num banco DESCARTÁVEL do
 * container de destino. Prova que:
 *  - um dump bom é conferido (tabelas e linhas) e o banco descartável some;
 *  - dump lixo, cortado ou com erro no meio vira falha (nunca "ok");
 *  - o que já existe no destino (bancos, tabelas, usuários, papéis) não muda;
 *  - o prazo estourado interrompe a restauração DENTRO do banco (nada continua rodando).
 *
 * Cada bloco pula sozinho quando a máquina não tem Docker ou a imagem local
 * (nunca baixa nada). Tudo o que cria tem nome único e é removido no fim.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dumpPlan } from "../src/services/backup-detect.js";
import { DockerCli } from "../src/services/backup-docker.js";
import { RestoreValidationError, validateRestore } from "../src/services/backup-restore-validate.js";

function hasImage(image: string): boolean {
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"] });
}

function rm_(...names: string[]): void {
  for (const n of names) {
    try {
      docker("rm", "-fv", n);
    } catch {
      /* já removido */
    }
  }
}

const cli = new DockerCli({ socketPath: "/var/run/docker.sock", helperImage: "unused", timeoutMs: 120_000 });
const suffix = randomBytes(4).toString("hex");
const id = () => randomBytes(4).toString("hex");

async function dumpOf(container: string, engine: "postgres" | "mysql" | "mariadb" | "mongo", file: string, arg?: string): Promise<void> {
  const step = dumpPlan(engine).find((s) => s.id === (engine === "postgres" ? "db" : "all"))!;
  await cli.execToFile(container, step.script, arg ? [arg] : [], file);
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(RestoreValidationError);
  expect((err as RestoreValidationError).code).toBe(code);
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

const PG_IMAGE = "postgres:16-alpine";

describe.skipIf(!hasImage(PG_IMAGE))("validação do dump com Postgres de verdade", () => {
  const SRC = `rcv-pg-src-${suffix}`;
  const DST = `rcv-pg-dst-${suffix}`;
  const PW = `pw-${randomBytes(6).toString("hex")}`;
  let dir: string;
  let good: string;

  const psql = (c: string, db: string, sql: string) => docker("exec", "-e", `PGPASSWORD=${PW}`, c, "psql", "-U", "app", "-d", db, "-AtX", "-c", sql).trim();
  const input = (file: string, timeoutMs = 60_000) => ({
    docker: cli,
    container: DST,
    engine: "postgres" as const,
    content: dir,
    workDir: dir,
    file,
    databaseName: "fazenda",
    id: id(),
    timeoutMs,
  });
  const temps = () => psql(DST, "postgres", "select count(*) from pg_database where datname like 'tws\\_rc\\_%'");

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paas-rcv-pg-"));
    for (const [name, db] of [[SRC, "fazenda"], [DST, "sbx"]] as const) {
      docker("run", "-d", "--name", name, "-e", "POSTGRES_USER=app", "-e", `POSTGRES_PASSWORD=${PW}`, "-e", `POSTGRES_DB=${db}`, PG_IMAGE);
    }
    for (const c of [SRC, DST]) {
      for (let i = 0; i < 60; i++) {
        try {
          docker("exec", "-e", `PGPASSWORD=${PW}`, c, "psql", "-h", "127.0.0.1", "-U", "app", "-d", "postgres", "-AtX", "-c", "select 1");
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
    psql(SRC, "postgres", "create role dono_somente_na_origem login password 'x'");
    psql(
      SRC,
      "fazenda",
      "create table animais (id int primary key, nome text); insert into animais values (1,'mimosa'),(2,'estrela'),(3,'bidu'); create table lotes (id int); alter table animais owner to dono_somente_na_origem; grant select on lotes to dono_somente_na_origem",
    );
    psql(DST, "sbx", "create table existente (i int); insert into existente values (1)");
    good = path.join(dir, "bom.sql");
    await dumpOf(SRC, "postgres", good, "fazenda");
  }, 240_000);

  afterAll(async () => {
    rm_(SRC, DST);
    await rm(dir, { recursive: true, force: true });
  });

  it("dump bom (com dono e permissão de papéis que não existem no destino): ok, conferido, banco descartável apagado, destino intacto", async () => {
    const r = await validateRestore(input(good));
    expect(r).toEqual({ tables: 2, rows: 3 });
    expect(temps()).toBe("0");
    expect(psql(DST, "sbx", "select count(*) from existente")).toBe("1");
    expect(psql(DST, "postgres", "select count(*) from pg_roles where rolname = 'dono_somente_na_origem'")).toBe("0");
    expect(psql(DST, "postgres", "select count(*) from pg_database where datname = 'fazenda'")).toBe("0");
  }, 120_000);

  it("dump lixo: falha, e não deixa banco descartável", async () => {
    const f = path.join(dir, "lixo.sql");
    await writeFile(f, "isto nao e um dump\n");
    await expectCode(validateRestore(input(f)), "sanity_failed");
    expect(temps()).toBe("0");
  }, 60_000);

  it("dump cortado no meio (sem a marca final): falha", async () => {
    const text = await readFile(good, "utf8");
    const f = path.join(dir, "cortado.sql");
    await writeFile(f, text.slice(0, Math.floor(text.length * 0.6)));
    await expectCode(validateRestore(input(f)), "sanity_failed");
    expect(temps()).toBe("0");
  }, 60_000);

  it("erro no meio do dump (a marca final está lá): falha na restauração", async () => {
    const text = await readFile(good, "utf8");
    const f = path.join(dir, "erro.sql");
    await writeFile(f, text.replace("CREATE TABLE public.lotes", "CREATE TABLE public.lotes_quebrada (x tipo_que_nao_existe);\nCREATE TABLE public.lotes"));
    await expectCode(validateRestore(input(f)), "restore_failed");
    expect(temps()).toBe("0");
  }, 60_000);

  it("prazo estourado: interrompe a restauração dentro do banco, apaga o descartável e nada continua rodando", async () => {
    const text = await readFile(good, "utf8");
    const f = path.join(dir, "lento.sql");
    await writeFile(f, text.replace("CREATE TABLE public.lotes", "SELECT pg_sleep(40);\nCREATE TABLE public.depois_do_prazo (i int);\nCREATE TABLE public.lotes"));
    const started = Date.now();
    await expectCode(validateRestore(input(f, 6_000)), "timeout");
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(temps()).toBe("0");
    expect(psql(DST, "postgres", "select count(*) from pg_stat_activity where application_name = 'tws-restore-check'")).toBe("0");
    await new Promise((r) => setTimeout(r, 4_000));
    expect(psql(DST, "sbx", "select count(*) from pg_tables where tablename = 'depois_do_prazo'")).toBe("0");
  }, 120_000);

  it("sobra de um teste anterior (banco tws_rc_ esquecido) é varrida no próximo", async () => {
    psql(DST, "postgres", "create database tws_rc_deadbeef");
    expect(temps()).toBe("1");
    await validateRestore(input(good));
    expect(temps()).toBe("0");
  }, 120_000);
});

// ---------------------------------------------------------------------------
// MariaDB
// ---------------------------------------------------------------------------

const MARIA_IMAGE = "mariadb:11";

describe.skipIf(!hasImage(MARIA_IMAGE))("validação do dump com MariaDB de verdade", () => {
  const SRC = `rcv-my-src-${suffix}`;
  const DST = `rcv-my-dst-${suffix}`;
  let dir: string;
  let good: string;

  const sql = (c: string, pw: string, q: string) => docker("exec", c, "mariadb", "-uroot", `-p${pw}`, "-N", "-B", "-e", q).trim();
  const input = (file: string, timeoutMs = 60_000, databaseName: string | null = "loja") => ({
    docker: cli,
    container: DST,
    engine: "mariadb" as const,
    content: dir,
    workDir: dir,
    file,
    databaseName,
    id: id(),
    timeoutMs,
  });
  const temps = () => sql(DST, "dstpw", "select count(*) from information_schema.schemata where schema_name like 'tws\\\\_rc\\\\_%'");

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paas-rcv-my-"));
    docker("run", "-d", "--name", SRC, "-e", "MARIADB_ROOT_PASSWORD=srcpw", "-e", "MARIADB_DATABASE=loja", MARIA_IMAGE);
    docker("run", "-d", "--name", DST, "-e", "MARIADB_ROOT_PASSWORD=dstpw", "-e", "MARIADB_DATABASE=loja", MARIA_IMAGE);
    for (const [c, pw] of [[SRC, "srcpw"], [DST, "dstpw"]] as const) {
      for (let i = 0; i < 90; i++) {
        try {
          sql(c, pw, "select 1");
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
    sql(
      SRC,
      "srcpw",
      "create table loja.pedidos (id int primary key, v text); insert into loja.pedidos values (1,'a'),(2,'b'); create table loja.vazia (i int); create view loja.v_pedidos as select id from loja.pedidos; create database extra_src; create table extra_src.t (i int); insert into extra_src.t values (1); create user 'appsrc'@'%' identified by 'x'",
    );
    sql(DST, "dstpw", "create table loja.antigo (i int); insert into loja.antigo values (1); create database outra_dst; create table outra_dst.t (i int); create user 'appdst'@'%' identified by 'y'");
    good = path.join(dir, "bom.sql");
    await dumpOf(SRC, "mariadb", good);
  }, 240_000);

  afterAll(async () => {
    rm_(SRC, DST);
    await rm(dir, { recursive: true, force: true });
  });

  it("dump bom: só o banco do projeto é restaurado (num descartável); outros bancos, usuários e tabelas do destino ficam como estão", async () => {
    const users = sql(DST, "dstpw", "select group_concat(concat(user,'@',host) order by user) from mysql.user");
    const schemas = sql(DST, "dstpw", "select group_concat(schema_name order by schema_name) from information_schema.schemata");
    const r = await validateRestore(input(good));
    expect(r.tables).toBe(3);
    expect(temps()).toBe("0");
    expect(sql(DST, "dstpw", "select group_concat(concat(user,'@',host) order by user) from mysql.user")).toBe(users);
    expect(sql(DST, "dstpw", "select group_concat(schema_name order by schema_name) from information_schema.schemata")).toBe(schemas);
    expect(sql(DST, "dstpw", "select count(*) from loja.antigo")).toBe("1");
    expect(sql(DST, "dstpw", "select count(*) from information_schema.schemata where schema_name = 'extra_src'")).toBe("0");
  }, 120_000);

  it("sem saber o banco do projeto, restaura todos os do dump, cada um num descartável", async () => {
    const r = await validateRestore(input(good, 60_000, null));
    expect(r.tables).toBe(4);
    expect(temps()).toBe("0");
  }, 120_000);

  it("dump cortado (sem 'Dump completed'): falha", async () => {
    const text = await readFile(good, "utf8");
    const f = path.join(dir, "cortado.sql");
    await writeFile(f, text.slice(0, Math.floor(text.length * 0.5)));
    await expectCode(validateRestore(input(f)), "sanity_failed");
    expect(temps()).toBe("0");
  }, 60_000);

  it("erro no meio do dump: falha na restauração e nada fica", async () => {
    const text = await readFile(good, "utf8");
    const f = path.join(dir, "erro.sql");
    await writeFile(f, text.replace("CREATE TABLE `vazia`", "ISTO NAO E SQL;\nCREATE TABLE `vazia`"));
    await expectCode(validateRestore(input(f)), "restore_failed");
    expect(temps()).toBe("0");
  }, 60_000);

  it("prazo estourado: interrompe, derruba a conexão e apaga os descartáveis", async () => {
    const text = await readFile(good, "utf8");
    const f = path.join(dir, "lento.sql");
    await writeFile(f, text.replace("CREATE TABLE `vazia`", "DO SLEEP(40);\nCREATE TABLE `depois_do_prazo` (i int);\nCREATE TABLE `vazia`"));
    await expectCode(validateRestore(input(f, 6_000)), "timeout");
    expect(temps()).toBe("0");
    expect(sql(DST, "dstpw", "select count(*) from information_schema.processlist where db like 'tws\\\\_rc\\\\_%'")).toBe("0");
  }, 120_000);
});

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

const MONGO_IMAGE = "mongo:7";

describe.skipIf(!hasImage(MONGO_IMAGE))("validação do dump com MongoDB de verdade", () => {
  const SRC = `rcv-mg-src-${suffix}`;
  const DST = `rcv-mg-dst-${suffix}`;
  let dir: string;
  let good: string;

  const mongo = (c: string, user: string, pw: string, js: string) =>
    docker("exec", c, "mongosh", "--quiet", "-u", user, "-p", pw, "--authenticationDatabase", "admin", "--eval", js).trim();
  const input = (file: string, timeoutMs = 60_000, databaseName: string | null = "loja") => ({
    docker: cli,
    container: DST,
    engine: "mongo" as const,
    content: dir,
    workDir: dir,
    file,
    databaseName,
    id: id(),
    timeoutMs,
  });
  const temps = () => mongo(DST, "dstroot", "dstpw", 'db.getSiblingDB("admin").adminCommand({listDatabases:1,nameOnly:true}).databases.filter(d=>d.name.startsWith("tws_rc_")).length');
  const adminUsers = (c: string, user: string, pw: string) => mongo(c, user, pw, 'db.getSiblingDB("admin").system.users.find({}, {user:1,_id:0}).toArray().map(u=>u.user).sort().join(",")');

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paas-rcv-mg-"));
    docker("run", "-d", "--name", SRC, "-e", "MONGO_INITDB_ROOT_USERNAME=srcroot", "-e", "MONGO_INITDB_ROOT_PASSWORD=srcpw", MONGO_IMAGE);
    docker("run", "-d", "--name", DST, "-e", "MONGO_INITDB_ROOT_USERNAME=dstroot", "-e", "MONGO_INITDB_ROOT_PASSWORD=dstpw", MONGO_IMAGE);
    for (const [c, u, pw] of [[SRC, "srcroot", "srcpw"], [DST, "dstroot", "dstpw"]] as const) {
      for (let i = 0; i < 90; i++) {
        try {
          // o servidor temporário da inicialização não tem o usuário ainda: só o definitivo responde com login
          mongo(c, u, pw, "1");
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
    mongo(SRC, "srcroot", "srcpw", 'db.getSiblingDB("loja").pedidos.insertMany([{n:1},{n:2},{n:3}]); db.getSiblingDB("loja").itens.insertOne({x:1}); db.getSiblingDB("outro").t.insertOne({y:1}); db.getSiblingDB("admin").createUser({user:"appsrc",pwd:"appsrcpw",roles:["readWrite"]})');
    mongo(DST, "dstroot", "dstpw", 'db.getSiblingDB("loja").antigo.insertOne({x:1}); db.getSiblingDB("admin").createUser({user:"appdst",pwd:"appdstpw",roles:["readWrite"]})');
    good = path.join(dir, "bom.archive");
    await dumpOf(SRC, "mongo", good);
  }, 300_000);

  afterAll(async () => {
    rm_(SRC, DST);
    await rm(dir, { recursive: true, force: true });
  });

  it("dump bom: restaura só o banco do projeto num descartável; usuários e bancos do destino ficam como estão", async () => {
    const before = adminUsers(DST, "dstroot", "dstpw");
    const r = await validateRestore(input(good));
    expect(r).toEqual({ tables: 2, rows: 4 });
    expect(temps()).toBe("0");
    expect(adminUsers(DST, "dstroot", "dstpw")).toBe(before);
    expect(mongo(DST, "dstroot", "dstpw", 'db.getSiblingDB("loja").antigo.countDocuments({})')).toBe("1");
    expect(mongo(DST, "dstroot", "dstpw", 'db.getSiblingDB("loja").pedidos.countDocuments({})')).toBe("0");
    // o login do destino continua o do destino, e o da origem não entrou
    expect(() => mongo(DST, "srcroot", "srcpw", "1")).toThrow();
  }, 120_000);

  it("sem saber o banco do projeto, restaura todos menos admin/config/local", async () => {
    const r = await validateRestore(input(good, 60_000, null));
    expect(r.tables).toBe(3);
    expect(temps()).toBe("0");
    expect(adminUsers(DST, "dstroot", "dstpw")).toContain("appdst");
  }, 120_000);

  it("dump lixo: falha", async () => {
    const f = path.join(dir, "lixo.archive");
    await writeFile(f, "isto nao e um archive do mongodump");
    await expectCode(validateRestore(input(f)), "restore_failed");
    expect(temps()).toBe("0");
  }, 60_000);

  it("dump cortado: falha", async () => {
    const buf = await readFile(good);
    const f = path.join(dir, "cortado.archive");
    await writeFile(f, buf.subarray(0, Math.floor(buf.length * 0.6)));
    await expectCode(validateRestore(input(f)), "restore_failed");
    expect(temps()).toBe("0");
  }, 60_000);
});
