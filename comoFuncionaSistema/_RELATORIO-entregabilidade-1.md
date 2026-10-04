# Relatório — entregabilidade, primeira leva (04/10/2026)

Branch `feat/entregabilidade-1`, a partir de `dev`. Este repositório é público: nada aqui
tem IP real, senha ou nome de cliente. `203.0.113.10`, `exemplo.com.br` e
`envio.exemplo.com.br` são valores de exemplo.

Base: `email/_PESQUISA-entregabilidade.md` (seções 2.2 e 3.2). As chaves do Stalwart
foram conferidas de novo no código da tag v0.11.8 (`crates/common/src/config/network.rs`,
`smtp/session.rs`, `smtp/queue.rs` e `crates/jmap/src/api/management/dns.rs`).

## O que mudou (pelo comportamento)

### 1. Message-ID e Date em toda mensagem
O servidor de e-mail passa a acrescentar os cabeçalhos `Message-ID` e `Date` quando a
mensagem chega sem eles, também nas portas 465 e 587 (as que os projetos usam). Antes,
o Stalwart só fazia isso na porta 25. Mensagem que já traz os dois (o nodemailer, por
exemplo, gera) segue igual: ele só completa o que falta, nunca troca.

### 2. Os relatórios DMARC passam a chegar
O registro DMARC do checklist manda os relatórios para `dmarc@<domínio>`, mas nenhuma
caixa tinha esse endereço: Gmail, Yahoo e Microsoft recebiam "usuário desconhecido".

- **Decisão:** `dmarc@` virou um endereço extra da caixa `postmaster@`, como já era com
  `abuse@`. O registro DMARC publicado **não muda**: ninguém precisa mexer no DNS, e o
  checklist de quem já está verde continua verde.
- **Alternativa descartada:** trocar o `rua` para `postmaster@`, que é o que o Stalwart
  sugere em `management/dns.rs`. Ela obrigaria todo mundo a editar o TXT do DMARC, e até
  isso acontecer o checklist ficaria vermelho.
- **Domínio novo:** a `postmaster@` já nasce com `abuse@` e `dmarc@`.
- **Domínio já cadastrado:** ganha o `dmarc@` na sincronização seguinte do servidor de
  e-mail, que roda 1 minuto depois de o painel subir e depois a cada hora. Antes de
  acrescentar, o painel confere no Stalwart se o endereço já está lá, então repetir não
  faz mal. Se `dmarc@` já for uma caixa própria (criada à mão antes), o painel não mexe:
  os relatórios já chegam nela. Se o Stalwart não responder, o motivo vai para o log e o
  painel tenta de novo na hora seguinte, sem atrapalhar o certificado. Cada domínio é
  marcado como feito no `mail.json` e não é consultado de novo.
- **Endereços reservados:** `postmaster`, `abuse` e `dmarc` não podem mais virar caixa
  nova nem endereço de envio de projeto. A tentativa recebe uma mensagem dizendo que o
  endereço já existe e cai na `postmaster@`.
- **Na página:** o propósito do registro DMARC agora diz que os relatórios chegam na
  caixa `postmaster@<domínio>`, pelo endereço `dmarc@`.

### 3. PTR único para o servidor inteiro
Antes, cada domínio esperava o nome reverso `mail.<domínio>`. Com dois domínios ou mais,
um deles nunca ficava verde, porque um IP tem um nome reverso só.

- O PTR esperado passou a ser o nome com que o servidor se apresenta no HELO: o
  `PAAS_MAIL_HOSTNAME` ou, sem ele, `mail.<1º domínio>`. É o mesmo nome em todos os
  domínios.
- O card do PTR (página do domínio e card do e-mail do projeto) explica: "O nome reverso
  do IP é um só para o servidor inteiro; ele deve ser `<nome>`, o nome com que este
  servidor se apresenta."
- O registro A e o MX de cada domínio continuam sendo `mail.<domínio>`.
- Com um domínio só, nada muda: o nome do servidor e `mail.<domínio>` são o mesmo.

### 4. PTR genérico (azul): de "opcional" para "recomendado"
Continua contando como OK (o FCrDNS passa). O texto agora é: "Funciona, mas troque: o
Yahoo e os filtros de reputação preferem um nome reverso que reflita o seu domínio." A
instrução recolhida virou "Recomendado: trocar o nome reverso para `<nome do servidor>`".
O caminho por provedor (Contabo, Hetzner, Vultr) e o texto de chamado (provedor
desconhecido) continuam iguais.

### 5. Avisos e relatórios do próprio servidor saem pelo domínio de e-mail
O Stalwart manda mensagens por conta própria: aviso de entrega (`MAILER-DAEMON@`) e
relatórios DMARC/TLS para outros servidores. Ele usava o domínio registrável do
hostname. Exemplo: com `mail.envio.exemplo.com.br`, as mensagens saíam como
`…@exemplo.com.br`, que não tem a chave DKIM nem o SPF desta VPS, e falhavam no DMARC
do domínio principal da empresa.

