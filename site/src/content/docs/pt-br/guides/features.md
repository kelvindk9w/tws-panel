---
title: "Funcionalidades"
description: "O que cada módulo do TWS Panel faz: deploy, certificados, domínio do painel, e-mail, notificações, backups, segurança e terminal web."
sidebar:
  label: "Funcionalidades"
---

O que o TWS Panel faz, módulo por módulo. O [README](https://github.com/kelvindk9w/tws-panel/blob/main/README.pt-BR.md) tem a lista curta; aqui está
o detalhe de cada parte. Os exemplos usam valores fictícios (`example.com`, `203.0.113.10`).

> [!NOTE]
> **Idioma da interface.** O painel está disponível em português e em inglês ([como escolher](../getting-started/complete-guide.md#idioma-da-interface)). Esta página cita os rótulos em português, exatamente como aparecem na tela. Algumas mensagens que vêm do servidor ainda aparecem em português mesmo com a interface em inglês: resultados das verificações de saúde e de segurança, mensagens do deploy e da checagem de DNS, status do servidor de e-mail e observações do checklist de DNS, erros de certificado, alertas e detalhes da auditoria, registros de backup, os detalhes dos passos do roteiro e muitas mensagens de erro. Quando esta página cita uma delas, avisa.

- [Deploy de projetos](#deploy)
- [Portas dos containers](#portas)
- [HTTPS e certificados](#certificados)
- [Domínio do painel](#dominio-do-painel)
- [Domínio de aplicações](#dominio-de-aplicacoes)
- [E-mail](#email)
- [Notificações](#notificacoes)
- [Backups](#backups)
- [Segurança e monitoramento](#seguranca)
- [Terminal web](#terminal)
- [Roteiro "Deixe o painel pronto"](#roteiro)

<a id="deploy"></a>

## Deploy de projetos

**Origem do código.**

- Repositório git com branch configurável: público, ou privado com um token **somente leitura**
  (a tela ensina a gerar o token).
- Repositório escolhido numa lista, depois de conectar a sua conta do GitHub em
  **Configurações → Integrações**.
- Uma pasta que já está na pasta de projetos do servidor (útil com o painel no seu computador).

**Tipo detectado sozinho.**

- Site em HTML puro (`index.html` na raiz): vai para o ar como está.
- Projeto com build (`npm run build`) que gera um site estático (`out/`, `dist/`, `build/`).
- **Next.js com servidor** (SSR, rotas de API, middleware, ISR, imagens): o painel gera o Dockerfile fora do
  seu repositório, constrói a imagem (instalação congelada pelo lockfile, usuário comum, Node 22 por padrão) e
  roda o servidor. Veja o [guia de Next.js](nextjs.md), que explica quando usar o site estático, o servidor
  automático ou um Dockerfile seu.
- `Dockerfile`.
- `docker-compose`: o compose existente é **adotado**, sem ser reescrito. A tela lista todos os
  serviços, as portas, as dependências e o healthcheck, e mostra em qual serviço e porta o HTTP do
  painel chega.

**Domínio.**

- Endereço automático com HTTPS na hora ou o seu domínio, com o registro de DNS exato a criar. Sem
  domínio de aplicações, o endereço automático é `projeto.203-0-113-10.sslip.io`, que tem o IP da VPS
  no nome: a tela avisa em âmbar que serve para testar. Com o
  [domínio de aplicações](#dominio-de-aplicacoes), é `projeto-k3x9q.apps.example.com`.
- Endereços de sslip.io já criados levam o indicador discreto "contém o IP da VPS" (página do
  projeto e lista de domínios).
- **Vários domínios** no mesmo projeto: conectar, tornar principal e remover, valendo na hora.
  Conectar o domínio oficial ou torná-lo principal **não remove** o endereço automático (ele vira
  adicional). O endereço só sai se você o remover, ou se escolher "Meu domínio" no assistente de
  novo projeto: nesse caso, com o DNS ainda sem apontar para a VPS e o painel público, o painel
  mantém um endereço temporário como adicional.
- **Endereço temporário para testar.** Enquanto o DNS do domínio oficial propaga (pode levar horas),
  a página **Domínios** do projeto oferece **Adicionar endereço temporário para testar** quando
  nenhum domínio do projeto aponta para a VPS: é o `projeto-k3x9q.apps.example.com` com domínio de
  aplicações verificado, ou o `sslip.io` sem ele. Se o certificado do sslip.io não sair por causa do
  limite de emissão do Let's Encrypt, o caminho é um domínio ou subdomínio seu. Quando o oficial
  passa a funcionar, a página lembra de remover o temporário (sslip.io; se ele for o principal,
  primeiro use **Tornar principal** no oficial); o painel não remove nada sozinho. O endereço sob o
  domínio de aplicações não é marcado como temporário e não gera lembrete. Não é oferecido em painel local (`.localhost`).
- **Com e sem www.** O nome que você digita é o principal; o painel também orienta o **par**
  (digitou `example.com`, orienta o `www.example.com`; digitou `www.example.com`, orienta o
  `example.com`). A tela mostra, para cada nome, o tipo do registro, o nome como se escreve no
  provedor (`@` e `www`), o valor e um botão de copiar, e o que acontece se só um apontar. O par só
  **redireciona (308) para o principal**, então o site fica com um endereço só (melhor para o Google
  e para o login). **Verificar DNS** confere cada nome separadamente (aponta, não aponta, aponta para
  outro lugar, Cloudflare laranja); o par que falha é só aviso e nunca impede o principal. O painel só
  pede o certificado do par depois que o DNS dele aponta, e reconfere a cada 10 minutos: crie o
  registro quando puder e o redirecionamento nasce sozinho. Dá para desligar o par por domínio.
  `app.example.com` e `blog.example.com` não ganham par, e um nome que já é de outro projeto (ou do
  painel) nunca é tomado. Domínios como `example.com.br` e `example.co.uk` funcionam do mesmo jeito.
- Antes do primeiro deploy, o domínio responde "site em configuração". Projeto parado mostra uma
  página neutra de "temporariamente indisponível", em vez do erro cru do servidor. Essas duas
  páginas são servidas aos visitantes do seu site e são escritas em português.

**No dia a dia.** Cada projeto tem o seu menu: Visão geral, Deploys, Domínios, Git, Variáveis,
E-mail, Envios, Logs, Recursos, Backups e Configurações.

- **Aba Recursos.** Quanto processador, memória, disco e rede cada serviço do projeto usa, medido a
  cada minuto (veja [Monitoramento de recursos](#monitoramento-de-recursos)). Escolha **1 hora, 24 horas,
  7 ou 30 dias**: quatro gráficos do projeto inteiro, cada serviço com o valor de agora, a média e o pico, e a
  lista de reinícios e mortes por falta de memória com o horário e o atalho para a aba Logs.

- **Logs dos containers (aba Logs).** Mostra o que os containers do projeto escrevem enquanto
  rodam, sem entrar na VPS por SSH. É a forma de conferir, por exemplo, se a fazenda voltou bem
  depois de reiniciar a máquina. No topo, o estado de cada serviço: rodando ou parado, saudável ou
  não, quantas vezes reiniciou, desde quando está no ar (ou quando parou e com que código de
  saída). Abaixo, as linhas do log, mais antigas primeiro, cada uma com a hora e a marca de erro
  quando veio da saída de erro (`stderr`).
  Você escolhe o **serviço** (ou todos), quantas **linhas** (100 a 2000; o padrão é 200) e o
  **período** (últimos 15 minutos, 1 hora ou 24 horas). O campo de filtro procura só nas linhas
  que já estão na tela. **Atualizar automaticamente** vem ligado (a cada 10 segundos; dá para
  trocar o intervalo ou desligar), **Acompanhar o fim** mantém a rolagem na última linha (subir a
  rolagem o desliga) e **Copiar linhas** leva para a área de transferência o que está na tela.
  Se o projeto estiver parado, a aba avisa e mostra o que ele escreveu antes de parar; se o
  Docker não responder, diz isso em vez de mostrar uma lista vazia.
  **Segredos são escondidos em melhor esforço, não por garantia.** O painel troca por `[oculto]`
  os valores das suas variáveis do projeto (com 8 caracteres ou mais), a senha em endereços de
  conexão (`postgres://usuário:senha@servidor`), `Bearer` e `Basic` e campos como `password=` ou
  `token:`. Um segredo que o seu app escreve de outro jeito (partido em duas linhas, codificado,
  com outro nome de campo) pode aparecer. Trate o log como dado sensível e não deixe o app
  escrever senhas nele. Também ficam de fora da máscara: o valor **antigo** de uma variável que você
  trocou (o log velho ainda tem o valor de antes), valores com menos de 8 caracteres e maiúsculas
  diferentes das da variável. Ler logs não aparece na Auditoria, porque a aba atualiza sozinha. Um token
  de API com nível **Leitura** **não lê o valor das variáveis**, mas lê os logs dos projetos do seu alcance
  (mascarados em melhor esforço). A leitura tem prazo de 15 segundos (contando a consulta ao Docker; a máscara pode levar mais um quarto de segundo), cada sessão ou token faz no máximo 2 leituras ao mesmo tempo, os tokens
  dividem 4 das 6 vagas do painel (as outras 2 ficam para a sua sessão) e a tela avisa quando há
  leituras demais.

- **Logs do deploy em tempo real.** Se um compose falha, o log ganha um bloco "Por que falhou"
  (escrito pelo servidor, sempre em português) com as últimas linhas do serviço que ficou doente e as últimas verificações do healthcheck.
- **Variáveis de ambiente** cifradas no servidor e injetadas no deploy. A tela lista as variáveis
  que o compose pede, importa um `.env` e barra o deploy quando falta uma obrigatória.
  O `.env` que pertence ao repositório nunca é sobrescrito: as variáveis do painel vão para um
  arquivo separado, e o log do deploy explica o conflito.
- **Rede e proxy:** na mesma aba, um cartão mostra a sub-rede e o IP do Caddy na `paas-net` e os
  cabeçalhos com o IP do visitante, e o painel entrega `PAAS_PROXY_SUBNET` e `PAAS_PROXY_IP` ao app a cada
  deploy. Veja [IP real do visitante](real-visitor-ip.md).
- **Git:** repositório e branch editáveis; a tela mostra qual branch está de fato no ar.
- **Aviso de nova atualização.** O painel consulta o repositório (só leitura, sem baixar o código) e
  compara a ponta da **branch configurada do projeto** com o commit que o último deploy publicou. Se
  houver commit novo, aparece "Nova atualização disponível" na aba Git, no topo da página do projeto
  e no Dashboard (num indicador no cartão do projeto e numa lista dos projetos com atualização).
  Projetos que usam o mesmo repositório em branches diferentes (produção em `main`, sandbox em outra)
  são avaliados cada um na sua branch. **O painel nunca atualiza sozinho:** para atualizar o código,
  clique em **Deploy** (ele busca o código novo da branch e reconstrói o projeto). A consulta é
  repetida a cada poucos minutos e há o botão **Verificar agora** na aba Git. Se não for possível
  consultar (rede, token recusado, branch que não existe), a tela diz "não deu para verificar" e o
  motivo, e isso não significa que o código está atualizado. Projetos publicados antes deste aviso
  ficam "sem commit registrado" até o próximo deploy; projetos de upload ou de pasta do servidor
  não têm o aviso, e projetos parados só o mostram na aba Git (não no topo nem no Dashboard).
- **Múltiplos ambientes:** o mesmo repositório pode rodar mais de uma vez, em branches e domínios
  diferentes (produção em `main`, sandbox em outra branch), lado a lado na mesma VPS. Cada
  instância tem clone, imagem, containers e rede próprios; só o domínio precisa ser único.
- Um **Caddy central** cuida do SSL automático e do reload sem downtime, com suporte a WebSocket e
  conexões longas.

<a id="portas"></a>

## Portas dos containers

O botão **Portas**, no cartão Containers da Visão geral, abre duas abas:

- **Este projeto:** cada serviço com as portas internas e as publicadas no servidor
  (`127.0.0.1:8010 → 8010`). Dá para **trocar** a porta publicada, **publicar uma porta** num
  serviço que não tinha, **remover a publicação** ou **editar em lote**. A troca vale no próximo
  deploy.
- **Todos os projetos:** todos os containers do servidor e as portas em uso, com os conflitos em
  vermelho, busca e ordenação.

O painel recusa 80 e 443 (são do proxy), as portas do e-mail e do próprio painel, e as que outro
container já usa. Ao escolher "todos os endereços" (`0.0.0.0`), a tela avisa que a porta fica
aberta para a internet.

<a id="certificados"></a>

## HTTPS e certificados

Todo certificado é emitido e renovado sozinho pelo Caddy (Let's Encrypt, com o ZeroSSL de
reserva). A página **Certificados** mostra todos os endereços que o painel serve com HTTPS: o do
painel, os domínios de cada projeto e cada `mail.<domínio>`.

- Para cada um: a quem pertence, o modo (Automático ou Manual), o estado (Válido, Emitindo,
  Falhou, Vence em breve, Vencido), o emissor, a validade, a **próxima renovação esperada** e o
  **estado do alerta** (tudo certo, atenção ou crítico, com o motivo).
- **Alerta de renovação.** O Let's Encrypt parou de mandar e-mail de vencimento (junho de 2025),
  então é o painel quem avisa. As janelas são **proporcionais à validade do certificado**, e por
  isso valem para 90 dias (hoje), 64 dias (a partir de fevereiro de 2027), 45 dias (2028) e 6 dias:
  o Caddy renova quando falta **1/3** da validade; o painel avisa (atenção) quando falta **1/4**,
  isto é, quando a renovação já devia ter acontecido e não aconteceu, e fica crítico quando falta
  1/12 da validade (no máximo 7 dias, no mínimo 6 horas). Num certificado de 90 dias: renova com
  30 dias, avisa com 22,5 dias e é crítico com 7. Num de 6 dias: renova com 2 dias, avisa com 36
  horas e é crítico com 12 horas. O certificado próprio (manual), que não renova sozinho, avisa
  com 1/3 da validade (no máximo 30 dias) e de novo perto do fim.
- **Emissão falhando.** Se o log do Caddy mostra pelo menos 3 rodadas de tentativa falhando
  durante pelo menos 1 hora, o painel abre um alerta com a causa traduzida e o que fazer (um
  domínio novo, com o DNS ainda por apontar, não dispara alerta na primeira hora). Sem nenhum
  certificado por mais de 24 horas, o alerta fica crítico (o painel guarda quando a falha começou, porque lê só as últimas 24 horas do log). Se o log do Caddy não puder ser lido, o alerta fica como estava.
- Cada nome tem o seu alerta em **Alertas**, e o aviso fora do painel (Telegram ou e-mail, tipo
  "Certificados com problema") sai uma vez só. Vários nomes que passam a ter problema na mesma
  conferência viram **um** aviso. O alerta só some depois de duas conferências seguidas sem
  problema (a cada 30 minutos), e um alerta que você reconheceu não volta enquanto o problema durar.
- Quando a emissão falha, a página explica a causa provável em linguagem simples: DNS que não
  aponta para a VPS, nuvem laranja da Cloudflare, portas 80/443 fechadas, limite do Let's Encrypt
  ou registro CAA.
- **Tentar emitir agora** faz o proxy recomeçar a emissão sem esperar o intervalo entre tentativas.
- **Usar certificado próprio** (manual): cola-se o certificado e a chave; o painel confere o par
  antes de aceitar e avisa quando um certificado manual está perto de vencer.

<a id="dominio-do-painel"></a>

## Domínio do painel

Por padrão, o painel abre em `https://203-0-113-10.sslip.io`, um endereço com o IP da VPS no
nome. Em **Configurações → Domínio do painel** você troca por um domínio seu
(`painel.example.com`):

1. a tela mostra o registro A a criar;
2. **Verificar DNS** consulta o DNS público;
3. com o DNS certo, o painel responde nos dois endereços e emite o certificado;
4. com o certificado válido, **Abrir o painel pelo endereço novo**.

Opcional, já no endereço novo: **Desativar o acesso pelo IP**. Só é liberado com a página aberta
pelo domínio novo, o certificado válido e o domínio digitado para confirmar. Para voltar atrás por
SSH: `cd /opt/tws-panel && sudo ./scripts/reativar-acesso-ip.sh` (veja
[Recuperar o acesso](recover-access.md)).

<a id="dominio-de-aplicacoes"></a>

## Domínio de aplicações

Em **Configurações → Domínio de aplicações** você define um subdomínio seu (`apps.example.com`) para
os endereços automáticos dos projetos, sem o IP da VPS no nome:

1. a tela mostra **um registro curinga** a criar (`*.apps.example.com`, tipo A para o IP da VPS, com
   nuvem cinza no Cloudflare; AAAA só se o painel souber o IPv6 da VPS);
2. **Verificar DNS e salvar** consulta um nome aleatório sob a base (`paas-check-…`) no DNS público e
   **só salva** se ele chegar a esta VPS (proxy da Cloudflare ligado conta como "não aponta");
3. com a base verificada, o passo 3 do **Novo Projeto** gera `<projeto>-<sufixo>.apps.example.com`,
   e o sslip.io vira o **Endereço de teste**, com aviso.

Cada projeto tem a sua rota e o seu certificado: não há certificado curinga nem emissão sob demanda,
e um nome aleatório sob a base, sem projeto, não tem certificado. A base não pode ser o domínio do
painel, um domínio de projeto ou de e-mail, um IP, um nome de rede interna (`.local`, `.internal`…)
nem um serviço como sslip.io. Só existe um domínio de aplicações por painel. Trocar ou remover a base
não muda os projetos que já usam um endereço sob ela. O arquivo volta com o backup do painel, mas,
em uma VPS com outro IP, a base volta como **A conferir** até o registro ser atualizado (veja
[Restaurar em outro servidor](restore-new-server.md#dominio-de-aplicacoes)). Passo a passo e limites
do Let's Encrypt: [Guia, Parte 2](../getting-started/complete-guide.md#dominio-de-aplicacoes).

<a id="email"></a>

## E-mail

Um servidor de e-mail próprio na VPS (**Stalwart**: SMTP, IMAP e DKIM num só container), para os
seus projetos enviarem mensagens e para caixas como `contato@`.

**Domínios e DNS.**

- Cada domínio ganha o seu par de chaves **DKIM RSA 2048**.
- Um **checklist de DNS verificável** (A, MX, SPF, DKIM, DMARC e PTR) traz os valores prontos
  para copiar e confere cada registro no DNS público.
- **PTR em três níveis:** verde (nome reverso igual ao do servidor), azul (nome genérico do
  provedor que aponta de volta para o IP: funciona, mas é recomendado trocar) e amarelo (sem nome
  reverso válido). Para Contabo, Hetzner e Vultr a tela diz onde trocar no painel do provedor;
  para os demais, traz um texto pronto para abrir chamado.
- O certificado de `mail.<domínio>` é emitido pelo Caddy e instalado no servidor de e-mail pelo
  painel, que o renova sozinho.
- Recomendação da tela: usar um subdomínio só de envio (`envio.example.com`), para não desviar
  o e-mail que o domínio principal já recebe em outro lugar.

**Caixas.**

- Criar uma caixa gera as **credenciais prontas** para Outlook, Gmail, Thunderbird ou o celular.
  A senha pode ser digitada ou gerada pelo painel, e não é mostrada de novo.
- **Enviar e-mail de teste** a partir de qualquer caixa.
- **E-mail do projeto:** o projeto ganha uma caixa própria (ex.: `contato@loja.example.com`)
  com nome de exibição, e os valores `SMTP_*` e `MAIL_*` são injetados no deploy. Se o app usa
  outros nomes de variável, **Ligar às variáveis do projeto** entrega os mesmos valores com esses
  nomes. Em vez de criar uma caixa nova, dá para **usar uma caixa que já existe** no domínio (nada é
  apagado). E apagar o projeto não apaga a caixa nem as mensagens: o endereço fica livre para ser
  usado de novo.
- **Nome de exibição:** toda caixa pode ter um nome (opcional, até 80 caracteres) que aparece para quem
  recebe, no campo De (`From`). Informe ao criar (página do domínio ou aba **Caixas** do projeto) e
  altere depois em **Alterar nome de exibição**: só o nome muda, a senha, o 2FA, as senhas de app, os
  apelidos e as mensagens ficam como estão. Na caixa de envio do projeto o nome é o `MAIL_FROM_NAME`
  e a mudança vale no próximo deploy (o painel não faz deploy sozinho); em branco, vale o nome do projeto.
  Na aba **Variáveis**, se o compose exige variáveis de e-mail (`SMTP_HOST`, `SMTP_PASSWORD`,
  `SMTP_FROM`…), um aviso diz quais o e-mail do projeto preenche, leva ao cartão para ligá-lo e
  oferece **Ligar `SMTP_PASSWORD` ao valor `SMTP_PASS`** (só a ligação é guardada, nada é copiado).
  O que o e-mail não fornece, como `SMTP_SECURE`, continua manual: o aviso sugere `false` para a
  porta 587 (STARTTLS) e o atalho só adiciona a linha, sem salvar.

**Webmail.** Com um clique, `https://mail.<domínio>/` passa a abrir um webmail (**Roundcube**) em
português para ler, responder e enviar como a própria caixa. A sessão termina depois de 10
minutos sem uso, e 10 logins errados vindos do mesmo IP em 10 minutos bloqueiam esse IP por 1 hora, só no webmail.

**Envios** (`/mail/envios`): o que o servidor de e-mail está fazendo.

- **Fila agora:** cada mensagem ainda em tentativa, com o motivo da última falha e o que fazer.
  Botões **Tentar agora** e **Cancelar**.
- **Histórico:** entregues, recusadas, adiadas e canceladas dos últimos 30 dias (só metadados,
  nunca assunto nem corpo).
- **Volume:** gráfico dos últimos 14 dias, taxa de recusa e totais por projeto.
- **Saídas:** os e-mails que o app de cada projeto enviou por SMTP (de, para, hora, estado e o
  motivo do erro em linguagem clara, com os detalhes técnicos recolhidos). Cada projeto tem a sua
  seção **Envios**. O assunto e o corpo ficam **ocultos**: clique em **Exibir** (cada exibição fica
  no registro de auditoria, sem o conteúdo). Ficam guardados 14 dias (os dados da mensagem, 90),
  sem anexos, e **não entram nos backups do painel**. Só as caixas **de projeto** (o que o app
  envia) guardam assunto e corpo; webmail e caixas pessoais ficam só com de, para, hora e estado. Dá para não guardar assunto e corpo, por
  projeto ou para todos, na aba **Privacidade**.
- **Reputação:** consulta diária às listas de bloqueio (Spamhaus ZEN e DBL, SpamCop, Barracuda),
  com o ponto de teste de cada lista para nunca dizer "limpo" sem ter conferido. Aceita a chave
  DQS gratuita da Spamhaus.
- **Nota:** a nota de entregabilidade, de 0 a 100, com a lista do que está feito e do que falta (DNS, PTR,
  certificado, listas, tempo enviando, recusas, Google Postmaster Tools, Microsoft SNDS).

**Entregabilidade por padrão.** O servidor completa `Message-ID` e `Date` quando faltam, os
relatórios DMARC chegam na `postmaster@` (pelo endereço `dmarc@`), o PTR é um só para o servidor
inteiro e a saída é só por IPv4, de acordo com o SPF.

<a id="notificacoes"></a>

## Notificações

Avisos fora do painel, em **Configurações → Notificações**, pelo **Telegram**, por **e-mail** ou
pelos dois.

- **Telegram:** cria-se um robô no @BotFather, cola-se o token, manda-se `/start` e clica-se em
  Conectar. O token fica cifrado no servidor.
- **E-mail:** sai da `postmaster@` de um domínio do servidor de e-mail com o DNS conferido, para
  até 5 endereços.
- **O que avisa** (uma caixa por tipo): alertas de segurança, deploy que falhou e que voltou,
  certificados com problema, e-mail em lista de bloqueio, disco acima de 90%, backups que falharam
  ou atrasaram, lembrete da senha de backup e painel reiniciado (este começa desligado).
- As mensagens são curtas e não levam o IP da VPS nem o detalhe do alerta. A exceção são os
  avisos de certificado, que dizem o nome, a causa traduzida e o que fazer. Assuntos repetidos em
  10 minutos viram um resumo, e cada canal tem um limite de 20 avisos por hora.
- **Enviar teste** e um histórico dos últimos envios.

<a id="backups"></a>

## Backups

Em **Configurações → Backups** e na aba **Backups** de cada projeto.

**O que entra.**

- **Projetos:** depois de cada deploy, o painel olha os containers e sugere o que guardar.
  Bancos detectados pela imagem (PostgreSQL, MySQL, MariaDB, MongoDB, Redis) entram por dump.
  Volumes e pastas de upload e dados vêm marcados; caches, logs e `node_modules` vêm desmarcados.
  O código entra quando o projeto não vem do GitHub.
- **Painel:** contas, projetos cadastrados, configurações e chaves. A **cópia externa cifrada** do
  painel leva também os **certificados HTTPS e a conta do Let's Encrypt do Caddy** (o volume
  `paas_caddy_data`), para uma VPS nova não pedir tudo de novo (o Let's Encrypt limita a 50
  certificados novos por semana por domínio registrado). Como esses arquivos têm chaves privadas,
  eles **só** entram na cópia cifrada; a cópia da VPS, sem senha, e a externa sem cifra não os
  levam. Se o Caddy ainda não existe, ou a cópia dele falha, o backup do painel sai sem eles
  (a falha vira aviso).
- **E-mail:** o servidor de e-mail e o webmail. Tem backup **próprio e global** (todas as caixas de
  todos os projetos juntas), independente do backup de cada projeto. Na aba **Backups** de um projeto
  com e-mail ligado, aparecem duas seções separadas: **Backup do projeto** (banco e arquivos) e
  **Backup do e-mail** (selo Ativo, Em pausa, Desligado ou Servidor de e-mail indisponível;
  frequência, último backup, conferência externa, atalho para **Configurações → Backups → E-mail** e
  **Fazer backup do e-mail agora**). A tela só diz que o e-mail está protegido quando o selo é
  Ativo; nos outros estados avisa que ele **não** está sendo copiado e como resolver. Desativar o
  backup do projeto não desativa o do e-mail. Sem e-mail ligado, a seção do e-mail não aparece.

**Onde fica.**

- Arquivos `.7z`. Uma cópia fica **na VPS**, sempre.
- Outra pode ir para um **armazenamento externo**: Cloudflare R2 (recomendado) ou outro compatível
  com S3. **Testar e salvar** grava, lê e apaga um arquivo de teste antes de aceitar.
- A cópia externa é **cifrada** (AES-256, nomes dos arquivos também) com uma senha sua, ligada por
  padrão e que pode ser desligada. A tela sugere uma frase forte, oferece um **kit de recuperação**
  para baixar e lembra a cada 90 dias de testar a senha.
- Cada cópia externa é baixada de volta e conferida antes de as antigas serem apagadas.

**Quando.** Uma vez por dia, a cada 12 ou a cada 6 horas, a partir das 03:00 no fuso da VPS, com
o número de cópias que ficam na VPS e fora. **Fazer backup agora** a qualquer momento.

**Validar o backup do banco restaurando num banco temporário (no servidor de outro projeto).** Na
aba **Backups** do projeto, desligada por padrão: o backup continua como sempre. Por enquanto vale
só para **PostgreSQL**. Ligada, depois de cada backup o painel
restaura o banco num **banco temporário** que ele cria no servidor de banco de **outro projeto**
(por exemplo, a fazenda em sandbox), confere que cada tabela do backup existe e que o número de
linhas bate com o do backup, e apaga o banco temporário. É a prova de que o backup do banco
realmente restaura. Os dados **não ficam no ambiente de teste**: o banco do projeto de destino não
é alterado e o teste não deixa os dados de produção lá.

- **Atenção.** O teste copia dados reais de produção, que podem ser dados pessoais (LGPD), para o
  servidor de banco do destino: enquanto o teste dura, eles passam pelo disco e pelo log de
  transações (WAL) dele, e apagar o banco temporário no fim (também quando o teste falha ou passa do
  prazo) não garante que não sobrem vestígios nesses arquivos. Não ligue se o destino for
  compartilhado com terceiros.
  Para ligar, escolha o projeto de destino e digite o nome dele.
- **Só o banco.** Arquivos, volumes, variáveis e a configuração do projeto de origem nunca são
  restaurados. Também não são tocados os bancos, os usuários, os papéis nem as tabelas de sistema
  do servidor de destino. O painel só apaga o banco temporário que ele mesmo criou e registrou
  (nome `tws_rc_` mais 16 letras e números sorteados); um banco seu com nome parecido nunca é apagado.
  O backup vem de outro projeto e é tratado como não confiável: ele é restaurado por um **papel
  descartável sem privilégios** (criado e apagado junto com o banco temporário), nunca com a
  credencial de administrador. Por isso, extensões que exigem superusuário fazem o teste falhar, com
  motivo próprio, e um backup com comandos do cliente `psql` (barra invertida) é recusado.
- **Quem pode ser destino.** Outro projeto, com banco PostgreSQL já detectado, em execução, e que
  não faça um teste próprio. O destino precisa de uma credencial de administrador (superusuário, ou com
  CREATEDB e CREATEROLE) e de espaço em disco para o backup; sem a permissão, o resultado
  diz que é problema de permissão. O nome do banco do destino não importa.
- **MySQL, MariaDB e MongoDB.** Ainda não disponíveis: a opção aparece com o motivo "ainda não
  disponível para este motor de banco". Ficam para uma próxima etapa.
- **Quando.** Após cada backup (padrão) ou, no máximo, uma vez por dia ou por semana. **Testar
  agora** roda o teste com o último backup, com a mesma confirmação digitada. Se a cópia externa
  falhar, o painel testa a cópia da VPS mesmo assim.
- **Segurança.** O banco do destino precisa estar em execução (o painel não liga nem reinicia nada),
  o destino não pode estar em deploy, e o teste espera a vez na fila dos backups, com prazo e
  checagem de espaço em disco. Se o destino for apagado ou renomeado, a opção se desliga e avisa.
- **Quando é "ok".** Só quando a restauração terminou sem nenhum erro (ela para no primeiro erro),
  todas as tabelas do backup existem no banco temporário e o número de linhas bate com o do backup.
  Backup cortado ou com erro, ou que o servidor de destino não aceita (por exemplo, uma extensão que
  falta), aparece como **falhou**, com o motivo curto. Um backup sem nenhuma tabela também falha.
- **Resultado.** A aba mostra "Último teste de restauração: ok em …, no projeto …", ou falhou, ou
  não executado, com o motivo curto e o que foi conferido; **Configurações → Backups** mostra um
  selo por projeto. Se o teste falhar, chega uma notificação de backup que falhou. Se o painel
  reiniciar no meio, um banco temporário pode sobrar no destino: o aviso diz isso e o painel o apaga
  ao iniciar e no próximo teste.

**Restaurar.**

- Por item (projeto, painel ou e-mail), escolhendo a data e a cópia (VPS ou externa).
- Para confirmar, você digita a palavra que a tela pede: o nome do projeto, no caso de um projeto;
  para o painel e para o e-mail, uma palavra fixa que depende do idioma da interface: `painel` e
  `e-mail` em português, `panel` e `email` em inglês. A tela mostra a palavra em fonte de código, com
  botão de copiar, e diz que é a palavra literal (`e-mail` não é o seu endereço de e-mail). Maiúsculas e
  minúsculas não importam. As outras confirmações do painel (recomeçar o assistente, desativar o acesso
  pelo IP) têm o mesmo formato.
- **Restaurar de outro servidor:** numa VPS nova, conecta-se o mesmo armazenamento, informa-se a
  senha e o painel lista o que existe, na ordem certa. Passo a passo:
  [Restaurar numa VPS nova](restore-new-server.md).
- **Restaurar o banco de um arquivo.** Na aba Backups do projeto, **Restaurar de um arquivo** envia um
  dump do seu computador para o banco do projeto (útil para trazer dados de outro lugar).
  - **Formatos:** PostgreSQL (`.sql`, `.sql.gz` e `pg_dump -Fc`, `.dump`/`.backup`), MySQL/MariaDB
    (`.sql`, `.sql.gz`), MongoDB (`mongodump --archive`, com ou sem gzip por fora) e o `.7z` de backup do
    próprio painel (se estiver cifrado, a tela pede a senha). O painel reconhece o formato pelos
    primeiros bytes, não pela extensão, e recusa o que não serve: `.zip` (descompacte antes), arquivo
    de outro tipo de banco, gzip corrompido, SQLite e binário que não é dump. O arquivo é lido por
    inteiro e o painel bloqueia os **comandos do cliente do banco**: no SQL do PostgreSQL, os do `psql` que
    começam por barra invertida (`\copy`, `\i`, `\!`...); no SQL do MySQL/MariaDB, `\!`, `system`,
    `source`, `pager`, `tee` e `edit` (o cliente ainda roda com `--binary-mode`). **Isso não torna o dump
    inofensivo:** o SQL do arquivo roda com o usuário administrador do banco e pode fazer qualquer coisa que
    esse usuário faça, então envie só dumps de origem confiável. Num dump do MySQL/MariaDB, `USE`,
    `CREATE DATABASE` (`mysqldump --databases` e `--all-databases`) e comandos sobre contas ou sobre os
    bancos `mysql`/`sys` são recusados para evitar erro (restaurar por cima do banco errado); é uma proteção
    contra engano, não uma barreira de segurança. Gere o dump de um único banco
    (`mysqldump NOME_DO_BANCO`). No MongoDB, `admin`, `config` e `local` nunca são restaurados e um arquivo de
    um banco só com outro nome vai para o banco do serviço. `mongodump --gzip` (gzip dentro do archive)
    não é suportado.
  - **Arquivos grandes:** o arquivo é gravado em disco aos poucos em `/data/uploads/restore` (volume do
    painel), sem guardá-lo inteiro na memória e sem usar o `/tmp`. O tamanho máximo é **10 GB** por padrão e muda com
    `PAAS_UPLOAD_RESTORE_MAX_BYTES` (em bytes, no `.env`). O painel confere o espaço livre antes e
    durante o envio e apaga o que recebeu se algo falhar. A tela mostra a porcentagem e tem **Cancelar**.
    Um envio parado por 5 minutos sem nenhum dado é interrompido, o painel recebe no máximo 3 envios ao
    mesmo tempo e cada projeto guarda até 2 arquivos esperando (um envio novo substitui o mais antigo; a
    tela lista os esquecidos e deixa descartá-los). Do backup `.7z` do painel sai só o dump escolhido, depois
    de conferir que ele cabe no disco.
    O arquivo enviado é apagado ao fim da restauração (com sucesso ou não), ao cancelar e, se sobrar
    algum, depois de 24 horas.
  - **Proxy:** o Caddy do painel não limita o tamanho do corpo nem o tempo do envio, então nada precisa
    ser ajustado nele. Se o domínio do painel passa pelo proxy da Cloudflare (nuvem laranja), o plano
    gratuito aceita só cerca de 100 MB por envio: para dumps maiores, deixe o registro do painel só em DNS
    (nuvem cinza) ou envie por um domínio sem proxy.
  - **Segurança:** pede a senha do painel, o código do 2FA (e o código por e-mail, se você ligou) e que você
    digite o nome do projeto. Token de API não faz isso. Você escolhe entre **Não fazer backup**
    (sugerido em projeto de desenvolvimento) e **Backup completo do projeto antes** (padrão); se o
    backup falhar, nada é restaurado. A restauração do PostgreSQL é tudo ou nada (uma transação).
  - **Limpar o banco antes:** vale para o dump `pg_dump -Fc` (`--clean --if-exists`) e para o MongoDB
    (`--drop`). Em SQL puro, quem apaga é o próprio arquivo: gere-o com
    `pg_dump --clean --if-exists --no-owner --no-acl`.
  - Os containers da aplicação ficam parados durante a restauração e voltam no fim. Se o próprio painel
    reiniciar no meio, eles continuam parados: ligue o projeto de novo. A saída do restaurador (limitada,
    inclusive quando falha) aparece na tela, com botão de copiar. Dono e permissões de um `.sql` do
    PostgreSQL não são filtrados: se aparecer `role ... does not exist`, gere o dump com
    `--no-owner --no-acl`.
- Sem conseguir entrar no painel, por SSH:
  `cd /opt/tws-panel && sudo ./scripts/restaurar-painel.sh /root/ARQUIVO.7z`.

**Depois de restaurar o painel de outro servidor.** Vale para a restauração pela tela, não para o
`restaurar-painel.sh`.

- **A agenda dos projetos e do e-mail fica em pausa por até 7 dias.** O painel restaurado traz de
  volta a agenda antiga, mas a VPS nova ainda não tem os dados. Por isso cada projeto cadastrado
  antes da restauração, e o e-mail, ficam sem backup agendado até a pausa acabar: quando você
  restaura os dados daquele item, quando faz um backup dele à mão, ou sozinha, depois de 7 dias. As
  telas mostram o motivo, uma mensagem que começa com "Em pausa", no lugar de "Próximo: …". Na mesma
  VPS, o que já tem containers não entra em pausa, e o e-mail só fica de fora da pausa se o
  container dele existir nesta VPS. Projeto criado depois da restauração não é pausado, e o painel também não.
- **Um painel novo não sobrescreve os backups de outro servidor.** O backup agendado do painel não
  sai enquanto tudo isto for verdade: nenhum projeto cadastrado, painel não restaurado, nenhum backup do painel nem do
  e-mail **enviado ao armazenamento** por esta VPS (a cópia só na VPS não conta), e o armazenamento já guarda backups do painel em `_painel/`. A pausa acaba
  sozinha 7 dias depois de o armazenamento ser conectado, e o painel manda uma notificação quando ela
  começa. Se o painel não conseguir listar o armazenamento, também não envia o backup, e uma
  notificação avisa na terceira falha seguida. **Fazer backup agora** sempre funciona.
  No roteiro "Deixe o painel pronto" (passo 6), o card "O que falta" mostra os dois caminhos quando o
  armazenamento já guarda backups de outro painel: restaurar o painel antigo (para continuá-lo) ou,
  se este é um painel novo, fazer o primeiro backup à mão em Configurações → Backups. Atenção: a partir
  do primeiro backup, a retenção apaga as cópias mais antigas da pasta (mantém só as mais novas; o
  padrão é 5), inclusive as do painel antigo; para guardá-las, baixe-as antes de fazer o primeiro
  backup ou use outro bucket ou pasta.
- **O endereço e as chaves do armazenamento ficam os que estão em uso nesta VPS.** O resto das
  configurações de backup volta com o painel.

<a id="monitoramento-de-recursos"></a>

## Monitoramento de recursos

O painel mede a VPS e cada projeto **uma vez por minuto**, sem programa extra (sem Prometheus, sem agente): ele lê os
números que o próprio kernel do Linux já mantém (`/proc` e os cgroups dos containers). O que você vê:

- **Dashboard, faixa "Saúde da VPS".** Seis cartões: **Processador**, **Memória**, **Disco**, **Rede**, **Projetos**
  (quantos rodam e quais têm problema) e **Proteções** (certificados e backups). Cada um tem um selo
  (**Normal**, **Atenção**, **Crítico** ou **Sem dados**, sempre com ícone e texto, nunca só a cor), o valor de agora
  e um gráfico pequeno das últimas 24 horas. **A memória mostra o que está disponível, não "% usada"**: o Linux
  enche a memória livre de cache de arquivo de propósito, então memória "cheia" é normal; o que importa é a
  pressão (processos esperando memória), o swap e as mortes por falta de memória. O cartão do processador também mostra
  a parte **tomada pelo provedor** ("steal"), sinal de servidor físico disputado. O cartão do disco diz "enche em cerca de X a Y dias"
  quando há pelo menos 7 dias de histórico crescendo.
  Um serviço que estoura o **próprio limite de memória** aparece como morte por falta de memória no projeto e no alerta dele;
  só vira aviso da VPS quando a máquina inteira estava sem memória.
- **Sem dados não é zero.** O que não foi medido aparece como "sem dados" (ou fica fora do gráfico). Se o painel não
  consegue ler os arquivos do servidor, ele diz isso na tela.
- **Alertas, ligados por padrão**, cada um com dois limiares (um para disparar e outro, mais folgado, para voltar ao
  normal), para um valor que oscila perto do limite não abrir e fechar alertas o dia todo: memória sob pressão (20% por 5 minutos,
  volta com menos de 10% por 15), processador no limite (50% de pressão por 15 minutos), processador tomado pelo provedor (10% por 30
  minutos, volta com menos de 5% por 60), disco lento, falta de inodes (90%, volta com menos de 85%), processo morto por falta de
  memória (na hora), container que reinicia mais de 3 vezes em 15 minutos e container que não passa na verificação de
  saúde por mais de 5 minutos. Aparecem em **Alertas** (origem "recursos") e saem pelas notificações (tipo **Recursos da
  VPS**, que dá para desligar em **Configurações → Notificações**). O aviso de disco cheio (90%) continua sendo o que já existia.
  Cada alerta de serviço traz o detalhe (qual serviço, qual verificação falhou, estado, código de saída e desde quando) e
  fica ligado ao projeto: a **Visão geral** do projeto lista os alertas abertos dele, com o motivo ao abrir o item, e leva a
  **Alertas** já filtrado por esse projeto. **Serviço de execução única** (migração, carga inicial) que terminou com
  código 0 não é falha: aparece como "concluído (saiu com 0)", é contado à parte nos containers e não gera alerta. Vale
  somente quando outro serviço do projeto espera por ele com `condition: service_completed_successfully`. Serviço
  sem dependente que saiu, mesmo com código 0 (postgres e aplicações saem com 0 ao receber SIGTERM, num reinício da VPS ou
  num `docker stop`), conta como parado e gera o alerta "parou de rodar". Código diferente de 0 também alerta, com o código.
  A saída do healthcheck que aparece no detalhe tem os segredos do projeto mascarados.
- **Configurações → Recursos da VPS.** O estado da coleta, o espaço que o histórico ocupa e **por quanto tempo guardar**:
  dado por minuto **48 horas** (de 24 a 168), médias por hora **90 dias** (de 7 a 365), médias por dia **2 anos** (de 90 dias a
  5 anos). Reduzir um prazo apaga o excedente na hora (a tela pede confirmação). O dado por minuto **não** entra no backup do
  painel; as médias de hora e de dia entram.
- **Custo.** Medido com 15 containers: cerca de 12 ms de processador por coleta (0,02% de um núcleo) e cerca de 18 MB de disco
  com a retenção padrão. Com 45 containers: cerca de 30 ms (0,05% de um núcleo) e cerca de 47 MB. A meta é menos de 0,1% de um
  núcleo e menos de 50 MB; com muito mais containers, reduza a retenção em Configurações.

> [!IMPORTANT]
> **Modo reduzido.** Para ler o `/proc` e o `/sys/fs/cgroup` do servidor, o container do painel precisa de duas montagens
> **somente leitura** que o novo `docker-compose.yml` traz. Numa instalação existente elas só passam a existir quando o
> container é **recriado**, o que o comando de atualização de sempre já faz: `cd /opt/tws-panel && sudo git pull && sudo docker compose up -d --build`.
> Até lá o painel funciona em modo reduzido (um aviso aparece no Dashboard e em Configurações): processador, memória e disco
> da VPS saem do que o container enxerga, os containers vêm da API do Docker, e a rede da VPS e a rede e o disco de cada container
> podem faltar. [Nota de segurança](https://github.com/kelvindk9w/tws-panel/blob/main/SECURITY.md).

<a id="seguranca"></a>

## Segurança e monitoramento

- **Wizard de segurança:** varredura com **Lynis** e checagens próprias, nota antes e depois, e
  hardening em 8 fases idempotentes (atualizações, usuário, SSH, firewall, fail2ban/AppArmor,
  minimização, auditoria e endurecimento adicional), com simulação e backup de cada arquivo. As
  fases que mexem no acesso agendam um **rollback automático** de 5 minutos. Disponível também
  depois da instalação, em **Segurança → Verificar e aplicar proteções**. Guia: [Wizard de segurança](../getting-started/security-wizard.md).
- **Guardrails de deploy:** regras em 3 níveis (`block`, `warn`, `info`) — porta de banco
  exposta, credenciais fracas, serviço de dev em produção, secret comitado e tag `:latest`. Um
  bloqueio só passa com override explícito e auditado. O compose também é conferido do jeito que o
  Docker o executa, contra uma lista do que é permitido (sem container privilegiado, sem
  `docker.sock`, sem bind fora da pasta do projeto, sem acesso às redes do painel). As regras que
  protegem o próprio painel não têm override.
- **Isolamento:** o painel, o servidor de e-mail e os projetos ficam em redes Docker separadas, e o
  proxy só confia nos cabeçalhos repassados pelo Caddy. Detalhes em
  [Migração de redes](network-migration.md).
- **Monitoramento:** um baseline registra pacotes, portas e hashes de arquivos críticos; as
  varreduras recorrentes comparam com ele, e cada mudança vira alerta.
- **Central de alertas** e **log de auditoria** das ações sensíveis.
- **Saúde da máquina:** CPU, memória, disco e rede.
- **Login:** conta de administrador com senha forte (argon2id), sessões revogáveis e limite de
  tentativas. **Verificação em duas etapas** (código de 6 dígitos de um app autenticador) com 10
  códigos de recuperação.

Detalhes do modelo de segurança, inclusive o que o painel **não** protege:
[Segurança](../reference/security.md).

<a id="terminal"></a>

## Terminal web

Ele fica em **Menu → Terminal**. Depois da instalação vem desligado: para usar, clique em
**Habilitar terminal** e confirme com a senha e o segundo fator.

Um terminal real do servidor dentro do painel (xterm.js + WebSocket + PTY), numa janela recolhida
por padrão. No wizard, ele fica bloqueado até o setup token ser validado, e as varreduras e fases
do hardening rodam dentro dele: você vê os comandos de verdade, como faria por SSH.

Na instalação você escolhe com qual usuário ele abre e como roda o que precisa de root (`senha`,
pelo `sudo`, ou `segundo-plano`, registrado na Auditoria). O backend faz relay puro do PTY e
nunca lê, registra ou guarda o que você digita; só audita conexão e desconexão. Veja
[o que cada escolha significa](../getting-started/installation.md#terminal-do-painel).

<a id="roteiro"></a>

## Roteiro "Deixe o painel pronto"

No Dashboard, um cartão lista o que ainda falta configurar depois da instalação, com o estado de
cada passo calculado a partir do estado real do painel. Cada passo tem um "Como fazer" e o botão
que leva à tela certa. Um passo que já começou mas ainda falta algo fica "em andamento" e mostra, fora do "Como fazer", uma caixa âmbar **O que falta** com o que fazer e o botão da tela certa; no topo do cartão, uma linha resume quantos passos precisam de atenção, com um link para cada um. Os passos opcionais aceitam "Não vou usar". O roteiro inteiro fica também
em **Configurações → Primeiros passos**. A lista dos passos está no
[README](https://github.com/kelvindk9w/tws-panel/blob/main/README.pt-BR.md#depois-de-instalar).
