# Relatório — MCP, Fase 0: tokens de API com escopo

Base: plano `plano-mcp.md` (seções 4 a 6), com as 8 decisões nas recomendações da seção 5. Branch parte de
`dev` (`b645f63`). Escopo desta fase: só a fundação (tokens, autenticação por Bearer, escopo, exclusões,
tela). **Não existe `/mcp`, nem o botão "Conectar uma IA", nem ferramentas** (Fases 1 a 4).

## O que passou a acontecer

1. **Tokens de API.** Em Configurações → Acesso por IA a pessoa cria um token com nome, escopo
   (leitura, escrita ou administração) e validade (padrão 30 dias, de 1 hora a 1 ano; 24 h é uma opção da
   lista, para o fluxo do assistente). O valor (`tws_pat_` + 256 bits) aparece **uma vez**, com botão copiar e
   aviso. O disco (`data/api-tokens.json`, 0600, gravação atômica pela fila) guarda só o SHA-256. Há id,
   criado em, vence em, último uso (gravado no máximo 1 vez por minuto) e revogado em.
2. **Entrada por `Authorization: Bearer`.** O plugin de autenticação aceita o token e cria uma "sessão
   sintética" (dono da conta, ator `token:<nome>`, validade do token, marca `session.token`). Ela não vai para
   o `sessions.json`. Sem cookie: o token não vale como cookie, o cookie é ignorado quando há Bearer, e nenhuma
   resposta a uma requisição com token emite cookie (nem o login: `POST /api/auth/login` com Bearer dá 403).
3. **CSRF/Origin e 2FA intactos.** A guarda de origem roda antes de tudo e vale para token. O 2FA não é
   contornado: criar token exige senha atual e, com 2FA ativo, o código (mesmo limite por IP e sessão e mesmo
   bloqueio por conta das outras rotas sensíveis).
4. **Escopo por rota e lista de exclusão central** (`services/token-policy.ts`): GET/HEAD = leitura;
   mudanças = escrita; sensíveis = administração; e uma lista que nenhum token alcança, nem admin. O teste
   `token-policy-rotas.test.ts` sobe o painel real e compara **todas** as 186 rotas `/api/*` com uma tabela
   (`services/token-policy-table.ts`, em `src`): rota nova sem decisão reprova no teste **e é negada em execução**
   (a tabela vale também no servidor: rota fora dela dá 403 a qualquer token).
5. **Auditoria.** Quem agiu aparece como `token:<nome>`. Como várias rotas gravavam sem ator (caíam em
   "operador"), o ator do token é aberto como contexto da requisição (`AsyncLocalStorage`) e o `AuditService`
   o usa quando o registro não traz ator: vale também para tarefas em segundo plano disparadas pela rota.
   O token nunca entra na auditoria, no log nem em mensagem de erro.
6. **Gestão só por humano.** Criar, listar e revogar exigem sessão de cookie; um token (mesmo admin) recebe
   403 e há uma segunda conferência dentro de cada handler. Limite de 20 tokens ativos; nome único entre os
   ativos. Revogar vale na hora (após a gravação terminar).
7. **Revogação em massa.** Trocar a senha e "Recomeçar do zero" revogam todos os tokens (sem isso uma sessão
   roubada deixaria um token vivo depois da troca). O caminho pela VPS, `scripts/reset-setup.sh --full`
   (senha do painel perdida), também apaga o `api-tokens.json`.
8. **Sem oráculo e com limite.** Token inexistente, adulterado, vencido, revogado, malformado, ou Bearer
   com o setup pendente: a mesma resposta 401, cabeçalhos iguais. O IP que erra 5 vezes em 1 min é bloqueado
   (429, 1 min dobrando até 30 min) por um limitador próprio (não trava o login de quem divide o IP). Enquanto
   bloqueado, até um token válido recebe 429; um acerto no meio não zera as falhas. Token na query string
   (`tws_pat_` em qualquer parte, ou `access_token`, `api_token`, `bearer`, `authorization`) dá 400 e o log
   troca o valor por `[redacted]`. Outro esquema de `Authorization` (Basic de um proxy) é ignorado.
