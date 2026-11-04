/**
 * O `.env` e o exclude do git são gravados dentro de `src`, pasta que o
 * PROJETO também grava (achado A2 da auditoria). Um app invadido troca esses
 * nomes por links simbólicos apontando para arquivos do painel; o painel, que
 * enxerga o /data, não pode sobrescrever nada através deles.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeProjectDotenv } from "../src/project-dotenv.js";
import { appendNoFollow, isRealDirectory, isRegularFile, readFileNoFollow, writeFileNoFollow } from "../src/safe-fs.js";

let root: string;
let src: string;
let work: string;
let alvo: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paas-dotenv-links-"));
  src = path.join(root, "src");
  work = path.join(root, "work");
  alvo = path.join(root, "segredo-do-painel");
  await mkdir(src, { recursive: true });
  await mkdir(work, { recursive: true });
  await writeFile(alvo, "NAO-MEXA\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("writeProjectDotenv — sem seguir links simbólicos", () => {
  it(".env que é link para um arquivo do painel: o arquivo do painel fica intacto", async () => {
    await symlink(alvo, path.join(src, ".env"));
    await writeProjectDotenv(src, work, { A: "1" });
    expect(await readFile(alvo, "utf8")).toBe("NAO-MEXA\n");
    const info = await lstat(path.join(src, ".env"));
    expect(info.isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(src, ".env"), "utf8")).toContain("A='1'");
  });

  it("sem variáveis, um .env que é link (mesmo para um arquivo com o cabeçalho do painel) não é apagado nem seguido", async () => {
    await writeFile(alvo, "# Gerado pelo painel (seção Variáveis do projeto) — não editar aqui: edite no painel.\nX=1\n");
    await symlink(alvo, path.join(src, ".env"));
    await writeProjectDotenv(src, work, {});
    expect((await lstat(path.join(src, ".env"))).isSymbolicLink()).toBe(true);
    expect(existsSync(alvo)).toBe(true);
  });

  it(".git/info trocado por link: o exclude do alvo não é tocado", async () => {
    execFileSync("git", ["init", "-q", src]);
    const fora = path.join(root, "fora");
    await mkdir(fora);
    await rm(path.join(src, ".git", "info"), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await symlink(fora, path.join(src, ".git", "info"));
    await writeProjectDotenv(src, work, { A: "1" });
    expect(existsSync(path.join(fora, "exclude"))).toBe(false);
  });

  it(".git/info/exclude trocado por link: o arquivo do painel não recebe a linha", async () => {
    execFileSync("git", ["init", "-q", src]);
    await mkdir(path.join(src, ".git", "info"), { recursive: true });
    await rm(path.join(src, ".git", "info", "exclude"), { force: true });
    await symlink(alvo, path.join(src, ".git", "info", "exclude"));
    await writeProjectDotenv(src, work, { A: "1" });
    expect(await readFile(alvo, "utf8")).toBe("NAO-MEXA\n");
  });

  it(".git/info/exclude que não é arquivo comum (pasta) é deixado como está", async () => {
    execFileSync("git", ["init", "-q", src]);
    await rm(path.join(src, ".git", "info", "exclude"), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await mkdir(path.join(src, ".git", "info", "exclude"), { recursive: true });
    await writeProjectDotenv(src, work, { A: "1" });
    expect((await lstat(path.join(src, ".git", "info", "exclude"))).isDirectory()).toBe(true);
  });

  it(".git de src que é só um ponteiro (arquivo): nada é gravado através dele", async () => {
    await writeFile(path.join(src, ".git"), `gitdir: ${path.join(root, "outro")}\n`);
    await writeProjectDotenv(src, work, { A: "1" });
    expect(existsSync(path.join(root, "outro"))).toBe(false);
  });
});

describe("writeProjectDotenv — repositório do painel (modo git, fora de src)", () => {
  async function repositorioDoPainel(): Promise<string> {
    const dir = path.join(work, "repo.git");
    execFileSync("git", ["--git-dir", dir, "--work-tree", src, "init", "-q"]);
    await writeFile(path.join(src, ".gitkeep"), "");
    execFileSync("git", ["--git-dir", dir, "--work-tree", src, "add", ".gitkeep"]);
    return dir;
  }

  it("o /.env vai para o exclude do repositório do painel, não para o .git de src", async () => {
    const dir = await repositorioDoPainel();
    await mkdir(path.join(src, ".git"), { recursive: true });
    await writeProjectDotenv(src, work, { A: "1" });
    expect(await readFile(path.join(dir, "info", "exclude"), "utf8")).toMatch(/^\/\.env$/m);
    expect(existsSync(path.join(src, ".git", "info", "exclude"))).toBe(false);
  });

  it(".env versionado no repositório do painel continua sendo reconhecido (vai para o paas.env)", async () => {
    const dir = await repositorioDoPainel();
    await writeFile(path.join(src, ".env"), "DO_REPO=1\n");
    execFileSync("git", ["--git-dir", dir, "--work-tree", src, "add", ".env"]);
    const r = await writeProjectDotenv(src, work, { A: "1" });
    expect(r.envFileArgs).toEqual(["--env-file", path.join(work, "paas.env")]);
    expect(await readFile(path.join(src, ".env"), "utf8")).toBe("DO_REPO=1\n");
  });

  it("fsmonitor plantado no .git de src não roda (o painel usa o repositório dele)", async () => {
    await repositorioDoPainel();
    const sentinela = path.join(root, "SENTINELA");
    const script = path.join(root, "fsm.sh");
    await writeFile(script, `#!/bin/sh\necho x >> ${sentinela}\n`, { mode: 0o755 });
    await mkdir(path.join(src, ".git"), { recursive: true });
    await writeFile(path.join(src, ".git", "config"), `[core]\n\tfsmonitor = ${script}\n`);
    await writeProjectDotenv(src, work, { A: "1" });
    expect(existsSync(sentinela)).toBe(false);
  });
});

describe("safe-fs", () => {
  it("writeFileNoFollow: se não dá para pôr o arquivo no lugar, não deixa o temporário para trás", async () => {
    const alvoPasta = path.join(root, "pasta");
    await mkdir(path.join(alvoPasta, "dentro"), { recursive: true });
    await expect(writeFileNoFollow(alvoPasta, "x", 0o600)).rejects.toThrow();
    expect((await readdir(root)).filter((n) => n.includes(".paas-"))).toEqual([]);
  });

  it("appendNoFollow: acrescenta em arquivo comum e recusa link", async () => {
    const comum = path.join(root, "comum");
    expect(await appendNoFollow(comum, "a\n")).toBe(true);
    expect(await appendNoFollow(comum, "b\n")).toBe(true);
    expect(await readFile(comum, "utf8")).toBe("a\nb\n");
    const link = path.join(root, "link");
    await symlink(alvo, link);
    expect(await appendNoFollow(link, "x\n")).toBe(false);
    expect(await readFile(alvo, "utf8")).toBe("NAO-MEXA\n");
  });

  it("appendNoFollow: outro erro de gravação sobe", async () => {
    await expect(appendNoFollow(path.join(root, "nao-existe", "x"), "a")).rejects.toThrow(/ENOENT/);
  });

  it("isRealDirectory e isRegularFile distinguem link, pasta e arquivo", async () => {
    const pasta = path.join(root, "p");
    await mkdir(pasta);
    const link = path.join(root, "lp");
    await symlink(pasta, link);
    expect(await isRealDirectory(pasta)).toBe(true);
    expect(await isRealDirectory(link)).toBe(false);
    expect(await isRealDirectory(path.join(root, "nada"))).toBe(false);
    expect(await isRegularFile(alvo)).toBe(true);
    expect(await isRegularFile(link)).toBe(false);
    expect(await isRegularFile(path.join(root, "nada"))).toBe(false);
  });

  it("readFileNoFollow lê arquivo comum e recusa link (não devolve o conteúdo do alvo)", async () => {
    const link = path.join(root, "atalho");
    await symlink(alvo, link);
    expect(await readFileNoFollow(alvo)).toBe("NAO-MEXA\n");
    await expect(readFileNoFollow(link)).rejects.toThrow();
  });
});
