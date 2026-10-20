# Relatório — Lote 7: autenticação e sessão

Data: 2026-10-19 · Branch: `worktree-agent-a8a60555ec14a0c6e` (a partir de `origin/dev`, que já tem os lotes 5 e 6) · Sem push, sem PR.

Achados tratados: M1, M2, M3 e, dos BAIXOS/INFORMATIVOS, B13, B14, I1 e a parte de cache do I3.
Um commit por achado. Insumo: `/home/kelvin/.claude/auditoria-paas/RELATORIO-AUDITORIA.md` (existia desta vez).

Método: para cada achado, primeiro o teste, visto falhar contra o código anterior pelo motivo certo; depois a correção.

## O que muda para quem usa o painel (leia isto primeiro)

1. **Todo mundo que está logado em HTTPS sai da sessão uma vez, na atualização.** O cookie passa a se chamar
   `__Host-paas_session` em HTTPS; o antigo `paas_session` deixa de valer. Basta entrar de novo. Em HTTP simples
   (`http://IP:9000`, antes do SSL) o nome não muda e ninguém é deslogado.
2. **Cookie SameSite=Strict** (era Lax). Abrir o painel por um link de outro site carrega a página normalmente; o
   navegador só não manda o cookie nessa primeira navegação, e a página já pergunta quem é logo em seguida.
   Não há fluxo de retorno de OAuth no painel (a integração com o GitHub é por token), então nada quebra por isso.
3. **Escrita vinda de outro site/origem leva 403 `forbidden_origin`.** Navegador comum e a interface do painel não
   são afetados (mandam `Sec-Fetch-Site: same-origin`). `curl` e scripts sem esses cabeçalhos continuam passando.
   Quem usa o painel por outro endereço (ex.: túnel com Host diferente do Origin) pode precisar de `ALLOWED_ORIGINS`.
4. **O setup token na URL (`?token=`) só vale no WebSocket do terminal.** A interface já usa o cabeçalho nas demais
   chamadas; scripts externos que mandavam `?token=` em outras rotas passam a levar 401.
5. **O token do instalador deixa de existir ao concluir o assistente** (arquivo apagado, memória limpa, variável de
   ambiente ignorada no boot seguinte), e o terminal aberto com ele fecha na hora (código 4401).
6. **Prioridade invertida:** o arquivo `/data/setup-token` vale mais que a variável `SETUP_TOKEN`. Instalação nova
   não percebe (os dois são iguais); o "Recomeçar do zero" passa a sobreviver a um reinício.
7. **Estado do setup ilegível dá 503 `setup_state_unavailable`** (antes 500), sem aceitar token nem sessão.
8. **Login em rajada:** pedidos simultâneos além da quinta tentativa do mesmo IP levam 429 (Retry-After 5s) sem a
   senha ser avaliada. Uso normal (uma tentativa por vez) não muda.

## M1 — CSRF a partir de qualquer `*.sslip.io`

- **Teste que falhou antes:** `apps/server/tests/csrf-origem.test.ts` (10 de 17 falhavam: POST com
  `Sec-Fetch-Site: same-site`/`cross-site`, `Origin` de outro host, `Origin: null`, malformado, DELETE, login e rota
  inexistente voltavam 200/401 em vez de 403) e `apps/server/tests/sessao-cookie.test.ts` (5 de 5 falhavam: nome do
  cookie, `Secure`, `SameSite=Strict`, cookie sem prefixo ainda aceito em HTTPS, logout).
- **O que mudou:** novo `services/same-origin.ts`. O hook de autenticação, antes de resolver sessão ou token, recusa
  escrita sob `/api/` que o navegador marca como de outro site (`Sec-Fetch-Site` diferente de `same-origin`/`none`,
  inclusive `same-site`) ou, sem esse cabeçalho, com `Origin` diferente do `Host`. Origens de `ALLOWED_ORIGINS`
  passam. Leitura (GET) não é barrada. `isCrossOrigin` saiu de `routes/terminal.ts` para o módulo novo (o
  terminal usa o mesmo).
  Cookie: `SameSite=Strict`; em HTTPS o nome é `__Host-paas_session` (Secure, Path=/, sem Domain) e é o único lido
  nessa conexão; logout e "recomeçar" apagam o cookie com o nome certo. Isso também resolve o **B13** (cookie
  tossing a partir de `*.sslip.io`).
- **Mudança em teste existente:** `auth.test.ts` esperava `SameSite=Lax`; passou a `Strict` (é a política que mudou).
  `test-utils.ts` ganhou a opção `trustProxy` e aceita o prefixo no extrator do cookie.

