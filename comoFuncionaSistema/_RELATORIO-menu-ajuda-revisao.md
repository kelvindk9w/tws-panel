# Revisão: "Ajuda e feedback" no cabeçalho (tarefa B)

Branch revisada: `worktree-agent-a8a11cfb224cd2208` (b07e51e, 4 commits sobre origin/dev b713450).
Trabalho feito em cópias descartáveis (worktrees em área temporária, já removidas): HEAD da B, o
commit base (origin/dev) e o HEAD da branch A (só leitura, para o formulário, o site e o checador de
rotas). O relatório do executor (`_RELATORIO-menu-ajuda.md`, dentro da branch B) não foi tocado.

## Veredito geral: REPROVADO

Um único motivo: **regressão de rolagem horizontal no cabeçalho** (item 5), medida contra o commit
base. Todo o resto passou. A correção é pequena e foi testada numa cópia (ver item 5).

---

## 1. Privacidade — APROVADO (com uma recomendação)

- **Link do bug, entradas hostis.** `bugReportUrl` foi chamada com 31 versões × 18 idiomas = 558
  combinações (versão com `&`, `#`, `%0A`, `\n`, `\r\n`, `<script>`, espaço, 40 e 41 caracteres,
  vazia, `undefined`, `null`, objeto, objeto com `toString`, array, número, `"unknown"`, `../../etc`,
  `?x=1`, dígito de largura total, NUL, e-mail; idioma `pt-BR&os=x`, `pt-BR#x`, `<script>`, vazio,
  `null`, objeto, `zh-Hant-TW`, `user@x`…), sempre junto com campos extras `os`, `ip` e `email`.
  Em todas: origem `github.com`, caminho `/kelvindk9w/tws-panel/issues/new`, sem fragmento, só as
  chaves `template`/`version`/`locale`, cada uma no máximo uma vez. Valor fora do formato é
  descartado (não "limpo"); `+` sai como `%2B`; espaços nas pontas são aparados.
- **Recomendação (não bloqueia):** o filtro de versão aceita qualquer sequência alfanumérica com
  pontos — `192.168.0.1` e `painel.example.com` passam e iriam ao link. A origem é o
  `package.json` da raiz (igual para todos), então não é vazamento hoje; mas o próprio teste
  `links.test.ts` lista `203.0.113.10` como "hostil" e só confere as chaves, não que o valor foi
  descartado. Trocar `VERSION_RE` em `apps/web/src/lib/links.ts` por semver estrito
  (`MAJOR.MINOR.PATCH` com pré-release/build opcionais) e acrescentar ao teste que um IP e um
  domínio não entram em `version`.
- **Links externos:** os 5 têm `target="_blank"` e `rel="noopener noreferrer"` (conferido no DOM
  do Chromium) — o `noreferrer` impede o endereço do painel de ir no Referer.
- **Rede ao abrir o popover (Chromium, API simulada):** a única requisição nova é
  `GET /api/version` ao próprio painel; nenhuma requisição externa em toda a sessão (sem fonte,
  imagem ou ping). Fechar e reabrir não repete a consulta.
- **GET /api/version:**
  - setup pendente sem token → 401 (teste do executor); setup concluído: sem sessão → 401,
    cookie adulterado → 401, setup token após o setup → 401, `/%61pi/version` → 401, sessão
    válida → 200 `{"version":"0.1.0"}` com `cache-control: no-store`. Corpo só com `version`.
  - Lê o `package.json` da raiz uma vez, no registro da rota; arquivo ausente/ inválido/sem
    versão → `"unknown"` (o web descarta e não mostra a linha da versão).
  - **Imagem Docker:** o servidor roda via `tsx` direto do fonte; o `Dockerfile` copia o
    `package.json` da raiz para `/app` no estágio de build e o `/app` inteiro vai para o runtime;
    o `.dockerignore` não o exclui. Conferido com um build mínimo usando o mesmo contexto:
    `/app/package.json` (versão 0.1.0) e `/app/apps/server/src/routes/health.ts` estão lá, e o
    caminho relativo da rota resolve para `/app/package.json`.
  - **Painel com falha do endpoint** (500) ou versão hostil (`1.0&os=evil#x`): popover abre normal,
    sem a linha de versão, e o link do bug sai só com `template` e `locale`.

