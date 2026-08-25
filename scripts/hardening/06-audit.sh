#!/usr/bin/env bash
# 06-audit.sh — Fase 06: detecção — auditd, AIDE (baseline), rkhunter/chkrootkit,
# Lynis e varreduras recorrentes via cron.
# Spec: docs/security-research.md §2.8, §2.9, §2.10 e §3.
#
# Uso: ./06-audit.sh [--skip-rkhunter] [--skip-aide] [--dry-run] [--rollback]
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$(readlink -f "$0")")/lib.sh"

MODE="apply"
WITH_RKHUNTER=1
WITH_AIDE=1
AUDIT_RULES="/etc/audit/rules.d/paas-hardening.rules"
CRON_FILE="/etc/cron.d/paas-security-scan"

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-rkhunter) WITH_RKHUNTER=0 ;;
    --skip-aide)     WITH_AIDE=0 ;;
    --dry-run)       PAAS_DRY_RUN=1 ;;
    --rollback)      MODE="rollback" ;;
    -h|--help)
      echo "Uso: $0 [--skip-rkhunter] [--skip-aide] [--dry-run] [--rollback]"
      paas_usage_common; exit 0 ;;
    *) die "opção desconhecida: $1" ;;
  esac
  shift
done

if [ "$MODE" = "rollback" ]; then
  step "Removendo cron de varredura e restaurando regras de auditoria"
  run rm -f "$CRON_FILE"
  restore_latest_backup "$AUDIT_RULES"
  if [ "$PAAS_DRY_RUN" != "1" ] && command -v augenrules >/dev/null 2>&1; then
    augenrules --load >/dev/null 2>&1 || warn "augenrules --load falhou (normal em containers)"
  fi
  ok "Rollback da fase 06 concluído"
  exit 0
fi

step "Instalando auditd, Lynis e cron"
apt_install auditd audispd-plugins lynis cron needrestart
if [ "$WITH_RKHUNTER" = "1" ]; then
  apt_install rkhunter chkrootkit
fi
if [ "$WITH_AIDE" = "1" ]; then
  apt_install aide aide-common
fi
ok "Ferramentas de auditoria instaladas"

step "Regras essenciais do auditd ($AUDIT_RULES)"
write_file "$AUDIT_RULES" <<'EOF'
# Gerenciado pelo painel PaaS (06-audit.sh). Spec: docs/security-research.md §2.8
-w /etc/passwd -p wa -k identity
-w /etc/group -p wa -k identity
-w /etc/shadow -p wa -k identity
-w /etc/sudoers -p wa -k sudoers_changes
-w /etc/sudoers.d/ -p wa -k sudoers_changes
-w /etc/ssh/sshd_config -p wa -k sshd_config
-w /etc/crontab -p wa -k cron
-w /etc/cron.d/ -p wa -k cron
-w /var/log/ -p wa -k logs
-a always,exit -F arch=b64 -S setuid -S setgid -S setreuid -S setregid -k privilege_escalation
-a always,exit -F arch=b64 -S init_module -S finit_module -S delete_module -k kernel_modules
EOF
if [ "$PAAS_DRY_RUN" = "1" ]; then
  echo "[dry-run] augenrules --load"
else
  augenrules --load >/dev/null 2>&1 || warn "regras carregadas somente no próximo boot do auditd (normal em containers)"
fi
svc_enable_now auditd
ok "auditd configurado"

step "Baseline do AIDE"
if [ "$WITH_AIDE" = "0" ]; then
  skip "AIDE ignorado (--skip-aide)"
else
  # Exclui os armazenamentos de containers do baseline de integridade.
  # /var/lib/docker (overlay2) guarda MILHÕES de arquivos efêmeros: sem a
  # exclusão o aideinit levou ~20 min na VPS real e cada `aide --check`
  # diário vira ruído operacional (containers mudam a todo deploy — a
  # integridade deles não é auditável por AIDE). Nome sem ponto: o
  # @@x_include do aide.conf só aceita ^[a-zA-Z0-9_-]+$.
  AIDE_EXCLUDES="/etc/aide/aide.conf.d/99_paas_container_excludes"
  write_file "$AIDE_EXCLUDES" <<'EOF'
