#!/usr/bin/env bash
# =============================================================================
# TWS Panel — reset-2fa.sh
#
# Saída de emergência para quem perdeu o celular E os códigos de recuperação:
# desliga a verificação em duas etapas do login do painel. Depois, entre só
# com usuário e senha e ative de novo (menu do usuário → Verificação em duas
# etapas).
#
# Quem roda isto já provou quem é: precisa de acesso SSH à VPS e de sudo.
#
# Uso (na VPS):
#   sudo ./scripts/reset-2fa.sh
#
# O que faz: para o painel, desliga a verificação em duas etapas no
# users.json do volume paas_data e sobe o painel de novo. Usuário, senha,
# sessões, projetos e todo o resto ficam como estão.
#
# ⚠  Exige confirmação interativa (digitar "desligar").
# =============================================================================
set -euo pipefail

VOLUME_NAME="${PAAS_VOLUME:-paas_data}"
IMAGE="${PAAS_IMAGE:-tws-panel:latest}"
CONTAINER="tws-panel"

log() { printf '\033[1;34m[tws-panel]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[tws-panel][erro]\033[0m %s\n' "$*" >&2; exit 1; }

case "${1:-}" in
  "") ;;
  -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
  *) die "argumento desconhecido: $1 (use --help)" ;;
esac

command -v docker >/dev/null 2>&1 || die "docker não encontrado — rode este script na VPS do painel."
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "imagem $IMAGE não encontrada — o painel está instalado nesta VPS?"

printf '\n%s\n%s\n%s\n\n' \
  "Isto DESLIGA a verificação em duas etapas do login do painel." \
  "O painel fica fora do ar por alguns segundos (é parado e iniciado de novo)." \
  "Depois, entre só com usuário e senha — e ative a verificação de novo."
printf 'Para confirmar, digite "desligar" e pressione ENTER: '
CONFIRM=""
read -r CONFIRM || CONFIRM=""
if [ "$CONFIRM" != "desligar" ]; then
  log "cancelado — nada foi alterado."
  exit 0
fi

# Parado: o painel guarda os usuários em memória e regravaria o arquivo.
RUNNING=0
if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  RUNNING=1
  log "parando o painel…"
  docker stop "$CONTAINER" >/dev/null
fi

STATUS=0
docker run --rm --entrypoint node -v "$VOLUME_NAME:/data" "$IMAGE" /app/scripts/reset-2fa.mjs /data/users.json || STATUS=$?

if [ "$RUNNING" = "1" ]; then
  log "iniciando o painel…"
  docker start "$CONTAINER" >/dev/null
fi
[ "$STATUS" = "0" ] || die "não foi possível alterar o users.json (código $STATUS). O painel voltou como estava."

log "pronto. Entre no painel com usuário e senha e ative a verificação em duas etapas de novo."
