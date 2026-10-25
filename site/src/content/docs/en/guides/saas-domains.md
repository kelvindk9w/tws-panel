---
title: "Your customers' domains (SaaS)"
description: "How to serve each SaaS customer's subdomain and own domain in the same project, with the HTTPS certificate issued by itself on first access: registration, step-by-step DNS (CNAME and A), Cloudflare without proxy, ceilings, the domains-token API and limitations."
sidebar:
  label: "Customer domains (SaaS)"
---

If your app serves several customers, each one usually wants an address of their own:
`customer1.your-saas.example` (a subdomain of **yours**) or `app.customer-school.example` (the **customer's**
domain, pointed at your VPS). This page shows how the panel serves those names **in the same project**,
without you editing the project for every new customer, with each name's HTTPS certificate issued by itself on
first access.

> For the project's fixed addresses (the main one and the extra ones), see the project's **Domains** section
> and the [step-by-step guide](../getting-started/complete-guide.md). This guide is only for **your customers'**
> names.

---

## How it works

1. You **register the name** in the project (from the screen, or your app through the API).
2. The customer points the name's **DNS** at your VPS.
3. On the **first HTTPS access** to the name, the proxy (Caddy) asks the panel whether that name is allowed. It
   only answers "yes" for registered names (or names under your suffix, see below), within the ceilings and
   **whose DNS already points at this VPS** (the panel checks before spending an issuance).
4. Caddy asks Let's Encrypt for the certificate (HTTP challenge) and the name opens with valid HTTPS. Renewals
   are automatic.

Before step 4 the name shows **Waiting for DNS / issuance**. That is normal: the certificate only comes out
after the name's DNS already points at the VPS and someone opens the address.

The panel does **not** issue a certificate for a name nobody registered: a made-up name pointed at your VPS by a
third party is refused before any request to Let's Encrypt. And a registered name whose DNS does **not** point at
the VPS yet is also refused **without spending** your issuances: someone who just repeats the address of a
customer who has not set up DNS does not burn everyone else's quota.

## What must be ready

- The panel must be **served over HTTPS on your domain** (Settings, Panel domain) and run in the standard
  container. Without that, the proxy cannot reach the panel and the project screen shows a warning explaining
  why.
- Ports **80 and 443** open on the VPS (the HTTP challenge uses 80).
- The panel must **know the VPS public IP**: the `PAAS_PUBLIC_IP` variable (and `PAAS_PUBLIC_IPV6` if there is
  IPv6), or the IP in the panel's `1-2-3-4.sslip.io` address. The panel uses it to check that the name's DNS
  points here (see the [production guide](production.md)). **With no known IP no new certificate is authorized**
  (fail safe); the name stays **Waiting for DNS / issuance**. Set it and restart the panel.
- Your app answers by the **host** it receives, finding the customer by the name (`Host`). All dynamic names
  land on the **same** project, on its port.

## Step 1: register the names

In the project, open **Domains** and scroll to **Your customers' domains**.

- **Standalone name** (customer domain): type `app.customer-school.example` and click **Register**. No
  `https://`, no wildcard. The same name cannot be in two projects or be an address the panel already serves
  (the main one, the panel's, the mail one).
- **Your own subdomains** (a suffix): under **Your own subdomains (suffix)** add `your-saas.example`. Any
  **one-level** name under it (`customer1.your-saas.example`) becomes valid, with **one certificate per name**.
  `a.b.your-saas.example` (two levels) is not valid.

By default a suffix only accepts **registered** names. The **Accept any subdomain on first access** option
registers the name by itself when someone visits it (and its DNS points at the VPS). It is convenient but has a
real cost: Let's Encrypt allows **50 certificates per registered domain every 7 days**, and all subdomains of
`your-saas.example` count together. Anyone who finds the address can point made-up names at the VPS and **use up
those 50, blocking new certificates for your domain for a week**, including real customers'. The panel holds this
with a weekly ceiling per domain (default **40**, see Ceilings), but the ceiling only limits the damage: with the
option on, a stranger can still take the 40 slots of the week. Turn it on only if you accept that; otherwise
register the names from the screen or the API.

A suffix **cannot** cover a name another project already has (nor another project's fixed site, the panel's or
the mail one), nor be confused with the apps domain. The reverse order holds too: a project's exact name always
beats another project's wildcard. Shared or free hosting domains (`github.io`, `sslip.io`, `nip.io`, `eu.org` and
the rest of the private section of the public suffix list) are refused, because their DNS is not yours. Reserved
endings such as `.example` and `.alt` are accepted with a **warning**: no public authority issues certificates
for them (they are for testing only).

