<div align="center">

# TWS Panel

**Turn an Ubuntu VPS into your own hosting platform.**<br>
Harden the server, publish projects with HTTPS and run your own email, all from one open-source panel that you control.

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
  Screenshots live in docs/assets/ (docs/assets/regenerar/COMO-REGENERAR.md, in Portuguese, explains
  how the existing ones are generated with fictional data). Add new ones there and reference them here.
-->

> [!NOTE]
> **TWS Panel is in beta.** The interface, the commands and the data formats may still change
> between versions. The [CHANGELOG](CHANGELOG.md) (in Portuguese) lists what changed in each one.
>
> The panel interface is currently in Portuguese only. The documentation is available in English
> and Portuguese (Brazil). Screen names in this README are translated; the Portuguese name appears
> in italics the first time it matters.

## Why it exists

TWS used to rely on a hosting service to publish its clients' websites. One day, a simple change
to a site sat blocked for days with no answer from support. The server was not the problem; the
dependence on another company to configure everything was. TWS Panel is not a hosting company. It
is the panel that sets up the VPS that **you** rent, from the provider you choose, and it moves
with you if you switch providers.

**Principles:**

- **Non-invasive:** it reuses the Docker already on the machine and leaves what works alone.
- **Security first:** nothing goes live before the hardening.
- **Minimalist:** Fastify and JSON files, with no external database.
- **Open source:** MIT license.

## What it does

A short overview. The [features guide](site/src/content/docs/en/guides/features.md) covers each
item in detail.

### Deploy

- Deploy from a git repository (public or private), from your GitHub account or from a folder on the server.
- Detects static HTML, projects with a build step, a `Dockerfile` or a `docker-compose` file (an existing compose file is adopted, not rewritten).
- Multiple domains per project, with an automatic `*.sslip.io` address until you have your own.
- Multiple environments from the same repository, such as production and sandbox side by side.
- Encrypted environment variables, `.env` import, and deploys that stop when a required variable is missing.
- Port management per container: change, publish, remove or bulk-edit ports, with conflicts shown up front.
- Live deploy logs and a "Why it failed" view that shows the log of the service that became unhealthy.

### HTTPS and the panel domain

