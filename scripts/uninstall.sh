#!/usr/bin/env bash
# =============================================================================
# TWS Panel — uninstall.sh
#
# Remove o painel desta VPS para você poder instalar de novo SEM reinstalar o
# sistema operacional. Depois dele, recomece pelo Passo 6 do README (clonar o
# repositório em /opt/tws-panel) — o Passo 5 (git) já está feito.
#
# Uso (na VPS, como o seu usuário — ele se reexecuta via sudo):
#   ./scripts/uninstall.sh --dry-run     # só MOSTRA o que seria removido
#   ./scripts/uninstall.sh               # mostra, pede para digitar "remover" e remove
#   ./scripts/uninstall.sh --keep-repo   # idem, mas mantém a pasta do repositório
#
# O QUE É REMOVIDO (só o que existir — a lista exata aparece antes):
#   • container do painel "tws-panel" e a imagem "tws-panel:latest"
#     (docker-compose.yml: container_name / image)
#   • proxy "paas-caddy" + volumes "paas_caddy_data" e "paas_caddy_config"
#     (packages/core/src/deploy.ts, packages/deploy/src/caddy.ts)
#   • servidor de e-mail "paas-stalwart" + volume "paas_stalwart_data"
#     (packages/core/src/mail.ts, packages/mailer/src/server.ts)
#   • containers auxiliares descartáveis: paas-terminal-<8 hex> (terminal web),
#     paas-host-exec-<8 hex> e paas-host-upload-<8 hex> (ponte com a VPS),
#     paas-build-<projeto> (build de site estático)
#     (apps/server/src/services/docker-socket.ts, packages/security/src/runner.ts,
#      packages/deploy/src/engine.ts)
#   • projetos implantados: containers com a etiqueta paas.managed=true ou
#     paas.project, e stacks compose cujo nome começa com "paas-" (com as redes
#     e volumes dessas stacks); imagens "paas-*" geradas no deploy
#     (packages/deploy/src/engine.ts, packages/core/src/deploy.ts)
#   • rede "paas-net" (packages/core/src/deploy.ts)
#   • volume "paas_data" — todo o estado do painel: conta admin, token,
#     projetos cadastrados, e-mail, histórico de segurança (docker-compose.yml)
#   • pasta dos projetos no host: PAAS_PROJECTS_DIR do .env (padrão
#     /opt/tws-projects) — o CÓDIGO e os DADOS dos seus projetos
#   • pasta dos scripts de hardening no host: /opt/paas-hardening
#     (apps/server/src/services/terminal-runner.ts, packages/security/src/runner.ts)
#   • rede padrão do compose do próprio painel (tws-panel_default)
#   • sobras que o Docker da VPS cria quando o painel monta arquivos do Caddy e
#     do Stalwart: /data/caddy/Caddyfile e /data/mail/stalwart, se existirem
#     (e /data/caddy, /data/mail, /data só se ficarem vazias)
#     (apps/server/src/services/deploy-service.ts, mail-service.ts)
#   • o arquivo .env e, por último, a pasta do repositório (/opt/tws-panel ou
#     onde este script estiver) — a menos que use --keep-repo
#
# O QUE ELE NÃO DESFAZ (e não tem como desfazer com segurança):
#   • as fases de hardening já aplicadas: senha do root travada, configuração do
#     SSH (login por senha e de root desligados), firewall UFW, fail2ban,
#     AppArmor, atualizações automáticas, pacotes removidos (ex.: snapd),
#     auditd/AIDE/rkhunter e o agendamento /etc/cron.d/paas-security-scan,
#     os backups *.paas-backup.* e o estado em /etc/paas;
#   • o seu usuário não-root e a chave SSH instalada nele. Se ele estiver no
#     grupo docker (instaladores antigos faziam isso), essa entrada também
#     fica — e ela equivale a root sem senha: remova com
#     `sudo gpasswd -d <usuário> docker`;
#   • o Docker e o git;
#   • imagens públicas baixadas (alpine, caddy, stalwart, node, nginx) — são só
#     cache; o comando para apagá-las é mostrado no final.
# Para uma validação "do zero de verdade", o caminho continua sendo reinstalar
# o sistema no painel do provedor (veja o README).
#
# ⚠  Não há desfazer. Exige confirmação digitada ("remover").
# =============================================================================
set -euo pipefail