9. **Falha fechada.** Arquivo ausente = nenhum token. JSON inválido ou registro malformado = guardado à
   parte (`.corrompido-<data>`), lista vazia, nenhum token antigo vale. Erro de disco ao ler = 503 e nada é
   aceito (não conta contra o IP). A carga é preguiçosa: o painel sobe de qualquer jeito. Falha ao gravar uma
   criação ou revogação = 500 dizendo o que NÃO foi feito.

## Decisões

- **Hash SHA-256, não um KDF lento.** O token tem 256 bits sorteados: não há espaço de adivinhação; um
  argon2 só tornaria cada requisição lenta. A busca compara o hash de todos os registros em tempo constante,
  sem parar no primeiro acerto.
- **A senha atual é pedida sempre ao criar** (e o código, com 2FA), além do que o plano pedia (só o 2FA):
  criar um token é entregar uma chave de longa duração; sessão roubada sem a senha não deve bastar.
- **Bearer vence cookie.** Com `Authorization: Bearer` na requisição o cookie é ignorado: a requisição vale o
  que o token vale, e um navegador logado não amplia o poder de um script.
- **Ator por contexto assíncrono** em vez de editar as dezenas de chamadas de auditoria: uma mudança só,
  testada com 20 pedidos concorrentes de token e humano (sem mistura).
- **Lista de exclusão por padrão de rota** (`/api/projects/:id/env`), nunca pelo endereço bruto: `%65nv` e
  `/%61pi/...` caem na mesma regra (testado).
- **Variáveis de projeto ficam fora da API.** `GET /api/projects/:id/env` devolve os **valores**, e
  `PUT` devolve a lista com os valores: nenhum dos dois serve a um token nesta fase. A Fase 1/2 traz o
  equivalente mascarado. **Isso não impede o desvio por deploy**: veja "Segunda rodada" abaixo.
- **Criar caixa de e-mail e ativar o e-mail do projeto também ficam fora** nesta fase: a resposta traz a
  senha gerada (`generatedPassword`). Serão liberados quando a senha for direto para o cofre/variáveis.

## Usos de sessão (`request.session`) e como cada um se comporta com token

45 pontos em 14 arquivos. A sessão sintética tem `id` `token:<id>`, `userId` do dono, `username` `token:<nome>`.

| Uso | Arquivo | Com token |
|---|---|---|
| Ator da auditoria (`session.username`) | `backups.ts`, `notifications.ts`, `timezone.ts`, `restore-reconciliation.ts`, `apps-domain.ts`, `panel-domain.ts`, `projects.ts` (fuso e recriar), `mail-send-routes.ts` | `token:<nome>` automaticamente |
| Ator padrão ("operador") nas demais rotas | todas as que auditam sem ator | `token:<nome>` pelo contexto da requisição |
| `session.id` como chave do limite por sessão (`beginAction`) | `auth.ts`, `setup-restart.ts`, `api-tokens.ts` | rotas proibidas a token; `sessao:token:<id>` seria uma chave separada |
| `userId` para ler o usuário | `onboarding.ts` (GET), `auth.ts` (`me`) | funciona (leitura): devolve o dono da conta |
| `sessionStore.destroy(session.id)` quando o usuário sumiu | `auth.ts`, `settings.ts`, `onboarding.ts`, `api-tokens.ts` | inofensivo (id sintético não existe no store) |
| `logout` | `auth.ts` | proibido a token |
| Troca de senha, 2FA (ativar, desativar, setup, status) | `auth.ts` | proibido a token |
| Perfil e preferências | `settings.ts` | proibido a token |
| Reinício do assistente | `setup-restart.ts` | proibido a token |
| Revelar senha dos backups (`userId` para `verifyLogin`) | `backups.ts` | proibido a token |
| Progresso do roteiro (iniciar, pular, ocultar) | `onboarding.ts` | proibido a token (só o GET) |
| Terminal: `session.id`, `expiresAt`, `onRevoked` | `terminal.ts` | proibido a token (nenhuma conexão presa a token) |
| Criar/listar/revogar tokens | `api-tokens.ts` | proibido a token; handler confere de novo |

## Tabela escopo × rota (186 rotas; a fonte é `src/services/token-policy-table.ts`)

