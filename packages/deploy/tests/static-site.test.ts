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
import { preparePublishDir, publishBuildOutput } from "../src/static-site.js";

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
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

describe("pasta de publicação dentro (ou igual) à pasta do código (A5: nunca apagar arquivo do usuário)", () => {
  it("preparePublishDir recusa quando o destino fica dentro do código e não apaga nada", async () => {
    const dentro = path.join(src, "site");
    await mkdir(dentro, { recursive: true });
    await writeFile(path.join(dentro, "pagina-do-usuario.html"), "do usuario");
    await expect(preparePublishDir(src, dentro)).rejects.toThrow(/coincide|dentro/);
    expect(await readFile(path.join(dentro, "pagina-do-usuario.html"), "utf8")).toBe("do usuario");
  });

  it("preparePublishDir recusa quando o destino é o próprio código ou contém o código", async () => {
    await expect(preparePublishDir(src, src)).rejects.toThrow(/coincide|dentro/);
    await expect(preparePublishDir(src, root)).rejects.toThrow(/coincide|dentro/);
    expect(await readFile(path.join(src, "index.html"), "utf8")).toBe("<h1>oi</h1>");
  });

  it("publishBuildOutput também recusa destino dentro do código", async () => {
    const dentro = path.join(src, "site");
    await mkdir(path.join(src, "dist"), { recursive: true });
    await writeFile(path.join(src, "dist", "a.html"), "a");
    await mkdir(dentro, { recursive: true });
    await writeFile(path.join(dentro, "pagina-do-usuario.html"), "do usuario");
    await expect(publishBuildOutput(src, "dist", dentro)).rejects.toThrow(/coincide|dentro/);
    expect(await readFile(path.join(dentro, "pagina-do-usuario.html"), "utf8")).toBe("do usuario");
  });
});

describe("publishBuildOutput — arquivos ocultos da saída do build", () => {
  it("tira .env, .git e qualquer oculto da saída (em qualquer nível), mas preserva .well-known", async () => {
    const out = path.join(src, "dist");
    await mkdir(path.join(out, ".git"), { recursive: true });
    await writeFile(path.join(out, ".git", "config"), "x");
    await writeFile(path.join(out, ".env"), "SEGREDO=1");
    await writeFile(path.join(out, ".env.local"), "SEGREDO=2");
    await mkdir(path.join(out, "assets", ".cache"), { recursive: true });
    await writeFile(path.join(out, "assets", ".cache", "x"), "x");
    await writeFile(path.join(out, "assets", "app.js"), "js");
    await mkdir(path.join(out, ".well-known"), { recursive: true });
    await writeFile(path.join(out, ".well-known", "security.txt"), "contato");
    await writeFile(path.join(out, "index.html"), "<h1>app</h1>");
    await publishBuildOutput(src, "dist", dest);
    expect((await readdir(dest)).sort()).toEqual([".well-known", "assets", "index.html"]);
    expect(await readdir(path.join(dest, "assets"))).toEqual(["app.js"]);
    expect(await readFile(path.join(dest, ".well-known", "security.txt"), "utf8")).toBe("contato");
  });

  it("saída dentro de uma pasta de nome oculto no caminho do código ainda é publicada (o filtro olha só o que está DENTRO da saída)", async () => {
    await mkdir(path.join(src, ".build", "dist"), { recursive: true });
    await writeFile(path.join(src, ".build", "dist", "index.html"), "ok");
    await publishBuildOutput(src, ".build/dist", dest);
    expect(await readdir(dest)).toEqual(["index.html"]);
  });
});
