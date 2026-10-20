---
title: TWS Panel
description: Open-source panel that turns an Ubuntu VPS into your own hosting platform.
template: splash
hero:
  tagline: Turn an Ubuntu VPS into your own hosting platform. Harden the machine, publish projects with HTTPS and run professional email, from one panel you control.
  actions:
    - text: First installation, step by step
      link: /tws-panel/en/getting-started/complete-guide/
      icon: right-arrow
    - text: Restore on a new VPS
      link: /tws-panel/en/guides/restore-new-server/
      icon: right-arrow
      variant: secondary
    - text: Source on GitHub
      link: https://github.com/kelvindk9w/tws-panel
      icon: external
      variant: minimal
---

## Where to start

| Your situation | Go to |
|---|---|
| **First installation.** You have never installed it, or want every step explained, from the rented VPS to a configured panel and a tested restore. | **[From zero to a fully set-up panel](getting-started/complete-guide.md)**<br>Only the installation, steps 1 to 8: [installation guide](getting-started/installation.md) |
| **I reinstalled the VPS, or I am moving to another server.** You want the panel, the projects and the email back from the external backups. | **[Restore on a new VPS](guides/restore-new-server.md)** |
| **I know what I am doing.** You have a clean Ubuntu VPS and a user with `sudo`. | **[Quick install, one command](https://github.com/kelvindk9w/tws-panel#installation)** (on the repository README) |

**SSH problems when connecting?** "REMOTE HOST IDENTIFICATION HAS CHANGED!" is expected after you
reinstall the VPS. See [what to do](getting-started/installation.md#host-identification-changed).

## What it does

- **Deploy:** git repositories, static HTML, build projects, `Dockerfile` and `docker-compose`, with several domains per project and automatic HTTPS.
- **Security first:** a hardening wizard with dry run and automatic rollback, deploy guardrails, continuous monitoring and two-factor sign-in (TOTP).
- **Email:** your own mail server (Stalwart) with a verifiable DNS checklist, mailboxes, project SMTP variables and webmail.
- **Backups:** scheduled `.7z` backups of the panel, email and projects, copied to the VPS and to Cloudflare R2 or another S3, with optional encryption.

## Where to go next

- [Installation, steps 1 to 8](getting-started/installation.md): every command of the installation explained.
- [Features](guides/features.md): what each module does.
- [Security model](reference/security.md): what the panel protects, and what it requires.
- [Troubleshooting](guides/troubleshooting.md): blocked port 25, email in spam, certificates that do not issue.

## What you need

A clean VPS with Ubuntu 22.04 or 24.04 LTS (at least 1 vCPU, 2 GB of RAM and 25 GB of disk) and ports
80 and 443 open. Docker, Node and the rest are installed by the installer.

The panel interface is available in English and Portuguese. It starts in the first of your browser's languages that it has (English if none matches), and
you can switch it with the **Language** selector (PT/EN) that is always visible in the panel header, next to your user menu (with the side menu layout, at the bottom of the sidebar, above the user menu, showing the full language name), on the sign-in and setup screens, and under **Settings → Appearance**.
Some messages that come from the server (health-check and security-scan results, deploy and DNS-check
messages, alerts, audit details and many error messages) still appear in Portuguese; the guides say so when they
quote one. See [Translating the interface](development/translating-the-interface.md) and the
[roadmap](https://github.com/kelvindk9w/tws-panel/blob/main/ROADMAP.md).
