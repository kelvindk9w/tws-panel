#!/usr/bin/env bash
# 05-minimal.sh — Fase 05: minimização — remove snapd, pacotes e serviços desnecessários.
# Spec: docs/security-research.md §2.12 e §5 (snapd, serviços, clientes legados,
# prevenção de re-crescimento via APT::Install-Recommends).
#
# NUNCA remove: metapacotes ubuntu-server/ubuntu-minimal/ubuntu-standard nem kernels.
#
# Uso: ./05-minimal.sh [--dry-run] [--rollback]
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$(readlink -f "$0")")/lib.sh"

MODE="apply"
APT_CONF="/etc/apt/apt.conf.d/99paas-dependencies"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)  PAAS_DRY_RUN=1 ;;
    --rollback) MODE="rollback" ;;
    -h|--help)  echo "Uso: $0 [--dry-run] [--rollback]"; paas_usage_common; exit 0 ;;
    *) die "opção desconhecida: $1" ;;
  esac
  shift
done

if [ "$MODE" = "rollback" ]; then
  step "Restaurando configuração APT"
  restore_latest_backup "$APT_CONF"
  # Nota: pacotes removidos NÃO são reinstalados automaticamente (o apt log
  # registra tudo em /var/log/apt/history.log para reinstalação manual).
  warn "pacotes removidos não são reinstalados pelo rollback — veja /var/log/apt/history.log"
  ok "Rollback da fase 05 concluído"
  exit 0
fi

step "Removendo snapd"
if pkg_installed snapd; then
  if command -v snap >/dev/null 2>&1 && [ "$PAAS_DRY_RUN" != "1" ]; then
    # Remove snaps na ordem correta (spec §5.3): primeiro os comuns, por último base/core.
    snap list 2>/dev/null | awk 'NR>1 {print $1}' | grep -vE '^(core|core[0-9]+|snapd|bare)$' | \
      while read -r s; do snap remove --purge "$s" || warn "falha ao remover snap $s"; done || true
    snap list 2>/dev/null | awk 'NR>1 {print $1}' | grep -E '^(core|core[0-9]+|snapd|bare)$' | \
      while read -r s; do snap remove --purge "$s" || warn "falha ao remover snap $s"; done || true
  fi
  svc_disable_mask snapd.socket
  svc_disable_mask snapd.service
  apt_purge_if_installed snapd
  run apt-mark hold snapd || true
  run_sh "rm -rf /var/cache/snapd /root/snap /home/*/snap 2>/dev/null || true"
  ok "snapd removido e bloqueado (apt-mark hold)"
else
  info "snapd não está instalado"
  ok "snapd ausente — nada a fazer"
fi

step "Desabilitando serviços desnecessários"
for svc in avahi-daemon cups bluetooth ModemManager whoopsie apport rpcbind rpcbind.socket; do
  svc_disable_mask "$svc"
done
ok "Serviços desnecessários desabilitados/mascarados"

step "Removendo clientes legados inseguros (telnet/rsh/ftp/tftp/talk/nis)"
apt_purge_if_installed telnet rsh-client rsh-redone-client ftp tftp-hpa tftp talk nis
ok "Clientes legados removidos"

step "Removendo suporte a desktop/impressão (se presente)"
# Categorias tipicamente desnecessárias em servidor (spec §5.1/§5.3).
apt_purge_if_installed cups-bsd avahi-daemon avahi-autoipd modemmanager whoopsie apport popularity-contest
ok "Pacotes de desktop/remoção concluída"

step "Limpando dependências órfãs e resíduos"
if [ "$PAAS_DRY_RUN" = "1" ]; then
  echo "[dry-run] apt-get autoremove --purge / purge '?config-files' / clean"
  apt-get -s autoremove --purge 2>/dev/null | grep -cE '^(Remv|Purg)' | xargs -I{} echo "[dry-run] {} pacote(s) órfãos seriam removidos"
else
  env DEBIAN_FRONTEND=noninteractive apt-get autoremove --purge -y
  # Resíduos de configuração de pacotes removidos
  residual="$(dpkg -l | awk '/^rc/ {print $2}')"
  if [ -n "$residual" ]; then
    echo "$residual" | xargs -r env DEBIAN_FRONTEND=noninteractive apt-get purge -y
  fi
  apt-get autoclean -y && apt-get clean
fi
ok "Limpeza concluída"

step "Prevenindo re-crescimento (APT sem Recommends/Suggests)"
write_file "$APT_CONF" <<'EOF'
// Gerenciado pelo painel PaaS (05-minimal.sh). Spec: docs/security-research.md §5.4
APT::Install-Recommends "false";
APT::Install-Suggests "false";
EOF
ok "APT configurado para não instalar Recommends/Suggests"

step "Salvando baseline de pacotes"
if [ "$PAAS_DRY_RUN" = "1" ]; then
  echo "[dry-run] apt-mark showmanual | sort > /etc/baseline-packages.txt"
else
  apt-mark showmanual | sort > /etc/baseline-packages.txt
  info "baseline salvo em /etc/baseline-packages.txt ($(wc -l < /etc/baseline-packages.txt) pacotes)"
fi
ok "Baseline de pacotes salvo"

ok "Fase 05 (minimização) concluída"
