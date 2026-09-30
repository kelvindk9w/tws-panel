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

  it("fase 02 com --no-tunnel (acesso por HTTPS) fecha também o encaminhamento local", () => {
    const r = sh("bash /opt/h/02-ssh.sh --dry-run --user kelvin --no-tunnel");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("AllowTcpForwarding no");
    expect(r.out).not.toContain("AllowTcpForwarding local");
  });

  /**
   * Validação real: todo comando apt mostrava "N: Ignoring file
   * '20auto-upgrades.paas-backup.…' in directory '/etc/apt/apt.conf.d/'" — a
   * cópia de segurança ficava DENTRO da pasta que o apt lê. Arquivos de pastas
   * "*.d" passam a ter a cópia em /var/backups/paas, espelhando o caminho.
   */
  it("cópia de segurança de arquivo em pasta *.d fica fora dela, e o desfazer a encontra", () => {
    const r = sh(
      [
        "set -e",
        "source /opt/h/lib.sh",
        "printf '// original\\n' > /etc/apt/apt.conf.d/20teste",
        "backup_file /etc/apt/apt.conf.d/20teste",
        "printf '// alterado\\n' > /etc/apt/apt.conf.d/20teste",
        "restore_latest_backup /etc/apt/apt.conf.d/20teste",
        "cat /etc/apt/apt.conf.d/20teste",
      ].join("; "),
    );
    expect(r.code, r.out).toBe(0);
    expect(r.out.trim().split("\n").at(-1)).toBe("// original");
    sh("rm -f /etc/apt/apt.conf.d/20teste");
    expect(sh("ls /etc/apt/apt.conf.d | grep paas-backup").out).toBe("");
    expect(sh("ls /var/backups/paas/etc/apt/apt.conf.d/").out).toMatch(/20teste\.paas-backup\./);
  });

  it("cópias antigas deixadas dentro de pastas *.d são movidas e continuam restauráveis", () => {
    const r = sh(
      [
        "set -e",
        "printf '// antigo\\n' > /etc/apt/apt.conf.d/20legado.paas-backup.20260101-000000",
        "printf '// atual\\n' > /etc/apt/apt.conf.d/20legado",
        "source /opt/h/lib.sh",
        "restore_latest_backup /etc/apt/apt.conf.d/20legado",
        "cat /etc/apt/apt.conf.d/20legado",
      ].join("; "),
    );
    expect(r.code, r.out).toBe(0);
    expect(r.out.trim().split("\n").at(-1)).toBe("// antigo");
    expect(sh("ls /etc/apt/apt.conf.d | grep paas-backup").out).toBe("");
    expect(sh("test -f /var/backups/paas/etc/apt/apt.conf.d/20legado.paas-backup.20260101-000000").code).toBe(0);
    expect(sh("apt-get check 2>&1 | grep -c 'Ignoring file' || true").out.trim()).toBe("0");
    sh("rm -f /etc/apt/apt.conf.d/20legado");
  });

  it("fase 02 com --user bloqueia o root e restringe quem entra por SSH", () => {
    const r = sh("bash /opt/h/02-ssh.sh --dry-run --user kelvin");
    expect(r.out).toContain("PermitRootLogin no");
    expect(r.out).toContain("AllowUsers kelvin");
    expect(r.out).not.toContain("sem --user");
  });

  /**
   * Validação real (Contabo): a imagem vem com /etc/ssh/sshd_config.d/
   * 50-cloud-init.conf dizendo "PasswordAuthentication yes". No sshd vale o
   * PRIMEIRO valor encontrado, em ordem alfabética: o nosso 99-paas-hardening
   * perdia — a fase dizia "concluída", o login por senha seguia ligado, o
   * check seguia crítico e a fase voltava ao plano em círculo.
   */
  it("fase 02 vence o 50-cloud-init.conf da imagem: o login por senha fica desligado de fato", () => {
    const setup = sh(
      [
        "set -e",
        "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server >/dev/null",
        "ssh-keygen -A >/dev/null",
        "mkdir -p /run/sshd /etc/ssh/sshd_config.d",
        "printf 'PasswordAuthentication yes\\n' > /etc/ssh/sshd_config.d/50-cloud-init.conf",
        // instalação anterior do painel, com o nome antigo do arquivo
        "printf '# antigo\\nPasswordAuthentication no\\n' > /etc/ssh/sshd_config.d/99-paas-hardening.conf",
      ].join(" && "),
    );
    expect(setup.code, setup.out).toBe(0);

    const r = sh("PAAS_ROLLBACK_DELAY=300 bash /opt/h/02-ssh.sh --user kelvin");
    expect(r.code, r.out).toBe(0);
    expect(sh("sshd -T 2>/dev/null | grep -i '^passwordauthentication'").out.trim()).toBe("passwordauthentication no");
    expect(sh("sshd -T 2>/dev/null | grep -i '^allowusers'").out.trim()).toBe("allowusers kelvin");
    expect(sh("test -e /etc/ssh/sshd_config.d/40-paas-hardening.conf").code).toBe(0);
    expect(sh("test -e /etc/ssh/sshd_config.d/99-paas-hardening.conf").code).not.toBe(0); // nome antigo sai

    // desfazer: volta exatamente ao que era (inclusive o arquivo antigo)
    const back = sh("bash /opt/h/02-ssh.sh --rollback");
    expect(back.code, back.out).toBe(0);
    expect(sh("test -e /etc/ssh/sshd_config.d/40-paas-hardening.conf").code).not.toBe(0);
    expect(sh("cat /etc/ssh/sshd_config.d/99-paas-hardening.conf").out).toContain("# antigo");
  }, 300_000);

  /**
   * Achado grave (validação dos testes acima): o desfazer da fase 02 chamava
   * a restauração "sem backup → apaga" também no /etc/ssh/sshd_config, que a
   * fase nunca copia — o SSH perdia o arquivo principal e não subiria no
   * próximo reinício (operador trancado para fora).
   */
  it("desfazer da fase 02 NUNCA apaga o /etc/ssh/sshd_config", () => {
    expect(sh("test -f /etc/ssh/sshd_config").code).toBe(0);
    const back = sh("bash /opt/h/02-ssh.sh --rollback");
    expect(back.code, back.out).toBe(0);
    expect(sh("test -f /etc/ssh/sshd_config").code).toBe(0);
    expect(sh("sshd -t").code).toBe(0);
  });

  it("fase 02: se outro arquivo continuar vencendo, a fase FALHA dizendo qual (não diz 'concluída' sem efeito)", () => {
    sh("rm -f /etc/ssh/sshd_config.d/99-paas-hardening.conf; printf 'PasswordAuthentication yes\\n' > /etc/ssh/sshd_config.d/10-local-override.conf");
    const r = sh("PAAS_ROLLBACK_DELAY=300 bash /opt/h/02-ssh.sh --user kelvin");
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/PasswordAuthentication.*10-local-override\.conf/s);
    sh("bash /opt/h/02-ssh.sh --rollback; rm -f /etc/ssh/sshd_config.d/10-local-override.conf");
  }, 300_000);

  /**
   * Trocar de HTTPS para túnel (instalador com --acesso=tunel) depois de a
   * fase 02 ter fechado o encaminhamento: sem reabrir, o túnel seria recusado
   * e o painel ficaria inacessível. O instalador chama --reopen-tunnel.
   */
  it("--reopen-tunnel volta o encaminhamento para local, e não mexe em nada sem a fase aplicada", () => {
    const aplicada = sh("PAAS_ROLLBACK_DELAY=300 bash /opt/h/02-ssh.sh --user kelvin --no-tunnel && bash /opt/h/02-ssh.sh --confirm");
    expect(aplicada.code, aplicada.out).toBe(0);
    expect(sh("sshd -T 2>/dev/null | grep -i '^allowtcpforwarding'").out.trim()).toBe("allowtcpforwarding no");

    const r = sh("bash /opt/h/02-ssh.sh --reopen-tunnel");
    expect(r.code, r.out).toBe(0);
    expect(sh("sshd -T 2>/dev/null | grep -i '^allowtcpforwarding'").out.trim()).toBe("allowtcpforwarding local");
    expect(sh("grep -c '^AllowUsers kelvin' /etc/ssh/sshd_config.d/40-paas-hardening.conf").out.trim()).toBe("1");

    sh("bash /opt/h/02-ssh.sh --rollback");
    const semFase = sh("bash /opt/h/02-ssh.sh --reopen-tunnel");
    expect(semFase.code, semFase.out).toBe(0);
    expect(sh("test -e /etc/ssh/sshd_config.d/40-paas-hardening.conf").code).not.toBe(0);
  }, 300_000);

  it("desfazer da fase 07 sem aplicação anterior NUNCA apaga arquivos do sistema", () => {
    // container limpo desta fase: sem nenhum backup da 07 ainda
    const antes = sh("md5sum /etc/login.defs /etc/issue").out;
    const back = sh("bash /opt/h/07-extra.sh --rollback");
    expect(back.code, back.out).toBe(0);
    expect(sh("md5sum /etc/login.defs /etc/issue").out).toBe(antes);
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
