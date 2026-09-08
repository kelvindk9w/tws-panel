/**
 * exec.ts / ingest.ts — falha quando o BINÁRIO não existe.
 *
 * Bug: o modo de ingestão "git" clonava o repositório de dentro do container
 * do painel, mas a imagem não tinha o `git` instalado. Quando execFile não
 * acha o binário, o erro traz `code: "ENOENT"` (string, não número): o
 * `run()` normalizava para `code: 1` e `stderr: ""`, indistinguível de um
 * comando que rodou e falhou calado. O operador via apenas
 * "git clone falhou:" — dois-pontos e nada depois.
 *
 * O que estes testes fixam: run() sempre devolve um stderr que identifica o
 * problema quando o processo sequer pôde ser iniciado, sem alterar o
 * comportamento de um comando que rodou e saiu com código != 0; e o fluxo de
 * clone nunca lança uma mensagem que termina em dois-pontos vazios.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@paas/core";
import { run } from "../src/exec.js";
import { ingestCode } from "../src/ingest.js";

/** Nome improvável de existir no PATH de qualquer ambiente de CI. */
const BINARIO_INEXISTENTE = "paas-binario-que-nao-existe-xyz";

describe("run() — processo que não pôde ser executado", () => {
  it("devolve código de falha E um stderr não-vazio identificando o problema", async () => {
    const r = await run(BINARIO_INEXISTENTE, ["--version"]);

    expect(r.code).not.toBe(0);
    expect(r.stderr.trim()).not.toBe("");
    // A mensagem tem de dizer QUAL binário faltou — é a única pista que o
    // operador recebe no log do deploy.
    expect(r.stderr).toContain(BINARIO_INEXISTENTE);
    expect(r.stderr).toMatch(/ENOENT|não encontrado/i);
  });
});

describe("run() — comando que existe e sai com código != 0 (não regride)", () => {
  it("preserva o exit code real e o stderr do processo", async () => {
    const r = await run("sh", ["-c", "echo saida-de-erro 1>&2; exit 3"]);

    expect(r.code).toBe(3);
    expect(r.stderr).toContain("saida-de-erro");
    // Nada de mensagem sintética por cima: o processo rodou, quem fala é ele.
    expect(r.stderr).not.toMatch(/ENOENT/);
  });

  it("um comando que falha calado continua com stderr vazio", async () => {
    const r = await run("sh", ["-c", "exit 2"]);

    expect(r.code).toBe(2);
    expect(r.stderr).toBe("");
  });

  it("um comando bem-sucedido continua com code 0", async () => {
    const r = await run("sh", ["-c", "echo ok"]);

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ok");
  });
});

describe("ingestão git — mensagem que chega ao operador", () => {
  let tmp: string;
  let projectsDir: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "paas-ingest-msg-"));
    projectsDir = path.join(tmp, "projects");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function projeto(overrides: Partial<Project> = {}): Project {
    return {
      id: "p1",
      name: "App",
      slug: "app",
      ingestMode: "git",
      source: path.join(tmp, "repositorio-que-nao-existe"),
      branch: "main",
      domain: "app.localhost",
      websocket: false,
      detection: null,
      proxyService: null,
      proxyPort: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastDeployAt: null,
      lastDeployStatus: null,
      ...overrides,
    } as Project;
  }

  it("o erro do clone nunca termina em dois-pontos sem texto", async () => {
    let erro: unknown;
    try {
      await ingestCode({ projectsDir }, projeto(), () => {});
    } catch (e) {
      erro = e;
    }

    expect(erro).toBeInstanceOf(Error);
    const msg = (erro as Error).message;
    expect(msg).toContain("git clone falhou");
    // O defeito original produzia exatamente "git clone falhou:" e nada mais.
    expect(msg.trim()).not.toMatch(/:$/);
    expect(msg.split("falhou:")[1]?.trim()).not.toBe("");
  }, 30_000);

  it("com o git ausente do PATH (o defeito real da imagem), a mensagem diz que o binário faltou", async () => {
    // Reproduz o container do painel sem git: o PATH vazio faz o execFile
    // falhar com ENOENT antes de o processo existir.
    const pathOriginal = process.env.PATH;
    process.env.PATH = path.join(tmp, "path-vazio");
    let erro: unknown;
    try {
      await ingestCode({ projectsDir }, projeto(), () => {});
    } catch (e) {
      erro = e;
    } finally {
      process.env.PATH = pathOriginal;
    }

    expect(erro).toBeInstanceOf(Error);
    const msg = (erro as Error).message;
    expect(msg.trim()).not.toMatch(/:$/);
    expect(msg).toMatch(/git/);
    expect(msg).toMatch(/ENOENT|não encontrado/i);
  }, 30_000);
});
