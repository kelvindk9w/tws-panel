import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error módulo .mjs de scripts/ sem declaração de tipos
import { acharAutoresDeTeste, lerCommits, lerConhecidos, montarIntervalo } from "../../../scripts/check-commit-authors.mjs";

// O valor reprovado é montado aqui para este arquivo não conter o e-mail por extenso.
const EMAIL = ["teste", "exemplo.com"].join("@");
const SHA_NOVO = "a".repeat(40);
const commit = (nome: string, email: string, mensagem: string, sha = SHA_NOVO) => ({ sha, nome, email, mensagem });

describe("check-commit-authors", () => {
  it("aceita autor e coautor normais", () => {
    expect(acharAutoresDeTeste([commit("Kelvin", "dono@exemplo.org", `feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n`)])).toEqual([]);
    expect(acharAutoresDeTeste([])).toEqual([]);
  });

  it("reprova autor com nome ou e-mail de teste", () => {
    expect(acharAutoresDeTeste([commit("Teste", "outro@exemplo.org", "x")])).toHaveLength(1);
    expect(acharAutoresDeTeste([commit("Alguém", EMAIL, "x")])).toHaveLength(1);
  });

  it("reprova coautor de teste no trailer, em qualquer caixa, e só ele", () => {
    const v = acharAutoresDeTeste([commit("Kelvin", "dono@exemplo.org", `fix: y\n\nco-authored-by: Teste <${EMAIL}>\nCo-authored-by: Pessoa <p@exemplo.org>\n`)]);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("coautor");
    expect(acharAutoresDeTeste([commit("K", "k@exemplo.org", "Co-authored-by: Teste")])).toHaveLength(1);
  });

  it("não confunde a palavra teste em texto comum", () => {
    expect(acharAutoresDeTeste([commit("Kelvin", "k@exemplo.org", "fix: teste de cobertura\n\nCo-authored-by: Testes Silva <ts@exemplo.org>")])).toEqual([]);
  });

  it("ignora o autor dos SHAs antigos da lista, mas não o trailer deles nem um SHA novo", () => {
    const conhecidos = lerConhecidos();
    expect(conhecidos.size).toBe(3);
    const [antigo] = [...conhecidos] as string[];
    expect(acharAutoresDeTeste([commit("Teste", EMAIL, "x", antigo!)])).toEqual([]);
    expect(acharAutoresDeTeste([commit("Teste", EMAIL, `x\n\nCo-authored-by: Teste <${EMAIL}>`, antigo!)])).toHaveLength(1);
    expect(acharAutoresDeTeste([commit("Teste", EMAIL, "x", SHA_NOVO)])).toHaveLength(1);
    expect(lerConhecidos("/nao-existe.txt").size).toBe(0);
  });

  it("monta o intervalo; base só com zeros (branch nova) confere o último commit", () => {
    expect(montarIntervalo("a", "b")).toBe("a..b");
    expect(montarIntervalo("0".repeat(40), "b")).toBe("b^!");
    expect(montarIntervalo("a..b")).toBe("a..b");
  });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" } });

describe("check-commit-authors: com um repositório de verdade", () => {
  it("passa com o autor antigo conhecido e reprova um commit novo de Teste, lendo o git", () => {
    const dir = mkdtempSync(join(tmpdir(), "autores-"));
    try {
      git(dir, "init", "-q", "-b", "main");
      git(dir, "config", "user.name", "Kelvin");
      git(dir, "config", "user.email", "dono@exemplo.org");
      writeFileSync(join(dir, "a.txt"), "1");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "base");
      const base = git(dir, "rev-parse", "HEAD").trim();
      writeFileSync(join(dir, "a.txt"), "2");
      git(dir, "commit", "-q", "-am", `feat: x\n\nCo-authored-by: Teste <${EMAIL}>`, "--author", `Teste <${EMAIL}>`);
      const commits = lerCommits(`${base}..HEAD`, dir);
      expect(commits).toHaveLength(1);
      expect(commits[0].nome).toBe("Teste");
      expect(acharAutoresDeTeste(commits)).toHaveLength(2); // autor e coautor
      // com o SHA desse commit na lista, só o trailer continua reprovando
      expect(acharAutoresDeTeste(commits, new Set([commits[0].sha]))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("o intervalo atual origin/main..origin/dev passa (quando os dois existem neste clone)", () => {
    let commits;
    try {
      commits = lerCommits("origin/main..origin/dev", join(__dirname, "..", "..", ".."));
    } catch {
      return; // sem as referências (clone raso, tarball): nada a provar aqui
    }
    expect(acharAutoresDeTeste(commits)).toEqual([]);
  });
});
