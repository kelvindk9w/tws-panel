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
| Caddy IP on the `paas-net` network | **Recommended** for "trusted proxies": only Caddy is accepted. |
| Subnet of the `paas-net` network | Simpler alternative, with the risk described below. |
| Headers carrying visitor data | `X-Forwarded-For` (the visitor's IP), `X-Forwarded-Proto` and `X-Forwarded-Host`. Caddy does not send `X-Real-IP`. |
| App name as Caddy sees it | Host and port Caddy uses to reach the app. |

## Whom to trust: Caddy's IP

All projects sit on the same network (`paas-net`) and reach each other freely by container name. That matters:
an `X-Forwarded-For` header is only trustworthy if it comes from Caddy. If a neighbouring project is
compromised, it can call your app directly (`neighbour:port`) with an invented `X-Forwarded-For`, and an app
that trusts the whole network will believe it. So the main recommendation is to **trust only Caddy's IP**, in
`PAAS_PROXY_IP`.

The limit of this choice: Caddy's IP is **not fixed**. The `paas-net` network is created with a subnet chosen by
Docker and Caddy gets the next free address in it. If Caddy is recreated (for example, in a panel update) the IP
can change, and your app only sees the new value on the **project's next deploy**. Until then the app stops
trusting Caddy and sees Caddy's internal IP in place of the visitor's. Redeploying fixes it.

**Simpler alternative: the whole subnet** (`PAAS_PROXY_SUBNET`). It does not change when Caddy is recreated,
but it trusts every container on `paas-net`, other projects included. Use it only if you accept the
compromised-neighbour risk described above (for example, when you own all the projects and trust them).

## Variables provided by the panel

On every deploy the panel gives the app:

- `PAAS_PROXY_IP`: Caddy's IP on `paas-net` at that moment (example: `172.20.0.2`).
- `PAAS_PROXY_SUBNET`: the `paas-net` subnet, in CIDR (example: `172.20.0.0/16`).

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
        TRUSTED_PROXIES: ${PAAS_PROXY_IP}
  ```

  When the compose file or `.env.example` mention `PAAS_PROXY_IP` or `PAAS_PROXY_SUBNET`, the Variables section
  shows the line as "provided by the panel". If the panel cannot read the network at deploy time, it refuses the
  deploy of a compose file that requires the variable and says why.

## Examples

Rename the app-side variable to whatever your code uses. The examples use `PAAS_PROXY_IP`; for the subnet
alternative, use `PAAS_PROXY_SUBNET` instead.

### Laravel

On Laravel 11 or later, in `bootstrap/app.php`:

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

The `use` lines go at the top of the file, with the ones already there. After that `request()->ip()` returns the
visitor's IP.

On older versions, in `app/Http/Middleware/TrustProxies.php`, the `$proxies` property cannot call `env()` (PHP
only accepts constant values there). Override the `proxies()` method:

```php
protected function proxies()
{
    return env('PAAS_PROXY_IP');
}
```

### Next.js

Next.js has no trusted-proxy list: it hands you `X-Forwarded-For` as it comes, and Caddy is not the only thing
that can reach the app. A compromised neighbour on `paas-net` can send fake headers directly. So only trust the
headers if the connection came from Caddy.

The App Router does not expose who connected. What works is your own Node server (`server.js`, run by the
project's `Dockerfile`) that checks the connection address against `PAAS_PROXY_IP`. If the connection comes from
anywhere else, it writes the **real connection address** into `X-Forwarded-For` (instead of deleting the header,
because Next fills it in by itself when it is missing) and removes `X-Forwarded-Host` and `X-Forwarded-Proto`,
which Next uses to build URLs and in the Server Actions origin check:

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
      if (!trusted || peer !== trusted) {
        // did not come from Caddy: the visitor headers are not valid
        req.headers["x-forwarded-for"] = peer;
        delete req.headers["x-forwarded-host"];
        delete req.headers["x-forwarded-proto"];
      }
      return handle(req, res);
    })
    .listen(Number(process.env.PORT) || 3000, "0.0.0.0");
});
```

Without `PAAS_PROXY_IP` (variable not delivered), no connection is treated as coming from Caddy.

> [!WARNING]
> With `output: 'standalone'`, `next build` generates its own `server.js`, which does not go with a custom
> server. Use the regular `next build` (no `standalone`) and run `node server.js` in the `Dockerfile`
> (`CMD ["node", "server.js"]`).

In your routes, read the first value of `x-forwarded-for`
(`(await headers()).get("x-forwarded-for")?.split(",")[0]`): with the server above it is the visitor's IP when
the connection came from Caddy and the address of whoever connected otherwise. Without such a server, treat the
header as untrusted data (fine for logs, not for security decisions).

### nginx inside the project

nginx does not read environment variables in its configuration. The official `nginx` image works around that:
files in `/etc/nginx/templates/*.template` get `${VARIABLE}` substitution at startup. In
`default.conf.template`:

```nginx
set_real_ip_from ${PAAS_PROXY_IP};
real_ip_header X-Forwarded-For;

server {
  listen 80;
  # ... the rest of your configuration; $remote_addr is now the visitor's IP
}
```

With a single trusted IP, do not use `real_ip_recursive on`. In compose, pass `PAAS_PROXY_IP: ${PAAS_PROXY_IP}`
in the nginx service's `environment`.

## If the value shows as unavailable

The card shows "unavailable right now" when Caddy has not joined the network yet or Docker did not answer.
Deploy any project, or reload the page in a few moments. If it stays that way, see
[Troubleshooting](troubleshooting.md).

> [!NOTE]
> If your domain goes through another proxy before the panel (such as Cloudflare's "proxied" mode), Caddy sees
> that proxy's IP, and that is the IP that reaches the app in `X-Forwarded-For`. The panel does not change this
> by itself.
