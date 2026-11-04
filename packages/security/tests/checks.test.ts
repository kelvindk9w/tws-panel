/**
 * Testes dos avaliadores dos checks de segurança (checks.ts): cada avaliador
 * recebe a saída bruta do comando (sshd -T, ufw status, ss -tuln, etc.) e
 * decide pass/fail/unknown. Os testes alimentam outputs realistas e verificam
 * o RESULTADO da avaliação — incluindo os casos "desconhecido" que não podem
 * ser confundidos com pass.
 */
import { describe, expect, it } from "vitest";
import { parseSudoUsers, SECURITY_CHECKS } from "../src/checks.js";
import type { ExecResult } from "../src/runner.js";

function exec(stdout: string, code = 0): ExecResult {
  return { code, stdout, stderr: "" };
}

function check(id: string) {
  const def = SECURITY_CHECKS.find((c) => c.id === id);
  if (!def) throw new Error(`check não encontrado: ${id}`);
  return def;
}

describe("estrutura do catálogo", () => {
  it("todos os checks têm id único, fase válida e comando fixo", () => {
    const ids = SECURITY_CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of SECURITY_CHECKS) {
      expect(c.phase).toMatch(/^0[0-7]$/);
      expect(c.command.length).toBeGreaterThan(0);
    }
  });
});

describe("sshd -T (fase 02)", () => {
  it("ssh.root-login: passa com no/prohibit-password/without-password", () => {
    const c = check("ssh.root-login");
    for (const v of ["no", "prohibit-password", "without-password", "forced-commands-only"]) {
      expect(c.evaluate(exec(`${v}\n`)).status, v).toBe("pass");
    }
  });

  it("ssh.root-login: falha com yes (root exposto por SSH)", () => {
    const result = check("ssh.root-login").evaluate(exec("yes\n"));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("yes");
  });

  it("ssh.root-login: saída vazia → unknown, nunca pass", () => {
    expect(check("ssh.root-login").evaluate(exec("")).status).toBe("unknown");
  });

  it("ssh.password-auth: só 'no' passa", () => {
    const c = check("ssh.password-auth");
    expect(c.evaluate(exec("no\n")).status).toBe("pass");
    expect(c.evaluate(exec("yes\n")).status).toBe("fail");
    expect(c.evaluate(exec("")).status).toBe("unknown");
  });

  it("ssh.max-auth-tries: ≤ 3 passa; acima falha com o valor no detalhe", () => {
    const c = check("ssh.max-auth-tries");
    expect(c.evaluate(exec("3\n")).status).toBe("pass");
    expect(c.evaluate(exec("1\n")).status).toBe("pass");
    const fail = c.evaluate(exec("6\n"));
    expect(fail.status).toBe("fail");
    expect(fail.detail).toContain("6");
    expect(c.evaluate(exec("abc\n")).status).toBe("unknown");
  });

  it("ssh.forwarding-disabled: qualquer forwarding=yes falha; tudo no passa", () => {
    const c = check("ssh.forwarding-disabled");
    expect(
      c.evaluate(exec("x11forwarding=no allowagentforwarding=no allowtcpforwarding=no ")).status,
    ).toBe("pass");
    expect(
      c.evaluate(exec("x11forwarding=no allowagentforwarding=no allowtcpforwarding=yes ")).status,
    ).toBe("fail");
    expect(c.evaluate(exec("")).status).toBe("unknown");
  });
});

describe("ufw (fase 03)", () => {
  it("firewall.ufw-active: active passa, inactive falha, ausente é unknown", () => {
    const c = check("firewall.ufw-active");
    expect(c.evaluate(exec("Status: active\n")).status).toBe("pass");
    expect(c.evaluate(exec("Status: inactive\n")).status).toBe("fail");
    expect(c.evaluate(exec("")).status).toBe("unknown");
  });

  it("firewall.default-deny: só 'deny (incoming)' passa", () => {
    const c = check("firewall.default-deny");
    expect(
      c.evaluate(exec("Default: deny (incoming), allow (outgoing), disabled (routed)\n")).status,
    ).toBe("pass");
    expect(
      c.evaluate(exec("Default: allow (incoming), allow (outgoing), disabled (routed)\n")).status,
    ).toBe("fail");
    expect(c.evaluate(exec("")).status).toBe("unknown");
  });
});

