# Pesquisa — entregabilidade do e-mail do TWS Panel (caixa de entrada x spam)

Data: 02/10/2026. Escopo: o servidor Stalwart v0.11.8 que o painel sobe em Docker numa VPS
comum (ex.: Contabo, IP novo) e que os projetos usam por SMTP. Este documento não tem IP,
senha nem nome de cliente. Nenhum código foi alterado; só este arquivo foi escrito.

Como ler: as seções 1, 3.1, 4 e 5 são para o dono do produto. As tabelas e a seção 3.2
trazem o "onde mexer" para o desenvolvedor. Onde algo não foi confirmado, está dito.

---

## 1. Resumo (por que hoje cai no spam e o que mais pesa)

1. A parte técnica obrigatória está quase toda certa: SPF, DKIM, DMARC, PTR com ida e volta,
   TLS e certificado válido. Por isso o Gmail **aceitou** a mensagem (250 OK) e não a recusou.
2. Cair no Spam, nesse cenário, é sobretudo **falta de reputação**: IP novo, domínio (ou
   subdomínio) que nunca enviou nada e volume zero de histórico. O Google manda "começar com
   pouco volume, para gente engajada, e aumentar devagar". Ninguém pula essa etapa.
3. O IP vem de uma faixa barata de VPS (Contabo). Faixas assim têm vizinhos que mandam spam.
   Isso pesa no Gmail e, mais ainda, na Microsoft (Outlook/Hotmail), que bloqueia faixas
   inteiras (erro "S3150").
4. O PTR genérico do provedor (`vmi…contaboserver.net`) passa no requisito mínimo, mas o Yahoo
   pede, como boa prática, um PTR "não genérico, que reflita o seu domínio". É barato
   corrigir e o painel deveria tratar isso como recomendação forte, não "opcional".
5. A mensagem de teste em si é magra: só texto, em base64, de `postmaster@`, assunto genérico.
   Ela não é spam, mas também não ajuda. O peso dela é pequeno perto dos itens 2 e 3.
6. Achados no código que atrapalham: o DMARC manda os relatórios para `dmarc@<domínio>`, caixa
   que **não existe** (os relatórios do Google e da Microsoft se perdem); com dois ou mais
   domínios, o painel pede um PTR diferente para cada um, o que é impossível (um IP tem um PTR,
   que deve casar com o nome que o servidor usa no HELO); e o Stalwart **não acrescenta
   Message-ID nem Date** em mensagens que chegam pela submissão (465/587), que é por onde os
   projetos enviam. O Google exige Message-ID válido.
7. O que mais pesa daqui para frente: **volume baixo e crescente** (aquecimento), **engajamento**
   (gente que abre e responde), **quase zero reclamação** (< 0,1%), **poucos bounces**, e
   **acompanhar** pelo Google Postmaster Tools e pelo Microsoft SNDS.
8. BIMI, MTA-STS, TLS-RPT e ARC **não** tiram ninguém do spam. São segurança e marca.
9. Para quem precisa de entrega garantida desde o primeiro dia (cadastro, recuperação de
   senha de um produto real), um **relay** (SES, Postmark, Resend, Brevo, Mailgun) resolve
   na hora. O Stalwart 0.11.8 já sabe usar relay; o painel só precisa oferecer o formulário.
10. Não há garantia: provedor nenhum publica a fórmula. O painel pode mostrar um "score de
    entregabilidade" honesto, que mede o que dá para medir e lembra o que não dá.

---

## 2. O que o painel já faz certo e o que falta

### 2.1 Já faz certo (conferido no código)

