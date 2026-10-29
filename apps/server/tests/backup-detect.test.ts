/**
 * backup-detect.test.ts — o que a aba Backups do projeto encontra nos
 * containers (bancos pela imagem, volumes e pastas montadas, arquivos fora
 * de volume) e os comandos de dump/restauração de cada banco. Puro: a saída
 * do `docker inspect`/`docker diff` entra como dado.
 */
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PG_DROP,
  PG_RESTORE_TEMP,
  PG_REVERT,
  PG_SWAP,
  PG_SWAP_FIX,
  PG_SWEEP_LIST,
  PG_SPACE,
  PG_COPY_SQL,
  buildDetection,
  databaseSignals,
  dumpPlan,
  ENGINE_PROBE_SCRIPT,
  engineFromImage,
  engineFromSignals,
  hasDatabaseSignal,
  parseEngineProbe,
  SUSPECTED_REASON,
  itemFileName,
  mountId,
  REDIS_SAVE,
  restoreScript,
  unsavedWritesFromDiff,
  type ContainerInspect,
} from "../src/services/backup-detect.js";

function container(partial: Partial<ContainerInspect> & { service: string; image: string }): ContainerInspect {
  return {
    Name: `/paas-loja-${partial.service}-1`,
    Config: {
      Image: partial.image,
      Env: partial.Config?.Env ?? [],
      Labels: { "com.docker.compose.service": partial.service },
      ExposedPorts: partial.Config?.ExposedPorts ?? null,
    },
    Mounts: partial.Mounts ?? [],
    State: { Running: true },
  };
}

describe("banco pela imagem", () => {
  it("reconhece os bancos comuns e ignora o resto", () => {
    expect(engineFromImage("postgres:16-alpine")).toBe("postgres");
    expect(engineFromImage("postgis/postgis:15-3.4")).toBe("postgres");
    expect(engineFromImage("bitnami/postgresql:16")).toBe("postgres");
    expect(engineFromImage("docker.io/library/mysql:8.4")).toBe("mysql");
    expect(engineFromImage("mariadb:11")).toBe("mariadb");
    expect(engineFromImage("mongo:7")).toBe("mongo");
    expect(engineFromImage("redis:7-alpine")).toBe("redis");
    expect(engineFromImage("valkey/valkey:8")).toBe("redis");
    expect(engineFromImage("node:22")).toBeNull();
    expect(engineFromImage("minha-org/api-postgres-helper:1")).toBeNull();
  });
});

