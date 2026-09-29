#!/usr/bin/env bash
# 07-extra.sh — Fase 07: endurecimento adicional — as recomendações do Lynis
# que são SEGURAS de automatizar numa VPS em produção.
#
# Fica de fora, de propósito (ver comoFuncionaSistema/seguranca/conceito-fases.json):
#  - idade máxima/expiração de senha: a senha do usuário do terminal expiraria
#    e o sudo do modo senha pararia de funcionar (e o NIST já não recomenda);
#  - senha no GRUB: um erro impede o boot desatendido da VPS;
#  - trocar a porta do SSH: obscuridade que quebra o README e o túnel;
#  - partições separadas (/home, /tmp, /var): só na instalação do sistema;
#  - apt-listbugs: consulta o BTS do Debian, não o do Ubuntu, e pode travar o apt;
#  - Lynis de repositório de terceiros; log remoto; remover contas travadas.
#
# Uso: ./07-extra.sh [--dry-run] [--rollback]
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$(readlink -f "$0")")/lib.sh"

MODE="apply"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)  PAAS_DRY_RUN=1 ;;
    --rollback) MODE="rollback" ;;
    -h|--help)
      echo "Uso: $0 [--dry-run] [--rollback]"
      paas_usage_common; exit 0 ;;
    *) die "opção desconhecida: $1" ;;
  esac
  shift
done

LOGIN_DEFS="/etc/login.defs"
LIMITS_FILE="/etc/security/limits.d/99-paas-nocore.conf"
COREDUMP_FILE="/etc/systemd/coredump.conf.d/99-paas-nocore.conf"
MODPROBE_FILE="/etc/modprobe.d/99-paas-hardening.conf"
SYSCTL_FILE="/etc/sysctl.d/99-paas-extra.conf"
SYSSTAT_DEFAULT="/etc/default/sysstat"
AIDE_CONF="/etc/aide/aide.conf"
ISSUE="/etc/issue"
ISSUE_NET="/etc/issue.net"
# Permissões originais de tudo que esta fase restringe ("<modo> <caminho>").
MODES_FILE="${PAAS_STATE_DIR}/extra-modes.txt"

# --- Rollback ----------------------------------------------------------------

if [ "$MODE" = "rollback" ]; then
  step "Restaurando configurações da fase 07"
  for f in "$LOGIN_DEFS" "$SYSSTAT_DEFAULT" "$AIDE_CONF" "$ISSUE" "$ISSUE_NET" \
           "$LIMITS_FILE" "$COREDUMP_FILE" "$MODPROBE_FILE" "$SYSCTL_FILE"; do
    restore_latest_backup "$f"
  done
  if [ -f "$MODES_FILE" ]; then
    while read -r mode path; do
      [ -n "$path" ] && [ -e "$path" ] && run chmod "$mode" "$path"
    done < "$MODES_FILE"
    run rm -f "$MODES_FILE"
  fi
  run_sh "sysctl --system >/dev/null 2>&1 || true"
  ok "Rollback da fase 07 concluído"
  exit 0
fi

# --- Utilitários desta fase ----------------------------------------------------

# set_conf <arquivo> <chave> <valor> — "CHAVE valor" (login.defs): troca a linha
# ativa ou acrescenta. O backup do arquivo é feito uma vez, por quem chama.
set_conf() {
  local file="$1" key="$2" value="$3"
  if [ "$PAAS_DRY_RUN" = "1" ]; then
    echo "[dry-run] $file: $key $value"
    return 0
  fi
  if grep -qE "^[[:space:]]*${key}[[:space:]]" "$file"; then
    sed -i -E "s|^[[:space:]]*${key}[[:space:]].*|${key} ${value}|" "$file"
  else
    printf '%s %s\n' "$key" "$value" >> "$file"
  fi
}

