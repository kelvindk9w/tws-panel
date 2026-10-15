/**
 * restaurar-painel-script.test.ts — scripts/restaurar-painel.sh, a
 * restauração do painel por SSH (sem entrar no painel).
 *
 * Usa um `docker` falso no PATH que registra as chamadas e a entrada padrão
 * de cada uma (para provar que a senha vai por ela e nunca pela linha de
 * comando). A versão com Docker e 7-Zip de verdade está descrita no
 * relatório (comoFuncionaSistema/_RELATORIO-backups.md).
 */
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SH = path.resolve(__dirname, "../../../scripts/restaurar-painel.sh");
const SENHA = "cavalo-azul-janela-trigo-mesa-41";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paas-restaurar-painel-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * docker falso: "7zz t" abre sem senha se o arquivo não tem "cifrado" no
 * nome; com senha, só se a linha recebida for SENHA. "run ... sh -c" (a
 * extração) grava o que recebeu; "exec" diz que o pedido já sumiu.
 */
async function montar(opts: { image?: boolean; running?: boolean; markerStays?: boolean; extractFails?: boolean } = {}) {
  const repo = path.join(dir, "tws-panel");
  const bin = path.join(dir, "bin");
  await mkdir(path.join(repo, "scripts"), { recursive: true });
  await mkdir(bin);
  await copyFile(SH, path.join(repo, "scripts", "restaurar-painel.sh"));
  const log = path.join(dir, "docker.log");
  const stdin = path.join(dir, "stdin.log");
  const fake = `#!/usr/bin/env bash
echo "$*" >> "${log}"
case "$1" in
  image) ${opts.image === false ? "exit 1" : "exit 0"} ;;
  ps) ${opts.running === false ? "true" : "echo tws-panel"} ;;
  stop|start) echo "$2" ;;
  exec) ${opts.markerStays ? "exit 1" : "exit 0"} ;;
  run)
    input="$(cat)"
    echo "[$input]" >> "${stdin}"
    case "$*" in
      *"--entrypoint 7zz"*)
        case "$*" in
          *cifrado*) [ "$input" = "${SENHA}" ] || exit 2 ;;
        esac
        exit 0 ;;
      *"-c "*"7zz x"*) ${opts.extractFails ? "exit 2" : "exit 0"} ;;
      *) exit 0 ;;
    esac ;;
  *) exit 0 ;;
esac
`;
  await writeFile(path.join(bin, "docker"), fake);
  await chmod(path.join(bin, "docker"), 0o755);
  return { repo, bin, log, stdin };
}

function rodar(m: { repo: string; bin: string }, args: string[], input = "", env: Record<string, string> = {}) {
  return spawnSync("bash", [path.join(m.repo, "scripts", "restaurar-painel.sh"), ...args], {
    encoding: "utf8",
    input,
    env: { ...process.env, PATH: `${m.bin}:${process.env.PATH ?? ""}`, PAAS_WAIT_SECONDS: "1", ...env },
  });
}

async function arquivo(name: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, "7z");
  return file;
}

describe("scripts/restaurar-painel.sh (docker falso)", () => {
  it("backup sem senha: confere, para, extrai no volume, sobe e confere a troca", async () => {
    const m = await montar();
    const file = await arquivo("2026-10-14_03-00.7z");
    const r = rodar(m, [file]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const calls = await readFile(m.log, "utf8");
    const order = ["--entrypoint 7zz", "stop tws-panel", "-v paas_data:/data", "start tws-panel", "exec tws-panel"].map((s) => calls.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(calls).toContain(`-v ${dir}:/entrada:ro tws-panel:latest t -bso0 -bsp0 /entrada/2026-10-14_03-00.7z`);
    expect(calls).toContain("/data/backups/.restaurar-painel 2026-10-14_03-00.7z");
    expect(r.stdout).toMatch(/Entre no painel com o usuário e a senha do backup/);
  });

  it("backup cifrado: pergunta a senha e ela vai só pela entrada padrão", async () => {
    const m = await montar();
    const file = await arquivo("cifrado.7z");
    const r = rodar(m, [file], `${SENHA}\n`);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stderr).toContain("Senha do backup:");
    expect(await readFile(m.log, "utf8")).not.toContain(SENHA);
    expect(await readFile(m.stdin, "utf8")).toContain(`[${SENHA}]`);
    expect(r.stdout + r.stderr).not.toContain(SENHA);
  });

  it("senha errada ou vazia: não para o painel nem mexe no volume", async () => {
    const m = await montar();
    const file = await arquivo("cifrado.7z");
    const errada = rodar(m, [file], "chute-errado\n");
    expect(errada.status).toBe(1);
    expect(errada.stderr).toMatch(/a senha não abre este backup/);
    const vazia = rodar(m, [file], "\n");
    expect(vazia.stderr).toMatch(/nenhuma senha foi digitada/);
    const calls = await readFile(m.log, "utf8");
    expect(calls).not.toMatch(/^stop /m);
    expect(calls).not.toContain("paas_data:/data");
  });

  it("senha pela variável PAAS_BACKUP_PASSWORD (sem perguntar)", async () => {
    const m = await montar();
    const file = await arquivo("cifrado.7z");
    const r = rodar(m, [file], "", { PAAS_BACKUP_PASSWORD: SENHA });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain("Senha do backup:");
  });

  it("extração que falha: limpa o pedido, sobe o painel como estava e avisa", async () => {
    const m = await montar({ extractFails: true });
    const file = await arquivo("2026-10-14_03-00.7z");
    const r = rodar(m, [file]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/O painel voltou como estava/);
    const calls = await readFile(m.log, "utf8");
    expect(calls).toMatch(/limpar \/data\/backups\/\.restaurar-painel \/data\/backups\/\.restaurar-painel\.json/);
    expect(calls).toMatch(/^start tws-panel/m);
  });

  it("painel parado não é parado; troca que não termina a tempo avisa onde olhar", async () => {
    const m = await montar({ running: false, markerStays: true });
    const file = await arquivo("2026-10-14_03-00.7z");
    const r = rodar(m, [file]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/docker logs tws-panel/);
    expect(await readFile(m.log, "utf8")).not.toMatch(/^stop /m);
  });

  it("argumentos: sem arquivo, arquivo que não existe, não .7z, dois arquivos, sem imagem e --help", async () => {
    const m = await montar();
    expect(rodar(m, []).stderr).toMatch(/informe o arquivo do backup/);
    expect(rodar(m, [path.join(dir, "nao-existe.7z")]).stderr).toMatch(/arquivo não encontrado/);
    expect(rodar(m, [await arquivo("x.zip")]).stderr).toMatch(/precisa ser um \.7z/);
    expect(rodar(m, ["a", "b"]).stderr).toMatch(/só o arquivo/);
    expect(rodar(m, ["--help"]).stdout).toMatch(/restaurar-painel\.sh/);
  });

  it("sem a imagem do painel: erro claro", async () => {
    const m = await montar({ image: false });
    const r = rodar(m, [await arquivo("2026-10-14_03-00.7z")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/instale o painel primeiro/);
  });

  it("passa no bash -n (sintaxe)", () => {
    expect(spawnSync("bash", ["-n", SH]).status).toBe(0);
  });
});
