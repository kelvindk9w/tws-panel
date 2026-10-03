/**
 * env-example.test.ts — nomes de variáveis do `.env.example` do repositório.
 *
 * Validação real (cassino, 03/10/2026): o app lê SMTP_USUARIO e SMTP_SENHA
 * por `env_file: .env`, sem `${...}` no compose — o seletor "Ligar às
 * variáveis do projeto" não as oferecia. O `.env.example` do repositório
 * lista esses nomes. Só os NOMES saem daqui: os valores de exemplo ficam.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_EXAMPLE_FILES, envExampleNames, readEnvExamples } from "../src/env-example.js";

let src: string;

beforeEach(async () => {
  src = await mkdtemp(path.join(tmpdir(), "paas-envex-"));
});
afterEach(async () => {
  await rm(src, { recursive: true, force: true });
});

describe("envExampleNames — só os nomes", () => {
  it("lê NOME=, export NOME=, linhas comentadas no formato NOME= e não repete", () => {
    const text = [
      "# E-mail",
      "SMTP_HOST=mail.exemplo.com",
      "SMTP_PORTA=587",
      "export SMTP_USUARIO=",
      "  SMTP_SENHA = troque-me",
      "#PIX_SIMULADO=1",
      "# BACKUP_PASTA=/tmp",
      "SMTP_HOST=repetida",
      "",
      "# Observação: isto não é variável",
      "1INVALIDA=x",
      "SEM_IGUAL",
      "EMAIL_DE=",
    ].join("\r\n");
    expect(envExampleNames(text)).toEqual([
      "SMTP_HOST",
      "SMTP_PORTA",
      "SMTP_USUARIO",
      "SMTP_SENHA",
      "PIX_SIMULADO",
      "BACKUP_PASTA",
      "EMAIL_DE",
    ]);
  });

  it("arquivo sem variáveis: lista vazia", () => {
    expect(envExampleNames("# só comentário\n\n")).toEqual([]);
  });
});

describe("readEnvExamples — procura os arquivos de exemplo", () => {
  it("conhece as variações comuns", () => {
    expect(ENV_EXAMPLE_FILES).toEqual([".env.example", ".env.sample", ".env.dist", ".env.template"]);
  });

  it("junta os arquivos das pastas, com a origem de cada nome (o primeiro arquivo vence)", async () => {
    await writeFile(path.join(src, ".env.example"), "SMTP_USUARIO=x\nSMTP_SENHA=y\n");
    await writeFile(path.join(src, ".env.sample"), "SMTP_SENHA=z\nKYC_MODO=demo\n");
    await mkdir(path.join(src, "deploy"));
    await writeFile(path.join(src, "deploy", ".env.dist"), "EMAIL_DE=a\n");
    const r = await readEnvExamples(src, ["", "deploy", "deploy", "nao-existe"]);
    expect(r).toEqual({
      files: [".env.example", ".env.sample", "deploy/.env.dist"],
      variables: [
        { name: "SMTP_USUARIO", file: ".env.example" },
        { name: "SMTP_SENHA", file: ".env.example" },
        { name: "KYC_MODO", file: ".env.sample" },
        { name: "EMAIL_DE", file: "deploy/.env.dist" },
      ],
    });
    // nenhum valor de exemplo sai daqui
    expect(JSON.stringify(r)).not.toMatch(/demo|"x"|"y"/);
  });

  it("sem arquivo de exemplo: null", async () => {
    expect(await readEnvExamples(src, [""])).toBeNull();
  });

  it("ignora arquivo grande demais, pasta com o nome do arquivo e caminho que sai do código", async () => {
    await writeFile(path.join(src, ".env.example"), `A=1\n${"#".repeat(300 * 1024)}\n`);
    await mkdir(path.join(src, ".env.sample"));
    await mkdir(path.join(src, "..", `${path.basename(src)}-fora`), { recursive: true });
    await writeFile(path.join(src, "..", `${path.basename(src)}-fora`, ".env.example"), "FORA=1\n");
    try {
      expect(await readEnvExamples(src, ["", `../${path.basename(src)}-fora`])).toBeNull();
    } finally {
      await rm(path.join(src, "..", `${path.basename(src)}-fora`), { recursive: true, force: true });
    }
  });

  it("link simbólico para fora do código: ignorado", async () => {
    const { symlink } = await import("node:fs/promises");
    const fora = await mkdtemp(path.join(tmpdir(), "paas-envex-fora-"));
    try {
      await writeFile(path.join(fora, "segredo"), "ROUBADA=1\n");
      await symlink(path.join(fora, "segredo"), path.join(src, ".env.example"));
      expect(await readEnvExamples(src, [""])).toBeNull();
    } finally {
      await rm(fora, { recursive: true, force: true });
    }
  });
});
