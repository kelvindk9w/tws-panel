/**
 * Nome de variável que guarda segredo (secret-names.ts) e seu uso nas duas regras de credencial
 * fraca (rules.ts = bloqueio do deploy; guardrails.ts = aviso ao adotar o compose).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeCompose } from "../src/guardrails.js";
import { runGuardrails } from "../src/rules.js";
import { isSecretKeyName } from "../src/secret-names.js";

const SEGREDOS = [
  "DB_PASSWORD",
  "POSTGRES_PASSWORD",
  "MYSQL_ROOT_PASSWORD",
  "REDIS_PASSWORD",
  "MERCADOPAGO_WEBHOOK_SECRET",
  "JWT_SECRET",
  "GITHUB_TOKEN",
  "STRIPE_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "POSTGRES_PASSWORD_FILE",
  "SMTP_PASS",
  "APP_KEY",
  // nomes inteiros, outras grafias e sufixos
  "PASSWORD",
  "secret",
  "TOKEN",
  "APIKEY",
  "STRIPE-API-KEY",
  "app.secret.key",
  "SECRET_KEY",
  "PRIVATE_KEY",
  "ACCESS_KEY",
  "MASTER_KEY",
  "ENCRYPTION_KEY",
  "DB_PASSWD",
  "DB_PWD",
  "PASS",
  "PASSWORD_PEPPER",
  "HASH_SALT",
  "ADMIN_PASSWORD_HASH",
  "PRIVATE_KEY_B64",
  "JWT_SECRET_BASE64",
  "SMTP_PASS_FILE",
];

const CONFIGURACAO = [
  "API_KEYS_ENVIRONMENT",
  "AUTH_PASSWORD_MIN",
  "AUTH_SENSITIVE_TOKEN_TTL_MINUTES",
  "WEBHOOKS_SECRET_MAX_OVERLAP_MINUTES",
  "API_KEYS_PER_PAGE",
  "TOKEN_TTL",
  "PASSWORD_RESET_EXPIRE",
  "SECRET_ROTATION_DAYS",
  // bordas
  "BYPASS",
  "PWD",
  "COMPASS",
  "KEY",
  "",
  "_FILE",
  "FILE",
  "HASH",
  "DB_HOST",
];

describe("isSecretKeyName", () => {
  it.each(SEGREDOS)("%s é segredo", (name) => {
    expect(isSecretKeyName(name)).toBe(true);
  });
  it.each(CONFIGURACAO)("'%s' não é segredo", (name) => {
    expect(isSecretKeyName(name)).toBe(false);
  });
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-secret-names-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const yaml = (key: string, value: string) => `services:\n  app:\n    image: nginx:1\n    environment:\n      ${key}: ${value}\n`;

describe("regras de credencial fraca usam o mesmo critério", () => {
  it("rules.ts: API_KEYS_ENVIRONMENT=live não bloqueia, mas JWT_SECRET=live bloqueia", async () => {
    await writeFile(path.join(dir, "compose.yml"), yaml("API_KEYS_ENVIRONMENT", "live"));
    const ok = await runGuardrails(dir, "compose.yml");
    expect(ok.findings.filter((f) => f.rule === "weak-credentials")).toHaveLength(0);

    await writeFile(path.join(dir, "compose.yml"), yaml("JWT_SECRET", "live"));
    const bad = await runGuardrails(dir, "compose.yml");
    expect(bad.findings.filter((f) => f.rule === "weak-credentials")).toHaveLength(1);
  });

  it("rules.ts: nome de configuração com valor curto não vira par usuário == senha", async () => {
    const content = `services:\n  app:\n    image: nginx:1\n    environment:\n      APP_USER: abc\n      TOKEN_TTL: abc\n`;
    await writeFile(path.join(dir, "compose.yml"), content);
    const report = await runGuardrails(dir, "compose.yml");
    expect(report.findings.filter((f) => f.rule === "weak-credentials")).toHaveLength(0);
  });

  it("guardrails.ts: mesmo critério no aviso ao adotar", () => {
    const ok = analyzeCompose(yaml("AUTH_PASSWORD_MIN", "8"), "compose.yml");
    expect(ok.filter((w) => w.id === "compose.weak-credentials")).toHaveLength(0);
    const bad = analyzeCompose(yaml("DB_PASSWORD", "123"), "compose.yml");
    expect(bad.filter((w) => w.id === "compose.weak-credentials")).toHaveLength(1);
  });
});
