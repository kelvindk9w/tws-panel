/**
 * upload-service.test.ts — código vindo do computador de quem usa o painel.
 *
 * "Diretório local (upload)" pedia um caminho de DENTRO do servidor do
 * painel: online (VPS) era inútil, e o navegador não pode entregar um caminho
 * do computador da pessoa. Agora o navegador envia os ARQUIVOS da pasta
 * escolhida (janela de pastas), um a um, para uma pasta de envio dentro da
 * pasta de projetos. E a janela de "pasta no servidor" navega só na pasta de
 * projetos — a única do computador que o painel enxerga.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UploadService } from "../src/services/upload-service.js";

let projectsDir: string;
let svc: UploadService;

beforeEach(async () => {
  projectsDir = await mkdtemp(path.join(tmpdir(), "paas-upload-"));
  svc = new UploadService(projectsDir, { maxTotalBytes: 1000, maxFiles: 5 });
});

afterEach(async () => {
  await rm(projectsDir, { recursive: true, force: true });
});

describe("envio de pasta pelo navegador", () => {
  it("cria a pasta de envio dentro da pasta de projetos e grava os arquivos nas subpastas", async () => {
    const { id, dir } = await svc.begin();
    expect(dir.startsWith(path.join(projectsDir, "_uploads"))).toBe(true);
    await svc.putFile(id, "index.html", Buffer.from("<h1>oi</h1>"));
    await svc.putFile(id, "assets/css/style.css", Buffer.from("h1{}"));
    expect(await readFile(path.join(dir, "assets", "css", "style.css"), "utf8")).toBe("h1{}");
  });

  it("recusa caminho que tenta sair da pasta de envio, absoluto, vazio ou com pasta oculta/node_modules", async () => {
    const { id } = await svc.begin();
    for (const bad of ["../fora.txt", "a/../../fora.txt", "/etc/passwd", "", "a\0b", ".git/config", "node_modules/x/i.js", "C:\\\\x"]) {
      await expect(svc.putFile(id, bad, Buffer.from("x")), bad).rejects.toMatchObject({ code: "invalid_path" });
    }
  });

  it("limite de tamanho total e de quantidade de arquivos → 413, com mensagem clara", async () => {
    const { id } = await svc.begin();
    await svc.putFile(id, "a.bin", Buffer.alloc(600));
    await expect(svc.putFile(id, "b.bin", Buffer.alloc(600))).rejects.toMatchObject({ statusCode: 413, code: "upload_too_large" });
    const outro = await svc.begin();
    for (let i = 0; i < 5; i += 1) await svc.putFile(outro.id, `f${i}.txt`, Buffer.from("x"));
    await expect(svc.putFile(outro.id, "f6.txt", Buffer.from("x"))).rejects.toMatchObject({ statusCode: 413, code: "upload_too_many_files" });
  });

  it("envio inexistente → 404", async () => {
    await expect(svc.putFile("nao-existe", "a.txt", Buffer.from("x"))).rejects.toMatchObject({ statusCode: 404 });
  });
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
