# Relatório — alerta de "nova atualização do projeto"

Data: 22/10/2026. Detalhe técnico dos endpoints em `projetos/alerta-atualizacao.json`.

## O que foi pedido

Um aviso "nova atualização disponível — clique para fazer o deploy" na aba Git, no topo da página do
projeto e no Dashboard, considerando a BRANCH configurada de cada projeto. Sem deploy automático: só aviso
e um botão que leva ao Deploy que já existe.

## O que foi feito

- **Servidor.** `UpdateCheckService` compara a ponta de `refs/heads/<branch>` do repositório (`ls-remote`,
  sem clonar) com `Project.deployedCommit`. A consulta reaproveita o mesmo núcleo do "Testar acesso"
  (`lsRemote` em `packages/deploy/src/git-access.ts`, agora compartilhado): credential helper que só entrega o
  token ao host/porta/protocolo cadastrados, nunca segue redirecionamento, recusa loopback/link-local/metadados
  e nomes que resolvam para eles (`resolveTarget`, com o pin anti-rebinding), sem proxy herdado,
  `GIT_TERMINAL_PROMPT=0`, prazo curto com o grupo de processos morto.
- **Onde o commit no ar é gravado.** Não havia registro. Passou a existir `Project.deployedCommit`, gravado ao
  fim de um deploy bem-sucedido (`readDeployedCommit`: `rev-parse HEAD` no repositório do painel, local). Projeto
  publicado antes disso fica `unknown` até o próximo deploy: nunca "atualização" falsa.
- **Rotas** (autenticadas, schema): `GET /api/projects/update-status` (todos), `GET /api/projects/:id/update-status`,
  `POST /api/projects/:id/update-status/check` ("Verificar agora", 6/min por projeto, corpo proibido).
- **Web.** `UpdateNotice` (variantes `banner` e `full`), `UpdateBadge` e `UpdateSummary`; hooks em
  `lib/update-status.ts`. Aba Git: todos os estados + botão de deploy + "Verificar agora" + a dica "Para atualizar
  o código, clique em Deploy". Topo: linha própria logo abaixo do cabeçalho, só com atualização. Dashboard: cartão
  "N projetos com atualização" com links e indicador no cartão de cada projeto. O botão Deploy ganhou tooltip e
  descrição para leitor de tela. Textos em pt-BR e en.
- **Site, CHANGELOG** (seção "Não lançado"): atualizados. O ROADMAP não tem seção de "não lançado" para isto.

## Decisões onde o desenho deixava espaço

1. **Só sob demanda, sem agendador no servidor.** A consulta acontece quando alguém abre a página/Dashboard
   (a interface relê a cada 5 min). Cache de 5 min por projeto (`UPDATE_CHECK_TTL_MS`), ±20% de jitter, recuo
   exponencial em falha (30 s até 15 min), 3 consultas simultâneas, teto de 15 s por consulta. Motivo: o painel
   não deve consultar repositórios de ninguém sem que alguém esteja olhando, e o alerta só tem valor quando há
   olhos na tela. Custo: não há notificação (Telegram/e-mail) de "nova atualização"; seria um passo seguinte.
2. **Sem "N commits à frente".** Exigiria baixar objetos (fetch); a consulta barata só dá o hash da ponta.
3. **`config_changed`** (estado extra): se a branch/repositório configurados diferem dos que estão no ar, não se
   comparam commits de branches diferentes. A aba Git já tinha o aviso "no ar: X" e o novo estado leva ao mesmo
   Deploy.
4. **Quem vê o aviso.** Topo e Dashboard só com o projeto no ar ou com erro (parado, criado e em deploy ficam de
   fora, como pedido). A aba Git mostra em qualquer situação de projeto com repositório (é onde se olha o estado
   do código). Projeto de upload/pasta não tem aviso em lugar nenhum.
5. **Clique.** O botão do aviso chama o MESMO `deployWithGuardrails` do botão Deploy (guardrails, variáveis
   obrigatórias). No Dashboard o link leva ao projeto, onde está o aviso com o botão: não usei `?deploy=1`
   (começaria o deploy sozinho). Fora da Visão geral/Deploys, o clique leva à aba Deploys para acompanhar.
6. **Cache vencido continua exibido** enquanto a consulta nova roda (sem piscar "verificando").
7. **Consulta mais antiga que o último deploy não vale** (o deploy pode ter baixado commit mais novo que o
   consultado); por isso não é preciso avisar o cache no fim do deploy.
8. **Mudança no `lsRemote`.** `checkGitAccess` foi refatorado para usar o núcleo compartilhado; o comportamento e
   os testes existentes não mudaram.

## Limites e riscos

- Repositório que só responde com redirecionamento (GitLab sem `.git`) aparece como erro "redirecionado" na
  verificação, embora o deploy o siga. Mesma regra do "Testar acesso" (por segurança do token).
- Trocar a conta do GitHub conectada não invalida o cache dos projetos que a usam (vale o recuo ou "Verificar
  agora"). Gravar/remover a credencial do projeto invalida.
- ssh: só o nome resolvido é conferido contra destinos internos (o ssh resolve de novo), como no teste de acesso.
- Enquanto o git roda (até 10 s) o token está no ambiente do processo (mesmo risco documentado do teste de acesso).
- Se o repositório avançar entre a consulta e o clique, o deploy baixa o commit mais novo; o aviso se corrige na
  consulta seguinte (o commit no ar é lido de verdade ao fim do deploy).
- "Verificar agora" repetido em menos de 10 s reaproveita a consulta anterior (evita martelar o servidor remoto).

## Verificação

Testes novos: `packages/deploy/tests/update-check.test.ts` (repositórios e servidores HTTP locais de verdade),
`apps/server/tests/{update-check-service,deploy-update-status,routes-projects-update-status}.test.ts`,
`apps/web/tests/update-notice.test.tsx`. Não foi possível testar contra o GitHub/GitLab reais nem com um token
real (sem rede externa); a classificação de erros usa as mesmas mensagens já conhecidas do "Testar acesso".
Falta ver a tela a 360 px em navegador real (a verificação foi por classes e testes de componente).
