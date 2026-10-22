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
os projetos. Na **Contabo**: Customer Control Panel, abra o servidor, vá em IPs/Network, ao lado do IP
clique em Reverse DNS, digite o nome e salve. Em outra hospedagem, procure "Reverse DNS", "rDNS" ou "PTR";
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

Os itens vêm em dois grupos: **Servidor** (IP, DNS reverso, porta 25, certificado, listas de bloqueio e fila, que valem para todos os projetos) e **Domínio** (A, MX, SPF, DKIM, DMARC, propagação, MTA-STS e TLS-RPT, de cada domínio). Na página de cada projeto com e-mail, a aba Remetente mostra o resumo do domínio do projeto e o estado do PTR e da porta 25.

Cada item que não está em ordem tem um botão **O que fazer** com passos curtos e valores para copiar. Os bônus (MTA-STS, TLS-RPT) dizem que são opcionais e o que melhoram. Quando o DMARC está em `p=none` e tudo certo, o painel sugere, sem impor, subir para `p=quarantine` só depois de 2 a 4 semanas de relatórios bons; o risco é uma mensagem legítima que falhe ir para o spam, e dá para voltar a `p=none`.

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
