---
title: "Domínios dos seus clientes (SaaS)"
description: "Como atender o subdomínio e o domínio próprio de cada cliente do seu SaaS no mesmo projeto, com certificado HTTPS emitido sozinho no primeiro acesso: cadastro, DNS passo a passo (CNAME e A), Cloudflare sem proxy, tetos, API com token de domínios e limitações."
sidebar:
  label: "Domínios dos clientes (SaaS)"
---

Se o seu app atende vários clientes, cada um costuma querer um endereço seu: `cliente1.seu-saas.com.br`
(um subdomínio **seu**) ou `app.escola-cliente.com.br` (o domínio **do cliente**, apontado para a sua VPS).
Esta página mostra como o painel serve esses nomes **no mesmo projeto**, sem você editar o projeto a cada
cliente novo, com o certificado HTTPS de cada nome emitido sozinho no primeiro acesso.

> Para os endereços fixos do projeto (o principal e os adicionais), veja a seção **Domínios** do projeto e
> o [guia passo a passo](../getting-started/complete-guide.md). Este guia é só para os nomes **dos seus clientes**.

---

## Como funciona

1. Você **cadastra o nome** no projeto (pela tela, ou o seu app pela API).
2. O cliente aponta o **DNS** do nome para a sua VPS.
3. No **primeiro acesso HTTPS** ao nome, o proxy (Caddy) pergunta ao painel se aquele nome é permitido. Só
   responde "sim" para nomes cadastrados (ou do seu sufixo, veja abaixo), dentro dos tetos e **cujo DNS já
   aponta para esta VPS** (o painel confere antes de gastar uma emissão).
4. O Caddy pede o certificado ao Let's Encrypt (desafio HTTP) e o nome passa a abrir com HTTPS válido. As
   renovações são automáticas.

Antes do passo 4 o nome fica em **Aguardando DNS / emissão**. Isso é normal: o certificado só sai depois que o
DNS do nome já aponta para a VPS e alguém abre o endereço.

O painel **não** emite certificado para nome que ninguém cadastrou: um nome inventado, apontado para a sua VPS
por terceiros, é recusado antes de qualquer pedido ao Let's Encrypt. E nome cadastrado cujo DNS ainda **não**
aponta para a VPS também é recusado **sem gastar** as suas emissões: quem só repete o endereço de um cliente que
ainda não configurou o DNS não consome a cota dos outros.

## O que precisa estar pronto

- O painel precisa estar **servido por HTTPS no seu domínio** (Configurações, Domínio do painel) e rodando no
  container padrão. Sem isso o proxy não alcança o painel e a tela do projeto mostra um aviso explicando.
- As portas **80 e 443** abertas na VPS (o desafio HTTP usa a 80).
- O painel precisa **saber o IP público da VPS**: é com ele que confere se o DNS do nome aponta para cá.
  Ele o descobre sozinho de qualquer um destes jeitos: a variável `PAAS_PUBLIC_IP` do `.env` (e
  `PAAS_PUBLIC_IPV6`, se houver IPv6), que o instalador já grava; o IP de qualquer endereço do painel no formato
  `1-2-3-4.sslip.io`; ou o IP que você informar em **Configurações, Domínios dinâmicos, IP público desta VPS**
  (vale na hora, sem reiniciar). O painel **não consulta nenhum serviço externo** para descobrir o IP.
  **Sem nenhum IP conhecido nenhum certificado novo é autorizado** (falha segura): a tela do projeto e as
  Configurações mostram, em destaque, "IP público da VPS desconhecido: nenhum certificado novo será emitido", e
  os nomes ficam **Aguardando DNS / emissão**. Para resolver, informe o IP nas Configurações. Quem já tinha o
  painel instalado só precisa da atualização de sempre (`cd /opt/tws-panel && sudo git pull && sudo docker
  compose up -d --build`): se o `.env` não tem o IP e o endereço do painel é um domínio seu, informe o IP uma vez
  nas Configurações (ou acrescente `PAAS_PUBLIC_IP=<ip>` ao `.env` e rode `sudo docker compose up -d`).
  Se o IP da VPS **mudar** (outro servidor, reinstalação), ajuste o `PAAS_PUBLIC_IP` no `.env` e o campo das
  Configurações: um IP antigo esquecido só soma um endereço velho à lista, mas convém tirá-lo.
