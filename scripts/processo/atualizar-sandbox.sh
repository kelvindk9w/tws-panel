#!/usr/bin/env bash
# =============================================================================
# atualizar-sandbox.sh — etapa "sandbox" do fluxo dev → sandbox → main.
#
# Leva a branch `sandbox` à VPS de testes e confere se o painel ficou de pé.
# O fluxo completo está em docs/processo/forma-de-trabalhar.md.
#
# Roda na máquina de quem integra (o guardião), de dentro de um clone deste
# repositório, com `git`, `gh` (autenticado), `ssh` e `curl`. Nada aqui roda na
# produção: o destino é lido de TWS_SANDBOX_SSH e a trava de segurança recusa
# qualquer instalação que não esteja na branch `sandbox`.
#
# Uso:
#   TWS_SANDBOX_SSH=<alias-do-ssh-config> scripts/processo/atualizar-sandbox.sh [opções]
#
# Opções:
#   --avancar             se a sandbox está atrás da dev, avança a sandbox no
#                         origin por fast-forward até a dev (só com o ci da dev
#                         verde no commit). Sem esta opção, sandbox ≠ dev é erro.
#   --preparar=<máquina>  primeira vez: troca a instalação do destino para a
#                         branch `sandbox` (checkout -B sandbox origin/sandbox,
#                         com upstream), só com a árvore limpa. <máquina> tem de
#                         ser igual ao `hostname` do destino: confirmação de que
#                         o alias aponta para a VPS de testes, e não a produção.
#   --so-validar          não atualiza nada: só confere o destino contra a
#                         origin/sandbox e imprime o resumo.
#   -h, --help            esta ajuda.
#
# Variáveis:
#   TWS_SANDBOX_SSH       (obrigatória) alias de ~/.ssh/config da VPS de testes.
#                         O usuário do alias precisa ser root ou ter sudo sem
#                         senha. Nunca escreva IP, host ou usuário real aqui.
#   TWS_SANDBOX_DIR       pasta da instalação no destino (padrão /opt/tws-panel).
#   TWS_SANDBOX_ESPERA    segundos de espera pelo container saudável e pelo
#                         endereço público (padrão 180).
#
# Saída: 0 com tudo validado; diferente de 0 com o motivo no resumo.
#   1 validação falhou · 2 uso ou pré-condição local · 3 trava de segurança
#   4 o instalador parou numa pergunta · 5 o instalador falhou
# =============================================================================
set -euo pipefail

DIR_PADRAO=/opt/tws-panel
ESPERA="${TWS_SANDBOX_ESPERA:-180}"
DESTINO_DIR="${TWS_SANDBOX_DIR:-$DIR_PADRAO}"

AVANCAR=0
PREPARAR=""
SO_VALIDAR=0

log()  { printf '[sandbox] %s\n' "$*" >&2; }
erro() { printf '[sandbox][erro] %s\n' "$*" >&2; }
sair() { local codigo="$1"; shift; erro "$*"; exit "$codigo"; }

ajuda() { sed -n '3,/^# =====/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'; }

