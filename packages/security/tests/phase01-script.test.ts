/**
 * phase01-script.test.ts — scripts/hardening/01-user.sh rodando DE VERDADE num
 * Ubuntu 24.04 descartável (container), porque o que importa aqui é o efeito
 * no sistema: a senha do root fica ou não travada.
 *
 * Defeito que motivou: a trava do root só conferia se o usuário tinha uma
 * chave SSH. Um usuário criado pela própria fase nasce SEM senha (passwd -l):
 * entra por SSH, mas não consegue usar o sudo — e, com a senha do root
 * travada, ninguém mais administra a VPS. Agora a senha do root só é travada
 * se o usuário tiver chave E senha utilizável, e a simulação (dry-run) diz de
 * antemão, lendo o estado real, se ela SERÁ ou NÃO será travada.
 */
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SECURITY_CHECKS, parseSudoUsers } from "../src/checks.js";

const IMAGE = "ubuntu:24.04";
const CONTAINER = `paas-fase01-test-${process.pid}`;
const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/hardening");
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyParaTesteDaFase01SemValorReal teste@local";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const HAS_DOCKER = dockerAvailable();

/** Roda um comando bash como root no container; devolve saída combinada e código. */
function sh(script: string): { out: string; code: number } {
  const r = spawnSync("docker", ["exec", CONTAINER, "bash", "-c", `${script} 2>&1`], {
    encoding: "utf8",
    timeout: 120_000,
  });
  return { out: r.stdout ?? "", code: r.status ?? -1 };
}

/** Estado da senha do root: "P" (utilizável) ou "L" (travada). */
function rootStatus(): string {
  return sh("passwd -S root | awk '{print $2}'").out.trim();
}

function fase01(args: string): { out: string; code: number } {
  return sh(`PAAS_ROLLBACK_DELAY=300 bash /opt/h/01-user.sh ${args}`);
}

describe.skipIf(!HAS_DOCKER)("01-user.sh — só trava o root se o usuário tiver chave E senha", () => {
  beforeAll(() => {
    const present = spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0;
    if (!present) execFileSync("docker", ["pull", "--quiet", IMAGE], { stdio: "ignore", timeout: 180_000 });
    execFileSync(
      "docker",
      ["run", "-d", "--rm", "--name", CONTAINER, "-v", `${SCRIPTS}:/opt/h:ro`, IMAGE, "sleep", "infinity"],
      { stdio: "ignore", timeout: 60_000 },
    );
    const setup = sh(
      [
        "set -e",
        "echo 'root:senha-do-root' | chpasswd",
        // com chave e com senha: o caso do README
        "useradd -m -s /bin/bash comsenha && echo 'comsenha:x1' | chpasswd && usermod -aG sudo comsenha",
        `mkdir -p /home/comsenha/.ssh && echo '${KEY}' > /home/comsenha/.ssh/authorized_keys`,
        // com chave e SEM senha: o que a fase cria quando o usuário não existe
        "useradd -m -s /bin/bash semsenha && usermod -aG sudo semsenha",
        `mkdir -p /home/semsenha/.ssh && echo '${KEY}' > /home/semsenha/.ssh/authorized_keys`,
        // com senha e SEM chave
        "useradd -m -s /bin/bash semchave && echo 'semchave:x2' | chpasswd && usermod -aG sudo semchave",
      ].join(" && "),
    );
    if (setup.code !== 0) throw new Error(`preparo do container falhou:\n${setup.out}`);
  }, 240_000);

  afterAll(() => {
    spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  });

  it("a varredura lê, no sistema real, a senha e as chaves de cada usuário com sudo", () => {
    const cmd = SECURITY_CHECKS.find((c) => c.id === "user.non-root-sudo")?.command ?? "";
    const r = sh(cmd);
    expect(r.code).toBe(0);
    const users = parseSudoUsers(r.out);
    expect(users).toEqual(
      expect.arrayContaining([
        { name: "comsenha", uid: expect.any(Number) as number, hasPassword: true, keyCount: 1 },
        { name: "semsenha", uid: expect.any(Number) as number, hasPassword: false, keyCount: 1 },
        { name: "semchave", uid: expect.any(Number) as number, hasPassword: true, keyCount: 0 },
      ]),
    );
  });

  it("simulação com chave e senha: diz que a senha do root SERÁ travada, sem travar nada", () => {
    const r = fase01("--user comsenha --dry-run");
    expect(r.code).toBe(0);
    expect(r.out).toContain("1 chave(s) SSH instalada(s) para comsenha");
    expect(r.out).toContain("comsenha tem senha");
    expect(r.out).toMatch(/senha do root SERÁ travada/);
    expect(rootStatus()).toBe("P");
  });

  it("simulação SEM senha: diz que NÃO será travada e por quê", () => {
    const r = fase01("--user semsenha --dry-run");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/senha do root NÃO será travada/);
    expect(r.out).toMatch(/semsenha não tem senha/);
    expect(rootStatus()).toBe("P");
  });

  it("simulação SEM chave: diz que NÃO será travada e por quê", () => {
    const r = fase01("--user semchave --dry-run");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/senha do root NÃO será travada/);
    expect(r.out).toContain("nenhuma chave SSH instalada para semchave");
  });

  it("simulação com usuário que ainda não existe (seria criado sem senha): NÃO será travada", () => {
    const r = fase01(`--user novo --pubkey '${KEY}' --dry-run`);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/senha do root NÃO será travada/);
    expect(r.out).toMatch(/novo não tem senha/);
    expect(sh("id novo").code).not.toBe(0); // simulação não cria ninguém
  });

  it("de verdade, usuário com chave e SEM senha: o root continua com senha (ninguém fica sem sudo)", () => {
    const r = fase01("--user semsenha");
    expect(r.code).toBe(0);
    expect(r.out).toContain(":::PAAS_SKIP");
    expect(r.out).not.toContain(":::PAAS_ROLLBACK_SCHEDULED");
    expect(rootStatus()).toBe("P");
  });

  it("de verdade, usuário com chave e senha: trava o root e agenda a reversão", () => {
    const r = fase01("--user comsenha");
    expect(r.code).toBe(0);
    expect(r.out).toContain(":::PAAS_ROLLBACK_SCHEDULED");
    expect(rootStatus()).toBe("L");
    // desfaz para não afetar outros testes
    expect(fase01("--user comsenha --rollback").code).toBe(0);
    expect(rootStatus()).toBe("P");
  });
});
