/**
 * project-dotenv.test.ts — as Variáveis do projeto viram o `.env` do compose.
 *
 * Validação real (cassino, 30/09/2026): o compose usa dezenas de
 * `${VAR:?defina VAR no .env}` e `env_file: .env`; o painel injetava as
 * variáveis só no override, e o `up` morreria em "defina POSTGRES_USER no
 * .env". Agora elas vão para o `.env` que o compose lê.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeVariables, writeProjectDotenv } from "../src/project-dotenv.js";

let root: string;
let src: string;
let work: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paas-dotenv-"));
  src = path.join(root, "src");
  work = path.join(root, "work");
  await mkdir(src, { recursive: true });
  await mkdir(work, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function gitInit() {
  execFileSync("git", ["init", "-q", src]);
}

describe("writeProjectDotenv", () => {
  it("grava o .env do projeto (0600), com aspas simples — '$' da senha não vira variável", async () => {
    gitInit();
    const r = await writeProjectDotenv(src, work, { POSTGRES_PASSWORD: "a$b c", EMAIL_DE: "no-reply@x.com" });
    expect(r.envFileArgs).toEqual([]);
    const content = await readFile(path.join(src, ".env"), "utf8");
    expect(content).toContain("POSTGRES_PASSWORD='a$b c'");
    expect(content).toContain("EMAIL_DE='no-reply@x.com'");
    expect((await stat(path.join(src, ".env"))).mode & 0o777).toBe(0o600);
    // não aparece como mudança do repositório
    expect(await readFile(path.join(src, ".git", "info", "exclude"), "utf8")).toMatch(/^\/\.env$/m);
  });

  it("valor com aspas simples ou quebra de linha: aspas duplas, com escape e sem interpolação", async () => {
    const r = await writeProjectDotenv(src, work, { A: "it's $HOME", B: "linha1\nlinha2" });
    expect(r.envFileArgs).toEqual([]);
    const content = await readFile(path.join(src, ".env"), "utf8");
    expect(content).toContain('A="it\'s $$HOME"');
    expect(content).toContain('B="linha1\\nlinha2"');
  });

  it(".env VERSIONADO no repositório: não sobrescreve; grava à parte e devolve --env-file", async () => {
    gitInit();
    await writeFile(path.join(src, ".env"), "DO_REPO=1\n");
    execFileSync("git", ["-C", src, "add", ".env"]);
    const r = await writeProjectDotenv(src, work, { A: "1" });
    expect(await readFile(path.join(src, ".env"), "utf8")).toBe("DO_REPO=1\n");
    expect(r.envFileArgs).toEqual(["--env-file", path.join(work, "paas.env")]);
    expect(await readFile(path.join(work, "paas.env"), "utf8")).toContain("A='1'");
    expect(r.note).toMatch(/versionado/);
  });

  it("exclude do git já existente (sem quebra de linha no fim) ganha a linha uma vez só", async () => {
    gitInit();
    await writeFile(path.join(src, ".git", "info", "exclude"), "*.log");
    await writeProjectDotenv(src, work, { A: "1" });
    await writeProjectDotenv(src, work, { A: "2" });
    expect(await readFile(path.join(src, ".git", "info", "exclude"), "utf8")).toBe("*.log\n/.env\n");
  });

  it("regrava o .env existente, trocando a permissão para 0600", async () => {
    await writeFile(path.join(src, ".env"), "VELHO=1\n", { mode: 0o644 });
    await writeProjectDotenv(src, work, { NOVO: "1" });
    expect(await readFile(path.join(src, ".env"), "utf8")).not.toContain("VELHO");
    expect((await stat(path.join(src, ".env"))).mode & 0o777).toBe(0o600);
  });

  it("sem variáveis: não cria nada", async () => {
    const r = await writeProjectDotenv(src, work, {});
    expect(r.envFileArgs).toEqual([]);
    await expect(stat(path.join(src, ".env"))).rejects.toThrow();
  });
});

describe("composeVariables — o que o compose espera", () => {
  it("lista as variáveis, dizendo quais são obrigatórias e quais têm padrão", () => {
    const vars = composeVariables(`services:
  db:
    environment:
      POSTGRES_USER: \${POSTGRES_USER:?defina POSTGRES_USER no .env}
      SMTP_HOST: \${SMTP_HOST:-mailpit}
      CASA_NOME: \${CASA_NOME}
      PREÇO: $$ESCAPADO
      OUTRA: $SIMPLES
    env_file:
      - .env
`);
    expect(vars.variables).toEqual([
      { name: "CASA_NOME", required: false, defaultValue: null },
      { name: "POSTGRES_USER", required: true, defaultValue: null },
      { name: "SIMPLES", required: false, defaultValue: null },
      { name: "SMTP_HOST", required: false, defaultValue: "mailpit" },
    ]);
    expect(vars.usesEnvFile).toBe(true);
  });
});
