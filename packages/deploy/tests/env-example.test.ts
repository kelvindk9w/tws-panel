/**
 * env-example.test.ts — nomes de variáveis do `.env.example` do repositório.
 *
 * Validação real (vitrine, 03/10/2026): o app lê SMTP_USUARIO e SMTP_SENHA
 * por `env_file: .env`, sem `${...}` no compose — o seletor "Ligar às
 * variáveis do projeto" não as oferecia. O `.env.example` do repositório
 * lista esses nomes. Só os NOMES saem daqui: os valores de exemplo ficam.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_EXAMPLE_FILES, PROD_ENV_EXAMPLE_FILES, envExampleNames, readEnvExamples } from "../src/env-example.js";

let src: string;

beforeEach(async () => {
  src = await mkdtemp(path.join(tmpdir(), "paas-envex-"));
});
afterEach(async () => {
  await rm(src, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("envExampleNames — só os nomes", () => {
  it("lê NOME= e export NOME=, não repete e ignora linhas comentadas", () => {
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
      production: false,
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
      await rm(path.join(src, "..", `${path.basename(src)}-fora`), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
      await rm(fora, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

// Caso real (06/11/2026): o .env.example de um kit Laravel é o de DESENVOLVIMENTO (~250 nomes) e a lista de produção
// fica no .env.prod.example (36). A tela sugeria os dois. Com um exemplo de produção, só ele vale.
describe("readEnvExamples — exemplo de produção", () => {
  it("conhece os exemplos de produção, sem misturar com os de desenvolvimento nem com o .env.production de verdade", () => {
    expect(PROD_ENV_EXAMPLE_FILES).toContain(".env.production.example");
    expect(PROD_ENV_EXAMPLE_FILES).toContain(".env.prod.example");
    expect(PROD_ENV_EXAMPLE_FILES).toContain(".env.example.production");
    expect(PROD_ENV_EXAMPLE_FILES).toContain(".env.example.prod");
    expect(PROD_ENV_EXAMPLE_FILES).not.toContain(".env.production");
    expect(PROD_ENV_EXAMPLE_FILES).not.toContain(".env.prod");
    expect(PROD_ENV_EXAMPLE_FILES.some((f) => (ENV_EXAMPLE_FILES as readonly string[]).includes(f))).toBe(false);
    expect(new Set(PROD_ENV_EXAMPLE_FILES).size).toBe(PROD_ENV_EXAMPLE_FILES.length);
  });

  it("só o .env.example: sugere os nomes dele (production: false)", async () => {
    await writeFile(path.join(src, ".env.example"), "DEV_SLOT=1\nAPP_KEY=\n");
    expect(await readEnvExamples(src, [""])).toEqual({
      production: false,
      files: [".env.example"],
      variables: [
        { name: "DEV_SLOT", file: ".env.example" },
        { name: "APP_KEY", file: ".env.example" },
      ],
    });
  });

  it(".env.example e .env.prod.example: só os nomes do de produção (o de desenvolvimento é ignorado)", async () => {
    await writeFile(path.join(src, ".env.example"), "DEV_SLOT=1\nCOMPOSE_PROFILES=dev\nAPP_DEBUG=true\nAPP_KEY=\n");
    await writeFile(path.join(src, ".env.sample"), "OUTRA_DEV=1\n");
    await writeFile(path.join(src, ".env.prod.example"), "APP_URL=https://exemplo.com\nAPP_KEY=\n# ADMIN_ALLOWED_IPS=\n# Vazio = desligado\n");
    const r = await readEnvExamples(src, [""]);
    expect(r).toEqual({
      production: true,
      files: [".env.prod.example"],
      variables: [
        { name: "APP_URL", file: ".env.prod.example" },
        { name: "APP_KEY", file: ".env.prod.example" },
      ],
    });
    // nenhum valor de exemplo sai daqui, nem do arquivo de produção
    expect(JSON.stringify(r)).not.toContain("exemplo.com");
  });

  it.each(PROD_ENV_EXAMPLE_FILES)("%s conta como exemplo de produção", async (name) => {
    await writeFile(path.join(src, ".env.example"), "DEV_SLOT=1\n");
    await writeFile(path.join(src, name), "PROD_ONLY=\n");
    expect(await readEnvExamples(src, [""])).toEqual({
      production: true,
      files: [name],
      variables: [{ name: "PROD_ONLY", file: name }],
    });
  });

  it("exemplo de produção na pasta do compose vale para todas as pastas: o .env.example da raiz e o da pasta saem", async () => {
    await writeFile(path.join(src, ".env.example"), "DEV_SLOT=1\n");
    await mkdir(path.join(src, "deploy"));
    await writeFile(path.join(src, "deploy", ".env.production.example"), "APP_URL=\n");
    await writeFile(path.join(src, "deploy", ".env.example"), "DEV_PORT=1\n");
    expect(await readEnvExamples(src, ["", "deploy"])).toEqual({
      production: true,
      files: ["deploy/.env.production.example"],
      variables: [{ name: "APP_URL", file: "deploy/.env.production.example" }],
    });
  });

  it("exemplos de produção na raiz e na pasta do compose: junta os dois, com a origem de cada nome", async () => {
    await writeFile(path.join(src, ".env.production.example"), "A=\nB=\n");
    await writeFile(path.join(src, ".env.prod.example"), "B=\nC=\n");
    await mkdir(path.join(src, "deploy"));
    await writeFile(path.join(src, "deploy", ".env.prod.example"), "C=\nD=\n");
    expect(await readEnvExamples(src, ["", "deploy"])).toEqual({
      production: true,
      files: [".env.production.example", ".env.prod.example", "deploy/.env.prod.example"],
      variables: [
        { name: "A", file: ".env.production.example" },
        { name: "B", file: ".env.production.example" },
        { name: "C", file: ".env.prod.example" },
        { name: "D", file: "deploy/.env.prod.example" },
      ],
    });
  });

  it("exemplo de produção sem nenhuma variável ainda é a lista de produção: nada é sugerido do .env.example", async () => {
    await writeFile(path.join(src, ".env.example"), "DEV_SLOT=1\n");
    await writeFile(path.join(src, ".env.prod.example"), "# preencha no painel\n# APP_KEY=\n");
    expect(await readEnvExamples(src, [""])).toEqual({ production: true, files: [".env.prod.example"], variables: [] });
  });

  it("o .env.production (arquivo de ambiente, não exemplo) não muda nada: vale o .env.example", async () => {
    await writeFile(path.join(src, ".env.example"), "DEV_SLOT=1\n");
    await writeFile(path.join(src, ".env.production"), "SEGREDO_REAL=abc\n");
    const r = await readEnvExamples(src, [""]);
    expect(r).toEqual({ production: false, files: [".env.example"], variables: [{ name: "DEV_SLOT", file: ".env.example" }] });
    expect(JSON.stringify(r)).not.toContain("SEGREDO_REAL");
  });

  it("só o exemplo de produção, sem .env.example: production true", async () => {
    await writeFile(path.join(src, ".env.example.prod"), "APP_URL=\n");
    expect(await readEnvExamples(src, [""])).toEqual({
      production: true,
      files: [".env.example.prod"],
      variables: [{ name: "APP_URL", file: ".env.example.prod" }],
    });
  });
});

describe("readEnvExamples — exemplo de produção ilegível ou fora do código não conta", () => {
  it("link simbólico para fora do código: ignorado, vale o .env.example", async () => {
    const { symlink } = await import("node:fs/promises");
    const fora = await mkdtemp(path.join(tmpdir(), "paas-envex-fora-"));
    try {
      await writeFile(path.join(fora, "x"), "FORA=1\n");
      await symlink(path.join(fora, "x"), path.join(src, ".env.prod.example"));
      await writeFile(path.join(src, ".env.example"), "DENTRO=1\n");
      expect(await readEnvExamples(src, [""])).toEqual({
        production: false,
        files: [".env.example"],
        variables: [{ name: "DENTRO", file: ".env.example" }],
      });
    } finally {
      await rm(fora, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("grande demais ou pasta com o nome do arquivo: ignorado, vale o .env.example", async () => {
    await writeFile(path.join(src, ".env.prod.example"), `A=1\n${"#".repeat(300 * 1024)}\n`);
    await mkdir(path.join(src, ".env.production.example"));
    await writeFile(path.join(src, ".env.example"), "DENTRO=1\n");
    expect(await readEnvExamples(src, [""])).toEqual({
      production: false,
      files: [".env.example"],
      variables: [{ name: "DENTRO", file: ".env.example" }],
    });
  });

  it("pasta que sai do código não traz exemplo de produção", async () => {
    const fora = path.join(src, "..", `${path.basename(src)}-fora`);
    await mkdir(fora, { recursive: true });
    await writeFile(path.join(fora, ".env.prod.example"), "FORA=1\n");
    await writeFile(path.join(src, ".env.example"), "DENTRO=1\n");
    try {
      expect(await readEnvExamples(src, ["", `../${path.basename(src)}-fora`])).toEqual({
        production: false,
        files: [".env.example"],
        variables: [{ name: "DENTRO", file: ".env.example" }],
      });
    } finally {
      await rm(fora, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it("pasta repetida não repete o arquivo de produção", async () => {
    await mkdir(path.join(src, "deploy"));
    await writeFile(path.join(src, "deploy", ".env.prod.example"), "A=\n");
    expect(await readEnvExamples(src, ["deploy", "deploy", "deploy"])).toEqual({
      production: true,
      files: ["deploy/.env.prod.example"],
      variables: [{ name: "A", file: "deploy/.env.prod.example" }],
    });
  });

  it("linhas comentadas do exemplo de produção não geram nome", () => {
    expect(envExampleNames("APP_URL=\n# ADMIN_ALLOWED_IPS=\n# Vazio = desligado\n#VAR=x\n")).toEqual(["APP_URL"]);
  });
});
