# Relatório — Lote 5: isolamento entre projeto hospedado e host

Data: 2026-10-17 · Branch: `fix/lote5-isolamento` (a partir de `origin/dev`) · Sem push, sem PR.

Achados tratados: A1 (guardrails sobre o compose resolvido), A2 (git e `.env` do painel), A3 (imagens por
digest), A4 (redes separadas e `trustProxy`), M8 (saída do build estático), M9 (labels forjadas) e os dois
pontos da revisão (posse por nome exato; regras duras aplicadas de verdade).

Método: para cada achado, teste hostil que falha pelo motivo certo no código antigo, depois a correção
mínima. Onde havia Docker, a validação foi no Docker real; o que não deu para validar está em "Não testado".

## Causa comum

O painel confiava no que o projeto hospedado declara (compose, repositório, saída do build, labels) e
rodava o resultado com privilégio (host bridge, Caddy, Stalwart) ou na mesma rede do painel. A correção é
sempre: decidir por uma LISTA DO QUE SE PERMITE, sobre o que o Docker de fato executa, e nunca confiar em
nome, label ou caminho que o projeto controla.

## A1 — compose conferido como o Docker o executa

- **Era:** os guardrails liam o YAML cru por lista de proibições. Merge `<<`, `include:`, `extends:`,
  `${VAR:-true}` e caminhos relativos escapavam.
- **Teste que reproduz:** `packages/deploy/tests/guardrails-hostil.test.ts` (compose hostil por
  vetor) e `compose-hostil-docker.test.ts` (os mesmos pelo `docker compose config` real, com fixtures em
  `tests/fixtures/hostil/`). Falhavam no `rules.ts` antigo (7 de 10).
- **Mudou:** `compose-model.ts` (lista do que se permite) roda em dois modos: cru (prévia) e canônico (saída
  de `docker compose config --format json --no-env-resolution`, mesmos `-p`/`--env-file`/`-f` do `up`),
  no engine antes de qualquer `up` (deploy e recriar; o recriar não aceita override). O ambiente do
  compose é filtrado (`composeEnv`): `SETUP_TOKEN` e demais segredos não chegam à interpolação.
- **Testado de verdade:** `docker compose config` real com merge, include, extends, interpolação e
  caminhos que sobem da pasta; vazamento de `${SETUP_TOKEN}` (chega vazio).
- **Risco de migração:** composes que dependiam de `privileged`, bind fora da pasta, volume externo etc. passam
  a ser bloqueados (com override do operador, exceto nas regras duras). Variável obrigatória faltando mantém a
  mesma mensagem.

## A2 — git do painel e `.env`

- **Era:** o `.git` ficava dentro de `src` (hooks e `.git/config` do repositório hospedado rodavam no painel);
  `.env` e arquivo de exclusão eram gravados seguindo link simbólico.
- **Teste que reproduz:** `ingest-hostil.test.ts` (hook e `core.fsmonitor` criam um sentinela no código
  antigo), `project-dotenv-links.test.ts` (8 de 13 falhavam no antigo).
- **Mudou:** repositório do painel em `<projeto>/repo.git` (`--git-dir`/`--work-tree` explícitos; `src/.git`
  vira apontador); git com `core.hooksPath=/dev/null`, `fsmonitor` desligado, sem config de sistema/usuário,
  `protocol.ext` desligado, fonte que começa com `-` recusada; atualização por `fetch` + `merge --ff-only`;
  `.env` e exclusão por `writeFileNoFollow`/`appendNoFollow` (arquivo temporário `O_EXCL|O_NOFOLLOW` + rename).
- **Migração:** projetos antigos com `src/.git` são convertidos na próxima atualização, sem reclonar; arquivos
  não versionados (dados, `.env`) são preservados.

## A3 — imagens do painel fixadas por digest

- **Era:** `docker compose up --build` de um projeto com `image: alpine:3` regravava a tag local; o painel
  rodava como root (helper `--privileged --pid=host`) o binário do projeto.
- **Teste que reproduz:** `compose-model-isolamento.test.ts` (build que grava tag do painel; `paas-*`/`tws-panel`
  de outro projeto), `packages/core/tests/images.test.ts` (todas as referências têm `@sha256:` completo),
  `docker-socket.test.ts` (pull por digest), `host-bridge.test.ts`.
