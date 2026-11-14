/**
 * restore-reconciliation.docker-real.test.ts — DockerCli.probe contra o Docker REAL (integração).
 *
 * Só roda com PAAS_TEST_REAL_DOCKER=1 (docs/processo/testes-e-docker.md) e uma imagem local em que `sleep` funcione
 * (nunca baixa nada): um container qualquer rotulado como o do painel, inexistente, parado, rodando e removido.
 * A parte com docker de mentira (fora do ar, sem permissão, sem o comando) está em restore-reconciliation-docker.test.ts.
 */
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { DockerCli } from "../src/services/backup-docker.js";
import { usarDockerReal } from "./helpers/docker-duble.js";

usarDockerReal();

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

// Só com o pedido explícito: localImage() já roda containers (um `docker run --rm` por imagem até achar uma com sleep).
const image = process.env.PAAS_TEST_REAL_DOCKER === "1" ? localImage() : null;

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