# -----------------------------------------------------------------------------
# Script que roda NO DESTINO (via `ssh ... bash -s`). Fica numa função para ser
# enviado pela entrada padrão; o próprio texto não tem nada da máquina real.
# Protocolo: linhas que começam com "@" são dados para este script
# (@chave=valor); o resto é log para quem acompanha.
# -----------------------------------------------------------------------------
script_remoto() {
  cat <<'REMOTO'
set -euo pipefail
principal() {
  exec </dev/null
  local modo="$1" dir="$2"
  [ -d "$dir/.git" ] || { echo "@erro=a pasta da instalação não é um repositório git"; exit 2; }
  local dono casa
  dono="$(stat -c %U "$dir")"
  casa="$(getent passwd "$dono" | cut -d: -f6 || true)"
  # git como o DONO da pasta (o git recusa, como root, repositório de outro dono, e o que ele gravar
  # continua do dono, como no fluxo normal de quem roda o instalador com sudo).
  g() {
    if [ "$(id -u)" = 0 ] && [ "$dono" != root ]; then
      runuser -u "$dono" -- env HOME="${casa:-/tmp}" git -C "$dir" "$@"
    else
      git -C "$dir" "$@"
    fi
  }
  local branch head upstream sujo
  branch="$(g symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  head="$(g rev-parse HEAD)"
  upstream="$(g rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
  sujo="$(g status --porcelain --untracked-files=no | wc -l | tr -d ' ')"

  case "$modo" in
    estado)
      echo "@branch=$branch"
      echo "@head=$head"
      echo "@upstream=$upstream"
      echo "@sujo=$sujo"
      echo "@maquina=$(hostname)"
      ;;

    preparar)
      local esperado="$3" maquina="$4"
      [ "$(hostname)" = "$maquina" ] || { echo "@erro=o nome da máquina do destino não confere com --preparar"; exit 3; }
      if [ "$branch" = sandbox ] && [ "$upstream" = origin/sandbox ]; then
        echo "@preparado=ja"; return 0
      fi
      [ "$sujo" = 0 ] || { echo "@erro=há mudança local em arquivo versionado; nada foi trocado"; exit 3; }
      g fetch --quiet origin "+refs/heads/sandbox:refs/remotes/origin/sandbox"
      [ "$(g rev-parse origin/sandbox)" = "$esperado" ] || { echo "@erro=a origin/sandbox do destino não é o commit esperado"; exit 2; }
      g update-ref "refs/tws-backup/antes-da-sandbox-$(date +%Y%m%d-%H%M%S)" HEAD
      g checkout --quiet -B sandbox origin/sandbox
      g branch --quiet --set-upstream-to=origin/sandbox sandbox
      echo "Instalação trocada de '${branch:-HEAD solto}' para a branch sandbox."
      echo "@preparado=sim"
      ;;

    atualizar)
      # TRAVA DE SEGURANÇA: só atualiza instalação que está na branch sandbox, seguindo a origin/sandbox.
      if [ "$branch" != sandbox ] || [ "$upstream" != origin/sandbox ]; then
        echo "@erro=trava: a instalação está em '${branch:-HEAD solto}' (upstream '${upstream:-nenhum}'), não na sandbox"
        exit 3
      fi
      local saida inicio rc=0
      saida="$(mktemp)"
      inicio="$(date +%s)"
      echo "@inicio=$inicio"
      # Modo de atualização da documentação (guia de operações): o instalador na pasta da instalação, sem
      # nenhuma resposta digitada. Roda como root; o safe.directory só nesta chamada (escopo de linha de
      # comando do git, nada gravado) faz o mesmo papel do "sudo pelo dono da pasta" que o guia manda.
      (cd "$dir" && GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$dir" \
        ./scripts/install.sh </dev/null) 2>&1 | tee "$saida" || rc=$? # pipefail: o código é o do instalador
      echo "@duracao=$(( $(date +%s) - inicio ))"
      # Numa atualização o pré-flight não pergunta mais por causa dos containers do próprio painel; se
      # ainda pedir "continuar", achou um conflito de verdade na VPS (porta ocupada, serviço estranho).
      if grep -q -e 'Digite "continuar"' -e 'Instalação abortada' "$saida"; then
        rm -f "$saida"
        echo "@erro=o pré-flight do instalador achou um conflito na VPS e pediu \"continuar\""
        exit 4
      fi
      rm -f "$saida"
      [ "$rc" = 0 ] || { echo "@erro=o instalador saiu com código $rc"; exit 5; }
      ;;

    validar)
      local esperado="$3" inicio="${4:-}" espera="${5:-180}"
      # 1. commit implantado
      if [ "$branch" = sandbox ] && [ "$head" = "$esperado" ] && [ "$sujo" = 0 ]; then
        echo "@check=commit|ok|a instalação está na branch sandbox, no commit da origin/sandbox, sem mudança local"
      else
        echo "@check=commit|falha|branch '${branch:-HEAD solto}', commit ${head:0:12}, $sujo arquivo(s) versionado(s) alterado(s)"
      fi
      # 2. imagem: o painel não expõe o commit (só a versão do package.json), então a prova é indireta.
      #    - com atualização: o instalador terminou bem (construiu a partir desta pasta) e o container roda a
      #      imagem tws-panel:latest; se o código da imagem não mudou, o build reaproveita o cache e a data
      #      da imagem fica a antiga, o que é normal;
      #    - só validação: o commit em que a pasta estava na hora em que a imagem foi criada (reflog do git)
      #      tem de ter a mesma árvore do commit atual.
      local img_container img_latest img_criada_iso img_criada commit_na_hora
      img_container="$(docker inspect -f '{{.Image}}' tws-panel 2>/dev/null || true)"
      img_latest="$(docker image inspect -f '{{.Id}}' tws-panel:latest 2>/dev/null || true)"
      img_criada_iso="$(docker image inspect -f '{{.Created}}' tws-panel:latest 2>/dev/null || true)"
      img_criada="$(date -d "${img_criada_iso:-1970-01-01}" +%s 2>/dev/null || echo 0)"
      if [ -z "$img_container" ] || [ "$img_container" != "$img_latest" ]; then
        echo "@check=imagem|falha|o container do painel não roda a imagem tws-panel:latest"
      elif [ "${inicio:-0}" -gt 0 ]; then
        if [ "$img_criada" -ge "$inicio" ]; then
          echo "@check=imagem|ok|o container do painel roda a imagem construída nesta atualização"
        else
          echo "@check=imagem|ok|o container do painel roda a imagem atual (o código da imagem não mudou; o build reaproveitou o cache)"
        fi
      else
        commit_na_hora="$(g rev-parse --verify --quiet "HEAD@{$(date -u -d "$img_criada_iso" '+%Y-%m-%d %H:%M:%S +0000' 2>/dev/null)}" 2>/dev/null || true)"
        if [ -n "$commit_na_hora" ] && [ "$(g rev-parse "$commit_na_hora^{tree}")" = "$(g rev-parse "HEAD^{tree}")" ]; then
          echo "@check=imagem|ok|a imagem do painel foi construída a partir do mesmo código do commit atual"
        else
          echo "@check=imagem|falha|a imagem do painel é anterior ao código atual da pasta (rode a atualização)"
        fi
      fi
      # 3. saúde do container (HEALTHCHECK do Dockerfile)
      local saude="" t=0
      while [ "$t" -le "$espera" ]; do
        saude="$(docker inspect -f '{{.State.Health.Status}}' tws-panel 2>/dev/null || echo ausente)"
        [ "$saude" = healthy ] || [ "$saude" = unhealthy ] || [ "$saude" = ausente ] && break
        sleep 5; t=$((t + 5))
      done
      if [ "$saude" = healthy ]; then
        echo "@check=saude|ok|container do painel healthy"
      else
        echo "@check=saude|falha|container do painel: ${saude:-sem estado}"
      fi
      # 4. nenhum container paas-* (nem o painel) reiniciando: estado e contador de reinícios em duas leituras
      local nomes antes depois reiniciando=""
      nomes="$( { echo tws-panel; docker ps -a --format '{{.Names}}' | grep '^paas-' || true; } | sort -u)"
      antes="$(for n in $nomes; do printf '%s %s\n' "$n" "$(docker inspect -f '{{.RestartCount}}' "$n" 2>/dev/null || echo 0)"; done)"
      sleep "${TWS_SANDBOX_INTERVALO_REINICIO:-10}"
      depois="$(for n in $nomes; do printf '%s %s\n' "$n" "$(docker inspect -f '{{.RestartCount}}' "$n" 2>/dev/null || echo 0)"; done)"
      for n in $nomes; do
        local estado
        estado="$(docker inspect -f '{{.State.Status}}' "$n" 2>/dev/null || echo ausente)"
        if [ "$estado" = restarting ] || [ "$(printf '%s\n' "$antes" | awk -v n="$n" '$1==n{print $2}')" != "$(printf '%s\n' "$depois" | awk -v n="$n" '$1==n{print $2}')" ]; then
          reiniciando="$reiniciando $n"
        fi
      done
      local qtd
      qtd="$(printf '%s\n' "$nomes" | grep -c . || true)"
      if [ -z "$reiniciando" ]; then
        echo "@check=reinicios|ok|$qtd container(s) do painel (tws-panel e paas-*), nenhum reiniciando"
      else
        echo "@check=reinicios|falha|reiniciando:$reiniciando"
      fi
      # 5. logs do painel desde a subida: nenhuma linha de erro (pino: level 50 = error, 60 = fatal)
      local subida erros
      subida="$(docker inspect -f '{{.State.StartedAt}}' tws-panel 2>/dev/null || true)"
      if [ -n "$subida" ]; then
        erros="$(docker logs --since "$subida" tws-panel 2>&1 | grep -E '"level":(50|60)[,}]|^(Error|TypeError|ReferenceError|SyntaxError|Unhandled)' || true)"
        if [ -z "$erros" ]; then
          echo "@check=logs|ok|nenhum erro no log do painel desde a subida"
        else
          echo "@check=logs|falha|$(printf '%s\n' "$erros" | grep -c .) linha(s) de erro no log do painel desde a subida"
          echo "Primeiras linhas de erro (só para o terminal, não copie para o PR):"
          printf '%s\n' "$erros" | head -n 5 | cut -c1-300
        fi
      else
        echo "@check=logs|falha|container do painel ausente"
      fi
      # 6. endereço público que o próprio painel informa: o domínio próprio, se o acesso pelo IP foi desativado
      # (data/panel-domain.json, igual ao instalador); senão o PAAS_PANEL_DOMAIN do .env. Acesso por túnel: só
      # dá para conferir por dentro da VPS.
      local acesso dominio json porta
      acesso="$(sed -n 's/^PAAS_ACCESS=//p' "$dir/.env" 2>/dev/null | tail -n 1)"
      dominio="$(sed -n 's/^PAAS_PANEL_DOMAIN=//p' "$dir/.env" 2>/dev/null | tail -n 1)"
      json="$(docker exec tws-panel cat /data/panel-domain.json 2>/dev/null || true)"
      if printf '%s' "$json" | grep -q '"ipAccessDisabled": true' && printf '%s' "$json" | grep -q '"active": true'; then
        dominio="$(printf '%s\n' "$json" | sed -n 's/^  "domain": "\([a-z0-9.-]*\)",$/\1/p' | head -n 1)"
      fi
      if [ "$acesso" = tunel ] || [ -z "$dominio" ]; then
        porta="$(sed -n 's/^PAAS_PORT=//p' "$dir/.env" 2>/dev/null | tail -n 1)"
        echo "@endereco="
        local caminho codigo
        for caminho in /api/healthz /login; do
          codigo="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:${porta:-9000}$caminho" 2>/dev/null || echo 000)"
          if [ "$codigo" = 200 ]; then
            echo "@check=http$caminho|ok|$caminho respondeu 200 por dentro da VPS (acesso por túnel)"
          else
            echo "@check=http$caminho|falha|$caminho respondeu $codigo por dentro da VPS (acesso por túnel)"
          fi
        done
      else
        echo "@endereco=$dominio"
      fi
      ;;

    *) echo "@erro=modo desconhecido: $modo"; exit 2 ;;
  esac
}
principal "$@"
REMOTO
}

