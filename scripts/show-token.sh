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
#   PAAS_PORT=9000        porta do painel NA VPS (vence o valor gravado no .env)
#   PAAS_VOLUME=paas_data nome do volume de dados
#   PAAS_PUBLIC_IP=<ip>   pula a detecção automática de IP público
# =============================================================================
set -euo pipefail

VOLUME_NAME="${PAAS_VOLUME:-paas_data}"

if [ -t 1 ]; then
  BOLD="$(tput bold 2>/dev/null || true)"; RESET="$(tput sgr0 2>/dev/null || true)"
  CYAN="$(tput setaf 6 2>/dev/null || true)"; YELLOW="$(tput setaf 3 2>/dev/null || true)"
  GREEN="$(tput setaf 2 2>/dev/null || true)"
else
  BOLD=""; RESET=""; CYAN=""; YELLOW=""; GREEN=""
fi
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

# Usuário do túnel SSH: o escolhido na instalação (PAAS_TERMINAL_USER no .env do
# repositório) quando não for root — o hardening desliga o SSH de root, então
# um túnel como root deixaria de funcionar. Sem escolha registrada, usa quem
# chamou o sudo, como antes.
ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
env_value() {
  [ -r "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | tr -d '"'"'"
}
TERMINAL_USER="$(env_value PAAS_TERMINAL_USER)"
ROOT_MODE="$(env_value PAAS_ROOT_MODE)"

# Porta do painel NA VPS: a mesma fonte e a mesma precedência do usuário do
# túnel — PAAS_PORT do ambiente > o que o instalador gravou no .env > 9000.
# Sem isso, quem instalou em outra porta veria aqui um link que não abre.
PORT="${PAAS_PORT:-$(env_value PAAS_PORT)}"
PORT="${PORT:-9000}"
if [ -n "$TERMINAL_USER" ] && [ "$TERMINAL_USER" != "root" ]; then
  TUNNEL_USER="$TERMINAL_USER"
else
  TUNNEL_USER="${SUDO_USER:-SEU_USUARIO}"
fi

# IP público (melhor esforço; o acesso local sempre funciona)
PUBLIC_IP="${PAAS_PUBLIC_IP:-}"
if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null \
    || curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null \
    || hostname -I 2>/dev/null | awk '{print $1}' \
    || echo 'SEU-IP')"
fi

# No modo "senha" a senha do sudo também é digitada no terminal do painel.
SUDO_NOTE=""
[ "$ROOT_MODE" = "senha" ] && SUDO_NOTE=", assim como a senha do sudo que você digitar no terminal do painel"

# Porta alternativa citada quando a ponta local do túnel estiver ocupada.
LOCAL_ALT=9100
[ "$PORT" = "9100" ] && LOCAL_ALT=9101

printf '\a'
cat <<EOF

${GREEN}${BOLD}██████████████████████████████████████████████████████████████████████████████
██                                                                          ██
██                  🔑  TWS PANEL — CREDENCIAIS DO ASSISTENTE                 ██
██                                                                          ██
██████████████████████████████████████████████████████████████████████████████${RESET}

${BOLD}👉  Abra o painel no navegador${RESET}

${BOLD}Recomendado — por túnel SSH.${RESET} Numa janela NOVA, no SEU COMPUTADOR, deixe aberto:

${CYAN}${BOLD}      ssh -L $PORT:localhost:$PORT ${TUNNEL_USER}@$PUBLIC_IP${RESET}

      Se o ssh recusar com "bind [127.0.0.1]:$PORT: Address already in use", a porta
      ocupada é a do SEU computador (o número da ESQUERDA), não a da VPS. Troque só
      ele — por exemplo ssh -L $LOCAL_ALT:localhost:$PORT ${TUNNEL_USER}@$PUBLIC_IP — e abra o
      navegador em http://localhost:$LOCAL_ALT/... em vez de :$PORT.

E então acesse:

${CYAN}${BOLD}      http://localhost:$PORT/?token=$TOKEN${RESET}

${YELLOW}Direto pelo IP${RESET} — sem criptografia; o token e a senha de admin trafegam
em texto claro${SUDO_NOTE}. Use só em rede confiável ou ambiente de teste descartável:

${CYAN}      http://$PUBLIC_IP:$PORT/?token=$TOKEN${RESET}

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
