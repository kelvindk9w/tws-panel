#!/usr/bin/env bash
# lib.sh — helpers comuns dos scripts de hardening do painel PaaS.
# Uso: cada script de fase faz `source "$(dirname "$0")/lib.sh"` APÓS `set -euo pipefail`.
#
# Convenções:
#  - Idempotente: re-executar nunca quebra nem duplica configuração.
#  - Backup de todo arquivo antes de alterar: <arquivo>.paas-backup.<TIMESTAMP>
#  - --dry-run: mostra o que faria sem alterar nada.
#  - --rollback: restaura os backups mais recentes e desfaz o que for seguro desfazer.
#  - Marcadores `:::PAAS_STEP/:::PAAS_OK/...` são parseados pelo executor (packages/security).
#  - `:::PAAS_ROLLBACK_SCHEDULED <id>` é emitido por schedule_rollback SÓ quando
#    uma reversão automática foi mesmo agendada no host (nunca em dry-run). O
#    executor usa esse marcador — e não os argumentos da fase — para saber que
#    existe uma janela de confirmação correndo no alvo.

# shellcheck shell=bash

PAAS_DRY_RUN="${PAAS_DRY_RUN:-0}"
PAAS_BACKUP_TS="$(date +%Y%m%d-%H%M%S)"
PAAS_STATE_DIR="/etc/paas"
PAAS_ROLLBACK_DELAY="${PAAS_ROLLBACK_DELAY:-300}" # 5 min (alinhado a `at now +5 minutes`)

# needrestart: NUNCA reiniciar serviços sozinho no meio de uma fase.
# O needrestart é acionado pelo hook de dpkg em toda instalação/atualização e,
# no modo automático, reinicia os serviços que usam bibliotecas atualizadas —
# o que inclui docker.service e ssh.service. Reiniciar o Docker derruba o
# container do painel e o container auxiliar onde a fase está rodando; o modo
# interativo é igualmente ruim aqui, porque abriria um menu whiptail no meio do
# log da fase. "l" (list only) só relata o que precisaria reiniciar.
# Valores conferidos em needrestart(1) (Ubuntu noble): (l)ist, (i)nteractive, (a)utomatic.
export NEEDRESTART_MODE="${NEEDRESTART_MODE:-l}"

# ---------------------------------------------------------------------------
# Logging / marcadores de progresso
# ---------------------------------------------------------------------------

