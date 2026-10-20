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
| `paas-net` | Caddy (`paas-caddy`) e os serviços web dos projetos. **Painel, Stalwart e webmail saem dela.** |
| `paas-panel` | Só o Caddy e o painel (`tws-panel`); o webmail também, para o Caddy alcançá-lo. |
| `paas-mail-admin` | Só o painel e o Stalwart (`paas-stalwart`): a administração do e-mail. |
| `paas-mail` | Stalwart, webmail e os serviços dos projetos com e-mail habilitado (SMTP/IMAP). |

Quando acontece sozinho (nada é recriado, só `docker network connect/disconnect`):

1. Painel no ar e servido por domínio: no boot (e em todo deploy ou atualização do proxy) o Caddy entra na
   `paas-panel`, o painel entra nela e, **só depois do reload do Caddy**, o painel sai da `paas-net`. No acesso por
   túnel (sem domínio do painel) o painel sai da `paas-net` na hora.
2. Cerca de 1 minuto depois do boot (e de novo a cada atualização de certificado, até dar certo), se há servidor de
   e-mail: o Stalwart entra na `paas-mail-admin` e na `paas-mail`; o painel entra na `paas-mail-admin`; os
   containers que já rodam dos projetos com e-mail entram na `paas-mail`; o webmail muda para `paas-panel` +
   `paas-mail`; por último o Stalwart sai da `paas-net`. Se o Stalwart não entrar nas redes novas, **nada** é
   tirado de lugar.
3. No boot, o log do painel avisa de containers antigos na `paas-net` com um nome que é do painel
   (`tws-panel`, `paas-*`, `tws-*`) como alias. O painel só avisa; quem decide é você.

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
sudo docker network inspect paas-net --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}'
```

Esperado: `paas-mail-admin` = `tws-panel` + `paas-stalwart`; `paas-mail` = `paas-stalwart`, `paas-webmail` (se ativado) e
os containers dos projetos com e-mail; `paas-net` sem `paas-stalwart` nem `paas-webmail`.

Teste de verdade:

1. Na página **E-mail** do painel, a situação do servidor aparece como em execução (o painel fala com o Stalwart
   pela `paas-mail-admin`).
2. SMTP de um projeto: use o teste de envio do próprio projeto/da seção E-mail do painel. Para conferir só a rede
   (substitua `<domínio>` pelo seu):
   `sudo docker run --rm --network paas-mail alpine:3 nc -zv -w 5 mail.<domínio> 587` — deve dizer `open`.
3. Webmail (se ativado): abra o endereço dele; tem que carregar e entrar.
4. Prova de isolamento (deve **falhar** em resolver o nome):
   `sudo docker run --rm --network paas-net alpine:3 sh -c 'nslookup paas-stalwart; nslookup tws-panel'`

### Passo 4 — projetos

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
| Log: "não consegui ligar o projeto X à rede de e-mail" | Esse projeto fica sem SMTP até o próximo deploy dele. | Faça o deploy do projeto X (o painel o liga à `paas-mail`) ou `sudo docker network connect paas-mail <container-do-projeto>`. |
| Log: "o webmail não mudou de rede agora" | O webmail segue na rede antiga. | `sudo docker network connect paas-panel paas-webmail` e `sudo docker network connect paas-mail paas-webmail`; depois `sudo docker network disconnect paas-net paas-webmail`. |
| Painel não abre pelo domínio depois do passo 1 | O Caddy deve alcançar `tws-panel` pela `paas-panel`. | `sudo docker network connect paas-panel paas-caddy` e `sudo docker network connect paas-panel tws-panel` (mensagem "already exists" é normal). Se ainda assim não abrir, volte a ligar o painel à rede antiga: `sudo docker network connect paas-net tws-panel` e siga para "Voltar". |

## Voltar à versão anterior

O que o painel faz sozinho ao voltar **não é tudo** (conferido lendo o código da versão anterior):

- **Painel ↔ Caddy:** a versão antiga, no boot e a cada atualização do proxy, liga o painel de novo à `paas-net`
  (somente se o painel é servido por domínio). Isso é automático.
- **Stalwart:** a versão antiga só o liga de volta à `paas-net` quando existem hosts `mail.<domínio>` (ela religa
  com os aliases ao iniciar o servidor de e-mail ou atualizar os certificados). Sem domínios de e-mail
  cadastrados, **não religa**. Faça à mão (abaixo).
- **Webmail:** a versão antiga **não** religa a rede dele. Faça à mão.
- **Projetos com e-mail:** continuam ligados à `paas-mail` (inofensivo); alcançam o Stalwart de novo assim que ele
  voltar à `paas-net`. O próximo deploy na versão antiga os recria sem a `paas-mail`.

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

Na linha do Stalwart repita `--alias mail.<domínio>` para cada domínio de e-mail cadastrado e o hostname do servidor
de e-mail (é por esses nomes que os projetos acham o SMTP na versão antiga). Se o Stalwart já estiver na
`paas-net` sem os aliases, rode antes `sudo docker network disconnect paas-net paas-stalwart`.

Conferir: login do painel; `sudo docker network inspect paas-net --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}'`
lista `tws-panel`, `paas-stalwart` e `paas-webmail` de novo; SMTP de um projeto e o webmail respondem.

Para voltar para a versão nova depois: `sudo git checkout <branch anotada no passo 0> && sudo git pull` e a linha do
passo 1. (Enquanto estiver com `checkout` de um hash, `git pull` não funciona: é esperado.)

As redes `paas-panel`, `paas-mail-admin` e `paas-mail` podem ficar: a versão antiga as ignora. Para apagá-las depois
(só se estiverem vazias): `sudo docker network rm paas-panel paas-mail-admin paas-mail`.

Dados: a migração não mexe em volumes. O painel grava arquivos novos fora da pasta `src` dos projetos
(`paas.canonical.json`, `paas.up.env`, `repo.git`); a versão antiga os ignora. Atenção: os projetos que já foram
atualizados pela versão nova têm o `.git` de `src` convertido para um apontador de `repo.git`; o git da versão antiga
segue esse apontador, mas **isso não foi testado** com a versão antiga.

## O que não foi testado de verdade

- Nenhum destes passos foi executado numa VPS nem com Docker real (o Docker Desktop do desenvolvedor ficou sem
  resposta e o pool de endereços de rede dele está esgotado): a ordem dos `docker network connect/disconnect`, a
  migração em instalação viva e o rollback foram verificados lendo o código e com dublês do Docker nos testes.
  Faça o roteiro primeiro num servidor de teste ou numa janela em que um minuto de instabilidade seja aceitável.
- SMTP de um projeto de ponta a ponta pela `paas-mail` e a leitura real dos IPs do Caddy para o `trustProxy`.
- O `docker compose` real foi usado apenas para `config` (modelo canônico, ida e volta do JSON gravado fora do `src`);
  `up` do JSON canônico não foi rodado.
