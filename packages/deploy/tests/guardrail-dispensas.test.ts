/**
 * Dispensas "não procede" dos achados dos guardrails: a identidade de cada achado (regra + serviço + variável/alvo,
 * ou a evidência normalizada), a abrangência (só o serviço ou o projeto inteiro), as regras que nenhuma dispensa
 * alcança e o engine respeitando as dispensas nos deploys sem override (reinício, redeploy automático).
 * Sem Docker: `run`/`runStream` são dublês e a saída do `docker compose config` é escolhida por teste.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyGuardrailDismissals,
  GUARDRAIL_NOTICE_RULES,
  GUARDRAIL_UNDISMISSABLE_RULES,
  guardrailDismissNeedsProof,
  guardrailDismissalFor,
  guardrailFindingIdentity,
  isGuardrailDismissible,
  normalizeGuardrailEvidence,
  validGuardrailDismissals,
  type GuardrailDismissal,
  type GuardrailReport,
  type Project,
} from "@paas/core";

type Result = { code: number; stdout: string; stderr: string };
const calls: string[][] = [];
let configResult: Result = { code: 0, stdout: "{}", stderr: "" };

vi.mock("../src/exec.js", () => ({
  run: vi.fn(async (_file: string, args: string[]): Promise<Result> => {
    calls.push(args);
    if (args.includes("config")) return configResult;
    return { code: 0, stdout: "", stderr: "" };
  }),
  runStream: vi.fn(async (_file: string, args: string[]) => {
    calls.push(args);
    return 0;
  }),
}));

const { DeployEngine } = await import("../src/engine.js");
const { runGuardrails, GUARDRAIL_RULES } = await import("../src/rules.js");
const { HARD_RULES } = await import("../src/compose-model.js");
const { analyzeCompose } = await import("../src/guardrails.js");

let root: string;
let src: string;

beforeEach(async () => {
  calls.length = 0;
  configResult = { code: 0, stdout: "{}", stderr: "" };
  root = await mkdtemp(path.join(tmpdir(), "paas-dispensas-"));
  src = path.join(root, "projects", "loja", "src");
  await mkdir(src, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** Quatro serviços com a mesma variável "fraca" (o caso real: APP_TOKEN_TTL não é senha). */
const QUATRO = `services:
  web:
    image: nginx:1.27
    environment:
      APP_TOKEN_TTL: "3600"
  api:
    image: node:22
    environment:
      APP_TOKEN_TTL: "3600"
  worker:
    image: node:22
    environment:
      APP_TOKEN_TTL: "3600"
  cron:
    image: node:22
    environment:
      APP_TOKEN_TTL: "3600"
`;

function dismissal(over: Partial<GuardrailDismissal>): GuardrailDismissal {
  return {
    id: "d1",
    rule: "weak-credentials",
    service: null,
    match: "target",
    value: "APP_TOKEN_TTL",
    title: "Credencial fraca",
    reason: null,
    by: "admin",
    at: "2026-11-06T12:00:00.000Z",
    ...over,
  };
}

