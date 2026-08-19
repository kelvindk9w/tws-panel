#!/usr/bin/env bash
# =============================================================================
# TWS Panel — instalador one-shot (100% Docker)
#
# Uso (como root em uma VPS Ubuntu 22.04/24.04 limpa):
#   apt update && apt install -y git
#   git clone <repo> /opt/tws-panel && cd /opt/tws-panel
#   ./scripts/install.sh
#
# Pré-requisito: Ubuntu com git. Não precisa instalar Docker, Node ou mais
# nada manualmente — este script cuida de tudo.
#
# O que faz:
#   1. Verifica o SO (Ubuntu 22.04/24.04; avisa em outros)
#   2. Instala git se ausente
#   3. Instala Docker se ausente (get.docker.com) + plugin compose
#   4. Define o diretório alvo (default /opt/tws-panel; personalize com
#      PAAS_DIR=<dir> ou ./scripts/install.sh <dir>) e clona o repo se ele
#      não existir (ou usa o diretório atual se já for o repo)
#   5. Gera SETUP_TOKEN aleatório (persistido no volume paas_data)
#   6. docker compose up -d --build (build da imagem + sobe o painel na 9000)
#   7. Imprime a URL do wizard + o token
#
# Idempotente: pode ser executado mais de uma vez sem quebrar.
# =============================================================================
set -euo pipefail

REPO_URL="${TWS_REPO_URL:-https://github.com/<org>/tws-panel.git}"
TARGET_DIR="${1:-${PAAS_DIR:-/opt/tws-panel}}"
PORT="${PAAS_PORT:-9000}"
COMPOSE_FILE="docker-compose.yml"

log()  { printf '\033[1;34m[tws-panel]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[tws-panel][aviso]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[tws-panel][erro]\033[0m %s\n' "$*" >&2; exit 1; }

# --- 0. Pré-requisitos básicos ----------------------------------------------
[ "$(id -u)" -eq 0 ] || die "Execute como root (ou via sudo)."

# --- 1. Verificação do SO -----------------------------------------------------
. /etc/os-release
log "SO detectado: ${PRETTY_NAME:-desconhecido}"
if [ "${ID:-}" != "ubuntu" ] || { [ "${VERSION_ID:-}" != "22.04" ] && [ "${VERSION_ID:-}" != "24.04" ]; }; then
  warn "Este instalador foi testado em Ubuntu 22.04/24.04. Prosseguindo por sua conta e risco."
fi

# --- 2. git --------------------------------------------------------------------
if ! command -v git >/dev/null 2>&1; then
  log "Instalando git…"
  apt-get update -qq
  apt-get install -y -qq git
else
  log "git já instalado: $(git --version)"
fi

# --- 3. Docker -------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "Instalando Docker (get.docker.com)…"
  command -v curl >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq curl ca-certificates; }
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
else
  log "Docker já instalado: $(docker --version)"
fi

docker compose version >/dev/null 2>&1 || die "Plugin 'docker compose' não encontrado. Reinstale o Docker por https://get.docker.com"

# --- 4. Diretório alvo / clone do repo --------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$SCRIPT_DIR/../$COMPOSE_FILE" ] && [ -f "$SCRIPT_DIR/../Dockerfile" ]; then
  # Script rodando de dentro do repo clonado — usa o próprio diretório.
  APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  log "Repo detectado em $APP_DIR — usando o diretório atual."
else
  APP_DIR="$TARGET_DIR"
  if [ -d "$APP_DIR/.git" ]; then
    log "Repo já existe em $APP_DIR — atualizando (git pull)…"
    git -C "$APP_DIR" pull --ff-only || warn "git pull falhou; seguindo com a versão local."
  else
    log "Clonando $REPO_URL em $APP_DIR…"
    git clone "$REPO_URL" "$APP_DIR"
  fi
fi
cd "$APP_DIR"

# --- 5. Setup token ------------------------------------------------------------------
# O token fica no volume paas_data (/data/setup-token dentro do container).
# Antes do primeiro boot, gravamos via container auxiliar para não depender
# de Node no host.
# Nome fixo definido no docker-compose.yml.
VOLUME_NAME="paas_data"
docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1 || docker volume create "$VOLUME_NAME" >/dev/null

EXISTING_TOKEN="$(docker run --rm -v "$VOLUME_NAME:/data" alpine sh -c 'cat /data/setup-token 2>/dev/null || true' 2>/dev/null || true)"
if [ -n "${SETUP_TOKEN:-}" ]; then
  log "Usando SETUP_TOKEN fornecido via ambiente."
elif [ -n "$EXISTING_TOKEN" ]; then
  SETUP_TOKEN="$EXISTING_TOKEN"
  log "Setup token já existe no volume $VOLUME_NAME — reutilizando."
else
  if command -v openssl >/dev/null 2>&1; then
    SETUP_TOKEN="$(openssl rand -hex 24)"
  else
    SETUP_TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
fi

# --- 6. Build + subida ------------------------------------------------------------------
log "Buildando a imagem e subindo o painel (docker compose up -d --build)…"
SETUP_TOKEN="$SETUP_TOKEN" docker compose -f "$COMPOSE_FILE" up -d --build

# Garante o token também em arquivo no volume (fallback caso SETUP_TOKEN não
# seja passado nas próximas subidas — ex.: restart da máquina).
docker run --rm -v "$VOLUME_NAME:/data" alpine sh -c \
  "printf '%s' '$SETUP_TOKEN' > /data/setup-token && chmod 600 /data/setup-token"

# --- 7. Resumo ---------------------------------------------------------------------------
PUBLIC_IP="$(curl -fsSL --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"

cat <<EOF

================================================================================
  ✅ TWS Panel instalado e rodando!

  Abra no navegador:

      http://$PUBLIC_IP:$PORT/?token=$SETUP_TOKEN

  Setup token:

      $SETUP_TOKEN

  O assistente vai diagnosticar o servidor e guiar o setup.

  Comandos úteis (em $APP_DIR):
    docker compose ps              # status do painel
    docker compose logs -f panel   # logs em tempo real
    docker compose up -d --build   # rebuild/restart (ex.: após git pull)
================================================================================
EOF
