# TWS Panel — instruções para o Claude Code

Painel PaaS self-hosted (monorepo pnpm: `apps/server`, `apps/web`, `packages/*`). Este repositório
segue o fluxo global de trabalho com subagentes (orquestrador, `executor`, `revisor`,
`guardiao-git`). Sessão nova: leia os dois arquivos abaixo antes de qualquer coisa e continue de onde
parou (a seção *Retomada* do primeiro diz como descobrir o estado real).

- [`docs/processo/forma-de-trabalhar.md`](docs/processo/forma-de-trabalhar.md) — o que é específico
  deste repositório: as três branches, os papéis, cada passo com os comandos, a etapa da VPS de
  testes, o lançamento, o retorno, conflitos, verificações, lista do revisor e termos proibidos.
  **Prevalece sobre as instruções genéricas dos agentes.**
- [`docs/plano/estado.md`](docs/plano/estado.md) — o que é de longa duração (itens parados,
  pendências, ideias, decisões). Tarefa em curso não fica nele: veja `git worktree list` e
  `gh pr list`.

Responda em português do Brasil, com acentos.

## Três regras que nenhuma sessão pode esquecer

1. **O código anda `dev` → `sandbox` → `main`.** A branch da tarefa nasce da `origin/dev`, num
   worktree em `.claude/worktrees/`; o guardião integra na `dev` com merge `--no-ff` (nunca no
   checkout principal, que é do Kelvin). A `sandbox` só avança por fast-forward até a `dev` com o
   `ci` verde, e o guardião atualiza e valida a VPS de testes com
   `scripts/processo/atualizar-sandbox.sh`. A `main` só recebe o PR `sandbox → main`, que o guardião
   abre com o resumo da validação e o **Kelvin mescla com merge commit**; depois o Kelvin roda o
   instalador na produção (**nenhum agente roda comando na produção**) e o guardião traz a `main` de
   volta para a `dev` e a `sandbox`. Nada de commit direto na `main`, push forçado, rebase de branch
   enviada ou reescrita de histórico.
2. **O repositório é público.** Nenhum nome de cliente, projeto privado, IP real, domínio de cliente,
   hostname de VPS ou caminho da máquina em código, docs, nome de arquivo, commit ou PR. A VPS de
   testes entra só por um alias do `~/.ssh/config` (`TWS_SANDBOX_SSH`). Antes de cada push, varra o
   diff pelos termos proibidos (a lista fica num arquivo local fora do versionamento e o orquestrador
   a passa ao agente) e rode `node scripts/check-no-real-hosts.mjs`.
3. **Consulte `comoFuncionaSistema/` antes de explorar o código.** Comece por
   [`comoFuncionaSistema/index.json`](comoFuncionaSistema/index.json), abra só o módulo e o arquivo
   do assunto, e atualize o JSON correspondente quando o comportamento mudar.
