#!/usr/bin/env bash
# =============================================================================
# TWS Panel — recuperar-acesso.sh
#
# Para quem perdeu o acesso ao painel e só tem o CONSOLE do provedor (VNC,
# teclado ruim): entre com o usuário e a senha Linux e rode
#
#   sudo /opt/tws-panel/scripts/recuperar-acesso.sh
#
# Menu:
#   1  Desbloquear o fail2ban (um IP ou todos; jails sshd e recidive).
#   2  Reativar o acesso ao painel pelo IP (reativar-acesso-ip.sh).
#   3  Desligar a verificação em duas etapas (reset-2fa.sh) — ou só o código
#      por e-mail, mantendo o 2FA — ou só o bloqueio por códigos errados.
#   4  Redefinir só a senha do painel (reset-senha.sh), sem apagar a conta.
#   5  Instalar no usuário de administração as chaves públicas de uma conta do
#      GitHub (https://github.com/NOME.keys), mostrando as impressões digitais
#      e pedindo confirmação antes de gravar.
#   0  Sair.
#
# Também aceita subcomandos (sem menu): desbanir, ip, 2fa, email, senha, github.
# Opções: --usuario NOME, --ip IP, --qualquer-ip, --github NOME, --silencioso.
#
# O SSH NUNCA passa a aceitar senha por aqui (nem por um tempo): a senha do
# Linux serve só para o console do provedor e para o sudo. Quem roda isto já
# provou quem é: tem o console do provedor e sudo. O painel NUNCA roda isto
# sozinho.
#
# Variáveis (para testes): ENV_FILE, FAIL2BAN_CLIENT, CURL,
# SSH_KEYGEN, RUNUSER, GETENT, GITHUB_URL, DOCKER, PAAS_SCRIPTS_DIR, PAAS_ASSUME_ROOT.
# =============================================================================
set -euo pipefail

FAIL2BAN_CLIENT="${FAIL2BAN_CLIENT:-fail2ban-client}"
CURL="${CURL:-curl}"
SSH_KEYGEN="${SSH_KEYGEN:-ssh-keygen}"
RUNUSER="${RUNUSER:-runuser}"
GETENT="${GETENT:-getent}"
GITHUB_URL="${GITHUB_URL:-https://github.com}"
DOCKER="${DOCKER:-docker}"
SELF="$(readlink -f "$0")"
SELF_DIR="$(dirname "$SELF")"
PAAS_SCRIPTS_DIR="${PAAS_SCRIPTS_DIR:-$SELF_DIR}"
ENV_FILE="${ENV_FILE:-$SELF_DIR/../.env}"

VOLUME_NAME="${PAAS_VOLUME:-paas_data}"
IMAGE="${PAAS_IMAGE:-tws-panel:latest}"
CONTAINER="tws-panel"

QUIET=0
ADMIN_USER=""
WANT_IP=""
WANT_GH=""
GH_WORK=""
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

# ------------------------------------------------------- chave do GitHub

# Nome de usuário do GitHub: letras, números e hífens soltos, 1 a 39 caracteres, sem hífen nas pontas.
valid_github_user() {
  [[ "$1" =~ ^[A-Za-z0-9](-?[A-Za-z0-9]){0,38}$ ]]
}

# Roda COMO o usuário de administração (nunca como root): um link simbólico plantado em ~/.ssh ou em
# authorized_keys só dá ao usuário o que ele já tem. Recusa (saída 7) link simbólico, arquivo que não é
# comum, pasta de outro dono ou gravável por grupo/outros. Escrita atômica (temporário + mv), com flock de
# no máximo 10 s (saída 9) e só os 5 backups mais novos. Não tem aspas simples (vai entre elas).
ADD_KEYS_SCRIPT='set -e; umask 077; f=$1; src=$2; d=$(dirname "$f")
if [ ! -e "$d" ] && [ ! -L "$d" ]; then mkdir -m 700 "$d" || exit 4; fi
{ [ -d "$d" ] && [ ! -L "$d" ] && [ -O "$d" ] && [ -z "$(find "$d" -maxdepth 0 -perm /022)" ]; } || exit 7
if [ -e "$f" ] || [ -L "$f" ]; then { [ -f "$f" ] && [ ! -L "$f" ] && [ -O "$f" ]; } || exit 7; fi
exec 9>>"$d/.paas-lock"; flock -w 10 -x 9 || exit 9
[ -e "$f" ] || : > "$f"
t=$(mktemp "$d/.ak.XXXXXX") || exit 4
cat "$f" > "$t"; { [ ! -s "$t" ] || [ -z "$(tail -c1 "$t")" ] || echo >> "$t"; }
n=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  b=$(printf "%s" "$line" | cut -d" " -f2)
  if grep -qF -- "$b" "$t"; then continue; fi
  printf "%s\n" "$line" >> "$t"; n=$((n + 1))
