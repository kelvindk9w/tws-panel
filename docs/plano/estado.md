# Estado do trabalho — TWS Panel

Atualizado em: 2026-11-13

Este arquivo cobre **só o trabalho do painel** (este repositório público). A parte operacional
(servidores, instalações, outros projetos) fica num plano privado, fora deste repositório. Como a
`main` só aceita PR, cada tarefa atualiza este arquivo no próprio PR, num último commit feito pelo
guardião (veja "Quem escreve no `estado.md`" em
[`docs/processo/forma-de-trabalhar.md`](../processo/forma-de-trabalhar.md)).

## Em andamento

- **Forma de trabalhar com agentes** — branch `docs/fluxo-de-trabalho-agentes`.
  - Adapta o repositório ao fluxo global de subagentes: `CLAUDE.md` na raiz,
    `docs/processo/forma-de-trabalhar.md` e este arquivo.
  - Estado: em revisão. O último commit desta branch, feito pelo guardião depois do APROVADO e da
    abertura do PR, move esta entrada para *Concluído (recente)* com o número do PR.
- **Documentação no domínio próprio** — PR #30 (rascunho), branch `docs/dominio-proprio`.
  - Estado: aguardando o DNS do domínio da documentação.
- **xterm 6** — PR #21 (Dependabot), atualização de `@xterm/xterm` de 5.5.0 para 6.0.0.
  - Estado: aguardando teste manual do terminal web antes de mesclar.

## Pendente

- **Normalização de IP no limite de tentativas (rate-limit).** Agora que o `@fastify/rate-limit`
  está na 11.2.2 (PR #23, mesclado), normalizar o IP (IPv6 agrupado por /64 com o `normalizeIP`
  exportado pela biblioteca) nos `keyGenerator` de `apps/server/src/app.ts`,
  `apps/server/src/routes/projects.ts` e `apps/server/src/routes/mcp.ts` e no
  `apps/server/src/services/login-limiter.ts`, com testes.
- **Atualizações grandes do Dependabot — não mesclar agora.** Os PRs #20 (TypeScript 7.0.2),
  #22 (`react-dom` e `@types/react-dom`), #24 (`react` e `@types/react`) e #25 (React Router 8.5.1)
  estão com o `ci` reprovado e exigem migração. Decisão: não mesclar agora e configurar o
  `.github/dependabot.yml` para ignorar versões grandes (major).
- **Lançamento open source v0.2.0.** Aguardando o domínio da documentação (PR #30).
- **Aposentar a `dev`:** tirar dos gatilhos do `ci.yml`, conferir que os 6 commits dela já estão na
  `main`, remover a regra `protect-dev` e apagar a branch — aguarda o Kelvin.
- **Branch local depois do squash** — regra vigente em `docs/processo/forma-de-trabalhar.md` (o
  guardião lista as branches locais já mescladas para o Kelvin apagar, porque o `-D` é bloqueado
  pelas proteções dos agentes) — aguarda a confirmação do Kelvin.
- **Commit do `estado.md` pelo guardião no PR da tarefa** — regra vigente em
  `docs/processo/forma-de-trabalhar.md` — aguarda a confirmação do Kelvin.

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
| `docs/fluxo-de-trabalho-agentes` | Forma de trabalhar com agentes | fora do repositório (scratchpad da sessão; criado antes da regra de `.claude/worktrees/`) | em execução | — |
| `docs/dominio-proprio` | Documentação no domínio próprio | — | aguardando DNS | #30 |
| `dependabot/npm_and_yarn/xterm/xterm-6.0.0` | xterm 6 | — (Dependabot) | aguardando teste manual | #21 |
| `dependabot/npm_and_yarn/typescript-7.0.2` | TypeScript 7.0.2 | — (Dependabot) | `ci` reprovado; não mesclar agora | #20 |
| `dependabot/npm_and_yarn/multi-75c0a8599d` | `react-dom` e `@types/react-dom` | — (Dependabot) | `ci` reprovado; não mesclar agora | #22 |
| `dependabot/npm_and_yarn/multi-b1658bdecd` | `react` e `@types/react` | — (Dependabot) | `ci` reprovado; não mesclar agora | #24 |
| `dependabot/npm_and_yarn/react-router-8.5.1` | React Router 8.5.1 | — (Dependabot) | `ci` reprovado; não mesclar agora | #25 |
