# TWS Panel — documento de transição entre sessões

Escrito em 23/10/2026, no meio do trabalho, porque o computador do Kelvin precisa ser formatado. **Quem lê isto é um novo assistente (Claude Code) que vai continuar o trabalho sem ter a conversa anterior.** Leia tudo antes de agir. Não repita passos que o Kelvin já fez.

> Este arquivo mora no repositório (pasta `handoff/`, branch `handoff/2026-10-23`) para sobreviver à formatação do computador. O repositório é **público**: por isso os domínios reais e a hospedagem anterior aparecem como `<dominio-da-tws>` e `<MX-da-hospedagem-anterior>`. Nunca grave aqui IP da VPS, senha, token, chave de recuperação, setup token nem conteúdo de `.env`. **Quando a transição terminar, apague a pasta `handoff/`.**

## 0. Primeiros passos do novo assistente (checklist)

1. Ler este arquivo, depois `validacoes-pendentes.md`, `plano-mcp.md`, os relatórios dos agentes em `agentes/` e a pasta `memoria/` (cópia das memórias do projeto; recriar em `~/.claude/projects/-home-kelvin-projects-paas/memory/` se não existir, com o índice `MEMORY.md`).
2. Conferir o repositório: `cd ~/projects/paas && git fetch origin && git status && git log --oneline -5` e `gh pr view 105 --json state`.
3. Ler `comoFuncionaSistema/` do repositório (índice primeiro) antes de explorar código.
4. Conferir o que sobreviveu à formatação (seção 9) e então retomar pela seção 7 (plano de retomada).
5. Responder ao Kelvin sempre em **português com acentuação correta**.

## 1. Quem é e o que está sendo feito

- **Kelvin Medeiros**, CEO da TWS. Usa o **TWS Panel**, um PaaS open-source auto-hospedado (repositório público `kelvindk9w/tws-panel`, código local em `~/projects/paas`) numa **VPS provedor da VPS** para migrar o site `<dominio-da-tws>` e a operação.
- Branch padrão do GitHub: **`main`**. Trabalho em **`dev`**. O Kelvin mescla PRs com **"Squash and merge"**.
- **VPS nova** (reinstalada em 22/10/2026): instalação em `/opt/tws-panel`, usuário `kelvin`, container `tws-panel`, painel em domínio de nome neutro (Cloudflare só DNS, nuvem cinza). **O IP real nunca foi gravado em arquivo; não grave.**
- Projetos na VPS: **cassino** (privado), **devLink**, **site da TWS** (ainda não no ar), **twsFazenda / Roça Mágica** (`~/projects/fazenda`, privado).
- Roteiro "Deixe o painel pronto": passos 1–5 feitos; passo 6 "Backups fora da VPS" em andamento (primeiro backup manual ainda a fazer).
- Stack: monorepo pnpm — `apps/server` (Fastify/Node 22/TypeScript), `apps/web` (React), `packages/{core,deploy,mailer,security}`, `site/` (Starlight). Não é PHP (PHP só no webmail Roundcube opcional). E-mail: Stalwart v0.11.8.

## 2. Regras do Kelvin (obrigatórias)

**Globais (`~/.claude/CLAUDE.md`):** ao criar/alterar arquivo, **cite só o caminho**; nunca cole conteúdo, diff nem resumo de linhas. Explique mudanças **em português, pelo comportamento**. Exceções: comandos de terminal para ele executar, valores curtos de configuração, trechos de terceiros citados.

**Do projeto (memórias em `memoria/`):** consultar `comoFuncionaSistema/` antes de explorar; subagente escreve só no próprio worktree; pedido explícito dele não se reduz (objeção se diz, não se aplica em silêncio); instruções de VPS completas (caminho `/opt/tws-panel`, comandos na ordem, como conferir); rodar cobertura de todos os pacotes antes do PR; não repetir passos que ele já fez; **todo pedido de execução vira um subagente próprio** (um por assunto; perguntas simples o assistente responde direto; usar o modelo pedido).

