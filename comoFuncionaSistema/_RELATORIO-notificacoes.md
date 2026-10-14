# Relatório — Notificações (07/10/2026, branch `feat/notificacoes`)

Item 4 da ordem combinada com o dono do produto: avisos fora do painel quando
algo precisa de atenção. Primeiro o Telegram, depois o e-mail; a pessoa escolhe
um, outro ou os dois. Comportamento e API em `notificacoes/` (index.json e um
JSON por fluxo).

## O que mudou (pelo comportamento)

- **Configurações → Notificações foi refeita** (`/settings/notifications`). Antes ela só dizia "aviso fora do painel ainda não existe". Agora tem:
  - **Cartão Telegram**, em três etapas:
    1. sem nada: passo a passo do @BotFather (`/newbot`, escolher o @, copiar o token) e o campo "Token do robô", com o olho para conferir o que foi colado;
    2. token conferido: o painel mostra o @ do robô, um link para abrir a conversa com ele e pede "Começar" (ou `/start`). Para grupo, basta adicionar o robô e mandar uma mensagem. O botão **Conectar** lê a última mensagem que o robô recebeu e mostra o nome da conversa para a pessoa conferir;
    3. conectado: "Conectado à conversa Fulano pelo robô @x", selo "Falta enviar o teste" ou "Testado em…", **Enviar teste** (azul) e **Desconectar** (pede confirmação e apaga o token).
  - **Cartão E-mail**:
    - com o servidor de e-mail do painel pronto (ligado e com um domínio de DNS conferido): mostra de onde os avisos saem (`postmaster@<domínio>`), o campo de até 5 endereços (um por linha ou separados por vírgula), **Salvar endereços**, **Enviar teste** e **Desligar e-mail**;
    - sem o servidor pronto: explica o que falta (não iniciado, sem domínio, DNS não conferido, parado), leva à página E-mail e lembra que dá para usar só o Telegram;
    - endereços salvos mas o servidor parou: avisa que os e-mails não vão sair enquanto isso não for resolvido.
  - **O que avisa**: uma caixa por tipo, salva na hora:
    - alertas de segurança (monitoramento e deploy barrado pelas regras);
    - deploy (falhou e voltou a publicar sem erro);
    - certificados HTTPS (não emitido, vencido, automático que não renovou, manual perto de vencer);
    - e-mail em lista de bloqueio;
    - disco quase cheio (acima de 90%);
    - painel reiniciado (começa desligado).
  - **Últimos envios**: data, canal, assunto, estado (Enviado / Falhou / Tentando de novo) e o motivo da falha. O conteúdo da mensagem não fica guardado.
  - A **verificação automática de segurança** (frequência em horas) continua na tela, no fim.
- **Como os avisos saem:**
  - Mensagens curtas em português: "TWS Panel: <assunto>", uma ou duas linhas e "Veja os detalhes no painel".
  - Link para a tela certa só quando o painel tem domínio próprio com certificado válido. O endereço `…sslip.io` tem o IP no nome e não vai na mensagem.
  - O detalhe de um alerta (portas, pacotes, IP listado) **não** vai na mensagem: só o título e a gravidade. IPs e nomes `…sslip.io` que aparecerem em qualquer texto viram "[IP oculto]" / "[endereço pelo IP]".
  - **Repetidos**: o mesmo assunto dentro de 10 minutos não gera outra mensagem; no fim da janela sai **um** resumo ("repetiu N vezes nos últimos 10 minutos").
  - **Limite**: no máximo 20 avisos por canal por hora. O que passa disso vira um resumo ("N avisos não foram enviados para não lotar") quando a hora libera.
  - **Falha**: falha temporária (sem internet, Telegram fora, servidor de e-mail parado) tenta de novo em 30 s, 2 min e 10 min (ou o tempo que o Telegram pedir). Falha definitiva (token inválido, robô bloqueado, endereço recusado) para na hora. Os dois casos ficam no histórico e no log, e nada derruba quem gerou o aviso.
  - E-mail em texto e HTML, remetente "TWS Panel" `<postmaster@domínio>`, sem pedir aviso de entrega (senão cada aviso deixaria uma mensagem na postmaster@).
