/**
 * backup-restore-check-docker.test.ts — o teste de restauração com Docker de
 * VERDADE: dois Postgres (origem e destino, nomes únicos), o backup do banco de origem
 * e a prova da restauração num banco temporário do servidor do destino.
 *
 * Pula sozinho quando a máquina não tem Docker ou não tem a imagem
 * `postgres:16-alpine` localmente (nunca baixa nada; igual ao teste de sonda do
 * restore-reconciliation-docker). Tudo o que cria é removido no fim, só pelo nome único.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Project } from "@paas/core";
import { ArchiveError } from "../src/services/backup-archive.js";
import { DockerCli } from "../src/services/backup-docker.js";
import { BackupService, projectTargetId, type Archiver } from "../src/services/backup-service.js";

const IMAGE = "postgres:16-alpine";

function hasDocker(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const enabled = hasDocker();
const suffix = randomBytes(4).toString("hex");
const SRC_SLUG = `rcheck-src-${suffix}`;
const DST_SLUG = `rcheck-dst-${suffix}`;
const SRC_C = `paas-${SRC_SLUG}-db-1`;
const DST_C = `paas-${DST_SLUG}-db-1`;
const PW = `pw-${randomBytes(6).toString("hex")}`;

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
}

function psql(container: string, db: string, sql: string): string {
  return docker("exec", "-e", `PGPASSWORD=${PW}`, container, "psql", "-U", "app", "-d", db, "-AtX", "-c", sql).trim();
}

function run(slug: string, name: string, dbName: string): void {
  docker(
    "run", "-d", "--name", name,
    "--label", `com.docker.compose.project=paas-${slug}`,
    "--label", "com.docker.compose.service=db",
    "-e", "POSTGRES_USER=app", "-e", `POSTGRES_PASSWORD=${PW}`, "-e", `POSTGRES_DB=${dbName}`,
    IMAGE,
  );
}

async function ready(container: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      // por TCP: o servidor temporário da inicialização só escuta no socket; este é o definitivo
      docker("exec", "-e", `PGPASSWORD=${PW}`, container, "psql", "-h", "127.0.0.1", "-U", "app", "-d", "postgres", "-AtX", "-c", "select 1");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("postgres não ficou pronto");
}

class JsonArchiver implements Archiver {
  async available() {
    return true;
  }
  private async collect(p: string, base: string, out: Record<string, string>): Promise<void> {
    if ((await stat(p)).isDirectory()) for (const n of await readdir(p)) await this.collect(path.join(p, n), `${base}/${n}`, out);
    else out[base] = (await readFile(p)).toString("base64");
  }
  async create(archive: string, inputs: string[]) {
    const files: Record<string, string> = {};
    for (const i of inputs) await this.collect(i, path.basename(i), files);
    await writeFile(archive, JSON.stringify({ files }));
  }
  async test(archive: string, password: string | null) {
    if (password) throw new ArchiveError("sem senha neste teste", "wrong_password");
    JSON.parse(await readFile(archive, "utf8"));
  }
  async extract(archive: string, outDir: string, _pw: string | null, only?: string[]) {
    const { files } = JSON.parse(await readFile(archive, "utf8")) as { files: Record<string, string> };
    for (const [rel, b64] of Object.entries(files)) {
      if (only && !only.some((o) => rel === o || rel.startsWith(`${o}/`))) continue;
      await mkdir(path.dirname(path.join(outDir, rel)), { recursive: true });
      await writeFile(path.join(outDir, rel), Buffer.from(b64, "base64"));
    }
  }
}

function project(id: string, name: string, slug: string): Project {
  return {
    id, name, slug, ingestMode: "git", source: "https://github.com/x/y.git", branch: "main", domain: `${slug}.example.com`, websocket: false,
    detection: null, proxyService: null, proxyPort: null, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
    lastDeployAt: "2026-10-01T00:00:00Z", lastDeployStatus: "success", deployedBranch: null, deployedSource: null,
  };
}

describe.skipIf(!enabled)("teste de restauração com Postgres de verdade", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "paas-rcheck-docker-"));
    run(SRC_SLUG, SRC_C, "fazenda");
    run(DST_SLUG, DST_C, "fazenda_sbx");
    await Promise.all([ready(SRC_C), ready(DST_C)]);
    psql(SRC_C, "fazenda", "create table animais (id int primary key, nome text); insert into animais values (1,'mimosa'),(2,'estrela'); create table lotes (id int)");
    // o destino já tem uma tabela de mesmo nome com outro formato e uma tabela que não existe na origem
    psql(DST_C, "fazenda_sbx", "create table animais (apelido text); create table antigo (id int)");
  }, 180_000);

  afterAll(async () => {
    for (const c of [SRC_C, DST_C]) {
      try {
        docker("rm", "-fv", c);
      } catch {
        /* já removido */
      }
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("restaura o backup num banco temporário do servidor do destino, confere e apaga, sem tocar no banco do destino", async () => {
    const projects = [project("a", "Fazenda", SRC_SLUG), project("b", "Fazenda Sandbox", DST_SLUG)];
    const service = new BackupService({
      dataDir: dir,
      projectsDir: path.join(dir, "projects"),
      docker: new DockerCli({ socketPath: "/var/run/docker.sock", helperImage: IMAGE, timeoutMs: 60_000 }),
      archiver: new JsonArchiver(),
      storage: () => {
        throw new Error("sem armazenamento neste teste");
      },
      projects: { list: async () => projects, get: async (id) => projects.find((p) => p.id === id) ?? null, srcDir: () => dir, redeploy: async () => undefined },
      mail: { container: "x", volume: "x", dataPath: "/d", etcPath: "/e", webmailContainer: "x", webmailVolume: "x", webmailPath: "/w" },
      verifyLogin: async () => true,
      log: () => undefined,
      readyDelayMs: 500,
    });
    await service.detectProject("a");
    await service.detectProject("b");
    const view = await service.projectView("a");
    expect(view.restoreCheck.candidates).toEqual([{ id: "b", name: "Fazenda Sandbox", engine: "postgres" }]);
    await service.updateRestoreCheck("a", { enabled: true, destinationId: "b", confirm: "fazenda sandbox" }, "admin");

    const backup = await service.runNow(projectTargetId("a"), "admin");
    await service.idle();
    expect((await service.record(backup.id)).status).not.toBe("failed");

    const last = (await service.projectView("a")).restoreCheck.last!;
    expect(last).toMatchObject({ status: "ok", destinationName: "Fazenda Sandbox", reasonCode: null });
    expect(last.checked).toEqual({ tables: 2, rows: 2 });
    // o banco do destino NÃO foi tocado: continua com as tabelas e os dados que tinha
    expect(psql(DST_C, "fazenda_sbx", "select count(*) from animais")).toBe("0");
    expect(psql(DST_C, "fazenda_sbx", "select count(*) from antigo")).toBe("0");
    expect(psql(DST_C, "fazenda_sbx", "select count(*) from information_schema.columns where table_name = 'animais' and column_name = 'apelido'")).toBe("1");
    // o banco temporário foi apagado, e o banco "fazenda" da origem não foi criado no servidor do destino
    expect(psql(DST_C, "postgres", "select count(*) from pg_database where datname like 'tws\\_rc\\_%' or datname = 'fazenda'")).toBe("0");
    // a senha do usuário do destino continua a mesma (papéis não são restaurados)
    expect(psql(DST_C, "fazenda_sbx", "select 1")).toBe("1");
    // a origem não mudou
    expect(psql(SRC_C, "fazenda", "select count(*) from animais")).toBe("2");
  }, 120_000);
});
