/**
 * backup-detect.test.ts — o que a aba Backups do projeto encontra nos
 * containers (bancos pela imagem, volumes e pastas montadas, arquivos fora
 * de volume) e os comandos de dump/restauração de cada banco. Puro: a saída
 * do `docker inspect`/`docker diff` entra como dado.
 */
import { describe, expect, it } from "vitest";
import {
  buildDetection,
  dumpPlan,
  engineFromImage,
  itemFileName,
  mountId,
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
