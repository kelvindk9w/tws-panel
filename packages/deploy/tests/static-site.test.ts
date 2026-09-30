/**
 * static-site.test.ts — o que vai para o ar num site estático. A pasta do
 * código NÃO é servida direto: ela tem .git (todo o histórico — num
 * repositório privado, o código inteiro), às vezes .env com segredos. O
 * painel copia para uma pasta de publicação sem nada oculto (exceto
 * .well-known, usado por verificações de domínio).
 */
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preparePublishDir } from "../src/static-site.js";

let root: string;
let src: string;
let dest: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paas-static-"));
  src = path.join(root, "src");
  dest = path.join(root, "site");
  await mkdir(path.join(src, ".git", "objects"), { recursive: true });
  await writeFile(path.join(src, ".git", "config"), "[remote]");
  await writeFile(path.join(src, ".env"), "SEGREDO=1");
  await mkdir(path.join(src, ".github"), { recursive: true });
  await writeFile(path.join(src, ".github", "ci.yml"), "x");
  await mkdir(path.join(src, ".well-known"), { recursive: true });
  await writeFile(path.join(src, ".well-known", "security.txt"), "contato");
  await writeFile(path.join(src, "index.html"), "<h1>oi</h1>");
  await mkdir(path.join(src, "assets", ".cache"), { recursive: true });
  await writeFile(path.join(src, "assets", "logo.svg"), "<svg/>");
  await writeFile(path.join(src, "assets", ".cache", "x"), "x");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("preparePublishDir", () => {
  it("copia o site e deixa de fora .git, .env e qualquer outro arquivo ou pasta oculta", async () => {
    await preparePublishDir(src, dest);
    expect((await readdir(dest)).sort()).toEqual([".well-known", "assets", "index.html"]);
    expect(await readFile(path.join(dest, "index.html"), "utf8")).toBe("<h1>oi</h1>");
    expect(await readdir(path.join(dest, "assets"))).toEqual(["logo.svg"]);
    expect(await readFile(path.join(dest, ".well-known", "security.txt"), "utf8")).toBe("contato");
  });

  it("publicar de novo não deixa arquivo velho para trás (arquivo apagado no repositório sai do ar)", async () => {
    await preparePublishDir(src, dest);
    await rm(path.join(src, "assets", "logo.svg"));
    await preparePublishDir(src, dest);
    expect(await readdir(path.join(dest, "assets"))).toEqual([]);
  });
});