describe("detecção do projeto", () => {
  const containers: ContainerInspect[] = [
    container({
      service: "db",
      image: "postgres:16",
      Config: { Image: "postgres:16", Env: ["POSTGRES_USER=app", "POSTGRES_DB=loja", "POSTGRES_PASSWORD=segredo-nao-vaza"], Labels: {} },
      Mounts: [{ Type: "volume", Name: "paas-loja_pgdata", Source: "/var/lib/docker/volumes/paas-loja_pgdata/_data", Destination: "/var/lib/postgresql/data", RW: true }],
    }),
    container({
      service: "web",
      image: "paas-loja-web",
      Mounts: [
        { Type: "volume", Name: "paas-loja_uploads", Source: "/x", Destination: "/app/public/uploads", RW: true },
        { Type: "volume", Name: "paas-loja_cache", Source: "/x", Destination: "/app/.cache", RW: true },
        { Type: "bind", Source: "/opt/tws-projects/loja/src/nginx.conf", Destination: "/etc/nginx/nginx.conf", RW: false },
        { Type: "bind", Source: "/opt/tws-projects/loja/src/dados", Destination: "/app/dados", RW: true },
        { Type: "bind", Source: "/opt/tws-projects/loja/src/codigo", Destination: "/srv/app", RW: true },
      ],
    }),
    container({
      service: "cache",
      image: "redis:7",
      Mounts: [{ Type: "volume", Name: "paas-loja_redis", Source: "/x", Destination: "/data", RW: true }],
    }),
  ];

  const detection = buildDetection({
    containers,
    diffs: { web: "C /app\nA /app/storage/notas/1.pdf\nA /tmp/x\n", db: "", cache: "" },
    sizes: {
      [mountId("web", "/app/public/uploads")]: 2048,
      [mountId("db", "/var/lib/postgresql/data")]: 50_000,
    },
    files: new Set(["/opt/tws-projects/loja/src/nginx.conf"]),
    sourceFolder: null,
    now: new Date("2026-10-14T12:00:00Z"),
  });

  it("banco com usuário e nome lidos do ambiente, marcado por padrão", () => {
    const pg = detection.databases.find((d) => d.engine === "postgres");
    expect(pg).toMatchObject({ id: "db:db", service: "db", databaseName: "loja", user: "app", defaultSelected: true });
    expect(pg!.method).toMatch(/pg_dump/);
  });

  it("Redis aparece desmarcado (costuma ser cache)", () => {
    expect(detection.databases.find((d) => d.engine === "redis")).toMatchObject({ defaultSelected: false });
  });

  it("a senha do banco nunca entra na detecção", () => {
    expect(JSON.stringify(detection)).not.toContain("segredo-nao-vaza");
  });

  it("volume do banco: coberto pelo dump", () => {
    const vol = detection.mounts.find((m) => m.destination === "/var/lib/postgresql/data");
    expect(vol).toMatchObject({ coveredByDump: true, defaultSelected: false, sizeBytes: 50_000 });
    expect(detection.mounts.find((m) => m.service === "cache")).toMatchObject({ coveredByDump: true });
  });

  it("uploads vem marcado; cache e arquivo de configuração não", () => {
    const by = (dest: string) => detection.mounts.find((m) => m.destination === dest)!;
    expect(by("/app/public/uploads")).toMatchObject({ type: "volume", source: "paas-loja_uploads", defaultSelected: true, sizeBytes: 2048 });
    expect(by("/app/.cache").defaultSelected).toBe(false);
    expect(by("/etc/nginx/nginx.conf")).toMatchObject({ isFile: true, defaultSelected: false });
    expect(by("/app/dados")).toMatchObject({ type: "bind", defaultSelected: true });
    expect(by("/srv/app").defaultSelected).toBe(false);
    for (const m of detection.mounts) expect(m.reason.length).toBeGreaterThan(0);
  });

  it("aponta arquivos gravados fora de volume", () => {
    expect(detection.unsavedWrites).toEqual([{ service: "web", count: 1, samples: ["/app/storage/notas/1.pdf"] }]);
    expect(detection.detectedAt).toBe("2026-10-14T12:00:00.000Z");
    expect(detection.error).toBeNull();
  });

  it("sem containers: explica que precisa publicar", () => {
    const empty = buildDetection({ containers: [], diffs: {}, sizes: {}, files: new Set(), sourceFolder: null, now: new Date() });
    expect(empty.error).toMatch(/deploy/i);
  });

  it("pasta do código quando o projeto não vem do GitHub", () => {
    const d = buildDetection({
      containers,
      diffs: {},
      sizes: {},
      files: new Set(),
      sourceFolder: { path: "/opt/tws-projects/site", sizeBytes: 10 },
      now: new Date(),
    });
    expect(d.sourceFolder).toEqual({ path: "/opt/tws-projects/site", sizeBytes: 10 });
  });

  it("MySQL e MongoDB com usuário raiz e banco do ambiente", () => {
    const d = buildDetection({
      containers: [
        container({ service: "mysql", image: "mysql:8", Config: { Image: "mysql:8", Env: ["MYSQL_DATABASE=app", "MYSQL_ROOT_PASSWORD=x"], Labels: {} } }),
        container({ service: "maria", image: "mariadb:11", Config: { Image: "mariadb:11", Env: ["MARIADB_DATABASE=m", "MARIADB_USER=u"], Labels: {} } }),
        container({ service: "mongo", image: "mongo:7", Config: { Image: "mongo:7", Env: ["MONGO_INITDB_ROOT_USERNAME=root", "MONGO_INITDB_DATABASE=d"], Labels: {} } }),
        { ...container({ service: "x", image: "postgres:16" }), Config: { Image: "postgres:16", Env: null, Labels: null } },
      ],
      diffs: {},
      sizes: {},
      files: new Set(),
      sourceFolder: null,
      now: new Date(),
    });
    expect(d.databases.map((x) => [x.engine, x.databaseName, x.user])).toEqual([
      ["mysql", "app", "root"],
      ["mariadb", "m", "u"],
      ["mongo", "d", "root"],
      ["postgres", "postgres", "postgres"],
    ]);
  });
});

