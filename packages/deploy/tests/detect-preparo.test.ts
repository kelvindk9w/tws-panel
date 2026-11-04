/**
 * Detecção — lacunas do guia "Como preparar seu projeto": package.json sem build + Dockerfile,
 * prioridade do Dockerfile sobre Vite/Next export, sugestão de aplicação de página única,
 * tipo escolhido à mão (com validação), EXPOSE do último estágio e senha fraca por Variável.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ForcedTypeError, detectProject, looksLikeSpa } from "../src/detect.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-detect-preparo-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const json = (file: string, data: unknown) => writeFile(path.join(dir, file), JSON.stringify(data));
const text = (file: string, content: string) => writeFile(path.join(dir, file), content);

describe("package.json sem script build + Dockerfile", () => {
  it("vira dockerfile (antes virava unknown), com a porta do EXPOSE", async () => {
    await json("package.json", { scripts: { start: "node server.js" }, dependencies: { express: "4" } });
    await text("Dockerfile", "FROM node:22\nEXPOSE 3000\nCMD [\"node\", \"server.js\"]\n");
    const result = await detectProject(dir);
    expect(result.type).toBe("dockerfile");
    expect(result.proxyPort).toBe(3000);
    expect(result.details.join(" ")).toMatch(/sem script de build/);
  });

  it("sem Dockerfile continua unknown (nada a publicar)", async () => {
    await json("package.json", { scripts: { start: "node server.js" } });
    expect((await detectProject(dir)).type).toBe("unknown");
  });

  it("Dockerfile vence o index.html da raiz também com package.json sem build", async () => {
    await json("package.json", { name: "x" });
    await text("Dockerfile", "FROM nginx\nEXPOSE 80\n");
    await text("index.html", "<h1>oi</h1>");
    expect((await detectProject(dir)).type).toBe("dockerfile");
  });
});

describe("Dockerfile tem prioridade sobre Vite e Next export (com aviso)", () => {
  it("Vite + Dockerfile → dockerfile, com a porta do estágio final e um aviso que explica a escolha", async () => {
    await json("package.json", { scripts: { build: "vite build" }, devDependencies: { vite: "5" }, dependencies: { react: "18" } });
    await text("Dockerfile", "FROM node:22 AS build\nEXPOSE 5173\nFROM nginx:alpine\nEXPOSE 80\n");
    const result = await detectProject(dir);
    expect(result.type).toBe("dockerfile");
    expect(result.proxyPort).toBe(80);
    expect(result.spaSuggested).toBeUndefined();
    const warning = result.warnings.find((w) => w.id === "detect.dockerfile-priority");
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toMatch(/dist\/.*Dockerfile/s);
  });

  it("Next com output export + Dockerfile → dockerfile, com aviso", async () => {
    await json("package.json", { scripts: { build: "next build" }, dependencies: { next: "15" } });
    await text("next.config.mjs", 'export default { output: "export" };\n');
    await text("Dockerfile", "FROM nginx\nEXPOSE 8080\n");
    const result = await detectProject(dir);
    expect(result.type).toBe("dockerfile");
    expect(result.warnings.map((w) => w.id)).toContain("detect.dockerfile-priority");
  });

  it("pasta de saída commitada + Dockerfile também fica com o Dockerfile", async () => {
    await json("package.json", { scripts: { build: "make" } });
    await mkdir(path.join(dir, "out"));
    await text(path.join("out", "index.html"), "x");
    await text("Dockerfile", "FROM nginx\n");
    expect((await detectProject(dir)).type).toBe("dockerfile");
  });

  it("build sem pista estática + Dockerfile: dockerfile sem o aviso de prioridade", async () => {
    await json("package.json", { scripts: { build: "tsc" } });
    await text("Dockerfile", "FROM node:22\nEXPOSE 3000\n");
    const result = await detectProject(dir);
    expect(result.type).toBe("dockerfile");
    expect(result.warnings.map((w) => w.id)).not.toContain("detect.dockerfile-priority");
  });

  it("sem Dockerfile o Vite segue como estático", async () => {
    await json("package.json", { scripts: { build: "vite build" }, devDependencies: { vite: "5" } });
    expect((await detectProject(dir)).type).toBe("static-node");
  });
});

describe("sugestão de aplicação de página única", () => {
  it("Vite + React, Vue ou Svelte sem servidor: sugere", async () => {
    for (const lib of ["react", "vue", "svelte"]) {
      await json("package.json", { scripts: { build: "vite build" }, devDependencies: { vite: "5" }, dependencies: { [lib]: "1" } });
      const result = await detectProject(dir);
      expect(result.type).toBe("static-node");
      expect(result.spaSuggested, lib).toBe(true);
      expect(result.details.join(" ")).toMatch(/página única/);
    }
  });

  it("create-react-app (react-scripts) também", async () => {
    await json("package.json", { scripts: { build: "react-scripts build" }, dependencies: { react: "18", "react-scripts": "5" } });
    expect((await detectProject(dir)).spaSuggested).toBe(true);
  });

  it("Vite puro (sem biblioteca de interface) não sugere", async () => {
    await json("package.json", { scripts: { build: "vite build" }, devDependencies: { vite: "5" } });
    expect((await detectProject(dir)).spaSuggested).toBeUndefined();
  });

  it("com renderização no servidor ou uma página por rota (SvelteKit, Astro, Next export), não sugere", async () => {
    await json("package.json", { scripts: { build: "vite build" }, devDependencies: { vite: "5", "@sveltejs/kit": "2" }, dependencies: { svelte: "5" } });
    expect((await detectProject(dir)).spaSuggested).toBeUndefined();
    await json("package.json", { scripts: { build: "next build" }, dependencies: { next: "15", react: "19", vite: "5" } });
    await text("next.config.mjs", 'export default { output: "export" };\n');
    const exported = await detectProject(dir);
    expect(exported.type).toBe("static-node");
    expect(exported.spaSuggested).toBeUndefined();
  });

  it("HTML puro nunca sugere", async () => {
    await text("index.html", "<h1>oi</h1>");
    const result = await detectProject(dir);
    expect(result.type).toBe("static");
    expect(result.spaSuggested).toBeUndefined();
  });

  it("looksLikeSpa olha dependencies e devDependencies juntas", () => {
    expect(looksLikeSpa({ dependencies: { vue: "3" }, devDependencies: { vite: "5" } })).toBe(true);
    expect(looksLikeSpa({ dependencies: { vue: "3", nuxt: "3" }, devDependencies: { vite: "5" } })).toBe(false);
    expect(looksLikeSpa({})).toBe(false);
  });
});

describe("tipo escolhido à mão", () => {
  it("o mesmo tipo da detecção só marca que foi escolhido", async () => {
    await text("Dockerfile", "FROM nginx\nEXPOSE 80\n");
    const result = await detectProject(dir, { forceType: "dockerfile" });
    expect(result).toMatchObject({ type: "dockerfile", chosenType: true, detectedType: "dockerfile" });
  });

  it("Vite com Dockerfile: escolher 'static-node' sobrepõe a prioridade do Dockerfile", async () => {
    await json("package.json", { scripts: { build: "vite build" }, devDependencies: { vite: "5" }, dependencies: { react: "18" } });
    await text("Dockerfile", "FROM nginx\n");
    const result = await detectProject(dir, { forceType: "static-node" });
    expect(result).toMatchObject({ type: "static-node", outputDir: "dist", chosenType: true, detectedType: "dockerfile", spaSuggested: true });
    expect(result.details[0]).toMatch(/Tipo escolhido por você: static-node \(a detecção automática diria dockerfile\)/);
  });

  it("Dockerfile escolhido num projeto Vite sem Dockerfile é recusado com o motivo", async () => {
    await json("package.json", { scripts: { build: "vite build" }, devDependencies: { vite: "5" } });
    await expect(detectProject(dir, { forceType: "dockerfile" })).rejects.toThrow(/Dockerfile na raiz/);
  });

  it("static escolhido à mão com arquivos de servidor na raiz: aviso crítico (a pasta inteira vira pública); HTML puro, sem aviso", async () => {
    await text("index.html", "<h1>oi</h1>");
    expect((await detectProject(dir, { forceType: "static" })).warnings.map((w) => w.id)).not.toContain("detect.static-publishes-server-files");
    await text("Dockerfile", "FROM php:8\n");
    await text("compose.yml", "services:\n  web:\n    image: nginx:1.27\n");
    await json("package.json", { name: "x" });
    for (const nome of ["a.php", "b.PHP", "c.php", "d.php"]) await text(nome, "<?php");
    const aviso = (await detectProject(dir, { forceType: "static" })).warnings.find((w) => w.id === "detect.static-publishes-server-files");
    expect(aviso?.severity).toBe("critical");
    expect(aviso?.message).toContain("Dockerfile, compose.yml, package.json, a.php, b.PHP, c.php");
    expect(aviso?.message).not.toContain("d.php");
  });

  it("static: precisa de index.html; sem ele é recusado, com ele vale mesmo com package.json", async () => {
    await json("package.json", { scripts: { build: "vite build" }, devDependencies: { vite: "5" } });
    await expect(detectProject(dir, { forceType: "static" })).rejects.toThrow(/index\.html/);
    await text("index.html", "<h1>oi</h1>");
    expect(await detectProject(dir, { forceType: "static" })).toMatchObject({ type: "static", detectedType: "static-node" });
  });

  it("static-node exige o script build", async () => {
    await text("index.html", "<h1>oi</h1>");
    await expect(detectProject(dir, { forceType: "static-node" })).rejects.toThrow(/script "build"/);
    await json("package.json", { scripts: { start: "x" } });
    await expect(detectProject(dir, { forceType: "static-node" })).rejects.toBeInstanceOf(ForcedTypeError);
  });

  it("static-node sem pista de framework assume dist/", async () => {
    await json("package.json", { scripts: { build: "make" } });
    await text("Dockerfile", "FROM nginx\n");
    expect(await detectProject(dir, { forceType: "static-node" })).toMatchObject({ type: "static-node", outputDir: "dist" });
  });

  it("compose: exige o arquivo", async () => {
    await text("Dockerfile", "FROM nginx\n");
    await expect(detectProject(dir, { forceType: "compose" })).rejects.toThrow(/arquivo compose/);
  });

  it("compose escolhido é o mesmo que a detecção daria (só que o compose vence sozinho)", async () => {
    await text("compose.yml", "services:\n  web:\n    image: app\n    expose: ['3000']\n");
    const result = await detectProject(dir, { forceType: "compose" });
    expect(result).toMatchObject({ type: "compose", proxyService: "web", proxyPort: 3000, chosenType: true });
  });

  it("node-server: exige next, recusa Next com output export e aceita Next com Dockerfile", async () => {
    await json("package.json", { scripts: { build: "x" } });
    await expect(detectProject(dir, { forceType: "node-server" })).rejects.toThrow(/dependência next/);
    await json("package.json", { scripts: { build: "next build" }, dependencies: { next: "15" } });
    await text("next.config.mjs", 'export default { output: "export" };\n');
    await expect(detectProject(dir, { forceType: "node-server" })).rejects.toThrow(/Site estático com build/);
    await text("next.config.mjs", "export default {};\n");
    await text("Dockerfile", "FROM node\n");
    expect(await detectProject(dir, { forceType: "node-server" })).toMatchObject({ type: "node-server", detectedType: "dockerfile", chosenType: true });
  });

  it("'unknown' e pasta inexistente não podem ser escolhidos", async () => {
    await expect(detectProject(dir, { forceType: "unknown" })).rejects.toThrow(/não pode ser escolhido/);
    await expect(detectProject(path.join(dir, "nao-existe"), { forceType: "static" })).rejects.toThrow(/não encontrado/);
  });

  it("arquivo grande demais para o tipo escolhido é recusado com a mensagem da detecção", async () => {
    await text("package.json", JSON.stringify({ scripts: { build: "x" }, pad: "x".repeat(1024 * 1024 + 10) }));
    await text("Dockerfile", "FROM nginx\n");
    await expect(detectProject(dir, { forceType: "static-node" })).rejects.toThrow(/maior que 1 MB/);
  });
});

describe("compose: senha fraca por trás de ${VARIÁVEL} nas Variáveis salvas (aviso da detecção)", () => {
  const compose = "services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: ${DB_PASSWORD}\n";

  it("com a Variável salva fraca: avisa com o NOME, sem o valor", async () => {
    await text("compose.yml", compose);
    const result = await detectProject(dir, { variables: { DB_PASSWORD: "123" } });
    const warning = result.warnings.find((w) => w.id === "compose.weak-credentials");
    expect(warning?.message).toMatch(/POSTGRES_PASSWORD.*Variável DB_PASSWORD/);
    expect(JSON.stringify(result)).not.toContain('"123"');
    expect(warning?.message).not.toMatch(/\b123\b/);
  });

  it("com a Variável forte, ausente ou sem Variáveis: sem aviso", async () => {
    await text("compose.yml", compose);
    for (const variables of [{ DB_PASSWORD: "k3j9-Zq8w-Lp2x-Vb7n" }, {}, undefined]) {
      const result = await detectProject(dir, variables ? { variables } : {});
      expect(result.warnings.map((w) => w.id)).not.toContain("compose.weak-credentials");
    }
  });
});
