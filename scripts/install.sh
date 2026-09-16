#!/usr/bin/env bash
# =============================================================================
# TWS Panel — instalador one-shot (100% Docker)
#
# Uso (VPS Ubuntu 22.04/24.04 limpa — com o usuário não-root criado no README):
#   sudo apt update && sudo apt install -y git
#   sudo git clone https://github.com/kelvindk9w/tws-panel.git /opt/tws-panel
#   sudo chown -R $USER:$USER /opt/tws-panel
#   cd /opt/tws-panel && ./scripts/install.sh
#
# O script PRECISA de privilégios de root: se for executado por um usuário
# comum, ele se reexecuta automaticamente via `sudo` (preservando as
# variáveis PAAS_* / SETUP_TOKEN). Chamar com `sudo ./scripts/install.sh`
# também funciona — os dois caminhos são equivalentes.
#
# Pré-requisito: Ubuntu com git. Não precisa instalar Docker, Node ou mais
# nada manualmente — este script cuida de tudo.
#
# O que faz:
#   1. PRÉ-FLIGHT (somente leitura, antes de instalar qualquer coisa):
#      SO, RAM/disco, Docker/containers, portas 80/443/25/465/587/143/993/8080 e
#      serviços conhecidos (nginx, apache, caddy, postfix, mysql, postgres).
#      A porta do PAINEL não entra nessa lista: ela é escolhida no passo 1d,
#      que confere se está livre e oferece outra quando não está.
#      Se a VPS não estiver limpa, exibe um relatório e exige confirmação
#      interativa (digitar "continuar") ou --force / PAAS_FORCE=1.
#      NUNCA remove ou para nada que já exista na máquina.
#      Se o Ubuntu sinalizar reinicialização pendente (/var/run/reboot-required),
#      PARA antes de tudo e orienta `sudo reboot` (com --force só avisa).
#   1b. TERMINAL DO PAINEL (ainda antes de instalar qualquer coisa): pergunta
#      com qual usuário da VPS o terminal ao vivo abre e, se não for root,
#      como os comandos que precisam de root são executados ("senha" —
#      recomendado — ou "segundo-plano"). Lista como SUGESTÃO os usuários
#      comuns com sudo, mas nunca escolhe pelo operador. Valida o usuário
#      (existe, tem senha, está no sudo) e pergunta de novo se algo falhar.
#      Pergunta também, só para montar os comandos de acesso do final, o
#      nome da chave SSH que o operador usa no computador dele.
#      Automação: --terminal-user=, --root-mode=, --ssh-key= (ou
#      PAAS_TERMINAL_USER, PAAS_ROOT_MODE, PAAS_SSH_KEY). Sem TTY ou com
#      --force e sem essas escolhas, NÃO adivinha: mantém o terminal como
#      root (comportamento anterior) e avisa. Reinstalação: o que já está
#      no .env é respeitado; --reconfigure-terminal pergunta de novo.
#   1c. GRUPO DOCKER: ninguém é adicionado a ele (equivale a root sem senha).
#      Se o usuário do terminal (não-root) já estiver no grupo, pergunta se
#      remove (recomendado); sem TTY ou com --force, não mexe e avisa no final.
#   1d. PORTA DO PAINEL NA VPS (4ª pergunta, padrão 9000): em qual porta da
#      VPS o container publica o painel. Confere se está livre (ss, netstat
#      ou /proc/net/tcp), diz quem a ocupa quando dá para descobrir e oferece
#      uma porta livre como sugestão — nunca troca sozinho. Recusa 22 (SSH),
#      80/443 (proxy Caddy dos projetos) e 25/465/587/143/993/8080 (servidor
#      de e-mail Stalwart), além de valor não numérico ou fora de 1–65535.
#      Automação: --port= (ou PAAS_PORT). Vai para o .env como PAAS_PORT e o
#      docker-compose.yml publica "${PAAS_PORT:-9000}:9000" — a porta INTERNA
#      do container continua 9000. Reinstalação respeita o valor do .env.
#   2. Instala git se ausente
#   3. Instala Docker se ausente (get.docker.com) + plugin compose
#   4. Define o diretório alvo (default /opt/tws-panel; personalize com
#      PAAS_DIR=<dir> ou ./scripts/install.sh <dir>) e clona o repo se ele
#      não existir (ou usa o diretório atual se já for o repo)
#   5. Gera SETUP_TOKEN aleatório (persistido no volume paas_data)
#   5c. Cria o diretório dos projetos no host (default /opt/tws-projects;
#      personalize com PAAS_PROJECTS_DIR=<dir> ou --projects-dir=<dir>) e
#      grava a escolha no .env
#   5d. Grava no .env o usuário do terminal e o modo escolhidos em 1b
#   5e. Grava no .env a porta do painel escolhida em 1d
#   6. docker compose up -d --build (build da imagem + sobe o painel na porta
#      escolhida em 1d — 9000 por padrão)
#   7. Imprime a URL do wizard + o token
#
# Idempotente: pode ser executado mais de uma vez sem quebrar (uma
# reinstalação detecta o próprio painel e não a trata como conflito).
# =============================================================================
set -euo pipefail

REPO_URL="${TWS_REPO_URL:-https://github.com/kelvindk9w/tws-panel.git}"
COMPOSE_FILE="docker-compose.yml"

# Porta padrão do painel na VPS. O container escuta sempre na 9000 por dentro;
# esta é só a porta publicada no host (docker-compose.yml: "${PAAS_PORT:-9000}:9000").
DEFAULT_PORT=9000
PORT="$DEFAULT_PORT"

log()  { printf '\033[1;34m[tws-panel]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[tws-panel][aviso]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[tws-panel][erro]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Uso: $0 [--force] [opções] [diretório-alvo]

  --force          prossegue mesmo se o pré-flight encontrar conflitos
                   (equivalente a PAAS_FORCE=1 — útil em automação).
                   Com --force, o instalador não faz perguntas: sem
                   --terminal-user, o terminal do painel continua abrindo
                   como root (comportamento anterior), com aviso.
  --terminal-user=<usuário>
                   com qual usuário da VPS o terminal do painel abre
                   (ou \$PAAS_TERMINAL_USER). "root" é aceito, mas
                   desaconselhado. Sem esta opção, o instalador pergunta.
  --root-mode=senha|segundo-plano
                   obrigatório quando o usuário não é root (ou
                   \$PAAS_ROOT_MODE). "senha" (recomendado): o painel usa
                   sudo dentro do terminal e você digita a sua senha ali.
                   "segundo-plano": os comandos de root rodam como root
                   por trás, registrados na Auditoria do painel.
  --ssh-key=<arquivo>
                   nome do arquivo da chave SSH no SEU computador (ex.:
                   minha_vps), só para imprimir os comandos de acesso
                   corretos no final. Não é gravado em lugar nenhum
                   (ou \$PAAS_SSH_KEY). id_ed25519/id_rsa dispensam.
  --reconfigure-terminal
                   numa reinstalação, pergunta de novo o usuário e o modo
                   do terminal em vez de reaproveitar o que está no .env.
                   (Informar --terminal-user/--root-mode também substitui.)
  --port=<número>  em qual porta DA VPS o painel fica disponível
                   (default: $DEFAULT_PORT, ou \$PAAS_PORT). O instalador
                   confere se ela está livre e recusa as portas usadas pelo
                   SSH (22), pelo proxy dos projetos (80, 443) e pelo
                   servidor de e-mail (25, 465, 587, 143, 993, 8080).
                   Não confundir com a porta do túnel no SEU computador:
                   essa você escolhe na hora de abrir o túnel.
                   Numa instalação já existente, o valor gravado no .env é
                   respeitado e esta opção só o substitui se for informada.
  --projects-dir=<dir>
                   onde ficam os arquivos dos projetos implantados, NO HOST
                   (default: /opt/tws-projects, ou \$PAAS_PROJECTS_DIR).
                   O container monta esse caminho com o mesmo nome dentro e
                   fora; trocá-lo depois exige `docker compose up -d`.
                   Numa instalação já existente, o valor gravado no .env é
                   respeitado e esta opção só o substitui se for informada.
  diretório-alvo   onde clonar o repo quando o script roda fora dele
                   (default: /opt/tws-panel, ou \$PAAS_DIR)
EOF
}

