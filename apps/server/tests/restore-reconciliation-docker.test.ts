/**
 * restore-reconciliation-docker.test.ts — a consulta que a reconciliação usa
 * para saber se um container roda de verdade (DockerCli.probe).
 *
 * Com docker de mentira no PATH: distingue "não existe" de "o Docker não
 * respondeu" (o segundo precisa LANÇAR, senão um Docker fora do ar viraria
 * "o webmail não existe" e a pendência sumiria ou a flag seria apagada).
 * A mesma consulta contra o Docker de verdade está em
 * restore-reconciliation.docker-real.test.ts (só com PAAS_TEST_REAL_DOCKER=1).
 */
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