**Privacidade/segurança (MUST):**
- Nunca expor IP, token, domínio de cliente, endpoint de bucket ou hospedagem anterior em **arquivos públicos** (usar `example.com` / `203.0.113.x`).
- Nunca colar em chat senha, chave de acesso, setup token, chave de recuperação. Nunca ler/imprimir `.env`/`.env.local` do cassino. A senha do `.7z` de backup de e-mail já foi colada por ele antes (não repetir nem gravar).
- Não publicar nada em nome dele (posts no X etc.). Ações externas dependem dele ou de autorização explícita. Não reescrever histórico. Não editar/enviar `twsFazenda` sem ele pedir. **Não investigar o e-mail do projeto "fazenda" nem rodar nada contra a VPS dele**: comandos de diagnóstico para a VPS são **só para ele executar**.
- Não apagar os arquivos não rastreados dele na raiz do repo: `CODE_REVIEW.md`, `image1.png` … `image6.png`, `TWS Panel Backups__email_2026-10-15_22-34.7z`. `docs:links` reclama de `CODE_REVIEW.md`: mover para `/tmp/claude-1000/x/` (criar com `mkdir -p`) ao rodar e devolver depois.
- `~/projects/social`: nunca publicar; sem commit/stash/reset/checkout.
- Hook de pre-commit barra marcador de chave privada e caminhos com `data/`.
- Subagentes: escrever só no próprio worktree; nada de `git clean`; **se aparecer objeto vazio em `.git/objects`, avisar, não apagar**. Volumes Docker anônimos soltos e containers como `tws-teste-4335` (nginx) não são nossos.
- **A máquina tem pouca memória / trava.** Já corrompeu objetos do `.git` uma vez (71 objetos vazios, recuperados). Por pedido do Kelvin (23/10): **não subir containers/Docker, nem navegador/Playwright, nem servidores de dev longos** até ele liberar; rodar testes um pacote por vez, `--maxWorkers=2`, `DOCKER_HOST` apontando para socket inexistente.

## 3. Fluxo de trabalho (executor → revisor → mesclagem)

1. **Executor** (modelo Sonnet) por tarefa, `isolation: worktree`. O worktree parte de base antiga: todo brief manda `git fetch origin && git merge dev` primeiro e confirmar que arquivos não estão vazios (`wc -c package.json`). Commitar em etapas pequenas (a máquina cai).
2. **Revisor** (modelo Opus), rigoroso e adversarial, em **cópia própria** no scratchpad, com mutações; não confia no relatório do executor; limpa o que cria; grava progresso em arquivo. Veredito APROVADO/REPROVADO com motivos numerados.
3. Reprovação volta ao executor via `SendMessage` com os motivos numerados; repetir até aprovar (é normal levar 3–6 rodadas).
4. Aprovado: mesclar no `dev`: `git merge --no-ff <branch> -m "merge: …"` (mensagem termina com as linhas de atribuição, ver seção 4); depois `git worktree remove -f -f <path>` e `git branch -D <branch>`.
5. Agente que não aceita `SendMessage` ("cannot receive messages") = precisa ser redisparado do zero com o brief completo (ver `prompts/`).
6. Máquina saturada (load 20–46 quando vários agentes rodam cobertura): testes sob carga usam `vi.useFakeTimers({toFake:["Date"]})`; não rodar suítes em paralelo.

Padrões de reprovação já vistos (anteciparam nos briefs): aviso que mente em caminho alternativo, testes com relógio real, mutações que sobrevivem, cobertura abaixo do mínimo, documentação que promete mais que o código faz, listas de memória em vez de fonte oficial, rota nova sem classificação.

## 4. Git, PR e VPS

