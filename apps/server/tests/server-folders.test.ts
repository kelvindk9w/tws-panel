/**
 * server-folders.test.ts — a janela "Procurar…" de "Pasta que já está no
 * servidor" navega só dentro da pasta de projetos — a única do computador que
 * o painel enxerga.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServerFolders } from "../src/services/server-folders.js";

let projectsDir: string;
let svc: ServerFolders;

beforeEach(async () => {
  projectsDir = await mkdtemp(path.join(tmpdir(), "paas-upload-"));
  svc = new ServerFolders(projectsDir);
});

afterEach(async () => {
  await rm(projectsDir, { recursive: true, force: true });
});

describe("navegar nas pastas do servidor (só dentro da pasta de projetos)", () => {
  beforeEach(async () => {
    await mkdir(path.join(projectsDir, "meu-site", "css"), { recursive: true });
    await writeFile(path.join(projectsDir, "meu-site", "index.html"), "x");
    await mkdir(path.join(projectsDir, "api"), { recursive: true });
    await mkdir(path.join(projectsDir, ".oculta"), { recursive: true });
    await mkdir(path.join(projectsDir, "_uploads"), { recursive: true });
    await writeFile(path.join(projectsDir, "solto.txt"), "x");
  });

  it("raiz: lista só as pastas, em ordem, sem as ocultas nem as internas do painel", async () => {
    const res = await svc.listDirs();
    expect(res.root).toBe(projectsDir);
    expect(res.path).toBe(projectsDir);
    expect(res.parent).toBeNull();
    expect(res.dirs.map((d) => d.name)).toEqual(["api", "meu-site"]);
    expect(res.dirs.find((d) => d.name === "meu-site")!.hasIndexHtml).toBe(true);
  });

  it("entra numa subpasta e mostra como voltar", async () => {
    const res = await svc.listDirs(path.join(projectsDir, "meu-site"));
    expect(res.dirs.map((d) => d.name)).toEqual(["css"]);
    expect(res.parent).toBe(projectsDir);
  });

  it("caminho fora da pasta de projetos → 400", async () => {
    for (const p of ["/etc", path.join(projectsDir, ".."), path.join(projectsDir, "meu-site", "..", "..")]) {
      await expect(svc.listDirs(p), p).rejects.toMatchObject({ statusCode: 400, code: "outside_projects_dir" });
    }
  });
});
