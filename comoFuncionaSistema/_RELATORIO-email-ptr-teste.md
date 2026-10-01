# Relatório — PTR em três níveis e "Enviar e-mail de teste" (01/10/2026)

Branch `feat/email-ptr-teste`. Este repositório é público: nada aqui tem IP real, senha
ou nome de cliente. `203.0.113.10` e `exemplo.com.br` são valores de exemplo.

## O problema

Validação real na VPS de teste do dono do produto (Contabo). Ele cadastrou
`envio.<domínio>` e todos os registros (A, MX, SPF, DKIM, DMARC) ficaram verdes. Duas
coisas atrapalharam:

1. **O PTR ficou amarelo** com "Sem PTR válido o Gmail, Yahoo e Microsoft podem
   rejeitar suas mensagens… Abra um chamado no provedor da VPS". Só que o IP tinha o
   nome reverso genérico da Contabo (`vmiNNNNNNN.contaboserver.net`), e esse nome
   aponta de volta para o mesmo IP. Ou seja, o FCrDNS, que é o que o Gmail exige, **já
   passava**. Faltava só o nome ser `mail.<domínio>`, que é um sinal leve de reputação,
   não um motivo de recusa. E na Contabo a própria pessoa troca o nome no painel, sem
   chamado.
2. **Não havia como ver o e-mail funcionando** sem um projeto. Como a VPS de teste é
   reinstalada várias vezes, o dono queria um botão que mandasse uma mensagem e dissesse
   se ela chegou.

## O que mudou (pelo comportamento)

### 1. PTR em três cores

Depois de "Verificar agora", o card **Reverse DNS (PTR)** mostra:

- **Verde**: o nome reverso do IP é `mail.<domínio>`.
- **Azul (novo)**: o IP tem um nome reverso diferente, mas esse nome aponta de volta
  para o mesmo IP. O card diz que o envio está liberado e que Gmail, Yahoo e Microsoft
  aceitam. Trocar para `mail.<domínio>` aparece como **opcional**, recolhido. **Conta
  como OK**: a contagem fica "6/6 OK", o domínio deixa de aparecer com "pendências" na
  lista da página E-mail, e o passo "e-mail do servidor" do roteiro de primeiros passos
  considera o DNS certo. O roteiro e a lista já liam o mesmo resumo da verificação,
  então acompanharam sem mudança própria.
- **Amarelo**: o IP não tem nome reverso, ou o nome não aponta de volta para o IP. Só
  aí aparece o aviso de que os grandes provedores podem recusar.

**Instrução por provedor.** O painel reconhece o provedor pelo final do nome reverso e
mostra onde a própria pessoa troca:

| Nome reverso termina em | Provedor | O que o painel diz |
|---|---|---|
| `contaboserver.net` | Contabo | my.contabo.com → "Reverse DNS Management" → editar o IP → `mail.<domínio>` |
| `your-server.de` | Hetzner | Hetzner Console → servidor → aba "Networking" → no IP, "Reverse DNS" |
| `vultrusercontent.com` | Vultr | my.vultr.com → servidor → Settings → IPv4 → "Reverse DNS" |

O texto pronto de chamado só aparece quando o provedor é desconhecido (ou quando o IP
não tem nome reverso). Nesse caso a página lembra, antes do chamado, que em vários
provedores dá para trocar sozinho, e que na DigitalOcean o nome reverso segue o nome do
droplet. A DigitalOcean não entra na tabela porque não há como reconhecê-la pelo nome.
Para acrescentar um provedor, basta um item na lista `PTR_PROVIDERS` de
`packages/mailer/src/dns-checklist.ts`.

**Correção no caminho.** A verificação do domínio ignorava o resolvedor DNS injetado
(usava sempre o público). Agora usa o injetado quando existe. Em produção nada muda.

### 2. Botão "Enviar e-mail de teste"