describe("arquivos gravados fora de volume (docker diff)", () => {
  it("ignora temporários, cache, log, sockets e pastas pai", () => {
    const diff = [
      "C /app",
      "C /app/public",
      "A /app/public/uploads/foto.png",
      "A /tmp/sess_1",
      "A /var/tmp/x",
      "C /root/.npm/_cacache/index",
      "A /home/node/.cache/x",
      "A /var/log/nginx/access.log",
      "C /run/nginx.pid",
      "A /var/run/app.sock",
      "A /app/node_modules/.cache/babel/x",
      "A /app/.next/cache/images/a",
      "A /app/__pycache__/m.cpython-312.pyc",
      "C /etc/nginx/conf.d/default.conf",
      "A /data/volume/arquivo",
      "D /app/apagado.txt",
      "",
    ].join("\n");
    expect(unsavedWritesFromDiff(diff, ["/data/volume"])).toEqual(["/app/public/uploads/foto.png"]);
  });

  // Saídas reais de `docker diff` (Docker 29), capturadas em containers de teste.
  it("pasta criada pelo Docker para montar um arquivo não conta (initdb do Postgres)", () => {
    const diff = [
      "A /docker-entrypoint-initdb.d",
      "A /docker-entrypoint-initdb.d/init-databases.sql",
      "C /var",
      "A /var/scratch",
      "C /opt",
      "A /opt/app",
      "A /opt/app/conf",
      "A /opt/app/conf/app.conf",
      "A /cache",
      "A /cache/tmpfs",
      "",
    ].join("\n");
    const mounts = ["/docker-entrypoint-initdb.d/init-databases.sql", "/opt/app/conf/app.conf", "/var/scratch", "/cache/tmpfs"];
    expect(unsavedWritesFromDiff(diff, mounts)).toEqual([]);
  });

  it("docker-init (init: true) não conta, nem as pastas pai alteradas por ele", () => {
    const debian = ["C /usr", "C /usr/sbin", "A /usr/sbin/docker-init", ""].join("\n");
    const alpine = ["C /sbin", "A /sbin/docker-init", ""].join("\n");
    expect(unsavedWritesFromDiff(debian, [])).toEqual([]);
    expect(unsavedWritesFromDiff(alpine, [])).toEqual([]);
  });

  it("ruídos que o Docker cria sozinho não contam", () => {
    const diff = [
      "A /.dockerenv",
      "C /etc",
      "A /etc/hostname",
      "A /etc/hosts",
      "A /etc/resolv.conf",
      "C /run",
      "A /run/secrets",
      "A /run/secrets/db_password",
      "C /dev",
      "A /dev/shm/x",
      "C /proc",
      "C /sys",
      "",
    ].join("\n");
    expect(unsavedWritesFromDiff(diff, ["/run/secrets/db_password"])).toEqual([]);
  });

  it("pasta pai alterada só por um arquivo apagado ou ignorado não conta", () => {
    const diff = ["C /srv", "D /srv/velho.txt", "C /app", "A /app/server.pid", ""].join("\n");
    expect(unsavedWritesFromDiff(diff, [])).toEqual([]);
  });

  it("projeto real: só o que foi gravado de verdade fica", () => {
    const diff = [
      "A /docker-entrypoint-initdb.d",
      "A /docker-entrypoint-initdb.d/init-databases.sql",
      "C /var",
      "A /var/www",
      "A /var/www/html",
      "A /var/www/html/uploads",
      "A /var/www/html/uploads/a.jpg",
      "A /app.db",
      "C /data/app.sqlite",
      "C /usr",
      "C /usr/sbin",
      "A /usr/sbin/docker-init",
      "C /run",
      "A /run/secrets",
      "A /run/secrets/db_password",
      "",
    ].join("\n");
    const mounts = ["/run/secrets/db_password", "/docker-entrypoint-initdb.d/init-databases.sql"];
    expect(unsavedWritesFromDiff(diff, mounts)).toEqual(["/app.db", "/data/app.sqlite", "/var/www/html/uploads/a.jpg"]);
  });

  it("tmpfs do HostConfig conta como montagem na detecção", () => {
    const c = container({ service: "web", image: "alpine:3" });
    c.HostConfig = { Tmpfs: { "/cache/tmpfs": "" } };
    const det = buildDetection({
      containers: [c],
      diffs: { web: "A /cache\nA /cache/tmpfs\nC /sbin\nA /sbin/docker-init\n" },
      sizes: {},
      files: new Set(),
      sourceFolder: null,
      now: new Date(),
    });
    expect(det.unsavedWrites).toEqual([]);
  });

  it("muitos caminhos: conta todos, mostra alguns", () => {
    const diff = Array.from({ length: 30 }, (_, i) => `A /srv/files/${i}.txt`).join("\n");
    expect(unsavedWritesFromDiff(diff, [])).toHaveLength(30);
  });
});

describe("dump e restauração", () => {
  it("credenciais lidas do ambiente DENTRO do container, sem senha no comando", () => {
    for (const engine of ["postgres", "mysql", "mariadb", "mongo"] as const) {
      const plan = dumpPlan(engine);
      expect(plan.length).toBeGreaterThan(0);
      for (const step of plan) expect(step.script).not.toMatch(/segredo/);
      expect(restoreScript(engine).length).toBeGreaterThan(0);
    }
    expect(dumpPlan("postgres").map((s) => s.script).join("\n")).toMatch(/pg_dump/);
    expect(dumpPlan("postgres")[0]!.script).toMatch(/POSTGRES_USER/);
    expect(dumpPlan("mysql")[0]!.script).toMatch(/mysqldump|mariadb-dump/);
    expect(dumpPlan("mysql")[0]!.script).toMatch(/MYSQL_PWD/);
    expect(dumpPlan("mongo")[0]!.script).toMatch(/mongodump --archive/);
    expect(restoreScript("mongo")).toMatch(/mongorestore --archive --drop/);
    expect(restoreScript("postgres")).toMatch(/psql/);
    expect(dumpPlan("redis")).toEqual([]);
    expect(restoreScript("redis")).toBe("");
  });

  it("nome de arquivo seguro dentro do backup", () => {
    expect(itemFileName("web", "/app/public/uploads")).toBe("web__app_public_uploads");
    expect(itemFileName("my svc", "/")).toBe("my_svc__raiz");
  });
});

/**
 * Roda o script de verdade (sh) com um mongodump/mongorestore/redis-cli
 * falso no PATH. O falso grava os argumentos e, se recebeu --config, o modo
 * e o conteúdo do arquivo naquele instante.
 */
