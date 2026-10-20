# Relatório — trilha do repositório, fase 1

Branch: `worktree-agent-afb387f62f8c4d5ad` (a partir de `origin/dev`). Sem push. Commits pequenos, na ordem do escopo.

## O que foi feito

1. **README em inglês** (`README.md`) e `README.pt-BR.md` (conteúdo anterior, atualizado), com link cruzado. Instalação em um comando (`apt install git`, `git clone --branch main`, `chown`, `./scripts/install.sh`), requisitos, recursos, "escopo e limites", links para os guias. Selos: só licença MIT, status beta (estáticos) e o CI que já existe. Não há comparação nominal com outros PaaS (não dá para afirmar de forma factual sem verificar cada um); no lugar há a seção "Scope and trade-offs", só com o que o código e a documentação comprovam. Os prints que existem (`docs/assets/*.png`, dados fictícios) foram mantidos; há um comentário no README indicando onde entram os novos.
2. **Documentação com fonte única** em `site/src/content/docs/{en,pt-br}/` (os guias originais, movidos com `git mv`, são o `pt-br`). Doze guias traduzidos para o inglês (instalação, guia completo, wizard, funcionalidades, operação, recuperar acesso, produção, problemas comuns, migração de redes, modelo de segurança, ponte com o host, desenvolvimento local). Comandos e caminhos conferidos por script contra os originais: diferem só os comentários e os marcadores (`SEU_USUARIO` virou `YOUR_USER` etc.). Specs e pesquisas ficaram em `docs/internal/` (só pt-BR, histórico); prints em `docs/assets/`; os textos de comunidade em português em `docs/community/pt-BR/`. Referências antigas (`docs/instalacao.md` etc.) atualizadas em scripts, comentários de código e mensagens ao operador.
3. **Site Starlight** em `site/` (Astro 7.4.1, Starlight 0.42.6): en padrão, pt-br, busca (Pagefind), sidebar, página inicial, redirecionamento da raiz por idioma do navegador, plugin que reescreve links relativos `.md` entre guias. `pnpm --filter site build` passa (28 páginas). Workflow `.github/workflows/docs.yml`: em PR só confere links e faz build; publica no Pages somente no push para `main`; actions fixadas por SHA; permissões mínimas por job.
4. **Comunidade**: `CONTRIBUTING.md`, `SECURITY.md` (Security Advisories + versões suportadas), `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), modelos de issue em formulário (`bug_report.yml`, `feature_request.yml`, `question.yml`, `config.yml`) e `PULL_REQUEST_TEMPLATE.md`, todos em inglês; versões em português em `docs/community/pt-BR/`.
5. **Raiz e "cassino"**: não havia lixo gerado e rastreado na raiz, então nada foi apagado (`CODE_REVIEW.md`, `image1.png` e `image2.png` não estavam no worktree e não foram tocados; `comoFuncionaSistema/` intacta). "cassino" virou "loja" só em nomes, slugs, domínios e e-mails de exemplo de testes (8 arquivos). O domínio de teste `cassp.tws.tec.br` (em `apps/server/tests/deploy-domains.test.ts`) virou `loja.example.com`.
6. **`ROADMAP.md`** curto e sem datas (tradução es, Google Drive, templates, API/OpenAPI, MCP, aquecimento de IP, MTA-STS, BIMI; multi-servidor como fase futura). Entrada em "Documentação e comunidade" no CHANGELOG.

Extras necessários: `scripts/check-doc-links.mjs` (`pnpm docs:links`, sem dependências; confere arquivos, âncoras e links do próprio repositório em todos os `.md`), scripts `docs:dev`/`docs:build`/`docs:links`, e `"vite": "^6.4.3"` como devDependency da raiz (sem isso o lockfile passava a resolver o vitest da raiz com o vite 8 do Astro, mudando o ambiente de testes dos pacotes).

## O que NÃO foi feito

- Capturas de tela novas (nenhuma foi inventada).
- Tradução para espanhol (a estrutura aceita: nova pasta em `site/src/content/docs/` + entrada em `locales`).
- Tradução das specs de `docs/internal/` (ficam só em português, de propósito).
- Tradução da interface do painel.
- Comparação nominal com Coolify/Dokploy/Portainer/Dokku/CapRover.
- Nenhuma configuração do GitHub foi alterada (ver lista abaixo). Não mexi em `ci.yml` nem em `dependabot.yml`; o comentário do `ci.yml` ainda cita `docs/github-security.md` (hoje `docs/internal/github-security.md`).

## Ambíguos deixados como estavam ("cassino")

Comentários "Validação real (cassino, data)" / "caso do cassino" em `src` e testes (descrevem o caso real validado); as fixtures `cassino-like.ts`, `cassino-env-names`, `CASSINO_LIKE`, `CASSINO_SERVICES`, `CASSINO` em `compose-entry.test.ts`; os nomes de container `paas-cassino-*` em `compose-diagnose.test.ts` (citam a mensagem real de erro); `comoFuncionaSistema/`. Dá para trocar depois por um renomear mecânico se você quiser. Também ficou "Hostinger" na lista de registradores de `apps/web/src/components/DnsGuide.tsx` (texto da interface, citado como exemplo de onde comprou o domínio): confirme se esse nome pode aparecer. Removi "Hostinger" de um exemplo do guia completo.

## Ações manuais para o Kelvin no GitHub

1. **Descrição** do repositório (ex.: "Open-source panel that turns an Ubuntu VPS into your own hosting platform") e **homepage** `https://kelvindk9w.github.io/tws-panel/`.
2. **Tópicos** (ex.: `paas`, `self-hosted`, `docker`, `vps`, `devops`, `ubuntu`, `hardening`, `email-server`, `caddy`, `typescript`).
3. **Discussions**: ativar (o `config.yml` dos modelos de issue e o CONTRIBUTING apontam para `/discussions`).
4. **Proteção da `main`** (ruleset): exigir PR e o check `ci`; o check `build` do workflow `docs` pode ser exigido quando houver mudança de docs.
5. **Relato privado de vulnerabilidade**: Settings → Code security → Private vulnerability reporting (o SECURITY.md e o `config.yml` apontam para `security/advisories/new`).
6. **Pages**: Settings → Pages → Source = GitHub Actions. O site só aparece depois do primeiro push para `main` que toque em `site/`, `docs/` ou `*.md` (ou após rodar o workflow `docs` manualmente, se você adicionar `workflow_dispatch`).
7. **Capturas de tela** a fazer (salvar em `docs/assets/`, dados fictícios, `docs/assets/regenerar/COMO-REGENERAR.md` explica o método): wizard de segurança/hardening (fases e rollback), página Certificados, Notificações, Webmail, Terminal web, tela de login com 2FA, deploy ao vivo com "Por que falhou", página Envios, modo escuro. Hoje existem: dashboard, projeto, e-mail com DNS, backups.
8. **E-mail de contato do código de conduta**: substituir `<CONTACT>` em `CODE_OF_CONDUCT.md` e em `docs/community/pt-BR/CODE_OF_CONDUCT.md` (o pt-BR tinha `contato@tws.tec.br`; troquei pelo marcador para ficar igual ao inglês). `SECURITY.md` ainda cita `contato@tws.tec.br` como alternativa a quem não usa o GitHub, e o README mantém o contato da TWS: decida se fica.
9. Conferir se o repositório aceita `main` como branch padrão de clone: o comando do README usa `--branch main`.