describe("identidade dos achados", () => {
  it("cada regra do compose diz a variável ou o alvo do achado", async () => {
    await writeFile(
      path.join(src, "compose.yml"),
      `services:
  db:
    image: postgres
    ports: ["5432:5432"]
    environment:
      POSTGRES_USER: loja
      POSTGRES_PASSWORD: loja
  mail:
    image: axllent/mailpit:v1.20
`,
    );
    await writeFile(path.join(src, "config.js"), 'const k = "AKIAIOSFODNN7EXAMPLE";\n');
    const report = await runGuardrails(src, "compose.yml");
    const target = (rule: string) => report.findings.filter((f) => f.rule === rule).map((f) => f.target);
    expect(target("db-port-exposed")).toEqual(["5432"]);
    expect(target("weak-credentials")).toEqual(expect.arrayContaining(["POSTGRES_PASSWORD", "POSTGRES_USER=POSTGRES_PASSWORD"]));
    expect(target("dev-service-in-prod")).toEqual(["Mailpit"]);
    expect(target("latest-tag")).toEqual(["postgres"]);
    expect(target("secret-in-code")).toEqual(["config.js (aws-access-key)"]);
  });

  it("db-port-exposed: o alvo diz o endereço; dispensar a publicação em 127.0.0.1 não cobre a mesma porta aberta para todos", async () => {
    await writeFile(
      path.join(src, "compose.yml"),
      `services:
  db:
    image: postgres:16
    ports: ["127.0.0.1:15432:5432"]
  db2:
    image: postgres:16
    ports: ["0.0.0.0:5432:5432", "::1:25432:5432"]
`,
    );
    const report = await runGuardrails(src, "compose.yml");
    const db = report.findings.filter((f) => f.rule === "db-port-exposed");
    expect(db.map((f) => f.target)).toEqual(["5432@127.0.0.1", "5432", "5432@::1"]);
    const local = dismissal({ rule: "db-port-exposed", value: "5432@127.0.0.1" });
    const after = applyGuardrailDismissals(report, [local]);
    expect(after.findings.filter((f) => f.rule === "db-port-exposed").map((f) => f.target)).toEqual(["5432", "5432@::1"]);
    // os avisos da detecção fazem a mesma conta
    const warnings = analyzeCompose(await readFile(path.join(src, "compose.yml"), "utf8"), "compose.yml", src);
    expect(warnings.filter((w) => w.rule === "db-port-exposed").map((w) => w.target)).toEqual(["5432@127.0.0.1", "5432", "5432@::1"]);
  });

  it("secret-in-code: dispensar um tipo de segredo no arquivo não cala outro tipo que entre nele depois", async () => {
    await writeFile(path.join(src, "config.js"), 'const k = "AKIAIOSFODNN7EXAMPLE";\nconst g = "ghp_' + "a".repeat(36) + '";\n');
    const report = await runGuardrails(src);
    const secrets = report.findings.filter((f) => f.rule === "secret-in-code");
    expect(secrets.map((f) => f.target).sort()).toEqual(["config.js (aws-access-key)", "config.js (github-token)"]);
    const after = applyGuardrailDismissals(report, [dismissal({ rule: "secret-in-code", value: "config.js (aws-access-key)" })]);
    expect(after.findings.filter((f) => f.rule === "secret-in-code").map((f) => f.target)).toEqual(["config.js (github-token)"]);
  });

  it("latest-tag: o alvo é a imagem sem a tag (trocar a versão não muda a identidade), mesmo com porta no registro", async () => {
    await writeFile(path.join(src, "compose.yml"), "services:\n  a:\n    image: registro:5000/loja/app:latest\n  b:\n    image: loja/app\n");
    const report = await runGuardrails(src, "compose.yml");
    expect(report.findings.filter((f) => f.rule === "latest-tag").map((f) => f.target)).toEqual(["registro:5000/loja/app", "loja/app"]);
  });

  it("achado sem alvo: vale a evidência sem espaços repetidos e com o serviço trocado por *", () => {
    expect(normalizeGuardrailEvidence('compose.yml:  serviço "web"   monta /srv/x:12', "web")).toBe('compose.yml: serviço "*" monta /srv/x:12');
    expect(normalizeGuardrailEvidence("a  b")).toBe("a b");
    expect(guardrailFindingIdentity({ evidence: 'compose.yml: serviço "api" usa x', service: "api" })).toEqual({ match: "evidence", value: 'compose.yml: serviço "*" usa x' });
    expect(guardrailFindingIdentity({ service: "api" })).toEqual({ match: "evidence", value: "" });
    expect(guardrailFindingIdentity({ target: "X", evidence: "e" })).toEqual({ match: "target", value: "X" });
  });

  it("os avisos da detecção carregam a mesma regra e o mesmo alvo que o deploy usa", () => {
    const warnings = analyzeCompose(QUATRO.replace("nginx:1.27", "mailhog/mailhog").concat("  db:\n    image: postgres:16\n    ports: ['5432:5432']\n"), "compose.yml", src);
    const weak = warnings.filter((w) => w.rule === "weak-credentials");
    expect(weak.map((w) => w.target)).toEqual(["APP_TOKEN_TTL", "APP_TOKEN_TTL", "APP_TOKEN_TTL", "APP_TOKEN_TTL"]);
    expect(warnings.find((w) => w.rule === "dev-service-in-prod")?.target).toBe("Mailhog");
    expect(warnings.find((w) => w.rule === "db-port-exposed")?.target).toBe("5432");
    const dismissals = [dismissal({})];
    expect(weak.every((w) => guardrailDismissalFor(w, dismissals))).toBe(true);
    const model = analyzeCompose("services:\n  web:\n    image: nginx:1.27\n    pid: host\n", "compose.yml", src);
    expect(model[0]).toMatchObject({ rule: "host-namespace", evidence: expect.stringContaining("pid: host") });
  });
});

