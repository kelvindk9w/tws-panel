# Forma de trabalhar no TWS Panel

Este documento complementa o fluxo global de trabalho com subagentes do Claude Code (orquestrador,
`executor`, `revisor` e `guardiao-git`, definidos fora deste repositório, nas instruções e nos
agentes globais do Claude Code). Aqui fica só o que é **específico deste repositório**. Quando este
documento e as instruções genéricas dos agentes divergirem, **vale este documento**.

O estado do trabalho de longa duração fica em [`docs/plano/estado.md`](../plano/estado.md).

- [As três branches](#as-três-branches)
- [Papéis](#papéis)
- [Ciclo de uma tarefa até a dev](#ciclo-de-uma-tarefa-até-a-dev)
- [Etapa sandbox: VPS de testes](#etapa-sandbox-vps-de-testes)
- [Lançamento: PR sandbox → main](#lançamento-pr-sandbox--main)
- [Retorno da main para a dev e a sandbox](#retorno-da-main-para-a-dev-e-a-sandbox)
- [Conflitos e situações fora do normal](#conflitos-e-situações-fora-do-normal)
- [Dependabot](#dependabot)
- [O `estado.md`](#o-estadomd)
- [Retomada](#retomada)
- [Branches e worktrees](#branches-e-worktrees)
- [Comandos de verificação](#comandos-de-verificação)
- [Lista de conferência do revisor](#lista-de-conferência-do-revisor)
- [Repositório público: termos proibidos](#repositório-público-termos-proibidos)
- [Documentação do sistema](#documentação-do-sistema)
- [Não concordar por padrão](#não-concordar-por-padrão)

## As três branches

O código anda sempre no mesmo sentido: **`dev` → `sandbox` → `main`**.

| Branch | Para que serve | Como recebe código | Regra no GitHub |
|---|---|---|---|
| `dev` | Integração. Toda tarefa entra aqui. | Merge `--no-ff` da branch da tarefa, feito pelo guardião; PR de contribuidor externo mesclado com merge commit. | `protect-dev`: não pode ser apagada nem receber push forçado. |
| `sandbox` | O que roda na **VPS de testes**. | **Só fast-forward** até um commit da `dev` com o `ci` verde (e o retorno da `main`, abaixo). | `protect-sandbox`: não pode ser apagada nem receber push forçado. |
| `main` | **Produção**: o que toda instalação recebe ao atualizar. Branch padrão do repositório. | **Só por PR `sandbox → main`**, mesclado pelo Kelvin com **merge commit**. | `protect-main`: só PR, check `ci` verde, branch atualizada com a `main` e **só merge commit** (squash e rebase recusados). |

- **Por que merge commit e não squash na `main`.** O squash cria um commit novo, sem parentesco com
  a `sandbox`; a `main` e a `sandbox` divergiriam a cada lançamento. Com o merge commit, a `sandbox`
  inteira vira ancestral da `main`, e o retorno (abaixo) é um avanço simples.
- **A `main` continua a branch padrão.** O instalador clona o repositório sem escolher branch, então
  a branch padrão é o que uma instalação nova recebe. Trocar a padrão para `dev` mandaria código não
  validado para quem instala.
- **Mesclar na `main` é publicar.** O instalador (`scripts/install.sh`) acompanha a branch em que a
  pasta da instalação está: a produção está na `main`, a VPS de testes na `sandbox`. O site de
  documentação só é publicado no push da `main` (`.github/workflows/docs.yml`). Tags `v*` são só a
  marca de versão (ruleset `protect-version-tags`); criar uma é decisão do Kelvin.
- O `ci` (`.github/workflows/ci.yml`) roda no push e nos PRs das três branches.

## Papéis

- **Orquestrador** (sessão principal): planeja cada tarefa (objetivo, fora do escopo, critério de
  pronto, área de arquivos), confere que tarefas em paralelo não mexem nos mesmos arquivos, despacha
  os agentes e decide quando um lote vai para a `sandbox` e para a `main`. Não programa direto.
- **`executor`**: implementa uma tarefa numa branch própria criada da `origin/dev`, num worktree em
  `.claude/worktrees/`; commits pequenos, push da branch a cada passo, testes e verificações;
  devolve o relatório de entrega. Nunca integra.
- **`revisor`**: só lê e roda testes; compara `origin/dev...origin/<branch>` e devolve APROVADO ou
  REPROVADO com lista numerada. Até 3 reprovações; na terceira, o orquestrador escala para o Kelvin.
- **`guardiao-git`**: o único que integra (uma tarefa por vez), avança a `sandbox`, atualiza e valida
  a VPS de testes, abre o PR `sandbox → main`, faz o retorno depois do lançamento e limpa branches e
  worktrees. É também o único que edita o [`estado.md`](../plano/estado.md).
- **Kelvin**: age em **dois pontos só**: mescla o PR `sandbox → main` e, depois, roda o instalador
  na produção. **Nenhum agente roda comando na produção.** Além disso, decide o que fica pendente no
  `estado.md` (decisões, prioridades).

## Ciclo de uma tarefa até a dev

1. **Orquestrador** planeja e despacha o executor com o objetivo, o fora de escopo, o critério de
   pronto, a área de arquivos e a lista de termos proibidos (veja
   [Repositório público](#repositório-público-termos-proibidos)).
2. **Executor** cria a branch e o worktree a partir da `dev` atualizada:

   ```bash
   git fetch origin
   git worktree add -b feat/minha-tarefa .claude/worktrees/feat-minha-tarefa origin/dev
   cd .claude/worktrees/feat-minha-tarefa && pnpm install --frozen-lockfile
   ```

   Trabalha, faz commit a cada passo e envia a branch (veja
   [Branches e worktrees](#branches-e-worktrees)). Antes de entregar, roda os
   [comandos de verificação](#comandos-de-verificação) e a varredura de termos proibidos.
3. **Revisor** revisa `origin/dev...origin/<branch>` e devolve APROVADO (com o hash aprovado) ou
   REPROVADO. Reprovado: o executor corrige **na mesma branch** e entrega de novo.
4. **Guardião**, com o APROVADO, integra **num worktree da `dev`**, nunca no checkout principal (que
   é do Kelvin):

   ```bash
   git fetch origin
   test "$(git rev-parse origin/<branch>)" = <hash-aprovado>       # diferente: precisa de nova revisão
   git worktree add --detach .claude/worktrees/guardiao-dev origin/dev   # ou reaproveite: git checkout --detach origin/dev
   cd .claude/worktrees/guardiao-dev
   git merge --no-ff origin/<branch> -m "merge: <título da tarefa>"
   # roda as verificações completas (a suíte com DOCKER_HOST falso) e só então:
   git push origin HEAD:dev
   gh run list --workflow ci.yml --branch dev --limit 1   # e gh run watch <id> até ficar verde
   ```

   Conflito no merge: `git merge --abort` e a branch volta ao executor (veja
   [Conflitos](#conflitos-e-situações-fora-do-normal)). Se a tarefa tem um PR aberto contra a `dev`
   (contribuição externa, PR do Dependabot ou PR antigo redirecionado), o mesmo resultado sai de
   `gh pr merge <número> --merge` depois do APROVADO; o GitHub também marca o PR como mesclado quando
   os commits dele chegam à `dev` pelo push acima.
5. **Guardião limpa:** `git worktree remove .claude/worktrees/<branch-com-hifens>` (sem `--force`;
   recusou, pare e avise), `git worktree prune`, `git push origin --delete <branch>` (se o GitHub
   ainda não apagou) e `git branch -d <branch>`. Como a integração é por merge, o `git branch -d`
   reconhece a branch como mesclada.

A `dev` pode receber várias tarefas antes de um lançamento. Cada push na `dev` roda o `ci`; um `ci`
vermelho na `dev` bloqueia a etapa sandbox até ser corrigido (por uma tarefa `fix/` no mesmo ciclo).

## Etapa sandbox: VPS de testes

Quando o orquestrador decide lançar o que está na `dev`, o guardião leva a `dev` à `sandbox` e à VPS
de testes com o script [`scripts/processo/atualizar-sandbox.sh`](../../scripts/processo/atualizar-sandbox.sh),
rodado de dentro de qualquer clone do repositório:

```bash
TWS_SANDBOX_SSH=<alias-da-vps-de-testes> scripts/processo/atualizar-sandbox.sh --avancar > resumo.md
```

Só o **resumo** final sai na saída padrão (e vai para `resumo.md`); o andamento, a saída ao vivo do
instalador e os detalhes das falhas saem na saída de erro, no terminal. Essa saída ao vivo **mostra o
endereço do painel** (o instalador imprime a URL): ela nunca vai para o PR, só o `resumo.md`.

`TWS_SANDBOX_SSH` é um **alias do `~/.ssh/config`** da máquina de quem roda (o usuário do alias é root
ou tem sudo sem senha). O endereço, o usuário e o nome da VPS **nunca** entram no repositório. O que o
script faz, em ordem:

1. **`sandbox` × `dev`.** Com `--avancar`, se a `sandbox` está atrás da `dev`, avança a `sandbox` no
   origin por fast-forward até a `dev`, **só com o `ci` do push da `dev` verde nesse commit** e sem
   PR `sandbox → main` aberto. Sem
   `--avancar`, `sandbox` diferente da `dev` é erro. `sandbox` à frente ou divergente da `dev` é
   sempre erro (nada é feito).
2. **Trava de segurança.** No destino, a pasta da instalação (`/opt/tws-panel`, ou
   `TWS_SANDBOX_DIR`) tem de estar na branch `sandbox` seguindo a `origin/sandbox`. Em `main` ou
   qualquer outra branch, o script **recusa** (código 3): é o que impede de atualizar a produção por
   engano. Na **primeira vez** de uma VPS de testes, `--preparar=<hostname do destino>` faz a troca
   (`checkout -B sandbox origin/sandbox` com upstream), só com a árvore limpa, guardando o commit
   anterior em `refs/tws-backup/`. O nome tem de ser igual ao `hostname` do destino: é a confirmação
   de que o alias aponta para a VPS certa.
3. **Atualização** pelo instalador no modo de atualização do guia de operações
   (`cd /opt/tws-panel && sudo ./scripts/install.sh`), sem nenhuma resposta digitada e sem `--force`.
   Como a sessão é de root e a pasta é de um usuário comum, o script passa `safe.directory` ao git só
   nessa chamada (o mesmo efeito do "sudo pelo dono da pasta" que o guia manda).
4. **Validação:** o commit da pasta é o da `origin/sandbox`, sem mudança local; o container do painel
   roda a imagem que o instalador construiu (o painel não expõe o commit, só a versão do
   `package.json`); o container está `healthy`; nenhum container `tws-panel`/`paas-*` reiniciando;
   nenhum erro (nível 50 ou 60 do log) no log do painel desde a subida; `/api/healthz` e `/login`
   respondem 200 pelo **endereço público que o próprio painel informa** (lido no destino: o domínio
   próprio, se o acesso pelo IP foi desativado, senão o `PAAS_PANEL_DOMAIN` do `.env`; no acesso por
   túnel, por dentro da VPS). O endereço não é impresso.
5. **Resumo** em Markdown, pronto para o corpo do PR `sandbox → main`, sem IP nem host.

Opções: `--so-validar` (não atualiza; só valida o destino contra a `origin/sandbox`), `--help`.
Códigos de saída: `0` tudo validado; `1` alguma validação falhou; `2` uso ou pré-condição local
(sandbox atrás sem `--avancar`, `ci` não verde, divergência); `3` trava de segurança; `4` o
pré-flight do instalador achou um conflito e pediu confirmação; `5` o instalador falhou.

- **Código 4.** Numa atualização, os containers do próprio painel (proxy, e-mail, projetos) não
  contam como conflito, e o instalador não pergunta nada. Se mesmo assim ele pedir `continuar`, o
  pré-flight achou um conflito de verdade na VPS de testes (porta ocupada, serviço estranho): ele
  aborta sem mudar nada. O guardião **não contorna** (nem `--force`, nem resposta digitada): lê o
  relatório do pré-flight no terminal e avisa o orquestrador.
- **Validação falhou** (código 1): o guardião não abre o PR. Passa o resumo ao orquestrador, que
  despacha uma tarefa `fix/` pelo ciclo normal até a `dev`; depois a etapa sandbox roda de novo.
- **Enquanto o PR `sandbox → main` estiver aberto, a `sandbox` não avança.** Um avanço mudaria o
  conteúdo do PR depois da validação.

## Lançamento: PR sandbox → main

1. **Guardião** abre o PR com o `resumo.md` do script (só ele; depois de varrer título e corpo pelos
   termos proibidos):

   ```bash
   gh pr create --base main --head sandbox --title "release: <resumo do lote>" --body-file resumo.md
   gh pr checks <número> --watch
   ```

   Com o `ci` verde, avisa o Kelvin que o PR está pronto, com o link.
2. **Kelvin** mescla no GitHub com **"Create a merge commit"** (o único método que a `main` aceita).
   Não use "Update branch" nesse PR: ele criaria na `sandbox` um commit que não passou pela `dev`. Se
   o GitHub disser que a branch está desatualizada, faltou o [retorno](#retorno-da-main-para-a-dev-e-a-sandbox)
   do lançamento anterior: o guardião fecha o PR, faz o retorno na `dev`, roda a etapa sandbox de novo
   (`--avancar`) e abre um PR novo com o resumo novo.
3. **Kelvin** atualiza a produção, na VPS de produção:

   ```bash
   cd /opt/tws-panel && sudo ./scripts/install.sh
   ```

   A exclusão automática da branch depois do merge (*delete branch on merge*, ligada no repositório)
   não alcança a `sandbox`: o ruleset `protect-sandbox` impede que ela seja apagada.

## Retorno da main para a dev e a sandbox

O merge commit do lançamento existe só na `main`. Sem trazê-lo de volta, o próximo PR
`sandbox → main` aparece desatualizado (o ruleset exige a branch atualizada). Logo depois que o
Kelvin mescla, o guardião faz, num worktree (nunca no checkout principal):

```bash
git fetch origin
# sandbox: fast-forward (o merge commit descende da sandbox que foi lançada, que não avançou com o PR aberto)
if git merge-base --is-ancestor origin/sandbox origin/main; then
  git push origin origin/main:refs/heads/sandbox
else
  echo "a sandbox não é ancestral da main: pare e escale ao Kelvin"   # alguém mexeu na sandbox fora do fluxo
fi
# dev: fast-forward se ela não avançou desde o lançamento…
if git merge-base --is-ancestor origin/dev origin/main; then
  git push origin origin/main:refs/heads/dev
else
  # …senão, merge da main na dev (o merge commit não muda a árvore, só o parentesco)
  git checkout --detach origin/dev
  git merge --no-ff origin/main -m "merge: traz o lançamento da main de volta para a dev"
  git push origin HEAD:dev
fi
```

Os pushes de commits que já passaram pelo `ci` podem usar `PAAS_SKIP_PREPUSH=1`; o `ci` roda de novo
no GitHub de qualquer forma. A VPS de testes não precisa ser atualizada no retorno: o código é o
mesmo que ela já roda.

## Conflitos e situações fora do normal

- **Conflito ao integrar na `dev`:** o guardião aborta (`git merge --abort`) e devolve a lista de
  arquivos ao orquestrador. O executor atualiza a branch com `git fetch origin` e
  `git merge origin/dev` (merge, **nunca rebase** de branch já enviada), resolve, roda as
  verificações, envia; o revisor revisa de novo; o guardião tenta outra vez.
- **A `dev` avançou depois do APROVADO, sem conflito:** o guardião integra normalmente (o merge
  `--no-ff` não precisa da branch atualizada) e roda as verificações na `dev` antes do push.
- **`sandbox` à frente ou divergente da `dev`** (alguém enviou direto, ou usou "Update branch" no PR
  de lançamento): pare e escale ao Kelvin. Nada de push forçado; a regra `protect-sandbox` o recusa.
- **`ci` vermelho na `dev`:** nada vai para a `sandbox` até uma tarefa `fix/` corrigir.
- **A VPS de testes está fora da `sandbox`** (código 3): só rode `--preparar` se tiver certeza de que
  o alias é a VPS de testes.

Nunca: commit ou push direto na `main`, push forçado, rebase de branch já enviada, reescrita de
histórico, `git clean`, `pkill`/`killall`, comando na produção.

## Dependabot

Os PRs de **atualização de versão** do Dependabot miram a `dev` (`target-branch: dev` em
[`.github/dependabot.yml`](../../.github/dependabot.yml)) e seguem o ciclo normal: revisor, guardião
(`gh pr merge <número> --merge`), etapa sandbox e lançamento.

Limite do GitHub: as **atualizações de segurança** sempre abrem PR contra a branch padrão (`main`), e
com `target-branch` definido as opções do arquivo (`ignore`, `groups`, `cooldown`) não valem para
elas. O PR de segurança contra a `main` **não é mesclado lá** (a `main` só recebe da `sandbox`): o
guardião troca a base (`gh pr edit <número> --base dev`) ou, se o Dependabot o recriar contra a
`main`, fecha o PR e aplica a mesma atualização numa branch `chore/` da `dev`.

## O `estado.md`

O [`docs/plano/estado.md`](../plano/estado.md) guarda só o que é **de longa duração**: itens parados,
Pendente, Futuro, Decisões do Kelvin e uma lista curta de *Concluído recente*. **Tarefa em curso não
vai para lá**: ela é descoberta por `git worktree list` (worktrees em `.claude/worktrees/`) e por
`gh pr list`. Nada da parte operacional (servidores, instalações, clientes) entra nele; isso fica num
plano privado, fora do repositório.

O dono do arquivo é o guardião: quando o orquestrador pede (decisão nova, pendência que entra ou sai,
lançamento feito), ele edita, faz o commit (`docs: ...`) direto num worktree da `dev` e envia na hora.

## Retomada

Sessão nova (ou depois de uma queda):

1. Leia o [`CLAUDE.md`](../../CLAUDE.md) da raiz (carregado sozinho), este documento e o
   [`estado.md`](../plano/estado.md).
2. Veja o estado real:

   ```bash
   git fetch origin --prune
   git worktree list                               # tarefas em curso: worktrees em .claude/worktrees/
   gh pr list                                      # PRs abertos (de tarefa, do Dependabot, de lançamento)
   git log --oneline origin/sandbox..origin/dev    # integrado na dev, ainda fora da sandbox
   git log --oneline origin/main..origin/sandbox   # na sandbox, ainda não lançado
   gh pr list --base main --head sandbox           # PR de lançamento aberto?
   git merge-base --is-ancestor origin/main origin/dev && echo "retorno feito"   # senão, falta o retorno
   gh run list --workflow ci.yml --branch dev --limit 1
   ```

3. Continue cada coisa do ponto em que parou, chamando o papel certo: worktree com commits não
   revisados vai ao revisor; branch aprovada vai ao guardião; PR de lançamento já `MERGED` sem
   retorno vira o retorno do guardião; PR fechado sem mesclar volta ao orquestrador.

## Branches e worktrees

- Nome objetivo, com prefixo: `feat/`, `fix/`, `docs/`, `test/`, `chore/` ou `refactor/`
  (exemplo: `feat/exportar-logs-csv`). Uma branch por tarefa.
- Cada tarefa tem o seu worktree, sempre em **`.claude/worktrees/<nome-da-branch-com-hifens>`**,
  relativo à raiz do repositório (exemplo: a branch `feat/exportar-logs-csv` fica em
  `.claude/worktrees/feat-exportar-logs-csv`). A pasta `.claude/worktrees/` está no `.gitignore`,
  então os worktrees **não interferem no checkout principal**: não aparecem no `git status` dele e
  não trocam a branch em que o Kelvin está. Nenhum agente trabalha no checkout principal nem troca a
  branch dele. As tarefas em curso são os worktrees em `.claude/worktrees/`; o checkout principal e
  worktrees em outros lugares não são tarefas.
- Preparar um worktree novo: `pnpm install --frozen-lockfile` (o `prepare` liga os hooks de
  `scripts/hooks/`). Não há `.env` a copiar para rodar testes.
- Envio da branch a cada commit. Dentro de um worktree, limpe as variáveis que prenderiam o git no
  repositório errado; em pushes intermediários o pre-push (que roda a suíte inteira) pode ser pulado,
  porque o revisor, o guardião e o CI validam tudo antes da integração:
  `env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE PAAS_SKIP_PREPUSH=1 git push origin HEAD:<branch>`

## Comandos de verificação

Passos **equivalentes** aos do job `ci` (`.github/workflows/ci.yml`), na raiz do worktree. A única
diferença é a cobertura: o CI roda `pnpm test:coverage`, que **para no primeiro pacote reprovado**;
aqui o `--no-bail` roda todos os pacotes, para mostrar de uma vez tudo o que o CI reprovaria.

```bash
pnpm install --frozen-lockfile
node scripts/check-no-real-hosts.mjs
pnpm typecheck
pnpm build
DOCKER_HOST=unix:///nonexistent.sock pnpm -r --workspace-concurrency=1 --no-bail --if-present run test:coverage
```

- **Docker local fica fora dos testes:** o `DOCKER_HOST` apontando para um socket que não existe
  garante que nenhum teste fale com o Docker da máquina (como no CI). `--workspace-concurrency=1`
  roda um pacote por vez, como o pre-push (vários juntos disputam CPU e estouram prazos).

- A cobertura tem **mínimos por pacote** (linhas, ramos e funções) em cada `vitest.config.ts`, e o
  CI reprova se qualquer um cair; o mínimo de **ramos** é o que mais reprova. Rode a cobertura de
  **todos** os pacotes: o `--no-bail` antes do `run` faz o pnpm seguir para os outros pacotes quando
  um falha. Não use `pnpm test:coverage --no-bail`: nesse formato o pnpm repassa a opção ao script de
  cada pacote, não ao modo recursivo.
- Para iterar num pacote só: `pnpm --filter @paas/server test`, `pnpm --filter @paas/web typecheck`.
- `pnpm docs:links` quando mexer em Markdown (links e âncoras).
- Script de shell novo ou alterado: `bash -n` e, se houver, `shellcheck`; o comportamento é testado
  em `apps/server/tests/*-script.test.ts`, com dublês dos comandos externos no `PATH` (exemplo:
  `atualizar-sandbox-script.test.ts`).
- `pnpm test:e2e` exige Docker real e não roda no CI; só quando a tarefa toca e-mail ou guardrails e
  o orquestrador autorizar o uso de Docker.

## Lista de conferência do revisor

Além do que o revisor global já confere, neste repositório:

1. **Testes de resultado.** Os testes verificam o **resultado** do comportamento (o estado certo, os
   dados certos, o efeito colateral), nunca só um HTTP 200. Cada regra ou verificação nova tem um
   caso que dispara, um que não dispara e um caso de borda. Padrão em
   [`CONTRIBUTING.md`](../../CONTRIBUTING.md#tests) e em
   [`comoFuncionaSistema/global/testes.json`](../../comoFuncionaSistema/global/testes.json).
2. **Validação de dados nas rotas.** Rota nova ou alterada tem schema, e os testes rejeitam valores
   inválidos, limites, tipos errados e campos ausentes com o status e o código de erro certos (veja
   os testes `routes-*-schema` em `apps/server/tests`).
3. **Testes de segurança.** Mudança que toca autenticação, autorização, guardrails, execução de
   comandos, caminhos de arquivo, rede ou segredos entra nos testes de segurança: em
   `apps/server/tests` (autenticação, 2FA, tokens de API, CSRF/origem, guardas e dispensas de
   guardrail) e em `packages/security/tests` (verificações, scanner, executor e acesso ao host).
4. **Cobertura** de todos os pacotes sem quebrar os mínimos (comando acima).
5. **`comoFuncionaSistema/` atualizado** quando o comportamento muda (o JSON do endpoint ou do
   módulo, e `global/` se a peça for transversal). Mudança visível ao usuário também atualiza o guia
   do site em `site/src/content/docs/` (`en` e, se possível, `pt-br`).
6. **Nada sensível**: varredura de termos proibidos limpa e `node scripts/check-no-real-hosts.mjs`
   sem achados (próxima seção).
7. **Commits** em conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`),
   sem autor ou coautor de identidade de teste.

## Repositório público: termos proibidos

O repositório é **público**. Nenhum nome de cliente, projeto privado, IP real, domínio de cliente,
hostname de VPS ou caminho da máquina do Kelvin pode aparecer em código, documentação, nome de
arquivo, mensagem de commit ou descrição de PR. Use exemplos genéricos (`example.com`,
`203.0.113.x`, `meu-projeto`).

- A **lista real de termos proibidos não fica no repositório** (publicá-la seria publicar o que ela
  protege). Ela fica num arquivo local fora do versionamento (`.check-real-hosts.local`, ignorado
  pelo Git) e no secret de Actions usado pelo CI. **O orquestrador passa a lista ao agente** junto
  com a tarefa.
- **Antes de cada push**, o executor varre o diff contra `origin/dev` (conteúdo e nomes de arquivo,
  sem diferenciar maiúsculas) por cada termo da lista e roda `node scripts/check-no-real-hosts.mjs`.
  O arquivo local de termos fica **na raiz da pasta principal** do repositório
  (`.check-real-hosts.local`, ignorado pelo Git), então não existe dentro de um worktree. Passe o
  caminho dele pela variável `CHECK_REAL_HOSTS_FILE`. De dentro de qualquer worktree, o bloco abaixo
  acha a pasta principal sozinho e **para com erro** se o arquivo não existir ou estiver vazio (sem
  ele, o verificador rodaria sem os nomes protegidos e passaria em falso). Os parênteses fazem o
  `exit` encerrar só o bloco, não o terminal:

  ```bash
  (
    arquivo="$(git rev-parse --path-format=absolute --git-common-dir)/../.check-real-hosts.local"
    test -s "$arquivo" || { echo "arquivo de termos ausente ou vazio: $arquivo" >&2; exit 1; }
    CHECK_REAL_HOSTS_FILE="$arquivo" node scripts/check-no-real-hosts.mjs
  )
  ```
- O guardião repete a varredura no título e na descrição do PR antes de abri-lo.
- O plano operacional (servidores, clientes, outros projetos) fica num plano **privado**, fora deste
  repositório. O [`docs/plano/estado.md`](../plano/estado.md) cobre só o trabalho do painel.

## Documentação do sistema

Antes de explorar o código, leia [`comoFuncionaSistema/index.json`](../../comoFuncionaSistema/index.json):
ele aponta o módulo de cada assunto; depois abra `<módulo>/index.json` e só o arquivo do endpoint que
interessa. Peças transversais (configuração, autenticação, execução de comandos, persistência,
testes) estão em `comoFuncionaSistema/global/`.

## Não concordar por padrão

Vale o princípio das instruções globais do Claude Code: avaliar antes de fazer, validar em fonte