# --- Argumentos ---------------------------------------------------------------
FORCE=0
TARGET_ARG=""
PROJECTS_DIR_ARG=""
TERMINAL_USER_ARG=""
ROOT_MODE_ARG=""
SSH_KEY_ARG=""
PORT_ARG=""
RECONFIGURE_TERMINAL=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --port=*) PORT_ARG="${arg#*=}" ;;
    --projects-dir=*) PROJECTS_DIR_ARG="${arg#*=}" ;;
    --terminal-user=*) TERMINAL_USER_ARG="${arg#*=}" ;;
    --root-mode=*) ROOT_MODE_ARG="${arg#*=}" ;;
    --ssh-key=*) SSH_KEY_ARG="${arg#*=}" ;;
    --reconfigure-terminal) RECONFIGURE_TERMINAL=1 ;;
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
# Precisamos de root (apt, docker, volumes). Se o operador rodou o script com
# o usuário comum, reexecutamos via sudo preservando as variáveis de ambiente
# relevantes — assim tanto `./scripts/install.sh` quanto
# `sudo ./scripts/install.sh` funcionam (o README recomenda o primeiro).
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "Este script precisa de root. Rode como root ou instale o sudo (apt install sudo)."
  log "Privilégios de administrador necessários — reexecutando via sudo…"
  exec sudo --preserve-env=PAAS_FORCE,PAAS_DIR,PAAS_PORT,PAAS_PROJECTS_DIR,PAAS_TERMINAL_USER,PAAS_ROOT_MODE,PAAS_SSH_KEY,TWS_REPO_URL,SETUP_TOKEN \
    bash "$(readlink -f "$0")" "$@"
fi

# --- Portas: quem já está escutando nesta VPS ----------------------------------
# Usado pelo pré-flight (passo 1) e pela escolha da porta do painel (passo 1d).
#
# Três fontes, nesta ordem, porque nem toda VPS tem as duas primeiras:
#   1. ss        — iproute2, presente em qualquer Ubuntu atual. Com -p ainda
#                  diz QUAL processo escuta (estamos como root neste ponto).
#   2. netstat   — net-tools; não vem instalado por padrão no Ubuntu desde a
#                  18.04, mas existe em imagens antigas e em quem o instalou.
#   3. /proc/net/tcp — o próprio kernel. Não depende de pacote nenhum, então
#                  SEMPRE há resposta; em troca, não identifica o processo.
# Sem nenhuma das três (só aconteceria fora do Linux) a verificação é pulada e
# dito com todas as letras que ela não aconteceu — nunca fingimos que está livre.
PORT_PROBE=""
if command -v ss >/dev/null 2>&1; then
  PORT_PROBE="ss"
elif command -v netstat >/dev/null 2>&1; then
  PORT_PROBE="netstat"
elif [ -r /proc/net/tcp ]; then
  PORT_PROBE="proc"
fi

listening_ports() { # imprime uma porta TCP em escuta por linha (pode repetir)
  case "$PORT_PROBE" in
    ss)      ss -ltn 2>/dev/null | awk 'NR>1 {print $4}' | sed 's/.*://' ;;
    netstat) netstat -ltn 2>/dev/null | awk '$1 ~ /^tcp/ {print $4}' | sed 's/.*://' ;;
    proc)
      # 4ª coluna = estado; 0A = LISTEN. A porta é a parte hexadecimal depois
      # do ":" na 2ª coluna (endereço local). printf faz a conversão: nem todo
      # Ubuntu tem gawk (o mawk padrão não conhece strtonum).
      awk 'NR > 1 && $4 == "0A" { split($2, a, ":"); print a[2] }' \
        /proc/net/tcp /proc/net/tcp6 2>/dev/null \
        | while read -r hex; do printf '%d\n' "0x$hex" 2>/dev/null || true; done ;;
    *) return 1 ;;
  esac
}

port_in_use() { # port_in_use <porta> — 0 = ocupada, 1 = livre, 2 = não deu para saber
  [ -n "$PORT_PROBE" ] || return 2
  listening_ports | grep -qx -- "$1"
}

# Quem está escutando, em linguagem de gente ("nginx", "o container docker
# 'loja'"). Vazio quando não dá para descobrir — aí a mensagem só diz que está
# ocupada, sem inventar culpado.
port_owner() { # port_owner <porta>
  local p="$1" name="" container=""
  case "$PORT_PROBE" in
    ss)
      name="$(ss -ltnp 2>/dev/null | awk -v re=":$p\$" '$4 ~ re {print $NF; exit}' \
        | sed -n 's/.*(("\([^"]*\)".*/\1/p')" ;;
    netstat)
      name="$(netstat -ltnp 2>/dev/null | awk -v re=":$p\$" '$4 ~ re {print $NF; exit}' \
        | sed 's#^[0-9]*/##')" ;;
  esac
  # docker-proxy/containerd não dizem nada a quem nunca mexeu numa VPS: se um
  # container publica a porta, o nome dele é a informação útil.
  if [ -z "$name" ] || [ "$name" = "docker-proxy" ] || [ "$name" = "containerd" ]; then
    container="$(docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null \
      | grep -F ":$p->" | head -n1 | cut -f1 || true)"
    [ -n "$container" ] && { printf 'pelo container Docker "%s"' "$container"; return 0; }
  fi
  [ -n "$name" ] && printf 'pelo programa "%s"' "$name"
}

# Porta publicada pelo PRÓPRIO painel (reinstalação não é conflito).
port_is_own_panel() { # port_is_own_panel <porta>
  docker ps --filter 'name=^/tws-panel$' --format '{{.Ports}}' 2>/dev/null | grep -q ":$1->"
}

# Portas que o painel NÃO pode usar, com o motivo em português. Fontes:
#   22            — o SSH desta VPS; perdê-lo é perder a máquina.
#   80, 443       — apps/server/src/config.ts (caddyHttpPort/caddyHttpsPort) e
#                   packages/deploy/src/caddy.ts, que publica "<http>:80" e
#                   "<https>:443" do proxy que atende os SEUS projetos.
#   25/465/587/143/993/8080 — packages/core/src/mail.ts (MAIL_DEFAULT_PORTS),
#                   publicadas pelo container Stalwart do módulo de e-mail.
port_reserved_reason() { # port_reserved_reason <porta> — vazio = pode usar
  case "$1" in
    22)   printf 'é por onde o SSH entra nesta VPS — usá-la aqui te deixaria sem acesso à máquina' ;;
    80)   printf 'é a porta que o proxy dos seus projetos (Caddy) usa para o HTTP e para emitir os certificados SSL' ;;
    443)  printf 'é a porta que o proxy dos seus projetos (Caddy) usa para o HTTPS — os sites que você publicar atendem nela' ;;
    25)   printf 'é a porta de entrega de e-mail (SMTP) do servidor de e-mail do painel' ;;
    465)  printf 'é a porta de envio com TLS (SMTPS) do servidor de e-mail do painel' ;;
    587)  printf 'é a porta de envio (submissão) do servidor de e-mail do painel — a que o Outlook/Thunderbird usam' ;;
    143)  printf 'é a porta de leitura de e-mail (IMAP) do servidor de e-mail do painel' ;;
    993)  printf 'é a porta de leitura de e-mail com TLS (IMAPS) do servidor de e-mail do painel' ;;
    8080) printf 'é a porta de administração do servidor de e-mail do painel (Stalwart)' ;;
  esac
}

# Porta numérica e dentro do intervalo válido. Rejeita "9000 " com sobra,
# "0080" (o [ -ge ] do shell leria como octal) e qualquer coisa não numérica.
valid_port() { # valid_port <valor>
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    0*) return 1 ;;
  esac
  [ "${#1}" -le 5 ] || return 1
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

# Primeira porta livre a partir de <inicio>, pulando as reservadas. Vazio se
# não achar nada na faixa varrida (aí a mensagem não sugere número nenhum).
suggest_free_port() { # suggest_free_port <inicio>
  local p="$1" limit=$(( $1 + 200 ))
  [ "$limit" -gt 65535 ] && limit=65535
  while [ "$p" -le "$limit" ]; do
    if [ -z "$(port_reserved_reason "$p")" ] && ! port_in_use "$p"; then
      printf '%s' "$p"; return 0
    fi
    p=$((p + 1))
  done
}

# --- 1. Pré-flight check (SOMENTE LEITURA) -------------------------------------
# Roda ANTES de instalar qualquer coisa. Nada aqui altera o sistema: apenas
# detecta e reporta. Se a VPS não estiver limpa, exigimos confirmação
# explícita — este instalador nunca remove/para nada que já exista.
ISSUES=0
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
info() { printf '  \033[1;34mℹ\033[0m %s\n' "$*"; }
flag() { printf '  \033[1;33m⚠\033[0m %s\n' "$*"; ISSUES=$((ISSUES + 1)); }

log "Pré-flight: inspecionando a máquina (nada será alterado nesta etapa)…"