describe("abrangência das dispensas", () => {
  it("em todos os serviços do projeto: a mesma variável some dos quatro e o deploy deixa de ser bloqueado", async () => {
    await writeFile(path.join(src, "compose.yml"), QUATRO);
    const report = await runGuardrails(src, "compose.yml");
    expect(report.findings.filter((f) => f.rule === "weak-credentials")).toHaveLength(4);
    const after = applyGuardrailDismissals(report, [dismissal({})]);
    expect(after.findings.filter((f) => f.rule === "weak-credentials")).toHaveLength(0);
    expect(after.blockers).toBe(0);
    expect(after.dismissed).toBe(4);
    expect(after.infos).toBe(report.infos);
  });

  it("só neste serviço: os outros três continuam avisando e bloqueando", async () => {
    await writeFile(path.join(src, "compose.yml"), QUATRO);
    const report = await runGuardrails(src, "compose.yml");
    const after = applyGuardrailDismissals(report, [dismissal({ service: "api" })]);
    const left = after.findings.filter((f) => f.rule === "weak-credentials");
    expect(left.map((f) => f.service).sort()).toEqual(["cron", "web", "worker"]);
    expect(after.blockers).toBe(3);
    expect(after.dismissed).toBe(1);
  });

  it("outra variável, outra regra ou outra forma de identidade não são cobertas", () => {
    const f = { rule: "weak-credentials", service: "web", target: "APP_TOKEN_TTL", evidence: "e" };
    expect(guardrailDismissalFor(f, [dismissal({ value: "OUTRA" })])).toBeNull();
    expect(guardrailDismissalFor(f, [dismissal({ rule: "secret-in-code" })])).toBeNull();
    expect(guardrailDismissalFor(f, [dismissal({ match: "evidence" })])).toBeNull();
    expect(guardrailDismissalFor({ ...f, service: undefined }, [dismissal({ service: "web" })])).toBeNull();
  });

  it("dispensa por evidência vale nos outros serviços quando é do projeto (a evidência normalizada é a mesma)", () => {
    const f = (service: string) => ({ rule: "host-mount", service, evidence: `compose.yml: serviço "${service}" monta /srv/dados de fora da pasta do projeto` });
    const d = dismissal({ rule: "host-mount", match: "evidence", value: guardrailFindingIdentity(f("web")).value });
    expect(guardrailDismissalFor(f("api"), [d])).toBe(d);
    expect(guardrailDismissalFor(f("api"), [{ ...d, service: "web" }])).toBeNull();
  });

  it("relatório sem nada dispensado não ganha o campo dispensados; o que já veio dispensado se acumula", () => {
    const base: GuardrailReport = { ranAt: "", dir: "", findings: [], blockers: 0, warnings: 0, infos: 0 };
    expect(applyGuardrailDismissals(base, [])).not.toHaveProperty("dismissed");
    expect(applyGuardrailDismissals({ ...base, dismissed: 2 }, []).dismissed).toBe(2);
  });
});

