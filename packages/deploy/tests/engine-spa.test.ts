/**
 * Aplicação de página única (opção por projeto): o nginx recebe uma configuração com
 * `try_files $uri $uri/ /index.html`, montada só leitura. Desligada (o padrão, e sempre para HTML
 * puro sem a opção), nada é montado e o nginx segue como sempre foi (404 para caminho inexistente).
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@paas/core";

type Result = { code: number; stdout: string; stderr: string };
const calls: string[][] = [];

vi.mock("../src/exec.js", () => ({
  run: vi.fn(async (_file: string, args: string[]): Promise<Result> => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "" };
  }),
  runStream: vi.fn(async (_file: string, args: string[]) => {
    calls.push(args);
    return 0;
  }),
}));

const { DeployEngine } = await import("../src/engine.js");
const { SPA_NGINX_CONF } = await import("../src/static-site.js");

let root: string;
let projectsDir: string;
let src: string;
let workDir: string;

beforeEach(async () => {
  calls.length = 0;
  root = await mkdtemp(path.join(tmpdir(), "paas-spa-"));
  projectsDir = path.join(root, "projects");
  workDir = path.join(projectsDir, "site");
  src = path.join(workDir, "src");
  await mkdir(path.join(src, "dist"), { recursive: true });
  await writeFile(path.join(src, "dist", "index.html"), "<div id=root></div>");
  await writeFile(path.join(src, "index.html"), "<h1>oi</h1>");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function project(type: "static" | "static-node", spa?: boolean): Project {
  return {
    id: "p1",
    name: "Site",
    slug: "site",
    ingestMode: "git",
    source: "https://example.com/x.git",
    branch: "main",
    domain: "site.localhost",
    websocket: false,
    ...(spa === undefined ? {} : { spa }),
    detection: {
      type,
      composeFile: null,
      outputDir: type === "static-node" ? "dist" : null,
      packageManager: "npm",
      buildCommand: null,
      proxyService: null,
      proxyPort: null,
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
  deployStatic(p: Project, src: string, onLog: (c: string) => void): Promise<string>;
  deployPlainStatic(p: Project, src: string, onLog: (c: string) => void): Promise<string>;
};
const confMount = () => calls.flat().find((a) => a.endsWith(":/etc/nginx/conf.d/default.conf:ro"));
const conf = () => path.join(workDir, "paas.spa.conf");

describe("nginx com fallback de aplicação de página única", () => {
  it("static-node com spa ligado: monta a configuração só leitura e ela responde o index.html", async () => {
    const log: string[] = [];
    await (engine() as unknown as Privado).deployStatic(project("static-node", true), src, (c) => log.push(c));
    expect(confMount()).toBe(`${conf()}:/etc/nginx/conf.d/default.conf:ro`);
    const text = await readFile(conf(), "utf8");
    expect(text).toBe(SPA_NGINX_CONF);
    expect(text).toContain("try_files $uri $uri/ /index.html;");
    // sem IPv6: num kernel sem suporte o nginx não subiria com `listen [::]:80`
    expect(text).not.toContain("[::]");
    expect(text).toContain("root /usr/share/nginx/html;");
    expect((await stat(conf())).mode & 0o777).toBe(0o644);
    expect(log.join("")).toMatch(/Aplicação de página única/);
    // continua montando a pasta publicada e usando a imagem do painel
    expect(calls.flat().some((a) => a.endsWith(":/usr/share/nginx/html:ro"))).toBe(true);
    expect(calls.flat()).toContain("nginx:alpine");
  });

  it("a configuração fica fora do código do projeto (nada é gravado no src)", async () => {
    await (engine() as unknown as Privado).deployStatic(project("static-node", true), src, () => undefined);
    expect(existsSync(path.join(src, "paas.spa.conf"))).toBe(false);
    expect(conf().startsWith(src + path.sep)).toBe(false);
  });

  it("spa desligado ou ausente: nada é montado nem gravado", async () => {
    for (const spa of [false, undefined]) {
      calls.length = 0;
      await (engine() as unknown as Privado).deployStatic(project("static-node", spa), src, () => undefined);
      expect(confMount()).toBeUndefined();
    }
    expect(existsSync(conf())).toBe(false);
  });

  it("HTML puro: sem a opção, nada; com a opção ligada (escolha explícita), vale também", async () => {
    await (engine() as unknown as Privado).deployPlainStatic(project("static"), src, () => undefined);
    expect(confMount()).toBeUndefined();
    calls.length = 0;
    await (engine() as unknown as Privado).deployPlainStatic(project("static", true), src, () => undefined);
    expect(confMount()).toBe(`${conf()}:/etc/nginx/conf.d/default.conf:ro`);
  });

  it("desligar a opção no deploy seguinte volta ao nginx sem a configuração (o container é recriado sem o -v)", async () => {
    await (engine() as unknown as Privado).deployStatic(project("static-node", true), src, () => undefined);
    calls.length = 0;
    await (engine() as unknown as Privado).deployStatic(project("static-node", false), src, () => undefined);
    expect(confMount()).toBeUndefined();
    expect(calls.some((a) => a[0] === "rm" && a.includes("-f"))).toBe(true);
  });
});
