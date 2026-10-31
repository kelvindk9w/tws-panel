/**
 * compose-services.ts — a lista de TODOS os serviços do compose, para o
 * painel mostrar o que vai subir (antes só aparecia a entrada HTTP).
 *
 * Fixture com a ESTRUTURA do caso real (vitrine, 03/10/2026), sem valores
 * reais: db e redis com healthcheck; ledger construído do repositório,
 * publicando 80/443 e a porta administrativa só em 127.0.0.1, com
 * healthcheck no Dockerfile; web construído de outro Dockerfile, na rede do
 * ledger, esperando o ledger saudável; caddy (imagem) na rede do ledger.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeComposeServices } from "../src/compose-services.js";
import { VITRINE_LIKE } from "./fixtures/vitrine-like.js";


const LEDGER_DOCKERFILE = `FROM node:22-alpine
WORKDIR /app
EXPOSE 8009 8010
HEALTHCHECK --interval=5s --timeout=3s \\
  CMD wget -qO- http://127.0.0.1:8009/pronto || exit 1
CMD ["node", "dist/main.js"]
`;

const WEB_DOCKERFILE = `FROM node:22-alpine
EXPOSE \${PORT}
HEALTHCHECK CMD wget -qO- http://localhost:3200/api/saude || exit 1
`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-compose-services-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("describeComposeServices — estrutura da vitrine", () => {
  it("lista os cinco serviços com imagem/build, portas, rede, dependências e healthcheck", async () => {
    await writeFile(path.join(dir, "Dockerfile"), LEDGER_DOCKERFILE);
    await mkdir(path.join(dir, "services", "web"), { recursive: true });
    await writeFile(path.join(dir, "services", "web", "Dockerfile"), WEB_DOCKERFILE);

    const services = await describeComposeServices(dir, VITRINE_LIKE);
    expect(services.map((s) => s.name)).toEqual(["db", "redis", "ledger", "web", "caddy"]);
    const byName = Object.fromEntries(services.map((s) => [s.name, s]));

    expect(byName.db).toEqual({
      name: "db",
      image: "postgres:18-alpine",
      build: null,
      publishedPorts: [],
      internalPorts: [],
      networkModeService: null,
      dependsOn: [],
      healthcheck: "compose",
    });

    expect(byName.ledger!.image).toBeNull();
    expect(byName.ledger!.build).toEqual({ context: ".", dockerfile: "Dockerfile" });
    // 80/443 de um serviço com Caddy próprio na rede dele: o painel não retira
    expect(byName.ledger!.publishedPorts).toEqual([
      { mapping: "80:80", containerPort: 80, hostPort: 80, panel: "conflict" },
      { mapping: "443:443", containerPort: 443, hostPort: 443, panel: "conflict" },
      { mapping: "127.0.0.1:8010:8010", containerPort: 8010, hostPort: 8010, panel: null },
    ]);
    expect(byName.ledger!.internalPorts).toEqual([
      { port: 8009, source: "dockerfile" },
      { port: 8010, source: "dockerfile" },
    ]);
    expect(byName.ledger!.healthcheck).toBe("dockerfile");
    expect(byName.ledger!.dependsOn).toEqual([
      { service: "db", condition: "service_healthy" },
      { service: "redis", condition: "service_healthy" },
    ]);

    expect(byName.web!.build).toEqual({ context: ".", dockerfile: "services/web/Dockerfile" });
    expect(byName.web!.networkModeService).toBe("ledger");
    // EXPOSE com variável é ignorado; a porta vem do healthcheck e da PORT
    expect(byName.web!.internalPorts).toEqual([{ port: 3200, source: "healthcheck" }]);
    expect(byName.web!.healthcheck).toBe("dockerfile");

    expect(byName.caddy!.image).toBe("caddy:2-alpine");
    expect(byName.caddy!.networkModeService).toBe("ledger");
    expect(byName.caddy!.healthcheck).toBeNull();
  });
});

describe("describeComposeServices — outras formas", () => {
  it("app comum: 80/443 retiradas pelo painel; expose; build em string; depends_on em lista", async () => {
    await mkdir(path.join(dir, "app"));
    await writeFile(path.join(dir, "app", "Dockerfile"), "FROM nginx\nEXPOSE 80/tcp 8443/udp\n");
    const compose = `services:
  app:
    build: ./app
    ports: ["80:3000", "8080:3000"]
    expose: ["3000", "9000/tcp", "\${X}"]
    environment: ["PORT=3000", "OUTRA=1"]
    depends_on: [db]
    healthcheck:
      disable: true
  db:
    image: mysql:8
    healthcheck:
      test: ["NONE"]
  worker:
    image: app-worker
    environment:
      PORT: "\${PORT}"
    healthcheck:
      test: "curl -f http://0.0.0.0:7000/saude"
`;
    const services = await describeComposeServices(dir, compose);
    const [app, db, worker] = services;
    expect(app!.build).toEqual({ context: "./app", dockerfile: "Dockerfile" });
    expect(app!.publishedPorts).toEqual([
      { mapping: "80:3000", containerPort: 3000, hostPort: 80, panel: "removed" },
      { mapping: "8080:3000", containerPort: 3000, hostPort: 8080, panel: null },
    ]);
    expect(app!.internalPorts).toEqual([
      { port: 3000, source: "expose" },
      { port: 9000, source: "expose" },
      { port: 80, source: "dockerfile" },
      { port: 8443, source: "dockerfile" },
    ]);
    expect(app!.dependsOn).toEqual([{ service: "db", condition: null }]);
    expect(app!.healthcheck).toBe("disabled");
    expect(db!.healthcheck).toBe("disabled");
    expect(worker!.internalPorts).toEqual([{ port: 7000, source: "healthcheck" }]);
    expect(worker!.healthcheck).toBe("compose");
  });

  it("PORT numérica vira porta interna quando nada mais diz a porta", async () => {
    const services = await describeComposeServices(
      dir,
      "services:\n  api:\n    image: node:22\n    environment:\n      PORT: 4000\n",
    );
    expect(services[0]!.internalPorts).toEqual([{ port: 4000, source: "environment" }]);
  });

  it("não lê Dockerfile fora da pasta do projeto, de contexto remoto ou ausente", async () => {
    const compose = `services:
  fora:
    build:
      context: ../..
      dockerfile: etc/passwd
  remoto:
    build: https://example.com.br/repo.git
  sem-arquivo:
    build: .
  inline:
    build:
      context: .
      dockerfile_inline: "FROM alpine"
`;
    const services = await describeComposeServices(dir, compose);
    for (const s of services) expect(s.internalPorts).toEqual([]);
    expect(services[1]!.build).toEqual({ context: "https://example.com.br/repo.git", dockerfile: "Dockerfile" });
  });

  it("compose inválido, sem serviços ou com serviço vazio", async () => {
    expect(await describeComposeServices(dir, "services: [")).toEqual([]);
    expect(await describeComposeServices(dir, "x: 1")).toEqual([]);
    const [vazio] = await describeComposeServices(dir, "services:\n  vazio:\n");
    expect(vazio).toEqual({
      name: "vazio",
      image: null,
      build: null,
      publishedPorts: [],
      internalPorts: [],
      networkModeService: null,
      dependsOn: [],
      healthcheck: null,
    });
  });

  it("porta publicada por variável ou aleatória: porta do host desconhecida", async () => {
    const [s] = await describeComposeServices(dir, 'services:\n  a:\n    image: x\n    ports: ["${P}:5000", "6000"]\n');
    expect(s!.publishedPorts.map((p) => p.hostPort)).toEqual([null, null]);
  });

  it("formas de mapeamento: IPv6, faixa, variável e aleatória", async () => {
    const [s] = await describeComposeServices(
      dir,
      'services:\n  a:\n    image: x\n    ports: ["[::1]:9000:9000", "8000-8005:80", "${P}:5000", "6000"]\n',
    );
    expect(s!.publishedPorts.map((p) => p.mapping)).toEqual(["[::1]:9000:9000", "8000-8005:80", "${P}:5000", "6000"]);
  });

  it("lê a política de reinício só quando declarada (inclui `no` sem aspas, que o YAML lê como false)", async () => {
    const list = await describeComposeServices(
      dir,
      "services:\n  a:\n    image: x\n    restart: always\n  b:\n    image: x\n    restart: no\n  c:\n    image: x\n    restart: \"no\"\n  d:\n    image: x\n",
    );
    expect(list.map((s) => s.restart)).toEqual(["always", "no", "no", undefined]);
    expect("restart" in list[3]!).toBe(false);
  });
});
