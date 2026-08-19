/**
 * checks.ts — checks de segurança somente-leitura (shell de baixo custo).
 * Base: docs/security-research.md §4 (fase 0 inventário) e §6.5.
 *
 * Cada check é um comando FIXO + avaliador. Nada de input externo.
 */
import type { CheckSeverity, SecurityPhaseId } from "@paas/core";
import type { ExecResult } from "./runner.js";

export interface CheckEvaluation {
  status: "pass" | "fail" | "unknown";
  detail?: string;
}

export interface CheckDefinition {
  id: string;
  phase: SecurityPhaseId;
  title: string;
  severity: CheckSeverity;
  description: string;
  /** Texto de remediação exibido no relatório (pt-BR). */
  remediation: string;
  /** false = o check não é corrigido por nenhum script de fase (ação manual). */
  fixable: boolean;
  /** Comando shell FIXO, somente-leitura. Deve retornar exit 0 em qualquer cenário. */
  command: string;
  evaluate: (r: ExecResult) => CheckEvaluation;
}

/** Avaliação simples por exit code: 0 = pass, outro = fail. */
function byExitCode(passDetail?: string): (r: ExecResult) => CheckEvaluation {
  return (r) =>
    r.code === 0
      ? { status: "pass", ...(passDetail !== undefined ? { detail: passDetail } : {}) }
      : { status: "fail" };
}

function firstLine(s: string): string {
  return s.split("\n")[0]?.trim() ?? "";
}

