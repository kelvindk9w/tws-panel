/**
 * Fase de troca do deploy (DeployEngine.beginReplace): a espera curta pelos cabeçalhos do app no proxy só
 * começa quando os containers do app começam a ser parados ou recriados, não no build (que pode levar
 * minutos com o app antigo atendendo). Sem Docker: `run` e `runStream` são dublês.
 *
 *  - compose: o `up --build` constrói e só depois recria; a fase começa na primeira linha do compose sobre um
 *    container (Recreate, Stopping, Creating...), ainda com o up rodando; se a linha não vier, logo depois do up;
 *  - Dockerfile/Next.js sem a troca sem queda: logo antes de o container no ar ser removido/parado;
 *  - com a troca sem queda a versão atual segue atendendo: a fase não começa ali.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";

type Result = { code: number; stdout: string; stderr: string };
type OnData = (chunk: string) => void;
const calls: string[][] = [];
const ordem: string[] = [];
let upChunks: string[] = [];
let upCode = 0;
let configResult: Result = { code: 0, stdout: "{}", stderr: "" };
/** O que o teste quer conferir no meio do `up` (entre os pedaços da saída). */
let duranteUp: ((i: number) => void) | null = null;

vi.mock("../src/exec.js", () => ({
  run: vi.fn(async (_file: string, args: string[]): Promise<Result> => {
    calls.push(args);
    ordem.push(args.join(" "));
    if (args.includes("config")) return configResult;
    return { code: 0, stdout: "", stderr: "" };
  }),
  runStream: vi.fn(async (_file: string, args: string[], onData: OnData) => {
    calls.push(args);
    if (args.includes("up")) {
      for (let i = 0; i < upChunks.length; i++) {
        duranteUp?.(i);
        onData(upChunks[i]!);
        await new Promise((r) => setTimeout(r, 1));
      }
      ordem.push("fim do up");
      return upCode;
    }
    return 0;
  }),
}));

const { DeployEngine, COMPOSE_REPLACE_EVENT_RE } = await import("../src/engine.js");

let root: string;
let projectsDir: string;
let src: string;

