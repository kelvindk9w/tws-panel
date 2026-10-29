#!/usr/bin/env bash
# =============================================================================
# TWS Panel — reset-senha.sh
#
# Redefine SÓ a senha de login do painel (esqueceu a senha). Diferente do
# reset-setup.sh --full, NÃO apaga a conta: usuário, verificação em duas etapas,
# projetos e domínios ficam como estão.
#
# Quem roda isto já provou quem é: precisa de acesso SSH (ou ao console do
# provedor) à VPS e de sudo.
#
# Uso (na VPS):
#   cd /opt/tws-panel && sudo ./scripts/reset-senha.sh [--usuario NOME]
#
# O que faz: pede a senha nova (sem eco, duas vezes; mínimo de 12 caracteres com
# maiúscula, minúscula e número), para o painel, grava o hash no users.json do
# volume paas_data, encerra TODAS as sessões, revoga os tokens de API e sobe o
# painel de novo. A senha vai pela entrada padrão do container: não aparece em
# argumento, em `ps`, em log nem no histórico do shell.
#
# ⚠  Exige confirmação interativa (digitar "redefinir").
# =============================================================================
set -euo pipefail

VOLUME_NAME="${PAAS_VOLUME:-paas_data}"
IMAGE="${PAAS_IMAGE:-tws-panel:latest}"
CONTAINER="tws-panel"

log() { printf '\033[1;34m[tws-panel]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[tws-panel][erro]\033[0m %s\n' "$*" >&2; exit 1; }

USER_ARGS=()
case "${1:-}" in
  "") ;;
  --usuario)
    [ -n "${2:-}" ] || die "--usuario precisa de um nome."
    USER_ARGS=(--usuario "$2") ;;
  -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
  *) die "argumento desconhecido: $1 (use --help)" ;;
esac

[ "${PAAS_ASSUME_ROOT:-0}" = "1" ] || [ "$(id -u)" = "0" ] || die "rode com sudo: sudo ./scripts/reset-senha.sh"
command -v docker >/dev/null 2>&1 || die "docker não encontrado — rode este script na VPS do painel."
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "imagem $IMAGE não encontrada — o painel está instalado nesta VPS?"

printf '\n%s\n%s\n%s\n\n' \
  "Isto redefine a SENHA do painel. A conta, a verificação em duas etapas e os projetos continuam." \
  "Todas as sessões abertas e os tokens de API serão encerrados." \
  "O painel fica fora do ar por alguns segundos (é parado e iniciado de novo)."
printf 'Para confirmar, digite "redefinir" e pressione ENTER: '
CONFIRM=""
read -r CONFIRM || CONFIRM=""
if [ "$CONFIRM" != "redefinir" ]; then
  log "cancelado — nada foi alterado."
  exit 0
fi

# Sem eco quando for um terminal; em pipe (testes) lê direto.
read_secret() {
  local prompt="$1" value=""
  printf '%s' "$prompt" >&2
  if [ -t 0 ]; then
    IFS= read -rs value || value=""
    printf '\n' >&2
  else
    IFS= read -r value || value=""
  fi
  printf '%s' "$value"
}

PASS1="$(read_secret 'Senha nova do painel: ')"
PASS2="$(read_secret 'Repita a senha nova: ')"
[ -n "$PASS1" ] || die "senha vazia — nada foi alterado."
[ "$PASS1" = "$PASS2" ] || die "as senhas não são iguais — nada foi alterado."
# A força é conferida de verdade pelo .mjs; aqui só falha cedo (antes de parar o painel).
if [ "${#PASS1}" -lt 12 ] || ! [[ "$PASS1" =~ [A-Z] ]] || ! [[ "$PASS1" =~ [a-z] ]] || ! [[ "$PASS1" =~ [0-9] ]]; then
  die "senha fraca: use ao menos 12 caracteres, com maiúscula, minúscula e número. Nada foi alterado."
fi

RUNNING=0
if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  RUNNING=1
  log "parando o painel…"
  docker stop "$CONTAINER" >/dev/null
fi

STATUS=0
printf '%s\n' "$PASS1" | docker run --rm -i --entrypoint node -v "$VOLUME_NAME:/data" "$IMAGE" /app/scripts/reset-senha.mjs /data/users.json ${USER_ARGS[@]+"${USER_ARGS[@]}"} || STATUS=$?
PASS1=""; PASS2=""

if [ "$RUNNING" = "1" ]; then
  log "iniciando o painel…"
  docker start "$CONTAINER" >/dev/null
fi
[ "$STATUS" = "0" ] || die "não foi possível redefinir a senha (código $STATUS). O painel voltou como estava."

log "pronto. Entre no painel com a senha nova (a verificação em duas etapas continua valendo)."
