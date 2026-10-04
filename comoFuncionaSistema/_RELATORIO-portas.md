# Relatório — Portas dos containers (03/10/2026)

Branch `feat/portas`, a partir da `dev`. Pedido do dono do produto, depois de
colocar o cassino no ar: "conseguimos pelo painel trocar as portas dos
containers? Seria interessante ter um botão que eu clico, ele abre um modal
exibindo os containers e portas desse projeto e, em outra aba, todos os
containers e portas de todos os projetos, podendo mudar a ordenação deles."

## O que mudou (pelo comportamento)

### Botão "Portas"
- Fica no cartão **Containers** da Visão geral do projeto, ao lado de "N/M
  rodando".
- Por que ali: é o cartão que já fala dos containers, e existe em todo tipo
  de projeto (compose, Dockerfile, estático). O cabeçalho do projeto já tem
  quatro botões de ação com cor (Abrir site, Parar, Iniciar, Deploy). No
  celular, um quinto botão quebraria a grade de duas colunas.
- Abre um modal com duas abas. A primeira consulta ao servidor alimenta as
  duas, e o servidor lista o Docker uma vez só.

### Aba "Este projeto"
- Começa com a frase para leigo: "Porta interna é onde o app escuta dentro do
  container; só muda no código do app. Porta publicada é a porta do servidor
  que leva até ele; o painel pode trocar."
- Mostra a entrada HTTP do painel (ex.: `wallet:80`) e lembra que ela usa a
  rede interna, sem precisar de porta publicada.
- Cada serviço aparece num cartão com:
  - o estado (rodando, saudável, não saudável, parado, sem container…);
  - as portas internas;
  - "usa a rede do X", quando é o caso;
  - as portas publicadas no servidor, no formato `127.0.0.1:8010 → 8010`, com
    selos: "no ar", "vale no próximo deploy", "trocada no painel", "aberta a
    todos os endereços", "o painel retira (80/443 são do painel)" e
    "conflita com o painel".
- Dá para ordenar por serviço, porta ou estado. A escolha fica lembrada no
  navegador.
- Projeto que não é compose: mostra as portas que estão no ar, sem "Trocar".
- Compose cujo código ainda não está no servidor: o modal pede o primeiro
  deploy.

### Trocar a porta publicada (só compose, só o lado do servidor)
- "Trocar" abre um formulário na própria porta:
  - nova porta do servidor (1024–65535; vazio = manter a mesma);
  - onde ela fica aberta: "Só no servidor (127.0.0.1) — recomendado" ou
    "Em todos os endereços (0.0.0.0)";
  - com 0.0.0.0, um aviso âmbar: a porta fica aberta para a internet; na
    maioria das VPS o Docker publica por fora do firewall (UFW); se a VPS tem
    regras próprias para o Docker, o UFW pode bloquear. Teste de fora depois
    do deploy.
- Também há "Remover publicação" (a porta some do servidor; o app continua
  acessível pelo painel e pela rede interna) e "Voltar ao compose" (apaga a
  troca).
- A porta é conferida na tela, enquanto se digita, e de novo no servidor. É
  recusada quando:
  - é 80 ou 443;
  - está fora de 1024–65535;
  - é reservada ao painel: 2019, a porta do painel e as do e-mail;
  - já é usada por outro container ou outro projeto, no ar ou configurada.
- Escolher exatamente o que o compose pede apaga a troca.
- A troca **vale no próximo deploy**. O modal diz isso e oferece "Fazer
  deploy agora", que segue o mesmo caminho do botão Deploy (guardrails
  incluídos).
- A Auditoria registra cada troca, por exemplo: `Projeto "Loja", serviço api:
  127.0.0.1:8010:8010 → 0.0.0.0:18010:8010.`

### No deploy
- O `paas.override.yml` recebe a lista final de cada serviço em
  `ports: !override`: as portas do compose, sem 80/443 de app comum, com as
  trocas e remoções aplicadas. A retirada de 80/443 continua igual.
- O log do deploy mostra cada troca ("Porta do servidor (api): … → …").
- Se o compose mudou e a porta trocada não existe mais, o log avisa e a troca
  é ignorada. Ela não cai noutra porta.
- **Os guardrails usam a mesma lista.** Um banco com a publicação removida no
  painel não bloqueia mais o deploy. A dica do bloqueio "porta de banco
  publicada" agora aponta para Portas → Remover publicação.

### Aba "Todos os projetos"
- Lista todos os containers do servidor: os dos projetos, os do próprio
  painel (Caddy, painel, e-mail) e os externos.
- Colunas: projeto, container (com o serviço), imagem, porta e estado.
- Também aparecem as portas que projetos do painel **vão usar**: projeto
  parado, ou troca salva e ainda sem deploy. Elas vêm marcadas "vai usar
  (próximo deploy ou ao iniciar)".
- Conflito (duas coisas querendo a mesma porta do servidor):
  - a linha fica em vermelho, com "conflito com X";
  - um aviso no topo conta quantas portas estão em conflito.
- Endereços diferentes e específicos (127.0.0.1 e 10.0.0.5) não conflitam.
  "Todos os endereços" conflita com qualquer um.
- Busca por projeto, container, imagem, serviço ou porta.
- Ordenação por clique no cabeçalho (projeto, container, porta, estado),
  lembrada no navegador.
- No celular a tabela vira lista empilhada, com os mesmos botões de
  ordenação.

### API
- `GET /api/projects/:id/ports`: o projeto e todas as portas do servidor.
  Somente leitura, sem segredos.
- `GET /api/ports`: todas as portas do servidor.
- `PUT /api/projects/:id/ports`: aplica uma troca. O schema aceita só
  porta 1024–65535, endereço `127.0.0.1` ou `0.0.0.0` e ação
  `change`/`remove`/`reset`.