beforeEach(async () => {
  calls.length = 0;
  ordem.length = 0;
  upChunks = [];
  upCode = 0;
  duranteUp = null;
  configResult = { code: 0, stdout: JSON.stringify({ name: "paas-loja", services: { web: { image: "nginx:1.27" } } }), stderr: "" };
  root = await mkdtemp(path.join(tmpdir(), "paas-engine-troca-"));
  projectsDir = path.join(root, "projects");
  src = path.join(projectsDir, "loja", "src");
  await mkdir(src, { recursive: true });
  await writeFile(path.join(src, "compose.yml"), "services:\n  web:\n    image: nginx:1.27\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function project(type: "compose" | "dockerfile" = "compose"): Project {
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

type Privado = InstanceType<typeof DeployEngine> & {
  withReplaceHook<T>(p: Project, hook: (() => Promise<void>) | undefined, job: () => Promise<T>): Promise<T>;
  deployCompose(p: Project, src: string, onLog: (c: string) => void, dotenv: Record<string, string>, extra: Record<string, string>, tz: string | null, override: boolean): Promise<string>;
  runDockerfileContainer(p: Project, image: string, onLog: (c: string) => void, env: Record<string, string>, tz: string | null, extra?: { swap?: unknown }): Promise<void>;
};

function engine(): Privado {
  const e = new DeployEngine({
    projectsDir,
    caddyDir: path.join(projectsDir, "caddy"),
    nodeImage: "node:22",
    staticImage: "nginx:alpine",
    caddyHttpPort: 80,
    caddyHttpsPort: 443,
  }) as unknown as Privado;
  e.setUpdating("p1", true);
  return e;
}

const BUILD = "#5 [web 2/3] RUN composer install\n#5 DONE 41.2s\n";

describe("compose: a fase de troca começa quando o compose começa a recriar, não no build", () => {
  it("na linha 'Container ... Recreate' (mesmo partida em dois pedaços), com o up ainda rodando; o build não conta", async () => {
    const e = engine();
    upChunks = [BUILD, " Container paas-loja-web-1  Running\n", " ✔ Container paas-loja-app-1  Recre", "ate\n", " Container paas-loja-app-1  Started\n"];
    const naFase: boolean[] = [];
    duranteUp = () => naFase.push(e.isReplacing("p1"));
    const hook = vi.fn(async () => {
      ordem.push("gancho");
    });
    await e.withReplaceHook(project(), hook, () => e.deployCompose(project(), src, () => undefined, {}, {}, null, false));
    // antes dos pedaços 0..3 (build, Running e a linha partida) a fase não tinha começado; no último, já
    expect(naFase).toEqual([false, false, false, false, true]);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(ordem.indexOf("gancho")).toBeLessThan(ordem.indexOf("fim do up"));
    expect(e.isReplacing("p1")).toBe(true);
  });

  it("sem nenhuma linha de container na saída (formato diferente): a fase começa logo depois do up", async () => {
    const e = engine();
    upChunks = [BUILD, "tudo pronto\n"];
    const hook = vi.fn(async () => {
      ordem.push("gancho");
    });
    await e.withReplaceHook(project(), hook, () => e.deployCompose(project(), src, () => undefined, {}, {}, null, false));
    expect(hook).toHaveBeenCalledTimes(1);
    expect(ordem.indexOf("gancho")).toBeGreaterThan(ordem.indexOf("fim do up"));
  });

  it("up que falha no build, sem mexer em container: a fase não começa", async () => {
    const e = engine();
    upChunks = [BUILD, "failed to solve: process did not complete successfully\n"];
    upCode = 1;
    const hook = vi.fn(async () => undefined);
    await expect(e.withReplaceHook(project(), hook, () => e.deployCompose(project(), src, () => undefined, {}, {}, null, false))).rejects.toThrow();
    expect(hook).not.toHaveBeenCalled();
    expect(e.isReplacing("p1")).toBe(false);
  });

  it("gancho que falha não derruba o deploy: só avisa no log", async () => {
    const e = engine();
    upChunks = [" Container paas-loja-app-1  Recreate\n"];
    let log = "";
    await e.withReplaceHook(
      project(),
      async () => {
        throw new Error("Caddy fora do ar");
      },
      () => e.deployCompose(project(), src, (c) => (log += c), {}, {}, null, false),
    );
    expect(log).toContain("não consegui ajustar o proxy para a troca dos containers (Caddy fora do ar); o deploy segue.");
  });

  it("sem o aviso 'Atualizando' ligado a fase não liga e o gancho não é chamado", async () => {
    const e = engine();
    e.setUpdating("p1", false);
    upChunks = [" Container paas-loja-app-1  Recreate\n"];
    const hook = vi.fn(async () => undefined);
    await e.withReplaceHook(project(), hook, () => e.deployCompose(project(), src, () => undefined, {}, {}, null, false));
    expect(hook).not.toHaveBeenCalled();
  });

  it("o gancho só vale durante o job: depois dele, outra troca não o chama", async () => {
    const e = engine();
    const hook = vi.fn(async () => undefined);
    await e.withReplaceHook(project(), hook, async () => undefined);
    upChunks = [" Container paas-loja-app-1  Recreate\n"];
    await e.deployCompose(project(), src, () => undefined, {}, {}, null, false);
    expect(hook).not.toHaveBeenCalled();
    expect(e.isReplacing("p1")).toBe(true);
  });
});

describe("linhas do compose que abrem a fase de troca", () => {
  it.each([
    " Container paas-loja-app-1  Recreate",
    "Container paas-loja-app-1 Recreated",
    " Container paas-loja-app-1  Stopping",
    " Container paas-loja-db-1  Removing",
    " ✔ Container paas-loja-app-1  Creating",
    "build ok\n Container paas-loja-app-1  Starting",
  ])("abre: %s", (linha) => {
    expect(COMPOSE_REPLACE_EVENT_RE.test(linha)).toBe(true);
  });

  it.each([
    " Container paas-loja-web-1  Running",
    "#7 [app 3/5] RUN echo Container x Recreate",
    "#8 exporting to image",
    " Network paas-loja_default  Creating",
    " Volume paas-loja_data  Creating",
  ])("não abre: %s", (linha) => {
    expect(COMPOSE_REPLACE_EVENT_RE.test(linha)).toBe(false);
  });
});

describe("um container (Dockerfile/Next.js): a fase começa logo antes de tirar do ar o container atual", () => {
  it("sem a troca sem queda: o gancho roda antes do `rm -f` do container no ar", async () => {
    const e = engine();
    const hook = vi.fn(async () => {
      ordem.push("gancho");
    });
    await e.withReplaceHook(project("dockerfile"), hook, () => e.runDockerfileContainer(project("dockerfile"), "paas-loja:latest", () => undefined, {}, null));
    expect(hook).toHaveBeenCalledTimes(1);
    const rm = ordem.findIndex((c) => c.startsWith("rm -f ") && c.endsWith("-app"));
    expect(rm).toBeGreaterThan(-1);
    expect(ordem.indexOf("gancho")).toBeLessThan(rm);
  });

  it("com a troca sem queda: a atual segue atendendo, a fase não começa ali", async () => {
    const e = engine();
    const hook = vi.fn(async () => undefined);
    const swap = { next: "paas-loja-app-next", alias: "loja--a", final: "paas-loja-app" };
    await e.withReplaceHook(project("dockerfile"), hook, () => e.runDockerfileContainer(project("dockerfile"), "paas-loja:latest", () => undefined, {}, null, { swap }));
    expect(hook).not.toHaveBeenCalled();
    expect(e.isReplacing("p1")).toBe(false);
  });
});
