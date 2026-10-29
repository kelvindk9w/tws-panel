/**
 * DeployEngine.deploy — o override vale só para os bloqueios que a pessoa viu e aceitou. A checagem depois da
 * ingestão (o código pode ter mudado desde a tela) recusa qualquer bloqueio fora da lista aceita
 * (guardrail_changed), com os novos no erro e no log. Sem Docker: `run`/`runStream` são dublês.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guardrailBlockKey, type Project } from "@paas/core";

vi.mock("../src/exec.js", () => ({
  run: vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "" })),
  runStream: vi.fn(async () => 0),
}));

const { DeployEngine } = await import("../src/engine.js");
const { runGuardrails } = await import("../src/rules.js");

let root: string;
let src: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paas-engine-override-"));
  src = path.join(root, "projects", "loja");
  await mkdir(src, { recursive: true });
  await writeFile(path.join(src, "compose.yml"), "services:\n  web:\n    image: nginx:1.27\n    privileged: true\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function project(): Project {
  return {
    id: "p1",
    name: "Loja",
    slug: "loja",
    ingestMode: "existing",
    source: src,
    branch: null,
    domain: "loja.localhost",
    websocket: false,
    detection: { type: "dockerfile", composeFile: null, outputDir: null, packageManager: null, buildCommand: null, proxyService: null, proxyPort: null, warnings: [], details: [] },
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

const engine = () =>
  new DeployEngine({ projectsDir: path.join(root, "projects"), caddyDir: path.join(root, "caddy"), nodeImage: "node:22", staticImage: "nginx:alpine", caddyHttpPort: 80, caddyHttpsPort: 443 });

describe("DeployEngine.deploy — override preso aos bloqueios aceitos", () => {
  it("bloqueio fora da lista: aborta nos guardrails, lista os novos no erro e no log", async () => {
    let log = "";
    await expect(engine().deploy(project(), [], (c) => (log += c), { guardrailOverride: true, acceptedBlocks: ["antigo|db|outra coisa"] })).rejects.toThrow(
      /guardrail_changed.*Novos: \[/,
    );
    expect(log).toContain("que você não aceitou");
    expect(log).not.toContain("Override explícito do operador");
  });

  it("lista que cobre os bloqueios: o override segue além dos guardrails", async () => {
    const report = await runGuardrails(src, null, undefined, undefined, {});
    const accepted = report.findings.filter((f) => f.level === "block").map(guardrailBlockKey);
    expect(accepted.length).toBeGreaterThan(0);
    let log = "";
    await engine()
      .deploy(project(), [], (c) => (log += c), { guardrailOverride: true, acceptedBlocks: accepted })
      .catch(() => undefined);
    expect(log).toContain("Override explícito do operador");
    expect(log).not.toContain("que você não aceitou");
  });

  it("sem lista (uso interno sem a prova da tela) o comportamento é o de antes: override vale", async () => {
    let log = "";
    await engine()
      .deploy(project(), [], (c) => (log += c), { guardrailOverride: true })
      .catch(() => undefined);
    expect(log).toContain("Override explícito do operador");
  });
});
