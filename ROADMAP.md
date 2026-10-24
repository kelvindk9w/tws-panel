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
- A **Logs** tab per project: what the project's containers write (stdout and stderr, with time and service status), with line count, period, text filter, auto refresh and copy, read-only and with secrets masked on a best-effort basis; no SSH needed to check that a project came back after a restart.
- Deploy guardrails, continuous monitoring, an alert center and an audit log.
- Two-step verification (TOTP) and recovery codes.
- API tokens with scope, expiry and instant revoke (Settings → AI access), the foundation for AI assistants and automation. Fixed exclusion list: the terminal, setup restart, password/2FA, backup and mailbox passwords, variable values and service tokens are out of reach of any token.
- Per-project reach for API tokens: a token reaches the whole panel or only the projects chosen for it (optionally creating new ones that join its list); anything outside the list does not exist for it, and the panel and server areas stay out of reach.
- Sign-in locks: per-account progressive lock on the 6-digit code, warnings to the owner, limits on routes that ask for the password with the session open.
- Notifications by Telegram and email.
- Backups of the panel, the mail server and the projects, on the VPS and on Cloudflare R2 (or other
  S3-compatible storage), with optional encryption and restore on a new server.
- Documentation in English and Portuguese (Brazil), published as a website.
- Panel interface in English and Portuguese (Brazil), chosen from the browser language or with the selector in the header.

## Next

Ideas we intend to work on, in no particular order:

| Item | Description |
|---|---|
| Spanish (es) translation | The documentation and the panel interface exist in English and Portuguese (Brazil); Spanish is still to come, documentation first. The docs structure and the interface dictionaries already accept more languages. Messages written by the server are still in Portuguese in every language. |
| Google Drive in backups | Another destination for the off-site copy, besides Cloudflare R2 and other S3-compatible storage. |
| One-click templates | Ready-made starting points for common apps, going through the same guardrails as any other deploy. |
| Mandatory two-step verification | Require the second factor at the end of setup in HTTPS mode, with a grace period for existing installs. |
| Passkeys (WebAuthn) | Hardware or phone passkeys as a second factor and later as the main sign-in, keeping TOTP and recovery codes as a fallback. Needs a stable domain. |
| Single sign-in form | Optionally show the code field up front with one generic error, so the first step no longer confirms the password. |
| Public API and OpenAPI | A documented, versioned API (with an OpenAPI description) for automating the panel. |
| MCP for AI assistants | Let AI assistants operate the panel through the Model Context Protocol, with the same authentication and audit as any other client. The API tokens it needs already exist, including the per-project reach (phases 0 and 0b); next come the `/mcp` endpoint with a "project live" vertical slice, then reversible changes, then human confirmation for destructive ones. |
| Guided IP warm-up | Limit the sending volume of a new IP and raise it gradually. Today the deliverability score only counts how long you have been sending. |
| MTA-STS / TLS-RPT | The panel already suggests the records and checks them (as an optional bonus). Still to come: serving the MTA-STS policy file itself. |
| Automatic Cloudflare DNS | Create the email records through a minimal-scope API token (DNS edit on one zone), with a diff and confirmation. Plan only, see the deliverability report. |
| BIMI | Show your verified logo in inboxes (requires an enforced DMARC policy). |

## Later (future phase)

| Item | Description |
|---|---|
| Multi-server | Manage several VPSs from one panel. This is a large architectural change (today, one panel manages the machine it runs on), so it is not being worked on now. |

## How to follow progress

Watch the repository, read the [CHANGELOG](CHANGELOG.md), or follow
[GitHub Discussions](https://github.com/kelvindk9w/tws-panel/discussions).
| Lazy-loaded public suffix list | The embedded Public Suffix List adds about 117 KB (37 KB gzipped) to the web bundle. Idea: load it on demand, only when the domain guide is opened. |