| Item | Onde está | Observação |
|---|---|---|
| DKIM RSA 2048, seletor `paas`, gerado no Stalwart | `packages/mailer/src/client.ts` (`createDkimSignature`, id `rsa-<domínio>`) | No v0.11.8, a assinatura é automática: o padrão de `auth.dkim.sign` assina com `rsa-<sender_domain>` quando o domínio é local (conferido em `crates/common/src/config/smtp/auth.rs`). O id que o painel usa casa com esse padrão. A chave `ed25519-…` que o padrão também tenta não existe e é ignorada sem erro (conferido: `get_dkim_signer` só assina se achar). |
| SPF `v=spf1 ip4:<IP> ~all` → `-all` | `packages/mailer/src/dns-checklist.ts` (`spfValue`) | Correto e alinhado (o remetente do envelope é do próprio domínio). |
| DMARC progressivo `p=none` → `quarantine` → `reject` | `dns-checklist.ts` (`dmarcValue`, `stageSuggestion`) | Bom plano. Falha no `rua` (ver 2.2). |
| A de `mail.<domínio>`, MX, AAAA se houver IPv6 | `dns-checklist.ts` | Correto. |
| PTR com FCrDNS (verde/azul/amarelo) e instrução por provedor | `dns-checklist.ts` (`verifyPtr`, `PTR_PROVIDERS`) | Cumpre o mínimo de Google/Yahoo/Microsoft. |
| HELO/EHLO = `server.hostname` | `packages/mailer/src/server.ts` (`renderConfigToml`) | No v0.11.8, `queue.outbound.hostname` tem como padrão `config_get('server.hostname')` (conferido em `queue.rs`). |
| TLS com certificado Let's Encrypt em `mail.<domínio>` | `tls-certificates.ts`, `server.ts` | E a saída já exige STARTTLS: padrão `queue.outbound.tls.starttls = require` (conferido). |
| `postmaster@` e `abuse@` funcionando | `apps/server/src/services/mail-service.ts` (`addDomain`) | Boa prática pedida pelos provedores. |
| Cuidado com o MX de domínio que já recebe e-mail em outro lugar; sugestão de subdomínio | `mail-service.ts` (`addDomain`) | Ajuda também a reputação: subdomínio dedicado ao envio isola problemas. |
| Botão de teste com fila e DSN | `smtp-send.ts`, `delivery-status.ts`, `mail-service.ts` | Mostra aceite/recusa do servidor de destino. Não mostra se caiu no spam (ninguém consegue, sem acesso à caixa). |
| Limite de envio do botão de teste | `mail-service.ts` (`takeTestSlot`) | Evita usar o teste como canhão. |
| Módulo de blacklist (Spamhaus ZEN, SpamCop, Barracuda, Spamhaus DBL) | `packages/mailer/src/blacklist.ts` | Existe e trata a recusa da Spamhaus (`127.255.255.x`) como "desconhecido". Ver 2.2. |

### 2.2 O que falta ou está errado

| Item | Impacto | Esforço | Onde mexer no código |
|---|---|---|---|
| **Aquecimento (warm-up) guiado + limite de saída por provedor de destino** (Gmail, Outlook, Yahoo…) nas primeiras semanas | Alto | Médio | `packages/mailer/src/server.ts` (`renderConfigToml`: seções `queue.limiter.outbound.<id>` com `key = ["rcpt_domain"]`, `rate`, `match`, `enable`); estado do plano em `mail-service.ts` (data de início, etapa atual); UI na página E-mail |
| **Message-ID e Date ausentes em mensagens da submissão**: o Stalwart 0.11.8 só os acrescenta na porta 25 (`session.data.add-headers.message-id` e `session.data.add-headers.date` têm padrão `local_port == 25`, conferido em `session.rs`; ele só acrescenta quando falta — `inbound/data.rs`) | Alto quando o app do projeto não gera esses cabeçalhos; nulo quando gera (nodemailer gera) | Baixo | `server.ts` (`renderConfigToml`): `session.data.add-headers.message-id = true` e `session.data.add-headers.date = true` |
| **`rua=mailto:dmarc@<domínio>` aponta para caixa que não existe** (o `addDomain` cria só `postmaster@` com alias `abuse@`). Os relatórios DMARC dos grandes provedores voltam como "usuário desconhecido" | Médio (sem relatório não há como subir para `quarantine` com segurança) | Baixo | `mail-service.ts` (`addDomain`: incluir `dmarc@` como alias da postmaster, como já faz com `abuse@`) ou `dns-checklist.ts` (`dmarcValue` com `postmaster@`, que é o que o próprio Stalwart sugere em `management/dns.rs`) |
| **PTR esperado por domínio** (`mail.<domínio>` em cada checklist). Com 2+ domínios, só um pode ficar verde; o que vale é o PTR casar com o nome do HELO (`server.hostname`, que é `mail.<1º domínio>` ou `PAAS_MAIL_HOSTNAME`) | Médio | Baixo | `mail-service.ts` (`dnsChecklist`: o PTR esperado deve ser `this.hostname()`, não `mail.<domínio>`); `dns-checklist.ts` (texto) |
| **PTR genérico tratado como "opcional"** (azul conta como OK). O Yahoo pede PTR "não genérico, que reflita o seu domínio" (boa prática, não requisito) | Médio | Baixo | `dns-checklist.ts` (texto do azul: "funciona, mas troque — melhora a reputação"; manter contando como OK) |
| **`report.domain` não configurado**. O padrão é o domínio registrável do hostname (ex.: hostname `mail.envio.exemplo.com.br` → `exemplo.com.br`, conferido em `network.rs`). Avisos de entrega (DSN) e relatórios DMARC/TLS que o Stalwart manda para fora saem como `…@exemplo.com.br`, assinados com uma chave `rsa-exemplo.com.br` que não existe e com SPF que não cobre a VPS | Baixo a médio (pouco volume, mas são mensagens que falham DMARC no domínio principal da empresa) | Baixo | `server.ts`: `report.domain = "<domínio de e-mail cadastrado>"` |
| **Blacklist não aparece na página E-mail e, segundo o estado da sessão, nunca roda na prática**. O código liga a checagem ao scan do Monitoramento (`apps/server/src/routes/monitoring.ts`, `setMailBlacklistHook`) e ao botão da página Segurança; a causa de não rodar não foi investigada aqui | Médio | Baixo a médio | `apps/web` (card na página E-mail), `mail-service.ts` (`checkBlacklists`), `monitor-service.ts` |
| **Consultas de blacklist pouco confiáveis**: a Spamhaus recusa consultas de resolvedores públicos e de resolvedores de provedor com muito volume (resposta `127.255.255.254`/`.255`) e oferece o DQS gratuito com chave; a Barracuda só responde a resolvedores cadastrados, e o "não respondeu" pode parecer "limpo" | Médio (falso "limpo" é pior que "não sei") | Médio | `blacklist.ts`: campo opcional de chave DQS (zona `<chave>.zen.dq.spamhaus.net`), Barracuda como "verificar no site", e `unknown` quando a resposta não for confiável |
| **Postmaster Tools (Google) e SNDS/JMRP (Microsoft) não aparecem no painel** | Alto (é o único jeito de ver reputação e taxa de spam) | Baixo (só guia + campo de TXT de verificação) | Página E-mail: passo "Acompanhar reputação" com links e o TXT de verificação do Google |
| **Bounces e supressão**: as recusas voltam como DSN para a caixa técnica do projeto e ninguém olha. Reenviar para endereço que não existe derruba a reputação | Médio a alto (quando houver volume) | Médio | `mail-service.ts` (já lê DSN da postmaster por JMAP no teste; reaproveitar para a caixa do projeto), página do projeto: "Endereços recusados" |
| **Limite por projeto (proteção contra app comprometido ou com bug mandando milhares)** | Médio | Baixo | `server.ts`: `queue.limiter.inbound.<id>` com `key = ["authenticated_as"]` |
| **Mensagem de teste magra** (só texto em base64, de `postmaster@`) | Baixo | Baixo | `smtp-send.ts` (`buildTestMessage`: multipart texto+HTML, quoted-printable), `mail-service.ts` (`testEmailText`) |
| **IPv6**: o SPF só tem `ip4`. Hoje o contêiner do Stalwart sai por IPv4 (rede Docker padrão sem IPv6), então não quebra. Se um dia sair por IPv6 sem `ip6:` no SPF e sem PTR IPv6, o Gmail recusa | Baixo hoje, alto se mudar | Baixo | `server.ts`: `queue.outbound.ip-strategy = "ipv4_only"` (valor conferido em `queue.rs`); ou `spfValue` com `ip6:` + PTR IPv6 no checklist |
| **Relay externo (smarthost) opcional** | Alto para quem precisa de entrega imediata | Médio | `server.ts` (`[remote.<id>]` + `queue.outbound.next-hop`), `mail-service.ts`, página E-mail |
| **One-click unsubscribe** (`List-Unsubscribe` + `List-Unsubscribe-Post`) | Baixo para transacional; obrigatório para marketing em volume | Baixo (só documentação/aviso) | Texto na página E-mail do projeto; o cabeçalho é responsabilidade do app |
| **MTA-STS / TLS-RPT** | Baixo para entregabilidade | Médio | Ver seção 4 |

