#!/usr/bin/env bash
# =============================================================================
# TWS Panel — recuperar-acesso.sh
#
# Comando ÚNICO e curto para quem perdeu o acesso e só tem o CONSOLE do
# provedor (VNC, teclado ruim): entre com o usuário e a senha Linux e rode
#
#   sudo /opt/tws-panel/scripts/recuperar-acesso.sh
#
# Menu:
#   1  Abrir o SSH por SENHA por 15 minutos, só para o usuário de administração
#      (e, se quiser, só a partir de um IP). Fecha sozinho, mesmo com reinício.
#      Nesse tempo, do seu computador, mande a chave nova e pronto.
#   2  Desbloquear o fail2ban (um IP ou todos; jails sshd e recidive).
#   3  Reativar o acesso ao painel pelo IP (reativar-acesso-ip.sh).
#   4  Desligar a verificação em duas etapas (reset-2fa.sh) — ou só o código
#      por e-mail, mantendo o 2FA.
#   5  Redefinir só a senha do painel (reset-senha.sh), sem apagar a conta.
#   0  Sair.
#
# Também aceita subcomandos (sem menu): janela, desbanir, ip, 2fa, email,
# senha, fechar. Opções: --usuario NOME, --ip IP, --qualquer-ip, --silencioso.
#
# Quem roda isto já provou quem é: tem o console do provedor e sudo. O painel
# NUNCA abre essa janela sozinho. O SSH continua só por chave fora dela.
#
# Variáveis (para testes): ETC_DIR, ENV_FILE, SSHD, SYSTEMCTL, FAIL2BAN_CLIENT,
# UFW, AT, ATQ, PASSWD_BIN, DOCKER, PAAS_SCRIPTS_DIR, SYSTEMD_RUN_DIR, WINDOW_MIN, PAAS_ASSUME_ROOT.
# =============================================================================
set -euo pipefail

ETC_DIR="${ETC_DIR:-/etc}"
SSHD="${SSHD:-sshd}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
FAIL2BAN_CLIENT="${FAIL2BAN_CLIENT:-fail2ban-client}"
UFW="${UFW:-ufw}"
AT="${AT:-at}"
ATQ="${ATQ:-atq}"
PASSWD_BIN="${PASSWD_BIN:-passwd}"
DOCKER="${DOCKER:-docker}"
SYSTEMD_RUN_DIR="${SYSTEMD_RUN_DIR:-/run/systemd/system}"
WINDOW_MIN="${WINDOW_MIN:-15}"
SELF="$(readlink -f "$0")"
SELF_DIR="$(dirname "$SELF")"
PAAS_SCRIPTS_DIR="${PAAS_SCRIPTS_DIR:-$SELF_DIR}"
ENV_FILE="${ENV_FILE:-$SELF_DIR/../.env}"

CONF_DIR="$ETC_DIR/ssh/sshd_config.d"
CONF_FILE="$CONF_DIR/00-paas-recuperacao.conf"
STATE_DIR="$ETC_DIR/paas"
EXPIRY_FILE="$STATE_DIR/recuperacao.expira"
UNIT_DIR="$ETC_DIR/systemd/system"
UNIT_NAME="paas-recuperacao-fechar"

VOLUME_NAME="${PAAS_VOLUME:-paas_data}"
IMAGE="${PAAS_IMAGE:-tws-panel:latest}"
CONTAINER="tws-panel"

QUIET=0
ADMIN_USER=""
WANT_IP=""
ANY_IP=0

say() { [ "$QUIET" = "1" ] || printf '%s\n' "$*"; }
log() { [ "$QUIET" = "1" ] || printf '\033[1;34m[tws-panel]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[tws-panel][aviso]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[tws-panel][erro]\033[0m %s\n' "$*" >&2; exit 1; }

need_root() {
  [ "${PAAS_ASSUME_ROOT:-0}" = "1" ] || [ "$(id -u)" = "0" ] || die "rode com sudo: sudo $SELF"
}

ask() { # ask "pergunta" -> resposta (vazia no fim da entrada)
  local a=""
  printf '%s' "$1" >&2
  read -r a || a=""
  printf '%s' "$a"
}

# ---------------------------------------------------------------- validações

