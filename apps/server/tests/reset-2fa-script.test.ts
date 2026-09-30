/**
 * reset-2fa-script.test.ts — saída de emergência de quem perdeu o celular E os
 * códigos de recuperação: scripts/reset-2fa.mjs (chamado por
 * scripts/reset-2fa.sh, na VPS, com o painel parado) desliga a verificação em
 * duas etapas de todas as contas e não toca em mais nada.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "../../../scripts/reset-2fa.mjs");
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-reset-2fa-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("scripts/reset-2fa.mjs", () => {
  it("remove a verificação em duas etapas e mantém usuário, senha e o resto", async () => {
    const file = path.join(dir, "users.json");
    const user = {
      id: "u1",
      username: "admin",
      usernameLower: "admin",
      passwordHash: "$argon2id$hash",
      twoFactor: { iv: "a", tag: "b", data: "c", lastStep: 1, recoveryHashes: ["x"], enabledAt: "2026-09-30T00:00:00Z" },
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z",
    };
    await writeFile(file, JSON.stringify({ users: [user] }), { mode: 0o600 });
    const out = execFileSync("node", [SCRIPT, file], { encoding: "utf8" });
    expect(out).toMatch(/admin/);
    const saved = JSON.parse(await readFile(file, "utf8")) as { users: Array<Record<string, unknown>> };
    expect(saved.users[0]!.twoFactor).toBeNull();
    expect(saved.users[0]!.passwordHash).toBe("$argon2id$hash");
    expect(saved.users[0]!.username).toBe("admin");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("sem nenhuma conta com a verificação ativa: diz isso e não regrava o arquivo", async () => {
    const file = path.join(dir, "users.json");
    const conteudo = JSON.stringify({ users: [{ id: "u1", username: "admin", twoFactor: null }] });
    await writeFile(file, conteudo, { mode: 0o600 });
    const out = execFileSync("node", [SCRIPT, file], { encoding: "utf8" });
    expect(out).toMatch(/nenhuma conta/i);
    expect(await readFile(file, "utf8")).toBe(conteudo);
  });
});
