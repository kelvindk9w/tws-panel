# Estado do trabalho — TWS Panel

Atualizado em: 2026-11-15

Este arquivo cobre **só o trabalho do painel** (este repositório público) e só o que é **de longa
duração**: itens parados, pendências, ideias, decisões e uma lista curta do que entrou por último. A
parte operacional (servidores, instalações, outros projetos) fica num plano privado, fora deste
repositório.

**Tarefa em curso não aparece aqui.** Ela é descoberta por `git worktree list` (worktrees em
`.claude/worktrees/`) e por `gh pr list`; o que está em cada etapa aparece em
`git log origin/sandbox..origin/dev` (falta ir para a sandbox) e `git log origin/main..origin/sandbox`
(falta lançar). Quem edita este arquivo é só o guardião, com commit na `dev`, quando o orquestrador
pede (veja [`docs/processo/forma-de-trabalhar.md`](../processo/forma-de-trabalhar.md#o-estadomd)).

## Para retomar

Leia esta seção primeiro. Ela foi escrita no fim da terceira etapa (15/11/2026).

### a) Onde parou

- Etapa encerrada. A `main`, a `sandbox` e a `dev` estão iguais, exceto o(s) commit(s) do próprio
  `estado.md` que ficam só na `dev` até o próximo lançamento (não precisam de PR sozinhos).
- Nada em andamento: nenhuma tarefa em curso, nenhum worktree de tarefa.
- O único PR aberto é o **#30** (documentação no domínio próprio, rascunho), esperando o DNS.

### b) O que depende do Kelvin

- **DNS do PR #30:** (1) o registro TXT de verificação do GitHub Pages no perfil; (2) um CNAME `docs`
  apontando para `<usuário>.github.io`, com a nuvem cinza (só DNS) na Cloudflare. Depois do
  lançamento que levar o #30, definir o domínio em Settings → Pages e marcar **Enforce HTTPS**. O
  #30 já foi aprovado pelo revisor (hash `d75b782a`) e só entra na `dev` depois do DNS.
- **Decidir** se as adaptações do starter kit Laravel para o painel serão feitas (compose próprio,
  nginx atrás de proxy, `.env.prod.example`; é trabalho fora deste repositório).
- **Decidir quando** fazer a melhoria do aviso de segredo no código (item 3 da próxima etapa).

### c) Próxima etapa, em ordem de prioridade

1. **Aviso "Deploy bloqueado" que fica aberto depois de remover o projeto, e erro do `compose down`
   ao remover projeto nunca publicado** (`deploy-service.ts`). Resolve: o alerta some junto com o
   projeto, e remover um projeto que nunca foi publicado deixa de dar erro.
2. **Campo opcional de pasta e compose para monorepo.** Resolve: projeto com o app numa subpasta
   funciona, e a aba Banco e o diagnóstico passam a achar o banco (por exemplo, Laravel em subpasta).
3. **Melhoria do aviso de segredo no código** (`secret-in-code`): `pk_` fora, `rk_` dentro, PEM só
   com corpo de 64 caracteres ou mais, dispensa pelo hash do valor exato, mensagem mais clara e aviso
   ao bater no limite de 2.000 arquivos. Resolve: menos falso positivo e um aviso que se entende.
4. **Juntar ou investigar as recargas do Caddy** (4 por deploy; cada uma pode derrubar uma conexão
   em andamento). Resolve: menos "connection reset" durante o deploy.
5. **Dica no guia do compose: nginx com `resolver 127.0.0.11`** para não guardar o IP antigo do app
   (`fastcgi_pass app:9000` fixo). Resolve: o site de um compose com nginx próprio não quebra quando
   o app é recriado.
6. **Linha "troca dos containers começou" aparece mesmo sem recriar nada.** Resolve: o log deixa de
   sugerir uma troca que não houve (inofensivo).
7. **Caracteres UTF-8 partidos em `packages/deploy/src/exec.ts`**: usar um decodificador em fluxo
   (`TextDecoder` com `stream: true`, ou `StringDecoder`). Resolve: acento ou emoji dividido entre
   dois pedaços da saída deixa de virar "�" no log do deploy.
8. **Aviso "fatal: Needed a single revision" nos testes do pacote core.** Resolve: some o ruído; achar
   qual teste chama o git. Nada falha hoje.
9. **Comentário da linha 21 do `Dockerfile`** (22.23.4 → 22.23.5). Resolve: o comentário volta a
   dizer a versão da imagem fixada.
10. **As quatro decisões de porta publicada:** (1) gravidade quando o padrão da variável de endereço
    é `0.0.0.0` ou vazio (hoje só avisa; o executor acha que deveria bloquear); (2) a prévia do
    assistente marca "crítico" quando o deploy só avisa; (3) colchetes em endereço que vem de variável
    no modal de portas (`apps/web/src/lib/ports.ts`, `bindingText`); (4) dois-pontos duplos na
    evidência de porta aleatória. Resolve: o aviso de porta fica coerente em toda a tela.
11. **Sugestões do revisor no #30:** alinhar o texto do redirecionamento 301 (`CHANGELOG.md`,
    comentário do `site/astro.config.mjs`, `comoFuncionaSistema/index.json`) e escrever testes para o
    check de CNAME/base e para o `sitePageExists`. Resolve: o texto não promete o que o GitHub Pages
    não garante, e o check ganha cobertura.
12. **Normalização de IP no limite de tentativas (rate-limit):** IPv6 agrupado por /64 com o
    `normalizeIP` da biblioteca (`@fastify/rate-limit` 11.2.2), nos `keyGenerator` de
    `apps/server/src/app.ts`, `routes/projects.ts`, `routes/mcp.ts` e no `services/login-limiter.ts`,
    com testes. Resolve: quem troca de endereço IPv6 não escapa do limite.
13. **Saltos de versão maior (major):** xterm 6 (com teste manual do terminal web no navegador) e
    TypeScript 7, além de `react`/`react-dom` e React Router. O Dependabot ignora majors; fazer à mão,
    cada uma como tarefa própria. Resolve: dependências em dia sem PR quebrado.
14. **Lançamento open source v0.2.0.** Depende do #30. Resolve: abre o projeto ao público.
15. **Ideias de backup:** botão "Fazer backup de tudo agora" e backup de projeto sem nada a copiar
    não aparecer como "Falhou".

### d) Decisões já tomadas, que não se refazem

- Fluxo `dev` → `sandbox` → `main`, com **merge commit** na `main` (detalhes na seção *Decisões do
  Kelvin*).
- **Dependabot sem saltos de versão maior.**
- A página "Atualizando" só aparece na **fase de troca** dos containers (o limite de 5 s termina antes
  do health check).

### e) Como retomar

Leia [`docs/processo/forma-de-trabalhar.md`](../processo/forma-de-trabalhar.md) e esta seção. A
primeira tarefa sai da `dev`, num worktree em `.claude/worktrees/`.

## Itens parados

- **Documentação no domínio próprio** — PR #30 (rascunho, base `dev`), branch `docs/dominio-proprio`,
  aprovado pelo revisor no hash `d75b782a`. Aguarda o DNS (veja *Para retomar*, item b).

## Decisões do Kelvin

- 2026-11-14 — Fluxo `dev` → `sandbox` → `main`: tarefas integradas na `dev` pelo guardião (merge
  `--no-ff`); a `sandbox` só avança por fast-forward até a `dev` com o `ci` verde e é o que roda na
  VPS de testes; a `main` só recebe o PR `sandbox → main`, mesclado pelo Kelvin com merge commit
  (ruleset `protect-main` só aceita merge); depois do lançamento, a `main` volta para a `dev` e a
  `sandbox`. Substitui a decisão de 2026-11-13 (PR com squash direto na `main`, `dev` sem uso).
- 2026-11-14 — **Dependabot ignora saltos de versão maior** em `.github/dependabot.yml`; major é
  sempre tarefa própria.
- 2026-11-15 — Etapa fechada só com o que estava pronto; o resto virou a lista da próxima etapa
  (*Para retomar*, item c). Regra da leva: os executores não editam o `CHANGELOG.md`; uma tarefa
  escreve as entradas do lançamento de uma vez.

## Concluído (recente)

Lista curta, pode ficar defasada; a fonte é `gh pr list --state merged` e o `git log` da `dev` e da
`main`.

- 2026-11-15 — Terceiro lançamento: PR #44 (`sandbox` → `main`, merge commit `faafb195`), instalado
  na produção em 15/11/2026: página "Atualizando" no redeploy, log do deploy com começo e fim, aviso
  de porta publicada, textos do reparo do AOF e imagem Node 22.23.5. A `main` voltou para a `sandbox`
  e para a `dev`.
- 2026-11-14 — Segundo lançamento: PR #43 (`sandbox` → `main`, merge commit `025ad1c5`) em
  produção, com o aviso de disco não ampliado, a barreira de testes contra o Docker real (PR #40) e
  o Dependabot sem saltos de major.
- 2026-11-14 — Primeiro lançamento pelo fluxo novo: PR #41 (`sandbox` → `main`, merge commit
  `d9b9511a`) em produção, com os PRs #33, #35, #37, #38, #39, o instalador sem `continuar` na
  reinstalação, o script da sandbox e os testes sem Docker real.
- 2026-11-14 — `dev` e `sandbox` iguais à `main` (merge de reconciliação), ruleset
  `protect-sandbox`, `protect-main` só com merge commit e PRs abertos redirecionados para a `dev`.
- 2026-11-13 — Alertas do code scanning corrigidos e envio SMTP do painel com certificado conferido
  (PR #32).
- 2026-11-13 — Botão "Copiar instruções para o agente" no novo projeto e no menu de Ajuda (PR #31).
- 2026-11-13 — Instruções para agentes de IA, `llms.txt` e Easypanel na comparação (PR #29).
- 2026-11-13 — Webmail na versão de segurança do Roundcube 1.7.6 (PR #28).
- 2026-11-13 — `@fastify/rate-limit` 11.2.2 (PR #23).
