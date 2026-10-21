---
title: "Help and feedback"
description: "Where to ask a question, report a bug, suggest something or reach us, and what to include in a report without exposing private data."
sidebar:
  label: "Help and feedback"
---

Stuck, found a bug or have an idea? Pick the channel that fits and follow the short checklist
below. You can write in English or Portuguese (Brazil).

<a id="onde-pedir-ajuda"></a>

## Where to go

| You want to | Go to |
|---|---|
| **Ask a question** (how to do something, why something behaves a certain way) | [Discussions](https://github.com/kelvindk9w/tws-panel/discussions) |
| **Report a bug** (something does not work as the guides say) | [Bug report](https://github.com/kelvindk9w/tws-panel/issues/new?template=bug_report.yml) |
| **Suggest something** | [Feature request](https://github.com/kelvindk9w/tws-panel/issues/new?template=feature_request.yml), or [Discussions](https://github.com/kelvindk9w/tws-panel/discussions) if it is still an idea to talk over |
| **Report a security problem** | Privately, through a [security advisory](https://github.com/kelvindk9w/tws-panel/security/advisories/new). Read [SECURITY.md](https://github.com/kelvindk9w/tws-panel/blob/main/SECURITY.md) first. **Do not open a public issue.** |
| **Reach us without a GitHub account** | Email [contato@tws.tec.br](mailto:contato@tws.tec.br) |

Before you write, try the [troubleshooting guide](troubleshooting.md) and search the existing
issues and discussions: someone may already have the answer.

<a id="relatar-um-bug"></a>

## What to include in a bug report

The bug report form asks for these items. Having them ready saves a round of questions.

1. **Panel version.** On the VPS, run `git -C /opt/tws-panel rev-parse --short HEAD`. It prints a
   short commit hash. If you reached the form from the panel's help menu, this field may already be
   filled in: check it.
2. **Operating system of the VPS.** For example "Ubuntu 24.04", plus the Docker version
   (`docker --version`). To see the system: `cat /etc/os-release`.
3. **Interface language.** English or Portuguese (Brazil).
4. **Steps to reproduce.** What you clicked or ran, in order, and what you expected to happen
   instead of what happened.
5. **Evidence,** such as a screenshot or a log excerpt, after you remove private data (next section).

<a id="anonimizar"></a>

## Do not paste logs without reviewing them

Logs, screenshots and command output can contain **domains, IP addresses, email addresses and
tokens**. An issue or a discussion is public: anyone can read it. Before you paste anything:

- Replace your domains with `example.com` (and subdomains with `app.example.com`, `mail.example.com`).
- Replace IP addresses with `203.0.113.10` (an address reserved for documentation).
- Replace email addresses with `user@example.com`.
- Replace tokens, passwords and keys with `REDACTED`.
- Crop screenshots so they do not show domains, IPs, project names or the setup token in the address bar.

To mask the IP addresses of a log automatically, run this on the VPS and **still read the result**
before you copy it (the command does not know your domains or tokens):

```bash
sudo docker logs --tail 100 tws-panel 2>&1 \
  | sed -E 's/[0-9]{1,3}(\.[0-9]{1,3}){3}/203.0.113.10/g'
```

> [!WARNING]
> **Never paste, anywhere public:** the setup token, passwords, two-factor codes or recovery codes,
> the recovery kit, the backup password, storage access keys, private SSH keys or the contents of
> `.env` files. If one of them leaked, treat it as compromised and replace it.

<a id="contato"></a>

## Direct contact

No GitHub account, or the matter is not suitable for a public page? Write to
[contato@tws.tec.br](mailto:contato@tws.tec.br). The same rule applies: no tokens, passwords or
unreviewed logs in the message. For a security vulnerability, prefer the private advisory above.