- Commits terminam com:
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` e `Claude-Session: https://claude.ai/code/session_01JDHHisDsbrpwf8726wLqzk` (a sessão nova pode usar a própria URL de sessão, se houver).
- Reconciliação após squash do Kelvin: `git fetch -q origin`; se `git diff --stat HEAD origin/main` vazio → `git merge -q -s ours origin/main -m "chore: reconcile with main after squash merge (#N)"`; senão `git merge --no-ff -X ours origin/main` e conferir com typecheck/testes. Depois `PAAS_SKIP_PREPUSH=1 git push -q origin dev`.
- PR: `gh pr create --base main --head dev --title … --body-file <arquivo>`; corpo em português, termina com "🤖 Generated with [Claude Code](https://claude.com/claude-code)" + linha em branco + URL da sessão. `gh pr edit` falha: usar `gh api -X PATCH repos/kelvindk9w/tws-panel/pulls/N …`. **Próximo PR = #106.**
- Cobertura mínima (CI reprova): server 94/91/98/94 (linhas/ramos/funções/instruções; hoje funções 98,07–98,34, folga mínima), deploy 95% ramos (hoje 95,27), mailer 98%, security 96%, core 98%. Comando: `pnpm -r --workspace-concurrency=1 --no-bail run test:coverage` (server `--maxWorkers=2`); no web o `--no-bail` quebra (rodar sem); no vitest o argumento é `--bail=0`. Três arquivos do `security` e um do `deploy` precisam de Docker real (falham sem ele, é ambiente).
- Scripts úteis: `pnpm -r typecheck`, `node scripts/check-no-real-hosts.mjs`, `pnpm run docs:links`, `docs:site-url`, build do site. Lista de sufixos públicos: `node scripts/gen-public-suffixes.mjs` (cópia fixada da PSL em `packages/core/psl/`).
- **Atualização da VPS** (dar ao Kelvin depois de cada merge): `cd /opt/tws-panel && sudo git pull && sudo git log --oneline -1 && sudo docker compose up -d --build`.

## 5. Estado do repositório (em 23/10/2026)

- **Mesclados em `main` pelo Kelvin:** PRs #84 a #104 (incl. #102 e-mail em caixa existente, #103 segurança Roundcube 1.7.5/PHP 8.4.27 + Node 22.23.4, #104 nome de exibição/guardrails doc/alerta de atualização/histórico de envios SMTP/travas do login/2FA/entregabilidade/teste de restauração PostgreSQL). A VPS roda `c9e7e44` (PR #104).
- **PR #105 ABERTO** (https://github.com/kelvindk9w/tws-panel/pull/105), `dev` = `origin/dev` = `33080ce`, **CI verde** (ci, build, trivy; deploy skipped), mergeable. **Aguarda o Kelvin mesclar com "Squash and merge".** Conteúdo: contador de tentativas do 2FA; saúde do e-mail por projeto (+PTR, itens expansíveis); status dos envios por projeto; domínio com e sem www (PSL embutida, IDN/punycode); MCP Fase 0 (tokens de API com escopo, Bearer, auditoria `token:<nome>`, tela Configurações → Acesso por IA, 47 rotas proibidas a token); correções de testes instáveis e fechamento do serviço de notificações.
- **Depois que ele mesclar o #105:** rodar a reconciliação (seção 4), dar o comando de atualização da VPS e lembrar cuidados: o Stalwart reinicia ao cadastrar domínio de e-mail novo; domínios antigos podem precisar recriar DKIM; 2FA bloqueia conta após 5 erros (5 min, dobrando até 24 h; `reset-2fa.sh --so-bloqueio`); guardar códigos de recuperação; trocar a senha ou recomeçar o assistente **revoga todos os tokens de API**.
- **Fase 0b (escopo por projeto) — NÃO está no GitHub.** Está só no computador, na branch local `worktree-agent-afa2e8e7957c923a4` (worktree `~/projects/paas/.claude/worktrees/agent-afa2e8e7957c923a4`), 6 commits sobre `33080ce` (`9e0e81a`, `604baad`, `0d1f0ac`, `00eb110`, `cc03082`, `d73eecc`). Executor terminou e relatou: typecheck ok, cobertura ok (server funções 98,07 — folga ínfima), 26 mutações detectadas, testes novos 20x. **Falta a revisão do Opus** (veja seção 6). **Se a formatação acontecer antes de empurrar essa branch para o GitHub, esse trabalho se perde** (ver seção 9).
- Branches locais antigas `worktree-agent-ae2b0f488c9574522` e `…ae9dfda2d7e90982a` já estão no `dev` (podem ser apagadas).
- Alerta Dependabot 82 (`braces`, advisory retirado, sem versão corrigida) foi dispensado como impreciso em 23/10.

## 6. Agentes — situação no momento da escrita