describe("regras que nenhuma dispensa alcança", () => {
  it("toda regra dura (HARD_RULES) e as que dão root na VPS estão na lista", () => {
    for (const rule of HARD_RULES) expect(GUARDRAIL_UNDISMISSABLE_RULES).toContain(rule);
    for (const rule of ["privileged-container", "host-namespace", "proxy-port-conflict", "invalid-compose"]) {
      expect(isGuardrailDismissible(rule)).toBe(false);
    }
    // e o resto do catálogo continua dispensável
    expect(GUARDRAIL_RULES.filter((r) => isGuardrailDismissible(r.rule)).map((r) => r.rule)).toEqual(
      expect.arrayContaining(["weak-credentials", "db-port-exposed", "secret-in-code", "dev-service-in-prod", "latest-tag", "host-mount", "unsupported-field"]),
    );
  });

  it("as regras que só avisam (dispensa sem reautenticação) são exatamente as não-block do catálogo", () => {
    expect([...GUARDRAIL_NOTICE_RULES].sort()).toEqual(GUARDRAIL_RULES.filter((r) => r.level !== "block").map((r) => r.rule).sort());
    expect(guardrailDismissNeedsProof("secret-in-code")).toBe(false);
    expect(guardrailDismissNeedsProof("weak-credentials")).toBe(true);
  });

  it("mesmo com uma dispensa gravada (arquivo editado à mão), o achado inegociável continua bloqueando", async () => {
    await writeFile(path.join(src, "compose.yml"), "services:\n  web:\n    image: nginx:1.27\n    privileged: true\n");
    const report = await runGuardrails(src, "compose.yml");
    const priv = report.findings.find((f) => f.rule === "privileged-container")!;
    const forged = dismissal({ rule: "privileged-container", service: null, ...guardrailFindingIdentity(priv) });
    const after = applyGuardrailDismissals(report, [forged]);
    expect(after.findings).toContainEqual(priv);
    expect(after.blockers).toBe(report.blockers);
  });
});

describe("leitura das dispensas gravadas", () => {
  it("só as entradas íntegras valem; o resto é ignorado sem derrubar nada", () => {
    const ok = dismissal({});
    expect(validGuardrailDismissals(undefined)).toEqual([]);
    expect(validGuardrailDismissals("lixo")).toEqual([]);
    expect(
      validGuardrailDismissals([ok, null, 3, { ...ok, id: "" }, { ...ok, service: 5 }, { ...ok, match: "x" }, { ...ok, reason: 1 }, { ...ok, title: 2 }, { ...ok, by: null }, { ...ok, at: "" }, { ...ok, value: "" }, { ...ok, rule: "" }, { ...ok, id: "d2", service: "web", reason: "não é senha" }]),
    ).toEqual([ok, { ...ok, id: "d2", service: "web", reason: "não é senha" }]);
  });
});

function project(over: Partial<Project> = {}): Project {
  return {
    id: "p1",
    name: "Loja",
    slug: "loja",
    ingestMode: "existing",
    source: src,
    branch: null,
    domain: "loja.localhost",
    websocket: false,
    detection: {
      type: "dockerfile",
      composeFile: null,
      outputDir: null,
      packageManager: null,
      buildCommand: null,
      proxyService: null,
      proxyPort: null, // de propósito: o deploy falha logo depois dos guardrails, sem Docker
      warnings: [],
      details: [],
    },
    proxyService: null,
    proxyPort: null,
    createdAt: "",
    updatedAt: "",
    lastDeployAt: null,
    lastDeployStatus: null,
    deployedBranch: null,
    deployedSource: null,
    ...over,
  } as Project;
}