# restrict_mode <caminho> <modo> — aplica o modo guardando o original (uma vez)
# para o rollback. Caminho inexistente ou já no modo: nada a fazer.
restrict_mode() {
  local path="$1" mode="$2" current
  [ -e "$path" ] || return 0
  current="$(stat -c %a "$path")"
  [ "$current" = "$mode" ] && return 0
  if [ "$PAAS_DRY_RUN" = "1" ]; then
    echo "[dry-run] chmod $mode $path (hoje $current)"
    return 0
  fi
  mkdir -p "$PAAS_STATE_DIR"
  grep -qF " $path" "$MODES_FILE" 2>/dev/null || echo "$current $path" >> "$MODES_FILE"
  chmod "$mode" "$path"
  info "permissão de $path: $current -> $mode"
}

# --- Aplicação -----------------------------------------------------------------

step "Instalando ferramentas de verificação e contabilidade"
# libpam-tmpdir: $TMP privado por sessão; debsums: confere arquivos dos pacotes;
# apt-show-versions: gestão de patches; acct: contabilidade de processos;
# sysstat: histórico de uso; libpam-pwquality: força mínima de senha NOVA.
# apt-listchanges: mostra mudanças importantes antes de cada atualização (a
# fase 00 também o instala, mas uma fase 00 interrompida o deixava de fora).
apt_install libpam-tmpdir debsums apt-show-versions acct sysstat libpam-pwquality apt-listchanges
ok "Ferramentas instaladas"

step "Ativando a contabilidade de processos e o sysstat"
if [ -f "$SYSSTAT_DEFAULT" ]; then
  backup_file "$SYSSTAT_DEFAULT"
  run sed -i -E 's/^ENABLED=.*/ENABLED="true"/' "$SYSSTAT_DEFAULT"
fi
svc_enable_now sysstat || warn "não foi possível ativar o sysstat (normal em containers)"
svc_enable_now acct || warn "não foi possível ativar o acct (normal em containers)"
ok "Contabilidade ativa"

step "Desativando core dumps"
write_file "$LIMITS_FILE" <<'EOF'
# Gerenciado pelo painel PaaS (07-extra.sh). Core dump pode conter senhas e chaves.
* hard core 0
EOF
write_file "$COREDUMP_FILE" <<'EOF'
# Gerenciado pelo painel PaaS (07-extra.sh).
[Coredump]
Storage=none
ProcessSizeMax=0
EOF
ok "Core dumps desativados"

step "Política de senha e umask ($LOGIN_DEFS)"
# Valem para senhas e sessões NOVAS: a senha atual continua funcionando.
backup_file "$LOGIN_DEFS"
set_conf "$LOGIN_DEFS" UMASK 027
set_conf "$LOGIN_DEFS" PASS_MIN_DAYS 1
set_conf "$LOGIN_DEFS" SHA_CRYPT_MIN_ROUNDS 5000
set_conf "$LOGIN_DEFS" SHA_CRYPT_MAX_ROUNDS 50000
ok "login.defs ajustado (umask 027, idade mínima 1 dia, rodadas de hash)"

step "Bloqueando módulos de kernel sem uso numa VPS ($MODPROBE_FILE)"
write_file "$MODPROBE_FILE" <<'EOF'
# Gerenciado pelo painel PaaS (07-extra.sh).
# Armazenamento USB (roubo de dados) e protocolos de rede raros (superfície de ataque).
# /bin/true (e não /bin/false): é a forma exata que o Lynis (NETW-3200) reconhece;
# o efeito é o mesmo — o módulo nunca carrega.
install usb-storage /bin/true
install dccp /bin/true
install sctp /bin/true
install rds /bin/true
install tipc /bin/true
blacklist usb-storage
blacklist dccp
blacklist sctp
blacklist rds
blacklist tipc
EOF
ok "Módulos bloqueados"