# Reinicialização pendente. No Ubuntu, quem instala uma atualização que só vale
# depois de reiniciar (kernel, libc, systemd…) cria /var/run/reboot-required e
# anota o pacote em /var/run/reboot-required.pkgs — é esse arquivo que faz o
# login mostrar "*** System restart required ***". VPS recém-entregue pelo
# provedor costuma vir assim. Checado PRIMEIRO e com parada imediata (antes do
# relatório de conflitos), para a pessoa não digitar "continuar" à toa: instalar
# Docker e subir containers em cima de um kernel que vai ser trocado no próximo
# boot é pedir comportamento estranho. Com --force/PAAS_FORCE=1 (automação que
# não tem como reiniciar no meio) só avisa e segue.
if [ -e /var/run/reboot-required ]; then
  REBOOT_PKGS=""
  if [ -r /var/run/reboot-required.pkgs ]; then
    REBOOT_PKGS="$(sort -u /var/run/reboot-required.pkgs | grep -v '^$' | paste -sd' ' - || true)"
  fi
  # Comando exato para rodar de novo: se o script está dentro do repo, aponta
  # para ele; senão (ex.: baixado avulso), repete o caminho usado agora.
  SELF="$(readlink -f "$0" 2>/dev/null || echo "$0")"
  SELF_REPO="$(cd "$(dirname "$SELF")/.." 2>/dev/null && pwd || true)"
  if [ -n "$SELF_REPO" ] && [ -f "$SELF_REPO/$COMPOSE_FILE" ]; then
    RERUN_CMD="cd $SELF_REPO && ./scripts/install.sh"
  else
    RERUN_CMD="bash $SELF"
  fi
  if [ "$FORCE" = "1" ]; then
    flag "Reinicialização pendente${REBOOT_PKGS:+ (pedida por: $REBOOT_PKGS)} — --force ativo, seguindo sem reiniciar."
  else
    cat >&2 <<EOF

================================================================================
  🔄  A VPS precisa ser REINICIADA antes da instalação.

  O sistema recebeu atualizações que só passam a valer depois de reiniciar
  (é o aviso "System restart required" que aparece ao entrar na VPS).
  Isso é normal em máquina nova. NADA foi instalado ainda.
${REBOOT_PKGS:+
  Pacotes que pediram o reinício: $REBOOT_PKGS
}
  Faça assim:
    1. Rode:  sudo reboot
    2. A conexão cai. Espere cerca de 1 minuto.
    3. Entre de novo na VPS (o mesmo comando ssh de antes).
    4. Rode o instalador outra vez:
         $RERUN_CMD
================================================================================

EOF
    exit 1
  fi
fi

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

# Portas que o painel reserva para os SEUS projetos: 80/443 (proxy Caddy) e
# 25/465/587/143/993/8080 (servidor de e-mail). A porta do painel em si NÃO
# entra aqui: ela é perguntada no passo 1d, que confere se está livre e oferece
# outra quando não está — não faz sentido abortar a instalação por algo que a
# pergunta seguinte resolve.
RESERVED_PORTS="80 443 25 465 587 143 993 8080"
if [ -n "$PORT_PROBE" ]; then
  PORTS_IN_USE=""
  for p in $RESERVED_PORTS; do
    port_in_use "$p" && PORTS_IN_USE="$PORTS_IN_USE $p"
  done
  if [ -n "$PORTS_IN_USE" ]; then
    flag "Portas em uso:$PORTS_IN_USE"
  else
    ok "Portas do proxy e do e-mail (80/443/25/465/587/143/993/8080) livres"
  fi
else
  info "Sem 'ss', 'netstat' ou /proc/net/tcp — verificação de portas ignorada."
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

# --- 1b. Terminal do painel: com qual usuário ele abre ---------------------------
# O terminal ao vivo do painel é onde a varredura de segurança e as fases de
# hardening rodam. O operador decide AQUI com qual usuário ele abre e, se não
# for root, como os comandos que precisam de root são executados. O instalador
# nunca escolhe sozinho: numa VPS pode haver vários usuários, e a pessoa pode
# querer um só para o painel. Nada é gravado nesta etapa — a escolha só vai
# para o .env no passo 5d, depois que o repositório existe.
#
# Precedência (igual à do PAAS_PROJECTS_DIR): --terminal-user/--root-mode >
# PAAS_TERMINAL_USER/PAAS_ROOT_MODE do ambiente > valor já gravado no .env >
# pergunta. --reconfigure-terminal ignora o .env e pergunta de novo.

# Onde o .env vai ficar (o mesmo cálculo do passo 4, feito aqui sem depender
# do git nem do Docker, que talvez ainda nem estejam instalados).
EARLY_SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")" && pwd)"
if [ -f "$EARLY_SCRIPT_DIR/../$COMPOSE_FILE" ] && [ -f "$EARLY_SCRIPT_DIR/../Dockerfile" ]; then
  EARLY_ENV_FILE="$(cd "$EARLY_SCRIPT_DIR/.." && pwd)/.env"
else
  EARLY_ENV_FILE="$TARGET_DIR/.env"
fi
env_value() { # env_value <CHAVE> — último valor gravado no .env (vazio se não houver)
  [ -f "$EARLY_ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$EARLY_ENV_FILE" | tail -n1
}

# Existe alguém do outro lado para responder? Sem /dev/tty (ssh sem -t, CI,
# cloud-init…) qualquer `read` travaria ou leria lixo: tratamos como automação.
INTERACTIVE=0
if { : </dev/tty; } 2>/dev/null; then
  INTERACTIVE=1
fi
ask() { # ask <pergunta> — lê uma linha do terminal para $ANSWER
  ANSWER=""
  printf '%s' "$1" >&2
  IFS= read -r ANSWER </dev/tty || die "A entrada do terminal foi encerrada no meio das perguntas. Nada foi instalado ou alterado."
  # tira espaços nas pontas (copiar e colar costuma trazer)
  ANSWER="${ANSWER#"${ANSWER%%[![:space:]]*}"}"
  ANSWER="${ANSWER%"${ANSWER##*[![:space:]]}"}"
}
say() { printf '%s\n' "$*" >&2; }

valid_username() { # regra do adduser do Debian/Ubuntu
  printf '%s' "$1" | grep -qE '^[a-z_][a-z0-9_-]{0,31}$'
}
user_has_sudo() { # no grupo sudo (ou admin, nome antigo no Ubuntu)
  id -nG "$1" 2>/dev/null | tr ' ' '\n' | grep -qxE 'sudo|admin'
}
# Estado da senha pelo `passwd -S` (formato: "<usuário> <P|L|NP> ..."):
# P = senha utilizável, L = travada, NP = sem senha. Evita ler /etc/shadow.
password_state() {
  passwd -S "$1" 2>/dev/null | awk 'NR==1 {print $2}'
}

# Sugestões: usuários comuns (UID 1000–59999) que estão no grupo sudo. É só
# uma lista para ajudar a lembrar o nome — a pessoa sempre digita.
sudo_user_suggestions() {
  getent passwd 2>/dev/null | awk -F: '$3 >= 1000 && $3 < 60000 {print $1}' | while read -r u; do
    user_has_sudo "$u" && printf '%s\n' "$u"
  done
}

# check_user_basic <usuário> — o que vale para QUALQUER modo. Imprime o motivo
# e devolve 1 se o usuário não serve.
check_user_basic() {
  local u="$1" entry uid shell
  if ! valid_username "$u"; then
    say "  ✗ \"$u\" não é um nome de usuário válido. Use só letras minúsculas, números, _ e -,"
    say "    começando por letra ou _, com até 32 caracteres (ex.: kelvin, painel_ops)."
    return 1
  fi
  [ "$u" = "root" ] && return 0
  if ! entry="$(getent passwd "$u" 2>/dev/null)" || [ -z "$entry" ]; then
    say "  ✗ O usuário \"$u\" não existe nesta VPS."
    say "    Confira o nome (é o mesmo que você usa no ssh) ou crie o usuário antes, como no"
    say "    Passo 3 do README:  sudo adduser $u && sudo usermod -aG sudo $u"
    return 1
  fi
  uid="$(printf '%s' "$entry" | cut -d: -f3)"
  shell="$(printf '%s' "$entry" | cut -d: -f7)"
  if [ "${uid:-0}" -lt 1000 ]; then
    say "  ✗ \"$u\" é uma conta de sistema (UID $uid), não uma pessoa. Escolha o seu usuário comum."
    return 1
  fi
  case "$shell" in
    */nologin|*/false|"")
      say "  ✗ \"$u\" não pode abrir um terminal (o shell dele é \"${shell:-nenhum}\")."
      say "    Escolha outro usuário, ou dê um shell a ele:  sudo usermod -s /bin/bash $u"
      return 1 ;;
  esac
  return 0
}

# check_user_for_mode <usuário> <modo> — 1 = não serve; 0 = serve (talvez com aviso).
USER_WARNINGS=0
check_user_for_mode() {
  local u="$1" mode="$2" pw
  USER_WARNINGS=0
  pw="$(password_state "$u")"
  if [ "$mode" = "senha" ]; then
    case "$pw" in
      P) ;;
      L) say "  ✗ A senha de \"$u\" está travada, então o sudo dele não funciona."
         say "    Destrave definindo uma senha nova:  sudo passwd $u"
         return 1 ;;
      NP) say "  ✗ \"$u\" não tem senha, e no modo \"senha\" é ela que você digita para o sudo."
          say "    Defina uma:  sudo passwd $u"
          return 1 ;;
      *) say "  ✗ Não consegui conferir a senha de \"$u\" (passwd -S não respondeu)."
         say "    Confira com:  sudo passwd -S $u   (a segunda coluna deve ser P)"
         return 1 ;;
    esac
    if ! user_has_sudo "$u"; then
      say "  ✗ \"$u\" não tem permissão de administrador (não está no grupo sudo)."
      say "    No modo \"senha\" o painel usa o sudo dele. Dê a permissão e rode o instalador"
      say "    de novo:  sudo usermod -aG sudo $u"
      return 1
    fi
    return 0
  fi
  # segundo-plano: nem senha nem sudo são necessários para o PAINEL, mas a
  # pessoa precisa saber o que isso significa para o uso dela por SSH.
  if ! user_has_sudo "$u"; then
    USER_WARNINGS=1
    say "  ⚠ \"$u\" não está no grupo sudo. Para o painel tudo bem: no modo \"segundo-plano\""
    say "    ele não precisa. Mas, entrando na VPS por SSH com esse usuário, você NÃO"
    say "    conseguirá fazer nada como administrador (instalar pacote, ver log do sistema,"
    say "    usar o docker). E, depois que o hardening travar a senha do root, a única saída"
    say "    para isso seria o próprio painel ou o console do provedor."
  elif [ "$pw" != "P" ]; then
    USER_WARNINGS=1
    say "  ⚠ \"$u\" está no grupo sudo, mas não tem senha utilizável — o sudo dele não vai"
    say "    funcionar por SSH. Se for usá-lo assim, defina uma:  sudo passwd $u"
  fi
  return 0
}

