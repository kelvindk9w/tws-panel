# TWS Panel — instruções para o Claude Code

Painel PaaS self-hosted (monorepo pnpm: `apps/server`, `apps/web`, `packages/*`). Este repositório
segue o fluxo global de trabalho com subagentes (orquestrador, `executor`, `revisor`,
`guardiao-git`). Sessão nova: leia os dois arquivos abaixo antes de qualquer coisa e continue de onde
parou.

- [`docs/processo/forma-de-trabalhar.md`](docs/processo/forma-de-trabalhar.md) — o que é específico
  deste repositório: integração, comandos de verificação, lista de conferência do revisor, worktrees
  e termos proibidos. **Prevalece sobre as instruções genéricas dos agentes.**
- [`docs/plano/estado.md`](docs/plano/estado.md) — o que é de longa duração (itens parados,
  pendências, ideias, decisões). Tarefa em curso não fica nele: veja `git worktree list` e
  `gh pr list`.

Responda em português do Brasil, com acentos.

## Três regras que nenhuma sessão pode esquecer

1. **Integração só por PR para a `main`.** A `main` é protegida no GitHub (exige PR, o check `ci`
   verde, a branch atualizada e só aceita squash), e a `dev` não é usada aqui. A branch da tarefa
   nasce da `origin/main`, num worktree em `.claude/worktrees/`; o guardião (sempre no worktree da
   tarefa, nunca no checkout principal) deixa o PR atualizado e verde, sem commit depois da
   aprovação além do merge de `origin/main` quando ela avança, e avisa o Kelvin; o **Kelvin mescla manualmente** (squash); depois o guardião limpa o
   worktree e a branch remota; lista as branches locais para o Kelvin apagar.
   Nada de `git push origin dev:main`, commit direto na `main`, force-push ou reescrita de histórico.
2. **O repositório é público.** Nenhum nome de cliente, projeto privado, IP real, domínio de cliente,
   hostname de VPS ou caminho da máquina em código, docs, nome de arquivo, commit ou PR. Antes de
   cada push, varra o diff pelos termos proibidos (a lista fica num arquivo local fora do
   versionamento e o orquestrador a passa ao agente) e rode `node scripts/check-no-real-hosts.mjs`.
3. **Consulte `comoFuncionaSistema/` antes de explorar o código.** Comece por
   [`comoFuncionaSistema/index.json`](comoFuncionaSistema/index.json), abra só o módulo e o arquivo
   do assunto, e atualize o JSON correspondente quando o comportamento mudar.
