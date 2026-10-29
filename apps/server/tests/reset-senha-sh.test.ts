/**
 * reset-senha-sh.test.ts — scripts/reset-senha.sh com um `docker` falso (como no
 * reset-2fa-sh.test.ts): o falso registra cada chamada e, no `run`, executa o
 * reset-senha.mjs de verdade sobre um users.json temporário. Confere a palavra
 * de confirmação, senha fraca/diferente (sem parar o painel), a ordem
 * parar → gravar → subir e que a senha NUNCA aparece nos argumentos do docker.
 */
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyPassword } from "../src/services/password.js";
import { removeDir } from "./helpers/tmp.js";

const SH = path.resolve(__dirname, "../../../scripts/reset-senha.sh");
const MJS = path.resolve(__dirname, "../../../scripts/reset-senha.mjs");
const APP_DIR = path.resolve(__dirname, "../../..");
const GOOD = "Senha-Nova-Forte-123";

let dir: string;
let users: string;
let log: string;

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$1" in
  image) exit "\${FAKE_IMAGE_EXIT:-0}" ;;
  ps) echo tws-panel; exit 0 ;;
  stop|start) exit 0 ;;
  run)
    shift; args=(); seen=0
    for a in "$@"; do
      if [ "$a" = "/app/scripts/reset-senha.mjs" ]; then seen=1; continue; fi
      [ "$seen" = "1" ] || continue
      [ "$a" = "/data/users.json" ] && a="$FAKE_USERS"
      args+=("$a")
    done
    exec node "$FAKE_MJS" "\${args[@]}" ;;