explain_terminal() {
  say ""
  say "================================================================================"
  say "  🖥️  TERMINAL DO PAINEL — com qual usuário ele abre?"
  say ""
  say "  O painel tem um terminal ao vivo da VPS. É nele que a varredura de segurança"
  say "  e o hardening rodam, e você pode usá-lo como usaria o SSH. Escolha agora com"
  say "  qual usuário ele abre (dá para trocar depois, veja o README)."
  say ""
  say "  • Recomendado: o SEU usuário comum (o que você criou no Passo 3 do README)."
  say "  • \"root\" é possível, mas desaconselhado: uma aba do navegador esquecida aberta"
  say "    com o painel daria acesso de root à VPS para quem sentasse na frente dela."
  say "================================================================================"
}

explain_modes() {
  local u="$1"
  say ""
  say "--------------------------------------------------------------------------------"
  say "  🔑  E quando um comando precisar de root?"
  say ""
  say "  1) senha  (RECOMENDADO)"
  say "     O terminal abre como $u. Quando algo precisar de root, o painel roda o"
  say "     comando com sudo ali mesmo e VOCÊ digita a sua senha no terminal, como faria"
  say "     por SSH. Nada roda como root sem você ver e autorizar."
  say "     Trade-off: a senha viaja do seu navegador, pelo painel, até o terminal da VPS."
  say "     Ela não é gravada, registrada nem enviada a lugar nenhum (o código é aberto e"
  say "     pode ser conferido) — mas por isso abra o painel SEMPRE pelo túnel SSH: pelo"
  say "     IP direto, ela trafegaria pela internet sem criptografia."
  say ""
  say "  2) segundo-plano"
  say "     O terminal abre como $u. Os comandos que precisam de root rodam como root"
  say "     por trás (pela mesma ponte que o painel já usa), e a saída aparece no"
  say "     terminal só para você acompanhar. Não pede senha."
  say "     Trade-off: você não autoriza comando a comando — a conferência é depois, na"
  say "     tela de Auditoria do painel, onde tudo fica registrado."
  say ""
  say "  Nos dois modos, o monitoramento automático agendado (que roda sozinho, sem"
  say "  ninguém para digitar senha) continua executando como root em segundo plano,"
  say "  e cada execução fica registrada na Auditoria."
  say "--------------------------------------------------------------------------------"
}

# Valores candidatos, na ordem de precedência.
TERMINAL_USER=""
ROOT_MODE=""
TERMINAL_SOURCE=""      # arg | env | dotenv | pergunta | legado
ENV_TERMINAL_USER="$(env_value PAAS_TERMINAL_USER)"
ENV_ROOT_MODE="$(env_value PAAS_ROOT_MODE)"
if [ -n "$TERMINAL_USER_ARG$ROOT_MODE_ARG" ]; then
  TERMINAL_USER="$TERMINAL_USER_ARG"; ROOT_MODE="$ROOT_MODE_ARG"; TERMINAL_SOURCE="arg"
  # completa com o ambiente o que não veio por parâmetro
  [ -z "$TERMINAL_USER" ] && TERMINAL_USER="${PAAS_TERMINAL_USER:-}"
  [ -z "$ROOT_MODE" ] && [ "$TERMINAL_USER" = "${PAAS_TERMINAL_USER:-}" ] && ROOT_MODE="${PAAS_ROOT_MODE:-}"
  [ -z "$ROOT_MODE" ] && [ "$TERMINAL_USER" = "$ENV_TERMINAL_USER" ] && ROOT_MODE="$ENV_ROOT_MODE"
elif [ -n "${PAAS_TERMINAL_USER:-}${PAAS_ROOT_MODE:-}" ]; then
  TERMINAL_USER="${PAAS_TERMINAL_USER:-}"; ROOT_MODE="${PAAS_ROOT_MODE:-}"; TERMINAL_SOURCE="env"
elif [ "$RECONFIGURE_TERMINAL" = "0" ] && [ -n "$ENV_TERMINAL_USER" ]; then
  TERMINAL_USER="$ENV_TERMINAL_USER"; ROOT_MODE="$ENV_ROOT_MODE"; TERMINAL_SOURCE="dotenv"
fi

# Sem nenhuma escolha e sem ninguém para perguntar: NÃO adivinhar.
if [ -z "$TERMINAL_SOURCE" ] && { [ "$FORCE" = "1" ] || [ "$INTERACTIVE" = "0" ]; }; then
  TERMINAL_SOURCE="legado"
  if [ "$FORCE" = "1" ]; then motivo="--force ativo"; else motivo="sem terminal para perguntar"; fi
  warn "Terminal do painel: nenhuma escolha informada ($motivo). Mantendo o comportamento"
  warn "anterior — o terminal abre como ROOT — e nada é gravado no .env."
  warn "Para escolher em automação: --terminal-user=<usuário> --root-mode=senha|segundo-plano"
  warn "(ou PAAS_TERMINAL_USER / PAAS_ROOT_MODE). Recomendado: um usuário comum com o modo senha."
fi

# Validação de escolhas vindas de parâmetro, ambiente ou .env.
if [ -n "$TERMINAL_SOURCE" ] && [ "$TERMINAL_SOURCE" != "legado" ]; then
  case "$TERMINAL_SOURCE" in
    arg) origem="parâmetros --terminal-user/--root-mode" ;;
    env) origem="variáveis PAAS_TERMINAL_USER/PAAS_ROOT_MODE" ;;
    *)   origem="$EARLY_ENV_FILE (instalação anterior)" ;;
  esac
  problema=""
  if [ -z "$TERMINAL_USER" ]; then
    problema="o modo foi informado, mas o usuário não. Informe também --terminal-user=<usuário>."
  elif ! check_user_basic "$TERMINAL_USER"; then
    problema="o usuário \"$TERMINAL_USER\" não pode ser usado (motivo acima)."
  elif [ "$TERMINAL_USER" = "root" ]; then
    if [ -n "$ROOT_MODE" ]; then
      warn "Terminal como root: o modo \"$ROOT_MODE\" não se aplica e será ignorado."
      ROOT_MODE=""
    fi
  else
    case "$ROOT_MODE" in
      senha|segundo-plano)
        check_user_for_mode "$TERMINAL_USER" "$ROOT_MODE" || \
          problema="o usuário \"$TERMINAL_USER\" não serve para o modo \"$ROOT_MODE\" (motivo acima)." ;;
      "") problema="usuário \"$TERMINAL_USER\" sem modo. Informe --root-mode=senha (recomendado) ou --root-mode=segundo-plano." ;;
      *) problema="modo \"$ROOT_MODE\" desconhecido. Use senha (recomendado) ou segundo-plano." ;;
    esac
  fi
  if [ -n "$problema" ]; then
    if [ "$INTERACTIVE" = "1" ] && [ "$FORCE" = "0" ]; then
      warn "Terminal do painel ($origem): $problema"
      warn "Vamos escolher de novo."
      TERMINAL_SOURCE=""; TERMINAL_USER=""; ROOT_MODE=""
    else
      [ "$TERMINAL_SOURCE" = "dotenv" ] && \
        warn "Para escolher de novo numa sessão interativa: ./scripts/install.sh --reconfigure-terminal"
      die "Terminal do painel ($origem): $problema Nada foi instalado ou alterado."
    fi
  elif [ "$TERMINAL_SOURCE" = "dotenv" ]; then
    info "Terminal do painel: mantendo a escolha já gravada (usuário ${TERMINAL_USER}${ROOT_MODE:+, modo $ROOT_MODE}). Para trocar: --reconfigure-terminal"
  else
    info "Terminal do painel: usuário ${TERMINAL_USER}${ROOT_MODE:+, modo $ROOT_MODE} (via $origem)."
  fi
