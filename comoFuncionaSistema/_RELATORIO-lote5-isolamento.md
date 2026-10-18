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

## Revisão rigorosa — correções (A1, A4 e M9 reprovados na primeira rodada)

Cada contorno abaixo ganhou um teste hostil que falhou antes (no `compose-model.ts` anterior: 44 dos 58 testes de
`compose-model-fechado.test.ts`; no `engine.ts` anterior: 9 dos 12 de `engine-canonico.test.ts`; 3 de 3 em
`container-identity.test.ts`; 5 de 5 em `engine-endurecimento.test.ts`) e passa agora.

1. **A1, lista fechada** (`compose-model-fechado.test.ts`). Antes: lista de campos perigosos; `use_api_socket`, `gpus`,
   `runtime`, `cgroup_parent`, `label_file`, `deploy.resources.reservations.devices` e ganchos `post_start`/`pre_stop`/
   `pre_start` com `privileged` passavam com 0 bloqueios. Agora: lista de campos ACEITOS por nível (serviço, `deploy`,
   `resources`, ganchos, topo); campo desconhecido bloqueia (`unsupported-field`, overridável); os campos que dão
   acesso ao host têm bloqueio próprio; ganchos passam pela mesma checagem por recursão; `logging.driver` só
   `json-file`/`local`/`none`. `x-*` segue livre.
2. **A1, app sequestrado.**
   - Bind dentro de bind gravável (`./:/app` + `./dados:/data`, no mesmo serviço ou em serviços diferentes) é barrado
     (`host-mount`); pai `:ro` e pastas irmãs passam.
   - Corrida entre `config` e `up`: o modelo conferido é gravado em `<projeto>/paas.canonical.json` (0600, fora do
     `src`) e o `up` roda dele (`engine-canonico.test.ts`: o compose do repositório trocado depois do `config` não chega
     ao `up`). `compose-hostil-docker.test.ts` confere com o `docker compose config` real que o JSON volta igual.
     Limite honesto: `env_file` e contexto de build ficam no JSON como caminhos; um link trocado nesses milissegundos
     ainda seria seguido (o bind, que persistia, está fechado).
3. **A2, `.env`.** `.env` e arquivo compose precisam ser arquivos comuns com caminho real dentro de `src`; link (para
   fora ou para dentro) para o deploy e o recriar antes de qualquer `docker compose`. O `up` usa `--env-file` vazio do
   painel, nunca o `.env` de `src`.
4. **A4, `paas-mail`.** Em projeto com e-mail, nome de serviço, `container_name`, `hostname` e todo alias de qualquer
   rede não podem ser nomes reservados, `paas-*`/`tws-*`, slug de outro projeto, `mail.*` nem host que o Stalwart
   responde (o engine passa `mailHosts()`); é `network-hijack` (regra dura). Entrou no meta-teste de `HARD_RULES`,
   que agora aceita vários hostis por regra.
5. **A4, override do painel.** `cap_drop: NET_RAW` e `no-new-privileges` em TODOS os serviços (aplicado ao modelo
   resolvido, então cobre `include`/`extends`) e no `docker run` do estático e do Dockerfile. Migração:
   `CaddyManager.reservedAliases` + aviso no boot (`DeployService.warnReservedNetworkAliases`) de containers antigos na
   `paas-net` com alias do painel; só avisa e mostra o comando para tirá-los.
6. **M9.** O `docker run` do painel grava `com.docker.compose.project=` vazia (vence o `LABEL` da imagem) e
   `containerIdentity` trata vazia como ausente: a identidade vem só do que o painel registrou.
7. **Regras duras que faltavam.** `panel-resource` (nova, sem override): `docker.sock` em qualquer grafia (inclui `//`,
   `..`, `/run`, `/proc/self/root`, maiúsculas e link dentro do `src`) e volumes/redes `paas*`/`tws*` que não são do
   projeto (`paas_data` etc.). `paas-panel` e `paas-mail-admin` já eram `network-hijack`. A mensagem antiga do
   `docker.sock` ("privileged-container", overridável) foi trocada.
8. **Roteiro da VPS e volta:** `docs/migracao-redes-lote5.md`. Resumo honesto da volta: o Caddy antigo religa o painel à
   `paas-net` sozinho (acesso por domínio); o Stalwart antigo só volta à `paas-net` se houver `mail.<domínio>` (senão
   `docker network connect` manual, com os aliases); o webmail antigo não religa (manual). Texto de status do
   servidor nunca criado agora mostra a imagem por digest (`STALWART_IMAGE_REF`).