| Escopo | Rotas | Regra |
|---|---|---|
| **Leitura** (61) | todo `GET`/`HEAD` não listado abaixo | projetos, domínios, portas, saúde, backups, certificados, e-mail (sem senhas), alertas, auditoria, segurança (leituras), containers, notificações, fuso, versão, `auth/me`, `onboarding` |
| **Escrita** (38) | todo `POST`/`PUT`/`PATCH`/`DELETE` não listado | ajustar projeto (só nome e websocket), deploy, iniciar/parar/recriar, backups (rodar, conferir, ajustes), alertas, testes de notificação, e-mail (domínios existentes, envios), reconciliação |
| **Administração** (40) | domínios e portas dos projetos (todas as mudanças), webmail ligar/desligar; `POST /api/projects` (criar projeto); `PATCH /api/projects/:id` quando o corpo traz repositório, branch, domínio ou proxy; `GET /api/security/scan?fresh=1`; destinos dos avisos (`PUT/DELETE` e-mail, `DELETE` Telegram, `connect`); `PUT/DELETE/POST` de `settings/panel-domain*` e `settings/apps-domain*`; `PUT /api/timezone`; `POST/PUT /api/security/*` que mudam (aplicar, plano, baseline, confirmar/desfazer acesso, vigia); `DELETE /api/projects/:id`; `POST /api/mail/domains`, `DELETE` de domínio e de caixa; `POST /api/mail/server/*`; `DELETE` de certificado manual; `POST` restaurar backup; `PUT` criptografia dos backups; `GET /api/fs/dirs` | apagar, restaurar, trancar o acesso, mudar o endereço do painel |
| **Nenhum** (47) | `PUT /api/projects/:id/email/links`; `PUT /api/mail/envios/reputation/dqs`; `POST /api/backups/targets/panel/restore` e `POST /api/projects/check-git-access` com `token` ou `useAccount` (por parâmetro/corpo);  terminal (`info`, `ws`); `POST /api/settings/restart-setup`; `/api/setup/*`; `auth/login`, `logout`, `change-password`, `2fa*`; `settings/profile`, `preferences`, `api-tokens*`; escrita do roteiro; senha dos backups (`PUT`, revelar, sugerir, testar); destino dos backups (`PUT`, `DELETE`, teste); `PUT` de certificado manual; `GET/PUT /api/projects/:id/env` e `env/provided/:name`; `PUT/DELETE /api/projects/:id/credential`; GitHub (`PUT`, `DELETE`, repositórios); `PUT` token do Telegram; `GET` credenciais e `PUT` senha de caixa; `POST` criar caixa; `POST /api/projects/:id/email`; revelar mensagens enviadas (2 rotas) | segredos e identidade |

## Testes

Servidor: `api-token-store` (23), `api-token-auth`, `token-policy-rotas`, `terminal-audit-actor`, mais casos em
`setup-restart` e `log-token`; core: `api-tokens`; web: `api-access-settings` (18). Relógio sempre
congelado só na `Date` (`vi.useFakeTimers({ toFake: ["Date"] })`), sem espera real. O resultado da
**mutação manual** (cada regra desligada, os testes precisam reprovar) está na seção "Mutação" abaixo.

## Mutação

29 mutações manuais no código (cada regra desligada ou invertida, um por vez), rodando `api-token-auth`,
`token-policy-rotas` e `api-token-store` (e `setup-restart`/`log-token` onde cabia). 28 foram pegas. As que
inicialmente sobreviveram: "setup pendente aceita Bearer" (o teste usava um token que nunca existiu; agora usa
um token real e a mutação é pega) e "o cookie também é lido quando há Bearer", que é **equivalente**: a
resposta do Bearer sempre substitui ou recusa a sessão, então ler o cookie a mais não muda nada observável
(a guarda segue por defesa em profundidade). Regras cobertas: HEAD nas listas do GET, GET/HEAD = leitura,
cada tipo de exclusão e de administração, cookie ignorado, login sem cookie, token na URL, escopo, exclusão,
acerto não zera falhas, setup pendente, limite por IP, 503 não conta, Bearer malformado, ator da auditoria,
expiração no instante, limite de ativos, nome único, revogado, registro malformado, último uso, só humano,
senha, 2FA, revogação em massa (senha e reinício) e o log.

## Segunda rodada (revisão independente)