async function rodarComFalso(script: string, opts: { tool: string; hasConfig: boolean; env: Record<string, string>; exitCode?: number }) {
  const dir = await mkdtemp(path.join(tmpdir(), "paas-mongo-cfg-"));
  const bin = path.join(dir, "bin");
  const tmp = path.join(dir, "tmp");
  await writeFile(path.join(dir, ".keep"), "");
  await spawnSync("mkdir", ["-p", bin, tmp]);
  const log = path.join(dir, "argv.log");
  const fake = `#!/bin/sh
if [ "$1" = "--help" ]; then
  echo "Usage: ${opts.tool} <options>"
  ${opts.hasConfig ? 'echo "      --config=<filename>   path to a configuration file"' : "true"}
  exit 0
fi
printf '%s\\n' "$*" >> "${log}"
if [ -n "\${REDISCLI_AUTH:-}" ]; then echo "auth=\$REDISCLI_AUTH" >> "${log}"; fi
prev=""
for a in "$@"; do
  case "$a" in --config=*) cfg="\${a#--config=}" ;; esac
  [ "$prev" = "--config" ] && cfg="$a"
  prev="$a"
done
if [ -n "\${cfg:-}" ]; then
  stat -c 'modo=%a' "$cfg" >> "${log}"
  cat "$cfg" >> "${log}"
fi
cat >/dev/null 2>&1 || true
exit ${opts.exitCode ?? 0}
`;
  await writeFile(path.join(bin, opts.tool), fake);
  await chmod(path.join(bin, opts.tool), 0o755);
  const r = spawnSync("sh", ["-c", script, "sh"], {
    encoding: "utf8",
    input: "",
    env: { PATH: `${bin}:/usr/bin:/bin`, TMPDIR: tmp, ...opts.env },
  });
  const argv = await readFile(log, "utf8").catch(() => "");
  const sobras = await readdir(tmp);
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return { status: r.status, stderr: r.stderr, argv, sobras };
}

const SENHA_MONGO = `se'nha "forte" $x`;

describe("MongoDB: a senha não vai na linha de comando", () => {
  const env = { MONGO_INITDB_ROOT_USERNAME: "root", MONGO_INITDB_ROOT_PASSWORD: SENHA_MONGO };

  it("dump com database-tools 100.x: senha num --config 0600 que some no fim", async () => {
    const r = await rodarComFalso(dumpPlan("mongo")[0]!.script, { tool: "mongodump", hasConfig: true, env });
    expect(r.status, r.stderr).toBe(0);
    const [linha, modo, conteudo] = r.argv.split("\n");
    expect(linha).toMatch(/^--archive --quiet --username root --authenticationDatabase admin --config \S+/);
    expect(linha).not.toContain("nha");
    expect(linha).not.toMatch(/--password/);
    expect(modo).toBe("modo=600");
    expect(conteudo).toBe(`password: 'se''nha "forte" $x'`);
    expect(r.sobras).toEqual([]);
  });

  it("restauração com database-tools 100.x: o mesmo, com mongorestore", async () => {
    const r = await rodarComFalso(restoreScript("mongo"), { tool: "mongorestore", hasConfig: true, env });
    expect(r.status, r.stderr).toBe(0);
    expect(r.argv.split("\n")[0]).toMatch(/^--archive --drop --quiet --username root --authenticationDatabase admin --config /);
    expect(r.argv).not.toMatch(/--password/);
    expect(r.sobras).toEqual([]);
  });

  it("o arquivo some mesmo quando o dump falha, e o código de saída é o do mongodump", async () => {
    const r = await rodarComFalso(dumpPlan("mongo")[0]!.script, { tool: "mongodump", hasConfig: true, env, exitCode: 3 });
    expect(r.status).toBe(3);
    expect(r.sobras).toEqual([]);
  });

  it("senha em arquivo (*_FILE) também vai pelo --config", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paas-mongo-file-"));
    await writeFile(path.join(dir, "pw"), "do-arquivo");
    const r = await rodarComFalso(dumpPlan("mongo")[0]!.script, {
      tool: "mongodump",
      hasConfig: true,
      env: { MONGO_INITDB_ROOT_USERNAME: "root", MONGO_INITDB_ROOT_PASSWORD_FILE: path.join(dir, "pw") },
    });
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    expect(r.argv).toContain("password: 'do-arquivo'");
    expect(r.argv.split("\n")[0]).not.toContain("do-arquivo");
  });

  it("database-tools antigas (sem --config): cai na senha por argumento, como antes", async () => {
    const r = await rodarComFalso(dumpPlan("mongo")[0]!.script, { tool: "mongodump", hasConfig: false, env });
    expect(r.status, r.stderr).toBe(0);
    expect(r.argv.split("\n")[0]).toBe(`--archive --quiet --username root --password ${SENHA_MONGO} --authenticationDatabase admin`);
    expect(r.sobras).toEqual([]);
  });

  it("sem usuário no ambiente: sem autenticação e sem arquivo", async () => {
    const r = await rodarComFalso(dumpPlan("mongo")[0]!.script, { tool: "mongodump", hasConfig: true, env: {} });
    expect(r.argv.split("\n")[0]).toBe("--archive --quiet");
    expect(r.sobras).toEqual([]);
  });
});

