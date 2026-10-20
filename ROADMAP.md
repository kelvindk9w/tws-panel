# Roadmap

A short, honest list of what exists in TWS Panel and what is planned. **There are no dates and no
promises:** the project is in beta, priorities can change, and the order below is not a commitment.
Want something moved up, or want to build it yourself? Open an issue or a discussion first (see
[CONTRIBUTING.md](CONTRIBUTING.md)).

This file is kept in English only. The [Portuguese README](README.pt-BR.md) links here.

## What exists today

Delivered, and listed in the [CHANGELOG](CHANGELOG.md) (in Portuguese):

- Hardening wizard (Lynis, 8 phases, dry run, automatic rollback on the phases that touch access).
- Deploy from git, from a folder or from `docker-compose`; domains, environments, environment variables and ports.
- Automatic HTTPS (Let's Encrypt), the **Certificates** page, and a custom domain for the panel.
- Mail server (Stalwart) with a DNS checklist, mailboxes, project email, webmail and delivery history.
- Deploy guardrails, continuous monitoring, an alert center and an audit log.
- Two-step verification (TOTP) and recovery codes.
- Notifications by Telegram and email.
- Backups of the panel, the mail server and the projects, on the VPS and on Cloudflare R2 (or other
  S3-compatible storage), with optional encryption and restore on a new server.
- Documentation in English and Portuguese (Brazil), published as a website.

## Next

Ideas we intend to work on, in no particular order:

| Item | Description |
|---|---|
| Spanish (es) translation | Documentation first. The docs structure already accepts more languages. Translating the panel interface (today Portuguese only) into English and Spanish is part of this. |
| Google Drive in backups | Another destination for the off-site copy, besides Cloudflare R2 and other S3-compatible storage. |
| One-click templates | Ready-made starting points for common apps, going through the same guardrails as any other deploy. |
| Public API and OpenAPI | A documented, versioned API (with an OpenAPI description) for automating the panel. |
| MCP for AI assistants | Let AI assistants operate the panel through the Model Context Protocol, with the same authentication and audit as any other client. |
| Guided IP warm-up | Limit the sending volume of a new IP and raise it gradually. Today the deliverability score only counts how long you have been sending. |
| MTA-STS / TLS-RPT | A policy that requires TLS for incoming email (MTA-STS), and reports of TLS delivery failures (TLS-RPT). |
| BIMI | Show your verified logo in inboxes (requires an enforced DMARC policy). |

## Later (future phase)

| Item | Description |
|---|---|
| Multi-server | Manage several VPSs from one panel. This is a large architectural change (today, one panel manages the machine it runs on), so it is not being worked on now. |

## How to follow progress

Watch the repository, read the [CHANGELOG](CHANGELOG.md), or follow
[GitHub Discussions](https://github.com/kelvindk9w/tws-panel/discussions).
