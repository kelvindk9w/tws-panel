/**
 * Pipeline node-server (Next.js com servidor) no engine, com dublês de
 * `run`/`runStream`: nenhum Docker real. Confere o que o painel manda ao
 * Docker (argumentos), o que NÃO manda (segredos, portas no host, montagens),
 * a explicação das falhas e a recriação do container.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";

type Result = { code: number; stdout: string; stderr: string };
interface Call {
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv | undefined;
}
const calls: Call[] = [];
let buildOutput = "";
let buildCode = 0;
let imageExists = true;

const defaultRun = async (file: string, args: string[]): Promise<Result> => {
  calls.push({ file, args });
  if (args[0] === "image" && args[1] === "inspect") return { code: imageExists ? 0 : 1, stdout: "", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};

vi.mock("../src/exec.js", () => ({
  run: vi.fn(async (file: string, args: string[]): Promise<Result> => defaultRun(file, args)),
  runStream: vi.fn(async (file: string, args: string[], onData: (c: string) => void, opts?: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ file, args, env: opts?.env });
    if (buildOutput) onData(buildOutput);
    return buildCode;
  }),
}));

const { DeployEngine, nodeServerPort } = await import("../src/engine.js");

let root: string;
let projectsDir: string;
let src: string;
let workDir: string;
const GB = 1024 ** 3;

beforeEach(async () => {
  const exec = await import("../src/exec.js");
  vi.mocked(exec.run).mockImplementation(async (file: string, args: string[]) => defaultRun(file, args));
  calls.length = 0;
  buildOutput = "";
  buildCode = 0;
  imageExists = true;
  root = await mkdtemp(path.join(tmpdir(), "paas-node-server-"));
  projectsDir = path.join(root, "projects");
  workDir = path.join(projectsDir, "loja");
  src = path.join(workDir, "src");
  await mkdir(src, { recursive: true });
  await writeFile(
    path.join(src, "package.json"),
    JSON.stringify({ scripts: { build: "next build" }, dependencies: { next: "^15.1.0" }, packageManager: "pnpm@10.0.0" }),
  );
  await writeFile(path.join(src, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(path.join(src, "next.config.mjs"), "export default { output: 'standalone' };\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function project(over: Partial<Project> = {}): Project {
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
      type: "node-server",
      composeFile: null,
      outputDir: null,
      packageManager: "pnpm",
      buildCommand: "pnpm build",
      proxyService: null,
      proxyPort: 3000,
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
  };
}

function engine(totalMem = 4 * GB) {
  return new DeployEngine({
    projectsDir,
    caddyDir: path.join(projectsDir, "caddy"),
    nodeImage: "node:22",
    staticImage: "nginx:alpine",
    caddyHttpPort: 80,
    caddyHttpsPort: 443,
    totalMemBytes: () => totalMem,
  });
}

type Internals = {
  deployNodeServer(p: Project, src: string, onLog: (c: string) => void, env: Record<string, string>, tz: string | null): Promise<string>;
  upstreamFor(p: Project): string;
};
const deploy = (p: Project, env: Record<string, string> = {}, tz: string | null = null, totalMem = 4 * GB) => {
  const logs: string[] = [];
  const result = (engine(totalMem) as unknown as Internals).deployNodeServer(p, src, (c) => logs.push(c), env, tz);
  return { result, logs };
};

const buildCall = () => calls.find((c) => c.args[0] === "build");
const runCall = () => calls.find((c) => c.args[0] === "run");
const allArgs = () => calls.flatMap((c) => c.args);

describe("deployNodeServer — caminho feliz", () => {
  it("constrói com o Dockerfile gerado FORA do src e sobe o container; devolve slug:3000", async () => {
    const { result, logs } = deploy(project());
    await expect(result).resolves.toBe("loja:3000");

    const build = buildCall()!;
    expect(build.file).toBe("docker");
    const dockerfile = build.args[build.args.indexOf("-f") + 1]!;
    expect(dockerfile).toBe(path.join(workDir, "paas.next.Dockerfile"));
    expect(dockerfile.startsWith(src + path.sep)).toBe(false);
    expect(build.args.at(-1)).toBe(src);
    expect(build.args).toContain("paas-loja:latest");
    expect(build.env?.DOCKER_BUILDKIT).toBe("1");
    // nada gravado no repositório do usuário
    expect(existsSync(path.join(src, "Dockerfile"))).toBe(false);
    expect(existsSync(path.join(src, "paas.next.Dockerfile"))).toBe(false);
    const text = await readFile(dockerfile, "utf8");
    expect(text).toContain("pnpm install --frozen-lockfile");
    expect(text).toContain('CMD ["node","server.js"]');
    expect(logs.join("")).toContain("Dockerfile gerado fora do seu repositório");
    expect(logs.join("")).toContain("standalone (node server.js)");
  });

  it("container: rede paas-net com alias, PORT/HOSTNAME/NODE_ENV do painel, --init, sem capabilities, sem portas nem montagens do host", async () => {
    await deploy(project()).result;
    const r = runCall()!.args;
    expect(r.slice(0, 5)).toEqual(["run", "-d", "--name", "paas-loja-app", "--restart"]);
    expect(r).toContain("unless-stopped");
    expect(r[r.indexOf("--network") + 1]).toBe("paas-net");
    expect(r[r.indexOf("--network-alias") + 1]).toBe("loja");
    expect(r).toContain("PORT=3000");
    expect(r).toContain("HOSTNAME=0.0.0.0");
    expect(r).toContain("NODE_ENV=production");
    expect(r).toContain("--init");
    expect(r.join(" ")).toContain("--cap-drop ALL");
    expect(r.join(" ")).toContain("--security-opt no-new-privileges");
    for (const proibido of ["-p", "--publish", "-P", "-v", "--volume", "--mount", "--privileged", "--pid", "--userns", "--cap-add"]) {
      expect(r, proibido).not.toContain(proibido);
    }
    expect(r.at(-1)).toBe("paas-loja:latest");
    // não força root
    expect(r).not.toContain("--user");
  });

  it("a ordem é: remover o container antigo SÓ depois do build (o site antigo segue no ar durante o build)", async () => {
    await deploy(project()).result;
    const i = calls.findIndex((c) => c.args[0] === "build");
    const rm = calls.findIndex((c) => c.args[0] === "rm");
    const run = calls.findIndex((c) => c.args[0] === "run");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(rm).toBeGreaterThan(i);
    expect(run).toBeGreaterThan(rm);
  });

  it("a poda NÃO roda aqui: a imagem anterior ainda pertence ao container parado, que pode ser religado", async () => {
    await deploy(project()).result;
    expect(calls.some((c) => c.args[0] === "builder" || (c.args[0] === "image" && c.args[1] === "prune"))).toBe(false);
  });

  it("o container antigo é parado e renomeado (não removido) antes do novo subir", async () => {
    const { logs, result } = deploy(project());
    await result;
    const i = (pred: (a: string[]) => boolean) => calls.findIndex((c) => pred(c.args));
    const rmPrev = i((a) => a[0] === "rm" && a.includes("paas-loja-app-previous"));
    const rename = i((a) => a[0] === "rename" && a[1] === "paas-loja-app" && a[2] === "paas-loja-app-previous");
    const stop = i((a) => a[0] === "stop" && a[1] === "paas-loja-app-previous");
    const run = i((a) => a[0] === "run");
    expect(rmPrev).toBeGreaterThanOrEqual(0);
    expect(rename).toBeGreaterThan(rmPrev);
    expect(stop).toBeGreaterThan(rename);
    expect(run).toBeGreaterThan(stop);
    expect(calls.some((c) => c.args[0] === "rm" && c.args.includes("paas-loja-app") && !c.args.includes("paas-loja-app-previous"))).toBe(false);
    expect(logs.join("")).toContain("Container anterior parado e guardado");
  });

  it("primeiro deploy (não há container para renomear): segue sem aviso de container anterior", async () => {
    const exec = await import("../src/exec.js");
    vi.mocked(exec.run).mockImplementation(async (_f: string, args: string[]) => {
      calls.push({ file: "docker", args });
      return args[0] === "rename" ? { code: 1, stdout: "", stderr: "no such container" } : { code: 0, stdout: "", stderr: "" };
    });
    const { logs, result } = deploy(project());
    await expect(result).resolves.toBe("loja:3000");
    expect(logs.join("")).not.toContain("Container anterior parado");
    expect(calls.some((c) => c.args[0] === "stop")).toBe(false);
  });

  it("docker run falha: o antigo é religado (rollback) e o erro continua", async () => {
    const exec = await import("../src/exec.js");
    vi.mocked(exec.run).mockImplementation(async (_f: string, args: string[]) => {
      calls.push({ file: "docker", args });
      return args[0] === "run" ? { code: 125, stdout: "", stderr: "boom" } : { code: 0, stdout: "", stderr: "" };
    });
    const { logs, result } = deploy(project());
    await expect(result).rejects.toThrow(/falha ao subir o container/);
    expect(calls.some((c) => c.args[0] === "rename" && c.args[1] === "paas-loja-app-previous" && c.args[2] === "paas-loja-app")).toBe(true);
    expect(calls.some((c) => c.args[0] === "start" && c.args[1] === "paas-loja-app")).toBe(true);
    expect(logs.join("")).toContain("versão anterior foi religada");
  });

  it("fuso do projeto vai como TZ", async () => {
    await deploy(project(), {}, "America/Sao_Paulo").result;
    expect(runCall()!.args).toContain("TZ=America/Sao_Paulo");
  });

  it("SMTP_HOST liga o container à rede de e-mail (mesmo comportamento do pipeline Dockerfile)", async () => {
    await deploy(project(), { SMTP_HOST: "mail" }).result;
    expect(calls.some((c) => c.args[0] === "network" && c.args[1] === "connect" && c.args.includes("paas-loja-app"))).toBe(true);
  });
});

describe("deployNodeServer — variáveis", () => {
  const VARS = {
    NEXT_PUBLIC_API_URL: "https://api.example.com",
    DATABASE_URL: "postgres://app:senha-do-banco@db.example.com/loja",
    AUTH_SECRET: "segredo-de-sessao-123",
  };

  it("NEXT_PUBLIC_ vai ao build como --build-arg; os segredos NUNCA aparecem em argumento nenhum do build", async () => {
    await deploy(project(), VARS).result;
    const b = buildCall()!.args;
    expect(b).toContain("NEXT_PUBLIC_API_URL=https://api.example.com");
    const doBuild = b.join("\n");
    expect(doBuild).not.toContain("senha-do-banco");
    expect(doBuild).not.toContain("segredo-de-sessao-123");
    expect(doBuild).toContain("id=paasenv,src=");
  });

  it("no container (execução) TODAS as variáveis do painel valem, inclusive as públicas", async () => {
    await deploy(project(), VARS).result;
    const r = runCall()!.args;
    for (const [k, v] of Object.entries(VARS)) expect(r).toContain(`${k}=${v}`);
  });

  it("o arquivo do segredo existe durante o build (0600) e é apagado depois, com sucesso ou falha", async () => {
    const secret = path.join(workDir, "paas.next.build.env");
    let existiaNoBuild = false;
    const exec = await import("../src/exec.js");
    vi.mocked(exec.runStream).mockImplementationOnce(async (file, args) => {
      calls.push({ file, args });
      existiaNoBuild = existsSync(secret) && (await readFile(secret, "utf8")).includes("AUTH_SECRET");
      return 0;
    });
    await deploy(project(), VARS).result;
    expect(existiaNoBuild).toBe(true);
    expect(existsSync(secret)).toBe(false);

    buildCode = 1;
    await expect(deploy(project(), VARS).result).rejects.toThrow();
    expect(existsSync(secret)).toBe(false);
  });

  it("o log lista só NOMES de variáveis, nunca valores", async () => {
    const { logs, result } = deploy(project(), VARS);
    await result;
    const log = logs.join("");
    expect(log).toContain("NEXT_PUBLIC_API_URL");
    expect(log).toContain("DATABASE_URL");
    expect(log).not.toContain("senha-do-banco");
    expect(log).not.toContain("segredo-de-sessao-123");
  });

  it("PORT nas Variáveis é ignorada (o servidor segue a porta do projeto) e o log avisa", async () => {
    const { logs, result } = deploy(project(), { PORT: "9999" });
    await result;
    const r = runCall()!.args;
    expect(r).toContain("PORT=3000");
    expect(r.lastIndexOf("PORT=9999")).toBeLessThan(r.lastIndexOf("PORT=3000")); // a do painel vem por último e vence
    expect(logs.join("")).toContain("PORT=9999 foi ignorada");
  });

  it("PORT igual à do projeto não gera aviso", async () => {
    const { logs, result } = deploy(project(), { PORT: "3000" });
    await result;
    expect(logs.join("")).not.toContain("foi ignorada");
  });
});

describe("deployNodeServer — porta e memória", () => {
  it("porta do campo do projeto vence a detectada: PORT, upstream e Dockerfile", async () => {
    const p = project({ proxyPort: 8080 });
    await expect(deploy(p).result).resolves.toBe("loja:8080");
    expect(runCall()!.args).toContain("PORT=8080");
    expect(await readFile(path.join(workDir, "paas.next.Dockerfile"), "utf8")).toContain("EXPOSE 8080");
  });

  it("nodeServerPort: projeto > detecção > 3000; upstreamFor segue a mesma regra", () => {
    expect(nodeServerPort(project({ proxyPort: 4000 }))).toBe(4000);
    expect(nodeServerPort(project())).toBe(3000);
    expect(nodeServerPort(project({ detection: null }))).toBe(3000);
    const e = engine() as unknown as Internals;
    expect(e.upstreamFor(project({ proxyPort: 4000 }))).toBe("loja:4000");
    expect(e.upstreamFor(project())).toBe("loja:3000");
  });

  it("heap do build proporcional à RAM do servidor (2 GB → 1229 MB; 1 GB → piso 768 MB)", async () => {
    await deploy(project(), {}, null, 2 * GB).result;
    expect(await readFile(path.join(workDir, "paas.next.Dockerfile"), "utf8")).toContain("--max-old-space-size=1229");
    await deploy(project(), {}, null, 1 * GB).result;
    expect(await readFile(path.join(workDir, "paas.next.Dockerfile"), "utf8")).toContain("--max-old-space-size=768");
  });

  it("sem totalMemBytes no contexto, usa a RAM real da máquina (≥ piso)", async () => {
    const e = new DeployEngine({
      projectsDir,
      caddyDir: path.join(projectsDir, "caddy"),
      nodeImage: "node:22",
      staticImage: "nginx:alpine",
      caddyHttpPort: 80,
      caddyHttpsPort: 443,
    });
    await (e as unknown as Internals).deployNodeServer(project(), src, () => undefined, {}, null);
    expect(await readFile(path.join(workDir, "paas.next.Dockerfile"), "utf8")).toMatch(/--max-old-space-size=\d{3,4}/);
  });
});

describe("deployNodeServer — falhas do build", () => {
  it("falta de memória: o log e o erro explicam e sugerem swap/RAM; nenhum container sobe", async () => {
    buildCode = 1;
    buildOutput = "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n";
    const { result, logs } = deploy(project(), {}, null, 2 * GB);
    await expect(result).rejects.toThrow(/sem memória.*1229 MB.*swap/s);
    expect(logs.join("")).toContain("O build ficou sem memória");
    expect(runCall()).toBeUndefined();
    expect(calls.some((c) => c.args[0] === "rm")).toBe(false); // o container antigo continua
    expect(calls.some((c) => c.args[0] === "rename" || c.args[0] === "stop")).toBe(false);
    expect(calls.some((c) => c.args[0] === "builder")).toBe(false); // sem limpeza quando falha
  });

  it("OOM do kernel (exit 137 do RUN) também é reconhecido", async () => {
    buildCode = 1;
    buildOutput = 'ERROR: failed to solve: process "/bin/sh -c pnpm run build" did not complete successfully: exit code: 137\n';
    await expect(deploy(project()).result).rejects.toThrow(/sem memória/);
  });

  it("lockfile fora de sincronia: orienta a atualizar e commitar", async () => {
    buildCode = 1;
    buildOutput = ' ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"\n';
    await expect(deploy(project()).result).rejects.toThrow(/"pnpm install".*commite o lockfile/s);
  });

  it("falha sem padrão conhecido: erro com o código de saída", async () => {
    buildCode = 3;
    buildOutput = "Type error: algo\n";
    const { result, logs } = deploy(project());
    await expect(result).rejects.toThrow("build do Next.js falhou (exit 3).");
    expect(logs.join("")).not.toContain("✖");
  });

  it("só o fim do log é guardado: OOM no começo de um log gigante não é lido (usa o fim)", async () => {
    buildCode = 1;
    buildOutput = "JavaScript heap out of memory\n" + "x".repeat(600_000);
    await expect(deploy(project()).result).rejects.toThrow("build do Next.js falhou (exit 1).");
  });
});

describe("deployNodeServer — o código mudou desde a detecção", () => {
  it("sem next no package.json: pede nova detecção e não constrói", async () => {
    await writeFile(path.join(src, "package.json"), JSON.stringify({ dependencies: { express: "4" } }));
    await expect(deploy(project()).result).rejects.toThrow(/não tem mais a dependência next/);
    expect(buildCall()).toBeUndefined();
  });

  it("package.json removido também", async () => {
    await rm(path.join(src, "package.json"));
    await expect(deploy(project()).result).rejects.toThrow(/dependência next/);
  });

  it('next.config passou a ter output: "export": pede nova detecção', async () => {
    await writeFile(path.join(src, "next.config.mjs"), "export default { output: 'export' };\n");
    await expect(deploy(project()).result).rejects.toThrow(/output: "export"/);
    expect(buildCall()).toBeUndefined();
  });

  it("Dockerfile apareceu no repositório: avisa (e segue gerando o do painel até redetectar)", async () => {
    await writeFile(path.join(src, "Dockerfile"), "FROM scratch\n");
    const { logs, result } = deploy(project());
    await result;
    expect(logs.join("")).toContain("há um Dockerfile no repositório");
    // o Dockerfile do usuário não é tocado
    expect(await readFile(path.join(src, "Dockerfile"), "utf8")).toBe("FROM scratch\n");
    expect(buildCall()!.args[buildCall()!.args.indexOf("-f") + 1]).toBe(path.join(workDir, "paas.next.Dockerfile"));
  });

  it("sem standalone: next start; versão do Node do .nvmrc; sem lockfile avisa", async () => {
    await writeFile(path.join(src, "next.config.mjs"), "export default {};\n");
    await rm(path.join(src, "pnpm-lock.yaml"));
    await writeFile(path.join(src, ".nvmrc"), "24\n");
    const { logs, result } = deploy(project());
    await result;
    const text = await readFile(path.join(workDir, "paas.next.Dockerfile"), "utf8");
    expect(text).toContain("node:24-alpine@sha256:");
    expect(text).toContain("next/dist/bin/next");
    expect(text).toMatch(/RUN --mount=type=cache,id=paas-loja-pnpm-[0-9a-f]{32},target=\/pnpm-store pnpm install\n/);
    expect(logs.join("")).toContain("sem lockfile");
    expect(logs.join("")).toContain(".nvmrc → Node 24");
  });
});

describe("recreate (node-server)", () => {
  const recreate = (p: Project, env: Record<string, string> = {}) => {
    const e = engine() as unknown as { recreate(p: Project, onLog: (c: string) => void): Promise<void> };
    return e.recreate(p, () => undefined);
  };

  it("com a imagem no servidor: só recria o container (sem build), com PORT e proteções", async () => {
    await recreate(project({ proxyPort: 3100 }));
    expect(buildCall()).toBeUndefined();
    const r = runCall()!.args;
    expect(r).toContain("PORT=3100");
    expect(r).toContain("--init");
    expect(r.join(" ")).toContain("--cap-drop ALL");
  });

  it("sem a imagem: erro pedindo um deploy novo", async () => {
    imageExists = false;
    await expect(recreate(project())).rejects.toThrow(/imagem do projeto não existe mais/);
    expect(runCall()).toBeUndefined();
  });
});
