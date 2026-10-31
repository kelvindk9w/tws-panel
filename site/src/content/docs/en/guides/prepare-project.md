---
title: "How to prepare your project for the panel"
description: "What your repository needs for the panel to publish it: how the panel decides what to do, ready-made recipes (static site, Dockerfile, app with database), variables, the rules that block a deploy and a checklist."
sidebar:
  label: "Prepare your project"
---

This guide is for whoever is going to **publish their own project** on the panel: you, someone helping you or
an AI assistant. It says what the panel expects to find in the repository, what to prepare for each kind of
project and gives files ready to copy. The examples use `example.com` and obvious example passwords: replace
them with your own.

> [!NOTE]
> This page **guides and points** to the others. The details of each screen are in
> [Features](features.md); the full list of what a deploy blocks is in
> [Compose rules](compose-rules.md); the step-by-step for creating the project on screen is in
> [First project](../getting-started/complete-guide.md#etapa-7).

---

## 1. Before you start

### What you need

- **The code in a Git repository** (GitHub, GitLab or another that accepts `https://` or SSH). It can be public.
  If it is **private**, the panel needs a **read-only** credential: a token with the `Contents: Read`
  permission for that repository only, or your GitHub account connected in **Settings → Integrations**.
  When you create the project, the **Test access** button checks that the panel can read it, without
  creating anything.
- **The branch** that goes live (the default is `main`). The panel clones only that branch. Code that is not
  on it is not published.
- **A domain**, if you want your own address. Without a domain, the panel creates an automatic address with
  HTTPS for testing. With a domain, create an **A** record at your DNS provider pointing to the VPS IP, for the
  name you type and also for the **pair with and without `www`** (`@` and `www`; the pair only exists for the main domain, such as `example.com`: a subdomain such as `shop.example.com` has no pair). On Cloudflare, keep the
  cloud **grey** (DNS only). With the orange cloud the certificate is not issued. The screen shows the exact
  records. More in [Features](features.md#project-deploys) and in
  [Troubleshooting](troubleshooting.md#the-site-opens-without-www-but-not-with-www-or-the-other-way-round).
  To connect a subdomain later (Project → Domains → **Connect new domain**), pick the **parent domain** and type
  only the label: `api` becomes `api.example.com` and `app.v2` becomes `app.v2.example.com`. The screen shows
  "Will be connected as ..." before you save. A full hostname that already ends with the parent is not
  duplicated, and `@` means the parent itself. Choose **Full hostname** to connect an unrelated domain. The
  domain is saved only when you click **Connect**; nothing is saved before that. While a request is running the window
  cannot be closed, so you always see the result.

### What the panel does for you

- Downloads the code (`git clone`) and updates it on every deploy.
- Builds and starts the containers (Docker).
- Issues and renews the **HTTPS** certificate by itself (Caddy) and connects the domain to your site, with
  WebSocket support (tick the option when you create the project).
- Stores the **variables** and hands them to the project.
- Connects the project's **email**, if you enable it (`SMTP_*` and `MAIL_*` variables).
- Makes **backups** and shows the **logs** of each service.

### What the panel does NOT do

- **It does not use the system's PM2, nginx or Apache.** Everything runs in containers. Do not install
  anything on the VPS by hand.
- **It does not run loose commands** from your project. Whoever installs, compiles and starts is the
  `Dockerfile` or compose file that **you** write. There is no "run `npm start` afterwards".
- **It does not read the `.env` on your computer.** If it is in `.gitignore` (as it should be), the panel never
  sees it. You import the variables through the **Variables** screen (see [section 5](#5-variables-and-secrets)).
- **It does not update by itself.** After a `git push`, click **Deploy**. The panel only warns you that there is a new commit.

---

## 2. How the panel decides what to do

When it detects the project, the panel looks at the **main folder** (the repository root) and uses the **first**
rule that fits:

1. **Compose.** If one of these files exists, in this order, the panel adopts the first one it finds:
   `compose.paas.yml`, `compose.paas.yaml`, `compose.prod.yml`, `compose.prod.yaml`,
   `compose.production.yml`, `docker-compose.prod.yml`, `docker-compose.prod.yaml`,
   `docker-compose.production.yml`, `compose.yml`, `compose.yaml`, `docker-compose.yml`,
   `docker-compose.yaml`. It **never rewrites** your file.
2. **Dockerfile without `package.json`.** It becomes a single container. The port comes from the `EXPOSE` line of
   the **last stage** (in a multi-stage Dockerfile, the stage that becomes the final image, not the build one).
3. **`package.json`.**
   - **With a `Dockerfile`, the `Dockerfile` has priority**, even for Vite or Next with `output: "export"`. The
     panel warns that the Dockerfile was chosen. If you prefer the static site without Docker, choose the type
     by hand (see below).
   - **Without a `Dockerfile`**, and with a `build` script: if it is **Vite**, **Next.js with
     `output: "export"`**, or `out/`, `dist/` or `build/` with an `index.html` is already in the repository,
     the panel runs the build and publishes the folder as a **static site**. With no clues, it assumes the build
     produces `dist/` (it may be wrong).
   - A `package.json` **without** a `build` script but **with** a `Dockerfile` also becomes a Dockerfile project.
4. **`index.html` in the root**, no build: a static site published as is.

If none of this fits, the screen says "The panel doesn't know how to deploy this code yet" and lists what it publishes.

**Choosing the type by hand.** The wizard's detection screen has a **Project type** field. Detection is usually
right, but if the code allows more than one way (for example, Vite with a `Dockerfile`), you choose. The panel
checks that the code has what the type needs (a `Dockerfile` for the Dockerfile type, a compose file for the
compose type, and so on) and refuses with an explanation if it does not. Note: choosing **static site** publishes **every non-hidden
file** in the folder; if there is a `Dockerfile`, a compose file, `package.json` or `*.php` in the root, the screen
shows a critical warning, because those files would go public as text. The choice is saved on the project; if
the code stops fitting it, the panel goes back to automatic detection and says so.

### My project is... what to prepare

| My project is... | Prepare in the repository | Recipe |
|---|---|---|
| A page in HTML, CSS and JS without a build | `index.html` in the root | [3.1](#31-static-site-plain-html) |
| React, Vue or Svelte with Vite | `package.json` with a `build` that produces `dist/` and `vite` in the dependencies | [3.2](#32-static-site-with-a-build-vite-react) |
| Next.js with static pages only | `next.config` with `output: "export"` | [4](#4-nextjs) |
| Next.js with a server (API, SSR) | Nothing: the panel generates the Dockerfile (or use your own `Dockerfile`/compose) | [4](#4-nextjs) and the [Next.js guide](nextjs.md) |
| A single-service app (Python, Go, Java...), no database and **no** `package.json` | `Dockerfile` with `EXPOSE` and `.dockerignore` | [3.3](#33-app-with-a-dockerfile) |
| A single-service **Node** app without a `build` script | `Dockerfile` (the panel recognizes it) | [3.3](#node-without-a-build-script) |
| An app **with a database**, cache or more than one service | `compose.prod.yml` | [3.4](#34-app-with-a-database-composeprodyml) |
| Laravel (PHP) with MySQL or PostgreSQL | `Dockerfile` + `compose.prod.yml` | [3.5](#35-laravel-php-with-mysql-and-redis) |
| WordPress, n8n, Metabase and similar | `compose.prod.yml` with the official image | [3.4](#34-app-with-a-database-composeprodyml) |

---

## 3. Recipes

> [!WARNING]
> **The `.env` written by the panel does not enter the build.** In a compose project, the panel writes your
> Variables (passwords, keys) to a `.env` inside the project folder. On `docker build` (Dockerfile or the
> compose `build:`), the panel takes that file out of the context by itself, with a `.dockerignore` generated
> only during the build (your own `.dockerignore` is neither changed nor deleted; if the panel goes down in
> the middle of a build, the leftover is undone on the next build and when the panel comes back). This relies on
> **BuildKit** (the default in current Docker; the panel forces it on `docker build`, and compose v2 already uses
> it). A `.dockerignore` that is a **link** to a file inside the project is followed; a link to outside, a file
> over 1 MB or an unreadable one makes the panel **refuse the deploy** with a message, instead of building
> without your exclusions. Still, **keep your
> `.dockerignore`** with `.git`, `node_modules` and `.env`: it shrinks the context and protects builds made
> outside the panel. A `.env` that **you** committed is not touched (the deploy log warns when it enters the
> context and no `.dockerignore` excludes it).

### 3.1 Static site (plain HTML)

```text
my-site/
├── index.html
├── style.css
└── img/logo.png
```

That is all. The panel copies the files to a web server (nginx) **without hidden files or folders**: `.git`,
`.env` and the like do not go live (only `.well-known` is kept, useful for domain verifications).

- Links between pages work as files: `about.html`, `contact/index.html`.
- A page that does not exist returns 404 (there is no "if not found, show `index.html`" rule). For plain HTML
  that is right, and the single-page option stays off.

### 3.2 Static site with a build (Vite, React)

`package.json`:

```json
{
  "name": "my-site",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.1",
    "vite": "^5.4.0"
  }
}
```

What the panel does: runs `npm install` and `npm run build` in a Node 22 container and publishes the `dist/`
folder. The package manager comes from the `packageManager` field of `package.json`; without it, from the lock
file (`pnpm-lock.yaml`, `yarn.lock`), and last it is `npm`.

Things to watch:

- **Commit the lock file** (`package-lock.json`, `pnpm-lock.yaml` or `yarn.lock`) so the build is always the same.
- **Browser-side routes (React Router etc.)**: tick **Single-page application** (on the wizard's detection
  screen, and later in the project's **Settings**). The server then answers `index.html` for any path that is
  not a file (`try_files $uri $uri/ /index.html`), and opening `https://example.com/dashboard` directly, or
  pressing F5, works. The panel comes with the option **on** when it finds a bundler (Vite, Create React
  App) with React, Vue, Svelte or similar and no server; for plain Vite and plain HTML it comes **off** (tick it
  by hand if your site has browser-side routes). The change takes effect on the next deploy.
- **Build variables (`VITE_...`)**: in the **Variables** tab, tick **build** on the ones the build must read.
  Only the ticked ones enter the static build; the others never reach it. They end up **in the site's
  JavaScript**, visible to any visitor: use them only for public values (such as your API address) and never for
  a password or secret key. Names with the `VITE_`, `NEXT_PUBLIC_`, `PUBLIC_` and `REACT_APP_` prefixes get a
  suggestion to tick. A committed `.env.production` keeps working too.

If you prefer to serve `dist/` with your own nginx configuration, publish with a `compose.prod.yml` (it has
priority over the Vite detection) and your own `Dockerfile`:

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
```

This `Dockerfile` uses `npm ci`, which **requires `package-lock.json`**. With pnpm, replace the install lines with
`COPY package.json pnpm-lock.yaml ./` and `RUN corepack enable && pnpm install --frozen-lockfile`; with yarn, with
`COPY package.json yarn.lock ./` and `RUN corepack enable && yarn install --frozen-lockfile`.

`.dockerignore` (keeps `.env.production`, which only has public values):

```text
node_modules
dist
.git
.env
.env.local
```

`nginx.conf`:

```nginx
server {
  listen 8080;
  root /usr/share/nginx/html;
  location / {
    try_files $uri /index.html;
  }
}
```

`compose.prod.yml`:

```yaml
services:
  web:
    build: .
    image: example-site:1.0
    expose:
      - "8080"
    restart: unless-stopped
```

The panel suggests the **Service port** from `expose` (`8080` here). Check it on the detection screen.

### 3.3 App with a Dockerfile

For an app with **a single service and no database**, **no `package.json`** in the root (Python, Go, Java,
Ruby...). Example for Python with Flask and gunicorn (it works the same for any language: what matters is the
`EXPOSE` and listening on all addresses). Put `gunicorn` in `requirements.txt`:

```dockerfile
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

# runs without being root
RUN useradd --create-home app
USER app

EXPOSE 8000
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "app:app"]
```

`.dockerignore` (avoids copying junk and secrets into the image):

```text
.git
.env
.env.*
.venv
__pycache__
```

Rules to make it work:

1. **Write `EXPOSE <port>`** with the port the app listens on. The panel takes the proxy port from it. Without
   `EXPOSE`, the screen asks for the port and you fill in **Service port**.
2. **The app must listen on `0.0.0.0`**, not on `127.0.0.1`/`localhost`. On localhost only the container itself
   can reach it and the site returns a 502 error.
3. **Run without being root** (`USER app`, after creating the user, as in the example). It helps security, and the panel already drops
   extra privileges from the container.
4. **Do not store data inside the container.** In this mode there is no volume: whatever the app writes to disk
   **is lost on every deploy**. If you need persistent files or a database, use [recipe 3.4](#34-app-with-a-database-composeprodyml).
5. The project's **Variables** reach the container as environment variables (in Python, `os.environ["NAME"]`; in Node, `process.env.NAME`). Only the ones ticked **build**
   go to `docker build` as `--build-arg`, and only those the Dockerfile declares with `ARG`. Do not tick a
   secret as "build": the value may stay in the image layers.

<a id="node-without-a-build-script"></a>

**Node app without a `build` script.** A `package.json` without `build`, but with a `Dockerfile`, is recognized
as a Dockerfile project (the port comes from `EXPOSE`). The `Dockerfile`:

```dockerfile
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

# runs without being root
USER node

EXPOSE 3000
CMD ["node", "server.js"]
```

The `.dockerignore` is the one above (replace `.venv` and `__pycache__` with `node_modules`). The `Dockerfile`
alone is enough, as in [section 4](#4-nextjs); if you prefer a one-service `compose.prod.yml`, it also has
priority and works.

### 3.4 App with a database: `compose.prod.yml`

When the project has more than one service (app, database, cache), write a `compose.prod.yml` in the root.
Complete example for **Node + PostgreSQL + Redis**:

```yaml
services:
  app:
    build: .
    image: example-app:1.0
    restart: unless-stopped
    expose:
      - "3000"
    environment:
      NODE_ENV: production
      PORT: "3000"
      DATABASE_URL: postgres://app:${DB_PASSWORD:?set DB_PASSWORD in Variables}@db:5432/app
      REDIS_URL: redis://cache:6379
      SESSION_SECRET: ${SESSION_SECRET:?set SESSION_SECRET in Variables}
    volumes:
      - uploads:/app/uploads
    depends_on:
      db:
        condition: service_healthy
      cache:
        condition: service_started
    # migrations before starting; replace with your tool's command
    command: ["sh", "-c", "npm run migrate && node server.js"]

  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: ${DB_PASSWORD:?set DB_PASSWORD in Variables}
      POSTGRES_DB: app
    volumes:
      - dbdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d app"]
      interval: 5s
      timeout: 3s
      retries: 10

  cache:
    image: redis:7.2-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - cachedata:/data

volumes:
  uploads:
  dbdata:
  cachedata:
```

The `Dockerfile` and `.dockerignore` are the Node ones from recipe 3.3.

Why it is written this way (each item avoids a block or a common problem):

- **Internal network.** Do not declare `networks:`. Compose already creates a private network for the project,
  and the services talk to each other by **name** (`db`, `cache`). The panel connects **only the web service**
  to the proxy network by itself.
- **`expose` instead of `ports`.** `expose` only opens the port to the other containers. `ports` would publish
  on the VPS: a database one (5432, 3306, 6379...) is **blocked**, and the panel removes 80/443 by itself.
- **Which service gets the site.** The panel picks the service by name (`web`, `app`, `frontend`, `site`...) or
  by image (`caddy`, `nginx`, `traefik`). Give the site's service one of those names. **Check the "Web service"
  and "Service port" on the detection screen**: the panel uses the first `expose` port (or the internal port of
  `ports`) and only falls back to 80, with a note, when the service declares none.
- **Named volumes** (`dbdata:`) keep the data and survive deploys. Do not use `./folder:/data` for a database.
  Folders **inside the project** (`./uploads:/app/uploads`) are accepted, but a named volume is simpler.
- **`healthcheck` + `depends_on: condition: service_healthy`** makes the app wait for the database to be ready.
- **Migrations** in the `command` (or in an `entrypoint`): the database starts empty on the first deploy.
- **Passwords outside the file**: `${DB_PASSWORD:?message}` has no value in the repository and **blocks the
  deploy with a clear message** if the variable is not filled in. Generate long values (`openssl rand -hex 24`;
  hexadecimal avoids characters that break the database URL).
- **Pinned versions** on the images (`postgres:16-alpine`). `:latest` or no version only gives a warning, but
  makes the deploy unpredictable.
- **The image name is yours** (`example-app:1.0`). Do not use `image: node:22` next to `build:` (nor `nginx`,
  `alpine`, `caddy`): it is blocked.

Variations:

- **MySQL instead of PostgreSQL**: `image: mysql:8.4`, volume at `/var/lib/mysql`, variables
  `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_PASSWORD` and `MYSQL_ROOT_PASSWORD`, and healthcheck
  `["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -p\"$$MYSQL_ROOT_PASSWORD\" --silent"]` (`$$` is how compose
  writes `$`).
- **Ready-made product (WordPress, n8n, Metabase...)**: use the official image, the same layout (web service +
  database + named volumes) and the variables from the product's documentation.
- **Application plus a database only**: delete the `cache` service, the `REDIS_URL` and the `cachedata` volume.

### 3.5 Laravel (PHP) with MySQL and Redis

Four files. The `Dockerfile` uses Apache with PHP, pointing at `public/`, and builds the Vite assets (a default
Laravel uses `@vite` in its views; without the `public/build` folder the page returns a 500 error). If your
project does not use Vite, delete the first stage and the line that copies `public/build`:

```dockerfile
FROM node:22-alpine AS assets
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM composer:2 AS vendor
WORKDIR /app
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-scripts --no-autoloader --prefer-dist
COPY . .
RUN composer dump-autoload --no-dev --optimize

FROM php:8.4-apache
RUN docker-php-ext-install pdo_mysql opcache \
 && pecl install redis-6.1.0 && docker-php-ext-enable redis \
 && a2enmod rewrite \
 && sed -ri 's!/var/www/html!/var/www/html/public!g' /etc/apache2/sites-available/*.conf /etc/apache2/apache2.conf /etc/apache2/conf-available/*.conf
WORKDIR /var/www/html
COPY --from=vendor /app ./
COPY --from=assets /app/public/build ./public/build
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
EXPOSE 80
ENTRYPOINT ["entrypoint.sh"]
CMD ["apache2-foreground"]
```

This `Dockerfile` is the exception to the "run without being root" rule of recipe 3.3: the official Apache starts as
root only to open port 80 and serves requests as `www-data`. The panel still drops extra privileges from the
container. If a Vite plugin reads files from `vendor/` (Livewire, for example), copy `vendor` into the `assets`
stage too.

`.dockerignore` (the panel already takes out the `.env` it writes, but your `.dockerignore` protects builds made outside the panel):

```text
.git
.env
.env.local
node_modules
vendor
storage/logs
```

This `.dockerignore` keeps `.env.production`, where the public `VITE_*` values the Vite build reads live (or tick them **build** in Variables and declare `ARG` in the `assets` stage). Never put a secret there.

The `assets` stage uses `npm ci`, which **requires `package-lock.json`**: a new Laravel only has it after the first `npm install`, so run it and commit the file. With pnpm or yarn, replace the install lines as in the static Vite site (recipe 3.2).

`docker/entrypoint.sh` (creates the folders the volume leaves empty and runs the migrations):

```bash
#!/bin/sh
set -e
mkdir -p storage/framework/cache storage/framework/sessions storage/framework/views storage/logs bootstrap/cache
chown -R www-data:www-data storage bootstrap/cache
php artisan config:cache
php artisan migrate --force
exec "$@"
```

`compose.prod.yml`:

```yaml
services:
  web:
    build: .
    image: example-laravel:1.0
    restart: unless-stopped
    expose:
      - "80"
    environment:
      APP_ENV: production
      APP_DEBUG: "false"
      APP_URL: https://example.com
      APP_KEY: ${APP_KEY:?set APP_KEY in Variables}
      DB_CONNECTION: mysql
      DB_HOST: db
      DB_PORT: "3306"
      DB_DATABASE: app
      DB_USERNAME: app
      DB_PASSWORD: ${DB_PASSWORD:?set DB_PASSWORD in Variables}
      REDIS_CLIENT: phpredis
      REDIS_HOST: cache
      CACHE_STORE: redis
      SESSION_DRIVER: redis
    volumes:
      - storage:/var/www/html/storage
    depends_on:
      db:
        condition: service_healthy

  db:
    image: mysql:8.4
    restart: unless-stopped
    environment:
      MYSQL_DATABASE: app
      MYSQL_USER: app
      MYSQL_PASSWORD: ${DB_PASSWORD:?set DB_PASSWORD in Variables}
      MYSQL_ROOT_PASSWORD: ${DB_ROOT_PASSWORD:?set DB_ROOT_PASSWORD in Variables}
    volumes:
      - dbdata:/var/lib/mysql
    healthcheck:
      test: ["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -p\"$$MYSQL_ROOT_PASSWORD\" --silent"]
      interval: 5s
      timeout: 3s
      retries: 20

  cache:
    image: redis:7.2-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - cachedata:/data

volumes:
  storage:
  dbdata:
  cachedata:
```

Variables to fill in: `APP_KEY` (generate it on your computer with `php artisan key:generate --show`),
`DB_PASSWORD` and `DB_ROOT_PASSWORD` (different, long values). For email, see
[section 5](#project-email).

Prefer the `predis/predis` package? Install it with Composer, set `REDIS_CLIENT: predis` and remove the `pecl` install from the `Dockerfile`.

With PostgreSQL: `image: postgres:16-alpine`, `DB_CONNECTION: pgsql`, port `5432`, the `pdo_pgsql` extension
(`apt-get install -y libpq-dev` before `docker-php-ext-install`) and the healthcheck from recipe 3.4.

---

## 4. Next.js

<a id="nextjs"></a>

> [!NOTE]
> **Current state:** the panel publishes Next.js in **three ways**: (1) a static site with `output: "export"`;
> (2) an **automatic server**, where it detects Next.js with a server and generates the `Dockerfile` itself
> (nothing is written to your repository); (3) your own `Dockerfile` or compose, which takes priority over the
> automatic one. When to use each, the `NEXT_PUBLIC_*` variables and build memory are in the
> [Next.js guide](nextjs.md). Options A and B below still apply to ways 1 and 3.

**Option A: static site.** In `next.config.js` (or `.mjs`, `.ts`):

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  images: { unoptimized: true },
};
export default nextConfig;
```

The panel recognizes `output: "export"`, runs the build and publishes the `out/` folder. There is no server: do
not use API routes, `getServerSideProps` or middleware.

**Option B: with a server (API, SSR).** Use `standalone` mode and a `Dockerfile` of your own. In `next.config`:

```js
const nextConfig = { output: "standalone" };
export default nextConfig;
```

`Dockerfile` (runs without being root; if the project has no `public/` folder, delete the line that copies it):

```dockerfile
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3000
CMD ["node", "server.js"]
```

`.dockerignore` (the panel already takes out the `.env` it writes; `.env.production`, with public values only, stays):

```text
node_modules
.next
.git
.env
.env.local
```

`HOSTNAME=0.0.0.0` is mandatory: without it Next listens only on localhost and the site returns 502. With a
`package.json` that has `build` and **no** `output: "export"` and no `vite`, the panel uses this `Dockerfile` and
reads the port from `EXPOSE`.

If the app uses a database, write a `compose.prod.yml` like the one in [recipe 3.4](#34-app-with-a-database-composeprodyml)
with `build: .` on the site's service. Mind the `NEXT_PUBLIC_...` variables: Next **bakes them into the code
during the build**. Tick them **build** in the Variables tab and declare `ARG NEXT_PUBLIC_...` in the Dockerfile: the panel passes
them as `--build-arg` (and as `build.args` in compose). Or keep only public values in a committed `.env.production`.

---

## 5. Variables and secrets

### How it works

1. In the project, open the **Variables** tab. The screen lists the variables the compose file asks for
   (`${NAME}`) and suggests the ones from the repository's `.env.example`, without a value.
2. Have a `.env` on your computer? Click **Import .env file**, review it and click **Save variables**.
   Nothing goes to the server before you save.
3. Run the **Deploy**. Variables only take effect on the next deploy.

### Golden rules

- **Never commit the `.env`** or write passwords in the code, in the `Dockerfile` or in the compose file. Put
  `.env` in `.gitignore`. A committed secret must be considered leaked: replace it. The panel warns when it
  finds something that looks like one (`secret-in-code`).
- **Commit a `.env.example`** with only the **names** and fake values (`DB_PASSWORD=replace-with-a-long-value`).
  It feeds the suggestions on the screen.
- **Mark the required ones with `${NAME:?message}`.** If a value is missing, the deploy stops before starting
  and says which one is missing. Without the `:?`, an empty variable slips through silently and the app breaks later.

### What the panel writes, and where

- The variables are stored **encrypted** on the panel's server.
- On deploy, in a **compose** project, the panel writes a `.env` file in the project folder on the VPS
  (restricted permissions, outside Git) with the header "Generated by the panel". Compose uses it to resolve
  `${NAME}` and `env_file: .env`. If **your repository already has a committed `.env`**, the panel **does not
  overwrite it**: it writes the variables separately and says so in the deploy log.
- In a **Dockerfile** project, they become the container's environment variables. The ones ticked **build** and
  declared with `ARG` in the Dockerfile also go to `docker build`.
- In a **static site** without a build, they are not used (there is no server to read them). With a build (Vite
  etc.), only the ones ticked **build** enter the build.
- **"Build" = public.** A ticked variable goes into the site's JavaScript or the image layers. The screen warns
  you (also that the value stays in the image history, `docker history`, and that `--build-arg` shows up in the
  server's process list during the build). Never tick a password or secret key; names that look like secrets
  (`KEY`, `TOKEN`, `SECRET`...) get an extra warning. Reserved names (`PATH`, `NODE_*`, `DOCKER_*`, `GIT_*`...) and values
  with line breaks cannot be ticked.
- The `.env` the panel writes stays **out of the build** (see the warning in [section 3](#3-recipes)).
- The project folder on the VPS is described in
  [Where your projects' files live](operations.md#where-your-projects-files-live).

### Project email

If your app sends email, enable the project's **Email** tab (it needs the [mail server](email-deliverability.md)
configured). On every deploy the panel hands the app `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`,
`MAIL_FROM` and `MAIL_FROM_NAME` (the display name; if you do not set one, the project name is used).

Does your app read **other names** (`MAIL_HOST`, `SMTP_SENHA`, `EMAIL_DE`)? In **Link to project variables**,
choose, for each app name, the email value it receives. In the compose file, write the app's name as required
(for example `MAIL_HOST: ${MAIL_HOST:?}`): the link counts as filled in. The link wins over a value saved
under the same name in Variables.

**Databases and caches stay out of the email network.** The email network is shared by every project with email
enabled; attaching your database to it would make it reachable from other projects' containers. So the panel
attaches to the email network (and hands the `SMTP_*` values to) only the services that may send mail: app, worker,
scheduler and other non-database services. Services with a recognised database/cache image (MySQL, MariaDB,
Postgres, Mongo, Redis, Valkey, SQL Server, ClickHouse and similar), and services with a `build:` whose Dockerfile
ends `FROM` one of those images, are left out. Your app still talks to the database normally, over the project's own
network. The deploy log lists which services joined and which were left out, and why.

Do you have a database-image service that **really sends email**? Mark it with the `tws.mail=true` label in the
compose file (`labels: ["tws.mail=true"]`) and it joins. The `tws.mail=false` label does the opposite: it removes a
non-database service from the email network. For projects already running: on restart the panel disconnects from the
email network any database that an older deploy had attached (the project's own network is never touched); the next
deploy generates the correct override.

---

## 6. Rules that block the deploy

Before starting, the panel checks the compose file. What a hosting service should not ask Docker for is a
**block** and the deploy stops, with the explanation on screen and in the log. Summary and how to fix each
(the full table, with all the fields and examples, is in [Compose rules](compose-rules.md)):

| If your compose file... | Rule | How to fix |
|---|---|---|
| publishes a database port (`"5432:5432"`, `"3306:3306"`, `"6379:6379"`...) | `db-port-exposed` | Delete the `ports` line. The other services reach the database as `db:5432`. |
| has `privileged: true`, `cap_add`, `devices`, `network_mode: host`, `pid: host`... | `privileged-container`, `host-namespace` | Remove the field. A web app rarely needs it. |
| mounts `/var/run/docker.sock` or another server folder (`/srv/data:/data`, `~/x`) | `panel-resource`, `host-mount` | Do not mount the Docker socket (**no override possible**). For data, use a named volume (`data:/data`) or a folder inside the project (`./data:/data`). |
| uses a trivial password (`password`, `admin`, `root`, `123456`, `changeme`...), under 6 characters, or a user equal to the password, **written in the file or coming from a saved Variable** (`${DB_PASSWORD}` set to `123`) | `weak-credentials` | Use `${DB_PASSWORD:?...}` and a long random value in Variables. The user must differ from the password. The message names only the Variable, never its value (whoever sees the report learns that the Variable is weak, but not its value). An existing project with a weak saved password is blocked on the next deploy. |
| publishes `80:80` or `443:443` | `proxy-port-conflict` | Remove it. The panel already handles HTTPS (it is only a block if the project brings its own HTTPS proxy). |
| uses `container_name`/`hostname` with a panel name (`tws-panel`, `paas-caddy`...) or starting with `paas-`/`tws-` (the same goes for the web service's name), a volume or network `name:` of the panel, or `image: node` next to `build:` | `reserved-name`, `panel-resource`, `panel-image` | Pick another name (or remove `container_name`). Do not use `name:` on volumes and networks. |
| uses a field the panel does not know | `unsupported-field` | Remove the field named in the message. |

Each message shows the **file, the service and the exact spot**, plus a suggestion. For what each rule accepts
and rejects, and the difference between what can and cannot get an **override**, read
[Compose rules](compose-rules.md). See also
[Deploy blocked by guardrail](troubleshooting.md#deploy-bloqueado-por-guardrail).

---

## 7. Checklist and "it went wrong, now what?"

### Before the first deploy

- [ ] The code is in Git and **on the branch** I will publish (`git push` done).
- [ ] There is a `compose.prod.yml`, `Dockerfile`, `package.json` with `build` or an `index.html` in the root,
      according to the [table](#my-project-is-what-to-prepare).
- [ ] The app listens on `0.0.0.0` on the port I declared (`EXPOSE` or `expose`).
- [ ] No database published in `ports`; no `privileged`, `docker.sock` or server folder mounted.
- [ ] No password written in the files. `.env` is in `.gitignore` and a `.env.example` exists.
- [ ] Important data is in **named volumes**.
- [ ] Image versions pinned (`postgres:16-alpine`, not `latest`).
- [ ] Domain: A records (and `www`) pointing to the VPS, **grey** cloud on Cloudflare. (You can create the
      project before DNS propagates.)
- [ ] Private repository: the **Test access** button said "Access confirmed".
- [ ] In the **Variables** tab, all the required ones are filled in.
- [ ] When creating, the **Security guardrails** list shows no red items (yellow and grey ones only warn).
- [ ] The `Dockerfile` with `COPY . .` has a `.dockerignore` (the panel already takes out the `.env` it writes, but yours protects builds outside the panel).
- [ ] Site with browser-side routes (React Router etc.): the **Single-page application** option is on.
- [ ] Variables read by the static build are ticked **build** and are public.

### It went wrong, now what?

1. **Read the deploy log** (**Deploys** tab, open the latest). A deploy has 5 steps: code ingestion,
   preparation, build and start, proxy and health check. The step that failed tells you where to look. When a
   compose fails, the log has a **Por que falhou** block (written in Portuguese) with the last lines of the sick service.
2. **Look at the Logs tab** for what the app wrote after starting: the state of each service (running,
   healthy, restarts) and the log lines, with errors marked. Details in
   [Features](features.md#project-deploys). Secrets are hidden only on a best-effort basis: do not make the
   app write passwords to the log.
3. **Common messages:**
   - `faltam variáveis obrigatórias do compose: NAME` (required compose variables are missing): fill them in
     under **Variables** and deploy again.
   - `Deploy bloqueado: N violação(ões)` (deploy blocked): fix what the window shows ([section 6](#6-rules-that-block-the-deploy)).
   - `Tipo de projeto desconhecido` (unknown project type): there is no `compose`, `Dockerfile`, `package.json`
     with `build` or `index.html` ([section 2](#2-how-the-panel-decides-what-to-do)).
   - `Informe a porta exposta pelo container` (give the container's exposed port): the last stage of the `Dockerfile` lacks
     `EXPOSE`; fill in **Service port**.
   - `health check falhou` (health check failed): the app did not answer in time (the panel waits about 1 minute
     for HTTP and up to 90 seconds for HTTPS). Look at the **Logs** tab. The most common causes: the app listens
     only on `localhost`, the proxy port is wrong, or the migrations take longer than the deadline. A 4xx on
     the root does not fail the deploy; a 5xx does.
   - Certificate not issued: almost always wrong DNS or an orange cloud on Cloudflare
     ([Troubleshooting](troubleshooting.md#caddy-does-not-issue-a-certificate)).
4. **Still stuck?** [Troubleshooting](troubleshooting.md) and [Help and feedback](help.md).

> The panel's server messages above (deploy log, guardrail cards) are written in Portuguese even when the
> interface is in English; they are quoted here exactly as they appear.

---

## 8. Using an AI assistant

If an AI assistant (Claude, ChatGPT, Cursor, Copilot...) is helping you organize the repository, paste the text
below into the conversation, **inside the project folder**, and let it work. Replace what is between `<...>`.

````text
Prepare this repository to be published on TWS Panel (a self-hosted PaaS that runs everything in Docker
containers, with automatic HTTPS through a central Caddy). Only change the repository; do not run anything on
a server and do not read or show the contents of .env files.

How the panel decides what to do, in the repository root, using the first rule that fits:
1. If compose.paas.yml, compose.prod.yml, compose.production.yml, docker-compose.prod.yml, compose.yml or
   docker-compose.yml exists (in this order), it is adopted without being rewritten.
2. Dockerfile without package.json: one container, port from the EXPOSE of the last stage.
3. package.json: if a Dockerfile exists, the Dockerfile has priority (even for Vite or Next export), with a
   warning; a package.json without a "build" script but with a Dockerfile also uses the Dockerfile. Without a
   Dockerfile: if it has `next` without output "export", it is Next.js with a server (the panel generates the
   Dockerfile). With a "build" script: Vite, Next with output "export", or out/dist/build with an index.html is
   a static site (build on Node 22, folder served by nginx).
4. index.html in the root without a build: static site.
The type can also be chosen by hand on the detection screen (the panel checks that the code fits).

Mandatory rules:
- Project type: <static site | app with Dockerfile | app with database | Next.js (export or server) | Laravel>. App port: <3000>.
  Database/cache: <PostgreSQL | MySQL | Redis | none>. Example domain: example.com.
- The app listens on 0.0.0.0 (not localhost), on the port declared in EXPOSE (Dockerfile) or expose (compose).
- Dockerfile: pinned base image version, non-root process (USER; exception: the official PHP Apache image,
  which serves as www-data), no secrets in ENV/ARG. Every Dockerfile with "COPY . ." needs a .dockerignore that
  excludes .env (and .git, node_modules, vendor); the panel already takes the .env it writes out of the build,
  but the .dockerignore protects builds outside the panel. Do not name the built image node, nginx, alpine, caddy, tws-panel or paas-*.
- With more than one service, use compose.prod.yml. Do not declare networks (the default network is already
  internal). Use "expose" instead of "ports" and NEVER publish database ports (5432, 3306, 6379, 27017...),
  80 or 443. Give the site's service a name such as web or app.
- Data in named volumes declared at the end of the file. Never mount server folders, "/", docker.sock, and
  never use privileged, cap_add, devices, network_mode: host or pid: host; avoid container_name.
- Databases with a healthcheck, and the app with depends_on condition service_healthy. Migrations in the app's
  command/entrypoint (for example "php artisan migrate --force" or "npm run migrate").
- Secrets NEVER in the file: use ${VAR:?message} for every password, key and token. Database user different
  from the password (use "app", not "postgres" or "admin"). No values such as password, admin, root, 123456,
  changeme.
- Create a .env.example with the variable names and fake values, and make sure .env is in .gitignore.
- Third-party images with a pinned version (no :latest) and no development tools (phpMyAdmin, Adminer,
  Mailhog, Mailpit) in the production file.
- Do not use unusual compose fields; the panel blocks fields it does not know.
- Node server with a package.json without a "build" script and with a Dockerfile: the panel uses the
  Dockerfile (port from the EXPOSE of the last stage).
- Next.js with a server and no Dockerfile: the panel generates the image; set `output: "standalone"` in next.config, commit the lockfile and never put a secret in NEXT_PUBLIC_* (it goes into the site's JavaScript).
- Static builds (Vite, Next export) only receive the Variables ticked "build" in the panel (or public values in a
  committed .env.production): VITE_*/NEXT_PUBLIC_* only with public values, never a secret. For a SPA with
  browser-side routes, tell me to turn on "Single-page application".
- Laravel: build the Vite assets in the Dockerfile and install the phpredis extension (or use REDIS_CLIENT=predis).
- Check "Service port" on the detection screen (the panel uses the first expose port; with neither expose nor
  ports, the guess is 80).

Deliver: the files created or changed, the list of variables I must fill in on the panel's Variables screen
(names only, with one sentence on what each is), and how to generate safe values (openssl rand -hex 24).
At the end, check each rule above item by item and say what could not be met.
````

If an AI assistant uses the panel in your place, also read [AI access (API tokens)](ai-access.md): a scoped
token lets the assistant read projects and logs without your password.
