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
| Sub-rede da rede `paas-net` | Use em "proxies confiáveis". É a recomendada. |
| IP do Caddy na rede `paas-net` | Para frameworks que só aceitam um IP. |
| Cabeçalhos com o IP do visitante | `X-Forwarded-For` (o IP do visitante), `X-Forwarded-Proto` e `X-Forwarded-Host`. O Caddy não envia `X-Real-IP`. |
| Nome do app visto pelo Caddy | Host e porta que o Caddy usa para chegar no app. |

O Caddy substitui qualquer `X-Forwarded-For` que o visitante tentar enviar pelo IP que ele mesmo viu, então o
valor que chega ao app não pode ser forjado por quem acessa.

## Use a sub-rede, não o IP

O IP do Caddy **não é fixo**. A rede `paas-net` é criada com uma sub-rede escolhida pelo Docker e o Caddy
recebe o próximo endereço livre dela; se o Caddy for recriado (por exemplo, numa atualização do painel), o
endereço pode mudar. A **sub-rede** vale enquanto a rede existir. Por isso a recomendação é confiar na
sub-rede inteira: só containers da `paas-net` (o Caddy e os seus próprios projetos) estão nela, e o painel e o
servidor de e-mail ficam em redes separadas.

## Variáveis fornecidas pelo painel

A cada deploy o painel entrega ao app:

- `PAAS_PROXY_SUBNET`: a sub-rede da `paas-net`, em CIDR (exemplo: `172.20.0.0/16`).
- `PAAS_PROXY_IP`: o IP do Caddy na `paas-net` naquele momento (exemplo: `172.20.0.2`).

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
        TRUSTED_PROXIES: ${PAAS_PROXY_SUBNET}
  ```

## Exemplos

Troque o nome da variável do app pelo que o seu código usar. Os exemplos usam `PAAS_PROXY_SUBNET`.

### Laravel

No Laravel 11 ou superior, em `bootstrap/app.php`:

```php
->withMiddleware(function (Middleware $middleware) {
    $middleware->trustProxies(
        at: explode(',', env('PAAS_PROXY_SUBNET', '')),
        headers: Request::HEADER_X_FORWARDED_FOR
            | Request::HEADER_X_FORWARDED_HOST
            | Request::HEADER_X_FORWARDED_PORT
            | Request::HEADER_X_FORWARDED_PROTO,
    );
})
```

Em versões anteriores, em `app/Http/Middleware/TrustProxies.php`: `protected $proxies = ...` lendo a mesma variável
(`env('PAAS_PROXY_SUBNET')`). Depois disso `request()->ip()` devolve o IP do visitante. Se o seu app usa
`php artisan config:cache`, leia a variável em um arquivo de `config/` em vez de chamar `env()` direto.

### Next.js

O Next.js não tem lista de proxies confiáveis: ele lê `X-Forwarded-For` como vier. Como o Caddy sempre
sobrescreve esse cabeçalho, o primeiro valor é o IP do visitante:

```ts
import { headers } from "next/headers";

export async function visitorIp() {
  const forwarded = (await headers()).get("x-forwarded-for") ?? "";
  return forwarded.split(",")[0]?.trim() || null;
}
```

Isso só é seguro enquanto o app for alcançável **apenas** pelo Caddy, que é o caso de um projeto implantado
pelo painel. Não use esse padrão se você também publicar a porta do app diretamente.

### nginx dentro do projeto

O nginx não lê variáveis de ambiente na configuração. A imagem oficial `nginx` resolve isso: arquivos em
`/etc/nginx/templates/*.template` passam por substituição de `${VARIAVEL}` na subida. Em
`default.conf.template`:

```nginx
set_real_ip_from ${PAAS_PROXY_SUBNET};
real_ip_header X-Forwarded-For;
real_ip_recursive on;

server {
  listen 80;
  # ... o resto da sua configuração; $remote_addr agora é o IP do visitante
}
```

No compose, passe `PAAS_PROXY_SUBNET: ${PAAS_PROXY_SUBNET}` no `environment` do serviço nginx.

## Se o valor aparecer como indisponível

O cartão mostra "indisponível agora" quando o Caddy ainda não entrou na rede (antes do primeiro deploy do
painel com o Caddy) ou quando o Docker não respondeu. Faça um deploy de qualquer projeto ou recarregue a
página em alguns instantes. Se ficar assim, veja a página [Solução de problemas](troubleshooting.md).

> [!NOTE]
> Se o seu domínio passa por outro proxy antes do painel (como o modo "proxied" da Cloudflare), o Caddy
> enxerga o IP desse proxy, e é esse IP que chega ao app em `X-Forwarded-For`. O painel não muda isso por conta própria.
