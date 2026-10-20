---
title: "Security model: what the panel does and what it requires"
description: "What TWS Panel protects, what it requires from you (a real shell and the Docker socket), and how login and two-step verification work."
sidebar:
  label: "Security model"
---

Found a vulnerability? **Do not open a public issue.** Read
[SECURITY.md](https://github.com/kelvindk9w/tws-panel/blob/main/SECURITY.md) to learn how to report it responsibly.

> [!NOTE]
> **The panel interface is being translated.** For now, screen names, buttons and messages appear in Portuguese, exactly as on screen, followed by the English meaning in parentheses. They may change when the English interface is released.

This document explains the panel's security model. To carry out the VPS hardening, see the
[Security wizard](../getting-started/security-wizard.md). To recover access, see
[I lost access: now what?](../guides/recover-access.md).

## What the panel protects

The panel was designed with security in mind: a wizard protected by a setup token (it stops working, and its file is deleted,
when the setup finishes), Docker socket not exposed over TCP, same-origin CORS by default, rate
limiting, schema validation on API routes, logs with secret redaction and an audit log of
sensitive actions.

- **Deploy guardrails:** rules in 3 levels (`block`, `warn`, `info`) — database port exposed
  on the host, weak credentials, dev service in production, secret committed to the code and
  `:latest` tag. A block only passes with an explicit, audited override. The compose file is also
  checked the way Docker actually runs it (after merge, include, extends and interpolation).
  Privileged containers, `docker.sock` and binds outside the project folder are blocked, but they
  accept the same audited override. Only the rules that protect the panel itself have no override:
  the panel's own images, networks, reserved names and resources cannot be used or taken over by a
  project.
- **Isolation between hosted projects and the panel:** separate Docker networks for the proxy,
  the panel, mail administration and mail delivery; the panel's images are pinned by digest; the
  hosted repository's git hooks and configuration never run with the panel's privileges.
- **Monitoring:** after hardening, a baseline records packages, ports and hashes of
  critical files; recurring scans compare against it and each difference becomes an alert.
- **Secrets encrypted on disk:** projects' environment variables, the Telegram token, the backup
  storage key and the backup encryption password are stored encrypted on the server. The Telegram
  token and the storage key never come back to the screen; the backup password only appears
  under **Ver a senha** (View the password), which asks for the login password and is recorded in the Auditoria (Audit log).

## What it requires

A PaaS needs privileged access to the host — there is no
way to create containers and configure a firewall without it. Two consequences you should know
before installing:

- **The web terminal is a real shell on the VPS**, not a list of pre-approved actions. It is what
  lets you see and drive the hardening as if you were on SSH, and it is also the most sensitive point
  of the system. At installation you choose which user it opens as: with your regular user, whatever
  needs root goes through `sudo` with your password (`senha` mode) or runs in the background and is recorded in the
  Auditoria (`segundo-plano` mode); with `root`, anyone with a panel session has the machine's root
  terminal. See [what each choice means](../getting-started/installation.md#terminal-do-painel).
- **The Docker socket is mounted into the panel's container**, which is equivalent to root on the host. It is
  a property of Docker, not a flaw in the panel, and no container hardening changes that.

Both are documented in detail, along with what the project does **not** protect and the known security
debts, in [comoFuncionaSistema/global/threat-model.json](https://github.com/kelvindk9w/tws-panel/blob/main/comoFuncionaSistema/global/threat-model.json).
If your case allows it, keep the panel off the open internet (SSH tunnel access, VPN or
IP restriction). With the default HTTPS access, turn on two-step verification.

## Authentication

**Login:** the panel starts out protected by the setup token generated at installation; in the wizard's
**Conta de administrador** (Administrator account) step you create that account (argon2id-hashed password, at least 12 characters with
uppercase, lowercase and numbers), which completes the setup, invalidates the token for good and deletes the token file from the server. From then
on every access requires login (`/login`): sessions are revocable, persisted on the server
(httpOnly cookie, SameSite=Strict, 12h expiry — no stateless JWT; over HTTPS the cookie is named `__Host-paas_session`, which forces Secure and Path=/ and rules out a Domain attribute), login is rate-limited
to 5 attempts/minute per IP with progressive lockout, and changing the password invalidates the other sessions.
Write requests (POST, PUT, PATCH, DELETE) that the browser says come from another site or origin are refused with `403 forbidden_origin` before reaching authentication, login included. Login, logout, failures and creation of the admin account are recorded in the audit log.

**Two-step verification (recommended):** with HTTPS access the panel is on the internet, and
the password alone becomes the only barrier. In your user menu (top right corner),
**Verificação em duas etapas** (Two-step verification) turns on the requirement of a 6-digit code from your phone, generated by
a free authenticator app (Google Authenticator, Microsoft Authenticator or another). You scan a
QR code, confirm with a code and receive **10 single-use recovery codes** — keep them
off your phone. The Dashboard reminds you while it is off.
