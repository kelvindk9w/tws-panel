#!/usr/bin/env bash
# 01-user.sh — Fase 01: usuário não-root com sudo + chave SSH.
# Spec: docs/security-research.md §2.2 e §4 (ordem usuário→chave→teste→só então travar root).
#
# REGRA DE OURO: este script NUNCA tranca o operador para fora:
#  - `passwd -l root` só acontece se o usuário tiver AO MENOS uma chave SSH
#    instalada (para ENTRAR) E uma senha utilizável (para o SUDO). Usuário sem
#    senha entra por SSH mas não vira root — com a senha do root travada,
#    ninguém mais administraria a VPS. Quem a fase cria nasce sem senha, então
#    criar um usuário aqui nunca trava o root.
#  - a simulação (--dry-run) lê o estado real e diz de antemão se a senha do
#    root SERÁ ou NÃO será travada, e por quê.
#
# Uso: ./01-user.sh [--user deploy] [--pubkey "ssh-ed25519 AAAA..."] [--dry-run] [--rollback] [--confirm]
#
# --confirm: cancela o rollback automático agendado quando o root é travado
# (o operador comprovou que consegue logar com o novo usuário em outra janela).
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$(readlink -f "$0")")/lib.sh"

MODE="apply"
SSH_USER="deploy"
PUBKEY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --user)     SSH_USER="${2:?--user exige um nome}"; shift ;;
    --pubkey)   PUBKEY="${2:?--pubkey exige uma chave}"; shift ;;
    --dry-run)  PAAS_DRY_RUN=1 ;;
    --rollback) MODE="rollback" ;;
    --confirm)  MODE="confirm" ;;
    -h|--help)
      echo "Uso: $0 [--user NOME] [--pubkey CHAVE] [--dry-run] [--rollback] [--confirm]"
      paas_usage_common; exit 0 ;;
    *) die "opção desconhecida: $1" ;;
  esac
  shift
done

[ "$SSH_USER" != "root" ] || die "o usuário não pode ser root"
case "$SSH_USER" in
  *[!a-z0-9_-]*) die "nome de usuário inválido: $SSH_USER" ;;
esac

CREATED_MARKER="${PAAS_STATE_DIR}/created-user"
REVERT_SCRIPT="${PAAS_STATE_DIR}/revert-01-user.sh"

if [ "$MODE" = "confirm" ]; then
  step "Confirmando acesso do operador com o novo usuário"
  confirm_rollback "user"
  run rm -f "$REVERT_SCRIPT"
  ok "Acesso confirmado — senha do root permanece travada definitivamente"
  exit 0
fi

if [ "$MODE" = "rollback" ]; then
  step "Destrancando root"
  if [ "$PAAS_DRY_RUN" = "1" ]; then
    echo "[dry-run] passwd -u root"
  else
    passwd -u root 2>/dev/null || warn "root já estava destrancado ou sem senha definida"
  fi
  step "Removendo usuário criado por este script (se houver)"
  if [ -f "$CREATED_MARKER" ]; then
    marked="$(cat "$CREATED_MARKER")"
    if [ "$marked" = "$SSH_USER" ]; then
      run userdel -r "$SSH_USER" 2>/dev/null || run userdel "$SSH_USER" || warn "falha ao remover $SSH_USER"
      run rm -f "$CREATED_MARKER"
    else
      info "usuário marcado ($marked) difere de --user ($SSH_USER); não removendo"
    fi
  else
    info "nenhum usuário criado por este script; nada a remover"
  fi
  # Só depois de desfazer com sucesso (set -e): se algo acima falhou, a
  # reversão agendada continua na fila como rede de segurança.
  if cancel_scheduled_rollback "user"; then
    info "reversão agendada cancelada — a configuração já foi desfeita agora"
  fi
  ok "Rollback da fase 01 concluído"
  exit 0
fi

step "Criando usuário não-root '$SSH_USER'"
if id -u "$SSH_USER" >/dev/null 2>&1; then
  info "usuário $SSH_USER já existe (idempotente)"
else
  # -c "" (GECOS vazio) + passwd -l: sem senha; acesso somente por chave SSH.
  run useradd --create-home --shell /bin/bash -c "" "$SSH_USER"
  run passwd -l "$SSH_USER"
  if [ "$PAAS_DRY_RUN" != "1" ]; then
    mkdir -p "$PAAS_STATE_DIR"
    echo "$SSH_USER" > "$CREATED_MARKER"
  fi
fi
ok "Usuário '$SSH_USER' presente"

step "Adicionando '$SSH_USER' ao grupo sudo"
run usermod -aG sudo "$SSH_USER"
ok "Usuário '$SSH_USER' no grupo sudo"