step()  { echo ":::PAAS_STEP $*"; }
ok()    { echo ":::PAAS_OK $*"; }
skip()  { echo ":::PAAS_SKIP $*"; }
# Sinal de controle (não é um passo): avisa o executor que existe uma reversão
# automática agendada no host, com a janela correndo. Só schedule_rollback emite.
rollback_scheduled() { echo ":::PAAS_ROLLBACK_SCHEDULED $*"; }
info()  { echo "[paas] $*"; }
warn()  { echo "[paas] WARN: $*" >&2; }
die()   { echo ":::PAAS_FAIL $*" >&2; echo "[paas] ERROR: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Execução com suporte a dry-run
# ---------------------------------------------------------------------------

# run <cmd> [args...] — executa comando (sem shell) ou só imprime em dry-run.
run() {
  if [ "$PAAS_DRY_RUN" = "1" ]; then
    echo "[dry-run] $*"
    return 0
  fi
  "$@"
}

# run_sh "<comando shell>" — para pipelines/redirects. Em dry-run só imprime.
run_sh() {
  if [ "$PAAS_DRY_RUN" = "1" ]; then
    echo "[dry-run] sh: $1"
    return 0
  fi
  bash -c "$1"
}

# write_file <dest> — lê stdin e grava em <dest> (com backup prévio). Dry-run: imprime o conteúdo.
write_file() {
  local dest="$1"
  local content
  content="$(cat)"
  if [ "$PAAS_DRY_RUN" = "1" ]; then
    echo "[dry-run] escreveria $dest:"
    echo "$content" | sed 's/^/    | /'
    return 0
  fi
  backup_file "$dest"
  mkdir -p "$(dirname "$dest")"
  printf '%s\n' "$content" > "$dest"
  info "arquivo escrito: $dest"
}

# ---------------------------------------------------------------------------
# Backup / restore
# ---------------------------------------------------------------------------

# backup_file <arquivo> — copia para <arquivo>.paas-backup.<TS> (uma vez por execução).
backup_file() {
  local file="$1"
  [ -e "$file" ] || return 0
  local dest="${file}.paas-backup.${PAAS_BACKUP_TS}"
  if [ "$PAAS_DRY_RUN" = "1" ]; then
    echo "[dry-run] backup: $file -> $dest"
    return 0
  fi
  cp -a "$file" "$dest"
  info "backup criado: $dest"
}

# restore_latest_backup <arquivo> — restaura o backup .paas-backup.* mais recente.
restore_latest_backup() {
  local file="$1"
  local latest
  latest="$(ls -1t "${file}".paas-backup.* 2>/dev/null | head -n 1 || true)"
  if [ -z "$latest" ]; then
    if [ -e "$file" ]; then
      # sem backup: remove o arquivo que nós criamos (ex.: drop-ins novos)
      run rm -f "$file"
      info "sem backup de $file — arquivo removido"
    else
      info "nada a restaurar em $file"
    fi
    return 0
  fi
  if [ "$PAAS_DRY_RUN" = "1" ]; then
    echo "[dry-run] restauraria $latest -> $file"
    return 0
  fi
  cp -a "$latest" "$file"
  info "restaurado: $latest -> $file"
}

# ---------------------------------------------------------------------------
# Serviços (tolerante a ambientes sem systemd, ex.: containers)
# ---------------------------------------------------------------------------

has_systemd() {
  [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1
}

# svc_enable_now <unit> — enable + start, com fallback para `service` ou skip.
svc_enable_now() {
  local unit="$1"
  if [ "$PAAS_DRY_RUN" = "1" ]; then
    echo "[dry-run] habilitaria e iniciaria serviço: $unit"
    return 0
  fi
  if has_systemd; then
    systemctl enable --now "$unit" || warn "falha ao habilitar $unit (continuando)"
  elif command -v service >/dev/null 2>&1; then
    service "$unit" start || warn "sem systemd: não foi possível iniciar $unit (continuando)"
  else
    warn "sem systemd/service: $unit não iniciado"
  fi
}

# svc_reload_or_restart <unit>
svc_reload_or_restart() {
  local unit="$1"
  if [ "$PAAS_DRY_RUN" = "1" ]; then
    echo "[dry-run] recarregaria serviço: $unit"
    return 0
  fi
  if has_systemd; then
    systemctl reload "$unit" 2>/dev/null || systemctl restart "$unit" || warn "falha ao recarregar $unit"
  elif command -v service >/dev/null 2>&1; then
    service "$unit" reload 2>/dev/null || service "$unit" restart || warn "falha ao recarregar $unit"
  else
    warn "sem systemd/service: $unit não recarregado"
  fi
}

# svc_disable_mask <unit> — desabilita e mascara, tolerante a unidade inexistente.
svc_disable_mask() {
  local unit="$1"
  if [ "$PAAS_DRY_RUN" = "1" ]; then
    echo "[dry-run] desabilitaria e mascararia: $unit"
    return 0
  fi
  if has_systemd; then
    systemctl disable --now "$unit" 2>/dev/null || true
    systemctl mask "$unit" 2>/dev/null || true
    info "serviço desabilitado/mascarado: $unit"
  else
    info "sem systemd: nada a fazer para $unit"
  fi
}

# ---------------------------------------------------------------------------
# Pacotes
# ---------------------------------------------------------------------------

pkg_installed() { dpkg -s "$1" >/dev/null 2>&1; }

# apt_install <pkgs...> — instala se ausente (idempotente).
apt_install() {
  local missing=()
  local pkg
  for pkg in "$@"; do
    pkg_installed "$pkg" || missing+=("$pkg")
  done
  if [ "${#missing[@]}" -eq 0 ]; then
    info "pacotes já instalados: $*"
    return 0
  fi
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
}

# ---------------------------------------------------------------------------
# Pacotes que REINICIAM o daemon do Docker
# ---------------------------------------------------------------------------
# O painel roda DENTRO de um container, e as fases rodam num container auxiliar
# (PTY via nsenter — apps/server/src/services/docker-socket.ts). Quem mantém os
# dois de pé é o daemon do Docker. Atualizar qualquer um destes pacotes reinicia
# o daemon e derruba, no meio do dpkg, o canal por onde a própria fase está
# sendo executada.
#
# Nomes conferidos em docs.docker.com/engine/install/ubuntu (repositório oficial)
# e no próprio get.docker.com — que é o instalador usado por scripts/install.sh.
# Os dois últimos são a alternativa do arquivo do Ubuntu (docker.io/containerd),
# que entra pelas mesmas origens que o unattended-upgrades atualiza sozinho.
PAAS_DOCKER_PKGS="docker-ce docker-ce-cli docker-ce-rootless-extras containerd.io docker-buildx-plugin docker-compose-plugin docker-model-plugin docker.io containerd"

# Pacotes que ESTE script colocou em hold (para desfazer no fim / no trap).
PAAS_DOCKER_HELD_BY_US=""

# paas_docker_pkgs_installed — lista (uma por linha) os pacotes do Docker presentes.
paas_docker_pkgs_installed() {
  local pkg
  for pkg in $PAAS_DOCKER_PKGS; do
    pkg_installed "$pkg" && echo "$pkg"
  done
  return 0
}

# paas_docker_pkgs_pending — lista os pacotes do Docker que um full-upgrade
# atualizaria AGORA (usa a simulação do apt; precisa rodar ANTES do hold).
paas_docker_pkgs_pending() {
  local sim pkg
  sim="$(apt-get -s full-upgrade 2>/dev/null | grep -E '^Inst ' || true)"
  [ -n "$sim" ] || return 0
  for pkg in $PAAS_DOCKER_PKGS; do
    printf '%s\n' "$sim" | grep -qE "^Inst ${pkg} " && echo "$pkg"
  done
  return 0
}

# paas_docker_hold — segura os pacotes do Docker durante o upgrade desta fase.
# Lê `apt-mark showhold` ANTES: o que já estava em hold foi decisão do operador
# e NÃO é desfeito depois. Registra um trap para devolver o estado mesmo se o
# script morrer no meio.
paas_docker_hold() {
  local already pkg to_hold=""
  already="$(apt-mark showhold 2>/dev/null || true)"
  for pkg in $(paas_docker_pkgs_installed); do
    if printf '%s\n' "$already" | grep -qxF "$pkg"; then
      info "$pkg já estava em hold (decisão do operador) — será mantido assim"
    else
      to_hold="$to_hold $pkg"
    fi
  done
  # shellcheck disable=SC2086
  set -- $to_hold
  if [ $# -eq 0 ]; then
    info "nenhum pacote do Docker a segurar"
    return 0
  fi
  if [ "$PAAS_DRY_RUN" = "1" ]; then
    echo "[dry-run] apt-mark hold $*"
    return 0
  fi
  # O trap é armado ANTES do hold: se o apt-mark falhar no meio da lista, o
  # unhold ainda roda para o que já tiver sido segurado.
  PAAS_DOCKER_HELD_BY_US="$*"
  trap 'paas_docker_unhold' EXIT
  trap 'paas_docker_unhold; exit 130' INT
  trap 'paas_docker_unhold; exit 143' TERM HUP
  apt-mark hold "$@" >/dev/null || warn "apt-mark hold falhou para: $*"
  info "pacotes do Docker segurados durante esta fase: $*"
}

# paas_docker_unhold — devolve ao estado anterior SÓ o que nós seguramos.
# Idempotente: pode ser chamado pelo fluxo normal e de novo pelo trap.
paas_docker_unhold() {
  local held="$PAAS_DOCKER_HELD_BY_US"
  [ -n "$held" ] || return 0
  PAAS_DOCKER_HELD_BY_US=""
  trap - EXIT INT TERM HUP
  if [ "$PAAS_DRY_RUN" = "1" ]; then
    echo "[dry-run] apt-mark unhold $held"
    return 0
  fi
  # shellcheck disable=SC2086
  apt-mark unhold $held >/dev/null || warn "apt-mark unhold falhou para: $held"
  info "hold temporário removido: $held"
}

# apt_purge_if_installed <pkgs...> — purge com simulação prévia (spec 5.2).
apt_purge_if_installed() {
  local installed=()
  local pkg
  for pkg in "$@"; do
    pkg_installed "$pkg" && installed+=("$pkg")
  done
  if [ "${#installed[@]}" -eq 0 ]; then
    info "nenhum dos pacotes está instalado: $*"
    return 0
  fi
  if [ "$PAAS_DRY_RUN" = "1" ]; then
    echo "[dry-run] purgaria: ${installed[*]}"
    apt-get -s purge "${installed[@]}" 2>/dev/null | grep -E '^(Remv|Purg)' || true
    return 0
  fi
  env DEBIAN_FRONTEND=noninteractive apt-get purge -y "${installed[@]}"
}

# ---------------------------------------------------------------------------
# Rollback automático agendado (SSH/firewall)
# ---------------------------------------------------------------------------
# schedule_rollback <id> <arquivo-de-reversão>
# Agenda a execução do arquivo de reversão em 5 minutos via `at`; se `at` não
# estiver disponível, usa um processo em background com sleep. O agendamento é
# cancelado por confirm_rollback (acionado via --confirm após o operador
# comprovar que ainda tem acesso ao servidor).

schedule_rollback() {
  local id="$1"
  local revert_script="$2"
  local pidfile="${PAAS_STATE_DIR}/pending-rollback-${id}.pid"
  local jobfile="${PAAS_STATE_DIR}/pending-rollback-${id}.at"
  if [ "$PAAS_DRY_RUN" = "1" ]; then
    echo "[dry-run] agendaria rollback automático em ${PAAS_ROLLBACK_DELAY}s: $revert_script"
    return 0
  fi
  mkdir -p "$PAAS_STATE_DIR"
  chmod 700 "$revert_script"
  if command -v at >/dev/null 2>&1; then
    svc_enable_now atd || true
    local job
    job="$(echo "bash '$revert_script'" | at "now + $((PAAS_ROLLBACK_DELAY / 60)) minutes" 2>&1 | grep -oE 'job [0-9]+' | awk '{print $2}' || true)"
    if [ -n "$job" ]; then
      echo "$job" > "$jobfile"
      info "rollback agendado via at (job $job) em $((PAAS_ROLLBACK_DELAY / 60)) min"
      rollback_scheduled "$id"
      return 0
    fi
    warn "agendamento via at falhou; usando timer em background"
  fi
  # Fallback sem `at`: processo em background sobrevive à sessão.
  setsid nohup bash -c "sleep '${PAAS_ROLLBACK_DELAY}'; bash '$revert_script'" \
    >"/var/log/paas-rollback-${id}.log" 2>&1 &
  echo "$!" > "$pidfile"
  info "rollback agendado via timer em background (pid $(cat "$pidfile")) em ${PAAS_ROLLBACK_DELAY}s"
  rollback_scheduled "$id"
}

# confirm_rollback <id> — cancela o rollback agendado (operador confirmou acesso).
confirm_rollback() {
  local id="$1"
  local pidfile="${PAAS_STATE_DIR}/pending-rollback-${id}.pid"
  local jobfile="${PAAS_STATE_DIR}/pending-rollback-${id}.at"
  local cancelled=0
  if [ -f "$jobfile" ]; then
    local job
    job="$(cat "$jobfile")"
    if [ "$PAAS_DRY_RUN" = "1" ]; then
      echo "[dry-run] cancelaria job at $job"
    else
      atrm "$job" 2>/dev/null || true
    fi
    rm -f "$jobfile"
    cancelled=1
  fi
  if [ -f "$pidfile" ]; then
    local pid
    pid="$(cat "$pidfile")"
    if [ "$PAAS_DRY_RUN" = "1" ]; then
      echo "[dry-run] cancelaria timer pid $pid"
    else
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
    cancelled=1
  fi
  if [ "$cancelled" = "1" ]; then
    info "rollback agendado CANCELADO ($id) — acesso confirmado pelo operador"
  else
    info "nenhum rollback pendente para $id"
  fi
}

# ---------------------------------------------------------------------------
# Execução DESTACADA da fase (sobrevive à queda do canal)
# ---------------------------------------------------------------------------
# Por que: a fase é disparada pelo painel DENTRO de um canal efêmero — o PTY
# (container auxiliar criado pelo daemon do Docker) ou o helper do host bridge.
# Qualquer coisa que derrube esse canal (rede caindo, aba fechada, reinício do
# daemon do Docker) matava o apt/dpkg no meio. Aqui a fase é lançada com setsid
# (sessão própria, reparentada ao init), com a saída indo para um arquivo de log
# e o código de saída para um arquivo próprio. O canal só ACOMPANHA o log: se
# ele cair, a fase continua, e o painel reatacha depois pelo mesmo id.
#
# Arquivos em <dir> (default ${PAAS_STATE_DIR}/runs), criados com umask 022 —
# legíveis por qualquer usuário DE PROPÓSITO: no modo senha o acompanhamento
# roda como o usuário comum do terminal e não pode pedir a senha do sudo a cada
# leitura. O que fica legível é a mesma saída que já rola no terminal dele.
#   <id>.log       saída combinada (stdout+stderr) da fase
#   <id>.pid       pid do processo destacado
#   <id>.exit      código de saída — escrito SÓ no fim (é o sinal de "terminou")
#   <script>.lock  trava por FASE (flock), mantida pelo processo destacado
#                  enquanto ele vive: a mesma fase nunca roda duas vezes.
PAAS_RUN_DIR_DEFAULT="${PAAS_STATE_DIR}/runs"

# paas_run_stream <log> <exitf> <pid> — transmite o log e termina com o marcador
# :::PAAS_RUN_END <código|-> <ok|dead>. Com o pid vivo usa `tail --pid`, que
# drena o arquivo e sai sozinho quando o processo morre (sem corrida de leitura).
paas_run_stream() {
  local log="$1" exitf="$2" pid="$3"
  if [ -n "$pid" ] && [ "$pid" != "0" ] && [ -d "/proc/$pid" ]; then
    tail -c +1 -f --pid="$pid" "$log" 2>/dev/null || true
  else
    cat "$log" 2>/dev/null || true
  fi
  # O código de saída é gravado logo depois que o processo morre: pequena folga.
  local i=0
  while [ ! -e "$exitf" ] && [ "$i" -lt 15 ]; do
    sleep 1
    i=$((i + 1))
  done
  if [ -e "$exitf" ]; then
    local code
    code="$(tr -dc '0-9' < "$exitf" | head -c 3)"
    printf '\n:::PAAS_RUN_END %s ok\n' "${code:-1}"
  else
    printf '\n:::PAAS_RUN_END - dead\n'
  fi
}

# paas_run_detached <dir> <id> <script> [args...] — lança a fase destacada e
# acompanha até o fim. Chamado pelo painel como:
#   bash <dir-dos-scripts>/lib.sh --paas-run-detached '<dir>' <id> <script> [args]
paas_run_detached() {
  local dir="$1" id="$2" script="$3"
  shift 3
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local log="$dir/$id.log" exitf="$dir/$id.exit" pidf="$dir/$id.pid" lock="$dir/$script.lock"
  umask 022
  mkdir -p "$dir" || { printf ':::PAAS_RUN_FAIL sem acesso a %s\n' "$dir"; return 70; }
  chmod 755 "$dir" 2>/dev/null || true
  # A trava é aberta no fd 9 e HERDADA pelo processo destacado: quando este
  # shell sai, o lock continua de pé porque o filho ainda tem o fd aberto.
  exec 9>>"$lock" || { printf ':::PAAS_RUN_FAIL sem acesso a %s\n' "$lock"; return 70; }
  if ! flock -n 9; then
    printf ':::PAAS_RUN_BUSY %s\n' "$script"
    return 75
  fi
  : > "$log"
  chmod 644 "$log" 2>/dev/null || true
  rm -f "$exitf"
  # O corpo do filho é literal (aspas simples): nada é interpolado — os dados
  # chegam como argv, então nenhum argumento vira shell.
  setsid nohup bash -c '
    log="$1"; exitf="$2"; target="$3"; shift 3
    bash "$target" "$@" > "$log" 2>&1
    printf "%s\n" "$?" > "$exitf.parcial"
    mv -f "$exitf.parcial" "$exitf"
  ' paas-run "$log" "$exitf" "$here/$script" "$@" < /dev/null > /dev/null 2>&1 &
  local child=$!
  printf '%s\n' "$child" > "$pidf"
  chmod 644 "$pidf" 2>/dev/null || true
  printf ':::PAAS_RUN_STARTED %s %s\n' "$id" "$child"
  paas_run_stream "$log" "$exitf" "$child"
}

# paas_run_follow <dir> <id> — reatache: reexibe o log desde o início e segue
# até o fim. É também o caminho da reconciliação (execução já terminada devolve
# o log completo e o código na hora; execução inexistente devolve "missing").
paas_run_follow() {
  local dir="$1" id="$2"
  local log="$dir/$id.log" exitf="$dir/$id.exit" pidf="$dir/$id.pid"
  if [ ! -e "$log" ]; then
    printf ':::PAAS_RUN_END - missing\n'
    return 0
  fi
  paas_run_stream "$log" "$exitf" "$(cat "$pidf" 2>/dev/null || echo 0)"
}

# ---------------------------------------------------------------------------
# Parsing de argumentos comum
# ---------------------------------------------------------------------------

paas_usage_common() {
  cat <<'EOF'
Opções comuns:
  --dry-run    mostra o que faria sem alterar nada
  --rollback   desfaz as alterações desta fase (restaura backups mais recentes)
  --confirm    cancela o rollback automático agendado (fases SSH/firewall)
EOF
}

# ---------------------------------------------------------------------------
# Despacho quando lib.sh é EXECUTADO (não sourced) pelo painel
# ---------------------------------------------------------------------------
# Os sentinelas abaixo não são opção de nenhuma fase, então um `source lib.sh`
# feito por um script de fase (que herda os argumentos dele: --dry-run,
# --rollback, --confirm, --user, --pubkey) nunca cai aqui.
case "${1:-}" in
  --paas-run-detached)
    shift
    paas_run_detached "$@"
    exit $?
    ;;
  --paas-run-follow)
    shift
    paas_run_follow "$@"
    exit $?
    ;;
esac