---

## 3. Recomendações priorizadas

### 3.1 Para o dono do produto (o que muda na prática)

**Prioridade 1 — corrigir o que é barato e está errado (1 PR pequeno)**
- O servidor passa a colocar Message-ID e Date em toda mensagem que falte.
- Os relatórios DMARC passam a chegar (alias `dmarc@` na postmaster).
- O PTR passa a ser cobrado uma vez só, para o nome do servidor, e o texto do azul passa a
  dizer "funciona, mas troque para `mail.<domínio>`: melhora a reputação" (na Contabo é um
  campo no painel dela).
- Os avisos e relatórios que o próprio servidor manda passam a sair do domínio de e-mail
  cadastrado, e não do domínio principal da empresa.
- O servidor fica preso a IPv4 para sair, até o painel cuidar de IPv6 de ponta a ponta.

**Prioridade 2 — aquecimento guiado (o que mais tira do spam com o tempo)**
- Ao ativar o e-mail, a página E-mail mostra "Aquecimento: semana 1 de 4" e o limite atual.
- O painel aplica sozinho um limite por provedor de destino (Gmail, Outlook/Hotmail, Yahoo,
  UOL/BOL/Terra e "outros"). O que passar do limite **não se perde**: fica na fila e sai na
  hora seguinte (conferido no código do Stalwart: o limite vira "falha temporária" com nova
  tentativa — `outbound/delivery.rs` e `queue/throttle.rs`).
- O plano sobe de etapa sozinho, mas só se não houver sinal ruim (muitas recusas ou adiamentos
  na fila). Se houver, o painel segura a etapa e explica.

Plano simples (por provedor de destino, por dia; ponto de partida comum no mercado, não número
oficial de nenhum provedor):

