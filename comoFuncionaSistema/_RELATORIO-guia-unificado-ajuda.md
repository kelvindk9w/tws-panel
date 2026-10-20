# Relatório: guia passo a passo em duas partes, READMEs apontando para o site, página de ajuda

Base: `origin/dev`, ramo `docs/guia-unificado`. Só documentação, scripts de documentação, CI de docs e o
formulário de bug. Nada em `apps/`, `packages/` nem nos dicionários.

## Decisões

- **Dois arquivos, duas partes, mesmos nomes.** `installation.md` virou "Parte 1: Instalar" e
  `complete-guide.md` virou "Parte 2: Configurar" (títulos, descrições e rótulos da barra lateral, em
  en e pt-br). As URLs não mudaram.
- **Numeração da Parte 2: renumerada** (Etapas 1 a 9, subitens 1.1, 4.7 etc.), sem buracos. As antigas
  Etapas 3 a 11 viraram 1 a 9. Âncoras `#etapa-3`..`#etapa-11` deixaram de existir (agora
  `#etapa-1`..`#etapa-9`); todas as referências internas e as do guia de restauração foram
  atualizadas. Links externos antigos para `#etapa-N` ficam sem âncora (a página abre no topo).
- **Etapa 1 e resumo da Etapa 2 do guia completo:** o resumo da instalação foi removido (já existe, em
  detalhe, na Parte 1). O que só existia no completo foi movido para "Antes de começar" da Parte 1:
  requisitos da VPS (portas 80/443, porta 25, console de recuperação), domínio opcional e tabela de
  contas (GitHub, Cloudflare R2, Telegram). A Parte 2 aponta para lá em uma frase.
- **Aviso do SSH** ficou só na Parte 1 (mais guia de restauração e README, como antes). O quadro
  "Qual guia eu uso?" saiu das duas páginas e deu lugar a uma nota curta de encadeamento; a Parte 1
  termina com "Próximo: Parte 2" e a Parte 2 abre com "Voltar: Parte 1".
- **Endereço do site:** fonte única é `site`/`const base` de `site/astro.config.mjs`. Novo
  `scripts/site-config.mjs` lê isso; `scripts/check-site-url.mjs` (`pnpm docs:site-url`) falha se uma URL
  do host configurado (ou de qualquer `*.github.io`) fora do `base` aparecer em md, yml, json, ts, tsx etc.
  O `check-doc-links.mjs` passou a derivar o `base` da config e, com `site/dist`, confere que cada URL
  absoluta do site tem rota e âncora no build (`--require-dist` no CI). Ambos ligados ao
  workflow `docs.yml`. Testei com URLs erradas de propósito: host, base, rota, âncora e barra final
  são pegos.
- **Formulário de bug:** `version` e `os` já existiam; acrescentei `locale` (campo de texto, para o
  preenchimento por URL nunca ser ignorado). Ids para o executor B: **`version`, `os`, `locale`**.
  O texto de `locale` sugere "English" ou "Português (Brasil)".
  Rótulo de `os` ajustado para "VPS operating system and Docker version".
- **Rodapé:** `site/src/components/Footer.astro` (override do Footer do Starlight, sem dependência nova)
  mostra "Help and feedback"/"Ajuda e feedback" em todas as páginas, no idioma da página.

## O que mudou, pelo comportamento

- O site tem um grupo "Guia passo a passo" na barra lateral (Parte 1, Parte 2), depois "Primeiros
  passos" (wizard de segurança, restauração); "Ajuda e feedback" fica em Guias. A página inicial e os
  READMEs têm um único link "Guia passo a passo" que abre a Parte 1.
- Os dois READMEs apontam para as URLs do site publicado (com barra final, `/en/` e `/pt-br/`), com uma
  linha dizendo que o texto também está em `site/src/content/docs/`. Ganharam a seção "Help and
  feedback"/"Ajuda e feedback" (item "Ajuda" no menu do topo).
- Nova página `guides/help` (en e pt-br): canais, o que informar num bug, como anonimizar (example.com,
  203.0.113.x, REDACTED, comando `sed` só para IPs), o que nunca colar, contato direto.
