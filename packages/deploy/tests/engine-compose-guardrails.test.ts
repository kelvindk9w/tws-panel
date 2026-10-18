/**
 * DeployEngine (compose) — o compose é conferido COMO O DOCKER O VAI EXECUTAR
 * (`docker compose config` com os mesmos -p/--env-file/-f do `up`) antes de
 * qualquer `up` (achado A1). Sem Docker: `run` e `runStream` são dublês; a
 * saída do `config` é o modelo canônico que cada teste escolhe.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";

type Result = { code: number; stdout: string; stderr: string };
const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
let configResult: Result = { code: 0, stdout: "{}", stderr: "" };

vi.mock("../src/exec.js", () => ({
  run: vi.fn(async (_file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }): Promise<Result> => {
    calls.push({ args, ...(opts?.env ? { env: opts.env } : {}) });
    if (args.includes("config")) return configResult;
    return { code: 0, stdout: "", stderr: "" };
  }),
  runStream: vi.fn(async (_file: string, args: string[], _onData: unknown, opts?: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ args, ...(opts?.env ? { env: opts.env } : {}) });
    return 0;
  }),
}));

const { DeployEngine } = await import("../src/engine.js");

let root: string;
let projectsDir: string;
let src: string;

beforeEach(async () => {
  calls.length = 0;
  configResult = { code: 0, stdout: "{}", stderr: "" };
  root = await mkdtemp(path.join(tmpdir(), "paas-engine-guardrails-"));
  projectsDir = path.join(root, "projects");
  src = path.join(projectsDir, "loja", "src");
  await mkdir(src, { recursive: true });
  await writeFile(path.join(src, "compose.yml"), "services:\n  web:\n    image: nginx:1.27\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function project(): Project {
  return {
    id: "p1",
    name: "Loja",
    slug: "loja",
    ingestMode: "git",
    source: "https://example.com/loja.git",
    branch: "main",
    domain: "loja.localhost",
    websocket: false,
    detection: {
      type: "compose",
      composeFile: "compose.yml",
      outputDir: null,
      packageManager: null,
      buildCommand: null,
      proxyService: "web",
      proxyPort: 80,
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
  };
}

function engine() {
  return new DeployEngine({
    projectsDir,
    caddyDir: path.join(projectsDir, "caddy"),
    nodeImage: "node:22",
    staticImage: "nginx:alpine",
    caddyHttpPort: 80,
    caddyHttpsPort: 443,
  });
}

type Privado = {
  deployCompose(p: Project, src: string, onLog: (c: string) => void, dotenv: Record<string, string>, extra: Record<string, string>, tz: string | null, override: boolean): Promise<string>;
  assertComposeAllowed(p: Project, src: string, args: string[], onLog: (c: string) => void, override: boolean): Promise<void>;
};
const privado = () => engine() as unknown as Privado;

function sobe(): boolean {
  return calls.some((c) => c.args.includes("up"));
}

const HOSTIL = JSON.stringify({
  name: "paas-loja",
  services: { web: { image: "nginx:1.27", privileged: true, cap_add: ["SYS_ADMIN"], volumes: [{ type: "bind", source: "/", target: "/host" }] } },
});
const LIMPO = JSON.stringify({ name: "paas-loja", services: { web: { image: "nginx:1.27" } } });

describe("DeployEngine.deployCompose — guardrails sobre o compose resolvido", () => {
  it("confere o compose resolvido ANTES do up, com o mesmo -p e --project-directory (o up roda do JSON conferido: engine-canonico.test.ts)", async () => {
    configResult = { code: 0, stdout: LIMPO, stderr: "" };
    await privado().deployCompose(project(), src, () => undefined, {}, {}, null, false);
    const config = calls.find((c) => c.args.includes("config"))!;
    const up = calls.find((c) => c.args.includes("up"))!;
    expect(calls.indexOf(config)).toBeLessThan(calls.indexOf(up));
    const valor = (a: string[], flag: string) => a[a.indexOf(flag) + 1];
    expect(valor(config.args, "-p")).toBe(valor(up.args, "-p"));
    expect(valor(config.args, "--project-directory")).toBe(valor(up.args, "--project-directory"));
    expect(config.args).toEqual(expect.arrayContaining(["--format", "json", "--no-env-resolution"]));
  });

  it("compose resolvido hostil: aborta antes do up e lista o que foi achado", async () => {
    configResult = { code: 0, stdout: HOSTIL, stderr: "" };
    let log = "";
    await expect(privado().deployCompose(project(), src, (c) => (log += c), {}, {}, null, false)).rejects.toThrow(/guardrail_blocked/);
    expect(sobe()).toBe(false);
    expect(log).toContain("Container privilegiado");
    expect(log).toContain("cap_add");
    expect(log).toContain("monta / de fora da pasta do projeto");
  });

  it("com override explícito do operador, os bloqueios comuns passam (e ficam no log)", async () => {
    configResult = { code: 0, stdout: HOSTIL, stderr: "" };
    let log = "";
    await privado().deployCompose(project(), src, (c) => (log += c), {}, {}, null, true);
    expect(sobe()).toBe(true);
    expect(log).toContain("Override explícito do operador");
  });

  it("docker compose, up e config rodam SEM os segredos do painel no ambiente", async () => {
    const antes = process.env.SETUP_TOKEN;
    process.env.SETUP_TOKEN = "segredo";
    try {
      configResult = { code: 0, stdout: LIMPO, stderr: "" };
      await privado().deployCompose(project(), src, () => undefined, {}, {}, null, false);
    } finally {
      if (antes === undefined) delete process.env.SETUP_TOKEN;
      else process.env.SETUP_TOKEN = antes;
    }
    for (const c of calls.filter((x) => x.args.includes("config") || x.args.includes("up"))) {
      expect(c.env).toBeDefined();
      expect(c.env).not.toHaveProperty("SETUP_TOKEN");
    }
  });

  it("variável obrigatória faltando: a mesma mensagem de antes, sem tentar subir", async () => {
    configResult = { code: 1, stdout: "", stderr: "required variable POSTGRES_PASSWORD is missing a value: defina" };
    await expect(privado().deployCompose(project(), src, () => undefined, {}, {}, null, false)).rejects.toThrow(
      /faltam variáveis obrigatórias do compose: POSTGRES_PASSWORD/,
    );
    expect(sobe()).toBe(false);
  });

  it("compose que o docker não consegue interpretar: erro claro, sem subir", async () => {
    configResult = { code: 1, stdout: "", stderr: "yaml: line 3: mapping values are not allowed" };
    await expect(privado().deployCompose(project(), src, () => undefined, {}, {}, null, false)).rejects.toThrow(
      /não conseguiu interpretar o compose do projeto: yaml: line 3/,
    );
    expect(sobe()).toBe(false);
  });
});

describe("regras duras não têm override do operador", () => {
  const DURO = JSON.stringify({
    name: "paas-loja",
    services: { web: { image: "nginx:1.27", labels: { "paas.project": "vitima" }, container_name: "tws-panel" } },
  });

  it("reserved-name: mesmo com override explícito, aborta antes do up", async () => {
    configResult = { code: 0, stdout: DURO, stderr: "" };
    await expect(privado().deployCompose(project(), src, () => undefined, {}, {}, null, true)).rejects.toThrow(/guardrail_blocked/);
    expect(sobe()).toBe(false);
  });

  it("panel-image: build que grava a tag da imagem auxiliar do painel", async () => {
    const e = new DeployEngine({
      projectsDir,
      caddyDir: path.join(projectsDir, "caddy"),
      nodeImage: "node:22",
      staticImage: "nginx:alpine",
      caddyHttpPort: 80,
      caddyHttpsPort: 443,
      protectedImages: ["alpine:3@sha256:abc"],
    }) as unknown as Privado;
    configResult = {
      code: 0,
      stdout: JSON.stringify({ name: "paas-loja", services: { web: { image: "alpine:3", build: { context: src } } } }),
      stderr: "",
    };
    await expect(e.deployCompose(project(), src, () => undefined, {}, {}, null, true)).rejects.toThrow(/guardrail_blocked/);
    expect(sobe()).toBe(false);
  });
});

describe("rede de e-mail (A4): só o painel liga, e só com e-mail habilitado", () => {
  const COM_MAIL = JSON.stringify({
    name: "paas-loja",
    services: { web: { image: "nginx:1.27", networks: { default: null, "paas-mail": null } } },
    networks: { default: { name: "paas-loja_default" }, "paas-mail": { name: "paas-mail", external: true } },
  });

  it("e-mail habilitado: o override liga o web à paas-mail e o compose resolvido passa", async () => {
    configResult = { code: 0, stdout: COM_MAIL, stderr: "" };
    await privado().deployCompose(project(), src, () => undefined, {}, { SMTP_HOST: "mail.loja.com" }, null, false);
    expect(sobe()).toBe(true);
    const override = await readFile(path.join(projectsDir, "loja", "paas.override.yml"), "utf8");
    expect(override).toContain("paas-mail");
  });

  it("SEM e-mail habilitado, um compose que se liga à paas-mail é barrado, mesmo com override do operador", async () => {
    configResult = { code: 0, stdout: COM_MAIL, stderr: "" };
    await expect(privado().deployCompose(project(), src, () => undefined, {}, {}, null, true)).rejects.toThrow(/guardrail_blocked/);
    expect(sobe()).toBe(false);
  });

  it("paas-panel e paas-mail-admin são barradas sempre", async () => {
    for (const rede of ["paas-panel", "paas-mail-admin"]) {
      configResult = {
        code: 0,
        stdout: JSON.stringify({
          name: "paas-loja",
          services: { web: { image: "nginx:1.27", networks: { [rede]: null } } },
          networks: { [rede]: { name: rede, external: true } },
        }),
        stderr: "",
      };
      await expect(privado().deployCompose(project(), src, () => undefined, {}, { SMTP_HOST: "x" }, null, true), rede).rejects.toThrow(/guardrail_blocked/);
    }
    expect(sobe()).toBe(false);
  });
});

describe("DeployEngine.recreate — o app pode ter mexido no compose desde o último deploy", () => {
  it("recreate também confere o compose resolvido e NÃO aceita override", async () => {
    configResult = { code: 0, stdout: HOSTIL, stderr: "" };
    await expect(engine().recreate(project(), () => undefined)).rejects.toThrow(/guardrail_blocked/);
    expect(sobe()).toBe(false);
  });

  it("recreate de compose limpo segue normalmente", async () => {
    configResult = { code: 0, stdout: LIMPO, stderr: "" };
    await engine().recreate(project(), () => undefined);
    expect(sobe()).toBe(true);
  });
});