# Roda um modo do script remoto no destino. Os argumentos viram texto da linha de comando remota: cada um
# tem de ser só letras, números e . _ / - (os valores vindos do destino são validados antes de chegar aqui,
# e esta conferência é a segunda barreira).
remoto() {
  local a
  for a in "$@"; do
    [[ "$a" =~ ^[A-Za-z0-9._/-]+$ ]] || sair 2 "argumento recusado para o destino (caractere fora de letras, números, . _ / -)."
  done
  local args="$*"
  ssh -T -o BatchMode=yes -o ConnectTimeout=20 "$TWS_SANDBOX_SSH" \
    "if [ \"\$(id -u)\" = 0 ]; then bash -s -- $args; else sudo -n bash -s -- $args; fi" < <(script_remoto)
}

# Valor de uma chave @chave= na saída do destino.
valor() { sed -n "s/^@$1=//p" "$2" | tail -n 1; }

# -----------------------------------------------------------------------------
# Argumentos
# -----------------------------------------------------------------------------
for arg in "$@"; do
  case "$arg" in
    --avancar) AVANCAR=1 ;;
    --preparar=*) PREPARAR="${arg#--preparar=}" ;;
    --preparar) sair 2 "--preparar precisa do nome da máquina de testes: --preparar=<nome> (o hostname do destino)." ;;
    --so-validar) SO_VALIDAR=1 ;;
    --script-remoto) script_remoto; exit 0 ;; # usado pelos testes
    -h|--help) ajuda; exit 0 ;;
    *) sair 2 "argumento desconhecido: $arg (veja --help)" ;;
  esac
