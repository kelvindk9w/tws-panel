# Validações pendentes (para executar depois, com a máquina livre)

Escrito em 23/10/2026. Tudo aqui foi **deixado de fora de propósito** (pedido do Kelvin: não subir containers nem navegador agora, para não esgotar a memória) ou depende de algo que só ele faz. Marque cada item quando concluir. Itens "VPS" são **comandos para o Kelvin executar** (o assistente não roda nada contra a VPS dele).

Regra de cuidado para os itens com Docker/navegador: um de cada vez, fechar tudo ao terminar, conferir `free -m` antes e depois.

## A. Máquina de desenvolvimento (precisam de Docker ou navegador)

| # | Validação | Como | Por que ficou pendente |
|---|---|---|---|
| A1 | Teste do deploy `tests/engine-guardrail-reuse.test.ts` ("com relatório pré-computado 'limpo', NÃO re-escaneia") | Com o Docker ligado: `pnpm --filter ./packages/deploy run test:coverage` e conferir que passa e que ramos ≥ 95 (hoje 95,27 com essa falha incluída) | Falha só quando o Docker está parado (erro "falha ao criar a rede paas-net") |
| A2 | Pacote `security`: 3 arquivos que fazem `docker pull ubuntu:24.04` (`phase01-script`, `phase02-07-scripts`, `phase03-04-scripts`) | Docker ligado e com acesso à internet: `pnpm --filter ./packages/security run test:coverage`; ramos ≥ 96 (medido sem eles: 97,33; com eles na Fase 0b: 12 arquivos passaram) | Ambiente sem a imagem |
| A3 | Teste antigo `terminal-service-pty` (server) usa Docker real quando existe | Rodar uma vez com Docker ligado e uma com `DOCKER_HOST=unix:///nonexistent` | Passa nos dois, mas nunca foi observado com Docker nesta rodada |
| A4 | **Tela Configurações → Acesso por IA em navegador real, 360 px e 1024 px, claro/escuro, pt-BR e en** (Fase 0: aprovada pelo revisor; **Fase 0b: seletor de alcance, linha de alcance, "Editar projetos", lista grande de projetos, projeto apagado, estado de erro, foco/leitor de tela — nunca vistos em navegador**) | Subir o painel em dev (`pnpm dev` ou a build) e abrir no Playwright/Chrome; criar token de cada alcance; copiar segredo; editar projetos; revogar | Pedido de não abrir navegador |
| A5 | Assistente de criação de projeto a 360 px rola ~12 px na horizontal (barra de passos) | Abrir o assistente a 360 px e ajustar a barra | Observação do revisor do domínio; trecho não mudou no lote |
| A6 | Caddyfile gerado com IDN e par www passa no `caddy validate` com o Caddy real (feito na revisão, mas não repetido após o merge) | `docker run --rm -v <dir>:/etc/caddy caddy:2 caddy validate --config /etc/caddy/Caddyfile` com um Caddyfile gerado pelo servidor de teste | Docker |
| A7 | Fluxo ponta a ponta de domínio com/sem www em ambiente com ACME e DNS reais (certificado só quando o DNS do par aponta) | Na VPS, com um domínio de teste e DNS na Cloudflare (nuvem cinza) | Nunca testado contra Caddy/ACME/DNS reais |
| A8 | Folgas de cobertura apertadas — conferir após qualquer mudança: **deploy ramos 95,27 (mín. 95)**; **server funções 98,07–98,34 (mín. 98)** | `pnpm -r --workspace-concurrency=1 --no-bail run test:coverage` (server `--maxWorkers=2`; web sem `--no-bail`; vitest usa `--bail=0`) | Risco de CI vermelho com qualquer código novo sem teste |
| A9 | `core.hooksPath=scripts/hooks` foi (re)gravado no `.git/config` compartilhado pelo `pnpm install` do verificador | `git config core.hooksPath` no repo principal; se estranho, restaurar o valor anterior (provavelmente já era esse) | Não deu para confirmar o valor anterior |

## B. Revisão da Fase 0b (nunca concluída)

O revisor Opus da Fase 0b caiu três vezes por reinício da máquina e **não emitiu veredito**. Tudo abaixo está por fazer (ver `prompts/revisor-fase-0b.md`). O executor relatou o seguinte, **ainda não confirmado por revisor**:

