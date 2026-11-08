/**
 * backup-restore-validate-docker.test.ts — a validação com Docker de VERDADE
 * (Postgres): o dump sai de um container "do projeto" com os scripts de backup
 * do painel e é restaurado numa cópia DESCARTÁVEL da mesma imagem, sem rede.
 * Prova que:
 *  - um dump bom é conferido (tabelas e linhas) e o container descartável some
 *    (junto com o volume anônimo dele);
 *  - o container descartável não tem rede e tem o limite de memória pedido;
 *  - dump com erro no meio vira falha (nunca "ok"), e o container some também;
 *  - o container "do projeto" não muda.
 *
 * Pula sozinho quando a máquina não tem Docker ou a imagem local (nunca baixa
 * nada). Tudo o que cria tem nome único e é removido no fim.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dumpPlan } from "../src/services/backup-detect.js";
import { DockerCli, type BackupDocker } from "../src/services/backup-docker.js";
import { RestoreValidationError, validateInSandbox, type SandboxInput } from "../src/services/backup-restore-validate.js";
import { removeDir } from "./helpers/tmp.js";

const PG_IMAGE = "postgres:16-alpine";

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

const cli = new DockerCli({ socketPath: "/var/run/docker.sock", helperImage: "unused", timeoutMs: 120_000 });
const suffix = randomBytes(4).toString("hex");

describe.skipIf(!hasImage(PG_IMAGE))("cópia descartável com Postgres de verdade", () => {
  const SRC = `rcv-pg-src-${suffix}`;
  const PW = `pw-${randomBytes(6).toString("hex")}`;
  let dir: string;
  let good: string;
  let imageId: string;
  let registry: string[] = [];
  const created: string[] = [];

  const psql = (sql: string) => docker("exec", "-e", `PGPASSWORD=${PW}`, SRC, "psql", "-U", "app", "-d", "loja", "-AtX", "-c", sql).trim();

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paas-rcv-docker-"));
    docker("run", "-d", "--name", SRC, "-e", "POSTGRES_USER=app", "-e", `POSTGRES_PASSWORD=${PW}`, "-e", "POSTGRES_DB=loja", PG_IMAGE);
    for (let i = 0; i < 60; i++) {
      try {
        if (psql("select 1") === "1") break;
      } catch {
        /* subindo */
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    // o servidor temporário do script de início pode responder antes do definitivo
    await new Promise((r) => setTimeout(r, 2000));
    psql("create table pedidos (id int primary key, cliente text); insert into pedidos select g, 'cliente ' || g from generate_series(1, 25) g;");
    psql("create table vazia (x int);");
    good = path.join(dir, "bom.sql");
    await cli.execToFile(SRC, dumpPlan("postgres").find((s) => s.id === "db")!.script, ["loja"], good);
    imageId = docker("inspect", "-f", "{{.Image}}", SRC).trim();
  }, 180_000);

  afterAll(async () => {
    for (const n of [SRC, ...created]) {
      try {
        docker("rm", "-fv", n);
      } catch {
        /* já removido */
      }
    }
    await removeDir(dir);
  });

  function input(file: string, over: Partial<SandboxInput> = {}): SandboxInput {
    const id = randomBytes(8).toString("hex");
    created.push(`tws-rc-${id}`);
    return {
      docker: cli as BackupDocker,
      engine: "postgres",
      image: imageId,
      workDir: dir,
      file,
      id,
      projectId: "teste",
      timeoutMs: 120_000,
      startTimeoutMs: 120_000,
      pollMs: 1000,
      limits: { memoryMb: 512, cpus: 1, pids: 256 },
      register: async (n) => void registry.push(n),
      forget: async (n) => void (registry = registry.filter((x) => x !== n)),
      ...over,
    };
  }

  it("dump bom: confere tabelas e linhas, sem rede e com limite de memória; o container some e o projeto não muda", async () => {
    const before = psql("select count(*) from pedidos");
    let seen: { network: string; memory: string } | null = null;
    const spy: BackupDocker = Object.create(cli) as BackupDocker;
    spy.execFromFile = async (c, script, args, f, o) => {
      if (script.includes(":restore") && !seen) {
        const [network, memory] = docker("inspect", "-f", "{{.HostConfig.NetworkMode}} {{.HostConfig.Memory}}", c).trim().split(" ");
        seen = { network: network!, memory: memory! };
      }
      return cli.execFromFile(c, script, args, f, o);
    };
    const i = input(good, { docker: spy });
    expect(await validateInSandbox(i)).toEqual({ tables: 2, rows: 25 });
    expect(seen).toEqual({ network: "none", memory: String(512 * 1024 * 1024) });
    expect(registry).toEqual([]);
    expect(docker("ps", "-a", "--filter", "label=tws.restore-check=1", "--format", "{{.Names}}")).not.toContain(`tws-rc-${i.id}`);
    expect(psql("select count(*) from pedidos")).toBe(before);
  }, 300_000);

  it("dump com erro no meio: falha, e o container some também", async () => {
    const broken = path.join(dir, "quebrado.sql");
    const text = await readFile(good, "utf8");
    await writeFile(broken, text.replace("COPY public.pedidos", "SELECT nao_existe();\nCOPY public.pedidos"));
    const i = input(broken);
    const err = await validateInSandbox(i).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestoreValidationError);
    expect((err as RestoreValidationError).code).toBe("restore_failed");
    expect(await cli.removeSandbox(`tws-rc-${i.id}`)).toBe(true);
    expect(registry).toEqual([]);
  }, 300_000);

  it("só remove container com o rótulo do teste", async () => {
    expect(await cli.removeSandbox(SRC)).toBe(false);
    expect(docker("inspect", "-f", "{{.State.Running}}", SRC).trim()).toBe("true");
  });
});
