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
the URL is refused. A wrong, expired or missing token gets `401` **without** the `WWW-Authenticate` header: on purpose, so the client does not go looking for an OAuth login the panel does not have and shows the real error.

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
| `update_project` | changes project settings; changing the domain, branch, www pairing or proxy needs approval | write (admin for domain, branch and proxy) |
| `set_env_vars` | creates or replaces variables; **every write needs your approval** (the screen shows the new value); never deletes | write |
| `add_domain` | adds a domain to the project | admin |
| `deploy_project`, `restart_project` | deploys and restarts | write |
| `recreate_project` | recreates the containers (sensitive, asks for approval) | write |
| `security_plan`, `get_security_job` | builds the hardening plan from the last scan (changes nothing) and follows the security job | admin |
| `security_apply` | simulation by default; applying for real is an option | admin |

There is no tool that deletes a project, variable, domain, backup or token. The project, domain, deploy and
security tools call the same routes as the screen, with the same validations, guardrails and rate limits. The variable
tools are the exception: the screen's route shows values, so no token may use it; they check reach and level on their own
and use the same service.

**Audit log.** Anything that changes something, approval requests and reading a secret always land in the **Audit log**,
with the token name and the client name. Repeated queries and refusals are recorded at most once a minute per token and
tool (with the count of repeats), and opening a session once an hour per token, so a busy AI cannot flood the log. The old
audit file is capped at 20,000 entries.

**Rate limit.** `/mcp` has its own limit of 120 calls per minute per token. The calls the tools make to the routes count in a
per-token bucket, not against the IP of whoever uses the panel screen.

## 4. The power options

Whoever installs decides how much power the AI has. Each option belongs to the **token**, starts off and only
turns on with your password (turning off needs no password and takes effect at once). When you turn one on,
the screen shows the risk.

| Option | Off (default) | On |
|---|---|---|
| **Apply security** | `security_apply` only simulates (dry-run). | Can apply SSH and firewall changes for real. A mistake can lock you out of the server. |
| **Read secrets** | The AI cannot read variable values; they come masked. | `get_env_value` returns the value. It may stay in the AI's conversation history. |
| **Skip approval** | Recreating a project, changing the domain, branch, www pairing or proxy, writing any variable and applying security wait for your approval on screen. | The AI does it on its own, without you seeing first. |
| **Metrics** | The AI sees no usage. | `get_metrics_summary` and `get_project_metrics`; `get_host_metrics` (whole VPS) only if the token has panel or monitoring reach. |

> [!CAUTION]
> **"Read secrets" off is not an absolute guarantee.** A write token can create variables, deploy and read the logs. If
> the code that runs in the project is the AI's own (for example a project created from a repository of its own by an admin
> token), that code can print the environment. That is why every variable write needs your approval, with the new value in view (names that change execution or the network, such as
> `NODE_OPTIONS` and `*_PROXY`, carry an alert; values above 4 KB are refused), and the panel masks
> the variable values in logs (also in base64 and hex), but this is best effort: an app that writes the secret some other way
> gets through. Only give write and project creation to an AI you trust to deploy code.

## 5. Approve a sensitive action

When the AI asks for something sensitive and the token does **not** skip approval, the call comes back with
`approval_required` and a request number. Then:

1. The request shows in **Settings → AI access → Approval requests**, with the **token** name highlighted, the project and what it wants to do (for variables, only the names). The AI program's name is reported by the AI itself and proves nothing: trust the token name.
2. Click **Approve**, enter your password (and code) and confirm. Or **Reject**.
3. The AI repeats the same call with the request number.

A request is valid for 10 minutes, serves **one** run, is tied to that token and those arguments, and vanishes
if the panel restarts or you turn MCP off. Each token has at most 5 requests waiting (and 20 open sessions), so a
compromised token cannot fill the others' queue. A token cannot approve anything, not even an admin one.

## Installing right now (optional)

To let an AI help **install** the panel before an account exists, set `PAAS_MCP_SETUP_LEVEL` to `read`, `write` or `admin`
in the panel's `.env` file (`docker-compose.yml` passes the variable to the container) and recreate the container. It is an
explicit choice by whoever installs the server:

- during installation, a **credential derived** from the setup token works on `/mcp` at that level, **even with MCP off**
  on screen (there is no account yet to turn it on). Give the AI **only that credential**, never the setup token: it opens
  no API route (not even the wizard that creates the account), and the raw setup token is not valid on `/mcp`. The panel
  writes it to `/data/mcp-setup-credential` (0600); read it with `sudo docker exec tws-panel cat /data/mcp-setup-credential`.
  Only the `Authorization: Bearer <credential>` header counts;
- there is no human approval in this mode, so sensitive actions (recreate, change domain, replace an existing variable,
  apply security) are refused;
- when installation ends, the setup token **stops working** and MCP goes back to following the on-screen switch, which
  starts **off**. The installation-complete screen offers to turn it on (with your password).

Remove the variable from `.env` after installing.

## Limitations

- The address must reach the panel through Caddy, over HTTPS. Responses are plain JSON; there is no streaming.
- Approval requests and MCP sessions live in memory and vanish when the panel restarts.
- The panel records the client name the client itself sends; it serves the audit log, not security. The approval screen shows it as "reported by the AI".
