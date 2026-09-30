#!/usr/bin/env bash
# 02-ssh.sh — Fase 02: hardening do OpenSSH.
# Spec: docs/security-research.md §1.1 e §2.3 (drop-in sshd_config.d, crypto moderna,
# validação `sshd -t`, teste de nova sessão ANTES de fechar a atual).
#
# SEGURANÇA DO OPERADOR: antes de aplicar, agenda um rollback automático
# (`at now +5 minutes`, ou timer em background) que restaura a configuração
# anterior. O operador cancela com `--confirm` após comprovar que ainda consegue
# abrir uma NOVA sessão SSH.
#
# Uso: ./02-ssh.sh [--user deploy] [--port 2222] [--no-tunnel] [--dry-run] [--rollback] [--confirm]
#      ./02-ssh.sh --reopen-tunnel   (o instalador chama no modo --acesso=tunel)
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$(readlink -f "$0")")/lib.sh"

MODE="apply"
SSH_USER=""
SSH_PORT=""
# "local" libera o túnel SSH (ssh -L) do modo --acesso=tunel; com o painel em
# HTTPS o túnel não é usado e --no-tunnel fecha também o encaminhamento local.
TCP_FORWARDING="local"
# 40-: no sshd vale o PRIMEIRO valor encontrado, em ordem alfabética. Imagens
# de nuvem (Contabo e outras) trazem 50-cloud-init.conf com
# "PasswordAuthentication yes": com o nome antigo (99-) o painel perdia e o
# login por senha seguia ligado (visto em campo). 40 vence o 50 e continua
# perdendo para o 10-local-override.conf que o README ensina ao operador.
DROPIN="/etc/ssh/sshd_config.d/40-paas-hardening.conf"
OLD_DROPIN="/etc/ssh/sshd_config.d/99-paas-hardening.conf"
REVERT_SCRIPT="${PAAS_STATE_DIR}/revert-ssh.sh"

while [ $# -gt 0 ]; do
  case "$1" in
    --user)     SSH_USER="${2:?--user exige um nome}"; shift ;;
    --port)     SSH_PORT="${2:?--port exige um número}"; shift ;;
    --no-tunnel) TCP_FORWARDING="no" ;;
    --dry-run)  PAAS_DRY_RUN=1 ;;
    --rollback) MODE="rollback" ;;
    --confirm)  MODE="confirm" ;;
    --reopen-tunnel) MODE="reopen-tunnel" ;;
    -h|--help)
      echo "Uso: $0 [--user NOME] [--port PORTA] [--no-tunnel] [--dry-run] [--rollback] [--confirm] | --reopen-tunnel"
      paas_usage_common; exit 0 ;;
    *) die "opção desconhecida: $1" ;;
  esac
  shift
done

if [ -n "$SSH_PORT" ]; then
  case "$SSH_PORT" in
    ''|*[!0-9]*) die "porta inválida: $SSH_PORT" ;;
  esac
  [ "$SSH_PORT" -ge 1024 ] && [ "$SSH_PORT" -le 65535 ] || die "porta fora do intervalo 1024-65535: $SSH_PORT"
fi

# --- Modo confirm: cancela o rollback agendado -------------------------------
if [ "$MODE" = "confirm" ]; then
  step "Confirmando acesso SSH do operador"
  confirm_rollback "ssh"
  run rm -f "$REVERT_SCRIPT"
  ok "Acesso confirmado — configuração de SSH mantida definitivamente"
  exit 0
fi

# --- Modo reopen-tunnel: libera de novo o túnel SSH (ssh -L) -----------------
# Quem troca de HTTPS para túnel (instalador com --acesso=tunel) depois de a
# fase ter gravado "AllowTcpForwarding no" ficaria sem como abrir o painel.
# Só troca essa linha do nosso drop-in; sem a fase aplicada, não faz nada.
if [ "$MODE" = "reopen-tunnel" ]; then
  step "Liberando o túnel SSH do painel (AllowTcpForwarding local)"
  if [ ! -f "$DROPIN" ] || ! grep -qE '^AllowTcpForwarding no$' "$DROPIN"; then
    ok "Nada a mudar — o túnel SSH já é aceito"
    exit 0
  fi
  # Sem backup_file de propósito: o desfazer da fase restaura a cópia MAIS
  # RECENTE, e uma cópia feita aqui o faria devolver a versão endurecida em vez
  # de desfazer a fase. A troca é de uma linha e é revertida se não validar.
  run sed -i 's/^AllowTcpForwarding no$/AllowTcpForwarding local/' "$DROPIN"
  if [ "$PAAS_DRY_RUN" != "1" ] && ! sshd -t; then
    sed -i 's/^AllowTcpForwarding local$/AllowTcpForwarding no/' "$DROPIN"
    die "a configuração do SSH não validou (sshd -t) — linha anterior restaurada"
  fi
  svc_reload_or_restart ssh || svc_reload_or_restart sshd || true
  ok "Túnel SSH liberado"
  exit 0