step "Ajustes de kernel recomendados pelo Lynis ($SYSCTL_FILE)"
# Complementa o 99-paas-hardening.conf da fase 03 (este arquivo é lido depois).
# De fora de propósito: net.ipv4.conf.all.forwarding=0 (o Docker precisa de
# roteamento) e kernel.modules_disabled=1 (impediria carregar qualquer módulo).
write_file "$SYSCTL_FILE" <<'EOF'
# Gerenciado pelo painel PaaS (07-extra.sh).
dev.tty.ldisc_autoload = 0
kernel.core_uses_pid = 1
kernel.ctrl-alt-del = 0
kernel.perf_event_paranoid = 3
net.ipv4.conf.all.bootp_relay = 0
net.ipv4.conf.all.proxy_arp = 0
net.ipv4.conf.default.log_martians = 1
net.ipv4.conf.default.send_redirects = 0
net.ipv6.conf.all.accept_source_route = 0
net.ipv6.conf.default.accept_source_route = 0
net.ipv6.conf.default.accept_redirects = 0
EOF
run_sh "sysctl -p '$SYSCTL_FILE' >/dev/null 2>&1 || echo '[paas] WARN: alguns valores de sysctl não puderam ser aplicados agora (normal em containers)' >&2"
ok "Kernel ajustado"

step "Aviso legal no login (/etc/issue e /etc/issue.net)"
BANNER="$(cat <<'EOF'
Authorized access only. This system is private and monitored: all activity may be audited and logged.
Unauthorized access is prohibited by law and by policy.
Acesso restrito a usuários autorizados. Este sistema é privado e monitorado.
EOF
)"
printf '%s\n' "$BANNER" | write_file "$ISSUE"
printf '%s\n' "$BANNER" | write_file "$ISSUE_NET"
ok "Aviso legal gravado"

step "AIDE com SHA512"
if [ -f "$AIDE_CONF" ]; then
  if grep -qE '^[^#]*sha512' "$AIDE_CONF"; then
    info "o AIDE já usa sha512"
  else
    backup_file "$AIDE_CONF"
    if [ "$PAAS_DRY_RUN" = "1" ]; then
      echo "[dry-run] $AIDE_CONF: Checksums = sha512 e nova baseline (aideinit)"
    else
      if grep -qE '^[[:space:]]*Checksums[[:space:]]*=' "$AIDE_CONF"; then
        sed -i -E 's|^[[:space:]]*Checksums[[:space:]]*=.*|Checksums = sha512|' "$AIDE_CONF"
      else
        printf 'Checksums = sha512\n' >> "$AIDE_CONF"
      fi
      if aide --config="$AIDE_CONF" --config-check >/dev/null 2>&1; then
        # a baseline antiga foi gerada com outro hash: refaz (rápido — a fase 06
        # exclui /var/lib/docker e /var/lib/containerd)
        if [ -f /var/lib/aide/aide.db ]; then
          aideinit -y -f >/dev/null 2>&1 || warn "aideinit falhou — rode 'sudo aideinit -y -f' depois"
        fi
        info "AIDE passa a usar sha512"
      else
        restore_latest_backup "$AIDE_CONF"
        warn "configuração do AIDE recusou sha512 — mantida a anterior"
      fi
    fi
  fi
else
  skip "AIDE não instalado (fase 06) — nada a ajustar"
fi
ok "AIDE verificado"

step "Compiladores só para o root"
# Um invasor sem root não compila exploit na máquina. Deploys compilam dentro
# dos containers, não no host.
for name in as cc c++ gcc g++ clang; do
  bin="$(command -v "$name" 2>/dev/null || true)"
  [ -n "$bin" ] || continue
  restrict_mode "$(readlink -f "$bin")" 750
done
ok "Compiladores restritos"

step "Permissões de arquivos sensíveis"
restrict_mode /etc/crontab 600
for d in /etc/cron.d /etc/cron.daily /etc/cron.hourly /etc/cron.weekly /etc/cron.monthly; do
  restrict_mode "$d" 700
done
restrict_mode /etc/ssh/sshd_config 600
restrict_mode /boot/grub/grub.cfg 400
ok "Permissões restritas"

step "Verificação"
if [ "$PAAS_DRY_RUN" = "1" ]; then
  echo "[dry-run] verificaria login.defs, módulos e sysctl"
else
  grep -qE '^UMASK 027' "$LOGIN_DEFS" || die "UMASK 027 não ficou em $LOGIN_DEFS"
  [ -f "$MODPROBE_FILE" ] || die "$MODPROBE_FILE não foi criado"
  [ -f "$SYSCTL_FILE" ] || die "$SYSCTL_FILE não foi criado"
fi
ok "Fase 07 (endurecimento adicional) concluída"
