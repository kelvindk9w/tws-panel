/**
 * phase03-04-scripts.test.ts — fases 03 (firewall) e 04 (fail2ban) e helpers
 * do lib.sh rodando DE VERDADE num Ubuntu 24.04 descartável (container com
 * NET_ADMIN, para o UFW poder ser ativado dentro dele).
 *
 * Achados da revisão cobertos aqui:
 *  - 23: reaplicar uma fase enquanto a anterior aguarda confirmação
 *    sobrescrevia o backup e a reversão agendada dela;
 *  - 24: o firewall presumia o SSH na porta 22 — com o sshd em 2222, ativava
 *    "deny incoming" liberando só a 22 e trancava novas conexões;
 *  - 25: pacote removido sem purge (estado "rc") era visto como instalado e
 *    não era reinstalado;
 *  - 26: com o fail2ban já rodando (o pacote sobe o serviço ao instalar), as
 *    jails novas do jail.local não entravam em vigor.
 */
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const IMAGE = "ubuntu:24.04";
const CONTAINER = `paas-fase03-04-test-${process.pid}`;
const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/hardening");

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

/** Sobe o sshd escutando nas portas dadas (sem systemd: processo direto). */
function startSshd(ports: number[]): void {
  const r = sh(
    [
      "pkill -x sshd || true",
      "sleep 0.5",
      "mkdir -p /run/sshd",
      `printf '${ports.map((p) => `Port ${p}`).join("\\n")}\\n' > /etc/ssh/sshd_config.d/10-porta-teste.conf`,
      "/usr/sbin/sshd",
      "sleep 0.5",
    ].join("; "),
  );
  if (r.code !== 0) throw new Error(`sshd não subiu:\n${r.out}`);
}

/** Desfaz a fase 03 e zera o UFW (cada teste começa de um firewall desligado). */
function resetFirewall(): void {
  sh("bash /opt/h/03-firewall.sh --rollback >/dev/null 2>&1; ufw --force reset >/dev/null 2>&1; true");
  sh("rm -f /etc/paas/pending-rollback-*; pkill -f '^sleep 600$' || true");
}