## 2. Compatibilidade com o formulário — APROVADO (com observações para o executor A)

- `bug_report.yml` da branch A tem `id: version`, `id: os` e `id: locale`; o link usa
  `?template=bug_report.yml&version=…&locale=…` (SO omitido, como pedido). `feature_request.yml`
  existe. Discussions e `issues/new?template=bug_report.yml` respondem 200 no GitHub.
- Rotas `/en/guides/help/` e `/pt-br/guides/help/` existem em `site/src/content/docs` da A e no
  build do site.
- **Checador da A** (`check-doc-links.mjs --require-dist`, com o `links.ts` da B copiado para a
  cópia da A e o site construído): passa e conta 5 URLs a mais do que sem o arquivo. Reprova
  quando a rota é errada (`/guides/helpx/`), quando falta a barra final e quando há um segundo
  trecho dinâmico.
- **Falha no checador da A (para o executor A):** com `SITE_URL` errado de propósito
  (`…/tws-panelx`) o checador **passa** — ele confere a forma `${SITE_URL}/${idioma}/…`, mas não
  que o `SITE_URL` do arquivo é o endereço do site. Na B isso está coberto pelo `links.test.ts`,
  que fixa o valor literal.
- Observações (não bloqueiam a B): o campo `locale` do formulário pede algo como "English" /
  "Português (Brasil)", e o link manda `pt-BR`/`en`; o campo `version` pede o commit, e o painel
  manda `0.1.0` (o `package.json` da raiz nunca muda hoje, então a versão quase não ajuda na
  triagem).

## 3. Acessibilidade e teclado — APROVADO

Testado no Chromium (topo 1440 e 390px; lateral esquerda e direita a 1024px):
- Botão com nome acessível ("Ajuda e feedback" / "Help and feedback"), `title`,
  `aria-expanded`, `aria-haspopup="dialog"`, `aria-controls` igual ao `id` do painel.
- Enter e Espaço abrem; Tab percorre os 5 links na ordem; o Tab seguinte sai do grupo e fecha;
  Esc dentro do painel fecha e devolve o foco ao botão; Shift+Tab para o idioma fecha; clique fora
  fecha. Sem armadilha de foco.
- Exclusão mútua nos 6 sentidos (ajuda↔usuário, ajuda↔"Mais", usuário↔"Mais"), pelo mouse e pelo
  teclado: em todos, abrir um fecha o outro; nunca dois abertos.
- Cada link anuncia "(abre em nova aba)"/"(opens in a new tab)" em texto só para leitor de tela.
- Contraste no tema (o painel é sempre escuro): texto dos links 18,2:1; aviso e ícones 7,4:1.
- Não verificado: leitor de tela real, Firefox, Safari.

## 4. i18n — APROVADO

Chaves `shell.help.*` em pt-BR e en com paridade; GLOSSARY com "ajuda e feedback", "relatar um
problema" e "sugerir uma funcionalidade"; rótulo igual ao título da página do site ("Ajuda e
feedback"/"Help and feedback"). O teste de texto fixo cobre `HelpMenu.tsx` (pus uma frase fixa
de propósito numa cópia e ele reprovou). Idioma desconhecido (`fr`, `es`, `portuguese`) → `/en/`;
`pt`/`PT` → `/pt-br/`.

## 5. Visual — REPROVADO

Chromium com o build de produção do web e API simulada; nome longo + badge 99+; topo, lateral
esquerda e direita; pt-BR e en; 360/390/768/1024/1440px. Popover sempre dentro da tela, sem
sobrepor idioma nem menu do usuário. Lateral esquerda: painel abre para cima, por cima do conteúdo,
inteiro na tela.

