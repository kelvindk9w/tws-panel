---
title: "Instructions for your AI agent"
description: "A ready-to-paste block for Claude, ChatGPT, Cursor or Copilot working on another project: what the panel expects from the repository and the compose file (rules, ports, health check, email, variables) and what not to do."
sidebar:
  label: "Instructions for your AI agent"
---

If an AI assistant (Claude, ChatGPT, Cursor, Copilot...) is helping you organize the repository of a project
you want to publish on the panel, paste the block below into the conversation, **inside the project folder**,
and let it work. Replace what is between `<...>`.

The block is a condensed version of two pages. When the assistant (or you) needs the details, go to them:

- [Prepare your project](prepare-project.md): how the panel decides what to do, recipes ready to copy,
  variables, project email and the checklist.
- [Compose rules](compose-rules.md): every rule that blocks or warns, what passes and what can get an override.

> [!TIP]
> Most assistants can read a web page. Besides pasting the block, you can give them the address of this page
> and of the two above, so they check the details on their own.

## How to use it

1. Open the assistant **inside the project's folder** (Claude Code, Cursor, Copilot in the editor), or attach
   the repository to the conversation.
2. Copy the block below and fill in the `<...>` fields: project type, app port and database.
3. Read what the assistant changed before committing. It must not touch `.env` files nor run anything on the
   server.
4. Push to the branch the panel publishes, fill in the variables on the panel's **Variables** screen and deploy.

## The block

````text
Prepare this repository to be published on TWS Panel (a self-hosted PaaS that runs everything in Docker
containers, with automatic HTTPS through a central Caddy). Only change the repository; do not run anything on
a server and do not read or show the contents of .env files.

My project:
- Type: <static site | app with Dockerfile | app with database | Next.js (export or server) | Laravel>.
- App port: <3000>. Database/cache: <PostgreSQL | MySQL | Redis | none>. Sends email: <yes | no>.
- Example domain: example.com.

How the panel decides what to do, in the repository root, using the first rule that fits:
1. If a compose file exists, it is adopted without being rewritten. Order: compose.paas.yml/.yaml,
   compose.prod.yml/.yaml, compose.production.yml, docker-compose.prod.yml/.yaml,
   docker-compose.production.yml, compose.yml/.yaml, docker-compose.yml/.yaml.
2. Dockerfile without package.json: one container, port from the EXPOSE of the last stage.
3. package.json: if a Dockerfile exists, the Dockerfile has priority (even for Vite or Next export), with a
   warning; a package.json without a "build" script but with a Dockerfile also uses the Dockerfile. Without a
   Dockerfile: if it has `next` without output "export", it is Next.js with a server (the panel generates the
   Dockerfile). With a "build" script: Vite, Next with output "export", or out/dist/build with an index.html is
   a static site (build on Node 22, folder served by nginx).
4. index.html in the root without a build: static site.
The type can also be chosen by hand on the detection screen (the panel checks that the code fits).

Ports and network:
- The app listens on 0.0.0.0 (not localhost), on the port declared in EXPOSE (Dockerfile) or expose (compose).
  The panel uses the first expose port as "Service port"; with neither expose nor ports, the guess is 80. Tell
  me to check "Service port" on the detection screen.
- With more than one service, use compose.prod.yml. Give the site's service a name such as web or app. Do not
  declare networks (the default network is already internal) and never join the panel's networks (paas-*,
  tws-*, any paas-mail* network): the panel connects the web service to the proxy by itself.
- Use "expose" instead of "ports". NEVER publish database ports (5432, 3306, 6379, 27017...), internal ports
  (9000 of PHP-FPM, 11211, 5672, 8025, 2375...), 80 or 443. HTTPS is done by the panel.
- If the project brings its own HTTPS proxy (Caddy, Traefik), create a compose.paas.yaml without ports 80/443
  and with the proxy speaking plain HTTP.

Health check and start-up:
- After starting, the panel checks that the site answers: about 1 minute for HTTP and up to 90 seconds for
  HTTPS. A 5xx on the root fails the deploy; a 4xx does not. Migrations must finish within that time.
- Databases with a healthcheck, and the app with depends_on condition service_healthy. Migrations in the app's
  command/entrypoint (for example "php artisan migrate --force" or "npm run migrate").

