#!/usr/bin/env bash
# 00-update.sh — Fase 00: atualização do sistema + atualizações automáticas de segurança.
# Spec: docs/security-research.md §2.1 (apt full-upgrade, unattended-upgrades, needrestart).
#
# Uso: ./00-update.sh [--dry-run] [--rollback]
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$(readlink -f "$0")")/lib.sh"

MODE="apply"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)  PAAS_DRY_RUN=1 ;;
    --rollback) MODE="rollback" ;;
    -h|--help)  echo "Uso: $0 [--dry-run] [--rollback]"; paas_usage_common; exit 0 ;;
    *) die "opção desconhecida: $1" ;;
  esac
  shift
done

AUTO_UPGRADES="/etc/apt/apt.conf.d/20auto-upgrades"

if [ "$MODE" = "rollback" ]; then
  step "Desfazendo configuração de atualizações automáticas"
  # Nota: pacotes já instalados/atualizados não são revertidos (inseguro e
  # impraticável fazer downgrade); restauramos apenas os arquivos de config.
  restore_latest_backup "$AUTO_UPGRADES"
  ok "Rollback da fase 00 concluído"
  exit 0
fi

step "Atualizando índice de pacotes (apt update)"
run apt-get update
ok "Índice de pacotes atualizado"

step "Aplicando atualizações (apt full-upgrade)"
if [ "$PAAS_DRY_RUN" = "1" ]; then
  echo "[dry-run] apt-get -y full-upgrade"
  apt-get -s full-upgrade 2>/dev/null | grep -cE '^Inst' | xargs -I{} echo "[dry-run] {} pacote(s) seriam atualizados"
else
  env DEBIAN_FRONTEND=noninteractive apt-get -y full-upgrade
fi
ok "Sistema atualizado"

step "Instalando unattended-upgrades, apt-listchanges e needrestart"
apt_install unattended-upgrades apt-listchanges needrestart
ok "Ferramentas de atualização instaladas"

step "Ativando atualizações automáticas de segurança"
# Garante a origem "${distro_id}:${distro_codename}-security" (já habilitada por
# padrão no Ubuntu em 50unattended-upgrades) e ativa o gatilho diário.
write_file "$AUTO_UPGRADES" <<'EOF'
// Gerenciado pelo painel PaaS (00-update.sh). Backup: *.paas-backup.*
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
if [ "$PAAS_DRY_RUN" != "1" ] && has_systemd; then
  systemctl enable --now unattended-upgrades >/dev/null 2>&1 || warn "unattended-upgrades: enable falhou (continuando)"
fi
ok "Atualizações automáticas de segurança ativas"

step "Verificação"
if [ "$PAAS_DRY_RUN" = "1" ]; then
  echo "[dry-run] verificaria configuração de unattended-upgrades"
elif grep -q 'Unattended-Upgrade "1"' "$AUTO_UPGRADES"; then
  info "unattended-upgrades configurado corretamente"
else
  die "unattended-upgrades não ficou configurado em $AUTO_UPGRADES"
fi
ok "Fase 00 (atualizações) concluída"