## M2 — limite de login contornável

- **Teste que falhou antes:** `apps/server/tests/login-limite.test.ts` (8 de 12 falhavam). 60 tentativas
  simultâneas avaliaram a senha **50 vezes** (esperado: no máximo 5), e uma senha certa no meio da rajada **criou
  sessão (200)**. Os 7 testes unitários do limitador falhavam por falta de `release`/poda.
- **O que mudou:** `login-limiter.ts` reserva a tentativa antes de verificar a senha (falhas na janela + tentativas
  em andamento nunca passam de 5). A rota devolve a reserva (`release`) em qualquer saída que não seja falha nem
  sucesso (senha certa esperando o código de 2FA, erro ao gravar a sessão), com `try/finally`. Poda do mapa (**B14**):
  IPs ociosos saem a cada minuto, o nível de bloqueio esfria 30 min depois de vencer, e há teto de 10 mil IPs
  rastreados (nunca solta quem está bloqueado ou com tentativa em andamento).
- **X-Forwarded-For:** já estava corrigido pelo lote 5 (A4, `trusted-proxies.ts`). Acrescentei só um teste de
  regressão no nível do login (`30 tentativas, cada uma com um XFF diferente`), que **passou também no código
  anterior a esta mudança**: não é um achado reproduzido aqui.

## M3 — setup token

- **Teste que falhou antes:** `apps/server/tests/setup-token-ciclo.test.ts` (10 de 14 falhavam) e
  `apps/server/tests/log-token.test.ts` (o token aparecia em claro em `req.url` do log; reproduzido tirando o
  serializador).
- **Falha aberta do `setup-state.json`:** o lote 6 (M7) já impedia o "ilegível = não concluído" (a carga agora
  falha). O que faltava era o hook devolver uma resposta limpa: antes era 500 (com mensagem do sistema, I2); agora
  503 `setup_state_unavailable` em toda rota protegida, em `/api/setup/*` e em `/api/auth/*`, sem aceitar token nem
  sessão. "Arquivo não existe" continua sendo instalação nova.
- **Token permanente:** ao criar o admin, o token some da memória (`app.revokeSetupToken()`), o arquivo é apagado
  (falha ao apagar não impede a conclusão: vira auditoria `setup.token_cleanup_failed`) e `process.env.SETUP_TOKEN`
  é esvaziado. No boot, com o setup concluído, nenhum token é carregado. O arquivo vale mais que a variável de
  ambiente (que é só fallback).
- **Token no log:** novo `log-config.ts` (usado pelo `app.ts`): o serializador de `req` troca o valor de `token` (e
  `access_token`, `secret`, `password`, `code`) na URL por `[redacted]`. O `redact` antigo não alcançava a URL.