| Etapa | Dias | Limite por provedor de destino | O que a pessoa faz |
|---|---|---|---|
| 1 | 1–3 | 20 por dia (≈ 2 por hora) | Mandar para gente conhecida que abre e responde; pedir para tirar do spam e responder |
| 2 | 4–7 | 50 por dia | Só e-mails esperados (cadastro, recuperação de senha) |
| 3 | 8–14 | 150 por dia | Conferir o Postmaster Tools quando aparecer dado |
| 4 | 15–21 | 400 por dia | Idem; nada de lista comprada nem envio em massa |
| 5 | 22–30 | 1.000 por dia | Considerar subir o DMARC para `quarantine` se os relatórios estiverem limpos |
| Livre | 30+ | Sem limite do painel (só o de proteção por projeto) | Manter a taxa de spam abaixo de 0,1% |

Regras de segurança do plano: segurar a etapa se, nas últimas 24 h, mais de 2% das mensagens
para um provedor forem recusadas, ou se aparecerem adiamentos com texto de reputação (ex.:
"421-4.7.28" no Gmail, "S3150"/"S775" na Microsoft, "TSS04" no Yahoo). O Stalwart não faz isso
sozinho: a equipe dele confirmou em 24/06/2026 que há limite por domínio/MX, mas não rampa
automática ("building blocks … just not a turnkey adaptive one") — a rampa seria do painel.

**Prioridade 3 — acompanhar reputação (a pessoa faz fora, o painel guia)**
- **Google Postmaster Tools** (postmaster.google.com): a pessoa entra com a conta Google,
  adiciona o domínio de envio e o painel mostra o TXT de verificação para colar no DNS (e
  confere). Desde 2025 o painel de "Compliance status" ficou acessível a quem envia pouco, mas
  os gráficos só aparecem com volume suficiente (o Google não diz quanto). O painel deve avisar
  isso para ninguém achar que está quebrado.
- **Microsoft SNDS** (sendersupport.olc.protection.outlook.com/snds) com o IP da VPS, e
  **JMRP** (aviso de reclamação). É um dos itens que a Microsoft confere num pedido de
  desbloqueio.
- **Yahoo Complaint Feedback Loop** (senders.yahooinc.com): exige DKIM, que o painel já tem.
- O painel não consegue ler esses portais por conta própria (não há API simples para SNDS; o
  Postmaster Tools tem API, mas pede OAuth do Google) — fica como checklist marcado pela
  pessoa, com data.

**Prioridade 4 — blacklists de verdade, na página E-mail**
- Card "Listas de bloqueio" na página E-mail, rodando 1 vez por dia e no botão "Verificar".
- Separar o que importa: **Spamhaus** (SBL/XBL/CSS/PBL via ZEN, e DBL para o domínio) é usada
  por muitos servidores e precisa de atenção imediata; **Barracuda** e **SpamCop** pesam em
  servidores corporativos; **UCEPROTECT** nível 2/3 lista faixas inteiras de provedores (a
  própria Contabo diz que Gmail, Hotmail e Yahoo não usam) — mostrar só como informação.
- Para a Spamhaus funcionar de dentro da VPS, oferecer o campo "chave DQS (grátis)".
- A lista de bloqueio da Microsoft (S3150) não é consultável por DNS: só aparece como recusa
  na fila. O painel deve reconhecer esse texto na recusa e mostrar o caminho de desbloqueio
  (sender.office.com).

**Prioridade 5 — bounces, supressão e proteção por projeto**
- Página do projeto: "Endereços recusados nos últimos 30 dias" (lidos dos avisos de entrega
  da caixa técnica) e aviso de "pare de enviar para estes".