done

[ -n "${TWS_SANDBOX_SSH:-}" ] || sair 2 "defina TWS_SANDBOX_SSH com o alias do ~/.ssh/config da VPS de testes (nunca a produção)."
# Só o alias: começando com "-" o ssh leria o valor como opção (ex.: -oProxyCommand roda comando local).
[[ "$TWS_SANDBOX_SSH" =~ ^[A-Za-z0-9][A-Za-z0-9._@-]*$ ]] || sair 2 "TWS_SANDBOX_SSH deve ser só o alias do ~/.ssh/config (letras, números, . _ - @; sem começar com -)."
[[ "$DESTINO_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || sair 2 "TWS_SANDBOX_DIR inválido (caminho absoluto, sem espaço)."
[[ -z "$PREPARAR" || "$PREPARAR" =~ ^[A-Za-z0-9._-]+$ ]] || sair 2 "--preparar=<nome>: só letras, números, . _ -"
[[ "$ESPERA" =~ ^[0-9]+$ ]] || sair 2 "TWS_SANDBOX_ESPERA deve ser um número de segundos."
[ "$SO_VALIDAR" = 0 ] || [ "$AVANCAR" = 0 ] || sair 2 "--so-validar não combina com --avancar."
[ "$SO_VALIDAR" = 0 ] || [ -z "$PREPARAR" ] || sair 2 "--so-validar não combina com --preparar."
git rev-parse --git-dir >/dev/null 2>&1 || sair 2 "rode de dentro de um clone do repositório."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# -----------------------------------------------------------------------------
# a) sandbox × dev no origin, e o ci da dev verde no commit
# -----------------------------------------------------------------------------
log "Buscando dev, sandbox e main no origin…"
git fetch --quiet origin dev sandbox main
DEV="$(git rev-parse origin/dev)"
SANDBOX="$(git rev-parse origin/sandbox)"

ci_verde() { # imprime a URL do run; falha se o ci do push da dev nesse commit não estiver verde
  local sha="$1" linha estado conclusao url
  linha="$(gh run list --workflow ci.yml --branch dev --event push --commit "$sha" --limit 1 \
    --json status,conclusion,url --jq '.[0] // empty | [.status, .conclusion, .url] | @tsv')" \
    || sair 2 "não consegui consultar o GitHub Actions (gh autenticado?)."
  [ -n "$linha" ] || sair 2 "nenhum run do ci para o push da dev no commit ${sha:0:12}."
  IFS=$'\t' read -r estado conclusao url <<<"$linha"
  [ "$estado" = completed ] || sair 2 "o ci da dev no commit ${sha:0:12} ainda não terminou ($estado): $url"
  [ "$conclusao" = success ] || sair 2 "o ci da dev no commit ${sha:0:12} não está verde ($conclusao): $url"
  printf '%s\n' "$url"
}

if [ "$SO_VALIDAR" = 1 ]; then
  ALVO="$SANDBOX"
  CI_URL="(não conferido: --so-validar)"
  [ "$SANDBOX" = "$DEV" ] || log "Aviso: a origin/sandbox (${SANDBOX:0:12}) não é a origin/dev (${DEV:0:12}); validando a sandbox."
else
  if [ "$SANDBOX" != "$DEV" ]; then
    if git merge-base --is-ancestor "$SANDBOX" "$DEV"; then
      [ "$AVANCAR" = 1 ] || sair 2 "a sandbox (${SANDBOX:0:12}) está atrás da dev (${DEV:0:12}). Rode com --avancar para avançá-la por fast-forward."
    elif git merge-base --is-ancestor "$DEV" "$SANDBOX"; then
      sair 2 "a sandbox (${SANDBOX:0:12}) está À FRENTE da dev: tem commit que não passou pela dev. Nada foi feito."
    else
      sair 2 "a sandbox e a dev divergiram. Nada foi feito; a sandbox só avança por fast-forward."
    fi
  fi
  CI_URL="$(ci_verde "$DEV")"
  log "ci da dev verde no commit ${DEV:0:12}."
  if [ "$SANDBOX" != "$DEV" ]; then
    # Com o PR de lançamento aberto a sandbox fica parada: avançar mudaria o PR depois da validação.
    PR_ABERTO="$(gh pr list --base main --head sandbox --state open --json number --jq '.[0].number // empty')" \
      || sair 2 "não consegui consultar os PRs abertos (gh autenticado?)."
    [ -z "$PR_ABERTO" ] || sair 2 "o PR #$PR_ABERTO (sandbox → main) está aberto: a sandbox não avança até ele ser mesclado ou fechado."
    log "Avançando a sandbox de ${SANDBOX:0:12} para ${DEV:0:12} (fast-forward)…"
    # O commit já passou pelo ci na dev; o pre-push local (suíte inteira) não acrescenta nada aqui.
    PAAS_SKIP_PREPUSH=1 git push --quiet origin "$DEV:refs/heads/sandbox"
    git fetch --quiet origin sandbox
    SANDBOX="$(git rev-parse origin/sandbox)"
    [ "$SANDBOX" = "$DEV" ] || sair 2 "a sandbox não ficou igual à dev depois do push."
  fi
  ALVO="$SANDBOX"
fi
git merge-base --is-ancestor origin/main "$ALVO" \
  || log "Aviso: a main tem commits que a sandbox não tem. Falta o retorno main → dev depois do último lançamento?"

# -----------------------------------------------------------------------------
# b) trava de segurança no destino (e a troca de branch, só com --preparar)
# -----------------------------------------------------------------------------
log "Lendo o estado da instalação no destino…"
remoto estado "$DESTINO_DIR" >"$TMP/estado" || sair 2 "não consegui ler o destino ($(valor erro "$TMP/estado"))."
BRANCH="$(valor branch "$TMP/estado")"
UPSTREAM="$(valor upstream "$TMP/estado")"

if [ -n "$PREPARAR" ]; then
  rc=0
  remoto preparar "$DESTINO_DIR" "$ALVO" "$PREPARAR" >"$TMP/preparar" || rc=$?
  [ "$rc" = 0 ] || sair "$rc" "--preparar recusado: $(valor erro "$TMP/preparar")"
  if [ "$(valor preparado "$TMP/preparar")" = sim ]; then
    log "Destino trocado para a branch sandbox (o commit anterior ficou numa referência refs/tws-backup/)."
  else
    log "O destino já estava na branch sandbox."
  fi
  BRANCH=sandbox; UPSTREAM=origin/sandbox
fi

if [ "$BRANCH" != sandbox ] || [ "$UPSTREAM" != origin/sandbox ]; then
  sair 3 "TRAVA: a instalação do destino está em '${BRANCH:-HEAD solto}' (upstream '${UPSTREAM:-nenhum}'), não na sandbox. Nada foi alterado. Se o destino é mesmo a VPS de testes, rode uma vez com --preparar=<hostname do destino>."
fi

# -----------------------------------------------------------------------------
# c) atualização pelo instalador (modo de atualização do guia de operações)
# -----------------------------------------------------------------------------
INICIO=""
DURACAO=""
if [ "$SO_VALIDAR" = 0 ]; then
  log "Atualizando a VPS de testes pelo instalador (pode levar alguns minutos)…"
  rc=0
  # A saída do instalador aparece ao vivo (sem as linhas @ do protocolo); pipefail: rc é o do destino.
  remoto atualizar "$DESTINO_DIR" | tee "$TMP/atualizar" | { grep -v '^@' >&2 || true; } || rc=$?
  # O que vem do destino é dado, não comando: só número passa (o INICIO volta na linha de comando remota).
  INICIO="$(valor inicio "$TMP/atualizar")"
  DURACAO="$(valor duracao "$TMP/atualizar")"
  [[ "$INICIO" =~ ^[0-9]+$ ]] || INICIO=0
  [[ "$DURACAO" =~ ^[0-9]+$ ]] || DURACAO=""
  case "$rc" in
    0) log "Instalador concluído em ${DURACAO:-?} s." ;;
    3) sair 3 "TRAVA no destino: $(valor erro "$TMP/atualizar")" ;;
    4) sair 4 "$(valor erro "$TMP/atualizar"). Nada foi atualizado: veja o relatório do pré-flight na saída acima e resolva o conflito na VPS de testes. Este script não força (--force) nem responde a pergunta." ;;
    *) sair 5 "a atualização falhou: $(valor erro "$TMP/atualizar")" ;;
  esac
