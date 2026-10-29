/**
 * weak-credentials — além do YAML cru, vale o valor RESOLVIDO das Variáveis salvas do projeto
 * (`${DB_PASSWORD}` com a Variável "123"). O valor nunca aparece na mensagem: só o nome.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGuardrails } from "../src/rules.js";
import { resolveWithVariables } from "../src/variable-resolve.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-weak-vars-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const compose = (env: string) => `services:\n  db:\n    image: postgres:16\n    environment:\n${env}\n`;
async function weak(env: string, variables?: Record<string, string>) {
  await writeFile(path.join(dir, "compose.yml"), compose(env));
  const report = await runGuardrails(dir, "compose.yml", undefined, undefined, variables);
  return report.findings.filter((f) => f.rule === "weak-credentials");
}

describe("weak-credentials com as Variáveis salvas", () => {
  it("${DB_PASSWORD} com a Variável '123' bloqueia, citando só o NOME da Variável", async () => {
    const found = await weak("      POSTGRES_PASSWORD: ${DB_PASSWORD}", { DB_PASSWORD: "123" });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ level: "block", service: "db" });
    expect(found[0]!.evidence).toMatch(/POSTGRES_PASSWORD.*Variável DB_PASSWORD/);
    expect(found[0]!.fix).toMatch(/Variável DB_PASSWORD/);
    expect(JSON.stringify(found)).not.toMatch(/"123"|\b123\b/);
  });

  it("vale também para $VAR, ${VAR:-padrão} e valor composto, e para a lista 'KEY=valor'", async () => {
    expect(await weak("      POSTGRES_PASSWORD: $DB_PASSWORD", { DB_PASSWORD: "admin" })).toHaveLength(1);
    expect(await weak("      POSTGRES_PASSWORD: ${DB_PASSWORD:-padrao-forte-123456}", { DB_PASSWORD: "root" })).toHaveLength(1);
    expect(await weak("      - API_TOKEN=${TK}", { TK: "dev" })).toHaveLength(1);
    expect(await weak("      DB_URL_PASSWORD: ${A}${B}", { A: "ab", B: "cd" })).toHaveLength(1);
  });

  it("Variável forte, vazia, desconhecida ou sem Variáveis não bloqueia", async () => {
    const env = "      POSTGRES_PASSWORD: ${DB_PASSWORD}-segura-o-bastante-xyz";
    expect(await weak(env, { DB_PASSWORD: "k3j9Zq8wLp2xVb7nR5" })).toHaveLength(0);
    expect(await weak(env, { DB_PASSWORD: "" })).toHaveLength(0);
    expect(await weak(env, { OUTRA: "123" })).toHaveLength(0);
    expect(await weak(env)).toHaveLength(0);
  });

  it("o padrão ':-' do compose não é adivinhado: sem Variável salva, o padrão fraco não bloqueia (pode vir de um .env)", async () => {
    expect(await weak("      POSTGRES_PASSWORD: ${DB_PASSWORD:-123}", { OUTRA: "x" })).toHaveLength(0);
  });

  it("usuário e senha iguais depois de resolver as Variáveis", async () => {
    const found = await weak("      POSTGRES_USER: ${DB_USER}\n      POSTGRES_PASSWORD: ${DB_PASS}", { DB_USER: "meuapp-prod", DB_PASS: "meuapp-prod" });
    const same = found.find((f) => f.title === "Usuário e senha idênticos");
    expect(same?.evidence).toMatch(/Variável DB_USER.*Variável DB_PASS/);
    expect(JSON.stringify(found)).not.toContain("meuapp-prod");
  });

  it("o valor cru fraco no YAML segue bloqueando como antes, sem 'valor da Variável' na mensagem", async () => {
    const found = await weak("      POSTGRES_PASSWORD: 123456", { OUTRA: "x" });
    expect(found).toHaveLength(1);
    expect(found[0]!.evidence).not.toMatch(/Variável/);
  });
});

describe("resolveWithVariables", () => {
  it("troca ${X}, $X, ${X:-d}, ${X?} e $$; deixa de fora ${X:+d} e o que não existe", () => {
    const vars = { X: "1", Y: "" };
    expect(resolveWithVariables("a${X}b $X ${X:-d} ${X:?falta}", vars)).toEqual({ text: "a1b 1 1 1", names: ["X"] });
    expect(resolveWithVariables("$$X", vars)).toEqual({ text: "$X", names: [] });
    expect(resolveWithVariables("${X:+alt} ${Y} ${Z}", vars).text).toBe("${X:+alt} ${Y} ${Z}");
  });

  it("sem Variáveis ou sem cifrão devolve o texto como está", () => {
    expect(resolveWithVariables("${X}", undefined)).toEqual({ text: "${X}", names: [] });
    expect(resolveWithVariables("simples", { X: "1" })).toEqual({ text: "simples", names: [] });
  });

  it("nome herdado de Object.prototype não é Variável", () => {
    expect(resolveWithVariables("${constructor} ${toString}", {}).names).toEqual([]);
  });
});
