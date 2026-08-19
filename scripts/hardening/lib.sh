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

# shellcheck shell=bash

PAAS_DRY_RUN="${PAAS_DRY_RUN:-0}"
PAAS_BACKUP_TS="$(date +%Y%m%d-%H%M%S)"
PAAS_STATE_DIR="/etc/paas"
PAAS_ROLLBACK_DELAY="${PAAS_ROLLBACK_DELAY:-300}" # 5 min (alinhado a `at now +5 minutes`)

# ---------------------------------------------------------------------------
# Logging / marcadores de progresso
# ---------------------------------------------------------------------------

step()  { echo ":::PAAS_STEP $*"; }
ok()    { echo ":::PAAS_OK $*"; }
skip()  { echo ":::PAAS_SKIP $*"; }
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
      return 0
    fi
    warn "agendamento via at falhou; usando timer em background"
  fi
  # Fallback sem `at`: processo em background sobrevive à sessão.
  setsid nohup bash -c "sleep '${PAAS_ROLLBACK_DELAY}'; bash '$revert_script'" \
    >"/var/log/paas-rollback-${id}.log" 2>&1 &
  echo "$!" > "$pidfile"
  info "rollback agendado via timer em background (pid $(cat "$pidfile")) em ${PAAS_ROLLBACK_DELAY}s"
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