describe("ss -tuln (fase 03)", () => {
  it("net.db-ports-exposed: porta de banco em 0.0.0.0 falha com a linha como evidência", () => {
    const line = "tcp   LISTEN 0      244          0.0.0.0:5432       0.0.0.0:*";
    const result = check("net.db-ports-exposed").evaluate(exec(`${line}\n`));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("5432");
  });

  it("net.db-ports-exposed: saída vazia (grep sem match) passa", () => {
    expect(check("net.db-ports-exposed").evaluate(exec("")).status).toBe("pass");
  });

  it("net.docker-api-exposed: 2375 aberta falha (root remoto no host)", () => {
    const line = "tcp   LISTEN 0      4096         0.0.0.0:2375       0.0.0.0:*";
    expect(check("net.docker-api-exposed").evaluate(exec(`${line}\n`)).status).toBe("fail");
    expect(check("net.docker-api-exposed").evaluate(exec("")).status).toBe("pass");
  });

  it("net.listening-inventory: sempre pass e preserva o inventário no detalhe", () => {
    const result = check("net.listening-inventory").evaluate(exec("0.0.0.0:22 0.0.0.0:80 "));
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("0.0.0.0:22");
    // saída vazia → detalhe explicativo (nunca vazio)
    expect(check("net.listening-inventory").evaluate(exec("")).detail).toBe("nenhuma porta em escuta");
  });

  it("net.sysctl-hardening: exige syncookies=1 E drop-in presente", () => {
    const c = check("net.sysctl-hardening");
    expect(c.evaluate(exec("syncookies=1\ndropin=present\n")).status).toBe("pass");
    expect(c.evaluate(exec("syncookies=1\ndropin=absent\n")).status).toBe("fail");
    expect(c.evaluate(exec("syncookies=0\ndropin=present\n")).status).toBe("fail");
  });
});

describe("usuários (fase 01)", () => {
  it("user.only-root-uid0: UID 0 extra é backdoor → fail com o nome", () => {
    const c = check("user.only-root-uid0");
    expect(c.evaluate(exec("root\n")).status).toBe("pass");
    const fail = c.evaluate(exec("root\nhaxor\n"));
    expect(fail.status).toBe("fail");
    expect(fail.detail).toContain("haxor");
  });

  it("user.root-password-locked: ! ou * passa; hash ativo falha; sem leitura → unknown", () => {
    const c = check("user.root-password-locked");
    expect(c.evaluate(exec("!\n")).status).toBe("pass");
    expect(c.evaluate(exec("*\n")).status).toBe("pass");
    expect(c.evaluate(exec("$6$abc\n")).status).toBe("fail");
    expect(c.evaluate(exec("")).status).toBe("unknown");
  });

  it("user.non-root-sudo: uid ≥ 1000 passa; vazio falha", () => {
    const c = check("user.non-root-sudo");
    expect(c.evaluate(exec("sudo-user deploy 1000\n")).status).toBe("pass");
    expect(c.evaluate(exec("")).status).toBe("fail");
  });

  it("user.non-root-sudo: cita o nome do usuário detectado no detalhe", () => {
    const r = check("user.non-root-sudo").evaluate(exec("sudo-user kelvin 1001\n"));
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("kelvin");
    expect(r.detail).toContain("1001");
  });

  it("user.non-root-sudo: detecta vários usuários, na ordem da saída", () => {
    const out = "sudo-user deploy 1000\nsudo-user kelvin 1001\n";
    const r = check("user.non-root-sudo").evaluate(exec(out));
    expect(r.status).toBe("pass");
    expect(r.detail?.indexOf("deploy")).toBeLessThan(r.detail?.indexOf("kelvin") ?? -1);
  });

  it("user.non-root-sudo: uid de sistema (< 1000) não conta como usuário comum", () => {
    expect(check("user.non-root-sudo").evaluate(exec("sudo-user daemon 1\n")).status).toBe("fail");
  });

  it("user.non-root-sudo: saída malformada → fail, sem exceção", () => {
    const c = check("user.non-root-sudo");
    expect(c.evaluate(exec("getent: comando nao encontrado\n")).status).toBe("fail");
    expect(c.evaluate(exec("sudo-user\n")).status).toBe("fail");
    expect(c.evaluate(exec("1000\n")).status).toBe("fail");
  });
});

