---
title: "IP real do visitante e proxies confiáveis"
description: "Como o app lê o IP de quem acessa quando está atrás do Caddy do painel: o cartão Rede e proxy, as variáveis PAAS_PROXY_IP e PAAS_PROXY_SUBNET e exemplos para Laravel, Next.js e nginx."
sidebar:
  label: "IP real do visitante"
---

Todo tráfego da internet chega ao seu app pelo **Caddy do painel**. Para o app, quem conectou foi o Caddy
(um IP interno como `172.x.x.x`), não o visitante. O IP do visitante vem num cabeçalho, e um framework só
aceita esse cabeçalho de um proxy em quem ele confia (os "proxies confiáveis"). Sem essa configuração, logs,
limites de tentativas e geolocalização enxergam todos os visitantes como o mesmo IP.

## Onde achar os valores no painel

Abra o projeto, seção **Variáveis**: logo abaixo da lista há o cartão **Rede e proxy**. Cada valor tem um
botão **Copiar** e uma frase de para que serve:

| Valor | Para que serve |
| --- | --- |
| IP do Caddy na rede `paas-net` | **Recomendado** em "proxies confiáveis": só o Caddy é aceito. |
| Sub-rede da rede `paas-net` | Alternativa mais simples, com o risco descrito abaixo. |
| Cabeçalhos com dados do visitante | `X-Forwarded-For` (o IP do visitante), `X-Forwarded-Proto` e `X-Forwarded-Host`. O Caddy não envia `X-Real-IP`. |
| Nome do app visto pelo Caddy | Host e porta que o Caddy usa para chegar no app. |

## Em quem confiar: o IP do Caddy

Todos os projetos ficam na mesma rede (`paas-net`) e se alcançam livremente pelo nome do container. Isso importa:
um cabeçalho `X-Forwarded-For` só é confiável se vier do Caddy. Se um projeto vizinho for comprometido, ele pode
chamar o seu app direto (`vizinho:porta`) com um `X-Forwarded-For` inventado, e um app que confia em toda a rede
vai acreditar nele. Por isso a recomendação principal é **confiar só no IP do Caddy**, em `PAAS_PROXY_IP`.

O limite dessa escolha: o IP do Caddy **não é fixo**. A rede `paas-net` é criada com uma sub-rede escolhida
pelo Docker e o Caddy recebe o próximo endereço livre dela. Se o Caddy for recriado (por exemplo, numa
atualização do painel), o IP pode mudar, e o seu app só enxerga o valor novo no **próximo deploy do projeto**.
Até lá o app deixa de confiar no Caddy e passa a ver o IP interno dele no lugar do visitante. Refazer o deploy
resolve.

**Alternativa mais simples: a sub-rede inteira** (`PAAS_PROXY_SUBNET`). Ela não muda quando o Caddy é recriado,
mas confia em todos os containers da `paas-net`, inclusive os outros projetos. Use só se você aceita o risco do
vizinho comprometido descrito acima (por exemplo, quando você é dono de todos os projetos e confia neles).

## Variáveis fornecidas pelo painel

A cada deploy o painel entrega ao app:

- `PAAS_PROXY_IP`: o IP do Caddy na `paas-net` naquele momento (exemplo: `172.20.0.2`).
- `PAAS_PROXY_SUBNET`: a sub-rede da `paas-net`, em CIDR (exemplo: `172.20.0.0/16`).

Regras:

- Os valores refletem o estado de **agora**; ao fazer um novo deploy eles são atualizados. Se o Docker não
  responder, a variável simplesmente não é entregue (nunca vai vazia).
- Se você salvar na seção Variáveis uma variável com o mesmo nome, **a sua vence**.
- Site estático não recebe variáveis de execução.
- Em projeto **compose**, o painel grava as variáveis no `.env` do projeto; o compose decide o destino. Repasse
  ao serviço:

  ```yaml
  services:
    web:
      environment:
        TRUSTED_PROXIES: ${PAAS_PROXY_IP}
  ```

  Quando o compose ou o `.env.example` citam `PAAS_PROXY_IP` ou `PAAS_PROXY_SUBNET`, a seção Variáveis mostra a
  linha como "fornecida pelo painel". Se o painel não conseguir ler a rede na hora do deploy, ele recusa o deploy
  de um compose que exige a variável, avisando o motivo.

