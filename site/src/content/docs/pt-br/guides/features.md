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
- Antes do primeiro deploy, o domínio responde "site em configuração". Projeto parado mostra uma
  página neutra de "temporariamente indisponível", em vez do erro cru do servidor. Essas duas
  páginas são servidas aos visitantes do seu site e são escritas em português.

**No dia a dia.** Cada projeto tem o seu menu: Visão geral, Deploys, Domínios, Git, Variáveis,
E-mail, Backups e Configurações.

- **Logs do deploy em tempo real.** Se um compose falha, o log ganha um bloco "Por que falhou"
  (escrito pelo servidor, sempre em português) com as últimas linhas do serviço que ficou doente e as últimas verificações do healthcheck.
- **Variáveis de ambiente** cifradas no servidor e injetadas no deploy. A tela lista as variáveis
  que o compose pede, importa um `.env` e barra o deploy quando falta uma obrigatória.
  O `.env` que pertence ao repositório nunca é sobrescrito: as variáveis do painel vão para um
  arquivo separado, e o log do deploy explica o conflito.
- **Git:** repositório e branch editáveis; a tela mostra qual branch está de fato no ar.
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
  Falhou, Vence em breve, Vencido), o emissor, a validade e a data aproximada de renovação.
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
  nomes.

**Webmail.** Com um clique, `https://mail.<domínio>/` passa a abrir um webmail (**Roundcube**) em
português para ler, responder e enviar como a própria caixa. A sessão termina depois de 10
minutos sem uso, e 10 logins errados vindos do mesmo IP em 10 minutos bloqueiam esse IP por 1 hora, só no webmail.

**Envios** (`/mail/envios`): o que o servidor de e-mail está fazendo.

- **Fila agora:** cada mensagem ainda em tentativa, com o motivo da última falha e o que fazer.
  Botões **Tentar agora** e **Cancelar**.
- **Histórico:** entregues, recusadas, adiadas e canceladas dos últimos 30 dias (só metadados,
  nunca assunto nem corpo).
- **Volume:** gráfico dos últimos 14 dias, taxa de recusa e totais por projeto.
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
- As mensagens são curtas e não levam o IP da VPS nem o detalhe do alerta. Assuntos repetidos em
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
- **Painel:** contas, projetos cadastrados, configurações e chaves.
- **E-mail:** o servidor de e-mail e o webmail.

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