- **Token do Telegram:** fica cifrado no disco do servidor, com chave própria. Nunca volta pela API e não aparece em auditoria nem em log.
- **Auditoria:** registra conectar, desconectar, testar, salvar e desligar o e-mail (só a quantidade de endereços) e mudar os tipos.
- **Roteiro de primeiros passos, passo 5:** deixou de ser "em breve".
  - A fazer: nenhum canal conectado.
  - Em andamento: canal conectado sem teste.
  - Feito: pelo menos um canal conectado e testado.
  - "Não vou usar" continua.
  - O "Como fazer" tem o passo a passo real e o botão "Abrir Notificações".

## Decisões

1. **Integração pelo menor acoplamento: ganchos, não chamadas diretas.**
   - O `AlertsService` avisa quem escuta quando grava um alerta **novo**; o `DeployService` chama um gancho ao terminar um deploy. Os dois são ligados ao serviço de notificações em `app.ts`.
   - Vantagem: toda origem de alerta que já existe (monitoramento, guardrail, blacklist, certificado manual 30/7 dias) vira aviso sem mexer em quem cria o alerta, e uma origem nova de alerta entra sozinha.
   - O "bump" de um alerta aberto (o monitor achando o mesmo problema de novo) **não** gera aviso. Isso já evita a enxurrada na origem.
2. **Serviço no escopo raiz.** `NotificationService` é criado e decorado em `app.ts`. O envio por e-mail é registrado pelo plugin de e-mail, porque só ele enxerga o `MailService`. É a lição do bug da blacklist que nunca rodava.
3. **Certificado automático e disco por "vigias" só de leitura** (a cada 6 h e a cada 15 min). Eles leem a lista da página Certificados e o espaço livre da pasta de dados, sem mexer no serviço de certificados (outro agente estava nos componentes de certificado). Cada problema repete no máximo uma vez a cada 24 h.
4. **Disco medido na pasta de dados do painel** (volume na VPS). É o disco que enche com builds e imagens; a leitura não precisa de acesso ao host.
5. **E-mail sai da postmaster@ do primeiro domínio com o DNS conferido** (mesma regra do passo 4 do roteiro). Sem DNS certo o aviso iria para o spam ou seria recusado. A senha da postmaster@ o painel já guarda; não precisou de caixa nem de segredo novo.
6. **"Feito" exige o teste.** Conectado sem teste ainda não garante que o aviso chega.
7. **Agrupamento, limite e novas tentativas ficam em memória.** É simples e sem fila em disco. Reiniciar o painel perde só a tentativa pendente (o histórico fica "tentando de novo").
8. **Conversa do Telegram = a da mensagem mais recente** que o robô recebeu. O nome aparece na tela para conferir. Se for a conversa errada, é só Desconectar e repetir.

## Como testei

- **Servidor** (sem rede, Telegram e SMTP simulados):
  - cliente do Telegram: getMe, getUpdates, sendMessage, erros 401/404/403/409/429/5xx, rede e tempo esgotado; o token nunca aparece na mensagem de erro; mais um teste com servidor HTTP local, sem dublê de `fetch`;
  - serviço: token cifrado em disco (o arquivo não contém o token), arquivos 0600, arquivo adulterado volta a "não configurado", status sem token, conectar antes do `/start`, teste com falha, e-mail indisponível e validação de endereços, tipos, agrupamento com resumo, limite por hora com resumo, nova tentativa com recuo (inclusive o tempo pedido pelo Telegram), falha permanente, canal removido com tentativa pendente, histórico de 50, mascaramento de IP, auditoria sem segredo;
  - rotas com schema: token mal formado, campo a mais, mais de 5 endereços, tipo desconhecido, 401 sem sessão, 500 genérico;
  - `MailService`: de onde sai o e-mail, o que falta quando não está pronto, envio sem DSN e com HTML, 5xx definitivo;
  - `DeployService`: gancho de falhou/voltou;
  - `AlertsService`: avisa só alerta novo, e uma falha de quem escuta não derruba o alerta;
  - roteiro: os três estados do passo 5.
