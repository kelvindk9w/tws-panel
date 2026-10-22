/**
 * reset-2fa-sh.test.ts — scripts/reset-2fa.sh com um `docker` falso: o falso
 * registra cada chamada e, no `run`, executa o reset-2fa.mjs de verdade sobre
 * um users.json temporário (no lugar do volume). Confere a palavra de
 * confirmação, a ordem parar → gravar → subir, o modo --so-bloqueio, o
 * cancelamento, a opção desconhecida, o painel parado e o --help.
 */
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SH = path.resolve(__dirname, "../../../scripts/reset-2fa.sh");
const MJS = path.resolve(__dirname, "../../../scripts/reset-2fa.mjs");

let dir: string;
let users: string;
let log: string;

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$1" in
  image) exit "\${FAKE_IMAGE_EXIT:-0}" ;;
  ps) [ "\${FAKE_RUNNING:-1}" = "1" ] && echo tws-panel; exit 0 ;;
  stop|start) exit 0 ;;
  run)
    shift
    args=()
    seen=0
    for a in "$@"; do
      if [ "$a" = "/app/scripts/reset-2fa.mjs" ]; then seen=1; continue; fi
      [ "$seen" = "1" ] || continue
      [ "$a" = "/data/users.json" ] && a="$FAKE_USERS"
      args+=("$a")
    done
    exec node "$FAKE_MJS" "\${args[@]}"
    ;;
esac
`;

const USER = {
  id: "u1",
  username: "admin",
  usernameLower: "admin",
  passwordHash: "h",
  twoFactor: {
    iv: "a",
    tag: "b",
    data: "c",
    lastStep: 1,
    recoveryHashes: ["x"],
    enabledAt: "z",
    failedCodes: 2,
    lockLevel: 3,
    lockedUntil: 9_999_999_999_999,
  },
  createdAt: "z",
  updatedAt: "z",
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-reset-sh-"));
  users = path.join(dir, "users.json");
  log = path.join(dir, "docker.log");
  await writeFile(users, JSON.stringify({ users: [USER] }), { mode: 0o600 });
  await writeFile(log, "");
  await writeFile(path.join(dir, "docker"), FAKE_DOCKER);
  await chmod(path.join(dir, "docker"), 0o755);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
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
      ...env,
    },
  });
}

const calls = async () => (await readFile(log, "utf8")).trim().split("\n").filter(Boolean);
const saved = async () =>
  (JSON.parse(await readFile(users, "utf8")) as { users: Array<{ twoFactor: Record<string, unknown> | null }> })
    .users[0]!;

describe("scripts/reset-2fa.sh", () => {
  it("--so-bloqueio + 'liberar': mantém o 2FA ligado, limpa só o bloqueio, 0600, na ordem parar → gravar → subir", async () => {
    const r = run(["--so-bloqueio"], "liberar\n");
    expect(r.status, r.stderr).toBe(0);
    const tf = (await saved()).twoFactor!;
    expect(tf.data).toBe("c");
    expect(tf.recoveryHashes).toEqual(["x"]);
    expect(tf).not.toHaveProperty("lockedUntil");
    expect(tf).not.toHaveProperty("failedCodes");
    expect(tf).not.toHaveProperty("lockLevel");
    expect((await stat(users)).mode & 0o777).toBe(0o600);
    const c = await calls();
    const order = ["stop", "run", "start"].map((verb) => c.findIndex((l) => l.startsWith(verb + " ")));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(c.find((l) => l.startsWith("run "))).toContain("--so-bloqueio");
  });

  it("sem opção + 'desligar': desliga o 2FA (bloqueio junto)", async () => {
    const r = run([], "desligar\n");
    expect(r.status, r.stderr).toBe(0);
    expect((await saved()).twoFactor).toBeNull();
    expect((await stat(users)).mode & 0o777).toBe(0o600);
    expect((await calls()).find((l) => l.startsWith("run "))).not.toContain("--so-bloqueio");
  });

  it("palavra errada cancela sem parar o painel nem alterar nada ('desligar' não vale no --so-bloqueio)", async () => {
    const r = run(["--so-bloqueio"], "desligar\n");
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/cancelado/);
    expect((await saved()).twoFactor).toHaveProperty("lockedUntil");
    const c = await calls();
    expect(c.some((l) => l.startsWith("stop ") || l.startsWith("run ") || l.startsWith("start "))).toBe(false);
  });

  it("sem resposta (entrada vazia) cancela", async () => {
    const r = run([], "");
    expect(r.status).toBe(0);
    expect((await saved()).twoFactor).not.toBeNull();
  });

  it("opção desconhecida: erro, nada é executado", async () => {
    const r = run(["--outra"], "desligar\n");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/argumento desconhecido/);
    expect(await calls()).toEqual([]);
  });

  it("painel parado: não tenta parar nem subir, mas grava", async () => {
    const r = run(["--so-bloqueio"], "liberar\n", { FAKE_RUNNING: "0" });
    expect(r.status, r.stderr).toBe(0);
    const c = await calls();
    expect(c.some((l) => l.startsWith("stop ") || l.startsWith("start "))).toBe(false);
    expect(c.some((l) => l.startsWith("run "))).toBe(true);
    expect((await saved()).twoFactor).not.toHaveProperty("lockedUntil");
  });

  it("falha do .mjs vira erro do script (código ≠ 0, mensagem) e o painel sobe de volta, sem mexer no users.json", async () => {
    const boom = path.join(dir, "boom.mjs");
    await writeFile(boom, "process.stderr.write('falhou'); process.exit(3);\n");
    const antes = await readFile(users, "utf8");
    const r = run(["--so-bloqueio"], "liberar\n", { FAKE_MJS: boom });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/não foi possível alterar o users\.json \(código 3\)/);
    expect(r.stderr).toMatch(/painel voltou como estava/);
    expect(await readFile(users, "utf8")).toBe(antes);
    const c = await calls();
    const idx = (verb: string) => c.findIndex((l) => l.startsWith(verb + " "));
    expect(idx("stop")).toBeGreaterThanOrEqual(0);
    expect(idx("run")).toBeGreaterThan(idx("stop"));
    expect(idx("start")).toBeGreaterThan(idx("run")); // o painel sobe mesmo com a falha
  });

  it("imagem ausente: erro antes de parar o painel", async () => {
    const r = run([], "desligar\n", { FAKE_IMAGE_EXIT: "1" });
    expect(r.status).not.toBe(0);
    expect((await calls()).some((l) => l.startsWith("stop "))).toBe(false);
  });

  it("--help mostra o uso, inclusive --so-bloqueio, sem chamar o docker", async () => {
    const r = run(["--help"], "");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/--so-bloqueio/);
    expect(await calls()).toEqual([]);
  });
});
