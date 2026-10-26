# Estado da sessão — atualizado em 26/10/2026

Documento de retomada. Se você é um agente entrando agora, leia este arquivo
primeiro e depois `index.json`. Ele diz **onde o trabalho parou**, o que está
pendente e por quê — informação que não está no código nem no git log.

> Este repositório vai ser público. Não registre aqui IP da VPS, token de setup,
> senhas nem nomes de clientes.

---

## Atualização de 26/10/2026 — MTA-STS automático e botão Verificar (subagente, worktree isolado, ramo `fix/mta-sts-automatico`)
- **Queixa do Kelvin:** com a política já abrindo, o item aparecia como "Bônus" e ainda mostrava os cinco passos de configuração; ele achou que não estava concluído.
- **O que passou a existir:** (1) item MTA-STS ativo (testing/enforce) com nível `ok`, selo "Ativo" e "Detalhes" recolhido; só falta algo => "O que fazer" com ✓/✗ e só os passos que faltam. (2) `MtaStsPublisher` (`apps/server/src/services/mta-sts-publisher.ts`): ao criar o domínio, na subida (90 s) e a cada 30 min registra o nome no proxy e, se o DNS já aponta, aquece o certificado abrindo a própria URL; limites de 3 por rodada, 10 por hora e esperas por domínio; estado `waiting_dns|issuing|active` na lista de domínios. (3) `POST /api/mail/domains/:domain/mta-sts/verify` (ver `email/verificar-mta-sts.json`). (4) A `mta-sts` e TXT `_mta-sts` no checklist de DNS como opcionais. (5) `id` anterior do TXT aceito por 24 h (`MtaStsIdStore`).
- **Decisões minhas (revisar se discordar):** 24 h de tolerância (max_age de 1 dia da RFC 8461); estado do publicador fica em memória; o aquecimento só ocorre se o DNS aponta (o `ask` ainda aplica as cotas).
- **NÃO feito, de propósito:** criar A e TXT no DNS sozinho. O código não tem integração com provedor de DNS (só detecta IP do Cloudflare). Próximo passo: token opcional do Cloudflare (Zone.DNS:Edit) guardado criptografado.
- **Não verificado (sem VPS):** o Caddy chamar o `ask` e emitir o certificado de `mta-sts.<domínio>`; o handshake abortado pelo aquecimento (30 s) deixar o Caddy terminar a emissão; o painel abrir a política pelo IP público da própria VPS; a negativa de DNS em cache de 60 s no `pointsHere`.

---

## Atualização de 26/10/2026 — saúde do e-mail: MTA-STS publicado pelo painel, opcional e "ciente" (subagente, worktree isolado, ramo `fix/saude-email-mta-sts-opcionais`)
- **Queixa do Kelvin:** "tem coisa que não depende de nós e isso fica impactando". O MTA-STS (opcional) mandava publicar um arquivo que o painel não publicava e deixava o domínio em "Atenção"; o PTR depende do provedor e ficava em "Atenção" para sempre.
- **O que passou a existir:** (1) O Caddy serve `https://mta-sts.<domínio>/.well-known/mta-sts.txt` (text/plain, texto da tela com LF, resto 404) para cada domínio de e-mail cadastrado, com certificado sob demanda: `CaddyDynamic.mtaSts` (packages/deploy/src/caddy.ts), `DynamicDomainsInput.mtaSts`, `MailService.mtaStsSites`, `DeployService.setMtaStsProvider`. O `ask` autoriza `mta-sts.<domínio>` só para domínio de e-mail cadastrado (`DynamicDomainsService.authorizeMtaSts`: DNS apontando para a VPS antes da cota, mesmas cotas por hora/semana/nome; sem teto de nomes). O certificado aparece em Certificados com dono "e-mail". (2) Plano de DNS ganhou o A `mta-sts.<domínio>` (id `mta_sts_a`); o item MTA-STS confere A, TXT e arquivo com uma mensagem por caso (`absent`, `missing_a`, `a_mismatch`, `a_proxied`, `missing_txt`, `id_outdated`, `cert_pending`, `cert_failed`, `unreachable`, `invalid`, `mx_mismatch`, `testing`, `enforce`); o `id` do TXT acompanha o texto da política. (3) Nível novo `optional` ("Opcional · não configurado" / "Opcional · incompleto") para MTA-STS e TLS-RPT: visível, com "O que fazer", fora das contagens e do selo. (4) "Marcar como ciente" (PUT/DELETE `/api/mail/domains/:domain/health/ack/:id`, só admin, auditado) para PTR e porta 25, com motivo opcional, gravado em `data/mail-health-acks.json`; vale para o problema do momento (`mailHealthFingerprint`) e some sozinho se ele mudar.
- **Decisões minhas (revisar se discordar):** só `mode: testing` (o `enforce` por domínio exigiria guardar o modo e mudaria o id do TXT; fica documentado, não feito); marcáveis são só PTR e porta 25 (os que dependem do provedor); a marcação é do servidor, não por domínio; política com id de outro lugar (escrita à mão) não é comparada com o do painel; o texto servido usa LF (RFC 8461 aceita CRLF ou LF); a faixa "Saúde da VPS" do Dashboard NÃO mostra a saúde do e-mail, então não houve o que mudar nela.
- **Correções da revisão (mesmo dia):** (a) `ask` do mta-sts carrega o estado antes de tudo; ilegível = emissão nova recusada, nada gravado, renovação passa; a primeira consulta depois de reiniciar lê os certificados já emitidos (`deps.issuedCertificates`) para a renovação não gastar cota. (b) Política em `enforce` quebrada deixa de ser opcional (MX fora = crítico, inválida = atenção); `testing`/ausente seguem opcionais. (c) Com o TXT presente, abre-se a política primeiro; se funciona, o A não é cobrado; só se não abre se diagnostica A, nuvem laranja e certificado. (d) "Ciente" só em atenção (crítico, como porta 25 bloqueada, nunca é silenciado). (e) Sem domínio do painel o item diz `publish_unavailable`. (f) Impressão do PTR com nomes ordenados; `summary()` removido; motivo do ciente em uma linha; checador exige `Content-Type: text/plain`. Rodada 3: política comparada com os MX reais (curinga de um nível, `mx_external` para MX de outro provedor), último modo bom guardado em `data/mail-health-mta-sts-modes.json` (`enforce_lapsed`), leitura dos certificados no boot compartilhada, e `reserveManual` (cadastro de domínio comum) recusa com 503 se o estado ilegível.
- **Não verificado (sem VPS):** o Caddy chamar o `ask` para `mta-sts.<domínio>` e emitir o certificado; a política abrir a partir do container do painel pelo IP público da própria VPS; remetentes reais aceitarem a política (LF).

---

## Atualização de 26/10/2026 — MCP, Fase 1: projeto no ar (subagente, worktree isolado)
- **O que passou a existir:** `POST /mcp` (MCP por HTTP, JSON-RPC, respostas JSON). Módulo novo `mcp/`. Desligado por padrão; liga em Configurações → Acesso por IA (senha e 2FA). Desligado, `/mcp` dá 404 como rota inexistente.
- **Decisões do dono (26/10):** quem instala decide o poder da IA; toda opção tem padrão seguro e afrouxar só por pessoa com senha e 2FA e aviso de risco. Escopo: consultar tudo; criar projeto, domínio e variáveis; deploy, logs, reiniciar e recriar; **nada que apague**. Segurança (SSH/firewall): padrão só simular. Segredos: padrão a IA define e troca mas não lê. Aprovação humana das ações sensíveis: padrão ligada, dispensável. Validade do token: 1, 7, 15, 30, 90, 180, 365 dias ou sem vencimento (substitui o teto de 365). Métricas pelo MCP: opção desligada por padrão. stdio e OpenAPI ficam para depois.
- **Decisões minhas (revisar se discordar):** (1) as quatro opções são **por token** (`securityApply`, `secretsRead`, `skipApproval`, `metrics`), porque o cadastro de tokens já tem criação e ampliação com senha e tokens diferentes merecem confianças diferentes; o **liga/desliga** do MCP é da instalação; (2) sem o SDK oficial (escreve direto no `res` do Node e pularia os hooks do Fastify; 4,5 MB de dependências); (3) cada ferramenta chama a rota HTTP por `app.inject` com o token do chamador, então nada pula validação, trava, alcance ou limite; só as variáveis têm código próprio (a rota nega valores a qualquer token); (4) aprovações e sessões ficam em memória (somem ao reiniciar; a IA pede de novo); (5) `PAAS_MCP_SETUP_LEVEL` deixa o setup token valer no `/mcp` na instalação, sem aprovação; (6) a tela de tokens passou a ter a escolha de validade em dias e o "sem vencimento" com confirmação.
- **Não validado em VPS real:** Caddy repassando `/mcp`, um cliente real (Claude Code), deploy, recriar e reiniciar de verdade pelo MCP, aplicar segurança de verdade, métricas reais, a tela no navegador e o fluxo de 2FA ao vivo.
- Guia do site: `site/src/content/docs/{pt-br,en}/guides/mcp.md`. Relatório: `_RELATORIO-mcp-fase1.md`.

## Atualização de 26/10/2026 — preparo de projeto (revisão do guia "Preparar seu projeto") (subagente, worktree isolado)
- **O que passou a existir:** (1) `.env` do painel fora do contexto de build (Dockerfile e compose com `build:`): `packages/deploy/src/build-context.ts` escreve `<Dockerfile>.dockerignore` mesclado só durante o build e restaura depois; só vale para `.env` com o cabeçalho do painel. (2) Opção `Project.spa` (nginx estático com `try_files $uri $uri/ /index.html`, montado como `paas.spa.conf`); `DetectResult.spaSuggested`. (3) Variáveis "de build" (`EnvVar.build`): `packages/deploy/src/build-vars.ts`; build estático por `--env-file` (0600, apagado depois), `--build-arg` só para marcadas e declaradas por `ARG`, `build.args` no override do compose. (4) Detecção: Dockerfile com prioridade (aviso `detect.dockerfile-priority`), `package.json` sem build com Dockerfile vira `dockerfile`, tipo à mão (`POST /detect` com `{type}`, `Project.typeOverride`, 422 `invalid_type`). (5) `guessProxyTarget` usa `ports`/`expose` antes de 80. (6) `dockerfileExposePort` do último estágio (`dockerfile.ts`). (7) `weak-credentials` confere Variáveis salvas (`variable-resolve.ts`). (8) `publishBuildOutput` remove ocultos mantendo `.well-known`.
- **Decisões minhas (revisar se discordar):** o `.env` só é excluído quando tem o cabeçalho do painel (um `.env` do usuário é respeitado); a SPA é opção explícita por projeto (o assistente a marca conforme a sugestão); o tipo escolhido à mão persiste até o código deixar de servir; padrões `${VAR:-x}` do compose não entram no `weak-credentials`; variável marcada vence `build.args` do compose de mesmo nome.
- **Correções da revisão (mesmo dia):** diário `paas.dockerignore.journal` na pasta de trabalho, gravado antes de tocar no `<Dockerfile>.dockerignore` e restaurado no começo de todo build e na subida do painel (`DeployService.recoverBuildLeftovers`); `.dockerignore` link para dentro é seguido, para fora/grande/ilegível recusa o deploy; `DOCKER_BUILDKIT=1` no `docker build`; Dockerfile fora do projeto é recusado; aviso do `.env` do repositório no contexto; aviso de nome de segredo "de build" (tela e log); auditoria cita as marcadas; aviso crítico ao escolher "site estático" com arquivos de servidor; `listen [::]:80` removido; restauração com try/catch por arquivo. Aceito e documentado: o relatório de guardrails revela que uma Variável é fraca (nunca o valor).
- **Não verificado (sem Docker):** que o BuildKit honra `<Dockerfile>.dockerignore` ao lado do Dockerfile pelo `docker build` e pelo compose; que o compose mescla `build.args` na forma curta `build: ./dir`; `docker run --env-file`. Conferir na VPS de desenvolvimento.