done < "$src"
if [ "$n" -eq 0 ]; then rm -f "$t"; echo ::nenhuma-nova; exit 0; fi
cp -p "$f" "$f.paas-bak-$(date +%Y%m%d%H%M%S)" || { rm -f "$t"; exit 4; }
chmod 600 "$t"; mv -f "$t" "$f"
ls -1t "$f".paas-bak-* 2>/dev/null | tail -n +6 | while IFS= read -r o; do rm -f "$o"; done
echo "::adicionadas:$n"'

cmd_github() {
  need_root
  resolve_admin_user
  command -v "$CURL" >/dev/null 2>&1 || die "curl não encontrado — instale com: sudo apt install curl"
  command -v "$SSH_KEYGEN" >/dev/null 2>&1 || die "ssh-keygen não encontrado — instale o cliente OpenSSH."
  command -v "$RUNUSER" >/dev/null 2>&1 || die "runuser não encontrado (pacote util-linux)."
  local gh="$WANT_GH"
  [ -n "$gh" ] || gh="$(ask 'Usuário do GitHub (dono das chaves): ')"
  gh="${gh#"${gh%%[![:space:]]*}"}"
  gh="${gh%"${gh##*[![:space:]]}"}"
  valid_github_user "$gh" || die "nome de usuário do GitHub inválido: '$gh'. Nada foi alterado."

  local body
  # `head -c` garante o teto de 200 KB mesmo sem Content-Length (o --max-filesize de curl antigo não corta o download);
  # resposta maior que isso derruba o curl por SIGPIPE e conta como falha de download.
  body="$({ "$CURL" -fsS --proto '=https' --max-time 15 "$GITHUB_URL/$gh.keys" 2>/dev/null; } | head -c 200000)" \
    || die "não consegui baixar $GITHUB_URL/$gh.keys (o usuário existe? a VPS tem internet?). Nada foi alterado."

  local keys_file line type blob info fp bits n=0 skipped=0 weak=0 hw=0 dup=0
  GH_WORK="$(umask 077; mktemp -d)"
  trap '[ -z "$GH_WORK" ] || rm -rf "$GH_WORK"' EXIT
  keys_file="$GH_WORK/keys"
  ( umask 077; : > "$keys_file" )
  # As impressões digitais saem SEMPRE (mesmo com --silencioso): a confirmação só vale vendo o que será gravado.
  printf '\n'
  printf '%s\n' "Chaves públicas da conta '$gh' no GitHub:"
  while IFS= read -r line; do
    line="${line%$'\r'}"
    [ -n "${line//[[:space:]]/}" ] || continue
    read -r type blob _ <<<"$line"
    if [[ "$type" =~ ^sk- ]]; then
      hw=$((hw + 1))
      continue
    fi
    if [[ ! "$type" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521))$ ]] || [[ ! "${blob:-}" =~ ^[A-Za-z0-9+/]{40,800}={0,2}$ ]]; then
      skipped=$((skipped + 1))
      continue
    fi
    if grep -qF -- " $blob " "$keys_file"; then
      dup=$((dup + 1))
      continue
    fi
    info="$(printf '%s %s\n' "$type" "$blob" | "$SSH_KEYGEN" -lf - 2>/dev/null || true)"
    bits="$(awk '{print $1}' <<<"$info")"
    fp="$(awk '{print $2}' <<<"$info")"
    [ -n "$fp" ] || { skipped=$((skipped + 1)); continue; }
    # o painel recusa RSA abaixo de 3072 bits (SSH_RSA_MIN_BITS); aqui vale a mesma regra
    if [ "$type" = "ssh-rsa" ] && { [[ ! "$bits" =~ ^[0-9]+$ ]] || [ "$bits" -lt 3072 ]; }; then
      weak=$((weak + 1))
      warn "chave RSA fraca ignorada: ${bits:-?} bits ($fp). Só se aceita RSA de 3072 bits ou mais (ou ed25519/ecdsa)."
      continue
    fi
    n=$((n + 1))
    [ "$n" -le 20 ] || die "a conta tem mais de 20 chaves; confira em https://github.com/settings/keys. Nada foi alterado."
    printf '%s %s github-%s\n' "$type" "$blob" "$gh" >> "$keys_file"
    printf '%s\n' "  $n) $type  ${bits:-?} bits  $fp"
  done <<<"$body"
  [ "$skipped" = "0" ] || warn "$skipped linha(s) ignorada(s) (tipo de chave desconhecido ou formato inválido)."
  [ "$hw" = "0" ] || warn "$hw chave(s) de segurança física (sk-ssh-ed25519 / sk-ecdsa) ignorada(s): o painel e este script não instalam esse tipo. Use uma chave ed25519 comum."
  [ "$dup" = "0" ] || warn "$dup chave(s) repetida(s) na resposta foram contadas uma vez só."
  [ "$n" -gt 0 ] || die "a conta '$gh' não tem chave pública aceitável no GitHub (nenhuma chave válida, ou só RSA fraca/chave física). Nada foi alterado."
  # o usuário de administração precisa LER o arquivo (runuser): grupo dele com 750/640; sem root (testes), 755/644
  if chgrp "$(id -g "$ADMIN_USER")" "$GH_WORK" "$keys_file" 2>/dev/null; then
    chmod 750 "$GH_WORK"
    chmod 640 "$keys_file"
  else
    chmod 755 "$GH_WORK"
    chmod 644 "$keys_file"
  fi

  printf '\n'
  printf '%s\n' "Compare as impressões digitais acima com as que aparecem em https://github.com/settings/keys (logado na sua conta)."
  local answer
  answer="$(ask "Gravar estas $n chave(s) no authorized_keys de '$ADMIN_USER'? [s/N]: ")"
  if [ "$answer" != "s" ]; then
    log "cancelado — nada foi alterado."
    return 0
  fi

  local home out status=0
  home="$("$GETENT" passwd "$ADMIN_USER" | cut -d: -f6)"
  { [ -n "$home" ] && [ -d "$home" ]; } || die "não encontrei a pasta pessoal de '$ADMIN_USER'."
  out="$("$RUNUSER" -u "$ADMIN_USER" -- env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin sh -c "$ADD_KEYS_SCRIPT" sh "$home/.ssh/authorized_keys" "$keys_file")" || status=$?
  case "$status" in
    0) ;;
    7) die "a pasta ~/.ssh ou o authorized_keys de '$ADMIN_USER' não está como deveria (link simbólico, outro dono ou gravável por outros). Por segurança nada foi gravado. Se o arquivo pertence ao root, corrija com: sudo chown -R $ADMIN_USER: $home/.ssh && sudo chmod 700 $home/.ssh && sudo chmod 600 $home/.ssh/authorized_keys" ;;
    9) die "outra operação de chaves está em andamento. Espere alguns segundos e rode de novo." ;;
    *) die "não consegui gravar as chaves (código $status). Nada foi alterado no authorized_keys." ;;
  esac
  case "$out" in
    *::nenhuma-nova*) log "essas chaves já estavam no authorized_keys de '$ADMIN_USER' — nada a fazer." ;;
    *::adicionadas:*) log "pronto: ${out##*::adicionadas:} chave(s) nova(s) em $home/.ssh/authorized_keys (backup datado ao lado). Entre com: ssh $ADMIN_USER@SEU_SERVIDOR" ;;
    *) die "resposta inesperada ao gravar as chaves; confira $home/.ssh/authorized_keys." ;;
  esac
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

  1) Desbloquear o fail2ban (IP bloqueado por tentativas erradas)
  2) Reativar o acesso ao painel pelo IP
  3) Desligar a verificação em duas etapas (ou só o código por e-mail)
  4) Redefinir só a senha do painel
  5) Instalar a chave pública de uma conta do GitHub no usuário de administração
  0) Sair

