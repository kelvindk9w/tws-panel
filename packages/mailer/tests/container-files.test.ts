/**
 * container-files.ts — entrega de arquivos a um container pelo daemon.
 *
 * Defeito de origem: o Caddyfile (e o config.toml do Stalwart) eram entregues
 * por bind mount de um caminho do painel. Com o painel em container, o daemon
 * do host não conhece esse caminho e montava um diretório vazio no lugar. A
 * correção grava os arquivos com `docker cp -` a partir de um tar em memória.
 * (Cópia do teste de packages/deploy: o arquivo-fonte é duplicado.)
 * Nada aqui usa Docker de verdade: o tar é conferido com o `tar` do sistema e
 * o `docker` é um script falso colocado à frente no PATH.
 */
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  copyFilesToContainer,
  hasLegacyConfigBind,
  parseContainerInspect,
  runWithInput,
  tarArchive,
} from "../src/container-files.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-container-files-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("tarArchive", () => {
  it("gera um tar que o tar do sistema extrai com conteúdo e permissões", async () => {
    const tarFile = path.join(dir, "a.tar");
    await writeFile(
      tarFile,
      tarArchive([
        { name: "etc/" },
        { name: "etc/config.toml", content: 'secret = "x"\n', mode: 0o600 },
        { name: "Caddyfile", content: Buffer.from("a".repeat(700)) },
        { name: "vazio" },
        { name: "sub/", mode: 0o700 },
      ]),
    );
    const out = path.join(dir, "out");
    execFileSync("mkdir", [out]);
    execFileSync("tar", ["-xf", tarFile, "-C", out]);

    expect(await readFile(path.join(out, "etc/config.toml"), "utf8")).toBe('secret = "x"\n');
    expect(await readFile(path.join(out, "Caddyfile"), "utf8")).toBe("a".repeat(700));
    expect(await readFile(path.join(out, "vazio"), "utf8")).toBe("");
    const modo = (p: string) => execFileSync("stat", ["-c", "%a", path.join(out, p)], { encoding: "utf8" }).trim();
    expect(modo("etc/config.toml")).toBe("600");
    expect(modo("Caddyfile")).toBe("644");
    expect(modo("etc")).toBe("755");
    expect(modo("sub")).toBe("700");
  });

  it("tamanho é múltiplo de 512 e termina com dois blocos zerados", () => {
    const buf = tarArchive([{ name: "f", content: "abc" }], 0);
    expect(buf.length % 512).toBe(0);
    expect(buf.subarray(buf.length - 1024).every((b) => b === 0)).toBe(true);
  });

  it.each(["", "/etc/passwd", "../fora", "a/../b", "a//b", "./a", "com espaço", "x".repeat(100)])(
    "recusa nome inseguro %j",
    (name) => {
      expect(() => tarArchive([{ name, content: "x" }])).toThrow(/nome de arquivo inválido/);
    },
  );
});

describe("runWithInput", () => {
  it("entrega a entrada padrão e captura stdout/stderr e código", async () => {
    const r = await runWithInput("sh", ["-c", "cat; echo erro >&2; exit 3"], Buffer.from("olá"));
    expect(r).toEqual({ code: 3, stdout: "olá", stderr: "erro\n" });
  });

  it("binário ausente vira code 1 com a causa, sem rejeitar", async () => {
    const r = await runWithInput("binario-que-nao-existe-paas", [], Buffer.from("x"));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Falha ao executar "binario-que-nao-existe-paas"/);
  });

  it("processo que sai sem ler a entrada não derruba o painel (EPIPE)", async () => {
    const r = await runWithInput("sh", ["-c", "exit 0"], Buffer.alloc(8 * 1024 * 1024, 97));
    expect(r.code).toBe(0);
  });

  it("processo morto por sinal vira code 1", async () => {
    const r = await runWithInput("sh", ["-c", "kill -9 $$"], Buffer.from(""));
    expect(r.code).toBe(1);
  });

  it("mata o processo ao exceder o tempo limite", async () => {
    const inicio = Date.now();
    const r = await runWithInput("sleep", ["5"], Buffer.from(""), { timeoutMs: 100 });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/tempo limite/);
    expect(Date.now() - inicio).toBeLessThan(3_000);
  });
});

describe("copyFilesToContainer", () => {
  it("chama `docker cp - <container>:<destino>` com o tar pela entrada padrão", async () => {
    const bin = path.join(dir, "bin");
    execFileSync("mkdir", [bin]);
    const fake = path.join(bin, "docker");
    await writeFile(fake, `#!/bin/sh\necho "$@" > "${dir}/args"\ncat > "${dir}/stdin.tar"\n`);
    await chmod(fake, 0o755);
    const pathAntigo = process.env.PATH;
    process.env.PATH = `${bin}:${pathAntigo}`;
    try {
      const r = await copyFilesToContainer("paas-caddy", "/etc/caddy", [{ name: "Caddyfile", content: "novo" }]);
      expect(r.code).toBe(0);
    } finally {
      process.env.PATH = pathAntigo;
    }
    expect((await readFile(path.join(dir, "args"), "utf8")).trim()).toBe("cp - paas-caddy:/etc/caddy");
    const listed = execFileSync("tar", ["-xOf", path.join(dir, "stdin.tar"), "Caddyfile"], { encoding: "utf8" });
    expect(listed).toBe("novo");
  });
});

describe("parseContainerInspect", () => {
  it("lê estado e montagens", () => {
    const out = parseContainerInspect(
      'true|[{"Type":"bind","Source":"/data/caddy/Caddyfile","Destination":"/etc/caddy/Caddyfile"},{"Type":"volume","Destination":"/data"}]\n',
    );
    expect(out).toEqual({
      running: true,
      mounts: [
        { type: "bind", destination: "/etc/caddy/Caddyfile" },
        { type: "volume", destination: "/data" },
      ],
    });
  });

  it("tolera saída sem separador, JSON inválido, null e itens incompletos", () => {
    expect(parseContainerInspect("false")).toEqual({ running: false, mounts: [] });
    expect(parseContainerInspect("true|não é json")).toEqual({ running: true, mounts: [] });
    expect(parseContainerInspect("false|null")).toEqual({ running: false, mounts: [] });
    expect(parseContainerInspect("false|[null,{}]").mounts).toEqual([
      { type: "", destination: "" },
      { type: "", destination: "" },
    ]);
  });
});

describe("hasLegacyConfigBind", () => {
  it("detecta bind mount sobre o arquivo, o diretório ou um ancestral", () => {
    expect(hasLegacyConfigBind([{ type: "bind", destination: "/etc/caddy/Caddyfile" }], "/etc/caddy")).toBe(true);
    expect(hasLegacyConfigBind([{ type: "bind", destination: "/etc/caddy" }], "/etc/caddy/")).toBe(true);
    expect(hasLegacyConfigBind([{ type: "bind", destination: "/etc" }], "/etc/caddy")).toBe(true);
  });

  it("ignora volumes e binds em outros caminhos", () => {
    expect(hasLegacyConfigBind([{ type: "volume", destination: "/etc/caddy" }], "/etc/caddy")).toBe(false);
    expect(hasLegacyConfigBind([{ type: "bind", destination: "/etc/caddyx" }], "/etc/caddy")).toBe(false);
    expect(hasLegacyConfigBind([], "/etc/caddy")).toBe(false);
  });
});