Na página do domínio, aba **Checklist DNS**, há um card novo. A pessoa digita um
endereço (ex.: o Gmail dela) e clica em **Enviar**. O painel:

1. manda uma mensagem simples, assunto "Teste do TWS Panel", explicando que ela veio
   do servidor de e-mail da VPS, a partir de `postmaster@<domínio>`;
2. consulta o destino a cada 3 s, por até 2 min, e mostra:
   - azul **"Na fila / tentando entregar…"**;
   - verde **"Entregue ao servidor do destinatário (aceito pelo Gmail)"**, com a
     resposta do servidor e o lembrete **"Confira também a pasta Spam"**;
   - vermelho **"Recusado: <motivo devolvido pelo servidor do destinatário>"**;
   - amarelo **"Adiada: <motivo>, nova tentativa às HH:MM"**;
3. depois de 2 min sem resultado definitivo, para de consultar, explica que o servidor
   continua tentando sozinho e oferece **"Conferir de novo"**.

Limite: 1 teste a cada 30 s e 20 por hora, por instância do painel. Uma tentativa que
falha também conta, para o botão não virar martelo nem fonte de spam. Cada envio fica
na auditoria (`mail.test.send`, com remetente e destinatário).

O card avisa que o teste fala com o servidor de e-mail por dentro da VPS. Por isso ele
funciona mesmo antes de o certificado de `mail.<domínio>` ficar pronto. O estado do
certificado continua no card próprio da página E-mail.

## Decisões

### De onde vem a senha da caixa do teste

A mensagem sai de **`postmaster@<domínio>`**. O painel cria essa caixa ao cadastrar o
domínio e **já guarda a senha dela** em `data/mail/mail.json` (0600), a mesma usada
pelas credenciais e pela injeção SMTP. Não foi preciso criar uma caixa técnica nova nem
um segredo novo. Ela também é a caixa que recebe o aviso de entrega (ver abaixo). Se um
domínio antigo não tiver essa caixa registrada, o botão responde com uma explicação
(remover e cadastrar o domínio de novo a recria).

### Como a mensagem é enviada

O painel usa a submission do Stalwart, autenticada, como os projetos fazem: porta 465 com
TLS. Em container, ele vai por `paas-stalwart` na paas-net; fora de container
(desenvolvimento), por `127.0.0.1` na porta publicada. O cliente SMTP é mínimo e foi
escrito no próprio pacote (`packages/mailer/src/smtp-send.ts`), sem dependência nova.