# Tudo dentro de main(): o bash lê o script inteiro antes de executar, então
# apagar a pasta do repositório (onde este arquivo mora) no final é seguro.
main() {
  local DRY_RUN=0 KEEP_REPO=0 arg
  for arg in "$@"; do
    case "$arg" in
      --dry-run) DRY_RUN=1 ;;
      --keep-repo) KEEP_REPO=1 ;;
      -h|--help) awk 'NR > 2 && /^# =====/ {exit} NR > 2' "$0"; exit 0 ;;
      *) die "argumento desconhecido: $arg (use --dry-run, --keep-repo ou --help)" ;;
    esac
  done

  if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null 2>&1 || die "Este script precisa de root. Rode como root ou instale o sudo."
    log "Privilégios de administrador necessários — reexecutando via sudo…"
    exec sudo --preserve-env=PAAS_PROJECTS_DIR bash "$(readlink -f "$0")" "$@"
  fi

  if [ -t 1 ]; then
    BOLD="$(tput bold 2>/dev/null || true)"; RESET="$(tput sgr0 2>/dev/null || true)"
    RED="$(tput setaf 1 2>/dev/null || true)"; YELLOW="$(tput setaf 3 2>/dev/null || true)"
    GREEN="$(tput setaf 2 2>/dev/null || true)"
  else
    BOLD=""; RESET=""; RED=""; YELLOW=""; GREEN=""
  fi

  # --- Repositório --------------------------------------------------------------
  local SELF REPO_DIR
  SELF="$(readlink -f "$0")"
  REPO_DIR="$(cd "$(dirname "$SELF")/.." && pwd)"
  # Só aceita apagar uma pasta que É o repositório do painel.
  if [ ! -f "$REPO_DIR/docker-compose.yml" ] || [ ! -f "$REPO_DIR/scripts/install.sh" ] || \
     ! grep -q 'container_name: tws-panel' "$REPO_DIR/docker-compose.yml" 2>/dev/null; then
    die "Não reconheci $REPO_DIR como o repositório do TWS Panel. Rode este script de dentro dele (ex.: /opt/tws-panel/scripts/uninstall.sh)."
  fi
  is_protected_dir "$REPO_DIR" && die "Recusando: $REPO_DIR é uma pasta do sistema."

  # --- Pasta dos projetos ---------------------------------------------------------
  local ENV_FILE="$REPO_DIR/.env" PROJECTS_DIR=""
  if [ -f "$ENV_FILE" ]; then
    PROJECTS_DIR="$(sed -n 's/^PAAS_PROJECTS_DIR=//p' "$ENV_FILE" | tail -n1)"
  fi
  PROJECTS_DIR="${PROJECTS_DIR:-${PAAS_PROJECTS_DIR:-/opt/tws-projects}}"
  local PROJECTS_DIR_OK=1
  case "$PROJECTS_DIR" in
    /*/*|/opt/tws-projects) ;;
    *) PROJECTS_DIR_OK=0 ;;
  esac
  if is_protected_dir "$PROJECTS_DIR"; then PROJECTS_DIR_OK=0; fi
  case "$REPO_DIR/" in "${PROJECTS_DIR%/}/"*) PROJECTS_DIR_OK=0 ;; esac

  # --- Descoberta (somente leitura) ----------------------------------------------
  local HAVE_DOCKER=0
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    HAVE_DOCKER=1
  fi

  local -a CONTAINERS=() NETWORKS=() VOLUMES=() IMAGES=() PATHS=()
  if [ "$HAVE_DOCKER" = "1" ]; then
    # Containers: nomes exatos + padrões exatos + etiquetas do painel.
    local id name project filter
    while IFS=$'\t' read -r id name project; do
      [ -n "$id" ] || continue
      if [ "$name" = "tws-panel" ] || [ "$name" = "paas-caddy" ] || [ "$name" = "paas-stalwart" ] || \
         [[ "$name" =~ ^paas-(terminal|host-exec|host-upload)-[0-9a-f]{8}$ ]] || \
         [[ "$name" =~ ^paas-build-[a-z0-9-]+$ ]] || \
         [[ "$project" == paas-* ]]; then
        add_unique CONTAINERS "$name"
      fi
    done < <(docker ps -a --format '{{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.project"}}' 2>/dev/null || true)
    for filter in label=paas.managed=true label=paas.project; do
      while read -r name; do
        [ -n "$name" ] && add_unique CONTAINERS "$name"
      done < <(docker ps -a --filter "$filter" --format '{{.Names}}' 2>/dev/null || true)
    done

    # Redes: paas-net, a rede padrão que o `docker compose` cria para o próprio
    # painel (<projeto compose>_default — o nome do projeto vem da etiqueta do
    # container tws-panel ou, sem ele, do nome da pasta do repositório) e as
    # redes das stacks compose "paas-*".
    local PANEL_PROJECT
    PANEL_PROJECT="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' tws-panel 2>/dev/null || true)"
    [ -n "$PANEL_PROJECT" ] || PANEL_PROJECT="$(basename "$REPO_DIR" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')"
    while IFS=$'\t' read -r name project; do
      [ -n "$name" ] || continue
      if [ "$name" = "paas-net" ] || [[ "$project" == paas-* ]] || \
         { [ -n "$PANEL_PROJECT" ] && [ "$project" = "$PANEL_PROJECT" ] && [ "$name" = "${PANEL_PROJECT}_default" ]; }; then
        add_unique NETWORKS "$name"
      fi
    done < <(docker network ls --format '{{.Name}}\t{{.Label "com.docker.compose.project"}}' 2>/dev/null || true)

    # Volumes: nomes exatos + volumes das stacks compose "paas-*".
    while IFS=$'\t' read -r name project; do
      [ -n "$name" ] || continue
      case "$name" in
        paas_data|paas_caddy_data|paas_caddy_config|paas_stalwart_data) add_unique VOLUMES "$name" ;;
        *) [[ "$project" == paas-* ]] && add_unique VOLUMES "$name" ;;
      esac
    done < <(docker volume ls --format '{{.Name}}\t{{.Label "com.docker.compose.project"}}' 2>/dev/null || true)

    # Imagens: a do painel e as geradas pelo deploy (paas-<projeto>…).
    while read -r name; do
      [ -n "$name" ] || continue
      if [ "$name" = "tws-panel:latest" ] || [[ "$name" =~ ^paas-[a-z0-9._-]+:[A-Za-z0-9._-]+$ ]]; then
        add_unique IMAGES "$name"
      fi
    done < <(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null || true)
  fi

  # Pastas e arquivos no host (só os que existem).
  if [ "$PROJECTS_DIR_OK" = "1" ] && [ -e "$PROJECTS_DIR" ]; then PATHS+=("$PROJECTS_DIR"); fi
  [ -e /opt/paas-hardening ] && PATHS+=("/opt/paas-hardening")
  # O painel roda num container com o estado em /data, mas quem monta arquivos
  # no Caddy e no Stalwart é o Docker da VPS, que procura esses caminhos NA
  # VPS e cria as pastas vazias se não existirem. Só os caminhos exatos.
  [ -e /data/caddy/Caddyfile ] && PATHS+=("/data/caddy/Caddyfile")
  [ -e /data/mail/stalwart ] && PATHS+=("/data/mail/stalwart")
  [ -e "$ENV_FILE" ] && PATHS+=("$ENV_FILE")
  if [ "$KEEP_REPO" = "0" ]; then PATHS+=("$REPO_DIR"); fi

  # --- Relatório -------------------------------------------------------------------
  printf '\n%s\n' "${RED}${BOLD}██████████████████████████████████████████████████████████████████████████████
██                                                                          ██
██                   ⚠   REMOÇÃO DO TWS PANEL DESTA VPS  ⚠                   ██
██                                                                          ██
██████████████████████████████████████████████████████████████████████████████${RESET}"

  if [ "$HAVE_DOCKER" = "0" ]; then
    printf '\n%s\n' "${YELLOW}Docker ausente ou sem resposta — só as pastas abaixo serão consideradas.${RESET}"
  fi
  if [ "$PROJECTS_DIR_OK" = "0" ]; then
    printf '\n%s\n' "${YELLOW}A pasta dos projetos gravada no .env (\"$PROJECTS_DIR\") parece uma pasta do sistema ou contém o repositório — por segurança ela NÃO será apagada. Remova à mão o que for do painel.${RESET}"
  fi

  local total=$(( ${#CONTAINERS[@]} + ${#NETWORKS[@]} + ${#VOLUMES[@]} + ${#IMAGES[@]} + ${#PATHS[@]} ))
  printf '\n%s\n' "${YELLOW}${BOLD}Será removido (encontrado nesta VPS agora):${RESET}"
  print_group "Containers (parados e apagados)" "${CONTAINERS[@]+"${CONTAINERS[@]}"}"
  print_group "Redes Docker" "${NETWORKS[@]+"${NETWORKS[@]}"}"
  print_group "Volumes Docker (os DADOS ficam aqui)" "${VOLUMES[@]+"${VOLUMES[@]}"}"
  print_group "Imagens Docker" "${IMAGES[@]+"${IMAGES[@]}"}"
  print_group "Pastas e arquivos no host" "${PATHS[@]+"${PATHS[@]}"}"
  if [ "$KEEP_REPO" = "1" ]; then
    printf '   %s\n' "(--keep-repo: a pasta $REPO_DIR fica; só o .env dela sai)"
  fi

  cat <<EOF

${BOLD}NÃO será desfeito:${RESET}
   • o hardening já aplicado — senha do root travada, SSH sem login por senha e
     sem root, firewall UFW, fail2ban, AppArmor, atualizações automáticas,
     pacotes removidos (ex.: snapd), auditd/AIDE/rkhunter, o agendamento
     /etc/cron.d/paas-security-scan, os backups *.paas-backup.* e /etc/paas
   • o seu usuário não-root e a chave SSH dele
   • a entrada de algum usuário no grupo docker, se houver (instaladores antigos
     faziam isso) — ela equivale a root sem senha; confira com  groups  e
     remova com  sudo gpasswd -d SEU_USUARIO docker
   • o Docker e o git
   • imagens públicas já baixadas (alpine, caddy, stalwart, node, nginx)

   Quer a máquina limpa de verdade? Aí é reinstalar o sistema no provedor.
EOF

  if [ "$total" -eq 0 ]; then
    printf '\n%s\n' "${GREEN}Nada do painel foi encontrado nesta VPS. Nada a fazer.${RESET}"
    exit 0
  fi

  if [ -n "$(ls -A /etc/paas 2>/dev/null | grep '^pending-rollback-' || true)" ]; then
    printf '\n%s\n' "${YELLOW}${BOLD}⚠ Há uma reversão automática de hardening agendada (/etc/paas/pending-rollback-*).${RESET}"
    printf '%s\n' "${YELLOW}  Ela continua valendo depois da remoção. Se uma fase ainda espera confirmação, resolva isso antes.${RESET}"
  fi

  if [ "$DRY_RUN" = "1" ]; then
    printf '\n%s\n' "${BOLD}--dry-run: nada foi alterado.${RESET}"
    exit 0
  fi

  # --- Confirmação ----------------------------------------------------------------
  { : </dev/tty; } 2>/dev/null || die "Sem terminal para confirmar. Rode este script numa sessão SSH interativa (nada foi alterado)."
  printf '\n%s' "${RED}${BOLD}Isso apaga os itens acima para sempre. Para confirmar, digite \"remover\" e pressione ENTER: ${RESET}"
  local CONFIRM=""
  IFS= read -r CONFIRM </dev/tty || CONFIRM=""
  if [ "$CONFIRM" != "remover" ]; then
    log "cancelado — nada foi alterado."
    exit 0
  fi

  # --- Remoção (somente a lista confirmada, na ordem segura) -----------------------
  local failures=0 item
  if [ "$HAVE_DOCKER" = "1" ]; then
    # O painel primeiro: parado, ele não recria o Caddy/Stalwart nem helpers.
    for item in "${CONTAINERS[@]+"${CONTAINERS[@]}"}"; do
      [ "$item" = "tws-panel" ] || continue
      step "container $item" docker rm -f "$item" || failures=$((failures + 1))
    done
    for item in "${CONTAINERS[@]+"${CONTAINERS[@]}"}"; do
      [ "$item" = "tws-panel" ] && continue
      step "container $item" docker rm -f "$item" || failures=$((failures + 1))
    done
    for item in "${NETWORKS[@]+"${NETWORKS[@]}"}"; do
      step "rede $item" docker network rm "$item" || failures=$((failures + 1))
    done
    for item in "${VOLUMES[@]+"${VOLUMES[@]}"}"; do
      step "volume $item" docker volume rm "$item" || failures=$((failures + 1))
    done
    for item in "${IMAGES[@]+"${IMAGES[@]}"}"; do
      step "imagem $item" docker image rm "$item" || failures=$((failures + 1))
    done
  fi

  # Sai da pasta do repositório antes de apagá-la.
  cd /
  for item in "${PATHS[@]+"${PATHS[@]}"}"; do
    [ "$item" = "$REPO_DIR" ] && continue   # por último, abaixo
    step "$item" rm -rf -- "$item" || failures=$((failures + 1))
  done
  # /data e /data/mail só saem se ficaram vazias (nunca apaga conteúdo alheio).
  rmdir /data/caddy 2>/dev/null || true
  rmdir /data/mail 2>/dev/null || true
  rmdir /data 2>/dev/null || true
  if [ "$KEEP_REPO" = "0" ]; then
    step "$REPO_DIR (repositório)" rm -rf -- "$REPO_DIR" || failures=$((failures + 1))
  fi

  echo
  if [ "$failures" -gt 0 ]; then
    printf '%s\n' "${YELLOW}${BOLD}Terminou com $failures item(ns) que não saíram (veja as mensagens acima).${RESET}"
  else
    printf '%s\n' "${GREEN}${BOLD}✅ Painel removido.${RESET}"
  fi
  if [ "$KEEP_REPO" = "1" ]; then
    cat <<EOF

${BOLD}Próximo passo:${RESET} a pasta do repositório ficou (--keep-repo), então pule o clone do
Passo 6 e vá direto ao ${BOLD}Passo 7 do README${RESET}:  cd $REPO_DIR && ./scripts/install.sh
EOF
  else
    cat <<EOF

${BOLD}Próximo passo:${RESET} recomece pelo ${BOLD}Passo 6 do README${RESET} (clonar o repositório). Se este
terminal estava dentro da pasta apagada, rode antes:  cd ~
EOF
  fi
  cat <<EOF

Imagens públicas baixadas pelo painel continuam no Docker, como cache. Para
apagá-las também (opcional):  sudo docker image prune -a
(isso apaga TODAS as imagens sem container em uso, inclusive as de outros sistemas)
EOF
  [ "$failures" -eq 0 ]
}

log()  { printf '\033[1;34m[tws-panel]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[tws-panel][erro]\033[0m %s\n' "$*" >&2; exit 1; }

# Pastas que este script nunca apaga, mesmo que alguma configuração aponte
# para elas.
is_protected_dir() {
  local d="${1%/}"
  case "${d:-/}" in
    /|/opt|/home|/root|/etc|/usr|/var|/srv|/mnt|/media|/tmp|/data|/boot|/bin|/sbin|/lib|/lib64|/dev|/proc|/sys|/run|/snap) return 0 ;;
    /home/*) [ "$(dirname "$d")" = "/home" ] && return 0 ;;
  esac
  return 1
}

add_unique() { # add_unique <nome-do-array> <valor>
  local -n arr="$1"
  local v
  for v in "${arr[@]+"${arr[@]}"}"; do [ "$v" = "$2" ] && return 0; done
  arr+=("$2")
}

print_group() { # print_group <título> <itens...>
  local title="$1"; shift
  [ "$#" -gt 0 ] || return 0
  printf '\n   %s\n' "$title:"
  local i
  for i in "$@"; do printf '     • %s\n' "$i"; done
}

step() { # step <descrição> <comando...>
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf '  \033[1;32m✓\033[0m removido: %s\n' "$desc"
  else
    printf '  \033[1;31m✗\033[0m falhou: %s  (comando: %s)\n' "$desc" "$*"
    return 1
  fi
}

main "$@"
exit $?
