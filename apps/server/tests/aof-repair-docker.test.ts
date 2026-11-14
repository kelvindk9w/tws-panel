/**
 * aof-repair-docker.test.ts — os comandos do Docker do reparo do AOF (dublê de `run`): o container auxiliar
 * sem rede, sem privilégios novos, só com as capacidades de arquivo, com limites, sem rótulos de projeto, só
 * com o volume da pasta de dados, removido ao terminar e à força no prazo; o inspect lido com segurança.
 */
import { describe, expect, it, vi } from "vitest";
import { containerIdentity } from "@paas/core";
import { AOF_HELPER_LABEL, AOF_HELPER_LIMITS, AOF_HELPER_PREFIX, AofDockerCli, helperRunArgs, parseAofInspect, type AofHelperSpec } from "../src/services/aof-repair-docker.js";

const SPEC: AofHelperSpec = {
  image: "sha256:" + "b".repeat(64),
  mount: { type: "volume", source: "paas-loja_redis-data", destination: "/data" },
  workdir: "/data",
  script: 'echo "$1"',
  args: ["redis-check-aof", "appendonlydir", "appendonly.aof.manifest"],
  timeoutMs: 60_000,
};

const pair = (args: string[], flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

describe("helperRunArgs — o container auxiliar", () => {
  const args = helperRunArgs(SPEC, "tws-aof-0011223344556677", { "paas.project": "outro", "com.docker.compose.project": "paas-outro", "org.opencontainers.image.title": "redis" });

  it("sem rede, removido ao terminar, sem reinício, nunca baixa imagem", () => {
    expect(args.slice(0, 4)).toEqual(["run", "--rm", "--name", "tws-aof-0011223344556677"]);
    expect(pair(args, "--network")).toEqual(["none"]);
    expect(pair(args, "--pull")).toEqual(["never"]);
    expect(pair(args, "--restart")).toEqual(["no"]);
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("--volumes-from");
  });

  it("sem privilégios novos e só as capacidades de arquivo; sistema de arquivos próprio só leitura", () => {
    expect(pair(args, "--security-opt")).toEqual(["no-new-privileges"]);
    expect(pair(args, "--cap-drop")).toEqual(["ALL"]);
    expect(pair(args, "--cap-add").sort()).toEqual(["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID"]);
    expect(args).toContain("--read-only");
  });

  it("limites de memória (sem swap extra), CPU e processos; log com teto", () => {
    expect(pair(args, "--memory")).toEqual([`${AOF_HELPER_LIMITS.memoryMb}m`]);
    expect(pair(args, "--memory-swap")).toEqual([`${AOF_HELPER_LIMITS.memoryMb}m`]);
    expect(pair(args, "--cpus")).toEqual(["1"]);
    expect(pair(args, "--pids-limit")).toEqual(["64"]);
    expect(pair(args, "--log-opt").length).toBeGreaterThan(0);
  });

  it("rótulos do painel e do compose vazios (os da imagem também) e o rótulo do auxiliar: não passa por container de projeto", () => {
    const labels = pair(args, "--label") as string[];
    expect(labels).toContain("paas.project=");
    expect(labels).toContain("paas.managed=");
    expect(labels).toContain("com.docker.compose.project=");
    expect(labels).toContain("tws.restore-check=");
    expect(labels).toContain(`${AOF_HELPER_LABEL}=1`);
    expect(labels).not.toContain("org.opencontainers.image.title=");
    const map = Object.fromEntries(labels.map((l) => l.split("=") as [string, string]));
    expect(containerIdentity(map, "tws-aof-0011223344556677")).toEqual({ managed: false, projectSlug: null, composeProject: null });
  });

  it("só o volume da pasta de dados, no mesmo caminho; pasta de trabalho e programa fixos; argumentos posicionais", () => {
    expect(pair(args, "--mount")).toEqual(["type=volume,src=paas-loja_redis-data,dst=/data"]);
    expect(pair(args, "--workdir")).toEqual(["/data"]);
    expect(pair(args, "--entrypoint")).toEqual(["sh"]);
    const img = args.indexOf(SPEC.image);
    expect(args.slice(img)).toEqual([SPEC.image, "-c", SPEC.script, "sh", ...SPEC.args]);
  });

  it("bind: monta o caminho do host", () => {
    const b = helperRunArgs({ ...SPEC, mount: { type: "bind", source: "/srv/redis", destination: "/data" } }, "n", null);
    expect(pair(b, "--mount")).toEqual(["type=bind,src=/srv/redis,dst=/data"]);
  });
});

describe("parseAofInspect", () => {
  const doc = {
    Id: "a".repeat(64),
    Name: "/paas-loja-redis-1",
    Image: "sha256:" + "b".repeat(64),
    Path: "docker-entrypoint.sh",
    Args: ["redis-server", "--appendonly", "yes", 3],
    State: { Status: "restarting" },
    Config: { Labels: { "com.docker.compose.project": "paas-loja" }, WorkingDir: "/data" },
    Mounts: [{ Type: "volume", Name: "paas-loja_redis-data", Source: "/var/lib/docker/volumes/x/_data", Destination: "/data", RW: true }, null, { Type: "bind", Source: "/srv", Destination: "/srv", RW: false }],
  };

  it("lê o que o reparo usa", () => {
    expect(parseAofInspect(JSON.stringify([doc]))).toEqual({
      id: "a".repeat(64),
      name: "paas-loja-redis-1",
      image: "sha256:" + "b".repeat(64),
      state: "restarting",
      labels: { "com.docker.compose.project": "paas-loja" },
      workingDir: "/data",
      argv: ["docker-entrypoint.sh", "redis-server", "--appendonly", "yes"],
      mounts: [
        { type: "volume", name: "paas-loja_redis-data", source: "/var/lib/docker/volumes/x/_data", destination: "/data", rw: true },
        { type: "bind", name: null, source: "/srv", destination: "/srv", rw: false },
      ],
    });
  });

  it("campos ausentes viram vazios; JSON quebrado, id ou imagem inválidos: null", () => {
    expect(parseAofInspect(JSON.stringify([{ Id: "a".repeat(64), Image: "sha256:x" }]))).toMatchObject({ labels: {}, mounts: [], argv: [], workingDir: null, state: "unknown", name: "" });
    expect(parseAofInspect("{")).toBeNull();
    expect(parseAofInspect("[]")).toBeNull();
    expect(parseAofInspect(JSON.stringify([{ ...doc, Id: "../x" }]))).toBeNull();
    expect(parseAofInspect(JSON.stringify([{ ...doc, Image: "" }]))).toBeNull();
  });
});

describe("AofDockerCli", () => {
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });

  it("inspect: id do container validado; pelo socket do painel", async () => {
    const run = vi.fn(async () => ok(JSON.stringify([{ Id: "a".repeat(64), Image: "sha256:x" }])));
    const cli = new AofDockerCli("/var/run/docker.sock", run);
    expect(await cli.inspect("../../etc")).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect((await cli.inspect("a".repeat(12)))?.id).toBe("a".repeat(64));
    expect(run).toHaveBeenCalledWith("docker", ["inspect", "--type", "container", "a".repeat(12)], expect.objectContaining({ env: expect.objectContaining({ DOCKER_HOST: "unix:///var/run/docker.sock" }) }));
    run.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "No such container" });
    expect(await cli.inspect("a".repeat(12))).toBeNull();
  });

  it("helper: lê os rótulos da imagem, roda com prazo, junta saída e erro, não lança por código de saída", async () => {
    const run = vi.fn(async (_f: string, args: string[]) => (args[0] === "image" ? ok('{"paas.project":"x"}') : { code: 1, stdout: "AOF analyzed: diff=3", stderr: "not valid" }));
    const cli = new AofDockerCli("tcp://203.0.113.10:2375", run);
    const r = await cli.helper(SPEC);
    expect(r).toEqual({ code: 1, output: "AOF analyzed: diff=3\nnot valid", timedOut: false });
    const runArgs = run.mock.calls[1]![1];
    expect(runArgs[3]).toMatch(new RegExp(`^${AOF_HELPER_PREFIX}[0-9a-f]{16}$`));
    expect(runArgs).toContain("paas.project=");
    expect((run.mock.calls[1] as unknown[])[2]).toMatchObject({ timeoutMs: 60_000, env: expect.objectContaining({ DOCKER_HOST: "tcp://203.0.113.10:2375" }) });
  });

  it("helper: rótulos ilegíveis ou imagem sem inspect seguem com os vazios de sempre", async () => {
    for (const img of [ok("não é json"), { code: 1, stdout: "", stderr: "No such image" }]) {
      const run = vi.fn(async (_f: string, args: string[]) => (args[0] === "image" ? img : ok("ok\n")));
      const r = await new AofDockerCli("/s", run).helper(SPEC);
      expect(r.output).toBe("ok\n");
      expect(run.mock.calls[1]![1]).toContain("paas.managed=");
    }
  });

  it("helper que passa do prazo: removido à força pelo nome", async () => {
    const run = vi.fn(async (_f: string, args: string[]) => (args[0] === "image" ? ok("null") : args[0] === "rm" ? ok() : { code: 1, stdout: "", stderr: 'Falha ao executar "docker": x — processo encerrado pelo sinal SIGTERM' }));
    const r = await new AofDockerCli("/s", run).helper(SPEC);
    expect(r.timedOut).toBe(true);
    const name = run.mock.calls[1]![1][3];
    expect(run.mock.calls[2]![1]).toEqual(["rm", "-f", name]);
  });

  it("stop/start: prazo do docker stop de 30 s; erro do Docker vira exceção com a mensagem", async () => {
    const run = vi.fn(async () => ok());
    const cli = new AofDockerCli("/s", run);
    await cli.stop("abc");
    await cli.start("abc");
    expect(run.mock.calls.map((c) => (c as unknown as [string, string[]])[1])).toEqual([["stop", "-t", "30", "abc"], ["start", "abc"]]);
    run.mockResolvedValue({ code: 1, stdout: "", stderr: "" });
    await expect(cli.stop("abc")).rejects.toThrow("docker stop saiu com código 1");
    run.mockResolvedValue({ code: 1, stdout: "", stderr: "Error: No such container" });
    await expect(cli.start("abc")).rejects.toThrow("No such container");
  });
});
