/**
 * mail-test-scan.ts — nomes de variável de e-mail que a caixa de teste não redireciona (.env versionado, compose,
 * env_file, Dockerfile e Variáveis do painel). Só nomes, nunca valores.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mailTestEnv } from "@paas/core";
import { mailVariableKind, scanUncontrolledMail } from "../src/services/mail-test-scan.js";

let dir: string;
const controlled = new Set(Object.keys(mailTestEnv({ host: "h", password: "p" })));
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-mtscan-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const scan = (over: Partial<Parameters<typeof scanUncontrolledMail>[0]> = {}) =>
  scanUncontrolledMail({ srcDir: dir, composeFile: null, panelNames: [], controlled, ...over });

describe("mailVariableKind", () => {
  it.each([
    ["MAIL_RELAY_HOST", "smtp"],
    ["SMTP_ENDPOINT", "smtp"],
    ["MAILER_TRANSPORT", "smtp"],
    ["SENDGRID_API_KEY", "api"],
    ["RESEND_API_KEY", "api"],
    ["AWS_SES_SECRET", "api"],
    ["MAIL_FROM_ADDRESS", null],
    ["EMAIL_REPLY_TO", null],
    ["DATABASE_HOST", null],
    ["MAILCHIMP_NAME", null],
  ])("%s -> %s", (name, kind) => {
    expect(mailVariableKind(name)).toBe(kind);
  });
});

describe("scanUncontrolledMail", () => {
  it("sem pasta de código, só as Variáveis do painel valem", async () => {
    expect(await scan({ srcDir: null, panelNames: ["RESEND_API_KEY", "DATABASE_URL", "SMTP_HOST"] })).toEqual([
      { name: "RESEND_API_KEY", file: "Variáveis do painel", kind: "api" },
    ]);
  });

  it("acha nomes no .env versionado, no Dockerfile e no compose; os que o painel redireciona ficam de fora", async () => {
    await writeFile(path.join(dir, ".env"), "MAIL_HOST=smtp.example.com\nMAIL_RELAY_HOST=relay.example.com\nexport SENDGRID_API_KEY=abc\n# MAIL_X_HOST=1\n");
    await writeFile(path.join(dir, ".env.production"), "MAIL_FROM_ADDRESS=a@example.com\nMAILER_TRANSPORT=smtp\n");
    await writeFile(path.join(dir, "Dockerfile"), "FROM node\nENV MAIL_GATEWAY_HOST=x MAIL_PORT=25\nENV SMTP_RELAY_URL smtp://x\nARG POSTMARK_API_TOKEN\n");
    await writeFile(path.join(dir, "docker-compose.yml"), "services:\n  web:\n    environment:\n      SMTP_PROXY_HOST: p.example.com\n      MAIL_HOST: fixo\n    ports:\n      - 80:80\n");
    const out = await scan({ composeFile: "docker-compose.yml" });
    const keys = out.map((o) => `${o.file}:${o.name}:${o.kind}`).sort();
    expect(keys).toEqual(
      [
        ".env:MAIL_RELAY_HOST:smtp",
        ".env:SENDGRID_API_KEY:api",
        ".env.production:MAILER_TRANSPORT:smtp",
        "Dockerfile:MAIL_GATEWAY_HOST:smtp",
        "Dockerfile:POSTMARK_API_TOKEN:api",
        "Dockerfile:SMTP_RELAY_URL:smtp",
        "docker-compose.yml:SMTP_PROXY_HOST:smtp",
      ].sort(),
    );
  });

  it("segue env_file (valor único, lista e lista de objetos), mas nunca para fora da pasta nem por link", async () => {
    await mkdir(path.join(dir, "config"));
    await writeFile(path.join(dir, "config", "app.env"), "MAIL_ALT_HOST=x\n");
    await writeFile(path.join(dir, "config", "b.env"), "MAIL_B_HOST=x\n");
    await writeFile(path.join(dir, "c.env"), "MAIL_C_HOST=x\n");
    await writeFile(path.join(dir, "link.env"), "MAIL_LINK_HOST=x\n");
    await symlink(path.join(dir, "link.env"), path.join(dir, "viaLink.env"));
    await writeFile(
      path.join(dir, "compose.yml"),
      ["services:", "  a:", "    env_file: config/app.env", "  b:", "    env_file:", "      - config/b.env", "      - path: c.env", "      - viaLink.env", "      - ../fora.env", "  c:", '    env_file: ["./c.env"]', "    image: x"].join("\n"),
    );
    const out = await scan({ composeFile: "compose.yml" });
    // link.env e viaLink.env: o primeiro é lido (arquivo da raiz, .env*? não: nome link.env não começa com .env), o link nunca
    expect(out.map((o) => o.name).sort()).toEqual(["MAIL_ALT_HOST", "MAIL_B_HOST", "MAIL_C_HOST"]);
    expect(out.find((o) => o.name === "MAIL_ALT_HOST")?.file).toBe(path.join("config", "app.env"));
  });

  it("arquivo grande demais, ilegível ou ausente é ignorado sem erro", async () => {
    await writeFile(path.join(dir, ".env"), `MAIL_BIG_HOST=${"x".repeat(300 * 1024)}\n`);
    expect(await scan({ composeFile: "nao-existe.yml" })).toEqual([]);
    expect(await scan({ srcDir: path.join(dir, "nao-existe") })).toEqual([]);
  });

  it("limita a quantidade de resultados e não repete o mesmo nome no mesmo arquivo", async () => {
    const lines = Array.from({ length: 80 }, (_, i) => `MAIL_X${i}_HOST=1`).join("\n");
    await writeFile(path.join(dir, ".env"), `${lines}\nMAIL_X1_HOST=2\n`);
    const out = await scan();
    expect(out).toHaveLength(40);
    expect(new Set(out.map((o) => o.name)).size).toBe(40);
  });
});
