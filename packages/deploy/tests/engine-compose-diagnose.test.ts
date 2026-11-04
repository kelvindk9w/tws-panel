/**
 * DeployEngine.deploy (compose) — quando o `docker compose up` falha, o log
 * do deploy ganha o "por que falhou" de cada serviço e a mensagem final diz
 * qual serviço falhou. Estrutura do caso real (vitrine): db e redis com
 * healthcheck, ledger construído do repositório com healthcheck no
 * Dockerfile, web dependendo do ledger saudável e caddy na rede do ledger.
 *
 * Sem Docker: `run` e `runStream` são dublês.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuardrailReport, Project } from "@paas/core";

type Result = { code: number; stdout: string; stderr: string };
const calls: string[][] = [];
let psOutput = "";

vi.mock("../src/exec.js", () => ({
  run: vi.fn(async (_file: string, args: string[]): Promise<Result> => {
    calls.push(args);
    // docker compose config (guardrails sobre o compose resolvido): modelo inofensivo
    if (args.includes("config")) return { code: 0, stdout: JSON.stringify({ name: "paas-loja", services: { ledger: { image: "app" } } }), stderr: "" };
    if (args.includes("ps")) return { code: 0, stdout: psOutput, stderr: "" };
    if (args.includes("logs")) return { code: 0, stdout: "ledger-1  | erro ao migrar o banco\n", stderr: "" };
    if (args[0] === "inspect" && args.includes("{{json .State.Health}}")) {
      return {
        code: 0,
        stdout: JSON.stringify({ Log: [{ ExitCode: 1, Output: "curl: (7) Failed to connect" }] }),
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  }),
  runStream: vi.fn(async (_file: string, args: string[], onData: (c: string) => void) => {
    calls.push(args);
    onData("dependency failed to start: container paas-loja-ledger-1 is unhealthy\n");
    return 1;
  }),
}));

const { DeployEngine } = await import("../src/engine.js");

const COMPOSE = `services:
  db:
    image: postgres:18-alpine
    healthcheck:
      test: ["CMD-SHELL", "pg_isready"]
  ledger:
    build: .
    ports: ["80:80", "443:443"]
    env_file: [.env]
  web:
    build: .
    network_mode: service:ledger
    depends_on:
      ledger:
        condition: service_healthy
  caddy:
    image: caddy:2-alpine
    network_mode: service:ledger
`;

let projectsDir: string;
let srcDir: string;

beforeEach(async () => {
  calls.length = 0;
  projectsDir = await mkdtemp(path.join(tmpdir(), "paas-engine-diagnose-"));
  srcDir = path.join(projectsDir, "src");
  await mkdir(srcDir, { recursive: true });
  await writeFile(path.join(srcDir, "compose.yaml"), COMPOSE);
});

afterEach(async () => {
  await rm(projectsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const clean: GuardrailReport = { ranAt: "", dir: "", findings: [], blockers: 0, warnings: 0, infos: 0 };

function project(): Project {
  return {
    id: "p1",
    name: "Loja",
    slug: "loja",
    ingestMode: "existing",
    source: srcDir,
    branch: null,
    domain: "loja.localhost",
    websocket: false,
    detection: {
      type: "compose",
      composeFile: "compose.yaml",
      outputDir: null,
      packageManager: null,
      buildCommand: null,
      proxyService: "ledger",
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

describe("DeployEngine.deploy — compose up com erro", () => {
  it("anexa o diagnóstico do serviço unhealthy e a mensagem final diz qual serviço falhou", async () => {
    psOutput = [
      { Service: "db", Name: "paas-loja-db-1", State: "running", Health: "healthy", ExitCode: 0 },
      { Service: "ledger", Name: "paas-loja-ledger-1", State: "running", Health: "unhealthy", ExitCode: 0 },
      { Service: "web", Name: "paas-loja-web-1", State: "created", Health: "", ExitCode: 0 },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n");
    let log = "";
    const p = project();
    await expect(engine().deploy(p, [p], (c) => (log += c), { precomputedGuardrailReport: clean })).rejects.toThrow(
      "docker compose up falhou: o serviço ledger não ficou saudável — veja o log dele acima.",
    );
    expect(log).toContain("=== Por que falhou: serviço ledger ===");
    expect(log).toContain("erro ao migrar o banco");
    expect(log).toContain("Failed to connect");
    expect(log).toContain("caddy: não foi criado");

    // mesmos -p / --project-directory / -f do up
    const up = calls.find((a) => a.includes("up"))!;
    const ps = calls.find((a) => a.includes("ps"))!;
    expect(ps.slice(0, up.indexOf("up"))).toEqual(up.slice(0, up.indexOf("up")));
  });

  it("sem culpado no ps, mantém a mensagem com o código de saída", async () => {
    psOutput = ["db", "ledger", "web", "caddy"]
      .map((s) => JSON.stringify({ Service: s, Name: s, State: "running", Health: "" }))
      .join("\n");
    const p = project();
    await expect(engine().deploy(p, [p], () => undefined, { precomputedGuardrailReport: clean })).rejects.toThrow(
      "docker compose up falhou (exit 1).",
    );
  });
});
