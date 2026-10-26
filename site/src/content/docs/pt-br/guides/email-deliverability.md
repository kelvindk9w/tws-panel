---
title: "DNS e entregabilidade do e-mail"
description: "Como configurar o DNS do e-mail (Cloudflare e PTR), ler o painel de saúde do envio e conferir no Gmail com Mostrar original."
sidebar:
  label: "DNS e entregabilidade"
---

Este guia mostra como deixar o e-mail do seu domínio **dentro das exigências de remetentes do Gmail, do
Yahoo e da Microsoft**. Isso aumenta as chances de a mensagem chegar rápido e de cair na caixa de
entrada. **Nenhum servidor pode garantir a caixa de entrada**: a decisão final é do provedor do
destinatário e depende também da reputação do seu IP e do conteúdo.

Os exemplos usam `exemplo.com.br` e `203.0.113.10`. Troque pelos seus valores.

## Por que o primeiro e-mail pode demorar alguns minutos

Com IP e domínio novos, o Gmail costuma responder "tente mais tarde" (códigos `421 4.7.28` ou `4.7.0`).
O servidor guarda a mensagem e tenta de novo; a primeira nova tentativa é em cerca de 2 minutos. Isso
diminui com semanas de envio regular, em volume baixo e crescente, e sem reclamações. O painel mostra a
causa em **Saúde do envio de e-mail**, no item "Fila de envio".

Atenção: se o motivo for `4.7.26`, `4.7.27`, `4.7.30` ou `4.7.32`, **não é limite de taxa**. É falha de
autenticação (SPF, DKIM ou alinhamento do domínio do remetente) e esperar não resolve: confira SPF e DKIM
abaixo e o domínio usado como remetente.

> [!NOTE]
> **Cadastrar um domínio reinicia o servidor de e-mail** por alguns segundos, porque o Stalwart só assina com
> a chave DKIM nova depois de reiniciar. As conexões abertas caem e voltam; a fila de envio fica guardada.
> Se o reinício falhar, o painel mostra DKIM em **atenção (reinício pendente)**, e as mensagens saem sem
> assinatura até a próxima sincronização.

## 1. Configure o DNS na ordem

Abra o domínio na página de E-mail. O card **Saúde do envio de e-mail** tem o **Passo a passo do DNS**, com
os registros em ordem e botões de copiar:

1. **A** de `mail.exemplo.com.br` para o IP do servidor.
2. **MX** do domínio apontando para `mail.exemplo.com.br`.
3. **SPF** (TXT) autorizando o IP do servidor.
4. **DKIM** (TXT em `paas._domainkey`), a chave pública gerada pelo painel.
5. **DMARC** (TXT em `_dmarc`), começando por `p=none` e endurecendo depois.
6. Opcionais: **TLS-RPT** e **MTA-STS**.

### Cloudflare: nuvem cinza

No painel do Cloudflare, em **DNS**, os registros `A` de `mail` (e de `autoconfig`, se existir) precisam
estar com a nuvem **cinza** ("DNS only"). Com a nuvem laranja (proxy), o IP que os outros servidores
enxergam é o do Cloudflare, que não recebe e-mail, e o MX e o SPF deixam de bater. Nos registros `MX` e
`TXT` o Cloudflare não tem proxy. No campo MX, o servidor de e-mail é `mail.exemplo.com.br` e a prioridade
é `10`.

### PTR (DNS reverso) no provedor da VPS

