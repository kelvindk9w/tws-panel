---
title: "Troubleshooting"
description: "Fixes for common problems: blocked port 25, email in spam, certificates that do not issue, a panel that does not open, lost SSH access and blocked deploys."
sidebar:
  label: "Troubleshooting"
---

Likely problems when running TWS Panel on a real VPS, and how to fix each one.

> [!NOTE]
> **Interface language.** The panel is available in English and Portuguese ([how to choose](../getting-started/complete-guide.md#idioma-da-interface)). This page quotes the English labels exactly as they appear on screen. Some messages that come from the server still appear in Portuguese in both languages: DNS-check and certificate messages, mail server status, alerts and audit details, and many error messages. Whenever this page quotes one of them, it says so.

---

## Email

<a id="porta-25-bloqueada-pelo-provedor"></a>
### Port 25 blocked by the provider

**Symptoms:** you send and receive email internally, but no message from outside arrives;
connection tests on port 25 fail (`telnet YOUR-IP 25` hangs).

**Cause:** many providers (Hetzner, AWS, OCI, new accounts in general) block port 25
outbound/inbound by default as an anti-spam measure.

**Solution:**
1. Open a ticket with the provider asking for port 25 to be unblocked (some have an option in the dashboard);
2. Check UFW: `sudo ufw allow 25/tcp`;
3. Verify from the outside: `nc -zv YOUR-IP 25`.

<a id="e-mail-caindo-em-spam"></a>
### Email landing in spam

**Symptoms:** sent messages arrive, but go straight to the spam folder (especially
Gmail and Outlook).

**Diagnosis (in this order):**
1. Send to [mail-tester.com](https://www.mail-tester.com) — it points out exactly what
   is missing. Target: ≥ 9/10.
2. Open the domain's **DNS checklist** in the panel and click **Verify now**: A, MX, SPF, DKIM and
   DMARC must all be ✅.
3. **Yellow PTR** (no valid reverse name) is the most common cause: only the VPS provider sets it. The
   PTR card says where to change it (Contabo, Hetzner, Vultr) or generates the ready-made ticket text.
4. Check the **blocklists** in the panel (**Sending → Reputation**). If you're listed, use
   **Request removal** on the corresponding list.
5. Look at the deliverability score in **Sending → Score**: it lists what is missing, item by item.
6. **New IP with no reputation**: in the first 2–4 weeks send a low volume and raise it gradually
   (dozens a day, not thousands). See "IP warm-up" in
   [email-deliverability.md](https://github.com/kelvindk9w/tws-panel/blob/main/docs/internal/email-deliverability.md).
7. Keep DMARC at `p=none` collecting reports until everything stabilizes; tighten to
   `quarantine`/`reject` later.

### Invalid Stalwart TLS certificate

**Symptoms:** email clients warn "untrusted certificate" when connecting.

**Cause:** the certificate for `mail.<domain>` has not been issued yet — in the meantime
Stalwart uses a self-signed one. Almost always the A record for `mail.<domain>` is missing
or is not pointing to the VPS, or it has the orange cloud on Cloudflare.

**Solution:** open **Email** in the panel: the **Mail server certificate** card says what
is missing. Create the A record for `mail.<domain>` with the VPS IP (on Cloudflare, **grey**
cloud), check that ports 80 and 443 are open, and click "Check again". The panel
installs and renews the certificate on its own.

---

## Domains and SSL

### Caddy does not issue a certificate

**Symptoms:** site up only over HTTP, ACME error in the `paas-caddy` container logs
(`docker logs paas-caddy`).

**Cause:** the domain's A record does not point to the VPS yet (or propagation has not finished).

**Solution:**
1. Use the **Verify DNS** button in the panel before issuing the certificate;
2. Check manually: `dig +short yourdomain.com` should return the VPS IP;
3. If you just created the record, wait for propagation (minutes to hours, depending on the TTL);
4. If there is a proxy in front (e.g. Cloudflare with the orange cloud), turn it off for the initial
   issuance. The panel has no DNS-01 mode: the central Caddy expects a direct connection on ports 80/443.
   After the certificate is issued, use **Try issuing now** on the **Certificates** page if it is still pending;
5. Check that UFW/the provider's firewall allows 80 and 443.

### The site opens without www but not with www (or the other way round)

**Symptom:** `example.com` opens and `www.example.com` shows a connection error (or the reverse). On the
project's **Domains** page, the pair's row says "waiting for DNS".

**Cause:** each name needs its own DNS record. The panel only requests the pair's certificate (and turns
on the redirect to the main name) once its DNS points to the VPS; until then, the name does not answer.

**Fix:**
1. Under **Domains → Connect new domain**, type the name and read the guide: one record per name (`@`
   and `www`, type A with the VPS IP; `www` can also be a CNAME to the bare domain).
2. On Cloudflare, keep the cloud **gray** on both. With orange, the pair's row says the proxy is on and
   the certificate is not issued.
3. Click **Verify DNS**: the result comes name by name. A failing pair is only a warning.
4. If the row says "already belongs to another project", "belongs to the panel" or "belongs to the mail
   server", the panel never takes the name: use the other project or remove the name there.
5. If you don't want the redirect, click **Turn off** on the pair's row.

**Known limits (documented, not implemented):** the pair's DNS check only reads A records (IPv4); an AAAA
record pointing elsewhere is not detected. After a panel restart with no DNS answer, a pair that was
redirecting is only kept once the first check answers; until then it is not rebuilt.

<a id="verificacao-do-dominio-de-aplicacoes"></a>

### The apps domain check fails

**Symptoms:** in **Settings → Apps domain**, **Verify DNS and save** shows "Not saved" and a message
from the server, in Portuguese even with the interface in English.

**Causes and solutions:**

- **Only the exact-name record exists** (`apps.example.com`). The check queries a random name
  (`paas-check-…apps.example.com`), so only a **wildcard** record (`*.apps`) passes. Create the
  record named `*.apps` (or `*.apps.example.com`, depending on the provider).
- **Cloudflare orange cloud:** the message mentions the "proxy da Cloudflare" (Cloudflare proxy).
  Switch the wildcard record to the gray cloud ("DNS only"). Behind the proxy, each project's certificate cannot be issued.
- **Wrong IP, or more than one A record:** leave only the VPS IP.
- **AAAA record pointing elsewhere:** delete the wildcard AAAA (or point it at the VPS IPv6, if the
  panel knows it).
- **"O DNS não respondeu agora" (the DNS did not answer now):** nothing was saved and nothing changed;
  try again in a moment.
- **You just created the record:** wait for propagation (minutes to hours) and verify again.
- Check from outside: `dig +short anything.apps.example.com` should return the VPS IP.

<a id="limite-do-lets-encrypt"></a>

### A project certificate is not issued (Let's Encrypt limit)

**Symptoms:** the browser shows a certificate error when opening the project (Caddy redirects HTTP to
HTTPS), and the **Certificates** page shows the domain as "Failed".

**Cause:** Let's Encrypt limits you to **50 new certificates per week per registered domain** (for
`projeto-k3x9q.apps.example.com`, the registered domain is `example.com`) and to 5 identical
certificates per week. Creating and deleting many projects within a few days uses up the limit of 50.
The limit on identical certificates only affects an own domain (repeating the same name): each address
under the apps domain gets a new suffix on every creation.

**Solution:**
1. Open **Certificates** and read the cause the panel shows (a server message, in Portuguese).
2. If it is the limit, wait: it comes back little by little over the week. The panel cannot get around it.
3. Then click **Try issuing now**. Meanwhile the panel keeps retrying on its own, with growing intervals.
4. To avoid using up the limit for nothing, do not delete and recreate projects several times. In the
   wizard, the project is created with a provisional address (`name-xxxxx.localhost`, unique, no IP and no public certificate) and only switches to the address under the base
   when you click **Create project**.

5. To avoid spending the limit when restoring onto a new VPS, restore the panel's **encrypted external
   copy**: it carries Caddy's certificates and Let's Encrypt account (see
   [Restore on a new server](restore-new-server.md)).

### I got the alert "Certificate of ... did not renew" or "issuance failing repeatedly"

**Symptoms:** an alert (and a Telegram or email notification) says the automatic certificate of a name
did not renew, is about to expire, or that Caddy keeps trying to issue it and failing.

**Cause:** Let's Encrypt no longer sends expiry emails, so the panel checks by itself every 30 minutes.
The alert shows up when Caddy should have renewed and did not (1/4 of the validity is left), or when the
log shows 3 or more failed rounds over at least 1 hour. The most common cause is the name's DNS no longer
pointing to the VPS, Cloudflare's orange cloud, or ports 80 and 443 closed.

**Solution:**
1. Open **Certificates**: the name's card shows the alert state and the translated cause, with what to do.
2. Fix the cause (DNS, grey cloud, ports) and click **Try issuing now**.
3. The alert clears by itself after two checks in a row without a problem (about 1 hour). If you already
   acknowledged it, it does not come back while the problem lasts.

### Project with a provisional address (`name-xxxxx.localhost`)

**Symptoms:** the project shows an amber "Provisional address" notice and the `name-xxxxx.localhost` address does not open.

**Cause:** the wizard creates the project with this provisional address and only replaces it when you click
**Create project**. If you closed the wizard before that, the project kept it. `.localhost` always points to the
computer of whoever is browsing, not to the VPS, so it does not work on a public panel.

**Solution:** open the project, go to **Domains** (the notice has a shortcut) and change the address:
- with the apps domain set up, click **Use the automatic address (…)**: the panel adds the address under the
  base, makes it primary and removes the provisional one (if something fails, click again and it continues where
  it stopped);
- without the apps domain, the screen explains the ways out: **Set up the apps domain** (in Settings) or
  **Connect a new domain** with a domain of your own.

Do not edit `/etc/hosts`: it will not make the
VPS site appear.

### `.localhost` domain does not open (panel on your machine)

**Symptoms:** `meuapp.localhost` does not resolve in the browser, with the panel running on your own computer.

**Solution:** `.localhost` depends on the operating system resolving to 127.0.0.1 — it works
natively on modern Linux/macOS and in Chrome; if it fails, add this to `/etc/hosts`:
`127.0.0.1 meuapp.localhost`. This applies only to a local panel. In dev, remember that `.localhost` is served over **plain HTTP**.

---

## Panel and wizard

### Panel does not open after `install.sh`

**Symptoms:** the address `https://YOUR-IP-WITH-HYPHENS.sslip.io/?token=...` does not open, or the
installer warns that it did not respond within 3 minutes.

**Checklist (on the VPS, in `/opt/tws-panel`):**
1. Are the containers up? `sudo docker compose ps`;
2. Did the certificate get issued? The most common cause is ports **80 and 443 blocked** in a
   provider firewall (in the hosting dashboard): open both and run `sudo docker compose restart`. To
   see what the proxy says: `sudo docker logs paas-caddy --tail 50`;
3. In the meantime, SSH tunnel access works: the installer banner shows the command
   (see [SSH tunnel access](../getting-started/installation.md#acesso-por-tunel));
4. Right token? Show the full link again with `sudo ./scripts/show-token.sh`.

The panel itself only listens inside the VPS (`127.0.0.1`): the address `http://YOUR-IP:9000` does not open,
on purpose.

### Saving or clicking fails with `403 forbidden_origin`

**Symptoms:** the panel opens, but actions that write (save, sign in, deploy) return
`403 forbidden_origin`. It happens when you open the panel behind **another proxy** (a load balancer,
a tunnel, a CDN) that removes the `Sec-Fetch-Site` header or rewrites `Origin`. Behind the Caddy
that the panel installs, nothing needs to be configured.

**Fix (on the VPS, in `/opt/tws-panel`):**
1. Add to the `.env` the exact origin where you open the panel, with no slash at the end; separate
   several with commas. Do not use `*`:

   ```
   ALLOWED_ORIGINS=https://panel.example.com
   ```

2. Recreate the container so it reads the variable:

   ```bash
   sudo docker compose up -d
   ```

The variable is empty by default, and then only the panel's own origin is accepted.

### "Invalid token" in the wizard

**Symptom:** the wizard says "Invalid token. Check the value the installer printed in the terminal."

**Cause:** wrong token, copied with an extra space, or the server was restarted with a different
`SETUP_TOKEN` in the environment.

**Solution:** the `/data/setup-token` file (`paas_data` volume) takes priority over the
`SETUP_TOKEN` environment variable, which is only the installation's starting point. Show the URL + token again with
`sudo ./scripts/show-token.sh` (it reads the volume, without reinstalling anything). When the wizard is completed the token is
deleted on purpose; to reopen the wizard and generate a new token, run
`sudo ./scripts/reset-setup.sh` (or `--full`, which also deletes the administrator account).

### I lost the token / I want to restart the wizard from scratch

- **Lost the token:** `sudo ./scripts/show-token.sh` — prints the banner with the URL and token.
- **Restart the wizard:** `sudo ./scripts/reset-setup.sh` — deletes `setup-state.json` from the volume
  (with interactive confirmation) and the wizard goes back to step 0; the admin account is kept.
  With `--full` it also deletes `users.json` and `sessions.json` (the admin account ceases to exist
  and everyone is signed out). Both modes generate a NEW setup token (the old one stops working; see it with
  `show-token.sh`). Projects, domains and email are NOT touched.

### I lost SSH access during hardening

**Do not panic — that's what the rollback is for.** Hardening schedules an automatic revert
(via `at`) that restores the previous configuration in ~5 minutes **if you do not confirm access**
through the panel. Wait for the rollback, sign in again and review the fix plan before reapplying.
Every changed file has a backup in `/var/backups/paas/`.
Lost the key, the password or the phone for two-factor authentication? See
[I lost access: now what?](recover-access.md).

<a id="deploy-bloqueado-por-guardrail"></a>
### Deploy blocked by guardrail

**Symptoms:** deploy returns `409 guardrail_blocked` and the UI opens the blockers modal.

**Solution:** the modal lists each violation with **evidence** (file:service) and a **suggested
fix**. Fix the compose/code (recommended) — e.g. remove the database port published on the
host, replace weak credentials. If you are sure of the risk (e.g. a database exposed only in a
staging environment), check **I understand the risks and want to deploy anyway (override)** and confirm the override — it is **audited** under
**Audit log** (`guardrail.override`). Four rules protect the panel itself and accept no override
(`panel-resource`, `network-hijack`, `reserved-name`, `panel-image`): the compose has to change.
What each rule blocks, how to read the message and before/after examples are in
[Writing a compose the panel accepts](compose-rules.md).

---

### "You have to authenticate first" in the mail server after a restore

The panel's saved mail server admin password and the one in the running mail server's
configuration differ (it happens after restoring the panel or the email). The panel checks this
after a restore and tries to fix it, and **Sync with the mail server** also tries the repair once
before showing an error. If you still see "O painel não conseguiu autenticar no servidor de
e-mail" (a server message), click **Repair now** (on the **Email** screen itself, next to the
message, or in the amber notice on the Dashboard), or stop the mail server and start it again in
**Email**. No data is deleted. Details in
[Restore on a new server](restore-new-server.md#if-something-fails).

### "535 5.7.8 Authentication credentials invalid" on the email notification test

The mail server refused the login of the `postmaster@` mailbox because the password the panel stored is not the one the server has (it happens after restoring the email: the mailbox comes back with the backup's password). The panel says "the password stored by the panel is not the server's" (in Portuguese, the language of the server messages) and, in **Settings → Notifications**, shows the **Open Email to sync** button. In **Email**, click **Sync with the mail server**: it checks and reapplies the password the panel stores for `postmaster@` and for project mailboxes (the notice says "Realinhei a senha de N caixas", meaning it realigned N mailboxes). Alternatively, use **Change password** on the domain's `postmaster@` mailbox. Only the passwords that differ are rewritten. Note: the password of a **project** mailbox (or of `postmaster@`) changed directly in webmail is undone by this step; regular user mailboxes are not touched. Then send the test again. Details in [Restore on a new server](restore-new-server.md#if-something-fails).

## Docker

### "Cannot connect to the Docker daemon"

**Solution:** `systemctl status docker` — if `install.sh` just installed it, you may need
`sudo systemctl enable --now docker`. The panel only accesses the local socket
(`/var/run/docker.sock`); never expose Docker over TCP.

### Checking that a project came back fine after restarting the VPS

Open the project and go to the **Logs** tab. At the top, each service shows whether it is
**running**, whether it is **healthy**, how many **restarts** it had and since when it has been up.
A service "restarting in a loop" or "unhealthy" is the one that needs attention: pick it in the
**Service** selector and read the last lines (error lines are marked). If the tab says the project
is **stopped**, use **Start** at the top of the project page. If it says **Docker is not
responding**, the problem is the machine, not the project: check `systemctl status docker` on the
VPS.

### The Dashboard says "Monitoring in reduced mode" or shows "No data"

- **"Reduced mode"**: the panel container was created before the update that added the host mounts (`/proc` and
  `/sys/fs/cgroup`, read-only). Recreate it: `cd /opt/tws-panel && sudo git pull && sudo docker compose up -d --build`
  (a `docker restart` does not pick up mounts). Check with `sudo docker inspect tws-panel --format '{{json .Mounts}}'`.
- **"No data" right after the update**: the first measurement takes about 1 minute; rates (CPU, network, disk) need two
  readings, so they appear from the second minute.
- **"The last write of the measurements failed"**: check the VPS free disk space (`df -h`); the panel never stops
  because of this, it just keeps no history until there is room.
- **Provider "steal" always at 0**: normal on some virtualization types that do not report it; it is not an error.

---

## Didn't find your problem?

Open an issue in the repository using the bug template — include logs (without secrets), the commit
you are running and the environment. See [CONTRIBUTING.md](https://github.com/kelvindk9w/tws-panel/blob/main/CONTRIBUTING.md).