valid_ip() {
  local ip="$1" o
  if [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
    local IFS=.
    for o in $ip; do
      # sem zero à esquerda (010 pode ser lido como octal) e no máximo 255
      [[ "$o" =~ ^(0|[1-9][0-9]{0,2})$ ]] || return 1
      [ "$o" -le 255 ] || return 1
    done
    return 0
  fi
  # IPv6: só hexadecimal e ':' (sem '.'), com ao menos dois ':' e no máximo 39 caracteres
  if [[ "$ip" =~ ^[0-9a-fA-F:]+$ ]] && [ "${#ip}" -le 39 ] && [[ "$ip" == *:*:* ]]; then
    return 0
  fi
  return 1
}

resolve_admin_user() {
  local u="$ADMIN_USER"
  if [ -z "$u" ] && [ -r "$ENV_FILE" ]; then
    u="$(sed -n 's/^PAAS_TERMINAL_USER=//p' "$ENV_FILE" | tail -n 1 | tr -d "\"'" || true)"
  fi
  [ -n "$u" ] || u="${SUDO_USER:-}"
  [ -n "$u" ] || die "não sei qual é o usuário de administração. Use: --usuario NOME"
  [ "$u" != "root" ] || die "o usuário de administração não pode ser root (o SSH do root continua fechado). Use --usuario NOME."
  [[ "$u" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "nome de usuário inválido: $u"
  id "$u" >/dev/null 2>&1 || die "o usuário '$u' não existe nesta máquina."
  ADMIN_USER="$u"
}

# ------------------------------------------------------------ janela do SSH

# Recarrega o sshd; se o reload não pegar (ex.: ssh.service parado com socket activation), reinicia.
reload_sshd() {
  "$SYSTEMCTL" reload ssh >/dev/null 2>&1 || "$SYSTEMCTL" reload sshd >/dev/null 2>&1 \
    || "$SYSTEMCTL" restart ssh >/dev/null 2>&1 || "$SYSTEMCTL" restart sshd >/dev/null 2>&1
}

# Fecha a janela: idempotente. Sem janela aberta, não faz nada além de limpar sobras.
close_window() {
  local had=0
  if [ -e "$CONF_FILE" ]; then had=1; rm -f "$CONF_FILE"; fi
  rm -f "$EXPIRY_FILE"
  if [ -e "$UNIT_DIR/$UNIT_NAME.timer" ] || [ -e "$UNIT_DIR/$UNIT_NAME.service" ]; then
    "$SYSTEMCTL" disable --now "$UNIT_NAME.timer" >/dev/null 2>&1 || true
    "$SYSTEMCTL" disable "$UNIT_NAME.service" >/dev/null 2>&1 || true
    rm -f "$UNIT_DIR/$UNIT_NAME.timer" "$UNIT_DIR/$UNIT_NAME.service"
    "$SYSTEMCTL" daemon-reload >/dev/null 2>&1 || true
  fi
  if [ "$had" = "1" ]; then
    if reload_sshd; then
      log "janela de recuperação FECHADA: o SSH voltou a aceitar só chave."
    else
      warn "ATENÇÃO: removi a janela, mas NÃO consegui recarregar o sshd — ele pode continuar aceitando senha. Rode: sudo systemctl restart ssh"
      return 1
    fi
  else
    log "nenhuma janela de recuperação aberta — nada a fechar."
  fi
}

# Agenda o fechamento ANTES de abrir. systemd: timer + serviço habilitados (o
# serviço roda no boot, antes do sshd, e fecha mesmo se a máquina reiniciar).
# Esta função é chamada dentro de um `if`, onde o `set -e` NÃO vale: por isso cada
# passo devolve erro explicitamente (return 1) e, no fim, confere que o timer (ou o
# job do `at`) ficou de pé. Qualquer dúvida = falha = a janela não abre.
schedule_close() {
  if command -v "$SYSTEMCTL" >/dev/null 2>&1 && [ -d "$SYSTEMD_RUN_DIR" ]; then
    mkdir -p "$UNIT_DIR" || return 1
    cat > "$UNIT_DIR/$UNIT_NAME.service" <<EOF || return 1
[Unit]
Description=Fecha a janela de recuperação de acesso SSH do TWS Panel
Before=ssh.service sshd.service

[Service]
Type=oneshot
ExecStart=/bin/bash "$SELF" fechar --silencioso

[Install]
WantedBy=multi-user.target
EOF
    cat > "$UNIT_DIR/$UNIT_NAME.timer" <<EOF || return 1
[Unit]
Description=Prazo da janela de recuperação de acesso SSH do TWS Panel

[Timer]
OnActiveSec=${WINDOW_MIN}min
OnBootSec=1min
Unit=$UNIT_NAME.service

[Install]
WantedBy=timers.target
EOF
    "$SYSTEMCTL" daemon-reload || return 1
    "$SYSTEMCTL" enable "$UNIT_NAME.service" >/dev/null 2>&1 || return 1
    "$SYSTEMCTL" enable --now "$UNIT_NAME.timer" >/dev/null 2>&1 || return 1
    "$SYSTEMCTL" is-active --quiet "$UNIT_NAME.timer" || return 1
    "$SYSTEMCTL" is-enabled --quiet "$UNIT_NAME.service" || return 1
    return 0
  fi
  if command -v "$AT" >/dev/null 2>&1 && command -v "$ATQ" >/dev/null 2>&1; then
    warn "sem systemd: o fechamento usa o 'at' (não fecha antes do sshd se a máquina reiniciar)."
    printf '/bin/bash "%s" fechar --silencioso\n' "$SELF" | "$AT" now + "$WINDOW_MIN" minutes >/dev/null 2>&1 || return 1
    [ -n "$("$ATQ" 2>/dev/null)" ] || return 1
    return 0
  fi
  return 1
}

# O usuário tem senha utilizável? (conta travada/sem senha: a janela abriria e não adiantaria)
ensure_usable_password() {
  local st
  command -v "$PASSWD_BIN" >/dev/null 2>&1 || return 0
  st="$("$PASSWD_BIN" -S "$ADMIN_USER" 2>/dev/null | awk '{print $2}' || true)"
  case "$st" in
    L|NP)
      warn "o usuário '$ADMIN_USER' está SEM senha utilizável (estado $st): abrir a janela não adiantaria."
      if [ "$(ask "Definir a senha de '$ADMIN_USER' agora? [s/N]: ")" = "s" ]; then
        "$PASSWD_BIN" "$ADMIN_USER" || die "a senha não foi definida; nada foi aberto."
      else
        die "sem senha utilizável para '$ADMIN_USER'; nada foi aberto. Defina com: sudo passwd $ADMIN_USER"
      fi ;;
  esac
}

cmd_window() {
  need_root
  resolve_admin_user
  local ip="$WANT_IP"
  if [ -z "$ip" ] && [ "$ANY_IP" = "0" ]; then
    say ""
    say "Se quiser, libere a senha SÓ para o IP do seu computador (mais seguro)."
    say "Para descobrir o IP: no computador, pesquise 'qual é o meu IP' no navegador."
    ip="$(ask 'IP do seu computador (ENTER = qualquer IP): ')"
  fi
  ip="${ip//[[:space:]]/}"
  if [ -n "$ip" ] && ! valid_ip "$ip"; then
    die "IP inválido: '$ip'. Exemplo: 203.0.113.10. Nada foi alterado."
  fi

  ensure_usable_password
  mkdir -p "$CONF_DIR" "$STATE_DIR"
  # Já havia janela aberta: fecha e recomeça, para o prazo e o aviso valerem de verdade.
  if [ -e "$CONF_FILE" ]; then
    warn "já havia uma janela aberta; ela será renovada por mais $WINDOW_MIN minutos."
    close_window >/dev/null 2>&1 || true
  fi
  # Fechamento agendado primeiro: se não der para agendar (ou não ficar de pé), não abre.
  if ! schedule_close; then
    close_window >/dev/null 2>&1 || true
    die "não consegui agendar o fechamento automático (systemd/at com problema) — por segurança, NADA foi aberto."
  fi

  local match="Match User $ADMIN_USER"
  [ -z "$ip" ] || match="$match Address $ip"
  {
    printf '# Janela de recuperação do TWS Panel (scripts/recuperar-acesso.sh).\n'
    printf '# Fecha sozinha em %s minutos e no próximo reinício. Pode apagar este arquivo.\n' "$WINDOW_MIN"
    printf '# O nome começa com 00 de propósito: o sshd usa a PRIMEIRA ocorrência de cada opção.\n'
    printf '%s\n' "$match"
    printf '    PasswordAuthentication yes\n'
  } > "$CONF_FILE"
  chmod 644 "$CONF_FILE"
  printf '%s\n' "$(( $(date +%s) + WINDOW_MIN * 60 ))" > "$EXPIRY_FILE"

  if ! "$SSHD" -t >/dev/null 2>&1; then
    close_window >/dev/null 2>&1 || true
    die "o sshd recusou a configuração; a janela NÃO foi aberta e tudo foi desfeito."
  fi
  if ! reload_sshd; then
    close_window >/dev/null 2>&1 || true
    die "não consegui recarregar o sshd; a janela NÃO foi aberta e tudo foi desfeito."
  fi
  # Confere o resultado real (o 40-paas-hardening não pode vencer).
  if ! "$SSHD" -T -C "user=$ADMIN_USER,host=localhost,addr=${ip:-127.0.0.1}" 2>/dev/null | grep -qi '^passwordauthentication yes'; then
    close_window >/dev/null 2>&1 || true
    die "o sshd continua recusando senha para '$ADMIN_USER' (outro arquivo vence). Tudo foi desfeito."
  fi

  # Aviso (sem mexer no firewall) se o UFW está ativo e o SSH não está liberado.
  local ufw_out port
  if command -v "$UFW" >/dev/null 2>&1; then
    ufw_out="$("$UFW" status 2>/dev/null || true)"
    port="$("$SSHD" -T 2>/dev/null | sed -n 's/^port //p' | head -n 1 || true)"
    port="${port:-22}"
    if grep -q 'Status: active' <<<"$ufw_out" && ! grep -Eq "(^|[^0-9])${port}(/tcp)?[[:space:]]+ALLOW|OpenSSH" <<<"$ufw_out"; then
      warn "o firewall (ufw) está ativo e a porta $port não parece liberada. Este script não mexe no firewall."
    fi
  fi

  say ""
  log "SSH por senha ABERTO para '$ADMIN_USER'${ip:+ (somente a partir de $ip)} por $WINDOW_MIN minutos."
  say "Agora, do SEU COMPUTADOR (não aqui), mande a chave pública nova:"
  say ""
  say "  Linux/macOS:  ssh-copy-id -i ~/.ssh/id_ed25519.pub $ADMIN_USER@SEU_SERVIDOR"
  say "  Windows (PowerShell):"
  say "    type \$env:USERPROFILE\\.ssh\\id_ed25519.pub | ssh $ADMIN_USER@SEU_SERVIDOR \"cat >> ~/.ssh/authorized_keys\""
  say ""
  say "Sem chave ainda? No computador: ssh-keygen -t ed25519"
  say "A janela fecha SOZINHA em $WINDOW_MIN minutos (e se a máquina reiniciar). Fechar agora: sudo $SELF fechar"
}

# ------------------------------------------------------------------ fail2ban

cmd_unban() {
  need_root
  command -v "$FAIL2BAN_CLIENT" >/dev/null 2>&1 || die "fail2ban-client não encontrado: o fail2ban não está instalado."
  local ip="${WANT_IP:-${1:-}}"
  if [ -z "$ip" ] && [ "$ANY_IP" = "0" ]; then
    ip="$(ask 'IP a desbloquear (ENTER = todos os bloqueados): ')"
  fi
  ip="${ip//[[:space:]]/}"
  if [ -n "$ip" ] && ! valid_ip "$ip"; then
    die "IP inválido: '$ip'. Nada foi alterado."
  fi
  local jail banned one count=0
  for jail in sshd recidive; do
    banned="$("$FAIL2BAN_CLIENT" status "$jail" 2>/dev/null | sed -n 's/.*Banned IP list:[[:space:]]*//p' || true)"
    if [ -n "$ip" ]; then
      "$FAIL2BAN_CLIENT" set "$jail" unbanip "$ip" >/dev/null 2>&1 && count=$((count + 1)) || true
      continue
    fi
    for one in $banned; do
      valid_ip "$one" || continue
      "$FAIL2BAN_CLIENT" set "$jail" unbanip "$one" >/dev/null 2>&1 && count=$((count + 1)) || true
    done
  done
  if [ -n "$ip" ]; then
    log "pedido de desbloqueio de $ip enviado aos jails sshd e recidive ($count aceito(s))."
  else
    log "desbloqueio feito: $count bloqueio(s) removido(s) dos jails sshd e recidive."
  fi
}

# -------------------------------------------------- outros scripts do painel

run_sibling() {
  local name="$1"
  shift
  [ -x "$PAAS_SCRIPTS_DIR/$name" ] || [ -f "$PAAS_SCRIPTS_DIR/$name" ] || die "$name não encontrado em $PAAS_SCRIPTS_DIR."
  bash "$PAAS_SCRIPTS_DIR/$name" "$@"
}

# Desliga só o código por e-mail (o 2FA continua). Mesmo cuidado do reset-2fa.sh:
# painel parado enquanto o users.json é regravado.
cmd_email() {
  need_root
  command -v "$DOCKER" >/dev/null 2>&1 || die "docker não encontrado — rode na VPS do painel."
  "$DOCKER" image inspect "$IMAGE" >/dev/null 2>&1 || die "imagem $IMAGE não encontrada — o painel está instalado nesta VPS?"
  printf '\n%s\n%s\n\n' \
    "Isto desliga SÓ o código por e-mail das ações sensíveis. A verificação em duas etapas continua ligada." \
    "O painel fica fora do ar por alguns segundos."
  local confirm
  confirm="$(ask 'Para confirmar, digite "desligar" e pressione ENTER: ')"
  if [ "$confirm" != "desligar" ]; then
    log "cancelado — nada foi alterado."
    return 0
  fi
  local running=0 status=0
  if "$DOCKER" ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    running=1
    log "parando o painel…"
    "$DOCKER" stop "$CONTAINER" >/dev/null
  fi
  "$DOCKER" run --rm --entrypoint node -v "$VOLUME_NAME:/data" "$IMAGE" /app/scripts/reset-2fa.mjs /data/users.json --so-codigo-email || status=$?
  if [ "$running" = "1" ]; then
    log "iniciando o painel…"
    "$DOCKER" start "$CONTAINER" >/dev/null
  fi
  [ "$status" = "0" ] || die "não foi possível alterar o users.json (código $status). O painel voltou como estava."
  log "pronto. O código por e-mail está desligado."
}

cmd_2fa() {
  local escolha
  escolha="$(ask $'Desligar (1) a verificação em duas etapas inteira, (2) só o código por e-mail, (3) só o bloqueio por códigos errados (o 2FA continua) ou ENTER para sair? [1/2/3]: ')"
  case "$escolha" in
    1) run_sibling reset-2fa.sh ;;
    2) cmd_email ;;
    3) run_sibling reset-2fa.sh --so-bloqueio ;;
    *) log "opção inválida ('$escolha') — nada foi alterado." ;;
  esac
}

