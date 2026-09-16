#!/usr/bin/env bash
# 05-minimal.sh — Fase 05: minimização — remove snapd, pacotes e serviços desnecessários.
# Spec: docs/security-research.md §2.12 e §5 (snapd, serviços, clientes legados,
# prevenção de re-crescimento via APT::Install-Recommends).
#
# NUNCA remove: metapacotes ubuntu-server/ubuntu-minimal/ubuntu-standard nem kernels.
#
# NUNCA remove o snapd quando o Docker deste servidor vem de um snap
# (`snap install docker`, comum em imagens de alguns provedores e em tutoriais
# antigos). É o daemon do Docker que mantém de pé o container do painel e o
# container auxiliar onde esta fase está rodando: remover o snap do Docker
# derrubaria a própria execução, e o rollback desta fase não reinstala nada.
#
# Uso: ./05-minimal.sh [--dry-run] [--rollback]
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "$(readlink -f "$0")")/lib.sh"

MODE="apply"
APT_CONF="/etc/apt/apt.conf.d/99paas-dependencies"

# ---------------------------------------------------------------------------
# Proteção do canal de execução (mesmo padrão adotado na fase 00)
# ---------------------------------------------------------------------------

# paas_snap_docker — ecoa o nome do snap que fornece o Docker, ou vazio.
# O snap oficial do Docker (publisher canonical) se chama "docker"; `snap list`
# imprime o nome na primeira coluna, depois do cabeçalho:
#   Name    Version  Rev   Tracking       Publisher  Notes
#   docker  27.2.0   2963  latest/stable  canonical  -
# O binário em /snap/bin/docker é o sinal de apoio: ele só existe enquanto esse
# snap está instalado, e cobre o caso de o comando `snap` não estar no PATH.
paas_snap_docker() {
  local name=""
  if command -v snap >/dev/null 2>&1; then
    name="$(snap list 2>/dev/null | awk 'NR>1 && $1 == "docker" {print $1; exit}' || true)"
  fi
  if [ -z "$name" ] && [ -e /snap/bin/docker ]; then
    name="docker"
  fi
  printf '%s' "$name"
}

# paas_protected_pkgs — pacotes que esta fase não pode deixar sair numa remoção
# ampla (autoremove/purge de resíduos). Além dos pacotes do Docker vindos do
# APT (lista da lib), o snapd entra quando o Docker é um snap: purgar o snapd
# leva TODOS os snaps do sistema junto, inclusive o do Docker.
paas_protected_pkgs() {
  # shellcheck disable=SC2086  # a divisão em palavras é o que se quer aqui
  printf '%s\n' $PAAS_DOCKER_PKGS
  [ -n "${SNAP_DOCKER:-}" ] && printf '%s\n' snapd
  return 0
}

# apt_sim_removals <args...> — nomes dos pacotes que `apt-get -s <args>` removeria.
apt_sim_removals() {
  apt-get -s "$@" 2>/dev/null | awk '/^(Remv|Purg) /{print $2}' || true
}

# paas_protected_in "<lista-por-linha>" — ecoa os protegidos presentes na lista.
paas_protected_in() {
  local list="$1" p
  [ -n "$list" ] || return 0
  while read -r p; do
    [ -n "$p" ] || continue
    printf '%s\n' "$list" | grep -qxF "$p" && printf '%s\n' "$p" || true
  done < <(paas_protected_pkgs)
  return 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)  PAAS_DRY_RUN=1 ;;
    --rollback) MODE="rollback" ;;
    -h|--help)  echo "Uso: $0 [--dry-run] [--rollback]"; paas_usage_common; exit 0 ;;
    *) die "opção desconhecida: $1" ;;
  esac
  shift
done

if [ "$MODE" = "rollback" ]; then
  step "Restaurando configuração APT"
  restore_latest_backup "$APT_CONF"
  # Nota: pacotes removidos NÃO são reinstalados automaticamente (o apt log
  # registra tudo em /var/log/apt/history.log para reinstalação manual).
  warn "pacotes removidos não são reinstalados pelo rollback — veja /var/log/apt/history.log"
  ok "Rollback da fase 05 concluído"
  exit 0
fi

