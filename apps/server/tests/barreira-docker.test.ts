/**
 * barreira-docker.test.ts — sem PAAS_TEST_REAL_DOCKER=1, a suíte não alcança o Docker da máquina.
 *
 * A barreira (scripts/testes/barreira-docker.ts) entra antes de qualquer teste, em todos os pacotes. Aqui se prova
 * que ela está de pé: o `docker` do PATH é o falso (registra e falha com a mensagem clara), o DOCKER_HOST aponta para
 * um socket inexistente, a conexão com o socket do daemon falha pelo evento de erro — e que um socket de dublê na
 * pasta temporária segue funcionando.
 *
 * As chamadas feitas de propósito aqui vão para um registro só deste arquivo: o registro geral da suíte
 * (PAAS_TEST_DOCKER_LOG) fica vazio quando nenhum outro teste tenta usar o Docker.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DOCKER_HOST_FALSO,
  MENSAGEM_BARREIRA,
  dockerRealPermitido,
  socketDoDockerReal,
} from "../../../scripts/testes/barreira-docker.js";

// O setup do servidor troca o child_process por um com dublê do docker (tests/helpers/docker-duble.ts); aqui interessa
// a barreira por baixo dele, então o teste usa o módulo de verdade.
const { spawnSync } = await vi.importActual<typeof import("node:child_process")>("node:child_process");

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = mkdtempSync(path.join(tmpdir(), "barreira-docker-"));
const meuLog = path.join(dir, "chamadas.log");
let logGeral: string | undefined;

beforeEach(() => {
  logGeral = process.env.PAAS_TEST_DOCKER_LOG;
  process.env.PAAS_TEST_DOCKER_LOG = meuLog;
  rmSync(meuLog, { force: true });
});
afterEach(() => {
  process.env.PAAS_TEST_DOCKER_LOG = logGeral;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function registro(): string {
  try {
    // cada linha traz "\t# <arquivo> > <teste>" no fim; aqui só interessa a chamada
    return readFileSync(meuLog, "utf8").replace(/\t# [^\n]*/g, "");
  } catch {
    return "";
  }
}

function conectar(opcoes: { socketPath: string }): Promise<Error | "conectou"> {
  return new Promise((resolve) => {
    const req = http.request({ ...opcoes, method: "GET", path: "/_ping" }, (res) => {
      res.resume();
      resolve("conectou");
    });
    req.on("error", resolve);
    req.end();
  });
}

