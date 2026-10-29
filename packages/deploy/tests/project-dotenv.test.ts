/**
 * project-dotenv.test.ts — as Variáveis do projeto viram o `.env` do compose.
 *
 * Validação real (vitrine, 30/09/2026): o compose usa dezenas de
 * `${VAR:?defina VAR no .env}` e `env_file: .env`; o painel injetava as
 * variáveis só no override, e o `up` morreria em "defina POSTGRES_USER no
 * .env". Agora elas vão para o `.env` que o compose lê.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composeVariables, missingFromComposeOutput, writeProjectDotenv } from "../src/project-dotenv.js";

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

  it("regrava o .env que o próprio painel gerou (começa com o cabeçalho), trocando a permissão para 0600", async () => {
    await writeProjectDotenv(src, work, { VELHO: "1" });
    await chmod(path.join(src, ".env"), 0o644);
    await writeProjectDotenv(src, work, { NOVO: "1" });
    expect(await readFile(path.join(src, ".env"), "utf8")).not.toContain("VELHO");
    expect(await readFile(path.join(src, ".env"), "utf8")).toContain("NOVO='1'");
    expect((await stat(path.join(src, ".env"))).mode & 0o777).toBe(0o600);
  });

  // A6 do lote 6: o .env do dono, NÃO versionado, era sobrescrito sem cópia.
  it("`.env` do dono (não versionado, sem o cabeçalho do painel): NÃO é sobrescrito; as variáveis vão à parte e há aviso", async () => {
    await writeFile(path.join(src, ".env"), "MEU_SEGREDO=abc\nOUTRO=2\n", { mode: 0o644 });
    const r = await writeProjectDotenv(src, work, { A: "1" });
    expect(await readFile(path.join(src, ".env"), "utf8")).toBe("MEU_SEGREDO=abc\nOUTRO=2\n");
    expect(r.envFileArgs).toEqual(["--env-file", path.join(work, "paas.env")]);
    expect(await readFile(path.join(work, "paas.env"), "utf8")).toContain("A='1'");
    expect(r.note).toMatch(/\.env/);
    expect(r.note).toMatch(/não foi sobrescrito/);
    expect(r.note).toMatch(/env_file/);
  });

  it("`.env` do dono + todas as variáveis excluídas: o .env do dono fica e o paas.env some", async () => {
    await writeFile(path.join(src, ".env"), "MEU_SEGREDO=abc\n");
    await writeProjectDotenv(src, work, { A: "1" });
    const r = await writeProjectDotenv(src, work, {});
    expect(r.envFileArgs).toEqual([]);
    expect(await readFile(path.join(src, ".env"), "utf8")).toBe("MEU_SEGREDO=abc\n");
    expect(existsSync(path.join(work, "paas.env"))).toBe(false);
  });

  it("o dono apaga o .env dele: na vez seguinte o painel volta a gerar o seu (com cabeçalho) e o paas.env antigo sai", async () => {
    await writeFile(path.join(src, ".env"), "MEU_SEGREDO=abc\n");
    await writeProjectDotenv(src, work, { A: "1" });
    await rm(path.join(src, ".env"));
    const r = await writeProjectDotenv(src, work, { A: "1" });
    expect(r.envFileArgs).toEqual([]);
    expect(r.note).toBeNull();
    expect(await readFile(path.join(src, ".env"), "utf8")).toMatch(/^# Gerado pelo painel/);
    expect(existsSync(path.join(work, "paas.env"))).toBe(false);
  });

  it("sem variáveis: não cria nada", async () => {
    const r = await writeProjectDotenv(src, work, {});
    expect(r.envFileArgs).toEqual([]);
    await expect(stat(path.join(src, ".env"))).rejects.toThrow();
  });

  // Achado 9 da revisão: apagar todas as variáveis no painel deixava o `.env`
  // antigo na pasta (o clone é mantido entre deploys) e o container subia
  // com o segredo que o dono acabou de apagar.
  it("todas as variáveis excluídas: o .env gerado pelo painel some no próximo deploy", async () => {
    gitInit();
    await writeProjectDotenv(src, work, { API_KEY: "old-secret" });
    const r = await writeProjectDotenv(src, work, {});
    expect(r.envFileArgs).toEqual([]);
    expect(existsSync(path.join(src, ".env"))).toBe(false);
  });

  it("todas excluídas com .env versionado: o paas.env some (o --env-file deixa de ser passado)", async () => {
    gitInit();
    await writeFile(path.join(src, ".env"), "DO_REPO=1\n");
    execFileSync("git", ["-C", src, "add", ".env"]);
    await writeProjectDotenv(src, work, { API_KEY: "old-secret" });
    expect(existsSync(path.join(work, "paas.env"))).toBe(true);
    const r = await writeProjectDotenv(src, work, {});
    expect(r.envFileArgs).toEqual([]);
    expect(existsSync(path.join(work, "paas.env"))).toBe(false);
    // o .env do repositório não é tocado
    expect(await readFile(path.join(src, ".env"), "utf8")).toBe("DO_REPO=1\n");
  });

  it("todas excluídas: um .env que o painel NÃO gerou (do dono, fora do git) fica intacto", async () => {
    await writeFile(path.join(src, ".env"), "MEU=1\n");
    await writeProjectDotenv(src, work, {});
    expect(await readFile(path.join(src, ".env"), "utf8")).toBe("MEU=1\n");
  });

  it(".env deixou de ser versionado: o paas.env antigo some e as variáveis vão para o .env", async () => {
    await writeFile(path.join(work, "paas.env"), "API_KEY='old-secret'\n");
    const r = await writeProjectDotenv(src, work, { A: "1" });
    expect(r.envFileArgs).toEqual([]);
    expect(existsSync(path.join(work, "paas.env"))).toBe(false);
    expect(await readFile(path.join(src, ".env"), "utf8")).toContain("A='1'");
  });
});

describe("writeProjectDotenv — .env que o dono editou depois de o painel gerar (A6)", () => {
  it("o painel guarda o que gravou; arquivo editado pelo dono (mesmo com o cabeçalho) NÃO é sobrescrito", async () => {
    gitInit();
    const primeira = await writeProjectDotenv(src, work, { A: "1" });
    expect(primeira.target).toBe(".env");
    await writeFile(path.join(src, ".env"), (await readFile(path.join(src, ".env"), "utf8")) + "MINHA_CHAVE='do-dono'\n");
    const segunda = await writeProjectDotenv(src, work, { A: "2" });
    expect(segunda.target).toBe("paas.env");
    expect(await readFile(path.join(src, ".env"), "utf8")).toMatch(/MINHA_CHAVE='do-dono'/);
    expect(await readFile(path.join(src, ".env"), "utf8")).not.toMatch(/A='2'/);
    expect(await readFile(path.join(work, "paas.env"), "utf8")).toMatch(/A='2'/);
    expect(segunda.envFileArgs).toEqual(["--env-file", path.join(work, "paas.env")]);
    expect(segunda.note).toMatch(/editado/);
  });

  it("arquivo que o painel gerou e ninguém mexeu continua sendo regravado a cada deploy", async () => {
    gitInit();
    await writeProjectDotenv(src, work, { A: "1" });
    const r = await writeProjectDotenv(src, work, { A: "2", B: "3" });
    expect(r.target).toBe(".env");
    expect(await readFile(path.join(src, ".env"), "utf8")).toMatch(/A='2'[\s\S]*B='3'/);
    expect(existsSync(path.join(work, "paas.env"))).toBe(false);
  });

  it("todas as variáveis excluídas: .env editado pelo dono fica; o intacto é apagado junto com o registro", async () => {
    gitInit();
    await writeProjectDotenv(src, work, { A: "1" });
    await writeFile(path.join(src, ".env"), (await readFile(path.join(src, ".env"), "utf8")) + "MINHA='x'\n");
    await writeProjectDotenv(src, work, {});
    expect(existsSync(path.join(src, ".env"))).toBe(true);

    await rm(path.join(src, ".env"));
    await writeProjectDotenv(src, work, { A: "1" });
    await writeProjectDotenv(src, work, {});
    expect(existsSync(path.join(src, ".env"))).toBe(false);
    expect(existsSync(path.join(work, "paas.dotenv.hash"))).toBe(false);
  });

  it(".env gerado por versão antiga do painel (cabeçalho, sem registro): segue sendo do painel", async () => {
    gitInit();
    await writeProjectDotenv(src, work, { A: "1" });
    await rm(path.join(work, "paas.dotenv.hash"), { force: true });
    const r = await writeProjectDotenv(src, work, { A: "2" });
    expect(r.target).toBe(".env");
  });

  it("primeira regravação de um .env antigo sem registro: guarda uma cópia do arquivo (uma vez só)", async () => {
    gitInit();
    await writeFile(
      path.join(src, ".env"),
      "# Gerado pelo painel (seção Variáveis do projeto) — não editar aqui: edite no painel.\nA='velho'\nEXTRA='que o dono pôs'\n",
    );
    await writeProjectDotenv(src, work, { A: "2" });
    const copia = path.join(work, "paas.dotenv.antigo");
    expect(await readFile(copia, "utf8")).toMatch(/EXTRA='que o dono pôs'/);
    expect((await stat(copia)).mode & 0o777).toBe(0o600);
    await writeProjectDotenv(src, work, { A: "3" });
    expect(await readFile(copia, "utf8")).toMatch(/A='velho'/);
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

/**
 * Validação real (vitrine, 01/10/2026): `${EMAIL_DE:-${MAIL_FROM:?…}}` — o
 * MAIL_FROM só é exigido se EMAIL_DE estiver vazia. A leitura antiga parava
 * no primeiro "}" e não via o MAIL_FROM: o deploy falhava sem aviso prévio.
 */
