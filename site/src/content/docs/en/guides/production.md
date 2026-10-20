---
title: "From dev to a real VPS: production guide"
description: "What changes between running the panel locally and on an internet-facing Ubuntu VPS: ports, DNS, PTR, TLS, firewall and setup order."
sidebar:
  label: "Production guide"
---

This guide covers everything that changes between running TWS Panel locally (`pnpm dev`, `.localhost`
domains, high ports) and running it on an Ubuntu 22.04/24.04 VPS exposed to the internet.

> [!NOTE]
> **Interface language.** The panel is available in English and Portuguese ([how to choose](../getting-started/complete-guide.md#idioma-da-interface)). This page quotes the English labels exactly as they appear on screen. Some messages that come from the server still appear in Portuguese in both languages (DNS-check and certificate messages, mail server status, alerts, audit details, and many error messages).

> Also read: [troubleshooting.md](troubleshooting.md) for the most common problems and
> [host-bridge.md](../reference/host-bridge.md) to understand how the scan/hardening runs on the real VPS
> (and why the panel container is hardened the way it is).

---

## 0. Host requirements created by install.sh

`scripts/install.sh` sets everything up; if you install/update manually, make sure of the following:

- **DOCKER_GID in `.env`**: the panel runs as a non-root user (`tws`) and accesses
  `/var/run/docker.sock` through `group_add`. Without the right GID the socket denies access:
  ```bash
  echo "DOCKER_GID=$(stat -c %g /var/run/docker.sock)" >> .env
  docker compose up -d --build
  ```
- **Host bridge image**: on the first run of the scan/hardening with
  `PAAS_TARGET=host` the panel downloads the disposable nsenter helper (`alpine:3`, pinned by
  digest in `packages/core/src/images.ts`). The same applies to the Caddy, Stalwart and static-site
  build images: the first installation needs access to the registry. VPS with no outbound
  internet access? Download the images beforehand, or set `PAAS_HOST_HELPER_IMAGE` to a local
  image that has `nsenter`/`tar`/`sh`.
- **ALLOWED_ORIGINS in `.env` (optional)**: leave it empty (the default) behind the Caddy that the
  panel installs. If you put **another proxy** in front of the panel and writes return
  `403 forbidden_origin`, add the origin where the panel opens (`ALLOWED_ORIGINS=https://panel.example.com`,
  several separated by commas) and run `sudo docker compose up -d`. See
  [Troubleshooting](troubleshooting.md).
- The panel container starts with `cap_drop ALL`, `no-new-privileges` and a read-only
  rootfs — only `/data` (volume) and `/tmp` (tmpfs) are writable. Don't remove
  these flags: the host bridge does NOT depend on container capabilities.

## 1. What changes in production

### 1.1 Email ports

In dev, Stalwart comes up on high ports (e.g. 10125/10587/…); in production it uses the
standard ports — which must be **open at the provider and in UFW**:

| Port | Service | Use |
|---|---|---|
| **25** | SMTP | receiving email from other servers |
| **587** | Submission | authenticated sending (email clients and your projects) |
| **465** | Submissions | authenticated sending over implicit TLS |
| **143** | IMAP | reading (STARTTLS) |
| **993** | IMAPS | reading over implicit TLS |

⚠️ **Port 25 is blocked by default at many providers** (new Hetzner, AWS, OCI accounts, etc.).
Open a ticket asking for it to be unblocked before setting up email — without it, you won't
receive messages from other servers.

### 1.2 `PAAS_PUBLIC_IP`

Set the VPS's real public IP in the server environment:

```bash
PAAS_PUBLIC_IP=203.0.113.10
# optional, only if the VPS has a public IPv6:
PAAS_PUBLIC_IPV6=2001:db8::10
```

The DNS checklist uses this value to generate the expected A/SPF records and for verification.
Without it, the panel tries to guess from the first interface — on a VPS behind NAT this can go
wrong.

### 1.3 Real TLS/ACME

- **Project sites**: the central Caddy issues certificates automatically via ACME as soon as the
  domain's DNS points to the VPS. `.localhost` domains are served over plain HTTP (dev only).
- **Email (Stalwart)**: the central Caddy issues the certificate for `mail.<domain>` (the A
  record just needs to point to the VPS, grey cloud on Cloudflare) and the panel installs and renews it in
  Stalwart. Status on the **Email** page. Details in [fase-3-email.md](https://github.com/kelvindk9w/tws-panel/blob/main/docs/internal/fase-3-email.md) §1.

### 1.4 PTR (rDNS)

The PTR record (reverse IP → mail server name) **can only be set by the VPS provider**.
The checklist shows the PTR at three levels: green (the reverse name is the server's), blue (a
generic provider name that points back to the IP: it works, but changing it is recommended) and yellow
(no valid reverse name: Gmail, Yahoo and Microsoft may refuse). For Contabo, Hetzner and Vultr the
screen says where to change it in the provider's dashboard; for the others, it generates the
text ready to open a ticket. The PTR is one per server, even with several domains.

### 1.5 Real domains vs `.localhost`

| | Dev | Production |
|---|---|---|
| Domains | `meuapp.localhost` (plain HTTP) | real domain with an A record → VPS IP |
| SSL | none | automatic (Caddy ACME) |
| DNS verification | disabled/test mode | confirm the DNS points to the VPS before issuing the certificate |

### 1.6 UFW in production

The wizard's hardening configures UFW in default-deny mode. After installing the email module,
make sure the ports are open:

```bash
sudo ufw allow 25,587,465/tcp    # SMTP + submission
sudo ufw allow 143,993/tcp       # IMAP
sudo ufw allow 80,443/tcp        # sites + panel (Caddy)
sudo ufw status verbose
```

---

## 2. Recommended setup order

Follow this sequence on a new VPS — each step depends on the previous one:

```
1. HARDENING          → run the wizard and finish the scan + hardening first.
                        The scan/hardening runs ON THE REAL VPS via the host bridge
                        (nsenter — reference/host-bridge), not in the panel container.
                        In Phase 01 paste your SSH PUBLIC KEY: root is only locked
                        with the key installed, and the pulsing alert asks you to test
                        signing in from ANOTHER SSH window before confirming (automatic
                        rollback in 5 min if you don't confirm).
2. PANEL              → finish the wizard (admin account). The panel opens at
                        https://YOUR-IP-WITH-HYPHENS.sslip.io, behind Caddy.
3. PANEL DOMAIN       → Settings → Panel domain: point
                        panel.yourdomain.com to the VPS, verify the DNS and
                        open the panel at the new address.
4. PROJECTS           → register and deploy the projects; for each domain,
                        use the **Verify DNS** button before issuing the certificate.
5. EMAIL              → unblock port 25 at the provider → start the Stalwart server
                        from the panel → add the email domain.
6. VERIFY DNS         → create the checklist records (A, MX, SPF, DKIM, DMARC)
                        at your DNS provider and click **Verify now** until it closes ✅.
                        Adjust the PTR at the provider in parallel (it can take a while).
7. MONITORING         → create the security baseline (POST /api/security/baseline
                        or through the UI under Security) and confirm the recurring scan is active.
                        Only monitor after everything is configured — that way the
                        baseline reflects the "good" state.
```

---

## 3. Final production checklist

- [ ] Hardening finished and SSH access confirmed (rollback canceled)
- [ ] Lynis score checked under **Security** (before vs after)
- [ ] Panel reachable only over HTTPS on its own domain
- [ ] Panel listening only on 127.0.0.1 (the default; Caddy serves the outside world, on ports 80/443)
- [ ] Port 25 unblocked by the provider + UFW
- [ ] PTR green or blue in the checklist (preferably green)
- [ ] Email DNS checklist 100% ✅ (A, MX, SPF, DKIM, DMARC)
- [ ] Sending test: [mail-tester](https://www.mail-tester.com) ≥ 9/10
- [ ] DMARC at `p=none` collecting reports → tighten to `quarantine`/`reject` later
- [ ] Security baseline created + recurring monitoring active
- [ ] Blocklists checked under **Sending → Reputation** (all clean)
- [ ] No critical alert open under **Alerts**

---

## 4. Operations: token and wizard reset

### Recover the setup token

The token is printed at the end of `install.sh` and kept in the `paas_data` volume
(`/data/setup-token` inside the container) until the wizard finishes. Until then, you can
display it again at any time, without reinstalling anything:

```bash
cd /opt/tws-panel
sudo ./scripts/show-token.sh
```

The script reads the file in the volume (with no fallback to the container variable, which is the
installation one and is ignored once an administrator exists), detects the public IP (best-effort; use `PAAS_PUBLIC_IP=<ip>` to pin it) and
prints the banner with the full URL `https://YOUR-IP-WITH-HYPHENS.sslip.io/?token=...` (for tunnel access, the tunnel
command and the address `http://localhost:PORT/?token=...`).

> Reminder: once the admin account is created (wizard step 4), the setup token stops working
> and its file is deleted, on purpose — from then on, access is through the normal sign-in.
> To reopen the wizard with a new token, use `reset-setup.sh` below.

### Reset the setup (restart the wizard from scratch)

```bash
sudo ./scripts/reset-setup.sh           # sends the wizard back to step 0 (admin account kept)
sudo ./scripts/reset-setup.sh --full    # + deletes admin users and active sessions
```

Both ask for interactive confirmation (type `resetar`, Portuguese for "reset") and restart the
panel at the end. What gets deleted is limited to the `paas_data` volume: `setup-state.json`
(always) and, in `--full` mode, also `users.json` and `sessions.json`. **Projects, domains,
email and security history are NOT touched.** Either mode generates a new setup token (the old
one stops working). After the reset, use `sudo ./scripts/show-token.sh` to get the wizard link again.
