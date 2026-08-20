/**
 * Testes do sistema completo de guardrails (rules.ts) — regras block/warn/info
 * executadas sobre fixtures reais em disco. Cada regra tem caso que dispara,
 * caso que NÃO dispara e edge case; o relatório final valida níveis,
 * ordenação e contadores.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GUARDRAIL_RULES, runGuardrails } from "../src/rules.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-rules-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeCompose(body: string, name = "compose.yml"): Promise<void> {
  await writeFile(path.join(dir, name), `services:\n${body}\n`);
}

describe("db-port-exposed (block)", () => {
  it("bloqueia deploy que publica porta do PostgreSQL no host", async () => {
    await writeCompose('  db:\n    image: postgres:16\n    ports: ["5432:5432"]');
    const report = await runGuardrails(dir);
    const finding = report.findings.find((f) => f.rule === "db-port-exposed");
    expect(finding).toBeDefined();
    expect(finding?.level).toBe("block");
    expect(finding?.service).toBe("db");
    expect(report.blockers).toBeGreaterThanOrEqual(1);
  });

  it("não dispara com banco apenas em expose (rede interna)", async () => {
    await writeCompose('  db:\n    image: postgres:16\n    expose: ["5432"]');
    const report = await runGuardrails(dir);
    expect(report.findings.filter((f) => f.rule === "db-port-exposed")).toHaveLength(0);
    expect(report.blockers).toBe(0);
  });
});

describe("weak-credentials (block)", () => {
  it("bloqueia credencial trivial no environment", async () => {
    await writeCompose("  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: password");
    const report = await runGuardrails(dir);
    expect(report.findings.some((f) => f.rule === "weak-credentials" && f.level === "block")).toBe(true);
  });

  it("bloqueia usuário == senha em variáveis separadas (POSTGRES_USER == POSTGRES_PASSWORD)", async () => {
    await writeCompose(
      "  db:\n    image: postgres:16\n    environment:\n      POSTGRES_USER: cacheta\n      POSTGRES_PASSWORD: cacheta",
    );
    const report = await runGuardrails(dir);
    const hit = report.findings.find((f) => f.rule === "weak-credentials" && f.title.includes("idênticos"));
    expect(hit).toBeDefined();
    expect(hit?.level).toBe("block");
  });

  it("não dispara com senha forte e usuário diferente", async () => {
    await writeCompose(
      "  db:\n    image: postgres:16\n    environment:\n      POSTGRES_USER: app\n      POSTGRES_PASSWORD: Kx9$mQ2pL8wZrT4uYbN7sA3vC6dF",
    );
    const report = await runGuardrails(dir);
    expect(report.findings.filter((f) => f.rule === "weak-credentials")).toHaveLength(0);
  });
});

describe("privileged-container (block)", () => {
  it("bloqueia privileged: true", async () => {
    await writeCompose("  app:\n    image: app:1\n    privileged: true");
    const report = await runGuardrails(dir);
    const hit = report.findings.find((f) => f.rule === "privileged-container");
    expect(hit).toMatchObject({ level: "block", service: "app" });
  });

  it("bloqueia montagem do /var/run/docker.sock (forma curta e longa)", async () => {
    await writeCompose(
      '  a:\n    image: app:1\n    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]\n' +
        "  b:\n    image: app:1\n    volumes:\n      - type: bind\n        source: /var/run/docker.sock\n        target: /sock",
    );
    const report = await runGuardrails(dir);
    const hits = report.findings.filter((f) => f.rule === "privileged-container");
    expect(hits).toHaveLength(2);
    expect(hits.every((f) => f.level === "block")).toBe(true);
  });

  it("não dispara com volumes comuns e sem privileged", async () => {
    await writeCompose('  app:\n    image: app:1\n    volumes: ["./data:/data"]');
    const report = await runGuardrails(dir);
    expect(report.findings.filter((f) => f.rule === "privileged-container")).toHaveLength(0);
  });
});

describe("dev-service-in-prod (warn)", () => {
  it("alerta Mailhog no compose de produção", async () => {
    await writeCompose('  mail:\n    image: mailhog/mailhog:v1.0.1\n    ports: ["8025:8025"]');
    const report = await runGuardrails(dir);
    const hit = report.findings.find((f) => f.rule === "dev-service-in-prod");
    expect(hit).toMatchObject({ level: "warn", service: "mail" });
    expect(report.blockers).toBe(0);
  });

  it("não dispara para stack de produção comum", async () => {
    await writeCompose("  web:\n    image: nginx:1.27\n  db:\n    image: postgres:16");
    const report = await runGuardrails(dir);
    expect(report.findings.filter((f) => f.rule === "dev-service-in-prod")).toHaveLength(0);
  });
});

describe("latest-tag (info)", () => {
  it("marca imagem :latest explícita e imagem sem tag", async () => {
    await writeCompose("  a:\n    image: redis:latest\n  b:\n    image: nginx");
    const report = await runGuardrails(dir);
    const hits = report.findings.filter((f) => f.rule === "latest-tag");
    expect(hits).toHaveLength(2);
    expect(hits.every((f) => f.level === "info")).toBe(true);
    expect(report.infos).toBe(2);
  });

  it("não dispara com versão fixada nem com digest imutável", async () => {
    await writeCompose(
      "  a:\n    image: redis:7.2-alpine\n  b:\n    image: nginx@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    const report = await runGuardrails(dir);
    expect(report.findings.filter((f) => f.rule === "latest-tag")).toHaveLength(0);
  });
});

describe("secret-in-code (warn)", () => {
  it("detecta chave AWS comitada em arquivo fonte", async () => {
    await writeFile(path.join(dir, "config.ts"), 'export const key = "AKIAIOSFODNN7EXAMPLE";\n');
    const report = await runGuardrails(dir);
    const hit = report.findings.find((f) => f.rule === "secret-in-code");
    expect(hit).toMatchObject({ level: "warn" });
    expect(hit?.evidence).toContain("config.ts:1");
  });

  it("detecta chave privada PEM e token do GitHub", async () => {
    // nota: o scanner só inspeciona extensões de texto (.pem não entra) —
    // a chave vazada num .txt é o vetor realista (backup esquecido).
    await writeFile(path.join(dir, "backup.txt"), "-----BEGIN RSA PRIVATE KEY-----\n...");
    await writeFile(path.join(dir, "ci.sh"), `TOKEN=ghp_${"a1B2c3D4".repeat(5)}\n`);
    const report = await runGuardrails(dir);
    expect(report.findings.filter((f) => f.rule === "secret-in-code").length).toBeGreaterThanOrEqual(2);
  });

  it("detecta atribuição genérica de alta entropia (SECRET = \"...\")", async () => {
    await writeFile(path.join(dir, ".env"), `APP_SECRET="Kx9mQ2pL8wZrT4uYbN7sA3vC6dF0gH1j"\n`);
    const report = await runGuardrails(dir);
    expect(report.findings.some((f) => f.rule === "secret-in-code")).toBe(true);
  });

  it("NÃO acusa placeholders óbvios (evita falso positivo)", async () => {
    await writeFile(path.join(dir, ".env.example"), 'APP_SECRET="changeme-placeholder-xxxx-xxxx"\n');
    const report = await runGuardrails(dir);
    expect(report.findings.filter((f) => f.rule === "secret-in-code")).toHaveLength(0);
  });

  it("ignora node_modules e arquivos sem extensão de texto", async () => {
    await mkdir(path.join(dir, "node_modules", "lib"), { recursive: true });
    await writeFile(path.join(dir, "node_modules", "lib", "leak.js"), 'const k = "AKIAIOSFODNN7EXAMPLE";\n');
    await writeFile(path.join(dir, "logo.png"), "fake-binary-AKIAIOSFODNN7EXAMPLE");
    const report = await runGuardrails(dir);
    expect(report.findings.filter((f) => f.rule === "secret-in-code")).toHaveLength(0);
  });

  it("deduplica ocorrências repetidas do mesmo padrão no mesmo arquivo", async () => {
    await writeFile(
      path.join(dir, "multi.ts"),
      'const a = "AKIAIOSFODNN7EXAMPLE";\nconst b = "AKIAIOSFODNN7EXAMPLE";\n',
    );
    const report = await runGuardrails(dir);
    expect(report.findings.filter((f) => f.rule === "secret-in-code")).toHaveLength(1);
  });
});

describe("relatório agregado", () => {
  it("compose inválido vira finding block (YAML quebrado não deve deployar)", async () => {
    await writeFile(path.join(dir, "compose.yml"), "services: [unclosed\n");
    const report = await runGuardrails(dir);
    const hit = report.findings.find((f) => f.rule === "invalid-compose");
    expect(hit).toMatchObject({ level: "block" });
    expect(report.blockers).toBe(1);
  });

  it("ordena findings por severidade (block → warn → info) e soma os contadores", async () => {
    await writeCompose(
      '  db:\n    image: postgres:16\n    ports: ["5432:5432"]\n' +
        '  mail:\n    image: mailhog/mailhog\n    ports: ["8025:8025"]\n' +
        "  cache:\n    image: redis",
    );
    const report = await runGuardrails(dir);
    const levels = report.findings.map((f) => f.level);
    const order = { block: 0, warn: 1, info: 2 } as const;
    for (let i = 1; i < levels.length; i += 1) {
      expect(order[levels[i]!]).toBeGreaterThanOrEqual(order[levels[i - 1]!]);
    }
    expect(report.findings.length).toBe(report.blockers + report.warnings + report.infos);
    expect(report.blockers).toBeGreaterThanOrEqual(1);
    expect(report.warnings).toBeGreaterThanOrEqual(1);
    expect(report.infos).toBeGreaterThanOrEqual(1);
    expect(report.dir).toBe(dir);
  });

  it("diretório limpo (sem compose nem secrets) → relatório vazio", async () => {
    await writeFile(path.join(dir, "README.md"), "# projeto\n");
    const report = await runGuardrails(dir);
    expect(report.findings).toHaveLength(0);
    expect(report.blockers).toBe(0);
  });

  it("catálogo GUARDRAIL_RULES lista as 6 regras com níveis corretos", () => {
    expect(GUARDRAIL_RULES.map((r) => [r.rule, r.level])).toEqual([
      ["db-port-exposed", "block"],
      ["weak-credentials", "block"],
      ["privileged-container", "block"],
      ["dev-service-in-prod", "warn"],
      ["secret-in-code", "warn"],
      ["latest-tag", "info"],
    ]);
  });
});
