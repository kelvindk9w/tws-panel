import { describe, expect, it } from "vitest";
import { BUILDX_MISSING_MESSAGE, buildkitEnv, buildxHintFromOutput, checkBuildx } from "../src/buildx.js";

describe("checkBuildx", () => {
  it("devolve a versão quando o plugin responde", async () => {
    let visto: { args: string[]; env?: NodeJS.ProcessEnv } | null = null;
    const r = await checkBuildx(async (_f, args, opts) => {
      visto = { args, env: opts?.env };
      return { code: 0, stdout: "docker/buildx v0.38.1 abc\n", stderr: "" };
    });
    expect(r).toEqual({ ok: true, version: "docker/buildx v0.38.1 abc" });
    expect(visto!.args).toEqual(["buildx", "version"]);
    expect(visto!.env?.DOCKER_BUILDKIT).toBe("1");
  });

  it("sem o plugin, devolve o motivo (primeira linha)", async () => {
    const r = await checkBuildx(async () => ({ code: 1, stdout: "", stderr: "docker: unknown command: docker buildx\nmais\n" }));
    expect(r).toEqual({ ok: false, detail: "docker: unknown command: docker buildx" });
  });

  it("falha sem nenhuma saída vira detalhe vazio; sucesso sem saída, versão vazia", async () => {
    expect(await checkBuildx(async () => ({ code: 1, stdout: "", stderr: "" }))).toEqual({ ok: false, detail: "" });
    expect(await checkBuildx(async () => ({ code: 0, stdout: "", stderr: "" }))).toEqual({ ok: true, version: "" });
  });
});

describe("buildkitEnv", () => {
  it("filtra os segredos do painel e liga o BuildKit", () => {
    const env = buildkitEnv({ PATH: "/usr/bin", SETUP_TOKEN: "x", DOCKER_HOST: "unix:///v.sock" });
    expect(env).toEqual({ PATH: "/usr/bin", DOCKER_HOST: "unix:///v.sock", DOCKER_BUILDKIT: "1", COMPOSE_DOCKER_CLI_BUILD: "1" });
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
  it("outras falhas não ganham a dica", () => {
    expect(buildxHintFromOutput("npm ERR! code E404")).toBeNull();
    expect(buildxHintFromOutput("")).toBeNull();
  });
});