export const SECURITY_CHECKS: CheckDefinition[] = [
  // ------------------------------------------------------------------ Fase 00
  {
    id: "update.pending-packages",
    phase: "00",
    title: "Pacotes com atualização pendente",
    severity: "warning",
    description: "Conta pacotes com updates disponíveis (apt list --upgradable). Sistema desatualizado é o vetor nº 1 de invasão.",
    remediation: "Aplicar a fase 00 (apt update && full-upgrade).",
    fixable: true,
    command: "apt list --upgradable 2>/dev/null | tail -n +2 | wc -l",
    evaluate: (r) => {
      const n = Number.parseInt(firstLine(r.stdout), 10);
      if (Number.isNaN(n)) return { status: "unknown", detail: r.stdout };
      return {
        status: n === 0 ? "pass" : "fail",
        detail: n === 0 ? "sistema atualizado" : `${n} pacote(s) com atualização pendente`,
      };
    },
  },
  {
    id: "update.unattended-upgrades",
    phase: "00",
    title: "Atualizações automáticas de segurança",
    severity: "critical",
    description: "Verifica se unattended-upgrades está instalado e ativado (APT::Periodic::Unattended-Upgrade).",
    remediation: "Aplicar a fase 00 (instala e ativa unattended-upgrades).",
    fixable: true,
    command:
      "dpkg -s unattended-upgrades >/dev/null 2>&1 && grep -q 'Unattended-Upgrade \"1\"' /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null",
    evaluate: byExitCode("unattended-upgrades instalado e ativado"),
  },
  {
    id: "supplychain.third-party-repos",
    phase: "00",
    title: "Repositórios APT de terceiros",
    severity: "info",
    description: "Lista arquivos em /etc/apt/sources.list.d/ — repositórios não-oficiais devem ser revisados (supply chain).",
    remediation: "Revisar manualmente cada repositório e remover os desnecessários.",
    fixable: false,
    command: "ls -1 /etc/apt/sources.list.d/ 2>/dev/null | wc -l && ls -1 /etc/apt/sources.list.d/ 2>/dev/null",
    evaluate: (r) => {
      const lines = r.stdout.split("\n").filter(Boolean);
      const n = Number.parseInt(lines[0] ?? "0", 10);
      return {
        status: "pass",
        detail: n > 0 ? `${n} arquivo(s): ${lines.slice(1).join(", ")}` : "nenhum repositório de terceiros",
      };
    },
  },

  // ------------------------------------------------------------------ Fase 01
  {
    id: "user.only-root-uid0",
    phase: "01",
    title: "Apenas root com UID 0",
    severity: "critical",
    description: "Qualquer conta além de root com UID 0 é backdoor clássico (awk em /etc/passwd).",
    remediation: "Remover/ajustar contas com UID 0 (investigar imediatamente).",
    fixable: false,
    command: "awk -F: '$3 == 0 {print $1}' /etc/passwd",
    evaluate: (r) => {
      const users = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      const extra = users.filter((u) => u !== "root");
      return extra.length === 0
        ? { status: "pass", detail: "apenas root possui UID 0" }
        : { status: "fail", detail: `UID 0 extra: ${extra.join(", ")}` };
    },
  },
  {
    id: "user.root-password-locked",
    phase: "01",
    title: "Senha do root travada",
    severity: "warning",
    description: "Verifica se a senha do root está bloqueada (campo shadow começa com ! ou *).",
    remediation: "Aplicar a fase 01 (passwd -l root) — só após chave SSH do usuário não-root estar testada.",
    fixable: true,
    command: "awk -F: '$1 == \"root\" {print substr($2, 1, 1)}' /etc/shadow 2>/dev/null",
    evaluate: (r) => {
      const c = firstLine(r.stdout);
      if (c === "") return { status: "unknown", detail: "sem leitura de /etc/shadow" };
      return c === "!" || c === "*"
        ? { status: "pass", detail: "senha do root bloqueada" }
        : { status: "fail", detail: "root possui senha ativa" };
    },
  },
  {
    id: "user.non-root-sudo",
    phase: "01",
    title: "Usuário não-root no grupo sudo",
    severity: "critical",
    description: "Verifica se existe ao menos um usuário comum (UID ≥ 1000) no grupo sudo — operar como root é anti-padrão.",
    remediation: "Aplicar a fase 01 (cria usuário não-root + sudo).",
    fixable: true,
    command:
      "for u in $(getent group sudo 2>/dev/null | cut -d: -f4 | tr ',' ' '); do [ \"$u\" != root ] && id -u \"$u\" 2>/dev/null; done | head -1",
    evaluate: (r) => {
      const uid = Number.parseInt(firstLine(r.stdout), 10);
      return !Number.isNaN(uid) && uid >= 1000
        ? { status: "pass", detail: `usuário não-root com sudo (uid ${uid})` }
        : { status: "fail", detail: "nenhum usuário não-root no grupo sudo" };
    },
  },

  // ------------------------------------------------------------------ Fase 02
  {
    id: "ssh.root-login",
    phase: "02",
    title: "Login root via SSH desabilitado",
    severity: "critical",
    description: "Configuração efetiva do sshd (sshd -T): PermitRootLogin deve ser no/prohibit-password.",
    remediation: "Aplicar a fase 02 (drop-in de hardening SSH).",
    fixable: true,
    command: "sshd -T 2>/dev/null | grep -i '^permitrootlogin ' | awk '{print $2}'",
    evaluate: (r) => {
      const v = firstLine(r.stdout).toLowerCase();
      if (v === "") return { status: "unknown", detail: "sshd ausente ou sem permissão de leitura" };
      // "without-password" é o alias legado de "prohibit-password"
      return v === "no" || v === "prohibit-password" || v === "without-password" || v === "forced-commands-only"
        ? { status: "pass", detail: `PermitRootLogin ${v}` }
        : { status: "fail", detail: `PermitRootLogin ${v}` };
    },
  },
  {
    id: "ssh.password-auth",
    phase: "02",
    title: "Autenticação SSH somente por chave",
    severity: "critical",
    description: "PasswordAuthentication deve ser no — ~89% dos ataques a Linux são brute force contra SSH com senha.",
    remediation: "Aplicar a fase 02 (PasswordAuthentication no + KbdInteractiveAuthentication no).",
    fixable: true,
    command: "sshd -T 2>/dev/null | grep -i '^passwordauthentication ' | awk '{print $2}'",
    evaluate: (r) => {
      const v = firstLine(r.stdout).toLowerCase();
      if (v === "") return { status: "unknown", detail: "sshd ausente ou sem permissão de leitura" };
      return v === "no"
        ? { status: "pass", detail: "PasswordAuthentication no" }
        : { status: "fail", detail: `PasswordAuthentication ${v}` };
    },
  },
  {
    id: "ssh.max-auth-tries",
    phase: "02",
    title: "Tentativas de autenticação SSH limitadas",
    severity: "warning",
    description: "MaxAuthTries ≤ 3 reduz a janela de brute force por conexão.",
    remediation: "Aplicar a fase 02 (MaxAuthTries 3).",
    fixable: true,
    command: "sshd -T 2>/dev/null | grep -i '^maxauthtries ' | awk '{print $2}'",
    evaluate: (r) => {
      const v = Number.parseInt(firstLine(r.stdout), 10);
      if (Number.isNaN(v)) return { status: "unknown", detail: "sshd ausente ou sem permissão de leitura" };
      return v <= 3 ? { status: "pass", detail: `MaxAuthTries ${v}` } : { status: "fail", detail: `MaxAuthTries ${v} (recomendado ≤ 3)` };
    },
  },
  {
    id: "ssh.forwarding-disabled",
    phase: "02",
    title: "Forwardings SSH desabilitados",
    severity: "info",
    description: "X11/agent/TCP forwarding ligados ampliam a superfície de movimento lateral.",
    remediation: "Aplicar a fase 02 (X11Forwarding/AllowAgentForwarding/AllowTcpForwarding no).",
    fixable: true,
    command:
      "sshd -T 2>/dev/null | grep -iE '^(x11forwarding|allowagentforwarding|allowtcpforwarding) ' | awk '{print $1\"=\"$2}' | tr '\\n' ' '",
    evaluate: (r) => {
      const out = r.stdout.trim();
      if (out === "") return { status: "unknown", detail: "sshd ausente ou sem permissão de leitura" };
      return /(x11forwarding=yes|allowagentforwarding=yes|allowtcpforwarding=yes)/i.test(out)
        ? { status: "fail", detail: out }
        : { status: "pass", detail: out };
    },
  },

  // ------------------------------------------------------------------ Fase 03
  {
    id: "firewall.ufw-active",
    phase: "03",
    title: "Firewall UFW ativo",
    severity: "critical",
    description: "Sem firewall default-deny, todo serviço instalado por engano fica exposto à internet.",
    remediation: "Aplicar a fase 03 (UFW default deny incoming + allow SSH/80/443).",
    fixable: true,
    command: "ufw status 2>/dev/null | head -1",
    evaluate: (r) => {
      const v = firstLine(r.stdout).toLowerCase();
      if (v === "") return { status: "unknown", detail: "ufw não instalado" };
      return v.includes("active")
        ? { status: "pass", detail: "UFW ativo" }
        : { status: "fail", detail: `UFW ${v.replace("status: ", "")}` };
    },
  },
  {
    id: "firewall.default-deny",
    phase: "03",
    title: "Política padrão: deny incoming",
    severity: "critical",
    description: "Verifica a política padrão de entrada do UFW (ufw status verbose).",
    remediation: "Aplicar a fase 03 (ufw default deny incoming).",
    fixable: true,
    command: "ufw status verbose 2>/dev/null | grep -i '^Default:'",
    evaluate: (r) => {
      const v = firstLine(r.stdout);
      if (v === "") return { status: "unknown", detail: "ufw não instalado ou inativo" };
      return /deny \(incoming\)/i.test(v)
        ? { status: "pass", detail: v }
        : { status: "fail", detail: v };
    },
  },
  {
    id: "net.db-ports-exposed",
    phase: "03",
    title: "Portas de banco de dados não expostas",
    severity: "critical",
    description: "MySQL/PostgreSQL/Redis/MongoDB (3306/5432/6379/27017) escutando em 0.0.0.0 = acesso público direto ao banco.",
    remediation: "Fazer bind dos bancos em 127.0.0.1 e/ou bloquear no firewall (fase 03).",
    fixable: true,
    command:
      "ss -tuln 2>/dev/null | grep -E '(0\\.0\\.0\\.0|\\*|\\[::\\]|::):(3306|5432|6379|27017)\\b' || true",
    evaluate: (r) => {
      const lines = r.stdout.split("\n").filter((l) => l.trim() !== "");
      return lines.length === 0
        ? { status: "pass", detail: "nenhuma porta de banco exposta publicamente" }
        : { status: "fail", detail: lines.join(" | ") };
    },
  },
  {
    id: "net.docker-api-exposed",
    phase: "03",
    title: "API do Docker não exposta em TCP",
    severity: "critical",
    description: "Docker API em 2375/2376 sem TLS = root remoto no host (CVE-2025-9074, CVSS 9.3).",
    remediation: "Desativar TCP do dockerd ou exigir TLS+auth (dockerd --tlsverify). Nunca expor publicamente.",
    fixable: false,
    command:
      "ss -tuln 2>/dev/null | grep -E '(0\\.0\\.0\\.0|\\*|\\[::\\]|::):(2375|2376)\\b' || true",
    evaluate: (r) => {
      const lines = r.stdout.split("\n").filter((l) => l.trim() !== "");
      return lines.length === 0
        ? { status: "pass", detail: "API Docker não escuta em TCP" }
        : { status: "fail", detail: lines.join(" | ") };
    },
  },
  {
    id: "net.sysctl-hardening",
    phase: "03",
    title: "Hardening de kernel (sysctl)",
    severity: "warning",
    description: "Verifica syncookies e o drop-in /etc/sysctl.d/99-paas-hardening.conf (anti-spoofing, redirects, etc.).",
    remediation: "Aplicar a fase 03 (sysctl hardening).",
    fixable: true,
    command:
      "echo \"syncookies=$(cat /proc/sys/net/ipv4/tcp_syncookies 2>/dev/null || echo '?')\"; test -f /etc/sysctl.d/99-paas-hardening.conf && echo dropin=present || echo dropin=absent",
    evaluate: (r) => {
      const sync = /syncookies=1/.test(r.stdout);
      const dropin = /dropin=present/.test(r.stdout);
      if (sync && dropin) return { status: "pass", detail: "syncookies=1 e drop-in presente" };
      return { status: "fail", detail: r.stdout.trim().replace(/\n/g, "; ") };
    },
  },
  {
    id: "net.listening-inventory",
    phase: "03",
    title: "Inventário de portas escutando",
    severity: "info",
    description: "Lista portas TCP/UDP em escuta (ss -tulpn) — base para detectar exposições inesperadas.",
    remediation: "Comparar com a matriz de portas esperada (docs/security-research.md §4) e fechar o excedente.",
    fixable: false,
    command: "ss -tuln 2>/dev/null | tail -n +2 | awk '{print $5}' | sort -u | tr '\\n' ' '",
    evaluate: (r) => ({ status: "pass", detail: r.stdout.trim() || "nenhuma porta em escuta" }),
  },

  // ------------------------------------------------------------------ Fase 04
  {
    id: "intrusion.fail2ban",
    phase: "04",
    title: "fail2ban ativo",
    severity: "critical",
    description: "Bane IPs após N falhas de autenticação (SSH, nginx, e-mail) — defesa ativa contra brute force.",
    remediation: "Aplicar a fase 04 (fail2ban com jail.local da spec).",
    fixable: true,
    command:
      "fail2ban-client ping 2>/dev/null || (dpkg -s fail2ban >/dev/null 2>&1 && echo installed-not-running) || echo absent",
    evaluate: (r) => {
      const v = firstLine(r.stdout);
      if (v.includes("pong")) return { status: "pass", detail: "fail2ban rodando" };
      if (v === "installed-not-running") return { status: "fail", detail: "instalado mas não está rodando" };
      return { status: "fail", detail: "fail2ban ausente" };
    },
  },
  {
    id: "intrusion.apparmor",
    phase: "04",
    title: "AppArmor habilitado",
    severity: "warning",
    description: "MAC obrigatório do Ubuntu: confina processos mesmo se comprometidos.",
    remediation: "Aplicar a fase 04 (apparmor-utils + enforce nos perfis).",
    fixable: true,
    command:
      "cat /sys/module/apparmor/parameters/enabled 2>/dev/null || echo unavailable",
    evaluate: (r) => {
      const v = firstLine(r.stdout);
      if (v === "Y") return { status: "pass", detail: "AppArmor habilitado no kernel" };
      if (v === "unavailable") return { status: "unknown", detail: "AppArmor indisponível neste kernel (container?)" };
      return { status: "fail", detail: `AppArmor enabled=${v}` };
    },
  },

  // ------------------------------------------------------------------ Fase 05
  {
    id: "minimal.snapd-absent",
    phase: "05",
    title: "snapd ausente",
    severity: "warning",
    description: "Servidor sem snaps não precisa do snapd — é superfície de ataque e consumo de recursos.",
    remediation: "Aplicar a fase 05 (purge do snapd na ordem correta + apt-mark hold).",
    fixable: true,
    command: "dpkg -s snapd >/dev/null 2>&1 && echo installed || echo absent",
    evaluate: (r) =>
      firstLine(r.stdout) === "absent"
        ? { status: "pass", detail: "snapd não instalado" }
        : { status: "fail", detail: "snapd instalado" },
  },
  {
    id: "minimal.unnecessary-services",
    phase: "05",
    title: "Serviços desnecessários desabilitados",
    severity: "warning",
    description: "avahi/cups/bluetooth/ModemManager/rpcbind/whoopsie rodando em servidor = superfície desnecessária.",
    remediation: "Aplicar a fase 05 (disable + mask).",
    fixable: true,
    command:
      "if [ -d /run/systemd/system ]; then systemctl list-units --type=service --state=running --no-legend 2>/dev/null | grep -E 'avahi-daemon|cups|bluetooth|ModemManager|rpcbind|whoopsie|apport' || true; else ps -eo comm 2>/dev/null | grep -E '^(avahi-daemon|cupsd|bluetoothd|ModemManager|rpcbind|whoopsie|apport)$' || true; fi",
    evaluate: (r) => {
      const lines = r.stdout.split("\n").filter((l) => l.trim() !== "");
      return lines.length === 0
        ? { status: "pass", detail: "nenhum serviço desnecessário ativo" }
        : { status: "fail", detail: lines.join(" | ") };
    },
  },
  {
    id: "minimal.legacy-clients",
    phase: "05",
    title: "Clientes legados inseguros ausentes",
    severity: "info",
    description: "telnet/rsh/ftp/tftp/talk/nis são protocolos em texto claro sem lugar em servidor moderno.",
    remediation: "Aplicar a fase 05 (purge dos clientes legados).",
    fixable: true,
    command:
      "for p in telnet rsh-client rsh-redone-client ftp tftp-hpa tftp talk nis; do dpkg -s \"$p\" >/dev/null 2>&1 && echo \"$p\"; done; true",
    evaluate: (r) => {
      const pkgs = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      return pkgs.length === 0
        ? { status: "pass", detail: "nenhum cliente legado instalado" }
        : { status: "fail", detail: `instalados: ${pkgs.join(", ")}` };
    },
  },

  // ------------------------------------------------------------------ Fase 06
  {
    id: "audit.auditd",
    phase: "06",
    title: "auditd instalado e ativo",
    severity: "critical",
    description: "Auditoria de syscalls/arquivos sensíveis (passwd, sudoers, cron) — detecção pós-invasão.",
    remediation: "Aplicar a fase 06 (auditd + regras essenciais da spec).",
    fixable: true,
    command:
      "dpkg -s auditd >/dev/null 2>&1 && echo installed || echo absent",
    evaluate: (r) =>
      firstLine(r.stdout) === "installed"
        ? { status: "pass", detail: "auditd instalado" }
        : { status: "fail", detail: "auditd ausente" },
  },
  {
    id: "audit.aide-baseline",
    phase: "06",
    title: "Baseline de integridade (AIDE)",
    severity: "warning",
    description: "AIDE detecta alterações não autorizadas em binários/configs — baseline deve existir desde o sistema limpo.",
    remediation: "Aplicar a fase 06 (aideinit no sistema limpo + cópia externa do aide.db).",
    fixable: true,
    command: "test -f /var/lib/aide/aide.db && echo present || echo absent",
    evaluate: (r) =>
      firstLine(r.stdout) === "present"
        ? { status: "pass", detail: "baseline AIDE presente" }
        : { status: "fail", detail: "sem baseline AIDE" },
  },
  {
    id: "audit.rkhunter",
    phase: "06",
    title: "Scanner de rootkits instalado",
    severity: "info",
    description: "rkhunter/chkrootkit com baseline (propupd) feito em sistema limpo.",
    remediation: "Aplicar a fase 06 (rkhunter --update --propupd + cron diário).",
    fixable: true,
    command: "command -v rkhunter >/dev/null 2>&1 && echo present || echo absent",
    evaluate: (r) =>
      firstLine(r.stdout) === "present"
        ? { status: "pass", detail: "rkhunter instalado" }
        : { status: "fail", detail: "rkhunter ausente" },
  },
  {
    id: "audit.recurring-scan",
    phase: "06",
    title: "Varreduras recorrentes agendadas",
    severity: "warning",
    description: "Cron com Lynis semanal + AIDE diário + rkhunter diário (/etc/cron.d/paas-security-scan).",
    remediation: "Aplicar a fase 06 (cron de varreduras recorrentes).",
    fixable: true,
    command: "test -f /etc/cron.d/paas-security-scan && echo present || echo absent",
    evaluate: (r) =>
      firstLine(r.stdout) === "present"
        ? { status: "pass", detail: "cron de varredura presente" }
        : { status: "fail", detail: "sem cron de varredura" },
  },

  // ------------------------------------------------------- Docker (manual)
  {
    id: "docker.privileged-containers",
    phase: "06",
    title: "Nenhum container privilegiado",
    severity: "critical",
    description: "--privileged desliga o isolamento do container (escape trivial para o host).",
    remediation: "Ação manual: recriar o container sem --privileged e com capabilities mínimas.",
    fixable: false,
    command:
      "command -v docker >/dev/null 2>&1 && docker ps -q 2>/dev/null | xargs -r docker inspect -f '{{.Name}} {{.HostConfig.Privileged}}' 2>/dev/null || echo no-docker",
    evaluate: (r) => {
      const out = r.stdout.trim();
      if (out === "no-docker" || out === "") return { status: "unknown", detail: "Docker ausente ou sem containers" };
      const priv = out.split("\n").filter((l) => l.endsWith(" true"));
      return priv.length === 0
        ? { status: "pass", detail: "nenhum container privilegiado" }
        : { status: "fail", detail: priv.join(" | ") };
    },
  },
  {
    id: "docker.sock-mounted",
    phase: "06",
    title: "docker.sock não montado em containers",
    severity: "critical",
    description: "Container com /var/run/docker.sock montado = root no host.",
    remediation: "Ação manual: remover o mount do socket ou restringir a containers de administração.",
    fixable: false,
    command:
      "command -v docker >/dev/null 2>&1 && docker ps -q 2>/dev/null | xargs -r docker inspect -f '{{.Name}} {{range .Mounts}}{{.Source}} {{end}}' 2>/dev/null | grep docker.sock || echo no-docker",
    evaluate: (r) => {
      const out = r.stdout.trim();
      if (out === "no-docker" || out === "") return { status: "unknown", detail: "Docker ausente ou sem mounts de socket" };
      return { status: "fail", detail: out.split("\n").join(" | ") };
    },
  },
];
