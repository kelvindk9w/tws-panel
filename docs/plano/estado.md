# Estado do trabalho — TWS Panel

Atualizado em: 2026-11-13

Este arquivo cobre **só o trabalho do painel** (este repositório público). A parte operacional
(servidores, instalações, outros projetos) fica num plano privado, fora deste repositório. Como a
`main` só aceita PR, as atualizações deste arquivo também entram por PR (veja
[`docs/processo/forma-de-trabalhar.md`](../processo/forma-de-trabalhar.md)).

## Em andamento

- **Forma de trabalhar com agentes** — branch `docs/fluxo-de-trabalho-agentes`.
  - Adapta o repositório ao fluxo global de subagentes: `CLAUDE.md` na raiz,
    `docs/processo/forma-de-trabalhar.md` e este arquivo.
  - Estado: em execução; depois vai para revisão e PR.
- **Documentação no domínio próprio** — PR #30 (rascunho), branch `docs/dominio-proprio`.
  - Estado: aguardando o DNS do domínio da documentação.
- **xterm 6** — PR #21 (Dependabot), atualização de `@xterm/xterm` de 5.5.0 para 6.0.0.
  - Estado: aguardando teste manual do terminal web antes de mesclar.

## Pendente

- **Normalização de IP no limite de tentativas (rate-limit).** Ajuste a fazer depois da atualização
  do `@fastify/rate-limit` para a 11.2.2 (PR #23, já mesclado).
- **Lançamento open source v0.2.0.** Aguardando o domínio da documentação (PR #30).
- **Aposentar a `dev`:** tirar dos gatilhos do `ci.yml`, conferir que os 6 commits dela já estão na
  `main`, remover a regra `protect-dev` e apagar a branch — aguarda o Kelvin.

## Futuro

- **Botão "Fazer backup de tudo agora"** (ideia).
- **Backup de projeto sem nada a copiar não deve aparecer como "Falhou"** (ideia).

## Concluído (recente)

- 2026-11-13 — Alertas do code scanning corrigidos e envio SMTP do painel com certificado conferido
  (PR #32).
- 2026-11-13 — Botão "Copiar instruções para o agente" no novo projeto e no menu de Ajuda (PR #31).
- 2026-11-13 — Instruções para agentes de IA, `llms.txt` e Easypanel na comparação (PR #29).
- 2026-11-13 — Webmail na versão de segurança do Roundcube 1.7.6 (PR #28).
- 2026-11-13 — `@fastify/rate-limit` 11.2.2 (PR #23).

## Registro de branches

| Branch | Tarefa | Worktree | Estado | PR |
|---|---|---|---|---|
| `docs/fluxo-de-trabalho-agentes` | Forma de trabalhar com agentes | scratchpad da sessão | em execução | — |
| `docs/dominio-proprio` | Documentação no domínio próprio | — | aguardando DNS | #30 |
| `dependabot/npm_and_yarn/xterm/xterm-6.0.0` | xterm 6 | — (Dependabot) | aguardando teste manual | #21 |