**Rolagem horizontal, base × HEAD** (varredura de 320 a 1440px, de 4 em 4px, rota /alerts):

| Largura | base (origin/dev) | HEAD |
|---|---|---|
| 360px | 8px | **20px** |
| 368–379px (inclui 375px, iPhone SE/mini) | 0 | **4–12px (novo)** |
| 1024–1031px, pt-BR, menu no topo | 0 | **3–7px (novo)** |

É regressão: o relatório do executor diz que a 360px "provavelmente já estourava antes" ~20px,
mas antes eram 8px, e a faixa de 368–379px e a de 1024px em pt-BR passaram a estourar agora. Nos
casos, quem passa da borda é o botão do menu do usuário (a seta fica cortada).

**O que corrigir — `apps/web/src/components/Layout.tsx`, componente `TopBar`:**
1. No botão "Menu" da barra móvel, deixar o texto "Menu" só para leitor de tela abaixo de `sm`
   (envolver `t("shell.nav.menu")` num span com `sr-only sm:not-sr-only`); o ícone continua
   visível e o nome acessível também.
2. No contêiner do cabeçalho (`container flex min-h-14 items-center gap-2 py-2 sm:gap-4 xl:gap-6`),
   reduzir o espaço só na faixa `lg` (`lg:gap-3` antes de `xl:gap-6`).

Com essas duas mudanças, numa cópia: nenhum estouro de 336px a 1440px, nos 4 cenários (nome longo
e curto, pt-BR e en) — melhor que o base, que estourava até 364px. Acrescentar ao
`layout.test.tsx` (ou ao `help-menu.test.tsx`) uma checagem de que o texto "Menu" tem a classe que
o esconde abaixo de `sm`, e atualizar o relatório do executor (a frase sobre "já estourava antes").

## 6. Regressões — APROVADO

`header-language-menu`, `layout`, `user-menu` e `update-banner` passam. Diff de testes: só
acréscimos; a única linha removida é o `import` de `routes-health.test.ts`, trocado por outro que
importa também `readPanelVersion`.

## 7. Qualidade — APROVADO (com uma observação de escopo)

- `pnpm install --frozen-lockfile`: ok. `pnpm typecheck`: ok.
- `test:coverage` de todos os pacotes, sem parar no primeiro erro, e o server à parte com
  `--maxWorkers=2`: tudo passa.
  - server 129 arquivos / 1991 testes (+2 ignorados): 97,73 / 93,33 / 98,15 / 98,88
    (mínimos 94/91/98/94).
  - deploy 98,52%; mailer 99,9%; security 99,33%; core 99,63%; web 1016 testes, 92,04% /
    86,40% (`links.ts` 100% instruções, 92,85% ramos).
- `node scripts/check-no-real-hosts.mjs`: ok (o endereço público do site e do repositório é
  aceito).
- Escopo: nada em README, `site/` ou `.github/`. **Observação:** `packages/core/src/auth.ts`
  ganhou o tipo `PanelVersionResponse` — fora da lista "apps/web, apps/server, testes,
  comoFuncionaSistema", mas é só o tipo compartilhado da resposta, no lugar onde o projeto põe
  esses tipos. Aceitável; fica registrado.

## Resumo do que fazer para aprovar

1. **Obrigatório:** a correção de `Layout.tsx` descrita no item 5, com o teste e a correção do
   relatório do executor.
2. Recomendado: semver estrito em `VERSION_RE` (`apps/web/src/lib/links.ts`) e um teste de que
   IP/domínio não entram em `version`.
3. Para o executor A (fora da B): o checador de rotas deveria conferir que o `SITE_URL` do
   arquivo TS é igual ao endereço do site em `site/astro.config.mjs`.

---

# 2ª rodada — commit 8fb3069 (B) e 34e4889 (A)

## Veredito: REPROVADO (um defeito novo, pequeno, introduzido pela própria correção)

