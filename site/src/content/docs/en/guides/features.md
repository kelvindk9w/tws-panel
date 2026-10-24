---
title: "Features"
description: "What each TWS Panel module does: deploys, certificates, panel domain, email, notifications, backups, security and the web terminal."
sidebar:
  label: "Features"
---

What TWS Panel does, module by module. The [README](https://github.com/kelvindk9w/tws-panel/blob/main/README.md) has the short list; here is
the detail on each part. The examples use placeholder values (`example.com`, `203.0.113.10`).

> [!NOTE]
> **Interface language.** The panel is available in English and Portuguese ([how to choose](../getting-started/complete-guide.md#idioma-da-interface)). This page quotes the English labels exactly as they appear on screen. Some messages that come from the server still appear in Portuguese in both languages: health-check and security-scan results, deploy and DNS-check messages, mail server status and DNS checklist notes, certificate errors, alerts and audit details, backup records, the details of the roadmap steps and many error messages. Whenever this page quotes one of them, it says so.

- [Project deploys](#deploy)
- [Container ports](#portas)
- [HTTPS and certificates](#certificados)
- [Panel domain](#dominio-do-painel)
- [Apps domain](#dominio-de-aplicacoes)
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
  **Settings → Integrations**.
- A folder that is already in the server's projects folder (useful with the panel on your own computer).

**Automatically detected type.**

- Plain HTML site (`index.html` at the root): goes live as is.
- Project with a build (`npm run build`) that produces a static site (`out/`, `dist/`, `build/`).
- **Next.js with a server** (SSR, API routes, middleware, ISR, images): the panel generates the Dockerfile outside
  your repository, builds the image (install frozen by the lockfile, regular user, Node 22 by default) and runs
  the server. See the [Next.js guide](nextjs.md), which explains when to use the static site, the automatic
  server or a Dockerfile of your own.
- `Dockerfile`.
- `docker-compose`: the existing compose file is **adopted**, not rewritten. The screen lists all
  services, ports, dependencies and the healthcheck, and shows which service and port the panel's
  HTTP traffic reaches.

**Domain.**

- Automatic address with instant HTTPS or your own domain, with the
  exact DNS record to create.
- **Multiple domains** on the same project: connect, make primary and remove, effective immediately.
  Connecting the official domain or making it primary does **not** remove the automatic address (it
  becomes an additional one). It only goes away if you remove it, or if you pick "My domain" in the
  new project wizard: in that case, while the DNS doesn't point to the VPS yet and the panel is
  public, the panel keeps a temporary address as an additional domain.
- **Temporary address for testing.** While the official domain's DNS propagates (it can take hours),
  the project's **Domains** page offers **Add a temporary address to test** when no domain of the
  project points to the VPS: `project-k3x9q.apps.example.com` with a verified apps domain, or
  `sslip.io` without one. If the sslip.io certificate can't be issued because of Let's Encrypt's
  issuance limit, the way forward is your own domain or subdomain. Once the official domain works,
  the page reminds you to remove the temporary (sslip.io) address (if it is the primary one, first
  use **Make primary** on the official domain); the panel never removes anything on its own. An
  address under the apps domain is not marked as temporary and gets no reminder. Not offered on a local panel (`.localhost`).
- **With and without www.** The name you type is the main one; the panel also guides the **pair**
  (you typed `example.com`, it guides `www.example.com`; you typed `www.example.com`, it guides
  `example.com`). For each name the screen shows the record type, the name as you write it at your
  provider (`@` and `www`), the value and a copy button, and what happens if only one points here.
  The pair only **redirects (308) to the main address**, so the site keeps a single address (better
  for Google and for logins). **Verify DNS** checks each name on its own (points here, doesn't,
  points elsewhere, orange Cloudflare cloud); a failing pair is only a warning and never blocks the
  main name. The panel only requests the pair's certificate once its DNS points here, and rechecks
  every 10 minutes: create the record when you can and the redirect starts by itself. You can turn the
  pair off per domain. `app.example.com` and `blog.example.com` get no pair, and a name that already
  belongs to another project (or to the panel) is never taken. Domains such as `example.com.br` and
  `example.co.uk` work the same way.
- Before the first deploy, the domain answers "site em configuração" (site being set up). A stopped project shows a
  neutral "temporariamente indisponível" (temporarily unavailable) page instead of the raw server error.
  These two pages are served to the public visitors of your site and are written in Portuguese.

**Day to day.** Each project has its own menu: Overview, Deploys, Domains, Git, Variables,
Email, Sends, Logs, Backups and Settings.

- **Container logs (Logs tab).** Shows what the project's containers write while they run,
  without logging in to the VPS over SSH. It is the way to check, for example, that the farm came
  back fine after the machine was restarted. At the top, the status of each service: running or
  stopped, healthy or not, how many times it restarted, since when it has been up (or when it
  stopped and with which exit code). Below, the log lines, oldest first, each with its time and an
  error mark when it came from the error output (`stderr`).
  You pick the **service** (or all), how many **lines** (100 to 2000; the default is 200) and the
  **period** (last 15 minutes, 1 hour or 24 hours). The filter box searches only the lines already
  on screen. **Refresh automatically** is on by default (every 10 seconds; you can change the
  interval or turn it off), **Follow the end** keeps the scroll on the last line (scrolling up
  turns it off) and **Copy lines** puts what is on screen on the clipboard. If the project is
  stopped, the tab says so and shows what it wrote before stopping; if Docker does not answer, it
  says that instead of showing an empty list.
  **Secrets are hidden on a best-effort basis, not guaranteed.** The panel replaces with
  `[oculto]` (hidden) the values of your project variables (8 characters or more), the password in
  connection URLs (`postgres://user:password@server`), `Bearer` and `Basic` credentials and fields
  such as `password=` or `token:`. A secret that your app writes in another way (split over two
  lines, encoded, under another field name) may show up. Treat the log as sensitive data and do not
  let the app write passwords to it. Also outside the mask: the **old** value of a variable you changed
  (the old log still has the value from before), values shorter than 8 characters and different letter
  case from the variable's. Reading logs does not appear in the Audit log, because the tab refreshes on
  its own. An API token with **Read** level **cannot read variable values**, but it does read the logs of
  the projects in its reach (masked on a best-effort basis). A read has a time limit of 15 seconds (counting the query to Docker; the mask may take a quarter of a second more), each session or token does at most 2 reads at the same time, tokens
  share 4 of the panel's 6 slots (the other 2 stay for your session) and the screen says so when there are
  too many reads.

- **Real-time deploy logs.** If a compose deploy fails, the log gets a "Por que falhou" (Why it failed) block
  (written by the server, so still in Portuguese) with the last lines of the service that became unhealthy and the last healthcheck results.
- **Environment variables** encrypted on the server and injected at deploy time. The screen lists the variables
  the compose file asks for, imports a `.env` and blocks the deploy when a required one is missing.
  A `.env` that belongs to the repository is never overwritten: the panel's variables go to
  a separate file, and the deploy log explains the conflict.
- **Git:** editable repository and branch; the screen shows which branch is actually live.
- **New-update notice.** The panel queries the repository (read-only, without downloading the code)
  and compares the tip of the project's **configured branch** with the commit the last deploy
  published. If there is a newer commit, "A new update is available" appears on the Git tab, at the
  top of the project page and on the Dashboard (a marker on the project card and a list of the
  projects with an update). Projects that use the same repository on different branches (production
  on `main`, sandbox on another) are each checked against their own branch. **The panel never updates
  by itself:** to update the code, click **Deploy** (it fetches the new code from the branch and
  rebuilds the project). The check repeats every few minutes and the Git tab has a **Check now**
  button. If the repository cannot be queried (network, rejected token, a branch that does not
  exist), the screen says "could not check" and why, which does not mean the code is up to date.
  Projects published before this notice stay at "no commit recorded" until their next deploy;
  uploads and server folders have no notice, and stopped projects only show it on the Git tab (not
  at the top of the page or on the Dashboard).
- **Multiple environments:** the same repository can run more than once, on different branches and domains
  (production on `main`, sandbox on another branch), side by side on the same VPS. Each
  instance has its own clone, image, containers and network; only the domain needs to be unique.
- A **central Caddy** handles automatic SSL and zero-downtime reloads, with support for WebSocket and
  long-lived connections.

<a id="portas"></a>

## Container ports

The **Ports** button, on the Containers card of the **Overview** tab, opens two tabs:

- **This project**: each service with its internal ports and those published on the server
  (`127.0.0.1:8010 → 8010`). You can **change** the published port, **publish a port** on a
  service that had none, **remove the publication** or **edit in bulk**. The change takes effect on the next
  deploy.
- **All projects**: all containers on the server and the ports in use, with conflicts in
  red, search and sorting.

The panel rejects 80 and 443 (they belong to the proxy), the email ports and the panel's own port, and any port another
container already uses. When you choose "On all addresses (0.0.0.0)", the screen warns that the port is
open to the internet.

<a id="certificados"></a>

## HTTPS and certificates

Every certificate is issued and renewed automatically by Caddy (Let's Encrypt, with ZeroSSL as a
fallback). The **Certificates** page shows every address the panel serves over HTTPS: the
panel's, each project's domains and every `mail.<domain>`.

- For each one: who it belongs to, the mode (Automatic or Manual), the status (Valid, Issuing,
  Failed, Expiring soon, Expired), the issuer, the expiry and the approximate renewal date.
- When issuance fails, the page explains the likely cause in plain language: DNS that does not
  point to the VPS, Cloudflare's orange cloud, ports 80/443 closed, Let's Encrypt rate limit
  or a CAA record.
- **Try issuing now** makes the proxy restart issuance without waiting for the interval between attempts.
- **Use custom certificate**: you paste the certificate and key; the panel checks the pair
  before accepting it and warns when a manual certificate is close to expiring.

<a id="dominio-do-painel"></a>

## Panel domain

By default, the panel opens at `https://203-0-113-10.sslip.io`, an address with the VPS IP in the
name. In **Settings → Panel domain** you switch to a domain of your own
(`panel.example.com`):

1. the screen shows the A record to create;
2. **Check DNS** queries public DNS;
3. with the DNS correct, the panel answers on both addresses and issues the certificate;
4. with the certificate valid, **Open the panel at the new address**.

Optional, once on the new address: **Turn off IP access**. It is only enabled when the page is opened
through the new domain, the certificate is valid and you type the domain to confirm. To go back over
SSH: `cd /opt/tws-panel && sudo ./scripts/reativar-acesso-ip.sh` (see
[Recover access](recover-access.md)).

<a id="dominio-de-aplicacoes"></a>

## Apps domain

In **Settings → Apps domain** you set a subdomain of your own (`apps.example.com`) for the automatic
project addresses, with no VPS IP in the name:

1. the screen shows **one wildcard record** to create (`*.apps.example.com`, type A pointing to the
   VPS IP, with the gray cloud on Cloudflare; AAAA only if the panel knows the VPS IPv6);
2. **Verify DNS and save** queries a random name under the base (`paas-check-…`) on public DNS and
   **only saves** if it reaches this VPS (the Cloudflare proxy turned on counts as "does not point here");
3. with the base verified, step 3 of **New Project** generates `<project>-<suffix>.apps.example.com`,
   and sslip.io becomes the **Test address**, with a notice.

Each project has its own route and its own certificate: there is no wildcard certificate and no
on-demand issuance, and a random name under the base without a project has no certificate. The base
cannot be the panel domain, a project or email domain, an IP, an internal network name (`.local`,
`.internal`…), or a service such as sslip.io. There is only one apps domain per panel. Changing or
removing the base does not change projects that already use an address under it. The file comes back
with the panel backup, but on a VPS with a different IP the base comes back as **To recheck** until
the record is updated (see [Restore on another server](restore-new-server.md#dominio-de-aplicacoes)).
Step by step and Let's Encrypt limits: [Guide, Part 2](../getting-started/complete-guide.md#dominio-de-aplicacoes).

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
  other variable names, **Link to project variables** delivers the same values under those
  names. Instead of creating a new mailbox, you can **use a mailbox that already exists** on the
  domain (nothing is deleted). And deleting the project does not delete the mailbox or its
  messages: the address is free to be used again.
- **Display name:** every mailbox can have a name (optional, up to 80 characters) that recipients see in
  the From field. Set it when creating (domain page or the project's **Mailboxes** tab) and change it
  later with **Change display name**: only the name changes, the password, 2FA, app passwords,
  aliases and messages stay as they are. On a project's sending mailbox the name is `MAIL_FROM_NAME`
  and a change applies on the next deploy (the panel does not deploy by itself); empty, the project
  name is used.
  On the **Variables** tab, if the compose file requires e-mail variables (`SMTP_HOST`,
  `SMTP_PASSWORD`, `SMTP_FROM`…), a notice says which ones project e-mail fills in, leads to the
  card to turn it on, and offers **Link `SMTP_PASSWORD` to the `SMTP_PASS` value** (only the link
  is stored, nothing is copied). What e-mail does not provide, such as `SMTP_SECURE`, stays
  manual: the notice suggests `false` for port 587 (STARTTLS) and the shortcut only adds the row,
  without saving.

**Webmail.** With one click, `https://mail.<domain>/` starts opening a webmail (**Roundcube**) in
Portuguese to read, reply and send as the mailbox itself. The session ends after 10
minutes of inactivity, and 10 failed sign-ins from the same IP within 10 minutes block that IP for 1 hour, in the webmail only.

**Sending** (`/mail/envios`): what the mail server is doing.

- **Queue now**: each message still being retried, with the reason for the last failure and what to do.
  **Retry now** and **Cancel** buttons.
- **History**: delivered, rejected, deferred and canceled messages from the last 30 days (metadata only,
  never subject or body).
- **Volume:** chart of the last 14 days, rejection rate and totals per project.
- **Outgoing:** the emails each project's app sent over SMTP (from, to, time, state and the error
  reason in plain language, with technical details collapsed). Each project has its own **Sends**
  section. Subject and body are **hidden**: click **Show** (each reveal is written to the audit log,
  without the content). They are kept for 14 days (message data for 90), with no attachments, and
  are **not included in panel backups**. Only **project** mailboxes (what the app sends) keep
  subject and body; webmail and personal mailboxes keep only from, to, time and state. You can stop storing subject and body, per project or for
  everything, on the **Privacy** tab.
- **Reputation**: daily lookup against blocklists (Spamhaus ZEN and DBL, SpamCop, Barracuda),
  with each list's test point so it never says "clean" without having checked. It accepts Spamhaus's
  free DQS key.
- **Deliverability score:** from 0 to 100, with the list of what is done and what is missing (DNS, PTR,
  certificate, blocklists, time sending, rejections, Google Postmaster Tools, Microsoft SNDS).

**Deliverability by default.** The server fills in `Message-ID` and `Date` when missing, DMARC
reports arrive at `postmaster@` (through the `dmarc@` address), the PTR is a single one for the whole
server and outbound traffic is IPv4 only, in line with the SPF.

<a id="notificacoes"></a>

## Notifications

Alerts outside the panel, in **Settings → Notifications**, through **Telegram**, **email** or
both.

- **Telegram:** you create a bot with @BotFather, paste the token, send `/start` and click
  **Connect**. The token is stored encrypted on the server.
- **Email:** sent from the `postmaster@` of a mail server domain with verified DNS, to
  up to 5 addresses.
- **What to notify** (one checkbox per type): security alerts, a deploy that failed and that recovered,
  certificates with problems, email on a blocklist, disk above 90%, backups that failed
  or ran late, the backup password reminder and panel restarted (this one starts off).
- Messages are short and do not include the VPS IP or the alert details. Repeated subjects within
  10 minutes become a digest, and each channel has a limit of 20 notifications per hour.
- **Send test** and a history of the latest sends.

<a id="backups"></a>

## Backups

In **Settings → Backups** and in each project's **Backups** tab.

**What is included.**

- **Projects:** after each deploy, the panel inspects the containers and suggests what to keep.
  Databases detected by image (PostgreSQL, MySQL, MariaDB, MongoDB, Redis) are included via dump.
  Volumes and upload and data folders come checked; caches, logs and `node_modules` come unchecked.
  The code is included when the project does not come from GitHub.
- **Panel:** accounts, registered projects, settings and keys.
- **Email:** the mail server and the webmail. It has its **own, global** backup (all mailboxes of
  all projects together), independent of each project's backup. In the **Backups** tab of a project
  with email turned on you see two separate sections: **Project backup** (database and files) and
  **Email backup** (badge On, Paused, Off or Mail server unavailable; frequency, last backup,
  external check, a shortcut to **Settings → Backups → Email** and **Back up email now**). The
  screen only says the email is protected when the badge is On; in the other states it warns that
  the email is **not** being copied and how to fix it. Turning off the project's backup does not
  turn off the email one. Without email turned on, the email section does not appear.

**Where it is stored.**

- `.7z` files. One copy is **on the VPS**, always.
- Another can go to **external storage**: Cloudflare R2 (recommended) or another S3-compatible
  service. **Test and save** writes, reads and deletes a test file before accepting.
- The external copy is **encrypted** (AES-256, file names too) with a password of yours, on by
  default and which can be turned off. The screen suggests a strong passphrase, offers a **recovery kit**
  to download and reminds you every 90 days to test the password.
- Each external copy is downloaded back and verified before the old ones are deleted.

**When.** Once a day, every 12 hours or every 6 hours, starting at 03:00 in the VPS time zone, with
the number of copies kept on the VPS and externally. **Back up now** at any time.

**Validate the database backup by restoring it into a temporary database (on another project's
server).** On the project's **Backups** tab, off by default: the backup keeps working as always.
For now it only works for **PostgreSQL**. When on, after each
backup the panel restores the database into a **temporary database** it creates on the database
server of **another project** (for example, the farm in sandbox), checks that every table in the
backup exists and that the row counts match the backup, and drops the temporary database. It is the
proof that the database backup really restores. The data **do not stay in the test environment**:
the destination project's own database is not changed and the test does not leave production data
there.

- **Careful.** The test copies real production data, which may be personal data (LGPD/GDPR), onto the
  destination database server: while the test runs it goes through that server's disk and
  transaction log (WAL), and dropping the temporary database at the end (also when the test fails or
  runs past its time limit) does not guarantee no traces remain in those files. Do not turn it on if
  the destination is shared with third parties. To turn it on, pick the destination project and type its name.
- **Database only.** Files, volumes, variables and the source project's configuration are never
  restored. The destination server's other databases, users, roles and system tables are not touched
  either. The panel only drops the temporary database it created and recorded itself (the name
  `tws_rc_` plus 16 random letters and digits); a database of yours with a similar name is never
  dropped. The backup comes from another project and is treated as untrusted: it is restored by a
  **disposable role with no privileges** (created and dropped together with the temporary
  database), never with the administrator credential. So extensions that require a superuser make
  the test fail, with their own reason, and a backup with `psql` client commands (backslash) is
  refused.
- **Who can be the destination.** Another project with a PostgreSQL database already detected and
  running, and with no restore test of its own. The destination needs an administrator credential
  (superuser, or with CREATEDB and CREATEROLE) and disk space for the backup; without the
  permission, the result says it is a permission problem. The destination database's name does not
  matter.
- **MySQL, MariaDB and MongoDB.** Not available yet: the option shows the reason "not available yet
  for this database engine". They are left for a later stage.
- **When.** After every backup (default) or at most once a day or a week. **Test now** runs the
  test with the latest backup, with the same typed confirmation. If the external copy fails, the
  panel still tests the VPS copy.
- **Safety.** The destination's database must be running (the panel does not start or restart
  anything), the destination must not be deploying, and the test waits its turn in the backup queue,
  with a time limit and a disk space check. If the destination is deleted or renamed, the option
  turns itself off and warns you.
- **When it is "ok".** Only when the restore finished with no error at all (it stops at the first
  one), every table in the backup exists in the temporary database and the row counts match the
  backup. A truncated backup, one with errors, or one the destination server does not accept (for
  example, a missing extension) shows as **failed**, with a short reason. A backup with no tables
  also fails.
- **Result.** The tab shows "Last restore test: passed on …, in project …", or failed, or not run,
  with a short reason and what was checked; **Settings → Backups** shows a seal per project. If the
  test fails, you get a failed-backup notification. If the panel restarts midway, a temporary
  database may be left on the destination: the notice says so and the panel drops it at startup and
  on the next test.

**Restore.**

- Per item (project, panel or email), choosing the date and the copy (VPS or external).
- To confirm, you type the word the screen asks for: the project name for a project, and for the
  panel and email a fixed word that depends on the interface language: `panel` and `email` in
  English, `painel` and `e-mail` in Portuguese. The screen shows the word in code font, with a copy
  button, and says it is the literal word (`email` is not your email address). Upper and lower case do
  not matter. The other confirmations in the panel (restarting the wizard, turning off access by IP)
  use the same format.
- **Restore from another server**: on a new VPS, you connect the same storage, enter the
  password and the panel lists what exists, in the right order. Step-by-step:
  [Restore on a new VPS](restore-new-server.md).
- If you cannot get into the panel, over SSH:
  `cd /opt/tws-panel && sudo ./scripts/restaurar-painel.sh /root/ARQUIVO.7z`.

**After restoring the panel from another server.** This applies to the restore from the screen, not
to `restaurar-painel.sh`.

- **The schedule of projects and email is held for up to 7 days.** The restored panel brings back
  the old schedule, but a new VPS has no data yet. So each project registered before the restore, and
  the email, stay without a scheduled backup until the hold ends: when you restore the data of that
  item, when you make a backup of it by hand, or by itself after 7 days. The screens show the reason,
  a message that starts with "Em pausa" (a server message, in Portuguese), instead of "Next: …". On
  the same VPS, what already has containers is not held, and the email is left out of the hold only
  if its container exists on this VPS. A project created after the restore is not held, and neither is
  the panel.
- **A new panel does not overwrite the backups of another server.** The scheduled backup of the panel
  does not go out while all of this is true: no project is registered, the panel was not restored, no panel backup and no email
  backup was **sent to the storage** by this VPS (a copy only on the VPS does not count), and the storage already holds panel backups in `_painel/`. The hold
  ends by itself 7 days after the storage is connected, and the panel sends one notification when it
  starts. If the panel cannot list the storage, it does not send the backup either, and a
  notification warns you on the third failure in a row. **Back up now** always works.
  In the "Get the panel ready" checklist (step 6), the "What's missing" card shows both paths when the
  storage already holds backups from another panel: restore the old panel (to continue it) or, if
  this is a new panel, make the first backup by hand in Settings → Backups. Note: from the first
  backup on, the retention deletes the oldest copies in the folder (it keeps only the newest ones; the
  default is 5), including the old panel's; to keep them, download them before making the first
  backup or use another bucket or folder.
- **The storage address and keys stay the ones in use on this VPS.** The rest of the backup settings
  comes back with the panel.

<a id="seguranca"></a>

## Security and monitoring

- **Security wizard:** scan with **Lynis** and custom checks, score before and after, and
  hardening in 8 idempotent phases (updates, user, SSH, firewall, fail2ban/AppArmor,
  minimization, auditing and additional hardening), with a dry run and a backup of each file. The
  phases that touch access schedule an **automatic rollback** after 5 minutes. Also available
  after installation, in **Security → Scan and apply protections**. Guide: [Security wizard](../getting-started/security-wizard.md).
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
- **Server health:** CPU, memory, disk and network.
- **Sign-in:** administrator account with a strong password (argon2id), revocable sessions and an attempt
  limit. **Two-factor authentication** (6-digit code from an authenticator app) with 10
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
each step computed from the panel's real state. Each step has a "How to" and a button
that takes you to the right screen. A step that has started but still lacks something is "in progress" and shows, outside the "How to", an amber **What's missing** box with what to do and the button for the right screen; at the top of the card, one line sums up how many steps need attention, with a link to each. Optional steps accept "I won't use this". The whole checklist is also
available in **Settings → Getting started**. The list of steps is in the
[README](https://github.com/kelvindk9w/tws-panel/blob/main/README.md#after-installing).
