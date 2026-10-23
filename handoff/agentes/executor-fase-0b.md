# Handoff do executor — Fase 0b: escopo por projeto dos tokens de API

Worktree: `/home/kelvin/projects/paas/.claude/worktrees/agent-afa2e8e7957c923a4`
Branch: `worktree-agent-afa2e8e7957c923a4` (parte de `dev` em 33080ce, que já tinha a Fase 0).
Estado: tudo commitado, árvore limpa. Nada foi enviado ao remoto por mim.

## 1. Tarefa e brief (resumo)

Cada token de API passa a ter, além do nível (leitura/escrita/administração), um **alcance** escolhido na criação:
(a) painel inteiro (comportamento da Fase 0); (b) só projetos escolhidos (lista de ids); (c) opcionalmente "pode
criar projetos novos", com o projeto criado entrando na lista do token de forma atômica (se o registro falhar,
desfazer ou dar erro claro, nunca órfão silencioso).

Exigências principais:
- Fora da lista o projeto não existe: listagens filtram; acesso direto por id dá o MESMO 404 de projeto inexistente.
- Token limitado nunca alcança rotas de painel/servidor (403 no formato da Fase 0).
- Rotas de projeto respeitam nível e lista; ids aninhados resolvem para o projeto dono; conflitos de domínio/porta
  fora do alcance dizem só "indisponível".
- Gestão: seletor na criação, tela em pt-BR e en, linha de alcance por token, edição só por humano (aumentar pede
  senha/2FA, diminuir não), apagar projeto o tira das listas, lista vazia sem canCreate é inválida, auditoria com
  `token:<nome>`, arquivo da Fase 0 = painel inteiro, lista ilegível = sem alcance (nunca amplia).
- Manter: só sessão humana cria/revoga token; lista de exclusão; deploy/escrita ≈ acesso às variáveis DAQUELE
  projeto (documentar); Bearer só no cabeçalho. Não implementar `/mcp` nem Fase 1.
- Qualidade: TDD, sem Docker real, mutações por regra, 20x nos testes novos, commits pequenos em inglês com as duas
  linhas de coautoria/sessão, docs (SECURITY, guias pt-br/en, comoFuncionaSistema, CHANGELOG, ROADMAP).

## 2. O que foi feito, por commit

- **9e0e81a — alcance no repositório de tokens.** O arquivo `api-tokens.json` guarda alcance, lista de projetos e
  "pode criar". Arquivo sem esses campos carrega como painel inteiro; qualquer valor inválido carrega como "sem
  alcance" (nunca amplia). Há operações para registrar projeto criado, trocar o alcance e esquecer um projeto apagado.
  Principais: `packages/core/src/api-tokens.ts`, `apps/server/src/services/api-token-store.ts`,
  `apps/server/src/services/session-store.ts`.
- **604baad — alcance na política de rotas, no plugin de autenticação e nas rotas de projeto.** Tabela de alcance
  por rota (187 rotas), conferida ANTES do nível. Projeto fora da lista = 404 idêntico ao inexistente; rota de
  painel = 403; criar só com "pode criar". Listagens filtram; mensagens de conflito viram "indisponível"; criar
  projeto registra no token, com desfazer em caso de falha; apagar projeto limpa as listas; edição do alcance por
  humano (PATCH). Principais: `apps/server/src/services/token-policy.ts`, `token-policy-table.ts`,
  `request-reach.ts`, `reach-masks.ts`, `plugins/auth.ts`, `routes/projects.ts`, `routes/domains.ts`,
  `routes/backups.ts`, `routes/api-tokens.ts`, `services/deploy-service.ts`.
- **0d1f0ac — matriz rota x alcance contra o painel real.** Todas as rotas reais contra 4 perfis de token
  (painel, só A, só A que cria, vazio); confere 404 idêntico em corpo e cabeçalhos e 403 uniforme.
  `apps/server/tests/token-alcance-matriz.test.ts`, `tests/helpers/real-panel.ts`.
- **00eb110 — testes com os handlers reais.** Listas filtradas, criação atômica de projeto (incluindo falha e
  falha do desfazer), máscaras de conflito, gestão do alcance (aumentar x diminuir). `tests/token-alcance-rotas.test.ts`,
  `tests/reach-masks.test.ts`, `tests/api-token-store-alcance.test.ts`, `tests/token-policy-rotas.test.ts`.
- **cc03082 — tela.** Seletor de alcance na criação, linha de alcance em cada token, "Editar projetos"
  (aumentar pede senha; diminuir não), textos pt-BR e en. `apps/web/src/pages/settings/ApiAccessSettings.tsx`,
  locales `settings.ts`/`setup.ts`/`projects.ts`, `apps/web/tests/api-access-settings.test.tsx`.
- **d73eecc — documentação.** SECURITY.md, guias `ai-access.md` (pt-br e en, com o exemplo "só a fazenda"),
  CHANGELOG, ROADMAP, `comoFuncionaSistema/autenticacao/tokens-de-api.json`, índices e
  `comoFuncionaSistema/_RELATORIO-mcp-fase0b.md`.

