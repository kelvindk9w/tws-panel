/**
 * readRegularFileLimited e as leituras da detecção: o repositório do usuário não
 * escolhe o que o painel lê (links, FIFO, /dev/zero) nem quanto, e o conteúdo
 * cru de arquivo nenhum aparece nos detalhes da detecção.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectProject } from "../src/detect.js";
import { findNestedNextApps, inspectNextApp, readPackageJson, PACKAGE_JSON_MAX_BYTES } from "../src/next-app.js";
import { readRegularFileLimited } from "../src/safe-fs.js";

let dir: string;
let fora: string;
const SEGREDO = "5f2c9a7d1b3e4f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8";

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-limited-"));
  fora = await mkdtemp(path.join(tmpdir(), "paas-fora-"));
  await writeFile(path.join(fora, "session-secret"), SEGREDO);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(fora, { recursive: true, force: true });
});

describe("readRegularFileLimited", () => {
  it("lê arquivo comum, só até o limite", async () => {
    await writeFile(path.join(dir, "a.txt"), "0123456789");
    expect(await readRegularFileLimited(path.join(dir, "a.txt"), 100)).toBe("0123456789");
    expect(await readRegularFileLimited(path.join(dir, "a.txt"), 4)).toBe("0123");
    await writeFile(path.join(dir, "vazio"), "");
    expect(await readRegularFileLimited(path.join(dir, "vazio"), 4)).toBe("");
  });

  it("link simbólico, pasta, FIFO, dispositivo e ausente → undefined", async () => {
    await symlink(path.join(fora, "session-secret"), path.join(dir, "link"));
    await mkdir(path.join(dir, "pasta"));
    execFileSync("mkfifo", [path.join(dir, "fifo")]);
    for (const alvo of [path.join(dir, "link"), path.join(dir, "pasta"), path.join(dir, "fifo"), "/dev/zero", path.join(dir, "nao-existe")]) {
      expect(await readRegularFileLimited(alvo, 100), alvo).toBeUndefined();
    }
  });
});

describe("detecção não segue link nem repete conteúdo", () => {
  const NEXT = { scripts: { build: "next build" }, dependencies: { next: "15" } };

  it(".nvmrc e .node-version que são links para um segredo: ignorados e o segredo não aparece em lugar nenhum", async () => {
    await writeFile(path.join(dir, "package.json"), JSON.stringify(NEXT));
    await symlink(path.join(fora, "session-secret"), path.join(dir, ".nvmrc"));
    await symlink(path.join(fora, "session-secret"), path.join(dir, ".node-version"));
    const r = await detectProject(dir);
    expect(r.nodeServer).toMatchObject({ nodeMajor: 22, nodeSource: "default" });
    expect(JSON.stringify(r)).not.toContain(SEGREDO.slice(0, 10));
  });

  it(".nvmrc de arquivo comum com lixo: só 'valor inválido', sem o conteúdo", async () => {
    await writeFile(path.join(dir, "package.json"), JSON.stringify(NEXT));
    await writeFile(path.join(dir, ".nvmrc"), SEGREDO);
    const r = await detectProject(dir);
    expect(r.details.join(" ")).toContain("valor inválido");
    expect(JSON.stringify(r)).not.toContain(SEGREDO.slice(0, 10));
  });

  it("package.json link, grande demais ou /dev/zero: não é projeto Node", async () => {
    await symlink(path.join(fora, "session-secret"), path.join(dir, "package.json"));
    expect(await readPackageJson(dir)).toBeNull();
    await rm(path.join(dir, "package.json"));
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "x", pad: "a".repeat(PACKAGE_JSON_MAX_BYTES) }));
    expect(await inspectNextApp(dir)).toBeNull();
    await rm(path.join(dir, "package.json"));
    await symlink("/dev/zero", path.join(dir, "package.json"));
    const t0 = performance.now();
    expect(await detectProject(dir)).toMatchObject({ type: "unknown" });
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it("next.config que é link para /dev/zero: tratado como ausente, sem leitura sem fim; vale também no caminho estático", async () => {
    await writeFile(path.join(dir, "package.json"), JSON.stringify(NEXT));
    await symlink("/dev/zero", path.join(dir, "next.config.js"));
    const t0 = performance.now();
    const r = await detectProject(dir);
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(r.type).toBe("node-server");
    expect(r.nodeServer?.standalone).toBe(false);
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: "vite build" }, devDependencies: { vite: "5" } }));
    expect((await detectProject(dir)).outputDir).toBe("dist");
  });

  it("Dockerfile link para um arquivo de fora: sem porta, sem ler", async () => {
    await writeFile(path.join(fora, "df"), "EXPOSE 4444\n");
    await symlink(path.join(fora, "df"), path.join(dir, "Dockerfile"));
    const r = await detectProject(dir);
    expect(r.proxyPort).toBeNull();
  });

  it("compose link: avisa que não consegue ler, sem seguir", async () => {
    await writeFile(path.join(fora, "c.yml"), "services:\n  web:\n    image: nginx\n");
    await symlink(path.join(fora, "c.yml"), path.join(dir, "compose.yml"));
    const r = await detectProject(dir);
    expect(r.type).toBe("compose");
    expect(r.warnings.map((w) => w.id)).toContain("compose.unreadable");
    expect(r.services).toBeUndefined();
  });

  it("apps/ ou apps/web que são links: não procura Next fora do repositório", async () => {
    await mkdir(path.join(fora, "web"));
    await writeFile(path.join(fora, "web", "package.json"), JSON.stringify(NEXT));
    await symlink(fora, path.join(dir, "apps"));
    expect(await findNestedNextApps(dir)).toEqual([]);
    await rm(path.join(dir, "apps"));
    await mkdir(path.join(dir, "apps"));
    await symlink(path.join(fora, "web"), path.join(dir, "apps", "web"));
    expect(await findNestedNextApps(dir)).toEqual([]);
  });
});
