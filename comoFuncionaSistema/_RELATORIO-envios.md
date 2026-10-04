# Relatório — página Envios (04/10/2026)

Branch `feat/envios` (a partir de `origin/dev`). Repositório público: nada aqui tem IP
real, senha, chave ou nome de cliente. `203.0.113.10`, `exemplo.com.br` e `envio.test`
são valores de exemplo.

## O pedido

O dono do produto quer acompanhar o que o servidor de e-mail faz: o que está na fila,
o que foi entregue ou recusado e por quê, quanto cada projeto envia, se o IP está em
lista de bloqueio e o que falta para as mensagens chegarem à caixa de entrada.

## O que mudou (pelo comportamento)

### Menu e página

- No menu, logo depois de **E-mail**, há **Envios** (`/mail/envios`). Em Envios só ele
  fica marcado; na página de um domínio, só E-mail. A página tem um link de volta para
  E-mail. A página E-mail em si não foi mexida.
- Cinco abas, guardadas no endereço (`?aba=historico`, `volume`, `reputacao`, `nota`),
  para dar para mandar o link. No celular (390 px) nada passa da largura da tela
  (conferido no navegador nas cinco abas).

### Fila agora

- Cada mensagem que o servidor ainda tenta entregar: destino com o estado (Aguardando,
  Adiada, Entregue, Recusada), quem enviou (projeto e caixa, "caixa do sistema" ou
  "aviso do próprio servidor"), quantas tentativas, a próxima, quando o servidor desiste
  e o motivo da última falha. Para códigos conhecidos aparece o que fazer (S3150 da
  Microsoft → sender.office.com; 4.7.28 do Gmail → reputação; TSS04 do Yahoo; 5.1.1 →
  endereço não existe).
- **Tentar agora** pede confirmação e avisa que é a **última tentativa** (ver "Achado"
  abaixo). **Cancelar** pede confirmação e avisa que o remetente não recebe aviso. As
  duas vão para a Auditoria (`mail.queue.retry`, `mail.queue.cancel`); o cancelamento
  aparece no Histórico como "Cancelada".

### Histórico

- Entregues, recusadas, adiadas e canceladas dos últimos 1, 7, 14 ou 30 dias, com a
  resposta do servidor do destinatário e o nome dele. Filtros por estado, projeto (ou
  "sem projeto"), caixa e domínio de destino, e busca por endereço, motivo ou servidor.
- Só metadados: remetente e destinatário do envelope, resultado, código, resposta
  (limitada a 300 caracteres) e servidor. Nunca assunto nem corpo. 30 dias guardados.
- Se a leitura do registro falhar (ex.: servidor de e-mail não criado), a aba diz o
  motivo.

### Volume

- Gráfico de barras dos últimos 14 dias (entregues, adiadas, recusadas, canceladas),
  feito em HTML, sem biblioteca: cada barra tem rótulo para leitor de tela, recebe foco
  pelo teclado e mostra os números do dia ao passar o dedo ou o mouse; há legenda e
  "Ver como tabela". Os dias seguem o fuso do navegador.
- Taxa de recusa (saudável até 2%) e de destinatários com adiamento (referência do
  painel: até 5%), com destaque vermelho quando passam. Reclamações (marcar como spam)
  aparecem como "sem dado": o servidor não recebe isso; a página manda para o Postmaster
  Tools (saudável abaixo de 0,1%). Com menos de 50 envios, um aviso de que a taxa oscila.
- Totais por projeto.

### Reputação (listas de bloqueio)

- **Agora roda de verdade**: uma vez por dia e no botão **Conferir agora** (no máximo
  um por minuto). Listagem cria o alerta na central de Alertas, como antes deveria.
- Cada lista aparece como **Limpo**, **Listado** (com "Pedir remoção") ou **Não deu para
  verificar** (com o motivo e "Conferir no site"). Nunca aparece "limpo" para o que não
  foi verificado: cada lista é consultada junto com o ponto de teste oficial dela
  (127.0.0.2; na Spamhaus DBL, dbltest.com), e se o teste não responde, o resultado não
  vale.