- Agora `report.domain` é o domínio de e-mail cadastrado a que o hostname pertence (no
  exemplo, `envio.exemplo.com.br`). Havendo mais de um que sirva, vale o mais específico.
- Hostname fora de todos os domínios cadastrados (`PAAS_MAIL_HOSTNAME` de outro
  domínio): vale o 1º cadastrado.
- Sem domínio cadastrado: a chave fica de fora e vale o padrão do Stalwart.
- No v0.11.8, a chave é texto simples (`network.rs`). A assinatura dos avisos usa
  `rsa-` + esse domínio (`report.dsn.sign`, em `smtp/queue.rs`), e é exatamente o id
  da chave DKIM que o painel cria.

### 6. Saída só por IPv4
`queue.outbound.ip-strategy = "ipv4_only"`, porque o SPF só tem `ip4:` e não há PTR IPv6.
Hoje o contêiner já saía por IPv4; a chave impede que isso mude sem querer.

### 7. Como a configuração nova chega a um servidor já instalado
O Stalwart v0.11.8 só lê o `config.toml` ao iniciar: o reload dele não relê o arquivo
(lição de 01/10). Até aqui, o painel só reiniciava o Stalwart quando aparecia
certificado de nome novo ou o hostname mudava. Uma chave nova no arquivo ficaria
gravada, mas sem efeito.

Agora o painel guarda, no estado aplicado (`data/mail/mail.json` → `tls.config`), uma
impressão digital (sha256) do `config.toml` com que o Stalwart foi reiniciado pela
última vez. O segredo do administrador fica fora do cálculo e nunca vai para o arquivo.
Na sincronização, se a configuração que o painel geraria agora tem outra impressão
digital, o painel entrega o arquivo novo e **reinicia o Stalwart uma vez**.

**Na VPS, depois de atualizar o painel:**
1. O painel sobe com o código novo. Até ali o Stalwart segue rodando com a configuração
   antiga.
2. Cerca de 1 minuto depois do boot, ou antes se alguém abrir a página E-mail, roda a
   sincronização. Ela:
   - acrescenta `dmarc@` à `postmaster@` dos domínios antigos;
   - vê que o estado gravado não tem `tls.config` (foi gravado pela versão anterior);
   - entrega o `config.toml` novo e reinicia o contêiner `paas-stalwart`.

   O reinício leva alguns segundos. Conexões SMTP/IMAP abertas caem e os clientes
   reconectam. A fila fica no volume e não se perde.
3. Daí em diante a impressão digital bate e não há reinício nenhum. Um reinício novo só
   acontece se uma versão futura do painel mudar o arquivo de novo, ou se o
   `report.domain` mudar (por exemplo, quando o primeiro domínio é cadastrado; nesse
   caso o hostname também muda, e o reinício já acontecia antes).
4. Cadastrar um segundo domínio não muda o `report.domain` nem o arquivo: continua sem
   reinício (só a rede, como antes).

## Como testei
- TDD em cada item: o teste foi escrito antes e falhou pelo motivo certo; depois passou.
- `packages/mailer` (`tests/server-manager.test.ts`):
  - chaves novas no `config.toml` gerado;
  - todas antes da primeira seção `[..]`, senão o TOML as poria dentro dela;
  - `report.domain` presente ou ausente;
  - impressão digital estável e sensível a mudança;
  - o manager entrega o arquivo com o `report.domain`.
- `packages/mailer` (`tests/dns-checklist.test.ts`):
  - PTR esperado = nome do servidor, com o segundo domínio ficando verde com o PTR do
    primeiro;
  - sem o nome do servidor, o comportamento antigo;
  - texto do DMARC.
- `packages/mailer` (`tests/delivery-status.test.ts`): leitura dos endereços de uma
  caixa no Stalwart (lista ou texto).
- `apps/server` (`tests/mail-deliverability.test.ts`, novo, 14 testes):
  - PTR único, com e sem `PAAS_MAIL_HOSTNAME`;
  - `dmarc@` no cadastro e na migração: uma vez só, já existente, caixa própria e
    Stalwart fora do ar;
  - endereço reservado;
  - escolha do `report.domain`;
  - reinício único depois de atualizar;
  - o `mail.json` não guarda o segredo.
- `apps/web` (`tests/mail-domain-page.test.tsx`): o texto do PTR único e o texto
  "recomendado" do azul, sem nenhum "opcional".

### Suítes (`pnpm -r --workspace-concurrency=1 --no-bail run test:coverage`)

