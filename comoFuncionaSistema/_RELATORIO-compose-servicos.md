# Relatório — serviços do compose e diagnóstico de deploy (03/10/2026)

Branch `feat/compose-servicos`, a partir da `dev`. Motivo: o deploy real de um
compose grande (cinco serviços: banco, redis, carteira construída do
repositório, front e um Caddy que atende dentro da carteira) falhou com
"dependency failed to start: container …-wallet-1 is unhealthy". O log do
painel não mostrou o que a carteira escreveu antes de ficar doente. Durante o
deploy, um texto vermelho apareceu acima do menu do projeto, e ninguém
conseguiu ler.

## O que mudou (pelo comportamento)

### 1. "Por que falhou" no log do deploy de compose
- Quando o `docker compose up` falha (e o motivo não é variável faltando), o
  painel pergunta ao Docker o estado de cada serviço do projeto, com os mesmos
  argumentos do deploy.
- Para cada serviço que ficou "não saudável", parou com erro ou fica
  reiniciando, o log do deploy ganha um bloco
  `=== Por que falhou: serviço <nome> ===` com:
  - as últimas 80 linhas do log do serviço;
  - as 3 últimas verificações do healthcheck, com código e saída, quando o
    serviço tem healthcheck.
- Serviços que só esperavam o que falhou aparecem numa lista curta, sem log:
  "não chegou a iniciar" e "não foi criado".
- A mensagem final passa a dizer qual serviço falhou, por exemplo: "docker
  compose up falhou: o serviço wallet não ficou saudável — veja o log dele
  acima." Se o Docker não aponta culpado, a mensagem continua a de antes
  (código de saída).
- O texto vem dos containers e pode vir de qualquer lugar, por isso é tratado
  antes de entrar no log:
  - perde cores e caracteres de controle (as quebras de linha ficam);
  - cada linha tem até 1.000 caracteres;
  - cada serviço tem até 8.000 caracteres (fica o fim);
  - o diagnóstico inteiro para de juntar logs perto de 30.000 caracteres.
- Serviços de `profiles` não entram na conta, porque o painel não os sobe.

### 2. Todos os serviços do compose na tela
- A detecção lista todos os serviços. Para cada um:
  - imagem, ou "construído do repositório" com o Dockerfile usado;
  - portas publicadas, marcando as 80/443 como "o painel retira" ou "conflita
    com o painel";
  - portas internas conhecidas, com a origem: `expose`, EXPOSE do Dockerfile,
    URL local do healthcheck ou variável `PORT`;
  - "usa a rede do X" (network_mode), as dependências com a condição e onde
    fica o healthcheck.
- O Dockerfile só é lido quando o build é local e o arquivo está dentro da
  pasta do projeto.
