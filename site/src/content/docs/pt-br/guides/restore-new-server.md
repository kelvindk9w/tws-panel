---
title: "Restaurar numa VPS nova"
description: "Traga tudo de uma VPS antiga ou perdida para uma nova usando os backups do armazenamento externo: o que você precisa, o que migra, a ordem dos passos, o DNS e as conferências finais."
sidebar:
  label: "Restaurar numa VPS nova"
---

Use este guia quando a VPS antiga foi perdida, invadida ou será substituída, e você quer o painel,
os projetos e o e-mail de volta numa VPS nova. Ele depende da **cópia externa** dos backups
(Cloudflare R2 ou outro armazenamento compatível com S3). Backups guardados só na VPS antiga somem
junto com ela.

> [!NOTE]
> **A interface do painel está sendo traduzida para o inglês.** Os nomes de telas, botões e mensagens citados aqui seguem a interface atual, em português, e podem mudar quando a versão em inglês for lançada.

A maior parte do tempo vai em esperar o DNS e a nova publicação dos projetos. Se a VPS antiga ainda
funciona, mantenha-a ligada até o último passo.

> [!IMPORTANT]
> **O que foi gravado ou recebido depois do último backup não migra.** Isso inclui registros de
> banco, arquivos enviados e e-mails recebidos entre o backup e o momento em que o DNS passa a
> apontar para a VPS nova. O passo 2 faz um backup final para deixar essa lacuna pequena.

## O que você precisa antes de começar

Guarde tudo isto **fora da VPS** (num gerenciador de senhas, por exemplo). Não dá para recuperar de
um servidor que você não tem mais.