- **Mailer:** mensagem multipart (texto + HTML, ASCII no fio) e `dsn: false`.
- **Web:** fluxo completo do Telegram (token → Conectar → Enviar teste → Desconectar), erros (token recusado, Conectar antes do `/start`, teste que falha), e-mail indisponível e disponível, tipos (salva na hora; com erro, volta a escolha), histórico e falha ao carregar. Conferido a 390 px com o Vite e a API simulada no navegador: sem rolagem lateral.
- **Suítes** (`pnpm -r --workspace-concurrency=1 --no-bail run test:coverage`):

  | Pacote | Antes | Depois |
  |---|---|---|
  | core | 54 | 56 |
  | web | 638 | 651 |
  | deploy | 418 de 423 (5 falhas do Docker) | 422 de 423 (1 falha do Docker) |
  | mailer | 339 | 342 |
  | security | 167 (+20 pulados) | 167 (+20 pulados) |
  | server | 1299 de 1304 (3 falhas do Docker) | 1414 de 1419 (as mesmas 3 falhas do Docker) |

  - As falhas dependem do Docker real da máquina (`docker-service`, `routes-misc-schema`, `engine-*`) e já falhavam antes. No deploy o número oscila entre rodadas.
  - Cobertura do servidor sem os dois arquivos que dependem do Docker: 98,19% das instruções, 95,21% dos ramos, 98,5% de funções e 99,01% de linhas, acima dos mínimos.
  - Os arquivos novos entraram na lista de cobertura do servidor.

## Passo a passo na VPS

Atualizar o painel:

```
cd /opt/tws-panel && sudo git pull && sudo git log --oneline -1 && sudo docker compose up -d --build
```

### Telegram

1. No celular ou no computador, abra o Telegram e procure **@BotFather** (selo azul de verificado).
2. Mande `/newbot`. Ele pede um nome (ex.: "Avisos do meu painel") e depois um @ que termine em `bot` (ex.: `avisos_meu_painel_bot`).
3. Ele responde com o **token**, uma linha como `123456789:ABC…`. Copie a linha inteira.
4. No painel: **Configurações → Notificações → Telegram**, cole no campo "Token do robô" e clique em **Salvar token**. Deve aparecer "Robô @… conferido".
5. Clique no link **Abrir @…**, toque em **Começar** (ou mande `/start`).
6. Volte ao painel e clique em **Conectar**. Confira se o nome que aparece é o seu (ou o do grupo).
7. Clique em **Enviar teste**. A mensagem "TWS Panel: Teste de notificação" deve chegar no Telegram, e o selo vira "Testado em…".
8. Como conferir: em **Últimos envios** aparece "Teste de notificação · Enviado". No Dashboard, o passo 5 do roteiro fica como feito.

### E-mail (opcional)

1. Precisa do passo 4 pronto: servidor de e-mail ligado e um domínio com **Verificar DNS** todo certo (página E-mail).
2. Em **Configurações → Notificações → E-mail**, informe até 5 endereços e clique em **Salvar endereços**.
3. Clique em **Enviar teste** e confira a caixa de entrada. No primeiro envio de um servidor novo costuma cair no spam: marque como "não é spam".

### Conferir um aviso de verdade

- **Deploy:** faça um deploy que falhe durante o build (variável obrigatória faltando não serve: essa é barrada antes de o deploy começar). Deve chegar "Deploy de X falhou". Corrija e publique de novo: chega "X voltou a publicar sem erro".
- **Painel reiniciado:** ligue o tipo "Painel reiniciado" e rode a linha de atualização acima. Ao subir, chega "O painel foi iniciado".

### O que só dá para validar na VPS

- O Telegram de verdade: getMe, getUpdates e sendMessage pela internet da VPS. Sem saída HTTPS para `api.telegram.org`, aparece "Não foi possível falar com o Telegram".
- O e-mail de verdade pelo Stalwart (submission 465 com a postmaster@) e a chegada na caixa.
- O disco medido pela pasta de dados (`/data`, volume `paas_data`) em vez da raiz da VPS. Se o Docker guardar os volumes em outro disco, a medida é a desse disco.
- Os certificados automáticos que não renovam: o vigia lê a página Certificados a cada 6 h. O primeiro giro sai 10 min depois de o painel subir.

## Dúvidas e o que ficou de fora

- **"Código por e-mail para recomeçar o setup"** (citado na ordem combinada como algo que as notificações destravam) **não** foi feito: não estava no pedido desta rodada. O envio por e-mail agora existe e pode ser reaproveitado (`MailService.sendSystemMail`); a tela de recomeçar ainda diz que o envio por e-mail não existe.
- O comentário do topo de `apps/server/src/services/onboarding.ts` ainda diz que o passo das notificações é "em breve". O pedido era mexer só em `notificationsState`, e outro agente estava no arquivo.
- O fixture `notifications: "soon"` continua em testes do roteiro e do Dashboard. É só um dado de teste e não representa mais o que o servidor devolve.