Efeitos para o operador: campo novo ou desconhecido no compose passa a ser barrado (com override, exceto nas regras
duras); bind aninhado, volume `paas_*` e `docker.sock` deixam de existir como opção; `ping`/raw sockets e `sudo`/setuid
dentro dos containers deixam de funcionar (sem `NET_RAW` e com `no-new-privileges`).

## Resultados

- `pnpm -r run typecheck`: sem erros.
- Cobertura (valores medidos nesta rodada): core 99,63 / 98,73; deploy 98,62 / 95,8 de ramos (mínimo 95); mailer 99,9 /
  98,45 de ramos (mínimo 98); security 99,33 / 97,33; server 97,9 / 93,5 / 98,34 / 98,86 (mínimos 94/91/98/94). O
  deploy só imprime a tabela com `--coverage.reportOnFailure` enquanto os testes de Docker falham.
- Testes que falham na máquina por causa do Docker Desktop travado (`docker info` sem resposta; não é código):
  `engine-lifecycle` (4), `engine-guardrail-reuse` (1), `docker-service` (2, Docker real) e `routes-misc-schema` (1).
  Todos os que não dependem do Docker passam (deploy 678 de 683, server 1778 de 1785 com 4 ignorados). Passaram antes
  da pane e passam isolados quando o Docker responde; não foi possível rodá-los de novo nesta rodada.

## Não testado (declarado)

- **A4 no Docker real:** a criação das redes novas, a migração em instalação viva (painel saindo da
  `paas-net` depois do reload, Stalwart/webmail/projetos trocando de rede) e a ordem real dos `docker network
  connect/disconnect` foram testadas só com dublês do Docker. O Docker Desktop travou no fim do lote (`docker ps`
  sem resposta, também para outra sessão na máquina) e este ambiente tem o pool de endereços de rede esgotado
  (`docker network create` precisa de `--subnet`). Validar numa VPS antes de promover.
- `trustProxy` com o IP real do Caddy: testado com Fastify e IPs simulados; a leitura por `docker inspect` não
  foi exercitada no container do painel.
- Fluxo completo de e-mail (projeto enviando por SMTP pela `paas-mail`) não foi rodado de ponta a ponta.
- `docker compose up` a partir do `paas.canonical.json`: só o `config` do JSON foi exercitado com o compose real
  (ida e volta igual); o `up` real, o `docker run` com `--cap-drop NET_RAW --security-opt no-new-privileges
  --label com.docker.compose.project=` e a prevalência da label vazia sobre o `LABEL` de uma imagem forjada foram
  verificados só pelos argumentos nos testes (a prevalência é o comportamento documentado do `docker run --label`).
- O roteiro de `docs/migracao-redes-lote5.md` (e a volta à versão anterior) foi escrito lendo o código das duas
  versões, não executado: Docker travado na máquina e nenhuma VPS à mão. O ponto "o git da versão antiga segue o
  apontador `src/.git`" também não foi testado.
- Reexecução dos testes que dependem do Docker (engine-lifecycle, engine-guardrail-reuse, docker-service,
  routes-misc-schema): o Docker continuou sem responder; não deu para tentar reiniciá-lo sem sair do escopo.

## Riscos residuais

- Serviços de projetos com e-mail habilitado alcançam o Stalwart inteiro pela `paas-mail` (portas de SMTP/IMAP
  e também a API de administração, 8080), protegido só pela senha; antes era igual para TODOS os projetos. Hoje
  entram na rede todos os serviços do compose (os que recebem o `SMTP_*`), não só o que envia e-mail.
- O webmail continua acessível pelo Caddy; ele fica fora da `paas-net`, mas na `paas-mail` com o Stalwart.
- Digest fixo exige atualização manual (tag e digest juntos) para receber correções das imagens.
- Janela do `trustProxy` após recriar o Caddy: até a releitura, o IP registrado é o do Caddy (nunca um IP forjado).
- Arquivo solto criado por engano fora do worktree: `/tmp/claude-1000/-home-kelvin/placeholder.txt` (vazio de
  significado, pode apagar).