esac
`;

const USER = {
  id: "u1",
  username: "admin",
  usernameLower: "admin",
  passwordHash: "$argon2id$antigo",
  twoFactor: { iv: "a", tag: "b", data: "c", lastStep: 1, recoveryHashes: ["x"], enabledAt: "z" },
  createdAt: "z",
  updatedAt: "z",
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-reset-senha-sh-"));
  users = path.join(dir, "users.json");
  log = path.join(dir, "docker.log");
  await writeFile(users, JSON.stringify({ users: [USER] }), { mode: 0o600 });
  await writeFile(path.join(dir, "sessions.json"), JSON.stringify({ sessions: [{ id: "s" }] }), { mode: 0o600 });
  await writeFile(path.join(dir, "api-tokens.json"), JSON.stringify({ tokens: [{ id: "t", revokedAt: null }] }), { mode: 0o600 });
  await writeFile(log, "");
  await writeFile(path.join(dir, "docker"), FAKE_DOCKER);
  await chmod(path.join(dir, "docker"), 0o755);
});
afterEach(async () => {
  await removeDir(dir);
});

function run(args: string[], input: string, env: Record<string, string> = {}) {
  return spawnSync("bash", [SH, ...args], {
    input,
    encoding: "utf8",
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      FAKE_LOG: log,
      FAKE_USERS: users,
      FAKE_MJS: MJS,
      PAAS_APP_DIR: APP_DIR,
      PAAS_ASSUME_ROOT: "1",
      ...env,
    },
  });
}
const calls = async () => (await readFile(log, "utf8")).trim().split("\n").filter(Boolean);
const saved = async () =>
  (JSON.parse(await readFile(users, "utf8")) as { users: Array<Record<string, unknown>> }).users[0]!;

describe("scripts/reset-senha.sh", () => {
  it("'redefinir' + senha válida duas vezes: troca só a senha, mantém 2FA, derruba sessões e tokens, ordem parar → gravar → subir", async () => {
    const r = run([], `redefinir\n${GOOD}\n${GOOD}\n`);
    expect(r.status, r.stderr).toBe(0);
    const u = await saved();
    expect(await verifyPassword(String(u.passwordHash), GOOD)).toBe(true);
    expect(u.twoFactor).not.toBeNull();
    expect(JSON.parse(await readFile(path.join(dir, "sessions.json"), "utf8")).sessions).toEqual([]);
    expect(JSON.parse(await readFile(path.join(dir, "api-tokens.json"), "utf8")).tokens[0].revokedAt).toMatch(/^20/);
    const c = await calls();
    const order = ["stop", "run", "start"].map((v) => c.findIndex((l) => l.startsWith(v + " ")));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // o docker recebe a senha pela entrada padrão (-i), nunca por argumento
    expect(c.find((l) => l.startsWith("run "))).toContain(" -i ");
  });

  it("espaços no começo e no fim da senha são preservados (a senha gravada é a digitada)", async () => {
    const spaced = `  ${GOOD}  `;
    const r = run([], `redefinir\n${spaced}\n${spaced}\n`);
    expect(r.status, r.stderr).toBe(0);
    const u = await saved();
    expect(await verifyPassword(String(u.passwordHash), spaced)).toBe(true);
    expect(await verifyPassword(String(u.passwordHash), GOOD)).toBe(false);
  });

  it("sem ser root, recusa antes de qualquer coisa", async () => {
    const r = run([], `redefinir\n${GOOD}\n${GOOD}\n`, { PAAS_ASSUME_ROOT: "0" });
    if (process.getuid?.() !== 0) {
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/rode com sudo/);
    }
  });

  it("a senha não aparece no log do docker nem na saída do script", async () => {
    const r = run([], `redefinir\n${GOOD}\n${GOOD}\n`);
    expect(r.status, r.stderr).toBe(0);
    expect(await readFile(log, "utf8")).not.toContain(GOOD);
    expect(r.stdout + r.stderr).not.toContain(GOOD);
  });

  it("palavra errada cancela sem parar o painel nem alterar nada", async () => {
    const before = await readFile(users, "utf8");
    const r = run([], `sim\n${GOOD}\n${GOOD}\n`);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/cancelado/);
    expect(await readFile(users, "utf8")).toBe(before);
    expect((await calls()).some((l) => l.startsWith("stop "))).toBe(false);
  });

  it("senhas diferentes: erro, painel não é parado, nada muda", async () => {
    const before = await readFile(users, "utf8");
    const r = run([], `redefinir\n${GOOD}\n${GOOD}x\n`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/não são iguais/);
    expect(await readFile(users, "utf8")).toBe(before);
    expect((await calls()).some((l) => l.startsWith("stop "))).toBe(false);
  });

  it.each(["curta1A", "senha-nova-forte-123", "SENHA-NOVA-FORTE-123", "Senha-Nova-Forte-abc"])(
    "senha fraca '%s': erro antes de parar o painel",
    async (pw) => {
      const before = await readFile(users, "utf8");
      const r = run([], `redefinir\n${pw}\n${pw}\n`);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/senha fraca/);
      expect(await readFile(users, "utf8")).toBe(before);
      expect((await calls()).some((l) => l.startsWith("stop "))).toBe(false);
    },
  );

  it("senha vazia: erro", async () => {
    const r = run([], "redefinir\n\n\n");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/vazia/);
  });

  it("falha do .mjs (conta inexistente): o painel volta a subir e o script falha", async () => {
    const r = run(["--usuario", "ninguem"], `redefinir\n${GOOD}\n${GOOD}\n`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/não foi possível/);
    const c = await calls();
    expect(c.some((l) => l.startsWith("start "))).toBe(true);
    expect(c.find((l) => l.startsWith("run "))).toContain("--usuario ninguem");
  });

  it("painel parado: não tenta parar nem iniciar... e --help; opção desconhecida; sem imagem", async () => {
    expect(run(["--help"], "").stdout).toMatch(/reset-senha/);
    expect(run(["--x"], "").status).not.toBe(0);
    expect(run(["--usuario"], "").status).not.toBe(0);
    const r = run([], "redefinir\n", { FAKE_IMAGE_EXIT: "1" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/imagem/);
  });
});