| O quê | De onde vem | Se perdeu |
|---|---|---|
| **Senha dos backups** | O kit de recuperação que você baixou em **Configurações → Backups → Criptografia da cópia externa**. O painel também mostra a senha em **Ver a senha**, mas só num painel em que você ainda consegue entrar. | Não há atalho: sem a senha, ninguém abre as cópias externas. |
| **Endpoint e bucket do armazenamento** | O kit de recuperação lista o bucket e o endpoint. | No Cloudflare: R2 → seu bucket → Configurações → S3 API. |
| **Chaves de acesso do armazenamento** (ID da chave de acesso e Chave de acesso secreta) | Você as viu uma única vez, ao criar o token no Cloudflare. **Elas não estão no kit.** | Crie um novo token de API do R2 para o mesmo bucket ([Guia completo, Etapa 8.1](../getting-started/complete-guide.md#etapa-8)). Os arquivos antigos continuam legíveis. Veja o aviso do passo 5. |
| **Acesso ao domínio** | Seu provedor de DNS ou o registrador. | Recupere o acesso com o registrador. |
| **Acesso ao provedor** | O painel do provedor da VPS nova (para definir o PTR e liberar a porta 25). | — |

## O que volta e o que não volta

| Volta | **Não** volta (você refaz) |
|---|---|
| **Painel:** contas de administrador e verificação em duas etapas, projetos cadastrados, configurações, configurações de notificação e de backup, domínio do painel e as chaves que cifram os segredos (variáveis dos projetos, tokens). | O sistema operacional e o hardening dele: usuário, chave SSH, firewall. Rode a instalação e o wizard de segurança na VPS nova. |
| **Projetos do GitHub:** os bancos e as pastas que estavam marcados na aba **Backups** de cada projeto. O código é publicado de novo a partir do repositório. | O que **não** estava marcado na aba Backups do projeto, e arquivos gravados fora de volumes. |
| **E-mail:** caixas, mensagens, contas, regras e chaves DKIM, e a configuração do webmail. | Registros DNS, o PTR e o firewall do provedor. Eles apontam para o IP antigo. |
| | Certificados TLS: são emitidos de novo, quando o DNS apontar para a VPS nova. |
| | A reputação do IP de e-mail: um IP novo começa sem nenhuma. |
| | O código do projeto na data do backup: projetos do GitHub vêm da branch **atual** do repositório. |
| | **Projetos que não vêm do GitHub** (criados por upload ou a partir de uma pasta do servidor): este fluxo não os restaura. Veja [Projetos que não vêm do GitHub](#projetos-fora-do-github). |

## Passo a passo

Faça os passos 2 a 8 **sem uma pausa longa**. O painel antigo é parado no passo 2 e os serviços só
voltam à medida que você os restaura.

### 1. Prepare a VPS nova

Siga o [guia de instalação](../getting-started/installation.md) do Passo 1 ao Passo 8 e conclua o
assistente de configuração, inclusive a etapa de Segurança. A restauração precisa de um painel com
login, então crie uma conta de administrador provisória quando o assistente pedir. A restauração a
substitui pelas contas antigas.

Confira que as portas **80 e 443** estão abertas no provedor, e a **25** se você vai usar e-mail
(veja o [Guia completo, Etapa 6.1](../getting-started/complete-guide.md#etapa-6)).

### 2. Faça um backup final e pare o painel antigo

Pule este passo se a VPS antiga não existe mais. Caso contrário, no painel **antigo**, nesta ordem:

1. Em **Configurações → Backups**, clique em **Fazer backup agora** no cartão **Painel** e no
   cartão **E-mail**.
2. Abra cada projeto, vá à aba **Backups** dele e clique em **Fazer backup agora**.
3. Espere até que todos os backups mostrem "cópia externa conferida" em **Últimos backups**.
   Anote a data e a hora do backup do painel.
4. Só então pare o painel antigo, para que dois servidores não gravem no mesmo bucket (o painel
   restaurado traz de volta a mesma agenda de backup):

   ```bash
   cd /opt/tws-panel && sudo docker compose stop
   ```

A partir daqui, nada do que for gravado ou recebido na VPS antiga chega à nova, até o DNS apontar
para ela.

### 3. Conecte o mesmo armazenamento

No painel novo, abra **Configurações → Backups**. Em **Armazenamento externo**, informe o mesmo
endpoint, bucket e chaves de acesso que a VPS antiga usava. Região: `auto`. Clique em **Testar e
salvar**.

**O que conferir:** aparece "Conexão testada e salva".

> [!WARNING]
> **Não clique em Fazer backup agora no painel novo antes do passo 5**, e não mude as agendas. O
> backup automático do painel vem ligado de fábrica. Depois que a senha é definida (passo 4), a VPS
> nova pode enviar um backup de um painel **vazio** para a pasta `_painel/`, e a retenção (5 cópias, por padrão)
> apaga a mais antiga. A data mais recente da lista pode então ser a do painel vazio, e não a da VPS
> antiga.

### 4. Informe a senha dos backups

Ainda em **Configurações → Backups**, encontre o cartão **Restaurar de outro servidor** e clique em
**Começar**.

1. O passo 1 do cartão mostra o bucket conectado.
2. No passo 2, digite a senha dos backups que está no kit e clique em **Conferir e usar**.

**O que conferir:** o cartão aceita a senha. Se ele disser que não consegue conferir porque falta o
arquivo de verificação, você pode clicar em **Usar esta senha mesmo assim**. Se disser que a senha
não abre os backups, confira o kit de novo.

### 5. Restaure o painel primeiro

1. No passo 3, clique em **Ver o que existe no armazenamento**.
2. No bloco **Painel**, clique em **Restaurar o painel**.
3. Escolha a data do **último backup da VPS antiga**, a que você anotou no passo 2. Não presuma que
   a primeira data da lista é a certa. Confirme digitando `painel`.
4. Espere. O painel reinicia sozinho.

**O que conferir:** abra de novo o endereço da VPS nova (`https://203-0-113-10.sslip.io`, com o IP
novo) e entre com o usuário e a senha de administrador **antigos**, mais o código de duas etapas do
celular antigo. Volte a **Configurações → Backups → Restaurar de outro servidor**.

> [!WARNING]
> **As chaves do armazenamento voltam a ser as antigas.** As configurações de backup e as chaves
> delas voltam junto com o painel. Se você criou um token novo no passo 3 (porque perdeu as chaves,
> ou porque revogou o token antigo depois de uma invasão), o painel restaurado guarda as chaves
> antigas e o download dos projetos e do e-mail falha. Vá a **Configurações → Backups →
> Armazenamento externo → Editar**, informe as chaves novas de novo e clique em **Testar e salvar**,
> antes do passo 7. Se a VPS antiga foi invadida, revogue o token antigo no Cloudflare e troque as
> senhas (painel, caixas de e-mail, bancos, tokens do Git) depois da restauração.

> [!WARNING]
> **Se o painel antigo estava com o acesso pelo IP desativado**, essa configuração também volta. O
> painel novo passa a responder só no domínio do painel, que ainda aponta para a VPS antiga, e você
> não consegue entrar. Há duas saídas: apontar o registro A do domínio para o IP novo e esperar o
> DNS, ou rodar, na VPS nova, `cd /opt/tws-panel && sudo ./scripts/reativar-acesso-ip.sh` e usar o
> endereço `…sslip.io`. Para evitar o problema, troque o registro A do domínio do painel para o IP
> novo **antes** deste passo.

Se o painel não abre de jeito nenhum, restaure-o a partir de um arquivo:
`cd /opt/tws-panel && sudo ./scripts/restaurar-painel.sh /root/ARQUIVO.7z` (veja
[Operação](operations.md)).

### 6. Aponte o DNS para o IP novo

Faça isto enquanto restaura os projetos, porque o DNS leva tempo para se espalhar. Para cada
domínio, edite o registro **A** para o IP da VPS nova (no Cloudflare, nuvem cinza, "Somente DNS").
Isso vale para o domínio do painel e para o de cada projeto. Se puder, diminua o TTL antes.

### 7. Restaure os projetos

No bloco **Projetos** do cartão, clique em **Restaurar** ao lado de cada projeto.

- Um projeto com o aviso "Não cadastrado aqui: restaure o painel primeiro" indica que o passo 5 não
  terminou.
- Escolha a data e confirme digitando o nome do projeto.
- Numa VPS nova o projeto não tem containers. Mantenha marcado **Publicar do GitHub antes de
  restaurar**: o painel publica o projeto de novo a partir do repositório e depois devolve os bancos
  e as pastas. Pode levar vários minutos por projeto, e o painel espera até 45 minutos.

**O que conferir:** cada projeto abre no seu domínio e os dados estão lá. A página **Certificados**
mostra o domínio do projeto como **Válido**. O certificado falha até o DNS do passo 6 apontar para o
IP novo. Depois disso, use **Tentar emitir agora** nessa mesma página.

<a id="projetos-fora-do-github"></a>

#### Projetos que não vêm do GitHub

Projetos criados por upload ou a partir de uma pasta do servidor não são restaurados pelos passos
acima. O painel publica o projeto **antes** de devolver o código, e nesses projetos o código-fonte
era uma pasta da VPS antiga, então a publicação falha. O caminho alternativo, por projeto, com os
projetos já cadastrados (passo 5) e antes de clicar em **Restaurar** no passo 7:

1. Baixe do armazenamento (`TWS Panel Backups/<projeto>/`) o `.7z` do **último backup feito na VPS
   antiga** (o mesmo momento do backup do painel do passo 5) e abra-o com o 7-Zip, usando a senha
   dos backups. Tire dele o `codigo/codigo.tar` e leve-o para a VPS nova.
2. Descubra a **pasta de origem** do projeto (`<ORIGEM>` abaixo) na aba de configuração do projeto:
   a tela diz "Este projeto usa uma pasta do servidor (…)". Ela precisa ficar dentro da pasta de
   projetos da VPS nova (`PAAS_PROJECTS_DIR`, padrão `/opt/tws-projects`), a única pasta do host que
   o painel enxerga.
3. Ponha o código em `<ORIGEM>`, conforme o jeito que o projeto foi criado:
   - **Criado por upload** (o tar traz uma pasta chamada `src/`): extraia numa pasta temporária e
     copie o **conteúdo** de `src/` para a origem:

     ```bash
     sudo mkdir -p <ORIGEM> /tmp/x
     sudo tar -xf codigo.tar -C /tmp/x
     sudo cp -a /tmp/x/src/. <ORIGEM>/
     ```

   - **Criado a partir de uma pasta do servidor** (o tar traz uma pasta com o nome da própria
     pasta, por exemplo `meusite/`): extraia na pasta pai da origem:

     ```bash
     sudo tar -xf codigo.tar -C "$(dirname <ORIGEM>)"
     ```
4. Nos dois casos, entregue a pasta ao usuário do painel (ele roda como usuário 10001):

   ```bash
   sudo chown -R 10001:10001 <ORIGEM>
   ```
5. Clique em **Deploy** no projeto para publicá-lo.
6. Só então restaure os dados: aba **Backups** do projeto → **Restaurar**. A restauração devolve o
   código por cima da pasta mais uma vez.

> [!NOTE]
> Este caminho foi escrito pela leitura do código e não foi executado numa VPS real. Em especial,
> não confirmei se o painel recusa uma pasta de origem fora da pasta de projetos; ele apenas não a
> enxerga.

### 8. Restaure o e-mail por último

1. No cartão, clique em **Restaurar o e-mail** e confirme digitando `e-mail`. Se a restauração
   terminar com o aviso "O servidor de e-mail ainda não existe nesta VPS: abra a página E-mail e
   clique em Iniciar", abra **E-mail** e clique em **Iniciar servidor**. Ele sobe com os dados
   restaurados.
2. Atualize o DNS (página **E-mail** → o domínio → **Checklist DNS**):
   - o registro **A** de `mail.envio.example.com` para o IP novo;
   - o registro **SPF**, que contém o IP antigo (`ip4:`): copie o valor novo do checklist;
   - MX, DKIM e DMARC não mudam, porque os nomes e as chaves voltaram.
3. Peça ao provedor para definir o **PTR** do IP novo como `mail.envio.example.com`.
4. Confira que a porta 25 de saída está liberada ([Guia completo, Etapa 6.1](../getting-started/complete-guide.md#etapa-6)).

**O que conferir:** clique em **Verificar agora** até chegar a **6/6 OK**, envie um e-mail de teste
(Etapa 6.7 do guia completo) e veja **válido** no cartão do certificado do e-mail. Envie devagar no
começo: o IP novo ainda não tem reputação.

## Conferências finais

- O painel abre no domínio, com cadeado, e o login e a verificação em duas etapas funcionam.
- **Certificados** mostra todos os endereços como **Válido**.
- Todos os projetos abrem e têm os seus dados.
- **Os backups automáticos continuam ligados.** Abra a aba **Backups** de cada projeto e confira que
  o backup automático está ligado. A agenda restaurada pode tentar fazer backup de um projeto que
  ainda não tem containers, e aí o painel desliga o backup automático desse projeto.
- E-mail: o checklist de DNS está em 6/6, o e-mail de teste chega e uma caixa consegue entrar no
  webmail.
- **Configurações → Fuso horário** mostra o fuso que você quer. Os backups rodam às 03:00 no fuso
  da VPS.
- Rode **Fazer backup agora** no painel e veja "cópia externa conferida". Depois faça um backup de
  um projeto.
- Se a página **Segurança** mostrar diferenças em relação ao servidor antigo, atualize o baseline
  com **Atualizar retrato de referência**, agora que a VPS nova está protegida.
- Só agora desligue a VPS antiga de vez, e apague os restos dela no DNS.

## Se algo falhar

- **Senha errada:** o cartão não a aceita. Confira o kit de novo. Para um backup feito antes de uma
  troca de senha, a janela de restauração tem o link **Este backup é de antes de uma troca de
  senha?**, onde você digita a senha que estava em uso quando aquele backup foi feito.
- **O download falha no passo 7 ou 8:** provavelmente as chaves do armazenamento são as antigas.
  Veja o aviso do passo 5.
- **A restauração falha no meio:** o painel guarda o estado anterior em
  `/data/backups/_painel/antes-da-restauracao/` e desfaz sozinho uma troca do painel que falhou.
  Leia o erro em **Últimos backups** e repita o passo.
- **Sem acesso nenhum ao painel:** restaure o painel a partir de um arquivo baixado com o
  `restaurar-painel.sh`, ou abra o `.7z` à mão com o 7-Zip. O kit explica os dois caminhos.
