/**
 * backup-restore-validate-docker.test.ts — a validação do dump com bancos de
 * VERDADE (Postgres, o único motor suportado neste lote): o dump sai do container de origem com
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
import { RestoreValidationError, dropTempDatabase, restoreCheckScripts, validateRestore } from "../src/services/backup-restore-validate.js";

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
const id = () => randomBytes(8).toString("hex");

async function dumpOf(container: string, file: string, db: string): Promise<void> {
  await cli.execToFile(container, dumpPlan("postgres").find((s) => s.id === "db")!.script, [db], file);
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
  /** Nomes registrados e esquecidos pelo validador (o serviço guarda isso em backups.json). */
  let registry: string[] = [];
  let seenBeforeCreate: boolean[] = [];
  const input = (file: string, timeoutMs = 60_000) => ({
    docker: cli,
    container: DST,
    engine: "postgres" as const,
    workDir: dir,
    file,
    id: id(),
    timeoutMs,
    register: async (name: string) => {
      registry.push(name);
      seenBeforeCreate.push(psql(DST, "postgres", `select count(*) from pg_database where datname = '${name}'`) === "0");
    },
    forget: async (name: string) => {
      registry = registry.filter((n) => n !== name);
    },
  });
  let lookalikes = "";
  const dbs = () => psql(DST, "postgres", "select string_agg(datname, ',' order by datname) from pg_database");

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
    // bancos REAIS do destino com nomes parecidos com os do painel: nunca podem ser apagados
    for (const n of ["tws_rc_cafe", "tws_rc_cafe_0", "tws_rc_meu_app", "tws_rc_0123456789abcdef", "tws_rc_deadbeef"]) psql(DST, "postgres", `create database ${n}`);
    lookalikes = psql(DST, "postgres", "select string_agg(datname, ',' order by datname) from pg_database");
    good = path.join(dir, "bom.sql");
    await dumpOf(SRC, good, "fazenda");
  }, 240_000);

  afterAll(async () => {
    rm_(SRC, DST);
    await rm(dir, { recursive: true, force: true });
  });

  it("dump bom (com dono e permissão de papéis que não existem no destino): ok, conferido, banco descartável apagado, destino intacto", async () => {
    const r = await validateRestore(input(good));
    expect(r).toEqual({ tables: 2, rows: 3 });
    // o nome foi registrado ANTES de o banco existir, e esquecido só depois de apagado
    expect(seenBeforeCreate).toEqual([true]);
    expect(registry).toEqual([]);
    expect(dbs()).toBe(lookalikes);
    expect(psql(DST, "sbx", "select count(*) from existente")).toBe("1");
    expect(psql(DST, "postgres", "select count(*) from pg_roles where rolname = 'dono_somente_na_origem'")).toBe("0");
    expect(psql(DST, "postgres", "select count(*) from pg_database where datname = 'fazenda'")).toBe("0");
  }, 120_000);

  it("dump lixo: falha, e não deixa banco descartável", async () => {
    const f = path.join(dir, "lixo.sql");
    await writeFile(f, "isto nao e um dump\n");
    await expectCode(validateRestore(input(f)), "sanity_failed");
    expect(dbs()).toBe(lookalikes);
  }, 60_000);

  it("dump cortado no meio (sem a marca final): falha", async () => {
    const text = await readFile(good, "utf8");
    const f = path.join(dir, "cortado.sql");
    await writeFile(f, text.slice(0, Math.floor(text.length * 0.6)));
    await expectCode(validateRestore(input(f)), "sanity_failed");
    expect(dbs()).toBe(lookalikes);
  }, 60_000);

  it("erro no meio do dump (a marca final está lá): falha na restauração", async () => {
    const text = await readFile(good, "utf8");
    const f = path.join(dir, "erro.sql");
    await writeFile(f, text.replace("CREATE TABLE public.lotes", "CREATE TABLE public.lotes_quebrada (x tipo_que_nao_existe);\nCREATE TABLE public.lotes"));
    await expectCode(validateRestore(input(f)), "restore_failed");
    expect(dbs()).toBe(lookalikes);
  }, 60_000);

  it("prazo estourado: interrompe a restauração dentro do banco, apaga o descartável e nada continua rodando", async () => {
    const text = await readFile(good, "utf8");
    const f = path.join(dir, "lento.sql");
    await writeFile(f, text.replace("CREATE TABLE public.lotes", "SELECT pg_sleep(40);\nCREATE TABLE public.depois_do_prazo (i int);\nCREATE TABLE public.lotes"));
    const started = Date.now();
    await expectCode(validateRestore(input(f, 6_000)), "timeout");
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(dbs()).toBe(lookalikes);
    expect(psql(DST, "postgres", "select count(*) from pg_stat_activity where application_name = 'tws-restore-check'")).toBe("0");
    await new Promise((r) => setTimeout(r, 4_000));
    expect(psql(DST, "sbx", "select count(*) from pg_tables where tablename = 'depois_do_prazo'")).toBe("0");
  }, 120_000);

  it("bancos reais com nomes parecidos (tws_rc_cafe, tws_rc_cafe_0, tws_rc_meu_app, 16 hexadecimais não registrados) nunca são apagados", async () => {
    await validateRestore(input(good));
    const f = path.join(dir, "lixo2.sql");
    await writeFile(f, "isto nao e um dump\n");
    await expectCode(validateRestore(input(f)), "sanity_failed");
    for (const n of ["tws_rc_cafe", "tws_rc_cafe_0", "tws_rc_meu_app", "tws_rc_0123456789abcdef", "tws_rc_deadbeef"]) {
      expect(psql(DST, "postgres", `select count(*) from pg_database where datname = '${n}'`)).toBe("1");
      // a função de limpeza recusa o que não tem a forma de um nome do painel; o nome com a forma certa mas
      // não registrado (16 hexadecimais) é protegido pelo registro do serviço, que só pede para apagar o que registrou
      if (n !== "tws_rc_0123456789abcdef") expect(await dropTempDatabase(cli, DST, n)).toBe(false);
    }
    expect(dbs()).toBe(lookalikes);
  }, 120_000);

  it("um banco temporário registrado que sobrou (painel caiu no meio) é apagado pelo nome registrado, e só ele", async () => {
    const left = `tws_rc_${id()}`;
    psql(DST, "postgres", `create database ${left}`);
    expect(await dropTempDatabase(cli, DST, left)).toBe(true);
    expect(dbs()).toBe(lookalikes);
  }, 60_000);

  it("o script de preparo recusa usuário sem permissão de criar bancos (código 8) e nome que já existe (código 9), sem criar nem apagar nada", () => {
    const prepare = restoreCheckScripts("postgres")!.prepare;
    psql(DST, "postgres", "create role comum login password 'x' nocreatedb nosuperuser");
    const run = (user: string, pw: string, name: string): { code: number; err: string } => {
      try {
        execFileSync("docker", ["exec", "-e", `POSTGRES_USER=${user}`, "-e", `POSTGRES_PASSWORD=${pw}`, DST, "sh", "-c", prepare, "sh", name], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return { code: 0, err: "" };
      } catch (e) {
        const x = e as { status: number; stderr: string };
        return { code: x.status, err: x.stderr };
      }
    };
    const fresh = `tws_rc_${id()}`;
    expect(run("comum", "x", fresh)).toMatchObject({ code: 8 });
    expect(run("comum", "x", fresh).err).toContain("tws-rc:no-permission");
    expect(run("app", PW, "tws_rc_cafe")).toMatchObject({ code: 9 });
    expect(run("app", PW, "tws_rc_cafe").err).toContain("tws-rc:exists");
    expect(dbs()).toBe(lookalikes);
    psql(DST, "postgres", "drop role comum");
  }, 60_000);
});