- **Mudou:** `packages/core/src/images.ts` (helper, Caddy, Stalwart, build Node, servidor estático) e as duas
  linhas `FROM` do `Dockerfile`; `ensureImage` entende `repo:tag@sha256`; regra dura `panel-image`.
- **Testado de verdade (Docker real):** reconstruí `alpine:3` localmente com uma label diferente; a tag passou
  a apontar para a imagem do atacante, e `alpine:3@sha256:294b683c…` continuou rodando a original.
- **Atualizar uma imagem:** trocar tag E digest juntos (`docker buildx imagetools inspect <tag> --format
  '{{.Manifest.Digest}}'`). A primeira instalação precisa baixar as imagens por digest (acesso ao registro).

## A4 — redes separadas e `trustProxy`

- **Era:** painel, Stalwart, webmail e projetos na mesma `paas-net`; `trustProxy: true`.
- **Teste que reproduz:** `compose-model-isolamento.test.ts` (alias e ligação indevidos à rede do painel),
  `trusted-proxies.test.ts` (par desconhecido forjando `X-Forwarded-For`), `server-manager.test.ts`,
  `webmail.test.ts`, `caddy-manager.test.ts`, `compose-override.test.ts`, `engine-compose-guardrails.test.ts`.
- **Mudou:**
  - `paas-net`: Caddy + projetos. `paas-panel`: só Caddy ↔ painel. `paas-mail-admin`: só painel ↔ Stalwart.
    `paas-mail`: Stalwart, webmail e serviços de projetos com e-mail habilitado.
  - O override do painel liga os serviços de e-mail à `paas-mail` só com `SMTP_HOST` injetado; o modo Dockerfile
    usa `docker network connect`.
  - Compose do usuário não liga nada às redes do painel (regra dura `network-hijack`); só o serviço web entra na
    `paas-net`, e só com o alias do slug.
  - `trustProxy` aceita o cabeçalho só do Caddy (IPs lidos do container, relidos a cada minuto e quando chega
    um par privado desconhecido) e do loopback.
- **Migração de instalação existente (sem recriar container):**
  1. Caddy entra na `paas-panel`, painel entra nela; só DEPOIS do reload o painel sai da `paas-net`
     (em acesso por túnel, sai na hora).
  2. 1 min depois do boot (`routes/mail.ts` → `migrateMailNetworks`, repetido a cada rodada até dar certo):
     Stalwart entra em `paas-mail-admin` e `paas-mail`; painel entra em `paas-mail-admin`; containers dos
     projetos com e-mail entram na `paas-mail`; webmail muda para `paas-panel` + `paas-mail`; por último o
     Stalwart sai da `paas-net`.
  3. Falha em um projeto ou no webmail é avisada no log e não impede o fim; o próximo deploy liga o projeto
     pelo override. Se o Stalwart não entrar nas redes novas, nada sai de lugar.
- **Risco de migração:** janela de segundos em que o IP do Caddy/painel muda de rede; projeto com e-mail cujo
  container não pôde ser ligado fica sem SMTP até o próximo deploy; enquanto o painel não for reiniciado/o
  boot não rodar, tudo segue como antes (nada piora). `scripts/uninstall.sh` e a doc de e-mail conhecem as redes novas.

## M8 — saída do build estático

- **Era:** a pasta de saída podia ser link simbólico para fora do projeto; o nginx a montava e servia.
- **Teste que reproduz:** `engine-static-link.test.ts` (link para outro projeto, link no meio do caminho).
- **Mudou:** a saída precisa ser diretório real cujo caminho real está dentro de `src`; o nginx recebe uma
  CÓPIA em `<projeto>/site`, sem links.

## M9 — labels forjadas

- **Era:** `LABEL paas.project=<outro>` na imagem (ou no compose) fazia o painel tratar o container como de
  outro projeto (parar, remover, backup, listagem).
- **Teste que reproduz:** `container-identity.test.ts`, `engine-containers-forjados.test.ts`,
  `docker-service.test.ts` (bloco `classifyContainer`).
- **Mudou:** `containerIdentity` (core): o dono vem de `com.docker.compose.project` (o compose grava por cima
  das labels da imagem); `paas.project` só vale em container sem label do compose e com `paas.managed=true`.
  `engine.projectContainers` e `classifyContainer` usam essa regra; backups herdam de `classifyContainer`.
  O compose do usuário também não pode declarar `paas.*`/`com.docker.compose.*` (regra dura `reserved-name`).

