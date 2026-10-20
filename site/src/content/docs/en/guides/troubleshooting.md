---
title: "Troubleshooting"
description: "Fixes for common problems: blocked port 25, email in spam, certificates that do not issue, a panel that does not open, lost SSH access and blocked deploys."
sidebar:
  label: "Troubleshooting"
---

Likely problems when running TWS Panel on a real VPS, and how to fix each one.

> [!NOTE]
> **The panel interface is being translated.** For now, screen names, buttons and messages appear in Portuguese, exactly as on screen, followed by the English meaning in parentheses. They may change when the English interface is released.

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
2. Open the domain's **DNS checklist** in the panel and click "verificar" (verify): A, MX, SPF, DKIM and
   DMARC must all be ✅.
3. **Yellow PTR** (no valid reverse name) is the #1 cause: only the VPS provider sets it. The
   PTR card says where to change it (Contabo, Hetzner, Vultr) or generates the ready-made ticket text.
4. Check the **blocklists** in the panel (Envios → Reputação — Sending → Reputation). If you're listed, use
   "Pedir remoção" (Request removal) on the corresponding list.
5. Look at the **Nota de entregabilidade** (Deliverability score) (Envios → Nota — Sending → Score): it lists what is missing, item by item.
6. **New IP with no reputation**: in the first 2–4 weeks send low, growing volume
   (dozens/day, not thousands). See "IP warm-up" in
   [email-deliverability.md](https://github.com/kelvindk9w/tws-panel/blob/main/docs/internal/email-deliverability.md).
7. Keep DMARC at `p=none` collecting reports until everything stabilizes; tighten to
   `quarantine`/`reject` later.

### Invalid Stalwart TLS certificate

**Symptoms:** email clients warn "untrusted certificate" when connecting.

**Cause:** the certificate for `mail.<domain>` hasn't been issued yet — in the meantime
Stalwart uses a self-signed one. Almost always the A record for `mail.<domain>` is missing
or isn't pointing to the VPS, or it has the orange cloud on Cloudflare.

**Solution:** open **E-mail** (Email) in the panel: the "Certificado do servidor de e-mail" (Email server certificate) card says what
is missing. Create the A record for `mail.<domain>` with the VPS IP (on Cloudflare, **grey**
cloud), check that ports 80 and 443 are open, and click "Conferir de novo" (Check again). The panel
installs and renews the certificate on its own.

---

## Domains and SSL

### Caddy does not issue a certificate

**Symptoms:** site up only over HTTP, ACME error in the `paas-caddy` container logs
(`docker logs paas-caddy`).

**Cause:** the domain's A record doesn't point to the VPS yet (or propagation hasn't finished).

**Solution:**
1. Use the **"verificar DNS"** (verify DNS) button in the panel before issuing the certificate;
2. Check manually: `dig +short yourdomain.com` should return the VPS IP;
3. If you just created the record, wait for propagation (minutes to hours, depending on the TTL);
4. If there is a proxy in front (e.g. Cloudflare with the orange cloud), turn it off for the initial
   issuance or use DNS-01 mode — the central Caddy expects a direct connection on ports 80/443;
5. Check that UFW/the provider's firewall allows 80 and 443.

### `.localhost` domain doesn't open

**Symptoms:** `meuapp.localhost` doesn't resolve in the browser.

**Solution:** `.localhost` depends on the operating system resolving to 127.0.0.1 — it works
natively on modern Linux/macOS and in Chrome; if it fails, add this to `/etc/hosts`:
`127.0.0.1 meuapp.localhost`. In dev, remember that `.localhost` is served over **plain HTTP**.

---

## Panel and wizard

### Panel doesn't open after `install.sh`

**Symptoms:** the address `https://YOUR-IP-WITH-HYPHENS.sslip.io/?token=...` doesn't open, or the
installer warns that it didn't respond within 3 minutes.

**Checklist (on the VPS, in `/opt/tws-panel`):**
1. Are the containers up? `sudo docker compose ps`;
2. Did the certificate get issued? The most common cause is ports **80 and 443 blocked** in a
   provider firewall (in the hosting dashboard): open both and run `sudo docker compose restart`. To
   see what the proxy says: `sudo docker logs paas-caddy --tail 50`;
3. In the meantime, SSH tunnel access works: the installer banner shows the command
   (see [SSH tunnel access](../getting-started/installation.md#acesso-por-tunel));
4. Right token? Show the full link again with `sudo ./scripts/show-token.sh`.

The panel itself only listens inside the VPS (`127.0.0.1`): the address `http://YOUR-IP:9000` doesn't open,
on purpose.

### "Token inválido" (invalid token) in the wizard

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
  and everyone is logged out). Both modes generate a NEW setup token (the old one stops working; see it with
  `show-token.sh`). Projects, domains and email are NOT touched.

### I lost SSH access during hardening

**Don't panic — that's what the rollback is for.** Hardening schedules an automatic revert
(via `at`) that restores the previous configuration in ~5 minutes **if you don't confirm access**
through the panel. Wait for the rollback, log in again and review the fix plan before reapplying.
Every changed file has a backup in `/var/backups/paas/`.
Lost the key, the password or the phone for two-step verification? See
[I lost access: now what?](recover-access.md).

<a id="deploy-bloqueado-por-guardrail"></a>
### Deploy blocked by guardrail

**Symptoms:** deploy returns `409 guardrail_blocked` and the UI opens the blockers modal.

**Solution:** the modal lists each violation with **evidence** (file:service) and a **suggested
fix**. Fix the compose/code (recommended) — e.g. remove the database port published on the
host, replace weak credentials. If you are sure of the risk (e.g. a database exposed only in a
staging environment), check "Entendo os riscos" (I understand the risks) and confirm the override — it is **audited** under
**Auditoria** (Audit log) (`guardrail.override`).

---

## Docker

### "Cannot connect to the Docker daemon"

**Solution:** `systemctl status docker` — if `install.sh` just installed it, you may need
`sudo systemctl enable --now docker`. The panel only accesses the local socket
(`/var/run/docker.sock`); never expose Docker over TCP.

---

## Didn't find your problem?

Open an issue in the repository using the bug template — include logs (without secrets), the commit
version and the environment. See [CONTRIBUTING.md](https://github.com/kelvindk9w/tws-panel/blob/main/CONTRIBUTING.md).