step "Verificando de onde vem o Docker deste servidor"
SNAP_DOCKER="$(paas_snap_docker)"
if [ -n "$SNAP_DOCKER" ]; then
  warn "o Docker deste servidor é o snap \"$SNAP_DOCKER\" — o snapd NÃO será removido"
  info "É esse snap que mantém de pé o daemon do Docker e, com ele, o container do"
  info "painel e o container onde esta fase está rodando agora. Removê-lo derrubaria"
  info "a própria execução no meio do caminho, e o rollback desta fase não reinstala"
  info "pacote nenhum. Por isso o snap \"$SNAP_DOCKER\", as bases de que ele depende"
  info "(core/core22/snapd/bare) e o pacote snapd ficam todos preservados."
  info ""
  info "Se quiser mesmo migrar para o Docker do repositório oficial (docker-ce), faça"
  info "isso numa sessão SSH — NÃO pelo terminal do painel — e por sua conta: envolve"
  info "parar os containers, mover os dados de /var/snap/docker para /var/lib/docker,"
  info "instalar o docker-ce e só então remover o snap. Este script não executa nada"
  info "disso. Feita a migração, rode a fase 05 de novo: sem Docker em snap, ela"
  info "remove o snapd normalmente."
  ok "Docker em snap detectado — snapd preservado"
else
  info "nenhum snap fornece o Docker (nem snap \"docker\" nem /snap/bin/docker)"
  ok "Docker não depende do snapd"
fi

step "Removendo snapd"
if pkg_installed snapd; then
  SNAPS_BASE_RE='^(core|core[0-9]+|snapd|bare)$'
  SNAPS_ALL=""
  SNAPS_OTHER=""
  SNAPS_BASE=""
  if command -v snap >/dev/null 2>&1; then
    # O `|| true` é obrigatório: sem snaps instalados o `snap list` sai 1 e, sob
    # pipefail, o pipeline inteiro falharia — derrubando o script (set -e).
    SNAPS_ALL="$(snap list 2>/dev/null | awk 'NR>1 {print $1}' || true)"
  fi
  if [ -n "$SNAPS_ALL" ]; then
    SNAPS_OTHER="$(printf '%s\n' "$SNAPS_ALL" | grep -vE "$SNAPS_BASE_RE" || true)"
    SNAPS_BASE="$(printf '%s\n' "$SNAPS_ALL" | grep -E "$SNAPS_BASE_RE" || true)"
    if [ -n "$SNAP_DOCKER" ] && [ -n "$SNAPS_OTHER" ]; then
      SNAPS_OTHER="$(printf '%s\n' "$SNAPS_OTHER" | grep -vxF "$SNAP_DOCKER" || true)"
    fi
  fi

  if [ -n "$SNAPS_OTHER" ]; then
    info "snaps a remover: $(printf '%s' "$SNAPS_OTHER" | tr '\n' ' ')"
  else
    info "nenhum snap comum a remover"
  fi

  # Remove na ordem correta (spec §5.3): primeiro os comuns, por último base/core.
  # As bases só saem quando NÃO há Docker em snap — elas sustentam o snap do
  # Docker, e removê-las levaria o Docker junto.
  if [ "$PAAS_DRY_RUN" = "1" ]; then
    echo "[dry-run] snap remove --purge: $(printf '%s' "$SNAPS_OTHER" | tr '\n' ' ')"
  else
    printf '%s\n' "$SNAPS_OTHER" | while read -r s; do
      [ -n "$s" ] || continue
      snap remove --purge "$s" || warn "falha ao remover snap $s"
    done
  fi

  if [ -n "$SNAP_DOCKER" ]; then
    skip "snap \"$SNAP_DOCKER\" e as bases ($(printf '%s' "$SNAPS_BASE" | tr '\n' ' ')) mantidos — é o Docker do painel"
    skip "snapd mantido instalado e ativo — purgá-lo removeria todos os snaps, inclusive o Docker"
    ok "Snaps desnecessários removidos; snapd preservado por causa do Docker"
  else
    if [ "$PAAS_DRY_RUN" = "1" ]; then
      echo "[dry-run] snap remove --purge (bases): $(printf '%s' "$SNAPS_BASE" | tr '\n' ' ')"
    else
      printf '%s\n' "$SNAPS_BASE" | while read -r s; do
        [ -n "$s" ] || continue
        snap remove --purge "$s" || warn "falha ao remover snap $s"
      done
    fi
    svc_disable_mask snapd.socket
    svc_disable_mask snapd.service
    apt_purge_if_installed snapd
    run apt-mark hold snapd || true
    run_sh "rm -rf /var/cache/snapd /root/snap /home/*/snap 2>/dev/null || true"
    ok "snapd removido e bloqueado (apt-mark hold)"
  fi
else
  info "snapd não está instalado"
  ok "snapd ausente — nada a fazer"
fi

step "Desabilitando serviços desnecessários"
for svc in avahi-daemon cups bluetooth ModemManager whoopsie apport rpcbind rpcbind.socket; do
  svc_disable_mask "$svc"
done
ok "Serviços desnecessários desabilitados/mascarados"

step "Removendo clientes legados inseguros (telnet/rsh/ftp/tftp/talk/nis)"
apt_purge_if_installed telnet rsh-client rsh-redone-client ftp tftp-hpa tftp talk nis
ok "Clientes legados removidos"