## Exemplos

Troque o nome da variável do app pelo que o seu código usar. Os exemplos usam `PAAS_PROXY_IP`; para a
alternativa da sub-rede, use `PAAS_PROXY_SUBNET`.

### Laravel

No Laravel 11 ou superior, em `bootstrap/app.php`:

```php
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;

->withMiddleware(function (Middleware $middleware) {
    $middleware->trustProxies(
        at: env('PAAS_PROXY_IP'),
        headers: Request::HEADER_X_FORWARDED_FOR
            | Request::HEADER_X_FORWARDED_HOST
            | Request::HEADER_X_FORWARDED_PORT
            | Request::HEADER_X_FORWARDED_PROTO,
    );
})
```

Os `use` ficam no topo do arquivo, junto dos que já existem. Depois disso `request()->ip()` devolve o IP do
visitante.

Em versões anteriores, em `app/Http/Middleware/TrustProxies.php`, a propriedade `$proxies` não aceita `env()`
(o PHP só aceita valores constantes ali). Sobrescreva o método `proxies()`:

```php
protected function proxies()
{
    return env('PAAS_PROXY_IP');
}
```

### Next.js

O Next.js não tem lista de proxies confiáveis: ele entrega `X-Forwarded-For` como vier, e o Caddy não é a única
coisa que alcança o app. Um vizinho comprometido na `paas-net` pode mandar um cabeçalho falso direto. Então só
confie no cabeçalho se a conexão veio do Caddy.

O App Router não expõe o endereço de quem conectou. O jeito que funciona é um servidor Node próprio
(`server.js`, no `Dockerfile` do projeto) que confere o endereço da conexão contra `PAAS_PROXY_IP` e apaga o
cabeçalho se for outro:

```js
const http = require("node:http");
const next = require("next");

const app = next({ dev: false });
const handle = app.getRequestHandler();
const trusted = process.env.PAAS_PROXY_IP;

app.prepare().then(() => {
  http
    .createServer((req, res) => {
      const peer = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
      if (!trusted || peer !== trusted) delete req.headers["x-forwarded-for"];
      return handle(req, res);
    })
    .listen(Number(process.env.PORT) || 3000, "0.0.0.0");
});
```

Nas rotas, leia o primeiro valor de `x-forwarded-for` (`(await headers()).get("x-forwarded-for")?.split(",")[0]`);
se ele estiver ausente, a requisição não veio do Caddy. Sem esse servidor próprio, trate o cabeçalho como dado
não confiável (serve para log, não para decisões de segurança).

### nginx dentro do projeto

O nginx não lê variáveis de ambiente na configuração. A imagem oficial `nginx` resolve isso: arquivos em
`/etc/nginx/templates/*.template` passam por substituição de `${VARIAVEL}` na subida. Em
`default.conf.template`:

```nginx
set_real_ip_from ${PAAS_PROXY_IP};
real_ip_header X-Forwarded-For;

server {
  listen 80;
  # ... o resto da sua configuração; $remote_addr agora é o IP do visitante
}
```

Com um único IP confiável, não use `real_ip_recursive on`. No compose, passe `PAAS_PROXY_IP: ${PAAS_PROXY_IP}`
no `environment` do serviço nginx.

## Se o valor aparecer como indisponível

O cartão mostra "indisponível agora" quando o Caddy ainda não entrou na rede (antes do primeiro deploy do
painel com o Caddy) ou quando o Docker não respondeu. Faça um deploy de qualquer projeto ou recarregue a
página em alguns instantes. Se ficar assim, veja a página [Solução de problemas](troubleshooting.md).

> [!NOTE]
> Se o seu domínio passa por outro proxy antes do painel (como o modo "proxied" da Cloudflare), o Caddy
> enxerga o IP desse proxy, e é esse IP que chega ao app em `X-Forwarded-For`. O painel não muda isso por conta própria.