| Pacote | Antes | Depois | Ramos (antes → depois) |
|---|---|---|---|
| core | 50 passam | 50 passam | 100% → 100% |
| web | 569 passam | 570 passam | 83,17% → 83,17% |
| deploy | 394 passam | 394 passam | 96,5% → 96,5% |
| mailer | 195 passam | 205 passam | 98,76% → 98,77% (mínimo 98%) |
| security | 167 passam, 20 pulados, 2 arquivos falham | igual | — |
| server | 1047 passam, 2 pulados, 1 arquivo falha | 1061 passam, 2 pulados, 1 arquivo falha | mínimos atendidos |

As três falhas são as mesmas antes e depois, e nenhuma é destas mudanças:
- `security`: `phase01-script` e `phase02-07-scripts`;
- `server`: `terminal-service-pty`.

As três precisam baixar a imagem `ubuntu:24.04`, e nesta máquina o `docker pull` falha
porque o Docker procura o programa de credenciais `docker-credential-desktop.exe`, que
não está no PATH (o Docker em si responde).

## O que só dá para validar na VPS (e como conferir)

1. **Reinício único depois de atualizar.**
   - Depois do `docker compose up -d --build` em `/opt/tws-panel`, espere 1 a 2
     minutos e rode `docker ps --filter name=paas-stalwart --format '{{.Status}}'`. O
     "Up" deve mostrar poucos minutos.
   - Uma hora depois, o mesmo comando mostra que ele **não** reiniciou de novo.
   - `docker logs tws-panel 2>&1 | grep -i dmarc` não deve trazer falha.
2. **Chaves dentro do contêiner.**
   - Rode `docker exec paas-stalwart grep -E 'add-headers|ip-strategy|report.domain' /opt/stalwart-mail/etc/config.toml`.
   - Devem aparecer as quatro linhas, com `report.domain` igual ao domínio de e-mail
     cadastrado (ex.: `envio.exemplo.com.br`).
3. **Message-ID e Date.**
   - Envie um e-mail de um projeto, ou pelo botão de teste, para uma conta Gmail.
   - Abra a mensagem → ⋮ → "Mostrar original". No cabeçalho, `Message-ID:` e `Date:`
     devem estar presentes.
   - Se o app já gerava, o `Message-ID` continua o dele. O Stalwart só preenche quando
     falta, e em geral o valor terminaria em `@<nome do servidor>`.
4. **Relatórios DMARC chegando.**
   - Os grandes provedores mandam o relatório agregado uma vez por dia, para domínios
     que receberam mensagens deles no dia anterior.
   - Um ou dois dias depois de enviar para Gmail, Outlook ou Yahoo, entre na caixa
     `postmaster@<domínio>` por IMAP. As credenciais estão na página do domínio, aba
     Caixas.
   - Procure mensagens com assunto parecido com "Report domain: <domínio> Submitter:
     google.com", com um anexo `.zip` ou `.xml.gz`.
   - Antes desta mudança, esses relatórios voltavam como "usuário desconhecido".
5. **Avisos de entrega pelo domínio certo.**
   - Mande um e-mail de teste para um endereço que não existe num provedor grande. O
     aviso de recusa deve chegar na caixa do remetente vindo de
     `MAILER-DAEMON@<domínio de e-mail>`, e não do domínio principal da empresa.
   - No "Mostrar original" de um aviso desses que vá para o Gmail, o DKIM deve vir
     `d=<domínio de e-mail>` e PASS.
6. **PTR único.**
   - Com dois domínios cadastrados, os dois checklists devem esperar o mesmo nome (o do
     servidor). Com o PTR igual a ele, os dois ficam verdes.
   - Com o PTR genérico da Contabo, os dois ficam azuis, com o texto "Funciona, mas
     troque…".
7. **IPv4 na saída.** Não há o que ver enquanto a VPS não tiver IPv6 na rede do Docker. A
   chave só garante que isso não mude.

## Decisões e dúvidas
- **DMARC por alias, e não trocando o `rua`:** evita mexer no DNS de quem já está
  configurado (justificativa no item 2).
- **Migração do `dmarc@` dentro da sincronização do certificado:** é o que já roda
  sozinho 1 minuto depois do boot e a cada hora, só com o servidor no ar. Não precisou
  de gatilho novo.
- **Reinício por mudança de configuração:** compara a impressão digital do arquivo, e
  não um número de versão escrito à mão. Assim, qualquer mudança futura no
  `config.toml` chega sozinha às VPS, com um reinício só.
- **Dúvida 1 (não testada no Stalwart real):** o formato do campo `emails` em
  `GET /api/principal/<caixa>` no v0.11.8. O painel aceita lista ou texto e, se vier
  outra coisa, trata como "não tem" e tenta acrescentar. Se o Stalwart recusar o
  acréscimo por já existir, o painel registra no log e tenta na hora seguinte, sem
  quebrar nada. Vale olhar o log na primeira atualização.
- **Dúvida 2:** o efeito exato do `report.domain` nos relatórios TLS/DMARC que o
  servidor envia para outros só aparece com volume. O aviso de entrega (item 5 da
  validação) é o jeito rápido de conferir.
