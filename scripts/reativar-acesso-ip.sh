#!/usr/bin/env bash
# =============================================================================
# TWS Panel — reativar-acesso-ip.sh
#
# Saída de emergência para quem desativou o acesso pelo IP (Configurações →
# Domínio do painel) e não consegue mais abrir o painel pelo domínio (DNS
# apagado ou trocado, domínio vencido, certificado que não renovou).
#
# Quem roda isto já provou quem é: precisa de acesso SSH à VPS e de sudo.
#
# Uso (na VPS):
#   cd /opt/tws-panel && sudo ./scripts/reativar-acesso-ip.sh
#
# O que faz:
#   1. para o painel (ele guarda a escolha em memória e regravaria o arquivo);
#   2. no volume paas_data, em /data/panel-domain.json, volta a ligar o acesso
#      pelo IP (o domínio próprio continua cadastrado);
#   3. sobe o painel: no boot ele remonta o proxy (Caddy) com os dois
#      endereços e recarrega;
#   4. confere que o Caddyfile do proxy voltou a ter o endereço pelo IP.
# Depois: abra https://<ip-com-hífens>.sslip.io e entre de novo.
# Usuário, senha, sessões, projetos e todo o resto ficam como estão.
# =============================================================================
set -euo pipefail

VOLUME_NAME="${PAAS_VOLUME:-paas_data}"
IMAGE="${PAAS_IMAGE:-tws-panel:latest}"
CONTAINER="tws-panel"
CADDY="paas-caddy"
WAIT_SECONDS="${PAAS_WAIT_SECONDS:-90}"

log() { printf '\033[1;34m[tws-panel]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[tws-panel][erro]\033[0m %s\n' "$*" >&2; exit 1; }

case "${1:-}" in
  "") ;;
  -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
  *) die "argumento desconhecido: $1 (use --help)" ;;
esac

command -v docker >/dev/null 2>&1 || die "docker não encontrado — rode este script na VPS do painel."
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "imagem $IMAGE não encontrada — o painel está instalado nesta VPS?"

# Endereço pelo IP gravado pelo install.sh (só para mostrar e conferir).
ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
IP_HOST=""
if [ -r "$ENV_FILE" ]; then
  IP_HOST="$(sed -n 's/^PAAS_PANEL_DOMAIN=//p' "$ENV_FILE" | tail -n 1 | tr -d "\"'")"
fi
[ -n "$IP_HOST" ] || die "PAAS_PANEL_DOMAIN vazio no .env: este painel usa acesso por túnel SSH e não tem endereço pelo IP."

RUNNING=0
if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  RUNNING=1
  log "parando o painel…"
  docker stop "$CONTAINER" >/dev/null
fi

STATUS=0
docker run --rm --entrypoint node -v "$VOLUME_NAME:/data" "$IMAGE" /app/scripts/reativar-acesso-ip.mjs /data/panel-domain.json || STATUS=$?

log "iniciando o painel…"
docker start "$CONTAINER" >/dev/null
[ "$STATUS" = "0" ] || die "não foi possível alterar o panel-domain.json (código $STATUS). O painel voltou como estava."
[ "$RUNNING" = "1" ] || log "(o painel estava parado e foi iniciado agora)"

# O painel remonta o proxy no boot (com novas tentativas se o Docker estiver
# ocupado). Confere o arquivo que o Caddy usa de verdade.
log "conferindo o proxy (até ${WAIT_SECONDS}s)…"
DEADLINE=$(( $(date +%s) + WAIT_SECONDS ))
while :; do
  if docker exec "$CADDY" cat /etc/caddy/Caddyfile 2>/dev/null | grep -qF "$IP_HOST"; then
    log "pronto. Abra https://$IP_HOST e entre de novo (o certificado já existe; se o navegador reclamar, espere 1 minuto)."
    exit 0
  fi
  [ "$(date +%s)" -lt "$DEADLINE" ] || break
  sleep 1
done
die "o proxy ainda não tem o endereço $IP_HOST. Veja o que o painel diz: sudo docker logs tws-panel --tail 50 (e o proxy: sudo docker logs paas-caddy --tail 50)."
