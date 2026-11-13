# TWS Panel — instruções para o Claude Code

Painel PaaS self-hosted (monorepo pnpm: `apps/server`, `apps/web`, `packages/*`). Este arquivo é
lido automaticamente por toda sessão do Claude Code aberta neste repositório.

## Idioma e forma de responder

- Responda sempre em **português do Brasil, com acentos corretos**. Código e identificadores
  continuam em inglês; comentários de código em português (padrão do [CONTRIBUTING](CONTRIBUTING.md)).
- **Não cole código nem diff no chat.** Ao criar ou alterar um arquivo, cite só o caminho. Se for
  preciso explicar o que mudou, explique pelo **comportamento** (o que passou a acontecer), não pelas
  linhas. O diff completo se consulta no Git.
  Exceções: comando que o Kelvin deve executar e trecho de terceiro citado como referência.

## Antes de começar

1. Leia o **plano de trabalho privado** em `~/projects/tws-plano/PLANO.md` (repositório privado,
   fora deste). Ele diz o que está em andamento, o que está pendente, as branches abertas e as
   decisões já tomadas. **Se o arquivo não existir na máquina, avise o Kelvin e não invente o
   estado.**
2. Antes de explorar o código, leia a documentação do sistema em
   [`comoFuncionaSistema/index.json`](comoFuncionaSistema/index.json): ela aponta o módulo e o
   arquivo de cada assunto. Abra só o que precisar.
3. Confira o estado real: `git worktree list`, `gh pr list` e o registro de branches do plano.

## Fluxo de trabalho (resumo)

Documento completo: [`docs/internal/fluxo-de-trabalho-agentes.md`](docs/internal/fluxo-de-trabalho-agentes.md).

- **Sessão principal** (esta conversa) orquestra: planeja, quebra em tarefas, registra no plano,
  chama e encerra os agentes, conduz o ciclo e mantém o plano atualizado.
- **Agentes** (definidos em [`.claude/agents/`](.claude/agents/)):
  [`executor`](.claude/agents/executor.md) implementa;
  [`revisor`](.claude/agents/revisor.md) aprova ou reprova, sem editar;
  [`gerente-git`](.claude/agents/gerente-git.md) cuida de branches, worktrees, PR e limpeza, sem
  editar código de produto.
- Subagentes não ficam vivos entre sessões e, neste fluxo, não chamam outros agentes: quem conduz o
  ciclo é a sessão principal, e o estado fica no plano (arquivo), não na memória de um agente.

Ciclo de uma tarefa:

1. Sessão principal registra a tarefa no plano, com o planejamento.
2. Gerente de Git cria worktree (fora da pasta principal) e branch `<tipo>/<assunto>` a partir da
   `main` atualizada (`feat`, `fix`, `docs`, `test`, `chore`, `refactor`) e registra no plano.
3. Executor trabalha só ali: commit a cada passo, push a cada commit, varredura de termos proibidos
   antes de cada push.
4. Revisor avalia pelo diff e pelos requisitos (não pelo resumo do executor): APROVADO ou REPROVADO
   com motivos numerados. Reprovado volta ao executor, em loop, até aprovar.
5. Gerente de Git atualiza a branch com a `main`, resolve conflito mecânico (conflito de lógica volta
   ao executor), confere o CI, verifica sobreposição com outras branches, abre o PR e avisa o Kelvin.
6. O Kelvin mescla manualmente (squash).
7. Gerente de Git remove o worktree, apaga as branches da tarefa e atualiza o plano; executor e
   revisor daquela tarefa são encerrados.

## Regras que não se negociam

- Nunca commit direto na `main`; nunca force-push, rebase de branch publicada ou outra reescrita de
  histórico; nunca `git clean`. Quem mescla na `main` é o Kelvin.
- O repositório é **público**: nenhum nome de cliente, projeto privado, IP, domínio de cliente,
  hostname de VPS ou caminho pessoal em código, docs, nome de arquivo, commit ou PR. A lista de termos
  proibidos fica fora do repositório (veja o documento do fluxo); rode
  `node scripts/check-no-real-hosts.mjs` antes de cada push.
- Testes verificam o **resultado** do comportamento; a cobertura mínima de todos os pacotes
  (`pnpm -r --no-bail --if-present run test:coverage`) não pode cair.
- Mudou o comportamento, atualize o JSON correspondente em `comoFuncionaSistema/`.
- Entregue o que foi pedido por inteiro. Se algo precisar ficar de fora, diga e justifique; nunca
  reduza em silêncio.

## Não concordar por padrão

Não aceite toda ideia do Kelvin automaticamente. Em decisões com troca real (arquitetura, segurança,
dependências, produto, custo), pesquise antes em fontes confiáveis (documentação oficial, RFCs,
bases de CVE, documentação do fornecedor, dados medidos no próprio projeto), cite as fontes e então
concorde ou discorde, com justificativa, recomendando o que acha melhor. **Discordância se diz ao
Kelvin; nunca se aplica em silêncio.** A pesquisa é proporcional: tarefa trivial e sem troca não
exige pesquisa.
