/**
 * Endurecimento de TODO container que o painel cria (A4: override do painel e
 * M9: identidade): NET_RAW removida (sem forjar ARP/DNS na rede do proxy),
 * no-new-privileges, e a label do compose gravada VAZIA nos containers de
 * `docker run` para a label herdada da imagem não valer. Sem Docker.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";

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
const { hardenComposeModel } = await import("../src/compose-override.js");

let root: string;
let projectsDir: string;
let src: string;

beforeEach(async () => {
  calls.length = 0;
  root = await mkdtemp(path.join(tmpdir(), "paas-engine-endurece-"));
  projectsDir = path.join(root, "projects");
  src = path.join(projectsDir, "loja", "src");
  await mkdir(src, { recursive: true });
  await writeFile(path.join(src, "compose.yml"), "services:\n  web:\n    image: nginx:1.27\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function project(type: "compose" | "dockerfile" | "static" = "compose"): Project {
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
      type,
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

const engine = () =>
  new DeployEngine({
    projectsDir,
    caddyDir: path.join(projectsDir, "caddy"),
    nodeImage: "node:22",
    staticImage: "nginx:alpine",
    caddyHttpPort: 80,
    caddyHttpsPort: 443,
  });

/** Pares "--flag valor" de uma linha de comando. */
const pares = (args: string[], flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]!] : []));

describe("hardenComposeModel: todos os serviços, inclusive os de include/extends", () => {
  it("acrescenta NET_RAW em cap_drop e no-new-privileges em security_opt, sem perder o que o projeto já tinha", () => {
    const model = {
      services: {
        web: { image: "a" },
        db: { image: "b", cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"] },
        worker: { image: "c", cap_drop: ["NET_RAW"], security_opt: ["seccomp=unconfined"] },
      },
    };
    const out = hardenComposeModel(model) as { services: Record<string, { cap_drop: string[]; security_opt: string[] }> };
    expect(out.services.web).toMatchObject({ cap_drop: ["NET_RAW"], security_opt: ["no-new-privileges:true"] });
    expect(out.services.db!.cap_drop).toEqual(["ALL", "NET_RAW"]);
    expect(out.services.db!.security_opt).toEqual(["no-new-privileges:true"]);
    expect(out.services.worker!.cap_drop).toEqual(["NET_RAW"]);
  });

  it("não altera o modelo recebido e aceita modelo sem serviços", () => {
    const model = { services: { web: { image: "a" } } };
    hardenComposeModel(model);
    expect(model).toEqual({ services: { web: { image: "a" } } });
    expect(hardenComposeModel({})).toEqual({});
    expect(hardenComposeModel(null)).toBeNull();
  });
});

describe("compose: o JSON que sobe tem NET_RAW fora e no-new-privileges em TODOS os serviços", () => {
  it("serviços do compose, e também os que só existem no modelo resolvido (include)", async () => {
    configResult = {
      code: 0,
      stdout: JSON.stringify({ name: "paas-loja", services: { web: { image: "nginx:1.27" }, incluido: { image: "redis:7" } } }),
      stderr: "",
    };
    await (engine() as unknown as { deployCompose: (...a: unknown[]) => Promise<string> }).deployCompose(project(), src, () => undefined, {}, {}, null, false);
    const gravado = JSON.parse(await readFile(path.join(projectsDir, "loja", "paas.canonical.json"), "utf8")) as {
      services: Record<string, { cap_drop?: string[]; security_opt?: string[] }>;
    };
    for (const nome of ["web", "incluido"]) {
      expect(gravado.services[nome]!.cap_drop, nome).toContain("NET_RAW");
      expect(gravado.services[nome]!.security_opt, nome).toContain("no-new-privileges:true");
    }
  });
});

describe("docker run do painel (estático e Dockerfile)", () => {
  it("site estático: sem NET_RAW, no-new-privileges e label do compose vazia", async () => {
    await (engine() as unknown as { serveStaticDir: (...a: unknown[]) => Promise<string> }).serveStaticDir(project("static"), path.join(root, "site"), "site", () => undefined);
    const executa = calls.find((a) => a[0] === "run")!;
    expect(pares(executa, "--cap-drop")).toContain("NET_RAW");
    expect(pares(executa, "--security-opt")).toContain("no-new-privileges");
    expect(pares(executa, "--label")).toContain("com.docker.compose.project=");
  });

  it("Dockerfile: sem NET_RAW, no-new-privileges e label do compose vazia (imagem com LABEL forjada não vale)", async () => {
    await (engine() as unknown as { runDockerfileContainer: (...a: unknown[]) => Promise<void> }).runDockerfileContainer(project("dockerfile"), "paas-loja:latest", () => undefined, {}, null);
    const executa = calls.find((a) => a[0] === "run")!;
    expect(pares(executa, "--cap-drop")).toContain("NET_RAW");
    expect(pares(executa, "--security-opt")).toContain("no-new-privileges");
    expect(pares(executa, "--label")).toContain("com.docker.compose.project=");
    // a vazia vem DEPOIS de qualquer outra e antes da imagem: nada a sobrepõe
    expect(executa[executa.length - 1]).toBe("paas-loja:latest");
  });
});