## Riscos

- **Mensagens ao operador mudaram de caminho** (instalador, `uninstall.sh`, `show-token.sh`, aviso de `users.json` ilegível): agora citam `site/src/content/docs/pt-br/...`. Dois testes do servidor que conferiam o texto antigo foram ajustados.
- **Cabeçalhos escritos pelo hardening** nos arquivos do sistema (`# Gerenciado pelo painel PaaS ... Spec: docs/...`) mudaram de texto; só comentário, mas o conteúdo gerado difere do de VPS já instaladas.
- **Lockfile maior** (Astro/Starlight): o CI do painel instala também as dependências do site; build, typecheck e cobertura do painel filtram o `site`.
- **Links para `blob/main/...`** só funcionam depois que estes arquivos chegarem à `main`.
- **Versões novas**: Astro 7.4.1 e Starlight 0.42.6 exigem Node >= 22.22; o workflow usa Node 22 (última 22.x). Se o CI cair numa 22.x mais antiga, o build do site falha.
- Dependabot passará a abrir PRs para as dependências do site, se o `dependabot.yml` cobrir `/` (não alterei o arquivo).
- Páginas em inglês foram traduzidas por modelo e conferidas só por contagem de blocos/títulos/âncoras e comparação de comandos; falta revisão humana de estilo.

## Verificações feitas

`pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm build` (raiz, sem o site), `pnpm test:coverage` de todos os pacotes (core 109, mailer 362, deploy 833, security 215, web 746 e server 1931 testes, thresholds passando; rodado antes do commit final dos testes e repetido para web e server), `pnpm --filter site build`, `pnpm docs:links` (46 arquivos, 0 quebrados), checagem dos `href` do HTML gerado (500 links internos, 0 quebrados) e `docker build` da imagem do painel (OK, sem erro de lockfile por causa do `site`). **Não testado:** o workflow `docs.yml` no GitHub (só validado por leitura), a publicação no Pages, o conteúdo da imagem Docker (o daemon do Docker Desktop caiu com erro de I/O depois do build; a imagem não carrega `site/` porque o `.dockerignore` o exclui e o Dockerfile só copia `apps`, `packages` e `scripts`), os scripts de shell alterados em VPS real (só `bash -n`), os testes E2E (`test:e2e`, exigem Docker) e a aparência do site em navegador.
