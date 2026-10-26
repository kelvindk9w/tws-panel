/**
 * build-context.ts — .dockerignore mesclado só durante o build, e quais serviços do compose constroem
 * a partir de um Dockerfile.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PANEL_IGNORE_BLOCK,
  composeBuildTargets,
  excludePanelDotenv,
  hasPanelDotenv,
  mergeDockerignore,
  stripPanelBlock,
} from "../src/build-context.js";
import { GENERATED_HEADER } from "../src/project-dotenv.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-build-context-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("mergeDockerignore / stripPanelBlock", () => {
  it("as linhas do painel vão por último, mesmo sem quebra de linha no fim do arquivo do usuário", () => {
    expect(mergeDockerignore("node_modules")).toBe(`node_modules\n${PANEL_IGNORE_BLOCK}`);
    expect(mergeDockerignore("a\n")).toBe(`a\n${PANEL_IGNORE_BLOCK}`);
    expect(mergeDockerignore("")).toBe(PANEL_IGNORE_BLOCK);
    expect(PANEL_IGNORE_BLOCK).toMatch(/^\.env$/m);
  });

  it("mesclar duas vezes dá o mesmo resultado (um bloco só)", () => {
    const uma = mergeDockerignore("a\n");
    expect(mergeDockerignore(uma)).toBe(uma);
  });

  it("stripPanelBlock tira o bloco do meio, preserva o que vem depois e tolera bloco sem fim", () => {
    expect(stripPanelBlock(`a\n${PANEL_IGNORE_BLOCK}b\n`)).toBe("a\nb\n");
    expect(stripPanelBlock("a\n# >>> TWS Panel (temporário, só durante o build)\n.env\n")).toBe("a\n");
    expect(stripPanelBlock("sem bloco\n")).toBe("sem bloco\n");
  });
});

describe("hasPanelDotenv", () => {
  it("só o .env com o cabeçalho do painel conta", async () => {
    expect(await hasPanelDotenv(dir)).toBe(false);
    await writeFile(path.join(dir, ".env"), "A=1\n");
    expect(await hasPanelDotenv(dir)).toBe(false);
    await writeFile(path.join(dir, ".env"), `${GENERATED_HEADER}\nA='1'\n`);
    expect(await hasPanelDotenv(dir)).toBe(true);
  });
});

describe("excludePanelDotenv", () => {
  it("cria o arquivo ao lado do Dockerfile e o remove ao restaurar (não existia)", async () => {
    const dockerfile = path.join(dir, "Dockerfile");
    const restore = await excludePanelDotenv(dir, dockerfile);
    expect(await readFile(`${dockerfile}.dockerignore`, "utf8")).toBe(PANEL_IGNORE_BLOCK);
    await restore();
    expect(existsSync(`${dockerfile}.dockerignore`)).toBe(false);
  });

  it("parte do .dockerignore da raiz do contexto quando não há o específico", async () => {
    await writeFile(path.join(dir, ".dockerignore"), "dist\n");
    const dockerfile = path.join(dir, "Dockerfile");
    const restore = await excludePanelDotenv(dir, dockerfile);
    expect(await readFile(`${dockerfile}.dockerignore`, "utf8")).toBe(`dist\n${PANEL_IGNORE_BLOCK}`);
    await restore();
    expect(await readFile(path.join(dir, ".dockerignore"), "utf8")).toBe("dist\n");
  });

  it("<Dockerfile>.dockerignore que é pasta: recusa com mensagem clara, sem gravar nada", async () => {
    await mkdir(path.join(dir, "Dockerfile.dockerignore"));
    await expect(excludePanelDotenv(dir, path.join(dir, "Dockerfile"))).rejects.toThrow(/não é um arquivo comum/);
  });
});

describe("composeBuildTargets", () => {
  const src = "/projetos/loja/src";

  it("contexto e Dockerfile absolutos; forma curta (build: ./api); padrão Dockerfile", () => {
    const targets = composeBuildTargets(
      {
        services: {
          web: { build: { context: src, dockerfile: "docker/web.Dockerfile" } },
          api: { build: "./api" },
          vazio: { build: {} },
        },
      },
      src,
    );
    expect(targets).toEqual([
      { service: "web", context: src, dockerfile: `${src}/docker/web.Dockerfile` },
      { service: "api", context: `${src}/api`, dockerfile: `${src}/api/Dockerfile` },
      { service: "vazio", context: src, dockerfile: `${src}/Dockerfile` },
    ]);
  });

  it("sem build, dockerfile_inline, contexto remoto (URL ou git@) e modelos estranhos ficam de fora", () => {
    expect(
      composeBuildTargets(
        {
          services: {
            a: { image: "x" },
            b: { build: null },
            c: { build: { context: src, dockerfile_inline: "FROM alpine" } },
            d: { build: { context: "https://example.com/x.git" } },
            e: { build: { context: "git@example.com:x/y.git" } },
            f: "texto",
            g: [],
          },
        },
        src,
      ),
    ).toEqual([]);
    expect(composeBuildTargets(null, src)).toEqual([]);
    expect(composeBuildTargets({ services: [] }, src)).toEqual([]);
    expect(composeBuildTargets({}, src)).toEqual([]);
  });
});