fi

# Diálogo interativo.
if [ -z "$TERMINAL_SOURCE" ]; then
  TERMINAL_SOURCE="pergunta"
  explain_terminal
  if [ -z "$ENV_TERMINAL_USER" ] && [ -f "$EARLY_ENV_FILE" ] && grep -q '^DOCKER_GID=' "$EARLY_ENV_FILE" 2>/dev/null; then
    say ""
    say "  (Esta VPS já tem o painel instalado. Hoje o terminal dele abre como root —"
    say "   para manter exatamente assim, digite root.)"
  fi
  while :; do
    SUGGESTIONS="$(sudo_user_suggestions | paste -sd' ' - || true)"
    say ""
    if [ -n "$SUGGESTIONS" ]; then
      say "  Usuários comuns desta VPS com permissão de administrador (sudo): $SUGGESTIONS"
      say "  (É só uma lista para ajudar — digite o nome que você quer usar.)"
    else
      say "  Não encontrei nenhum usuário comum com sudo nesta VPS. Se ainda não criou o seu,"
      say "  aperte Ctrl+C, siga o Passo 3 do README e rode o instalador de novo."
    fi
    ask "  Com qual usuário o terminal do painel deve abrir? "
    if [ -z "$ANSWER" ]; then
      say "  ✗ Digite um nome de usuário (o instalador não escolhe por você)."
      continue
    fi
    check_user_basic "$ANSWER" || continue
    TERMINAL_USER="$ANSWER"

    if [ "$TERMINAL_USER" = "root" ]; then
      say ""
      say "  ⚠ Com root, qualquer pessoa que chegar a uma aba aberta do painel tem a VPS"
      say "    inteira, sem nenhuma senha a mais. O recomendado é um usuário comum."
      ask "  Para confirmar root mesmo assim, digite \"usar root\" (ou Enter para escolher outro): "
      if [ "$ANSWER" = "usar root" ]; then
        ROOT_MODE=""
        break
      fi
      continue
    fi

    explain_modes "$TERMINAL_USER"
    ROOT_MODE=""
    while [ -z "$ROOT_MODE" ]; do
      ask "  Escolha 1 (senha, recomendado) ou 2 (segundo-plano): "
      case "$ANSWER" in
        1|senha) ROOT_MODE="senha" ;;
        2|segundo-plano|"segundo plano") ROOT_MODE="segundo-plano" ;;
        *) say "  ✗ Responda 1 ou 2." ;;
      esac
    done

    if ! check_user_for_mode "$TERMINAL_USER" "$ROOT_MODE"; then
      say "  Vamos escolher de novo (outro usuário, ou o outro modo)."
      continue
    fi
    if [ "$USER_WARNINGS" = "1" ]; then
      ask "  Continuar com \"$TERMINAL_USER\" mesmo assim? [s/N] "
      case "$ANSWER" in s|S|sim|SIM) ;; *) continue ;; esac
    fi
    break
  done
fi

# --- 1c. Usuário do terminal no grupo docker ---------------------------------------
# Estar no grupo docker é ter root na VPS SEM senha: qualquer membro roda
# `docker run --privileged -v /:/host ... chroot /host`. Os modos "senha" e
# "segundo-plano" existem para que uma aba esquecida do painel NÃO dê root;
# com o usuário do terminal nesse grupo, essa garantia é falsa. Por isso o
# instalador não coloca ninguém no grupo docker (versões antigas colocavam
# quem chamou o sudo) e, se o usuário do terminal já estiver lá, pergunta se
# remove. Sem ninguém para responder, não mexe em grupo: só avisa no final.
# A remoção em si fica para depois da etapa do Docker, junto das outras
# alterações — até aqui nada foi alterado na máquina.
user_in_docker_group() { # user_in_docker_group <usuário>
  id -nG "$1" 2>/dev/null | tr ' ' '\n' | grep -qx docker
}
DOCKER_GROUP_STATE=""   # "" (nada a dizer) | remover | removido | recusou | automacao | falhou
if [ "$TERMINAL_SOURCE" != "legado" ] && [ "$TERMINAL_USER" != "root" ] && user_in_docker_group "$TERMINAL_USER"; then
  if [ "$INTERACTIVE" = "1" ] && [ "$FORCE" = "0" ]; then
    if [ "$ROOT_MODE" = "senha" ]; then
      protecao="do pedido da sua senha do sudo"
    else
      protecao="da Auditoria (rodar root sem passar pelo painel)"
    fi
    say ""
    say "================================================================================"
    say "  ⚠️  \"$TERMINAL_USER\" ESTÁ NO GRUPO DOCKER — isso anula a proteção que você escolheu"
    say ""
    say "  Quem está no grupo docker consegue virar root na VPS sem digitar senha nenhuma:"
    say "  basta um único comando docker. Então, do terminal do painel aberto como"
    say "  \"$TERMINAL_USER\", daria para passar por cima $protecao."
    say "  Uma aba do navegador esquecida aberta voltaria a ser acesso de root à VPS."
    say ""
    say "  (Isso costuma vir de uma versão antiga deste instalador, que colocava no grupo"
    say "  quem o executava. Desinstalar o painel não desfaz.)"
    say ""
    say "  RECOMENDADO: remover. Você não perde nada: os comandos docker continuam"
    say "  funcionando com sudo na frente (ex.: sudo docker compose ps)."
    say "  A mudança só vale em sessões novas: sessões SSH de \"$TERMINAL_USER\" já abertas"
    say "  mantêm o acesso antigo até você sair (exit) e entrar de novo."
    say "================================================================================"
    while :; do
      ask "  Remover \"$TERMINAL_USER\" do grupo docker? [s/n] "
      case "$ANSWER" in
        s|S|sim|Sim|SIM)
          DOCKER_GROUP_STATE="remover"
          log "Combinado: \"$TERMINAL_USER\" sai do grupo docker durante a instalação."
          break ;;
        n|N|nao|não|Nao|Não|NAO|NÃO)
          DOCKER_GROUP_STATE="recusou"
          warn "\"$TERMINAL_USER\" continua no grupo docker — o aviso vai se repetir no final."
          break ;;
        *) say "  ✗ Responda s (remover, recomendado) ou n (manter)." ;;
      esac
    done
  else
    DOCKER_GROUP_STATE="automacao"
    warn "\"$TERMINAL_USER\" (usuário do terminal do painel) está no grupo docker: isso é root sem"
    warn "senha e anula a proteção do modo \"$ROOT_MODE\". Em automação (sem terminal interativo ou"
    warn "com --force) o instalador não altera grupos. Para corrigir: sudo gpasswd -d $TERMINAL_USER docker"
  fi
fi

# --- 1d. Porta do painel NA VPS ---------------------------------------------------
# São DUAS portas diferentes, e confundi-las é o erro clássico:
#   • esta aqui é a porta DA VPS, onde o container publica o painel. O
#     instalador roda na VPS, então PODE conferir se ela está livre;
#   • a porta do túnel no COMPUTADOR do operador (o número da esquerda em
#     `ssh -L <local>:localhost:<vps>`) é outra história: o instalador não
#     enxerga aquela máquina. Se lá der "Address already in use", basta trocar
#     o número da esquerda — está explicado no banner final.
# A porta INTERNA do container é sempre 9000 e não muda: o docker-compose.yml
# publica "${PAAS_PORT:-9000}:9000".
#
# Precedência (igual à das outras escolhas): --port > PAAS_PORT do ambiente >
# valor já gravado no .env > pergunta (padrão 9000).
PORT_SOURCE=""          # arg | env | dotenv | pergunta | padrao
ENV_PORT="$(env_value PAAS_PORT)"
if [ -n "$PORT_ARG" ]; then
  PORT="$PORT_ARG"; PORT_SOURCE="arg"
