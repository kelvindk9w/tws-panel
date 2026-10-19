/**
 * DeployEngine (compose) — o `config` roda com --no-env-resolution e o `up`
 * sai de um JSON gravado fora do src. Por isso o ambiente que resolve
 * `environment: [VAR]` (só o nome), `${VAR}` em env_file e as Variáveis do
 * painel precisa chegar ao compose por um --env-file que o PAINEL monta:
 * cópia do `.env` já conferido (arquivo comum em src, lido sem seguir link) mais
 * o `paas.env`. O compose nunca lê `src/.env` por conta própria (A2).
 * Sem Docker: `run` e `runStream` são dublês.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";

type Result = { code: number; stdout: string; stderr: string };
const calls: string[][] = [];
const LIMPO = JSON.stringify({ name: "paas-loja", services: { web: { image: "nginx:1.27", environment: { DATABASE_URL: null } } } });

vi.mock("../src/exec.js", () => ({
  run: vi.fn(async (_file: string, args: string[]): Promise<Result> => {
    calls.push(args);
    if (args.includes("config")) return { code: 0, stdout: LIMPO, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }),
  runStream: vi.fn(async (_file: string, args: string[]) => {
    calls.push(args);
    return 0;
  }),
}));

const { DeployEngine } = await import("../src/engine.js");

let root: string;
let projectsDir: string;
let src: string;
let workDir: string;

beforeEach(async () => {
  calls.length = 0;
  root = await mkdtemp(path.join(tmpdir(), "paas-engine-variaveis-"));
  projectsDir = path.join(root, "projects");
  workDir = path.join(projectsDir, "loja");
  src = path.join(workDir, "src");
  await mkdir(src, { recursive: true });
  await writeFile(path.join(src, "compose.yml"), "services:\n  web:\n    image: nginx:1.27\n    environment: [DATABASE_URL]\n");
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

const engine = () =>
  new DeployEngine({ projectsDir, caddyDir: path.join(projectsDir, "caddy"), nodeImage: "node:22", staticImage: "nginx:alpine", caddyHttpPort: 80, caddyHttpsPort: 443 });
type Privado = { deployCompose(...a: unknown[]): Promise<string> };
const deploy = (dotenv: Record<string, string> = {}) =>
  (engine() as unknown as Privado).deployCompose(project(), src, () => undefined, dotenv, {}, null, false);

const envFileDe = (args: string[]) => args[args.indexOf("--env-file") + 1]!;
const config = () => calls.find((c) => c.includes("config"))!;
const sobe = () => calls.find((c) => c.includes("up"))!;

describe("o ambiente do compose é montado pelo painel e é o mesmo no config e no up", () => {
  it("Variáveis do painel (sem .env versionado): o env-file tem as variáveis e fica fora do src", async () => {
    await deploy({ DATABASE_URL: "postgres://painel", OUTRA: "x" });
    const arquivo = envFileDe(sobe());
    expect(envFileDe(config())).toBe(arquivo);
    expect(arquivo.startsWith(src + path.sep)).toBe(false);
    const texto = await readFile(arquivo, "utf8");
    expect(texto).toContain("DATABASE_URL='postgres://painel'");
    expect(texto).toContain("OUTRA='x'");
    expect((await stat(arquivo)).mode & 0o777).toBe(0o600);
  });

  it(".env do projeto (comum, em src) entra no env-file: variável só com o nome e ${VAR} de env_file resolvem", async () => {
    await writeFile(path.join(src, ".env"), "DATABASE_URL=postgres://do-repo\nSEGREDO_DO_ENV_FILE=abc\n");
    await deploy();
    const texto = await readFile(envFileDe(sobe()), "utf8");
    expect(texto).toContain("DATABASE_URL=postgres://do-repo");
    expect(texto).toContain("SEGREDO_DO_ENV_FILE=abc");
  });

  it(".env versionado + Variáveis do painel: as duas fontes entram e a do painel vem por último (vence)", async () => {
    await writeFile(path.join(src, ".env"), "DATABASE_URL=postgres://do-repo\nSO_NO_REPO=1\n");
    execFileSync("git", ["init", "-q"], { cwd: src });
    execFileSync("git", ["add", ".env"], { cwd: src });
    await deploy({ DATABASE_URL: "postgres://painel" });
    const texto = await readFile(envFileDe(sobe()), "utf8");
    expect(texto).toContain("SO_NO_REPO=1");
    expect(texto.indexOf("postgres://do-repo")).toBeGreaterThanOrEqual(0);
    expect(texto.lastIndexOf("DATABASE_URL")).toBeGreaterThan(texto.indexOf("postgres://do-repo"));
    expect(texto.slice(texto.lastIndexOf("DATABASE_URL"))).toContain("postgres://painel");
  });

  it("o log diz ONDE as variáveis foram gravadas: no .env do projeto, ou no paas.env quando o .env é do dono", async () => {
    const run = async () => {
      const log: string[] = [];
      await (engine() as unknown as Privado).deployCompose(project(), src, (c: string) => log.push(c), { A: "1" }, {}, null, false);
      return log.join("");
    };
    expect(await run()).toMatch(/Variáveis gravadas no \.env do projeto \(A\)/);
    await rm(path.join(src, ".env"), { force: true });
    await writeFile(path.join(src, ".env"), "DO_DONO=1\n");
    const separado = await run();
    expect(separado).toMatch(/gravadas em .*paas\.env.*--env-file.*NÃO foi alterado/);
    expect(separado).not.toMatch(/gravadas no \.env do projeto/);
  });

  it("sem .env nem variáveis: o env-file existe e é do painel (o compose não procura src/.env sozinho)", async () => {
    await deploy();
    const arquivo = envFileDe(sobe());
    expect(arquivo.startsWith(src + path.sep)).toBe(false);
    expect(await readFile(arquivo, "utf8")).toBe("");
  });

  it(".env que vira link depois da conferência não é lido (o env-file não leva o conteúdo do alvo)", async () => {
    await writeFile(path.join(root, "segredo-do-painel"), "SESSION_SECRET=nao-pode-vazar\n");
    await symlink(path.join(root, "segredo-do-painel"), path.join(src, ".env"));
    await expect(deploy()).rejects.toThrow(/\.env/);
    expect(calls).toHaveLength(0);
  });

  it("recreate usa o mesmo env-file do painel", async () => {
    await writeFile(path.join(src, ".env"), "DATABASE_URL=postgres://do-repo\n");
    await engine().recreate(project(), () => undefined);
    const arquivo = envFileDe(sobe());
    expect(envFileDe(config())).toBe(arquivo);
    expect(await readFile(arquivo, "utf8")).toContain("postgres://do-repo");
  });
});