- O app do projeto responde pelo **host** que recebe, descobrindo o cliente pelo nome (`Host`). Todos os nomes
  dinâmicos caem no **mesmo** projeto, na porta dele.

## Passo 1: cadastrar os nomes

No projeto, abra **Domínios** e role até **Domínios dos seus clientes**.

- **Nome avulso** (domínio do cliente): digite `app.escola-cliente.com.br` e clique em **Cadastrar**. Sem
  `https://`, sem curinga. O mesmo nome não pode estar em dois projetos nem ser um endereço que o painel já
  serve (o principal, o do painel, o do e-mail).
- **Subdomínios seus** (um sufixo): em **Subdomínios seus (sufixo)** adicione `seu-saas.com.br`. Qualquer nome
  de **um nível** abaixo dele (`cliente1.seu-saas.com.br`) passa a valer, com **um certificado por nome**.
  `a.b.seu-saas.com.br` (dois níveis) não vale.

Por padrão o sufixo só aceita nomes **cadastrados**. A opção **Aceitar qualquer subdomínio no primeiro acesso**
cadastra o nome sozinha quando alguém o acessa (e o DNS dele aponta para a VPS). Ela é cômoda, mas tem um
custo real: o Let's Encrypt aceita **50 certificados por domínio registrado a cada 7 dias**, e todos os
subdomínios de `seu-saas.com.br` contam juntos. Quem descobrir o endereço pode apontar nomes inventados para a
VPS e **esgotar esses 50, travando novos certificados do seu domínio por uma semana**, inclusive os de clientes
de verdade. O painel segura isso com um teto semanal por domínio (padrão **40**, veja Tetos), mas o teto só
reduz o estrago: com a opção ligada, um estranho ainda consegue ocupar as 40 vagas da semana. Ligue só se você
aceita isso; senão cadastre os nomes pela tela ou pela API.

Um sufixo **não pode** cobrir um nome que outro projeto já tenha (nem o site fixo de outro projeto), nem ser o
domínio de aplicações ou ficar abaixo dele. Já o **painel, o webmail e o e-mail podem ficar sob o seu sufixo**
(`painel.seu-saas.com.br` sob `seu-saas.com.br` é o arranjo comum): o nome exato deles vence o curinga e o painel
nunca emite certificado dinâmico para eles. Um sufixo **acima** do domínio de aplicações (`seu-saas.com.br` com
aplicações em `apps.seu-saas.com.br`) também vale, porque o curinga é de um nível só. Pela ordem inversa vale o
mesmo: o nome exato de um projeto sempre vence o curinga de outro. Domínios de hospedagem compartilhada ou gratuita (`github.io`,
`sslip.io`, `nip.io`, `eu.org` e os demais da seção privada da lista de sufixos públicos) são recusados, porque
o DNS deles não é seu. Terminações reservadas como `.example` e `.alt` são aceitas com um **aviso**: nenhuma
autoridade pública emite certificado para elas (servem só para testar).

A lista tem **busca**, **filtro por situação** e **páginas**, para centenas de nomes. As situações são
**Aguardando DNS / emissão**, **Emitindo**, **Válido**, **Vence em breve**, **Vencido** e **Falhou** (com a
causa em português).

## Passo 2: o DNS (CNAME ou A)

O DNS é feito **onde o domínio está** (no registrador ou na Cloudflare). Há duas formas; o IP de exemplo abaixo
(`203.0.113.10`) é fictício: use o IP da sua VPS.

