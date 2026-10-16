#!/usr/bin/env bash
# 04-intrusion.sh — Fase 04: prevenção ativa (fail2ban) + AppArmor.
# Spec: docs/security-research.md §2.5 (jail.local completo) e §2.7.
#
# A jail sshd vigia as portas reais do SSH (detect_ssh_ports, em lib.sh);
# `--ssh-port` soma uma porta às detectadas (achado 24).
#
# Uso: ./04-intrusion.sh [--ssh-port N]... [--profile mail] [--dry-run] [--rollback]
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$(readlink -f "$0")")/lib.sh"

MODE="apply"
EXTRA_SSH_PORTS=""
PROFILE=""
JAIL="/etc/fail2ban/jail.local"

while [ $# -gt 0 ]; do
  case "$1" in
    --ssh-port) EXTRA_SSH_PORTS="$EXTRA_SSH_PORTS ${2:?--ssh-port exige um número}"; shift ;;
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
for port in $EXTRA_SSH_PORTS; do
  case "$port" in
    ''|*[!0-9]*) die "porta inválida: $port" ;;
  esac
  if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    die "porta fora do intervalo 1-65535: $port"
  fi
done

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
# Portas reais do SSH + as pedidas com --ssh-port, no formato do fail2ban (vírgulas).
# shellcheck disable=SC2046,SC2086 # separação por espaço é intencional
SSH_PORT="$(printf '%s\n' $(detect_ssh_ports) $EXTRA_SSH_PORTS | sort -un | paste -sd, -)"
info "jail sshd vigiando a(s) porta(s) do SSH: $SSH_PORT"
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

step "Ativando fail2ban com as regras novas"
# O pacote já sobe o serviço ao ser instalado, com a configuração padrão.
# `enable --now` não recarrega um serviço que já roda: as jails novas
# (recidive, maxretry 3, e-mail…) só entravam em vigor no próximo reboot
# (achado 26). Daemon já ativo → reload; depois, confere no daemon que cada
# jail do jail.local está de fato ativa.
EXPECTED_JAILS="$(printf '%s\n' "$JAILS" | sed -n 's/^\[\([A-Za-z0-9_-]*\)\]$/\1/p' | grep -vx DEFAULT | tr '\n' ' ')"
if [ "$PAAS_DRY_RUN" = "1" ]; then
  echo "[dry-run] habilitaria o fail2ban, recarregaria se já estivesse rodando e conferiria as jails: $EXPECTED_JAILS"
else
  WAS_RUNNING=0
  fail2ban-client ping >/dev/null 2>&1 && WAS_RUNNING=1
  svc_enable_now fail2ban
  if [ "$WAS_RUNNING" = "1" ]; then
    info "fail2ban já estava rodando — recarregando para aplicar o jail.local"
    fail2ban-client reload >/dev/null 2>&1 || svc_reload_or_restart fail2ban
  fi
  # o daemon leva alguns segundos para subir/recarregar as jails
  F2B_UP=0
  for _ in $(seq 1 20); do
    if fail2ban-client ping >/dev/null 2>&1; then F2B_UP=1; break; fi
    sleep 1
  done
  if [ "$F2B_UP" = "1" ]; then
    MISSING=""
    for _ in $(seq 1 10); do
      ACTIVE=" $(fail2ban-client status 2>/dev/null | sed -n 's/.*Jail list:[[:space:]]*//p' | tr -d ',' | tr -s '[:space:]' ' ') "
      MISSING=""
      for jail in $EXPECTED_JAILS; do
        case "$ACTIVE" in *" $jail "*) ;; *) MISSING="$MISSING $jail" ;; esac
      done
      [ -z "$MISSING" ] && break
      sleep 1
    done
    [ -z "$MISSING" ] || die "jails do fail2ban que não ficaram ativas:$MISSING (rollback: $0 --rollback)"
    info "jails ativas no fail2ban: $EXPECTED_JAILS"
  else
    warn "fail2ban não respondeu (sem systemd? serviço subirá no boot) — não foi possível conferir as jails"
  fi
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
