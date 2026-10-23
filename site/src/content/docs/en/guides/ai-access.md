---
title: "AI access (API tokens)"
description: "Create, use and revoke API tokens so a program, such as an AI assistant, can read or operate the panel without your password."
sidebar:
  label: "AI access (API tokens)"
---

An **API token** lets a program (a script, a tool, an AI assistant) call the panel's API without
your password and without a browser session. You decide what it can do, for how long, and you can
revoke it at any moment. Tokens live in **Settings → AI access**.

> [!NOTE]
> This is the foundation. Today a token works with the panel's own HTTP API. The ready-made
> "connect an AI assistant" integration (MCP) is planned on top of these tokens and is not part of
> this page yet.

## Create a token

1. Open **Settings → AI access**.
2. Give it a **name** (it shows up in the Audit log as `token:name`), pick the **scope** and the **validity**.
3. Confirm with your **current password**, and with the **authenticator code** if two-step verification is on.
4. **Copy the token right away.** It is shown **once**. The panel keeps only a fingerprint (hash), so nobody, including you, can see it again. If you lose it, revoke it and create another.

| Scope | What the token can do |
|---|---|
| **Read** | Only look: projects, health, domains, backups, audit. Changes nothing. |
| **Write** | Read, plus everyday changes: deploy, start and stop projects, domains, backups. |
| **Admin** | Write, plus administrative actions: deleting projects, changing the panel domain, server hardening, restoring backups. |

Validity: **30 days** by default, from 1 hour up to **1 year**. Pick **24 hours** for a one-off
connection. Up to 20 active tokens at the same time.

## Use a token

Send it in the `Authorization` header, never in the address (an address ends up in logs and history,
and the panel refuses it):

```bash
export TWS_PANEL_TOKEN='paste-the-token-here'   # keep it out of your shell history and chats
curl -H "Authorization: Bearer $TWS_PANEL_TOKEN" https://panel.example.com/api/projects
```

A token is **not** a cookie: it does not open the web interface, and a request that carries one never
receives a session cookie.

## What a token can never do

Even with the **Admin** scope, a token cannot:

- open the **web terminal**;
- restart the **setup wizard**;
- change the **password** or the **two-step verification**;
- reveal **backup passwords** or **mailbox credentials**;
- read the **values of project variables**;
- touch **GitHub or other services' tokens**;
- **create, list or revoke tokens** (only you, signed in to the panel, can).

The panel answers `403` for these. They are on a fixed list in the code, and a test checks every route.

## Revoke and expiry

- **Revoke** in the list takes effect immediately.
- An expired token simply stops working.
- Changing your **password** revokes every token. Restarting the setup wizard does too.
- Every action a token performs appears in **Audit** as `token:name`. The token itself never does.

## Good habits

- One token per tool, with the smallest scope that works, and a short validity.
- Treat it like a password: password manager, not chat, e-mail, screenshot or repository.
- If a token may have leaked, revoke it first and ask questions afterwards.
- Several wrong tokens in a row from one address block that address for a while.