- B1 Matriz rota × alcance (187 rotas) com tokens reais: painel, projeto A, projeto A + criar, lista vazia, projeto apagado.
- B2 404 de projeto fora do alcance idêntico ao de inexistente (corpo e cabeçalhos), em todos os métodos e rotas aninhadas (deploy id, backup id, job id, log, domínio, link de e-mail, cron); sem vazar via 409 de nome/domínio/porta em uso.
- B3 Criar projeto com "pode criar": atomicidade (desfazer se falhar o registro; erro com o nome se nem o desfazer funcionar), corrida entre criações e edição de alcance.
- B4 Editar alcance só por humano; aumentar exige senha/2FA, reduzir não; apagar projeto remove das listas; id reutilizado não herda acesso; migração de arquivo da Fase 0 (= painel inteiro); alcance ilegível = sem alcance.
- B5 Busca de projeto "id exato antes de apelido": tentar sequestro (nome de projeto igual ao id de outro, maiúsculas, unicode, `%2e`, barra extra, parâmetros duplicados).
- B6 Um token de projeto consegue clonar repositório **privado** usando a conta GitHub conectada do painel? Isso seria escalada. Avaliar e documentar/limitar.
- B7 26 mutações do executor foram detectadas; o revisor deve fazer ao menos 20 próprias. Testes novos 30x sob carga com `DOCKER_HOST` inexistente.
- B8 Documentação (SECURITY.md, `ai-access.md` pt-br/en, CHANGELOG, ROADMAP, relatório) honesta: limitar alcance restringe a API do painel, **não é sandbox**.
- B9 Cobertura pacote a pacote da branch (server funções 98,07 — folga ínfima).

## C. Produção / VPS (comandos para o Kelvin executar; trocar `seu@gmail.com`)

1. **Atualizar a VPS após cada merge:** `cd /opt/tws-panel && sudo git pull && sudo git log --oneline -1 && sudo docker compose up -d --build` (após o #105 o `log` deve mostrar o commit do squash do #105).
2. **E-mail `contato@` recebendo** — depois de apagar o MX da hospedagem anterior na Cloudflare:
   - `dig +short MX <dominio-da-tws> @1.1.1.1` deve devolver **uma** linha (`mail.<dominio-da-tws>`).
   - `sudo ss -ltnp | grep ':25 '` e `sudo ufw status | grep -E '25|Status'` (porta 25 escutando e liberada).
   - Enviar teste do Gmail e do convite da X; `docker logs --since 30m paas-stalwart 2>&1 | grep -iE "contato|smtp" | tail -n 30`.
3. **Teste real de envio** (já deu spf/dkim/dmarc pass em 22/10): repetir após o #105; abrir "Envios deste projeto" e conferir que o status deixa de ficar "na fila" depois da entrega. Se ainda ocorrer: `docker exec tws-panel … grep` em `/data/mail/envios/saidas/*.jsonl` e `estado.json` (`collectedAt`/`collectError`), `docker logs --since 72h paas-stalwart | grep -E "dsn-success|dsn-perm-fail|queue.rescheduled"`, `docker inspect -f … paas-stalwart`.
4. **PTR**: pedir à provedor da VPS (Customer Control Panel → Reverse DNS Management) com o nome do HELO (`mail.envio.<dominio>`); depois conferir o card "saúde do e-mail" (hoje crítico).
5. **Webmail** (Roundcube 1.7.5) abre e entra na caixa; **e-mail do projeto do site TWS** (ainda não relatado).
6. **2FA**: errar o código e ver "tentativas restantes"; 5 erros bloqueiam 5 min; `reset-2fa.sh --so-bloqueio` destrava; guardar os códigos de recuperação.
7. **Tokens de API** (depois da Fase 0 em produção): criar token de leitura, usar `curl -H "Authorization: Bearer …" https://<painel>/api/projects` (token fictício na doc; nunca colar token real no chat); trocar a senha e ver todos os tokens revogados; confirmar que rotas proibidas dão 403 mesmo com admin.
8. **Backups fora da VPS**: 1º backup manual (passo 6 do roteiro); testar restauração PostgreSQL (papel descartável, banco temporário `tws_rc_…`); decidir sobre MySQL/MariaDB/Mongo.
9. **Domínio do site da TWS** (ainda fora do ar): orientar DNS com e sem www, verificar os dois, deploy.
10. **Caddy e `/mcp` (Fase 1)**: conferir que o proxy mantém envio contínuo (`flush_interval -1`) também para `/mcp`.
11. **DMARC** `p=none`: acompanhar relatórios por semanas antes de endurecer.

## D. Decisões abertas do Kelvin

- Porta de envio 465 vs 587 (`SMTP_SECURE`).
- Teste de restauração só PostgreSQL: aceitar ou reativar outros bancos.
- MCP: as 8 decisões de `plano-mcp.md` (seção 5) e a de segredos (padrão seguro).
- (Resolvido em 23/10: a branch da Fase 0b foi enviada ao GitHub como `mcp-fase-0b`, sem revisão ainda.)
- Um PR por fase (#106 = 0b) — proposta do assistente: separar a autenticação do MCP do resto.
