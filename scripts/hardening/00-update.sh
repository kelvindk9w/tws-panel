#!/usr/bin/env bash
# 00-update.sh — Fase 00: atualização do sistema + atualizações automáticas de segurança.
# Spec: docs/security-research.md §2.1 (apt full-upgrade, unattended-upgrades, needrestart).
#
# NÃO ATUALIZA O DOCKER, de propósito: esta fase roda dentro de um container
# mantido pelo próprio daemon do Docker (PTY via nsenter — docker-socket.ts).
# Atualizar docker-ce & cia reinicia o daemon e mata a sessão que está rodando
# a fase, no meio de um dpkg. Os pacotes ficam em `apt-mark hold` só durante o
# full-upgrade (com trap para devolver o estado em caso de falha) e são
# excluídos também das atualizações automáticas.
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
UNATTENDED_DOCKER="/etc/apt/apt.conf.d/52paas-unattended-docker"

if [ "$MODE" = "rollback" ]; then
  step "Desfazendo configuração de atualizações automáticas"
  # Nota: pacotes já instalados/atualizados não são revertidos (inseguro e
  # impraticável fazer downgrade); restauramos apenas os arquivos de config.
  restore_latest_backup "$AUTO_UPGRADES"
  restore_latest_backup "$UNATTENDED_DOCKER"
  ok "Rollback da fase 00 concluído"
  exit 0
fi

step "Atualizando índice de pacotes (apt update)"
run apt-get update
ok "Índice de pacotes atualizado"

# --- Proteção do canal de execução -------------------------------------------
# Esta fase roda DENTRO de um container mantido pelo daemon do Docker. Atualizar
# docker-ce & cia reinicia o daemon e mata a própria sessão no meio do dpkg.
step "Protegendo o Docker do full-upgrade (o painel roda sobre ele)"
DOCKER_PENDING="$(paas_docker_pkgs_pending | tr '\n' ' ' | sed 's/ *$//')"
if [ -n "$DOCKER_PENDING" ]; then
  info "estes pacotes TÊM atualização disponível e ficarão de fora: $DOCKER_PENDING"
else
  info "nenhum pacote do Docker tem atualização pendente agora"
fi
paas_docker_hold
ok "Docker protegido durante esta fase"

step "Aplicando atualizações (apt full-upgrade)"
if [ "$PAAS_DRY_RUN" = "1" ]; then
  echo "[dry-run] apt-get -y full-upgrade (com os pacotes do Docker em hold)"
  # grep -c sai 1 quando não há matches (0 pacotes) — sem `|| true` o
  # pipefail mataria o dry-run num sistema já atualizado.
  COUNT="$(apt-get -s full-upgrade 2>/dev/null | grep -cE '^Inst' || true)"
  DOCKER_COUNT="$(printf '%s' "$DOCKER_PENDING" | wc -w | tr -d ' ')"
  echo "[dry-run] $((COUNT - DOCKER_COUNT)) pacote(s) seriam atualizados"
  if [ -n "$DOCKER_PENDING" ]; then
    echo "[dry-run] $DOCKER_COUNT pacote(s) ficariam de fora (reiniciam o Docker): $DOCKER_PENDING"
  else
    echo "[dry-run] 0 pacote(s) ficariam de fora (nenhuma atualização pendente do Docker)"
  fi
else
  env DEBIAN_FRONTEND=noninteractive apt-get -y full-upgrade
fi
ok "Sistema atualizado"

step "Liberando os pacotes do Docker (hold era só desta fase)"
paas_docker_unhold
ok "Estado de hold devolvido ao que era antes da fase"

if [ -n "$DOCKER_PENDING" ]; then
  step "O que ficou de fora — e como atualizar por conta própria"
  info "Estes pacotes NÃO foram atualizados de propósito: $DOCKER_PENDING"
  info "Motivo: instalá-los reinicia o daemon do Docker, e é o daemon que mantém"
  info "de pé o container do painel e o container onde esta fase está rodando."
  info "Atualizar por aqui derrubaria a própria execução no meio do dpkg."
  info ""
  info "Para atualizar o Docker, entre por SSH (NÃO pelo terminal do painel) e rode:"
  info "  sudo apt-get update && sudo apt-get install --only-upgrade $DOCKER_PENDING"
  info ""
  info "Isso reinicia o Docker: o painel fica fora do ar por alguns segundos e volta"
  info "sozinho (o compose usa restart: unless-stopped). Aguarde e recarregue a página."
  ok "Instruções de atualização do Docker registradas no log"
fi

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

step "Excluindo o Docker das atualizações automáticas"
# Por que: o unattended-upgrades roda sozinho, num horário qualquer, e reinicia
# serviços. Se ele atualizar um pacote que reinicia o daemon do Docker, o painel
# cai de madrugada sem ninguém por perto.
#
# As origens padrão (Allowed-Origins em 50unattended-upgrades) cobrem só o
# arquivo do Ubuntu, então o repositório do Docker (origem "Docker") NÃO entra
# automaticamente. Mas docker.io e containerd, a alternativa que vem do próprio
# Ubuntu, entram — e derrubariam o painel do mesmo jeito. Por isso a exclusão
# explícita, que vale para os dois casos.
#
# Sintaxe conferida no arquivo de exemplo do próprio pacote
# (/etc/apt/apt.conf.d/50unattended-upgrades, seção Package-Blacklist): lista de
# expressões regulares Python, "$" marca o fim do nome, caracteres especiais
# escapados com "\".
{
  echo "// Gerenciado pelo painel PaaS (00-update.sh). Backup: *.paas-backup.*"
  echo "// Pacotes que reiniciam o daemon do Docker — atualizar sozinho derruba o painel."
  echo "// Atualize-os à mão por SSH: sudo apt-get install --only-upgrade <pacote>"
  echo "Unattended-Upgrade::Package-Blacklist {"
  for _pkg in $PAAS_DOCKER_PKGS; do
    # "." é metacaractere de regex — containerd.io precisa de escape.
    printf '    "%s$";\n' "$(printf '%s' "$_pkg" | sed 's/\./\\./g')"
  done
  echo "};"
} | write_file "$UNATTENDED_DOCKER"
warn "o Docker NÃO recebe atualização automática de segurança — atualize-o à mão, por SSH, de tempos em tempos"
ok "Docker fora das atualizações automáticas"

step "Verificação"
if [ "$PAAS_DRY_RUN" = "1" ]; then
  echo "[dry-run] verificaria configuração de unattended-upgrades"
elif grep -q 'Unattended-Upgrade "1"' "$AUTO_UPGRADES"; then
  info "unattended-upgrades configurado corretamente"
else
  die "unattended-upgrades não ficou configurado em $AUTO_UPGRADES"
fi
ok "Fase 00 (atualizações) concluída"