### Subdomínios do seu sufixo

Crie **uma vez** um registro curinga no DNS do seu domínio:

| Tipo | Nome | Valor |
| --- | --- | --- |
| `A` | `*.seu-saas.com.br` | `203.0.113.10` |

Pronto: todo `clienteN.seu-saas.com.br` já aponta para a VPS. Se o seu domínio também usa IPv6, crie o `AAAA`
com o IPv6 da VPS.

### Domínio do cliente

O cliente (ou você, se administra o DNS dele) cria **um destes**, para `app.escola-cliente.com.br`:

| Tipo | Nome | Valor | Quando usar |
| --- | --- | --- | --- |
| `CNAME` | `app` | um nome seu que já aponta para a VPS, por exemplo `entrada.seu-saas.com.br` | Recomendado: se um dia você trocar de VPS, muda só o seu registro `entrada`. |
| `A` | `app` | `203.0.113.10` | Quando o CNAME não é possível. |

`entrada.seu-saas.com.br` é um nome comum seu com um registro `A` para a VPS (e **não** cadastrado como
dinâmico). Um domínio **raiz** do cliente (`escola-cliente.com.br`, sem `app.`) não aceita CNAME na maioria dos
provedores: peça o `A`, ou a "CNAME flattening"/"ALIAS" se o provedor tiver.

Confira antes de cadastrar, no terminal do cliente: `dig +short app.escola-cliente.com.br` deve devolver o IP
da VPS (ou o nome do CNAME e depois o IP).

## Cloudflare: nuvem cinza (somente DNS)

Se o DNS está na Cloudflare, prefira o registro em **somente DNS** (nuvem **cinza**) em vez de "Proxied"
(nuvem laranja). Com a nuvem laranja o nome resolve para IPs da Cloudflare, e não para a sua VPS: a conferência
de DNS do painel recusa a emissão, e o desafio HTTP do Let's Encrypt pode não chegar ao seu servidor ou entrar
em laço (por exemplo, com redirecionamento para HTTPS ligado na Cloudflare). Resultado comum: o nome fica
**Aguardando DNS / emissão** ou **Falhou**. O painel **não** usa a API da Cloudflare: você mexe só no DNS.

