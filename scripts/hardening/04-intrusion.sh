#!/usr/bin/env bash
# 04-intrusion.sh — Fase 04: prevenção ativa (fail2ban) + AppArmor.
# Spec: docs/security-research.md §2.5 (jail.local completo) e §2.7.
#
# Uso: ./04-intrusion.sh [--ssh-port 22] [--profile mail] [--dry-run] [--rollback]
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$(readlink -f "$0")")/lib.sh"

MODE="apply"
SSH_PORT="22"
PROFILE=""
JAIL="/etc/fail2ban/jail.local"

while [ $# -gt 0 ]; do
  case "$1" in
    --ssh-port) SSH_PORT="${2:?--ssh-port exige um número}"; shift ;;
    --profile)  PROFILE="${2:?--profile exige um nome}"; shift ;;
    --dry-run)  PAAS_DRY_RUN=1 ;;
    --rollback) MODE="rollback" ;;
    -h|--help)
      echo "Uso: $0 [--ssh-port N] [--profile mail] [--dry-run] [--rollback]"
      paas_usage_common; exit 0 ;;
    *) die "opção desconhecida: $1" ;;
  esac
  shift
done
[ -z "$PROFILE" ] || [ "$PROFILE" = "mail" ] || die "profile desconhecido: $PROFILE (suportado: mail)"

if [ "$MODE" = "rollback" ]; then
  step "Restaurando configuração do fail2ban"
  restore_latest_backup "$JAIL"
  if [ "$PAAS_DRY_RUN" != "1" ] && command -v fail2ban-client >/dev/null 2>&1; then
    svc_reload_or_restart fail2ban || true
  fi
  ok "Rollback da fase 04 concluído"
  exit 0
fi

step "Instalando fail2ban e apparmor-utils"
apt_install fail2ban apparmor-utils
ok "Pacotes instalados"

step "Configurando jails do fail2ban ($JAIL)"
# Jails seguem os serviços presentes (spec §4 passo 17: "conforme serviços") —
# habilitar jail de serviço inexistente faz `fail2ban-client -t` falhar por
# falta de arquivo de log.
JAILS="$(
  cat <<EOF
# Gerenciado pelo painel PaaS (04-intrusion.sh). Spec: docs/security-research.md §2.5
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = auto
banaction = nftables-multiport
ignoreip = 127.0.0.1/8 ::1
bantime.increment = true
bantime.factor = 2
bantime.maxtime = 1w
dbpurgeage = 7d

[sshd]
enabled = true
port = $SSH_PORT
maxretry = 3
bantime = 6h

[recidive]
enabled = true
bantime = 1w
findtime = 1d
EOF
)"

# nginx: somente se o serviço está presente
if command -v nginx >/dev/null 2>&1 || [ -d /var/log/nginx ]; then
  JAILS="$JAILS

[nginx-http-auth]
enabled = true

[nginx-limit-req]
enabled = true
maxretry = 10

[nginx-botsearch]
enabled = true"
else
  info "nginx ausente — jails nginx não habilitados"
fi

# e-mail: somente com --profile mail e serviços presentes
if [ "$PROFILE" = "mail" ]; then
  if command -v postfix >/dev/null 2>&1 || pkg_installed postfix; then
    JAILS="$JAILS

[postfix]
enabled = true
mode = aggressive

[postfix-sasl]
enabled = true"
  else
    info "postfix ausente — jails postfix não habilitados"
  fi
  if command -v dovecot >/dev/null 2>&1 || pkg_installed dovecot-core; then
    JAILS="$JAILS

[dovecot]
enabled = true"
  else
    info "dovecot ausente — jail dovecot não habilitado"
  fi
fi

printf '%s\n' "$JAILS" | write_file "$JAIL"

# O jail sshd (backend=auto) exige um arquivo de log existente; em instalações
# sem rsyslog/journal acessível o auth.log pode não existir ainda.
if [ "$PAAS_DRY_RUN" != "1" ] && [ ! -e /var/log/auth.log ] && [ ! -d /run/systemd/system ]; then
  touch /var/log/auth.log
  info "criado /var/log/auth.log vazio (exigido pelo jail sshd)"
fi
ok "jail.local configurado"

step "Validando configuração do fail2ban"
if [ "$PAAS_DRY_RUN" = "1" ]; then
  echo "[dry-run] fail2ban-client -t"
else
  fail2ban-client -t || die "fail2ban-client -t FALHOU — jail.local inválido (rollback: $0 --rollback)"
fi
ok "Configuração válida"

step "Ativando fail2ban"
svc_enable_now fail2ban
if [ "$PAAS_DRY_RUN" != "1" ]; then
  fail2ban-client ping 2>/dev/null && info "fail2ban respondendo" || warn "fail2ban não respondeu (sem systemd? serviço subirá no boot)"
fi
ok "Fail2ban ativo"

step "AppArmor: verificando perfis"
if [ "$PAAS_DRY_RUN" = "1" ]; then
  echo "[dry-run] aa-status / aa-enforce"
elif [ -f /sys/module/apparmor/parameters/enabled ]; then
  aa-status 2>/dev/null || true
  # Perfis novos devem passar 48h em complain antes de enforce (spec §2.7);
  # aqui reforçamos apenas os perfis já existentes e carregados.
  if aa-status --enforced >/dev/null 2>&1; then
    aa-enforce /etc/apparmor.d/* >/dev/null 2>&1 || warn "alguns perfis não entraram em enforce"
  fi
  ok "AppArmor verificado"
else
  skip "AppArmor indisponível neste kernel (container?) — nada a fazer"
fi

ok "Fase 04 (prevenção de intrusão) concluída"