- Campo da **chave DQS gratuita da Spamhaus**: guardada no servidor (arquivo 0600),
  nunca volta para a tela (só "termina em xxxx"), não vai para a Auditoria; "Apagar
  chave". Com ela, a Spamhaus passa a responder de dentro da VPS.
- A **Barracuda** só responde a servidores DNS cadastrados nela: sem cadastro, aparece
  "Não deu para verificar" com o texto explicando e o link do site.
- O card da página Segurança usa a mesma conferência (com a chave e o resultado guardado).

### Nota de entregabilidade

- "Prontidão para a caixa de entrada", de 0 a 100, com faixa (85+ verde, 60–84 amarelo,
  abaixo vermelho) e a lista do que está feito e do que falta, cada item com pontos, o
  que o painel viu, o que fazer e link: DNS (6/6), PTR personalizado (10) ou genérico
  (5), certificado, listas de bloqueio, aquecimento (dias enviando), recusas e
  adiamentos em 7 dias, Google Postmaster Tools, Microsoft SNDS, taxa de spam e
  relatórios DMARC (sempre "não deu para verificar": o painel ainda não os lê).
- A pessoa marca com data quando cadastrou o Postmaster Tools, o SNDS e quando conferiu
  a taxa de spam abaixo de 0,1% (vale por 30 dias). Links para os dois portais.
- Um servidor novo não chega ao verde antes de uns 30 dias enviando, de propósito (a
  pesquisa explica que é isso que causa o spam do começo).

## De onde vem cada dado

| Dado | Fonte |
|---|---|
| Fila | API de administração do Stalwart v0.11.8: `GET /api/queue/messages?values=1&limit=200` |
| Tentar agora / Cancelar | `PATCH` / `DELETE /api/queue/messages/{id}` (confirmados no código da tag v0.11.8 e num Stalwart real) |
| Histórico e volume | Registro do container (`docker logs --since … paas-stalwart`), lido a cada 5 min e ao abrir a aba |
| Remetente → projeto | Caixas e projetos que o painel já guarda (`data/mail/mail.json`) |
| Listas de bloqueio | Consultas DNS do próprio servidor (resolvedor do sistema), com ponto de teste e DQS |
| DNS, PTR e certificado da nota | A verificação de DNS e o estado do certificado que a página E-mail já usa, refeitos uma vez por dia junto com as listas |
| Postmaster, SNDS, taxa de spam | Marcados pela pessoa |

### Por que o histórico vem do registro

Pesquisado no código da tag v0.11.8:

- **Histórico de rastreio do Stalwart** (`tracing.history`, API `/api/telemetry`): é
  recurso da edição Enterprise (`#[cfg(feature = "enterprise")]` e checagem de
  licença). Fora.
- **Webhooks** existem na edição livre, mas exigiriam mexer no `config.toml` gerado
  (`packages/mailer/src/server.ts`, que é de outro agente nesta rodada) e abrir um
  caminho do container do Stalwart para o painel. Fica como evolução possível.
- **Avisos de entrega (DSN) nas caixas**: só chega aviso de falha (o de sucesso só
  quando o app pede), e cada projeto tem a sua caixa — daria recusas, nunca entregas.
- **API `/api/logs`**: só funciona com registro em arquivo, que o painel não configura.
- **Registro do container**: o painel já gera `[tracer.stdout] level = "info"`, e nesse
  nível cada resultado vira uma linha com os campos da tentativa (fila, remetente,
  destinatários). É barato (uma leitura incremental a cada 5 min, linha a linha, sem
  guardar a saída inteira), confiável para o que importa e não precisa mudar nada no
  servidor de e-mail. **Escolhido.**

Eventos lidos: `delivery.dsn-success` (entregue; a resposta do DATA vem da linha
`delivery.delivered`), `delivery.dsn-perm-fail` (recusada, inclusive a desistência
depois de dias) e `queue.rescheduled` (adiada; o motivo é a última falha da tentativa:
resposta do destinatário ou falha de conexão). Avisos do próprio servidor (remetente
vazio) ficam de fora. A leitura lembra a última linha lida (com as linhas do mesmo
segundo) e não duplica.