describe("parseSudoUsers (fase 01)", () => {
  /**
   * A Fase 01 só trava a senha do root se o usuário tiver chave E senha: a
   * tela precisa mostrar esse estado ANTES de a pessoa aplicar. O check emite
   * "sudo-user <nome> <uid> <estado da senha> <nº de chaves>".
   */
  it("lê o estado da senha (P = utilizável) e o número de chaves SSH", () => {
    expect(parseSudoUsers("sudo-user kelvin 1001 P 2\nsudo-user novo 1002 L 1\nsudo-user ana 1003 NP 0\n")).toEqual([
      { name: "kelvin", uid: 1001, hasPassword: true, keyCount: 2 },
      { name: "novo", uid: 1002, hasPassword: false, keyCount: 1 },
      { name: "ana", uid: 1003, hasPassword: false, keyCount: 0 },
    ]);
  });

  it("estado desconhecido (?) ou nº de chaves ilegível: o dado fica ausente, nunca inventado", () => {
    expect(parseSudoUsers("sudo-user kelvin 1001 ? x\n")).toEqual([{ name: "kelvin", uid: 1001 }]);
  });

  it("extrai nome e uid de cada linha bem formada", () => {
    expect(parseSudoUsers("sudo-user deploy 1000\nsudo-user kelvin 1001\n")).toEqual([
      { name: "deploy", uid: 1000 },
      { name: "kelvin", uid: 1001 },
    ]);
  });

  it("ignora ruído do PTY e linhas fora do formato", () => {
    const out = "Welcome to Ubuntu\nsudo-user deploy 1000\nlixo qualquer\n";
    expect(parseSudoUsers(out)).toEqual([{ name: "deploy", uid: 1000 }]);
  });

  it("descarta uid < 1000 e saída vazia", () => {
    expect(parseSudoUsers("sudo-user daemon 1\n")).toEqual([]);
    expect(parseSudoUsers("")).toEqual([]);
  });

  it("descarta nomes que não são nome de usuário válido", () => {
    const out = "sudo-user ../etc 1000\nsudo-user root 1000\nsudo-user deploy 1000\n";
    expect(parseSudoUsers(out)).toEqual([{ name: "deploy", uid: 1000 }]);
  });
});

describe("atualizações (fase 00)", () => {
  it("update.pending-packages: 0 passa; N falha com a contagem", () => {
    const c = check("update.pending-packages");
    expect(c.evaluate(exec("0\n")).status).toBe("pass");
    const fail = c.evaluate(exec("42\n"));
    expect(fail.status).toBe("fail");
    expect(fail.detail).toContain("42");
    expect(c.evaluate(exec("listando...\n")).status).toBe("unknown");
  });

  it("update.unattended-upgrades: exit code decide (0 = ativado)", () => {
    const c = check("update.unattended-upgrades");
    expect(c.evaluate(exec("", 0)).status).toBe("pass");
    expect(c.evaluate(exec("", 1)).status).toBe("fail");
  });

  it("supplychain.third-party-repos: sempre pass, listando os arquivos quando existem", () => {
    const c = check("supplychain.third-party-repos");
    const nenhum = c.evaluate(exec("0\n"));
    expect(nenhum.status).toBe("pass");
    expect(nenhum.detail).toContain("nenhum");

    const comRepos = c.evaluate(exec("2\ndocker.list\nnodesource.list\n"));
    expect(comRepos.status).toBe("pass");
    expect(comRepos.detail).toContain("2 arquivo(s)");
    expect(comRepos.detail).toContain("docker.list");
    expect(comRepos.detail).toContain("nodesource.list");

    // saída vazia (ls falhou) → conta como 0, sem lançar
    expect(c.evaluate(exec("")).detail).toContain("nenhum");
  });
});