- `config.yml` das issues ganhou o link "Help and feedback".
- `site/README.md` documenta navegação, endereço do site (lista de arquivos que o contêm e roteiro de
  troca de domínio) e a página de ajuda.

## Verificação feita

`pnpm install --frozen-lockfile`, `pnpm docs:build` (34 páginas), `check:build`, `docs:links
--require-dist` (53 URLs absolutas conferidas contra o build), `docs:site-url`,
`check-no-real-hosts`: passaram, sem `git init`. Paridade de títulos e âncoras en/pt-br conferida nas
três páginas alteradas e na de ajuda. READMEs renderizados com marked 12.0.2 + marked-gfm-heading-id
3.2.0: tabelas, âncoras acentuadas (`#por-onde-começar`, `#instalação`) e links resolveram.
Capturas com Playwright: página inicial (en, 1440), Parte 1 pt-br com barra lateral (1440), Parte 2 en
(1440 e 390). Rodapé confirmado no HTML de en e pt-br.

## O que não foi conferido

- Capturas da Parte 1/2 em todas as combinações (en/pt-br x 390/1440): vi só as listadas acima; a
  página de ajuda em 390 foi capturada, mas não revista.
- O render real no GitHub (usei um conversor local) e a página de issue com campos pré-preenchidos.
- A frase "se você chegou pelo menu de ajuda do painel, o campo pode vir preenchido" na página de ajuda
  depende de o executor B entregar o menu e o preenchimento; ajustar se ele mudar.
- O painel não mostra a versão em lugar nenhum hoje (busquei no código web); a página manda rodar
  `git -C /opt/tws-panel rev-parse --short HEAD`.
- O `docs.yml` só valida em CI. As rotas do link do painel passaram a ser conferidas contra o build
  (ver "Correções após a revisão"), mas só foram testadas com uma cópia do `links.ts` do worktree do B.

## Correções após a revisão

- A nota "interface só em português" foi corrigida nos dois READMEs, nos dois CONTRIBUTING e no ROADMAP
  (que também ganhou a interface bilíngue em "Delivered"; espanhol segue como trabalho futuro).
- O README em inglês passou a citar os rótulos do dicionário `en` (conferidos um a um), com a nota de que
  o README em português usa os do dicionário `pt-BR`. "Por que falhou" é texto do servidor (ainda em
  português) e está dito assim. A imagem do dashboard continua em português e o texto alternativo avisa.
- Guia de restauração: o token do R2 aponta para Parte 2, Etapa 6.1 (`#etapa-6`). Refiz o grep de todas
  as referências "Etapa/Step/Passo N" e links `#etapa-*`/`#passo-*`; as de dentro da Parte 2 foram
  conferidas por script (número do texto = número da âncora).
- Parte 1, "Depois do wizard": o parágrafo e o aviso final apontam para a Parte 2 (que começa no assistente),
  sem mandar para o README.
- Links do painel: `docs:links` agora lê os `.ts/.tsx` de `apps/web/src` (menos testes), interpreta as URLs
  com `new URL()` (host em maiúsculas ou `:443` valem como o mesmo endereço) e expande modelos
  `${SITE_URL}/${idioma}/caminho/` para cada idioma do build. O B deve declarar a URL como literal completo
  ou nesse formato (só o idioma dinâmico; `SITE_URL` literal no mesmo arquivo). Testei o `links.ts` do B
  (passa, incluindo `/en/guides/help/` e `/pt-br/guides/help/`) e casos errados de propósito.
- `docs.yml` roda também quando `apps/web/src/lib/links.ts` muda.
- Endurecimento final: o valor literal de `SITE_URL` no código do painel tem de ser igual a origem + base
  do `astro.config.mjs`, sem barra final (host, base, `http`, barra final e ausência de definição
  reprovam; importar a constante vale). A marca `site-url-ignore` só vale como comentário na linha
  (`<!-- -->`, `//` ou `#`), só para `*.github.io` de terceiros, e não vale dentro de URL, como parte de
  outra palavra nem para o próprio site. Testado caso a caso com arquivos temporários (removidos).