## Por que a checagem de blacklist nunca rodava

O gancho estava no plugin do Monitoramento (`routes/monitoring.ts`), que lia
`app.mailService`. Só que o serviço de e-mail é criado **dentro** do plugin de rotas do
e-mail, e o Fastify isola cada plugin: no Monitoramento, `app.mailService` era
`undefined`. O gancho lançava erro, o scan o tratava como "melhor esforço" e o engolia
em silêncio. (Além disso, o scan só chega ao gancho depois de coletar a linha de base
pelo host bridge.) Um teste novo prova a causa: um plugin irmão do de e-mail não enxerga
o serviço.

Correção: o gancho saiu do Monitoramento, e a conferência passou a ser agendada pelo
próprio plugin de e-mail, com o resultado guardado e o alerta indo para a central.

## Achado: "Tentar agora" do Stalwart 0.11.8 é a última tentativa

No código da tag (`management/queue.rs`), o pedido de "tentar agora" também faz
`if domain.expires > time { domain.expires = time + 10 }`. Conferido num Stalwart real:
a mensagem adiada, depois do "tentar agora" que falhou de novo, foi dada como não
entregue 10 s depois ("Queue rate limit exceeded") e o remetente recebeu o aviso de
falha. Por isso o botão confirma antes e diz isso com todas as letras. O Stalwart já
tenta de novo sozinho por até 5 dias; o botão é para quando a pessoa resolveu a causa.

## Decisões

- **Rotas e agendamentos dentro do plugin de e-mail** (`routes/mail-envios.ts`, chamado
  por `routes/mail.ts`), porque é o único lugar que enxerga o serviço de e-mail.
- **`mail-service.ts`**: só métodos novos (`enviosServerCreated`, `enviosQueue`,
  `enviosRetry`, `enviosCancel`, `enviosSenders`, `enviosBlacklistTargets`,
  `enviosDeliverabilityFacts`), todos com o prefixo `envios` para não colidir com o que
  o outro agente acrescentar. Nenhum método existente foi reescrito.
- **Id da fila como texto**: o JSON comum arredonda o número (o "tentar agora" acertaria
  outra mensagem ou nenhuma).
- **Adiamento conta destinatário, não tentativa**: um destino adiado cinco vezes conta
  uma vez na taxa.
- **Limite de adiamento 5%** é referência do painel (nenhum provedor publica); o de
  recusa (2%) e o de spam (0,1%) seguem a pesquisa.
- **Gráfico sem biblioteca**: barras em HTML com Tailwind; nenhuma dependência nova.
- **Nota com DMARC sempre "não verificado"**: ler os relatórios fica para depois; zero
  pontos é mais honesto que um palpite.
- **Fatos de DNS/PTR/certificado uma vez por dia**: a verificação consulta DNS público;
  refazer a cada abertura da aba seria caro.

## Como foi testado

TDD em todas as partes (teste escrito, visto falhar, depois implementado).

| Pacote | Antes | Depois | Observação |
|---|---|---|---|
| packages/core | 50 | 50 | só tipos |
| apps/web | 569 de 570 (1 tempo esgotado sob carga) | 585 de 585 | |
| packages/deploy | 394 | 394 | |
| packages/mailer | 205 (ramos 98,77%) | 295 (ramos 99,31%, linhas 100%) | mínimo 98% |
| packages/security | 167 + 2 arquivos falhando | igual | dependem de Docker com credencial do Docker Desktop, falham igual sem as mudanças |
| apps/server | 1061 + 1 falhando (PTY real) | 1143 + o mesmo PTY | sem o PTY, ramos 94,4% (mínimo 91%) |

- **Registro real**: subi um Stalwart v0.11.8 em Docker com um servidor SMTP de mentira
  do outro lado (respostas 250, 451 e 550, porta fechada, domínio sem MX) e capturei as
  linhas. Elas viraram os testes do leitor. Depois rodei o leitor do painel
  (`docker logs` + parser) contra esse container: entregue com a resposta do DATA,
  recusada 550, recusada sem MX, adiada 451 a cada tentativa, adiada por conexão
  recusada, e a desistência depois do "tentar agora".