elif [ -n "${PAAS_PORT:-}" ]; then
  PORT="${PAAS_PORT}"; PORT_SOURCE="env"
elif [ -n "$ENV_PORT" ]; then
  PORT="$ENV_PORT"; PORT_SOURCE="dotenv"
fi

# check_port <porta> — diz por que a porta não serve e devolve 1. Devolve 0
# quando ela pode ser usada (podendo ter avisado algo pelo caminho).
check_port() {
  local p="$1" motivo dono
  if ! valid_port "$p"; then
    say "  ✗ \"$p\" não é uma porta válida. Informe um número inteiro de 1 a 65535 (o padrão é $DEFAULT_PORT)."
    return 1
  fi
  motivo="$(port_reserved_reason "$p")"
  if [ -n "$motivo" ]; then
    say "  ✗ A porta $p não pode ser usada pelo painel: $motivo."
    say "    Escolha outra: qualquer número alto e livre serve (ex.: $DEFAULT_PORT, 9001, 9090)."
    return 1
  fi
  if [ "$p" -lt 1024 ]; then
    say "  ⚠ A porta $p é uma porta de sistema (abaixo de 1024). Funciona, mas costuma ser disputada"
    say "    por outros serviços. Se não tiver um motivo para ela, prefira um número alto (ex.: $DEFAULT_PORT)."
  fi
  if port_is_own_panel "$p"; then
    return 0   # reinstalação: quem ocupa é o próprio painel, não é conflito
  fi
  local estado=0
  port_in_use "$p" || estado=$?
  case "$estado" in
    0)
      dono="$(port_owner "$p")"
      if [ -n "$dono" ]; then
        say "  ✗ A porta $p já está ocupada nesta VPS $dono."
      else
        say "  ✗ A porta $p já está ocupada nesta VPS (não consegui descobrir por qual programa)."
      fi
      say "    Duas saídas: escolher outra porta aqui, ou desligar esse programa antes (o instalador"
      say "    nunca para nada que já existe na máquina)."
      return 1 ;;
    2)
      say "  ⚠ Não consegui conferir se a porta $p está livre (sem 'ss', 'netstat' ou /proc/net/tcp)."
      say "    Se ela estiver ocupada, o painel vai falhar ao subir no fim da instalação." ;;
  esac
  return 0
}

# Valor vindo de parâmetro/ambiente/.env: valida antes de aceitar.
if [ -n "$PORT_SOURCE" ]; then
  case "$PORT_SOURCE" in
    arg)    origem_porta="parâmetro --port" ;;
    env)    origem_porta="variável PAAS_PORT" ;;
    *)      origem_porta="$EARLY_ENV_FILE (instalação anterior)" ;;
  esac
  if check_port "$PORT"; then
    if [ "$PORT_SOURCE" = "dotenv" ]; then
      info "Porta do painel na VPS: mantendo a $PORT já gravada. Para trocar: --port=<número>"
    else
      info "Porta do painel na VPS: $PORT (via $origem_porta)."
    fi
  else
    if [ "$INTERACTIVE" = "1" ] && [ "$FORCE" = "0" ]; then
      warn "Porta do painel ($origem_porta): $PORT não serve (motivo acima). Vamos escolher de novo."
      PORT_SOURCE=""
    else
      die "Porta do painel ($origem_porta): $PORT não serve (motivo acima). Informe outra com --port=<número>. Nada foi instalado ou alterado."
    fi
  fi
fi

# Sem escolha e sem ninguém para perguntar: fica no padrão, avisando se ele
# não estiver livre (em automação, quem decide o que fazer é quem chamou).
if [ -z "$PORT_SOURCE" ] && { [ "$FORCE" = "1" ] || [ "$INTERACTIVE" = "0" ]; }; then
  PORT="$DEFAULT_PORT"; PORT_SOURCE="padrao"
  if port_in_use "$PORT" && ! port_is_own_panel "$PORT"; then
    PORT_ALT="$(suggest_free_port "$((DEFAULT_PORT + 1))")"
    warn "Porta do painel: a $DEFAULT_PORT (padrão) já está ocupada nesta VPS${PORT_ALT:+ — a $PORT_ALT está livre}."
    warn "Em automação o instalador não troca sozinho: o painel provavelmente vai falhar ao subir."
    warn "Rode de novo com --port=<número> (ou PAAS_PORT=<número>) para escolher outra."
  else
    info "Porta do painel na VPS: $DEFAULT_PORT (padrão — nenhuma escolha informada)."
  fi
fi

# Diálogo interativo.
if [ -z "$PORT_SOURCE" ]; then
  PORT_SOURCE="pergunta"
  say ""
  say "--------------------------------------------------------------------------------"
  say "  🔌  Em qual porta DA VPS o painel deve ficar?"
  say ""
  say "  Uma porta é o \"número da sala\" onde um programa atende dentro do servidor: dois"
  say "  programas não podem ocupar a mesma. O painel usa a $DEFAULT_PORT por padrão, e isso serve"
  say "  para quase todo mundo — só troque se ela já estiver em uso aqui."
  say ""
  say "  Esta é a porta DA VPS. A porta do seu computador, na hora de abrir o túnel, é"
  say "  outra coisa e você escolhe lá — o instalador explica isso no final."
  say "--------------------------------------------------------------------------------"
  # A situação da porta padrão é conferida UMA vez: repetir o aviso a cada
  # tentativa só faria barulho.
  PORT_SUGGESTION="$DEFAULT_PORT"
  if port_in_use "$DEFAULT_PORT" && ! port_is_own_panel "$DEFAULT_PORT"; then
    dono_padrao="$(port_owner "$DEFAULT_PORT")"
    say ""
    say "  ⚠ A porta $DEFAULT_PORT (a padrão) já está ocupada nesta VPS${dono_padrao:+ $dono_padrao}."
    PORT_SUGGESTION="$(suggest_free_port "$((DEFAULT_PORT + 1))")"
    if [ -n "$PORT_SUGGESTION" ]; then
      say "    A porta $PORT_SUGGESTION está livre — mas quem escolhe é você."
    else
      say "    Não achei nenhuma porta livre logo acima dela; digite a que você quiser."
    fi
  fi
  while :; do
    say ""
    if [ -n "$PORT_SUGGESTION" ]; then
      ask "  Porta do painel na VPS [Enter = $PORT_SUGGESTION]: "
      [ -z "$ANSWER" ] && ANSWER="$PORT_SUGGESTION"
    else
      ask "  Porta do painel na VPS: "
      if [ -z "$ANSWER" ]; then
        say "  ✗ Digite um número de porta."
        continue
      fi
    fi
    check_port "$ANSWER" || continue
    PORT="$ANSWER"
    break
  done
  log "Porta do painel na VPS: $PORT"
fi

# Chave SSH do computador do operador — SÓ para imprimir os comandos certos no
# final. O instalador roda na VPS e não enxerga as chaves do computador da
# pessoa; o ssh experimenta id_ed25519 e id_rsa sozinho, então só um nome
# personalizado precisa de `-i`. Não é gravado em lugar nenhum.
normalize_ssh_key() { # aceita "x", "x.pub", "~/.ssh/x" — devolve só "x"
  local k="$1"
  k="${k#\~/.ssh/}"; k="${k#\$HOME/.ssh/}"; k="${k%.pub}"
  printf '%s' "$k"
}
valid_ssh_key_name() {
  printf '%s' "$1" | grep -qE '^[A-Za-z0-9._@-]{1,100}$' && [ "$1" != "." ] && [ "$1" != ".." ]
}
SSH_KEY="$(normalize_ssh_key "${SSH_KEY_ARG:-${PAAS_SSH_KEY:-}}")"
if [ -n "$SSH_KEY" ] && ! valid_ssh_key_name "$SSH_KEY"; then
  warn "Nome de chave SSH ignorado (\"${SSH_KEY_ARG:-${PAAS_SSH_KEY:-}}\"): informe só o nome do arquivo em ~/.ssh, ex.: minha_vps."
  SSH_KEY=""
