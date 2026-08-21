#!/usr/bin/env bash
# =============================================================================
# TWS Panel — instalador one-shot (100% Docker)
#
# Uso (como root em uma VPS Ubuntu 22.04/24.04 limpa):
#   apt update && apt install -y git
#   git clone https://github.com/kelvindk9w/tws-panel.git /opt/tws-panel
#   cd /opt/tws-panel && ./scripts/install.sh
#
# Pré-requisito: Ubuntu com git. Não precisa instalar Docker, Node ou mais
# nada manualmente — este script cuida de tudo.
#
# O que faz:
#   1. PRÉ-FLIGHT (somente leitura, antes de instalar qualquer coisa):
#      SO, RAM/disco, Docker/containers, portas 80/443/9000/25/587/993 e
#      serviços conhecidos (nginx, apache, caddy, postfix, mysql, postgres).
#      Se a VPS não estiver limpa, exibe um relatório e exige confirmação
#      interativa (digitar "continuar") ou --force / PAAS_FORCE=1.
#      NUNCA remove ou para nada que já exista na máquina.
#   2. Instala git se ausente
#   3. Instala Docker se ausente (get.docker.com) + plugin compose
#   4. Define o diretório alvo (default /opt/tws-panel; personalize com
#      PAAS_DIR=<dir> ou ./scripts/install.sh <dir>) e clona o repo se ele
#      não existir (ou usa o diretório atual se já for o repo)
#   5. Gera SETUP_TOKEN aleatório (persistido no volume paas_data)
#   6. docker compose up -d --build (build da imagem + sobe o painel na 9000)
#   7. Imprime a URL do wizard + o token
#
# Idempotente: pode ser executado mais de uma vez sem quebrar (uma
# reinstalação detecta o próprio painel e não a trata como conflito).
# =============================================================================
set -euo pipefail

REPO_URL="${TWS_REPO_URL:-https://github.com/kelvindk9w/tws-panel.git}"
PORT="${PAAS_PORT:-9000}"
COMPOSE_FILE="docker-compose.yml"

log()  { printf '\033[1;34m[tws-panel]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[tws-panel][aviso]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[tws-panel][erro]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Uso: $0 [--force] [diretório-alvo]

  --force          prossegue mesmo se o pré-flight encontrar conflitos
                   (equivalente a PAAS_FORCE=1 — útil em automação)
  diretório-alvo   onde clonar o repo quando o script roda fora dele
                   (default: /opt/tws-panel, ou \$PAAS_DIR)
EOF
}

# --- Argumentos ---------------------------------------------------------------
FORCE=0
TARGET_ARG=""
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      if [ -z "$TARGET_ARG" ]; then
        TARGET_ARG="$arg"
      else
        die "Argumento desconhecido: $arg (veja --help)"
      fi
      ;;
  esac
done
[ "${PAAS_FORCE:-0}" = "1" ] && FORCE=1
TARGET_DIR="${TARGET_ARG:-${PAAS_DIR:-/opt/tws-panel}}"

# --- 0. Pré-requisitos básicos ----------------------------------------------
[ "$(id -u)" -eq 0 ] || die "Execute como root (ou via sudo)."

# --- 1. Pré-flight check (SOMENTE LEITURA) -------------------------------------
# Roda ANTES de instalar qualquer coisa. Nada aqui altera o sistema: apenas
# detecta e reporta. Se a VPS não estiver limpa, exigimos confirmação
# explícita — este instalador nunca remove/para nada que já exista.
ISSUES=0
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
info() { printf '  \033[1;34mℹ\033[0m %s\n' "$*"; }
flag() { printf '  \033[1;33m⚠\033[0m %s\n' "$*"; ISSUES=$((ISSUES + 1)); }

log "Pré-flight: inspecionando a máquina (nada será alterado nesta etapa)…"

# SO: Ubuntu 22.04/24.04 = ok; qualquer outro = aviso.
. /etc/os-release
if [ "${ID:-}" = "ubuntu" ] && { [ "${VERSION_ID:-}" = "22.04" ] || [ "${VERSION_ID:-}" = "24.04" ]; }; then
  ok "SO: ${PRETTY_NAME} (suportado)"
else
  flag "SO: ${PRETTY_NAME:-desconhecido} — instalador testado apenas em Ubuntu 22.04/24.04"
fi