fi

# --- Modo rollback imediato --------------------------------------------------
if [ "$MODE" = "rollback" ]; then
  step "Restaurando configuração anterior do SSH"
  restore_latest_backup "$DROPIN"
  restore_latest_backup "$OLD_DROPIN"
  restore_backup_or_keep "/etc/ssh/sshd_config"
  if has_systemd && [ -n "$(systemctl cat ssh.socket 2>/dev/null || true)" ]; then
    # remove override de socket activation, se existir
    run rm -rf /etc/systemd/system/ssh.socket.d
    run systemctl daemon-reload || true
  fi
  svc_reload_or_restart ssh || svc_reload_or_restart sshd || true
  run rm -f "$REVERT_SCRIPT"
  # Só depois de desfazer com sucesso (set -e): se algo acima falhou, a
  # reversão agendada continua na fila como rede de segurança.
  if cancel_scheduled_rollback "ssh"; then
    info "reversão agendada cancelada — a configuração já foi desfeita agora"
  fi
  ok "Rollback da fase 02 concluído"
  exit 0
fi

# --- Aplicação ---------------------------------------------------------------

step "Garantindo OpenSSH server instalado"
apt_install openssh-server
ok "OpenSSH server presente"

step "Verificando pré-requisitos anti-lockout"
if [ -n "$SSH_USER" ]; then
  if ! id -u "$SSH_USER" >/dev/null 2>&1; then
    die "usuário --user $SSH_USER não existe. Rode 01-user.sh primeiro."
  fi
  USER_KEY="$(getent passwd "$SSH_USER" | cut -d: -f6)/.ssh/authorized_keys"
  if [ "$PAAS_DRY_RUN" != "1" ] && { [ ! -s "$USER_KEY" ] || ! grep -qE '^(ssh-|ecdsa-)' "$USER_KEY"; }; then
    die "$SSH_USER não tem chave SSH ($USER_KEY vazio). Recusando desabilitar senha/root (anti-lockout)."
  fi
  info "usuário $SSH_USER com chave SSH — seguro restringir acesso"
else
  warn "sem --user: PermitRootLogin=prohibit-password (em vez de no) e sem AllowUsers"
fi
ok "Pré-requisitos verificados"

step "Agendando rollback automático de segurança (5 min)"
# Script de reversão executado pelo timer caso o operador NÃO confirme acesso.
if [ "$PAAS_DRY_RUN" = "1" ]; then
  echo "[dry-run] gravaria $REVERT_SCRIPT e agendaria via at"
else
  mkdir -p "$PAAS_STATE_DIR"
  cat > "$REVERT_SCRIPT" <<EOF
#!/usr/bin/env bash
# Reversão automática do hardening SSH (agendada por 02-ssh.sh).
set -uo pipefail
source "$(dirname "$(readlink -f "$0")")/lib.sh"
echo "[paas-rollback] operador não confirmou acesso em ${PAAS_ROLLBACK_DELAY}s — revertendo SSH"
PAAS_DRY_RUN=0
restore_latest_backup "$DROPIN"
restore_latest_backup "$OLD_DROPIN"
rm -rf /etc/systemd/system/ssh.socket.d
if [ -d /run/systemd/system ]; then
  systemctl daemon-reload || true
  systemctl reload ssh 2>/dev/null || systemctl restart ssh 2>/dev/null || true
else
  service ssh reload 2>/dev/null || service ssh restart 2>/dev/null || true
fi
rm -f "${PAAS_STATE_DIR}/pending-rollback-ssh.pid" "${PAAS_STATE_DIR}/pending-rollback-ssh.at"
echo "[paas-rollback] SSH revertido"
EOF
  schedule_rollback "ssh" "$REVERT_SCRIPT"
fi
ok "Rollback automático agendado — cancele com '$0 --confirm' após testar nova sessão"

# AllowTcpForwarding: "local" por padrão — no modo túnel o painel é aberto por
# `ssh -L`, que é encaminhamento LOCAL. Com "no", o túnel aberto antes
# continuava funcionando e o próximo — inclusive depois do reboot — era
# recusado: o operador perdia o acesso ao painel (visto em campo). "local"
# libera só o -L; -R (remoto), agent e X11 continuam bloqueados. Com o painel
# em HTTPS (padrão da instalação), o painel passa --no-tunnel e fica "no"
# (recomendação SSH-7408 do Lynis).
# TCPKeepAlive no: quem detecta conexão morta é o ClientAliveInterval, que
# passa pelo canal cifrado (o keepalive TCP pode ser forjado).
if [ -e "$OLD_DROPIN" ]; then
  # instalação anterior do painel: o arquivo antigo sai (com backup — o
  # desfazer o devolve), senão ficariam duas versões da configuração.
  backup_file "$OLD_DROPIN"
  run rm -f "$OLD_DROPIN"