- **API da fila real**: listagem com o id grande, `PATCH` (tentar agora) e `DELETE`
  (cancelar), e o 404 de mensagem que já saiu.
- **Listas de bloqueio**: os pontos de teste responderam como esperado a partir desta
  máquina (Spamhaus ZEN e DBL, SpamCop, Barracuda).
- **Servidor**: rotas com schema (ids inválidos, filtros fora do formato, corpo da chave
  e das marcações), auditoria sem a chave, leitura do registro com Docker simulado
  (cursor, duplicadas, linhas do mesmo segundo, retenção, erro), agendamento das duas
  rotinas com relógio simulado, e a prova da causa do bug.
- **Web**: cada aba, confirmações, erros, filtros (a consulta muda), gráfico e tabela,
  estados das listas, chave DQS, nota e marcações, menu.
- **Celular**: as cinco abas abertas a 390 px no navegador, sem rolagem lateral.

O container de teste foi removido depois.

## Como validar na VPS

1. Atualize o painel:

   ```bash
   cd /opt/tws-panel && sudo git pull && sudo git log --oneline -1 && sudo docker compose up -d --build
   ```

2. Abra **Envios** no menu. Na aba **Fila agora**, normalmente "A fila está vazia".
3. Em **E-mail → domínio**, mande um e-mail de teste para o seu Gmail. Espere uns
   segundos e abra **Envios → Histórico** (o botão Atualizar lê o registro na hora): deve
   aparecer "Entregue" com a resposta do Google ("250 2.0.0 OK … gsmtp").
4. Mande um teste para um endereço que não existe no seu domínio de outro provedor (ou
   `ninguem@nao-existe.invalid`): deve aparecer "Recusada" com o motivo.
5. **Volume**: as barras de hoje com os envios acima.
6. **Reputação**: espere 1 minuto depois de atualizar o painel (ou clique em Conferir
   agora). Sem chave DQS, é provável que a Spamhaus apareça como "Não deu para
   verificar" (a maioria das VPS usa servidor DNS que ela recusa). Cadastre a chave DQS
   gratuita, salve e confira de novo: deve virar "Limpo" (ou "Listado", com o link).
7. Conferir que roda sozinha: no dia seguinte, a data "Conferido em" muda sem clique.
   Pelo terminal, o arquivo também muda:

   ```bash
   sudo docker exec tws-panel ls -l /data/mail/reputacao.json /data/mail/envios/
   ```

   (Os dados do painel ficam no volume `paas_data`, montado em `/data` no container
   `tws-panel`.)
8. **Nota**: confira se DNS, PTR e certificado batem com a página E-mail; marque a data
   do Postmaster Tools e veja a nota subir.

## Pendências e dúvidas

- **Leitura do registro em produção**: o painel roda o `docker logs` pelo mesmo Docker
  que já usa para o Stalwart. Não testado no container do painel na VPS.
- **Primeira leitura**: pega até 30 dias do que o Docker ainda guardar do container; se
  o container do Stalwart for recriado, o registro anterior se perde (o que já foi lido
  fica).
- **Formato do registro** é o da v0.11.8; outra versão do Stalwart exige reconferir o
  parser (os testes usam linhas reais).
- **Chave DQS**: a forma das zonas (`<chave>.zen.dq.spamhaus.net`) segue a documentação
  pública da Spamhaus; não testei com uma chave real (não há chave no repositório, de
  propósito). Se a Spamhaus recusar a chave, a tela diz para conferir a chave.
- **Barracuda**: aqui ela respondeu ao ponto de teste a partir de um resolvedor
  residencial; numa VPS, a pesquisa indica que exige cadastro. A tela trata os dois casos.
- **Mensagem recusada antes da fila** (senha errada do app, remetente não permitido) não
  aparece: acontece antes do servidor aceitar a mensagem.
- **Link na página E-mail**: não editei `MailPage.tsx` (outro agente). Sugestão: um
  "Ver envios" no topo dela.
