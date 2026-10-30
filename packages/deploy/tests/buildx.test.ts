import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUILDX_MISSING_MESSAGE, BUILDX_UNUSABLE_MESSAGE, buildkitEnv, buildxHintFromOutput, checkBuildx, composeHasBuild, probeConfigDirs } from "../src/buildx.js";

describe("checkBuildx", () => {
  it("version e inspect respondem: devolve a versão, e os dois rodam com o ambiente de build", async () => {
    const vistos: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const r = await checkBuildx(async (_f, args, opts) => {
      vistos.push({ args, env: opts?.env });
      return { code: 0, stdout: "docker/buildx v0.38.1 abc\n", stderr: "" };
    });
    expect(r).toEqual({ ok: true, version: "docker/buildx v0.38.1 abc" });
    expect(vistos.map((v) => v.args)).toEqual([["buildx", "version"], ["buildx", "inspect"]]);
    expect(vistos.every((v) => v.env?.DOCKER_BUILDKIT === "1")).toBe(true);
  });

  it("sem o plugin: reason missing, e o inspect nem roda", async () => {
    const chamadas: string[] = [];
    const r = await checkBuildx(async (_f, args) => {
      chamadas.push(args[1]!);
      return { code: 1, stdout: "", stderr: "docker: unknown command: docker buildx\nmais\n" };
    });
    expect(r).toEqual({ ok: false, detail: "docker: unknown command: docker buildx", reason: "missing" });
    expect(chamadas).toEqual(["version"]);
  });

  it("plugin presente mas o estado não grava (rootfs somente leitura): reason unusable com o motivo", async () => {
    const r = await checkBuildx(async (_f, args) =>
      args[1] === "version"
        ? { code: 0, stdout: "docker/buildx v0.38.1\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "ERROR: mkdir /app/.docker/buildx/instances: read-only file system\n" },
    );
    expect(r).toEqual({ ok: false, detail: "ERROR: mkdir /app/.docker/buildx/instances: read-only file system", reason: "unusable" });
  });

  it("falha sem nenhuma saída vira detalhe vazio; sucesso sem saída, versão vazia", async () => {
    expect(await checkBuildx(async () => ({ code: 1, stdout: "", stderr: "" }))).toEqual({ ok: false, detail: "", reason: "missing" });
    expect(await checkBuildx(async () => ({ code: 0, stdout: "", stderr: "" }))).toEqual({ ok: true, version: "" });
  });
});

describe("composeHasBuild", () => {
  it("qualquer serviço com build conta: contexto local, dockerfile_inline e contexto remoto", () => {
    expect(composeHasBuild({ services: { a: { image: "x" }, b: { build: { context: "." } } } })).toBe(true);
    expect(composeHasBuild({ services: { a: { build: { dockerfile_inline: "FROM alpine\nCOPY --chmod=755 a b" } } } })).toBe(true);
    expect(composeHasBuild({ services: { a: { build: { context: "https://example.com/repo.git" } } } })).toBe(true);
    expect(composeHasBuild({ services: { a: { build: "." } } })).toBe(true);
  });
  it("sem build (ou modelo estranho): não", () => {
    expect(composeHasBuild({ services: { a: { image: "x" }, b: { build: null } } })).toBe(false);
    expect(composeHasBuild({ services: {} })).toBe(false);
    expect(composeHasBuild({ services: { a: null } })).toBe(false);
    expect(composeHasBuild(null)).toBe(false);
    expect(composeHasBuild({})).toBe(false);
    expect(composeHasBuild({ services: "x" })).toBe(false);
  });
});

describe("buildkitEnv", () => {
  it("filtra os segredos do painel e liga o BuildKit", () => {
    const env = buildkitEnv({ PATH: "/usr/bin", SETUP_TOKEN: "x", DOCKER_HOST: "unix:///v.sock" });
    expect(env).toEqual({ PATH: "/usr/bin", DOCKER_HOST: "unix:///v.sock", DOCKER_BUILDKIT: "1", COMPOSE_DOCKER_CLI_BUILD: "1" });
  });
  it("repassa BUILDX_CONFIG (pasta gravável do estado do buildx) e continua sem os segredos", () => {
    const env = buildkitEnv({ PATH: "/usr/bin", BUILDX_CONFIG: "/data/.docker/buildx", SESSION_SECRET: "y" });
    expect(env.BUILDX_CONFIG).toBe("/data/.docker/buildx");
    expect(env).not.toHaveProperty("SESSION_SECRET");
  });
  it("usa o ambiente do processo por padrão", () => {
    expect(buildkitEnv().DOCKER_BUILDKIT).toBe("1");
  });
});

describe("buildxHintFromOutput", () => {
  it.each([
    "buildx Docker CLI plugin not found: falling back to the classic builder",
    "the --chmod option requires BuildKit",
    "ERROR: docker-buildx not found",
    "buildx plugin is not installed",
  ])("reconhece: %s", (linha) => {
    expect(buildxHintFromOutput(`passo 1\n${linha}\nfim`)).toBe(BUILDX_MISSING_MESSAGE);
  });
  it("buildx que não grava o estado ganha a dica de BUILDX_CONFIG", () => {
    expect(buildxHintFromOutput("ERROR: buildx: mkdir /app/.docker/buildx: read-only file system")).toBe(BUILDX_UNUSABLE_MESSAGE);
  });
  it("outras falhas não ganham a dica", () => {
    expect(buildxHintFromOutput("npm ERR! code E404")).toBeNull();
    expect(buildxHintFromOutput("")).toBeNull();
  });
});

describe("pastas de configuração do Docker (DOCKER_CONFIG / BUILDX_CONFIG)", () => {
  const tmp = () => mkdtempSync(path.join(tmpdir(), "paas-dockercfg-"));

  it("cria as pastas que faltam e prova a escrita sem deixar sobra", () => {
    const base = tmp();
    try {
      const env = { DOCKER_CONFIG: path.join(base, ".docker"), BUILDX_CONFIG: path.join(base, ".docker", "buildx") };
      expect(probeConfigDirs(env)).toBeNull();
      expect(existsSync(env.BUILDX_CONFIG)).toBe(true);
      expect(readdirSync(env.DOCKER_CONFIG)).toEqual(["buildx"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("variáveis ausentes são ignoradas (fora do container vale o padrão do Docker)", () => {
    expect(probeConfigDirs({})).toBeNull();
  });

  it("pasta que não dá para criar/gravar acusa qual variável e o motivo", () => {
    const base = tmp();
    try {
      const arquivo = path.join(base, "arquivo");
      writeFileSync(arquivo, "x");
      const r = probeConfigDirs({ DOCKER_CONFIG: path.join(arquivo, ".docker") });
      expect(r).toMatch(/^DOCKER_CONFIG=.*não é gravável \(ENOTDIR\)$/);
      expect(probeConfigDirs({ DOCKER_CONFIG: base, BUILDX_CONFIG: path.join(arquivo, "b") })).toMatch(/^BUILDX_CONFIG=/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("checagem prévia falha (unusable) se a pasta não é gravável, sem chamar o docker", async () => {
    let chamou = false;
    const r = await checkBuildx(
      async () => {
        chamou = true;
        return { code: 0, stdout: "", stderr: "" };
      },
      () => "DOCKER_CONFIG=/app/.docker não é gravável (EROFS: read-only file system)",
    );
    expect(r).toEqual({ ok: false, detail: "DOCKER_CONFIG=/app/.docker não é gravável (EROFS: read-only file system)", reason: "unusable" });
    expect(chamou).toBe(false);
  });

  it("os comandos docker recebem DOCKER_CONFIG e BUILDX_CONFIG do painel", () => {
    const env = buildkitEnv({ PATH: "/usr/bin", DOCKER_CONFIG: "/data/.docker", BUILDX_CONFIG: "/data/.docker/buildx", SETUP_TOKEN: "x" });
    expect(env.DOCKER_CONFIG).toBe("/data/.docker");
    expect(env.BUILDX_CONFIG).toBe("/data/.docker/buildx");
    expect(env).not.toHaveProperty("SETUP_TOKEN");
  });

  it("diagnóstico reconhece 'mkdir /app/.docker: read-only file system' (frontend do Dockerfile)", () => {
    const saida = "[migrate] resolve image config for docker-image://docker.io/docker/dockerfile:1\nERROR: mkdir /app/.docker: read-only file system";
    expect(buildxHintFromOutput(saida)).toBe(BUILDX_UNUSABLE_MESSAGE);
    expect(BUILDX_UNUSABLE_MESSAGE).toContain("DOCKER_CONFIG");
  });
});
