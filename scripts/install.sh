#!/usr/bin/env bash
# =============================================================================
# Painel PaaS — instalador one-shot
#
# Uso (como root em uma VPS Ubuntu 22.04/24.04):
#   git clone <repo> /opt/paas && cd /opt/paas && ./scripts/install.sh
#
# O que faz:
#   1. Verifica o SO (Ubuntu 22.04/24.04; avisa em outros)
#   2. Instala dependências ausentes: Node 22 (NodeSource), pnpm (corepack), git
#   3. Instala Docker se ausente (get.docker.com)
#   4. pnpm install + build do monorepo
#   5. Gera SETUP_TOKEN aleatório e salva em /etc/paas/setup-token (chmod 600)
#   6. Cria/habilita o systemd unit paas-setup.service (porta 9000)
#   7. Imprime a URL do wizard + o token
#
# Idempotente: pode ser executado mais de uma vez sem quebrar.
# =============================================================================
set -euo pipefail

APP_DIR="${PAAS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
TOKEN_DIR="/etc/paas"
TOKEN_FILE="$TOKEN_DIR/setup-token"
SERVICE_NAME="paas-setup.service"
PORT="${PAAS_PORT:-9000}"

log()  { printf '\033[1;34m[paas]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[paas][aviso]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[paas][erro]\033[0m %s\n' "$*" >&2; exit 1; }

# --- 0. Pré-requisitos básicos ----------------------------------------------
[ "$(id -u)" -eq 0 ] || die "Execute como root (ou via sudo)."
command -v curl >/dev/null 2>&1 || apt-get update -qq && apt-get install -y -qq curl ca-certificates gnupg

# --- 1. Verificação do SO -----------------------------------------------------
. /etc/os-release
log "SO detectado: ${PRETTY_NAME:-desconhecido}"
if [ "${ID:-}" != "ubuntu" ] || { [ "${VERSION_ID:-}" != "22.04" ] && [ "${VERSION_ID:-}" != "24.04" ]; }; then
  warn "Este instalador foi testado em Ubuntu 22.04/24.04. Prosseguindo por sua conta e risco."
fi

# --- 2. Node 22 / pnpm / git ---------------------------------------------------
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  log "Instalando Node.js 22 (NodeSource)…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
else
  log "Node.js já instalado: $(node -v)"
fi

if ! command -v pnpm >/dev/null 2>&1; then
  log "Habilitando pnpm via corepack…"
  corepack enable
  corepack prepare pnpm@latest --activate
else
  log "pnpm já instalado: $(pnpm -v)"
fi

if ! command -v git >/dev/null 2>&1; then
  log "Instalando git…"
  apt-get install -y -qq git
fi

# --- 3. Docker ------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "Instalando Docker (get.docker.com)…"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
else
  log "Docker já instalado: $(docker --version)"
fi

# --- 4. Build do monorepo ---------------------------------------------------------
log "Instalando dependências e buildando (em $APP_DIR)…"
cd "$APP_DIR"
pnpm install --frozen-lockfile=false
pnpm build

# --- 5. Setup token ---------------------------------------------------------------
mkdir -p "$TOKEN_DIR"
if [ -s "$TOKEN_FILE" ]; then
  log "Setup token já existe em $TOKEN_FILE — reutilizando."
else
  openssl rand -hex 24 > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  log "Setup token gerado em $TOKEN_FILE (permissão 600)."
fi
SETUP_TOKEN="$(cat "$TOKEN_FILE")"

# --- 6. systemd unit ----------------------------------------------------------------
cat > "/etc/systemd/system/$SERVICE_NAME" <<EOF
[Unit]
Description=Painel PaaS — assistente de setup (porta $PORT)
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
WorkingDirectory=$APP_DIR/apps/server
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=SETUP_TOKEN_FILE=$TOKEN_FILE
Environment=PAAS_DATA_DIR=$APP_DIR/data
ExecStart=$(command -v pnpm) start
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
log "Serviço $SERVICE_NAME ativo."

# --- 7. Resumo ------------------------------------------------------------------------
PUBLIC_IP="$(curl -fsSL --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"

cat <<EOF

================================================================================
  ✅ Instalação concluída!

  Abra no navegador:

      http://$PUBLIC_IP:$PORT/?token=$SETUP_TOKEN

  Setup token (também em $TOKEN_FILE):

      $SETUP_TOKEN

  O assistente vai diagnosticar o servidor e guiar o setup.
  A porta $PORT será fechada automaticamente ao final do setup.

  Comandos úteis:
    systemctl status $SERVICE_NAME    # status do serviço
    journalctl -u $SERVICE_NAME -f    # logs em tempo real
================================================================================
EOF