describe("intrusão, minimização e auditoria (fases 04–06)", () => {
  it("intrusion.fail2ban: pong passa; instalado-parado e ausente falham", () => {
    const c = check("intrusion.fail2ban");
    expect(c.evaluate(exec("Server replied: pong\n")).status).toBe("pass");
    expect(c.evaluate(exec("installed-not-running\n")).status).toBe("fail");
    expect(c.evaluate(exec("absent\n")).status).toBe("fail");
  });

  it("intrusion.apparmor: Y passa; indisponível (container) → unknown", () => {
    const c = check("intrusion.apparmor");
    expect(c.evaluate(exec("Y\n")).status).toBe("pass");
    expect(c.evaluate(exec("unavailable\n")).status).toBe("unknown");
    expect(c.evaluate(exec("N\n")).status).toBe("fail");
  });

  it("minimal.snapd-absent / audit.auditd / audit.aide-baseline / audit.rkhunter / audit.recurring-scan", () => {
    expect(check("minimal.snapd-absent").evaluate(exec("absent\n")).status).toBe("pass");
    expect(check("minimal.snapd-absent").evaluate(exec("installed\n")).status).toBe("fail");
    expect(check("audit.auditd").evaluate(exec("installed\n")).status).toBe("pass");
    expect(check("audit.auditd").evaluate(exec("absent\n")).status).toBe("fail");
    expect(check("audit.aide-baseline").evaluate(exec("present\n")).status).toBe("pass");
    expect(check("audit.aide-baseline").evaluate(exec("absent\n")).status).toBe("fail");
    expect(check("audit.rkhunter").evaluate(exec("present\n")).status).toBe("pass");
    expect(check("audit.rkhunter").evaluate(exec("absent\n")).status).toBe("fail");
    expect(check("audit.recurring-scan").evaluate(exec("present\n")).status).toBe("pass");
    expect(check("audit.recurring-scan").evaluate(exec("absent\n")).status).toBe("fail");
  });

  // Falso-positivo real: `dpkg -s <pkg>` retorna 0 até para pacote em estado
  // "rc" (removido, só restam configs) — o check minimal.snapd-absent
  // reportava "snapd instalado" logo após o purge da fase 05. O gate correto
  // é o Status-Abbrev do dpkg-query: só "ii " = instalado ("rc "/"un " =
  // ausente). Comandos validados em container ubuntu:24.04 real:
  //   ii  → dpkg -s: exit 0, gate ^ii : instalado   (correto)
  //   rc  → dpkg -s: exit 0 (FALSO-POSITIVO), gate ^ii : ausente (correto)
  it("checks de pacote NÃO usam `dpkg -s` (aceita estado rc): gate é dpkg-query Status-Abbrev ^ii", () => {
    for (const c of SECURITY_CHECKS) {
      expect(c.command, c.id).not.toMatch(/dpkg -s\b/);
    }
    // todos os checks que testam pacote instalado passam pelo gate "ii "
    const pkgChecks = [
      "update.unattended-upgrades",
      "intrusion.fail2ban",
      "minimal.snapd-absent",
      "minimal.legacy-clients",
      "audit.auditd",
    ];
    for (const id of pkgChecks) {
      const cmd = check(id).command;
      expect(cmd, id).toContain("dpkg-query -W -f='${db:Status-Abbrev}'");
      expect(cmd, id).toContain("grep -q '^ii '");
    }
  });

  it("minimal.unnecessary-services: qualquer serviço listado falha com evidência", () => {
    const c = check("minimal.unnecessary-services");
    expect(c.evaluate(exec("")).status).toBe("pass");
    const fail = c.evaluate(exec("cups.service loaded active running\n"));
    expect(fail.status).toBe("fail");
    expect(fail.detail).toContain("cups");
  });

  it("minimal.legacy-clients: telnet instalado falha", () => {
    const c = check("minimal.legacy-clients");
    expect(c.evaluate(exec("")).status).toBe("pass");
    expect(c.evaluate(exec("telnet\n")).status).toBe("fail");
  });
});