- Limite por projeto, por hora, para um app com bug não queimar o IP de todos os projetos
  (todos dividem o mesmo IP: o Google diz que "a atividade de qualquer remetente num IP
  compartilhado afeta a reputação de todos").

**Prioridade 6 — relay opcional** (seção 5).

### 3.2 Para o desenvolvedor (chaves do Stalwart v0.11.8)

Todas as chaves abaixo foram conferidas no código-fonte da tag v0.11.8
(`crates/common/src/config/...`). A documentação oficial publicada hoje (stalw.art/docs) é da
linha 0.15+, que mudou parte dos nomes e a forma de configurar (objetos de painel); por isso o
código da tag é a fonte. O site `stalwart.email` não respondeu nesta pesquisa (DNS); a
documentação está em `stalw.art`.

| Objetivo | Chave (v0.11.8) | Padrão na v0.11.8 | Recomendação |
|---|---|---|---|
| Nome no HELO/EHLO de saída | `queue.outbound.hostname` | `config_get('server.hostname')` | Manter; o PTR deve casar com `server.hostname` |
| IP de saída | `queue.outbound.source-ip.v4`, `queue.outbound.source-ip.v6` | vazio | Não precisa (o contêiner sai pelo IP do host via NAT) |
| Família de IP na saída | `queue.outbound.ip-strategy` | `ipv4_then_ipv6` | `ipv4_only` enquanto o checklist não cuidar de IPv6 |
| STARTTLS obrigatório na saída | `queue.outbound.tls.starttls` | `require` | Manter |
| Respeitar MTA-STS / DANE do destino | `queue.outbound.tls.mta-sts`, `queue.outbound.tls.dane` | `optional` | Manter |
| Limite de saída por provedor de destino (aquecimento) | `queue.limiter.outbound.<id>.key` (`rcpt_domain`, `mx`, `sender_domain`, `remote_ip`, `local_ip`, `sender`), `.rate` (ex.: "20/1d"), `.match` (expressão, ex.: `rcpt_domain == 'gmail.com'`), `.enable` | nenhum | Um limitador por grupo de provedor, gerado pelo plano de aquecimento |
| Limite por projeto (caixa autenticada) | `queue.limiter.inbound.<id>.key = ["authenticated_as"]`, `.rate`, `.enable` | nenhum | Ex.: 500/1h por projeto, ajustável |
| Agenda de novas tentativas | `queue.schedule.retry`, `queue.schedule.notify`, `queue.schedule.expire` | `[2m, 5m, 10m, 15m, 30m, 1h, 2h]`, `[1d, 3d]`, `5d` | Manter |
| Assinatura DKIM | `auth.dkim.sign` (expressão); assinaturas em `signature.<id>.*` (criadas pela API `/api/dkim`) | `is_local_domain('*', sender_domain)` → `['rsa-' + sender_domain, 'ed25519-' + sender_domain]` | Manter. Para rotação de chave: criar `rsa2-<domínio>` com outro seletor, publicar o TXT, depois trocar `auth.dkim.sign` (é uma lista: aceita duas chaves ao mesmo tempo) |
| Selo ARC | `auth.arc.seal`, `auth.arc.verify` | `'rsa-' + config_get('report.domain')`, `relaxed` | Irrelevante para quem só envia (ARC é para quem encaminha) |
| Domínio dos avisos e relatórios | `report.domain` | domínio registrável do `server.hostname` | Definir como o domínio de e-mail cadastrado |
| Remetente dos avisos de entrega | `report.dsn.from-address`, `report.dsn.sign` | `MAILER-DAEMON@` + `report.domain` | Segue o `report.domain` |
| Relatórios DMARC agregados que o servidor envia a terceiros | `report.dmarc.aggregate.send`, `report.dmarc.aggregate.from-address`, `report.dmarc.aggregate.org-name` | `daily`, `noreply-dmarc@` + `report.domain` | Ok depois de acertar `report.domain` |
| Relatórios TLS que o servidor envia | `report.tls.aggregate.send` | `daily` | Idem |
| Ler os relatórios DMARC/TLS recebidos | `report.analysis.addresses` (lista de endereços), `report.analysis.forward`, `report.analysis.store` | vazio, `true`, `30d` | Pôr `dmarc@*` e `tls-rpt@*` para o Stalwart analisar e guardar; o painel lê o resumo depois (API de relatórios não verificada nesta pesquisa) |
| Acrescentar cabeçalhos que faltam | `session.data.add-headers.message-id`, `session.data.add-headers.date` | `local_port == 25` → só na porta 25 | `true` (só acrescenta quando falta) |
| Política MTA-STS servida pelo Stalwart | `session.mta-sts.mode` (`testing`/`enforce`), `session.mta-sts.max-age`, `session.mta-sts.mx` | `testing`, `7d`, vazio | Servida em `/.well-known/mta-sts.txt` no listener HTTP (conferido em `jmap/src/api/http.rs`). Aqui o 8080 só escuta em 127.0.0.1: o Caddy teria de atender `mta-sts.<domínio>` (ou servir o arquivo ele mesmo) |
| Relay (smarthost) | `[remote.<id>]`: `address`, `port`, `protocol` (`smtp`), `auth.username`, `auth.secret`, `tls.implicit`, `tls.allow-invalid-certs`; escolha por `queue.outbound.next-hop` (expressão com `sender_domain`, `rcpt_domain` etc.) | `next-hop` = `'local'` para domínio local, senão `false` (MX direto) | Ex.: `next-hop` = id do relay quando `sender_domain` for um domínio marcado "enviar por relay" |

Duas observações de implementação, conferidas no código:
- **O arquivo vence o banco:** no boot, as chaves do `config.toml` entram primeiro e as do banco
  só preenchem o que falta (`extend_config` usa `or_insert`, `manager/config.rs`). Então pôr
  `queue.*`, `session.*`, `report.*` e `auth.*` no arquivo gerado funciona, mas, como já
  registrado em `server.ts`, o Stalwart não relê o arquivo no `reload` — mudar a etapa do
  aquecimento exige reiniciar o contêiner (uma vez por etapa é aceitável). Alternativa não
  testada: gravar essas chaves pela API de configurações e chamar `/api/reload`.
- **Limite não descarta:** quando um limitador de saída barra, a mensagem fica com "falha
  temporária (rate limited)" e nova tentativa marcada; só expira depois de
  `queue.schedule.expire` (5 dias).

### 3.3 "Score de entregabilidade" para a página E-mail

Nome sugerido: **"Prontidão para a caixa de entrada"**, de 0 a 100, com uma frase honesta
embaixo: "mede o que o painel consegue conferir; a decisão final é de cada provedor".

| Bloco | Pontos | Como o painel mede | Automático? |
|---|---|---|---|
| Autenticação: SPF, DKIM, DMARC publicados e corretos | 25 | Checklist DNS já existente | Sim |
| PTR = nome do servidor (HELO) | 10 (5 se genérico com ida e volta; 0 se falhar) | Já existente, com o ajuste da seção 2.2 | Sim |
| TLS com certificado válido em `mail.<domínio>` | 5 | Card de certificado já existente | Sim |
| Listas de bloqueio limpas (Spamhaus ZEN/DBL, SpamCop; Barracuda se verificável) | 15 (0 se Spamhaus listar) | Checagem diária | Sim |
| Aquecimento | 15 (proporcional à etapa: semana 1 = 3 … concluído = 15) | Data de início e etapa | Sim |
| Recusas e adiamentos nos últimos 7 dias abaixo de 2% | 10 | Fila + avisos de entrega | Sim (com a Prioridade 5) |
| Postmaster Tools e SNDS cadastrados | 5 | A pessoa marca; o TXT do Google o painel confere | Parcial |
| Taxa de spam no Postmaster abaixo de 0,1% | 10 | A pessoa informa (ou integração futura pela API do Postmaster) | Manual |
| Relatórios DMARC chegando e sem falha de alinhamento | 5 | `report.analysis` do Stalwart | Sim (depois de ligar a análise) |

Faixas: 85+ verde ("pronto; siga o aquecimento"), 60–84 amarelo ("vai chegar, mas com risco de
spam"), abaixo de 60 vermelho ("arrume os itens em vermelho antes de usar com clientes"). Cada
linha leva ao "Como fazer" do item. Importante: um servidor novo **não** chega a 85 antes de
terminar o aquecimento, e isso é de propósito — é exatamente o que explica o spam de hoje.

### 3.4 O que a pessoa precisa fazer fora do painel (e como o painel guia)

| O quê | Onde | Como o painel ajuda |
|---|---|---|
| PTR = `mail.<domínio>` (nome do servidor) | Painel do provedor da VPS (Contabo: "Reverse DNS Management") | Já existe a instrução por provedor; mudar o tom de "opcional" para "recomendado" |
| Registrar o domínio no Google Postmaster Tools | postmaster.google.com | Mostrar o TXT de verificação e conferir |
| Registrar o IP no Microsoft SNDS e no JMRP | sendersupport.olc.protection.outlook.com/snds | Link + explicação + campo "feito em" |
| Yahoo CFL (opcional) | senders.yahooinc.com | Link |
| Chave DQS gratuita da Spamhaus (opcional, melhora a checagem) | spamhaus.com (Data Query Service) | Campo para colar a chave |
| Testar a mensagem real do projeto | mail-tester.com (poucos testes grátis por dia) ou aboutmy.email | Botão "Como testar a mensagem do meu app" com o passo a passo |
| Se a Microsoft bloquear (S3150) | sender.office.com / olcsupport.office.com | Reconhecer o texto da recusa e mostrar o caminho |
| Não comprar lista, não mandar marketing do mesmo domínio do transacional | — | Aviso fixo na página do projeto |

---

## 4. O que NÃO vale a pena (mitos)

- **"BIMI tira do spam."** Não. BIMI mostra o logotipo para quem já passou nos filtros. Exige
  DMARC em `quarantine`/`reject`, logo em SVG Tiny-PS e, no Gmail, certificado VMC ou CMC
  (pago, normalmente na casa de centenas a mais de mil dólares por ano; o CMC pede o logo
  público há 12 meses). Só faz sentido para marca com volume.
- **"MTA-STS e TLS-RPT melhoram a entrega."** Não para quem envia. MTA-STS protege o e-mail
  que **chega** ao domínio contra rebaixamento de TLS; TLS-RPT só manda relatório. São boas
  práticas de segurança, prioridade baixa aqui. (O Stalwart já respeita o MTA-STS dos
  destinos na saída.)
- **"ARC ajuda."** ARC é para quem **encaminha** e-mail (listas, redirecionadores). O painel só
  envia; não muda nada.
- **"`p=reject` no DMARC faz o Gmail confiar mais."** Não há evidência pública de que a
  política, por si só, mude a pasta para quem envia pouco. A política protege contra quem
  falsifica o seu domínio. Suba quando os relatórios estiverem limpos, não para "ganhar ponto".
- **"`-all` em vez de `~all` muda a pasta."** Com DKIM alinhado, praticamente não. É proteção
  contra falsificação.
- **"Pedir para tirar das blacklists resolve tudo."** O que mais pesa no Gmail e na Microsoft
  é a reputação interna deles, que nenhuma DNSBL mostra.
- **UCEPROTECT nível 2/3.** Lista faixas inteiras de provedores (a Contabo informa que Gmail,
  Hotmail e Yahoo não usam). Não pagar "remoção expressa". Só o nível 1 (o seu IP) merece olhar.
- **"Marcar como 'não é spam' na minha própria conta resolve."** Ajuda na **sua** caixa e é um
  sinal pequeno no geral. Não substitui volume real com engajamento real.
- **"Trocar o assunto e tirar palavras como 'grátis' resolve."** Conteúdo pesa menos do que
  reputação hoje. Vale evitar o óbvio (só imagem, encurtador de link, link para domínio
  diferente do remetente, texto todo em maiúsculas), mas não é o problema principal.
- **"Comprar outro IP / trocar de VPS a cada problema."** IP novo volta ao zero de reputação.
  Só faz sentido se o IP estiver de fato numa lista grave (Spamhaus SBL/XBL) ou numa faixa que
  a Microsoft bloqueia e o provedor não resolve.
- **"Precisa de one-click unsubscribe em tudo."** O Google diz que é obrigatório só para
  **marketing/assinatura** de quem envia 5.000+ por dia; transacional (senha, confirmação)
  está fora. Ainda assim, newsletter do projeto deve ter (RFC 8058).

---

## 5. Quando recomendar relay externo, e como oferecer no painel

**Recomendar relay quando:**
- o projeto é de cliente/produção e e-mail transacional precisa chegar **hoje** (cadastro,
  código de login, recuperação de senha, nota fiscal) e o servidor ainda está aquecendo;
- o destino principal é Outlook/Hotmail e aparece bloqueio de faixa (S3150) que o provedor da
  VPS não resolve;
- a porta 25 de saída é bloqueada pelo provedor (comum em nuvens grandes);
- o volume vai passar de alguns milhares por dia, ou haverá marketing/newsletter;
- o IP entrou na Spamhaus SBL/XBL e a remoção vai demorar.

**Envio direto é suficiente quando:** volume baixo (dezenas a centenas por dia), público que
espera o e-mail, e a pessoa aceita algumas semanas de aquecimento.

**Opções (todas aceitam SMTP com usuário e senha, que é o que o Stalwart usa como relay):**
Amazon SES (mais barato em volume, exige saída do "sandbox"), Postmark (forte em
transacional), Resend, Brevo (tem plano grátis diário), Mailgun. Preços e limites mudam;
não foram conferidos nesta pesquisa.

**Como o painel ofereceria (envio continua passando pelo Stalwart):**
1. Página E-mail → "Enviar por um serviço externo (opcional)": provedor (lista com host/porta
   pré-preenchidos), usuário, senha, e "usar para: todos os domínios / só estes domínios".
2. O painel grava `[remote.<id>]` com `address`, `port`, `protocol = "smtp"`,
   `auth.username`, `auth.secret`, `tls.implicit` e define `queue.outbound.next-hop` para usar
   o relay quando o `sender_domain` estiver na lista (ou para tudo). O Stalwart continua
   assinando o DKIM do domínio, então o alinhamento DMARC continua pelo DKIM.
3. O checklist DNS muda junto: o SPF ganha o `include:` do provedor (ex.:
   `include:amazonses.com`), e o provedor costuma pedir os próprios registros (DKIM dele,
   domínio de MAIL FROM/retorno) — o painel mostra o que o provedor pedir como "registros do
   serviço externo".
4. O projeto não muda nada: continua com `SMTP_HOST=mail.<domínio>`; a troca é transparente e
   reversível. A fila e o botão de teste seguem funcionando (o aviso de entrega passa a
   refletir a resposta do relay, não a do Gmail — o painel precisa dizer isso).
5. Opção "relay só para Microsoft" (por `rcpt_domain`) é possível com a mesma expressão, para
   quem só sofre com Outlook.

Ponto não confirmado: o comportamento exato do Stalwart 0.11.8 com relay que exige STARTTLS na
587 (`tls.implicit = false`) não foi testado aqui; o código lê a chave, mas vale um teste real
antes de prometer.

---

## 6. Fontes (acessadas em 02/10/2026)

Provedores
- Google — Email sender guidelines (requisitos para todos e para 5.000+/dia; Message-ID; PTR;
  IP compartilhado; aumentar volume devagar): https://support.google.com/a/answer/81126?hl=en
- Google — Sender guidelines FAQ (endurecimento a partir de novembro/2025; one-click só para
  marketing; taxa de spam diária, 0,1%/0,3%): https://support.google.com/a/answer/14229414?hl=en
- Google Postmaster Tools: https://postmaster.google.com
- Yahoo — Sender best practices (FCrDNS para todos; PTR "não genérico" como recomendação; CFL;
  descadastro em 2 dias): https://senders.yahooinc.com/best-practices/
- Microsoft — Outlook.com Policies, Practices and Guidelines (rDNS válido, IP dinâmico, 500
  conexões simultâneas, SNDS/JMRP):
  https://substrate.office.com/ip-domain-management-snds/postmaster/Policies
- Microsoft — requisitos para remetentes de alto volume (5.000+/dia, desde 05/05/2025, erro
  `550 5.7.515`): https://techcommunity.microsoft.com/blog/microsoftdefenderforoffice365blog/strengthening-email-ecosystem-outlook%E2%80%99s-new-requirements-for-high%E2%80%90volume-senders/4399730
  (o conteúdo da página não carregou na ferramenta; resumo conferido via
  https://www.mailgun.com/blog/deliverability/microsoft-sender-requirements/)
- Microsoft SNDS: https://sendersupport.olc.protection.outlook.com/snds/
- Microsoft — pedido de desbloqueio: https://sender.office.com/
- Bloqueio S3150 (relatos e caminho de remoção): https://learn.microsoft.com/en-sg/answers/questions/5777377/how-can-i-remove-from-s3150-block-list
  e https://docs.hetzner.com/robot/dedicated-server/troubleshooting/microsoft-blacklist/

Listas de bloqueio
- Spamhaus — fim das consultas por resolvedores públicos e DQS gratuito:
  https://www.spamhaus.org/resource-hub/email-security/if-you-query-the-legacy-dnsbls-via-cloudflares-dns-move-to-spamhaus-technologys-free-data-query-service/
- Contabo — UCEPROTECT nível 3 e por que não afeta Gmail/Hotmail/Yahoo:
  https://contabo.com/blog/de/kb/103000275039-warum-steht-meine-ip-adresse-auf-der-schwarzen-liste-von-uceprotect/
- Barracuda — consulta só de resolvedores cadastrados (fonte secundária; a página oficial de
  cadastro não foi conferida): https://www.suped.com/learn/blocklists/barracuda-networks-barracuda-reputation-block-list-brbl

IPv6, BIMI, Postmaster v2 (fontes secundárias)
- Requisitos do Gmail para IPv6 (PTR + FCrDNS + SPF `ip6:`/DKIM):
  https://oneuptime.com/blog/post/2026-03-20-google-ipv6-mail-policy/view
- BIMI/VMC/CMC no Gmail: https://easydmarc.com/blog/bimi-cmc-google/
- Postmaster Tools v2 e acesso para baixo volume:
  https://www.suped.com/blog/ultimate-guide-to-google-postmaster-tools-v2
- RFC 8058 (one-click unsubscribe): https://www.rfc-editor.org/rfc/rfc8058

Stalwart
- Código-fonte da tag v0.11.8 (baixado e lido):
  https://github.com/stalwartlabs/mail-server/tree/v0.11.8 — arquivos
  `crates/common/src/config/smtp/{auth,queue,report,session,throttle,resolver}.rs`,
  `crates/common/src/config/network.rs`, `crates/common/src/manager/config.rs`,
  `crates/smtp/src/inbound/data.rs`, `crates/smtp/src/outbound/delivery.rs`,
  `crates/jmap/src/api/http.rs`, `crates/jmap/src/api/management/dns.rs`
- Documentação (linha 0.15, mesma estrutura `queue.limiter.outbound`):
  https://stalw.art/docs/0.15/mta/outbound/rate-limit/
- Fórum oficial — aquecimento de IP (resposta da equipe em 24/06/2026):
  https://support.stalw.art/t/features-to-warm-up-ip-address/758

Código do painel lido
- `packages/mailer/src/server.ts`, `dns-checklist.ts`, `blacklist.ts`, `smtp-send.ts`,
  `client.ts`; `apps/server/src/services/mail-service.ts`, `monitor-service.ts`,
  `apps/server/src/routes/monitoring.ts`; `docs/email-deliverability.md`;
  `comoFuncionaSistema/_ESTADO-DA-SESSAO.md`, `_RELATORIO-email-ptr-teste.md`,
  `comoFuncionaSistema/email/blacklist.json`.

### O que não consegui confirmar
- **Provedores brasileiros (UOL, BOL, Terra):** não há página pública de requisitos para
  remetentes. A recomendação é tratá-los como "outros" no aquecimento e seguir o padrão
  Google/Yahoo. Qualquer número específico seria chute.
- **Por que exatamente o teste caiu no Spam:** o Gmail não informa. A explicação da seção 1 é a
  mais provável (reputação zero + faixa de VPS + PTR genérico), não uma certeza.
- **Números do aquecimento:** são prática de mercado; nenhum provedor publica uma tabela oficial.
- **Volume mínimo para o Postmaster Tools mostrar dados:** o Google não publica.
- **Barracuda hoje:** se ainda aceita cadastro de resolvedores e como responde a quem não é
  cadastrado.
- **API do Stalwart 0.11.8 para ler os relatórios DMARC analisados** e a gravação das chaves
  de limite pela API de configurações com `/api/reload` (sem reiniciar): não testadas.
- **Por que a checagem de blacklist "nunca roda"**: o código a liga ao scan do Monitoramento;
  a causa de não rodar na prática não foi investigada.
- A página da Microsoft no Tech Community não carregou na ferramenta; os dados de 05/05/2025 e
  do erro `550 5.7.515` vieram de fonte secundária que cita o texto da Microsoft.