### 1. Rolagem lateral, base × HEAD — APROVADO
Varredura pixel a pixel de 320 a 1440px, nome longo + badge 99+, topo/lateral esquerda/lateral
direita, pt-BR e en (12 cenários). Em todos: base estoura de 320 a 367px (até 48px); HEAD estoura
só de 320 a 335px (até 16px). Em 360, 375 e 1024–1031px o HEAD não estoura (base: 8px a 360px).
**Não há nenhuma largura em que o HEAD seja pior que a base.** A afirmação do executor confere
(ele disse 320–334; medi até 335, com 1px).

### 1b. Popover dentro da tela — REPROVADO (novo)
Como o cabeçalho agora cabe, o botão de ajuda ficou mais à esquerda, e o painel (288px, alinhado
pela direita do botão) **sai pela esquerda da tela de 320 a 373px**: 6px cortados a 320–360px,
1px a 373px. Nos 12 cenários, com nome longo ou curto. Na captura a 360px some a borda esquerda
do painel. Na 1ª rodada, a 360px, ele cabia (começava em 38px).

**Corrigir em `apps/web/src/components/HelpMenu.tsx`:** na classe do painel para
`placement === "top"`, abaixo de `sm`, fixar o painel a 16px da borda direita e logo abaixo do
cabeçalho (acrescentar `max-sm:fixed max-sm:right-4 max-sm:top-14 max-sm:mt-0`). O
`backdrop-blur` do cabeçalho faz dele a referência do `fixed`, então o painel acompanha o
cabeçalho fixo. Testado numa cópia: nenhuma largura de 320 a 1440px com o painel fora da tela
(a 360px começa em 56px). Esc continua devolvendo o foco ao botão, e de 640px para cima o
comportamento não muda. Vale um teste estrutural como os de `header-language-menu.test.tsx`.

### 2. Semver estrito — APROVADO
`1.2.3`, `1.2.3-rc.1`, `1.2.3+build` e `0.0.0` passam (o `+` sai como `%2B`). `01.2.3`, `1.02.3`,
`1.2`, `v1.2.3`, `192.168.0.1`, `painel.example.com`, `1.2.3-<script>`, `&`, `#`, mais de 40
caracteres e `9999999999.0.0` são descartados. Nenhuma chave fora de template/version/locale.
Resta o que o próprio semver permite: IP ou domínio dentro do pré-lançamento ou do build
(`1.2.3+painel.example.com`). Não bloqueia, porque a fonte é o `package.json` da raiz.
`1.2.3-0123` é aceito, embora o semver proíba zero à esquerda em identificador numérico; é
inofensivo.

### 3. Teclado e menus — APROVADO
Os 6 sentidos (ajuda↔usuário, ajuda↔"Mais", usuário↔"Mais"), pelo mouse e pelo teclado: abrir um
fecha o outro. Espaço abre; Esc num link fecha e devolve o foco ao botão. A 360px o botão "Menu"
mostra só o ícone, mantém o nome acessível "Menu" e abre normalmente. Testes `user-menu`, `layout`
e `header-language-menu` passam (web: 1019 testes). Os dois testes novos só acrescentam.

### 4. Qualidade — APROVADO
Typecheck ok. Cobertura com `--no-bail`, server com `--maxWorkers=2`: server 97,75 / 93,33 /
98,15 / 98,88; deploy 98,52; mailer 99,9; security 99,33; core 99,63; web 92,04 / 86,4. Todos
dentro dos mínimos. `check-no-real-hosts`: ok.

### 5. Checador de rotas e SITE_URL da A contra o `links.ts` da B — APROVADO
Com o site construído na cópia da A, o `check-doc-links --require-dist` passa (5 URLs a mais
conferidas) e `docs:site-url` passa. Reprova, como deve: rota errada, falta de barra final,
`SITE_URL` com caminho errado, com outro host e montado sem ser literal. A marca
`site-url-ignore` na linha do `SITE_URL` não burla a checagem do valor. A falha que eu tinha
apontado na 1ª rodada está corrigida.
