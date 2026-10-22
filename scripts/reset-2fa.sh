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
#   sudo ./scripts/reset-2fa.sh                  desliga a verificação (limpa o bloqueio junto)
#   sudo ./scripts/reset-2fa.sh --so-bloqueio    mantém a verificação ligada e só limpa o
#                                                bloqueio por excesso de códigos errados
#
# O painel bloqueia o código de 6 dígitos da conta (5 min, dobrando até 24 h)
# depois de 5 erros seguidos; o código de recuperação passa mesmo assim. Este
# script é a saída se o bloqueio for longo e não houver código de recuperação.
#
# O que faz: para o painel, desliga a verificação em duas etapas no
# users.json do volume paas_data e sobe o painel de novo. Usuário, senha,
# sessões, projetos e todo o resto ficam como estão.
#
# ⚠  Exige confirmação interativa (digitar "desligar"; com --so-bloqueio, "liberar").
# =============================================================================
set -euo pipefail

VOLUME_NAME="${PAAS_VOLUME:-paas_data}"
IMAGE="${PAAS_IMAGE:-tws-panel:latest}"
CONTAINER="tws-panel"

log() { printf '\033[1;34m[tws-panel]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[tws-panel][erro]\033[0m %s\n' "$*" >&2; exit 1; }

ONLY_LOCK=0
SCRIPT_ARGS=""
WORD="desligar"
case "${1:-}" in
  "") ;;
  --so-bloqueio) ONLY_LOCK=1; SCRIPT_ARGS="--so-bloqueio"; WORD="liberar" ;;
  -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
  *) die "argumento desconhecido: $1 (use --help)" ;;
esac

command -v docker >/dev/null 2>&1 || die "docker não encontrado — rode este script na VPS do painel."
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "imagem $IMAGE não encontrada — o painel está instalado nesta VPS?"

if [ "$ONLY_LOCK" = "1" ]; then
  printf '\n%s\n%s\n\n' \
    "Isto limpa o bloqueio por excesso de códigos errados (a verificação continua ligada)." \
    "O painel fica fora do ar por alguns segundos (é parado e iniciado de novo)."
else
printf '\n%s\n%s\n%s\n\n' \
  "Isto DESLIGA a verificação em duas etapas do login do painel (e limpa o bloqueio por códigos errados)." \
  "O painel fica fora do ar por alguns segundos (é parado e iniciado de novo)." \
  "Depois, entre só com usuário e senha — e ative a verificação de novo."
fi
printf 'Para confirmar, digite "%s" e pressione ENTER: ' "$WORD"
CONFIRM=""
read -r CONFIRM || CONFIRM=""
if [ "$CONFIRM" != "$WORD" ]; then
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
docker run --rm --entrypoint node -v "$VOLUME_NAME:/data" "$IMAGE" /app/scripts/reset-2fa.mjs /data/users.json $SCRIPT_ARGS || STATUS=$?

if [ "$RUNNING" = "1" ]; then
  log "iniciando o painel…"
  docker start "$CONTAINER" >/dev/null
fi
[ "$STATUS" = "0" ] || die "não foi possível alterar o users.json (código $STATUS). O painel voltou como estava."

if [ "$ONLY_LOCK" = "1" ]; then
  log "pronto. O bloqueio foi limpo; entre com usuário, senha e o código do app."
else
  log "pronto. Entre no painel com usuário e senha e ative a verificação em duas etapas de novo."
fi
