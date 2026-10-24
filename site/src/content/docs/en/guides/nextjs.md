---
title: "Publishing a Next.js project"
description: "The three ways to put a Next.js site online (static, automatic server, your own Dockerfile or compose), when to use each one, how the panel builds the image, NEXT_PUBLIC_ variables, build memory and cleanup."
sidebar:
  label: "Next.js"
---

Next.js can become a set of ready-made files or a Node server that runs all the time (server-rendered pages,
API routes, middleware, ISR, image optimization). The panel publishes both, and still lets you take over with
a Dockerfile of your own. This page shows the **three ways**, when to use each one and what the panel does in each.

> If you use a compose file or a Dockerfile of your own, also see the [compose rules](compose-rules.md).

---

## The three ways

The panel looks at the repository in this order and **stops at the first match**:

| Priority | What it finds | Way | Type on screen |
|---|---|---|---|
| 1 | A `compose.yml` / `docker-compose.yml` file (or `.prod` variants) | Your compose is adopted | adopted compose |
| 2 | A `Dockerfile` in the root | Your Dockerfile is used | dockerfile |
| 3 | `next` in the dependencies and `output: "export"` in `next.config` | Static site (`out/` folder) | static (Node) |
| 4 | `next` in the dependencies, **without** `output: "export"` | Automatic server | **Next.js (server)** |

### 1. Static site (`output: "export"`)

Use it when the site **does not need a server**: pages that can be generated at build time, with no API routes,
no middleware, no on-demand image optimization, no ISR. `next build` produces the `out/` folder and the panel
serves it with a plain web server.

- It is the lightest and cheapest: no Node process keeps running.
- Environment variables **do not exist** at runtime (there is no server to read them). `NEXT_PUBLIC_*` only
  count if they are in the code or in the build.
- The panel reads `next.config.js`, `.mjs`, `.cjs`, `.ts` or `.mts` **as text** (it never runs the file) and
  looks for `output: "export"` written directly. If the value comes from an expression
  (`process.env.X ? "export" : …`), the panel cannot know the result and treats the project as a server: write the
  value directly in the file.

### 2. Automatic server (the new way)

Use it when the project **uses the Next.js server** and you do not want to write a Dockerfile. This is the case of
almost every project created with `create-next-app` that uses API routes, `middleware.ts`, Server Actions,
dynamic pages, `revalidate` (ISR) or `next/image`.

The panel:

1. generates the Dockerfile **outside your repository** (nothing is written to your code; it lives in the panel's
   working folder and is regenerated on every deploy);
2. builds the image (multi-stage) with the install **frozen by the lockfile** and runs `next build`;
3. starts a container from the minimal final image, as a **regular user** (not root), with no capabilities and
   **no port published on the server**: access is only through the domain, via Caddy, with HTTPS;
4. checks that the site answered (health check), like the other types.

What it detects on its own:

| Detection | Where it comes from |
|---|---|
| Package manager | the `packageManager` field in `package.json`, then the lockfile (`pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`), otherwise npm |
| Node version | `engines.node` in `package.json`, then `.nvmrc`, then `.node-version`; with nothing, **Node 22 (LTS)**. The panel offers **20, 22 and 24**; any other version falls back to 22 and says so in the log |
| Standalone mode | `output: "standalone"` written directly in `next.config` |
| Port | 3000 by default; you can change it in the wizard |

**Standalone or `next start`?**

- With `output: "standalone"` the final image carries only what is needed and runs `node server.js`. It is a
  **much smaller** image (tens of MB instead of hundreds) and starts faster. **Recommended.**
- Without standalone, the panel runs `next start` with the built project inside the image. It works, it is just
  bigger.
- To turn standalone on, add to `next.config`: `output: "standalone"`.

**Limits of the automatic server**

- The app must be **at the repository root** (the `package.json` with `next` at the root). Monorepo with the app in
  `apps/web`: the panel warns during detection and you use way 3 (your own Dockerfile).
- With `output: "standalone"` in a monorepo (`outputFileTracingRoot`), the path of `server.js` changes: the build
  stops with a message explaining it. Use way 3.
- Yarn Plug'n'Play (no `node_modules`) is not supported; use `nodeLinker: node-modules`.
- Without a lockfile in the repository the install is **not reproducible** (each deploy may bring new versions):
  the panel warns you. Commit the lockfile.
- The build has no access to the project's internal network (for example, the database in the same compose).
  Pages generated at build time that read a database need a database reachable from outside, or must be generated
  at runtime.
- `.git` does not enter the build (if your `next.config` runs `git rev-parse` for `generateBuildId`, set the id
  another way).

### 3. Your own Dockerfile or compose

Use it when you **need control**: monorepo, system packages (`apk add`), a database in the same compose, another
runtime, different build stages. Put a `Dockerfile` (or `compose.yml`) at the root: it **takes priority** over the
automatic server, and the panel uses it as it is.

That includes the common case of someone who already had a Next.js Dockerfile in the repository: nothing changes
for that project.

### How to choose

| Situation | Way |
|---|---|
| Content site, no API or middleware, can be pre-generated | 1. Static |
| App with API routes, middleware, Server Actions, ISR or images, single-app repository | 2. Automatic server |
| Monorepo, database in the same compose, system dependencies, own image | 3. Your Dockerfile/compose |