describe.skipIf(!HAS_DOCKER)("fases 03/04 e lib.sh num Ubuntu real", { timeout: 400_000 }, () => {
  beforeAll(() => {
    const present = spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0;
    if (!present) execFileSync("docker", ["pull", "--quiet", IMAGE], { stdio: "ignore", timeout: 180_000 });
    execFileSync(
      "docker",
      [
        "run",
        "-d",
        "--rm",
        "--cap-add",
        "NET_ADMIN",
        "--name",
        CONTAINER,
        "-v",
        `${SCRIPTS}:/opt/h:ro`,
        IMAGE,
        "sleep",
        "infinity",
      ],
      { stdio: "ignore", timeout: 60_000 },
    );
    const setup = sh(
      [
        "set -e",
        "apt-get update -qq >/dev/null",
        "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ufw fail2ban openssh-server iproute2 >/dev/null",
        "ssh-keygen -A >/dev/null",
      ].join(" && "),
      600_000,
    );
    if (setup.code !== 0) throw new Error(`preparo do container falhou:\n${setup.out}`);
  }, 700_000);

  afterAll(() => {
    spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  });

  // -------------------------------------------------------------- achado 25
  describe("pacote em estado 'rc' (removido sem purge) — achado 25", () => {
    it("pkg_installed só conta o estado 'ii'", () => {
      const r = sh(
        [
          "DEBIAN_FRONTEND=noninteractive apt-get remove -y -qq ufw >/dev/null 2>&1",
          "dpkg-query -W -f='${db:Status-Abbrev}\\n' ufw",
          "source /opt/h/lib.sh",
          "pkg_installed ufw && echo VISTO-COMO-INSTALADO || echo VISTO-COMO-AUSENTE",
        ].join("; "),
      );
      expect(r.out).toMatch(/^rc/m);
      expect(r.out).toContain("VISTO-COMO-AUSENTE");
      sh("DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ufw >/dev/null 2>&1");
    });

    it("apt_install reinstala o pacote que estava em 'rc'", () => {
      const r = sh(
        [
          "DEBIAN_FRONTEND=noninteractive apt-get remove -y -qq ufw >/dev/null 2>&1",
          "source /opt/h/lib.sh",
          "apt_install ufw >/dev/null 2>&1",
          "dpkg-query -W -f='${db:Status-Abbrev}\\n' ufw",
          "command -v ufw",
        ].join("; "),
        300_000,
      );
      expect(r.out).toMatch(/^ii/m);
      expect(r.out).toContain("/ufw");
      sh("DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ufw >/dev/null 2>&1");
    });
  });

  // -------------------------------------------------------------- achado 24
  describe("porta real do SSH no firewall — achado 24", () => {
    it("detect_ssh_ports encontra a porta configurada e a que está escutando", () => {
      startSshd([2222]);
      const r = sh("source /opt/h/lib.sh; detect_ssh_ports");
      expect(r.out.trim().split(/\s+/)).toEqual(["2222"]);
    });

    it("simulação: libera a porta real (2222) do sshd, não a 22", () => {
      startSshd([2222]);
      const r = sh("bash /opt/h/03-firewall.sh --dry-run");
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("ufw allow 2222/tcp");
      expect(r.out).not.toContain("ufw allow 22/tcp");
    });

    it("de verdade: com o sshd em 2222, o UFW ativo libera a 2222 antes de bloquear o resto", () => {
      resetFirewall();
      startSshd([2222]);
      const r = sh("PAAS_ROLLBACK_DELAY=600 bash /opt/h/03-firewall.sh");
      expect(r.code, r.out).toBe(0);
      const status = sh("ufw status").out;
      expect(status).toContain("Status: active");
      expect(status).toMatch(/^2222\/tcp\s+ALLOW/m);
      resetFirewall();
    });

    it("sshd em duas portas: libera as duas", () => {
      resetFirewall();
      startSshd([22, 2222]);
      const r = sh("bash /opt/h/03-firewall.sh --dry-run");
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("ufw allow 22/tcp");
      expect(r.out).toContain("ufw allow 2222/tcp");
    });

    it("--ssh-port explícito soma à porta detectada (nunca a substitui)", () => {
      startSshd([2222]);
      const r = sh("bash /opt/h/03-firewall.sh --dry-run --ssh-port 22");
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("ufw allow 22/tcp");
      expect(r.out).toContain("ufw allow 2222/tcp");
    });

    it("sem sshd rodando e sem porta na configuração: cai para a 22", () => {
      const r = sh(
        [
          "pkill -x sshd || true",
          "sleep 0.5",
          "rm -f /etc/ssh/sshd_config.d/10-porta-teste.conf",
          "mv /usr/sbin/sshd /usr/sbin/sshd.off",
          "source /opt/h/lib.sh",
          "detect_ssh_ports",
          "mv /usr/sbin/sshd.off /usr/sbin/sshd",
        ].join("; "),
      );
      expect(r.out.trim().split(/\s+/).at(-1)).toBe("22");
    });

    it("com o UFW já ativo, nenhuma política 'deny' vem antes das regras do SSH", () => {
      startSshd([2222]);
      const r = sh("bash /opt/h/03-firewall.sh --dry-run");
      expect(r.code, r.out).toBe(0);
      const allowSsh = r.out.indexOf("ufw allow 2222/tcp");
      const denyIn = r.out.indexOf("ufw default deny incoming");
      const enable = r.out.indexOf("ufw --force enable");
      expect(allowSsh).toBeGreaterThan(-1);
      expect(denyIn).toBeGreaterThan(allowSsh);
      expect(enable).toBeGreaterThan(denyIn);
    });

    it("soma a porta da sessão atual ($SSH_CONNECTION), mesmo sem sshd ou com sshd -T falhando", () => {
      const r = sh(
        [
          "pkill -x sshd || true",
          "sleep 0.5",
          "rm -f /etc/ssh/sshd_config.d/10-porta-teste.conf",
          "mv /usr/sbin/sshd /usr/sbin/sshd.off",
          "source /opt/h/lib.sh",
          "SSH_CONNECTION='203.0.113.9 51234 10.0.0.5 2200' detect_ssh_ports",
          "mv /usr/sbin/sshd.off /usr/sbin/sshd",
        ].join("; "),
      );
      expect(r.out.trim().split(/\s+/).at(-1)).toBe("2200");
    });

    it("porta da sessão soma às detectadas; valor não numérico ou fora do intervalo é ignorado", () => {
      startSshd([2222]);
      const somada = sh("source /opt/h/lib.sh; SSH_CONNECTION='1.2.3.4 5 6.7.8.9 2200' detect_ssh_ports").out;
      expect(somada.trim().split(/\s+/)).toEqual(["2200", "2222"]);
      for (const ruim of ["1.2.3.4 5 6.7.8.9 abc", "1.2.3.4 5 6.7.8.9 70000", "1.2.3.4 5 6.7.8.9 0", ""]) {
        const out = sh(`source /opt/h/lib.sh; SSH_CONNECTION='${ruim}' detect_ssh_ports`).out;
        expect(out.trim().split(/\s+/), ruim).toEqual(["2222"]);
      }
    });

    it("--ssh-port fora de 1-65535 ou não numérico é recusado nas fases 03 e 04", () => {
      for (const script of ["03-firewall.sh", "04-intrusion.sh"]) {
        for (const ruim of ["0", "70000", "abc", "-5"]) {
          const r = sh(`bash /opt/h/${script} --dry-run --ssh-port ${ruim} 2>&1; echo EXIT=$?`);
          expect(r.out, `${script} ${ruim}`).toContain("EXIT=1");
          expect(r.out, `${script} ${ruim}`).toMatch(/porta (inválida|fora do intervalo)/);
        }
      }
    });

    it("fail2ban (fase 04) vigia a porta real do SSH", () => {
      startSshd([2222]);
      const r = sh("bash /opt/h/04-intrusion.sh --dry-run");
      expect(r.code, r.out).toBe(0);
      expect(r.out).toMatch(/\|\s*port = 2222$/m);
    });
  });

  // -------------------------------------------------------------- achado 23
  describe("reaplicar com a confirmação pendente — achado 23", () => {
    it("fase 03 recusa reaplicar enquanto a reversão agendada anterior está viva, sem mexer em nada", () => {
      resetFirewall();
      startSshd([22]);
      const r = sh(
        [
          "mkdir -p /etc/paas",
          // reversão agendada "viva": o timer em segundo plano ainda não rodou
          "setsid nohup sleep 600 >/dev/null 2>&1 & echo $! > /etc/paas/pending-rollback-firewall.pid",
          "bash /opt/h/03-firewall.sh 2>&1; echo EXIT=$?",
          "ufw status",
        ].join("; "),
      );
      expect(r.out).toContain("EXIT=1");
      expect(r.out).toMatch(/aguardando confirmação/i);
      expect(r.out).toContain("Status: inactive");
      resetFirewall();
    });

    it("reversão agendada que já rodou (processo morto) não bloqueia", () => {
      resetFirewall();
      startSshd([22]);
      const r = sh(
        [
          "mkdir -p /etc/paas",
          "echo 999999 > /etc/paas/pending-rollback-firewall.pid",
          "PAAS_ROLLBACK_DELAY=600 bash /opt/h/03-firewall.sh >/dev/null; echo EXIT=$?",
        ].join("; "),
      );
      expect(r.out).toContain("EXIT=0");
      resetFirewall();
    });

    it("fase 02 também recusa reaplicar com a reversão do SSH pendente", () => {
      const r = sh(
        [
          "mkdir -p /etc/paas",
          // reversão agendada "viva": o timer em segundo plano ainda não rodou
          "setsid nohup sleep 600 >/dev/null 2>&1 & echo $! > /etc/paas/pending-rollback-ssh.pid",
          "bash /opt/h/02-ssh.sh 2>&1; echo EXIT=$?",
          "kill $(cat /etc/paas/pending-rollback-ssh.pid); rm -f /etc/paas/pending-rollback-ssh.pid",
        ].join("; "),
      );
      expect(r.out).toContain("EXIT=1");
      expect(r.out).toMatch(/aguardando confirmação/i);
    });
  });

  // -------------------------------------------------------------- achado 26
  describe("fail2ban já rodando — achado 26", () => {
    it("as jails novas entram em vigor (recidive ativa), não só depois de um reboot", () => {
      startSshd([22]);
      // como o pacote deixa: serviço rodando com a configuração padrão (só sshd)
      const before = sh(
        [
          "rm -f /etc/fail2ban/jail.local",
          "touch /var/log/auth.log",
          "service fail2ban restart >/dev/null 2>&1",
          "sleep 2",
          "fail2ban-client status",
        ].join("; "),
      );
      expect(before.out).toContain("sshd");
      expect(before.out).not.toContain("recidive");

      const r = sh("bash /opt/h/04-intrusion.sh", 400_000);
      expect(r.code, r.out).toBe(0);
      const after = sh("fail2ban-client status").out;
      expect(after).toContain("recidive");
      expect(after).toContain("sshd");
      // a política nova (maxretry 3 no sshd) está valendo no daemon
      expect(sh("fail2ban-client get sshd maxretry").out.trim()).toBe("3");
    });
  });
});