Nenhum agente está de fato executando (a máquina reiniciou e as sessões caíram). Os IDs antigos **não servem** numa sessão nova; redisparar do zero.

| Assunto | Papel | Situação | O que fazer |
|---|---|---|---|
| Domínio com e sem www | executor+revisor | **Concluído e mesclado** (`88423f3`, 6 rodadas) | nada |
| MCP Fase 0 (tokens de API) | executor+revisor | **Concluído e mesclado** (`33080ce`, 5 rodadas) | nada |
| Verificação completa do dev | verificador | **Concluído** (tudo ok; único teste do deploy falha só sem Docker) | nada |
| **MCP Fase 0b (escopo por projeto)** | executor | **Código pronto**, commitado só localmente (6 commits) | empurrar a branch (com autorização) |
| **MCP Fase 0b** | **revisor Opus** | **Interrompido 3 vezes** por reinício; sem veredito; progresso perdido | **Redisparar** com `prompts/revisor-fase-0b.md` (sem Docker/navegador; registrar o que ficar para `validacoes-pendentes.md`) |

Fase 0b em uma frase: o token passa a ter alcance — painel inteiro, só projetos escolhidos (mesmo nível leitura/escrita/admin), ou projetos + "pode criar" (projeto criado entra sozinho na lista). Fora da lista o projeto "não existe" (404 idêntico ao de inexistente); token limitado nunca alcança rotas de painel/servidor (403); 187 rotas classificadas; aumentar alcance exige senha/2FA; alcance ilegível = token sem alcance; arquivos da Fase 0 migram como painel inteiro. Decisões do executor a validar: clone Git apenas (sem pasta do servidor), restauração de backup só do painel, rotas globais negadas em vez de filtradas, busca por id exato antes de apelido.

## 7. Plano de retomada (ordem)

1. **Esperar o Kelvin mesclar o #105** (ou perguntar) → reconciliar `dev` com `main` → comando de atualização da VPS.
2. **Salvar a Fase 0b** (seção 9) e **redisparar o revisor Opus** da 0b (`prompts/revisor-fase-0b.md`). Reprovou? SendMessage ao executor novo (ou redisparar o executor com a lista de motivos, partindo da branch). Aprovou? Mesclar no `dev` → verificação (cobertura pacote a pacote, lembrar a folga mínima de deploy e server) → **PR #106** → atualização da VPS.
3. **MCP Fase 1 — "fatia vertical projeto no ar"** (HTTP streamable em `/mcp`, desligado por padrão; só Bearer, nunca cookie; rejeitar requisições de navegador/DNS rebinding; checar `flush_interval -1` no Caddy): criar projeto de repositório, ver o que precisa, definir variáveis (**sem devolver valor**), domínio com/sem www, deploy, ler logs; respeitar alcance por projeto da 0b. Durante a instalação o setup token pode ser aceito em `/mcp` apenas para o roteiro "Deixe o painel pronto" (domínio do painel, notificações, backup, e-mail), com SSH/firewall só em `dryRun`. Saída estruturada, textos como dado não confiável, segredos removidos. **Antes**, pedir ao Kelvin para confirmar as 8 decisões do `plano-mcp.md` e a de segredos (padrão = caminho seguro: a IA lista variáveis faltantes e o humano digita os valores sensíveis na tela; ler `.env` local só por opção explícita).
4. Fase 2 (mudanças reversíveis + botão "Conectar uma IA", token 24 h), Fase 3 (confirmação humana com 2FA para ações destrutivas), Fase 4 (pareamento + OpenAPI). Ver `plano-mcp.md` seções 4 e 10.
5. Lotes futuros possíveis: mensagens de guardrail (erro do compose só com contagem; override inalcançável para `${VAR}`; janela oferece override inútil para 5 regras; `conceito-guardrails.json` desatualizado); progresso/cancelamento/clone raso na criação do projeto (aguarda texto do erro 422 e tamanho do repo); porta 465/`SMTP_SECURE` (aguarda a resposta do Kelvin: 465 vs 587); v0.2.0 (tag, notas, checksums, aviso "beta" no README, prints em inglês); Dockerfile com retry do pnpm; 2FA obrigatório/passkey; reativar MySQL/MariaDB/Mongo no teste de restauração (decisão do Kelvin); AAAA no check de DNS; carregar a lista de sufixos públicos sob demanda (módulo de 117 KB); aviso no card de saúde quando houver MX de outro provedor junto com o do painel (caso real do dia 23/10, ver seção 8); teste do dublê de `engine.remove` no alerta de atualização; legenda do punycode só quando houve conversão (teste); `PUT /api/notifications/kinds` e `check-git-access` simples (informativos da 0).