describe("Redis: a senha não vai na linha de comando", () => {
  it("SAVE com REDIS_PASSWORD usa REDISCLI_AUTH, não -a", async () => {
    const r = await rodarComFalso(REDIS_SAVE, { tool: "redis-cli", hasConfig: false, env: { REDIS_PASSWORD: "segredo-redis" } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.argv.split("\n")[0]).toBe("--no-auth-warning SAVE");
    expect(r.argv).toContain("auth=segredo-redis");
  });
});

describe("banco que a imagem não diz: sinais, sonda e pasta de dados suspeita", () => {
  const env = (...e: string[]) => e;
  const c = (image: string, Env: string[], opts: { ports?: string[]; mounts?: string[] } = {}) =>
    container({
      service: "db",
      image,
      Config: { Image: image, Env, Labels: {}, ExposedPorts: Object.fromEntries((opts.ports ?? []).map((p) => [p, {}])) },
      Mounts: (opts.mounts ?? []).map((d) => ({ Type: "volume", Name: "v", Source: "/x", Destination: d })),
    });

  it("mais nomes de imagem", () => {
    expect(engineFromImage("pgvector/pgvector:pg16")).toBe("postgres");
    expect(engineFromImage("mysql/mysql-server:8.0")).toBe("mysql");
    expect(engineFromImage("percona/percona-server:8.0")).toBe("mysql");
    expect(engineFromImage("mongodb/mongodb-enterprise-server:7")).toBe("mongo");
  });

  it("um sinal só não basta (app que usa POSTGRES_USER para falar com o banco); dois tipos que concordam, sim", () => {
    expect(engineFromSignals(c("minha/api:1", env("POSTGRES_USER=app", "POSTGRES_PASSWORD=x")))).toBeNull();
    expect(engineFromSignals(c("minha/api:1", [], { ports: ["5432/tcp"] }))).toBeNull();
    expect(engineFromSignals(c("minha/api:1", [], { mounts: ["/var/lib/postgresql/data"] }))).toBeNull();
    expect(engineFromSignals(c("minha/db:1", env("POSTGRES_PASSWORD=x"), { mounts: ["/var/lib/postgresql/data"] }))).toBe("postgres");
    expect(engineFromSignals(c("minha/db:1", env("MONGO_INITDB_ROOT_USERNAME=r"), { ports: ["27017/tcp"] }))).toBe("mongo");
    expect(engineFromSignals(c("minha/db:1", env("MYSQL_ROOT_PASSWORD=x"), { ports: ["3306/tcp"] }))).toBe("mysql");
    expect(engineFromSignals(c("minha/db:1", env("MARIADB_ROOT_PASSWORD=x"), { ports: ["3306/tcp"] }))).toBe("mariadb");
    // sem variável do MariaDB, a pasta/porta do MySQL valem como MySQL
    expect(engineFromSignals(c("minha/db:1", [], { ports: ["3306/tcp"], mounts: ["/var/lib/mysql"] }))).toBe("mysql");
    expect(engineFromSignals(c("minha/db:1", env("MYSQL_DATABASE=x", "MARIADB_USER=u"), { ports: ["3306/tcp"] }))).toBe("mariadb");
  });

  it("sinais fracos pedem a sonda; sem nenhum, nada é sondado", () => {
    expect(hasDatabaseSignal(c("node:22", []))).toBe(false);
    expect(hasDatabaseSignal(c("node:22", env("PGDATA=/x")))).toBe(true);
    expect(databaseSignals(c("x", []))).toEqual(new Map());
  });

  it("sonda: três resultados (achou, rodou e não achou, não deu para sondar); só binário de SERVIDOR conta", () => {
    expect(ENGINE_PROBE_SCRIPT).toMatch(/command -v postgres/);
    expect(ENGINE_PROBE_SCRIPT).toMatch(/mariadbd/);
    expect(ENGINE_PROBE_SCRIPT).toMatch(/\/proc\/\[0-9\]\*\/comm/);
    expect(ENGINE_PROBE_SCRIPT).not.toMatch(/pg_dump|mysqldump/);
    expect(parseEngineProbe("postgres running\n")).toEqual({ engine: "postgres", running: true });
    expect(parseEngineProbe("mariadb installed")).toEqual({ engine: "mariadb", running: false });
    expect(parseEngineProbe("mysql running\n")).toEqual({ engine: "mysql", running: true });
    expect(parseEngineProbe("mongo installed")).toEqual({ engine: "mongo", running: false });
    expect(parseEngineProbe("none\n")).toBe("none");
    // exec que falhou ou lixo: "não deu para sondar", que NÃO é "none"
    expect(parseEngineProbe("")).toBeNull();
    expect(parseEngineProbe("postgres")).toBeNull();
    expect(parseEngineProbe("bash: command not found")).toBeNull();
  });

  it("o script da sonda roda de verdade: 'none' sem servidor; 'installed' com binário e sem processo", async () => {
    const bin = await mkdtemp(path.join(tmpdir(), "sonda-"));
    try {
      const run = (path_: string) => spawnSync("sh", ["-c", ENGINE_PROBE_SCRIPT], { env: { PATH: path_ }, encoding: "utf8" }).stdout.trim();
      // só o sh e utilitários básicos do sistema (sem postgres etc.)
      expect(run("/usr/bin:/bin")).toBe("none");
      await writeFile(path.join(bin, "postgres"), "#!/bin/sh\n");
      await chmod(path.join(bin, "postgres"), 0o755);
      expect(run(`${bin}:/usr/bin:/bin`)).toMatch(/^postgres (installed|running)$/); // "running" se a máquina de teste roda um postgres
    } finally {
      await rm(bin, { recursive: true, force: true });
    }
  });

  const base = { diffs: {}, sizes: {}, files: new Set<string>(), sourceFolder: null, now: new Date("2026-10-27T00:00:00Z") };

  it("buildDetection: sonda que achou o servidor + porta/pasta/processo vira banco (dump), com detectedBy", () => {
    // instalado + porta (herdada de FROM postgres) NÃO basta; instalado + pasta de dados, sim
    const withPort = buildDetection({ ...base, containers: [c("minha/db:1", [], { ports: ["5432/tcp"] })], probes: { db: { engine: "postgres", running: false } } });
    expect(withPort.databases).toEqual([]);
    const withData = buildDetection({ ...base, containers: [c("minha/db:1", [], { mounts: ["/var/lib/postgresql/data"] })], probes: { db: { engine: "postgres", running: false } } });
    expect(withData.databases).toMatchObject([{ engine: "postgres", detectedBy: "probe", defaultSelected: true }]);
    expect(withData.databases[0]!.serverRunning).toBeUndefined();
    const running = buildDetection({ ...base, containers: [c("minha/db:1", env("POSTGRES_PASSWORD=x"))], probes: { db: { engine: "postgres", running: true } } });
    expect(running.databases).toMatchObject([{ engine: "postgres", detectedBy: "probe", serverRunning: true }]);
    const signalled = buildDetection({ ...base, containers: [c("minha/db:1", env("POSTGRES_PASSWORD=x"), { mounts: ["/var/lib/postgresql/data"] })] });
    expect(signalled.databases).toMatchObject([{ engine: "postgres", detectedBy: "signals" }]);
    expect(signalled.mounts[0]).toMatchObject({ coveredByDump: true, defaultSelected: false });
    const byImage = buildDetection({ ...base, containers: [c("postgres:16", [])] });
    expect(byImage.databases[0]!.detectedBy).toBe("image");
  });

  it("REVISÃO B1: pooler do Supabase (sonda 'none' + POSTGRES_* + porta 5432) NÃO vira banco", () => {
    const d = buildDetection({
      ...base,
      containers: [c("supabase/supavisor:2.5.1", ["POSTGRES_DB=postgres", "POSTGRES_PASSWORD=x", "POSTGRES_PORT=5432"], { ports: ["5432/tcp", "6543/tcp"] })],
      probes: { db: "none" },
    });
    expect(d.databases).toEqual([]);
  });

  it("REVISÃO B1: ferramenta FROM postgres (binário instalado, só variáveis de cliente, sem processo) NÃO vira banco", () => {
    const d = buildDetection({
      ...base,
      containers: [c("prodrigestivill/postgres-backup-local:16", ["POSTGRES_HOST=db", "POSTGRES_DB=app", "POSTGRES_USER=app", "POSTGRES_PASSWORD=x"], { mounts: ["/backups"] })],
      probes: { db: { engine: "postgres", running: false } },
    });
    expect(d.databases).toEqual([]);
  });

  it("não deu para sondar (null): só vale com sinais E pasta de dados montada; porta e variáveis sozinhas não bastam", () => {
    const no = buildDetection({ ...base, containers: [c("x/y:1", env("POSTGRES_PASSWORD=x"), { ports: ["5432/tcp"] })], probes: { db: null } });
    expect(no.databases).toEqual([]);
    const yes = buildDetection({ ...base, containers: [c("x/y:1", env("POSTGRES_PASSWORD=x"), { mounts: ["/var/lib/postgresql/data"] })], probes: { db: null } });
    expect(yes.databases).toMatchObject([{ engine: "postgres", detectedBy: "signals" }]);
  });

  it("sonda 'none' também veta o que seria reconhecido só por sinais, e a pasta de dados vira 'suspeita'", () => {
    const d = buildDetection({ ...base, containers: [c("x/y:1", env("POSTGRES_PASSWORD=x"), { mounts: ["/var/lib/postgresql/data"] })], probes: { db: "none" } });
    expect(d.databases).toEqual([]);
    expect(d.mounts[0]).toMatchObject({ suspectedDatabase: "postgres", defaultSelected: false });
  });

  it("MariaDB/MySQL achados pela sonda contam os sinais dos dois nomes", () => {
    const d = buildDetection({ ...base, containers: [c("x/y:1", [], { mounts: ["/var/lib/mysql"] })], probes: { db: { engine: "mariadb", running: false } } });
    expect(d.databases).toMatchObject([{ engine: "mariadb", detectedBy: "probe" }]);
  });

  it("pasta de dados de banco NÃO reconhecido vem desmarcada, com o motivo e a marca de suspeita", () => {
    for (const [dest, engine] of [
      ["/var/lib/postgresql/data", "postgres"],
      ["/var/lib/mysql", "mysql"],
      ["/data/db", "mongo"],
    ] as const) {
      const d = buildDetection({ ...base, containers: [c("minha/api:1", [], { mounts: [dest] })] });
      expect(d.databases).toEqual([]);
      expect(d.mounts[0]).toMatchObject({ suspectedDatabase: engine, defaultSelected: false, coveredByDump: false, reason: SUSPECTED_REASON });
    }
    // pasta comum de dados (nem de banco) continua como antes
    const plain = buildDetection({ ...base, containers: [c("minha/api:1", [], { mounts: ["/app/data"] })] });
    expect(plain.mounts[0]).toMatchObject({ defaultSelected: true });
    expect(plain.mounts[0]!.suspectedDatabase).toBeUndefined();
  });

  it("restauração do Postgres para no primeiro erro e dentro de uma transação", () => {
    expect(restoreScript("postgres")).toMatch(/ON_ERROR_STOP=1/);
    expect(restoreScript("postgres")).toMatch(/--single-transaction/);
  });
});

describe("restauração do PostgreSQL por troca: scripts", () => {
  it("têm sintaxe de shell válida e guardam as garantias (transação única, parar no erro, apagar o temporário, desfazer a troca)", () => {
    for (const script of [PG_RESTORE_TEMP, PG_SWAP, PG_REVERT, PG_DROP, PG_SWAP_FIX, PG_SWEEP_LIST, PG_SPACE]) {
      expect(spawnSync("sh", ["-n", "-c", script], { encoding: "utf8" }).status).toBe(0);
    }
    // sem transação única no banco descartável (não estoura max_locks_per_transaction), mas para no primeiro erro
    expect(PG_RESTORE_TEMP).not.toMatch(/--single-transaction/);
    expect(PG_RESTORE_TEMP).toMatch(/ON_ERROR_STOP=1/);
    expect(PG_RESTORE_TEMP).toMatch(/dropdb .*"\$NEW"/);
    expect(PG_RESTORE_TEMP).toMatch(/-T template0 -O "\$OWNER" -E "\$ENC" --lc-collate/);
    expect(PG_SWAP).toMatch(/ALLOW_CONNECTIONS false/);
    expect(PG_SWAP).toMatch(/pg_terminate_backend/);
    expect(PG_SWAP).toMatch(/RENAME TO :"o"/);
    expect(PG_SWAP).toMatch(/echo created/);
    expect(PG_REVERT).toMatch(/RENAME TO :"a"/);
    expect(PG_DROP).toMatch(/--force/);
  });
});

describe("REVISÃO B3: o banco novo herda o que é do banco (dono, locale, ALTER DATABASE SET, privilégios, limite, comentário)", () => {
  it("o SQL de cópia consulta o catálogo do banco ATUAL e cobre tudo o que um dump sem -C não leva", () => {
    expect(PG_COPY_SQL).toMatch(/pg_db_role_setting/);
    expect(PG_COPY_SQL).toMatch(/setrole = 0/); // ALTER DATABASE ... SET
    expect(PG_COPY_SQL).toMatch(/ALTER ROLE %I IN DATABASE %I SET/);
    expect(PG_COPY_SQL).toMatch(/REVOKE ALL ON DATABASE %I FROM PUBLIC/);
    expect(PG_COPY_SQL).toMatch(/aclexplode\(d\.datacl\)/);
    expect(PG_COPY_SQL).toMatch(/CONNECTION LIMIT/);
    expect(PG_COPY_SQL).toMatch(/COMMENT ON DATABASE %I IS %L/);
    // nome da configuração entre aspas (app.settings.jwt_secret) e valor literal; listas (search_path) sem aspas de valor
    expect(PG_COPY_SQL).toMatch(/SET %I TO %s/);
    expect(PG_COPY_SQL).toMatch(/quote_literal\(substr\(s, strpos\(s, '='\) \+ 1\)\)/);
    expect(PG_COPY_SQL).toMatch(/'search_path'/);
    expect(PG_RESTORE_TEMP).toMatch(/-T template0/);
    expect(PG_RESTORE_TEMP).toMatch(/--locale-provider=icu --icu-locale/);
  });

  const run = async (opts: { restoreFails?: boolean; noDatabase?: boolean; propFails?: boolean }) => {
    const dir = await mkdtemp(path.join(tmpdir(), "paas-pg-stub-"));
    const log = path.join(dir, "log");
    const bin = path.join(dir, "bin");
    await mkdir(bin);
    // psql de mentira: responde ao catálogo com dados fixos e registra tudo o que recebe
    await writeFile(
      path.join(bin, "psql"),
      [
        "#!/bin/sh",
        'in=$(cat)',
        'echo "psql $*" >> "$LOG"',
        'case "$in" in',
        opts.noDatabase ? "  *datdba*) ;;" : "  *datdba*) echo 'dono|UTF8|pt_BR.utf8|pt_BR.utf8|i|pt-BR|pg_default' ;;",
        `  *pg_db_role_setting*) printf '%s\\n' "ALTER DATABASE tws_new_x SET \\"app.settings.jwt_secret\\" TO 'segredo-de-teste';" "ALTER DATABASE tws_new_x CONNECTION LIMIT 5;" ;;`,
        opts.propFails ? '  *"CONNECTION LIMIT 5"*) echo "ERROR: permission denied to set parameter" >&2; exit 1 ;;' : '  *"CONNECTION LIMIT 5"*) echo "STDIN: $in" >> "$LOG" ;;',
        opts.restoreFails ? '  *BOOM*) echo "ERROR: boom" >&2; exit 3 ;;' : "  *BOOM*) ;;",
        '  *) echo "STDIN: $in" >> "$LOG" ;;',
        "esac",
      ].join("\n"),
    );
    for (const name of ["createdb", "dropdb"]) await writeFile(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "$LOG"\n`);
    for (const name of ["psql", "createdb", "dropdb"]) await chmod(path.join(bin, name), 0o755);
    const res = spawnSync("sh", ["-c", PG_RESTORE_TEMP, "sh", "loja", "tws_new_x"], {
      encoding: "utf8",
      input: opts.restoreFails ? "BOOM" : "CREATE TABLE t();",
      env: { PATH: `${bin}:${process.env.PATH}`, LOG: log, POSTGRES_USER: "admin", POSTGRES_PASSWORD: "x" },
    });
    const text = await readFile(log, "utf8");
    await rm(dir, { recursive: true, force: true });
    return { status: res.status, text, stderr: res.stderr };
  };

  it("caso Supabase: o banco novo nasce do template0 com dono e locale do atual e recebe o ALTER DATABASE SET (app.settings.jwt_secret) antes da troca", async () => {
    const { status, text } = await run({});
    expect(status).toBe(0);
    expect(text).toMatch(/createdb -U admin -T template0 -O dono -E UTF8 --lc-collate=pt_BR\.utf8 --lc-ctype=pt_BR\.utf8 --locale-provider=icu --icu-locale=pt-BR tws_new_x/);
    // restaura o dump no temporário, sem transação única, parando no primeiro erro
    expect(text).toMatch(/psql -U admin -d tws_new_x -X -q -v ON_ERROR_STOP=1\n/);
    expect(text).not.toMatch(/single-transaction/);
    // e aplica o que veio do catálogo
    expect(text).toMatch(/STDIN: ALTER DATABASE tws_new_x SET "app\.settings\.jwt_secret" TO 'segredo-de-teste';/);
    expect(text).toMatch(/STDIN: ALTER DATABASE tws_new_x CONNECTION LIMIT 5;/);
    expect(text).not.toMatch(/dropdb/);
  });

  it("erro no dump: o temporário é apagado, nada do catálogo é aplicado e o script sai com erro", async () => {
    const { status, text } = await run({ restoreFails: true });
    expect(status).toBe(3);
    expect(text).toMatch(/dropdb -U admin --if-exists tws_new_x/);
    expect(text).not.toMatch(/STDIN: ALTER DATABASE/);
  });

  it("R6: erro ao copiar uma propriedade (falta de privilégio) vira aviso na saída de erro e NÃO derruba a restauração", async () => {
    const { status, stderr } = await run({ propFails: true });
    expect(status).toBe(0);
    expect(stderr).toMatch(/TWS_PROP: ERROR: permission denied to set parameter/);
  });

  it("R2/R3: exclusão estrita dos temporários e lista vazia (search_path = '') com SQL válido", () => {
    expect(dumpPlan("postgres")[0]!.script).toMatch(/datname !~ '\^tws_\(new\|old\)_\[0-9a-f\]\{12\}\$'/);
    expect(PG_SWEEP_LIST).toMatch(/datname ~ '\^tws_\(new\|old\)_\[0-9a-f\]\{12\}\$'/);
    // valor de lista vazio ("" ou '') vira '' em vez de "" (que o Postgres recusa)
    expect(PG_COPY_SQL.match(/IN \('', '""'\) THEN ''''''/g)).toHaveLength(2);
    expect(PG_COPY_SQL).toMatch(/replace\(replace\(shobj_description/);
  });

  it("banco que ainda não existe: cria simples (sem dono nem locale) e não copia nada", async () => {
    const { status, text } = await run({ noDatabase: true });
    expect(status).toBe(0);
    expect(text).toMatch(/createdb -U admin tws_new_x/);
    expect(text).not.toMatch(/template0/);
    expect(text).not.toMatch(/STDIN: ALTER DATABASE/);
  });

  it("I8: a lista de bancos do dump não leva os temporários do painel", () => {
    expect(dumpPlan("postgres")[0]!.script).toMatch(/tws_\(new\|old\)/);
  });
});
