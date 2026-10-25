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
| **Write** | Read, plus everyday changes: deploy, start and stop projects, backups. Cannot change repositories, domains or ports. |
| **Admin** | Write, plus administrative actions: creating a project or changing a project's repository, deleting projects (whole-panel token only), changing the panel domain, server hardening, restoring project and e-mail backups. |

## Choose the reach: the whole panel or only some projects

Besides the **scope** (what the token can do), you choose the **reach** (where it can do it):

| Reach | What the token sees |
|---|---|
| **The whole panel** | All projects and the panel areas its scope allows. This is how tokens worked before. |
| **Only the projects I choose** | Only the ticked projects. To the token, **the other projects do not exist**: the list does not show them, and asking for one by its id gives the same "Project not found" as for a project that never existed. |
| **Only the chosen projects, and it can create new projects** | Same as above, and every project the token creates itself **joins its list automatically**, so it can configure and publish without leaving the limit. Needs the Admin scope (creating a project is an administrative action). |
| **Only the domains of the projects I choose** | For **your customers' app** to register and remove the domains of its own project, and nothing else: it does not read the project, deploy or see the rest of the panel. Read or Write level only (no Admin, no "can create"). See [your customers' domains (SaaS)](saas-domains.md). |

**Example: "only the farm".** You have the projects "Farm", "Shop" and "Blog" and want an assistant to
look after the Farm only. In **Settings → AI access**, pick the **Write** scope, the reach **Only the
projects I choose**, tick **Farm** and create the token. With it the assistant can publish and restart
the Farm, but the project list shows only the Farm and any request about the Shop or the Blog answers
"Project not found".

A token limited to projects **never** reaches what belongs to the panel or the server, whatever its
scope: the panel domain, the mail server (domains and mailboxes), the panel and mail backups and
restores, server security, users and two-step verification, notices and integrations, general settings,
the panel Audit log and Alerts, the container list, the server ports, the terminal and other tokens.
All of that answers `403` and stays with the **whole-panel** token. Inside a project in its reach, the
scope and the usual rules apply (for example, domains and ports need Admin). For safety, a limited
token only creates a project from a **Git repository** and **cannot change the source** of an existing
project (a server folder would give access to other projects' files). **Private repositories:** a project created by a limited token **never uses the connected GitHub account** to download the code; it only sees **public** repositories (or uses the credential you put on that project, in the Git tab). Otherwise, pointing the project at someone else's private repository would clone with your account's access. If the repository is yours and private, open the project, Git tab, and use **Release the GitHub account** (asks for your password and code). Projects created by you or by a whole-panel token work as before: they use the connected account for any github.com repository it can read.

**Can create projects** only exists with the **Admin** scope (creating a project is an administrative action); both the screen and the server refuse the combination with Read or Write. The nickname (slug) of a project created by a limited token always carries a random suffix, whether or not the name is free, so it does not reveal that a project with the same name exists outside its reach.

When a domain or a port cannot be
used because something outside its reach already uses it, the refusal only says "unavailable", without
saying who uses it.

**Seeing the VPS usage: a separate option.** The usage of the whole VPS (processor, memory, disk and network)
reveals what **every** project is doing, including the ones outside the token's list. So a token limited to
projects **does not see it** (`403`), even with the Read scope. When you do want it (for example, an assistant that
answers "does the Farm need a bigger plan?"), tick **Can see the VPS monitoring (read-only)**, which only
exists for projects-limited tokens and starts **off**. It opens exactly two read routes (`GET /api/metrics/summary`
and `GET /api/metrics/host`) and nothing else of the panel; in the summary it lists the problems only of the
projects on the token's list. The usage of a project itself (`GET /api/projects/:id/metrics`) is a project route
like the others: it follows the reach, and a project outside it answers the same "Project not found". A
**whole-panel** token with Read scope always sees everything. Turning the option on counts as **widening** the reach
(password and, with 2FA, the code); turning it off does not and takes effect at once. The monitoring retention
(Settings → VPS resources) is never reachable by a token.

**Changing the list later.** In the token list, **Edit projects** changes the projects of a limited
token. **Narrowing** the reach (removing a project, turning "can create" off) takes effect at once and
asks for no password: taking access away is always safe and has to be quick. **Widening** it (ticking a
new project, turning "can create" on) asks for your current password and, with 2FA, the code, as on
creation. Deleting a project removes it from every token's list, and the id of a deleted project is never
reused. A token cannot change its own reach. If the token creates a project while you edit the list, the panel refuses to save (409), shows the new project already ticked, and you send again: nothing disappears silently.

:::caution[Whoever can publish code can reach the variables]
A deploy runs the project's code **with its variables** (passwords, keys). So a **Write** token (which can trigger a deploy) and, even more, an **Admin** token (which can change the repository and then publish) must be treated as **access to the variables of the projects they reach**, even though the API never returns those values. The panel closes the direct shortcuts (see below) but cannot separate "publish code" from "read what the code reads". **Limiting the token to a few projects is exactly that protection:** it only reaches the variables of the projects on its list. Limiting is not an isolated box: the published code runs on the server, under the deploy safety rules. Give **Read** whenever it is enough.
:::

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
- read or write the **values of project variables** through the API (see the warning above about deploys);
- link a **mailbox password** to a project variable;
- **restore the panel** (that replaces users, password and two-step verification);
- test Git access with a typed **GitHub token** or the connected account's one;
- **release the deploy's security blocks** (the "override" that lets, for example, `privileged: true` through): only you, on screen, after reading the report;
- **release the connected GitHub account** for a project created by a limited token (see below);
- **delete a project**, when the token is limited to projects: deleting needs a person's confirmation on screen (coming with the next phase); a whole-panel Admin token can still delete;
- touch **GitHub or other services' tokens**, or the Spamhaus key;
- **create, list or revoke tokens** (only you, signed in to the panel, can).

The panel answers `403` for these. They are on a fixed list in the code, and a test checks every route. A new route that has not been classified yet **is denied** to tokens until someone decides.

Some actions depend on what is sent: changing a project's repository, branch, domain or proxy, and asking for a fresh security scan, require **Admin**. The same goes for anything that changes what the internet reaches: a project's domains (add, remove, primary, port, with/without-www pair), published ports, the webmail and where alerts go. Reading the security scan by token only returns a report that already exists: with none, the panel answers "no report yet" instead of scanning. The health scan by token does not use the panel's terminal (network and pending reboot show as unavailable).

**Container logs.** No token can read the **value** of the variables, but a token with **Read** level can already read the **Logs** tab of the projects in its reach (the lines the containers write and the status of each service). The panel hides the values of the variables and obvious password patterns, but this is best effort: a log may hold your business data, and a secret written in another way may slip through (for example, the old value of a variable you changed). If that is a problem, give the token only to projects that may be read.

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