## 8. Ações que dependem do Kelvin (não fazer por ele)

- Mesclar o #105 (e depois #106); rodar a atualização na VPS.
- **E-mail `contato@` não recebe** (diagnosticado em 23/10): o DNS de `<dominio-da-tws>` tem dois MX — `5 <MX-da-hospedagem-anterior>` (hospedagem anterior) e `10 mail.<dominio-da-tws>` (painel). Como o menor número vence, o e-mail ainda vai para a hospedagem anterior. **Correção dele na Cloudflare:** apagar o MX da hospedagem anterior (e `mx2`, se existir), deixar só `mail.<dominio-da-tws>`, e conferir que o A de `mail` está com nuvem cinza. Depois: `dig +short MX <dominio-da-tws> @1.1.1.1` deve mostrar uma linha; pedir à X (programa de startups) para reenviar o convite. Se ainda falhar, diagnóstico (só leitura, ele roda na VPS): `sudo ss -ltnp | grep ':25 '`, `sudo ufw status`, `docker logs --since 30m paas-stalwart 2>&1 | grep -iE "contato|smtp" | tail -n 30`. **Ainda não relatou se resolveu.**
- Pedir o PTR (DNS reverso) do IP à provedor da VPS (Customer Control Panel → Reverse DNS Management; o nome deve ser o HELO do servidor de e-mail, `mail.envio.<dominio>`); hoje o card marca crítico.
- DMARC está em `p=none`; endurecer só depois de semanas de relatórios.
- Responder: porta 465 vs 587; decisão sobre o teste de restauração só PostgreSQL; segredos no MCP (padrão seguro).
- Relatar os testes pós-atualização da VPS que faltam (webmail abre; e-mail do projeto do site TWS; "na fila" resolvido?); fazer o 1º backup manual (passo 6 do roteiro).

## 9. Como a transição foi salva (e como restaurar)

Tudo foi para o GitHub, em duas branches **separadas do `dev`/PR #105**:

- **`handoff/2026-10-23`** — esta pasta `handoff/`.
- **`mcp-fase-0b`** — o código da Fase 0b (6 commits sobre `33080ce`), **ainda não revisado** (a revisão Opus é a primeira tarefa pendente).

Restaurar depois da formatação: instalar Node 22 + pnpm, `gh auth login`, `git clone https://github.com/kelvindk9w/tws-panel ~/projects/paas`, `cd ~/projects/paas && git checkout handoff/2026-10-23`, `pnpm install --frozen-lockfile` (só quando for rodar testes), recriar as memórias a partir de `handoff/memoria/`, instalar o Claude Code. Docker só quando necessário (memória da máquina).

**Fora do GitHub** (o que só ele guarda; conferir antes de formatar): arquivos não rastreados da raiz (`CODE_REVIEW.md`, `image1.png`…`image6.png`, o `.7z` de backup de e-mail), `~/projects/fazenda`, o projeto do cassino e seus `.env`, `~/projects/social`, `~/post-tws-panel/`, chaves de recuperação 2FA, setup token, senhas de backup. Análises de segurança locais (`~/analise-login-2fa.md`, `~/auditoria-vulnerabilidade-2026-10-22.md`) **não** foram para o repositório público de propósito.

## 10. Como o novo assistente deve começar a conversa

Dizer ao Kelvin, em poucas linhas e em português: (1) que leu o documento; (2) o estado (PR #105 aberto/mesclado?; Fase 0b salva ou não; revisor da 0b a redisparar); (3) a próxima ação proposta (seção 7) e **uma única** pergunta se houver bloqueio. Não pedir de volta o passo a passo que ele já fez. Tudo que for executar vira subagente próprio, um por assunto.
