# Estado do trabalho — TWS Panel

Atualizado em: 2026-11-13

Este arquivo cobre **só o trabalho do painel** (este repositório público) e só o que é **de longa
duração**: itens parados, pendências, ideias, decisões e uma lista curta do que entrou por último. A
parte operacional (servidores, instalações, outros projetos) fica num plano privado, fora deste
repositório.

**Tarefa em curso não aparece aqui.** Ela é descoberta por `git worktree list` (worktrees em
`.claude/worktrees/`) e por `gh pr list`; o que foi mesclado aparece em `gh pr list --state merged`
e no `git log` da `main`. Este arquivo só muda quando o plano muda, pela sessão principal, numa
branch `docs/estado-<data>` com PR (veja
[`docs/processo/forma-de-trabalhar.md`](../processo/forma-de-trabalhar.md)).

## Itens parados

- **Documentação no domínio próprio** — PR #30 (rascunho), branch `docs/dominio-proprio`.
  Aguardando o DNS do domínio da documentação.
- **xterm 6** — PR #21 (Dependabot), `@xterm/xterm` de 5.5.0 para 6.0.0. Aguardando teste manual do
  terminal web antes de mesclar.
- **Atualizações grandes do Dependabot** — PRs #20 (TypeScript 7.0.2), #22 (`react-dom` e
  `@types/react-dom`), #24 (`react` e `@types/react`) e #25 (React Router 8.5.1), todos com o `ci`
  reprovado e exigindo migração. Recomendação: não mesclar agora e configurar o
  `.github/dependabot.yml` para ignorar versões major — aguarda o Kelvin.

## Pendente

- **Normalização de IP no limite de tentativas (rate-limit).** Agora que o `@fastify/rate-limit`
  está na 11.2.2 (PR #23, mesclado), normalizar o IP (IPv6 agrupado por /64 com o `normalizeIP`
  exportado pela biblioteca) nos `keyGenerator` de `apps/server/src/app.ts`,
  `apps/server/src/routes/projects.ts` e `apps/server/src/routes/mcp.ts` e no
  `apps/server/src/services/login-limiter.ts`, com testes.
- **Lançamento open source v0.2.0.** Aguardando o domínio da documentação (PR #30).
- **Aposentar a `dev`:** tirar dos gatilhos do `ci.yml`, conferir que os 6 commits dela já estão na
  `main`, remover a regra `protect-dev` e apagar a branch — aguarda o Kelvin.

## Futuro

- **Botão "Fazer backup de tudo agora"** (ideia).
- **Backup de projeto sem nada a copiar não deve aparecer como "Falhou"** (ideia).

## Decisões do Kelvin

- 2026-11-13 — O repositório segue o fluxo global de subagentes, com a exceção de integração por PR
  para a `main` (squash, mesclado manualmente pelo Kelvin); a `dev` não é usada.
- Aguarda confirmação — **Branch local depois do squash:** regra vigente em
  `docs/processo/forma-de-trabalhar.md` (o guardião lista as branches locais já mescladas para o
  Kelvin apagar, porque `git branch -d` recusa e o `-D` é bloqueado pelas proteções dos agentes).

## Concluído (recente)

Lista curta, pode ficar defasada; a fonte é `gh pr list --state merged`.

- 2026-11-13 — Alertas do code scanning corrigidos e envio SMTP do painel com certificado conferido
  (PR #32).
- 2026-11-13 — Botão "Copiar instruções para o agente" no novo projeto e no menu de Ajuda (PR #31).
- 2026-11-13 — Instruções para agentes de IA, `llms.txt` e Easypanel na comparação (PR #29).
- 2026-11-13 — Webmail na versão de segurança do Roundcube 1.7.6 (PR #28).
- 2026-11-13 — `@fastify/rate-limit` 11.2.2 (PR #23).
