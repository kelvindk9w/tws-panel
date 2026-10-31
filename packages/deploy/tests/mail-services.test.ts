import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dockerfileFinalBaseImage } from "../src/dockerfile.js";
import { composeBuildBaseImages, selectMailServices, serviceMailLabel } from "../src/mail-services.js";

describe("dockerfileFinalBaseImage", () => {
  it("segue o apelido do estágio até a imagem", () => {
    expect(dockerfileFinalBaseImage("FROM node:22 AS build\nFROM postgres:16 AS base\nFROM base AS final\nRUN x")).toBe("postgres:16");
    expect(dockerfileFinalBaseImage("FROM node:22 AS build\nFROM nginx:1\nCOPY --from=build /a /b")).toBe("nginx:1");
    expect(dockerfileFinalBaseImage("FROM --platform=linux/amd64 redis:7")).toBe("redis:7");
  });
  it("H1: com target parte do estágio de apelido igual (qualquer ordem); alvo desconhecido: null", () => {
    const a = "FROM php:8 AS app\nFROM postgres:16 AS db\n";
    const b = "FROM postgres:16 AS DB\nFROM php:8 AS app\n";
    expect(dockerfileFinalBaseImage(a, "app")).toBe("php:8");
    expect(dockerfileFinalBaseImage(a, "db")).toBe("postgres:16");
    expect(dockerfileFinalBaseImage(a)).toBe("postgres:16");
    expect(dockerfileFinalBaseImage(b, "app")).toBe("php:8");
    expect(dockerfileFinalBaseImage(b, "db")).toBe("postgres:16");
    expect(dockerfileFinalBaseImage(a, "nada")).toBeNull();
    expect(dockerfileFinalBaseImage("FROM node:22 AS base\nFROM base AS web\nFROM redis:7 AS r\n", "web")).toBe("node:22");
  });
  it("sem FROM ou scratch: null", () => {
    expect(dockerfileFinalBaseImage("RUN x")).toBeNull();
    expect(dockerfileFinalBaseImage("FROM scratch")).toBeNull();
    expect(dockerfileFinalBaseImage("FROM")).toBeNull();
  });
});

describe("serviceMailLabel", () => {
  it("lê mapa e lista; ausente é null", () => {
    expect(serviceMailLabel({ labels: { "tws.mail": "true" } })).toBe("true");
    expect(serviceMailLabel({ labels: { "tws.mail": null } })).toBe("");
    expect(serviceMailLabel({ labels: { outra: "x" } })).toBeNull();
    expect(serviceMailLabel({ labels: ["a=b", 3, "tws.mail=false"] })).toBe("false");
    expect(serviceMailLabel({ labels: ["tws.mail"] })).toBe("");
    expect(serviceMailLabel({ labels: ["a=b"] })).toBeNull();
    expect(serviceMailLabel({})).toBeNull();
    expect(serviceMailLabel(undefined)).toBeNull();
  });
});

describe("selectMailServices", () => {
  const compose = [
    "services:",
    "  web: { image: web:1 }",
    "  worker: { image: web:1 }",
    "  db: { image: mysql:8 }",
    "  cache: { image: redis:7 }",
    "  pg: { build: ./pg }",
    "  smtp-db: { image: postgres:16, labels: ['tws.mail=true'] }",
    "  quiet: { image: web:1, labels: { tws.mail: 'false' } }",
  ].join("\n");
  const names = ["web", "worker", "db", "cache", "pg", "smtp-db", "quiet"];

  it("separa app/worker de banco/cache, build sobre banco e a label", () => {
    const r = selectMailServices(compose, names, undefined, { pg: "postgres:16" });
    expect(r.included).toEqual(["web", "worker", "smtp-db"]);
    expect(r.forced).toEqual(["smtp-db"]);
    expect(r.excluded.map((e) => [e.service, e.decision.reason])).toEqual([
      ["db", "database-image"],
      ["cache", "database-image"],
      ["pg", "database-build"],
      ["quiet", "label"],
    ]);
  });

  it("usa o modelo resolvido quando existe e tolera serviço desconhecido", () => {
    const resolved = { services: { app: { image: "a:1" }, db: { image: "mongo:7" } } };
    const r = selectMailServices("", ["app", "db", "fantasma"], resolved);
    expect(r.included).toEqual(["app", "fantasma"]);
    expect(r.excluded.map((e) => e.service)).toEqual(["db"]);
  });
});