O revisor aprovou o mecanismo (hash, Bearer, 401 uniforme, as 186 rotas, mutação, suítes e tela) e reprovou
seis pontos. O que mudou:

1. **Escrita não pode equivaler a ler segredo (ALTA).** Havia dois desvios: `PATCH /api/projects/:id` trocando
   `source`/`branch` seguido de `POST .../deploy` (publica código do atacante, que lê as variáveis), e
   `PUT /api/projects/:id/email/links` (injeta a senha da caixa como variável). Agora: `email/links` é
   **proibido** a qualquer token; o `PATCH` com `source`, `branch`, `domain`, `proxyService` ou `proxyPort`
   exige **admin** (a conferência é por campo do corpo, em `refineAccess`, num gancho `preValidation` depois
   que o corpo é lido); `POST /api/projects` (criar projeto a partir de um repositório) passou a **admin**; e
   o destino dos avisos (e-mail, Telegram) também. Varredura das demais escritas: não existe rota para
   comando de build/start, Dockerfile, compose ou hook; domínios dos projetos (adicionar, trocar principal,
   porta) seguem como escrita porque só apontam o tráfego para o próprio projeto.
   **Risco que sobra, dito sem rodeio:** quem pode disparar um deploy faz o código do projeto rodar com as
   variáveis dele, e um token de **admin** ainda pode trocar o repositório e publicar. Na prática, escrita e
   admin equivalem a **acesso às variáveis dos projetos que alcançam**. Isso está dito em SECURITY.md, no
   guia do site (pt-br e en), no modelo de ameaças e na tela. Para quem precisa de menos, o escopo é leitura.
2. **Restaurar o painel (MÉDIA-ALTA).** `POST /api/backups/targets/panel/restore` é **proibido a qualquer
   token** (conferência pelo parâmetro `:target`); restaurar `email` e `project:<id>` continua admin. Além
   disso, o `api-tokens.json` não entra no backup do painel e sobrevive a uma restauração (como `setup-token`):
   nenhum token revogado ressuscita, nem pelo script `restaurar-painel.sh`.
3. **Falha fechada em execução (MÉDIA).** A tabela foi para `src/services/token-policy-table.ts`; `classifyRoute`
   nega (403 `token_forbidden`) qualquer par método+rota que não esteja nela. O teste de referência segue
   exigindo as 186 rotas e que as regras coincidam com a tabela.
4. **Auditoria atribuída ao token certo (MÉDIA-BAIXA).** Eventos do terminal (`terminal.session`,
   `terminal.session-end`, ociosidade) são registrados com ator `operador` explícito: a sessão do PTY vive mais
   que a requisição que a abriu e herdava o contexto de ator do token. Os eventos da conexão do navegador já
   usavam o usuário da sessão.
5. **Chaves e terminal (BAIXA-MÉDIA).** `PUT /api/mail/envios/reputation/dqs` é proibido; `POST
   /api/projects/check-git-access` com `token` ou `useAccount` é proibido (sem eles segue escrita);
   `GET /api/security/scan?fresh=1` exige admin (o cache segue leitura; só o primeiro uso, sem relatório
   algum, ainda varre); `GET /api/health/scan` por token **não toca o terminal** (nem o espelho, nem a leitura
   do host: rede e reinício pendente voltam como indisponíveis).
6. **Tela.** Se a consulta do 2FA falha, o campo do código aparece mesmo assim, com aviso e "Tentar de novo";
   depois de criar, o foco vai para o aviso do segredo, que é uma região `role="status"` com anúncio para leitor
   de tela. Os textos dos escopos e o bloco "o que um token nunca faz" foram corrigidos (não diziam que escrita
   chega às variáveis por deploy).

Mutação desta rodada: 14 mutações (cada regra nova desligada); resultado na seção "Mutação" abaixo.

## Terceira rodada (revisão independente)

1. **Teste do terminal tocava o Docker real.** O `SecurityService` liga o terminal ao Docker do alvo; o teste
   agora desliga isso (`setEnsureTarget(undefined)`) e foi rodado com `DOCKER_HOST` apontando para um socket
   inexistente. Os testes novos de aplicação completa (`token-security-scan`) fazem o mesmo.
