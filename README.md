<div align="center">

# TWS Panel

**Turn an Ubuntu VPS into your own hosting platform.**<br>
Harden the machine, publish projects with HTTPS and run professional email, from one open-source panel that you control.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Status: beta](https://img.shields.io/badge/status-beta-yellow)](ROADMAP.md)
[![CI](https://github.com/kelvindk9w/tws-panel/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/kelvindk9w/tws-panel/actions/workflows/ci.yml)

[Documentation](https://kelvindk9w.github.io/tws-panel/) ·
[Installation](#installation) ·
[Roadmap](ROADMAP.md) ·
[Changelog](CHANGELOG.md) ·
[Contributing](CONTRIBUTING.md) ·
**English** | [Português (Brasil)](README.pt-BR.md)

</div>

![TWS Panel dashboard with the "Get the panel ready" checklist and three running projects](docs/assets/dashboard.png)

<!--
  Screenshots live in docs/assets/ (see docs/assets/regenerar/COMO-REGENERAR.md for how the
  existing ones are generated with fictional data). Add new ones there and reference them here.
-->

> [!NOTE]
> **TWS Panel is in beta.** The interface, the commands and the data formats may still change
> between versions. See what changed in each one in the [CHANGELOG](CHANGELOG.md).
> The panel interface is currently available in Portuguese only; the documentation is available in
> English and Portuguese (Brazil).

## Why it exists

TWS depended on a hosting service to publish its clients' websites. One day a simple change to a
site sat blocked for days, with no answer from support. The server was not the problem: depending
on another company to configure everything was. TWS Panel is not a hosting company. It is the panel
that prepares the VPS that **you** rent, from the provider you choose, and it goes with you if you
move.

**Principles:** non-invasive (it uses the Docker already on the machine and leaves what works
alone), security first (nothing goes live before the hardening), minimalist (Fastify and JSON
files, no external database) and open source (MIT license).

## What it does

A short list. Each item is detailed in the [features guide](site/src/content/docs/en/guides/features.md).

### Deploy

- Code from a git repository (public or private), from your GitHub account or from a folder on the server.
- Detects plain HTML, projects with a build step, `Dockerfile` and `docker-compose` (the compose file is adopted, not rewritten).
- Several domains per project, with an automatic `*.sslip.io` address until you have a domain.
- Several environments of the same repository (production and sandbox side by side).
- Encrypted environment variables, `.env` import, and deploys blocked when a required variable is missing.
- Ports per container: change, publish, remove and edit in bulk, with conflicts shown up front.
- Live deploy logs and a "Why it failed" view with the log of the service that became unhealthy.

### HTTPS and the panel domain

- Automatic certificates (Let's Encrypt) for the panel, the projects and email.
- A **Certificates** page with the state of each one, the likely cause when issuing fails and "Try to issue now".
- Your own (manual) certificate, with a key/certificate pair check.
- A custom domain for the panel and, optionally, turning off access by IP.

### Email

- Your own email server (Stalwart) with RSA 2048 DKIM.
- A verifiable DNS checklist (A, MX, SPF, DKIM, DMARC and PTR), with PTR instructions per provider.
- Mailboxes with ready-made credentials for Outlook, Gmail or a phone, and a test email.
- Project email: a dedicated mailbox and `SMTP_*` variables injected at deploy.
- Webmail (Roundcube) at `https://mail.<domain>/`.
- A **Sends** page: queue, history, volume, blocklists and a deliverability score.

### Notifications

- Alerts by Telegram, email or both: security, deploys, certificates, blocklists, disk and backups.
- Messages without the VPS IP, with grouping of repeats and an hourly limit.

### Backups

- Detects databases (PostgreSQL, MySQL, MariaDB, MongoDB, Redis), volumes and folders in each project.
- Backups of the panel, the email server and the projects as `.7z`, with a schedule and retention.
- Copy on the VPS and on Cloudflare R2 (or another S3), verified after upload.
- Optional encryption of the off-site copy, with a recovery kit.
- Per-item restore and "Restore from another server" to rebuild everything on a new VPS.

### Security

- Hardening wizard: Lynis, 8 phases with a dry run and automatic rollback on the ones that touch access.
- Deploy guardrails: 6 rules, with an explicit, audited override.
- Continuous monitoring against a baseline, an alert center and an audit log.
- Email blocklist checks.
- Login with two-step verification (TOTP) and recovery codes.

### Web terminal and checklist

- A real terminal of the server inside the panel, with the user you choose at install time.
- A **Get the panel ready** checklist on the Dashboard, showing what is still left to configure.

## Installation

**Requirements**

- A clean VPS with **Ubuntu 22.04 or 24.04 LTS**. Recommended minimum: 1 vCPU, 2 GB of RAM and 25 GB of disk.
- Ports **80 and 443** open to the internet (the HTTPS certificate depends on them).
- For email: port **25** unblocked by your provider (many block it on new accounts).
- Docker, Node and everything else are installed by the installer.

**One command**, as a regular user with `sudo` (installs git first if you do not have it):

```bash
sudo apt update && sudo apt install -y git \
  && sudo git clone --branch main https://github.com/kelvindk9w/tws-panel.git /opt/tws-panel \
  && sudo chown -R $USER:$USER /opt/tws-panel \
  && cd /opt/tws-panel && ./scripts/install.sh
```

The installer checks the machine without changing anything, asks which user the panel terminal
opens with, installs Docker, starts the panel and ends by printing the HTTPS address and the setup
token, for example `https://203-0-113-10.sslip.io/?token=...` (with your IP). Open it in the browser
and follow the wizard: welcome, machine health, security (hardening) and the administrator account.

> [!WARNING]
> **First time on a fresh VPS?** Create a regular user and install your SSH key *before* the
> installer; the hardening phase turns off password login over SSH. The
> [installation guide](site/src/content/docs/en/getting-started/installation.md) walks through it
> step by step, and the [security wizard guide](site/src/content/docs/en/getting-started/security-wizard.md)
> explains how to confirm access without locking yourself out.

<a id="after-installing"></a>

## After installing

On the first access, the Dashboard shows the **Get the panel ready** checklist. The panel checks
the state of each step, and each one has a "How to" with the button to the right screen.

| # | Step | What it is |
|---|---|---|
| 1 | VPS protections | The hardening phases: updates, SSH with keys only, firewall, blocking of repeated attempts and auditing. |
| 2 | Two-step verification | A 6-digit code from your phone, in addition to the password, to sign in to the panel. |
| 3 | Panel domain | An address of your own (`panel.example.com`) instead of the one with the IP. |
| 4 | Server email *(optional)* | An email server on the VPS so your projects can send messages. |
| 5 | Notifications *(optional)* | Telegram or email alerts when something needs attention. |
| 6 | Off-VPS backups *(optional)* | An encrypted copy on Cloudflare R2 (or another S3) to recover everything on a new VPS. |

Want to follow everything in order, up to the first project online and a restored backup? Use
[From zero to a configured panel](site/src/content/docs/en/getting-started/complete-guide.md).

<table>
  <tr>
    <td><img src="docs/assets/projeto.png" alt="A project page: compose services, domains with valid HTTPS and the project email enabled"></td>
    <td><img src="docs/assets/email-dns.png" alt="An email domain with the DNS checklist all green (6/6 OK)"></td>
    <td><img src="docs/assets/backups.png" alt="Backup settings with Cloudflare R2 connected and encryption on"></td>
  </tr>
  <tr>
    <td align="center">Project</td>
    <td align="center">Email with verified DNS</td>
    <td align="center">Backups</td>
  </tr>
</table>

## Scope and trade-offs

- **One panel, one VPS.** Managing several servers from one panel is not available (see the [roadmap](ROADMAP.md)).
- **It needs privileged access to the server.** The web terminal is a real shell on the VPS, and
  the Docker socket mounted into the panel is equivalent to root. This is by design, and it is
  explained, together with what the project does **not** protect, in the
  [security model](site/src/content/docs/en/reference/security.md).
- **Built for a clean Ubuntu LTS VPS.** The installer checks the machine first and asks for
  confirmation if it finds other services in the way.

## Documentation

The documentation website is at **<https://kelvindk9w.github.io/tws-panel/>** (English and Portuguese).
The same pages live in this repository, under [`site/src/content/docs/`](site/src/content/docs/).

| Guide | Content |
|---|---|
| [Installation](site/src/content/docs/en/getting-started/installation.md) | Complete step-by-step on a clean VPS (Steps 1 to 8) |
| [Security wizard](site/src/content/docs/en/getting-started/security-wizard.md) | The 8 hardening phases and how to confirm access without locking yourself out |
| [From zero to a configured panel](site/src/content/docs/en/getting-started/complete-guide.md) | One ordered walkthrough, from the rented VPS to a tested restore |
| [Features](site/src/content/docs/en/guides/features.md) | What each module does, in detail |
| [Operations](site/src/content/docs/en/guides/operations.md) | Updating, useful commands, emergency scripts, project folder, terminal user and port |
| [Lost access](site/src/content/docs/en/guides/recover-access.md) | Lost password, phone, SSH key or panel domain: the way back |
| [Security model](site/src/content/docs/en/reference/security.md) | What the panel protects and what it requires |
| [Production](site/src/content/docs/en/guides/production.md) and [troubleshooting](site/src/content/docs/en/guides/troubleshooting.md) | Email ports, PTR, UFW; blocked port 25, email in spam, certificates that do not issue |
| [Local development](site/src/content/docs/en/development/local-development.md) | Local dev mode and architecture |
| [Docs folder](docs/README.md) | Internal specs, research notes and README images |

## Security

Found a vulnerability? **Do not open a public issue.** See [SECURITY.md](SECURITY.md) for how to
report it privately.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for what exists today and what is planned, without dates.

## Contributing

Contributions are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains the local setup, the tests,
the standards and the pull request flow. To run the panel on your own computer, see the
[local development guide](site/src/content/docs/en/development/local-development.md).
Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## About TWS

**TWS Panel** is maintained by **TWS**, a software house founded and led by its CEO **Kelvin**.
TWS builds custom web solutions, systems and automations for clients. The project was born from a
real pain of the company itself and was opened to the community under the MIT license.

- Website: [tws.tec.br](https://tws.tec.br/)
- Email: [contato@tws.tec.br](mailto:contato@tws.tec.br)
- LinkedIn: [Kelvin Medeiros](https://www.linkedin.com/in/kelvin-medeiros-37920487)

## License

[MIT](LICENSE) © 2026 TWS — Kelvin