Unsure between 1 and 2? If `next build` already produces everything you need in `out/` with `output: "export"`,
stay with 1: it is cheaper and simpler to operate.

---

## Environment variables

In the project's **Variables** section:

- **At runtime** (the running server), **all** the panel variables apply, as in any project.
- **`NEXT_PUBLIC_*` must exist at build time.** Next.js replaces `process.env.NEXT_PUBLIC_X` with the value
  **inside the JavaScript that goes to the browser**. That is why the panel hands the `NEXT_PUBLIC_*` variables to
  the build. **They are public by definition:** any visitor can read the value in the site's code. **Never put a
  secret in a `NEXT_PUBLIC_*` variable.**
- Changed a `NEXT_PUBLIC_*`? **Deploy again**: restarting the container is not enough, because the value is inside
  the build.
- **The other variables** (passwords, keys, `DATABASE_URL`) are also available to `next build`, in case a page
  generated at build time needs them. The panel hands them over as a **BuildKit secret**, mounted only during the
  `next build` step: they **do not enter any layer of the image** and do not show up in `docker history`. The deploy
  log lists only the **names**, never the values.
- These do not enter the build (they apply at runtime only): `PORT`, `HOSTNAME`, `NODE_ENV`, `NODE_OPTIONS`,
  `PATH`, `HOME`, `LD_*`, `npm_*` and names that are not valid shell identifiers; also values over 32 KB.
- `PORT` in the Variables is **ignored**: the server listens on the project's port (3000 by default) and the panel
  hands that port to Next.js. To change it, use the project's port field.
- The panel always sets `HOSTNAME=0.0.0.0` and `NODE_ENV=production` and turns Next.js telemetry off.

> [!CAUTION]
> A server-only secret (such as `STRIPE_SECRET_KEY`) must **never** start with `NEXT_PUBLIC_`. If it does, it ends
> up in the site's JavaScript.

---

## Build memory and time

`next build` is the heaviest step of a deploy. On a small VPS it can run out of memory.

- The panel limits the Node heap during the build with `--max-old-space-size` equal to **60% of the server's RAM**,
  with a minimum of 768 MB and a maximum of 4096 MB (1 GB of RAM → 768 MB; 2 GB → 1229 MB; 4 GB → 2458 MB; 8 GB or
  more → 4096 MB). The value appears in the deploy log.
- If the build dies from lack of memory, the log ends with **"The build ran out of memory"** and what to do (that
  message is written by the server in Portuguese). What usually fixes it, in this order:
  1. **Create a swap file** on the VPS (2 GB already helps a lot). On Ubuntu: `sudo fallocate -l 2G /swapfile`,
     `sudo chmod 600 /swapfile`, `sudo mkswap /swapfile`, `sudo swapon /swapfile`, and the line
     `/swapfile none swap sw 0 0` in `/etc/fstab` to survive a reboot.
  2. Stop other heavy containers during the deploy.
  3. Use a VPS with more RAM.
  4. On Next.js 15 or newer, turn on `experimental.webpackMemoryOptimizations` in `next.config` to lower the peak.
- The site that was already online **stays online** during the build: the old container is only replaced after the
  new image is ready.
- A deploy with unchanged dependencies is usually much faster: the panel keeps the package manager's install cache
  **per project** (never shared between projects).

### If the deploy fails because of the lockfile

The install is frozen: if `package.json` and the lockfile do not match, the log explains it. Run `pnpm install`
(or `npm install` / `yarn install`) on your computer, commit the updated lockfile and deploy again.

---

## Disk: cache and images

The dependency cache and the build layers live in Docker's BuildKit and grow with use.

- **Automatic:** after every successful build the panel removes the **project's previous image** and the build cache
  **older than 7 days**.
- **Manual**, when you need space (on the VPS):
  ```bash
  docker system df
  docker builder prune --filter until=24h
  docker image prune
  ```
  Clearing the cache only makes the next build slower; nothing that is online is affected.

---

## Security

The automatic server follows the same rules as the other types:

- The deploy security checks run over your code before the build.
- The container runs as `node` (not root), with `cap_drop ALL` and `no-new-privileges`, **with no server folders
  mounted** and no published port: only the panel's internal network and Caddy.
- The base image is the official `node:<version>-alpine`, **pinned by digest**.
- The generated Dockerfile does not go to your repository and the build secret is a temporary file (`0600`) deleted
  right after the build.
- The build runs **your code** (install scripts, `next.config`), like any Docker build: only publish repositories
  you trust.

---

## When something goes wrong

| Symptom | What to do |
|---|---|
| "The build ran out of memory" | Create swap, free memory or use more RAM (see above) |
| "The lockfile does not match package.json" | Update and commit the lockfile |
| "asks for output standalone, but the build did not produce .next/standalone/server.js" | Monorepo or `output` coming from an expression: write the value directly or use your own Dockerfile |
| The site shows a 502 error page right after the deploy | The server is slow to start: check the project's **Logs** tab |
| I changed a `NEXT_PUBLIC_` and the site still shows the old value | Deploy again (restarting is not enough) |
| The type shows "dockerfile" but you wanted the automatic one | There is a `Dockerfile` at the root: remove (or rename) it and run detection again |