2. **Timers de vida longa herdavam o ator do token.** `PUT /api/security/monitor/config` recriava o
   `setInterval` dentro do contexto do token, e cada disparo saía como `token:<nome>`. O agendador agora é
   recriado fora do contexto (`runOutsideActor`). Varredura dos demais `setInterval`/`setTimeout`: os de
   agendas (backups, notificações, e-mail, certificados) nascem na subida do painel, sem contexto; o do
   terminal já usa ator explícito. Jobs de segurança iniciados por um token seguem atribuídos a ele (é quem os
   iniciou).
3. **Exposição à internet.** Domínios do projeto (adicionar, remover, principal, porta, par com/sem www),
   portas do projeto (também em lote, que podiam publicar uma porta interna em `0.0.0.0`) e ligar/desligar o
   webmail passaram a **admin**. Leitura (`GET .../ports`, `.../domains/pairs`) segue leitura.
4. **Varredura de segurança sem relatório.** Para token, `GET /api/security/scan` sem `fresh` e sem relatório
   guardado responde 404 `scan_not_available` e não varre (a varredura roda no terminal root compartilhado).
5. **Dono do token.** O token só vale se a conta dona ainda existe; conta sumida (ex.: `users.json` de outro
   servidor restaurado) dá o mesmo 401 uniforme.

Mutação desta rodada: 7 mutações, todas pegas (o primeiro teste do timer não reproduzia o vazamento e foi
reescrito: relógio falso não carrega o contexto assíncrono, então o teste observa o ator no instante em que o
`setInterval` é criado).

## Riscos e limites

- **Token de escrita/admin age sem confirmação humana**, inclusive em ações destrutivas (apagar projeto,
  restaurar backup). Isso é a Fase 3. Até lá: o menor escopo e validade curta.
- Logs de deploy (texto livre) são lidos por token de leitura, como a sessão humana lê. Pode conter segredo
  que o projeto imprima; a mascaração de respostas é da Fase 1.
- O bloqueio por IP é em memória (reiniciar o painel zera) e, atrás de NAT, divide o bloqueio. Vale o IP do
  `X-Forwarded-For` do Caddy (`trusted-proxies.ts`).
- Revogar vale quando a gravação em disco termina; um pedido que chegou junto pode terminar normalmente.
- Se a gravação da revogação falha, o token **continua valendo** e a tela diz isso (a alternativa, invalidar
  em memória sem gravar, voltaria a valer num reinício).
- A seleção de rotas "leitura" inclui `GET /api/audit` e logs; o `GET /api/fs/dirs` está em admin.
- Para onde vão os avisos (e-mail, Telegram) agora é administração: um token de escrita não redireciona alertas.
- **Restaurar um backup do painel** (feito por uma pessoa) mantém o `api-tokens.json` de agora, e o backup
  do painel nem leva o arquivo: nenhum token revogado volta, nenhum token novo some. Os usuários, a senha e o 2FA
  continuam voltando ao estado do backup (é para isso que serve restaurar) e, nesse caso, os tokens existentes
  seguem valendo para o `userId` de antes; confira a lista depois de restaurar.
- Troca de usuário de login (perfil) não revoga tokens (o token guarda o `userId`, não o nome).

## O que não pôde ser verificado

- Nada rodou contra uma VPS real: HTTPS/Caddy, IP real atrás do proxy e `flush_interval` (este só vale para
  `/mcp`, Fase 1).
- Tela em 360 px conferida só pelas classes e por teste (sem rolagem lateral esperada: `min-w-0`,
  `break-words`, sem larguras fixas) e, se anotado abaixo, pelo navegador.

## O que ficou para a Fase 1 e seguintes

- `/mcp` (HTTP streamable), desligado por padrão, só Bearer e sem cookie, rejeitando requisições de navegador.
- Setup token em `/mcp` durante a instalação (decisão 2), com o conjunto mínimo.
- Saída estruturada, truncada e mascarada (inclusive variáveis sem valor) e a tela "Acesso por IA" com o
  liga/desliga do `/mcp`.
- Botão "Conectar uma IA" (token de 24 h) e limites de frequência por token (Fase 2).
- Confirmação humana de ações destrutivas, com 2FA (Fase 3). Pareamento e OpenAPI (Fase 4).