## Pontos da revisão (coordenador)

1. **Posse por nome exato (ALTA).** `ownedByProject` aceitava os prefixos `<projeto>_` e `<projeto>-`: o projeto
   "app" "possuía" "app-outro". Agora só vale o nome que o compose geraria (`<projeto>_<chave>`); a alternativa
   com hífen foi removida (o compose não a gera).
   - Teste: `compose-model-isolamento.test.ts`, bloco "posse por nome EXATO" (projetos app, app-outro, app_x não
     tocam recursos um do outro). Contra o `compose-model.ts` anterior, 14 dos 17 testes do arquivo falhavam.
2. **Regras duras de verdade (MÉDIA).** `reserved-name`, `network-hijack` e `panel-image` estavam declaradas e
   só parcialmente aplicadas (um `continue` liberava a rede do painel quando `external`). Agora:
   - `container_name`, `hostname`, nome do serviço web e aliases fora do espaço do projeto, ou iguais a nomes
     do painel/de outro projeto, são recusados; labels `paas.*` e `com.docker.compose.*` também.
   - Só o override do painel liga serviço à `paas-net`, sem aliases do usuário; a declaração da `paas-net`
     só vale externa e sem driver/ipam.
   - Sem override do operador, no deploy e no recriar (`engine-compose-guardrails.test.ts`).
   - Cada regra de `HARD_RULES` tem um compose hostil e um meta-teste garante que nenhuma fica sem teste.
   - Bug achado no caminho: lista de imagens do painel com entrada indefinida derrubava a análise inteira
     (virava `invalid-compose`); corrigido com teste.

## Resultados

- `pnpm -r run typecheck`: sem erros.
- Cobertura (valores medidos): core 99,63 / 98,73; deploy 98,87 / 96,11 de ramos (mínimo 95); mailer 99,9 / 98,45 de
  ramos (mínimo 98); security 99,33 / 97,33; server 97,9 / 93,5 / 98,34 / 98,86 (mínimos 94/91/98/94).
- Testes que falham na máquina por causa do Docker Desktop travado (não por código): `engine-lifecycle` (4),
  `engine-guardrail-reuse` (1), `docker-service` (2, Docker real), `routes-misc-schema` (1) e, de forma
  intermitente, `compose-hostil-docker` (o plugin `docker compose` some: "unknown shorthand flag: 'p'").
  Passaram antes da pane e passam isolados quando o Docker responde.

## Não testado (declarado)

- **A4 no Docker real:** a criação das redes novas, a migração em instalação viva (painel saindo da
  `paas-net` depois do reload, Stalwart/webmail/projetos trocando de rede) e a ordem real dos `docker network
  connect/disconnect` foram testadas só com dublês do Docker. O Docker Desktop travou no fim do lote (`docker ps`
  sem resposta, também para outra sessão na máquina) e este ambiente tem o pool de endereços de rede esgotado
  (`docker network create` precisa de `--subnet`). Validar numa VPS antes de promover.
- `trustProxy` com o IP real do Caddy: testado com Fastify e IPs simulados; a leitura por `docker inspect` não
  foi exercitada no container do painel.
- Fluxo completo de e-mail (projeto enviando por SMTP pela `paas-mail`) não foi rodado de ponta a ponta.

## Riscos residuais

- Serviços de projetos com e-mail habilitado alcançam o Stalwart inteiro pela `paas-mail` (portas de SMTP/IMAP
  e também a API de administração, 8080), protegido só pela senha; antes era igual para TODOS os projetos. Hoje
  entram na rede todos os serviços do compose (os que recebem o `SMTP_*`), não só o que envia e-mail.
- O webmail continua acessível pelo Caddy; ele fica fora da `paas-net`, mas na `paas-mail` com o Stalwart.
- Digest fixo exige atualização manual (tag e digest juntos) para receber correções das imagens.
- Janela do `trustProxy` após recriar o Caddy: até a releitura, o IP registrado é o do Caddy (nunca um IP forjado).
- Arquivo solto criado por engano fora do worktree: `/tmp/claude-1000/-home-kelvin/placeholder.txt` (vazio de
  significado, pode apagar).