# RAM total mínima: 1.5 GB (o painel é leve, mas os builds Docker precisam de folga).
RAM_MB="$(awk '/^MemTotal:/ {print int($2 / 1024)}' /proc/meminfo)"
if [ "${RAM_MB:-0}" -ge 1536 ]; then
  ok "RAM: ${RAM_MB} MB"
else
  flag "RAM: ${RAM_MB:-?} MB (< 1536 MB recomendado)"
fi

# Disco livre em /: mínimo 10 GB (imagem do painel + Docker + projetos).
DISK_FREE_MB="$(df -Pm / | awk 'NR==2 {print $4}')"
if [ "${DISK_FREE_MB:-0}" -ge 10240 ]; then
  ok "Disco livre em /: $((DISK_FREE_MB / 1024)) GB"
else
  flag "Disco livre em /: $(( ${DISK_FREE_MB:-0} / 1024 )) GB (< 10 GB recomendado)"
fi

# Docker já instalado? Containers rodando? (o próprio painel, em reinstalação,
# não conta como conflito)
OWN_PANEL=0
if command -v docker >/dev/null 2>&1; then
  info "Docker já instalado: $(docker --version 2>/dev/null || echo 'versão desconhecida')"
  if RUNNING="$(docker ps --format '{{.Names}}' 2>/dev/null)"; then
    if printf '%s\n' "$RUNNING" | grep -qx 'tws-panel'; then
      OWN_PANEL=1
      info "Instalação existente do TWS Panel detectada (container 'tws-panel') — reinstalação/atualização."
    fi
    OTHER="$(printf '%s\n' "$RUNNING" | grep -vx 'tws-panel' | grep -v '^$' || true)"
    if [ -n "$OTHER" ]; then
      flag "Containers Docker em execução: $(printf '%s\n' "$OTHER" | paste -sd' ' -)"
    elif [ "$OWN_PANEL" = "0" ]; then
      ok "Nenhum container Docker em execução"
    fi
  else
    info "Docker instalado, mas o daemon não respondeu (docker ps falhou)."
  fi
else
  ok "Docker: ausente (será instalado por este script)"
fi

# Portas em uso: 80/443 (proxy Caddy), 9000 (painel), 25/587/993 (e-mail).
if command -v ss >/dev/null 2>&1; then
  PORTS_IN_USE=""
  for p in 80 443 9000 25 587 993; do
    if ss -tuln | awk '{print $5}' | grep -qE "(^|:)${p}$"; then
      # Na reinstalação, a 9000 ocupada pelo próprio painel não é conflito.
      if [ "$p" = "9000" ] && [ "$OWN_PANEL" = "1" ] && \
         docker ps --filter 'name=^/tws-panel$' --format '{{.Ports}}' 2>/dev/null | grep -q ':9000->'; then
        continue
      fi
      PORTS_IN_USE="$PORTS_IN_USE $p"
    fi
  done
  if [ -n "$PORTS_IN_USE" ]; then
    flag "Portas em uso:$PORTS_IN_USE"
  else
    ok "Portas 80/443/9000/25/587/993 livres"
  fi
else
  info "Utilitário 'ss' ausente — verificação de portas ignorada."
fi

# Web servers/serviços conhecidos ativos (podem conflitar com Caddy/Stalwart).
for svc in nginx apache2 caddy postfix mysql postgresql; do
  if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
    systemctl is-active --quiet "$svc" 2>/dev/null && flag "Serviço ativo: $svc"
  else
    proc="$svc"
    [ "$svc" = "postgresql" ] && proc="postgres"
    pgrep -x "$proc" >/dev/null 2>&1 && flag "Serviço ativo: $svc (processo $proc)"
  fi
done

# Veredito do pré-flight.
if [ "$ISSUES" -eq 0 ]; then
  log "Máquina limpa detectada ✓ — prosseguindo com a instalação."
else
  cat >&2 <<EOF

================================================================================
  ⚠️  ATENÇÃO: esta VPS NÃO parece estar limpa ($ISSUES ponto(s) acima).

  O TWS Panel foi feito para uma VPS Ubuntu LIMPA. Continuar pode causar
  conflitos (portas, serviços, recursos) com o que já existe na máquina.
  Este instalador NUNCA remove ou para nada que já exista — mas os
  serviços do painel podem falhar ao subir se as portas estiverem ocupadas.

  Para prosseguir mesmo assim, digite "continuar" — ou rode com
  --force (PAAS_FORCE=1) em automações.