The list has **search**, a **status filter** and **pages**, for hundreds of names. The statuses are **Waiting
for DNS / issuance**, **Issuing**, **Valid**, **Expiring soon**, **Expired** and **Failed** (with the cause in
plain words).

## Step 2: DNS (CNAME or A)

DNS is done **where the domain lives** (the registrar or Cloudflare). There are two ways; the example IP below
(`203.0.113.10`) is fictional: use your VPS IP.

### Subdomains of your suffix

Create **once** a wildcard record in your domain's DNS:

| Type | Name | Value |
| --- | --- | --- |
| `A` | `*.your-saas.example` | `203.0.113.10` |

Done: every `customerN.your-saas.example` already points at the VPS. If your domain also uses IPv6, create the
`AAAA` with the VPS IPv6.

### Customer's domain

The customer (or you, if you manage their DNS) creates **one of these**, for `app.customer-school.example`:

| Type | Name | Value | When to use |
| --- | --- | --- | --- |
| `CNAME` | `app` | a name of yours that already points at the VPS, for example `entry.your-saas.example` | Recommended: if you ever change VPS, only your `entry` record changes. |
| `A` | `app` | `203.0.113.10` | When a CNAME is not possible. |

`entry.your-saas.example` is an ordinary name of yours with an `A` record to the VPS (and **not** registered
as dynamic). A customer's **apex** domain (`customer-school.example`, without `app.`) does not accept a CNAME at
most providers: ask for the `A`, or "CNAME flattening"/"ALIAS" if the provider has it.

Check before registering, from the customer's terminal: `dig +short app.customer-school.example` should return
the VPS IP (or the CNAME target and then the IP).

## Cloudflare: grey cloud (DNS only)

If DNS is on Cloudflare, prefer the record **DNS only** (**grey** cloud) over "Proxied" (orange cloud). With
the orange cloud the name resolves to Cloudflare IPs, not your VPS: the panel's DNS check refuses issuance, and
Let's Encrypt's HTTP challenge may not reach your server or may loop (for example with HTTPS redirection on at
Cloudflare). Common result: the name stays **Waiting for DNS / issuance** or shows **Failed**. The panel does
**not** use the Cloudflare API: you only touch DNS.

