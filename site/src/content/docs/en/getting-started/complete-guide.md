---
title: "Step-by-step guide — Part 2: Configure"
description: "Part 2 of the step-by-step guide: with the panel installed, configure the wizard, security, domain, email, notifications, backups, your first project and a test restore."
sidebar:
  label: "Part 2: Configure"
---

> [!TIP]
> **Back: [Part 1 — Install](installation.md).** This is **Part 2 (Configure)** of the same path: it starts where
> Part 1 ends, with the panel installed and the wizard link in hand. Have not installed yet? Start with Part 1.

A single roadmap, in order, from the freshly installed panel to a fully configured one: wizard,
security, domain, time zone, email, notifications, backups, your first project live, and a test restore.

> [!NOTE]
> **Interface language.** The panel is available in English and Portuguese ([how to choose](#idioma-da-interface)). This page quotes the English labels exactly as they appear on screen. Some messages that come from the server still appear in Portuguese in both languages: health-check and security-scan results, deploy and DNS-check messages, mail server status and DNS checklist notes, certificate errors, alerts and audit details, backup records, the details of the roadmap steps and many error messages. Whenever this page quotes one of them, it says so.

Each step tells you **what to do**, **where to click**, and **what to check** to know it worked.
When the details are long, the step summarizes and points you to the right guide. Follow the steps
in order: some depend on earlier ones (email notifications, for example, need email to be ready).

The examples use made-up values: `203.0.113.10` as the VPS IP and `example.com` as the domain.
Replace them with yours.

| Step | What you do | Where |
|---|---|---|
| [1](#etapa-1) | Initial wizard, security, and two-factor authentication | Browser |
| [2](#etapa-2) | Panel domain | Settings → Panel domain |
| [3](#etapa-3) | Time zone | Settings → Time zone |
| [4](#etapa-4) | Email | Email, Sending |
| [5](#etapa-5) | Notifications | Settings → Notifications |
| [6](#etapa-6) | Backups outside the VPS | Settings → Backups |
| [7](#etapa-7) | First project | New project |
| [8](#etapa-8) | Test a restore | Project → Backups |
| [9](#etapa-9) | Maintenance | Terminal, Alerts, Audit log |
| [✓](#checklist) | Final checklist | — |

The accounts you will use (GitHub, Cloudflare and Telegram) and the optional domain are described in
[Before you start](installation.md#before-you-start), in Part 1.

> [!TIP]
> The panel itself tracks much of this. On the Dashboard, the **Get the panel ready** card shows what is missing (protections, two-factor authentication, panel domain, email,
> notifications, and backups), with a "How to" link and a button to the right screen.
> The same list lives in **Settings → Getting started**. This
> guide goes beyond it: time zone, first project, and a test restore.

<a id="etapa-1"></a>

## Step 1 — Initial wizard, security, and two-factor authentication

### 1.1 The wizard (setup)

**What to do:** open the banner link in your browser (the same one from [Step 8 of Part 1](installation.md#passo-8)). The wizard has four steps:

1. **Welcome and token**: validates the setup token (already in the link) and unlocks the
   server terminal.
2. **Server health**: CPU, memory, disk, and network, checked live in the
   built-in terminal. This step also shows the VPS time zone (see [Step 3](#etapa-3)).
3. **Security**: scan (Lynis), plan, and hardening in 8 phases. Explained just below.
4. **Administrator account**: your user and a strong panel password. Click
   **Create admin account**.

<a id="idioma-da-interface"></a>
**Language.** On the first visit the panel goes through your browser's list of languages and uses the
first one it has: Portuguese for any `pt` variant (such as `pt-BR`), English for `en`; if none matches,
English. To change it, use the **Language**
selector on the setup and sign-in screens, in the panel header (next to your user menu, always visible; with the side menu layout it sits at the bottom of the sidebar, above the user menu), or under **Settings → Appearance**.
The choice is saved in that browser only: another browser or device starts again from its own
language.

**What to check:** **Setup complete!** appears and you land on the Dashboard.
From here on, access is through the sign-in screen, with username and password. The setup token stops
working.

### 1.2 The Security step (hardening)

> [!IMPORTANT]
> **Read the [Security wizard](security-wizard.md) before this step.** It turns off password login
> over SSH. Done carelessly, it can lock you out of the VPS.

**What to do, in short:**

- Apply the phases **one at a time**. Simulate first if you like: nothing changes on the VPS during
  a simulation.
- Phases **01 (user), 02 (SSH), and 03 (firewall)** ask for confirmation. After applying, open
  **a new window** of the terminal on your computer, without closing the old one, and run the `ssh`
  command the panel shows.
- Only if the new window connects, type `exit` and click **I'm in — confirm**.
  If it doesn't connect, click **I couldn't sign in — undo now**. Without confirmation, the phase undoes itself after about 5 minutes.
- In phase 01, the new window must sign in **without asking for the account password**. If it asks,
  don't confirm and don't move on to 02.
- Phase 06 (Audit) takes several minutes. It looks stuck, but it is not.
- **After the last phase, reboot the VPS** (`sudo reboot`), wait a minute, and open the panel
  again.

The full step-by-step, phase by phase, is in
[The eight phases](security-wizard.md#as-oito-fases).

**What to check:** on the Dashboard, the **VPS hardening** step of the roadmap
shows as done, with "Todas as 8 fases resolvidas" (All 8 phases resolved; a server message, still in Portuguese). If any phase was left out, it stays in
**Security → Scan and apply protections** for you to review, simulate, or apply later.

### 1.3 Two-factor authentication

With it, signing in to the panel asks for a 6-digit code generated on your phone in addition to
the password. If your password leaks, nobody gets in without your phone.

**What to do:**

1. Install an authenticator app on your phone (Google Authenticator, Microsoft Authenticator,
   2FAS, or similar).
2. In the panel, open **Settings → Security** and click **Get started**.
3. Scan the QR code with the app. Can't scan it? The screen shows the key to type into the app.
4. Type the **code shown in the app** and **your current panel password**. Click **Enable**.
5. The screen shows the **recovery codes**, which appear only now. Store them somewhere safe, check
   **I saved the codes somewhere safe**, and click
   **Done**.

**What to check:** the screen says "Enabled: signing in to the panel requires the app code." Sign out and back in: the sign-in asks for the code.
On the Dashboard, the **Two-factor authentication** step shows as done.

<a id="etapa-2"></a>

## Step 2 — Panel domain

Replaces the address `https://203-0-113-10.sslip.io` with one of your own, such as
`panel.example.com`. The automatic address gives away the VPS IP in the name; a domain of your own
is more discreet and easier to remember.
For project addresses, see also the [Apps domain](#dominio-de-aplicacoes), at the end of this step.

> [!NOTE]
> Installed with SSH tunnel access? Then the panel has no address on the internet, this step
> already counts as done, and the screen explains how to switch to HTTPS.

**What to do:**

1. **Create the DNS record.** On Cloudflare: DNS → Records → Add record.
   - Type: **A**.
   - Name: `panel` (for `panel.example.com`).
   - IPv4 address: the VPS IP.
   - Proxy: **gray cloud ("DNS only")**. With the orange cloud, the certificate is not issued.
   - Save. If there is an **AAAA** record with the same name, delete it.
2. **Register it in the panel.** Still on the `…sslip.io` address, open **Settings → Panel domain**, type `panel.example.com`, and click **Save domain**. The screen shows the same A record, with a copy button on each field.
3. Click **Check DNS**. If the result says the domain "ainda não aponta" (doesn't point there
   yet; this check result comes from the server and is still in Portuguese), wait a few minutes
   and try again.
4. **Wait for the certificate.** In the certificate card, wait for it to become **Valid**
   (seconds to 2 minutes). Use **Check again** to refresh. If it fails, the
   cause shows up in the card, with the **Try issuing now** button.
5. Click **Open the panel at the new address** and sign in
   again, with username, password, and code. The session is valid only on the address where you
   signed in.

**What to check:** the panel opens at `https://panel.example.com`, with a padlock. The **Panel address**
list shows both addresses. On the Dashboard, the **Panel domain** step shows as done, with the
notice "acesso pelo IP ainda ativo" (access by IP still active; a server message, still in
Portuguese).

### Turn off access by IP (optional)

Makes the `…sslip.io` address stop opening the panel. It is only unlocked with the page open **on
the new domain** and the certificate valid.

1. Already on the new address, in **Settings → Panel domain**, **write down the SSH
   command** the screen shows (there is a **Copy the command** button). It is
   your way back if the domain stops opening.
2. Click **Turn off IP access**, type the domain, and click
   **Turn off now**.

**What to check:**

- `https://203-0-113-10.sslip.io` no longer opens the panel;
- `https://panel.example.com` still opens;
- in **Audit log**, `panel_domain.ip_disabled` appears.

### How to turn access by IP back on

- **On screen:** in **Settings → Panel domain**, click **Turn IP access back on**.
- **Over SSH**, if the domain stopped opening (DNS deleted, domain expired, certificate that did
  not renew):

  ```bash
  cd /opt/tws-panel && sudo ./scripts/reativar-acesso-ip.sh
  ```

  Wait for the script's final message ("pronto", Portuguese for "done"), open `https://203-0-113-10.sslip.io` (with your IP), and
  sign in again. Details in
  [The panel domain stopped opening](../guides/recover-access.md#o-domínio-do-painel-parou-de-abrir).

<a id="dominio-de-aplicacoes"></a>

### Apps domain (optional)

By default, each new project gets an automatic **test** address with the VPS IP in the name
(`minha-app.203-0-113-10.sslip.io`). That address shows up in screenshots and shared links, stops
opening if the VPS IP changes, and depends on a third-party service (sslip.io). It is not a serious
security flaw: anyone who hosts sites can always have the IP found through DNS. The problem is
privacy, appearance, and stability.

With the **apps domain**, the panel generates addresses under a subdomain of your own, with no IP in
the name: `minha-app-k3x9q.apps.example.com`.

**What to do:**

1. **Pick a subdomain just for apps**, such as `apps.example.com`. Do not use the main domain, the
   panel domain, or a project or email domain.
2. Open **Settings → Apps domain** and type `apps.example.com`. The screen shows the record to
   create, with a copy button on each field.
3. **Create a single wildcard DNS record.** On Cloudflare: DNS → Records → Add record.
   - Type: **A**.
   - Name: `*.apps` (for `*.apps.example.com`). If your provider asks for the full name, type
     `*.apps.example.com`.
   - IPv4 address: the VPS IP.
   - Proxy: **gray cloud ("DNS only")**. With the orange cloud, each project's certificate is not issued.
   - The screen only shows an **AAAA** record if the panel knows the VPS public IPv6
     (`PAAS_PUBLIC_IPV6`). Otherwise, do not create an AAAA.
4. Click **Verify DNS and save**. The panel queries a random name under the base (`paas-check-…`)
   and **only saves** if it reaches this VPS. A record only for `apps.example.com` does not pass:
   the wildcard is what counts. The result is a server message, still in Portuguese. If it says the
   name does not point there ("não aponta"), wait a few minutes and try again.

**What to check:** the screen shows the domain with the **Verified** badge and an example address.

**How to use it:** in **New Project**, step 3, the **Automatic address** becomes
`<project>-<suffix>.apps.example.com` (a random 5-character suffix), with HTTPS and no warning.
sslip.io stays available as the **Test address**, with the notice that it contains the VPS IP.
Projects that already exist with sslip.io do not change.

**Good to know:**

- Each project has its own route and its own certificate. The panel does **not** issue a wildcard
  certificate or allow on-demand issuance: any name under `apps.example.com` without a project
  answers only the "domain not configured" page, over HTTP, and has no certificate.
- **Let's Encrypt limits you to 50 new certificates per week per registered domain** (here,
  `example.com`, adding up all subdomains). That is plenty for personal use; creating and deleting
  many projects within a few days can use it up. When issuing fails, the **Certificates** page shows
  the cause and has the **Try issuing now** button
  (see [Let's Encrypt limit](../guides/troubleshooting.md#limite-do-lets-encrypt)).
- Every certificate goes into a public list (Certificate Transparency): each project's address
  (project name and suffix) is visible there. The suffix avoids collisions; it does not hide the address.
- **Changing** the base does not change projects that already use the old one. **Removing** it does
  not either: they keep opening, and new projects go back to the test address.
- If the check fails, see
  [The apps domain check fails](../guides/troubleshooting.md#verificacao-do-dominio-de-aplicacoes).

<a id="etapa-3"></a>

## Step 3 — Time zone

The VPS time zone defines **the time of scheduled backups, which run at 03:00 in the VPS time
zone**, and the dates in the logs. Each provider delivers the VPS in some time zone: most in UTC
(three hours ahead of Brasília), some in the local time of their data center. In UTC, the backups'
"03:00" would be midnight Brasília time.

**Where to see it:** the initial wizard already shows the detected time zone in the **Server health** step, with **Change time zone**. After installation,
the place is **Settings → Time zone**.

**What to do:**

1. Open **Settings → Time zone**. The screen shows the VPS time zone and the current time.
2. Under **New time zone**, pick yours. Brazil's appear first; you can search by city or
   state (e.g., `America/Sao_Paulo`).
3. Optional: under **Also apply to these projects**, check the
   projects that should follow the VPS time zone. They switch to "Same as the VPS" and restart with the new time zone, without pulling new code. Unchecked ones keep the time
   zone they have.
4. Click **Apply to the VPS**. The change applies to the whole VPS, with no SSH
   needed.

Each project also has the **Time zone** card, in the project's **Settings**
tab: "Image default (usually UTC)", "Same as the VPS", or a specific time zone.

**What to check:** the time shown on screen matches your clock. In **Settings → Backups**, the
schedule sentence says "Runs at 03:00 (VPS time, …)" with the
new time zone's offset (for Brasília, `UTC-03:00`).

<a id="etapa-4"></a>

## Step 4 — Email

An email server on the VPS itself, so your projects can send messages (password recovery, notices,
forms) and so you can have mailboxes such as `contato@`. It is optional: if your projects use an
external sending service (Amazon SES, Resend, SendGrid…), check **I won't use this**
in the roadmap and skip to [Step 5](#etapa-5).

> [!IMPORTANT]
> **Use a subdomain just for sending**, such as `send.example.com`. Don't use the main domain:
> pointing its MX at the VPS would divert the email the company already receives somewhere else
> (Google, Microsoft, or another service). The steps below use `send.example.com`.

### 4.1 Check port 25

On the VPS, over SSH:

```bash
nc -vz -w 5 gmail-smtp-in.l.google.com 25
```

**What to check:** `succeeded` or `open` means it is unblocked. `timed out` means it is blocked:
open a ticket with the provider asking to unblock outbound port 25 for transactional email. Without
it, email does not go out. See
[Port 25 blocked by the provider](../guides/troubleshooting.md#porta-25-bloqueada-pelo-provedor).

### 4.2 Start the server and register the sending domain

1. In the menu, click **Email**.
2. If the server is stopped, click **Start server**.
3. In the **Email domains** card, type `send.example.com` and click
   **Add domain**.
4. If the red notice "This domain already receives email on another server" appears, do **not**
   go ahead with the main domain. Click **Use envio.example.com (recommended)** (the panel
   always suggests an `envio.` subdomain of your domain, which is a Portuguese word; any subdomain
   works, and the steps below use `send.example.com`).

**What to check:** the **Mail server** card shows the server running and the
domain appears in the list.

### 4.3 Create the DNS records

Click the registered domain and open the **DNS checklist** tab. The **Expected DNS records** card has the exact values, with your VPS IP and the DKIM key.
**Copy field by field**, using each one's copy button. On Cloudflare (DNS → Records → Add record),
for `send.example.com`:

| Type | Name (on Cloudflare) | Value | Note |
|---|---|---|---|
| A | `mail.send` | VPS IP | **Gray cloud ("DNS only")**. With the orange one, the certificate is not issued and email does not arrive. |
| MX | `send` | Mail server: `mail.send.example.com` · Priority: `10` | On Cloudflare, the MX has **two separate fields**: Mail server and Priority. The screen shows each one with its own copy button. Only on the subdomain: don't touch the main domain's MX. |
| TXT (SPF) | `send` | `v=spf1 ip4:<IP> ~all`, from the checklist | |
| TXT (DKIM) | `paas._domainkey.send` | `v=DKIM1; k=rsa; p=…`, from the checklist | Copy it whole, using the button. |
| TXT (DMARC) | `_dmarc.send` | `v=DMARC1; p=none; …`, from the checklist | Keep `p=none` for the first few weeks. |

Then click **Verify now** until all of them turn green. Propagation takes from
minutes to a few hours.

**What to check:** the count reaches **6/6 OK** (the sixth item is the PTR, just below).

### 4.4 Reverse DNS (PTR)

The PTR is the "name" the VPS IP reports to whoever receives the email. It does **not** live on
Cloudflare: it is set in the VPS provider's dashboard. The **Reverse DNS (PTR)** card shows one of
three colors:

- **Green:** the reverse name is already `mail.send.example.com`. Nothing to do.
- **Blue:** a generic provider name that points back to the IP. Sending already works; changing the
  name is recommended, and the way to do it appears under "Recommended: change the reverse name to …".
- **Yellow:** no valid reverse name. Gmail, Yahoo, and Microsoft may reject your mail: change the
  name.

Where to change it: on **Contabo**, in Reverse DNS Management; on **Hetzner**, server → Networking
tab → Reverse DNS; on **Vultr**, server → Settings → IPv4 → Reverse DNS. On other providers, the
card has ready-made text for opening a ticket, with a copy button.

**What to check:** after changing it, **Verify now** turns the PTR green.

### 4.5 Email certificate

1. Go back to **Email**.
2. The **Mail server certificate** card shows
   `mail.send.example.com`.
3. Click **Check again** until **Valid** and "Issued by Let's Encrypt" appear. The first time, the email server restarts by itself for a few
   seconds.

**What to check:** the state is **Valid**. If it stays pending, the card itself says what is
missing (missing A record, orange cloud, or ports 80/443 closed). The panel renews it by itself.

### 4.6 Create a mailbox

1. On the domain's page, open the **Mailboxes** tab.
2. Under **New mailbox**, type the name (e.g., `contato`).
3. Choose the password: type it twice (minimum of 12 characters) or have the panel generate one.
   The password does not show up again: store it in your password manager.
4. Click **Create mailbox**.

**What to check:** the mailbox appears in the list. "Set up in app" shows
the settings for Outlook, Gmail, Thunderbird, or your phone.

### 4.7 Send a test email

1. In the **DNS checklist** tab, in the **Test email** card, click **Send test email**.
2. Type an address of yours (a Gmail, for example) and click **Send**.

**What to check:** within a few seconds, **"Delivered to the recipient's server"** appears in green. Open the destination mailbox and also check the Spam
folder: on a new server, it is common for the first one to land there. Mark it as "not spam". If
the yellow "Deferred: Connection to … failed" appears, port 25 is
blocked ([4.1](#etapa-4)). If the red "Rejected: …" appears, the reason is whatever
the recipient replied (usually SPF, DKIM, DMARC, or the reverse name). See
[Email landing in spam](../guides/troubleshooting.md#e-mail-caindo-em-spam).

### 4.8 Webmail

1. In **Email**, in the **Webmail** card, click **Enable webmail**. The first time
   takes a while: the panel downloads the Roundcube image (a few hundred MB).
2. Click **Open webmail** next to `mail.send.example.com`.
3. Sign in with the mailbox's full address (e.g., `contato@send.example.com`) and its password.

**What to check:** `https://mail.send.example.com/` opens with a padlock and the sign-in screen in
Portuguese by default (webmail is Roundcube, which has its own language setting; it does not follow the panel's). Send an email to yourself and reply from there: the reply shows up in the webmail
Inbox. Forgot the mailbox password? **Mailboxes** tab → **Change password**.

**Security updates:** after you update the panel, the webmail is recreated automatically with the
fixed Roundcube version (a brief restart; preferences, contacts and display names are kept). You do
not need to disable and enable it again.

### 4.9 The Sending page

In the menu (arrow beside **Settings** → **Sending**), **Sending** shows what the email server is doing:

- **Queue now**: what is still being retried, with the reason for the last failure.
- **History**: delivered, rejected, deferred, and canceled over the last 30 days.
- **Volume**: chart of the last 14 days and the rejection rate.
- **Reputation**: blocklists, checked once a day and on the **Check now** button.
- **Score**: from 0 to 100, with what is done and what is
  missing.

**What to check:** in **History**, the test email appears as "Delivered". A new server
does not reach green on the score until it has been sending for about 30 days: this is on purpose.

**In the roadmap:** the **Server email** step shows as done once the server is
running and at least one domain has correct DNS.

<a id="etapa-5"></a>

## Step 5 — Notifications

Notices outside the panel when something needs attention: security alert, failed deploy,
certificate problem, email on a blocklist, disk above 90%, backups that failed or ran late. Without
this, alerts only appear inside the panel.

### 5.1 Telegram

1. In Telegram, search for **@BotFather** (with the blue verified badge) and open the chat.
2. Send `/newbot`. It asks for a name (e.g., "My panel notices") and then a @ username that ends in
   `bot` (e.g., `my_panel_notices_bot`).
3. It replies with the **token**, a line like `123456789:ABC…`. Copy the entire line.
4. In the panel, open **Settings → Notifications**. In the
   **Telegram** card, paste it into the **Bot token** field and click **Save token**. "Bot @… verified" should appear.
5. Click the **Open @…** link and, in Telegram, tap **Start** (or send
   `/start`).
6. Go back to the panel and click **Connect**. Check that the chat name shown is yours
   (or the group's).
7. Click **Send test**.

**What to check:** a "TWS Panel: Teste de notificação" message (Notification test) arrives in Telegram. The test message is written by the server and is still in Portuguese. In the panel, the badge turns to "Tested on…" and, under **Recent sends**, a "Teste de notificação" entry (also a server text) appears with the status **Sent**.

### 5.2 Email (optional)

Needs [Step 4](#etapa-4) done: server running and a domain with all DNS correct.

1. In **Settings → Notifications**, in the **Email** card, enter up to 5 addresses and click
   **Save addresses**.
2. Click **Send test**.

**What to check:** the message arrives in the mailbox. On the first send from a new server, it
tends to land in spam: mark it as "not spam".

### 5.3 What it notifies

In the **What to notify** card, choose the types. The default already turns on
everything that calls for action; "Panel restarted" starts off.

**In the roadmap:** the **Notifications** step shows as done once at least one
channel is connected and the test has been sent.

<a id="etapa-6"></a>

## Step 6 — Backups outside the VPS

The panel already keeps copies on the VPS itself, but they disappear along with the server if it is
lost, broken into, or wiped. With a copy outside, on Cloudflare R2, you can rebuild everything on a
new VPS.

### 6.1 Create the bucket and keys on Cloudflare R2

Cloudflare shows the names in English or Portuguese, depending on your account's language. Both are
given below (English / Portuguese), as on the panel's screen.

1. At dash.cloudflare.com, open **R2 Object Storage** / **Armazenamento de objetos R2**. The first
   time, enable R2 (it asks for a card; the free plan covers 10 GB per month).
2. Click **Create bucket** / **Criar bucket**, give it a name (e.g., `tws-backups`, only lowercase
   letters, numbers, and hyphens), and create it.
3. On the R2 page, on the right side, find **API Tokens** / **Tokens de API** and click **Manage** /
   **Gerenciar**. Then, **Create Account API token** / **Criar token de API da conta** (or the user
   one, if only that one appears).
4. In the form:
   - a name (e.g., `tws-panel-backups`);
   - under Permissions / Permissões: **Object Read & Write** / **Leitura e gravação de objetos**;
   - under Specify bucket(s) / Especificar bucket(s): **Apply to specific buckets only** / **Aplicar
     somente a buckets específicos**, and pick the bucket;
   - TTL: **Forever** / **Para sempre**.

   Confirm with the create-token button at the bottom of the page.
5. The next screen shows the keys **only once**. Copy:
   - the **Access Key ID** / **ID da chave de acesso**;
   - the **Secret Access Key** / **Chave de acesso secreta**;
   - the endpoint that ends in `.r2.cloudflarestorage.com`.

   The "Token value" / "Valor do token" is not used. Lost the endpoint? It is in the bucket →
   Settings / Configurações → S3 API.

### 6.2 Connect it in the panel

1. Open **Settings → Backups**. In the **External storage**
   (External storage) card, leave **Cloudflare R2** checked.
2. Paste the endpoint, the bucket, the Access Key ID, and the Secret Access Key. Region: `auto`.
3. Click **Test and save**. Before saving, the panel writes, reads, and deletes a
   test file in the bucket.

**What to check:** "Connection tested and saved" appears, along with the
"Tested on…" badge. If it fails, nothing is saved and the screen explains the reason (key
rejected, bucket does not exist, no response).

### 6.3 Encryption and recovery kit

The external copy goes encrypted with a password of yours. **Without this password, nobody, not
even TWS, can open your backups.**

1. In the **External copy encryption** card, create the password (minimum of 12 characters) or
   click **Suggest a strong passphrase**.
2. Click **Download recovery kit** and store the file **outside the
   VPS**. It contains the password, where the backups are kept, and how to restore.
3. Check **I've stored the password somewhere safe** and click
   **Turn on encryption**.

**What to check:** the card shows **On (AES-256)**.

### 6.4 First backup

1. In the **Panel** card, click **Back up now**.
2. Do the same in the **Email** card, if you turned on email in [Step 4](#etapa-4).

**Reusing a bucket from an old panel?** The Dashboard warns that the storage already holds backups from
another panel. If you want to continue the old panel, restore it first (restore guide). If this is a
new panel, the manual backup above is not blocked and can be the first one. From the first backup on, the
retention deletes the oldest copies in the folder (it keeps only the newest ones; the default is 5),
including the old panel's: to keep them, download them before making the first backup or use another
bucket or folder.

**What to check:**

- in **Latest backups**, the line ends with **"on the VPS · external copy verified"**: the panel downloaded the copy back and
  checked it before calling it done;
- on Cloudflare, under R2 → `tws-backups`, the folder `TWS Panel Backups/_painel/` appears with the
  `.7z` file;
- on the Dashboard, the **Off-VPS backups** step shows as done.

### 6.5 Test the password

In the **External copy encryption** card, type the kit's password and click **Test my password**.

**What to check:** the answer starts with "Senha certa" (Correct password; this reply comes from the server and is still in Portuguese). Every 90 days without a test, the
panel reminds you to repeat this.

### 6.6 Schedule

In the **Panel** and **Email** cards, choose the frequency (once a day, every 12 hours, or every
6 hours) and how many copies to keep on the VPS and outside. **The base time is 03:00 in the VPS
time zone** (see [Step 3](#etapa-3)).

Projects have their own settings. In the **Project defaults** card, choose
the same for projects: on or off, frequency, and copies.

1. Adjust the fields. The sentence below shows how many days the backups cover.
2. Under **Also apply to these projects**, check the projects that already exist (or **Select all**).
3. Click **Save**.

**What to check:** each project in the list shows "follows the default". A new project is born with the default. Each project's databases and folders stay in its
**Backups** tab ([Step 7](#etapa-7)).

Details on what is included, where it is kept, and how to restore on a new VPS:
[Features → Backups](../guides/features.md#backups).

<a id="etapa-7"></a>

## Step 7 — First project

### 7.1 Connect GitHub (optional)

To pick the repository from a list, instead of pasting the URL: open **Settings → Integrations**, paste a **GitHub token (read-only)**, and click **Connect**. The screen teaches you how to generate the token. A
token with write permission is rejected.

**What to check:** the screen shows "Connected as …".

### 7.2 Create the project

In the menu, click **New project**. There are three steps:

1. **Code source**.
   - Give it a **Project name**.
   - Choose **Git repository** and paste the **Repository URL**, or click **Choose from my repositories** (with GitHub
     connected).
   - Check the **Branch**.
   - Private repository without the account connected? Check **Private repository** and paste a **Read token** (the screen teaches you how to
     generate it, with the `Contents: Read` permission for that repository only).
   - Before creating, click **Test access**, next to the token field. The panel only queries the
     repository (it does not create the project or store the token) and tells you, in plain words, whether it can
     read it: **Access confirmed** (with the default branch and the first branches), invalid or expired
     token, token without read permission, repository not found, branch that does not exist,
     unreachable server, or timeout. The same button appears when you pick a private repository of the
     connected GitHub account from the list (it tests with the account's token). The test never follows redirects (so the credential is not sent to another address and internal destinations are not queried), while the deploy does follow redirects, but the saved token is only sent to the host of the project address and never without encryption (a repository moved to another host, or redirecting from https to http, needs the final https address). If the test says the address redirects, use the final address, for example with `.git` at the end (GitLab redirects when it is missing). The test does not query addresses of the machine itself (`localhost`, `127.x`, `169.254.x`). Changed the URL, the
     branch, or the token? The old result disappears and you need to test again.
   - Click **Create and detect**.
2. **Automatic detection**. The panel works out the type: plain HTML, project
   with a build, `Dockerfile`, or `docker-compose`. A compose file is adopted as is, without being
   rewritten, and the screen shows which service and port HTTP arrives on.
3. **Domain and creation**.
   - **Automatic address**: works right away, with HTTPS. Without an apps domain, it is
     `minha-app.203-0-113-10.sslip.io`, and the screen shows an amber notice: "This address contains
     the VPS IP. Use it to test; to publish, use your own domain or subdomain." (it is not an error).
     With the [apps domain](#dominio-de-aplicacoes), it is `minha-app-k3x9q.apps.example.com`, with no
     IP and no notice.
   - **Test address**: only appears once the apps domain is set up. It is the sslip.io address, with
     the notice. Use it to test.
   - **My domain or subdomain**: type the domain and create, in your
     DNS, the record the screen shows (type A pointing to the VPS IP, gray cloud on Cloudflare). If you
     type `example.com`, the screen also shows `www.example.com` (and the other way round): create
     both records, with `@` and `www` in the name field. The other name only sends visitors to the one
     you typed; untick the box if you don't want it. You can create the project before the DNS
     propagates.
   - Check **Project uses WebSocket / long-lived connections** if that applies.
   - Leave **Back up** on **Yes**.
   - Click **Create project**.

**What to check:** the project page opens, with the menu Overview, Deploys, Domains, Git, Variables, Email, Backups, and Settings.

### 7.3 Variables

Open the **Variables** tab. The screen lists the variables the compose file asks for and suggests
the names from the repository's `.env.example`, still without values.

1. Have the `.env` on your computer? Click **Import .env file**. Nothing is
   saved yet: review it.
2. Fill in what is missing (or use **Add variable**).
3. Click **Save variables**.

> [!TIP]
> A variable whose name ends in `_HOST`, `_HOSTNAME`, or `_DOMAIN` (such as `SITE_HOST`) usually
> expects just the domain name, without `http://`, a trailing slash, a path, a port, or a space. If the
> value has any of them, the row gets an amber warning with the suggested value and a **Fix** button.
> It is only a warning: it does not block saving, and the deploy log repeats the note (without showing
> the value of a variable that looks like a secret). `_URL` variables are not affected.

> [!NOTE]
> If the repository already has its own `.env`, the panel does not overwrite it. The variables you
> set here go to a separate file (`paas.env`, in the project folder on the VPS), and the deploy
> log warns about the conflict and how to make the container receive them.

**What to check:** no warning about a missing required variable. The deploy is blocked when a
required one is missing; the `.env.example` ones without a value only raise a warning.

### 7.4 Project email

Needs [Step 4](#etapa-4) done.

1. Open the project's **Email** tab and choose the **Email domain**.
2. Check the **Sender address** (e.g., `contato@send.example.com`) and the
   **Display name**.
3. Set the mailbox password (type it twice or generate a strong one). The generated one is shown
   only once.
4. Click **Enable email**.
5. If your app uses other variable names (e.g., `SMTP_SENHA`, `EMAIL_DE`), click **Link to project variables** and, on each row, choose the name the
   app reads. The panel supplies the current value under that name on every deploy.

**What to check:** the card shows `SMTP_HOST = mail.send.example.com`. The `SMTP_*` and `MAIL_*`
values go into the deploy automatically. The values only reach the app on the next deploy.

**Display name.** It is optional (up to 80 characters; no line breaks, `<`, `>`, quotes or
backslashes). Empty, the project name is used. It is what recipients see next to the address, and it
is delivered to the app as `MAIL_FROM_NAME`: the From the app uses is `MAIL_FROM_NAME` with
`MAIL_FROM`. To change it later, open the project's **Mailboxes** tab and use **Change display name**
on the mailbox (the password, 2FA and messages do not change); the change reaches the app on the next
deploy. The project's other mailboxes and those on the **Email** page also accept a name when created.

**Using a mailbox that already exists.** If the mailbox was already created (for example, set up in webmail), in step 2 choose
**Use a mailbox that already exists**, pick the mailbox from the list and decide on the password:

- **Enter the mailbox's current password:** the panel checks the password without trying to sign in to the mailbox.
  If the mail server does not allow checking (app passwords and two-step verification share the same field), the panel does not accept the password: use the option to replace it with a generated one.
- **Keep the password the panel already stores** (shown when it knows it).
- **Replace this mailbox's password with one generated by the panel:** apps, phones and webmail that use the old password
  must be updated. The mailbox's app passwords and two-step verification are kept.

Nothing is deleted: the mailbox and its messages stay. Once connected, the mailbox is managed by the panel
(**Sync** and the email restore keep it on the stored password): do not change its password directly in
webmail, use **Change password** on the card. **Disable email** releases a mailbox that already existed: it keeps its messages and goes back to being a regular mailbox. A mailbox the panel created for a project stays that project's, even when disabled. Other projects' mailboxes (those their email uses and those created for them) and the panel's own (`postmaster@`,
`abuse@`, `dmarc@`) are left out of the list.

**Deleting the project** releases its email, but does not delete the mailbox or its messages. When you recreate the
project, the same address is free again and the mailbox can be used again.

### 7.5 Ports (only if you need to)

In the **Overview**, in the Containers card, the **Ports** button opens two tabs:

- **This project**: change the published port, **Publish a port**, remove the publication, or **Edit in bulk**. The change applies on the
  next deploy.
- **All projects**: the ports in use on the server, with conflicts in red.

Most projects don't need this: the site opens through the domain, via the proxy. If you choose "On all addresses (0.0.0.0)", the port is open to the internet.

### 7.6 Deploy and logs

1. Click **Deploy**, at the top of the project page.
2. Follow the live log. If a compose deploy fails, the log gets a block titled "Por que falhou" (Why it
   failed; written by the server, still in Portuguese), with the last lines from the service that went unhealthy.

**What to check:** the deploy ends as **success** and the project's address opens the
site. In the **Deploys** tab you will find the **Deploy history**. If a
guardrail blocked the deploy (e.g., an exposed database port), the screen says which rule; see
[Deploy blocked by a guardrail](../guides/troubleshooting.md#deploy-bloqueado-por-guardrail)
and [Writing a compose the panel accepts](../guides/compose-rules.md).

### 7.7 Certificate

In the **Domains** tab, each of the project's domains shows its HTTPS certificate state. The
**Certificates** page (arrow beside **Settings** → **Certificates**) lists all of them (panel, projects, and email).

**What to check:** the project's domain is **Valid**. If it failed, the **Certificates**
page explains the likely cause (DNS not pointing to the VPS, orange cloud, ports 80/443 closed) and
has the **Try issuing now** button.

### 7.8 The project's Backups tab

After the first deploy that succeeds, the panel looks at the containers and suggests what to keep.

1. Open the project's **Backups** tab.
2. Check **Databases** (PostgreSQL, MySQL, MariaDB, and MongoDB come checked;
   Redis comes unchecked, because it is usually a cache) and **Volumes and folders** (uploads and data checked; caches, logs, and `node_modules` unchecked).
3. If the orange notice about **Files written outside a volume**
   appears, read it: they vanish on the next deploy. The notice does not count what Docker itself
   creates (such as `docker-init` or the folder of a mounted file).
4. Click **Save items**.
5. Under **Frequency and copies**, the badge says **Following the panel default**. Changing and saving there moves the project to
   **Custom settings**; **Back to default** undoes it.
6. Click **Back up now**.

**What to check:** the project's history shows the backup completed, with "external copy verified". On Cloudflare, the folder `TWS Panel Backups/<project-name>/` appears.

<a id="etapa-8"></a>

## Step 8 — Test a restore (recommended)

A backup that has never been restored is a promise. Test now, with test data, while nothing depends
on it.

> [!WARNING]
> **Restoring overwrites the project's data with that of the chosen backup.** Databases and folders
> go back to the state of that date, and everything written afterward is lost. The app is stopped
> during the restore. Do the test on a project with no real data, or at a moment when losing what
> was written after the backup doesn't matter.

1. **Make a backup.** In the project's **Backups** tab, click **Back up now** and wait for it
   to complete.
2. **Change something.** In the app, create a test record, delete another, or upload a file. Note
   what changed.
3. **Restore.** In the same tab, click **Restore**.
   - Under **Choose a date**, pick the backup from step 1.
   - Under **Use the copy**, choose **from the VPS (faster)** or **from external storage**. Testing the external one also proves the
     password and R2.
   - To confirm, type the project name and click **Restore**.
4. Follow the stages in the window. You can close it: the restore continues on the server.

**What to check:** the app comes back up, and what you changed in step 2 is back to how it was in
the backup (the record you created is gone, the deleted one is back). The restore appears in
**Latest backups**, in **Settings → Backups**.

Lost the entire VPS? The path is different: install the panel on a new VPS and use **Settings
→ Backups → Restore from another server**. The step-by-step is in
[Restore on a new VPS](../guides/restore-new-server.md).

<a id="etapa-9"></a>

## Step 9 — Maintenance

### Update the panel

A single line, on the VPS:

```bash
cd /opt/tws-panel && sudo git pull && sudo git log --oneline -1 && sudo docker compose up -d --build
```

**What to check:** `git log --oneline -1` shows the commit that is now live. Your projects,
domains, email, and account stay as they were. What changed in each version is in the
[CHANGELOG](https://github.com/kelvindk9w/tws-panel/blob/main/CHANGELOG.md). More commands in [Operations](../guides/operations.md).

### Update Docker

The hardening leaves Docker out of the automatic updates, on purpose. From time to time,
**over SSH** (not through the panel's terminal):

```bash
sudo apt-get update && sudo apt-get install --only-upgrade docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

The panel goes down for a few seconds and comes back by itself. The reason is explained in the
[Security wizard](security-wizard.md#as-oito-fases).

### Where to keep an eye on things

- **Alerts** (menu): the alert center, with what monitoring found. Filter by status
  (open, acknowledged).
- **Audit log** (menu **Settings**, arrow beside it): sensitive actions, with when, action, target, and detail.
- **Security** (menu): VPS protections, baseline snapshot, monitoring, and email
  reputation.
- **Certificates** and **Sending** (menu **Settings**, arrow beside it): certificates and email.
- Telegram or the email from [Step 5](#etapa-5), when the panel is closed.

### If you lose access

Panel password, two-factor authentication phone, Linux password, SSH key, or panel domain: each case
has its own way back in **[I lost access: now what?](../guides/recover-access.md)**.
The emergency commands are in
[Operations → Emergency scripts](../guides/operations.md#scripts-de-emergência).

<a id="checklist"></a>

## Final checklist: panel ready

- [ ] VPS with Ubuntu 22.04/24.04, ports 80 and 443 open, and the provider's console checked
- [ ] Panel installed and the wizard completed (administrator account created)
- [ ] All 8 security phases applied and confirmed, and the VPS rebooted afterward
- [ ] Two-factor authentication on and recovery codes stored
- [ ] Panel domain with a valid certificate (and, if you want, access by IP turned off, with the way-back command written down)
- [ ] (Optional) Apps domain verified, so projects do not show the VPS IP in their address
- [ ] VPS time zone checked (backups at 03:00 your time)
- [ ] Email: port 25 unblocked, DNS checklist 6/6 OK, PTR green or blue, and certificate valid
- [ ] Mailbox created, test email delivered, and webmail opening
- [ ] Notifications: Telegram (or email) connected and test received
- [ ] Backups: R2 connected, encryption on, recovery kit stored outside the VPS
- [ ] First panel backup with "external copy verified" and "Senha certa" (server message) on Test my password
- [ ] First project live, with variables, project email, and a valid certificate
- [ ] Project Backups tab checked and a project backup made
- [ ] A test restore done and verified
- [ ] Panel update command written down
- [ ] **Get the panel ready** roadmap on the Dashboard fully done (or with "I won't use this" on the optional ones you skipped)