describe("composeVariables — variável dentro do padrão de outra", () => {
  it("obrigatória aninhada vale só se a de fora estiver vazia (alternatives)", () => {
    const vars = composeVariables(`services:
  ledger:
    environment:
      EMAIL_DE: \${EMAIL_DE:-\${MAIL_FROM:?defina EMAIL_DE nas Variaveis}}
      SMTP_PORTA: \${SMTP_PORTA:-\${SMTP_PORT:-587}}
      KYC: \${KYC_MODO:?defina KYC_MODO no .env (demonstracao ou producao)}
`);
    expect(vars.variables).toEqual([
      { name: "EMAIL_DE", required: false, defaultValue: "${MAIL_FROM:?defina EMAIL_DE nas Variaveis}" },
      { name: "KYC_MODO", required: true, defaultValue: null },
      { name: "MAIL_FROM", required: true, defaultValue: null, alternatives: ["EMAIL_DE"] },
      { name: "SMTP_PORT", required: false, defaultValue: "587" },
      { name: "SMTP_PORTA", required: false, defaultValue: "${SMTP_PORT:-587}" },
    ]);
  });

  it("usada também fora do padrão: vira obrigatória de verdade (sem alternativa)", () => {
    const vars = composeVariables("a: ${A:-${B:?x}}\nb: ${B:?y}\n");
    expect(vars.variables.find((v) => v.name === "B")).toEqual({ name: "B", required: true, defaultValue: null });
  });
});

describe("missingFromComposeOutput — o que faltou, lido do erro do compose", () => {
  it("extrai os nomes das linhas 'required variable X is missing a value', sem repetir", () => {
    const out = [
      "error while interpolating services.caddy.environment.SITE_HOST: required variable SITE_HOST is missing a value: defina SITE_HOST no .env",
      "error while interpolating services.ledger.environment.EMAIL_DE: required variable MAIL_FROM is missing a value: defina EMAIL_DE",
      "error while interpolating services.x.environment.SITE_HOST: required variable SITE_HOST is missing a value: defina",
    ].join("\n");
    expect(missingFromComposeOutput(out)).toEqual(["SITE_HOST", "MAIL_FROM"]);
  });

  it("nada a extrair: lista vazia", () => {
    expect(missingFromComposeOutput("port is already allocated")).toEqual([]);
  });
});