# -------------------------------------------------------------------- menu

menu() {
  cat >&2 <<'EOF'

TWS Panel — recuperar acesso (console do provedor)

  1) Abrir SSH por senha por 15 minutos (só o usuário de administração)
  2) Desbloquear o fail2ban (IP bloqueado por tentativas erradas)
  3) Reativar o acesso ao painel pelo IP
  4) Desligar a verificação em duas etapas (ou só o código por e-mail)
  5) Redefinir só a senha do painel
  0) Sair

EOF
  local c
  c="$(ask 'Escolha: ')"
  case "$c" in
    1) cmd_window ;;
    2) cmd_unban ;;
    3) run_sibling reativar-acesso-ip.sh ;;
    4) cmd_2fa ;;
    5) run_sibling reset-senha.sh ;;
    0|"") log "nada foi alterado." ;;
    *) die "opção inválida: $c" ;;
  esac
}

# ----------------------------------------------------------------- principal

CMD=""
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) sed -n '2,29p' "$0"; exit 0 ;;
    --usuario) [ -n "${2:-}" ] || die "--usuario precisa de um nome."; ADMIN_USER="$2"; shift 2 ;;
    --ip) [ -n "${2:-}" ] || die "--ip precisa de um endereço."; WANT_IP="$2"; shift 2 ;;
    --qualquer-ip) ANY_IP=1; shift ;;
    --silencioso) QUIET=1; shift ;;
    janela|desbanir|ip|2fa|email|senha|fechar|menu)
      [ -z "$CMD" ] || die "subcomando repetido: $1"
      CMD="$1"; shift ;;
    *)
      if [ "$CMD" = "desbanir" ] && [ -z "$WANT_IP" ]; then WANT_IP="$1"; shift
      else die "argumento desconhecido: $1 (use --help)"; fi ;;
  esac
done

case "$CMD" in
  ""|menu) menu ;;
  janela) cmd_window ;;
  desbanir) cmd_unban ;;
  ip) run_sibling reativar-acesso-ip.sh ;;
  2fa) cmd_2fa ;;
  email) cmd_email ;;
  senha) run_sibling reset-senha.sh ;;
  fechar) need_root; close_window ;;
esac
