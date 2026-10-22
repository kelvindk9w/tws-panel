---
title: "Guia passo a passo — Parte 2: Configurar"
description: "Parte 2 do guia passo a passo: com o painel instalado, configure o assistente, a segurança, o domínio, o e-mail, as notificações, os backups, o primeiro projeto e uma restauração de teste."
sidebar:
  label: "Parte 2: Configurar"
---

> [!TIP]
> **Voltar: [Parte 1 — Instalar](installation.md).** Esta é a **Parte 2 (Configurar)** do mesmo caminho: ela começa onde a
> Parte 1 termina, com o painel instalado e o link do assistente em mãos. Ainda não instalou? Comece pela Parte 1.

Um roteiro só, em ordem, do painel recém-instalado até o painel configurado por completo: assistente,
segurança, domínio, fuso, e-mail, notificações, backups, o primeiro projeto no ar e uma restauração de teste.

> [!NOTE]
> **Idioma da interface.** O painel está disponível em português e em inglês ([como escolher](#idioma-da-interface)). Esta página cita os rótulos em português, exatamente como aparecem na tela. Algumas mensagens que vêm do servidor ainda aparecem em português mesmo com a interface em inglês: resultados das verificações de saúde e de segurança, mensagens do deploy e da checagem de DNS, status do servidor de e-mail e observações do checklist de DNS, erros de certificado, alertas e detalhes da auditoria, registros de backup, detalhes dos passos do roteiro e muitas mensagens de erro. Quando esta página cita uma delas, avisa.

Cada etapa diz **o que fazer**, **onde clicar** e **o que conferir** para saber que deu certo.
Quando o detalhe é longo, a etapa resume e manda para o guia certo. Siga na ordem: algumas etapas
dependem das anteriores (as notificações por e-mail, por exemplo, precisam do e-mail pronto).

Os exemplos usam valores fictícios: `203.0.113.10` como IP da VPS e `example.com` como domínio.
Troque pelos seus.

| Etapa | O que você faz | Onde |
|---|---|---|
| [1](#etapa-1) | Assistente inicial, segurança e verificação em duas etapas | Navegador |
| [2](#etapa-2) | Domínio do painel | Configurações → Domínio do painel |
| [3](#etapa-3) | Fuso horário | Configurações → Fuso horário |
| [4](#etapa-4) | E-mail | E-mail, Envios |
| [5](#etapa-5) | Notificações | Configurações → Notificações |
| [6](#etapa-6) | Backups fora da VPS | Configurações → Backups |
| [7](#etapa-7) | Primeiro projeto | Novo Projeto |
| [8](#etapa-8) | Testar uma restauração | Projeto → Backups |
| [9](#etapa-9) | Manutenção | Terminal, Alertas, Auditoria |
| [✓](#checklist) | Checklist final | — |

As contas que você vai usar (GitHub, Cloudflare e Telegram) e o domínio opcional estão descritos em
[Antes de começar](installation.md#antes-de-começar), na Parte 1.

> [!TIP]
> O próprio painel acompanha boa parte disto. No Dashboard, o cartão **Deixe o painel pronto**
> mostra o que falta (proteções, verificação em duas etapas, domínio do painel, e-mail,
> notificações e backups), com um "Como fazer" e o botão para a tela certa. A mesma lista fica em
> **Configurações → Primeiros passos**. Este guia vai além dela: fuso, primeiro projeto e teste de
> restauração.

<a id="etapa-1"></a>

## Etapa 1 — Assistente inicial, segurança e verificação em duas etapas

### 1.1 O assistente (setup)

**O que fazer:** abra no navegador o link do banner (o mesmo do [Passo 8 da Parte 1](installation.md#passo-8)). O assistente tem quatro etapas:

1. **Boas-vindas e token:** valida o setup token (já vem no link) e libera o terminal do servidor.
2. **Saúde da máquina:** CPU, memória, disco e rede, conferidos ao vivo no terminal embutido.
   Esta etapa também mostra o fuso horário da VPS (veja a [Etapa 3](#etapa-3)).
3. **Segurança:** varredura (Lynis), plano e hardening em 8 fases. Explicada logo abaixo.
4. **Conta de administrador:** o seu usuário e uma senha forte do painel. Clique em
   **Criar conta admin**.

<a id="idioma-da-interface"></a>
**Idioma.** Na primeira visita, o painel percorre a lista de idiomas do navegador e usa o primeiro que
ele tem: português para qualquer variante de `pt` (como `pt-BR`), inglês para `en`; se nenhum
combinar, inglês. Para mudar, use o seletor **Idioma** nas telas do assistente e de login, no cabeçalho do painel (ao lado do menu do
usuário, sempre à vista; na disposição lateral fica no rodapé da lateral, acima do menu do usuário) ou em **Configurações → Aparência**. A escolha fica guardada só nesse navegador: outro
navegador ou aparelho começa de novo pelo idioma dele.

**O que conferir:** aparece **Setup concluído!** e você entra no Dashboard. A partir daqui, o
acesso é pela tela de login, com usuário e senha. O setup token deixa de valer.

### 1.2 A etapa Segurança (hardening)

> [!IMPORTANT]
> **Leia o [Wizard de segurança](security-wizard.md) antes desta etapa.** Ela desliga o login
> por senha no SSH. Feita sem atenção, pode trancar você fora da VPS.

**O que fazer, em resumo:**

- Aplique as fases **uma de cada vez**. Simule antes, se quiser: nada muda na VPS durante a
  simulação.
- As fases **01 (usuário), 02 (SSH) e 03 (firewall)** pedem confirmação. Depois de aplicar, abra
  **uma janela nova** do terminal do seu computador, sem fechar a antiga, e rode o comando `ssh`
  que o painel mostra.
- Só se a janela nova conectar, digite `exit` e clique em **Entrei — confirmar**. Se não conectar,
  clique em **Não consegui entrar — desfazer agora**. Sem confirmação, a fase se desfaz sozinha em
  cerca de 5 minutos.
- Na fase 01, a janela nova precisa entrar **sem pedir a senha da conta**. Se pedir, não confirme
  e não avance para a 02.
- A fase 06 (Auditoria) demora vários minutos. Parece travada, mas não está.
- **Depois da última fase, reinicie a VPS** (`sudo reboot`), espere um minuto e abra o painel de
  novo.

O passo a passo completo, fase por fase, está em
[As oito fases](security-wizard.md#as-oito-fases).

**O que conferir:** no Dashboard, o passo **Proteções da VPS** do roteiro aparece como feito, com
"Todas as 8 fases resolvidas" (mensagem do servidor). Se ficou alguma de fora, ela fica em **Segurança → Verificar e aplicar proteções** para revisar,
simular ou aplicar depois.

### 1.3 Verificação em duas etapas

Com ela, entrar no painel passa a pedir, além da senha, um código de 6 dígitos gerado no seu
celular. Se a sua senha vazar, ninguém entra sem o celular.

**O que fazer:**

1. Instale no celular um app autenticador (Google Authenticator, Microsoft Authenticator, 2FAS ou
   parecido).
2. No painel, abra **Configurações → Segurança** e clique em **Começar**.
3. Leia o QR code com o app. Não consegue ler? A tela mostra a chave para digitar no app.
4. Digite o **código que aparece no app** e a **sua senha atual do painel**. Clique em **Ativar**.
5. A tela mostra os **códigos de recuperação**, que só aparecem agora. Guarde num lugar seguro,
   marque **Guardei os códigos em lugar seguro** e clique em **Concluir**.

**O que conferir:** a tela diz "Ativa: entrar no painel exige o código do app." Saia e entre de
novo: o login pede o código. No Dashboard, o passo **Verificação em duas etapas** fica como feito.

<a id="etapa-2"></a>

## Etapa 2 — Domínio do painel

Troca o endereço `https://203-0-113-10.sslip.io` por um seu, como `painel.example.com`. O
endereço automático entrega o IP da VPS no nome; um domínio seu é mais discreto e fácil de lembrar.
Para os endereços dos projetos, veja também o [Domínio de aplicações](#dominio-de-aplicacoes), no
fim desta etapa.

> [!NOTE]
> Instalou com acesso por túnel SSH? Então o painel não tem endereço na internet, este passo já
> conta como feito e a tela explica como mudar para HTTPS.

**O que fazer:**

1. **Crie o registro no DNS.** No Cloudflare: DNS → Registros → Adicionar registro.
   - Tipo: **A**.
   - Nome: `painel` (para `painel.example.com`).
   - Endereço IPv4: o IP da VPS.
   - Proxy: **nuvem cinza ("Somente DNS")**. Com a nuvem laranja, o certificado não sai.
   - Salve. Se existir um registro **AAAA** com o mesmo nome, apague.
2. **Cadastre no painel.** Ainda pelo endereço `…sslip.io`, abra **Configurações → Domínio do
   painel**, digite `painel.example.com` e clique em **Salvar domínio**. A tela mostra o mesmo
   registro A, com botão de copiar em cada campo.
3. Clique em **Verificar DNS**. Se o resultado disser que o domínio "ainda não aponta" (mensagem
   que vem do servidor e continua em português mesmo com a interface em inglês), espere alguns minutos e tente de
   novo.
4. **Espere o certificado.** No cartão do certificado, espere ficar "Válido" (de segundos a 2
   minutos). Use **Conferir de novo** para atualizar. Se falhar, a causa aparece no cartão, com o
   botão **Tentar emitir agora**.
5. Clique em **Abrir o painel pelo endereço novo** e entre de novo, com usuário, senha e código. A
   sessão vale só no endereço em que você entrou.

**O que conferir:** o painel abre em `https://painel.example.com`, com cadeado. A lista
"Endereço do painel" mostra os dois endereços. No Dashboard, o passo **Domínio do painel** fica
como feito, com o aviso "acesso pelo IP ainda ativo" (mensagem do servidor, sempre em português).

### Desativar o acesso pelo IP (opcional)

Faz o endereço `…sslip.io` parar de abrir o painel. Só é liberado com a página aberta **pelo
domínio novo** e o certificado válido.

1. Já no endereço novo, em **Configurações → Domínio do painel**, **anote o comando de SSH** que a
   tela mostra (tem botão **Copiar o comando**). Ele é a sua volta se o domínio parar de abrir.
2. Clique em **Desativar o acesso pelo IP**, digite o domínio e clique em **Desativar agora**.

**O que conferir:**

- `https://203-0-113-10.sslip.io` não abre mais o painel;
- `https://painel.example.com` continua abrindo;
- em **Auditoria**, aparece `panel_domain.ip_disabled`.

### Como reativar o acesso pelo IP

- **Pela tela:** em **Configurações → Domínio do painel**, clique em **Reativar o acesso pelo IP**.
- **Por SSH**, se o domínio parou de abrir (DNS apagado, domínio vencido, certificado que não
  renovou):

  ```bash
  cd /opt/tws-panel && sudo ./scripts/reativar-acesso-ip.sh
  ```

  Espere a mensagem "pronto", abra `https://203-0-113-10.sslip.io` (com o seu IP) e entre de
  novo. Detalhes em
  [O domínio do painel parou de abrir](../guides/recover-access.md#o-domínio-do-painel-parou-de-abrir).

<a id="dominio-de-aplicacoes"></a>

### Domínio de aplicações (opcional)

Cada projeto novo ganha, por padrão, um endereço automático **de teste** com o IP da VPS no nome
(`minha-app.203-0-113-10.sslip.io`). Esse endereço aparece em prints e em links compartilhados,
deixa de abrir se o IP da VPS mudar e depende de um serviço de terceiros (o sslip.io). Não é uma
falha de segurança grave: quem hospeda sites sempre pode ter o IP descoberto pelo DNS. O problema é
de privacidade, aparência e estabilidade.

Com o **domínio de aplicações**, o painel gera os endereços sob um subdomínio seu, sem o IP no nome:
`minha-app-k3x9q.apps.example.com`.

**O que fazer:**

1. **Escolha um subdomínio só para as aplicações**, como `apps.example.com`. Não use o domínio
   principal, o domínio do painel nem um domínio de projeto ou de e-mail.
2. Abra **Configurações → Domínio de aplicações** e digite `apps.example.com`. A tela mostra o
   registro a criar, com botão de copiar em cada campo.
3. **Crie um único registro curinga no DNS.** No Cloudflare: DNS → Registros → Adicionar registro.
   - Tipo: **A**.
   - Nome: `*.apps` (para `*.apps.example.com`). Se o seu provedor pede o nome completo, digite
     `*.apps.example.com`.
   - Endereço IPv4: o IP da VPS.
   - Proxy: **nuvem cinza ("Somente DNS")**. Com a nuvem laranja, o certificado de cada projeto não sai.
   - A tela só mostra um registro **AAAA** se o painel souber o IPv6 público da VPS
     (`PAAS_PUBLIC_IPV6`). Fora isso, não crie AAAA.
4. Clique em **Verificar DNS e salvar**. O painel consulta um nome aleatório sob a base
   (`paas-check-…`) e **só salva** se ele chegar a esta VPS. Um registro só para `apps.example.com`
   não passa: o curinga é que vale. O resultado é uma mensagem do servidor, sempre em português.
   Se disser que não aponta, espere alguns minutos e tente de novo.

**O que conferir:** a tela mostra o domínio com o selo **Verificado** e um exemplo de endereço.

**Como usar:** em **Novo Projeto**, no passo 3, o **Endereço automático** passa a ser
`<projeto>-<sufixo>.apps.example.com` (sufixo aleatório de 5 caracteres), com HTTPS e sem aviso. O
sslip.io continua disponível como **Endereço de teste**, com o aviso de que contém o IP da VPS.
Projetos que já existem com sslip.io não mudam.

**Bom saber:**

- Cada projeto tem a sua rota e o seu certificado. O painel **não** emite certificado curinga nem
  libera emissão sob demanda: um nome qualquer sob `apps.example.com` sem projeto responde só a
  página de "domínio não configurado", em HTTP, e não tem certificado.
- O **Let's Encrypt limita a 50 certificados novos por semana por domínio registrado** (aqui,
  `example.com`, somando todos os subdomínios). Para uso pessoal sobra; criar e apagar muitos
  projetos em poucos dias pode esgotar o limite. Quando a emissão falha, a página **Certificados**
  mostra a causa e tem o botão **Tentar emitir agora**
  (veja [Limite do Let's Encrypt](../guides/troubleshooting.md#limite-do-lets-encrypt)).
- Todo certificado fica numa lista pública (Certificate Transparency): o endereço de cada projeto
  (nome do projeto e sufixo) fica visível ali. O sufixo evita colisão; não esconde o endereço.
- **Trocar** a base não muda os projetos que já usam a antiga. **Remover** também não: eles
  continuam abrindo, e os projetos novos voltam ao endereço de teste.
- Se a verificação falhar, veja
  [A verificação do domínio de aplicações falha](../guides/troubleshooting.md#verificacao-do-dominio-de-aplicacoes).

<a id="etapa-3"></a>

## Etapa 3 — Fuso horário

O fuso da VPS define **o horário dos backups agendados, que rodam às 03:00 no fuso da VPS**, e as
datas dos registros. Cada provedor entrega a VPS num fuso: a maioria em UTC (três horas à frente de Brasília), alguns no
horário local do datacenter. Em UTC, o "03:00" dos backups seria meia-noite no horário de Brasília.

**Onde ver:** o assistente inicial já mostra o fuso detectado na etapa **Saúde da máquina**, com
**Trocar o fuso**. Depois da instalação, o lugar é **Configurações → Fuso horário**.

**O que fazer:**

1. Abra **Configurações → Fuso horário**. A tela mostra o fuso da VPS e a hora de agora.
2. Em **Fuso novo**, escolha o seu. Os do Brasil aparecem primeiro; dá para buscar pela cidade ou
   pelo estado (ex.: `America/Sao_Paulo`).
3. Opcional: em **Aplicar também nestes projetos**, marque os projetos que devem seguir o fuso da
   VPS. Eles passam a usar "Igual ao da VPS" e reiniciam com o fuso novo, sem baixar código novo.
   Os desmarcados mantêm o fuso que têm.
4. Clique em **Aplicar na VPS**. A troca vale para a VPS inteira, sem precisar de SSH.

Cada projeto também tem o cartão **Fuso horário**, na aba **Configurações** do projeto:
"Padrão da imagem" (geralmente UTC), "Igual ao da VPS" ou um fuso específico.

**O que conferir:** a hora mostrada na tela bate com o seu relógio. Em **Configurações → Backups**,
a frase da agenda diz "Roda às 03:00 (horário da VPS, …)" com o deslocamento do fuso novo (para
Brasília, `UTC-03:00`).

<a id="etapa-4"></a>

## Etapa 4 — E-mail

Um servidor de e-mail na própria VPS, para os seus projetos enviarem mensagens (recuperação de
senha, avisos, formulários) e para caixas como `contato@`. É opcional: se os seus projetos usam um
serviço externo de envio (Amazon SES, Resend, SendGrid…), marque **Não vou usar** no roteiro e pule
para a [Etapa 5](#etapa-5).

> [!IMPORTANT]
> **Use um subdomínio só para o envio**, como `envio.example.com`. Não use o domínio principal:
> apontar o MX dele para a VPS desviaria o e-mail que a empresa já recebe em outro lugar (Google,
> Microsoft ou outro serviço). Os passos abaixo usam `envio.example.com`.

### 4.1 Conferir a porta 25

Na VPS, por SSH:

```bash
nc -vz -w 5 gmail-smtp-in.l.google.com 25
```

**O que conferir:** `succeeded` ou `open` quer dizer liberada. `timed out` quer dizer bloqueada:
abra um chamado no provedor pedindo a liberação da porta 25 de saída para envio de e-mail
transacional. Sem ela, o e-mail não sai. Veja
[Porta 25 bloqueada pelo provedor](../guides/troubleshooting.md#porta-25-bloqueada-pelo-provedor).

### 4.2 Ligar o servidor e cadastrar o domínio de envio

1. No menu, clique em **E-mail**.
2. Se o servidor estiver parado, clique em **Iniciar servidor**.
3. No cartão **Domínios de e-mail**, digite `envio.example.com` e clique em
   **Adicionar domínio**.
4. Se aparecer o aviso vermelho "Este domínio já recebe e-mail em outro servidor", **não** siga
   com o domínio principal. Clique em **Usar envio.example.com (recomendado)** (o painel sempre sugere um subdomínio `envio.` do seu domínio; qualquer subdomínio serve).

**O que conferir:** o cartão **Servidor de e-mail** mostra o servidor rodando e o domínio aparece
na lista.

### 4.3 Criar os registros DNS

Clique no domínio cadastrado e abra a aba **Checklist DNS**. O cartão **Registros DNS esperados**
traz os valores exatos, com o IP da sua VPS e a chave DKIM. **Copie campo a campo**, com o botão de
copiar de cada um. No Cloudflare (DNS → Registros → Adicionar registro), para
`envio.example.com`:

| Tipo | Nome (no Cloudflare) | Valor | Atenção |
|---|---|---|---|
| A | `mail.envio` | IP da VPS | **Nuvem cinza ("Somente DNS")**. Com a laranja, o certificado não sai e o e-mail não chega. |
| MX | `envio` | Servidor de e-mail: `mail.envio.example.com` · Prioridade: `10` | No Cloudflare, o MX tem **dois campos separados**: Servidor de e-mail e Prioridade. A tela mostra cada um com o seu botão de copiar. Só no subdomínio: não mexa no MX do domínio principal. |
| TXT (SPF) | `envio` | `v=spf1 ip4:<IP> ~all`, do checklist | |
| TXT (DKIM) | `paas._domainkey.envio` | `v=DKIM1; k=rsa; p=…`, do checklist | Copie inteiro, com o botão. |
| TXT (DMARC) | `_dmarc.envio` | `v=DMARC1; p=none; …`, do checklist | Mantenha `p=none` nas primeiras semanas. |

Depois, clique em **Verificar agora** até todos ficarem verdes. A propagação leva de minutos a
algumas horas.

**O que conferir:** a contagem chega a **6/6 OK** (o sexto item é o PTR, logo abaixo).

### 4.4 DNS reverso (PTR)

O PTR é o "nome" que o IP da VPS informa a quem recebe o e-mail. Ele **não** fica no Cloudflare: é
configurado no painel do provedor da VPS. O cartão **Reverse DNS (PTR)** mostra uma de três cores:

- **Verde:** o nome reverso já é `mail.envio.example.com`. Nada a fazer.
- **Azul:** nome genérico do provedor que aponta de volta para o IP. O envio já funciona; trocar o
  nome é recomendado, e o caminho aparece em "Recomendado: trocar o nome reverso para …".
- **Amarelo:** sem nome reverso válido. Gmail, Yahoo e Microsoft podem recusar: troque o nome.

Onde trocar: na **Contabo**, em Reverse DNS Management; na **Hetzner**, servidor → aba Networking →
Reverse DNS; na **Vultr**, servidor → Settings → IPv4 → Reverse DNS. Nos outros provedores, o
cartão traz um texto pronto para abrir chamado, com botão de copiar.

**O que conferir:** depois de trocar, **Verificar agora** deixa o PTR verde.

### 4.5 Certificado do e-mail

1. Volte em **E-mail**.
2. O cartão **Certificado do servidor de e-mail** mostra `mail.envio.example.com`.
3. Clique em **Conferir de novo** até aparecer **Válido**, "Emitido por Let's Encrypt". Na primeira
   vez, o servidor de e-mail reinicia sozinho por alguns segundos.

**O que conferir:** o estado é **Válido**. Se continuar pendente, o próprio cartão diz o que falta
(registro A ausente, nuvem laranja ou portas 80/443 fechadas). O painel renova sozinho.

### 4.6 Criar uma caixa

1. Na página do domínio, abra a aba **Caixas**.
2. Em **Nova caixa**, digite o nome (ex.: `contato`).
3. Escolha a senha: digite duas vezes (mínimo de 12 caracteres) ou peça para o painel gerar uma.
   A senha não aparece de novo: guarde no seu gerenciador.
4. Clique em **Criar caixa**.

**O que conferir:** a caixa aparece na lista. "Configurar no app" mostra os dados para Outlook,
Gmail, Thunderbird ou o celular.

### 4.7 Enviar um e-mail de teste

1. Na aba **Checklist DNS**, no cartão **E-mail de teste**, clique em **Enviar e-mail de teste**.
2. Digite um endereço seu (um Gmail, por exemplo) e clique em **Enviar**.

**O que conferir:** em alguns segundos aparece, em verde, **"Entregue ao servidor do destinatário"**.
Abra a caixa de destino e confira também a pasta Spam: num servidor novo, é comum o primeiro cair
lá. Marque como "não é spam". Se aparecer amarelo "Adiada: Connection to … failed", a porta 25 está
bloqueada ([4.1](#etapa-4)). Se aparecer vermelho "Recusado: …", o motivo é o que o destinatário
respondeu (normalmente SPF, DKIM, DMARC ou o nome reverso). Veja
[E-mail caindo em spam](../guides/troubleshooting.md#e-mail-caindo-em-spam).

### 4.8 Webmail

1. Em **E-mail**, no cartão **Webmail**, clique em **Ativar webmail**. A primeira vez demora: o
   painel baixa a imagem do Roundcube (algumas centenas de MB).
2. Clique em **Abrir webmail** ao lado de `mail.envio.example.com`.
3. Entre com o endereço completo da caixa (ex.: `contato@envio.example.com`) e a senha dela.

**O que conferir:** `https://mail.envio.example.com/` abre com cadeado e a tela de login em
português por padrão (o webmail é o Roundcube, que tem a própria configuração de idioma e não segue a do painel). Envie um e-mail para você e responda de lá: a resposta aparece na Caixa de entrada do
webmail. Esqueceu a senha da caixa? Aba **Caixas** → **Trocar senha**.

### 4.9 Página Envios

No menu (seta ao lado de **Configurações** → **Envios**), **Envios** mostra o que o servidor de e-mail está fazendo:

- **Fila agora:** o que ainda está em tentativa, com o motivo da última falha.
- **Histórico:** entregues, recusadas, adiadas e canceladas dos últimos 30 dias.
- **Volume:** gráfico dos últimos 14 dias e taxa de recusa.
- **Reputação:** listas de bloqueio, conferidas uma vez por dia e no botão **Conferir agora**.
- **Nota:** a nota de entregabilidade, de 0 a 100, com o que está feito e o que falta.

**O que conferir:** em **Histórico**, o e-mail de teste aparece como "Entregue". Um servidor novo
não chega ao verde na nota antes de uns 30 dias enviando: é de propósito.

**No roteiro:** o passo **E-mail do servidor** fica como feito com o servidor ligado e pelo menos
um domínio com o DNS certo.

<a id="etapa-5"></a>

## Etapa 5 — Notificações

Avisos fora do painel quando algo precisa de atenção: alerta de segurança, deploy que falhou,
certificado com problema, e-mail em lista de bloqueio, disco acima de 90%, backups que falharam ou
atrasaram. Sem isso, os alertas só aparecem dentro do painel.

### 5.1 Telegram

1. No Telegram, procure **@BotFather** (com o selo azul de verificado) e abra a conversa.
2. Mande `/newbot`. Ele pede um nome (ex.: "Avisos do meu painel") e depois um @ que termine em
   `bot` (ex.: `avisos_do_meu_painel_bot`).
3. Ele responde com o **token**, uma linha como `123456789:ABC…`. Copie a linha inteira.
4. No painel, abra **Configurações → Notificações**. No cartão **Telegram**, cole no campo
   **Token do robô** e clique em **Salvar token**. Deve aparecer "Robô @… conferido".
5. Clique no link **Abrir @…** e, no Telegram, toque em **Começar** (ou mande `/start`).
6. Volte ao painel e clique em **Conectar**. Confira se o nome da conversa que aparece é o seu (ou o
   do grupo).
7. Clique em **Enviar teste**.

**O que conferir:** a mensagem "TWS Panel: Teste de notificação" chega no Telegram (o texto do teste é escrito pelo servidor e é sempre em português). No painel, o selo vira "Testado em…" e, em **Últimos envios**, aparece uma entrada "Teste de notificação" (também texto do servidor) com o estado **Enviado**.

### 5.2 E-mail (opcional)

Precisa da [Etapa 4](#etapa-4) pronta: servidor ligado e um domínio com o DNS todo certo.

1. Em **Configurações → Notificações**, no cartão **E-mail**, informe até 5 endereços e clique em
   **Salvar endereços**.
2. Clique em **Enviar teste**.

**O que conferir:** a mensagem chega na caixa. No primeiro envio de um servidor novo, costuma cair
no spam: marque como "não é spam".

### 5.3 O que avisa

No cartão **O que avisa**, escolha os tipos. O padrão já liga tudo o que pede ação; "Painel
reiniciado" começa desligado.

**No roteiro:** o passo **Notificações** fica como feito com pelo menos um canal conectado e o
teste enviado.

<a id="etapa-6"></a>

## Etapa 6 — Backups fora da VPS

O painel já guarda cópias na própria VPS, mas elas somem junto se o servidor for perdido, invadido
ou apagado. Com uma cópia fora, no Cloudflare R2, dá para montar tudo de novo numa VPS nova.

### 6.1 Criar o bucket e as chaves no Cloudflare R2

O Cloudflare mostra os nomes em inglês ou em português, conforme o idioma da sua conta. Os dois vêm
abaixo (inglês / português), como na tela do painel.

1. Em dash.cloudflare.com, abra **R2 Object Storage** / **Armazenamento de objetos R2**. Na
   primeira vez, ative o R2 (ele pede um cartão; o plano gratuito cobre 10 GB por mês).
2. Clique em **Create bucket** / **Criar bucket**, dê um nome (ex.: `tws-backups`, só minúsculas,
   números e hífen) e crie.
3. Na página do R2, no canto direito, ache **API Tokens** / **Tokens de API** e clique em
   **Manage** / **Gerenciar**. Depois, em **Create Account API token** / **Criar token de API da
   conta** (ou o de usuário, se só ele aparecer).
4. No formulário:
   - um nome (ex.: `tws-panel-backups`);
   - em Permissions / Permissões: **Object Read & Write** / **Leitura e gravação de objetos**;
   - em Specify bucket(s) / Especificar bucket(s): **Apply to specific buckets only** / **Aplicar
     somente a buckets específicos**, e escolha o bucket;
   - TTL: **Forever** / **Para sempre**.

   Confirme no botão de criar o token, no fim da página.
5. A tela seguinte mostra as chaves **uma única vez**. Copie:
   - a **Access Key ID** / **ID da chave de acesso**;
   - a **Secret Access Key** / **Chave de acesso secreta**;
   - o endpoint que termina em `.r2.cloudflarestorage.com`.

   O "Token value" / "Valor do token" não é usado. Perdeu o endpoint? Ele fica no bucket →
   Settings / Configurações → S3 API.

### 6.2 Conectar no painel

1. Abra **Configurações → Backups**. No cartão **Armazenamento externo**, deixe **Cloudflare R2**
   marcado.
2. Cole o endpoint, o bucket, a Access Key ID e a Secret Access Key. Região: `auto`.
3. Clique em **Testar e salvar**. Antes de guardar, o painel grava, lê e apaga um arquivo de teste
   no bucket.

**O que conferir:** aparece "Conexão testada e salva" e o selo "Testado em…". Se falhar, nada é
salvo e a tela explica o motivo (chave recusada, bucket inexistente, sem resposta).

### 6.3 Criptografia e kit de recuperação

A cópia externa vai cifrada com uma senha sua. **Sem esta senha, ninguém, nem a TWS, consegue abrir
seus backups.**

1. No cartão **Criptografia da cópia externa**, crie a senha (mínimo de 12 caracteres) ou clique em **Sugerir uma
   frase forte**.
2. Clique em **Baixar kit de recuperação** e guarde o arquivo **fora da VPS**. Ele traz a senha,
   onde os backups ficam e como restaurar.
3. Marque **Guardei a senha em lugar seguro** e clique em **Ativar a criptografia**.

**O que conferir:** o cartão mostra **Ligada (AES-256)**.

### 6.4 Primeiro backup

1. No cartão **Painel**, clique em **Fazer backup agora**.
2. Faça o mesmo no cartão **E-mail**, se você ligou o e-mail na [Etapa 4](#etapa-4).

**Reaproveitou um bucket de um painel antigo?** O Dashboard avisa que o armazenamento já guarda
backups de outro painel. Se você quer continuar o painel antigo, restaure-o primeiro (guia de
restauração). Se este é um painel novo, o backup à mão acima não é bloqueado e pode ser o primeiro.
A partir do primeiro backup, a retenção apaga as cópias mais antigas da pasta (mantém só as mais
novas; o padrão é 5), inclusive as do painel antigo: para guardá-las, baixe-as antes de fazer o
primeiro backup ou use outro bucket ou pasta.

**O que conferir:**

- em **Últimos backups**, a linha termina com **"na VPS · cópia externa conferida"**: o painel
  baixou a cópia de volta e conferiu antes de dar como feita;
- no Cloudflare, em R2 → `tws-backups`, aparece a pasta `TWS Panel Backups/_painel/` com o arquivo
  `.7z`;
- no Dashboard, o passo **Backups fora da VPS** fica como feito.

### 6.5 Testar a senha

No cartão **Criptografia da cópia externa**, digite a senha do kit e clique em **Testar minha senha**.

**O que conferir:** a resposta começa com "Senha certa" (resposta do servidor, sempre em português). A cada 90 dias sem teste, o painel lembra de
repetir isto.

### 6.6 Agenda

Nos cartões **Painel** e **E-mail**, escolha a frequência (uma vez por dia, a cada 12 ou a cada 6
horas) e quantas cópias ficam na VPS e fora. **O horário base é 03:00 no fuso da VPS** (veja a
[Etapa 3](#etapa-3)).

Os projetos têm a configuração deles. No cartão **Padrão dos projetos**, escolha o mesmo para os
projetos: ligado ou desligado, frequência e cópias.

1. Ajuste os campos. A frase de baixo mostra quantos dias os backups cobrem.
2. Em **Aplicar também nestes projetos**, marque os projetos que já existem (ou **Marcar todos**).
3. Clique em **Salvar**.

**O que conferir:** cada projeto da lista mostra "hoje: segue o padrão". Projeto novo já nasce com
o padrão. Os bancos e as pastas de cada projeto continuam na aba **Backups** dele
([Etapa 7](#etapa-7)).

Detalhes do que entra, de onde fica e de como restaurar numa VPS nova:
[Funcionalidades → Backups](../guides/features.md#backups).

<a id="etapa-7"></a>

## Etapa 7 — Primeiro projeto

### 7.1 Conectar o GitHub (opcional)

Para escolher o repositório numa lista, em vez de colar a URL: abra **Configurações →
Integrações**, cole um **Token do GitHub (somente leitura)** e clique em **Conectar**. A tela ensina
a gerar o token. Um token com permissão de escrita é recusado.

**O que conferir:** a tela mostra "Conectado como …".

### 7.2 Criar o projeto

No menu, clique em **Novo Projeto**. São três passos:

1. **Fonte do código.**
   - Dê um **Nome do projeto**.
   - Escolha **Repositório Git** e cole a **URL do repositório**, ou clique em **Escolher dos meus
     repositórios** (com o GitHub conectado).
   - Confira a **Branch**.
   - Repositório privado sem a conta conectada? Marque **Repositório privado** e cole um **Token de
     leitura** (a tela ensina a gerar, com a permissão `Contents: Read` só para esse repositório).
   - Antes de criar, clique em **Testar acesso**, ao lado do campo do token. O painel só consulta o
     repositório (não cria o projeto nem guarda o token) e diz, em português, se consegue ler: **Acesso
     confirmado** (com a branch padrão e as primeiras branches), token inválido ou expirado, token sem
     permissão de leitura, repositório não encontrado, branch que não existe, servidor inacessível ou
     tempo esgotado. O mesmo botão aparece quando você escolhe da lista um repositório privado da
     conta do GitHub conectada (ele testa com o token da conta). O teste nunca segue redirecionamentos (para não enviar a credencial a outro endereço nem consultar destinos internos), já o deploy segue redirecionamentos, mas o token cadastrado só é enviado ao host do endereço do projeto e nunca sem criptografia (um repositório movido para outro host, ou que redireciona de https para http, exige o endereço final https). Se o teste disser que o endereço redireciona, use o endereço final, por exemplo com `.git` no fim (o GitLab redireciona quando ele falta). O teste não consulta endereços da própria máquina (`localhost`, `127.x`, `169.254.x`). Mudou a URL, a branch ou o token? O
     resultado antigo some e é preciso testar de novo.
   - Clique em **Criar e detectar**.
2. **Detecção automática.** O painel descobre o tipo: HTML puro, projeto com build, `Dockerfile`
   ou `docker-compose`. Num compose, ele é adotado como está, sem ser reescrito, e a tela mostra em
   qual serviço e porta o HTTP chega.
3. **Domínio e criação.**
   - **Endereço automático:** funciona na hora, com HTTPS. Sem domínio de aplicações, é o
     `minha-app.203-0-113-10.sslip.io`, e a tela mostra um aviso âmbar: "Este endereço contém o IP da
     VPS. Use para testar; para publicar, use o seu domínio ou subdomínio." (não é um erro). Com o
     [domínio de aplicações](#dominio-de-aplicacoes), é `minha-app-k3x9q.apps.example.com`, sem o IP e
     sem aviso.
   - **Endereço de teste:** só aparece com o domínio de aplicações configurado. É o endereço do
     sslip.io, com o aviso. Serve para testar.
   - **Meu domínio ou subdomínio:** digite o domínio e crie, no seu DNS, o registro que a tela
     mostrar (tipo A para o IP da VPS, nuvem cinza no Cloudflare). Dá para criar o projeto antes de
     o DNS propagar.
   - Marque **Projeto usa WebSocket / conexões longas** se for o caso.
   - Deixe **Fazer backup** em **Sim**.
   - Clique em **Criar projeto**.

**O que conferir:** a página do projeto abre, com o menu Visão geral, Deploys, Domínios, Git,
Variáveis, E-mail, Backups e Configurações.

### 7.3 Variáveis

Abra a aba **Variáveis**. A tela lista as variáveis que o compose pede e sugere os nomes do
`.env.example` do repositório, ainda sem valor.

1. Tem o `.env` no seu computador? Clique em **Importar arquivo .env**. Nada é gravado ainda: revise.
2. Preencha o que falta (ou use **Adicionar variável**).
3. Clique em **Salvar variáveis**.

> [!TIP]
> Variável cujo nome termina em `_HOST`, `_HOSTNAME` ou `_DOMAIN` (como `SITE_HOST`) costuma esperar
> só o nome do domínio, sem `http://`, barra final, caminho, porta ou espaço. Se o valor tiver
> algum deles, a linha ganha um aviso âmbar com o valor sugerido e o botão **Corrigir**. É só um aviso:
> não impede de salvar, e o log do deploy repete a observação (sem mostrar o valor de variável com
> cara de segredo). Variáveis `_URL` não são afetadas.

> [!NOTE]
> Se o repositório já tem um `.env` próprio, o painel não o sobrescreve. As variáveis que você
> define aqui vão para um arquivo separado (`paas.env`, na pasta do projeto na VPS), e o log do
> deploy avisa do conflito e de como fazer o container recebê-las.

**O que conferir:** nenhum aviso de variável obrigatória faltando. O deploy é barrado quando falta
uma obrigatória; as do `.env.example` sem valor só geram um aviso.

### 7.4 E-mail do projeto

Precisa da [Etapa 4](#etapa-4) pronta.

1. Abra a aba **E-mail** do projeto e escolha o **Domínio de e-mail**.
2. Confira o **Endereço de envio** (ex.: `contato@envio.example.com`) e o **Nome de exibição**.
3. Defina a senha da caixa (digitar duas vezes ou gerar uma forte). A gerada aparece uma única vez.
4. Clique em **Ativar e-mail**.
5. Se o seu app usa outros nomes de variável (ex.: `SMTP_SENHA`, `EMAIL_DE`), clique em **Ligar às
   variáveis do projeto** e, em cada linha, escolha o nome que o app lê. O painel entrega o valor
   atual com esse nome a cada deploy.

**O que conferir:** o cartão mostra `SMTP_HOST = mail.envio.example.com`. Os valores `SMTP_*` e
`MAIL_*` entram sozinhos no deploy. Os valores só chegam ao app no próximo deploy.

**Nome de exibição.** É opcional (até 80 caracteres, sem quebra de linha, `<`, `>`, aspas nem barra
invertida). Em branco, vale o nome do projeto. É o que aparece para quem recebe, junto do endereço, e
é entregue ao app como `MAIL_FROM_NAME`: o `From` que o app usa é o `MAIL_FROM_NAME` com o
`MAIL_FROM`. Para trocar depois, abra a aba **Caixas** do projeto e use **Alterar nome de exibição**
na caixa (a senha, o 2FA e as mensagens não mudam); a mudança chega ao app no próximo deploy. As
outras caixas do projeto e as da página **E-mail** também aceitam um nome ao criar.

**Usar uma caixa que já existe.** Se a caixa já foi criada (por exemplo, configurada no webmail), no passo 2 escolha
**Usar uma caixa que já existe**, selecione a caixa na lista e decida a senha:

- **Informar a senha atual da caixa:** o painel confere a senha sem tentar entrar na caixa. Se o servidor
  de e-mail não deixar conferir (senha de app e verificação em duas etapas dividem o mesmo campo), o painel não aceita a senha: use a opção de trocar por uma gerada.
- **Manter a senha que o painel já guarda** (aparece quando ele a conhece).
- **Trocar a senha desta caixa por uma gerada pelo painel:** apps, celulares e o webmail que usam a senha antiga
  precisam ser atualizados. As senhas de app e a verificação em duas etapas da caixa são mantidas.

Nada é apagado: a caixa e as mensagens continuam. Depois de ligada, a caixa passa a ser gerenciada pelo
painel (o **Sincronizar** e a restauração do e-mail a mantêm com a senha guardada): não troque a senha dela
direto no webmail, use **Trocar senha** no cartão. **Desativar e-mail** solta a caixa que já existia: ela continua com as mensagens e volta a ser uma caixa comum. Uma caixa que o painel criou para um projeto continua sendo dele, mesmo desativada. Ficam de fora da lista as caixas de outros projetos (as que o e-mail deles usa e as criadas para eles) e as do
painel (`postmaster@`, `abuse@`, `dmarc@`).

**Apagar o projeto** solta o e-mail dele, mas não apaga a caixa nem as mensagens. Ao recriar o projeto, o mesmo
endereço volta a ficar livre e a caixa pode ser usada de novo.

### 7.5 Portas (só se precisar)

Na **Visão geral**, no cartão Containers, o botão **Portas** abre duas abas:

- **Este projeto:** trocar a porta publicada, **Publicar uma porta**, remover a publicação ou
  **Editar em lote**. A mudança vale no próximo deploy.
- **Todos os projetos:** as portas em uso no servidor, com os conflitos em vermelho.

A maioria dos projetos não precisa: o site abre pelo domínio, pelo proxy. Ao escolher "Em todos os
endereços (0.0.0.0)", a porta fica aberta para a internet.

### 7.6 Deploy e logs

1. Clique em **Deploy**, no topo da página do projeto.
2. Acompanhe o log ao vivo. Se um compose falhar, o log ganha um bloco "Por que falhou" (escrito pelo servidor), com as
   últimas linhas do serviço que ficou doente.

**O que conferir:** o deploy termina como **sucesso** e o endereço do projeto abre o site. Na aba
**Deploys** fica o **Histórico de deploys**. Se um guardrail barrou o deploy (ex.: porta de banco
exposta), a tela diz qual regra; veja
[Deploy bloqueado por guardrail](../guides/troubleshooting.md#deploy-bloqueado-por-guardrail)
e [Como escrever um compose que o painel aceita](../guides/compose-rules.md).

### 7.7 Certificado

Na aba **Domínios**, cada domínio do projeto mostra o estado do certificado HTTPS. A página
**Certificados** (seta ao lado de **Configurações** → **Certificados**) lista todos (painel, projetos e e-mail).

**O que conferir:** o domínio do projeto está **Válido**. Se falhou, a página **Certificados**
explica a causa provável (DNS que não aponta para a VPS, nuvem laranja, portas 80/443 fechadas) e
tem o botão **Tentar emitir agora**.

### 7.8 Aba Backups do projeto

Depois do primeiro deploy que dá certo, o painel olha os containers e sugere o que guardar.

1. Abra a aba **Backups** do projeto.
2. Confira **Bancos de dados** (PostgreSQL, MySQL, MariaDB e MongoDB vêm marcados; o Redis vem
   desmarcado, porque costuma ser cache) e **Volumes e pastas** (uploads e dados marcados; caches,
   logs e `node_modules` desmarcados).
3. Se aparecer o aviso laranja de **arquivos gravados fora de volume**, leia: eles somem no próximo
   deploy. O aviso não conta o que o próprio Docker cria (como `docker-init` ou a pasta de um
   arquivo montado).
4. Clique em **Salvar itens**.
5. Em **Frequência e cópias**, o selo diz **Seguindo o padrão do painel**. Mudar e salvar ali passa
   o projeto para **Configuração própria**; **Voltar ao padrão** desfaz.
6. Clique em **Fazer backup agora**.

**O que conferir:** o histórico do projeto mostra o backup concluído, com "cópia externa
conferida". No Cloudflare, aparece a pasta `TWS Panel Backups/<nome-do-projeto>/`.

<a id="etapa-8"></a>

## Etapa 8 — Testar uma restauração (recomendado)

Um backup que nunca foi restaurado é uma promessa. Teste agora, com dados de teste, enquanto nada
depende dele.

> [!WARNING]
> **Restaurar sobrescreve os dados do projeto pelos do backup escolhido.** Os bancos de dados e as
> pastas voltam ao estado daquela data, e tudo o que foi gravado depois se perde. O app fica parado
> durante a restauração. Faça o teste num projeto sem dados reais, ou num momento em que perder o
> que foi gravado depois do backup não faça falta.

1. **Faça um backup.** Na aba **Backups** do projeto, clique em **Fazer backup agora** e espere
   ficar concluído.
2. **Mude algo.** No app, crie um registro de teste, apague outro ou envie um arquivo. Anote o que
   mudou.
3. **Restaure.** Na mesma aba, clique em **Restaurar**.
   - Em **Escolha a data**, marque o backup do passo 1.
   - Em **Usar a cópia**, escolha **da VPS (mais rápido)** ou **do armazenamento externo**. Testar a
     externa prova também a senha e o R2.
   - Para confirmar, digite o nome do projeto e clique em **Restaurar**.
4. Acompanhe as etapas na janela. Dá para fechar: a restauração continua no servidor.

**O que conferir:** o app volta ao ar, e o que você mudou no passo 2 voltou a ser como era no
backup (o registro criado sumiu, o apagado voltou). A restauração aparece em **Últimos backups**,
em **Configurações → Backups**.

Perdeu a VPS inteira? O caminho é outro: instale o painel numa VPS nova e use **Configurações →
Backups → Restaurar de outro servidor**. O passo a passo está em
[Restaurar numa VPS nova](../guides/restore-new-server.md).

<a id="etapa-9"></a>

## Etapa 9 — Manutenção

### Atualizar o painel

Uma linha só, na VPS:

```bash
cd /opt/tws-panel && sudo git pull && sudo git log --oneline -1 && sudo docker compose up -d --build
```

**O que conferir:** o `git log --oneline -1` mostra o commit que ficou no ar. Seus projetos,
domínios, e-mail e a conta continuam como estavam. O que mudou em cada versão está no
[CHANGELOG](https://github.com/kelvindk9w/tws-panel/blob/main/CHANGELOG.md). Mais comandos em [Operação](../guides/operations.md).

### Atualizar o Docker

O hardening deixa o Docker de fora das atualizações automáticas, de propósito. De tempos em tempos,
**por SSH** (não pelo terminal do painel):

```bash
sudo apt-get update && sudo apt-get install --only-upgrade docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

O painel sai do ar por alguns segundos e volta sozinho. O porquê está no
[Wizard de segurança](security-wizard.md#as-oito-fases).

### Onde acompanhar

- **Alertas** (menu): a central de alertas, com o que o monitoramento achou. Filtre por status
  (aberto, reconhecido).
- **Auditoria** (menu **Configurações**, seta ao lado): as ações sensíveis, com quando, ação, alvo e detalhe.
- **Segurança** (menu): proteções da VPS, retrato de referência, monitoramento e reputação do
  e-mail.
- **Certificados** e **Envios** (menu **Configurações**, seta ao lado): certificados e e-mail.
- O Telegram ou o e-mail da [Etapa 5](#etapa-5), quando o painel está fechado.

### Se perder o acesso

Senha do painel, celular da verificação em duas etapas, senha do Linux, chave SSH ou domínio do
painel: cada caso tem o seu caminho de volta em **[Perdi o acesso: e agora?](../guides/recover-access.md)**.
Os comandos de emergência estão em
[Operação → Scripts de emergência](../guides/operations.md#scripts-de-emergência).

<a id="checklist"></a>

## Checklist final: painel pronto

- [ ] VPS com Ubuntu 22.04/24.04, portas 80 e 443 abertas e console do provedor conferido
- [ ] Painel instalado e o assistente concluído (conta de administrador criada)
- [ ] As 8 fases de segurança aplicadas e confirmadas, e a VPS reiniciada depois
- [ ] Verificação em duas etapas ativa e códigos de recuperação guardados
- [ ] Domínio do painel com certificado válido (e, se quiser, o acesso pelo IP desativado, com o comando de volta anotado)
- [ ] (Opcional) Domínio de aplicações verificado, para os projetos não mostrarem o IP da VPS no endereço
- [ ] Fuso horário da VPS conferido (backups às 03:00 no seu horário)
- [ ] E-mail: porta 25 liberada, checklist DNS 6/6 OK, PTR verde ou azul e certificado válido
- [ ] Caixa criada, e-mail de teste entregue e webmail abrindo
- [ ] Notificações: Telegram (ou e-mail) conectado e teste recebido
- [ ] Backups: R2 conectado, criptografia ligada, kit de recuperação guardado fora da VPS
- [ ] Primeiro backup do painel com "cópia externa conferida" e "Senha certa" (mensagem do servidor) em Testar minha senha
- [ ] Primeiro projeto no ar, com variáveis, e-mail do projeto e certificado válido
- [ ] Aba Backups do projeto conferida e um backup do projeto feito
- [ ] Uma restauração de teste feita e conferida
- [ ] Comando de atualização do painel anotado
- [ ] Roteiro **Deixe o painel pronto** do Dashboard todo feito (ou com "Não vou usar" nos opcionais que você dispensou)
