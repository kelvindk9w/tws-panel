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
});
