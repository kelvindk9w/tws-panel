---
title: TWS Panel
description: Open-source panel that turns an Ubuntu VPS into your own hosting platform.
template: splash
hero:
  tagline: Turn an Ubuntu VPS into your own hosting platform. Harden the machine, publish projects with HTTPS and run professional email, from one panel you control.
  actions:
    - text: Install the panel
      link: /tws-panel/en/getting-started/installation/
      icon: right-arrow
    - text: Source on GitHub
      link: https://github.com/kelvindk9w/tws-panel
      icon: external
      variant: minimal
---

import { Card, CardGrid } from '@astrojs/starlight/components';

<CardGrid>
  <Card title="Deploy" icon="rocket">
    Git repositories, plain HTML, build projects, `Dockerfile` and `docker-compose`, with several
    domains per project and automatic HTTPS.
  </Card>
  <Card title="Security first" icon="approve-check">
    A hardening wizard with dry run and automatic rollback, deploy guardrails, continuous
    monitoring and two-step login (TOTP).
  </Card>
  <Card title="Email" icon="envelope">
    Your own mail server (Stalwart) with a verifiable DNS checklist, mailboxes, project SMTP
    variables and webmail.
  </Card>
  <Card title="Backups" icon="download">
    Scheduled `.7z` backups of the panel, email and projects, copied to the VPS and to
    Cloudflare R2 or another S3, with optional encryption.
  </Card>
</CardGrid>

## Where to go next

- [Installation](getting-started/installation.md): step by step on a clean VPS.
- [From zero to a configured panel](getting-started/complete-guide.md): one ordered walkthrough, up to a restored backup.
- [Features](guides/features.md): what each module does.
- [Security model](reference/security.md): what the panel protects, and what it requires.
- [Troubleshooting](guides/troubleshooting.md): blocked port 25, email in spam, certificates that do not issue.
- [Restore on a new VPS](guides/restore-new-server.md): bring the panel, projects and email back from the external backups.

## What you need

A clean VPS with Ubuntu 22.04 or 24.04 LTS (at least 1 vCPU, 2 GB of RAM and 25 GB of disk) and ports
80 and 443 open. Docker, Node and the rest are installed by the installer.

The panel interface is being translated into English; for now it is in Portuguese. See the
[roadmap](https://github.com/kelvindk9w/tws-panel/blob/main/ROADMAP.md).