O SSH continua só por chave: este menu não abre SSH por senha.

EOF
  local c
  c="$(ask 'Escolha: ')"
  case "$c" in
    1) cmd_unban ;;
    2) run_sibling reativar-acesso-ip.sh ;;
    3) cmd_2fa ;;
    4) run_sibling reset-senha.sh ;;
    5) cmd_github ;;
    0|"") log "nada foi alterado." ;;
    *) die "opção inválida: $c" ;;
  esac
}

# ----------------------------------------------------------------- principal

CMD=""
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) sed -n '2,31p' "$0"; exit 0 ;;
    --usuario) [ -n "${2:-}" ] || die "--usuario precisa de um nome."; ADMIN_USER="$2"; shift 2 ;;
    --ip) [ -n "${2:-}" ] || die "--ip precisa de um endereço."; WANT_IP="$2"; shift 2 ;;
    --qualquer-ip) ANY_IP=1; shift ;;
    --github) [ -n "${2:-}" ] || die "--github precisa de um nome."; WANT_GH="$2"; shift 2 ;;
    --silencioso) QUIET=1; shift ;;
    desbanir|ip|2fa|email|senha|github|menu)
      [ -z "$CMD" ] || die "subcomando repetido: $1"
      CMD="$1"; shift ;;
    *)
      if [ "$CMD" = "desbanir" ] && [ -z "$WANT_IP" ]; then WANT_IP="$1"; shift
      else die "argumento desconhecido: $1 (use --help)"; fi ;;
  esac
done

case "$CMD" in
  ""|menu) menu ;;
  desbanir) cmd_unban ;;
  ip) run_sibling reativar-acesso-ip.sh ;;
  2fa) cmd_2fa ;;
  email) cmd_email ;;
  senha) run_sibling reset-senha.sh ;;
  github) cmd_github ;;
esac