## 3. Decisões e por quê

- **Token limitado só cria projeto a partir de clone Git** e **não troca a fonte** de projeto existente: uma pasta
  local do servidor daria leitura de arquivos de outros projetos.
- **Restauração de teste de backup (restore-check) é só do painel**: grava dados de um projeto no banco de outro.
- **Rotas globais negadas, não filtradas** (auditoria, alertas, containers, portas, certificados, e-mail do
  servidor...): menos superfície; filtrar pode vir na Fase 1.
- **Alcance conferido antes do nível**: evita vazar existência pela diferença 403 x 404.
- **Busca por id exato antes do apelido (slug)**: um nome de projeto não pode sequestrar o id de outro.
- **Aumentar alcance pede senha/2FA, diminuir não**: tirar acesso é seguro e precisa ser rápido.
- **Falha fechada**: rota sem classificação = painel; alcance inválido = nenhum projeto.
- Restaurar o painel preserva `api-tokens.json`; como apagar projeto limpa as listas e ids são aleatórios e não
  reaproveitados, restaurar um projeto apagado não devolve acesso a ninguém.
- Erro 429 do limitador do `check-git-access` conta como "chegou" na matriz (é limite de taxa, não alcance).

## 4. Como verificar

Sempre um pacote por vez, a partir da raiz do worktree. Para o server, `DOCKER_HOST` aponta para socket inexistente.

```
pnpm -r typecheck
(cd packages/core && pnpm run test:coverage --bail=0)
(cd packages/deploy && pnpm run test:coverage --bail=0)
(cd packages/mailer && pnpm run test:coverage --bail=0)
(cd packages/security && pnpm run test:coverage --bail=0)
(cd apps/server && DOCKER_HOST=unix:///nonexistent.sock pnpm run test:coverage --maxWorkers=2 --bail=0)
(cd apps/web && pnpm run test:coverage --bail=0)
node scripts/check-no-real-hosts.mjs
pnpm run docs:links
pnpm docs:build
```

(`--no-bail` não existe neste vitest; use `--bail=0`.) Repetição 20x dos testes novos do server:
`vitest run tests/api-token-store-alcance.test.ts tests/token-alcance-matriz.test.ts tests/token-alcance-rotas.test.ts tests/reach-masks.test.ts tests/token-policy-rotas.test.ts --maxWorkers=2`;
do web: `tests/api-access-settings.test.tsx`. Resultado: 0 falhas em 20 execuções de cada.

Cobertura medida (ramos): core 98,95; deploy 95,27 (margem mínima); mailer 98,49; security 97,33 (12 arquivos, todos
passaram, inclusive os que dependem de docker pull); server 94,07 (statements 97,55, funções 98,07 com mínimo 98,
linhas 98,78; 185 arquivos / 3242 testes passaram); web 88,14 (92 arquivos / 1693 testes). Nenhum mínimo reprovou.
`check-no-real-hosts` ok, `docs:links` ok (62 arquivos), build do site ok (40 páginas). 26 mutações, todas detectadas.

## 5. Não verificado e riscos

- Nada foi testado com Docker real nem em VPS; os testes usam o painel real com Docker simulado.
- A tela foi testada só por testes de componente, não em navegador real.
- Não inspecionei objetos vazios em `.git/objects` do repositório compartilhado (o worktree usa `.git` como arquivo).
- **Um token de projeto pode clonar repositório privado pela conta GitHub do painel?** Provavelmente SIM e NÃO foi
  testado: o token com "pode criar" e nível administração cria projeto de clone Git, e o painel usa a conta GitHub
  conectada para clonar; portanto o repositório pode ser qualquer um que essa conta consiga ler, inclusive privado e de
  outro "assunto". Isso foi documentado como risco aceito (deploy ≈ acesso às variáveis do projeto), mas não há
  restrição por dono/organização nem confirmação humana. Vale decidir se precisa de lista de repositórios permitidos.
- Código publicado roda no servidor sob os guardrails do deploy: o alcance limita a API do painel, não é sandbox.
- Rota nova sem classificação de alcance fica negada a token limitado (seguro, mas pode surpreender).
- Máscaras cobrem os conflitos que mapeei (domínio, porta, nome/pasta, ocupante de par, backup); outra mensagem de
  erro que cite recurso alheio, que eu não tenha visto, continuaria vazando para token limitado.

## 6. O que falta antes de mesclar

- Revisão do Opus (independente, com foco em oráculo de existência, rotas esquecidas e máscaras).
- PR #106: conferir se descrição e base batem com este branch, rodar o CI (cobertura mínima de ramos) e resolver
  eventual conflito com `dev`.
- Decidir o ponto do repositório privado acima antes da Fase 1.
- Opcional: ver a tela em navegador real e testar uma criação de projeto por token em ambiente com Docker.