describe("docker (checks manuais)", () => {
  it("docker.privileged-containers: container com 'true' falha; sem docker → unknown", () => {
    const c = check("docker.privileged-containers");
    expect(c.evaluate(exec("no-docker\n")).status).toBe("unknown");
    expect(c.evaluate(exec("/app false\n/db false\n")).status).toBe("pass");
    const fail = c.evaluate(exec("/app false\n/evil true\n"));
    expect(fail.status).toBe("fail");
    expect(fail.detail).toContain("evil");
  });

  it("docker.sock-mounted: qualquer mount do socket falha (root no host)", () => {
    const c = check("docker.sock-mounted");
    expect(c.evaluate(exec("no-docker\n")).status).toBe("unknown");
    const fail = c.evaluate(exec("/portainer /var/run/docker.sock \n"));
    expect(fail.status).toBe("fail");
    expect(fail.detail).toContain("docker.sock");
  });

  /**
   * O painel PRECISA do socket (deploys) e dos helpers privilegiados (terminal
   * e host bridge via nsenter): marcá-los como "crítico pendente" para sempre
   * assustava o operador sem ação possível. Eles viram risco aceito, explicado;
   * qualquer OUTRO container continua reprovando.
   */
  it("docker.privileged-containers: helpers do próprio painel são risco aceito, os demais reprovam", () => {
    const c = check("docker.privileged-containers");
    const own = c.evaluate(exec("/paas-terminal-4b165899 true\n/paas-host-exec-0a1b2c3d true\n/tws-panel false\n"));
    expect(own.status).toBe("pass");
    expect(own.detail).toMatch(/aceito por design/);
    const mixed = c.evaluate(exec("/paas-terminal-4b165899 true\n/evil true\n"));
    expect(mixed.status).toBe("fail");
    expect(mixed.detail).toContain("evil");
    expect(mixed.detail).not.toContain("paas-terminal");
    // nome parecido não passa por helper do painel
    expect(c.evaluate(exec("/paas-terminal-custom true\n")).status).toBe("fail");
  });

  it("docker.sock-mounted: o socket no container do painel é risco aceito; em outro, reprova", () => {
    const c = check("docker.sock-mounted");
    const own = c.evaluate(exec("/tws-panel /var/lib/docker/volumes/paas_data/_data /var/run/docker.sock \n"));
    expect(own.status).toBe("pass");
    expect(own.detail).toMatch(/aceito por design/);
    const other = c.evaluate(exec("/tws-panel /var/run/docker.sock \n/portainer /var/run/docker.sock \n"));
    expect(other.status).toBe("fail");
    expect(other.detail).toContain("portainer");
  });

  it("fase 07: login.defs, kernel, core dump e contabilidade", () => {
    const umask = check("extra.login-defs");
    expect(umask.phase).toBe("07");
    expect(umask.evaluate(exec("UMASK 027\n")).status).toBe("pass");
    expect(umask.evaluate(exec("UMASK 022\n")).status).toBe("fail");
    expect(umask.evaluate(exec("")).status).toBe("fail");
    const kernel = check("extra.kernel-hardening");
    expect(kernel.evaluate(exec("modprobe=present sysctl=present\n")).status).toBe("pass");
    expect(kernel.evaluate(exec("modprobe=absent sysctl=present\n")).status).toBe("fail");
    // arquivo da versão anterior (/bin/false): o Lynis não reconhece — a fase precisa rodar de novo
    expect(kernel.evaluate(exec("modprobe=outdated sysctl=present\n")).status).toBe("fail");
    expect(kernel.command).toContain("install dccp /bin/true");
    const listchanges = check("extra.apt-listchanges");
    expect(listchanges.phase).toBe("07");
    expect(listchanges.evaluate(exec("installed\n")).status).toBe("pass");
    expect(listchanges.evaluate(exec("absent\n")).status).toBe("fail");
    const core = check("extra.core-dumps");
    expect(core.evaluate(exec("present\n")).status).toBe("pass");
    expect(core.evaluate(exec("absent\n")).status).toBe("fail");
    expect(kernel.evaluate(exec("")).detail).toBe("sem leitura");
    const acct = check("extra.accounting");
    expect(acct.evaluate(exec("acct sysstat\n")).status).toBe("pass");
    expect(acct.evaluate(exec("acct\n")).status).toBe("fail");
    expect(acct.evaluate(exec("\n")).detail).toBe("instalados: nenhum");
  });
});