function engine() {
  return new DeployEngine({
    projectsDir: path.join(root, "projects"),
    caddyDir: path.join(root, "caddy"),
    nodeImage: "node:22",
    staticImage: "nginx:alpine",
    caddyHttpPort: 80,
    caddyHttpsPort: 443,
  });
}

describe("deploy sem override (reinício, redeploy automático) respeita as dispensas", () => {
  it("sem dispensa o achado bloqueia; com a dispensa do projeto o deploy passa dos guardrails e o log diz o que foi dispensado", async () => {
    await writeFile(path.join(src, "compose.yml"), QUATRO);
    await expect(engine().deploy(project(), [], () => undefined)).rejects.toThrow(/guardrail_blocked/);
    let log = "";
    const p = project({ guardrailDismissals: [dismissal({})] });
    await expect(engine().deploy(p, [p], (c) => (log += c))).rejects.toThrow(/porta exposta/i);
    expect(log).not.toContain("guardrail_blocked");
    expect(log).toContain('○ DISPENSADO [weak-credentials]');
    expect(log).toContain('4 achado(s) dispensado(s) como "não procede"');
    expect(log).toContain("Etapa 2/5");
  });

  it("dispensa só de um serviço: os outros continuam bloqueando o deploy automático", async () => {
    await writeFile(path.join(src, "compose.yml"), QUATRO);
    const p = project({ guardrailDismissals: [dismissal({ service: "web" })] });
    await expect(engine().deploy(p, [p], () => undefined)).rejects.toThrow(/guardrail_blocked: 3 bloqueio/);
  });

  it("relatório reaproveitado (já sem os dispensados) mantém a contagem no log", async () => {
    let log = "";
    const p = project({ guardrailDismissals: [dismissal({})] });
    const pre: GuardrailReport = { ranAt: "", dir: src, findings: [], blockers: 0, warnings: 0, infos: 0, dismissed: 4 };
    await expect(engine().deploy(p, [p], (c) => (log += c), { precomputedGuardrailReport: pre })).rejects.toThrow(/porta exposta/i);
    expect(log).toContain("4 achado(s) dispensado(s)");
  });

  it("compose resolvido: achado dispensável dispensado não barra o up; o inegociável barra mesmo com dispensa gravada", async () => {
    type Privado = { assertComposeAllowed(p: Project, src: string, args: string[], onLog: (c: string) => void, override: boolean): Promise<unknown> };
    const evidence = 'compose.yml: serviço "web" monta /srv/dados de fora da pasta do projeto';
    configResult = {
      code: 0,
      stdout: JSON.stringify({ name: "paas-loja", services: { web: { image: "nginx:1.27", volumes: [{ type: "bind", source: "/srv/dados", target: "/d" }] } } }),
      stderr: "",
    };
    const composeProject = (dismissals: GuardrailDismissal[]) =>
      project({ guardrailDismissals: dismissals, detection: { ...project().detection!, type: "compose", composeFile: "compose.yml" } });
    const check = (p: Project, onLog: (c: string) => void = () => undefined) =>
      (engine() as unknown as Privado).assertComposeAllowed(p, src, ["compose"], onLog, false);
    await expect(check(composeProject([]))).rejects.toThrow(/guardrail_blocked/);
    let log = "";
    const d = dismissal({ rule: "host-mount", match: "evidence", value: guardrailFindingIdentity({ evidence, service: "web" }).value });
    await expect(check(composeProject([d]), (c) => (log += c))).resolves.toBeTruthy();
    expect(log).toContain("○ DISPENSADO [host-mount]");
    expect(log).toContain("só pede o que um projeto pode pedir");

    configResult = { code: 0, stdout: JSON.stringify({ name: "paas-loja", services: { web: { image: "nginx:1.27", privileged: true } } }), stderr: "" };
    const forged = dismissal({ rule: "privileged-container", match: "evidence", value: 'compose.yml: serviço "*" define privileged: true' });
    await expect(check(composeProject([forged]))).rejects.toThrow(/guardrail_blocked/);
  });
});