================================================================================

EOF
  if [ "$FORCE" = "1" ]; then
    warn "--force/PAAS_FORCE=1 ativo — prosseguindo apesar dos avisos."
  else
    ANSWER=""
    printf 'Digite "continuar" para prosseguir: ' >&2
    read -r ANSWER 2>/dev/null < /dev/tty || true
    [ "$ANSWER" = "continuar" ] || die "Instalação abortada. Nada foi instalado ou alterado."
    log "Confirmação recebida — prosseguindo."
  fi
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

# --- 5b. GID do grupo do docker.sock ------------------------------------------------------
# O painel roda como usuário não-root (tws) e acessa o socket via group_add.
# Persistimos o GID no .env para sobreviver a restarts/rebuilds futuros.
DOCKER_GID="$(stat -c %g /var/run/docker.sock 2>/dev/null || echo 999)"
if [ -f .env ] && grep -q '^DOCKER_GID=' .env; then
  sed -i "s/^DOCKER_GID=.*/DOCKER_GID=$DOCKER_GID/" .env
else
  printf 'DOCKER_GID=%s\n' "$DOCKER_GID" >> .env
fi
log "Grupo do docker.sock no host: GID $DOCKER_GID (gravado em .env)"

# --- 6. Build + subida ------------------------------------------------------------------
log "Buildando a imagem e subindo o painel (docker compose up -d --build)…"
SETUP_TOKEN="$SETUP_TOKEN" docker compose -f "$COMPOSE_FILE" up -d --build

# Garante o token também em arquivo no volume (fallback caso SETUP_TOKEN não
# seja passado nas próximas subidas — ex.: restart da máquina).
docker run --rm -v "$VOLUME_NAME:/data" alpine sh -c \
  "printf '%s' '$SETUP_TOKEN' > /data/setup-token && chmod 600 /data/setup-token"

# --- 7. Resumo ---------------------------------------------------------------------------
PUBLIC_IP="$(curl -fsSL --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"

# Cores/ênfase (só se o terminal suportar).
if [ -t 1 ]; then
  BOLD="$(tput bold 2>/dev/null || true)"; RESET="$(tput sgr0 2>/dev/null || true)"
  GREEN="$(tput setaf 2 2>/dev/null || true)"; YELLOW="$(tput setaf 3 2>/dev/null || true)"
  CYAN="$(tput setaf 6 2>/dev/null || true)"; BG_GREEN="$(tput setab 2 2>/dev/null || true)"
else
  BOLD=""; RESET=""; GREEN=""; YELLOW=""; CYAN=""; BG_GREEN=""
fi

# Toca o "bell" do terminal para chamar atenção ao fim da instalação.
printf '\a'

cat <<EOF

${GREEN}${BOLD}██████████████████████████████████████████████████████████████████████████████
██                                                                          ██
██               ✅  TWS PANEL INSTALADO E RODANDO COM SUCESSO!               ██
██                                                                          ██
██████████████████████████████████████████████████████████████████████████████${RESET}

${BOLD}👉  PASSO ÚNICO AGORA: abra este link no seu navegador${RESET}

${CYAN}${BOLD}      http://$PUBLIC_IP:$PORT/?token=$SETUP_TOKEN${RESET}

${YELLOW}${BOLD}┌──────────────────────────────────────────────────────────────────────────┐
│                            ⚑  SETUP TOKEN  ⚑                              │
│                                                                          │
│   $SETUP_TOKEN                       │
│                                                                          │
│   ⚠  Ele aparece SÓ AGORA em destaque. Guarde-o até concluir o wizard.   │
│   ⚠  Após criar sua conta admin (passo 4 do wizard), ele é invalidado.   │
└──────────────────────────────────────────────────────────────────────────┘${RESET}

${BOLD}Perdeu o token? Recupere a qualquer momento com:${RESET}

      docker exec tws-panel cat /data/setup-token

O assistente vai diagnosticar o servidor e guiar o setup.

Comandos úteis (em $APP_DIR):
    docker compose ps              # status do painel
    docker compose logs -f panel   # logs em tempo real
    docker compose up -d --build   # rebuild/restart (ex.: após git pull)

EOF