describe.skipIf(dockerRealPermitido())("barreira do Docker real (sem PAAS_TEST_REAL_DOCKER=1)", () => {
  it("o docker do PATH é o falso: registra a chamada e falha com a mensagem clara", () => {
    const r = spawnSync("docker", ["rm", "-f", "paas-loja-next"], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`${MENSAGEM_BARREIRA}: docker rm -f paas-loja-next`);
    expect(r.stderr).toContain("PAAS_TEST_REAL_DOCKER=1");
    expect(registro()).toBe("docker rm -f paas-loja-next\n");
  });

  it("vale também pelo shell e para o docker-compose antigo", () => {
    const r = spawnSync("sh", ["-c", "docker network create paas-net; docker-compose up -d"], { encoding: "utf8" });
    expect(r.stderr).toContain(`${MENSAGEM_BARREIRA}: docker network create paas-net`);
    expect(r.stderr).toContain(`${MENSAGEM_BARREIRA}: docker-compose up -d`);
    expect(registro()).toBe("docker network create paas-net\ndocker-compose up -d\n");
  });

  it("o registro diz qual teste fez a chamada", () => {
    spawnSync("docker", ["ps"], { encoding: "utf8" });
    expect(readFileSync(meuLog, "utf8")).toBe("docker ps\t# barreira-docker.test.ts > o registro diz qual teste fez a chamada\n");
  });

  it("DOCKER_HOST aponta para um socket que não existe", () => {
    expect(process.env.DOCKER_HOST).toBe(DOCKER_HOST_FALSO);
    expect(process.env.DOCKER_CONTEXT).toBeUndefined();
  });

  it.each(["/var/run/docker.sock", "/run/docker.sock"])("conexão com %s falha pelo evento de erro, com a mensagem clara", async (socketPath) => {
    const r = await conectar({ socketPath });
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toContain(`${MENSAGEM_BARREIRA}: socket ${socketPath}`);
    expect((r as NodeJS.ErrnoException).code).toBe("ECONNREFUSED");
    expect(registro()).toBe(`socket ${socketPath}\n`);
  });

  it("net.connect direto também é barrado", async () => {
    const erro = await new Promise<Error>((resolve) => {
      net.connect({ path: "/var/run/docker.sock" }).on("error", resolve);
    });
    expect(erro.message).toContain(MENSAGEM_BARREIRA);
  });

  it("socket de dublê na pasta temporária (tmp/docker.sock) segue funcionando", async () => {
    const socketPath = path.join(dir, "docker.sock");
    const server = http.createServer((_req, res) => res.end("OK"));
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      expect(await conectar({ socketPath })).toBe("conectou");
      expect(registro()).toBe("");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("regra do socket bloqueado", () => {
  const conhecidos = ["/var/run/docker.sock", "/run/docker.sock", "/run/user/1000/docker.sock"];
  it.each([
    ["/var/run/docker.sock", true],
    ["/var/run/docker.sock/", true],
    ["/run/user/1000/docker.sock", true],
    ["/home/alguem/.docker/desktop/docker.sock", true],
    ["/srv/docker-engine.sock", true],
    ["/tmp/x/docker.sock", false],
    ["/tmpx/docker.sock", true],
    ["/tmp/x/mail.sock", false],
    ["/var/run/outro.sock", false],
  ])("%s (existente) → bloqueado: %s", (alvo, esperado) => {
    expect(socketDoDockerReal(alvo, conhecidos, "/tmp", () => true)).toBe(esperado);
  });

  it("docker*.sock que não existe não é bloqueado (falha sozinho); o conhecido é bloqueado mesmo sem existir", () => {
    expect(socketDoDockerReal("/nonexistent/docker.sock", conhecidos, "/tmp", () => false)).toBe(false);
    expect(socketDoDockerReal("/run/docker.sock", conhecidos, "/tmp", () => false)).toBe(true);
  });

  it("o socket conhecido é bloqueado mesmo dentro da pasta temporária (DOCKER_HOST apontando para lá)", () => {
    expect(socketDoDockerReal("/tmp/rootless/docker.sock", ["/tmp/rootless/docker.sock"], "/tmp", () => true)).toBe(true);
    // o do DOCKER_HOST que não existe não alcança daemon nenhum: falha sozinho
    expect(socketDoDockerReal("/nonexistent.sock", ["/nonexistent.sock"], "/tmp", () => false)).toBe(false);
  });
});

describe("a barreira está ligada em todos os pacotes com vitest", () => {
  const configs = ["apps", "packages"].flatMap((grupo) =>
    readdirSync(path.join(raiz, grupo)).map((pacote) => path.join(grupo, pacote, "vitest.config.ts")),
  ).filter((arquivo) => {
    try {
      readFileSync(path.join(raiz, arquivo));
      return true;
    } catch {
      return false;
    }
  });

  it("acha os seis pacotes", () => {
    expect(configs.sort()).toEqual([
      "apps/server/vitest.config.ts",
      "apps/web/vitest.config.ts",
      "packages/core/vitest.config.ts",
      "packages/deploy/vitest.config.ts",
      "packages/mailer/vitest.config.ts",
      "packages/security/vitest.config.ts",
    ]);
  });

  it.each(["apps/server", "apps/web", "packages/core", "packages/deploy", "packages/mailer", "packages/security"])(
    "%s: a barreira é o primeiro setupFile",
    (pacote) => {
      const texto = readFileSync(path.join(raiz, pacote, "vitest.config.ts"), "utf8");
      expect(texto).toMatch(/setupFiles: \["\.\.\/\.\.\/scripts\/testes\/barreira-docker\.ts"/);
    },
  );
});
