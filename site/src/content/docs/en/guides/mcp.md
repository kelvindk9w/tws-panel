---
title: "Connect an AI assistant (MCP)"
description: "How to turn on the panel's MCP, create the token, connect a client (Claude Code and others), what each tool does, the four power options (security, secrets, human approval, metrics) and how to approve sensitive actions."
sidebar:
  label: "AI assistant (MCP)"
---

**MCP** (Model Context Protocol) is the standard way for an AI assistant to use tools. With it on, the assistant
queries and operates the panel through the same path as the screen: it creates a project, sets variables,
deploys, reads logs. **You** decide how much power it has, when you create the token.

> [!NOTE]
> MCP ships **off**. While it is off, the `/mcp` address answers as if it did not exist. Only the HTTP
> transport is in the panel. A terminal client (stdio) and OpenAPI come later.

## 1. Turn it on

1. Open **Settings → AI access**.
2. In the **AI access (MCP)** card, enter your password (and the code, if you use two-step verification) and
   click **Turn on AI access**.
3. The address shows on screen, like `https://panel.example.com/mcp`. To turn it off, the button sits next to
   it and asks for no password.

## 2. Create the token

On the same screen, create a token (see [AI access](./ai-access.md)). For MCP, choose:

- **Level**: read (query only), write (query and operate existing projects) or admin (also creates projects and
  adds domains). Over MCP a token **never** deletes anything, whatever its level.
- **Reach**: the whole panel or only some projects. Outside its reach a project simply does not exist for the
  assistant (the same 404 as a project that does not exist).
- **Validity**: 1, 7, 15, 30 (default), 90, 180 or 365 days, or **no expiry**. No expiry asks you to confirm,
  because a leaked token stays valid until you revoke it.
- **AI options**, all off by default (see section 4).

The token value shows once. Keep it.

## 3. Connect a client

Any MCP client with HTTP transport works. Example for Claude Code:

```bash
claude mcp add --transport http tws-panel https://panel.example.com/mcp \
  --header "Authorization: Bearer <your-token>"
```

The token always goes in the `Authorization` header. A session cookie is not valid on `/mcp`, and a token in
the URL is refused.

## What the assistant can do

| Tool | What it does | Minimum level |
|---|---|---|
| `get_access_info` | says what this token reaches and which options it has on | read |
| `list_projects`, `get_project`, `get_project_guardrails` | queries projects and the safety guardrails | read |
| `list_deploys`, `get_deploy`, `get_logs` | deploy history and logs | read |
| `get_project_https`, `check_dns` | HTTPS and DNS status | read |
| `list_env_names` | variable names, no values | read |
| `get_env_value` | one variable value (only with the "Read secrets" option) | read |
| `get_approval` | status of an approval request | read |
| `read_panel_info` | panel information (whole-panel token only) | read |
| `create_project` | creates a project from a Git repository | admin |
| `update_project` | changes project settings | write |
| `set_env_vars` | sets or replaces variables; never deletes | write |
| `add_domain` | adds a domain to the project | admin |
| `deploy_project`, `restart_project` | deploys and restarts | write |
| `recreate_project` | recreates the containers (sensitive, asks for approval) | write |
| `security_plan`, `get_security_job` | simulates a server security phase (SSH, firewall) and follows the job | admin |
| `security_apply` | simulation by default; applying for real is an option | admin |

There is no tool that deletes a project, variable, domain, backup or token. Every call goes through the same
routes, validations, guardrails and rate limits as the screen, and lands in the **Audit log** with the token
name and the client name.

## 4. The power options

Whoever installs decides how much power the AI has. Each option belongs to the **token**, starts off and only
turns on with your password (turning off needs no password and takes effect at once). When you turn one on,
the screen shows the risk.

| Option | Off (default) | On |
|---|---|---|
| **Apply security** | `security_apply` only simulates (dry-run). | Can apply SSH and firewall changes for real. A mistake can lock you out of the server. |
| **Read secrets** | The AI sets and replaces values but sees only the names; the value comes masked. | `get_env_value` returns the value. It may stay in the AI's conversation history. |
| **Skip approval** | Recreating a project and applying security wait for your approval on screen. | The AI does it on its own, without you seeing first. |
| **Metrics** | The AI sees no usage. | `get_metrics_summary` and `get_project_metrics`; `get_host_metrics` (whole VPS) only if the token has panel or monitoring reach. |

## 5. Approve a sensitive action

When the AI asks for something sensitive and the token does **not** skip approval, the call comes back with
`approval_required` and a request number. Then:

1. The request shows in **Settings → AI access → Approval requests**, with what it wants to do.
2. Click **Approve**, enter your password (and code) and confirm. Or **Reject**.
3. The AI repeats the same call with the request number.

A request is valid for 10 minutes, serves **one** run, is tied to that token and those arguments, and vanishes
if the panel restarts. A token cannot approve anything, not even an admin one.

## Installing right now (optional)

To let an AI help **install** the panel before an account exists, set `PAAS_MCP_SETUP_LEVEL` to `read`,
`write` or `admin` in the panel's environment. The setup token then works on `/mcp` at that level, with no
human approval. After you create the account, remove the variable and use a normal token.

## Limitations

- The address must reach the panel through Caddy, over HTTPS. Responses are plain JSON; there is no streaming.
- Approval requests and MCP sessions live in memory and vanish when the panel restarts.
- The panel records the client name the client itself sends; it serves the audit log, not security.
