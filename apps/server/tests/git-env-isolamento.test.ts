/**
 * O ambiente de teste não herda GIT_*: com GIT_DIR exportado (hook de pre-push em worktree) apontando para um
 * repositório descartável, o git dos testes não pode alcançá-lo. O teste de fora reexecuta o de dentro em um
 * vitest filho com GIT_DIR exportado e confere que o repositório descartável ficou intocado.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeDirSync } from "./helpers/tmp.js";

const INNER = process.env.PAAS_GIT_ISOLATION_INNER === "1";
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });

describe("ambiente de teste sem GIT_*", () => {
  it.skipIf(!INNER)("(dentro) GIT_DIR sumiu e o git age no repositório temporário do teste", () => {
    expect(process.env.GIT_DIR).toBeUndefined();
    expect(process.env.GIT_WORK_TREE).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), "paas-gitenv-"));
    try {
      git(dir, "init", "-q");
      writeFileSync(join(dir, "a.txt"), "x");
      git(dir, "add", "a.txt");
      git(dir, "commit", "-q", "-m", "do teste");
      expect(git(dir, "log", "--format=%s").trim()).toBe("do teste");
    } finally {
      removeDirSync(dir);
    }
  });

  it.skipIf(INNER)("com GIT_DIR exportado para um repositório descartável, ele fica intocado", () => {
    const descartavel = mkdtempSync(join(tmpdir(), "paas-gitenv-alvo-"));
    try {
      git(descartavel, "init", "-q");
      const antes = [readFileSync(join(descartavel, ".git", "HEAD"), "utf8"), readdirSync(join(descartavel, ".git", "refs", "heads")).join(",")];
      execFileSync("pnpm", ["exec", "vitest", "run", "tests/git-env-isolamento.test.ts"], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: "pipe",
        env: { ...process.env, GIT_DIR: join(descartavel, ".git"), GIT_WORK_TREE: descartavel, PAAS_GIT_ISOLATION_INNER: "1" },
      });
      const depois = [readFileSync(join(descartavel, ".git", "HEAD"), "utf8"), readdirSync(join(descartavel, ".git", "refs", "heads")).join(",")];
      expect(depois).toEqual(antes);
      expect(readdirSync(descartavel).filter((f) => f !== ".git")).toEqual([]);
      expect(() => git(descartavel, "rev-parse", "--verify", "HEAD")).toThrow();
    } finally {
      removeDirSync(descartavel);
    }
  }, 120_000);
});
