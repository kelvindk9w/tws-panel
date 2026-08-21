#!/usr/bin/env bash
# =============================================================================
# TWS Panel — reset-setup.sh
#
# Reseta o estado do setup para recomeçar o wizard do ZERO (passo 0), sem
# reinstalar o painel. Opera direto no volume paas_data.
#
# Uso (na VPS, como root ou usuário com acesso ao Docker):
#   ./scripts/reset-setup.sh           # reseta SÓ o progresso do wizard
#   ./scripts/reset-setup.sh --full    # + remove usuários admin e sessões
#
# O que cada modo apaga (dentro do volume paas_data, montado em /data):
#   padrão:  setup-state.json                  (o wizard volta ao passo 0)
#   --full:  setup-state.json + users.json + sessions.json
#            (a conta admin deixa de existir — crie outra no fim do wizard)
#
# NADA mais é tocado: projetos, domínios, e-mail, histórico de segurança e o
# setup token permanecem intactos.
#
# ⚠  Exige confirmação interativa (digitar "resetar").
# =============================================================================
set -euo pipefail

VOLUME_NAME="${PAAS_VOLUME:-paas_data}"

BOLD='\033[1m'; RESET='\033[0m'; RED='\033[1;31m'; YELLOW='\033[1;33m'
log()  { printf '\033[1;34m[tws-panel]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[tws-panel][erro]\033[0m %s\n' "$*" >&2; exit 1; }

FULL=0
for arg in "$@"; do
  case "$arg" in
    --full) FULL=1 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) die "argumento desconhecido: $arg (use --full ou --help)" ;;
  esac
done

command -v docker >/dev/null 2>&1 || die "docker não encontrado — rode este script na VPS do painel."

cat <<EOF

${RED}${BOLD}██████████████████████████████████████████████████████████████████████████████
██                                                                          ██
██                 ⚠   RESET DO ASSISTENTE DE CONFIGURAÇÃO  ⚠                ██
██                                                                          ██
██████████████████████████████████████████████████████████████████████████████${RESET}

EOF

if [ "$FULL" = "1" ]; then
  printf '%b\n' "${YELLOW}${BOLD}Modo --full: serão apagados do volume $VOLUME_NAME:${RESET}"
  cat <<EOF
   • setup-state.json  (progresso do wizard)
   • users.json        (conta(s) de administrador — login atual deixa de existir)
   • sessions.json     (sessões ativas — todos serão deslogados)
EOF
else
  printf '%b\n' "${YELLOW}${BOLD}Será apagado do volume $VOLUME_NAME:${RESET}"
  cat <<EOF
   • setup-state.json  (o wizard volta ao passo 0; a conta admin é mantida)
EOF
fi

cat <<EOF

${BOLD}NÃO será tocado:${RESET} projetos, domínios, e-mail, histórico de segurança e
o setup token (use ./scripts/show-token.sh para vê-lo de novo).

EOF

printf '%b' "${RED}${BOLD}Para confirmar, digite \"resetar\" e pressione ENTER: ${RESET}"
read -r CONFIRM
if [ "$CONFIRM" != "resetar" ]; then
  log "cancelado — nada foi alterado."
  exit 0
fi

if [ "$FULL" = "1" ]; then
  RM_LIST="setup-state.json users.json sessions.json"
else
  RM_LIST="setup-state.json"
fi

docker run --rm -v "$VOLUME_NAME:/data" alpine:3 sh -c "
  for f in $RM_LIST; do rm -f \"/data/\$f\"; done
" || die "falha ao limpar o volume $VOLUME_NAME."

# Reinicia o painel para ele reler o estado zerado (se estiver rodando).
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'tws-panel'; then
  docker restart tws-panel >/dev/null
  log "painel reiniciado."
fi

cat <<EOF

${BOLD}✅ Setup resetado.${RESET} Abra o painel novamente com o link do instalador —
se não lembrar o token: ${BOLD}./scripts/show-token.sh${RESET}
EOF
