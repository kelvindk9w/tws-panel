#!/usr/bin/env bash
# 01-user.sh — Fase 01: usuário não-root com sudo + chave SSH.
# Spec: docs/security-research.md §2.2 e §4 (ordem usuário→chave→teste→só então travar root).
#
# REGRA DE OURO: este script NUNCA tranca o operador para fora:
#  - `passwd -l root` só acontece se o novo usuário tiver AO MENOS uma chave SSH
#    instalada e testável (~/.ssh/authorized_keys não-vazio).
#
# Uso: ./01-user.sh [--user deploy] [--pubkey "ssh-ed25519 AAAA..."] [--dry-run] [--rollback]
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
    -h|--help)
      echo "Uso: $0 [--user NOME] [--pubkey CHAVE] [--dry-run] [--rollback]"
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

step "Verificando acesso por chave antes de travar root"
KEY_FILE="$USER_HOME/.ssh/authorized_keys"
HAS_KEY=0
if [ "$PAAS_DRY_RUN" != "1" ] && [ -s "$KEY_FILE" ] && grep -qE '^(ssh-|ecdsa-)' "$KEY_FILE"; then
  HAS_KEY=1
fi
if [ "$PAAS_DRY_RUN" = "1" ]; then
  echo "[dry-run] só travaria root se $KEY_FILE tivesse ao menos uma chave válida"
elif [ "$HAS_KEY" = "1" ]; then
  info "chave presente — seguro travar a senha do root"
else
  skip "NENHUMA chave SSH instalada para $SSH_USER — root NÃO será travado (proteção anti-lockout)"
fi
ok "Verificação anti-lockout concluída"

step "Travando senha do root (passwd -l root)"
if [ "$HAS_KEY" = "1" ]; then
  run passwd -l root
  ok "Senha do root travada (acesso root direto desabilitado)"
else
  skip "Travamento do root adiado até existir chave SSH para $SSH_USER"
fi

step "Verificação"
if [ "$PAAS_DRY_RUN" = "1" ]; then
  echo "[dry-run] verificaria grupo sudo e estado da conta root"
else
  id "$SSH_USER" | grep -q '(sudo)' && info "$SSH_USER está no grupo sudo" || die "$SSH_USER não ficou no grupo sudo"
fi
ok "Fase 01 (usuário não-root) concluída"
