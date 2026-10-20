# Roadmap

An honest, short list of what exists and what is planned for TWS Panel. **There are no dates and no
promises:** the project is in beta, priorities can change, and the order below is not a commitment.
Want something moved up, or want to build it? Open an issue or a discussion first, see
[CONTRIBUTING.md](CONTRIBUTING.md).

Portuguese (Brazil): the [README](README.pt-BR.md) points here; this file is kept in English.

## What exists today

Delivered and described in the [CHANGELOG](CHANGELOG.md):

- Hardening wizard (Lynis, 8 phases, dry run, automatic rollback on the phases that touch access).
- Deploy from git, folders or `docker-compose`; domains, environments, environment variables and ports.
- Automatic HTTPS (Let's Encrypt), the **Certificates** page, and a custom domain for the panel.
- Email server (Stalwart) with a DNS checklist, mailboxes, project email, webmail and delivery history.
- Deploy guardrails, continuous monitoring, alert center and audit log.
- Two-step verification (TOTP) and recovery codes.
- Notifications by Telegram and email.
- Backups of the panel, email and projects, on the VPS and on Cloudflare R2 (or another S3),
  with optional encryption and restore on a new server.
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
| Guided IP warm-up | Limit the sending volume of a new IP and raise it gradually (today the deliverability score only counts the days sending). |
| MTA-STS / TLS-RPT | Mandatory-TLS policy for email, and failure reports. |
| BIMI | Verified logo in inboxes (requires a hardened DMARC policy). |

## Later (future phase)

| Item | Description |
|---|---|
| Multi-server | Manage several VPS from one panel. It is a large change to the architecture (today one panel manages the machine it runs on), so it is not being worked on now. |

## How to follow progress

Watch the repository, read the [CHANGELOG](CHANGELOG.md), or join the discussions.