> Quer a nuvem laranja (CDN, proteção)? Com a emissão deste guia, deixe cinza. A emissão por DNS (que
> permitiria a nuvem laranja e o curinga) está planejada no [ROADMAP](https://github.com/kelvindk9w/tws-panel/blob/main/ROADMAP.md).

## Passo 3: o primeiro acesso

Abra `https://app.escola-cliente.com.br` no navegador. O primeiro acesso demora alguns segundos (o certificado
está sendo emitido). Volte à lista: o nome deve estar **Válido**. Se estiver **Falhou**, a mensagem diz o
motivo (DNS que não aponta, nuvem laranja, portas fechadas, limite do Let's Encrypt).

## Tetos que protegem você

Em **Configurações, Domínios dinâmicos**:

- **Nomes por projeto**: padrão **500** (de 10 a 5000). Acima disso o painel recusa nomes novos.
- **Emissões novas por hora**: padrão **20** (de 1 a 100), no servidor todo. Passou disso, o nome espera a hora
  seguinte (continua **Aguardando**).
- **Emissões novas por semana, por domínio**: padrão **40** (de 1 a 49). O Let's Encrypt aceita **50
  certificados por domínio registrado a cada 7 dias** (o domínio registrado de `a.b.seu-saas.com.br` é
  `seu-saas.com.br`; o painel o descobre pela lista de sufixos públicos). O teto fica abaixo dos 50 de
  propósito. Passou disso, os nomes daquele domínio esperam a semana andar.

Renovar um certificado que já existe **não** gasta a cota de emissões novas, mas um certificado que o painel
viu **vencido** volta a contar como emissão nova. Um mesmo nome tem no máximo 3 tentativas novas por hora (e
remover e cadastrar de novo não zera essa conta). Nome que não aponta para a VPS não gasta nenhuma cota. A conta
da **semana** é guardada em disco (`data/dynamic-domains.usage.json`): reiniciar ou atualizar o painel não libera
outro lote de emissões. Os demais contadores (hora e tentativas por nome) ficam na memória e zeram ao reiniciar. O teto de nomes por projeto vale mesmo com muitos
acessos simultâneos.

## A API para o app do seu cliente (token de domínios)

Para o **seu app** cadastrar e remover os domínios de cada cliente sozinho, crie um token com alcance **Só os
domínios dos projetos que eu escolher** em **Configurações, Acesso por IA** (nível **Leitura** ou **Escrita**; a
administração não existe para esse alcance). Esse token:

- só enxerga as rotas abaixo, **nos projetos que você marcou**; qualquer outra rota responde `403`, e um
  projeto fora da lista responde `404`, igual a um projeto que não existe;
- não lê o projeto, não faz deploy, não vê variáveis nem o resto do painel;
- não muda sufixos nem tetos (isso é só seu, pela tela).

Guarde o token como segredo do app (variável de ambiente). Exemplos, com `PROJETO` sendo o **id** do projeto
(o código que aparece no endereço da página do projeto no painel; o apelido não vale nessas rotas):

```bash
export TWS_PANEL_URL='https://painel.exemplo.com'
export TWS_PANEL_TOKEN='cole-o-token-aqui'

# cadastrar (201; repetir devolve 200)
curl -X POST -H "Authorization: Bearer $TWS_PANEL_TOKEN" -H 'Content-Type: application/json' \
  -d '{"host":"app.escola-cliente.com.br"}' \
  "$TWS_PANEL_URL/api/projects/PROJETO/dynamic-domains"

# listar (busca, filtro e páginas: ?q=escola&state=waiting&page=1&pageSize=25)
curl -H "Authorization: Bearer $TWS_PANEL_TOKEN" "$TWS_PANEL_URL/api/projects/PROJETO/dynamic-domains"

# consultar um nome (o estado do certificado vem no item)
curl -H "Authorization: Bearer $TWS_PANEL_TOKEN" "$TWS_PANEL_URL/api/projects/PROJETO/dynamic-domains/app.escola-cliente.com.br"

# remover
curl -X DELETE -H "Authorization: Bearer $TWS_PANEL_TOKEN" "$TWS_PANEL_URL/api/projects/PROJETO/dynamic-domains/app.escola-cliente.com.br"
```

| Rota | O que faz | Nível mínimo |
| --- | --- | --- |
| `GET /api/projects/:id/dynamic-domains` | Lista, com busca, filtro por situação e páginas | Leitura |
| `GET /api/projects/:id/dynamic-domains/:host` | Consulta um nome | Leitura |
| `POST /api/projects/:id/dynamic-domains` | Cadastra um nome (`{"host": "..."}`) | Escrita |
| `DELETE /api/projects/:id/dynamic-domains/:host` | Remove um nome | Escrita |

O token de um projeto só **não vê** o contador de emissões do servidor todo (`usage.issuancesLastHour` vem
`null`): esse número é da instalação, não do cliente dele. Quando você cadastra um nome terminado em `.example`
ou `.alt`, a resposta traz `"warning": "reserved_tld"`.

Erros úteis: `400 invalid_dynamic_host` (nome inválido, com o motivo; `shared_hosting` para `github.io`,
`sslip.io` e semelhantes), `409 domain_unavailable` (o nome já é de
outro projeto ou endereço; o painel não diz de quem), `409 dynamic_limit_reached` (teto de nomes) e `404`
(projeto fora do alcance). Tokens de alcance maior (projetos ou painel inteiro) também usam essas rotas, mas
precisam do nível **Administração** para cadastrar e remover, como nos domínios fixos.

O nome é conferido com rigor: minúsculas, sem `https://`, sem curinga, sem IP, sem `localhost` e nomes locais
(`.local`, `.internal`), sem sufixo público (`com.br`), com no máximo 253 caracteres e 63 por parte. Domínios
com acento chegam em formato `xn--` (punycode).

## Limitações

- **Sem o par `www`** automático para nomes dinâmicos: cadastre `www.escola-cliente.com.br` como outro nome.
- **Sem "Tentar emitir agora"** nem certificado próprio para esses nomes: a emissão é sempre sob demanda, no
  primeiro acesso.
- **Nuvem laranja da Cloudflare** costuma impedir a emissão (veja acima).
- **Sem verificação de posse por TXT** por enquanto: um nome só recebe certificado se o DNS dele já aponta para a
  VPS (o painel confere e o desafio do Let's Encrypt também exige), mas quem tem acesso ao painel (ou a um token
  de domínios) pode cadastrar qualquer nome que aponte para cá. Dê o token só a apps em que você confia.
- **Atrás de um proxy ou CDN** (nuvem laranja, balanceador) o DNS não aponta para a VPS e a conferência recusa.
- **Arquivo de estado ilegível**: se `dynamic-domains.json` estragar, nenhum nome novo é autorizado (o `ask`
  recusa) e o painel cria um alerta crítico. O Caddyfile **continua com a última lista boa** (guardada em
  `dynamic-domains.lastgood.json`), então os clientes que já funcionam não saem do ar. A **renovação** dos nomes
  que já tinham certificado nessa lista também continua autorizada (sem gastar cota), mas nome novo e emissão
  nova ficam negados; sem restaurar o arquivo (backup do painel), o que não estava na lista não é atendido.
- **Regra endurecida depois de cadastrar**: se uma versão nova passa a recusar um nome ou sufixo que já estava
  salvo (por exemplo `app.x.github.io`), o painel o **descarta** na leitura, avisa com um alerta e mantém o
  resto da lista. Cadastre de novo, se ainda precisar.
- **Sufixos públicos privados** (como `eu.org`) são recusados como sufixo.
- Os contadores de **hora** e de tentativas por nome zeram ao reiniciar o painel; a conta da **semana** não.
- Um nome cujo certificado venceu e não renova segue com alerta até ser **removido** da lista. Os alertas dos
  nomes de clientes vêm **agrupados por projeto** ("Domínios dos clientes de X: certificados com problema",
  com a contagem e alguns nomes), não um por nome.
- Backup: a lista de nomes entra no backup do painel; os certificados entram na cópia externa **cifrada** (o
  volume do Caddy). Na restauração em outro servidor, o DNS dos clientes precisa apontar para a nova VPS.

## Segurança

O painel só emite para nome que você cadastrou (ou do seu sufixo, se você ligou a opção), que aponta para a
VPS e está dentro dos tetos. A consulta do proxy ao painel usa uma **porta interna** que não é publicada na
internet, recusa quem não vem da rede do Docker, exige um **segredo** na URL (gerado pelo painel, guardado em
`data/`, comparado em tempo constante) e não grava nenhum nome em log. Com o sufixo aberto, só poucas consultas de
DNS de nomes ainda não cadastrados rodam ao mesmo tempo, para um estranho não ocupar as vagas dos clientes. Quando o
`ask` **nega a renovação** de um nome, o Caddy registra a URL configurada, com o segredo, no log **dele**
(`docker logs paas-caddy`, que só o root do servidor lê). Para trocar o segredo, apague `data/dynamic-ask.secret` e
reinicie o painel (ele gera outro; o Caddy passa a usá-lo na próxima vez que o painel reescrever o proxy, o que
acontece em qualquer mudança de domínio). Projeto apagado deixa de ser autorizado
na hora, mesmo que a limpeza dos nomes falhe. Veja também o [guia de IA e tokens](ai-access.md) e a
[página de segurança](../reference/security.md).