Images and Dockerfile:
- Pinned base image version, non-root process (USER; exception: the official PHP Apache image, which serves as
  www-data), no secrets in ENV/ARG. Every Dockerfile with "COPY . ." needs a .dockerignore that excludes .env
  (and .git, node_modules, vendor); the panel already takes the .env it writes out of the build, but the
  .dockerignore protects builds outside the panel.
- Do not name the built image node, nginx, alpine, caddy, stalwart, roundcube, tws-panel or paas-* (with
  build:, do not put image: node next to it; use your own name, such as example-app:1.0).
- Build context and Dockerfile inside the repository (no context: .., no server path, no Git URL).
- Third-party images with a pinned version (no :latest) and no development tools (phpMyAdmin, Adminer,
  Mailhog, Mailpit, pgAdmin) in the production file.

Volumes and what is forbidden:
- Data in named volumes declared at the end of the file, without name:, external or driver. A folder inside
  the project (./uploads:/app/uploads) is fine.
- Never mount server folders, "~", "/", docker.sock, /var/lib/docker or /run; never use privileged, cap_add,
  devices, sysctls, network_mode: host, pid: host or external_links; avoid container_name and hostname.
  No container, service, volume or network name starting with paas or tws, and no label starting with paas.
  or com.docker.compose. (the tws.mail label below is the exception the panel reads).
- Do not use unusual compose fields; the panel blocks fields it does not know (x-... fields are free).

Variables and secrets:
- Secrets NEVER in the files: use ${VAR:?message} for every password, key and token (the deploy stops and
  names the missing one). Database user different from the password (use "app", not "postgres" or "admin").
  No values such as password, admin, root, 123456, changeme, nor shorter than 6 characters.
- Create a .env.example with the variable names and fake values (it feeds the suggestions on the panel), and
  make sure .env is in .gitignore.
- Node server with a package.json without a "build" script and with a Dockerfile: the panel uses the
  Dockerfile (port from the EXPOSE of the last stage).
- Next.js with a server and no Dockerfile: the panel generates the image; set output: "standalone" in
  next.config, commit the lockfile and never put a secret in NEXT_PUBLIC_* (it goes into the site's JavaScript).
- Static builds (Vite, Next export) only receive the Variables ticked "build" in the panel (or public values
  in a committed .env.production): VITE_*/NEXT_PUBLIC_* only with public values, never a secret. NEXT_PUBLIC_*
  in a Dockerfile needs a matching ARG. For a SPA with browser-side routes, tell me to turn on
  "Single-page application".
- Laravel: build the Vite assets in the Dockerfile and install the phpredis extension (or use
  REDIS_CLIENT=predis).

Email (only if the app sends email):
- Do not add a mail server or SMTP container. With the project's Email tab enabled, the panel hands the app
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM and MAIL_FROM_NAME on every deploy. Prefer reading
  those names. If the app reads other names (MAIL_HOST, MAIL_PASSWORD...), keep them required in the compose
  (MAIL_HOST: ${MAIL_HOST:?}) and list them for me: I link them to the email values on the panel's screen.
- Only services that may send email (app, worker, scheduler) are attached to the email network; databases and
  caches are left out on purpose and the app keeps talking to them over the project's own network. Only if a
  service with a database image really sends email, add the label tws.mail=true to it; tws.mail=false removes a
  service from the email network.

Deliver: the files created or changed; the list of variables I must fill in on the panel's Variables screen
(names only, with one sentence on what each is) and the email names I must link, if any; and how to generate
safe values (openssl rand -hex 24). At the end, check each rule above item by item and say what could not be
met.
````

## What the block leaves out on purpose

- **It does not deploy.** The assistant only changes the repository. The deploy, the variables and the domain
  are done by you on the panel (or by an assistant you authorized, below).
- **It does not see secrets.** The block forbids reading `.env` files. The values go straight into the
  **Variables** tab.
- **It does not replace the guardrails.** Even if the assistant gets something wrong, the panel checks the
  compose before the deploy and stops with an explanation. See
  [Checking before the deploy](compose-rules.md#checking-before-the-deploy).

## When the assistant also operates the panel

If an assistant is going to use the panel in your place (read projects and logs, deploy), do not give it your
password. Read [AI access (API tokens)](ai-access.md), for a token with limited scope, and [MCP](mcp.md), for
the connection with human approval of sensitive actions.