O PTR **não** fica no DNS do seu domínio. Ele é configurado no painel do provedor da VPS (campo "reverse
DNS" ou "rDNS", na tela do IP). Deve apontar para o nome do servidor mostrado no painel, por exemplo
`mail.exemplo.com.br`, e esse nome precisa ter um registro A para o mesmo IP. Sem PTR, vários provedores
adiam ou rejeitam a mensagem.

O PTR é **por IP do servidor, não por projeto nem por domínio**: um único PTR, apontando para o nome do
servidor de e-mail (o mesmo do HELO/EHLO, que precisa ter registro A de volta para o IP), vale para todos
os projetos. Na **Contabo**: Customer Control Panel, abra o menu **Reverse DNS Management**, escolha o IP,
digite o nome e salve. Em outra hospedagem, procure "Reverse DNS", "rDNS" ou "PTR";
se não houver, abra um chamado. O painel mostra o nome esperado, o valor encontrado e um texto pronto
("Peço configurar o DNS reverso (PTR) do IP X para o nome Y"), já com os dados da sua VPS.

Por que é **atenção importante** e não crítico: com SPF, DKIM e DMARC passando, o Gmail aceitou mensagens
sem PTR. Microsoft, Yahoo e servidores corporativos podem atrasar ou recusar, então resolva antes de
enviar em volume.

## 2. Leia o painel de saúde

Clique em **Verificar a saúde agora** (limite de 6 por minuto). Cada item tem estado:

- **OK**: conforme.
- **Atenção**: funciona, mas pode piorar a entrega (chave DKIM de 1024 bits, DMARC herdado, certificado perto de vencer, DNS ainda propagando).
- **Crítico**: tende a impedir ou prejudicar muito o envio (porta 25 bloqueada, falha de SPF, DKIM ou DMARC, servidor parado). Um aviso vermelho lista esses itens. Os itens em atenção que também afetam a entrega (como o PTR) aparecem num aviso laranja.

Os itens vêm em dois grupos: **Servidor** (IP, DNS reverso, porta 25, certificado e listas de bloqueio, que valem para todos os projetos) e **Domínio** (A, MX, SPF, DKIM, DMARC, propagação, MTA-STS, TLS-RPT e a fila de envio daquele domínio, de cada domínio). Na página de cada projeto com e-mail, a aba Remetente mostra o pior nível entre domínio e servidor, com a contagem de cada um, e destaca em vermelho qualquer crítico do servidor.

Cada item que não está em ordem tem um botão **O que fazer** com passos curtos e valores para copiar. Quando o DMARC está em `p=none` e tudo certo, o painel sugere, sem impor, subir para `p=quarantine` só depois de 2 a 4 semanas de relatórios bons; o risco é uma mensagem legítima que falhe ir para o spam, e dá para voltar a `p=none`. Os opcionais (MTA-STS, TLS-RPT) aparecem como **Opcional · não configurado** ou **Opcional · incompleto**: ficam visíveis, dizem o que melhoram, mas **não contam** em "em atenção" e não mudam o selo do domínio nem o geral.

**MTA-STS:** o painel publica o arquivo da política sozinho, em `https://mta-sts.seudominio/.well-known/mta-sts.txt`, com certificado próprio (modo `testing`, que só relata). Para ligar, crie dois registros no DNS: o `A` de `mta-sts.seudominio` apontando para o IP da VPS (**somente DNS**, nuvem cinza no Cloudflare; pode ser também um `CNAME` para `mail.seudominio`) e o `TXT` `_mta-sts` com o valor mostrado na tela. O item confere os dois e o arquivo e diz o que falta: o A, o TXT, o arquivo que não abre ou o certificado que ainda está sendo emitido (leva de segundos a poucos minutos depois que o A existe). Se a política já abre e é válida (mesmo hospedada fora do painel), o `A` não é cobrado. Se o servidor de e-mail mudar, o texto da política muda e o valor do `TXT` também: a tela mostra o valor novo. A publicação automática exige o **domínio do painel** configurado (Configurações → Domínio do painel); sem ele o item avisa. Se você publicar uma política em `enforce` que não lista o servidor de e-mail real do domínio (o MX que está no DNS, que pode ser de outro provedor), quem envia recusa a entrega: nesse caso o item deixa de ser opcional e acende, dizendo qual MX ficou de fora. O curinga `*.exemplo.com` vale para um nível só. Se uma política que estava em `enforce` deixar de abrir, o item avisa em atenção, porque os remetentes seguem usando a cópia guardada até ela expirar. Domínio cujo MX não é o deste painel não deve usar a política publicada pelo painel (ela lista o servidor do painel): o item avisa.

**MTA-STS, passo a passo do que o painel faz sozinho e do que fica com você:**

- **Do lado do painel (automático, para todo domínio de e-mail):** ao criar o domínio, o painel registra `mta-sts.seudominio` no proxy e, se o DNS já aponta para a VPS, abre a própria URL da política para o certificado ser emitido na hora. Na subida do painel e a cada 30 minutos o mesmo roda para os domínios que ainda não têm a política ativa, poucos por vez e respeitando os limites de certificados. Na lista de domínios, cada um mostra **MTA-STS: aguardando DNS**, **emitindo** ou **ativo**.
- **Do lado do seu DNS (você):** o `A` de `mta-sts.seudominio` e o `TXT` `_mta-sts`. O painel **não** os cria: ele não tem acesso ao seu provedor de DNS (nem token do Cloudflare). A aba **Checklist DNS** os lista junto de A, MX, SPF, DKIM e DMARC, com o selo **Opcional** e o status encontrado ou faltando; eles não entram na contagem "x/y OK".
- **Quando está funcionando:** só vale como **Ativo** quando a política abre em HTTPS, é válida **e** o TXT `_mta-sts` existe com o `id` certo (um DNS curinga que aponta o A para a VPS não basta: sem o TXT nenhum remetente usa a política, e a lista mostra "MTA-STS: falta o TXT"). O item mostra o selo **Ativo** e o texto "MTA-STS ativo em modo de teste". Os passos de configuração somem; fica só um **Detalhes** recolhido com os valores, para consulta.
- **Quando falta algo:** o **O que fazer** mostra a situação (A, TXT e política, cada um com ✓ ou ✗ e a palavra "Pronto" ou "Falta") e **só os passos do que falta**: se o A existe e falta o TXT, aparece só o TXT.
- **Botão Verificar (na própria caixa, só administradores):** roda só este item na hora. Consulta o A e o TXT; se o nome ainda não estava registrado no proxy, registra; se o DNS aponta e falta o certificado, dispara a emissão e acompanha ("emitindo…", nova conferência a cada poucos segundos, até um limite); se falta DNS, mostra exatamente qual registro, com o valor certo do `id` e botão de copiar. O resultado é o próprio item da saúde, avaliado pela mesma regra da verificação completa (MX reais, `enforce`, política inválida), e o aviso do topo e as contagens se atualizam junto. Tem limite de taxa, cota própria de tentativas de emissão por hora (esgotada, a caixa diz "tente às HH:MM") e vai para a auditoria sempre que o painel recarrega o proxy ou dispara uma emissão.
- **`id` do TXT desatualizado:** quando o servidor de e-mail muda, a política e o `id` mudam. Pela RFC 8461, quem já guardou a política antiga a usa até o `max_age` (1 dia), então o painel aceita o TXT com o `id` anterior por **24 horas**: o item continua **Ativo** e só lembra de trocar pelo valor novo. Passado esse prazo, vira "id desatualizado".

**Marcar como ciente:** alguns itens dependem do provedor da VPS e não do painel, como o **DNS reverso (PTR)** e a **porta 25 de saída**. Em cada um há o botão **Marcar como ciente** (com um motivo opcional; só administradores). O item continua visível com o selo **Ciente**, não conta em "em atenção" e sai do aviso do topo. **Só vale para item em atenção**: o que está crítico, como a porta 25 bloqueada (nenhum e-mail sai), não pode ser silenciado. Se o problema mudar (o PTR passa a apontar para outro nome, ou a porta 25 passa a bloqueada), ele volta a contar sozinho; **Desmarcar** também volta ao normal. Para o PTR, o passo a passo do Contabo continua valendo: lá dá para configurar no Customer Control Panel; "ciente" serve para quando você decidiu não fazer agora.

Itens: A, MX, SPF (inclusive o limite de 10 consultas DNS), DKIM, DMARC, PTR, porta 25 de saída, fila,
certificado TLS, listas de bloqueio, propagação e, como bônus, MTA-STS e TLS-RPT. O painel repete a
verificação todo dia. Reputação do IP e reclamações não dá para medir daqui: use o Google Postmaster Tools
e o Microsoft SNDS.

Mudou o DNS? Aguarde: pode levar de minutos a horas. O item "Propagação" avisa quando os resolvedores
ainda discordam.

## 3. Teste e confira no Gmail

Em **Enviar e-mail de teste**, digite um endereço seu e envie (máximo de 60 por dia). Depois de "entregue":

1. Abra a mensagem no Gmail.
2. Clique nos três pontos e em **Mostrar original**.
3. Confira que **SPF**, **DKIM** e **DMARC** estão como **PASS**.
4. Veja se caiu em Spam; se caiu, marque como "Não é spam" para ajudar.

O painel não lê a sua caixa; ele só informa o resultado do envio no servidor.

## Se algo não fecha

Veja [Solução de problemas](troubleshooting.md) para porta 25 bloqueada e e-mail em spam.
