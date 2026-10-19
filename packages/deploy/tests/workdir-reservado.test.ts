/**
 * Lote 6 / A5 — a pasta onde o painel guarda um projeto nunca coincide com
 * pasta do usuário, e nada é copiado/apagado antes de conferir.
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@paas/core";
import { ingestCode, pathsOverlap, projectSrcDir, projectWorkDir, reservedRoot } from "../src/ingest.js";
import { migrateLegacyWorkDir, removeProjectWorkDir, uploadOverlapBlocker, workDirRemovalBlocker } from "../src/workdir-safety.js";

let projetos: string;
const ctx = () => ({ projectsDir: projetos });

function projeto(over: Partial<Project> & { id: string; slug: string }): Project {
  return {
    name: over.slug,
    ingestMode: "upload",
    source: "",
    branch: null,
    domain: `${over.slug}.localhost`,
    websocket: false,
    detection: null,
    proxyService: null,
    proxyPort: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastDeployAt: null,
    lastDeployStatus: null,
    deployedBranch: null,
    deployedSource: null,
    ...over,
  };
}

beforeEach(async () => {
  projetos = await mkdtemp(path.join(tmpdir(), "paas-reservado-"));
});
afterEach(async () => {
  await rm(projetos, { recursive: true, force: true });
});

describe("projectWorkDir", () => {
  it("novo: .paas/<id>; antigo (sem storageLayout): <slug>; id fora do padrão é recusado", () => {
    expect(projectWorkDir(ctx(), projeto({ id: "abc123", slug: "loja", storageLayout: "reserved" }))).toBe(path.join(projetos, ".paas", "abc123"));
    expect(projectWorkDir(ctx(), projeto({ id: "abc123", slug: "loja" }))).toBe(path.join(projetos, "loja"));
    expect(projectSrcDir(ctx(), projeto({ id: "abc123", slug: "loja", storageLayout: "reserved" }))).toBe(path.join(projetos, ".paas", "abc123", "src"));
    expect(() => projectWorkDir(ctx(), projeto({ id: "../x", slug: "loja", storageLayout: "reserved" }))).toThrow(/inválido/);
    expect(reservedRoot(ctx())).toBe(path.join(projetos, ".paas"));
  });

  it("pathsOverlap: igual, dentro e fora", () => {
    expect(pathsOverlap("/a/b", "/a/b")).toBe(true);
    expect(pathsOverlap("/a/b", "/a/b/c")).toBe(true);
    expect(pathsOverlap("/a/b/c", "/a/b")).toBe(true);
    expect(pathsOverlap("/a/b", "/a/bc")).toBe(false);
  });
});

describe("upload — a cópia não apaga nem copia sobre o código do usuário", () => {
  it("projeto antigo cuja pasta de origem é a própria pasta de trabalho (<slug>): recusa e o `src` do usuário fica", async () => {
    const pasta = path.join(projetos, "site");
    await mkdir(path.join(pasta, "src"), { recursive: true });
    await writeFile(path.join(pasta, "src", "main.js"), "codigo do usuario");
    const p = projeto({ id: "u1", slug: "site", source: pasta });
    await expect(ingestCode(ctx(), p, () => undefined)).rejects.toThrow(/coincide com a pasta onde o painel guarda/);
    expect(await readFile(path.join(pasta, "src", "main.js"), "utf8")).toBe("codigo do usuario");
  });

  it("projeto novo apontando para a pasta de projetos inteira: recusa (a cópia incluiria a área do painel)", async () => {
    await writeFile(path.join(projetos, "qualquer.txt"), "x");
    const p = projeto({ id: "n1", slug: "tudo", source: projetos, storageLayout: "reserved" });
    await expect(ingestCode(ctx(), p, () => undefined)).rejects.toThrow(/coincide/);
    expect(existsSync(path.join(projetos, ".paas", "n1", "src"))).toBe(false);
  });

  it("projeto novo: copia para .paas/<id>/src e a pasta de origem do usuário, que tem o nome do slug, fica intacta", async () => {
    const origem = path.join(projetos, "loja");
    await mkdir(origem);
    await writeFile(path.join(origem, "index.html"), "pagina");
    const p = projeto({ id: "n2", slug: "loja", source: origem, storageLayout: "reserved" });
    const src = await ingestCode(ctx(), p, () => undefined);
    expect(src).toBe(path.join(projetos, ".paas", "n2", "src"));
    expect(await readFile(path.join(src, "index.html"), "utf8")).toBe("pagina");
    expect(await readFile(path.join(origem, "index.html"), "utf8")).toBe("pagina");
  });

  it("uploadOverlapBlocker: sem sobreposição devolve null", async () => {
    const origem = path.join(projetos, "outra");
    await mkdir(origem);
    expect(await uploadOverlapBlocker(ctx(), projeto({ id: "n3", slug: "x", source: origem, storageLayout: "reserved" }))).toBeNull();
  });
});

describe("workDirRemovalBlocker", () => {
  it("projeto novo sem coincidência: pode; o de pasta existente nunca", async () => {
    expect(await workDirRemovalBlocker(ctx(), projeto({ id: "n1", slug: "a", source: "https://x/r.git", ingestMode: "git", storageLayout: "reserved" }), [])).toBeNull();
    expect(await workDirRemovalBlocker(ctx(), projeto({ id: "e1", slug: "a", ingestMode: "existing", source: path.join(projetos, "a") }), [])).toMatch(/pasta do próprio usuário/);
  });

  it("alvo fora da pasta de projetos, a própria pasta de projetos e a área reservada inteira são recusados", async () => {
    // slug com '..' (adulterado em projects.json): a pasta de trabalho sairia da pasta de projetos
    expect(await workDirRemovalBlocker(ctx(), projeto({ id: "x1", slug: "..", ingestMode: "git", source: "https://x/r.git" }), [])).toMatch(/estritamente dentro/);
    expect(await workDirRemovalBlocker(ctx(), projeto({ id: "x2", slug: ".", ingestMode: "git", source: "https://x/r.git" }), [])).toMatch(/estritamente dentro/);
    expect(await workDirRemovalBlocker(ctx(), projeto({ id: "x3", slug: ".paas", ingestMode: "git", source: "https://x/r.git" }), [])).toMatch(/área reservada inteira/);
  });

  it("a pasta coincide com a fonte do próprio projeto, da fonte de outro e com a pasta de trabalho de outro", async () => {
    const fonteDoOutro = path.join(projetos, "app");
    await mkdir(fonteDoOutro);
    const outro = projeto({ id: "o1", slug: "outro", name: "Outro", ingestMode: "existing", source: fonteDoOutro });
    const antigo = projeto({ id: "a1", slug: "app", ingestMode: "git", source: "https://x/r.git" });
    expect(await workDirRemovalBlocker(ctx(), antigo, [outro])).toMatch(/projeto "Outro"/);

    const upload = projeto({ id: "u1", slug: "app", ingestMode: "upload", source: fonteDoOutro });
    expect(await workDirRemovalBlocker(ctx(), upload, [])).toMatch(/pasta do código do projeto/);

    const mesmaPasta = projeto({ id: "m1", slug: "app", name: "Mesma", ingestMode: "git", source: "https://x/r.git" });
    expect(await workDirRemovalBlocker(ctx(), antigo, [mesmaPasta])).toMatch(/pasta de trabalho do projeto "Mesma"/);
    // ele mesmo na lista dos outros não conta
    expect(await workDirRemovalBlocker(ctx(), antigo, [antigo, projeto({ id: "z", slug: "zzz", ingestMode: "git", source: "https://x/r.git" })])).toBeNull();
  });

  it("a fonte de outro projeto atrás de um link simbólico também é reconhecida", async () => {
    const real = path.join(projetos, "real");
    await mkdir(real);
    await symlink(real, path.join(projetos, "atalho"));
    const outro = projeto({ id: "o2", slug: "outro", name: "Outro", ingestMode: "existing", source: path.join(projetos, "atalho") });
    const antigo = projeto({ id: "a2", slug: "real", ingestMode: "git", source: "https://x/r.git" });
    expect(await workDirRemovalBlocker(ctx(), antigo, [outro])).toMatch(/projeto "Outro"/);
  });
});

describe("removeProjectWorkDir e migrateLegacyWorkDir", () => {
  it("pasta antiga compartilhada: apaga só src/repo.git/site/paas.* e lista o que ficou", async () => {
    const dir = path.join(projetos, "blog");
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "paas.env"), "x");
    await writeFile(path.join(dir, "notas.txt"), "meu");
    const r = await removeProjectWorkDir(ctx(), projeto({ id: "b", slug: "blog", ingestMode: "git" }), [], { deleteSource: true });
    expect(r.removed.sort()).toEqual(["paas.env", "src"]);
    expect(r.kept).toEqual(["notas.txt"]);
    expect(r.folderRemoved).toBe(false);
    expect(existsSync(path.join(dir, "notas.txt"))).toBe(true);
  });

  it("pasta antiga só com o que é do painel: a pasta sai; sem nada para apagar, devolve vazio", async () => {
    const dir = path.join(projetos, "blog");
    await mkdir(path.join(dir, "src"), { recursive: true });
    const p = projeto({ id: "b", slug: "blog", ingestMode: "git" });
    expect((await removeProjectWorkDir(ctx(), p, [], { deleteSource: true })).folderRemoved).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(await removeProjectWorkDir(ctx(), p, [], { deleteSource: true })).toEqual({ removed: [], kept: [], folderRemoved: false, skipped: [] });
  });

  it("entrada que coincide com a fonte de outro projeto não é apagada; pasta fora dos projetos é recusada", async () => {
    const dir = path.join(projetos, "app");
    await mkdir(path.join(dir, "src"), { recursive: true });
    const outro = projeto({ id: "o", slug: "outro", name: "Outro", ingestMode: "existing", source: path.join(dir, "src") });
    const r = await removeProjectWorkDir(ctx(), projeto({ id: "b", slug: "app", ingestMode: "git" }), [outro], { deleteSource: true });
    expect(r.skipped[0]).toMatch(/Outro/);
    expect(existsSync(path.join(dir, "src"))).toBe(true);
    expect(r.folderRemoved).toBe(false);
    const raiz = await removeProjectWorkDir(ctx(), projeto({ id: "b", slug: ".", ingestMode: "git" }), [], { deleteSource: true });
    expect(raiz.skipped[0]).toMatch(/estritamente dentro/);
  });

  it("pasta reservada: sem apagar o código só saem os paas.*; com apagar sai inteira", async () => {
    const p = projeto({ id: "r1", slug: "r", ingestMode: "git", storageLayout: "reserved" });
    const dir = projectWorkDir(ctx(), p);
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "paas.env"), "x");
    await removeProjectWorkDir(ctx(), p, [], { deleteSource: false });
    expect(existsSync(path.join(dir, "paas.env"))).toBe(false);
    expect(existsSync(path.join(dir, "src"))).toBe(true);
    await removeProjectWorkDir(ctx(), p, [], { deleteSource: true });
    expect(existsSync(dir)).toBe(false);
  });

  it("migra upload antigo (src, site, paas.*) e existing (só paas.*); idempotente; git não migra", async () => {
    const dir = path.join(projetos, "meu");
    await mkdir(path.join(dir, "src"), { recursive: true });
    await mkdir(path.join(dir, "site"), { recursive: true });
    await writeFile(path.join(dir, "paas.env"), "x");
    const up = projeto({ id: "u1", slug: "meu", ingestMode: "upload", source: "/fora/origem" });
    expect((await migrateLegacyWorkDir(ctx(), up))?.sort()).toEqual(["paas.env", "site", "src"]);
    expect(up.storageLayout).toBe("reserved");
    expect(existsSync(path.join(projetos, ".paas", "u1", "src"))).toBe(true);
    expect(await migrateLegacyWorkDir(ctx(), up)).toBeNull();

    await writeFile(path.join(dir, "paas.env"), "y");
    await mkdir(path.join(dir, "site"), { recursive: true });
    const ex = projeto({ id: "e1", slug: "meu", ingestMode: "existing", source: dir });
    expect(await migrateLegacyWorkDir(ctx(), ex)).toEqual(["paas.env"]);
    expect(existsSync(path.join(dir, "site"))).toBe(true);

    expect(await migrateLegacyWorkDir(ctx(), projeto({ id: "g1", slug: "meu", ingestMode: "git", source: "u" }))).toBeNull();
    expect(await migrateLegacyWorkDir(ctx(), projeto({ id: "v1", slug: "nao-existe", ingestMode: "existing", source: "/x" }))).toEqual([]);
  });

  it("migração não sobrescreve o que já existe no destino", async () => {
    const dir = path.join(projetos, "meu");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "paas.env"), "velho");
    await mkdir(path.join(projetos, ".paas", "e1"), { recursive: true });
    await writeFile(path.join(projetos, ".paas", "e1", "paas.env"), "novo");
    expect(await migrateLegacyWorkDir(ctx(), projeto({ id: "e1", slug: "meu", ingestMode: "existing", source: dir }))).toEqual([]);
    expect(await readFile(path.join(projetos, ".paas", "e1", "paas.env"), "utf8")).toBe("novo");
    expect(await readFile(path.join(dir, "paas.env"), "utf8")).toBe("velho");
  });

  it("paas.override.yml (senha SMTP) é do painel: sai com a pasta antiga, é migrado e é limpo em .paas/<id>", async () => {
    const dir = path.join(projetos, "comp");
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "paas.override.yml"), "SMTP_PASS: x");
    const r = await removeProjectWorkDir(ctx(), projeto({ id: "c1", slug: "comp", ingestMode: "git" }), [], { deleteSource: true });
    expect(r.kept).toEqual([]);
    expect(r.folderRemoved).toBe(true);
    expect(existsSync(dir)).toBe(false);

    const dir2 = path.join(projetos, "ex");
    await mkdir(dir2, { recursive: true });
    await writeFile(path.join(dir2, "paas.override.yml"), "SMTP_PASS: y");
    const ex = projeto({ id: "e9", slug: "ex", ingestMode: "existing", source: dir2 });
    expect(await migrateLegacyWorkDir(ctx(), ex)).toEqual(["paas.override.yml"]);
    expect(existsSync(path.join(dir2, "paas.override.yml"))).toBe(false);
    expect(existsSync(path.join(projetos, ".paas", "e9", "paas.override.yml"))).toBe(true);

    const p = projeto({ id: "r2", slug: "r2", ingestMode: "git", storageLayout: "reserved" });
    const wd = projectWorkDir(ctx(), p);
    await mkdir(path.join(wd, "src"), { recursive: true });
    await writeFile(path.join(wd, "paas.override.yml"), "SMTP_PASS: z");
    await removeProjectWorkDir(ctx(), p, [], { deleteSource: false });
    expect(existsSync(path.join(wd, "paas.override.yml"))).toBe(false);
    expect(existsSync(path.join(wd, "src"))).toBe(true);
  });
});
