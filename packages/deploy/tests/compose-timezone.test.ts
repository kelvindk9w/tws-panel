/**
 * compose-timezone.test.ts — fuso do projeto no compose: quem já define TZ
 * fica como está; os demais serviços recebem o TZ escolhido no painel pelo
 * paas.override.yml.
 */
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { composeOverrideYaml } from "../src/compose-override.js";
import { composeDockerfiles, composeTimezoneExcluded, composeEnvFiles, composeServiceList, composeTimezoneDefinitions, timezoneServiceEnv, tzInDotenv } from "../src/compose-timezone.js";

const COMPOSE = `services:
  web:
    image: node:22
    environment:
      TZ: Europe/Lisbon
  api:
    image: node:22
    environment:
      - NODE_ENV=production
      - TZ=America/Manaus
  worker:
    image: node:22
    environment:
      - TZ
  cron:
    image: alpine:3
    env_file: ./config/cron.env
  db:
    image: postgres:17
    env_file:
      - .env
  cache:
    image: redis:7
    env_file:
      - path: ./sem-tz.env
        required: false
      - ./nao-existe.env
  nulo:
    image: alpine:3
    environment:
      TZ:
  livre:
    image: alpine:3
`;

const files: Record<string, string> = {
  "./config/cron.env": "# fuso\nexport TZ='Asia/Tokyo'\nOUTRA=1\n",
  "./sem-tz.env": "A=1\n",
};

describe("composeTimezoneDefinitions", () => {
  it("acha TZ no environment (mapa e lista), no .env das Variáveis e em env_file", () => {
    const defs = composeTimezoneDefinitions(COMPOSE, { TZ: "America/Bahia" }, (p) => files[p] ?? null);
    expect(defs).toEqual([
      { service: "web", value: "Europe/Lisbon", where: "compose" },
      { service: "api", value: "America/Manaus", where: "compose" },
      { service: "worker", value: "(do ambiente do servidor)", where: "compose" },
      { service: "cron", value: "Asia/Tokyo", where: "env_file" },
      { service: "db", value: "America/Bahia", where: "variables" },
      { service: "nulo", value: "(do ambiente do servidor)", where: "compose" },
    ]);
  });

  it(".env sem TZ nas Variáveis não conta; compose inválido ou vazio não quebra", () => {
    const defs = composeTimezoneDefinitions(COMPOSE, { TZ: "" }, () => null);
    expect(defs.map((d) => d.service)).toEqual(["web", "api", "worker", "nulo"]);
    expect(composeTimezoneDefinitions("services: [", {}, () => null)).toEqual([]);
    expect(composeTimezoneDefinitions("", {}, () => null)).toEqual([]);
    expect(composeTimezoneDefinitions("services:\n  a:\n", {}, () => null)).toEqual([]);
    expect(composeTimezoneDefinitions("services:\n  a:\n    environment: [1, 2]\n", {}, () => null)).toEqual([]);
  });

  it("lista os env_file dos serviços (menos o .env, que vem das Variáveis)", () => {
    expect(composeEnvFiles(COMPOSE)).toEqual(["./config/cron.env", "./sem-tz.env", "./nao-existe.env"]);
    expect(composeEnvFiles("services: [")).toEqual([]);
    expect(composeEnvFiles("services:\n  a:\n  b:\n    env_file: [{ required: false }]\n")).toEqual([]);
  });

  it("lê o TZ de um .env (última definição, sem aspas)", () => {
    expect(tzInDotenv('TZ="America/Recife"\nTZ=UTC\n')).toBe("UTC");
    expect(tzInDotenv("TZX=1\n# TZ=foo\n")).toBeUndefined();
    expect(tzInDotenv("  TZ = Europe/Paris \r\n")).toBe("Europe/Paris");
  });
});

describe("TZ por serviço no override", () => {
  it("todos os serviços menos os que já definem; sem fuso, nada", () => {
    const services = composeServiceList(COMPOSE);
    expect(services).toEqual(["web", "api", "worker", "cron", "db", "cache", "nulo", "livre"]);
    const defs = composeTimezoneDefinitions(COMPOSE, {}, (p) => files[p] ?? null);
    expect(timezoneServiceEnv(services, defs, "America/Sao_Paulo")).toEqual({
      db: { TZ: "America/Sao_Paulo" },
      cache: { TZ: "America/Sao_Paulo" },
      livre: { TZ: "America/Sao_Paulo" },
    });
    expect(timezoneServiceEnv(services, defs, null)).toEqual({});
    expect(composeServiceList("services: [")).toEqual([]);
    expect(composeServiceList("")).toEqual([]);
  });

  it("o override junta o TZ com as variáveis do e-mail no mesmo environment", () => {
    const yaml = composeOverrideYaml({
      compose: "services:\n  web:\n    image: nginx\n  worker:\n    image: app\n",
      proxyService: "web",
      slug: "loja",
      network: "paas-net",
      env: { SMTP_HOST: "mail" },
      envServices: ["web", "worker"],
      serviceEnv: { web: { TZ: "America/Sao_Paulo" }, extra: { TZ: "America/Sao_Paulo" } },
    });
    const doc = parse(yaml);
    expect(doc.services.web.environment).toEqual({ SMTP_HOST: "mail", TZ: "America/Sao_Paulo" });
    expect(doc.services.web.networks).toEqual({ default: null, "paas-net": { aliases: ["loja"] } });
    expect(doc.services.worker.environment).toEqual({ SMTP_HOST: "mail" });
    expect(doc.services.extra.environment).toEqual({ TZ: "America/Sao_Paulo" });
  });
});

describe("bancos, caches e ENV TZ do Dockerfile", () => {
  const YML = `services:
  app:
    build: ./app
  api:
    build:
      context: .
      dockerfile: docker/Dockerfile.api
  inline:
    build:
      dockerfile_inline: "FROM x"
  nobuild:
    image: alpine
  envwins:
    build: ./app
    environment:
      TZ: UTC
  db:
    image: mysql:8
  pg:
    image: docker.io/library/postgres:17
  cache:
    image: redis:7
`;
  const files: Record<string, string> = {
    "app/Dockerfile": "FROM node\nENV TZ=Asia/Tokyo\n",
    "docker/Dockerfile.api": "FROM php\nRUN true\n",
  };

  it("detecta ENV TZ do Dockerfile só de serviço com build legível; o compose vence", () => {
    const defs = composeTimezoneDefinitions(YML, {}, (p) => files[p] ?? null);
    expect(defs).toEqual([
      { service: "app", value: "Asia/Tokyo", where: "dockerfile" },
      { service: "envwins", value: "UTC", where: "compose" },
    ]);
  });

  it("lista os Dockerfiles e os bancos/caches", () => {
    expect(composeDockerfiles(YML)).toEqual(["app/Dockerfile", "docker/Dockerfile.api"]);
    expect(composeDockerfiles("services: [")).toEqual([]);
    expect(composeTimezoneExcluded(YML)).toEqual([
      { service: "db", image: "mysql:8" },
      { service: "pg", image: "docker.io/library/postgres:17" },
      { service: "cache", image: "redis:7" },
    ]);
    expect(composeTimezoneExcluded("services: [")).toEqual([]);
  });

  it("o override não injeta TZ nos excluídos", () => {
    const defs = composeTimezoneDefinitions(YML, {}, (p) => files[p] ?? null);
    const env = timezoneServiceEnv(composeServiceList(YML), defs, "America/Sao_Paulo", composeTimezoneExcluded(YML));
    expect(Object.keys(env)).toEqual(["api", "inline", "nobuild"]);
  });
});
