/**
 * server-folders.test.ts — a janela "Procurar…" de "Pasta que já está no
 * servidor" navega só dentro da pasta de projetos — a única do computador que
 * o painel enxerga.
 */
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServerFolders } from "../src/services/server-folders.js";
import { removeDir } from "./helpers/tmp.js";

let projectsDir: string;
let svc: ServerFolders;

beforeEach(async () => {
  projectsDir = await mkdtemp(path.join(tmpdir(), "paas-upload-"));
  svc = new ServerFolders(projectsDir);
});

afterEach(async () => {
  await removeDir(projectsDir);
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

  it("pasta vizinha com o mesmo começo de nome → 400 (não basta o prefixo do texto)", async () => {
    const vizinha = `${projectsDir}-vizinha`;
    await mkdir(vizinha, { recursive: true });
    try {
      await expect(svc.listDirs(vizinha)).rejects.toMatchObject({ statusCode: 400, code: "outside_projects_dir" });
    } finally {
      await removeDir(vizinha);
    }
  });

  it("caminho fora que nem existe → 400 (não revela se existe ou não)", async () => {
    await expect(svc.listDirs("/caminho/que/nao/existe")).rejects.toMatchObject({ statusCode: 400, code: "outside_projects_dir" });
  });

  it("pasta dentro que não existe → 404", async () => {
    await expect(svc.listDirs(path.join(projectsDir, "sumiu"))).rejects.toMatchObject({ statusCode: 404, code: "dir_not_found" });
  });

  it("link dentro da pasta de projetos que aponta para fora → 400", async () => {
    const fora = await mkdtemp(path.join(tmpdir(), "paas-fora-"));
    try {
      await symlink(fora, path.join(projectsDir, "atalho"));
      await expect(svc.listDirs(path.join(projectsDir, "atalho"))).rejects.toMatchObject({ statusCode: 400, code: "outside_projects_dir" });
    } finally {
      await removeDir(fora);
    }
  });

  it("pasta de projetos configurada por um link: aceita o caminho do link e responde com o real", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "paas-link-"));
    try {
      const viaLink = path.join(base, "projetos");
      await symlink(projectsDir, viaLink);
      const res = await new ServerFolders(viaLink).listDirs(path.join(viaLink, "meu-site"));
      expect(res.path).toBe(path.join(projectsDir, "meu-site"));
      expect(res.dirs.map((d) => d.name)).toEqual(["css"]);
    } finally {
      await removeDir(base);
    }
  });
});
