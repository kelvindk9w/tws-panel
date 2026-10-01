# Relatório — certificado de verdade no e-mail do painel (01/10/2026)

Branch `feat/email-tls`. Este repositório é público: nada aqui tem IP real, senha
ou nome de cliente. `203.0.113.10` e `exemplo.com.br` são valores de exemplo.

## O problema

- O servidor de e-mail do painel (container `paas-stalwart`, Stalwart v0.11.8) rodava
  **sem certificado configurado**: o Stalwart gerava um autoassinado.
- Projetos com "E-mail do projeto" recebiam `SMTP_HOST=paas-stalwart`, porta 587.
- App que confere o certificado recusa a conexão. O cassino usa nodemailer com
  `requireTLS` e a verificação padrão, então ia quebrar por dois motivos: o certificado
  é autoassinado e o nome `paas-stalwart` não está em nenhum certificado público.
- Além disso, o dono do produto ia cadastrar o domínio principal da empresa, que já tem
  e-mail funcionando em outro provedor. O checklist manda apontar o MX para a VPS:
  seguir isso desviaria todo o e-mail da empresa.

## O que foi feito

### 1. Certificado de verdade para `mail.<domínio>`

**Quem emite é o Caddy.** O Caddy central (`paas-caddy`) já emite os certificados dos
sites e do painel. Agora o Caddyfile ganha um bloco para cada `mail.<domínio>`, que
responde uma página simples ("Servidor de e-mail — não há site aqui"). Esse bloco faz
o Caddy emitir o certificado desse nome (Let's Encrypt, com o ZeroSSL de reserva).
Se o nome já é de um site ou do painel, o bloco extra não entra: o certificado já sai
pelo bloco existente, e dois blocos com o mesmo nome derrubariam o Caddyfile inteiro.

**O painel copia o certificado para o Stalwart.** O Caddy guarda o par em
`/data/caddy/certificates/<emissor>/<host>/<host>.crt|.key`, no volume `paas_caddy_data`.
O painel lê o par pelo daemon (`docker exec paas-caddy find … / cat …`) e confere três
coisas antes de usar: o nome bate, o certificado está na validade e a chave é desse
certificado. Depois entrega ao Stalwart só esse par, em
`/opt/stalwart-mail/etc/certs/` (pasta 0700, arquivos 0600), junto com o `config.toml`.
A entrega usa o `docker cp` que o painel já usava para o `config.toml`.

**Por que copiar em vez de montar o volume do Caddy.** Montar o volume do Caddy no
Stalwart (mesmo só para leitura) daria a um segundo serviço exposto na internet as
chaves privadas de **todos** os sites e a conta ACME. Com a cópia, ele só recebe a
chave do próprio nome. A cópia também resolve a pasta do emissor: o painel procura em
todas, e o caminho não fica fixo no Let's Encrypt.

**Sintaxe no Stalwart v0.11.8 (conferida no servidor real).** Cada host com certificado
ganha uma seção:

```toml
[certificate.mail-exemplo-com-br]
cert = "%{file:/opt/stalwart-mail/etc/certs/mail-exemplo-com-br.crt}%"
private-key = "%{file:/opt/stalwart-mail/etc/certs/mail-exemplo-com-br.key}%"
default = true
```

O Stalwart escolhe o certificado pelo nome que o cliente pede (SNI), a partir dos nomes
que estão no próprio certificado. O certificado do hostname do servidor é marcado como
`default` e atende quem não manda SNI. A chave EC (formato SEC1, o que o Caddy grava)
foi aceita. Enquanto nada foi emitido, não há seção e o Stalwart continua com o
autoassinado.

**Renovação.** O Let's Encrypt renova a cada ~60 dias, e o Caddy faz isso sozinho. O
painel roda a sincronização (`MailService.syncTls`) em vários momentos: 1 minuto depois
do boot, a cada hora, ao iniciar o servidor, ao adicionar ou remover um domínio e ao
abrir a página E-mail. Em cada rodada ele compara o que o Caddy tem com o que instalou
da última vez (impressão digital, guardada em `data/mail/mail.json`, sem a chave):

| O que mudou | O que o painel faz |
|---|---|
| nada | nada |
| só o conteúdo (renovação) ou os aliases | entrega os arquivos e chama `GET /api/reload/certificate`: troca sem derrubar conexão (se a API falhar, reinicia) |
| apareceu certificado de um nome novo, ou o hostname mudou | entrega e **reinicia** o container (alguns segundos) |

Comportamento conferido no Stalwart real:
- `/api/reload/certificate` relê os **arquivos** das seções que já existem;
- nem ele nem `/api/reload` releem o `config.toml` local, então uma seção nova só vale
  depois de reiniciar o container.

Por isso a primeira emissão de cada domínio custa um reinício, e as renovações não
custam nenhum.

**ACME embutido do Stalwart: descartado.** Ele exigiria o Caddy repassando
`/.well-known/acme-challenge` só daquele nome para o Stalwart, uma segunda conta ACME,
outra fila de renovação para monitorar e uma configuração ACME da linha v0.11 que já
está descontinuada. A abordagem com o Caddy reaproveita o emissor que já funciona para
os sites e pôde ser validada localmente de ponta a ponta. O ACME embutido não pode.

### 2. O projeto conecta pelo nome do certificado

- O container `paas-stalwart` ganha, na `paas-net`, o alias `mail.<domínio>` de cada
  domínio cadastrado, além de `paas-stalwart`. Container que já existe recebe os aliases
  na próxima sincronização: o Docker não acrescenta alias a uma conexão, então o painel
  desconecta e reconecta. A rede interna fica fora por um instante, e as portas
  publicadas no host não caem.
- O painel passa a injetar `SMTP_HOST=mail.<domínio da caixa>`, com `SMTP_PORT=587`.
  Dentro da `paas-net`, esse nome resolve para o container do Stalwart: a conexão não
  sai pela internet e o certificado bate. **Projetos com e-mail ativo recebem o valor
  novo no próximo deploy.**
- O hostname do servidor passou a ser `mail.<1º domínio>` de verdade. O comentário
  dizia isso, mas o código usava `mail.localhost` quando não havia `PAAS_MAIL_HOSTNAME`.

### 3. Estado visível na página E-mail

Novo card **"Certificado do servidor de e-mail"**. Para cada `mail.<domínio>` ele
mostra:

- **válido**: o emissor e a data de validade;
- **pendente**: o que falta e a resposta do servidor.

A conferência é feita como um app faz, com `certificateStatus()` de
`packages/deploy/src/tls-status.ts`: TLS com SNI, validação da cadeia e do nome. Com o
painel em container, ela conecta em `mail.<domínio>:465` pela `paas-net`, o mesmo
caminho do projeto. O card diz o que falta conforme o caso:

- sem registro A: criar o A de `mail.<domínio>` com o IP da VPS, nuvem **cinza** na
  Cloudflare;
- IP da Cloudflare (nuvem laranja): trocar para cinza;
- outro IP: qual é o IP atual e para qual trocar;
- DNS certo e certificado ainda não emitido: aguardar e conferir as portas 80/443;
- certificado emitido mas ainda não apresentado: o painel instala em instantes.

Botão "Conferir de novo". Falha ao instalar o certificado também aparece no card.

### 4. Proteção contra desviar o e-mail da empresa

Ao adicionar um domínio, o painel consulta o MX nos resolvers públicos:

- **MX em outro servidor**: aviso em vermelho. Ele diz onde o e-mail chega hoje e que
  *"apontar o MX para esta VPS desviaria todo o e-mail que hoje chega em
  <servidor atual>"*, e recomenda `envio.<domínio>` com um botão que já cadastra o
  subdomínio. Para seguir com o domínio original é preciso marcar a confirmação e
  clicar em "Seguir com <domínio> mesmo assim".
- **Consulta falhou**: aviso próprio, com a mesma confirmação. Não dá para afirmar que
  o domínio não recebe e-mail.
- **Sem MX, MX nulo, ou MX já apontando para cá**: segue direto.

A API responde `409 domain_receives_mail` com `existingMail` e só segue com
`confirmExistingMail: true`.

### 5. Correção encontrada no caminho: o painel em container nunca falou com o Stalwart

O `StalwartClient` e a espera de prontidão usavam `http://127.0.0.1:8080`. Com o painel
em container (produção), esse endereço é o próprio painel. Agora, em container, a API vai
por `http://paas-stalwart:8080`, e o painel se liga à `paas-net`. Isso acontece ao
iniciar o servidor e, depois de uma atualização que recria o container do painel, na
primeira operação que precisa do Stalwart. É a mesma lição de sempre: *isto roda no
container ou no host?*

### Arquivos principais

- `packages/mailer/src/tls-certificates.ts` (novo): leitura e conferência do par no Caddy
- `packages/mailer/src/mx-guard.ts` (novo): consulta e classificação do MX
- `packages/mailer/src/server.ts`: seções de certificado, aliases, `applyTls`, `connectContainer`
- `packages/mailer/src/smtp-inject.ts`: `SMTP_HOST=mail.<domínio>`
- `packages/deploy/src/caddy.ts` e `engine.ts`: bloco `mail.<domínio>` no Caddyfile
- `apps/server/src/services/mail-service.ts`: `syncTls`, `tlsStatus`, MX no `addDomain`, rede
- `apps/server/src/routes/mail.ts`: `GET /api/mail/tls`, manutenção de hora em hora
- `apps/server/src/services/deploy-service.ts`: `setMailHostsProvider`, `refreshProxy`
- `apps/web/src/pages/MailPage.tsx`: card do certificado e aviso de MX
- `comoFuncionaSistema/email/*.json` (incluindo o novo `certificado-servidor.json`)

## O que foi validado, e como

### Testes automatizados

| Pacote | Testes | Cobertura (linhas / branches) |
|---|---|---|
| packages/core | 39 | (sem cobertura configurada) |
| packages/deploy | 302 (antes 295) | 99,51% / 95,57%, igual a antes |
| packages/mailer | 104 (antes 71) | 100% / 99,32%; antes 100% / 99,08% |
| apps/server | 822 (antes 784) | 98,26% / 92,22%, igual a antes |
| apps/web | 375 (antes 366) | 81,94% / 75,46%, igual a antes |

Os tipos (`tsc --noEmit`) passam nos cinco pacotes. Os certificados dos testes são
gerados com o openssl na hora: nenhuma chave privada vai para o repositório.

### Validação local de ponta a ponta (Docker real, WSL)

O teste rodou numa rede isolada (`emailtls-teste-net`, sub-rede `10.250.41.0/24`),
sem tocar na `paas-net` nem no `paas-caddy`. Containers, volumes e rede foram
removidos no fim.

**Passo A: Stalwart com certificado de uma CA de teste (openssl).**

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 30 \
  -subj "/O=CA de Teste TWS/CN=CA de Teste TWS"
openssl req -newkey rsa:2048 -nodes -keyout mail.key -out mail.csr -subj "/CN=mail.exemplo.test"
printf "subjectAltName=DNS:mail.exemplo.test\n" > ext.cnf
openssl x509 -req -in mail.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out mail.crt -days 20 -extfile ext.cnf
docker network create --subnet 10.250.41.0/24 emailtls-teste-net
docker create --name emailtls-stalwart --network emailtls-teste-net \
  --network-alias paas-stalwart --network-alias mail.exemplo.test \
  -p 127.0.0.1:18080:8080 stalwartlabs/mail-server:v0.11.8
# config.toml com [certificate.mail-exemplo-test] (sintaxe acima) + certs/ → docker cp → docker start
```

Os comandos abaixo rodaram de dentro de um container na mesma rede, então
`mail.exemplo.test` resolveu pelo alias:

```bash
openssl s_client -starttls smtp -connect mail.exemplo.test:587 -servername mail.exemplo.test \
  -CAfile ca.crt -verify_hostname mail.exemplo.test -verify_return_error
openssl s_client -connect mail.exemplo.test:465 -servername mail.exemplo.test -CAfile ca.crt ...
```

Resultado:

| Porta | Certificado apresentado | Verificação |
|---|---|---|
| 587 STARTTLS | `subject=CN=mail.exemplo.test`, `issuer=O=CA de Teste TWS` | `Verify return code: 0 (ok)` |
| 465 TLS implícito | idem | `0 (ok)` |
| 25 STARTTLS | idem | `0 (ok)` |
| 993 IMAPS | idem | `0 (ok)` |
| 587 sem a CA de teste | — | `20 (unable to get local issuer certificate)`, recusa como esperado |

No mesmo Stalwart foram conferidos três comportamentos:

- **Renovação.** O arquivo foi trocado por outro certificado (chave EC/SEC1, serial
  `…6B` → `…6C`) e `GET /api/reload/certificate` foi chamado. As portas 465 e 587
  passaram a apresentar o serial novo **sem reiniciar**.
- **Seção nova no `config.toml`** (segundo domínio, `mail.outro.test`). Depois de
  `/api/reload/certificate` e de `/api/reload`, o SNI `mail.outro.test` continuava com
  `62 (hostname mismatch)`. Depois de `docker restart` passou a dar `0 (ok)`. Daí a
  regra "nome novo → reiniciar".
- **SNI com dois certificados.** Cada nome recebeu o próprio certificado.

**Passo B: o código do painel de ponta a ponta.** Um script com `tsx` chamou as funções
do painel contra containers reais:

```bash
DOCKER_CONFIG=<pasta com {}> ./node_modules/.bin/tsx e2e.mts
```

1. `CaddyManager.ensureRunning` subiu um **Caddy real** com o Caddyfile gerado por
   `renderCaddyfile([], undefined, ["mail.exemplo.test"])`. Só no teste foi acrescentado
   `{ local_certs }` no topo, para usar a CA local do Caddy no lugar do Let's Encrypt.
2. `readCaddyCertificate` leu o par do volume do Caddy:
   `emissor=Caddy Local Authority - ECC Intermediate`, validade de 12 h.
3. `StalwartManager.start` criou o Stalwart com o certificado e os aliases
   `["paas-stalwart","mail.exemplo.test"]`.
4. `StalwartClient` criou o domínio `exemplo.test` e a caixa `app@exemplo.test`.
5. Com o openssl pelo alias, 587 e 465 apresentaram a impressão digital do certificado
   do Caddy, `Verify return code: 0 (ok)`. A cadeia (folha + intermediária) foi
   repassada.
6. `certificateStatus` (o que a página usa) respondeu
   `{"ok":true,"issuer":"Caddy Local Authority - ECC Intermediate",...}`. Sem a CA:
   `unable to get local issuer certificate`.
7. **nodemailer** (`requireTLS: true`, verificação ligada, `tls.ca` = raiz local do
   Caddy) rodou num container `node:24-slim` na rede:

   ```
   [OK]      SMTP_HOST=mail.exemplo.test:587, verificação ligada: 250 2.0.0 Message queued for delivery.
   [OK]      mail.exemplo.test:465 TLS implícito, verificação ligada: 250 2.0.0 Message queued for delivery.
   [RECUSOU] ANTES: SMTP_HOST=paas-stalwart: Hostname/IP does not match certificate's altnames:
             Host: paas-stalwart. is not in the cert's altnames: DNS:mail.exemplo.test
   [RECUSOU] sem a CA de teste: unable to get local issuer certificate
   ```

   A terceira linha é exatamente o defeito que o cassino teria com o valor antigo.
8. **Renovação pelo Caddy.** O certificado foi apagado no Caddy e o Caddy reiniciado,
   e ele emitiu outro (`80:A4…` → `1C:89…`). `applyTls({restart:false})` respondeu
   `reloaded`, o `StartedAt` do Stalwart ficou igual (**sem reinício**) e 465 e 587
   passaram a apresentar `1C:89…`.
9. **Complemento.** Com o container rodando, `applyTls` acrescentou o alias
   `mail.outro.test` sem reiniciar. `applyTls({restart:true})` reiniciou, e a API
   voltou com os aliases preservados. Dentro do container ficaram `certs/` com 0700,
   arquivos com 0600 e o `config.toml` com a seção `[certificate.mail-exemplo-test]`.

### O que NÃO dá para validar localmente

- **A emissão pelo Let's Encrypt.** O ACME exige um domínio público cujo registro A
  aponte para a máquina e as portas 80/443 alcançáveis da internet. Localmente o Caddy
  usou a CA local dele. O resto do caminho (arquivos do Caddy → painel → Stalwart → app)
  é o mesmo, mas a emissão real só se confirma na VPS.
- Entrega para fora (porta 25 de saída, reputação, PTR, SPF/DKIM/DMARC avaliados pelo
  Gmail ou Outlook).
- O comportamento do painel **em container** (rede `paas-net`, `paas-stalwart:8080`)
  foi coberto por testes com dublês. O teste real rodou com o código fora de container.

## Na VPS: passo a passo para o dono do produto

> Recomendação forte: use um **subdomínio só para o envio**, por exemplo
> `envio.suaempresa.com.br`. O domínio principal (`suaempresa.com.br`) continua
> recebendo e-mail onde recebe hoje (Google, Microsoft, Hostinger…). Os passos abaixo
> usam `envio.suaempresa.com.br` como exemplo.

### Passo 1: atualizar o painel

No terminal da VPS (SSH):

```bash
cd /opt/tws-panel && sudo git pull && sudo git log --oneline -1 && sudo docker compose up -d --build
```

Confira na linha do `git log` que o commit é o desta entrega. Em até 1 minuto depois de
o painel subir, ele ajusta sozinho o servidor de e-mail. O container `paas-stalwart`
pode **reiniciar uma vez** (alguns segundos), para ganhar o hostname e os aliases novos.

### Passo 2: conferir se a VPS consegue enviar e-mail (porta 25 de saída)

Alguns provedores bloqueiam a porta 25 de saída por padrão (DigitalOcean, Vultr,
Hetzner em contas novas, AWS, Google Cloud, Azure). Sem ela, o e-mail não sai da VPS
para o Gmail ou Outlook. Teste na VPS:

```bash
nc -vz -w 5 gmail-smtp-in.l.google.com 25
```

- `succeeded` / `open`: liberada.
- `timed out`: bloqueada. Abra um chamado no provedor pedindo a liberação da porta 25
  de saída para envio de e-mail transacional.

### Passo 3: cadastrar o domínio no painel

1. No menu, clique em **E-mail**.
2. Se o servidor estiver parado, clique em **Iniciar servidor**.
3. No campo do card **Domínios de e-mail**, digite `envio.suaempresa.com.br` e clique
   em **Adicionar domínio**.
4. Se aparecer o **aviso vermelho** "Este domínio já recebe e-mail em outro servidor",
   **não** siga com o domínio principal. Clique em **Usar envio.… (recomendado)**.

### Passo 4: criar os registros DNS

Clique no domínio cadastrado: a página mostra o **checklist DNS** com os valores
exatos, com o IP da sua VPS e a chave DKIM. Para `envio.suaempresa.com.br`, no painel
do DNS (na Cloudflare: *DNS → Registros → Adicionar registro*), crie:

| Tipo | Nome (na Cloudflare) | Valor | Observação |
|---|---|---|---|
| A | `mail.envio` | IP da VPS | **Nuvem CINZA ("Somente DNS")**. Com a nuvem laranja o certificado não é emitido e o e-mail não chega à VPS. |
| MX | `envio` | `mail.envio.suaempresa.com.br`, prioridade 10 | Só para o subdomínio: **não** mexe no MX do domínio principal. |
| TXT (SPF) | `envio` | o valor `v=spf1 ip4:<IP> ~all` do checklist | |
| TXT (DKIM) | `paas._domainkey.envio` | o valor `v=DKIM1; k=rsa; p=…` do checklist | copie inteiro, com o botão de copiar |
| TXT (DMARC) | `_dmarc.envio` | o valor `v=DMARC1; p=none; …` do checklist | |

Depois clique em **Verificar agora** até todos ficarem verdes. A propagação leva de
minutos a algumas horas.

### Passo 5: DNS reverso (PTR), no painel do provedor da VPS

O PTR não fica no Cloudflare: ele é configurado **no painel do provedor da VPS**. Na
Contabo: *Customer Control Panel → Reverse DNS Management → editar o IP da VPS*. O
valor é `mail.envio.suaempresa.com.br`, o mesmo hostname do registro A. Se o provedor
não tiver essa opção, use o texto pronto de chamado que o painel mostra no card
**Reverse DNS (PTR)**.

### Passo 6: conferir o certificado

1. Volte em **E-mail**.
2. O card **Certificado do servidor de e-mail** mostra `mail.envio.suaempresa.com.br`.
3. Clique em **Conferir de novo** até aparecer **válido**, "Emitido por Let's Encrypt".
   Com o registro A certo, costuma levar poucos minutos. Na primeira vez o servidor de
   e-mail reinicia sozinho por alguns segundos.
4. Se continuar **pendente**, o próprio card diz o que falta. Os casos comuns são o
   registro A ausente, a nuvem laranja, ou as portas 80/443 fechadas no firewall do
   provedor.

O painel renova o certificado sozinho. Não há nada a fazer a cada 60 dias.

### Passo 7: ligar o e-mail no projeto e fazer o deploy

1. Abra o projeto (ex.: o cassino) → seção **E-mail** → escolha o domínio → **Ativar e-mail**.
   Se já estava ativo, pule.
2. Confira que a seção mostra `SMTP_HOST = mail.envio.suaempresa.com.br`.
3. Clique em **Deploy**. O valor novo só chega ao app no deploy.
4. Teste o envio pelo app (ex.: "esqueci a senha"). Com `requireTLS` e a verificação
   padrão, ele deve conectar sem configuração extra.

### O que conferir se algo falhar

- **App recusa o certificado.** Abra E-mail e veja se o card está **válido**. Confira
  também que o projeto foi reimplantado depois da atualização (o `SMTP_HOST` antigo era
  `paas-stalwart`).
- **E-mail sai mas cai no spam.** Confira o checklist DNS todo verde e o PTR.
  Mantenha o DMARC em `p=none` nas primeiras semanas.
- **E-mail não sai.** A porta 25 de saída está bloqueada (Passo 2).

## Pendências e incertezas

- **Validar na VPS** a emissão real (Let's Encrypt), o reinício único do Stalwart após a
  atualização e o envio do cassino.
- **A porta 8080 do Stalwart (API e webadmin) é publicada no host em todas as
  interfaces.** Isso já era assim antes desta entrega. Como as portas publicadas pelo
  Docker passam na frente do UFW, ela fica acessível pela internet, protegida só pela
  senha do fallback-admin. Agora que o painel em container fala com a API pela
  `paas-net`, dá para deixar de publicar a 8080 (ou publicá-la só em `127.0.0.1`). Fica
  como próximo passo, porque muda a criação do container e o fluxo de desenvolvimento.
- **A Fase 03 do hardening** (UFW) só libera 25/465/587/993 com `--profile mail`, e o
  painel nunca passa essa opção. Hoje isso não bloqueia o e-mail, porque as portas
  publicadas pelo Docker passam na frente do UFW. Mesmo assim vale alinhar a fase com
  o e-mail.
- **Contas de e-mail em clientes externos (Outlook, Thunderbird)** usam
  `mail.<domínio>` como servidor, e esse nome agora tem certificado válido. A
  conferência foi feita com openssl em 993 e 587, não com um cliente real.
- **Stalwart v0.11.8** continua com o CVE-2025-61600 aberto (pendência antiga). Uma
  migração futura de versão precisa reconferir a sintaxe `%{file:...}%` e o
  comportamento de `/api/reload/certificate`.