- Automatic certificates (Let's Encrypt) for the panel, the projects and email.
- A **Certificates** (*Certificados*) page with the status of each certificate, the likely cause when issuing fails, and a "Try to issue now" button.
- Bring your own certificate, with a check that the key and certificate match.
- A custom domain for the panel and, optionally, the ability to turn off access by IP.

### Email

- Your own mail server (Stalwart), with DKIM signing (RSA 2048).
- A DNS checklist that the panel verifies (A, MX, SPF, DKIM, DMARC and PTR), with PTR instructions per provider.
- Mailboxes with ready-to-use credentials for Outlook, Gmail or a phone, and a test email.
- Project email: a dedicated mailbox, with `SMTP_*` variables injected at deploy.
- Webmail (Roundcube) at `https://mail.<domain>/`.
- A **Sends** (*Envios*) page: queue, history, volume, blocklists and a deliverability score.

### Notifications

- Alerts by Telegram, email or both, covering security, deploys, certificates, blocklists, disk and backups.
- Messages leave out the VPS IP, repeated alerts are grouped, and an hourly limit applies.

### Backups

- Detects the databases (PostgreSQL, MySQL, MariaDB, MongoDB, Redis), volumes and folders in each project.
- Backups of the panel, the mail server and the projects as `.7z` files, with a schedule and retention.
- A copy on the VPS and another on Cloudflare R2 (or other S3-compatible storage), verified after upload.
- Optional encryption of the off-site copy, with a recovery kit.
- Restore item by item, or use "Restore from another server" to rebuild everything on a new VPS.

### Security

- A hardening wizard based on Lynis: 8 phases with a dry run, and automatic rollback on the phases that touch access.
- Deploy guardrails that block dangerous configurations (such as an exposed database port or a privileged container). Most blocks accept an explicit, audited override.
- Continuous monitoring against a baseline, an alert center and an audit log.
- Checks of the mail server IP against email blocklists.
- Login with two-step verification (TOTP) and recovery codes.

### Web terminal and setup checklist

- A real shell on the server inside the panel, running as the user you choose at install time.
- A **Get the panel ready** (*Deixe o painel pronto*) checklist on the Dashboard that shows what is still left to configure.

## Installation

**Requirements**

- A clean VPS running **Ubuntu 22.04 or 24.04 LTS**. Recommended minimum: 1 vCPU, 2 GB of RAM and 25 GB of disk.
- Ports **80 and 443** open to the internet (the HTTPS certificate depends on them).
- For email: port **25** unblocked by your provider (many block it on new accounts).
- Docker and everything else the panel needs are installed by the installer.

**One command**, run as a regular user with `sudo` (it installs git first if you do not have it):

```bash
sudo apt update && sudo apt install -y git \
  && sudo git clone --branch main https://github.com/kelvindk9w/tws-panel.git /opt/tws-panel \
  && sudo chown -R $USER:$USER /opt/tws-panel \
  && cd /opt/tws-panel && ./scripts/install.sh
```

The installer first checks the machine without changing anything. It then asks which user the
panel terminal should open with, installs Docker, starts the panel and prints the HTTPS address
with the setup token, for example `https://203-0-113-10.sslip.io/?token=...` (with your own IP).
Open it in your browser and follow the wizard: welcome, machine health, security (hardening) and
the administrator account.

> [!WARNING]
> **First time on a fresh VPS?** Create a regular user and install your SSH key *before* running
> the installer: the hardening phase turns off password login over SSH. The
> [installation guide](site/src/content/docs/en/getting-started/installation.md) walks through it
> step by step, and the [security wizard guide](site/src/content/docs/en/getting-started/security-wizard.md)
> explains how to confirm access without locking yourself out.

<a id="after-installing"></a>

## After installing

On your first visit, the Dashboard shows the **Get the panel ready** checklist. The panel checks
the status of each step by itself, and each step has a "How to" (*Como fazer*) section with a
button that opens the right screen.

| # | Step | What it is |
|---|---|---|
| 1 | VPS protections | The hardening phases: updates, SSH with keys only, firewall, blocking of repeated login attempts and auditing. |
| 2 | Two-step verification | A 6-digit code from your phone, in addition to your password, to sign in to the panel. |
| 3 | Panel domain | An address of your own (`panel.example.com`) instead of the one that contains the IP. |
| 4 | Server email *(optional)* | A mail server on the VPS so your projects can send email. |
| 5 | Notifications *(optional)* | Telegram or email alerts when something needs your attention. |
| 6 | Off-VPS backups *(optional)* | An encrypted copy on Cloudflare R2 (or other S3-compatible storage), so you can recover everything on a new VPS. |

Optional steps can be dismissed with "I will not use this" (*Não vou usar*). The whole checklist is
also available under **Settings → Getting started** (*Configurações → Primeiros passos*).

Prefer one ordered walkthrough, from the rented VPS to a first project online and a tested restore?
Follow [From zero to a configured panel](site/src/content/docs/en/getting-started/complete-guide.md).

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

- **One panel, one VPS.** Managing several servers from one panel is not supported (see the [roadmap](ROADMAP.md)).
- **It needs privileged access to the server.** The web terminal is a real shell on the VPS, and
  the Docker socket mounted into the panel is equivalent to root. This is by design. The
  [security model](site/src/content/docs/en/reference/security.md) explains it, along with what the
  project does **not** protect.
- **Built for a clean Ubuntu LTS VPS.** The installer checks the machine first and asks for
  confirmation if it finds other services in the way.

## Documentation

The documentation website is at **<https://kelvindk9w.github.io/tws-panel/>** (English and Portuguese).
The same pages live in this repository, under [`site/src/content/docs/`](site/src/content/docs/).

| Guide | Content |
|---|---|
| [Installation](site/src/content/docs/en/getting-started/installation.md) | Step-by-step setup on a clean VPS (steps 1 to 8) |
| [Security wizard](site/src/content/docs/en/getting-started/security-wizard.md) | The 8 hardening phases, and how to confirm access without locking yourself out |
| [From zero to a configured panel](site/src/content/docs/en/getting-started/complete-guide.md) | One ordered walkthrough, from the rented VPS to a tested restore |
| [Features](site/src/content/docs/en/guides/features.md) | What each module does, in detail |
| [Operations](site/src/content/docs/en/guides/operations.md) | Updating, useful commands, emergency scripts, the projects folder, and the terminal user and port |
| [Lost access](site/src/content/docs/en/guides/recover-access.md) | Lost password, phone, SSH key or panel domain, and how to get back in |
| [Security model](site/src/content/docs/en/reference/security.md) | What the panel protects and what it requires |
| [Production](site/src/content/docs/en/guides/production.md) and [troubleshooting](site/src/content/docs/en/guides/troubleshooting.md) | Email ports, PTR and UFW; blocked port 25, email going to spam, certificates that fail to issue |
| [Local development](site/src/content/docs/en/development/local-development.md) | Local development mode and architecture |
| [Docs folder](docs/README.md) | Internal specs, research notes and the README images |

## Security

Found a vulnerability? **Do not open a public issue.** [SECURITY.md](SECURITY.md) explains how to
report it privately.

## Roadmap

[ROADMAP.md](ROADMAP.md) lists what exists today and what is planned, without dates.

## Contributing

Contributions are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers the local setup, the tests, the
project standards and the pull request flow. To run the panel on your own computer, see the
[local development guide](site/src/content/docs/en/development/local-development.md).
Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## About TWS

**TWS Panel** is maintained by **TWS**, a software company founded and led by its CEO, **Kelvin**.
TWS builds custom web solutions, systems and automations for clients. The project grew out of a
problem the company had itself, and was then opened to the community under the MIT license.

- Website: [tws.tec.br](https://tws.tec.br/)
- Email: [contato@tws.tec.br](mailto:contato@tws.tec.br)
- LinkedIn: [Kelvin Medeiros](https://www.linkedin.com/in/kelvin-medeiros-37920487)

## License

[MIT](LICENSE) © 2026 TWS - Kelvin Medeiros