- **Token só no cabeçalho:** a query `?token=` só é lida em `/api/terminal/ws`.
- **Mudanças em testes existentes:** `routes-setup.test.ts` ("aceita o token via query" virou "NÃO aceita ... em
  rota comum") e `setup-token.test.ts` (a prioridade "env vence o arquivo" virou "arquivo vence a env"). Os dois
  encodavam exatamente o comportamento que a auditoria aponta como defeito.

## I1 — terminal aberto com o setup token sobrevive à conclusão

- **Teste que falhou antes:** `routes-terminal.test.ts` (bloco "fim do assistente encerra o terminal"): o WS ficava
  aberto (estouro de tempo) depois de revogar o token.
- **O que mudou:** o plugin de auth avisa quem assinou (`onSetupTokenRevoked`); o terminal aberto sem sessão fecha
  com 4401 e o que se digita depois não chega ao PTY. Terminal com sessão não é tocado.

## I3 (parte) — cache

- **Teste que falhou antes:** `apps/server/tests/api-no-store.test.ts` (1 de 3): `GET /api/projects/:id/env` e o
  401 saíam sem `Cache-Control`.
- **O que mudou:** toda resposta sob `/api/` leva `Cache-Control: no-store`, salvo quando a rota definiu o seu.

## Itens que NÃO peguei, e por quê

| Item | Motivo |
|---|---|
| Limite por conta e teto global (parte do M2) | Um bloqueio por conta/global deixa um anônimo travar o único administrador (negação de serviço do login e de qualquer recuperação). Com o XFF corrigido (A4), a reserva por IP, argon2 e senha de 12+ caracteres, o risco que sobra é botnet; deixei como risco residual em vez de trocar uma falha por outra. |
| Senha certa sem código de 2FA não gasta tentativa | É um oráculo da senha (só a certa responde `two_factor_required`) sem limite além da reserva. Contar quebraria o login legítimo (a interface envia sem código primeiro). Precisa de mudança de fluxo na interface. |
| I3: revelação da senha do backup sem 2FA; S3 aceitando `http://` | Exige campo novo na interface e decisão de produto; não é barato nem seguro de fazer às cegas. |
| I2 (erros 500 devolvem `err.message`) | Não é autenticação, e testes existentes dependem das mensagens; fica para um lote de tratamento de erros. |
| B12 (`reset-2fa.mjs` sem escrita atômica) | Já está atômico no código atual (arquivo temporário + rename). Nada a fazer. |
| B1–B8, B11, I4–I9 | Fora de autenticação/sessão (auditoria, deploy, e-mail, backup, notificações, supply chain). |
| Telegram B8 | Notificações, não autenticação. |

## O que NÃO foi testado de verdade

- **Navegador real:** nada foi aberto num navegador. Que o navegador manda `Sec-Fetch-Site: same-origin` nas chamadas
  da interface, aceita `__Host-paas_session` e trata `SameSite=Strict` como descrito é conhecimento da especificação,
  não prova. Os testes usam `inject` do Fastify com os cabeçalhos escritos à mão.
- **Caddy real:** assumo que o proxy repassa o `Host` do cliente (o gerador não reescreve `Host` para o painel, e o
  terminal já dependia disso). Não subi o Caddy.
- **`install.sh`, `docker compose` e reinício do contêiner:** a nova prioridade arquivo > variável e o "setup
  concluído não carrega token" foram testados em `loadSetupToken` e na rota, não no ciclo real de reinício.
  `app.ts` fica fora da cobertura unitária (como já era); só a linha que chama `loadSetupToken` com o estado
  concluído não tem teste próprio.
- **Concorrência em produção:** a rajada de 60 foi com `inject` em processo único, argon2 real; sem rede.

## Riscos residuais

- Quem já tinha sessão em HTTPS é deslogado uma vez (intencional).
- `Sec-Fetch-Site` ausente em navegador muito antigo cai na conferência de `Origin`; se também faltar, a escrita passa
  (igual a um cliente que não é navegador). `SameSite=Strict` cobre esse caso para o cookie.
- Botnet com muitos IPs contra a senha do admin continua limitada só por argon2 e pelo mínimo de 12 caracteres.
- Em HTTP simples (`http://IP:9000`) o cookie não tem `__Host-`/`Secure`: é o modo antes do SSL, e o tossing por
  `*.sslip.io` só afeta quem usa o endereço sslip.io em HTTPS.
- O `process.env.SETUP_TOKEN` do contêiner continua definido no `docker-compose.yml` e ainda é lido se o arquivo não
  existir e o setup estiver incompleto; com o setup concluído é ignorado.
- Scripts externos que dependiam de `?token=` fora do terminal quebram (ver acima).

## Correções da revisão (rodada 2)

O revisor aprovou M1, M2, I1/I3 e os 3 testes alterados, e reprovou três pontos. Todos corrigidos.

### 1. M3 — recuperação de acesso (o mais grave)

- **Era:** ao concluir o assistente o painel apaga `/data/setup-token`, mas `reset-setup.sh` (com e sem `--full`)
  dizia que o token "não é tocado" e mandava usar `show-token.sh`. Depois do reset e de recriar o contêiner
  (`docker compose up -d --build` não repassa `SETUP_TOKEN`) não havia token: toda a API, inclusive
  `/api/setup/admin`, dava 503 `setup_token_missing`, e o `show-token.sh` dizia "não encontrado". No caso inverso
  (contêiner original da instalação), a variável `SETUP_TOKEN` revalidava o token que o lote dizia invalidado.
- **Teste que falhou antes:** `apps/server/tests/reset-setup-token.test.ts` (8 de 10 falhavam; o docker é um
  dublê no PATH que executa o `sh -c` do `docker run` contra uma pasta temporária): nenhum `/data/setup-token`
  depois do reset, token que não mudava a cada reset, `show-token.sh` sem orientação, e a variável da instalação
  autenticando com admin existente e sem arquivo.
- **Mudou (pelo comportamento):**
  - `reset-setup.sh`, com e sem `--full`, gera um token novo (24 bytes em hexadecimal, arquivo 0600, gravado por
    temporário e `mv`). O token antigo deixa de valer. Os avisos do script foram corrigidos.
  - `show-token.sh` não usa mais a variável do contêiner como fallback (mostraria um token que o painel ignora);
    sem arquivo, explica que o token foi apagado de propósito e manda rodar `reset-setup.sh`.
  - `loadSetupToken` só usa a variável `SETUP_TOKEN` quando não há administrador: com admin (mesmo com o
    `setup-state.json` ausente, como após um reset sem `--full`) ela nunca revalida. Instalação nova sem arquivo
    ainda a usa como fallback.
  - Testes do ciclo: concluir → reset → reinício **sem** a variável (sobe com o token novo), **com** a variável
    (o arquivo novo vale), e reinício com a variável após concluir ou com admin existente (não autentica).
- **Não testado de verdade:** o `docker run`/`docker restart` reais e o `docker compose` (o docker do teste é um
  dublê); o fluxo completo na VPS.

### 2. M3 — token ainda ia para o log

- **Era:** o error handler gravava `request.url` crua ao recusar por validação (token válido + `clientId` inválido
  no WebSocket do terminal deixava `token=SEGREDO` em claro).
- **Teste que falhou antes:** `apps/server/tests/log-token.test.ts` (bloco "pedido recusado por validação", com o
  schema e a rota reais do terminal).
- **Mudou:** `plugins/error-handler.ts` usa o mesmo `scrubUrl` do `log-config.ts`. Procurei outros
  `request.url` indo para log em `src/`: não há.

### 3. Documentação e dev nativo

- `docs/troubleshooting.md`, `docs/production.md` e `docs/instalacao.md` corrigidos (arquivo vale mais que a
  variável; token apagado ao concluir; `reset-setup.sh` gera token novo; `show-token.sh` sem fallback pela variável).
- **Dev nativo (`SETUP_TOKEN=dev-token pnpm dev`):** o proxy do Vite reescreve o `Host` para `localhost:9000`
  e o `Origin` segue `localhost:5173`. A guarda comparava `Origin` com `Host` mesmo quando o navegador dizia
  `same-origin`. **Teste que falhou antes:** `csrf-origem.test.ts` ("proxy de dev: Origin e Host diferentes, mas
  Sec-Fetch-Site same-origin" voltava 403). **Mudou:** `Sec-Fetch-Site: same-origin`/`none` agora vale por si
  (o navegador o define e a página não o forja); `same-site`/`cross-site` continuam barrados, e `Origin` vs `Host`
  só é conferido quando o cabeçalho falta. O WebSocket do terminal usa a mesma função (também funcionava mal no dev
  por causa do `Host`) e agora respeita `ALLOWED_ORIGINS`. Preferi isso a mudar o proxy do Vite (seguro e sem
  configuração); `docs/desenvolvimento.md` documenta `ALLOWED_ORIGINS=http://localhost:5173` só como reserva
  caso algum proxy remova o cabeçalho. **Não testado:** o Vite real com navegador.
- JSON de `comoFuncionaSistema/` com o nome do cookie: `terminal/websocket.json`, `autenticacao/index.json`,
  `global/auth-plugin.json`. Também corrigi `global/threat-model.json`, que o commit anterior deixou com JSON
  inválido (uma linha sem a chave `controle`), e completei o texto do vazamento em log.
- Nos itens "O que muda" acima: o item 6 (prioridade) e o 5 valem com a regra nova (variável só sem administrador).

## Verificação

- `pnpm -r run typecheck`: passou nos 6 pacotes.
- Server: 129 arquivos, 1929 testes passando; cobertura geral 97,97% linhas / 93,37% ramos / 98,28% funções /
  99,02% instruções (mínimos 94/91/98/94), rodada com `--maxWorkers=2`.
- `@paas/core`: 26 testes do arquivo alterado e cobertura 99,6% / 98,8% ramos; `@paas/web`: 746 testes passando.
- Deploy e mailer não foram tocados, então não rodei a cobertura deles.

## Documentação atualizada em `comoFuncionaSistema/`

`global/auth-plugin.json`, `autenticacao/login.json`, `autenticacao/logout.json`,
`configuracoes/dominio-do-painel.json`, `global/configuracao.json`, `global/arquitetura.json`,
`global/threat-model.json`, `terminal/websocket.json`, `setup/status.json`, `setup/avancar.json`,
`setup/criar-admin.json`. Os números de linha citados nesses JSON já estavam defasados antes e não foram refeitos.
