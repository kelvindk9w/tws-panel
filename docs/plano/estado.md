# Estado do trabalho — TWS Panel

Atualizado em: 2026-11-24

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
- A `dev` já tem o **#30** (documentação em `docs.tws.tec.br/tws-panel/`, aprovado no hash `091a711c`)
  e espera o DNS para o próximo lançamento; a `sandbox` e a `main` não o têm ainda.

### b) O que depende do Kelvin

- **Domínio da documentação (PR #30), nesta ordem:** (1) o registro TXT de verificação do GitHub
  Pages no perfil; (2) o CNAME `docs` apontando para `<usuário>.github.io`, com a nuvem cinza (só DNS)
  na Cloudflare, sem curinga; (3) criar o repositório `<usuário>.github.io` e configurar nele o
  domínio `docs.tws.tec.br` em Settings → Pages, marcando **Enforce HTTPS**. O lançamento que levar o
  #30 para a `main` só acontece depois que `https://docs.tws.tec.br/tws-panel/` responder; depois da
  troca, conferir com `curl -sI` se o endereço antigo `<usuário>.github.io/tws-panel/en/`
  redireciona. Não há domínio no repositório do painel.
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
11. **Sugestões não bloqueantes do revisor sobre o #30 (24/11):** (i) a lista "Today those are" em
    `site/README.md` não cita o `package.json` (citá-lo ou trocar pela referência ao `--list`);
    (ii) `sitePageExists` em `scripts/site-config.mjs` deveria aceitar arquivos de `site/public`;
    (iii) a detecção de "chamado direto" em `scripts/check-site-url.mjs`,
    `scripts/check-no-real-hosts.mjs` e `scripts/check-commit-authors.mjs` deveria comparar caminhos
    reais (link simbólico); (iv) uma frase no passo 2 do `site/README.md` explicando por que o DNS
    antes do Settings é seguro aqui (a verificação do passo 1). Resolve: documentação e verificadores
    mais precisos; nada disso bloqueia o lançamento.
12. **Normalização de IP no limite de tentativas (rate-limit):** IPv6 agrupado por /64 com o
    `normalizeIP` da biblioteca (`@fastify/rate-limit` 11.2.2), nos `keyGenerator` de
    `apps/server/src/app.ts`, `routes/projects.ts`, `routes/mcp.ts` e no `services/login-limiter.ts`,
    com testes. Resolve: quem troca de endereço IPv6 não escapa do limite.
13. **Saltos de versão maior (major):** xterm 6 (com teste manual do terminal web no navegador) e
    TypeScript 7, além de `react`/`react-dom` e React Router. O Dependabot ignora majors; fazer à mão,
    cada uma como tarefa própria. Resolve: dependências em dia sem PR quebrado.
14. **Lançamento open source v0.2.0.** Depende do #30. Resolve: abre o projeto ao público. Falta:
    - release `v0.2.0` com notas em inglês (o selo de release do README hoje mostra erro porque não
      há release);
    - teste de instalação do zero na VPS de testes, com o comando exato do README (Ubuntu 22.04 e
      24.04);
    - enviar a imagem de prévia social (só pela interface do GitHub);
    - abrir as issues para iniciantes;
    - post de boas-vindas fixado no Discussions;
    - página do projeto no site da TWS;
    - para a onda internacional: capturas e vídeo com a interface em inglês e as mensagens do
      servidor traduzidas.
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

- Nenhum.

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

- 2026-11-24 — **Documentação dos projetos open source em `docs.tws.tec.br/<repositório>/`**, pelo
  recurso de domínio herdado do GitHub Pages: o domínio `docs.tws.tec.br` fica no site de usuário
  (`<usuário>.github.io`) e os sites de projeto sem domínio próprio aparecem como pasta. A do painel
  fica em `https://docs.tws.tec.br/tws-panel/`; o repositório do painel não tem domínio próprio em
  Settings → Pages. A raiz `docs.tws.tec.br` mostra a lista dos projetos.
- 2026-11-24 — O repositório continua na conta pessoal por enquanto; reavaliar uma organização quando
  houver dois ou mais projetos com contribuidores de fora ou outra pessoa na equipe.
- 2026-11-24 — **Lançamento open source em duas ondas:** primeiro o público brasileiro (português),
  depois o internacional (inglês), com a primeira release pública `v0.2.0`.

## Concluído (recente)

Lista curta, pode ficar defasada; a fonte é `gh pr list --state merged` e o `git log` da `dev` e da
`main`.

- 2026-11-24 — PR #30 integrado na `dev` (documentação em `docs.tws.tec.br/tws-panel/`; aprovado em
  `091a711c`; merge `e76d81a6`). Ainda não está na `sandbox` nem na `main`.

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