- **No assistente de Novo Projeto**, no passo da detecção, os campos soltos
  "serviço web / porta" deram lugar a:
  - a lista dos serviços;
  - a entrada HTTP em destaque ("O HTTP do painel chega em wallet:80");
  - a explicação quando outro serviço atende dentro da entrada ("O caddy
    atende dentro do wallet (network_mode: service:wallet), por isso a entrada
    é wallet:80 — a porta em que o caddy escuta");
  - a escolha do serviço e da porta interna. Serviços que usam a rede de outro
    ficam fora da lista. As portas conhecidas viram atalhos, e uma porta fora
    de 1–65535 trava o "Continuar".
- **Na Visão geral do projeto**, um cartão "Serviços do compose" mostra:
  - o mesmo conteúdo;
  - o estado de cada container: rodando, saudável, não saudável, iniciando,
    reiniciando, parado, não iniciou ou sem container;
  - o botão "Salvar entrada", que vale no próximo deploy.
- Projetos detectados antes desta mudança mostram "Ler o compose de novo". O
  botão relê o compose e não publica nada.
- **O servidor confere a entrada ao salvar.** Recusa, com uma frase que diz o
  que escolher:
  - um serviço que não existe no compose;
  - um serviço que usa a rede de outro.

  A porta continua validada entre 1 e 65535.
- A listagem de containers passa a trazer o serviço do compose e a saúde do
  healthcheck de cada container.

### 3. O texto vermelho acima do menu do projeto
- **O que era:** a página do projeto consulta o servidor a cada 1,5 s durante
  o deploy (5 s fora dele). Se uma consulta falhava, a mensagem aparecia em
  vermelho exatamente entre o cabeçalho e o menu lateral. A consulta seguinte,
  bem-sucedida, apagava a mensagem: ela piscava e sumia. O mesmo lugar
  mostrava os erros de ação, que também eram apagados pela consulta.
- **Causas prováveis no deploy real** (sem o log do servidor não dá para
  cravar qual):
  - **Limite de requisições (o mais provável).** O servidor aceita 200
    requisições por minuto por IP. Cada ciclo fazia três consultas, ou seja,
    ~120 por minuto. Com a janela de detalhe do deploy aberta ou outra aba do
    painel, o limite estoura. A resposta vem em inglês: "Rate limit exceeded,
    retry in 1 minute".
  - **Docker lento.** A listagem de containers pode falhar enquanto o Docker
    recria a stack.
  - **Conexão** caindo por um instante.
- **Agora:**
  - uma falha isolada não aparece;
  - a partir da segunda seguida, aparece um aviso âmbar estável, legível e em
    português, que some sozinho quando a consulta volta. O texto depende da
    causa:
    - "consultas demais… a página continua tentando", e a página passa a
      esperar 15 s;
    - "o deploy está recriando os containers — é normal nesta etapa";
    - "sem conexão com o painel";
    - ou o motivo da falha;
  - a página faz uma consulta a menos por ciclo: o log do deploy já vem na
    lista de deploys;
  - durante o deploy, se o Docker não responde à listagem, o servidor responde
    "em deploy" em vez de erro;
  - erro de ação (deploy, parar, iniciar, remover) fica num quadro vermelho
    com botão de fechar e não some sozinho.

## Decisões
- **Entrada no modelo do projeto:** reutiliza `proxyService` e `proxyPort`,
  que já existiam como ajuste manual. Não foi criado campo novo.
- **Serviço que usa a rede de outro não pode ser a entrada.** O compose não
  aceita `networks` junto de `network_mode`, então o painel não conseguiria
  ligá-lo à rede dele. A entrada certa é o dono da rede.
- **Detecção antiga sem a lista:** a validação deixa passar, como antes, para
  não travar projetos existentes.
- **Saída com código 0** (tarefa que termina, como migração) não conta como
  falha.
- **Lógica nova em módulos próprios:** o diagnóstico e a lista de serviços
  ficam em arquivos separados com testes. O `engine.ts`, fora da cobertura, só
  chama esses módulos.
- **Limite de requisições:** não foi aumentado. O ajuste foi no lado da página,
  com menos consultas e espera maior quando o servidor pede pausa.

## Como testei
- TDD com o executor de comandos simulado:
  - `compose ps` em NDJSON e em array, logs com cores e caracteres de
    controle, healthcheck com e sem verificações;
  - limites de tamanho e falhas do próprio diagnóstico;
  - o deploy de compose inteiro com `run`/`runStream` simulados, conferindo
    que o `ps` usa os mesmos argumentos do `up`.
- Fixture com a ESTRUTURA do caso real, com valores de exemplo:
  - `packages/deploy/tests/fixtures/cassino-like.ts`;
  - `apps/web/tests/fixtures/compose-services.ts`.
- Tela, com Testing Library:
  - lista, explicação do network_mode, estados, troca e validação da entrada,
    "Ler o compose de novo" e o assistente;
  - consulta periódica com relógio simulado: 429, falha no deploy, painel fora
    do ar e erro de ação que fica.
- `pnpm -r --workspace-concurrency=1 --no-bail run test:coverage`:

  | Pacote | Antes | Depois |
  |---|---|---|
  | core | 50 | 50 |
  | web | 515 | 532 |
  | deploy | 341 + 5 falhas | 369 + 5 falhas |
  | mailer | 195 | 195 |
  | security | 167 | 167 |
  | server | 991 + 3 falhas | 999 + 3 falhas |

  - **As 8 falhas são as mesmas antes e depois.** São testes que falam com o
    Docker real, e o Docker desta máquina (WSL) não respondia: até
    `docker version` esgotava o tempo.
  - **Cobertura mínima conferida rodando sem esses testes:**
    - deploy: 96,47% de ramos (mínimo 95%);
    - server: passou nos mínimos.

## O que só dá para validar na VPS
1. Fazer o deploy do compose real e, se falhar, conferir que o log mostra o
   bloco "Por que falhou: serviço wallet" com as linhas do wallet e o
   healthcheck. A versão do compose da VPS deve devolver o `ps -a --format
   json` no formato esperado (NDJSON no 2.21 ou mais novo).
2. Visão geral → "Ler o compose de novo" (projeto antigo). Conferir:
   - os cinco serviços aparecem;
   - a explicação "o caddy atende dentro do wallet" aparece;
   - depois do deploy, o estado de cada container (saudável ou não saudável)
     aparece.
3. Durante um deploy longo, com a janela de detalhe aberta: o texto vermelho
   não deve mais aparecer. Se aparecer o aviso âmbar, anotar o texto: ele diz
   qual era a causa.
4. Alterar a entrada pela Visão geral: escolher outro serviço ou porta, salvar
   e fazer o deploy.

## Pendências e dúvidas
- **Proxy HTTPS próprio continua bloqueado.** O wallet publica 80/443 e tem
  um Caddy na rede dele. As portas aparecem como "conflita com o painel" e
  esse caso continua bloqueado pelos guardrails, como antes. O caminho
  continua sendo um compose.paas.yaml sem essas portas.
- **Limite de requisições:** o limite global de 200 por minuto por IP vale
  também para a página do painel. Se o aviso de "consultas demais" aparecer
  na prática, vale discutir um limite separado para as consultas de leitura
  do próprio painel.
