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
  revokes all of them. A token has read, write or admin scope and a **reach**: the whole panel, or
  only a list of projects chosen by whoever creates it (optionally allowed to create projects, which
  then join its list in the same step, undone if the registration fails). Outside the list a project
  does not exist for the token: lists are filtered and a direct request by id gets the very same 404
  as a project that never existed (body and headers), before any scope check. A project-limited token
  never reaches a panel or server route (panel domain, server mail, panel backups and restore,
  hardening, users and 2FA, global notices, integrations, settings, container and port overviews,
  the audit log, terminal, tokens): they answer 403, and every route has a reach classification
  checked by a test over the real routes (an unclassified route is panel-only at run time). Refusals
  about a domain or port already in use outside the token's reach say only "unavailable", and a
  limited token can only create projects from a Git repository and cannot change a project's source. A project created by a limited token is flagged and **never clones with the connected GitHub account** (public repositories, or the project's own credential, only); a person releases it per project with the password (and 2FA code). Its nickname always carries a random suffix, so creating a project never reveals whether a name exists outside the token's reach.
  A list that cannot be read makes the token reach nothing (never everything), a file from before this
  feature loads as whole panel, and project ids are random and never reused. Raising a token's reach
  needs the current password (and 2FA code) like creating one; lowering it does not. **No token, whatever its scope,
  can** pass the deploy guardrail override (`guardrailOverride`: the only way past `privileged`, host mounts and the like, so only a person on screen),
  use the web terminal, restart the setup wizard, change the password or two-step verification,
  reveal backup or mailbox passwords, read or write variable values through the API, link a mailbox
  password to a variable, restore the panel, touch GitHub or other service tokens, or create, list or
  revoke tokens (a fixed list in code, with a test over every route; a route not on the list is
  denied at run time). A project-limited token cannot delete a project (a person's on-screen confirmation comes with a later phase), and "can create projects" is only accepted with the admin scope. Reach checks use the project's exact id (a stale id left in a list never reaches a new project by nickname), and editing a token's list is a compare-and-set (a project the token created meanwhile makes the edit fail with 409, never vanish). Anything that changes what runs or what the internet reaches needs the admin scope: a project's
  repository, branch, domain or proxy, creating a project, domains and their ports, published ports,
  the webmail switch, and where alerts go. The owner account must still exist: after restoring a
  `users.json` from another server, tokens of accounts that vanished stop working. **Residual risk, stated plainly:** a deploy runs the project's code
  with its variables, so a write or admin token is, in practice, access to the variables of the
  projects it reaches. Limiting a token to a few projects is exactly what bounds that exposure, but it
  is a limit on the panel API, not a sandbox: published code runs on the server under the deploy
  guardrails. Use read-only whenever it is enough. A panel restore keeps the current
  `api-tokens.json` and the panel backup does not carry it, so a restore never revives a revoked token. Wrong tokens are
  rate-limited per address with identical answers for unknown, expired and revoked ones. Actions
  appear in the audit log as `token:<name>`, never with the token. A leaked token is a vulnerability
  worth reporting if it grants more than its scope or reaches the exclusion list.
- **Caddy's HTTPS certificates and Let's Encrypt account (private keys) in the backup, encrypted
  only.** The panel's **encrypted external copy** (AES-256, file names included) also carries the
  contents of the `paas_caddy_data` volume, so a restore onto a new VPS does not spend Let's
  Encrypt's weekly limit. The VPS copy has no password and an external copy without encryption is
  not encrypted, so **neither carries these files** (a notice in the record says so). The files
  live in the archive as `_caddy/caddy-data.tar`, are staged in a 0700 temporary folder that is
  removed at the end, never reach the panel's data directory, and appear in no log, record or audit
  entry. On restore they are merged into the volume (nothing is deleted and no existing file is
  overwritten, so a newer certificate is never replaced by an older one), by a throwaway container
  without network, as root, with owner `0:0`, folders `0700` and files `0600` (applied even if the
  extraction fails halfway). Exactly what is refused: the whole `caddy-data.tar` is rejected, before
  anything is merged, if it contains a symbolic link, a device file, a FIFO or a socket, or a hard
  link (also checked after extraction, because BusyBox lists a hard link as a regular file); only
  regular files and folders are accepted; paths with `..` are blocked. A `_caddy`
  folder that is a link, or a `caddy-data.tar` that is not a regular file, is ignored with a warning. Anyone who has the backup
  **password** and the file has the keys of those certificates: treat the password like a key. If it
  leaks, revoke the certificates by changing the keys (delete the volume's `caddy/certificates` and
  let Caddy issue again) and change the backup password.
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