Nessa conexão interna **a verificação do certificado fica desligada**, de propósito: em
ambiente de teste ele ainda pode ser autoassinado, e o teste não pode falhar por isso.
A conversa é do painel com o próprio servidor de e-mail, pela rede Docker. O certificado
continua sendo conferido à parte, como um app confere (card "Certificado do servidor de
e-mail").

### Como a fila é lida, e por que só a fila não basta

Fontes conferidas no código do Stalwart **v0.11.8** (tag no GitHub):

- **A fila** (`GET /api/queue/messages?values=1&text=<destinatário>`,
  `crates/jmap/src/api/management/queue.rs`). Cada mensagem traz `env_id`, `domains[]`
  com `status`, `next_retry` e `recipients[]`. O status é `"scheduled"` ou
  `{"completed"|"temp_fail"|"perm_fail": "<texto>"}`. O painel acha a mensagem do teste
  pelo `env_id`: ele envia um identificador próprio (ENVID `tws-teste-<id>`).
- **O que acontece quando a mensagem sai da fila.** Quando nada mais está pendente, o
  Stalwart **remove a mensagem da fila tanto na entrega quanto na recusa definitiva**
  (`crates/smtp/src/outbound/delivery.rs`). Então "sumiu da fila" sozinho **não**
  significa "entregue".
- **O aviso de entrega (DSN).** Antes de remover, o Stalwart manda um aviso ao
  remetente (`crates/smtp/src/queue/dsn.rs`) com assunto fixo: "Successfully delivered
  message" (só quando pedido, e o painel pede com `NOTIFY=SUCCESS,FAILURE,DELAY`),
  "Failed to deliver message" ou "Warning: Delay in message delivery". O texto traz
  uma linha por destinatário com a resposta do servidor dele. O painel lê esse aviso
  na caixa `postmaster@` pela API JMAP do próprio Stalwart, com a senha que já guarda.

Na prática:

- mensagem na fila: o estado vem da fila (na fila / adiada com motivo e próxima
  tentativa / recusada);
- mensagem fora da fila: o estado vem do aviso (entregue com a resposta do servidor, ou
  recusada com o motivo);
- fora da fila e sem aviso: o painel espera 20 s e então trata como **entregue sem
  recibo** ("saiu da fila sem erro registrado"). Uma recusa definitiva sempre gera
  aviso ao remetente, então isso só acontece se a leitura do aviso falhar.

**Achado da validação local.** O Stalwart só anuncia a extensão DSN para sessão
**autenticada**, e a lista de extensões é calculada na hora do EHLO. Na 465 o EHLO vem
antes do AUTH, então no primeiro teste real o aviso de sucesso não foi pedido. O cliente
agora faz um segundo EHLO depois do AUTH. No código do Stalwart, o reset da sessão no
EHLO não mexe na autenticação. Com isso, o DSN passou a ser aceito.

O acompanhamento fica **só em memória** por 1 hora. Se o painel reiniciar, os testes em
andamento somem e a consulta responde "Teste não encontrado".

## Como foi testado

### Testes automatizados (TDD: teste escrito antes, visto falhar, depois passando)

| Pacote | Testes | Antes |
|---|---|---|
| packages/core | 45 | 45 |
| packages/mailer | 150 | 105 |
| apps/server | 880 | 849 |
| apps/web | 407 | 396 |

`tsc --noEmit` limpo nos quatro. Cobertura do mailer: 100% de linhas, 98,46% de
branches, acima do mínimo de 98%. Nos testes de web e servidor, a API e o Docker são
simulados.

O que os testes cobrem:

- **Checklist**: verde, azul (Contabo e provedor desconhecido), amarelo (nome que não
  volta, nome da Contabo que não volta, sem PTR), mais de um nome reverso,
  reconhecimento do provedor (Contabo, Hetzner, Vultr, ponto final, maiúsculas, sufixo
  parcial que não deve casar) e a contagem.
- **Servidor**: o azul chega ao resumo do domínio (`lastVerify` 6/6) e o amarelo deixa
  uma pendência. Para o envio: endereço do Stalwart, autenticação, ENVID, os 3 limites,
  os erros 400/404/409/429/502 e cada estado do acompanhamento (fila, aviso de entrega,
  sumiço sem aviso, falha da fila e falha do aviso). Para a rota: schema (sem campo,
  dois destinatários, lista, quebra de linha, campo extra), auditoria e 401.
- **SMTP**: um servidor SMTP falso em TCP e outro com **TLS real e certificado
  autoassinado** gerado na hora pelo openssl, para provar que o teste não falha por
  isso. Também cobre o EHLO depois do AUTH, a recusa de senha (535), a recusa do
  destinatário, o tempo esgotado, a conexão recusada e a tentativa de injetar um
  segundo destinatário.
- **Web**: o card do PTR azul (sem chamado, instrução recolhida, contagem 2/2), o
  amarelo da Contabo, o envio, a consulta periódica, os estados entregue, recusado,
  adiado e entregue sem recibo, o tempo máximo com "Conferir de novo" e o erro 429.

### Validação local com Stalwart real (Docker, WSL)

Subi um `stalwartlabs/mail-server:v0.11.8` com o `config.toml` gerado pelo próprio
painel (`renderConfigToml`), em portas locais. Criei o domínio e a caixa postmaster
pela API e rodei o código do painel contra ele:

1. **Envio pela 465 com TLS autoassinado**: aceito ("250 2.0.0 Message queued for
   delivery.").
2. **Antes da correção**, o DSN não era pedido (`dsn: false`). Foi esse teste que
   revelou o segundo EHLO necessário. **Depois da correção**: `dsn: true`.
3. **Recusa** (destino `ninguem@nao-existe.invalid`): a mensagem saiu da fila na hora e
   o painel achou o aviso por JMAP: recusado, "connection to 'nao-existe.invalid' failed:
   record not found for MX".
4. **Entrega** (destino numa segunda caixa do mesmo servidor): a fila devolveu
   exatamente o formato documentado acima (`"status":"scheduled"`, `env_id`,
   `next_retry`, `orcpt`…), e o aviso lido por JMAP foi: entregue, "delivered to
   'localhost' with code 250 (2.1.5) 'OK'".

O container e a imagem foram removidos depois.

## O que só dá para validar na VPS real

- **Entrega de verdade para o Gmail, Outlook ou Yahoo**: a porta 25 de saída, a
  reputação do IP e a resposta real ("250 2.0.0 OK … gsmtp"). Localmente o destino
  externo não foi testado, de propósito, para não mandar mensagem de um IP residencial.
- **O estado "Adiada"** com um motivo real (ex.: porta 25 bloqueada → "Connection to
  'gmail-smtp-in.l.google.com' failed: …" e a nova tentativa). A lógica está testada com
  o formato do código-fonte, mas não com um adiamento real.
- **O caminho em container** (`paas-stalwart:465` e `paas-stalwart:8080` pela paas-net)
  foi coberto só por dublês. A validação local rodou com o código fora de container.
- **O PTR azul** com o nome real da Contabo, e as instruções dos painéis da Contabo,
  Hetzner e Vultr: os nomes de menu foram escritos a partir da documentação pública e
  podem mudar.

## Passo a passo na VPS

1. Atualize o painel:

   ```bash
   cd /opt/tws-panel && sudo git pull && sudo git log --oneline -1 && sudo docker compose up -d --build
   ```

2. Abra **E-mail** → clique no domínio (ex.: `envio.suaempresa.com.br`) → **Verificar
   agora**. Com o nome reverso genérico da Contabo, o card do PTR deve ficar **azul**, e
   a contagem, **6/6 OK**.
3. No card **Enviar e-mail de teste**, digite o seu Gmail e clique em **Enviar**.
4. Em alguns segundos deve aparecer, em verde, **"Entregue ao servidor do destinatário
   (aceito pelo Gmail)"**. Abra o Gmail e confira também a pasta **Spam**.
5. Se aparecer **amarelo "Adiada: Connection to … failed"**, a porta 25 de saída
   provavelmente está bloqueada. Veja o Passo 2 de `_RELATORIO-email-tls.md`.
6. Se aparecer **vermelho "Recusado: …"**, o motivo é o que o Gmail respondeu.
   Normalmente ele cita SPF, DKIM, DMARC ou o nome reverso. Confira o checklist e tente
   de novo depois de 30 s.

## Pendências e incertezas

- **JMAP com HTTP Basic** na porta 8080: funcionou no Stalwart real local. Não há
  configuração do painel que desligue isso, mas uma mudança futura de versão precisa
  reconferir.
- **Avisos de entrega acumulam** na caixa `postmaster@` (um por teste). O painel não os
  apaga. Quem abrir essa caixa num cliente de e-mail vai vê-los.
- **O id da fila (u64)** perde precisão no JSON do JavaScript. O painel não usa o id:
  acha a mensagem pelo ENVID.
- **A ordem do Stalwart** (enfileirar o aviso antes de remover a mensagem) foi lida no
  código da v0.11.8. A espera de 20 s cobre o caso de o aviso demorar a chegar à caixa.
