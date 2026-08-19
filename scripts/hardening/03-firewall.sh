#!/usr/bin/env bash
# 03-firewall.sh — Fase 03: firewall UFW (default-deny) + hardening de kernel (sysctl).
# Spec: docs/security-research.md §1.2, §2.4 e §2.6.
#
# REGRA DE OURO: liberar SSH ANTES de `ufw enable`. Rollback automático agendado
# (5 min) desfaz tudo caso o operador não confirme acesso com `--confirm`.
# Portas de e-mail (25/465/587/993) só com --profile mail.
#
# Uso: ./03-firewall.sh [--ssh-port 22] [--profile mail] [--dry-run] [--rollback] [--confirm]
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$(readlink -f "$0")")/lib.sh"

MODE="apply"
SSH_PORT="22"
PROFILE=""
SYSCTL_FILE="/etc/sysctl.d/99-paas-hardening.conf"
REVERT_SCRIPT="${PAAS_STATE_DIR}/revert-firewall.sh"

while [ $# -gt 0 ]; do
  case "$1" in
    --ssh-port) SSH_PORT="${2:?--ssh-port exige um número}"; shift ;;
    --profile)  PROFILE="${2:?--profile exige um nome}"; shift ;;
    --dry-run)  PAAS_DRY_RUN=1 ;;
    --rollback) MODE="rollback" ;;
    --confirm)  MODE="confirm" ;;
    -h|--help)
      echo "Uso: $0 [--ssh-port N] [--profile mail] [--dry-run] [--rollback] [--confirm]"
      paas_usage_common; exit 0 ;;
    *) die "opção desconhecida: $1" ;;
  esac
  shift
done

case "$SSH_PORT" in
  ''|*[!0-9]*) die "porta inválida: $SSH_PORT" ;;
esac
[ -z "$PROFILE" ] || [ "$PROFILE" = "mail" ] || die "profile desconhecido: $PROFILE (suportado: mail)"

if [ "$MODE" = "confirm" ]; then
  step "Confirmando acesso do operador"
  confirm_rollback "firewall"
  run rm -f "$REVERT_SCRIPT"
  ok "Acesso confirmado — firewall mantido definitivamente"
  exit 0
fi

if [ "$MODE" = "rollback" ]; then
  step "Desativando UFW e restaurando configurações"
  if command -v ufw >/dev/null 2>&1; then
    run ufw --force disable || warn "ufw disable falhou (pode já estar inativo)"
  fi
  restore_latest_backup "$SYSCTL_FILE"
  run_sh "sysctl --system >/dev/null 2>&1 || true"
  run rm -f "$REVERT_SCRIPT"
  ok "Rollback da fase 03 concluído"
  exit 0
fi

step "Instalando UFW"
apt_install ufw
ok "UFW presente"

step "Agendando rollback automático de segurança (5 min)"
if [ "$PAAS_DRY_RUN" = "1" ]; then
  echo "[dry-run] gravaria $REVERT_SCRIPT e agendaria via at"
else
  mkdir -p "$PAAS_STATE_DIR"
  cat > "$REVERT_SCRIPT" <<EOF
#!/usr/bin/env bash
# Reversão automática do firewall (agendada por 03-firewall.sh).
set -uo pipefail
source "$(dirname "$(readlink -f "$0")")/lib.sh"
echo "[paas-rollback] operador não confirmou acesso em ${PAAS_ROLLBACK_DELAY}s — desativando UFW"
PAAS_DRY_RUN=0
ufw --force disable || true
restore_latest_backup "$SYSCTL_FILE"
sysctl --system >/dev/null 2>&1 || true
rm -f "${PAAS_STATE_DIR}/pending-rollback-firewall.pid" "${PAAS_STATE_DIR}/pending-rollback-firewall.at"
echo "[paas-rollback] firewall revertido"
EOF
  schedule_rollback "firewall" "$REVERT_SCRIPT"
fi
ok "Rollback automático agendado — cancele com '$0 --confirm' após testar o acesso"

step "Política padrão: deny incoming / allow outgoing"
run ufw default deny incoming
run ufw default allow outgoing
ok "Política padrão definida"

step "Liberando SSH (porta $SSH_PORT) ANTES de ativar o firewall"
run ufw allow "$SSH_PORT/tcp" comment 'SSH'
ok "SSH liberado"

step "Liberando HTTP/HTTPS"
run ufw allow 80/tcp comment 'HTTP'
run ufw allow 443/tcp comment 'HTTPS'
ok "HTTP/HTTPS liberados"

step "Portas de e-mail (profile: ${PROFILE:-nenhum})"
if [ "$PROFILE" = "mail" ]; then
  run ufw allow 25,465,587/tcp comment 'SMTP'
  run ufw allow 993/tcp comment 'IMAPS'
  ok "Portas de e-mail liberadas (25, 465, 587, 993)"
else
  skip "Sem --profile mail — portas 25/465/587/993 permanecem fechadas"
fi

step "Ativando UFW"
if [ "$PAAS_DRY_RUN" = "1" ]; then
  echo "[dry-run] ufw --force enable"
elif ! ufw --force enable; then
  die "ufw enable FALHOU — rollback automático vai reverter"
fi
if [ "$PAAS_DRY_RUN" != "1" ]; then
  ufw status verbose || true
fi
ok "UFW ativo"

step "Hardening de kernel ($SYSCTL_FILE)"
# Nota: net.ipv4.ip_forward NÃO é forçado a 0 — o Docker gerencia forwarding
# automaticamente (spec §1.2, aviso).
write_file "$SYSCTL_FILE" <<'EOF'
# Gerenciado pelo painel PaaS (03-firewall.sh). Spec: docs/security-research.md §1.2
# --- Anti-spoofing / roteamento ---
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.secure_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.all.log_martians = 1

# --- SYN flood / DDoS ---
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_max_syn_backlog = 2048
net.ipv4.tcp_synack_retries = 2
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1
net.ipv4.tcp_keepalive_time = 600

# --- IPv6 ---
net.ipv6.conf.all.accept_ra = 0
net.ipv6.conf.default.accept_ra = 0
net.ipv6.conf.all.accept_redirects = 0

# --- Kernel ---
kernel.randomize_va_space = 2
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
kernel.yama.ptrace_scope = 1
kernel.sysrq = 0
kernel.unprivileged_bpf_disabled = 1
net.core.bpf_jit_harden = 2
kernel.perf_event_paranoid = 2

# --- Filesystem ---
fs.protected_symlinks = 1
fs.protected_hardlinks = 1
fs.protected_fifos = 2
fs.protected_regular = 2
fs.suid_dumpable = 0
EOF
if [ "$PAAS_DRY_RUN" = "1" ]; then
  echo "[dry-run] sysctl --system"
else
  # Tolerante: algumas chaves não existem em kernels de container/VPS específicos.
  sysctl --system >/dev/null 2>&1 || warn "algumas chaves sysctl não se aplicaram a este kernel (normal em containers)"
fi
ok "Sysctl de hardening aplicado"

echo
warn "ATENÇÃO: teste AGORA o acesso SSH (e os serviços web) em outro terminal."
warn "Se funcionar, confirme com: $0 --confirm"
warn "Sem confirmação, o UFW será desativado automaticamente em ${PAAS_ROLLBACK_DELAY}s."
ok "Fase 03 (firewall) concluída — aguardando confirmação do operador"
