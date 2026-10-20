# Relatório: "Ajuda e feedback" no cabeçalho

## O que passou a acontecer
- Um ícone de ajuda fica no cabeçalho, entre o seletor de idioma e o menu do usuário (topo e barra
  móvel). Na lateral (esquerda/direita) vira uma linha com texto "Ajuda e feedback", entre o idioma
  e o menu do usuário, porque ali há espaço.
- Clicar abre um painel (não modal) com cinco links, todos em nova aba com `rel="noopener noreferrer"`,
  indicados por ícone e por "(abre em nova aba)" para leitor de tela: guia (`/<idioma>/`), página de
  ajuda do site (`/<idioma>/guides/help/`), Discussions, "Relatar um problema" (formulário
  `bug_report.yml`) e "Sugerir uma funcionalidade" (`feature_request.yml`). pt-BR usa `/pt-br/`;
  qualquer outro idioma usa `/en/`. Trocar o idioma com o painel aberto atualiza os endereços.
- Rodapé do painel: "Não cole logs sem revisar: podem conter domínios, IPs e tokens." e
  "TWS Panel vX.Y.Z".
- Foco, Esc (devolve o foco ao botão), clique fora e saída do foco fecham o painel. Abrir a ajuda fecha
  "Mais" e o menu do usuário (e vice-versa): nunca há dois abertos.

## Decisões
- Ícone próprio no cabeçalho em vez de item dentro do menu do usuário: o menu do usuário é da conta
  (configurações, senha, 2FA, sair) e a ajuda deve estar a um clique, sem nem saber onde fica a conta.
  Preço: 32px a mais no cabeçalho; compensados com espaçamentos menores só abaixo de `sm` (o cabeçalho
  em 390px passou a caber; antes de compensar, a página ganhava rolagem lateral).
- Endereços todos em `apps/web/src/lib/links.ts` (`SITE_URL`, `REPO_URL`); nenhum outro arquivo escreve URL.
- Versão do painel: não existia forma no web (o UpdateBanner só compara o nome do bundle). Acrescentado
  `GET /api/version` (autenticada, em `routes/health.ts`), que devolve apenas `{ version }` do
  package.json da raiz; tipo `PanelVersionResponse` em `packages/core`. Consultada uma vez, na primeira
  abertura do painel (não pesa no carregamento do painel).
- SO da VPS: OMITIDO do link. O único dado de SO exposto hoje é o do scan de saúde (`/api/health/scan`),
  que dispara leituras no host e espelho no terminal — pesado e com efeito colateral demais para um
  link de ajuda. O formulário tem o campo e a pessoa informa. Menos superfície = menos risco.

## Privacidade (crítico)
- `bugReportUrl` só lê `version` e `locale` (propriedades extras são ignoradas) e só monta
  `template`, `version`, `locale` via `URLSearchParams`.
- Versão: semver estrito (X.Y.Z, pré-lançamento e build opcionais, até 40 caracteres); `192.168.0.1`,
  `painel.example.com`, "unknown", `1.2`, `v1.2.3` são descartados (testado). Idioma: código tipo
  `pt-BR`/`en`. Se não casar, o campo é descartado (não "limpo"). `&`, `#`, quebra de linha, espaços,
  `<script>`, caminho, IP, domínio e valores longos nunca chegam ao link. `+` sai como `%2B`.
- A versão exibida no painel passa pelo mesmo filtro.

## Testes
- Os testes novos do cabeçalho (rótulo "Menu" sr-only, classes de espaço) e do semver foram escritos junto com a correção, não antes dela (desvio do TDD, admitido).
- `apps/web/tests/links.test.ts` (novo): idioma→pasta, links fixos, lista permitida de parâmetros
  (template/version/locale), 12 versões hostis × 6 idiomas hostis, campos extras (IP, domínio, e-mail,
  usuário, caminho, SO) ignorados.
- `apps/web/tests/help-menu.test.tsx` (novo): botão e a11y (aria-label/expanded/haspopup), links e
  `target`/`rel` em pt-BR e en, versão consultada uma vez, falha/formato estranho da versão, versão
  hostil do servidor, Esc/Tab/clique fora, convivência com "Mais" e menu do usuário, lateral esquerda/direita.
- `apps/server/tests/routes-health.test.ts`: `/api/version` exige auth e devolve só `version`;
  `readPanelVersion` com arquivo ausente/inválido/sem versão. (Vistos falhar antes da implementação.)
- Nenhum teste existente foi alterado ou enfraquecido (header-language-menu, layout, user-menu passam).
- Cobertura: web 1016 testes, 92,04% instr. / 86,40% ramos; core 119; deploy 833 (98,52/95,72);
  mailer 362 (99,9/98,45); security 215; server 1991 (+2 ignorados) 97,73/93,35/98,15/98,88.
  `check-no-real-hosts`: ok (os endereços públicos do site/repositório não reclamam).

## Verificação visual e correção da revisão
A primeira versão (ícone + espaços menores só abaixo de `sm`) REGREDIU a rolagem lateral, segundo o
revisor: 360px 8px → 20px; 368-379px (inclui 375) cabia → estourava 4-12px; 1024-1031px em pt-BR com
menu no topo cabia → estourava 3-7px. Minha frase anterior de que 360px "já estourava uns 20px" era
falsa e foi retirada. Correção: abaixo de `sm` o texto "Menu" fica `sr-only` (o ícone permanece e o nome
acessível continua "Menu"), e o espaço entre itens é menor só na faixa `lg` (gap-3 no cabeçalho, gap-1
no grupo da direita; `xl` volta ao normal).

Medição própria (Chromium, API simulada, nome de usuário longo, badge 150 → "99+", varredura de 2 em 2px
de 320 a 1440px, página /mail/envios, pt-BR e en, topo e laterais esquerda/direita; as laterais usam o
mesmo cabeçalho abaixo de 768px). Base (b713450) estoura de 320 a 368px (até 58px); HEAD corrigido
estoura só de 320 a 334px (até 26px), ou seja, melhor que a base em toda a faixa e sem nenhum estouro de
336 a 1440px (inclui 360, 375, 390 e 1024-1031). O navegador de teste reserva 10px de barra de rolagem;
sem ela (celular) o cabeçalho cabe a partir de ~326px, então a 320px ainda passa uns 6px.
Capturas com o painel aberto: topo e lateral esquerda/direita, 390/1024/1440px, pt-BR e en (área
temporária da sessão, não versionadas): painel dentro da tela, sem rolagem horizontal.

## Não verificado
- Larguras abaixo de ~326px (320px passa uns 6px, mas menos que a base); leitor de tela real; Firefox/Safari.
- Que o formulário `bug_report.yml` tenha os campos `version`/`locale` (é do executor A; o GitHub
  ignora parâmetro desconhecido) e que as páginas do site existam no ar.
- Site: nenhuma página ficou falsa com o novo ícone ("ao lado do menu do usuário" segue verdadeiro); nada em `site/` foi tocado.
