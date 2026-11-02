/**
 * Atualização pelo install.sh: antes do rebuild, espera um deploy em andamento terminar (até 15 min) ou segue na hora
 * com --force. Execução REAL das funções deploy_running e wait_for_running_deploy extraídas do install.sh, com um
 * docker e um sleep falsos no PATH (o instalador inteiro não roda aqui).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeDirSync } from "./helpers/tmp.js";

const raiz = path.resolve(__dirname, "../../..");
const sh = readFileSync(path.join(raiz, "scripts/install.sh"), "utf8");
const pegar = (nome: string) => sh.match(new RegExp(`^${nome}\\(\\) \\{[\\s\\S]*?^\\}`, "m"))?.[0] ?? "";
const funcoes = `${pegar("deploy_running")}\n${pegar("wait_for_running_deploy")}`;

const pastas: string[] = [];
afterEach(() => {
  for (const p of pastas.splice(0)) removeDirSync(p);
});

function falso(dir: string, nome: string, corpo: string) {
  const arquivo = path.join(dir, nome);
  writeFileSync(arquivo, `#!/bin/bash\n${corpo}\n`);
  chmodSync(arquivo, 0o755);
}

interface Cenario {
  /** quantas consultas seguidas respondem "há deploy rodando" (Infinity = sempre) */
  rodando: number;
  /** o docker exec falha (painel parado / arquivo ausente) */
  dockerFalha?: boolean;
  semEsperar?: boolean;
  timeout?: number | string;
  interval?: number | string;
}