step "Removendo suporte a desktop/impressão (se presente)"
# Categorias tipicamente desnecessárias em servidor (spec §5.1/§5.3).
apt_purge_if_installed cups-bsd avahi-daemon avahi-autoipd modemmanager whoopsie apport popularity-contest
ok "Pacotes de desktop/remoção concluída"

step "Limpando dependências órfãs e resíduos"
# O autoremove e o purge de resíduos são comandos amplos: o que eles levam junto
# depende do estado do sistema, não do que está escrito aqui. Por isso a lista
# vai para o log ANTES da remoção, e uma simulação prévia barra a remoção se ela
# tocar em algo que sustenta o painel (Docker, e o snapd quando o Docker é snap).
ORPHANS="$(apt_sim_removals autoremove --purge)"
if [ -n "$ORPHANS" ]; then
  info "autoremove removeria: $(printf '%s' "$ORPHANS" | tr '\n' ' ')"
else
  info "nenhum pacote órfão a remover"
fi
ORPHANS_HIT="$(paas_protected_in "$ORPHANS" | tr '\n' ' ' | sed 's/ *$//')"

if [ "$PAAS_DRY_RUN" = "1" ]; then
  echo "[dry-run] apt-get autoremove --purge / purge de resíduos 'rc' / clean"
  COUNT="$(printf '%s' "$ORPHANS" | grep -c . || true)"
  echo "[dry-run] $COUNT pacote(s) órfãos seriam removidos"
  if [ -n "$ORPHANS_HIT" ]; then
    echo "[dry-run] autoremove protegeria (apt-mark manual): $ORPHANS_HIT"
  fi
else
  if [ -n "$ORPHANS_HIT" ]; then
    # Pacote essencial marcado como automático: marcar manual já resolve, e é o
    # estado correto para ele (foi instalado de propósito).
    warn "o autoremove levaria junto pacote(s) que sustentam o painel: $ORPHANS_HIT"
    # shellcheck disable=SC2086
    apt-mark manual $ORPHANS_HIT >/dev/null 2>&1 || true
    info "marcados como instalados manualmente para não serem removidos: $ORPHANS_HIT"
    ORPHANS="$(apt_sim_removals autoremove --purge)"
    ORPHANS_HIT="$(paas_protected_in "$ORPHANS" | tr '\n' ' ' | sed 's/ *$//')"
  fi
  if [ -n "$ORPHANS_HIT" ]; then
    warn "autoremove NÃO executado: ainda removeria $ORPHANS_HIT — limpe as órfãs por SSH, com o Docker conferido"
  elif [ -n "$ORPHANS" ]; then
    env DEBIAN_FRONTEND=noninteractive apt-get autoremove --purge -y
  else
    info "autoremove sem trabalho a fazer"
  fi

  # Resíduos de configuração de pacotes já removidos (estado "rc" no dpkg).
  residual="$(dpkg -l | awk '/^rc/ {print $2}')"
  if [ -n "$residual" ]; then
    info "resíduos de configuração a purgar: $(printf '%s' "$residual" | tr '\n' ' ')"
    # shellcheck disable=SC2086
    RESID_PLAN="$(apt_sim_removals purge $residual)"
    RESID_HIT="$(paas_protected_in "$RESID_PLAN" | tr '\n' ' ' | sed 's/ *$//')"
    if [ -n "$RESID_HIT" ]; then
      warn "purge dos resíduos NÃO executado: arrastaria $RESID_HIT — resolva por SSH"
    else
      # shellcheck disable=SC2086
      env DEBIAN_FRONTEND=noninteractive apt-get purge -y $residual
    fi
  else
    info "nenhum resíduo de configuração a purgar"
  fi
  apt-get autoclean -y && apt-get clean
fi
ok "Limpeza concluída"

step "Prevenindo re-crescimento (APT sem Recommends/Suggests)"
write_file "$APT_CONF" <<'EOF'
// Gerenciado pelo painel PaaS (05-minimal.sh). Spec: docs/security-research.md §5.4
APT::Install-Recommends "false";
APT::Install-Suggests "false";
EOF
ok "APT configurado para não instalar Recommends/Suggests"

step "Salvando baseline de pacotes"
if [ "$PAAS_DRY_RUN" = "1" ]; then
  echo "[dry-run] apt-mark showmanual | sort > /etc/baseline-packages.txt"
else
  apt-mark showmanual | sort > /etc/baseline-packages.txt
  info "baseline salvo em /etc/baseline-packages.txt ($(wc -l < /etc/baseline-packages.txt) pacotes)"
fi
ok "Baseline de pacotes salvo"

ok "Fase 05 (minimização) concluída"