fi

# -----------------------------------------------------------------------------
# d) validação
# -----------------------------------------------------------------------------
log "Validando o destino…"
remoto validar "$DESTINO_DIR" "$ALVO" "${INICIO:-0}" "$ESPERA" >"$TMP/validar" || sair 1 "a validação no destino falhou ($(valor erro "$TMP/validar"))."
grep -v '^@' "$TMP/validar" >&2 || true
{ grep '^@check=' "$TMP/validar" || true; } | sed 's/^@check=//' >"$TMP/checks"
[ -s "$TMP/checks" ] || echo "destino|falha|o destino não devolveu nenhuma verificação" >"$TMP/checks"

ENDERECO="$(valor endereco "$TMP/validar")"
# Só nome de host (letras, números, pontos e hífens): o valor vem do destino e vai para a URL do curl.
if [ -n "$ENDERECO" ] && ! [[ "$ENDERECO" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]]; then
  echo "endereco|falha|o destino informou um endereço público que não é um nome de host válido" >>"$TMP/checks"
  ENDERECO=""
fi
if [ -n "$ENDERECO" ]; then
  # HTTP pelo endereço público, a partir desta máquina (de fora da VPS). O endereço não é impresso.
  for caminho in /api/healthz /login; do
    codigo=000; t=0
    while :; do
      codigo="$(curl --globoff -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://$ENDERECO$caminho" 2>/dev/null || true)"
      [ "$codigo" = 200 ] && break
      [ "$t" -ge "$ESPERA" ] && break
      sleep 5; t=$((t + 5))
    done
    if [ "$codigo" = 200 ]; then
      echo "http$caminho|ok|$caminho respondeu 200 pelo endereço público do painel (HTTPS)" >>"$TMP/checks"
    else
      echo "http$caminho|falha|$caminho respondeu ${codigo:-000} pelo endereço público do painel" >>"$TMP/checks"
    fi
  done
