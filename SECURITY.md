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
- **API tokens with scope** (Settings → AI access) for programs and AI assistants. Policy: the
  value has 256 bits, is shown **once** and only its SHA-256 hash is stored (file mode 0600); it
  travels only in the `Authorization: Bearer` header (an address carrying one is refused and
  scrubbed from logs) and never works as a cookie or opens a web session. Validity is 30 days by
  default, at most 1 year, with immediate revoke; changing the password or restarting the setup wizard
  revokes all of them. A token has read, write or admin scope, and **no token, whatever its scope,
  can** use the web terminal, restart the setup wizard, change the password or two-step verification,
  reveal backup or mailbox passwords, read variable values, touch GitHub or other service tokens, or
  create, list or revoke tokens (a fixed list in code, with a test over every route). Wrong tokens are
  rate-limited per address with identical answers for unknown, expired and revoked ones. Actions
  appear in the audit log as `token:<name>`, never with the token. A leaked token is a vulnerability
  worth reporting if it grants more than its scope or reaches the exclusion list.
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
  credentials or a privileged container) and can be bypassed only with an explicit, audited override. The rules that protect the panel's own isolation cannot be bypassed at all.
- **Pinned container images, kept current.** Every image the panel runs (Node, Caddy, Stalwart,
  Roundcube webmail, nginx) is pinned by tag and digest, so fixes only arrive when the repository
  changes the digest. When the pinned webmail image changes, the panel recreates the webmail
  container on its own after an update (data and settings stay in the volume).
- **Known accepted risk: `braces` (Dependabot alert, GHSA-vfj7-8cjw-p6xm).** It has no fixed version
  upstream. It is only a development dependency (through `tailwindcss`, `chokidar` and `micromatch`,
  used while building the web UI), `pnpm audit --prod` reports nothing, and the server never loads
  it, so no external input reaches it. We review it when a fixed version appears.
- **Hardening with automatic rollback** on the three phases that touch access (user, SSH and
  firewall): if nobody confirms within about 5 minutes, the server undoes what it applied by itself.
