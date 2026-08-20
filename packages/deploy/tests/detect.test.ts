/**
 * Testes da detecção automática de tipo de projeto (detect.ts) usando
 * fixtures reais em disco: static-node, compose, dockerfile e unknown,
 * incluindo as prioridades entre os sinais (compose > Dockerfile > package.json).
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectProject } from "../src/detect.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-detect-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeJson(file: string, data: unknown): Promise<void> {
  await writeFile(path.join(dir, file), JSON.stringify(data));
}

describe("static-node", () => {
  it("detecta projeto Vite com script de build → saída dist/", async () => {
    await writeJson("package.json", {
      scripts: { build: "vite build" },
      devDependencies: { vite: "^5.0.0" },
      packageManager: "pnpm@10.0.0",
    });
    const result = await detectProject(dir);
    expect(result.type).toBe("static-node");
    expect(result.outputDir).toBe("dist");
    expect(result.packageManager).toBe("pnpm");
    expect(result.buildCommand).toBe("pnpm build");
  });

  it("detecta Next.js com output: export → saída out/", async () => {
    await writeJson("package.json", {
      scripts: { build: "next build" },
      dependencies: { next: "^15.0.0" },
    });
    await writeFile(path.join(dir, "next.config.mjs"), 'export default { output: "export" };\n');
    const result = await detectProject(dir);
    expect(result.type).toBe("static-node");
    expect(result.outputDir).toBe("out");
  });

  it("usa pasta estática já commitada (out/index.html) quando não há pista de framework", async () => {
    await writeJson("package.json", { scripts: { build: "make site" } });
    await mkdir(path.join(dir, "out"), { recursive: true });
    await writeFile(path.join(dir, "out", "index.html"), "<html></html>");
    const result = await detectProject(dir);
    expect(result.type).toBe("static-node");
    expect(result.outputDir).toBe("out");
  });

  it("build sem pistas de framework assume dist/ (fallback documentado)", async () => {
    await writeJson("package.json", { scripts: { build: "tsc && cp -r public dist" } });
    const result = await detectProject(dir);
    expect(result.type).toBe("static-node");
    expect(result.outputDir).toBe("dist");
    expect(result.details.join(" ")).toContain("dist/");
  });

  it("package.json sem script de build → unknown", async () => {
    await writeJson("package.json", { scripts: { start: "node index.js" } });
    const result = await detectProject(dir);
    expect(result.type).toBe("unknown");
    expect(result.outputDir).toBeNull();
  });

  it("detecta o gerenciador de pacotes pelo lockfile quando não declarado", async () => {
    await writeJson("package.json", { scripts: { build: "vite build" }, devDependencies: { vite: "^5" } });
    await writeFile(path.join(dir, "yarn.lock"), "");
    const result = await detectProject(dir);
    expect(result.packageManager).toBe("yarn");
    expect(result.buildCommand).toBe("yarn build");
  });

  it("npm é o fallback e gera buildCommand 'npm run build'", async () => {
    await writeJson("package.json", { scripts: { build: "vite build" }, devDependencies: { vite: "^5" } });
    const result = await detectProject(dir);
    expect(result.packageManager).toBe("npm");
    expect(result.buildCommand).toBe("npm run build");
  });
});

describe("compose", () => {
  const compose = [
    "services:",
    "  web:",
    "    image: nginx:1.27",
    '    ports: ["8080:80"]',
    "  db:",
    "    image: postgres:16",
    "",
  ].join("\n");

  it("compose tem prioridade sobre package.json e Dockerfile", async () => {
    await writeFile(path.join(dir, "docker-compose.yml"), compose);
    await writeJson("package.json", { scripts: { build: "vite build" }, devDependencies: { vite: "^5" } });
    await writeFile(path.join(dir, "Dockerfile"), "FROM node:22\nEXPOSE 3000\n");
    const result = await detectProject(dir);
    expect(result.type).toBe("compose");
    expect(result.composeFile).toBe("docker-compose.yml");
  });

  it("prefere compose.prod.yml ao docker-compose.yml", async () => {
    await writeFile(path.join(dir, "docker-compose.yml"), compose);
    await writeFile(path.join(dir, "compose.prod.yml"), compose);
    const result = await detectProject(dir);
    expect(result.composeFile).toBe("compose.prod.yml");
  });

  it("sugere o serviço web como alvo do proxy", async () => {
    await writeFile(path.join(dir, "compose.yml"), compose);
    const result = await detectProject(dir);
    expect(result.type).toBe("compose");
    expect(result.proxyService).toBe("web");
    expect(result.proxyPort).toBe(80);
  });

  it("agrega os warnings dos guardrails de compose (banco exposto)", async () => {
    const risky = [
      "services:",
      "  db:",
      "    image: postgres:16",
      '    ports: ["5432:5432"]',
      "",
    ].join("\n");
    await writeFile(path.join(dir, "compose.yml"), risky);
    const result = await detectProject(dir);
    expect(result.warnings.some((w) => w.id === "compose.db-port-exposed")).toBe(true);
  });

  it("YAML inválido vira warning crítico e não derruba a detecção", async () => {
    await writeFile(path.join(dir, "compose.yml"), "services: [unclosed\n");
    const result = await detectProject(dir);
    expect(result.type).toBe("compose");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ id: "compose.invalid-yaml", severity: "critical" });
  });

  it("serviço com redes próprias gera warning informativo", async () => {
    const custom = [
      "services:",
      "  app:",
      "    image: node:22",
      "    networks: [minha-rede]",
      "networks:",
      "  minha-rede: {}",
      "",
    ].join("\n");
    await writeFile(path.join(dir, "compose.yml"), custom);
    const result = await detectProject(dir);
    expect(result.warnings.some((w) => w.id === "compose.custom-networks")).toBe(true);
  });
});

describe("dockerfile", () => {
  it("Dockerfile sem package.json → pipeline docker com porta do EXPOSE", async () => {
    await writeFile(path.join(dir, "Dockerfile"), "FROM node:22-slim\nEXPOSE 3000\n");
    const result = await detectProject(dir);
    expect(result.type).toBe("dockerfile");
    expect(result.proxyPort).toBe(3000);
  });

  it("Dockerfile sem EXPOSE → proxyPort null e detalhe orientando configuração manual", async () => {
    await writeFile(path.join(dir, "Dockerfile"), "FROM node:22-slim\n");
    const result = await detectProject(dir);
    expect(result.type).toBe("dockerfile");
    expect(result.proxyPort).toBeNull();
  });

  it("package.json com build + Dockerfile sem saída estática conhecida → dockerfile", async () => {
    await writeJson("package.json", { scripts: { build: "node build.js" } });
    await writeFile(path.join(dir, "Dockerfile"), "FROM node:22\nEXPOSE 8080\n");
    const result = await detectProject(dir);
    expect(result.type).toBe("dockerfile");
    expect(result.proxyPort).toBe(8080);
  });
});

describe("unknown", () => {
  it("diretório vazio → unknown com detalhe de configuração manual", async () => {
    const result = await detectProject(dir);
    expect(result.type).toBe("unknown");
    expect(result.details.join(" ")).toContain("configuração manual");
  });

  it("diretório inexistente → unknown sem lançar erro", async () => {
    const result = await detectProject(path.join(dir, "nao-existe"));
    expect(result.type).toBe("unknown");
    expect(result.details[0]).toContain("Diretório não encontrado");
  });
});
