---
title: "Real visitor IP and trusted proxies"
description: "How an app reads the visitor's IP when it runs behind the panel's Caddy: the Network and proxy card, the PAAS_PROXY_IP and PAAS_PROXY_SUBNET variables, and examples for Laravel, Next.js and nginx."
sidebar:
  label: "Real visitor IP"
---

> [!NOTE]
> **Interface language.** The panel is available in English and Portuguese ([how to choose](../getting-started/complete-guide.md#idioma-da-interface)). This page quotes the English labels exactly as they appear on screen.

All internet traffic reaches your app through the **panel's Caddy**. To the app, the one that connected is
Caddy (an internal IP such as `172.x.x.x`), not the visitor. The visitor's IP travels in a header, and a
framework only accepts that header from a proxy it trusts ("trusted proxies"). Without this setting, logs,
rate limits and geolocation see every visitor as the same IP.

## Where to find the values in the panel

Open the project, **Variables** section: right below the list there is the **Network and proxy** card. Each
value has a **Copy** button and a short line saying what it is for:

| Value | What it is for |
| --- | --- |
| Subnet of the `paas-net` network | Use it in "trusted proxies". This is the recommended one. |
| Caddy IP on the `paas-net` network | For frameworks that only accept a single IP. |
| Headers carrying the visitor's IP | `X-Forwarded-For` (the visitor's IP), `X-Forwarded-Proto` and `X-Forwarded-Host`. Caddy does not send `X-Real-IP`. |
| App name as Caddy sees it | Host and port Caddy uses to reach the app. |

Caddy replaces any `X-Forwarded-For` a visitor tries to send with the IP it actually saw, so the value that
reaches the app cannot be forged by the visitor.

## Use the subnet, not the IP

Caddy's IP is **not fixed**. The `paas-net` network is created with a subnet chosen by Docker, and Caddy gets
the next free address in it; if Caddy is recreated (for example, in a panel update) the address can change.
The **subnet** lasts as long as the network exists. So the recommendation is to trust the whole subnet: only
containers on `paas-net` (Caddy and your own projects) are in it, while the panel and the mail server sit on
separate networks.

## Variables provided by the panel

On every deploy the panel gives the app:

- `PAAS_PROXY_SUBNET`: the `paas-net` subnet, in CIDR (example: `172.20.0.0/16`).
- `PAAS_PROXY_IP`: Caddy's IP on `paas-net` at that moment (example: `172.20.0.2`).

Rules:

- The values reflect the state **right now**; a new deploy refreshes them. If Docker does not answer, the
  variable is simply not delivered (it is never empty).
- If you save a variable with the same name in the Variables section, **yours wins**.
- A static site does not receive runtime variables.
- In a **compose** project the panel writes the variables to the project's `.env`; compose decides where they
  go. Pass them to the service:

  ```yaml
  services:
    web:
      environment:
        TRUSTED_PROXIES: ${PAAS_PROXY_SUBNET}
  ```

## Examples

Rename the app-side variable to whatever your code uses. The examples use `PAAS_PROXY_SUBNET`.

### Laravel

On Laravel 11 or later, in `bootstrap/app.php`:

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

On older versions, in `app/Http/Middleware/TrustProxies.php`, set `protected $proxies` from the same variable
(`env('PAAS_PROXY_SUBNET')`). After that `request()->ip()` returns the visitor's IP. If your app uses
`php artisan config:cache`, read the variable in a `config/` file instead of calling `env()` directly.

### Next.js

Next.js has no trusted-proxy list: it reads `X-Forwarded-For` as it comes. Since Caddy always overwrites that
header, the first value is the visitor's IP:

```ts
import { headers } from "next/headers";

export async function visitorIp() {
  const forwarded = (await headers()).get("x-forwarded-for") ?? "";
  return forwarded.split(",")[0]?.trim() || null;
}
```

This is only safe while the app is reachable **only** through Caddy, which is the case for a project deployed
by the panel. Do not use this pattern if you also publish the app's port directly.

### nginx inside the project

nginx does not read environment variables in its configuration. The official `nginx` image works around that:
files in `/etc/nginx/templates/*.template` get `${VARIABLE}` substitution at startup. In
`default.conf.template`:

```nginx
set_real_ip_from ${PAAS_PROXY_SUBNET};
real_ip_header X-Forwarded-For;
real_ip_recursive on;

server {
  listen 80;
  # ... the rest of your configuration; $remote_addr is now the visitor's IP
}
```

In compose, pass `PAAS_PROXY_SUBNET: ${PAAS_PROXY_SUBNET}` in the nginx service's `environment`.

## If the value shows as unavailable

The card shows "unavailable right now" when Caddy has not joined the network yet or Docker did not answer.
Deploy any project, or reload the page in a few moments. If it stays that way, see
[Troubleshooting](troubleshooting.md).

> [!NOTE]
> If your domain goes through another proxy before the panel (such as Cloudflare's "proxied" mode), Caddy sees
> that proxy's IP, and that is the IP that reaches the app in `X-Forwarded-For`. The panel does not change this
> by itself.