fi
if [ -z "${SSH_KEY_ARG:-${PAAS_SSH_KEY:-}}" ] && [ "$INTERACTIVE" = "1" ] && [ "$FORCE" = "0" ]; then
  say ""
  say "--------------------------------------------------------------------------------"
  say "  🗝️  Última pergunta (opcional): qual chave SSH você usa para entrar nesta VPS?"
  say ""
  say "  Este instalador roda NA VPS e não enxerga as chaves do seu computador. A resposta"
  say "  serve só para imprimir, no final, o comando de acesso já pronto para copiar."
  say "  Não é gravada em lugar nenhum."
  say ""
  say "  • Usa id_ed25519 ou id_rsa (o padrão do Passo 4)? Só aperte Enter."
  say "  • Usa uma chave com outro nome? Digite o nome do arquivo em ~/.ssh (ex.: minha_vps)."
  say "--------------------------------------------------------------------------------"
  while :; do
    ask "  Nome do arquivo da chave [Enter = padrão]: "
    SSH_KEY="$(normalize_ssh_key "$ANSWER")"
    [ -z "$SSH_KEY" ] && break
    valid_ssh_key_name "$SSH_KEY" && break
    say "  ✗ Digite só o nome do arquivo (letras, números, . _ - @), sem pastas. Ex.: minha_vps"
  done
fi
case "$SSH_KEY" in id_ed25519|id_rsa) SSH_KEY="" ;; esac

if [ "$TERMINAL_SOURCE" = "pergunta" ]; then
  say ""
  if [ "$TERMINAL_USER" = "root" ]; then
    log "Terminal do painel: abrirá como root (escolhido por você, desaconselhado)."
  else
    log "Terminal do painel: abrirá como $TERMINAL_USER; comandos de root no modo \"$ROOT_MODE\"."
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
  # Em VPS há systemd; em containers de teste (sem systemd) o dockerd precisa
  # ser iniciado manualmente — não é erro, apenas não há o que habilitar.
  if [ -d /run/systemd/system ]; then
    systemctl enable --now docker
  else
    warn "systemd ausente (container?) — inicie o dockerd manualmente antes de continuar."
  fi
else
  log "Docker já instalado: $(docker --version)"
fi

# Grupo docker: ninguém é adicionado (é root sem senha — veja o passo 1c). Os
# comandos do dia a dia funcionam com sudo na frente. Aqui só se executa a
# remoção que a pessoa autorizou no passo 1c.
if [ "$DOCKER_GROUP_STATE" = "remover" ]; then
  if gpasswd -d "$TERMINAL_USER" docker >/dev/null 2>&1 && ! user_in_docker_group "$TERMINAL_USER"; then
    DOCKER_GROUP_STATE="removido"
    log "\"$TERMINAL_USER\" removido do grupo docker (vale para sessões novas: saia e entre de novo por SSH)."
  else
    DOCKER_GROUP_STATE="falhou"
    warn "Não consegui remover \"$TERMINAL_USER\" do grupo docker. Confira com: id $TERMINAL_USER"
  fi
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
# O .env é lido por `docker compose` rodado pelo USUÁRIO depois — devolve a
# propriedade a quem invocou o sudo (o repo foi chown'ed para ele no README).
if [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ] && id "$SUDO_USER" >/dev/null 2>&1; then
  chown "$SUDO_USER:$SUDO_USER" .env 2>/dev/null || true
fi
log "Grupo do docker.sock no host: GID $DOCKER_GID (gravado em .env)"

# --- 5c. Diretório dos projetos no host -----------------------------------------------
# Os arquivos dos projetos implantados NÃO ficam num volume Docker: ficam num
# diretório de verdade do host, montado no container com o MESMO caminho dos
# dois lados. Motivo: o deploy roda `docker compose --project-directory <esse
# caminho>` e quem resolve os bind mounts do compose do usuário
# (`./dados:/app/dados`) é o daemon do host — um caminho que só existisse
# dentro do container faria o daemon criar pastas vazias no host.
#
# Precedência: --projects-dir > PAAS_PROJECTS_DIR > valor já gravado no .env
# (a escolha de um operador que já instalou não é sobrescrita) > default.
ENV_PROJECTS_DIR=""
if [ -f .env ]; then
  ENV_PROJECTS_DIR="$(sed -n 's/^PAAS_PROJECTS_DIR=//p' .env | tail -n1)"
