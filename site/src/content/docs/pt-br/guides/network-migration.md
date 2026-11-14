---
title: "Migração para redes separadas: roteiro da VPS e como desfazer"
description: "Roteiro para atualizar uma instalação existente para a versão com redes Docker separadas, com conferências, tratamento de falhas e como voltar atrás."
sidebar:
  label: "Migração de redes"
---

Vale para uma instalação que já roda o painel (pasta `/opt/tws-panel`, projetos em `/opt/tws-projects`) e vai
receber a versão com as redes separadas. Instalação nova não precisa disto: as redes nascem certas.

> [!NOTE]
> **Idioma da interface.** O painel está disponível em português e em inglês ([como escolher](../getting-started/complete-guide.md#idioma-da-interface)). Esta página cita os rótulos em português, exatamente como aparecem na tela. As linhas de log e os avisos que esta página cita vêm do servidor e continuam em português mesmo com a interface em inglês.

## O que muda nas redes

| Rede | Quem fica nela |
|---|---|
| `paas-net` | Só o Caddy (`paas-caddy`). **Painel, Stalwart, webmail e os serviços web dos projetos saem dela.** |
| `paas-proxy-<slug>` | Uma por projeto que recebe tráfego: o Caddy e o serviço web **daquele** projeto (sub-rede `/26` própria; não é interna, porque é por ela que o app de um container só sai para a internet). |
| `paas-panel` | Só o Caddy e o painel (`tws-panel`); o webmail também, para o Caddy alcançá-lo. |
| `paas-mail-admin` | Só o painel e o Stalwart (`paas-stalwart`): a administração do e-mail. |
| `paas-mail` | Só o Stalwart (saída para a internet e portas publicadas). |
| `paas-mailweb` | Só o webmail e o Stalwart (interna). |
| `paas-mail-<slug>` | Uma por projeto com e-mail: o Stalwart e os serviços **daquele** projeto (interna, sub-rede `/26` própria). |

> **Rede de e-mail por projeto.** Antes, os serviços de todos os projetos com e-mail dividiam a `paas-mail`: o php-fpm, o nginx e os workers de um projeto ficavam ao alcance dos containers de outro. Agora cada projeto tem a sua (`paas-mail-<slug>`), e o Stalwart está em todas com os mesmos nomes (`paas-stalwart` e `mail.<domínio>`), então o `SMTP_HOST` dos projetos **não muda**. As sub-redes saem de uma faixa reservada do painel (`10.213.0.0/16`, um bloco `/26` por projeto); se a sua VPS já usa essa faixa, defina outra no `.env` com `PAAS_MAIL_SUBNET_POOL=172.30.0.0/16` (faixa privada, `/26` ou maior) antes de atualizar. Um projeto de slug `admin` recebe `paas-mail--admin` (para não tomar a `paas-mail-admin`).

> **Rede do proxy por projeto.** Antes, o serviço web de todo projeto ficava na `paas-net`, e por ela um projeto alcançava o container web de qualquer outro sem passar pelo Caddy. Agora cada projeto tem a sua (`paas-proxy-<slug>`), e o Caddy entra em todas: o upstream (`<slug>:<porta>`) não muda. As sub-redes saem da faixa `10.214.0.0/16` (trocável por `PAAS_PROXY_SUBNET_POOL` no `.env`, faixa privada `/26` ou maior; faixa inválida gera aviso no log e o painel usa a padrão). O Caddy tem endereço fixo em cada rede (o endereço base+2 do bloco, fora da faixa dos endereços automáticos), então `PAAS_PROXY_IP` não muda quando ele é recriado. Um compose que declara a `paas-net` passa a ser barrado no deploy (`network-hijack`, sem override): tire do compose a rede que aponta para `paas-net` (no bloco `networks:` do fim e em `networks:` dos serviços); o painel liga o serviço web à rede do projeto sozinho.

> Serviço do compose com `network_mode: service:X` (que compartilha a rede de outro) não recebe rede própria: o painel liga o serviço dono (`X`) à rede de e-mail do projeto e os que compartilham a rede dele alcançam o servidor de e-mail por ele.

> Banco e cache (imagem reconhecida, ou `tws.mail=false`) **não** entram na rede de e-mail nem recebem o `SMTP_*`; quem estava nela por um deploy antigo é desligado dela na migração (só dela: a rede do projeto, por onde o banco fala com o app, não é tocada). Para manter um serviço de imagem de banco que envia e-mail, use a label `tws.mail=true`. Quem compartilha a rede de um banco (`network_mode: service:db`) não tem como alcançar o e-mail por outro caminho: fica de fora junto com ele, sem `SMTP_*`, e o log do deploy diz para marcar o **dono** (`db`) com `tws.mail=true`; marcado o dono, os dois entram. O painel grava em cada serviço o carimbo `tws.mail.decided` (`in`/`out`) e, ao reiniciar, só segue o carimbo; containers de antes dele (sem carimbo) são ligados à rede de e-mail do projeto, para não perderem o e-mail quando o Stalwart sair da `paas-net`, exceto os de imagem reconhecidamente de banco, que são desligados dela.

Quando acontece sozinho (nada é recriado, só `docker network connect/disconnect`):

1. Painel no ar e servido por domínio: no boot (e em todo deploy ou atualização do proxy) o Caddy entra na
   `paas-panel`, o painel entra nela e, **só depois do reload do Caddy**, o painel sai da `paas-net`. No acesso por
   túnel (sem domínio do painel) o painel sai da `paas-net` na hora.
2. Cerca de 1 minuto depois do boot (e de novo a cada atualização de certificado, até dar certo), se há servidor de
   e-mail: o Stalwart entra na `paas-mail-admin`, na `paas-mail`, na `paas-mailweb` e na rede de cada projeto; o
   painel entra na `paas-mail-admin`; para cada projeto com e-mail, a `paas-mail-<slug>` é criada, o Stalwart entra
   nela, os containers do projeto (rodando ou parados) entram nela com os mesmos apelidos e **só depois** saem da
   `paas-mail`; o webmail entra na `paas-mailweb` e sai da `paas-mail`; o Stalwart sai da `paas-net`; por último,
   quem sobrou na `paas-mail` (menos o Stalwart) sai dela. Nenhum container é parado nem recriado, e não precisa de
   redeploy. Se o Stalwart não entrar nas redes novas, **nada** é tirado de lugar; um projeto que falhar fica na
   `paas-mail` (com o e-mail funcionando) e a rodada seguinte tenta de novo.
3. No boot, o log do painel avisa de containers antigos na `paas-net` com um nome que é do painel
   (`tws-panel`, `paas-*`, `tws-*`) como alias. O painel só avisa; quem decide é você.
4. Cerca de 1 minuto depois do boot: para cada projeto, a `paas-proxy-<slug>` é criada, o Caddy entra nela, os
   containers do projeto (rodando ou parados) entram nela com o apelido `<slug>` e **só depois** saem da `paas-net`;
   no fim o Caddy recarrega uma vez (fecha as conexões antigas). **Ficam na `paas-net`, no ar, até o próximo deploy**
   (aviso no log e no cartão "Rede e proxy" da seção Variáveis do projeto): projeto cujo container recebeu
   `PAAS_PROXY_IP`/`PAAS_PROXY_SUBNET`, ou compose cujo compose/`.env.example` cita essas variáveis (mudar de rede
   mudaria o IP do proxy que o app vê), e compose que declara a `paas-net`. O deploy desses projetos os leva para a
   rede própria só depois que a versão nova sobe: se o build falhar, a versão no ar segue como estava.

Efeitos que você vai notar: os projetos passam a ser conferidos por uma lista fechada de campos do compose
(campo desconhecido, `privileged`, bind fora da pasta, volume ou rede do painel, `docker.sock` etc. barram o
deploy), e todo container sobe sem `NET_RAW` e com `no-new-privileges`. Um compose que dependia disso passa a ser
barrado **no próximo deploy** (os containers que já rodam continuam como estão).

## Roteiro

Entre na VPS por SSH com o seu usuário. Todos os comandos abaixo rodam com `sudo`.

### Passo 0 — anotar o estado atual (é o que permite voltar)

```
cd /opt/tws-panel
sudo git status -sb | head -1
sudo git log --oneline -1
sudo docker network ls --format '{{.Name}}' | grep -E '^paas'
sudo docker inspect -f '{{json .NetworkSettings.Networks}}' tws-panel
sudo docker inspect -f '{{json .NetworkSettings.Networks}}' paas-stalwart
sudo docker network inspect paas-net --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}'
```

Anote: a **branch** (primeira linha do `git status -sb`), o **hash do commit** e quem está na `paas-net`. Se não
usa e-mail, os comandos do `paas-stalwart` darão "No such object": normal.

### Passo 1 — atualizar

```
cd /opt/tws-panel && sudo git pull && sudo git log --oneline -1 && sudo docker compose up -d --build
```

A primeira vez baixa as imagens do Alpine, Caddy, nginx, node e Stalwart **pelo digest** (precisa de acesso ao
registro). Conferir: o comando termina sem erro e `sudo docker ps --filter name=tws-panel --format '{{.Status}}'`
mostra `Up`. Se o `build` falhar, o painel antigo continua rodando e **nada mudou**: veja a seção "Se falhar".

Instalação fora de `/opt/tws-panel` que só faz `git pull`: o painel não sabe onde está a pasta dele e continua protegendo
`/opt/tws-panel` (o `.env` com os segredos ficaria montável por um compose de projeto com override). Rode o
`./scripts/install.sh` de novo, ou acrescente `PAAS_HOST_REPO_DIR=<caminho real da pasta, sem link>` ao `.env` e rode
o `docker compose up -d`.

### Passo 2 — painel e Caddy

Espere cerca de 1 minuto e confira:

```
sudo docker logs --tail 40 tws-panel
sudo docker network inspect paas-panel --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}'
sudo docker network inspect paas-net --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}'
```

Esperado: `paas-panel` com `paas-caddy` e `tws-panel`; `paas-net` **sem** `tws-panel`; no log, nenhuma linha
"falha ao conectar" nem "o painel continua na rede paas-net". Depois:

- abra `https://<domínio do painel>` e entre com o seu login (a tela de login tem que responder);
- abra o site de um projeto em outra aba (o Caddy responde);
- em `sudo docker logs --tail 40 paas-caddy` não pode haver erro de "no such host".

### Passo 3 — e-mail (só se usa o servidor de e-mail)

Espere mais 1 ou 2 minutos (a migração roda na atualização dos certificados) e confira:

```
sudo docker network inspect paas-mail-admin --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}'
sudo docker network inspect paas-mail --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}'
sudo docker network inspect paas-mailweb --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}'
sudo docker network ls --filter label=paas.mail.project --format '{{.Name}}'
sudo docker network inspect paas-mail-<slug> --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}'
sudo docker network inspect paas-net --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}'
```

Esperado: `paas-mail-admin` = `tws-panel` + `paas-stalwart`; `paas-mail` = **só** `paas-stalwart`; `paas-mailweb` =
`paas-stalwart` + `paas-webmail` (se ativado); uma `paas-mail-<slug>` por projeto com e-mail, cada uma com
`paas-stalwart` e os containers **daquele** projeto (nunca os de outro); `paas-net` sem `paas-stalwart` nem
`paas-webmail`. No log do painel, cada container migrado aparece como "passou da paas-mail (dividida com outros
projetos) para paas-mail-<slug>".

Teste de verdade:

1. Na página **E-mail** do painel, a situação do servidor aparece como em execução (o painel fala com o Stalwart
   pela `paas-mail-admin`).
2. SMTP de um projeto: use o teste de envio do próprio projeto/da seção E-mail do painel. Para conferir só a rede
   (substitua `<domínio>` pelo seu):
   `sudo docker run --rm --network paas-mail-<slug> alpine:3 nc -zv -w 5 mail.<domínio> 587` — deve dizer `open`.
3. Webmail (se ativado): abra o endereço dele; tem que carregar e entrar.
4. Prova de isolamento (deve **falhar** em resolver o nome):
   `sudo docker run --rm --network paas-net alpine:3 sh -c 'nslookup paas-stalwart; nslookup tws-panel'`
5. Prova de isolamento entre projetos (deve **falhar**: o serviço `app` do projeto B não existe na rede do A):
   `sudo docker run --rm --network paas-mail-<slug-do-A> alpine:3 nslookup <serviço-do-B>`

### Passo 4 — projetos

Espere cerca de 1 minuto depois da subida e confira a rede do proxy:

```
sudo docker logs tws-panel 2>&1 | grep "Rede do proxy"
sudo docker network ls --filter label=paas.proxy.project --format '{{.Name}}'
sudo docker network inspect paas-net --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}'
sudo docker network inspect paas-proxy-<slug> --format '{{range .Containers}}{{.Name}} {{.IPv4Address}}{{"\n"}}{{end}}'
```

Esperado: uma `paas-proxy-<slug>` por projeto, cada uma com `paas-caddy` (no endereço base+2 do bloco, ex.:
`10.214.3.66/26` num bloco `10.214.3.64/26`) e os containers **daquele** projeto; na `paas-net`, `paas-caddy` e só
os projetos que ficaram esperando deploy, que o log lista na linha "N projeto(s) ficaram na paas-net esperando um
novo deploy: …" (o motivo de cada um vem logo antes, em "o projeto X segue na paas-net, no ar: …"). Faça o deploy
de cada um deles (se o motivo for o compose declarar a `paas-net`, corrija o compose antes). Prova de isolamento
(deve **falhar**): `sudo docker run --rm --network paas-proxy-<slug-do-A> alpine:3 nslookup <slug-do-B>`.

Entre no log do painel e procure o aviso de alias reservado (passo "3" acima):
`sudo docker logs tws-panel 2>&1 | grep -i "responde pelo nome"`. Para cada container citado, corrija o compose do
projeto e faça o deploy de novo (ou, para tirar da rede agora, o comando que o próprio aviso mostra).

Faça um deploy de teste de um projeto comum. Se o painel barrar (`guardrail_blocked`), a tela mostra qual campo; as
regras que protegem o painel (`reserved-name`, `network-hijack`, `panel-image`, `panel-resource`) não têm
override.

## Se falhar no meio do caminho

| O que aconteceu | Estado | O que fazer |
|---|---|---|
| `docker compose up -d --build` falhou (por exemplo, sem acesso ao registro para baixar por digest) | O painel antigo continua rodando; nada mudou. | Corrija o acesso e rode a linha do passo 1 de novo. |
| Log: "falha ao conectar … à rede paas-panel" ou "falha ao criar a rede" | O painel **continua na `paas-net`**; o site segue no ar. | Em geral falta endereço livre para a rede nova: `sudo docker network create --label paas.managed=true --subnet 172.29.0.0/24 paas-panel` (escolha uma faixa que `docker network inspect` das outras redes não use). Reinicie o painel: `cd /opt/tws-panel && sudo docker compose restart`. |
| Log: "o painel continua na rede paas-net" | O painel está nas duas redes. | Sem urgência. Tente `sudo docker network disconnect paas-net tws-panel` quando o Caddy já responde pelo domínio do painel. |
| Log: "E-mail: migração para as redes separadas falhou" | O Stalwart **não** saiu de lugar; o e-mail continua como antes. | A migração se repete na próxima atualização de certificados. Para forçar: `sudo docker network connect paas-mail-admin paas-stalwart` e `sudo docker network connect paas-mail paas-stalwart` (com os aliases: veja "Voltar" abaixo), depois `sudo docker restart tws-panel`. |
| Log: "não consegui passar o projeto X para a rede de e-mail dele" | Esse projeto segue na `paas-mail` com o e-mail funcionando; a rodada seguinte tenta de novo. | Espere a próxima rodada ou faça o deploy do projeto X (o deploy já sobe na rede dele). |
| Log: "o servidor de e-mail não entrou numa rede de projeto agora" | O Stalwart está fora da rede daquele projeto: o projeto fica sem SMTP até a próxima rodada. | `sudo docker network connect --alias paas-stalwart --alias mail.<domínio> paas-mail-<slug> paas-stalwart` (repita `--alias` para cada domínio e o hostname do servidor de e-mail). |
| Log: "a faixa das redes de e-mail (…) está cheia" ou a rede nova colide com uma rede da VPS | O deploy do projeto para antes de mexer no que está no ar. | Defina outra faixa privada no `.env` (`PAAS_MAIL_SUBNET_POOL=172.30.0.0/16`) e rode `sudo docker compose up -d`. |
| Log: "o webmail não mudou de rede agora" | O webmail segue na rede antiga. | `sudo docker network connect paas-panel paas-webmail` e `sudo docker network connect paas-mailweb paas-webmail`; depois `sudo docker network disconnect paas-net paas-webmail`. |
| Log: "não consegui passar o projeto X para a rede dele" | Esse projeto segue na `paas-net`, no ar; a rodada seguinte (a cada 10 minutos) tenta de novo. | Espere a próxima rodada ou faça o deploy do projeto X. |
| Log: "o proxy (Caddy) não pôde entrar na rede … com o endereço fixo" | O Caddy entrou com outro endereço (rede criada sem a reserva): `PAAS_PROXY_IP` pode mudar se ele for recriado. | Sem urgência; `PAAS_PROXY_SUBNET` segue estável. |
| Log: "PAAS_PROXY_SUBNET_POOL=… foi descartada" (ou `PAAS_MAIL_SUBNET_POOL`) | O painel usa a faixa padrão. | Corrija o valor no `.env` (faixa IPv4 privada, `/26` ou maior) e rode `cd /opt/tws-panel && sudo docker compose up -d`. |
| Painel não abre pelo domínio depois do passo 1 | O Caddy deve alcançar `tws-panel` pela `paas-panel`. | `sudo docker network connect paas-panel paas-caddy` e `sudo docker network connect paas-panel tws-panel` (mensagem "already exists" é normal). Se ainda assim não abrir, volte a ligar o painel à rede antiga: `sudo docker network connect paas-net tws-panel` e siga para "Voltar". |

## Voltar à versão anterior

O que o painel faz sozinho ao voltar **não é tudo** (conferido lendo o código da versão anterior):

- **Painel ↔ Caddy:** a versão antiga, no boot e a cada atualização do proxy, liga o painel de novo à `paas-net`
  (somente se o painel é servido por domínio). Isso é automático.
- **Stalwart:** a versão antiga só o liga de volta à `paas-net` quando existem hosts `mail.<domínio>` (ela religa
  com os aliases ao iniciar o servidor de e-mail ou atualizar os certificados). Sem domínios de e-mail
  cadastrados, **não religa**. Faça à mão (abaixo).
- **Webmail:** a versão antiga **não** religa a rede dele. Faça à mão.
- **Projetos com e-mail:** continuam ligados à `paas-mail-<slug>` deles (inofensivo); alcançam o Stalwart de novo
  assim que ele voltar à `paas-net`. O próximo deploy na versão antiga os recria sem ela.
- **Rede do proxy por projeto:** os sites seguem no ar enquanto o Caddy estiver nas `paas-proxy-<slug>` (a versão
  antiga não o tira delas). Se o Caddy for recriado na versão antiga, ele volta só na `paas-net`: religue cada
  container web a ela à mão (abaixo) ou faça o deploy do projeto na versão antiga.

Passos:

```
cd /opt/tws-panel
sudo git checkout <hash anotado no passo 0>
sudo docker compose up -d --build
```

Depois, **à mão** (o que for aplicável; "already exists" é normal):

```
sudo docker network connect paas-net tws-panel
sudo docker network connect --alias paas-stalwart --alias mail.<domínio> paas-net paas-stalwart
sudo docker network connect paas-net paas-webmail
```

Para cada projeto (o serviço web dele; `sudo docker network inspect paas-proxy-<slug>` mostra o nome):

```
sudo docker network connect --alias <slug> paas-net <container-web-do-projeto>
```

Na linha do Stalwart repita `--alias mail.<domínio>` para cada domínio de e-mail cadastrado e o hostname do servidor
de e-mail (é por esses nomes que os projetos acham o SMTP na versão antiga). Se o Stalwart já estiver na
`paas-net` sem os aliases, rode antes `sudo docker network disconnect paas-net paas-stalwart`.

Conferir: login do painel; `sudo docker network inspect paas-net --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}'`
lista `tws-panel`, `paas-stalwart` e `paas-webmail` de novo; SMTP de um projeto e o webmail respondem.

Para voltar para a versão nova depois: `sudo git checkout <branch anotada no passo 0> && sudo git pull` e a linha do
passo 1. (Enquanto estiver com `checkout` de um hash, `git pull` não funciona: é esperado.)

As redes `paas-panel`, `paas-mail-admin`, `paas-mail`, `paas-mailweb` e `paas-mail-<slug>` podem ficar: a versão
antiga as ignora. Para apagá-las depois (só se estiverem vazias): `sudo docker network rm paas-panel paas-mail-admin
paas-mail paas-mailweb` e `sudo docker network rm $(sudo docker network ls -q --filter label=paas.mail.project)`. As
`paas-proxy-<slug>` só depois de religar os projetos à `paas-net`: `sudo docker network disconnect paas-proxy-<slug>
paas-caddy` e `sudo docker network rm paas-proxy-<slug>`.

Voltando de uma versão com rede por projeto para a anterior a ela (ainda com a `paas-mail` dividida): os projetos
ficam só na `paas-mail-<slug>`, que a versão anterior não conhece; o SMTP deles volta no próximo deploy de cada um
(que os liga à `paas-mail`), ou à mão: `sudo docker network connect paas-mail <container-do-projeto>`.

Dados: a migração não mexe em volumes. O painel grava arquivos novos fora da pasta `src` dos projetos
(`paas.canonical.json`, `paas.up.env`, `repo.git`); a versão antiga os ignora. Atenção: os projetos que já foram
atualizados pela versão nova têm o `.git` de `src` convertido para um apontador de `repo.git`; o git da versão antiga
segue esse apontador, mas **isso não foi testado** com a versão antiga.

## O que não foi testado de verdade

- Nenhum destes passos foi executado numa VPS nem com Docker real (o Docker Desktop do desenvolvedor ficou sem
  resposta e o pool de endereços de rede dele está esgotado): a ordem dos `docker network connect/disconnect`, a
  migração em instalação viva e o rollback foram verificados lendo o código e com dublês do Docker nos testes.
  Faça o roteiro primeiro num servidor de teste ou numa janela em que um minuto de instabilidade seja aceitável.
- SMTP de um projeto de ponta a ponta pela rede de e-mail dele e a leitura real dos IPs do Caddy para o `trustProxy`.
- A migração para a rede de e-mail por projeto (`paas-mail-<slug>`, sub-rede explícita, `docker network connect`
  com os apelidos e a limpeza da `paas-mail`) foi verificada com dublês do Docker, não numa VPS.
- O `docker compose` real foi usado apenas para `config` (modelo canônico, ida e volta do JSON gravado fora do `src`);
  `up` do JSON canônico não foi rodado.