> Want the orange cloud (CDN, protection)? With this guide's issuance, keep it grey. DNS-based issuance (which
> would allow the orange cloud and the wildcard) is planned on the
> [ROADMAP](https://github.com/kelvindk9w/tws-panel/blob/main/ROADMAP.md).

## Step 3: the first access

Open `https://app.customer-school.example` in the browser. The first access takes a few seconds (the certificate
is being issued). Go back to the list: the name should be **Valid**. If it is **Failed**, the message says why
(DNS not pointing, orange cloud, closed ports, Let's Encrypt limit).

## Ceilings that protect you

In **Settings, Dynamic domains**:

- **Names per project**: default **500** (from 10 to 5000). Above it the panel refuses new names.
- **New issuances per hour**: default **20** (from 1 to 100), server-wide. Past it, the name waits for the next
  hour (it stays **Waiting**).
- **New issuances per week, per domain**: default **40** (from 1 to 49). Let's Encrypt allows **50 certificates
  per registered domain every 7 days** (the registered domain of `a.b.your-saas.example` is
  `your-saas.example`; the panel finds it with the public suffix list). The ceiling is below 50 on purpose. Past
  it, that domain's names wait for the week to move on.

Renewing a certificate that already exists does **not** spend the new-issuance quota, but a certificate the
panel saw **expired** counts as a new issuance again. One name gets at most 3 new attempts per hour (and removing
and registering it again does not reset that count). A name that does not point at the VPS spends no quota. The
counters live in memory: restarting the panel resets them. The names ceiling per project holds even under many
simultaneous visits.

## The API for your customer's app (domains token)

For **your app** to register and remove each customer's domains by itself, create a token with the reach
**Only the domains of the projects I choose** in **Settings, AI access** (**Read** or **Write** level; admin does
not exist for this reach). That token:

- only sees the routes below, **on the projects you ticked**; any other route answers `403`, and a project
  outside the list answers `404`, identical to a project that does not exist;
- does not read the project, deploy, see variables or the rest of the panel;
- does not change suffixes or ceilings (that is yours only, from the screen).

Keep the token as the app's secret (environment variable). Examples, with `PROJECT` being the project **id**
(the code in the project page address in the panel; the nickname does not work on these routes):

```bash
export TWS_PANEL_URL='https://panel.example.com'
export TWS_PANEL_TOKEN='paste-the-token-here'

# register (201; repeating returns 200)
curl -X POST -H "Authorization: Bearer $TWS_PANEL_TOKEN" -H 'Content-Type: application/json' \
  -d '{"host":"app.customer-school.example"}' \
  "$TWS_PANEL_URL/api/projects/PROJECT/dynamic-domains"

# list (search, filter and pages: ?q=school&state=waiting&page=1&pageSize=25)
curl -H "Authorization: Bearer $TWS_PANEL_TOKEN" "$TWS_PANEL_URL/api/projects/PROJECT/dynamic-domains"

# look up one name (the certificate status comes in the item)
curl -H "Authorization: Bearer $TWS_PANEL_TOKEN" "$TWS_PANEL_URL/api/projects/PROJECT/dynamic-domains/app.customer-school.example"

# remove
curl -X DELETE -H "Authorization: Bearer $TWS_PANEL_TOKEN" "$TWS_PANEL_URL/api/projects/PROJECT/dynamic-domains/app.customer-school.example"
```

| Route | What it does | Minimum level |
| --- | --- | --- |
| `GET /api/projects/:id/dynamic-domains` | Lists, with search, status filter and pages | Read |
| `GET /api/projects/:id/dynamic-domains/:host` | Looks up one name | Read |
| `POST /api/projects/:id/dynamic-domains` | Registers a name (`{"host": "..."}`) | Write |
| `DELETE /api/projects/:id/dynamic-domains/:host` | Removes a name | Write |

A single-project token does **not** see the server-wide issuance counter (`usage.issuancesLastHour` comes as
`null`): that number belongs to the installation, not to its customer. When you register a name ending in
`.example` or `.alt`, the response carries `"warning": "reserved_tld"`.

Useful errors: `400 invalid_dynamic_host` (invalid name, with the reason; `shared_hosting` for `github.io`,
`sslip.io` and similar), `409 domain_unavailable` (the name
already belongs to another project or address; the panel does not say whose), `409 dynamic_limit_reached` (names
ceiling) and `404` (project out of reach). Tokens with a wider reach (projects or the whole panel) also use these
routes, but need the **Admin** level to register and remove, as with fixed domains.

The name is checked strictly: lowercase, no `https://`, no wildcard, no IP, no `localhost` or local names
(`.local`, `.internal`), no public suffix (`co.uk`), at most 253 characters and 63 per label. Accented domains
arrive in `xn--` form (punycode).

## Limitations

- **No automatic `www` pair** for dynamic names: register `www.customer-school.example` as another name.
- **No "Try to issue now"** and no own certificate for these names: issuance is always on demand, on first access.
- **Cloudflare's orange cloud** usually prevents issuance (see above).
- **No TXT ownership verification** for now: a name only gets a certificate if its DNS already points at the VPS
  (the panel checks it and Let's Encrypt's challenge requires it), but anyone with panel access (or a domains
  token) can register any name that points here. Give the token only to apps you trust.
- **Behind a proxy or CDN** (orange cloud, load balancer) the DNS does not point at the VPS and the check refuses.
- **Unreadable state file**: if `dynamic-domains.json` breaks, no new name is authorized (the `ask` refuses) and
  the panel raises a critical alert. The Caddyfile **keeps the last good list** (saved in
  `dynamic-domains.lastgood.json`), so customers that already work do not go down. Restore a copy of the file
  (panel backup) to return to normal.
- **Private public-suffix zones** (such as `eu.org`) are refused as a suffix.
- The quota counters **reset on panel restart**.
- A name whose certificate expired and does not renew keeps alerting until it is **removed** from the list.
  Alerts for customer names come **grouped by project** ("Customer domains of X: certificates with a problem",
  with the count and a few names), not one per name.
- Backup: the name list is in the panel backup; the certificates are in the **encrypted** external copy (the Caddy
  volume). When restoring on another server, your customers' DNS must point at the new VPS.

## Security

The panel only issues for a name you registered (or under your suffix, if you turned the option on), that
points at the VPS and is within the ceilings. The proxy's query to the panel uses an **internal port** that is not
published to the internet, refuses anyone not coming from the Docker network, requires a **secret** in the URL
(generated by the panel, kept in `data/`, compared in constant time) and never logs a name. A deleted project
stops being authorized at once, even if the name cleanup fails. See also the
[AI and tokens guide](ai-access.md) and the [security page](../reference/security.md).
