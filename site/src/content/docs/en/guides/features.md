---
title: "Features"
description: "What each TWS Panel module does: deploys, certificates, panel domain, email, notifications, backups, security and the web terminal."
sidebar:
  label: "Features"
---

What TWS Panel does, module by module. The [README](https://github.com/kelvindk9w/tws-panel/blob/main/README.md) has the short list; here is
the detail on each part. The examples use placeholder values (`example.com`, `203.0.113.10`).

> [!NOTE]
> **The panel interface is being translated.** For now, screen names, buttons and messages appear in Portuguese, exactly as on screen, followed by the English meaning in parentheses. They may change when the English interface is released.

- [Project deploys](#deploy)
- [Container ports](#portas)
- [HTTPS and certificates](#certificados)
- [Panel domain](#dominio-do-painel)
- [Email](#email)
- [Notifications](#notificacoes)
- [Backups](#backups)
- [Security and monitoring](#seguranca)
- [Web terminal](#terminal)
- ["Get the panel ready" checklist](#roteiro)

<a id="deploy"></a>

## Project deploys

**Code source.**

- Git repository with a configurable branch: public, or private with a **read-only** token
  (the screen teaches you how to generate the token).
- Repository picked from a list, after connecting your GitHub account in
  **Configurações → Integrações** (Settings → Integrations).
- A folder that is already in the server's projects folder (useful with the panel on your own computer).

**Automatically detected type.**

- Plain HTML site (`index.html` at the root): goes live as is.
- Project with a build (`npm run build`) that produces a static site (`out/`, `dist/`, `build/`).
- `Dockerfile`.
- `docker-compose`: the existing compose file is **adopted**, not rewritten. The screen lists all
  services, ports, dependencies and the healthcheck, and shows which service and port the panel's
  HTTP traffic reaches.

**Domain.**

- Automatic address with instant HTTPS (`projeto.203-0-113-10.sslip.io`) or your own domain, with the
  exact DNS record to create.
- **Multiple domains** on the same project: connect, make primary and remove, effective immediately.
- Before the first deploy, the domain answers "site em configuração" (site being set up). A stopped project shows a
  neutral "temporariamente indisponível" (temporarily unavailable) page instead of the raw server error.

**Day to day.** Each project has its own menu: Visão geral (Overview), Deploys, Domínios (Domains), Git, Variáveis (Variables),
E-mail, Backups and Configurações (Settings).

- **Real-time deploy logs.** If a compose deploy fails, the log gets a "Por que falhou" (Why it failed) block
  with the last lines of the service that became unhealthy and the last healthcheck results.
- **Environment variables** encrypted on the server and injected at deploy time. The screen lists the variables
  the compose file asks for, imports a `.env` and blocks the deploy when a required one is missing.
  A `.env` that belongs to the repository is never overwritten: the panel's variables go to
  a separate file, and the deploy log explains the conflict.
- **Git:** editable repository and branch; the screen shows which branch is actually live.
- **Multiple environments:** the same repository can run more than once, on different branches and domains
  (production on `main`, sandbox on another branch), side by side on the same VPS. Each
  instance has its own clone, image, containers and network; only the domain needs to be unique.
- A **central Caddy** handles automatic SSL and zero-downtime reloads, with support for WebSocket and
  long-lived connections.

<a id="portas"></a>

## Container ports

The **Portas** (Ports) button, on the Containers card of the Visão geral (Overview), opens two tabs:

- **Este projeto** (This project): each service with its internal ports and those published on the server
  (`127.0.0.1:8010 → 8010`). You can **change** the published port, **publish a port** on a
  service that had none, **remove the publication** or **edit in bulk**. The change takes effect on the next
  deploy.
- **Todos os projetos** (All projects): all containers on the server and the ports in use, with conflicts in
  red, search and sorting.

The panel rejects 80 and 443 (they belong to the proxy), the email ports and the panel's own port, and any port another
container already uses. When you choose "all addresses" (`0.0.0.0`), the screen warns that the port is
open to the internet.

<a id="certificados"></a>

## HTTPS and certificates

Every certificate is issued and renewed automatically by Caddy (Let's Encrypt, with ZeroSSL as a
fallback). The **Certificados** (Certificates) page shows every address the panel serves over HTTPS: the
panel's, each project's domains and every `mail.<domain>`.

- For each one: who it belongs to, the mode (Automático or Manual), the status (Válido, Emitindo,
  Falhou, Vence em breve, Vencido — Valid, Issuing, Failed, Expiring soon, Expired), the issuer, the expiry and the approximate renewal date.
- When issuance fails, the page explains the likely cause in plain language: DNS that does not
  point to the VPS, Cloudflare's orange cloud, ports 80/443 closed, Let's Encrypt rate limit
  or a CAA record.
- **Tentar emitir agora** (Try to issue now) makes the proxy restart issuance without waiting for the interval between attempts.
- **Usar certificado próprio** (Use your own certificate, manual): you paste the certificate and key; the panel checks the pair
  before accepting it and warns when a manual certificate is close to expiring.

<a id="dominio-do-painel"></a>

## Panel domain

By default, the panel opens at `https://203-0-113-10.sslip.io`, an address with the VPS IP in the
name. In **Configurações → Domínio do painel** (Settings → Panel domain) you switch to a domain of your own
(`panel.example.com`):

1. the screen shows the A record to create;
2. **Verificar DNS** (Verify DNS) queries public DNS;
3. with the DNS correct, the panel answers on both addresses and issues the certificate;
4. with the certificate valid, **Abrir o painel pelo endereço novo** (Open the panel at the new address).

Optional, once on the new address: **Desativar o acesso pelo IP** (Disable access by IP). It is only enabled when the page is opened
through the new domain, the certificate is valid and you type the domain to confirm. To go back over
SSH: `cd /opt/tws-panel && sudo ./scripts/reativar-acesso-ip.sh` (see
[Recover access](recover-access.md)).

<a id="email"></a>

## Email

Your own mail server on the VPS (**Stalwart**: SMTP, IMAP and DKIM in a single container), so
your projects can send messages and for mailboxes such as `contato@`.

**Domains and DNS.**

- Each domain gets its own **DKIM RSA 2048** key pair.
- A **verifiable DNS checklist** (A, MX, SPF, DKIM, DMARC and PTR) gives you values ready
  to copy and checks each record against public DNS.
- **PTR in three levels:** green (reverse name equal to the server's), blue (generic provider
  name that points back to the IP: it works, but changing it is recommended) and yellow (no valid
  reverse name). For Contabo, Hetzner and Vultr the screen says where to change it in the provider's panel;
  for the others, it gives you ready-made text to open a support ticket.
- The `mail.<domain>` certificate is issued by Caddy and installed on the mail server by the
  panel, which renews it automatically.
- The screen recommends using a send-only subdomain (`send.example.com`), so you do not divert
  the email the main domain already receives elsewhere.

**Mailboxes.**

- Creating a mailbox generates **ready-to-use credentials** for Outlook, Gmail, Thunderbird or your phone.
  The password can be typed or generated by the panel, and is not shown again.
- **Send a test email** from any mailbox.
- **Project email:** the project gets its own mailbox (e.g. `contato@shop.example.com`)
  with a display name, and the `SMTP_*` and `MAIL_*` values are injected at deploy time. If the app uses
  other variable names, **Ligar às variáveis do projeto** (Link to the project's variables) delivers the same values under those
  names.

**Webmail.** With one click, `https://mail.<domain>/` starts opening a webmail (**Roundcube**) in
Portuguese to read, reply and send as the mailbox itself. The session ends after 10
minutes of inactivity, and 10 failed logins from the same IP within 10 minutes block that IP for 1 hour, in the webmail only.

**Envios** (Sends) (`/mail/envios`): what the mail server is doing.

- **Fila agora** (Queue now): each message still being retried, with the reason for the last failure and what to do.
  **Tentar agora** (Try now) and **Cancelar** (Cancel) buttons.
- **Histórico** (History): delivered, rejected, deferred and canceled messages from the last 30 days (metadata only,
  never subject or body).
- **Volume:** chart of the last 14 days, rejection rate and totals per project.
- **Reputação** (Reputation): daily lookup against blocklists (Spamhaus ZEN and DBL, SpamCop, Barracuda),
  with each list's test point so it never says "clean" without having checked. It accepts Spamhaus's
  free DQS key.
- **Deliverability score:** from 0 to 100, with the list of what is done and what is missing (DNS, PTR,
  certificate, blocklists, time sending, rejections, Google Postmaster Tools, Microsoft SNDS).

**Deliverability by default.** The server fills in `Message-ID` and `Date` when missing, DMARC
reports arrive at `postmaster@` (through the `dmarc@` address), the PTR is a single one for the whole
server and outbound traffic is IPv4 only, in line with the SPF.

<a id="notificacoes"></a>

## Notifications

Alerts outside the panel, in **Configurações → Notificações** (Settings → Notifications), through **Telegram**, **email** or
both.

- **Telegram:** you create a bot with @BotFather, paste the token, send `/start` and click
  Conectar (Connect). The token is stored encrypted on the server.
- **Email:** sent from the `postmaster@` of a mail server domain with verified DNS, to
  up to 5 addresses.
- **What it notifies** (one checkbox per type): security alerts, a deploy that failed and that recovered,
  certificates with problems, email on a blocklist, disk above 90%, backups that failed
  or ran late, the backup password reminder and panel restarted (this one starts off).
- Messages are short and do not include the VPS IP or the alert details. Repeated subjects within
  10 minutes become a digest, and each channel has a limit of 20 notifications per hour.
- **Enviar teste** (Send test) and a history of the latest sends.

<a id="backups"></a>

## Backups

In **Configurações → Backups** (Settings → Backups) and in each project's **Backups** tab.

**What is included.**

- **Projects:** after each deploy, the panel inspects the containers and suggests what to keep.
  Databases detected by image (PostgreSQL, MySQL, MariaDB, MongoDB, Redis) are included via dump.
  Volumes and upload and data folders come checked; caches, logs and `node_modules` come unchecked.
  The code is included when the project does not come from GitHub.
- **Panel:** accounts, registered projects, settings and keys.
- **Email:** the mail server and the webmail.

**Where it is stored.**

- `.7z` files. One copy is **on the VPS**, always.
- Another can go to **external storage**: Cloudflare R2 (recommended) or another S3-compatible
  service. **Testar e salvar** (Test and save) writes, reads and deletes a test file before accepting.
- The external copy is **encrypted** (AES-256, file names too) with a password of yours, on by
  default and which can be turned off. The screen suggests a strong passphrase, offers a **recovery kit**
  to download and reminds you every 90 days to test the password.
- Each external copy is downloaded back and verified before the old ones are deleted.

**When.** Once a day, every 12 hours or every 6 hours, starting at 03:00 in the VPS time zone, with
the number of copies kept on the VPS and externally. **Fazer backup agora** (Back up now) at any time.

**Restore.**

- Per item (project, panel or email), choosing the date and the copy (VPS or external).
- **Restaurar de outro servidor** (Restore from another server): on a new VPS, you connect the same storage, enter the
  password and the panel lists what exists, in the right order. Step-by-step:
  [Restore on a new VPS](restore-new-server.md).
- If you cannot get into the panel, over SSH:
  `cd /opt/tws-panel && sudo ./scripts/restaurar-painel.sh /root/ARQUIVO.7z`.

<a id="seguranca"></a>

## Security and monitoring

- **Security wizard:** scan with **Lynis** and custom checks, score before and after, and
  hardening in 8 idempotent phases (updates, user, SSH, firewall, fail2ban/AppArmor,
  minimization, auditing and additional hardening), with a dry run and a backup of each file. The
  phases that touch access schedule an **automatic rollback** after 5 minutes. Also available
  after installation, in **Segurança → Proteções** (Security → Protections). Guide: [Security wizard](../getting-started/security-wizard.md).
- **Deploy guardrails:** rules in 3 levels (`block`, `warn`, `info`) — exposed database port,
  weak credentials, dev service in production, committed secret and `:latest` tag. A block only
  passes with an explicit, audited override. The compose file is also checked the way Docker
  runs it, against a list of what is allowed (no privileged container, no `docker.sock`, no bind
  outside the project folder, no access to the panel's networks). The rules that protect the
  panel itself have no override.
- **Isolation:** the panel, the mail server and the projects sit on separate Docker networks, and
  the proxy only trusts forwarded headers from Caddy. Details in
  [Network migration](network-migration.md).
- **Monitoring:** a baseline records packages, ports and hashes of critical files; recurring
  scans compare against it, and each change becomes an alert.
- **Alert center** and **audit log** of sensitive actions.
- **Machine health:** CPU, memory, disk and network.
- **Login:** administrator account with a strong password (argon2id), revocable sessions and an attempt
  limit. **Two-step verification** (6-digit code from an authenticator app) with 10
  recovery codes.

Details of the security model, including what the panel does **not** protect:
[Security](../reference/security.md).

<a id="terminal"></a>

## Web terminal

A real terminal of the server inside the panel (xterm.js + WebSocket + PTY), in a window collapsed
by default. In the wizard, it stays locked until the setup token is validated, and the scans and phases
of the hardening run inside it: you see the real commands, as you would over SSH.

At installation you choose which user it opens as and how what needs root runs (`senha`,
through `sudo`, or `segundo-plano`, recorded in the Auditoria). The backend is a pure PTY relay
and never reads, logs or stores what you type; it only audits connection and disconnection. See
[what each choice means](../getting-started/installation.md#terminal-do-painel).

<a id="roteiro"></a>

## "Get the panel ready" checklist

On the Dashboard, a card lists what is still left to configure after installation, with the status of
each step computed from the panel's real state. Each step has a "Como fazer" (How to) and a button
that takes you to the right screen. Optional steps accept "Não vou usar" (I won't use this). The whole checklist is also
available in **Configurações → Primeiros passos** (Settings → Getting started). The list of steps is in the
[README](https://github.com/kelvindk9w/tws-panel/blob/main/README.md#after-installing).
