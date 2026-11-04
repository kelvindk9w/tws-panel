/**
 * restore-reconciliation-docker.test.ts — a consulta que a reconciliação usa
 * para saber se um container roda de verdade (DockerCli.probe).
 *
 * Duas partes:
 *  1. docker de mentira no PATH: distingue "não existe" de "o Docker não
 *     respondeu" (o segundo precisa LANÇAR, senão um Docker fora do ar viraria
 *     "o webmail não existe" e a pendência sumiria ou a flag seria apagada);
 *  2. Docker REAL, quando a máquina tem Docker e uma imagem local: um
 *     container qualquer rotulado como o do painel, parado, rodando e removido.
 *     Sem Docker ou sem imagem, esta parte é pulada (não falha em CI sem Docker).
 */
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DockerCli } from "../src/services/backup-docker.js";
import { removeDir } from "./helpers/tmp.js";

let dir: string;
let pathAntes: string | undefined;

async function dockerDeMentira(corpo: string): Promise<DockerCli> {
  const bin = path.join(dir, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "docker"), `#!/bin/sh\n${corpo}\n`);
  await chmod(path.join(bin, "docker"), 0o755);
  process.env.PATH = `${bin}:${pathAntes}`;
  return new DockerCli({ socketPath: "/var/run/docker.sock", helperImage: "alpine", timeoutMs: 20_000 });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-probe-"));
  pathAntes = process.env.PATH;
});
afterEach(async () => {
  process.env.PATH = pathAntes;
  await removeDir(dir);
});

describe("DockerCli.probe com docker de mentira", () => {
  it("rodando, parado, inexistente", async () => {
    expect(await (await dockerDeMentira("echo true")).probe("paas-webmail")).toBe("running");
    expect(await (await dockerDeMentira("echo false")).probe("paas-webmail")).toBe("stopped");
    expect(await (await dockerDeMentira('echo "Error: No such object: paas-webmail" >&2; exit 1')).probe("paas-webmail")).toBe("missing");
    expect(await (await dockerDeMentira('echo "Error response from daemon: No such container: paas-webmail" >&2; exit 1')).probe("paas-webmail")).toBe("missing");
  });

  it("Docker fora do ar, sem permissão ou sem o comando: LANÇA (não é 'não existe')", async () => {
    await expect((await dockerDeMentira('echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" >&2; exit 1')).probe("paas-webmail")).rejects.toThrow(
      /Cannot connect/,
    );
    await expect((await dockerDeMentira('echo "permission denied while trying to connect to the Docker daemon socket" >&2; exit 1')).probe("x")).rejects.toThrow(/permission denied/);
    process.env.PATH = path.join(dir, "vazio");
    await expect(new DockerCli({ socketPath: "/var/run/docker.sock", helperImage: "alpine" }).probe("x")).rejects.toThrow(/não foi possível rodar o docker/);
  });
});

// --- Docker real ----------------------------------------------------------

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }).trim();
}

/** Uma imagem local em que `sleep` funciona (sem baixar nada da internet). */
function localImage(): string | null {
  try {
    const images = docker("images", "--format", "{{.Repository}}:{{.Tag}}").split("\n").filter((i) => i && !i.includes("<none>"));
    for (const image of images) {
      try {
        docker("run", "--rm", "--entrypoint", "sleep", image, "0");
        return image;
      } catch {
        /* esta imagem não tem sleep */
      }
    }
  } catch {
    /* sem Docker */
  }
  return null;
}

const image = localImage();

describe.skipIf(image === null)("DockerCli.probe com Docker real", () => {
  const name = `paas-probe-teste-${process.pid}`;
  afterEach(() => {
    try {
      docker("rm", "-f", name);
    } catch {
      /* já não existe */
    }
  });

  it("container rotulado: inexistente → parado → rodando → removido", async () => {
    const cli = new DockerCli({ socketPath: "/var/run/docker.sock", helperImage: image! });
    expect(await cli.probe(name)).toBe("missing");
    docker("create", "--name", name, "--label", "paas.managed=true", "--entrypoint", "sleep", image!, "60");
    expect(await cli.probe(name)).toBe("stopped");
    docker("start", name);
    expect(await cli.probe(name)).toBe("running");
    docker("rm", "-f", name);
    expect(await cli.probe(name)).toBe("missing");
  });
});
