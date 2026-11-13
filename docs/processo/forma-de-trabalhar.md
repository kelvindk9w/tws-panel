# Forma de trabalhar no TWS Panel

Este documento complementa o fluxo global de trabalho com subagentes do Claude Code (orquestrador,
`executor`, `revisor` e `guardiao-git`, definidos fora deste repositório, nas instruções e nos
agentes globais do Claude Code). Aqui fica só o que é **específico deste repositório**. Quando este
documento e as instruções genéricas dos agentes divergirem, **vale este documento**.

O estado do trabalho fica em [`docs/plano/estado.md`](../plano/estado.md).

- [Exceção de integração: tudo entra na main por PR](#exceção-de-integração-tudo-entra-na-main-por-pr)
- [Retomada](#retomada)
- [Branches e worktrees](#branches-e-worktrees)
- [Comandos de verificação](#comandos-de-verificação)
- [Lista de conferência do revisor](#lista-de-conferência-do-revisor)
- [Repositório público: termos proibidos](#repositório-público-termos-proibidos)
- [Documentação do sistema](#documentação-do-sistema)
- [Não concordar por padrão](#não-concordar-por-padrão)

## Exceção de integração: tudo entra na main por PR

**Neste repositório, esta seção prevalece sobre as instruções genéricas dos agentes.**

A `main` tem proteção no GitHub (ruleset `protect-main`): só recebe mudanças por **pull request**,
exige o check **`ci`** verde, exige a branch **atualizada** com a `main` e só aceita **squash**. Por
isso o caminho genérico do guardião (merge `--no-ff` na `dev` e `git push origin dev:main`) seria
recusado. **A `dev` não é usada neste repositório.**

O fluxo aqui é:

1. **Executor:** cria a branch da tarefa a partir da **`origin/main`** atualizada (não da `dev`),
   no worktree da tarefa (veja [Branches e worktrees](#branches-e-worktrees)), trabalha, faz commit a
   cada passo e envia a branch a cada commit. Quando o guardião aponta conflito, o executor atualiza a
   branch com **`git fetch origin` e `git merge origin/main`** (nunca `origin/dev`), resolve, roda as
   verificações, envia e entrega de novo.
2. **Revisor:** compara com a **`origin/main`**: revisa `origin/main...origin/<branch>` (no lugar de
   `origin/dev...`) e devolve APROVADO ou REPROVADO, como no fluxo global.
3. **Guardião (`guardiao-git`), depois do APROVADO.** O guardião **não usa o checkout principal**:
   ele é do Kelvin e não precisa estar limpo nem na `dev`. Tudo o que o guardião faz acontece **no
   worktree da tarefa**.
   - confere que a ponta da branch no origin é o hash aprovado;
   - atualiza a branch com a `main` no worktree da tarefa: `git fetch origin` e
     `git merge origin/main` (merge, nunca rebase), depois push da branch. Conflito: `git merge
     --abort` e devolve a lista de arquivos ao orquestrador, que manda ao executor (e depois ao
     revisor de novo);
   - abre o PR **contra a `main`** (`gh pr create --base main`), com título em conventional commit
     e descrição em português pelo comportamento;
   - acompanha o CI (`gh pr checks <número> --watch`) até o check `ci` ficar verde; vermelho volta
     ao orquestrador com o job e o erro;
   - avisa o Kelvin que o PR está atualizado, verde e pronto para mesclar.
4. **Kelvin:** mescla **manualmente**, por squash. Ao confirmar o squash, a mensagem não pode
   levar `Co-authored-by` de identidade de teste (o job `commit-authors` reprova).
5. **Guardião, depois da mesclagem:**
   - confirma com `gh pr view <número> --json state,mergedAt` (estado `MERGED`). Não use
     `git branch --merged`: o squash cria um commit novo, e a branch nunca aparece como mesclada;
   - `git worktree remove <caminho>` (sem `--force`; recusou, pare e avise) e `git worktree prune`;
   - a branch remota é apagada pelo próprio GitHub na mesclagem (opção *delete branch on merge*
     ligada); confira com `git fetch origin --prune` e, se ainda existir,
     `git push origin --delete <branch>`;
   - a branch **local** não sai com `git branch -d` (pelo mesmo motivo do squash), e o `-D` é
     bloqueado pelas proteções dos agentes. O guardião lista no relatório as branches locais já
     mescladas, para o Kelvin apagar;
   - não precisa mexer no `estado.md` (veja abaixo).

### Quem escreve no `estado.md`

A `main` não aceita push direto, então o [`docs/plano/estado.md`](../plano/estado.md) muda junto
com o PR de cada tarefa:

- Depois do APROVADO do revisor e da abertura do PR, o **guardião** acrescenta **na própria branch
  da tarefa um único commit**, só no `docs/plano/estado.md`, movendo a tarefa para *Concluído
  (recente)* com o número do PR e tirando-a de *Em andamento* e do *Registro de branches*. A
  mesclagem pelo Kelvin torna isso verdadeiro; se o PR for fechado sem mesclar, a correção vai no
  PR seguinte.
- O revisor e o guardião aceitam commits depois do hash aprovado **sem nova revisão** só quando eles
  não mudam nada além desse arquivo: `git diff --name-only <aprovado>..HEAD` mostra apenas
  `docs/plano/estado.md`. Se no meio houve um merge de `origin/main` sem conflito (veja
  [Retomada](#retomada)), confira só a linha da branch:
  `git log --first-parent --no-merges --name-only --format= <aprovado>..HEAD` deve listar apenas
  `docs/plano/estado.md`.
- O **executor não edita** o `estado.md`.
- O que está em andamento de verdade aparece em `gh pr list` e no *Registro de branches*; o
  `estado.md` da `main` mostra o que já entrou e o que está planejado.

**Branch local depois do squash** (regra vigente, aguarda confirmação do Kelvin): como
`git branch -d` recusa e o `-D` é bloqueado pelas proteções dos agentes, o guardião lista no
relatório as branches locais já mescladas (confirmadas com `gh pr view`) para o Kelvin apagar.

Nunca: commit ou push direto na `main`, force-push, rebase de branch já enviada, reescrita de
histórico, `git clean`, `pkill`/`killall`.

**Deploy: mesclar na `main` é publicar.**

- **Instalações do painel.** O instalador (`scripts/install.sh`) acompanha a branch em uso, que é a
  `main`. Cada vez que roda `sudo ./scripts/install.sh`, ele baixa o código novo, avança a branch só
  para a frente (fast-forward), reconstrói e recria o painel (veja o guia de operações em
  `site/src/content/docs/en/guides/operations.md`). Ou seja: o que entra na `main` é o que **toda
  instalação recebe** na próxima atualização, **inclusive a VPS do Kelvin**.
- **Site de documentação.** É publicado sozinho a cada push na `main` que mexa em `docs/**`, em
  `*.md`, em `site/**` ou nos outros caminhos listados em `.github/workflows/docs.yml`.
- **Tags `v*`.** São só a marca de versão (protegidas pelo ruleset `protect-version-tags`). As
  instalações não dependem delas; criar uma tag é decisão do Kelvin.

## Retomada

- **Ordem de leitura de uma sessão nova:** o [`CLAUDE.md`](../../CLAUDE.md) da raiz (carregado
  sozinho), este documento, o [`docs/plano/estado.md`](../plano/estado.md) e então o estado real:
  `git fetch origin --prune`, `git worktree list` e `gh pr list`. Só depois continue cada tarefa do
  ponto em que parou, chamando o papel certo do ciclo.
- **Detectar o que o Kelvin já mesclou:** `gh pr list --state all` e `gh pr view <número>` de cada
  PR citado no `estado.md`. PR com estado `MERGED` cujo worktree ainda existe vira limpeza do
  guardião; PR fechado sem mesclar volta ao orquestrador para decidir.
- **A `main` avançou depois do PR verde:** a regra `protect-main` exige a branch atualizada, então o
  Kelvin usa "Update branch" no GitHub ou o guardião faz `git merge origin/main` na branch (no
  worktree da tarefa) e envia. **Sem conflito e com o `ci` verde, não precisa de nova revisão.** Com
  conflito, a branch volta ao executor e depois ao revisor.

## Branches e worktrees

- Nome objetivo, com prefixo: `feat/`, `fix/`, `docs/`, `test/`, `chore/` ou `refactor/`
  (exemplo: `feat/exportar-logs-csv`). Uma branch por tarefa.
- Cada tarefa tem o seu worktree, sempre em **`.claude/worktrees/<nome-da-branch-com-hifens>`**,
  relativo à raiz do repositório (exemplo: a branch `feat/exportar-logs-csv` fica em
  `.claude/worktrees/feat-exportar-logs-csv`). A pasta `.claude/worktrees/` está no `.gitignore`,
  então os worktrees **não interferem no checkout principal**: não aparecem no `git status` dele e
  não trocam a branch em que o Kelvin está. Nenhum agente trabalha no checkout principal nem troca a
  branch dele. O caminho de cada worktree vai no *Registro de branches* do
  [`estado.md`](../plano/estado.md).
- Preparar um worktree novo: `pnpm install --frozen-lockfile` (o `prepare` liga os hooks de
  `scripts/hooks/`). Não há `.env` a copiar para rodar testes.
- Envio da branch a cada commit. Dentro de um worktree, limpe as variáveis que prenderiam o git no
  repositório errado; em pushes intermediários o pre-push (que roda a suíte inteira) pode ser pulado,
  porque o revisor e o CI validam tudo antes do PR:
  `env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE PAAS_SKIP_PREPUSH=1 git push origin HEAD:<branch>`

## Comandos de verificação

Os mesmos passos do job `ci` (`.github/workflows/ci.yml`), na raiz do worktree:

```bash
pnpm install --frozen-lockfile
node scripts/check-no-real-hosts.mjs
pnpm typecheck
pnpm build
pnpm -r --no-bail --if-present run test:coverage
```

- A cobertura tem **mínimos por pacote** (linhas, ramos e funções) em cada `vitest.config.ts`, e o
  CI reprova se qualquer um cair; o mínimo de **ramos** é o que mais reprova. Rode a cobertura de
  **todos** os pacotes: o `--no-bail` antes do `run` faz o pnpm seguir para os outros pacotes quando
  um falha. Não use `pnpm test:coverage --no-bail`: nesse formato o pnpm repassa a opção ao script de
  cada pacote, não ao modo recursivo.
- Para iterar num pacote só: `pnpm --filter @paas/server test`, `pnpm --filter @paas/web typecheck`.
- `pnpm docs:links` quando mexer em Markdown (links e âncoras).
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
- **Antes de cada push**, o executor varre o diff contra `origin/main` (conteúdo e nomes de arquivo,
  sem diferenciar maiúsculas) por cada termo da lista e roda `node scripts/check-no-real-hosts.mjs`.
  Num worktree o arquivo local não existe: aponte para ele com
  `CHECK_REAL_HOSTS_FILE=<caminho do arquivo>`.
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
confiável quando fizer diferença e dizer claramente se concorda, concorda com ajustes ou discorda.
