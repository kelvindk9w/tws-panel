#!/usr/bin/env bash
# =============================================================================
# TWS Panel — restaurar-painel.sh
#
# Restaura o PAINEL (contas, projetos cadastrados, configurações, chaves) a
# partir de um backup .7z, sem precisar entrar no painel. Para quando o
# painel não abre ou você não tem mais o login. Com o painel abrindo, prefira
# Configurações → Backups → Painel → Restaurar.
#
# Uso (na VPS, com o arquivo já copiado para ela):
#   cd /opt/tws-panel && sudo ./scripts/restaurar-painel.sh /root/2026-10-14_03-00.7z
#
# Se o backup tem senha (cópia externa cifrada), o script pergunta a senha
# sem mostrar na tela. Ela vai para o 7-Zip pela entrada padrão: não aparece
# no histórico do shell nem na lista de processos.
#
# O que faz:
#   1. confere o arquivo com o 7-Zip da imagem do painel (e a senha);
#   2. para o painel;
#   3. extrai o backup no volume paas_data, em /data/backups/.restaurar-painel,
#      e grava o pedido de restauração;
#   4. sobe o painel: na subida ele guarda o estado atual em
#      /data/backups/_painel/antes-da-restauracao/ e põe o backup no lugar;
#   5. confere que a troca aconteceu.
# Ficam como estão: as cópias de backup na VPS, o token de instalação e o
# código dos projetos. Depois: entre com o usuário e a senha do backup.
# Permissões: a extração roda como o usuário da imagem (o mesmo dono do
# painel) e tudo fica só para ele (0600 nos arquivos, 0700 nas pastas).
# =============================================================================
set -euo pipefail

VOLUME_NAME="${PAAS_VOLUME:-paas_data}"
IMAGE="${PAAS_IMAGE:-tws-panel:latest}"
CONTAINER="${PAAS_CONTAINER:-tws-panel}"
WAIT_SECONDS="${PAAS_WAIT_SECONDS:-120}"
STAGE="/data/backups/.restaurar-painel"
MARKER="/data/backups/.restaurar-painel.json"

log() { printf '\033[1;34m[tws-panel]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[tws-panel][erro]\033[0m %s\n' "$*" >&2; exit 1; }

case "${1:-}" in
  -h|--help) sed -n '2,29p' "$0"; exit 0 ;;
  "") die "informe o arquivo do backup. Ex.: sudo ./scripts/restaurar-painel.sh /root/2026-10-14_03-00.7z" ;;
esac
[ "$#" -eq 1 ] || die "informe só o arquivo do backup (use --help)"

ARCHIVE="$1"
[ -f "$ARCHIVE" ] || die "arquivo não encontrado: $ARCHIVE"
case "$ARCHIVE" in *.7z) ;; *) die "o arquivo precisa ser um .7z do TWS Panel (pasta _painel do backup)" ;; esac

command -v docker >/dev/null 2>&1 || die "docker não encontrado — rode este script na VPS do painel."
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "imagem $IMAGE não encontrada — instale o painel primeiro (scripts/install.sh)."

ARCHIVE_DIR="$(cd "$(dirname "$ARCHIVE")" && pwd)"
ARCHIVE_NAME="$(basename "$ARCHIVE")"

# 7zz dentro da imagem do painel, com o arquivo montado só para leitura.
seven() {
  docker run --rm -i --entrypoint 7zz -v "$ARCHIVE_DIR:/entrada:ro" "$IMAGE" "$@"
}

# 1. Conferir o arquivo (primeiro sem senha; se pedir, pergunta).
SENHA_LIDA=""
if ! seven t -bso0 -bsp0 "/entrada/$ARCHIVE_NAME" </dev/null >/dev/null 2>&1; then
  if [ -n "${PAAS_BACKUP_PASSWORD:-}" ]; then
    SENHA_LIDA="$PAAS_BACKUP_PASSWORD"
  else
    printf 'Senha do backup: ' >&2
    IFS= read -rs SENHA_LIDA || true
    printf '\n' >&2
  fi
  [ -n "$SENHA_LIDA" ] || die "o arquivo não abriu sem senha e nenhuma senha foi digitada."
  printf '%s\n' "$SENHA_LIDA" | seven t -bso0 -bsp0 "/entrada/$ARCHIVE_NAME" >/dev/null 2>&1 \
    || die "a senha não abre este backup (ou o arquivo está estragado). Se ele é de antes de uma troca de senha, use a senha daquela época."
fi
log "arquivo conferido: $ARCHIVE_NAME"

# 2. Parar o painel (ele regravaria os arquivos que estão em memória).
if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  log "parando o painel…"
  docker stop "$CONTAINER" >/dev/null
fi

# 3. Extrair no volume e gravar o pedido de restauração.
log "extraindo o backup no volume $VOLUME_NAME…"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STATUS=0
printf '%s\n' "$SENHA_LIDA" | docker run --rm -i --entrypoint sh \
  -v "$VOLUME_NAME:/data" -v "$ARCHIVE_DIR:/entrada:ro" "$IMAGE" -c '
    set -e
    umask 077
    rm -rf "$1" && mkdir -p "$1"
    if [ -n "$4" ]; then 7zz x -y -bso0 -bsp0 -o"$1" "/entrada/$2"; else 7zz x -y -bso0 -bsp0 -o"$1" "/entrada/$2" </dev/null; fi
    chmod -R go-rwx "$1"
    rm -rf "$1/backups" "$1/setup-token" "$1/projects"
    printf "{\"requestedAt\":\"%s\",\"fileName\":\"%s\",\"actor\":\"ssh\"}\n" "$3" "$2" > "$5"
  ' restaurar "$STAGE" "$ARCHIVE_NAME" "$NOW" "${SENHA_LIDA:+cifrado}" "$MARKER" || STATUS=$?
SENHA_LIDA=""

if [ "$STATUS" != "0" ]; then
  docker run --rm --entrypoint sh -v "$VOLUME_NAME:/data" "$IMAGE" -c 'rm -rf "$1" "$2"' limpar "$STAGE" "$MARKER" || true
  docker start "$CONTAINER" >/dev/null 2>&1 || true
  die "não foi possível extrair o backup (código $STATUS). O painel voltou como estava."
fi

# 4. Subir o painel: a troca acontece na subida.
log "iniciando o painel…"
docker start "$CONTAINER" >/dev/null

# 5. Conferir: o pedido some quando a troca termina.
log "conferindo a restauração (até ${WAIT_SECONDS}s)…"
DEADLINE=$(( $(date +%s) + WAIT_SECONDS ))
while :; do
  if docker exec "$CONTAINER" sh -c "test ! -e $MARKER" >/dev/null 2>&1; then
    log "pronto. Entre no painel com o usuário e a senha do backup."
    log "o estado anterior ficou em /data/backups/_painel/antes-da-restauracao/ (volume $VOLUME_NAME)."
    exit 0
  fi
  [ "$(date +%s)" -lt "$DEADLINE" ] || break
  sleep 2
done
die "o painel ainda não terminou a troca. Veja o que ele diz: sudo docker logs tws-panel --tail 50"
