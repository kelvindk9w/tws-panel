/**
 * B11 — a restauração de pasta/volume esvazia o destino antes de extrair. Agora
 * guarda antes uma cópia (.tar) do que existia, no próprio destino, e aborta sem
 * apagar nada se a cópia falhar. Roda o script real com `sh` e `tar` reais.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RESTORE_PATH_SCRIPT } from "../src/services/backup-docker.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-restore-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function arquivoTar(conteudo: Record<string, string>): Promise<string> {
  const origem = path.join(dir, "origem", "vol");
  await mkdir(origem, { recursive: true });
  for (const [n, c] of Object.entries(conteudo)) await writeFile(path.join(origem, n), c);
  const tar = path.join(dir, "backup.tar");
  execFileSync("tar", ["-cf", tar, "-C", path.join(dir, "origem"), "vol"]);
  return tar;
}

describe("restauração de pasta: cópia de segurança antes de esvaziar", () => {
  it("o conteúdo anterior fica num .tar dentro do destino e o do backup entra", async () => {
    const destino = path.join(dir, "destino");
    await mkdir(destino);
    await writeFile(path.join(destino, "dado-atual.txt"), "atual");
    const tar = await arquivoTar({ "do-backup.txt": "backup" });
    execFileSync("sh", ["-c", RESTORE_PATH_SCRIPT, "sh", destino, "dir"], { input: await readFile(tar) });
    const nomes = (await readdir(destino)).sort();
    expect(nomes).toContain("do-backup.txt");
    expect(nomes).not.toContain("dado-atual.txt");
    const copia = nomes.find((n) => n.startsWith(".paas-antes-da-restauracao-"));
    expect(copia).toBeDefined();
    const listado = execFileSync("tar", ["-tf", path.join(destino, copia!)], { encoding: "utf8" });
    expect(listado).toMatch(/dado-atual\.txt/);
  });

  it("destino vazio: não cria cópia", async () => {
    const destino = path.join(dir, "vazio");
    const tar = await arquivoTar({ "a.txt": "a" });
    execFileSync("sh", ["-c", RESTORE_PATH_SCRIPT, "sh", destino, "dir"], { input: await readFile(tar) });
    expect((await readdir(destino)).filter((n) => n.startsWith(".paas-antes"))).toEqual([]);
  });
});