- Detalhes em `projetos/portas.json`, `projetos/portas-servidor.json` e
  `projetos/trocar-porta.json`.

## Decisões
- **Modelo:** `Project.portOverrides`, por serviço. Cada troca guarda a
  porta como está no compose (a chave), a porta nova do servidor (ou null =
  removida) e o endereço.
- **A chave é a forma normalizada da porta no compose**
  (`127.0.0.1:8010:8010`, `5353:53/udp`). Com isso, a troca não se perde
  quando a ordem das portas muda e não vai para a porta errada quando a
  porta some do compose.
- **Uma consulta ao Docker por abertura do modal.** O GET do projeto já traz
  as linhas da aba "Todos", que não consulta de novo. O `GET /api/ports`
  existe para uso futuro (por exemplo, no Dashboard).
- **Docker fora do ar** não derruba o modal: aparece um aviso e o que está
  configurado nos projetos.
- **80/443 não são trocadas aqui.** Continuam com a regra de sempre: o painel
  retira as de app comum e bloqueia as de proxy HTTPS próprio.
- **Faixas:** trocar uma porta de dentro de uma faixa (`8000-8001:8000-8001`)
  reescreve a faixa como portas soltas. Variável e porta aleatória do lado do
  servidor continuam como estão, mas aceitam troca para um número fixo.
- **Aviso do UFW:** o pedido falava em "o firewall pode bloquear". O texto
  final é mais preciso: na maioria das VPS o Docker publica por fora do UFW
  (o compose do painel já registra isso). O "pode bloquear" ficou para quem
  tem regras próprias.
- **Processos fora do Docker** (algo escutando direto na VPS) não entram na
  checagem. Se a porta estiver ocupada assim, o `docker compose up` falha
  com "port is already allocated", e o diagnóstico do deploy mostra.
- **Lógica pura em módulos testados:** `packages/deploy/src/port-overrides.ts`
  e `apps/server/src/services/port-map.ts`, este último incluído na cobertura
  do servidor. `engine.ts` e `deploy-service.ts` só chamam esses módulos.

## Como testei
- TDD, com os testes escritos antes do código:
  - **deploy:** `port-overrides.test.ts`, mais casos novos em
    `compose-override.test.ts` e `rules.test.ts` (banco com a publicação
    removida não bloqueia).
  - **server:** `port-map.test.ts` (docker ps, linhas, conflitos, aba do
    projeto, validação), `deploy-ports.test.ts` (o serviço com o Docker
    simulado: uma listagem, Docker fora do ar, troca gravada, auditoria e
    guardrails) e `routes-ports.test.ts` (autenticação, schema, erros).
  - **web:** `ports-lib.test.ts` (ordenação, busca, conferência da porta,
    localStorage bloqueado), `ports-modal.test.tsx` (abas, Trocar, Remover,
    Voltar ao compose, erro do servidor, ordenação lembrada, celular) e um
    caso novo em `project-detail-page.test.tsx` (o botão abre o modal e o
    "Fazer deploy agora" passa pelos guardrails).
- **Navegador** (Playwright, vite numa porta livre, API simulada por
  `page.route` com a estrutura do cassino):
  - computador: as duas abas, a troca e os conflitos;
  - 390 px: sem rolagem lateral (largura do documento 380 ≤ 390), lista
    empilhada e formulário legível.
- `pnpm -r --workspace-concurrency=1 --no-bail run test:coverage`: números
  na seção abaixo.

  | Pacote | Antes | Depois |
  |---|---|---|
  | core | 50 | 50 |
  | web | 546 | 569 |
  | deploy | 374 | 394 |
  | mailer | 195 | 195 |
  | security | 167 + 2 arquivos com falha | 167 + 2 arquivos com falha |
  | server | 1014 + 1 arquivo com falha | 1047 + 1 arquivo com falha |

  - **As falhas são as mesmas antes e depois e não têm relação com esta
    mudança.** Os testes das fases 01/02/07 (security) e o do terminal com PTY
    real (server) param ao baixar `ubuntu:24.04`: o Docker desta máquina (WSL)
    não acha o ajudante de credenciais `docker-credential-desktop.exe`. Desta
    vez o Docker respondia, e os testes de deploy com Docker real passaram.
  - **Cobertura mínima conferida:**
    - deploy: 96,5% de ramos (mínimo 95%);
    - server, rodado sem o teste do PTY: passou nos mínimos, com 93,78% de
      ramos (mínimo 91%); `port-map.ts` tem 99% de ramos.

## O que só dá para validar na VPS
1. Abrir o cassino → Visão geral → **Portas**. Conferir:
   - os cinco serviços, com o estado;
   - a porta `127.0.0.1:8010 → 8010` do wallet;
   - 80/443 marcadas "conflita com o painel";
   - na aba Todos, o Caddy, o painel e o Stalwart como "Painel".
2. Trocar a 8010 do wallet para outra porta (ex.: 18010, só no servidor) e
   fazer o deploy. Conferir:
   - o log mostra "Porta do servidor (wallet): …";
   - `sudo docker ps` mostra `127.0.0.1:18010->8010/tcp`;
   - no modal, o selo muda para "no ar".
3. Voltar ao compose e fazer o deploy de novo.
4. A versão do docker compose da VPS precisa aceitar `!override`
   (2.24 ou mais nova). Isso já era necessário para a retirada de 80/443.

## Pendências e dúvidas
- **Mostrar a troca também no cartão "Serviços do compose"?** Hoje o cartão
  mostra o compose como está. A troca aparece só no modal.
- O aviso de conflito com um container externo **parado** não aparece: o
  `docker ps` não mostra portas de container parado.