# Gerenciado pelo painel PaaS (06-audit.sh).
# Containers são efêmeros: overlay2 do Docker/containerd muda a cada deploy
# e infla o baseline/check de integridade em ordens de grandeza (na prática:
# ~20 min de aideinit numa VPS com Docker → segundos com a exclusão).
!/var/lib/docker
!/var/lib/containerd
EOF
  if [ "$PAAS_DRY_RUN" != "1" ]; then
    # Valida a config resultante; se o drop-in quebrar o parse, remove-o e
    # segue com a config padrão (o cron diário de aide --check não pode
    # quebrar por causa da exclusão).
    if ! aide --config=/etc/aide/aide.conf --config-check >/dev/null 2>&1; then
      warn "aide --config-check falhou com o drop-in de exclusões — removendo $AIDE_EXCLUDES"
      run rm -f "$AIDE_EXCLUDES"
    fi
  fi
  if [ "$PAAS_DRY_RUN" = "1" ]; then
    echo "[dry-run] aideinit && mv aide.db.new aide.db"
  elif [ -f /var/lib/aide/aide.db ]; then
    info "baseline do AIDE já existe (idempotente) — use 'aide --update' manualmente após mudanças legítimas"
  else
    info "gerando baseline do AIDE (pode levar alguns minutos)…"
    if aideinit -y -f >/dev/null 2>&1 && [ -f /var/lib/aide/aide.db.new ]; then
      mv /var/lib/aide/aide.db.new /var/lib/aide/aide.db
      info "baseline salvo em /var/lib/aide/aide.db"
      warn "guarde uma cópia do aide.db + sha256 FORA do servidor (spec §2.9)"
    else
      warn "aideinit falhou — baseline pode ser gerado depois com 'aideinit'"
    fi
  fi
fi
ok "AIDE verificado"

step "rkhunter/chkrootkit: baseline em sistema limpo"
if [ "$WITH_RKHUNTER" = "0" ]; then
  skip "rkhunter ignorado (--skip-rkhunter)"
elif [ "$PAAS_DRY_RUN" = "1" ]; then
  echo "[dry-run] rkhunter --update --propupd"
else
  rkhunter --update >/dev/null 2>&1 || warn "rkhunter --update falhou (sem rede?)"
  rkhunter --propupd >/dev/null 2>&1 || warn "rkhunter --propupd falhou"
  info "baseline de propriedades do rkhunter registrado"
fi
ok "Scanners de rootkit verificados"

step "Cron de varreduras recorrentes ($CRON_FILE)"
write_file "$CRON_FILE" <<'EOF'
# Gerenciado pelo painel PaaS (06-audit.sh). Spec: docs/security-research.md §3/§6
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Lynis semanal (domingo 03:30) — atualiza /var/log/lynis-report.dat (Hardening Index)
30 3 * * 0 root lynis audit system --cronjob >/dev/null 2>&1

# AIDE diário (04:15) — diff de integridade contra o baseline
# (aide 0.18 exige --config explícito: sem ele falha com "missing configuration")
15 4 * * * root test -f /var/lib/aide/aide.db && aide --config=/etc/aide/aide.conf --check >/var/log/aide-check.log 2>&1 || true

# rkhunter diário (04:45) — somente warnings em /var/log/rkhunter.log
45 4 * * * root command -v rkhunter >/dev/null && rkhunter --check --skip-keypress --report-warnings-only >/dev/null 2>&1 || true
EOF
if [ "$PAAS_DRY_RUN" != "1" ]; then
  svc_enable_now cron
fi
ok "Varreduras recorrentes agendadas"

step "Verificação"
if [ "$PAAS_DRY_RUN" = "1" ]; then
  echo "[dry-run] verificaria auditd/cron"
else
  pkg_installed auditd || die "auditd não ficou instalado"
  pkg_installed lynis || die "lynis não ficou instalado"
  info "auditd e lynis instalados"
fi
ok "Fase 06 (auditoria e detecção) concluída"