fi

# -----------------------------------------------------------------------------
# e) resumo (pronto para o corpo do PR sandbox → main; sem IP nem host)
# -----------------------------------------------------------------------------
FALHAS="$(grep -c '|falha|' "$TMP/checks" || true)"
{
  echo
  echo "## Validação na VPS de testes"
  echo
  echo "- Commit: \`${ALVO:0:12}\` (origin/sandbox$([ "$ALVO" = "$DEV" ] && echo " = origin/dev"))"
  echo "- ci da dev nesse commit: ${CI_URL}"
  if [ "$SO_VALIDAR" = 0 ]; then
    echo "- Atualização: instalador no modo de atualização, concluído em ${DURACAO:-?} s"
  else
    echo "- Atualização: não executada (só validação)"
  fi
  while IFS='|' read -r nome estado detalhe; do
    [ -n "$nome" ] || continue
    if [ "$estado" = ok ]; then echo "- [x] $detalhe"; else echo "- [ ] FALHOU ($nome): $detalhe"; fi
  done <"$TMP/checks"
  echo
  echo "Commits que entram na main:"
  echo
  git log --no-merges --format='- %h %s' "origin/main..$ALVO" | head -n 50
  echo
  if [ "$FALHAS" = 0 ]; then echo "Resultado: tudo validado."; else echo "Resultado: $FALHAS verificação(ões) falharam."; fi
}

[ "$FALHAS" = 0 ] || exit 1
