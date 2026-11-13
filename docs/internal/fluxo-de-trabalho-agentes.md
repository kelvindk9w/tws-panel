# Fluxo de trabalho com agentes

Este documento descreve como o trabalho no TWS Panel é conduzido com o Claude Code: quem faz o quê,
como uma tarefa nasce, é executada, revisada e entra na `main`, e como uma sessão nova retoma o
trabalho se a anterior cair. O resumo está no [`CLAUDE.md`](../../CLAUDE.md) da raiz; as definições
dos agentes estão em [`.claude/agents/`](../../.claude/agents/).

- [Papéis](#papéis)
- [Limites reais do Claude Code](#limites-reais-do-claude-code)
- [Ciclo de uma tarefa](#ciclo-de-uma-tarefa)
- [Checklist obrigatório do revisor](#checklist-obrigatório-do-revisor)
- [Regras de Git](#regras-de-git)
- [Termos proibidos e dados sensíveis](#termos-proibidos-e-dados-sensíveis)
- [Princípio: não concordar por padrão](#princípio-não-concordar-por-padrão)
- [Retomada após queda de sessão](#retomada-após-queda-de-sessão)
- [Modelo do plano privado](#modelo-do-plano-privado)

## Papéis

| Papel | Quem é | O que faz | O que não faz |
|---|---|---|---|
| **Sessão principal** | A conversa do Claude Code aberta pelo Kelvin | Orquestra: entende o pedido, planeja, quebra em tarefas, registra no plano, dispara e encerra os agentes, conduz o ciclo executor → revisor → gerente de Git e mantém o plano atualizado | Não implementa tarefas grandes ela mesma; não mescla na `main` |
| **Executor** | Subagente [`executor`](../../.claude/agents/executor.md) | Implementa uma tarefa dentro do worktree e da branch que recebeu, com testes e documentação, commit a cada passo e push a cada commit | Não sai do worktree; não abre PR; não mexe em outra branch |
| **Revisor** | Subagente [`revisor`](../../.claude/agents/revisor.md) | Avalia a entrega a partir do diff e dos requisitos e dá **APROVADO** ou **REPROVADO** com motivos numerados | Não edita código; só relata |
| **Gerente de Git** | Subagente [`gerente-git`](../../.claude/agents/gerente-git.md) | Cria worktree e branch, atualiza a branch com a `main`, resolve conflitos mecânicos, confere o CI, abre o PR, limpa depois da mesclagem e registra tudo no plano | Nunca edita código de produto; nunca mescla na `main` |
| **Kelvin** | Dono do projeto | Decide, aprova e **mescla manualmente** os PRs (squash) | — |

## Limites reais do Claude Code

O fluxo foi desenhado em cima do que o Claude Code de fato oferece (documentação oficial:
[Subagents](https://code.claude.com/docs/en/sub-agents)):

- **Subagentes não ficam vivos permanentemente.** Cada chamada cria uma instância nova, que trabalha,
  devolve um relatório e para. Dentro da mesma sessão dá para retomar um subagente pelo nome ou ID
  (com o histórico dele), mas se a sessão principal cair e não for retomada, os subagentes vão junto.
  Por isso **o estado do trabalho mora em arquivo** (o plano privado), não na memória de um agente.
- **Quem conduz o ciclo é a sessão principal.** O Claude Code até permite que um subagente dispare
  outros (por padrão, até três níveis abaixo da conversa principal), mas neste fluxo os agentes
  **não disparam agentes**: a ferramenta `Agent` está bloqueada nas definições em `.claude/agents/`.
  Assim só existe um ponto que sabe o estado de todas as tarefas, o relatório de cada agente volta
  para quem decide o próximo passo e não há agentes órfãos rodando sem ninguém olhando.
- **O "gerente de Git sempre presente" é um papel, não um processo contínuo.** A sessão principal
  chama o gerente de Git nos momentos certos do ciclo (criar a branch, preparar o PR, limpar depois
  da mesclagem). Ele lê o plano para saber o estado, faz a sua parte, registra no plano e termina.

## Ciclo de uma tarefa

1. **Planejamento.** A sessão principal registra a tarefa no plano privado (seção *Em andamento*),
   com o objetivo, os requisitos, o que fica de fora e os arquivos ou módulos envolvidos.
2. **Branch e worktree.** A sessão principal chama o gerente de Git, que atualiza a `main`
   (`git fetch`), cria um worktree **fora da pasta principal do repositório** com uma branch
   exclusiva a partir de `origin/main`, e registra no plano (seção *Registro de branches*).
   O nome da branch é objetivo, no formato `<tipo>/<assunto>`, com `tipo` entre `feat`, `fix`,
   `docs`, `test`, `chore` e `refactor` (exemplos: `feat/exportar-logs`, `fix/timeout-no-deploy`).
3. **Execução.** A sessão principal chama o executor com a tarefa, o caminho do worktree e a branch.
   O executor trabalha **só ali**, faz commit a cada passo concluído e **push da branch a cada
   commit**. O push frequente é a cópia fora da máquina: se a sessão cair ou o computador der
   problema, nada se perde. Antes de cada push ele varre o diff pelos
   [termos proibidos](#termos-proibidos-e-dados-sensíveis).
4. **Revisão.** Ao fim, a sessão principal chama o revisor com os requisitos da tarefa, a branch e o
   worktree. O revisor avalia **a partir do diff e dos requisitos, não a partir do resumo do
   executor**, roda o [checklist](#checklist-obrigatório-do-revisor) e responde **APROVADO** ou
   **REPROVADO** com motivos numerados. Reprovado, a sessão principal devolve os motivos ao executor
   (de preferência retomando o mesmo executor, que já tem o contexto) e o ciclo se repete até a
   aprovação.
5. **Preparação do PR.** Aprovado, a sessão principal chama o gerente de Git, que:
   - atualiza a branch com a `main` (merge de `origin/main` na branch, sem reescrever histórico);
   - resolve conflitos **mecânicos** (lockfile, imports, linhas vizinhas). Conflito de **lógica**
     volta ao executor, e a entrega passa de novo pelo revisor;
   - confere o CI da branch (`gh run list`, `gh pr checks`);
   - verifica **sobreposição** com as outras branches em andamento do registro (mesmos arquivos ou
     mesmo comportamento) e avisa a sessão principal se houver;
   - abre o PR contra a `main` e avisa o Kelvin que pode mesclar, lembrando que é **squash** e que
     a mensagem do squash não pode levar `Co-authored-by` de identidade de teste.
6. **Mesclagem.** O Kelvin mescla manualmente.
7. **Limpeza.** Mesclado, a sessão principal chama o gerente de Git, que remove o worktree, apaga a
   branch local e a remota da tarefa, move a tarefa para *Concluído* e atualiza o registro de
   branches. O executor e o revisor daquela tarefa são encerrados (não são retomados para outra
   tarefa).

Tarefas independentes podem correr em paralelo, cada uma com o seu worktree, a sua branch, o seu
executor e o seu revisor. Tarefas que mexem nos mesmos arquivos andam em sequência.

## Checklist obrigatório do revisor

O revisor é rigoroso: um item não atendido é motivo de **REPROVADO**. Ele não edita código; só relata.

1. **Requisitos atendidos por completo.** Tudo o que a tarefa pediu foi feito. Nada foi reduzido,
   trocado ou deixado de fora em silêncio; se algo ficou de fora, isso precisa estar dito e
   justificado.
2. **Testes de funcionalidade que verificam o resultado.** Os testes conferem o **resultado** do
   comportamento (o estado certo, os dados certos, o efeito colateral esperado), nunca só um HTTP 200
   ou "não lançou erro". Padrão em [`CONTRIBUTING.md`](../../CONTRIBUTING.md#tests) e em
   [`comoFuncionaSistema/global/testes.json`](../../comoFuncionaSistema/global/testes.json): caso que
   dispara, caso que não dispara e pelo menos um caso de borda.
3. **Testes de validação de entrada.** Valores inválidos, limites, tipos errados e campos ausentes
   são rejeitados com o erro certo (status e código), conforme os schemas das rotas (veja os testes
   `routes-*-schema` em `apps/server/tests`).
4. **Testes de segurança.** Quando a mudança toca superfície de segurança (autenticação,
   autorização, guardrails, execução de comandos, caminhos de arquivo, rede, segredos), a novidade
   entra nos testes de segurança existentes ou ganha os seus, no mesmo padrão dos que já existem em
   `apps/server/tests` (por exemplo os de autenticação, CSRF/origem, guardas e dispensas de
   guardrail) e em `packages/security/tests`.
5. **Cobertura.** `pnpm -r --no-bail --if-present run test:coverage` passa sem quebrar os mínimos de
   **nenhum** pacote (o `--no-bail` faz rodar todos, em vez de parar no primeiro que falhar). Os
   mínimos estão em cada `vitest.config.ts` e na tabela do CONTRIBUTING; o CI reprova se caírem.
6. **Typecheck e build.** `pnpm typecheck` e `pnpm build` limpos.
7. **Documentação.** Se o comportamento mudou, o JSON correspondente em
   [`comoFuncionaSistema/`](../../comoFuncionaSistema/index.json) foi atualizado (e o guia do site,
   quando a mudança aparece para o usuário).
8. **Nada sensível.** Nenhum termo proibido, nome de cliente, IP, domínio real, hostname de VPS,
   caminho pessoal, token ou senha no diff, nos nomes de arquivo nem nas mensagens de commit
   (`node scripts/check-no-real-hosts.mjs` limpo).
9. **Commits no padrão.** Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`,
   `refactor:`), descritivos, sem autor ou `Co-authored-by` de identidade de teste.

## Regras de Git

- Uma branch por tarefa, criada a partir de `origin/main` atualizada.
- Nunca commit direto na `main`.
- Nunca `push --force`, `rebase` de branch já publicada, `reset` que descarte commits publicados ou
  qualquer outra reescrita de histórico. Para atualizar uma branch com a `main`, use merge.
- Nunca `git clean`.
- Worktrees de agentes ficam **fora da pasta principal** do repositório; a pasta principal é do Kelvin.
- Quem mescla na `main` é o Kelvin, sempre por **squash**.
- Push a cada commit. Quando o comando roda dentro de um worktree a partir de um hook ou de outro
  processo git, limpe as variáveis que prenderiam o git no repositório errado:
  `env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE git push origin HEAD:<branch>`.
- O hook de pre-push roda a suíte inteira. Em pushes intermediários de uma branch de trabalho ele
  pode ser pulado com `PAAS_SKIP_PREPUSH=1`, porque a validação completa é feita pelo revisor e pelo
  CI antes do PR.

## Termos proibidos e dados sensíveis

O repositório é **público**. Nenhum nome de cliente, projeto privado, IP, domínio de cliente,
hostname de VPS ou caminho da máquina do Kelvin pode aparecer em código, documentação, nome de
arquivo, mensagem de commit ou descrição de PR. Use exemplos genéricos (`example.com`,
`203.0.113.x`, `meu-projeto`).

A **lista de termos proibidos não fica no repositório** (publicá-la seria publicar o que ela protege).
Ela fica:

- no arquivo local `.check-real-hosts.local` (ignorado pelo Git), lido por
  `node scripts/check-no-real-hosts.mjs`;
- no secret de Actions `CHECK_REAL_HOSTS_PATTERNS`, usado pelo CI;
- no plano privado, para a sessão principal repassar aos agentes.

Antes de cada push, varra o diff contra `origin/main` (conteúdo e nomes de arquivo), sem diferenciar
maiúsculas, por cada termo da lista, e rode `node scripts/check-no-real-hosts.mjs`. Num worktree, o
arquivo local não existe: aponte para ele com `CHECK_REAL_HOSTS_FILE=<caminho do arquivo>`.

## Princípio: não concordar por padrão

A sessão principal e os agentes **não aceitam toda ideia do Kelvin automaticamente**. Concordar por
reflexo não ajuda ninguém.

- Para decisões com **troca real** (arquitetura, segurança, dependências, produto, custo), pesquise
  antes, em fontes confiáveis: documentação oficial, RFCs, bases de CVE, documentação do fornecedor e
  dados medidos no próprio projeto (testes, logs, benchmarks).
- **Cite as fontes** e então concorde ou discorde, com justificativa, e recomende o que acha melhor.
- **Discordância se diz ao Kelvin; nunca se aplica em silêncio.** Se ele mantiver a decisão depois de
  ouvir o argumento, faça o que ele pediu, por inteiro, e registre a decisão no plano.
- A pesquisa é **proporcional**: tarefa trivial e sem troca (corrigir um texto, renomear uma
  variável) não exige pesquisa.

## Retomada após queda de sessão

Uma sessão nova, ao abrir o repositório, faz nesta ordem:

1. Lê o [`CLAUDE.md`](../../CLAUDE.md) (carregado automaticamente) e este documento.
2. Lê o plano privado em `~/projects/tws-plano/PLANO.md`: *Em andamento*, *Pendente*, *Futuro*,
   *Concluído* e o *Registro de branches*. Se o plano não existir na máquina, avisa o Kelvin e não
   inventa um estado.
3. Confere o estado real, que pode ter andado depois do último registro:
   - `git fetch` e `git worktree list` (quais worktrees e branches existem de fato);
   - `git log origin/<branch>` de cada branch em andamento (o que já foi enviado);
   - `gh pr list` e `gh pr checks <número>` (quais PRs estão abertos, mesclados e com CI verde).
4. Reconcilia o plano com o que encontrou (por exemplo: PR mesclado que o plano ainda dá como aberto
   vira limpeza do gerente de Git) e continua cada tarefa do ponto em que parou, chamando o papel
   certo do ciclo.

## Modelo do plano privado

O plano fica em um repositório **privado**, fora deste (`~/projects/tws-plano/PLANO.md`), porque
fala de clientes, servidores e decisões internas. Quem o atualiza faz commit e push nele também, para
que ele tenha a mesma cópia fora da máquina que as branches de trabalho. A estrutura (os exemplos
abaixo são fictícios):

```markdown
# Plano de trabalho — TWS Panel

Atualizado em: 2026-01-15 14:30

## Em andamento
- **Exportar logs em CSV** — branch `feat/exportar-logs-csv`
  - Objetivo: botão na aba Logs que baixa o período filtrado em CSV.
  - Requisitos: respeita o filtro atual; limite de 50 mil linhas com aviso; teste do conteúdo do arquivo.
  - Fora do escopo: exportar em JSON.
  - Estado: revisão reprovada (2 motivos), devolvida ao executor.

## Pendente
- **Timeout configurável no deploy** — aguardando decisão do Kelvin sobre o valor padrão.

## Futuro
- Notificação por webhook genérico.

## Concluído (recente)
- 2026-01-14 — Corrigir rolagem do modal de domínio (PR #101, mesclado).

## Registro de branches
| Branch | Tarefa | Worktree | Estado | PR |
|---|---|---|---|---|
| `feat/exportar-logs-csv` | Exportar logs em CSV | `~/worktrees/exportar-logs-csv` | em revisão | — |
| `fix/modal-dominio-rolagem` | Rolagem do modal | (removido) | mesclado e limpo | #101 |

## Decisões do Kelvin
- 2026-01-10 — Logs exportados ficam limitados a 50 mil linhas por arquivo.
- 2026-01-08 — Dependência nova só com pesquisa de manutenção e CVEs antes.

## Termos proibidos
(lista privada, repassada aos agentes; nunca copiada para o repositório público)

## Histórico de sessões
- 2026-01-15 — Exportação de logs iniciada; modal de domínio mesclado.
- 2026-01-14 — Revisão do lote de certificados.
```
