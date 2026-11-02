/**
 * DeployEngine.recoverInterruptedDeploy — no boot, depois de um deploy que a atualização do painel matou:
 * religa o `-app-previous` do Next.js quando o container do projeto não está de pé; os demais tipos
 * (Dockerfile, estático) já tiveram o container antigo removido, então só se constata que o site está fora.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";

type Result = { code: number; stdout: string; stderr: string };
const calls: string[][] = [];
let respond: (args: string[]) => Result;
const ok = (stdout = ""): Result => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "No such object"): Result => ({ code: 1, stdout: "", stderr });

vi.mock("../src/exec.js", () => ({
  run: vi.fn(async (_file: string, args: string[]) => {
    calls.push(args);
    return respond(args);
  }),
  runStream: vi.fn(async () => 0),
}));

const { DeployEngine } = await import("../src/engine.js");

const engine = new DeployEngine({
  projectsDir: "/nonexistent/projects",
  caddyDir: "/nonexistent/caddy",
  nodeImage: "node:22",
  staticImage: "nginx:alpine",
  caddyHttpPort: 80,
  caddyHttpsPort: 443,
});

const proj = (type: string | null, over: Partial<Project> = {}): Project =>
  ({
    id: "loja",
    slug: "loja",
    name: "Loja",
    domain: "loja.example.com",
    detection: type ? { type } : null,
    ...over,
  }) as unknown as Project;

/** Estado do Docker: quais containers existem e quais rodam. */
function docker(state: { running?: string[]; exist?: string[]; port?: string; stoppedAt?: string }) {
  return (args: string[]): Result => {
    if (args[0] === "inspect" && args[2] === "{{.State.FinishedAt}}") return state.exist?.includes(args[3]!) ? ok(`${state.stoppedAt ?? "2026-11-02T10:05:00.000Z"}\n`) : fail();
    if (args[0] === "inspect" && args[2] === "{{.State.Running}}") return state.running?.includes(args[3]!) ? ok("true\n") : ok("false\n");
    if (args[0] === "inspect" && args[2] === "{{.Id}}") return state.exist?.includes(args[3]!) ? ok("abc\n") : fail();
    if (args[0] === "inspect") return ok(state.port ? `PORT=${state.port}\n` : "");
    return ok();
  };
}

const JOB_START = "2026-11-02T10:00:00.000Z";

beforeEach(() => {
  calls.length = 0;
});

describe("recoverInterruptedDeploy", () => {
  it("Next.js: app não roda e o anterior está guardado — renomeia de volta, inicia e devolve a porta da versão antiga", async () => {
    respond = docker({ exist: ["paas-loja-app-previous"], port: "3100" });
    const logs: string[] = [];
    const r = await engine.recoverInterruptedDeploy(proj("node-server"), (c) => logs.push(c), JOB_START);
    expect(r).toEqual({ outcome: "restored", port: 3100 });
    expect(calls).toContainEqual(["rename", "paas-loja-app-previous", "paas-loja-app"]);
    expect(calls).toContainEqual(["start", "paas-loja-app"]);
    expect(logs.join("")).toContain("religando-o");
  });

  it("app já está rodando: não mexe em nada", async () => {
    respond = docker({ running: ["paas-loja-app"], exist: ["paas-loja-app-previous"] });
    expect(await engine.recoverInterruptedDeploy(proj("node-server"), () => undefined)).toEqual({ outcome: "running" });
    expect(calls.some((a) => a[0] === "rename" || a[0] === "start" || a[0] === "rm")).toBe(false);
  });

  it("Dockerfile: o antigo já foi removido — não há o que religar, o site está fora", async () => {
    respond = docker({});
    expect(await engine.recoverInterruptedDeploy(proj("dockerfile"), () => undefined)).toEqual({ outcome: "down" });
    expect(calls.some((a) => a[0] === "rename" || a[0] === "start")).toBe(false);
  });

  it("estático confere o container -web", async () => {
    respond = docker({ running: ["paas-loja-web"] });
    expect(await engine.recoverInterruptedDeploy(proj("static"), () => undefined)).toEqual({ outcome: "running" });
    respond = docker({ exist: ["paas-loja-app-previous"] });
    // estático nunca tem anterior: mesmo que haja um nome parecido, não religa
    expect(await engine.recoverInterruptedDeploy(proj("static"), () => undefined)).toEqual({ outcome: "down" });
    expect(calls.some((a) => a[0] === "rename")).toBe(false);
  });

  it("static-node também é servido por -web: rodando = ok, parado = fora (nunca confere -app)", async () => {
    respond = docker({ running: ["paas-loja-web"] });
    expect(await engine.recoverInterruptedDeploy(proj("static-node"), () => undefined, JOB_START)).toEqual({ outcome: "running" });
    expect(calls.some((a) => a.includes("paas-loja-app"))).toBe(false);
    respond = docker({ running: ["paas-loja-app"] });
    expect(await engine.recoverInterruptedDeploy(proj("static-node"), () => undefined, JOB_START)).toEqual({ outcome: "down" });
  });

  it("-app-previous velho (parado antes do job começar) ou job sem início: não é religado, só relatado", async () => {
    respond = docker({ exist: ["paas-loja-app-previous"], stoppedAt: "2026-10-01T00:00:00.000Z" });
    const logs: string[] = [];
    expect(await engine.recoverInterruptedDeploy(proj("node-server"), (c) => logs.push(c), JOB_START)).toEqual({ outcome: "down" });
    expect(logs.join("")).toContain("não é deste deploy");
    expect(calls.some((a) => a[0] === "rename" || a[0] === "start" || a[0] === "rm")).toBe(false);
    respond = docker({ exist: ["paas-loja-app-previous"] });
    expect(await engine.recoverInterruptedDeploy(proj("node-server"), () => undefined, null)).toEqual({ outcome: "down" });
    expect(calls.some((a) => a[0] === "rename")).toBe(false);
  });

  it("religar falha (renomear dá erro): site fora", async () => {
    respond = (a) => (a[0] === "rename" ? fail("conflict") : docker({ exist: ["paas-loja-app-previous"] })(a));
    expect(await engine.recoverInterruptedDeploy(proj("node-server"), () => undefined, JOB_START)).toEqual({ outcome: "down" });
  });

  it("compose, projeto parado de propósito e sem detecção são ignorados", async () => {
    respond = docker({});
    expect(await engine.recoverInterruptedDeploy(proj("compose"), () => undefined)).toEqual({ outcome: "skipped" });
    expect(await engine.recoverInterruptedDeploy(proj("node-server", { stoppedAt: "2026-11-01T00:00:00.000Z" }), () => undefined)).toEqual({ outcome: "skipped" });
    expect(await engine.recoverInterruptedDeploy(proj(null), () => undefined)).toEqual({ outcome: "skipped" });
    expect(calls).toHaveLength(0);
  });
});
