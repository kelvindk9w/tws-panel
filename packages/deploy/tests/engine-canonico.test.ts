/**
 * DeployEngine (compose) — o `up` roda do JSON canônico que o painel conferiu e
 * gravou FORA do src (não relê o compose do repositório, que o app pode trocar
 * entre o `config` e o `up`), e o `.env` e o compose do projeto precisam ser
 * arquivos de verdade dentro do src (achados A1 e A2 da revisão do lote 5).
 * Sem Docker: `run` e `runStream` são dublês.
 */
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";

type Result = { code: number; stdout: string; stderr: string };
const calls: Array<{ args: string[] }> = [];
let configResult: Result = { code: 0, stdout: "{}", stderr: "" };
let aoConfigurar: (() => Promise<void>) | null = null;

vi.mock("../src/exec.js", () => ({
  run: vi.fn(async (_file: string, args: string[]): Promise<Result> => {
    calls.push({ args });
    if (args.includes("config")) {
      await aoConfigurar?.();
      return configResult;
    }
    return { code: 0, stdout: "", stderr: "" };
  }),
  runStream: vi.fn(async (_file: string, args: string[]) => {
    calls.push({ args });
    return 0;
  }),
}));

const { DeployEngine } = await import("../src/engine.js");

let root: string;
let projectsDir: string;
let src: string;
let workDir: string;

const LIMPO = JSON.stringify({ name: "paas-loja", services: { web: { image: "nginx:1.27" } } });
/** O que sobe: o conferido, mais NET_RAW fora e no-new-privileges em todo serviço. */
const ENDURECIDO = { name: "paas-loja", services: { web: { image: "nginx:1.27", cap_drop: ["NET_RAW"], security_opt: ["no-new-privileges:true"] } } };

beforeEach(async () => {
  calls.length = 0;
  aoConfigurar = null;
  configResult = { code: 0, stdout: LIMPO, stderr: "" };
  root = await mkdtemp(path.join(tmpdir(), "paas-engine-canonico-"));
  projectsDir = path.join(root, "projects");
  src = path.join(projectsDir, "loja", "src");
  workDir = path.join(projectsDir, "loja");
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
};
const deploy = () => (engine() as unknown as Privado).deployCompose(project(), src, () => undefined, {}, {}, null, false);

const sobe = () => calls.find((c) => c.args.includes("up"));
const valorDe = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!;
const arquivosF = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === "-f" ? [a] : []));

describe("o up roda do JSON canônico gravado fora do src (A1: corrida entre config e up)", () => {
  it("usa -f paas.canonical.json (fora do src), com -p e --project-directory, e não o compose do repositório", async () => {
    await deploy();
    const up = sobe()!;
    expect(arquivosF(up.args)).toEqual([path.join(workDir, "paas.canonical.json")]);
    expect(valorDe(up.args, "--project-directory")).toBe(src);
    expect(valorDe(up.args, "-p")).toBe("paas-loja");
    expect(arquivosF(up.args).some((f) => f.startsWith(src + path.sep))).toBe(false);
  });

  it("o arquivo tem exatamente o modelo que foi conferido, com permissão 0600", async () => {
    await deploy();
    const arquivo = path.join(workDir, "paas.canonical.json");
    expect(JSON.parse(await readFile(arquivo, "utf8"))).toEqual(ENDURECIDO);
    expect((await stat(arquivo)).mode & 0o777).toBe(0o600);
  });

  it("compose do repositório trocado DEPOIS do config não chega ao up (o arquivo do up é o conferido)", async () => {
    aoConfigurar = async () => {
      // o app (ou o clone) troca o compose logo depois da leitura do config
      await writeFile(path.join(src, "compose.yml"), "services:\n  web:\n    image: x\n    privileged: true\n");
    };
    await deploy();
    expect(arquivosF(sobe()!.args)).not.toContain(path.join(src, "compose.yml"));
    expect(JSON.parse(await readFile(path.join(workDir, "paas.canonical.json"), "utf8"))).toEqual(ENDURECIDO);
  });

  it("o up não lê o .env do src: --env-file é um arquivo do painel, fora do src", async () => {
    await deploy();
    const envFile = valorDe(sobe()!.args, "--env-file");
    expect(envFile.startsWith(src + path.sep)).toBe(false);
  });

  it("compose hostil: nem escreve o JSON canônico nem sobe", async () => {
    configResult = { code: 0, stdout: JSON.stringify({ name: "paas-loja", services: { web: { image: "a", privileged: true } } }), stderr: "" };
    await expect(deploy()).rejects.toThrow(/guardrail_blocked/);
    expect(sobe()).toBeUndefined();
    await expect(stat(path.join(workDir, "paas.canonical.json"))).rejects.toThrow();
  });
});

describe(".env e compose precisam ser arquivos de verdade dentro do src (A2)", () => {
  const nenhumDocker = () => expect(calls).toHaveLength(0);

  it(".env que é link simbólico para fora: barrado antes de qualquer docker", async () => {
    await writeFile(path.join(root, "segredo"), "X=1\n");
    await symlink(path.join(root, "segredo"), path.join(src, ".env"));
    await expect(deploy()).rejects.toThrow(/\.env/);
    nenhumDocker();
  });

  it(".env que é link simbólico mesmo para dentro do src também é barrado", async () => {
    await writeFile(path.join(src, "real.env"), "X=1\n");
    await symlink(path.join(src, "real.env"), path.join(src, ".env"));
    await expect(deploy()).rejects.toThrow(/\.env/);
    nenhumDocker();
  });

  it("arquivo compose que é link simbólico: barrado", async () => {
    await writeFile(path.join(root, "outro.yml"), "services: {}\n");
    await rm(path.join(src, "compose.yml"));
    await symlink(path.join(root, "outro.yml"), path.join(src, "compose.yml"));
    await expect(deploy()).rejects.toThrow(/compose\.yml/);
    nenhumDocker();
  });

  it("compose dentro de uma pasta que é link para fora: barrado", async () => {
    await mkdir(path.join(root, "fora"), { recursive: true });
    await writeFile(path.join(root, "fora", "compose.yml"), "services: {}\n");
    await rm(path.join(src, "compose.yml"));
    await symlink(path.join(root, "fora"), path.join(src, "sub"));
    const p = project();
    p.detection!.composeFile = "sub/compose.yml";
    await expect((engine() as unknown as Privado & { deployCompose: Privado["deployCompose"] }).deployCompose(p, src, () => undefined, {}, {}, null, false)).rejects.toThrow(/compose/);
    nenhumDocker();
  });

  it(".env comum e ausência de .env passam", async () => {
    await deploy();
    expect(sobe()).toBeDefined();
    calls.length = 0;
    await writeFile(path.join(src, ".env"), "X=1\n");
    await deploy();
    expect(sobe()).toBeDefined();
  });

  it("recreate (variáveis novas) faz a mesma checagem do .env", async () => {
    await writeFile(path.join(root, "segredo"), "X=1\n");
    await symlink(path.join(root, "segredo"), path.join(src, ".env"));
    await expect(engine().recreate(project(), () => undefined)).rejects.toThrow(/\.env/);
    nenhumDocker();
  });

  it("recreate também sobe do JSON canônico", async () => {
    await engine().recreate(project(), () => undefined);
    expect(arquivosF(sobe()!.args)).toEqual([path.join(workDir, "paas.canonical.json")]);
  });
});
