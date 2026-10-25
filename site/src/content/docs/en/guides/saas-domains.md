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
   only answers "yes" for registered names (or names under your suffix, see below) and within the ceilings.
4. Caddy asks Let's Encrypt for the certificate (HTTP challenge) and the name opens with valid HTTPS. Renewals
   are automatic.

Before step 4 the name shows **Waiting for DNS / issuance**. That is normal: the certificate only comes out
after the name's DNS already points at the VPS and someone opens the address.

The panel does **not** issue a certificate for a name nobody registered: a made-up name pointed at your VPS by a
third party is refused before any request to Let's Encrypt.

## What must be ready

- The panel must be **served over HTTPS on your domain** (Settings, Panel domain) and run in the standard
  container. Without that, the proxy cannot reach the panel and the project screen shows a warning explaining
  why.
- Ports **80 and 443** open on the VPS (the HTTP challenge uses 80).
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
registers the name by itself when someone visits it. It is convenient, but anyone who finds the address can
**burn your issuance quota** by visiting made-up names. Turn it on only if you accept that.

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

If DNS is on Cloudflare, keep the record **DNS only** (**grey** cloud), not "Proxied" (orange cloud). With the
orange cloud Cloudflare answers, Let's Encrypt's HTTP challenge never reaches your server and the name stays
**Waiting for DNS / issuance** forever. The panel does **not** use the Cloudflare API: you only touch DNS.

> Want the orange cloud (CDN, protection)? Not possible with this guide's issuance for now. DNS-based
> issuance (which allows the orange cloud and the wildcard) is on the
> [ROADMAP](https://github.com/kelvindk9w/tws-panel/blob/main/ROADMAP.md).

## Step 3: the first access

Open `https://app.customer-school.example` in the browser. The first access takes a few seconds (the certificate
is being issued). Go back to the list: the name should be **Valid**. If it is **Failed**, the message says why
(DNS not pointing, orange cloud, closed ports, Let's Encrypt limit).

## Ceilings that protect you

In **Settings, Dynamic domains**:

- **Names per project**: default **500** (from 10 to 5000). Above it the panel refuses new names.
- **New issuances per hour**: default **20** (from 1 to 100), server-wide. Protects against Let's Encrypt's
  certificate limit. Past it, the name waits for the next hour (it stays **Waiting**).

Renewing a certificate that already exists does **not** spend the new-issuance quota. One name gets at most 3 new
attempts per hour. The counters live in memory: restarting the panel resets them.

## The API for your customer's app (domains token)

For **your app** to register and remove each customer's domains by itself, create a token with the reach
**Only the domains of the projects I choose** in **Settings, AI access** (**Read** or **Write** level; admin does
not exist for this reach). That token:

- only sees the routes below, **on the projects you ticked**; any other route answers `403`, and a project
  outside the list answers `404`, identical to a project that does not exist;
- does not read the project, deploy, see variables or the rest of the panel;
- does not change suffixes or ceilings (that is yours only, from the screen).

Keep the token as the app's secret (environment variable). Examples, with `PROJECT` being the project id or
nickname:

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

Useful errors: `400 invalid_dynamic_host` (invalid name, with the reason), `409 domain_unavailable` (the name
already belongs to another project or address; the panel does not say whose), `409 dynamic_limit_reached` (names
ceiling) and `404` (project out of reach). Tokens with a wider reach (projects or the whole panel) also use these
routes, but need the **Admin** level to register and remove, as with fixed domains.

The name is checked strictly: lowercase, no `https://`, no wildcard, no IP, no `localhost` or local names
(`.local`, `.internal`), no public suffix (`co.uk`), at most 253 characters and 63 per label. Accented domains
arrive in `xn--` form (punycode).

## Limitations

- **No automatic `www` pair** for dynamic names: register `www.customer-school.example` as another name.
- **No "Try to issue now"** and no own certificate for these names: issuance is always on demand, on first access.
- **Cloudflare's orange cloud** prevents issuance (see above).
- **No TXT ownership verification** for now: a name only gets a certificate if its DNS already points at the VPS,
  which Let's Encrypt's own challenge requires; but anyone with panel access (or a domains token) can register
  any name. Give the token only to apps you trust.
- **Private public-suffix zones** (such as `eu.org`) are refused as a suffix.
- The quota counters **reset on panel restart**.
- A name whose certificate expired and does not renew keeps alerting until it is **removed** from the list.
- Backup: the name list is in the panel backup; the certificates are in the **encrypted** external copy (the Caddy
  volume). When restoring on another server, your customers' DNS must point at the new VPS.

## Security

The panel only issues for a name you registered (or under your suffix, if you turned the option on), within the
ceilings. The proxy's query to the panel uses an **internal port** that is not published to the internet, refuses
anyone not coming from the Docker network, and never logs a name. See also the
[AI and tokens guide](ai-access.md) and the [security page](../reference/security.md).