---

## Atualização de 25/10/2026 — domínios dinâmicos para SaaS multi-cliente (subagente, worktree isolado)
- **O que passou a existir:** nomes de clientes (domínio próprio ou um nível abaixo de um sufixo do dono do SaaS) servidos por um projeto sem editar o projeto. O Caddy emite o certificado de cada nome sob demanda (`on_demand_tls`) depois de perguntar ao painel, em um ouvido interno separado do Fastify (`PAAS_ASK_PORT`, padrão 9101, só rede privada, sem log, falha fechada), se o nome é permitido. Módulo novo: `dominios-dinamicos/`.
- **Decisões do dono aplicadas:** emissão sob demanda agora; DNS-01/curinga e verificação TXT ficam na fase 2 (ROADMAP); sem dependência da API da Cloudflare; sem Cloudflare for SaaS; tetos padrão de 500 nomes por projeto e 20 emissões novas por hora, ajustáveis em Configurações → Domínios dinâmicos (10–5000 e 1–100).
- **Decisões minhas (revisar se discordar):** (1) o sufixo tem a opção `openAll` (desligada por padrão): ligada, o primeiro acesso a qualquer nome um nível abaixo do sufixo o cadastra sozinho e conta no teto; desligada, só valem nomes cadastrados; (2) a cota de emissões é GLOBAL (a conta ACME é uma só) e o teto de nomes é por projeto; o mesmo nome tem no máximo 3 tentativas novas por hora e nome que já tem certificado visto passa sem gastar cota (renovação); (3) roteamento por bloco único `*.sufixo` + nomes avulsos no mesmo bloco: cadastrar sob o sufixo não recarrega o Caddy, nomes avulsos recarregam em lote (3 s); (4) o estado vem do armazenamento do Caddy, nunca de handshake TLS (o handshake dispararia a emissão); novo estado `waiting` ('Aguardando DNS / emissão'); (5) token de alcance `domains` (read/write; admin recusado; lista obrigatória; 404 idêntico fora do alcance); tokens `projects`/`panel` precisam de admin para cadastrar/remover; sufixos e tetos só a pessoa.
- **Integra com:** `CertificateAlertWatcher` (os nomes dinâmicos entram em `CertificateService.names()`), backup (o JSON `data/dynamic-domains.json` está no diretório de dados; os certificados já estão no volume do Caddy).
- **Limitações documentadas:** sem par www automático; 'Tentar emitir agora' e certificado manual não valem para nome dinâmico (409 `on_demand`); exige painel em container servido pelo Caddy por HTTPS; Cloudflare com nuvem laranja impede o desafio HTTP; contador de cota zera ao reiniciar; sufixos públicos privados (`eu.org`) são recusados; nome vencido que nunca renova alerta até ser removido.
- **Falta validar com Caddy, Let's Encrypt e DNS reais:** o Caddy chamar o `ask` no handshake e aceitar a resposta; o formato do diretório `/data/caddy/certificates/<emissor>/<nome>/<nome>.crt` da versão em uso; o reload com o bloco global `on_demand_tls`; se o Caddy consulta o `ask` também na renovação; a exigência de e-mail na conta ACME (ZeroSSL). Comandos de validação estão no relatório final do lote e no guia do site (`guides/saas-domains`).
- Guia do site: `site/src/content/docs/{pt-br,en}/guides/saas-domains.md` (no menu lateral). CHANGELOG, SECURITY e ROADMAP atualizados.
- **Revisão de 25/10/2026 (fase 2 dos domínios dinâmicos):** sufixo que cobre nome de outro projeto ou o domínio de aplicações é recusado (e o nome exato sempre vence o curinga alheio no Caddyfile); o `ask` confere o DNS (aponta para o IP público da VPS) ANTES de gastar cota e exige um segredo `?k=` na URL; teto semanal por domínio registrável (padrão 40, abaixo dos 50 certificados por 7 dias do Let's Encrypt); reserva atômica de vaga no teto de nomes; projeto apagado deixa de ser autorizado; arquivo ilegível mantém a última lista boa no Caddyfile e alerta; alertas de certificado dos nomes de clientes agrupados por projeto; token de um projeto só não vê o contador global; hospedagem compartilhada (github.io, sslip.io...) recusada e `.example`/`.alt` com aviso. O token de domínios NUNCA vê o monitoramento da VPS (`hostMetrics` sempre falso nele; rotas `host` dão 403). **Falta validar na VPS:** o Caddy aceitar `?k=` na URL do `ask`; o resolvedor do container enxergar o DNS dos clientes; o painel conhecer o IP público (`PAAS_PUBLIC_IP`).

## Atualização de 24/10/2026 — Métricas, Fase 1 (MVP) (subagente, worktree isolado)
- Monitoramento de recursos com **coletor próprio** dentro do painel (sem Prometheus/Netdata/Beszel): a cada 60 s lê o host (`/proc`: CPU com steal e espera de disco, carga, memória disponível, swap, PSI, mortes por falta de memória, disco/inodes, rede, uptime) e cada container/projeto (cgroup v2: CPU, memória de trabalho, IO, oom; rede pelo PID; reinícios e saúde pelo inspect). Sem a montagem, modo reduzido (host pelo `/proc` do container; containers pela API de stats do Docker) e a tela diz isso.
- **Montagens novas** em `docker-compose.yml`: `/proc:/host/proc:ro` e `/sys/fs/cgroup:/host/sys/fs/cgroup:ro`. Só valem com o container **recriado** (o `docker compose up -d --build` da atualização já recria; `docker restart` não). Registrado em SECURITY.md, `global/threat-model.json` e `global/infraestrutura.json`; teste `metrics-compose.test.ts` fixa a lista de montagens.
- Armazenamento em arquivos (padrão do histórico de envios): minuto em `data/metrics-min/` (**fora do backup**, preservado na restauração), hora em `data/metrics/hour/`, dia em `data/metrics/day/`, retenção em `data/metrics-settings.json`. Padrão 48 h / 90 d / 2 anos, configurável em Configurações → Recursos da VPS (24–168 h, 7–365 d, 90 d–5 anos; dia ≥ hora). Reduzir apaga na hora.
- Telas: faixa de semáforos no Dashboard (6 cartões com miniatura de 24 h), aba **Recursos** em cada projeto (1 h/24 h/7 d/30 d) e Configurações → Recursos da VPS. Alertas de recursos (origem `resources`, tipo de aviso `resources`, ligados por padrão) com histerese.
- Token de API: opção nova **"pode ver o monitoramento da VPS"** (`hostMetrics`, desligada por padrão, só em token limitado; ligar = aumentar alcance, pede senha/2FA). Novo alcance de rota `host` na tabela de política. Retenção das métricas proibida a qualquer token.
- Detalhes em `metricas/` (módulo novo). **Fase 2 (não feita):** `/system/df` diário e tamanho de volumes/imagens/logs, página Saúde da VPS completa com top consumidores e linha do tempo, alerta de previsão de disco, rotação de logs do Docker. **Fase 3:** capacidade, CSV, ferramentas de leitura do MCP.
- **Não verificado na VPS real:** leitura de `/host/proc` e `/host/sys/fs/cgroup` montados no container, nome do cgroup com o driver da VPS, `/host/proc/<pid>/net/dev`. O parse de `/proc` e do cgroup v2 foi conferido em Linux real (kernel 6.x com PSI), fora de container. Sem push.

## Atualização de 24/10/2026 — certificados: alerta de renovação, aviso proporcional e backup do Caddy (subagente, worktree isolado)
- **Alerta de certificado automático que não renovou** (o Let's Encrypt parou de mandar e-mail de vencimento): `CertificateAlertWatcher` (`certificate-alerts.ts`, a cada 30 min) cria alerta (origem `certificate`) por nome quando o Caddy devia ter renovado e não renovou, quando o certificado está prestes a vencer/venceu e quando o log do Caddy mostra 3+ rodadas de falha durante 1 h ou mais (crítico após 24 h sem certificado). Texto: nome + causa traduzida + o que fazer, sem IP. Histerese (2 conferências limpas para sair), alerta reconhecido não volta, e vários nomes na mesma rodada viram UM aviso fora do painel. Substituiu o antigo `CertificateWatcher`. Aceita nomes fora do Caddyfile (extensível para "Domínios dinâmicos"; sem emissão sob demanda ainda).
- **Aviso proporcional à validade** (`@paas/core`, `certificateThresholds`): automático 1/4 da validade (o Caddy renova com 1/3), manual 1/3 (máx. 30 d), crítico 1/12 (6 h a 7 d). Vale para 90, 64, 45 e 6 dias. Decisão: 1/4 e não 1/3 no automático para não acender junto com a renovação normal. A tela Certificados mostra a próxima renovação esperada (com a validade) e o estado do alerta.
- **Backup do Caddy**: a cópia externa CIFRADA do painel leva `_caddy/caddy-data.tar` (`docker cp paas-caddy:/data`, volume `paas_caddy_data`: certificados, chaves e conta ACME); a cópia da VPS e a externa sem cifra NÃO levam. A restauração (tela e `restaurar-painel.sh`) junta ao volume sem apagar (`mergeVolume`, root, 0700/0600), grava `data/backups/.caddy-reload-pending` e o painel manda o Caddy recarregar (forçado) ao subir. Falha vira aviso. SECURITY.md e os guias (features, restore-new-server, troubleshooting) atualizados.
- Detalhes: `certificados/index.json`, `backups/index.json`, `backups/restaurar.json`, `notificacoes/index.json`. Falta validar com Caddy/Let's Encrypt/Docker reais (busybox `tar`, recarga forçada lendo o armazenamento, certificado vencido sendo reemitido). Sem push.

## Atualização de 24/10/2026 — Next.js com servidor, sem Dockerfile (subagente, worktree isolado)
- Projeto com `next` nas dependências e sem `output: "export"` (e sem compose nem Dockerfile, que continuam com prioridade) vira o tipo novo **`node-server`**, mostrado como **Next.js (servidor)**. Tipo genérico de propósito: outros servidores Node entram depois trocando só o gerador de Dockerfile. Detalhes em `projetos/conceito-next-servidor.json`.
- O painel gera o Dockerfile **fora do repositório** (`paas.next.Dockerfile` na pasta de trabalho), em duas etapas: instalação congelada pelo lockfile, `next build` e imagem final `node:<20|22|24>-alpine` (digest em `packages/core/src/images.ts`), usuário `node`, `--cap-drop ALL`, sem porta no host. Standalone roda `node server.js`; senão `next start`. `next.config` é lido só como texto.
- `NEXT_PUBLIC_*` entram no build como argumento (públicas por definição, a tela avisa); as demais variáveis chegam ao `next build` por segredo do BuildKit (fora das camadas); o log mostra só nomes. Heap do build = 60% da RAM (768 a 4096 MB); OOM, lockfile fora de sincronia e standalone ausente têm mensagem própria; poda da imagem anterior e do cache com mais de 7 dias.
- Limitações: app só na raiz do repositório (monorepo = Dockerfile próprio, a detecção avisa), Yarn PnP, build sem acesso à rede interna do projeto, `output` por expressão não é avaliado, porta só editável no assistente.
- Guia do site: `site/src/content/docs/{pt-br,en}/guides/nextjs.md` (já no menu lateral).
- Revisão (Opus) corrigida: leitura de arquivos do repositório sem seguir link e com limite (nada do conteúdo vai ao log); `.env*` fora do build e `.env` gravado pelo painel apagado antes dele; id do cache de dependências imprevisível por projeto e impressão do segredo em HMAC; código da imagem final de root (só `.next/cache` gravável); HEALTHCHECK sem seguir redirecionamento; rollback (o container antigo fica parado até o novo passar no health check; se falhar, é religado; a poda só roda depois); heap documentado como por processo. Imagens dos projetos NÃO são varridas por Trivy (só a do painel no CI): item no ROADMAP.
- Validar também com Docker real: `docker ps -a --filter name=paas-demo-app` durante um deploy que falha (por exemplo, app que não sobe) deve mostrar o antigo religado e o site respondendo; `docker builder du` deve mostrar o cache com id `paas-demo-<pm>-<32 hex>`; `docker exec paas-demo-app sh -c 'touch /app/server.js'` deve falhar (somente leitura) e `touch /app/.next/cache/x` funcionar; um `.env` com segredo no repositório não pode aparecer em `docker run --rm --entrypoint sh paas-demo:latest -c 'ls -a /app'`.
- **Falta validar com Docker real** (nenhum teste automático roda Docker). Com um app de exemplo (`pnpm dlx create-next-app@15 demo --ts --app --no-tailwind --no-eslint --no-src-dir --import-alias "@/*" --use-pnpm --yes`, usando `process.env.NEXT_PUBLIC_DEMO` numa página e `output: "standalone"` no `next.config.ts`), criado como projeto no painel de desenvolvimento, com as Variáveis `NEXT_PUBLIC_DEMO=ola-publico` e `SEGREDO_DEMO=valor-secreto-123`, depois do deploy:
  - `docker inspect paas-demo-app --format '{{.Config.User}} {{.HostConfig.CapDrop}} {{.HostConfig.PortBindings}} {{len .Mounts}}'` deve mostrar `node`, `ALL`, `map[]` e `0`;
  - `docker exec paas-demo-app id` deve mostrar `uid=1000(node)`;
  - `docker ps --filter name=paas-demo-app --format '{{.Ports}}'` deve vir vazio e `docker inspect paas-demo-app --format '{{.State.Health.Status}}'` deve chegar a `healthy`;
  - `docker history --no-trunc paas-demo:latest | grep -c valor-secreto-123` deve dar `0`;
  - `docker run --rm --entrypoint sh paas-demo:latest -c 'grep -rl ola-publico .next/static | head -1'` deve achar um arquivo (NEXT_PUBLIC no bundle);
  - mudar `NEXT_PUBLIC_DEMO` para `novo-valor` e fazer deploy de novo: o mesmo `grep` com `novo-valor` deve achar (o cache não deixa o valor velho);
  - `docker image ls paas-demo --format '{{.Size}}'` em standalone deve ficar na casa de dezenas de MB;
  - repetir sem `output: "standalone"` (`next start`), com `--use-npm` e com `--use-yarn`, e sem lockfile (aviso no log);
  - segundo deploy sem mudar dependências deve ser bem mais rápido (cache), e `docker builder du` mostra o cache do projeto;
  - em VM de 1 GB sem swap, o deploy deve terminar com "O build ficou sem memória"; depois de `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile` o deploy seguinte passa;
  - `docker builder prune --filter until=168h` deve rodar sem erro na versão do Docker da VPS (a poda automática ignora falhas, mas convém ver que o filtro existe).
  Pré-requisito: Docker com BuildKit (versão 23 ou mais nova), para `--mount=type=cache` e `--mount=type=secret`.

## Atualização de 24/10/2026 — aba Logs do projeto (subagente, worktree isolado)
- Nova aba **Logs** em `/projects/:id/logs`: linhas dos containers do projeto (stdout/stderr com horário) e estado de cada serviço, pelo painel e sem SSH. Rota `GET /api/projects/:id/logs` (serviço, `tail` 1 a 2000 com padrão 200, `since` 15m/1h/24h), lida pela Docker Engine API no socket (quadros stdout/stderr), polling simples na tela (ligado, 5/10/30/60 s).
- Só containers do projeto (mesma identidade de `container-identity.ts`); serviço fora do projeto = 404, formato ruim = 400. Limites de bytes (8 MiB), tempo (10 s), serviços (40) e resposta (1.000.000 caracteres).
- Segredos: máscara em melhor esforço dos valores das variáveis (≥ 8 caracteres) e de padrões (Bearer/Basic, senha em URL, `password=`, `tws_pat_`). Sem conseguir ler as variáveis, o servidor responde 503 e não lê log nenhum.
- Token: rota `read` + `project` nas duas tabelas; fora do alcance = 404 idêntico. Sem auditoria da leitura (padrão do painel: audita mudança e revelação, não consulta).
- Detalhes em `projetos/logs.json`. Falta validar com Docker real (quadros, TTY, volume de log) e na VPS. Sem push.

## Atualização de 22/10/2026 — domínio com e sem www
- Ao conectar um domínio, o painel orienta o nome digitado **e o par** (apex <-> www): tipo, nome como se escreve no provedor (`@`/`www`), valor, copiar, pt-BR e en, e o que acontece se só um apontar. O par só **redireciona (308)** para o digitado (um endereço só: SEO e cookies).
- **Verificar DNS** confere cada nome à parte (aponta / sem registro / outro lugar / Cloudflare laranja / DNS mudo). Par que falha é aviso, nunca bloqueia o principal.
- O Caddy só ganha o bloco do par quando o DNS dele já aponta (sem falha de ACME nem gasto do limite do Let's Encrypt); o painel reconfere a cada 10 min. Nunca toma nome de outro projeto, do painel (inclusive o cadastrado aguardando DNS) nem do servidor de e-mail/webmail; sufixo incerto mostra o nome completo no guia; o status só vira "redirecionando" depois de o Caddy aplicar. Padrão ligado; desliga por domínio (`Project.pairOff`).
- Detalhes em `dominios/index.json` e `dominios/verificar.json`. Falta validar com DNS e ACME reais (nada foi feito contra a VPS).

## Atualização de 15/10/2026 — branch `feat/fuso-conferir-backup` (subagente, worktree isolado)
- **Configurações → Fuso horário**: mostra o fuso e a hora da VPS e troca o fuso pelo host bridge (comando novo na allowlist, auditado). Vale na hora para o painel e para a agenda dos backups. Os projetos marcados reiniciam com o fuso novo.
- O fuso é lido pelo host bridge e guardado em `data/timezone.json`. A montagem `/host/etc/localtime`, que ficava presa no fuso antigo, virou só reserva.
- Fuso por projeto: "Padrão da imagem", "Igual ao da VPS" ou um fuso específico. O TZ entra no deploy sem passar por cima do TZ que o projeto já define. O botão "Reiniciar com o fuso novo" recria os containers sem build. A tela avisa quando a imagem não tem tzdata.
- O assistente de instalação mostra o fuso detectado e deixa trocar sem travar.
- **Conferir backups**: um backup, todos de um item ou todos. A cópia da VPS passa pelo `7zz t`. A externa é baixada e comparada (tamanho e SHA-256) antes do `7zz t`. Se a senha guardada não abrir, pede a senha da época. O resultado fica ao lado do backup, e uma falha avisa por `backup_failed`.
- Selo da cópia externa ao lado do "Concluído" na lista de backups.
- Detalhes: `fuso/`, `backups/conferir.json` e `_RELATORIO-fuso-conferir-backup.md`, com o que foi testado de verdade e o passo a passo na VPS.
- Falta validar a troca do fuso numa VPS real (systemd e nsenter) e com o R2 real. Sem push nem PR.

## Atualização de 14/10/2026 — branch `feat/backups` (subagente, worktree isolado)
- Fase 1 dos backups: **Configurações → Backups**, aba **Backups** do projeto, "Fazer backup: Sim/Não" na criação e passo 6 do roteiro ("Backups fora da VPS").
- Entram no backup: bancos detectados pela imagem (dump dentro do container), volumes e pastas escolhidos, o painel (`data/` sem as cópias) e o e-mail (Stalwart parado por instantes e webmail).
- Formato `.7z` com o `7zz` da imagem. A senha vai pela entrada padrão, nunca por argumento.
- Onde fica: cópia na VPS sempre, sem senha. Cópia externa S3 (R2 em destaque) cifrada com AES-256 e `-mhe=on`. Ela é baixada de volta e conferida antes de a retenção apagar as antigas.
- Restauração por item, restauração do painel em duas fases (troca na subida), `scripts/restaurar-painel.sh` por SSH e o fluxo "Restaurar de outro servidor".
- Avisos novos: backup falhou, backup externo atrasado, lembrete trimestral da senha.
- Serviço no escopo raiz (`app.ts`), ganchos no deploy. O fuso da VPS é lido de `/host/etc/localtime`.
- Detalhes: `backups/` e `_RELATORIO-backups.md`, com o que foi testado de verdade, o passo a passo na VPS e o da VPS nova.
- Falta validar com R2, Stalwart, MongoDB e MySQL reais, e o painel inteiro no ar. Google Drive fica para a fase 2. Sem push nem PR.

## Atualização de 07/10/2026 — branch `feat/notificacoes` (subagente, worktree isolado)
- Item 4 da ordem combinada: **Configurações → Notificações** com Telegram (robô do @BotFather, Conectar depois do /start, Enviar teste) e e-mail (pelo servidor de e-mail do painel, postmaster@ do domínio com DNS conferido).
- Avisa: alertas novos (segurança, blacklist, certificado manual), deploy que falhou e voltou, certificado automático com problema, disco acima de 90% e painel iniciado (desligado por padrão).
- Proteções: agrupamento de 10 min, até 20 avisos por hora por canal e novas tentativas com recuo. O token fica cifrado e as mensagens não levam IP nem o detalhe do alerta.
- Serviço no escopo raiz (`app.ts`), ligado por ganchos (`AlertsService.onCreated`, `onDeployFinished`).
- O passo 5 do roteiro deixou de ser "em breve".
- Detalhes: `notificacoes/` e `_RELATORIO-notificacoes.md`, com o passo a passo na VPS. Falta validar com o Telegram e o Stalwart reais.
- Não feito: o código por e-mail para recomeçar o setup. Sem push nem PR.

## Atualização de 07/10/2026 — branch `feat/dominio-painel` (subagente, worktree isolado)
- Item 3 da ordem combinada: **Configurações → Domínio do painel**.
  - Fluxo: registro A → Verificar DNS (DNS público) → os dois endereços no proxy → certificado (cartão da página Certificados) → "Abrir o painel pelo endereço novo" (entrar de novo).
  - "Desativar o acesso pelo IP" só aberto pelo domínio novo, com certificado válido e o domínio digitado; "Reativar" na tela.
  - Volta por SSH: `scripts/reativar-acesso-ip.sh`.
  - A escolha fica em `data/panel-domain.json` e vale depois de reiniciar.
- O passo 3 do roteiro deixou de ser "em breve". No modo túnel, a tela explica como mudar para HTTPS.
- Detalhes: `configuracoes/dominio-do-painel.json` e `_RELATORIO-dominio-painel.md`, com o passo a passo na VPS.
- Falta validar na VPS real (ACME com o domínio, script com Docker de verdade). Sem push nem PR.

## Atualização de 04/10/2026 — branch `feat/variaveis-senha-webmail-nome` (subagente, worktree isolado)
- Pedidos do dono depois de validar na VPS:
  - **Variáveis: ver qualquer valor, inclusive a senha da caixa.** Decisão nova; antes a senha nunca aparecia.
    - O olho e "Mostrar valores" buscam a senha (SMTP_PASS e as ligadas a ela) em `GET /api/projects/:id/env/provided/:name`.
    - A listagem continua sem ela.
    - Limite de 30 por minuto por projeto; a Auditoria registra `project.env_revealed`, só com o nome.
    - A criação de caixa não mudou: a senha gerada aparece uma vez.
  - **Webmail com nome de exibição:** a caixa do projeto entra no Roundcube com o nome do e-mail do projeto.
    - Plugin próprio `paas_identity` (hooks `user_create` e `login_after`) lê `paas-identities.json`.
    - Só preenche nome vazio; nunca sobrescreve o que a pessoa escolheu.
    - Validado no Roundcube e no Stalwart reais: o e-mail chegou com `From: Nome <endereço>`.
- Detalhes: `email/ligar-variaveis-email-projeto.json`, `projetos/conceito-pagina-do-projeto.json`, `email/webmail.json` e a seção nova do `_RELATORIO-webmail.md` (com o passo a passo na VPS).
- Sem push nem PR: o agente principal decide.

## Atualização de 04/10/2026 — branch `feat/webmail` (subagente, worktree isolado)
- Pedido do dono: webmail para ler, responder e enviar e-mail das caixas pelo navegador.
- O que entrou:
  - **Roundcube 1.7.5** (PHP 8.4.27, desde 22/10/2026; o painel recria o container sozinho quando a imagem fixada muda), com a imagem fixada por tag e digest, no container `paas-webmail`: fica na `paas-net`, sem porta publicada, e fala só com o `paas-stalwart` (IMAP 993 e SMTP 465, conferindo o certificado pelo nome).
  - **Card "Webmail"** na página E-mail (ativar/desativar) e botão **"Abrir webmail"** em cada caixa, com o usuário preenchido.
  - **`https://mail.<domínio>/`** abre o webmail quando ele está ativado; o certificado continua sendo emitido pelo mesmo bloco do Caddy.
  - **Defesa contra senha errada:**
    - o IP do webmail fica isento no bloqueio automático do Stalwart: sem isso, 100 erros/dia derrubariam o webmail de todos para sempre (conferido no real);
    - o painel bloqueia no Caddy o IP real de quem erra 10 vezes em 10 min, por 1 h.
- Detalhes, fontes da escolha, testes e passo a passo na VPS: `_RELATORIO-webmail.md`. Comportamento: `email/webmail.json`.
- Sem push nem PR: o agente principal decide.

## Atualização de 04/10/2026 — branch `feat/envios` (subagente, worktree isolado)
- Pedido do dono: um painel para acompanhar o que o servidor de e-mail faz.
- O que entrou: página **Envios** (`/mail/envios`, link no menu depois de E-mail) com
  fila (Tentar agora / Cancelar), histórico, volume de 14 dias, reputação e nota.
- **Blacklist resolvida**: nunca rodava porque o gancho ficava no plugin do Monitoramento,
  que não enxerga o serviço de e-mail (plugins isolados no Fastify; o erro era engolido).
  Agora roda uma vez por dia e no botão, dentro do plugin de e-mail, com ponto de teste
  (nunca "limpo" sem resposta) e chave DQS da Spamhaus.
- Histórico vem do registro do container (`docker logs` a cada 5 min), só metadados, 30
  dias em `data/mail/envios/`.
- Achado: no Stalwart 0.11.8, "tentar agora" encurta o prazo para 10 s — é a última
  tentativa. A tela avisa.
- Detalhes, decisões e como validar na VPS: `_RELATORIO-envios.md` e `email/envios.json`.
- Sem push nem PR. Falta um link "Ver envios" na página E-mail (arquivo do agente do webmail).

## Atualização de 03/10/2026 — branch `feat/portas` (subagente, worktree isolado)
- Pedido do dono depois de colocar o cassino no ar: ver e trocar as portas dos containers pelo painel.
- O que entrou:
  - **Botão "Portas"** no cartão Containers da Visão geral. O modal tem duas abas:
    - **Este projeto:** portas internas, publicadas e a entrada HTTP;
    - **Todos os projetos:** tabela ordenável, com busca e conflitos marcados; no celular, lista.
  - **Trocar a porta do servidor** (só compose): porta nova, 127.0.0.1 ou 0.0.0.0, remover a publicação ou voltar ao compose.
    - Vale no próximo deploy, pelo `ports: !override`.
    - A Auditoria registra cada troca.
    - Os guardrails usam a lista com as trocas: banco sem publicação não bloqueia mais.
- Detalhes, decisões e o que validar na VPS: `_RELATORIO-portas.md`.
- Sem push nem PR: o agente principal decide.

## Atualização de 03/10/2026 — branch `feat/compose-servicos` (subagente, worktree isolado)
- Contexto: o primeiro deploy do cassino falhou com "wallet is unhealthy", e o log do painel não mostrava o motivo.
- O que entrou:
  - **"Por que falhou" no log:** fim do log e healthcheck de cada serviço com problema; a mensagem final diz qual serviço falhou.
  - **Todos os serviços do compose:** no assistente e na Visão geral, com o estado de cada container e a explicação do network_mode ("o caddy atende dentro do wallet, por isso a entrada é wallet:80").
  - **Entrada HTTP:** escolha do serviço e da porta, validada no servidor.
  - **Texto vermelho que piscava acima do menu do projeto:** era o erro da consulta periódica; agora é um aviso âmbar estável.
- Detalhes, decisões e o que validar na VPS: `_RELATORIO-compose-servicos.md`.
- Sem push nem PR: o agente principal decide.

## Atualização de 02/10/2026 (leia antes do resto)

### Onde paramos
- **Mesclado até o PR #66.** E-mail do servidor validado na VPS real:
  - o certificado de `mail.<domínio>` foi emitido pelo Caddy;
  - o e-mail de teste foi entregue ao Gmail (caiu no Spam no 1º envio, o esperado para servidor novo);
  - o PTR está azul, com o nome genérico do provedor voltando para o IP.
- **O que entrou:**
  - **#63:** roteiro compacto. Aberto só no 1º acesso; depois, números 1 a 5 e a orientação do passo atual.
  - **#64:** PTR em três níveis (verde, azul, amarelo) e botão "Enviar e-mail de teste", que acompanha a fila e o aviso de entrega.
  - **#65:**
    - página **Certificados**: lista única, motivo da falha lido do log do Caddy, "Tentar emitir agora" e certificado próprio com alertas de vencimento;
    - caixas de e-mail sem senha visível: a pessoa define a senha e, se esquecer, troca;
    - página do domínio abrindo em Caixas e conferindo o DNS ao abrir.
  - **#66:**
    - PTR sem falso alarme quando o DNS só demora (tenta de novo; sem resposta, fica "pendente");
    - e-mail de teste em modal, a partir de qualquer caixa ("Testar envio", e no aviso de senha trocada);
    - aba Caixas antes de Checklist DNS.
- **Página Certificados:** o dono viu a página, mas ainda não testou "Tentar emitir agora" nem o certificado próprio.
- **Regra nova:** antes de abrir PR, rodar `pnpm -r --workspace-concurrency=1 --no-bail run test:coverage`. O CI reprova por cobertura mínima de ramos (mailer 98%, deploy 95%…), e isso já derrubou o #65 duas vezes.
- **Post no X sobre o e-mail:** rascunho em `~/projects/social/projetos/tws-panel/post-email.md` (fora do repositório). O dono vai refazer os prints com 6/6 verde.

### Mais tarde em 02/10/2026 (PRs #67, #68 e o PR seguinte)
- **#67:** o projeto escolhe o endereço de envio e o nome de exibição.
- **#68:** cadastro do domínio do próprio projeto no card do e-mail do projeto.
- **PR seguinte**, a pedido do dono depois de testar na VPS:
  - **Caixa de verdade:** o endereço de envio é a própria caixa do projeto, com senha digitada ou gerada (mostrada uma única vez). Dá para trocar a senha pelo card do projeto e pela página do domínio.
  - **E-mail de teste:** sai com o nome de exibição.
  - **Variáveis:** cada valor tem botão de copiar (menos a senha). "Ligar às variáveis do projeto" guarda só o mapeamento e entrega o valor atual no deploy, usando o seletor com busca reutilizável (`components/ui/combobox.tsx`).
  - **Checklist DNS:** copiar por campo; MX separado em servidor e prioridade; aviso da nuvem cinza.
  - **PTR:** usa o DNS do sistema quando o público não responde.
  - **Certificado:** "Verificar agora" pede o certificado de `mail.<domínio>` sozinho.
  - Relatórios: `_RELATORIO-email-projeto-caixa.md` e `email/_PESQUISA-entregabilidade.md`.
- **Validado na VPS:**
  - "Tentar emitir agora" da página Certificados (o certificado de `mail.<domínio>` falhou porque o domínio foi cadastrado antes do registro A; o botão resolveu);
  - envio a partir do domínio do projeto (chega no Spam: falta reputação).
- **Entregabilidade, ordem sugerida ao dono** (aguardando o ok dele):
  1. Corrigir três defeitos baratos:
     - `Message-ID`/`Date` na submissão (`session.data.add-headers.*`);
     - `rua` do DMARC para uma caixa que existe;
     - um PTR único, igual ao HELO, e não um por domínio.
  2. Aquecimento guiado (`queue.limiter.outbound`), blacklist diária e nota de entregabilidade.
  3. Relay externo opcional.
  4. PTR genérico passa de "opcional" para "recomendado" (o Yahoo pede PTR não genérico).
- **Pendências novas:**
  - o teste do terminal com PTY real voltou a falhar de vez em quando no CI (passou ao rodar de novo);
  - a checagem de blacklist nunca roda, provavelmente porque as rotas de monitoramento não enxergam o serviço de e-mail (plugins isolados).

### Próximos passos (ordem combinada)
1. **Cassino:** ativar o e-mail do projeto, preencher as variáveis (KYC_MODO, PIX_*, SITE_HOST, CARTEIRA_HOST), conectar os domínios (SITE_HOST principal, CARTEIRA_HOST adicional) e fazer o deploy.
2. **Domínio do painel** (ainda não existe; passo 3 do roteiro, "em breve"):
   - DNS e verificação;
   - certificado;
   - botão "Desativar o acesso pelo IP", liberado só depois de abrir pelo domínio novo;
   - comando de SSH documentado para reverter.
3. **Notificações:** Telegram primeiro, depois e-mail.
4. **Backups.**
5. **Validação do zero:** reinstalar a VPS e seguir o README, cronometrando.
6. **Tradução EN/ES.**
- Pendências antigas: a checagem de blacklist do e-mail nunca roda; a Fase 03 não usa `--profile mail`.

## Atualização de 01/10/2026 (leia antes do resto)

### Onde paramos
- **Tudo mesclado até o PR #61** (`main` = `dev` em conteúdo). Do #55 ao #61, nesta ordem:
  - **#55:** compose de verdade (variáveis no `.env`, portas 80/443, porta por domínio).
  - **#56:** o painel retira 80/443 de app comum; o primeiro deploy começa sozinho.
  - **#57:** variáveis do compose prontas para preencher; importar `.env`.
  - **#58:** os guardrails analisam o mesmo compose que o deploy usa.
  - **#59:** deploy barrado por variável faltando; Visão geral, Deploys e Variáveis redesenhados; botões com cor.
  - **#60:** todo projeto entra no proxy; site publicado não some quando um redeploy falha.
  - **#61:** páginas "Site em manutenção" e "temporariamente indisponível" com visual amigável, recarregando a cada 60 s.
- **PR #62 (aberto, CI verde):** junta os dois branches feitos por subagentes em worktrees isolados, já revisados e testados na `dev`:
  - `feat/primeiros-passos`: roteiro "Deixe o painel pronto" no Dashboard (`_RELATORIO-primeiros-passos.md`); o aviso de 2FA some enquanto o roteiro está na tela.
  - `feat/email-tls`: certificado de verdade para `mail.<domínio>` (o Caddy emite e o painel copia para o Stalwart), `SMTP_HOST=mail.<domínio>`, estado do certificado e aviso de MX na página E-mail (`_RELATORIO-email-tls.md`, com o passo a passo na VPS).
  - Mais: a porta 8080 do Stalwart passa a ser publicada só em 127.0.0.1.
  - Os worktrees foram removidos depois do push.
- **Falta validar na VPS:** emissão real do certificado de `mail.<domínio>`, reinício único do Stalwart, porta 25 de saída, DNS reverso e envio do cassino.

### Ordem combinada com o dono do produto
1. **E-mail do servidor funcionando** (no PR #62; falta validar na VPS), ANTES de voltar ao cassino.
2. **Primeiros passos no Dashboard** (no PR #62):
   - no primeiro acesso, aberto com todos os passos;
   - depois de começar, compacto, mostrando só o próximo passo, com botão para ver todos num modal;
   - cada passo com "Como fazer";
   - passos opcionais com "Não vou usar".
   Ordem dos passos: proteções da VPS → 2FA → domínio do painel → e-mail do servidor → notificações.
3. **Domínio do painel** (ainda não existe), em Configurações → Domínio do painel:
   - DNS e verificação;
   - certificado;
   - botão "Desativar o acesso pelo IP", liberado só depois de abrir o painel pelo domínio novo, para não trancar ninguém fora;
   - comando de SSH documentado para reverter.
   Observação: o `…sslip.io` NÃO é o túnel; é o acesso HTTPS pelo IP.
4. **Notificações:** Telegram primeiro (bot do @BotFather, botão "Enviar teste"); depois e-mail. A pessoa escolhe um, outro ou ambos. Também destrava o "código por e-mail" para recomeçar o setup.
5. **Backups:** depois (decisão do dono). Hoje NÃO existe backup de projetos.
- **Login continua senha + código (2FA).** O dono concordou em não fazer login só com código, que viraria um fator. Ideias para depois: "lembrar este navegador por 30 dias" e passkey.

### Cassino (projeto real do dono, primeiro compose grande)
- Domínio principal conectado; o deploy ainda não passou.
- Faltavam: `KYC_MODO`, `PIX_CHAVE`, `PIX_CIDADE`, `PIX_NOME`, `SITE_HOST`, `CARTEIRA_HOST`, `SMTP_HOST` e `MAIL_FROM`. Estas duas o painel fornece com o E-mail do projeto ativo.
- O cassino exige TLS e confere o certificado (nodemailer com `requireTLS`). Por isso o e-mail do painel precisa da correção do branch `feat/email-tls`.
- No modo demonstração, ele recusa SMTP vazio, local ou Mailpit; `paas-stalwart` passa.
- Próximo passo com o dono, depois do e-mail:
  1. E-mail do servidor com um SUBDOMÍNIO dedicado. NÃO usar o domínio raiz da empresa: o MX desviaria o e-mail da empresa. Ainda não sabemos onde fica o e-mail do domínio da empresa; perguntado, sem resposta.
  2. E-mail do projeto.
  3. Variáveis restantes.
  4. Domínios: `SITE_HOST` como principal e `CARTEIRA_HOST` como adicional, porta em branco.
  5. Deploy.

### Preferências do dono do produto, confirmadas nesta sessão
- **Instrução completa:** caminho exato, comandos na ordem, onde clicar e como conferir.
- **Atualizar o painel na VPS** com UMA linha: `cd /opt/tws-panel && sudo git pull && sudo git log --oneline -1 && sudo docker compose up -d --build`. O `sudo git pull` é necessário porque arquivos do `.git` ficaram do root.
- **Visual:** simples, responsivo e com cor nos botões (Abrir site azul, Iniciar verde, Parar vermelho, Deploy violeta).
- **Projeto de postagens:** separado, em `~/projects/social` (pesquisa, guias de boas práticas para X e Instagram, `CLAUDE.md` do agente de conteúdo, rascunho do post de continuação sobre o TWS Panel e o devLink). Sem commit; o dono decide. Alerta: o endereço `…sslip.io` contém o IP da VPS e precisa ser borrado em prints e vídeos.

## Atualização de 29/09/2026 (leia antes do resto)

- **PRs #31, #32 e #33** depois do documento abaixo:
  - **#31** — o pedido de senha era cancelado no mesmo instante: o compose repassava
    `PAAS_TERMINAL_SUDO_PASSWORD_TIMEOUT_MS` vazia e `Number("")` é 0. Agora: variável
    numérica vazia vale o padrão; o painel **não desiste sozinho** da senha (padrão sem
    prazo); campo de senha no alerta com Enviar/Cancelar; alerta sobrevive à queda do WS;
    digitação com o WS caído é avisada; tela limpa ao reconectar.
  - **#32** — Fase 01 só trava o root com chave **e** senha do usuário (usuário criado
    pela fase nasce sem senha → ficaria sem sudo); a varredura informa senha/chaves de
    cada usuário com sudo; card da Fase 01 curto, com quadro "o que vai acontecer".
  - **#33** — Fase 02 com `AllowTcpForwarding local` (com `no` o túnel do README deixava
    de abrir após a fase — visto em campo) e `TCPKeepAlive no`; o wizard passa `--user`
    à Fase 02; **nova Fase 07** (recomendações do Lynis seguras de automatizar — lista do
    que fica de fora e por quê em `seguranca/conceito-fases.json`); checks de Docker
    reconhecem os containers do próprio painel como risco aceito; alerta de teste de
    acesso usa o IP da VPS (não `localhost`) e não diz mais "criou o usuário";
    aviso de que a nota final do Lynis leva 2–5 min.
- **Validação real:** hardening 00–06 aplicado na VPS de teste; Lynis 76. O operador
  corrigiu à mão o túnel (`AllowTcpForwarding local` em `10-local-override.conf`).
  Próximo passo dele: **reinstalar o sistema** e refazer tudo pelo README, agora com a
  Fase 07, cronometrando.
- **Resolvido (29/09):** a falha intermitente do teste do PTY real. O erro de tempo
  esgotado passou a mostrar o fim da tela, e a primeira falha seguinte revelou a causa:
  o PTY quebrava a leitura logo depois do PRIMEIRO ":" do marcador de fim
  ("a b :" | "::PAAS_EXIT…"); a regra que segura um possível marcador exigia "::", o ":"
  ia para a tela e o resto não casava. Nos comandos de captura, um ":" solto no fim do
  pedaço agora também é segurado. Era um defeito real (podia travar um check numa VPS).
- **Acesso por HTTPS decidido e implementado (PR #34):** o instalador entrega
  `https://<ip-com-hífens>.sslip.io` (Let's Encrypt, sem túnel, sem pergunta de porta nem
  de chave SSH); o painel escuta só em 127.0.0.1; o Caddy sobe no boot com o bloco fixo
  do painel e conecta o `tws-panel` à `paas-net`; o WS do terminal recusa outra origem;
  `--acesso=tunel` mantém o fluxo antigo. Validado com smoke test Docker real (sem ACME).
  O aviso "main vs dev" saiu do README (é processo de quem publica, não do usuário).
  **Falta a validação real na VPS** (ACME de verdade, portas 80/443 da Contabo).
  Próximo recomendado: 2FA no login, já que o painel passa a estar na internet.
- **"Andando em círculo" (29/09, depois do PR #43):** duas causas na tela de hardening.
  (1) Ao reaplicar a partir do resultado salvo, a tela final mostrava a nota antiga
  ("Hoje 86", "Última aplicação 86 → 86") enquanto o Lynis ainda media — agora mostra
  "medindo…" até a nota nova chegar. (2) Uma fase aplicada com sucesso cujo item
  continuava reprovado (caso da Contabo, `50-cloud-init.conf` vencendo o drop-in) era
  recomendada de novo como se fosse nova — agora o card da fase avisa que ela já foi
  aplicada, em que data, qual item continua reprovado e que reaplicar provavelmente não
  resolve. Ainda em aberto: por que o Lynis deu 80 numa medição e 86 em outra (pedir a
  lista de sugestões do relatório ao operador).
- **Lynis 86 com tudo aprovado (29/09):** as 16 sugestões restantes estão na lista "não
  automatizar" aprovada, exceto duas que viraram correção: (1) cópias de segurança de
  arquivos em pastas `*.d` saem da pasta (o apt mostrava "N: Ignoring file
  '20auto-upgrades.paas-backup…'" em todo comando) e vão para `/var/backups/paas`; as antigas
  são movidas na próxima execução real de qualquer fase; (2) com o painel em HTTPS a Fase 02
  grava `AllowTcpForwarding no` (SSH-7408); no modo túnel continua `local`, e o instalador
  com `--acesso=tunel` reabre o túnel (`02-ssh.sh --reopen-tunnel`). Na VPS de teste, que já
  tinha a Fase 02 aplicada, o operador reaplica a fase pelo modo manual.
- **30/09 — ajustes rápidos:** o desfazer da Fase 02 só devolve o `99-paas-hardening.conf`
  antigo quando foi a própria aplicação que o removeu (marca em
  `/etc/paas/ssh-old-dropin-removed`; a reversão automática recriava o arquivo a partir de
  cópias antigas — visto em campo); aviso "nova versão do painel — Recarregar" (a página
  compara o arquivo principal carregado com o que o servidor entrega; confere a cada 60 s e
  ao voltar à aba); `ip-address` 10.7.2 (Dependabot); "O que isso faz?" recolhido junto do
  "Simular todas as fases pendentes"; botão "Aplicar de verdade" verde com "Agora a VPS será
  alterada de verdade". O item "como instalar a minha chave" da Fase 01 já estava coberto
  (o card diz que sem chave nada muda e a chave colada é instalada pela própria fase).
  Ordem combinada a seguir: 2FA no login → configurações do painel e dos projetos →
  validação do zero → tradução por último.
- **30/09 — verificação em duas etapas (2FA) no login:** TOTP próprio (node:crypto, vetores da
  RFC 6238), segredo cifrado em `data/two-factor-key`, 10 códigos de recuperação de uso único,
  anti-reuso, desativar exige senha + código, aviso no Dashboard enquanto desligada, e
  `scripts/reset-2fa.sh` para quem perdeu celular e códigos. Detalhes em
  `autenticacao/verificacao-duas-etapas.json`. Falta validar na VPS real com um app de verdade.
- **30/09 — 2FA validado na VPS real** (Google Authenticator; login de novo pediu o código).
- **30/09 — página Configurações** (`/settings`): menu no topo, na lateral esquerda ou na
  direita, salvo na conta (chega com `/api/auth/me`); celular sempre no topo, com botão
  "Menu"; caixa do menu do usuário ganhou fundo (faltava a cor `popover` no tema). Próximo
  combinado: configurações do painel e dos projetos. Ver `configuracoes/index.json`.
- **30/09 — Configurações com menu próprio:** Perfil (nome de exibição, e-mail, usuário de
  login com senha), Segurança (senha + 2FA na página), Aparência, Notificações (frequência da
  verificação automática; aviso fora do painel ainda não existe — decisão pendente: canal
  e-mail/Telegram/outro). Cada seção com URL própria (`/settings/...`).
- **30/09 — Novo Projeto:** tipo "site estático" (HTML puro; publicado sem .git/.env);
  guia "Como gerar o token" (GitHub completo; outros, orientação geral); "Enviar do meu
  computador" (janela de pasta; arquivos sobem para `_uploads/` da pasta de projetos);
  "Pasta que já está no servidor" com navegador preso à pasta de projetos; caminhos locais
  fora dela passam a ser recusados. Para testar deploy: `docker/welcome-to-docker` (Dockerfile)
  e, com o tipo estático, o `devlinks` do dono do produto. Pendentes pedidos em 30/09:
  conectar a conta do GitHub para listar repositórios; Setup concluído com "recomeçar do zero"
  protegido por senha + 2FA (ou código por e-mail, que depende de configurar envio de e-mail).
- **30/09 — conta do GitHub e Setup concluído:** Configurações → Integrações conecta a conta
  do GitHub (token somente leitura; clássico com escrita é recusado) e o Novo Projeto lista os
  repositórios. `/setup` com sessão mostra "Configuração inicial concluída": saúde (`/health`) e
  proteções sem apagar nada; "Recomeçar do zero" com orientação + senha + código do 2FA +
  digitar "recomeçar" (POST /api/settings/restart-setup; gera token de setup novo). Sem 2FA, o
  painel recusa e aponta o `reset-setup.sh --full` — o código por e-mail pedido pelo dono do
  produto depende de o painel enviar e-mail, que ainda não existe (decisão do canal pendente).
- **30/09 — domínio no Novo Projeto:** endereço automático `<projeto>.<ip>.sslip.io` (HTTPS na
  hora) ou domínio próprio com o registro A exato; "Verificar DNS" corrigido (usava o IP do
  container). "Enviar do meu computador" removido a pedido (foco em git). Próximo combinado:
  Configurações → Domínios (domínio próprio para o painel e domínio-base dos projetos com DNS
  curinga, para subdomínio automático por projeto).
- **30/09 — primeiro deploy real (devLink, site estático):** o site subiu, mas o deploy saiu
  "falhou": o health check batia em 127.0.0.1:80 de DENTRO do container do painel. Agora usa a
  rede interna (paas-caddy:80/443, `EngineContext.panelContainer`) e confere também o HTTPS com o
  certificado de verdade (avisa sem falhar se ainda estiver sendo emitido). Link do projeto em
  https; botão "Abrir site"; card "HTTPS automático"; deploy que falhou não aparece mais como
  "nenhum deploy publicado".
- **30/09 — página do projeto com menu próprio:** Visão geral, Deploys, Domínios (vários por
  projeto: conectar/tornar principal/remover, valendo na hora), Git (token some com repositório
  público), Variáveis (cifradas, injetadas no deploy), E-mail, Configurações. Páginas de erro
  neutras no Caddy (projeto parado; domínio não configurado). Ver
  `projetos/conceito-pagina-do-projeto.json`. Sugestão pendente: seção Logs (app rodando).
- **30/09 — repositório privado não clonava na VPS:** "cannot exec '/tmp/…/askpass.sh':
  Permission denied" — o /tmp do container do painel não executa (hardening). O token agora
  chega ao git por credential helper em linha (sem arquivo). Os testes de clone privado rodaram
  também num container com /tmp noexec. E a mensagem culpava o token (errado). Cloudflare: o
  guia de DNS pede a nuvem cinza, e o "Verificar DNS" reconhece os IPs da Cloudflare (nuvem
  laranja) e explica.
- **30/09 — compose de verdade (cassino):** Variáveis → .env do projeto; lista do que o compose
  exige; guardrail de 80/443; network_mode resolvido; porta por domínio; compose.paas.* com
  prioridade. O cassino ganha um compose.paas.yaml (PR no repositório dele) para rodar atrás do
  painel.
- **30/09 — portas 80/443 e primeiro deploy:** app comum que publica 80/443 deixa de ser
  bloqueado: o painel retira essas portas no `paas.override.yml` (`ports: !override`, testado
  com o docker compose real) sem mexer no repositório, e o guardrail vira aviso. Projeto com
  proxy HTTPS próprio (Caddy/Traefik) continua bloqueado, agora SEM a opção de forçar (falharia
  igual) — o caminho é o compose.paas.yaml. "Criar projeto" já dispara o primeiro deploy; se o
  compose exige variáveis sem valor, leva à seção Variáveis com o aviso.
- **30/09 — Variáveis:** cada variável do compose já aparece como linha para preencher
  (obrigatórias primeiro; sugerida vazia não é salva, vale o padrão). "Importar arquivo .env":
  lido no navegador (`apps/web/src/lib/dotenv.ts`), entra na lista e só é gravado ao salvar.
- **01/10 — guardrails no compose errado:** os guardrails tinham lista própria de arquivos
  compose (sem compose.paas.*) e bloqueavam o cassino pelo compose.prod.yaml. Lista única em
  `packages/deploy/src/compose-files.ts`; os guardrails recebem o arquivo da detecção do projeto;
  a Visão geral mostra o compose em uso.
- **01/10 — deploy do cassino falhou por variáveis:** o deploy rodava com 8 obrigatórias sem valor.
  Agora é recusado antes (422 missing_env com a lista), conta o e-mail do projeto como fornecedor
  de SMTP_*/MAIL_FROM e entende `${A:-${B:?}}`. Variáveis: mostrar/ocultar todas, copiar, apagar
  todas, lista com rolagem e rodapé fixo. Visão geral nova (status, deploy em andamento com log,
  domínios com certificado, e-mail, containers, código); Deploys = histórico + detalhe em janela;
  botões com cor. Projeto `~/projects/social` criado (pesquisa e rascunhos de posts; fora deste repo).
- **01/10 — domínio antes do primeiro deploy:** página "Site em manutenção" (com HTTPS) para
  projeto nunca publicado; site já publicado não some mais do proxy quando um redeploy falha.
- **01/10 — roteiro "Deixe o painel pronto" (branch `feat/primeiros-passos`):** cartão no
  Dashboard com proteções da VPS, 2FA, domínio do painel (em breve), e-mail do servidor
  (opcional) e notificações (em breve), cada um com status calculado do estado real
  (`GET /api/onboarding`); aberto no primeiro acesso, compacto depois, some quando tudo está
  resolvido e continua em Configurações → Primeiros passos. Ver
  `configuracoes/roteiro-primeiros-passos.json` e `_RELATORIO-primeiros-passos.md`.
- **IMPLEMENTADO (01/10, branch `feat/email-tls`) — e-mail do painel com app que confere
  certificado:** o Caddy emite o certificado de `mail.<domínio>` (bloco com página simples), o painel
  copia o par para o Stalwart e o renova (recarga sem reinício; reinício só quando aparece um nome
  novo), o Stalwart ganha o alias `mail.<domínio>` na paas-net e o painel injeta
  SMTP_HOST=`mail.<domínio>` (vale no próximo deploy). Página E-mail mostra o certificado (válido ou
  o que falta). Cadastro de domínio que já recebe e-mail em outro servidor exige confirmação e
  sugere `envio.<domínio>`. Validado localmente com Caddy e Stalwart reais (CA local do Caddy no
  lugar do Let's Encrypt) e nodemailer com requireTLS. **Falta validar na VPS** (ACME real,
  porta 25, PTR) — passo a passo em `_RELATORIO-email-tls.md`.
  Lição: o reload do Stalwart v0.11.8 (`/api/reload` e `/api/reload/certificate`) NÃO relê o
  `config.toml` local — só os arquivos das seções que já existiam; seção nova exige reinício.
  Lição 2: com o painel em container, `127.0.0.1:8080` nunca foi o Stalwart (era o próprio
  painel); a API agora vai por `paas-stalwart:8080` na paas-net.
- **ABERTO (01/10) — checagem de blacklist do e-mail nunca roda:** a rota do monitoramento agendado
  procura o serviço de e-mail, que não é visível para ela, e o erro some em silêncio (a checagem é
  tratada como opcional). Achado pelo subagente do roteiro de primeiros passos; não corrigido.
- **01/10 — porta 8080 do Stalwart só em 127.0.0.1** (antes ficava na internet, porque o Docker
  publica por cima do UFW). Vale para containers criados daqui em diante. Ainda ABERTO: alinhar a
  Fase 03 (`--profile mail` nunca é passado pelo painel).
- **ABERTO (30/09) — nova falha intermitente do teste do PTY real** (CI do PR #53, run
  36760343943; não reproduziu localmente em 6 execuções). Foi no AQUECIMENTO
  (`printf 'pronto'` de `abrirTerminalPronto`), não no comando testado. A tela terminou com
  `…echo ":::PAA\rAS_EXIT_<n>:$?"\r\n\rpronto:::PAAS_EXIT_<n>:0\r\n<prompt>`: o EXIT chegou
  mas ficou VISÍVEL (não casou/não havia waiter), e a linha do BEGIN não aparece (foi consumida).
  Hipóteses a verificar: saída chegando antes de o waiter existir; ou o eco da linha longa com
  quebra do readline (`\r`) confundindo o parse. Próximo passo: diagnóstico com os bytes crus das
  últimas linhas e o estado do waiter (capturing, pending) no erro de tempo esgotado.
- **PRÓXIMO ITEM COMBINADO — lembrar o dono do produto assim que a validação terminar:
  tradução para inglês e espanhol** (pedido de 29/09/2026, adiado de propósito porque o
  README ainda muda a cada rodada de teste). Escopo e ordem acordados:
  1. Interface do painel: i18n no React (textos das telas, alertas, wizard, erros) +
     mensagens do servidor exibidas ao usuário; seletor de idioma.
  2. Instalador e scripts (`install.sh`, `uninstall.sh`, `show-token.sh`, logs das 8
     fases): idioma escolhido na primeira pergunta do instalador.
  3. README por último (`README.en.md`, `README.es.md`, seletor no topo), já refletindo
     as telas traduzidas — traduzir tudo junto para o usuário estrangeiro não ficar
     perdido no meio do caminho.

---

## Onde tudo está

| | |
|---|---|
| Repositório | `github.com/kelvindk9w/tws-panel` |
| Branch de desenvolvimento | `dev` (default do repo) |
| Branch de instalação | `main` — protegida, só entra por Pull Request |
| Último PR mesclado | **#29** (squash) |
| PRs abertos | nenhum |
| Sincronização | `dev` e `main` com o **mesmo conteúdo** |

A `main` é o que o README manda clonar. O Passo 6 do README manda o operador
conferir `git diff --stat origin/main origin/dev` e esperar saída **vazia** —
então todo trabalho relevante na `dev` precisa ser promovido, senão quem segue o
README vê diferença e trava.

## Situação da validação real (VPS de teste)

O dono do produto está validando o painel **seguindo o README literalmente**,
numa VPS Contabo com Ubuntu 24.04.5 LTS, como um leigo faria. É daí que saiu
quase todo o trabalho desta sessão.

Estado da VPS no fim da sessão:

- Usuário `kelvin` (uid 1001) criado pelo Passo 3, com `sudo`. **Removido do grupo
  `docker`** (o instalador antigo o colocava lá — ver lições). Existe também um
  usuário `ubuntu` com sudo, vindo da imagem do provedor.
- Chave SSH `id_ed25519` instalada com `ssh-copy-id`.
- Painel **reinstalado do zero** com o instalador novo, respondendo:
  terminal `kelvin`, modo **`senha`**, porta da VPS **9001**, chave padrão.
  Projetos em `/opt/tws-projects`.
- Acesso pelo túnel: `ssh -L 9001:localhost:9001 kelvin@<ip>` e
  `http://localhost:9001/?token=<token>`.
- Wizard parado na etapa **Segurança**. A **Fase 00** precisa ser rodada de novo
  (a primeira execução morreu no meio — ver lições). O `full-upgrade` em si
  terminou no host; os passos seguintes da fase (unattended-upgrades,
  needrestart) não chegaram a rodar.
- Duas varreduras de segurança falharam por **tempo esgotado aguardando a senha
  do sudo**: o pedido não foi percebido. Corrigido no PR #28 (faixa fixa,
  contagem regressiva, título da aba).
- O usuário acrescentou uma linha `127.0.1.1 <hostname>` ao `/etc/hosts` por
  sugestão errada minha (o nome já estava lá). Redundante e inofensiva.
- No fim da sessão ele estava rodando
  `cd /opt/tws-panel && sudo git pull && sudo docker compose up -d --build`
  para pegar os PRs #28 e #29.

**Plano do usuário:** terminar esta rodada (hardening + admin + deploy), e só
então **reinstalar o sistema operacional** e refazer tudo do zero pelo README,
cronometrando, como validação final.

---

## O que foi feito nesta sessão (PRs #13 a #29)

### Instalação e README
- **#13** — README à prova de instalação real (erro de host key separado do
  reinício, `adduser`/`usermod` como par inseparável, reconectar depois do
  `usermod`, git já instalado pelo provedor). Correção da corrida na auditoria.
- **#20** — O instalador **para** antes de instalar se houver
  `/var/run/reboot-required`. Escolha da chave SSH virou regra objetiva
  (`id_ed25519` → `id_rsa` → gerar nova) e o comando sempre usa `-i`.
- **#21** — Instalador pergunta usuário do terminal, modo de execução como root e
  nome da chave local. Novo `scripts/uninstall.sh` (lista, pede para digitar
  `remover`, `--dry-run`, `--keep-repo`, diz o que **não** desfaz).
- **#22** — O instalador **não coloca mais ninguém no grupo `docker`**; se o
  usuário do terminal já estiver lá, explica e pergunta se remove.
- **#25 / #26 / #27** — Porta do painel: 4ª pergunta do instalador, confere se
  está livre na VPS e recusa 22/80/443/portas de e-mail. README ensina a conferir
  a porta livre **no computador do operador** (Linux/WSL, macOS, PowerShell)
  antes de instalar. O banner explica que o número do endereço é o da **esquerda**
  do túnel.

### Terminal ao vivo
- **#14** — Varredura detecta o usuário não-root do grupo sudo; Fase 01 vem
  preenchida e a chave SSH ficou opcional.
- **#15** — Botão "Abrir como `<usuário>`" (`su -`) nas sessões root.
- **#21** — Terminal abre com o usuário escolhido na instalação
  (`PAAS_TERMINAL_USER`) e dois modos (`PAAS_ROOT_MODE`):
  - `senha` (recomendado): `sudo` no próprio terminal, o operador digita a senha;
  - `segundo-plano`: comandos de root pelo host bridge, auditados, saída espelhada.
  O monitoramento agendado roda como root nos dois modos. Protocolo de controle
  no WebSocket (NUL + `paas-control:` + JSON) e `GET /api/terminal/info`.
- **#22** — O painel verifica a cada sessão se o usuário do terminal consegue
  escrever no socket do Docker (= root sem senha) e mostra aviso vermelho.
- **#23** — Aviso de conexão não protegida com saída pronta (comando do túnel e
  URL `localhost` montados); textos da chave pública e da simulação.
- **#28** — Pedido de senha impossível de perder: faixa fixa no topo, contagem
  regressiva (viaja como duração, não como instante), título da aba, prazo de
  5 → 2 min (`PAAS_TERMINAL_SUDO_PASSWORD_TIMEOUT_MS`), texto dizendo que a senha
  é do usuário do terminal, **não** do root.

### Hardening
- **#14** — Confirmação de acesso da Fase 01 passou a vir do marcador
  `:::PAAS_ROLLBACK_SCHEDULED`, emitido só quando uma reversão é de fato agendada.
- **#24** — As fases não derrubam mais o próprio canal:
  - Fase 00 segura (`apt-mark hold`) os pacotes que reiniciam o Docker e devolve o
    estado por `trap`; unattended-upgrades exclui o Docker.
  - `NEEDRESTART_MODE=l` em todas as fases.
  - Fase 05 preserva Docker instalado via snap e simula o `autoremove` antes.
  - **Execução destacada**: `setsid` + `flock` por fase + log/código de saída em
    arquivos de estado; o painel reataja e reconcilia após queda do canal ou
    reinício do próprio painel. Allowlist reconstrói o comando e compara byte a
    byte.

### Deploy e projetos
- **#15** — `git` instalado na imagem (o modo git **nunca** tinha funcionado) e
  erro de binário ausente com mensagem legível.
- **#16** — Repositório privado com credencial de leitura cifrada (AES-256-GCM,
  chave própria), entregue ao git por `GIT_ASKPASS` — nunca na URL nem no argv.
  Diretório dos projetos configurável (`PAAS_PROJECTS_DIR`, montado com o mesmo
  caminho dentro e fora do container).
- **#19** — Gravação em disco que falha não é mais confirmada (senha, sessões,
  credencial). Regra de banco exposto reconhece `"5432"`, `${VAR}:5432`, faixas,
  IPv6 e forma longa; lista de bancos unificada. Migração para o Vitest 4.
- **#21** — Caddy e Stalwart recebiam a configuração por bind mount de caminho
  que só existe dentro do container: **não funcionavam em nenhuma VPS**. Agora a
  config é gravada dentro dos containers com `docker cp`.

### Saúde e monitoramento
- **#20** — O monitoramento agendado **vigiava o container, não a VPS**
  (`HostRunner` local). Corrigido para o host bridge, com recoleta da linha de
  base antiga sem alertas falsos. Tela de saúde: todos os cards com selo, IP do
  container removido, reinicialização pendente, KVM reconhecido.

### CI e testes
- **#16** — Lacunas reais de cobertura fechadas em vez de baixar limites.
- **#19** — Vitest 4 com classificação trecho a trecho do que a nova régua passou
  a contar; só um limite recalibrado, com justificativa no config.
- **#29** — Teste do PTY real estabilizado: o `docker exec` devolve o stream antes
  de o shell existir; o teste agora espera prontidão antes de medir.

---

## Pendências — o que fazer a seguir

### Com o usuário, agora
1. Depois do `git pull` + `docker compose up -d --build`: **Revarrer** na etapa
   Segurança, digitar a senha do `kelvin` quando o pedido aparecer, e rodar a
   **Fase 00** de novo. Conferir no log os pacotes do Docker que ficaram de fora.
2. Fases 01–03 aplicadas de verdade: quando o painel pedir confirmação de acesso,
   **abrir uma janela SSH nova sem fechar a atual** e testar o login antes de
   confirmar (janela de 5 minutos, depois reverte sozinho).
3. Criar a conta admin, depois deploy de **repositório público** e só então de
   **privado** — para saber qual parte quebrou, se quebrar.
4. Ainda não recebi o print do pedido de senha que ele descreveu como "senha
   root" pelo IP. Com o #28 no ar, confirmar se o problema sumiu.

### Itens de interface pedidos e ainda não feitos
- Fase 01: deixar explícito que **sem chave o operador digita a senha quando
  necessário**, e botão "como instalar a minha chave" ao lado do "como gerar".
- Botão "O que isso faz?" expansível junto de "Simular todas as fases pendentes".
- Botão **verde** "Aplicar de verdade", com texto objetivo de que agora a VPS
  será alterada.

### Decisões pendentes do usuário
- **HTTPS com certificado próprio na instalação** (primeiro acesso pelo IP já
  criptografado, impressão digital no banner). Proposto, sem resposta.
- **Banco publicado só em loopback** (`127.0.0.1:5432:5432`) hoje é bloqueado.
  Opções: manter; rebaixar para aviso (recomendado); liberar.
- **Suporte ao Ubuntu 26.04**: rodada dedicada depois de o 24.04 estar validado.

### Limitações e riscos conhecidos
- ~~`/security/hardening` sem terminal~~ — RESOLVIDO em 29/09/2026: a página mostra o
  terminal, que conecta pela sessão de login (`TerminalPanel authMode="session"`).
- Logs de execução das fases (`/etc/paas/runs`) são legíveis por qualquer usuário
  local (`umask 022`, para o usuário do terminal acompanhar sem senha).
  Restringir ao usuário do terminal.
- O Docker ficou **sem atualização automática de segurança** (troca consciente
  para o painel não cair de madrugada). README e log da Fase 00 avisam.
- `alerts-service` ainda engole falha de gravação (os outros stores já não).
- O painel não exibe o diretório de projetos em uso.
- Achados antigos ainda abertos: Stalwart `v0.11.8` com CVE-2025-61600 (P1
  pós-lançamento); Trivy deixa passar HIGH; imagem de produção carrega
  devDependencies; `intervalMs` do monitor auditado sem o clamp.
- `global/threat-model.json` ainda descreve "terminal web com root" como risco
  aceito — precisa refletir os modos `senha`/`segundo-plano` e o risco do grupo
  `docker`.

### Divulgação
- Thread publicada no X (5 tweets, sem link do repositório). O próximo post
  combinado é a **continuação da história** (resultado da validação), não uma
  repetição. O link do repositório só entra depois da validação final.

---

## Lições desta sessão (evitar repetir)

- **O painel roda DENTRO de um container. Toda funcionalidade que toca o host
  precisa ser pensada dos dois lados.** Esta sessão achou quatro defeitos graves
  com a mesma raiz, nenhum pego por teste porque em desenvolvimento o painel roda
  direto no host:
  - bind mount de caminho do painel (`/data/...`) é resolvido pelo daemon **no
    host**, onde não existe — Caddy e Stalwart nunca funcionaram numa VPS;
  - `os.networkInterfaces()` mostra a rede do container, não a da VPS;
  - `HostRunner` (`bash -c` local) roda no container — o monitoramento vigiava o
    próprio painel;
  - qualquer coisa que reinicie o `dockerd` (upgrade do `docker-ce`, `needrestart`,
    remover snap do Docker) mata o PTY e o helper **no meio da fase**.
  Pergunta obrigatória em code review: *isto roda no container ou no host, e o
  caminho/processo existe dos dois lados?*
- **Grupo `docker` = root sem senha.** Qualquer proteção baseada em "o usuário não
  é root" é falsa se ele estiver no grupo. Verificar pela permissão real de
  escrita no socket, não pelo nome do grupo.
- **Teste de `sudo` precisa separar digitação de execução.** Medi `time sudo true`
  com a credencial fora do cache e atribuí à rede o tempo que era a pessoa
  digitando. Medir sempre com credencial em cache (`sudo -v` antes).
- **"Lento" pode ser "esperando por alguém".** Os 296 s do relato eram o timeout
  de senha, visível no log como `SudoElevationError reason:"timeout"`. Leia o log
  com o campo `host` de cada requisição antes de concluir onde algo aconteceu.
- **O túnel SSH tem duas portas.** `ssh -L <local>:localhost:<vps>` —
  `Address already in use` é o lado esquerdo (computador do operador);
  `Connection refused` é o direito; o navegador usa sempre o número da esquerda.
- **Não aceite de subagente uma redução de escopo que contraria pedido explícito
  do usuário.** O usuário pediu um comando para achar porta livre; o agente
  decidiu não publicar "porque não existe um igual nos três sistemas" e eu
  repassei. A resposta certa era publicar os três.
- **Verifique pessoalmente as afirmações de segurança dos subagentes** (onde o
  segredo trafega, allowlist, quoting). Em todas as vezes nesta sessão bateu,
  mas é a parte que não pode estar errada.
- **Remover uma trava de interface pode expor um defeito que ela escondia.** Ao
  tornar a chave opcional na Fase 01, apareceu que o executor decidia a
  confirmação de acesso pelo argumento, não pelo que o script fez.
- **Teste instável tem causa.** O do PTY real falhou três vezes; subir o timeout
  já tinha sido tentado. A causa (escrever antes de o shell existir) só apareceu
  olhando o fluxo cru. Não usar retry automático onde ele esconde o defeito que o
  teste existe para pegar.

## Detalhes que custaram tempo e vale saber de antemão

- **Todo PR `dev` → `main` nasce `CONFLICTING`** por causa do squash merge. O
  procedimento, sempre com verificação antes:
  1. `git fetch origin` e conferir que `git diff origin/dev origin/main` só tem,
     do lado da `main`, versões antigas do que a `dev` reescreveu (nenhum arquivo
     só na `main`: `git diff origin/dev origin/main --name-status | grep '^A'`
     vazio). Para JSON reformatado, comparar o conteúdo parseado, não linhas.
  2. `git merge -s ours origin/main -m "chore: reconcile with main after squash merge"`
  3. `git diff <commit anterior> HEAD --stat` **vazio** (a árvore não mudou).
  4. `PAAS_SKIP_PREPUSH=1 git push origin dev` e esperar a CI de novo.
- **Hook de pré-commit barra segredos em testes também.** Fixtures não podem
  parecer tokens reais (`github_pat_…`). A chave de exemplo oficial da AWS
  (`AKIAIOSFODNN7EXAMPLE`) está na allowlist como string exata; o cabeçalho de
  chave privada é montado por concatenação no teste.
- **Vitest 4:** mock de classe usado com `new` precisa de `function`, não arrow;
  a cobertura remapeada por AST conta callbacks defensivos que a v3 ignorava.
- **Corpo de PR com caractere de controle é recusado pela ferramenta** — usar
  `gh pr create --body-file`.
- **`gh run view --log-failed` pode vir vazio**; usar
  `gh api repos/kelvindk9w/tws-panel/actions/jobs/<id>/logs`.
- **A ferramenta bloqueia `sleep N && cmd`**; esperar condição com
  `until <cheque>; do sleep 20; done`.
- **A `main` é protegida** (`protect-main`); push direto é rejeitado. Nunca
  contornar.
- **Drop-in de sshd: o primeiro arquivo vence.** Override do usuário em
  `10-local-override.conf`; verificar com `sudo sshd -T | grep -i clientalive`.
- **Squash merge invalida verificação por ancestralidade** (`A..B` mente neste
  repo); compare conteúdo com `git diff --stat`.

## Convenções observadas

- Commits em português, conventional commits, corpo explicando **por quê** e o
  comportamento (não as linhas). Trailer de coautoria e link da sessão no fim.
- PR com contexto do problema real, decisões, trade-offs honestos e validações.
- Comentários no código em português, densos, explicando a decisão.
- TDD: teste que falha primeiro, verificado falhando pelo motivo certo.
- Nunca commitar sem `pnpm test:coverage` (espelha a CI) e `pnpm run typecheck`
  limpos; scripts com `bash -n` e `npx --yes shellcheck -x`.
- Subagentes com escopo de escrita explícito por arquivo; em paralelo só em
  arquivos disjuntos; nunca `git stash`/`reset`/`checkout` dentro deles.
- `comoFuncionaSistema/` atualizado junto com o código.
- O usuário não quer código colado no chat — cite o caminho do arquivo.
- Público-alvo do README é o leigo: nada pode depender de sorte nem de a pessoa
  ler uma mensagem solta na tela; transparência total (projeto open source).
- `image1.png`/`image2.png` na raiz são prints do usuário com IP da VPS: **nunca
  commitar**.
