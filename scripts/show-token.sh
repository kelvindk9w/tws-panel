#!/usr/bin/env bash
# =============================================================================
# TWS Panel — show-token.sh
#
# Imprime a URL do wizard + o SETUP TOKEN lido do volume paas_data — para quem
# perdeu o token SEM precisar reinstalar nada.
#
# Uso (na VPS, como root ou usuário com acesso ao Docker):
#   ./scripts/show-token.sh
#
# Variáveis opcionais:
#   PAAS_PORT=9000        porta publicada do painel
#   PAAS_VOLUME=paas_data nome do volume de dados
#   PAAS_PUBLIC_IP=<ip>   pula a detecção automática de IP público
# =============================================================================
set -euo pipefail

PORT="${PAAS_PORT:-9000}"
VOLUME_NAME="${PAAS_VOLUME:-paas_data}"

BOLD='\033[1m'; RESET='\033[0m'; CYAN='\033[1;36m'; YELLOW='\033[1;33m'; GREEN='\033[1;32m'
log()  { printf '\033[1;34m[tws-panel]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[tws-panel][erro]\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker não encontrado — rode este script na VPS do painel."

# 1) token do arquivo no volume (gravado pelo install.sh)
TOKEN="$(docker run --rm -v "$VOLUME_NAME:/data" alpine:3 \
  sh -c 'cat /data/setup-token 2>/dev/null || true' 2>/dev/null || true)"

# 2) fallback: variável de ambiente do container em execução
if [ -z "$TOKEN" ] && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'tws-panel'; then
  TOKEN="$(docker exec tws-panel sh -c 'printf %s "${SETUP_TOKEN:-}"' 2>/dev/null || true)"
fi

[ -n "$TOKEN" ] || die "setup token não encontrado (nem no volume $VOLUME_NAME, nem no container tws-panel). O painel está instalado?"

# IP público (melhor esforço; o acesso local sempre funciona)
PUBLIC_IP="${PAAS_PUBLIC_IP:-}"
if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null \
    || curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null \
    || hostname -I 2>/dev/null | awk '{print $1}' \
    || echo 'SEU-IP')"
fi

printf '\a'
cat <<EOF

${GREEN}${BOLD}██████████████████████████████████████████████████████████████████████████████
██                                                                          ██
██                  🔑  TWS PANEL — CREDENCIAIS DO ASSISTENTE                 ██
██                                                                          ██
██████████████████████████████████████████████████████████████████████████████${RESET}

${BOLD}👉  Abra este link no seu navegador:${RESET}

${CYAN}${BOLD}      http://$PUBLIC_IP:$PORT/?token=$TOKEN${RESET}

${YELLOW}${BOLD}┌──────────────────────────────────────────────────────────────────────────┐
│                            ⚑  SETUP TOKEN  ⚑                              │
│                                                                          │
│   $TOKEN
│                                                                          │
│   ⚠  Guarde-o até concluir o wizard.                                     │
│   ⚠  Após criar a conta admin (passo 4), ele é invalidado.               │
└──────────────────────────────────────────────────────────────────────────┘${RESET}

${BOLD}Para recomeçar o wizard do zero:${RESET} ./scripts/reset-setup.sh
EOF

log "token lido do volume $VOLUME_NAME (/data/setup-token)."
