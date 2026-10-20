/**
 * reset-setup-token.test.ts — lote 7, correção da revisão (M3): recuperação de acesso.
 *
 * Ao concluir o assistente o painel apaga /data/setup-token. Se depois o
 * operador roda scripts/reset-setup.sh, o assistente reabre e PRECISA de um
 * token: o script gera um novo no volume (como o "Recomeçar do zero" do painel).
 * E a variável SETUP_TOKEN da instalação nunca revalida o token antigo de um
 * painel que já tem administrador.
 *
 * O docker é de mentira no PATH: executa o `sh -c` do `docker run` trocando
 * /data por uma pasta temporária.
 */
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSetupToken } from "../src/services/setup-token.js";

const RESET = path.resolve(__dirname, "../../../scripts/reset-setup.sh");
const SHOW = path.resolve(__dirname, "../../../scripts/show-token.sh");
let dir: string;
let data: string;
let bin: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-reset-setup-"));
  data = path.join(dir, "data");
  bin = path.join(dir, "bin");
  await rm(data, { recursive: true, force: true });
  execFileSync("mkdir", ["-p", data, bin]);
  const fake = [
    "#!/bin/sh",
    'if [ "$1" = "run" ]; then',
    "  while [ $# -gt 0 ]; do",
    '    if [ "$1" = "sh" ] && [ "$2" = "-c" ]; then script="$3"; break; fi',
    "    shift",
    "  done",
    '  script=$(printf %s "$script" | sed "s#/data#$FAKE_DATA#g")',
    '  exec sh -c "$script"',
    "fi",
    "exit 0",
    "",
  ].join("\n");
  await writeFile(path.join(bin, "docker"), fake);
  await chmod(path.join(bin, "docker"), 0o755);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

function env() {
  return { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DATA: data, HOME: dir };
}
function runReset(args: string[] = []) {
  return execFileSync("bash", [RESET, ...args], { input: "resetar\n", encoding: "utf8", env: env() });
}

describe("scripts/reset-setup.sh gera um token novo", () => {
  for (const args of [[], ["--full"]]) {
    it(`${args.join(" ") || "sem --full"}: setup concluído (token apagado) → reset → existe /data/setup-token novo, 0600`, async () => {
      await writeFile(path.join(data, "setup-state.json"), '{"completed":true}');
      await writeFile(path.join(data, "users.json"), "{}");
      // o painel apagou o token ao concluir: não há /data/setup-token
      const out = runReset(args);
      const file = path.join(data, "setup-token");
      const token = (await readFile(file, "utf8")).trim();
      expect(token).toMatch(/^[0-9a-f]{48}$/);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(out).not.toContain("permanecem intactos");
      expect(out).not.toMatch(/setup token\s*\n?\s*\(use/); // não manda "ver o token de novo"
      expect(out).toContain("show-token.sh");
    });
  }

  it("cada reset troca o token (o antigo, mesmo que vaze, não vale mais)", async () => {
    await writeFile(path.join(data, "setup-token"), "token-antigo\n");
    runReset();
    const novo = (await readFile(path.join(data, "setup-token"), "utf8")).trim();
    expect(novo).not.toBe("token-antigo");
  });

  it("--full apaga estado, usuários e sessões; sem --full mantém os usuários", async () => {
    for (const f of ["setup-state.json", "users.json", "sessions.json"]) await writeFile(path.join(data, f), "{}");
    runReset();
    expect(execFileSync("ls", [data], { encoding: "utf8" }).split("\n")).toEqual(
      expect.arrayContaining(["users.json", "sessions.json", "setup-token"]),
    );
    runReset(["--full"]);
    const left = execFileSync("ls", [data], { encoding: "utf8" }).split("\n");
    expect(left).not.toContain("users.json");
    expect(left).toContain("setup-token");
  });
});

describe("scripts/show-token.sh depois do setup concluído", () => {
  it("sem arquivo de token explica o que fazer (reset-setup.sh) em vez de só dizer 'não encontrado'", () => {
    let msg = "";
    try {
      execFileSync("bash", [SHOW], { encoding: "utf8", env: env(), stdio: "pipe" });
    } catch (err) {
      msg = String((err as { stderr?: string }).stderr);
    }
    expect(msg).toContain("reset-setup.sh");
  });
});

describe("ciclo concluir → reset → reinício", () => {
  it("SEM a variável: o painel sobe com o token novo gerado pelo reset", async () => {
    vi.stubEnv("SETUP_TOKEN", "");
    runReset(["--full"]);
    const file = path.join(data, "setup-token");
    const novo = (await readFile(file, "utf8")).trim();
    expect(await loadSetupToken(file, { setupCompleted: false, hasAdmin: false })).toBe(novo);
  });

  it("COM a variável da instalação: o arquivo novo vale mais", async () => {
    vi.stubEnv("SETUP_TOKEN", "token-da-instalacao");
    runReset(["--full"]);
    const file = path.join(data, "setup-token");
    const novo = (await readFile(file, "utf8")).trim();
    expect(await loadSetupToken(file, { setupCompleted: false, hasAdmin: false })).toBe(novo);
  });

  it("setup concluído + variável da instalação + sem arquivo: NÃO autentica (null)", async () => {
    vi.stubEnv("SETUP_TOKEN", "token-da-instalacao");
    expect(await loadSetupToken(path.join(data, "setup-token"), { setupCompleted: true, hasAdmin: true })).toBeNull();
  });

  it("estado ausente (reset sem --full), admin existe, variável da instalação, sem arquivo: NÃO autentica", async () => {
    vi.stubEnv("SETUP_TOKEN", "token-da-instalacao");
    expect(await loadSetupToken(path.join(data, "setup-token"), { setupCompleted: false, hasAdmin: true })).toBeNull();
  });

  it("instalação nova (sem admin, sem arquivo): a variável ainda serve de fallback", async () => {
    vi.stubEnv("SETUP_TOKEN", "token-da-instalacao");
    expect(await loadSetupToken(path.join(data, "setup-token"), { setupCompleted: false, hasAdmin: false })).toBe(
      "token-da-instalacao",
    );
  });
});