fi
step "Aplicando drop-in de hardening ($DROPIN)"
{
  echo "# Gerenciado pelo painel PaaS (02-ssh.sh). Spec: docs/security-research.md §2.3"
  [ -n "$SSH_PORT" ] && echo "Port $SSH_PORT"
  cat <<'EOF'
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
MaxAuthTries 3
MaxSessions 2
LoginGraceTime 30
ClientAliveInterval 300
ClientAliveCountMax 2
TCPKeepAlive no
X11Forwarding no
AllowAgentForwarding no
PermitTunnel no
PermitUserEnvironment no
HostbasedAuthentication no
IgnoreRhosts yes
LogLevel VERBOSE
KexAlgorithms sntrup761x25519-sha512@openssh.com,curve25519-sha256,curve25519-sha256@libssh.org
Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes128-gcm@openssh.com
MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com
EOF
  echo "AllowTcpForwarding $TCP_FORWARDING"
  if [ -n "$SSH_USER" ]; then
    echo "PermitRootLogin no"
    echo "AllowUsers $SSH_USER"
  else
    echo "PermitRootLogin prohibit-password"
  fi
} | write_file "$DROPIN"
ok "Drop-in de hardening escrito"

step "Porta customizada via socket activation (Ubuntu 22.10+)"
if [ -n "$SSH_PORT" ]; then
  if has_systemd && systemctl list-unit-files ssh.socket >/dev/null 2>&1; then
    if [ "$PAAS_DRY_RUN" = "1" ]; then
      echo "[dry-run] systemctl edit ssh.socket com ListenStream=$SSH_PORT"
    else
      mkdir -p /etc/systemd/system/ssh.socket.d
      cat > /etc/systemd/system/ssh.socket.d/listen.conf <<EOF
[Socket]
ListenStream=
ListenStream=$SSH_PORT
EOF
      systemctl daemon-reload
      info "ssh.socket configurado para a porta $SSH_PORT"
    fi
  else
    info "sem socket activation — diretiva Port do drop-in é suficiente"
  fi
else
  skip "Porta padrão (22) mantida"
fi
ok "Configuração de porta concluída"

step "Validando configuração (sshd -t)"
if [ "$PAAS_DRY_RUN" = "1" ]; then
  echo "[dry-run] sshd -t"
else
  mkdir -p /run/sshd
  if ! sshd -t; then
    die "sshd -t FALHOU — configuração inválida; rollback automático vai reverter"
  fi
fi
ok "Configuração válida"

step "Conferindo o que o SSH adotou de fato (sshd -T)"
# Validar a sintaxe não basta: outro arquivo lido ANTES pode vencer o nosso.
# A fase não pode dizer "concluída" com o login por senha ainda ligado.
if [ "$PAAS_DRY_RUN" = "1" ]; then
  echo "[dry-run] conferiria PasswordAuthentication efetivo = no"
else
  EFFECTIVE_PWAUTH="$(sshd -T 2>/dev/null | awk 'tolower($1)=="passwordauthentication"{print $2}')"
  if [ "$EFFECTIVE_PWAUTH" != "no" ]; then
    CULPRIT="$(grep -liE '^[[:space:]]*PasswordAuthentication[[:space:]]+yes' /etc/ssh/sshd_config.d/*.conf /etc/ssh/sshd_config 2>/dev/null | head -n 1 || true)"
    die "PasswordAuthentication continua \"${EFFECTIVE_PWAUTH:-?}\": o arquivo ${CULPRIT:-(não identificado)} define \"yes\" e é lido antes do painel (no SSH vale o primeiro valor). Ajuste ou remova esse arquivo e rode a fase de novo."
  fi
  info "login por senha desligado de fato (sshd -T: passwordauthentication no)"
fi
ok "Configuração efetiva conferida"

step "Recarregando SSH"
svc_reload_or_restart ssh || svc_reload_or_restart sshd || true
if has_systemd && [ -n "$SSH_PORT" ]; then
  run systemctl restart ssh.socket || warn "restart do ssh.socket falhou"
fi
ok "SSH recarregado com a nova configuração"

echo
warn "ATENÇÃO: teste AGORA uma NOVA sessão SSH em outro terminal (não feche a atual)."
warn "Se funcionar, confirme com: $0 --confirm"
warn "Sem confirmação, a configuração anterior será restaurada automaticamente em ${PAAS_ROLLBACK_DELAY}s."
ok "Fase 02 (SSH) concluída — aguardando confirmação do operador"
