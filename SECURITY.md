# Security Policy

TWS Panel administers an entire VPS, so we take security seriously. If you have found a
vulnerability, we appreciate a responsible report.

Portuguese (Brazil) version: [docs/community/pt-BR/SECURITY.md](docs/community/pt-BR/SECURITY.md).

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion** for a security vulnerability.

Report it privately through GitHub Security Advisories:

1. Go to the [Security tab of the repository](https://github.com/kelvindk9w/tws-panel/security).
2. Click **Report a vulnerability** and fill in the form.

Direct link: <https://github.com/kelvindk9w/tws-panel/security/advisories/new>

If you cannot use GitHub, email **[contato@tws.tec.br](mailto:contato@tws.tec.br)** instead. Please
do not post exploit details anywhere public.

If possible, include:

- A description of the vulnerability and its potential impact;
- Steps to reproduce (or a proof of concept);
- The affected version or commit, and your environment (OS, Docker version, etc.).

**What to expect:**

- Acknowledgement of your report within **72 hours**;
- An assessment and, if the report is confirmed, a fix or mitigation within **90 days** (sooner
  whenever possible);
- Credit in the fix announcement, if you want it;
- We ask that you do not disclose the vulnerability publicly until a fix is available.

## Supported versions

The project is in **beta** (`0.x`). Only the latest code on the `main` branch receives security
fixes, and no older release lines are maintained. Always run the most recent version (see the
[CHANGELOG](CHANGELOG.md), and the update instructions in the
[operations guide](site/src/content/docs/en/guides/operations.md)).

| Version | Supported |
| ------- | --------- |
| `main` (latest) | Yes |
| Anything older | No, please update |

## Scope

**In scope:**

- The code in this repository: `apps/server`, `apps/web`, `packages/*` and `scripts/*`;
- The installer (`scripts/install.sh`) and the hardening scripts (`scripts/hardening/`);
- The setup wizard (token authentication) and access to the panel (HTTPS through the Caddy proxy,
  SSH tunnel, panel domain);
- The panel API (authentication, authorization, injection, path traversal, etc.).

**Out of scope:**

- Vulnerabilities in third-party dependencies without proof that they can be exploited through this
  project (report them upstream; we keep our dependencies up to date);
- Issues that require root or local access to the VPS (the panel treats the host as the trust base);
- Deliberately insecure configurations marked "for testing only" in `examples/`;
- Denial of service by exhausting the machine's own resources.

## Security practices of the project

- **A setup wizard protected by a token**, compared in constant time. The installer generates it
  with 0600 permissions, and it stops being accepted once setup is complete.
- **A web terminal with a real shell on the VPS, by design.** It lets you drive the hardening from
  the interface, and it is the largest attack surface of the system. At install time, whoever is
  installing chooses which user the terminal opens as. The recommended choice is your own regular
  user, where anything that needs root goes through `sudo` with a password or runs in the background
  and is recorded in the audit log. `root` is possible but discouraged: with `root`, anyone who has
  a panel session has the machine. This is **not a vulnerability to report**. It is declared as an
  accepted risk in [threat-model.json](comoFuncionaSistema/global/threat-model.json), together with
  the Docker socket mounted into the panel. Flaws that allow reaching this terminal **without a
  valid session** are in scope.
- **The panel listens only on `127.0.0.1`.** The panel container does not publish a port to the
  internet. The Caddy proxy serves it from outside on ports 80 and 443 with HTTPS (or you reach it
  through an SSH tunnel, in tunnel-only access).
- **Login with two-step verification** (TOTP, with recovery codes), argon2id password hashing,
  revocable sessions and attempt limiting.
- **The Docker socket is never exposed over TCP.** It is reached only through the local socket.
- **Same-origin CORS** by default, security headers (Helmet/CSP) and rate limiting.
- **Secrets on disk with mode 0600**, with the sensitive ones encrypted (project environment
  variables, repository credentials, the Telegram token, and the backup key and password), and
  **redaction of tokens and passwords in logs**.
- **Auditing** of every sensitive action (login, deploy, guardrail override, hardening, email
  changes, panel domain, notifications, backups and monitoring).
- **Deploy guardrails** that block dangerous configurations (such as an exposed database port, weak
  credentials or a privileged container) and require an explicit, audited override.
- **Hardening with automatic rollback** on the three phases that touch access (user, SSH and
  firewall): if nobody confirms within about 5 minutes, the server undoes what it applied by itself.
