---
title: "Server logs"
description: "The Server logs page: what it shows (panel, proxy, mail, Docker and SSH of the VPS), controls, secret masking and who can open it."
sidebar:
  label: "Server logs"
---

The **Server logs** page (menu) shows what the server itself writes, without opening an SSH session. It is
read-only.

## Sources

A closed list; you cannot ask for another container:

- **Panel** (`tws-panel`);
- **Proxy** (`paas-caddy`): requests, certificates and HTTPS errors;
- **Mail server** (`paas-stalwart`): deliveries, logins and refusals;
- **VPS Docker** and **VPS SSH**: read from the system journal. They exist only in a panel installed on the VPS.

With no source selected the page merges the panel, the proxy and the mail server. Each project's own logs are on
the project's **Logs** tab.

## Controls

The same as the project Logs tab: number of lines (100 to 2000), period (15 minutes, 1 hour, 24 hours), text
search, copy and refresh. The page **does not refresh by itself** by default, because every read is written to
the Audit log; automatic refresh is optional.

## Secrets

The panel hides, on a best-effort basis, mailbox passwords, the mail server admin password, project variables and
common patterns (Bearer, passwords in URLs, cookies, tokens). A secret a program writes in an unusual way can slip
through: do not paste logs into public places without reading them.

The **SSH** log shows the IP addresses of people who tried to log in. That is useful to the VPS owner, and it is
why this page is for you only, signed in to the panel.

## Who can open it

Only a signed-in person. **No API token** can reach this page, not even with administrator permission. It is
limited to 30 requests per minute and each request is recorded in the Audit log (who, source, size; never the
content). How the journal is read: [Host bridge](../reference/host-bridge.md).
