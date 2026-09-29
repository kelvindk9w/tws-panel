/**
 * phase02-07-scripts.test.ts — Fases 02 e 07 rodando DE VERDADE num Ubuntu
 * 24.04 descartável (container).
 *
 * Fase 02 — defeito visto em campo: o drop-in gravava AllowTcpForwarding no.
 * O túnel aberto antes continuava funcionando, e o próximo (inclusive depois do
 * reboot) era recusado: o operador perdia o acesso ao painel, que o README
 * manda abrir por `ssh -L`. E sem --user a fase deixava o root entrar com chave.
 *
 * Fase 07 — as recomendações do Lynis seguras de automatizar: aplica, e o
 * rollback devolve cada arquivo e cada permissão ao que era.
 */
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const IMAGE = "ubuntu:24.04";
const CONTAINER = `paas-fase02-07-test-${process.pid}`;
const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/hardening");
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyParaTesteDaFase02SemValorReal teste@local";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const HAS_DOCKER = dockerAvailable();

function sh(script: string, timeout = 300_000): { out: string; code: number } {
  const r = spawnSync("docker", ["exec", CONTAINER, "bash", "-c", `${script} 2>&1`], {
    encoding: "utf8",
    timeout,
  });
  return { out: r.stdout ?? "", code: r.status ?? -1 };
}

describe.skipIf(!HAS_DOCKER)("fases 02 e 07 num Ubuntu real", () => {
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
        "useradd -m -s /bin/bash kelvin && echo 'kelvin:x1' | chpasswd",
        `mkdir -p /home/kelvin/.ssh && echo '${KEY}' > /home/kelvin/.ssh/authorized_keys`,
        // o que a fase 07 restringe e depois devolve
        "echo '# crontab de teste' > /etc/crontab && chmod 644 /etc/crontab",
        "mkdir -p /etc/cron.d && chmod 755 /etc/cron.d",
        "echo 'Ubuntu 24.04 \\n \\l' > /etc/issue",
        "apt-get update -qq >/dev/null",
      ].join(" && "),
    );
    if (setup.code !== 0) throw new Error(`preparo do container falhou:\n${setup.out}`);
  }, 400_000);

  afterAll(() => {
    spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  });

  it("fase 02 libera só o encaminhamento LOCAL (o túnel do painel) e desliga o TCPKeepAlive", () => {
    const r = sh("bash /opt/h/02-ssh.sh --dry-run --user kelvin");
    expect(r.code).toBe(0);
    expect(r.out).toContain("AllowTcpForwarding local");
    expect(r.out).not.toContain("AllowTcpForwarding no");
    expect(r.out).toContain("TCPKeepAlive no");
  });

  it("fase 02 com --user bloqueia o root e restringe quem entra por SSH", () => {
    const r = sh("bash /opt/h/02-ssh.sh --dry-run --user kelvin");
    expect(r.out).toContain("PermitRootLogin no");
    expect(r.out).toContain("AllowUsers kelvin");
    expect(r.out).not.toContain("sem --user");
  });

  it("fase 07: a simulação não altera nada", () => {
    const antes = sh("md5sum /etc/login.defs; stat -c %a /etc/crontab").out;
    const r = sh("bash /opt/h/07-extra.sh --dry-run");
    expect(r.code).toBe(0);
    expect(r.out).toContain("[dry-run]");
    expect(sh("md5sum /etc/login.defs; stat -c %a /etc/crontab").out).toBe(antes);
    expect(sh("test -e /etc/modprobe.d/99-paas-hardening.conf").code).not.toBe(0);
  });

  it("fase 07 aplica as recomendações e o rollback devolve tudo ao que era", () => {
    const umaskAntes = sh("grep -E '^UMASK' /etc/login.defs").out.trim();
    const issueAntes = sh("cat /etc/issue").out;

    const r = sh("bash /opt/h/07-extra.sh");
    expect(r.code, r.out).toBe(0);
    expect(sh("grep -E '^UMASK' /etc/login.defs").out.trim()).toBe("UMASK 027");
    expect(sh("grep -E '^PASS_MIN_DAYS' /etc/login.defs").out.trim()).toBe("PASS_MIN_DAYS 1");
    expect(sh("grep -E '^PASS_MAX_DAYS' /etc/login.defs").out.trim()).toBe("PASS_MAX_DAYS\t99999"); // intocado
    // o Lynis (NETW-3200) só reconhece o bloqueio na forma exata "install <protocolo> /bin/true"
    const modprobe = sh("cat /etc/modprobe.d/99-paas-hardening.conf").out;
    for (const p of ["dccp", "sctp", "rds", "tipc", "usb-storage"]) expect(modprobe).toContain(`install ${p} /bin/true`);
    expect(modprobe).not.toMatch(/^install .* \/bin\/false$/m);
    expect(sh("cat /etc/security/limits.d/99-paas-nocore.conf").out).toContain("* hard core 0");
    expect(sh("cat /etc/issue.net").out).toContain("Authorized access only");
    expect(sh("stat -c %a /etc/crontab").out.trim()).toBe("600");
    expect(sh("stat -c %a /etc/cron.d").out.trim()).toBe("700");
    for (const pkg of ["libpam-tmpdir", "debsums", "apt-show-versions", "acct", "sysstat", "libpam-pwquality", "apt-listchanges"]) {
      expect(sh(`dpkg -s ${pkg} >/dev/null && echo ok`).out.trim(), pkg).toBe("ok");
    }

    const back = sh("bash /opt/h/07-extra.sh --rollback");
    expect(back.code, back.out).toBe(0);
    expect(sh("grep -E '^UMASK' /etc/login.defs").out.trim()).toBe(umaskAntes);
    expect(sh("cat /etc/issue").out).toBe(issueAntes);
    expect(sh("test -e /etc/modprobe.d/99-paas-hardening.conf").code).not.toBe(0);
    expect(sh("test -e /etc/sysctl.d/99-paas-extra.conf").code).not.toBe(0);
    expect(sh("stat -c %a /etc/crontab").out.trim()).toBe("644");
    expect(sh("stat -c %a /etc/cron.d").out.trim()).toBe("755");
  }, 400_000);
});