step "Instalando chave SSH de '$SSH_USER'"
USER_HOME="$(getent passwd "$SSH_USER" | cut -d: -f6 || echo "/home/$SSH_USER")"
if [ -n "$PUBKEY" ]; then
  case "$PUBKEY" in
    ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-nistp256\ *) ;;
    *) die "formato de chave pública não reconhecido (esperado ssh-ed25519/ssh-rsa/ecdsa)" ;;
  esac
  if [ "$PAAS_DRY_RUN" = "1" ]; then
    echo "[dry-run] instalaria chave em $USER_HOME/.ssh/authorized_keys"
  else
    mkdir -p "$USER_HOME/.ssh"
    touch "$USER_HOME/.ssh/authorized_keys"
    backup_file "$USER_HOME/.ssh/authorized_keys"
    grep -qxF "$PUBKEY" "$USER_HOME/.ssh/authorized_keys" || echo "$PUBKEY" >> "$USER_HOME/.ssh/authorized_keys"
    chmod 700 "$USER_HOME/.ssh"
    chmod 600 "$USER_HOME/.ssh/authorized_keys"
    chown -R "$SSH_USER:$SSH_USER" "$USER_HOME/.ssh"
    info "chave instalada em $USER_HOME/.ssh/authorized_keys"
  fi
else
  info "nenhuma --pubkey informada; mantendo authorized_keys existente"
fi
ok "Chave SSH instalada"

step "Verificando acesso por chave e senha antes de travar root"
KEY_FILE="$USER_HOME/.ssh/authorized_keys"
# Leitura pura: vale também na simulação, que precisa dizer o que VAI acontecer.
KEY_COUNT=0
if [ -f "$KEY_FILE" ]; then
  KEY_COUNT="$(grep -cE '^(ssh-|ecdsa-|sk-)' "$KEY_FILE" 2>/dev/null || true)"
  KEY_COUNT="${KEY_COUNT:-0}"
fi
# Simulação com --pubkey nova: conta a chave que SERIA instalada.
if [ "$PAAS_DRY_RUN" = "1" ] && [ -n "$PUBKEY" ] && ! grep -qxF "$PUBKEY" "$KEY_FILE" 2>/dev/null; then
  KEY_COUNT=$((KEY_COUNT + 1))
fi
# "P" = senha utilizável. Usuário inexistente (simulação) seria criado sem senha.
PW_STATUS="$(passwd -S "$SSH_USER" 2>/dev/null | awk '{print $2}' || true)"
HAS_KEY=0
HAS_PW=0
[ "$KEY_COUNT" -gt 0 ] && HAS_KEY=1
[ "$PW_STATUS" = "P" ] && HAS_PW=1
if [ "$HAS_KEY" = "1" ]; then
  info "$KEY_COUNT chave(s) SSH instalada(s) para $SSH_USER"
else
  info "nenhuma chave SSH instalada para $SSH_USER"
fi
if [ "$HAS_PW" = "1" ]; then
  info "$SSH_USER tem senha (necessária para usar o sudo)"
else
  info "$SSH_USER não tem senha — sem ela não há como usar o sudo"
fi
if [ "$HAS_KEY" = "1" ] && [ "$HAS_PW" = "1" ]; then
  info "resultado: a senha do root SERÁ travada — você entra com a chave e administra com a senha de $SSH_USER"
elif [ "$HAS_KEY" = "0" ]; then
  skip "resultado: a senha do root NÃO será travada — nenhuma chave SSH instalada para $SSH_USER (proteção anti-lockout)"
else
  skip "resultado: a senha do root NÃO será travada — $SSH_USER não tem senha e ficaria sem sudo (proteção anti-lockout; defina com: sudo passwd $SSH_USER)"
fi
ok "Verificação anti-lockout concluída"

step "Travando senha do root (passwd -l root)"
if [ "$HAS_KEY" = "1" ] && [ "$HAS_PW" = "1" ]; then
  run passwd -l root
  ok "Senha do root travada (acesso root direto desabilitado)"
  # Anti-lockout: agenda reversão automática (at/timer) que destranca o root
  # caso o operador NÃO confirme que consegue logar com o novo usuário.
  if [ "$PAAS_DRY_RUN" != "1" ]; then
    mkdir -p "$PAAS_STATE_DIR"
    cat > "$REVERT_SCRIPT" <<'EOF'
#!/usr/bin/env bash
# Reversão automática da fase 01: operador não confirmou acesso a tempo.
echo "[paas-rollback] operador não confirmou acesso — destrancando a senha do root"
passwd -u root 2>/dev/null || true
EOF
    chmod 700 "$REVERT_SCRIPT"
    schedule_rollback "user" "$REVERT_SCRIPT"
  fi
else
  skip "Travamento do root adiado até $SSH_USER ter chave SSH e senha"
fi

step "Verificação"
if [ "$PAAS_DRY_RUN" = "1" ]; then
  echo "[dry-run] verificaria grupo sudo e estado da conta root"
else
  id "$SSH_USER" | grep -q '(sudo)' && info "$SSH_USER está no grupo sudo" || die "$SSH_USER não ficou no grupo sudo"
fi
ok "Fase 01 (usuário não-root) concluída"