function rodar(c: Cenario) {
  expect(funcoes.length, "funções não encontradas no install.sh").toBeGreaterThan(50);
  const dir = mkdtempSync(path.join(tmpdir(), "espera-deploy-"));
  pastas.push(dir);
  const contador = path.join(dir, "consultas");
  const dormiu = path.join(dir, "sleep.log");
  const dockerLog = path.join(dir, "docker.log");
  writeFileSync(contador, "0");
  falso(
    dir,
    "docker",
    `echo "$@" >> "${dockerLog}"\n` +
      (c.dockerFalha
        ? "exit 1"
        : `n=$(cat "${contador}"); echo $((n + 1)) > "${contador}"\n[ "$n" -lt "${Number.isFinite(c.rodando) ? c.rodando : 999999}" ] && exit 0\nexit 1`),
  );
  falso(dir, "sleep", `echo "$1" >> "${dormiu}"`);
  const r = spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail; FORCE=0; SKIP_DEPLOY_WAIT=${c.semEsperar ? 1 : 0}; log() { echo "LOG $*"; }; warn() { echo "AVISO $*"; }\n${funcoes}\nwait_for_running_deploy; echo FIM`,
    ],
    {
      encoding: "utf8",
      env: {
        PATH: `${dir}:/usr/bin:/bin`,
        ...(c.timeout !== undefined ? { PAAS_DEPLOY_WAIT_TIMEOUT: String(c.timeout) } : {}),
        ...(c.interval !== undefined ? { PAAS_DEPLOY_WAIT_INTERVAL: String(c.interval) } : {}),
      },
    },
  );
  return {
    r,
    out: r.stdout,
    sleeps: existsSync(dormiu) ? readFileSync(dormiu, "utf8").trim().split("\n").filter(Boolean) : [],
    docker: existsSync(dockerLog) ? readFileSync(dockerLog, "utf8") : "",
  };
}

describe("install.sh — espera de deploy em andamento na atualização", () => {
  it("sem deploy rodando: segue na hora, sem mensagem e sem dormir", () => {
    const { r, out, sleeps } = rodar({ rodando: 0 });
    expect(r.status).toBe(0);
    expect(out).toBe("FIM\n");
    expect(sleeps).toHaveLength(0);
  });

  it("consulta só o arquivo de jobs dentro do container do painel (sem login, sem token, sem imprimir o arquivo)", () => {
    const { docker } = rodar({ rodando: 0 });
    expect(docker.trim()).toBe(`exec tws-panel grep -qE "status": "(running|queued)" /data/deploy-jobs.json`);
  });

  it("deploy rodando: avisa, espera com mensagem de progresso e segue quando termina", () => {
    const { r, out, sleeps } = rodar({ rodando: 8, interval: 10, timeout: 900 });
    expect(r.status).toBe(0);
    expect(out).toMatch(/AVISO Há um deploy em andamento no painel.*até 15 min.*--sem-esperar-deploy/);
    expect(out).toMatch(/LOG Ainda aguardando o deploy terminar… \(30s de 900s\)/);
    expect(out).toMatch(/LOG O deploy terminou; seguindo com a atualização\./);
    expect(sleeps.length).toBe(7);
    expect(out.endsWith("FIM\n")).toBe(true);
  });

  it("estourou o prazo: avisa que vai interromper o deploy e segue (não trava a atualização)", () => {
    const { r, out, sleeps } = rodar({ rodando: Infinity, timeout: 30, interval: 10 });
    expect(r.status).toBe(0);
    expect(sleeps).toHaveLength(3);
    expect(out).toMatch(/AVISO O deploy não terminou em 0 min\. Seguindo com a atualização mesmo assim/);
    expect(out.endsWith("FIM\n")).toBe(true);
  });

  it("--sem-esperar-deploy: não espera; avisa que o deploy será interrompido", () => {
    const { r, out, sleeps } = rodar({ rodando: Infinity, semEsperar: true });
    expect(r.status).toBe(0);
    expect(sleeps).toHaveLength(0);
    expect(out).toMatch(/AVISO .*--sem-esperar-deploy.*esse deploy será interrompido/);
  });

  it("PAAS_DEPLOY_WAIT_TIMEOUT=0 equivale a não esperar", () => {
    const { r, out, sleeps } = rodar({ rodando: Infinity, timeout: 0 });
    expect(r.status).toBe(0);
    expect(sleeps).toHaveLength(0);
    expect(out).toMatch(/esse deploy será interrompido/);
  });

  it("valores não numéricos caem no padrão com aviso (nem abortam nem travam)", () => {
    const { r, out, sleeps } = rodar({ rodando: 3, timeout: "abc", interval: "0" });
    expect(r.status).toBe(0);
    expect(out).toMatch(/AVISO PAAS_DEPLOY_WAIT_TIMEOUT inválido.*usando 900/);
    expect(out).toMatch(/AVISO PAAS_DEPLOY_WAIT_INTERVAL inválido.*usando 10/);
    expect(sleeps).toEqual(["10", "10"]);
    expect(out.endsWith("FIM\n")).toBe(true);
  });

  it("zeros à esquerda ('09', '08') não são lidos como octal: viram 9 e 8", () => {
    const { r, out, sleeps } = rodar({ rodando: 3, timeout: "0900", interval: "09" });
    expect(r.status).toBe(0);
    expect(out).not.toMatch(/inválido/);
    expect(out).toMatch(/\(até 15 min\)/);
    expect(sleeps).toEqual(["9", "9"]);
    expect(out.endsWith("FIM\n")).toBe(true);
    const zero = rodar({ rodando: Infinity, timeout: "00" });
    expect(zero.sleeps).toHaveLength(0);
    const intervaloZero = rodar({ rodando: 2, interval: "000" });
    expect(intervaloZero.out).toMatch(/INTERVAL inválido.*usando 10/);
    expect(intervaloZero.r.status).toBe(0);
  });

  it("--force mantém o significado antigo: nenhuma ligação com a espera", () => {
    expect(sh).not.toMatch(/\[ "\$FORCE" = "1" \]\s*;?\s*then\s*\n\s*warn "Há um deploy/);
    expect(sh).toMatch(/--sem-esperar-deploy\) SKIP_DEPLOY_WAIT=1/);
  });

  it("a espera vem DEPOIS do build (minutos) e ANTES de recriar o container, sem --build no up", () => {
    const build = sh.indexOf("docker compose -f \"$COMPOSE_FILE\" build");
    const espera = sh.indexOf("\nwait_for_running_deploy\n");
    const up = sh.indexOf("docker compose -f \"$COMPOSE_FILE\" up -d\n");
    expect(build).toBeGreaterThan(0);
    expect(espera).toBeGreaterThan(build);
    expect(up).toBeGreaterThan(espera);
    expect(sh).not.toContain('"$COMPOSE_FILE" up -d --build');
  });

  it("painel parado ou arquivo ausente (docker exec falha): não há deploy, segue na hora", () => {
    const { r, out, sleeps } = rodar({ rodando: 0, dockerFalha: true });
    expect(r.status).toBe(0);
    expect(out).toBe("FIM\n");
    expect(sleeps).toHaveLength(0);
  });
});