describe("selectMailServices — rede compartilhada e labels", () => {
  it("M2: quem usa a rede de um serviço de fora sai junto; com o dono ligado, entra", () => {
    const resolved = { services: { db: { image: "postgres:16" }, side: { image: "s:1", network_mode: "service:db", labels: { "tws.mail": "true" } }, web: { image: "w:1" } } };
    const r = selectMailServices("", ["db", "side", "web"], resolved);
    expect(r.included).toEqual(["web"]);
    expect(r.excluded.map((e) => [e.service, e.decision.reason, e.decision.image])).toEqual([
      ["db", "database-image", "postgres:16"],
      ["side", "shared-network", "db"],
    ]);
    const ligado = { services: { db: { image: "postgres:16", labels: ["tws.mail=true"] }, side: { image: "s:1", network_mode: "service:db" } } };
    expect(selectMailServices("", ["db", "side"], ligado).included).toEqual(["db", "side"]);
  });

  it("L5: valor desconhecido da label é registrado", () => {
    const resolved = { services: { a: { image: "x", labels: ["tws.mail=sim"] }, b: { image: "x", labels: ["tws.mail"] }, c: { image: "x", labels: ["tws.mail=TRUE"] } } };
    expect(selectMailServices("", ["a", "b", "c"], resolved).badLabels).toEqual([
      { service: "a", value: "sim" },
      { service: "b", value: "" },
    ]);
  });

  it("H1: build.target do compose decide a imagem-base lida", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paas-target-"));
    try {
      await writeFile(path.join(root, "Dockerfile"), "FROM php:8 AS app\nFROM postgres:16 AS db\n");
      const compose = "services:\n  web: { build: { context: ., target: app } }\n  banco: { build: { context: ., target: db } }\n  tudo: { build: . }\n";
      await expect(composeBuildBaseImages(compose, undefined, root)).resolves.toEqual({ web: "php:8", banco: "postgres:16", tudo: "postgres:16" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("composeBuildBaseImages", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "paas-mailsvc-"));
    await mkdir(path.join(root, "pg"));
    await mkdir(path.join(root, "app"));
    await writeFile(path.join(root, "pg", "Dockerfile"), "FROM postgres:16\n");
    await writeFile(path.join(root, "app", "Dockerfile.prod"), "FROM node:22\n");
    await writeFile(path.join(root, "segredo"), "FROM redis:7\n");
    await symlink(path.join(root, "segredo"), path.join(root, "app", "Dockerfile"));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("lê o Dockerfile de cada build; ignora inline, fora da pasta, ausente e link simbólico", async () => {
    const compose = [
      "services:",
      "  pg: { build: ./pg }",
      "  app: { build: { context: ./app, dockerfile: Dockerfile.prod } }",
      "  link: { build: { context: ./app } }",
      "  inline: { build: { dockerfile_inline: 'FROM redis:7' } }",
      "  fora: { build: { context: ../outro } }",
      "  falta: { build: ./nao-existe }",
      "  semctx: { build: { dockerfile: pg/Dockerfile } }",
      "  pronta: { image: redis:7 }",
    ].join("\n");
    await expect(composeBuildBaseImages(compose, undefined, root)).resolves.toEqual({ pg: "postgres:16", app: "node:22", semctx: "postgres:16" });
  });

  it("modelo resolvido (contexto absoluto) também vale", async () => {
    const resolved = { services: { pg: { build: { context: path.join(root, "pg"), dockerfile: "Dockerfile" } } } };
    await expect(composeBuildBaseImages("", resolved, root)).resolves.toEqual({ pg: "postgres:16" });
  });
});
