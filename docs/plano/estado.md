# Estado do trabalho — TWS Panel

Atualizado em: 2026-11-14

Este arquivo cobre **só o trabalho do painel** (este repositório público) e só o que é **de longa
duração**: itens parados, pendências, ideias, decisões e uma lista curta do que entrou por último. A
parte operacional (servidores, instalações, outros projetos) fica num plano privado, fora deste
repositório.

**Tarefa em curso não aparece aqui.** Ela é descoberta por `git worktree list` (worktrees em
`.claude/worktrees/`) e por `gh pr list`; o que está em cada etapa aparece em
`git log origin/sandbox..origin/dev` (falta ir para a sandbox) e `git log origin/main..origin/sandbox`
(falta lançar). Quem edita este arquivo é só o guardião, com commit na `dev`, quando o orquestrador
pede (veja [`docs/processo/forma-de-trabalhar.md`](../processo/forma-de-trabalhar.md#o-estadomd)).

## Itens parados

- **Documentação no domínio próprio** — PR #30 (rascunho, base `dev`), branch `docs/dominio-proprio`,
  **aprovado pelo revisor** no hash `d75b782a`. Não integrar ainda: só entra na `dev` depois que o
  Kelvin confirmar (1) a verificação TXT do domínio no GitHub e (2) o CNAME `docs` para
  `kelvindk9w.github.io` na Cloudflare. **Passo do Kelvin no dia do lançamento:** logo depois de
  mesclar o PR de lançamento na `main`, configurar o domínio próprio da documentação (o mesmo do CNAME `docs`) em Settings → Pages e, em
  seguida, marcar **Enforce HTTPS**.
- **xterm 6** — o PR #21 (Dependabot) foi fechado; `@xterm/xterm` de 5.5.0 para 6.0.0 volta como
  tarefa própria, com teste manual do terminal web no navegador antes de integrar.
- **Atualizações grandes do Dependabot** — os PRs #20 (TypeScript 7.0.2), #22 (`react-dom` e
  `@types/react-dom`), #24 (`react` e `@types/react`) e #25 (React Router 8.5.1) foram fechados por
  exigirem migração; cada salto de major volta como tarefa própria quando for a hora. Com a
  `ignore` de versão major no Dependabot, eles não reabrem sozinhos.

## Pendente

- **Normalização de IP no limite de tentativas (rate-limit).** Agora que o `@fastify/rate-limit`
  está na 11.2.2 (PR #23, mesclado), normalizar o IP (IPv6 agrupado por /64 com o `normalizeIP`
  exportado pela biblioteca) nos `keyGenerator` de `apps/server/src/app.ts`,
  `apps/server/src/routes/projects.ts` e `apps/server/src/routes/mcp.ts` e no
  `apps/server/src/services/login-limiter.ts`, com testes.
- **Lançamento open source v0.2.0.** Aguardando o domínio da documentação (PR #30).
- **Comentário do Dockerfile desatualizado.** O comentário da linha 21 diz "Node 22.23.4", mas a
  imagem fixada agora é a 22.23.5 (PR #42). Atualizar o texto na próxima mexida no Dockerfile.

- **Sugestões opcionais do revisor do PR #30 (pendência pequena).** (1) Alinhar o texto do
  redirecionamento 301 do endereço antigo: `CHANGELOG.md` (linha 568), o comentário do
  `site/astro.config.mjs` (linha 11) e `comoFuncionaSistema/index.json` (linha 74) afirmam um
  redirecionamento que a documentação do GitHub Pages não garante. (2) Escrever testes para o check
  de CNAME/base e para o `sitePageExists`.

- **Leva do teste real com o starter kit** (dados do teste na VPS de testes). **Decisão do Kelvin de
  2026-11-15:** fechar esta etapa só com o que já está pronto. O terceiro lançamento leva o que está
  na `dev`, incluindo a página "Atualizando" (`fix/atualizando-upstream-502`, já na `dev`), depois da
  validação real na VPS de testes.
  - *Ficam para a próxima etapa* (mexem no `deploy-service.ts`): alerta "Deploy bloqueado" que fica
    aberto depois de remover o projeto; erro do `compose down` ao remover projeto nunca publicado;
    campo opcional de pasta e compose para monorepo, que também resolve a aba Banco e o diagnóstico
    com o Laravel em subpasta; melhoria do aviso de segredo no código (falso positivo de
    `secret-in-code`).
  - *Regra desta leva:* os executores **não editam o `CHANGELOG.md`**; uma tarefa escreve as entradas
    do lançamento de uma vez.
  - *Fora deste repositório, aguardando o Kelvin:* adaptar o starter kit para o painel (compose
    próprio, nginx atrás de proxy, `.env.prod.example`).

- **Acento ou emoji cortado no log do deploy.** Em `packages/deploy/src/exec.ts`, cada pedaço da
  saída é convertido para texto separadamente; um caractere que chega dividido entre dois pedaços vira
  "�" no log. Corrigir com um decodificador de fluxo (`TextDecoder` com `stream: true`, ou
  `StringDecoder`). Será uma tarefa `fix/` própria, depois da leva atual.

- **Porta publicada: pontos a decidir com o Kelvin (depois do `fix/texto-porta-interna`).**
  (1) Severidade quando o padrão da variável de endereço é `0.0.0.0` ou vazio: hoje só avisa e o
  executor acha que deveria bloquear. (2) A prévia do assistente marca "critical" quando o deploy só
  avisa. (3) O modal Portas do web (`apps/web/src/lib/ports.ts`, `bindingText`) põe colchetes em
  endereço que vem de variável. (4) A evidência de porta aleatória sai com dois-pontos dobrado.

- **Aviso "fatal: Needed a single revision" nos testes do pacote core.** Algum teste chama o git e
  imprime o aviso; nada falha. Achar a origem depois.

## Futuro

- **Botão "Fazer backup de tudo agora"** (ideia).
- **Backup de projeto sem nada a copiar não deve aparecer como "Falhou"** (ideia).

## Decisões do Kelvin

- 2026-11-14 — Fluxo `dev` → `sandbox` → `main`: tarefas integradas na `dev` pelo guardião (merge
  `--no-ff`); a `sandbox` só avança por fast-forward até a `dev` com o `ci` verde e é o que roda na
  VPS de testes; a `main` só recebe o PR `sandbox → main`, mesclado pelo Kelvin com merge commit
  (ruleset `protect-main` só aceita merge); depois do lançamento, a `main` volta para a `dev` e a
  `sandbox`. Substitui a decisão de 2026-11-13 (PR com squash direto na `main`, `dev` sem uso).
- 2026-11-14 — **Dependabot ignora saltos de versão maior** em `.github/dependabot.yml`; major é
  sempre tarefa própria.

## Concluído (recente)

Lista curta, pode ficar defasada; a fonte é `gh pr list --state merged` e o `git log` da `dev` e da
`main`.

- 2026-11-14 — Primeiro lançamento pelo fluxo novo: PR #41 (`sandbox` → `main`, merge commit
  `d9b9511a`) em produção, com os PRs #33, #35, #37, #38, #39, o instalador sem `continuar` na
  reinstalação, o script da sandbox e os testes sem Docker real. A `main` voltou para a `dev` e a
  `sandbox`.
- 2026-11-14 — Na `dev`, aguardando o próximo lançamento: imagem `node:22-bookworm-slim` com o
  digest novo, Node 22.23.5 (PR #42, Dependabot).
- 2026-11-14 — Na `dev`, aguardando o próximo lançamento: textos do reparo do AOF descrevem a pane
  real (lixo no fim do arquivo; truncar não a reproduz), nos guias, no `comoFuncionaSistema/` e nos
  comentários do código.
- 2026-11-14 — Na `dev`, aguardando o próximo lançamento: aviso de porta publicada que diz onde a
  porta fica de verdade (`fix/texto-porta-interna`).
- 2026-11-15 — Na `dev`, aguardando o próximo lançamento: o log de um deploy muito longo guarda o
  começo e o fim (`fix/log-deploy-comeco-e-fim`).
- 2026-11-15 — Na `dev`, aguardando o terceiro lançamento: CHANGELOG com as entradas do log do
  deploy, do aviso de porta publicada, do reparo do AOF, do Node 22.23.5, do Dependabot e da página
  "Atualizando"; e a página "Atualizando" quando o upstream responde 502, 503 ou 504 durante o deploy
  (`fix/atualizando-upstream-502`). O commit `ccc43b7f` fica, não se reverte.
- 2026-11-14 — Segundo lançamento: PR #43 (`sandbox` → `main`, merge commit `025ad1c5`) em
  produção, com o aviso de disco não ampliado, a barreira de testes contra o Docker real (PR #40) e
  o Dependabot sem saltos de major. A `main` voltou para a `dev` e a `sandbox` (fast-forward).
- 2026-11-14 — `dev` e `sandbox` iguais à `main` (merge de reconciliação), ruleset
  `protect-sandbox`, `protect-main` só com merge commit e PRs abertos redirecionados para a `dev`.
- 2026-11-13 — Alertas do code scanning corrigidos e envio SMTP do painel com certificado conferido
  (PR #32).
- 2026-11-13 — Botão "Copiar instruções para o agente" no novo projeto e no menu de Ajuda (PR #31).
- 2026-11-13 — Instruções para agentes de IA, `llms.txt` e Easypanel na comparação (PR #29).
- 2026-11-13 — Webmail na versão de segurança do Roundcube 1.7.6 (PR #28).
- 2026-11-13 — `@fastify/rate-limit` 11.2.2 (PR #23).