fi
PROJECTS_DIR="${PROJECTS_DIR_ARG:-${PAAS_PROJECTS_DIR:-${ENV_PROJECTS_DIR:-/opt/tws-projects}}}"
case "$PROJECTS_DIR" in
  /*) ;;
  *) die "--projects-dir precisa ser um caminho absoluto (recebi: $PROJECTS_DIR)." ;;
esac

if [ ! -d "$PROJECTS_DIR" ]; then
  log "Criando o diretório dos projetos em $PROJECTS_DIR…"
  mkdir -p "$PROJECTS_DIR"
fi
# O painel roda como usuário não-root fixo (tws, UID/GID 10001). O rootfs do
# container é somente-leitura; um bind mount continua gravável, mas só se o
# dono no host permitir — sem este chown o primeiro deploy morre com EACCES.
chown 10001:10001 "$PROJECTS_DIR"
chmod 755 "$PROJECTS_DIR"

if [ -f .env ] && grep -q '^PAAS_PROJECTS_DIR=' .env; then
  sed -i "s#^PAAS_PROJECTS_DIR=.*#PAAS_PROJECTS_DIR=$PROJECTS_DIR#" .env
else
  printf 'PAAS_PROJECTS_DIR=%s\n' "$PROJECTS_DIR" >> .env
fi
if [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ] && id "$SUDO_USER" >/dev/null 2>&1; then
  chown "$SUDO_USER:$SUDO_USER" .env 2>/dev/null || true
fi
log "Arquivos dos projetos no host: $PROJECTS_DIR (gravado em .env)"

# --- 5d. Terminal do painel no .env ------------------------------------------------------
# Grava SEMPRE o par coerente (o servidor recusa subir com usuário não-root e
# modo vazio). Com root, o modo fica vazio de propósito. No caminho "legado"
# (automação sem escolha) nada é gravado: o painel segue abrindo como root,
# exatamente como antes, e uma instalação existente não muda sozinha.
env_set() { # env_set <CHAVE> <valor> — mesmo padrão do DOCKER_GID/PAAS_PROJECTS_DIR
  if [ -f .env ] && grep -q "^$1=" .env; then
    sed -i "s#^$1=.*#$1=$2#" .env
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}
if [ "$TERMINAL_SOURCE" != "legado" ]; then
  env_set PAAS_TERMINAL_USER "$TERMINAL_USER"
  env_set PAAS_ROOT_MODE "$ROOT_MODE"
  # O `docker compose` dá preferência ao ambiente sobre o .env: exporta o valor
  # resolvido para que um PAAS_TERMINAL_USER antigo no shell não vença a escolha.
  export PAAS_TERMINAL_USER="$TERMINAL_USER" PAAS_ROOT_MODE="$ROOT_MODE"
  if [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ] && id "$SUDO_USER" >/dev/null 2>&1; then
    chown "$SUDO_USER:$SUDO_USER" .env 2>/dev/null || true
  fi
  if [ "$TERMINAL_USER" = "root" ]; then
    log "Terminal do painel: root (gravado em .env)"
  else
    log "Terminal do painel: $TERMINAL_USER, modo $ROOT_MODE (gravado em .env)"
  fi
else
  log "Terminal do painel: nenhuma escolha gravada — continua abrindo como root."
fi

# --- 5e. Porta do painel no .env --------------------------------------------------------
# O docker-compose.yml publica "${PAAS_PORT:-9000}:9000": só o lado de FORA
# muda: o painel continua escutando na 9000 dentro do container. Exportamos o
# valor resolvido porque o `docker compose` dá preferência ao ambiente sobre o
# .env — um PAAS_PORT antigo no shell não pode vencer a escolha de agora.
env_set PAAS_PORT "$PORT"
export PAAS_PORT="$PORT"
if [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ] && id "$SUDO_USER" >/dev/null 2>&1; then
  chown "$SUDO_USER:$SUDO_USER" .env 2>/dev/null || true
fi
log "Painel publicado na porta $PORT da VPS (gravado em .env; dentro do container continua 9000)"

# --- 6. Build + subida ------------------------------------------------------------------
log "Buildando a imagem e subindo o painel (docker compose up -d --build)…"
SETUP_TOKEN="$SETUP_TOKEN" docker compose -f "$COMPOSE_FILE" up -d --build

# Garante o token também em arquivo no volume (fallback caso SETUP_TOKEN não
# seja passado nas próximas subidas — ex.: restart da máquina).
docker run --rm -v "$VOLUME_NAME:/data" alpine sh -c \
  "printf '%s' '$SETUP_TOKEN' > /data/setup-token && chmod 600 /data/setup-token"

# Garante que o usuário não-root do painel (tws, UID/GID fixo 10001) seja
# dono de TODO o volume — volumes criados por versões antigas (root ou UIDs
# variáveis de builds anteriores) causariam EACCES no boot do painel.
log "Ajustando dono do volume $VOLUME_NAME para tws (10001:10001)…"
docker run --rm -v "$VOLUME_NAME:/data" alpine sh -c \
  'chown -R 10001:10001 /data'

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

# Usuário do túnel SSH: quem vai ENTRAR na VPS pelo seu computador. É o
# usuário escolhido para o terminal quando ele não é root (o hardening desliga
# o login de root por SSH, então um túnel como root pararia de funcionar). Com
# root ou sem escolha, cai no usuário que chamou o sudo, como antes.
TUNNEL_NOTE=""
if [ "$TERMINAL_SOURCE" != "legado" ] && [ "$TERMINAL_USER" != "root" ]; then
  TUNNEL_USER="$TERMINAL_USER"
  TUNNEL_HOME="$(getent passwd "$TUNNEL_USER" | cut -d: -f6)"
  if [ -n "$TUNNEL_HOME" ] && [ ! -s "$TUNNEL_HOME/.ssh/authorized_keys" ]; then
    TUNNEL_NOTE="     Atenção: $TUNNEL_USER ainda não tem nenhuma chave SSH instalada nesta VPS.
     Instale a sua nele (Passo 4 do README) — ou, se você entra com outro usuário,
     troque $TUNNEL_USER pelo nome dele no comando acima."
  fi
else
  TUNNEL_USER="${SUDO_USER:-}"
  [ "$TUNNEL_USER" = "root" ] && TUNNEL_USER=""
  TUNNEL_USER="${TUNNEL_USER:-SEU_USUARIO}"
fi
SSH_KEY_OPT=""
[ -n "$SSH_KEY" ] && SSH_KEY_OPT="-i ~/.ssh/$SSH_KEY "
TUNNEL_CMD="ssh ${SSH_KEY_OPT}-L $PORT:localhost:$PORT $TUNNEL_USER@$PUBLIC_IP"

# O túnel tem duas pontas, e a da ESQUERDA é uma porta do computador do
# operador — que este script não tem como inspecionar. Quando ela já está
# ocupada lá, o ssh recusa com "Address already in use"; a correção é trocar só
# aquele número. Não citamos comando para "achar uma porta livre" porque não
# existe um que funcione igual em Linux, macOS e no PowerShell do Windows.
LOCAL_ALT=9100
[ "$PORT" = "9100" ] && LOCAL_ALT=9101
LOCAL_PORT_NOTE="     Se o ssh recusar com \"bind [127.0.0.1]:$PORT: Address already in use\", a porta
     ocupada é a do SEU computador (o número da ESQUERDA, antes dos dois-pontos) —
     não a da VPS. Troque só ele por outro qualquer, por exemplo:

${CYAN}${BOLD}       ssh ${SSH_KEY_OPT}-L $LOCAL_ALT:localhost:$PORT $TUNNEL_USER@$PUBLIC_IP${RESET}

     e abra o navegador em http://localhost:$LOCAL_ALT/... em vez de :$PORT."

# No modo "senha", a senha do sudo passa pelo painel: pelo IP direto ela
# trafegaria sem criptografia. Reforça isso exatamente onde o link aparece.
DIRECT_NOTE=""
if [ "$TERMINAL_SOURCE" != "legado" ] && [ "$ROOT_MODE" = "senha" ]; then
  DIRECT_NOTE="${YELLOW}${BOLD}Você escolheu o modo \"senha\":${RESET} a senha do seu usuário vai ser digitada no
terminal do painel. Pelo link do IP abaixo ela passaria pela internet sem
criptografia — use o túnel acima.

"
fi

if [ "$TERMINAL_SOURCE" = "legado" ]; then
  TERMINAL_SUMMARY="abre como root (nenhuma escolha feita na instalação)."
elif [ "$TERMINAL_USER" = "root" ]; then
  TERMINAL_SUMMARY="abre como root (desaconselhado)."
elif [ "$ROOT_MODE" = "senha" ]; then
  TERMINAL_SUMMARY="abre como $TERMINAL_USER; comandos de root pedem a sua senha (sudo) no terminal."
else
  TERMINAL_SUMMARY="abre como $TERMINAL_USER; comandos de root rodam em segundo plano (veja a Auditoria)."
fi

# Grupo docker do usuário do terminal (passo 1c): confirma a remoção ou avisa,
# em destaque, que a proteção do modo escolhido não está valendo.
DOCKER_GROUP_NOTE=""
case "$DOCKER_GROUP_STATE" in
  removido)
    DOCKER_GROUP_NOTE="
${BOLD}Grupo docker:${RESET} $TERMINAL_USER foi removido, como você autorizou. Só vale para sessões
    novas: saia da VPS (exit) e entre de novo por SSH — as sessões já abertas
    continuam com o acesso antigo até lá.
" ;;
  recusou|automacao|falhou)
    case "$DOCKER_GROUP_STATE" in
      recusou)   motivo_docker="Você preferiu manter assim durante a instalação." ;;
      automacao) motivo_docker="Em automação, o instalador não altera grupos sem confirmação." ;;
      *)         motivo_docker="O instalador tentou remover e não conseguiu (confira com: id $TERMINAL_USER)." ;;
    esac
    DOCKER_GROUP_NOTE="
${YELLOW}${BOLD}⚠  ATENÇÃO: A PROTEÇÃO DO TERMINAL DO PAINEL NÃO ESTÁ VALENDO${RESET}
${YELLOW}    $TERMINAL_USER está no grupo docker, e quem está nesse grupo vira root sem senha
    com um único comando docker. Do terminal do painel dá para contornar o modo
    \"$ROOT_MODE\". $motivo_docker${RESET}

    Para corrigir, rode na VPS:

${CYAN}${BOLD}      sudo gpasswd -d $TERMINAL_USER docker${RESET}

    Depois saia da VPS (exit) e entre de novo por SSH: a mudança só vale em
    sessões novas.
" ;;
esac

# Toca o "bell" do terminal para chamar atenção ao fim da instalação.
printf '\a'

cat <<EOF

${GREEN}${BOLD}██████████████████████████████████████████████████████████████████████████████
██                                                                          ██
██               ✅  TWS PANEL INSTALADO E RODANDO COM SUCESSO!               ██
██                                                                          ██
██████████████████████████████████████████████████████████████████████████████${RESET}

${BOLD}👉  PRÓXIMO PASSO: abra o painel no navegador${RESET}

${BOLD}Recomendado — acesse por túnel SSH.${RESET} A senha de administrador que você vai
criar na última etapa do wizard é permanente: por túnel ela nunca trafega em texto
claro pela internet.

  1) Numa janela NOVA do terminal, no SEU COMPUTADOR (não na VPS), deixe aberto:

${CYAN}${BOLD}      $TUNNEL_CMD${RESET}

$LOCAL_PORT_NOTE
${TUNNEL_NOTE:+
$TUNNEL_NOTE
}
  2) Com essa janela aberta, abra no navegador:

${CYAN}${BOLD}      http://localhost:$PORT/?token=$SETUP_TOKEN${RESET}

     (Windows: PowerShell já traz o comando ssh acima pronto para uso; no
     PuTTY, configure em Connection → SSH → Tunnels: Source port $PORT,
     Destination localhost:$PORT, Local.)

${DIRECT_NOTE}${YELLOW}Direto pelo IP${RESET} — sem criptografia; use só em rede confiável ou ambiente de
teste descartável:

${CYAN}      http://$PUBLIC_IP:$PORT/?token=$SETUP_TOKEN${RESET}

${YELLOW}${BOLD}┌──────────────────────────────────────────────────────────────────────────┐
│                            ⚑  SETUP TOKEN  ⚑                              │
│                                                                          │
│   $SETUP_TOKEN                       │
│                                                                          │
│   ⚠  Ele aparece SÓ AGORA em destaque. Guarde-o até concluir o wizard.   │
│   ⚠  Após criar a conta admin no fim do wizard, ele é invalidado.        │
└──────────────────────────────────────────────────────────────────────────┘${RESET}

${BOLD}Perdeu o token? Recupere a qualquer momento com:${RESET}

      sudo docker exec tws-panel cat /data/setup-token

O assistente vai diagnosticar o servidor e guiar o setup.

${BOLD}Porta do painel na VPS:${RESET} $PORT (gravada no .env; dentro do container continua 9000).
    Para trocar depois: ./scripts/install.sh --port=<número>

${BOLD}Terminal do painel:${RESET} ${TERMINAL_SUMMARY}
    Para trocar depois: ./scripts/install.sh --reconfigure-terminal
${DOCKER_GROUP_NOTE}
Comandos úteis (em $APP_DIR) — com sudo: o painel não coloca ninguém no grupo
docker, porque estar nele é ter root sem senha.
    sudo docker compose ps              # status do painel
    sudo docker compose logs -f panel   # logs em tempo real
    sudo docker compose up -d --build   # rebuild/restart (ex.: após git pull)

EOF
