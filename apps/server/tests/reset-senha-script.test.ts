/**
 * reset-senha-script.test.ts — scripts/reset-senha.mjs (chamado por
 * scripts/reset-senha.sh com o painel parado): troca SÓ a senha, com o mesmo
 * argon2id do painel, e mantém conta e 2FA; derruba as sessões e revoga os
 * tokens de API. A senha chega pela entrada padrão.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyPassword } from "../src/services/password.js";

const SCRIPT = path.resolve(__dirname, "../../../scripts/reset-senha.mjs");
const APP_DIR = path.resolve(__dirname, "../../..");
const GOOD = "Senha-Nova-Forte-123";

let dir: string;
let users: string;

const TF = { iv: "a", tag: "b", data: "c", lastStep: 1, recoveryHashes: ["x"], enabledAt: "z" };
const USER = {
  id: "u1",
  username: "Admin",
  usernameLower: "admin",
  passwordHash: "$argon2id$antigo",
  twoFactor: TF,
  email: "admin@example.com",
  createdAt: "z",
  updatedAt: "z",
};

function run(input: string, extra: string[] = []) {
  return spawnSync("node", [SCRIPT, users, ...extra], {
    input,
    encoding: "utf8",
    env: { ...process.env, PAAS_APP_DIR: APP_DIR },
  });
}
const savedUser = async (i = 0) =>
  (JSON.parse(await readFile(users, "utf8")) as { users: Array<Record<string, unknown>> }).users[i]!;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-reset-senha-"));
  users = path.join(dir, "users.json");
  await writeFile(users, JSON.stringify({ users: [USER] }), { mode: 0o600 });
  await writeFile(path.join(dir, "sessions.json"), JSON.stringify({ sessions: [{ id: "s1" }, { id: "s2" }] }), { mode: 0o600 });
  await writeFile(
    path.join(dir, "api-tokens.json"),
    JSON.stringify({
      tokens: [
        { id: "t1", revokedAt: null },
        { id: "t2", revokedAt: "2026-01-01T00:00:00.000Z" },
      ],
    }),
    { mode: 0o600 },
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("scripts/reset-senha.mjs", () => {
  it("grava um hash argon2id que valida a senha nova; mantém conta e 2FA; 0600; sem temporários", async () => {
    const r = run(`${GOOD}\n`);
    expect(r.status, r.stderr).toBe(0);
    const u = await savedUser();
    expect(String(u.passwordHash)).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(String(u.passwordHash), GOOD)).toBe(true);
    expect(await verifyPassword(String(u.passwordHash), "outra")).toBe(false);
    expect(u.twoFactor).toEqual(TF);
    expect(u.username).toBe("Admin");
    expect(u.email).toBe("admin@example.com");
    expect((await stat(users)).mode & 0o777).toBe(0o600);
    expect((await readdir(dir)).sort()).toEqual(["api-tokens.json", "sessions.json", "users.json"]);
    expect(r.stdout + r.stderr).not.toContain(GOOD);
  });

  it("derruba todas as sessões e revoga só os tokens ainda ativos", async () => {
    const r = run(`${GOOD}\n`);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(await readFile(path.join(dir, "sessions.json"), "utf8"))).toEqual({ sessions: [] });
    const t = JSON.parse(await readFile(path.join(dir, "api-tokens.json"), "utf8")) as { tokens: Array<{ id: string; revokedAt: string | null }> };
    expect(t.tokens[0]!.revokedAt).toMatch(/^20/);
    expect(t.tokens[1]!.revokedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(r.stdout).toMatch(/1 token/);
  });

  it("funciona sem sessions.json nem api-tokens.json", async () => {
    await rm(path.join(dir, "sessions.json"));
    await rm(path.join(dir, "api-tokens.json"));
    const r = run(`${GOOD}\n`);
    expect(r.status, r.stderr).toBe(0);
    expect((await readdir(dir)).sort()).toEqual(["users.json"]);
  });

  it.each([
    ["curta", "Ab1"],
    ["sem maiúscula", "senha-nova-forte-123"],
    ["sem minúscula", "SENHA-NOVA-FORTE-123"],
    ["sem número", "Senha-Nova-Forte-abc"],
    ["vazia", ""],
  ])("senha fraca (%s) é recusada e nada muda", async (_n, pw) => {
    const before = await readFile(users, "utf8");
    const r = run(`${pw}\n`);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/Senha fraca/);
    expect(await readFile(users, "utf8")).toBe(before);
    expect(JSON.parse(await readFile(path.join(dir, "sessions.json"), "utf8")).sessions).toHaveLength(2);
  });

  it("--usuario: escolhe a conta (sem diferenciar maiúsculas) e recusa nome desconhecido; sem --usuario com duas contas, pede o nome", async () => {
    const second = { ...USER, id: "u2", username: "outro", usernameLower: "outro" };
    await writeFile(users, JSON.stringify({ users: [USER, second] }), { mode: 0o600 });
    let r = run(`${GOOD}\n`);
    expect(r.status).toBe(4);
    expect(r.stderr).toMatch(/--usuario/);
    r = run(`${GOOD}\n`, ["--usuario", "nao-existe"]);
    expect(r.status).toBe(4);
    r = run(`${GOOD}\n`, ["--usuario", "OUTRO"]);
    expect(r.status, r.stderr).toBe(0);
    expect(await verifyPassword(String((await savedUser(1)).passwordHash), GOOD)).toBe(true);
    expect((await savedUser(0)).passwordHash).toBe("$argon2id$antigo");
  });

  it("sem conta: avisa; uso errado: código 2", async () => {
    await writeFile(users, JSON.stringify({ users: [] }), { mode: 0o600 });
    expect(run(`${GOOD}\n`).status).toBe(4);
    expect(spawnSync("node", [SCRIPT], { encoding: "utf8" }).status).toBe(2);
    expect(run("", ["--outra"]).status).toBe(2);
  });

  it("api-tokens.json ilegível: avisa, mas a senha é trocada", async () => {
    await writeFile(path.join(dir, "api-tokens.json"), "{ não é json");
    const r = run(`${GOOD}\n`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/ilegível/);
  });
});
