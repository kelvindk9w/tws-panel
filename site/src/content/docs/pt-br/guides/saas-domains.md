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
   responde "sim" para nomes cadastrados (ou do seu sufixo, veja abaixo) e dentro dos tetos.
4. O Caddy pede o certificado ao Let's Encrypt (desafio HTTP) e o nome passa a abrir com HTTPS válido. As
   renovações são automáticas.

Antes do passo 4 o nome fica em **Aguardando DNS / emissão**. Isso é normal: o certificado só sai depois que o
DNS do nome já aponta para a VPS e alguém abre o endereço.

O painel **não** emite certificado para nome que ninguém cadastrou: um nome inventado, apontado para a sua VPS
por terceiros, é recusado antes de qualquer pedido ao Let's Encrypt.

## O que precisa estar pronto

- O painel precisa estar **servido por HTTPS no seu domínio** (Configurações, Domínio do painel) e rodando no
  container padrão. Sem isso o proxy não alcança o painel e a tela do projeto mostra um aviso explicando.
- As portas **80 e 443** abertas na VPS (o desafio HTTP usa a 80).
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
cadastra o nome sozinho quando alguém o acessa. Ela é cômoda, mas qualquer pessoa que descubra o endereço
consegue **gastar a sua cota de emissões** acessando nomes inventados. Ligue só se você aceita isso.

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

Se o DNS está na Cloudflare, deixe o registro em **somente DNS** (nuvem **cinza**), não em "Proxied" (nuvem
laranja). Com a nuvem laranja, quem responde é a Cloudflare, o desafio HTTP do Let's Encrypt não chega ao seu
servidor e o nome fica **Aguardando DNS / emissão** para sempre. O painel **não** usa a API da Cloudflare:
você mexe só no DNS.

> Quer a nuvem laranja (CDN, proteção)? Por enquanto não é possível com a emissão deste guia. A emissão por
> DNS (que permite a nuvem laranja e o curinga) está no [ROADMAP](https://github.com/kelvindk9w/tws-panel/blob/main/ROADMAP.md).

## Passo 3: o primeiro acesso

Abra `https://app.escola-cliente.com.br` no navegador. O primeiro acesso demora alguns segundos (o certificado
está sendo emitido). Volte à lista: o nome deve estar **Válido**. Se estiver **Falhou**, a mensagem diz o
motivo (DNS que não aponta, nuvem laranja, portas fechadas, limite do Let's Encrypt).

## Tetos que protegem você

Em **Configurações, Domínios dinâmicos**:

- **Nomes por projeto**: padrão **500** (de 10 a 5000). Acima disso o painel recusa nomes novos.
- **Emissões novas por hora**: padrão **20** (de 1 a 100), no servidor todo. Protege do limite de certificados
  do Let's Encrypt. Passou disso, o nome espera a hora seguinte (continua **Aguardando**).

Renovar um certificado que já existe **não** gasta a cota de emissões novas. Um mesmo nome tem no máximo 3
tentativas novas por hora. Os contadores ficam na memória: reiniciar o painel os zera.

## A API para o app do seu cliente (token de domínios)

Para o **seu app** cadastrar e remover os domínios de cada cliente sozinho, crie um token com alcance **Só os
domínios dos projetos que eu escolher** em **Configurações, Acesso por IA** (nível **Leitura** ou **Escrita**; a
administração não existe para esse alcance). Esse token:

- só enxerga as rotas abaixo, **nos projetos que você marcou**; qualquer outra rota responde `403`, e um
  projeto fora da lista responde `404`, igual a um projeto que não existe;
- não lê o projeto, não faz deploy, não vê variáveis nem o resto do painel;
- não muda sufixos nem tetos (isso é só seu, pela tela).

Guarde o token como segredo do app (variável de ambiente). Exemplos, com `PROJETO` sendo o id ou apelido do
projeto:

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

Erros úteis: `400 invalid_dynamic_host` (nome inválido, com o motivo), `409 domain_unavailable` (o nome já é de
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
- **Nuvem laranja da Cloudflare** impede a emissão (veja acima).
- **Sem verificação de posse por TXT** por enquanto: um nome só recebe certificado se o DNS dele já aponta para a
  VPS, o que o próprio desafio do Let's Encrypt exige; mas quem tem acesso ao painel (ou a um token de
  domínios) pode cadastrar qualquer nome. Dê o token só a apps em que você confia.
- **Sufixos públicos privados** (como `eu.org`) são recusados como sufixo.
- Os contadores de cota **zeram ao reiniciar** o painel.
- Um nome cujo certificado venceu e não renova segue com alerta até ser **removido** da lista.
- Backup: a lista de nomes entra no backup do painel; os certificados entram na cópia externa **cifrada** (o
  volume do Caddy). Na restauração em outro servidor, o DNS dos clientes precisa apontar para a nova VPS.

## Segurança

O painel só emite para nome que você cadastrou (ou do seu sufixo, se você ligou a opção), dentro dos tetos. A
consulta do proxy ao painel usa uma **porta interna** que não é publicada na internet e recusa quem não vem da
rede do Docker, e não grava nenhum nome em log. Veja também o [guia de IA e tokens](ai-access.md) e a
[página de segurança](../reference/security.md).
