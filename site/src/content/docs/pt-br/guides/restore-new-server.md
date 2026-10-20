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
> **Idioma da interface.** O painel está disponível em português e em inglês ([como escolher](../getting-started/complete-guide.md#idioma-da-interface)). Esta página cita os rótulos em português, exatamente como aparecem na tela. Algumas mensagens que vêm do servidor ainda aparecem em português mesmo com a interface em inglês: registros de backup, avisos do servidor de e-mail e muitas mensagens de erro. Quando esta página cita uma delas, avisa. A palavra que você digita para confirmar uma restauração depende do idioma da interface (passos 5 e 8).

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
| **Chaves de acesso do armazenamento** (ID da chave de acesso e Chave de acesso secreta) | Você as viu uma única vez, ao criar o token no Cloudflare. **Elas não estão no kit.** | Crie um novo token de API do R2 para o mesmo bucket ([Guia completo, Etapa 8.1](../getting-started/complete-guide.md#etapa-8)). Os arquivos antigos continuam legíveis. As chaves que você informar no passo 3 continuam valendo depois de restaurar o painel pela tela (veja o passo 5). |
| **Acesso ao domínio** | Seu provedor de DNS ou o registrador. | Recupere o acesso com o registrador. |
| **Acesso ao provedor** | O painel do provedor da VPS nova (para definir o PTR e liberar a porta 25). | — |

## O que volta e o que não volta

| Volta | **Não** volta (você refaz) |
|---|---|
| **Painel:** contas de administrador e verificação em duas etapas, projetos cadastrados, configurações, configurações de notificação, domínio do painel e as chaves que cifram os segredos (variáveis dos projetos, tokens). | O sistema operacional e o hardening dele: usuário, chave SSH, firewall. Rode a instalação e o wizard de segurança na VPS nova. |
| **Configurações de backup:** agenda, frequência, número de cópias e a senha dos backups. O endereço e as chaves do armazenamento são a exceção: ficam os que você informou nesta VPS. Isso vale ao restaurar pela tela. Com o `restaurar-painel.sh`, o arquivo inteiro das configurações de backup volta, inclusive as chaves antigas (veja o passo 5). | O que **não** estava marcado na aba Backups do projeto, e arquivos gravados fora de volumes. |
| **Projetos:** os bancos e as pastas que estavam marcados na aba **Backups** de cada projeto. Projetos do GitHub são publicados de novo a partir do repositório. Nos projetos criados por upload ou a partir de uma pasta do servidor, o código volta do backup para a pasta de origem do projeto, e depois o projeto é publicado. | Registros DNS, o PTR e o firewall do provedor. Eles apontam para o IP antigo. |
| **E-mail:** caixas, mensagens, contas, regras e chaves DKIM, e a configuração do webmail. | Certificados TLS: são emitidos de novo, quando o DNS apontar para a VPS nova. |
| | A reputação do IP de e-mail: um IP novo começa sem nenhuma. |
| | O código de um projeto do GitHub na data do backup: ele vem da branch **atual** do repositório. |

## Passo a passo

Faça os passos 2 a 8 **sem uma pausa longa**. O painel antigo é parado no passo 2 e os serviços só
voltam à medida que você os restaura.

### 1. Prepare a VPS nova

Siga o [guia de instalação](../getting-started/installation.md) do Passo 1 ao Passo 8 e conclua o
assistente de configuração, inclusive a etapa de Segurança. A restauração precisa de um painel com
login, então crie uma conta de administrador provisória quando o assistente pedir. A restauração a
substitui pelas contas antigas.

Se a VPS antiga usava outra pasta de projetos, instale com a mesma (`./scripts/install.sh --projects-dir=<pasta>`, veja [Operação](operations.md)). Senão, os projetos criados por upload ou a partir de uma pasta do servidor falham no passo 7 com "fica fora da pasta de projetos".

**Não inicie o servidor de e-mail na VPS nova** antes do passo 8, mesmo que o roteiro "Deixe o painel pronto" do Dashboard sugira. O backup agendado do e-mail enviaria um servidor de e-mail vazio para `_email/`, contaria como backup concluído e tiraria o e-mail da pausa.

**Desligue o backup automático do painel se a VPS nova ficar ligada por uma madrugada antes do passo 3 ou se o passo 5 puder levar mais de 7 dias.** Em **Configurações → Backups**, no cartão **Painel**, desmarque **Backup automático ligado** e salve. Um painel novo vem com a agenda ligada e roda às 03:00 mesmo sem armazenamento conectado. Esse backup só local conta como backup concluído desta VPS e cancela a proteção descrita no passo 3. A partir daí, um painel vazio vai para `_painel/` todo dia e a retenção (5 cópias) apaga os backups bons em cerca de 5 dias. A restauração do painel traz a agenda antiga de volta, então o ajuste não fica desligado sozinho.

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
> **Não clique em Fazer backup agora no painel novo antes do passo 5.** O
> backup manual sempre roda e envia um backup de um painel **vazio** para a pasta `_painel/`; a
> retenção (5 cópias, por padrão) então apaga a mais antiga. A data mais recente da lista pode
> acabar sendo a do painel vazio, e não a da VPS antiga.
>
> O backup agendado do painel novo vem ligado de fábrica, e o painel só o segura nestas condições:
>
> - nenhum projeto cadastrado, nenhum backup do painel feito nesta VPS e nenhum backup do e-mail concluído; e
> - o armazenamento já guarda backups do painel em `_painel/`; e
> - passaram menos de **7 dias** desde que você conectou o armazenamento.
>
> Enquanto a pausa vale, **Configurações → Backups** mostra o motivo, e o painel manda uma
> notificação, "Backup automático do painel em pausa: o armazenamento tem backups de outro
> servidor". Ela é esperada. Se o painel não conseguir listar o armazenamento, também não envia o
> backup, e uma notificação avisa na terceira falha seguida. **Se passarem mais de 7 dias entre o
> passo 3 e o passo 5**, a pausa acaba sozinha e o próximo backup agendado pode pôr um painel vazio
> por cima do backup bom. A proteção também não existe se o painel novo já fez um backup que ficou
> só na VPS (o das 03:00 sem armazenamento conectado): ele conta como backup concluído. Nos dois
> casos, desligue **Backup automático ligado** no cartão **Painel** antes do passo 3, como diz o
> passo 1.

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
   a primeira data da lista é a certa. Confirme digitando a palavra que a tela mostra: `painel` com a interface em português, `panel` com a interface em inglês.
4. Espere. O painel reinicia sozinho.

**O que conferir:** abra de novo o endereço da VPS nova (`https://203-0-113-10.sslip.io`, com o IP
novo) e entre com o usuário e a senha de administrador **antigos**, mais o código de duas etapas do
celular antigo. Volte a **Configurações → Backups → Restaurar de outro servidor**.

Se você já apontou o registro A do domínio do painel para o IP novo e o painel antigo estava com o
acesso pelo IP desativado, o endereço `…sslip.io` não abre (o acesso continua desativado porque o
domínio aponta para esta VPS). Nesse caso, entre pelo domínio do painel.

> [!NOTE]
> **As chaves do armazenamento que você informou no passo 3 continuam valendo.** Ao restaurar pela
> tela, as configurações de backup voltam com o painel, mas o endpoint, o bucket e as chaves do
> armazenamento ficam os desta VPS, porque foram eles que acabaram de baixar o backup. Se o backup
> trazia outras chaves, o registro da restauração avisa (mensagem do servidor): "As chaves do
> armazenamento externo que você configurou nesta VPS (…) foram mantidas…". Se a VPS antiga foi
> invadida, revogue o token antigo no Cloudflare e troque as senhas (painel, caixas de e-mail,
> bancos, tokens do Git) depois da restauração.

> [!NOTE]
> **Acesso pelo IP.** Se o painel antigo estava com o acesso pelo IP desativado, o painel restaurado
> o deixa **ativo** enquanto o domínio do painel não aponta para esta VPS, para você conseguir
> entrar. O registro da restauração avisa (mensagem do servidor): "O painel antigo tinha o acesso
> pelo IP desativado. Aqui ele fica ativo…". Se o domínio já aponta para esta VPS, o acesso continua
> desativado. Depois que o DNS apontar para cá, desative de novo em **Configurações → Domínio do
> painel** (**Desativar o acesso pelo IP**). Trocar o registro A do domínio antes deste passo é
> opcional.

Se o painel não abre de jeito nenhum, restaure-o a partir de um arquivo:
`cd /opt/tws-panel && sudo ./scripts/restaurar-painel.sh /root/ARQUIVO.7z` (veja
[Operação](operations.md)). Esse caminho não faz os ajustes acima, então os dois avisos a seguir
valem **só para ele**. Ele também não põe a agenda em pausa (veja as conferências finais).

> [!WARNING]
> **Com o `restaurar-painel.sh`, as chaves do armazenamento voltam a ser as antigas.** O arquivo
> inteiro das configurações de backup volta. Se você criou um token novo no passo 3 (porque perdeu
> as chaves, ou porque revogou o token antigo depois de uma invasão), o painel restaurado guarda as
> chaves antigas e o download dos projetos e do e-mail falha. Vá a **Configurações → Backups →
> Armazenamento externo → Editar**, informe as chaves novas de novo e clique em **Testar e salvar**,
> antes do passo 7. Se a VPS antiga foi invadida, revogue o token antigo no Cloudflare e troque as
> senhas (painel, caixas de e-mail, bancos, tokens do Git) depois da restauração.

> [!WARNING]
> **Com o `restaurar-painel.sh`, se o painel antigo estava com o acesso pelo IP desativado**, essa
> configuração também volta. O painel novo passa a responder só no domínio do painel, que ainda
> aponta para a VPS antiga, e você não consegue entrar. Há duas saídas: apontar o registro A do
> domínio para o IP novo e esperar o DNS, ou rodar, na VPS nova,
> `cd /opt/tws-panel && sudo ./scripts/reativar-acesso-ip.sh` e usar o endereço `…sslip.io`. Para
> evitar o problema, troque o registro A do domínio do painel para o IP novo **antes** deste passo.

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
  restaurar** (a caixa serve também aos projetos que não vêm do GitHub). O painel publica o projeto
  e depois devolve os bancos e as pastas. Pode levar vários minutos por projeto, e o painel espera
  até 45 minutos.
  - **Projeto do GitHub:** o painel o publica de novo a partir do repositório.
  - **Projeto criado por upload ou a partir de uma pasta do servidor:** o painel primeiro devolve o
    código do backup à **pasta de origem** do projeto (a que está na configuração dele) e só então
    publica. Essa pasta precisa ficar dentro da pasta de projetos da VPS nova (`PAAS_PROJECTS_DIR`,
    padrão `/opt/tws-projects`), sem link simbólico apontando para fora, e o usuário do painel
    (10001) precisa poder gravar na pasta de projetos, onde a pasta de origem é criada. Num projeto criado por upload, o `.env` que o painel gerou
    não volta (o painel gera um novo no deploy); um `.env` escrito pelo dono do projeto volta.
  - **A pasta de origem já existe na VPS nova com arquivos:** ela fica como está, nada é
    sobrescrito, e o registro da restauração avisa. A publicação usa o que já está lá. Para usar o
    código do backup, renomeie ou esvazie essa pasta **antes** de clicar em **Restaurar**. Depois
    não adianta: num projeto criado por upload, uma nova restauração devolve o código só à cópia de
    trabalho do painel, e o próximo deploy falha sem a pasta de origem.

**O que conferir:** cada projeto abre no seu domínio e os dados estão lá. A página **Certificados**
mostra o domínio do projeto como **Válido**. O certificado falha até o DNS do passo 6 apontar para o
IP novo. Depois disso, use **Tentar emitir agora** nessa mesma página.

### 8. Restaure o e-mail por último

1. No cartão, clique em **Restaurar o e-mail**, escolha a data do backup do e-mail que você anotou no passo 2 e confirme digitando a palavra que a tela mostra: `e-mail` com a interface em português, `email` com a interface em inglês. Se a restauração
   terminar com o aviso "O servidor de e-mail ainda não existe nesta VPS: abra a página E-mail e
   clique em Iniciar" (aviso do servidor, sempre em português), abra **E-mail** e clique em **Iniciar servidor**. Ele sobe com os dados
   restaurados.
2. Atualize o DNS (página **E-mail** → o domínio → **Checklist DNS**):
   - o registro **A** de `mail.envio.example.com` para o IP novo;
   - o registro **SPF**, que contém o IP antigo (`ip4:`): copie o valor novo do checklist;
   - MX, DKIM e DMARC não mudam, porque os nomes e as chaves voltaram.
3. Peça ao provedor para definir o **PTR** do IP novo como `mail.envio.example.com`.
4. Confira que a porta 25 de saída está liberada ([Guia completo, Etapa 6.1](../getting-started/complete-guide.md#etapa-6)).

**O que conferir:** clique em **Verificar agora** até chegar a **6/6 OK**, envie um e-mail de teste
(Etapa 6.7 do guia completo) e veja **Válido** no cartão do certificado do e-mail. Envie devagar no
começo: o IP novo ainda não tem reputação.

## Conferências finais

- O painel abre no domínio, com cadeado, e o login e a verificação em duas etapas funcionam.
- **Certificados** mostra todos os endereços como **Válido**.
- Todos os projetos abrem e têm os seus dados.
- **As agendas voltaram.** Depois de restaurar o painel, o backup automático dos projetos e do
  e-mail fica em pausa até os dados de cada um voltarem. A pausa aparece em **Configurações →
  Backups** e na aba **Backups** do projeto, como uma mensagem que começa com "Em pausa" (mensagem
  do servidor), no lugar de "Próximo: …". Depois de restaurar cada projeto e o e-mail, confira que
  a mensagem sumiu. Projeto criado depois da restauração não é pausado, e a pausa acaba sozinha em
  7 dias. Se você restaurou o painel com o `restaurar-painel.sh`, não há pausa: a agenda antiga
  volta como era e pode tentar fazer backup de um projeto que ainda não tem containers.
- **Não deixe os projetos esperando.** O backup agendado de um projeto que ainda não tem containers
  falha com "Nenhum container do projeto encontrado" (mensagem do servidor), com notificação. O de
  um projeto publicado cujos dados ainda não voltaram pode enviar um backup sem os dados. Restaure
  os projetos logo depois do painel.
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
- **O download falha no passo 7 ou 8:** o token pode estar revogado ou errado. Vá a
  **Configurações → Backups → Armazenamento externo → Editar**, informe as chaves de novo e clique em
  **Testar e salvar**. Se você restaurou o painel com o `restaurar-painel.sh`, este também é o efeito
  das chaves antigas que voltaram (veja o aviso do passo 5).
- **"A pasta do código deste projeto (…) fica fora da pasta de projetos desta VPS" (mensagem do
  servidor):** o painel não grava fora da pasta de projetos. Ponha o código dentro dela, sem link
  simbólico apontando para fora, e cadastre o caminho de novo na configuração do projeto.
- **"A pasta do código (…) já existe nesta VPS e tem arquivos: ficou como está, nada foi
  sobrescrito" (mensagem do servidor):** a publicação usa o que já está lá. Se você quer o código
  do backup, renomeie ou esvazie a pasta de origem **antes** de clicar em **Restaurar**, nunca
  depois (veja o passo 7).
- **A restauração falha no meio:** o painel guarda o estado anterior em
  `/data/backups/_painel/antes-da-restauracao/` e desfaz sozinho uma troca do painel que falhou.
  Leia o erro em **Últimos backups** e repita o passo.
- **Sem acesso nenhum ao painel:** restaure o painel a partir de um arquivo baixado com o
  `restaurar-painel.sh`, ou abra o `.7z` à mão com o 7-Zip. O kit explica os dois caminhos.
