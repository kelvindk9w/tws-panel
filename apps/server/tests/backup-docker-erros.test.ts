/**
 * Lote 6 / M4 — disco cheio (ENOSPC) durante o dump de banco não derruba o painel.
 *
 * Antes: o stream de gravação do dump (e o de leitura do arquivo da restauração)
 * não tinham ouvinte de `error`; o primeiro ENOSPC/EIO/ENOENT virava exceção
 * não tratada e o processo do painel caía no meio do backup. Agora o comando
 * REJEITA com uma mensagem clara e o filho do docker é encerrado.
 *
 * O docker é um script de mentira no PATH; o disco cheio é o /dev/full real do
 * Linux (toda gravação falha com ENOSPC).
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DockerCli } from "../src/services/backup-docker.js";

let dir: string;
let pathAntes: string | undefined;

async function dockerDeMentira(corpo: string): Promise<DockerCli> {
  const bin = path.join(dir, "bin");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "docker"), `#!/bin/sh\n${corpo}\n`);
  await chmod(path.join(bin, "docker"), 0o755);
  process.env.PATH = `${bin}:${pathAntes}`;
  return new DockerCli({ socketPath: "/var/run/docker.sock", helperImage: "alpine", timeoutMs: 20_000 });
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-backup-docker-"));
  pathAntes = process.env.PATH;
});
afterEach(async () => {
  process.env.PATH = pathAntes;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("M4 — erro nos arquivos do dump e da restauração", () => {
  it("disco cheio ao gravar o dump: a promessa rejeita (sem derrubar o processo) e o docker é encerrado", async () => {
    // despeja 8 MB e depois fica vivo: se ninguém o encerrar, o teste estoura o prazo
    const cli = await dockerDeMentira("head -c 8388608 /dev/zero; sleep 30");
    await expect(cli.execToFile("c1", "pg_dump", [], "/dev/full")).rejects.toThrow(/sem espaço ao gravar o backup/);
  });

  it("copyOut com destino impossível de gravar também rejeita", async () => {
    const cli = await dockerDeMentira("head -c 1048576 /dev/zero");
    await expect(cli.copyOut("c1", "/dados", path.join(dir, "nao-existe", "saida.tar"))).rejects.toThrow(/gravar|ENOENT/i);
  });

  it("arquivo de entrada da restauração ilegível: rejeita em vez de derrubar o processo", async () => {
    const cli = await dockerDeMentira("cat > /dev/null");
    await expect(cli.execFromFile("c1", "psql", [], path.join(dir, "nao-existe.sql"))).rejects.toThrow(/ler|ENOENT/i);
  });

  it("restauração com prazo próprio (teste de restauração): passou do prazo, o comando é interrompido", async () => {
    const cli = await dockerDeMentira("cat > /dev/null; exec sleep 30");
    const entrada = path.join(dir, "entrada.sql");
    await writeFile(entrada, "select 1;");
    await expect(cli.execFromFile("c1", "psql", [], entrada, { timeoutMs: 200 })).rejects.toThrow(/passou do prazo/);
  });

  it("dump que termina bem continua funcionando", async () => {
    const cli = await dockerDeMentira("echo SELECT 1");
    const saida = path.join(dir, "dump.sql");
    await expect(cli.execToFile("c1", "pg_dump", [], saida)).resolves.toBeDefined();
  });
});
