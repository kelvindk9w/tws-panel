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
  name you type and also for the **pair with and without `www`** (`@` and `www`). On Cloudflare, keep the
  cloud **grey** (DNS only). With the orange cloud the certificate is not issued. The screen shows the exact
  records. More in [Features](features.md#project-deploys) and in
  [Troubleshooting](troubleshooting.md#the-site-opens-without-www-but-not-with-www-or-the-other-way-round).

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
   `compose.paas.yml`, `compose.prod.yml`, `compose.production.yml`, `docker-compose.prod.yml`,
   `compose.yml`, `docker-compose.yml` (and the `.yaml` versions). It **never rewrites** your file.
2. **Dockerfile without `package.json`.** It becomes a single container. The port comes from the first `EXPOSE` line.
3. **`package.json` with a `build` script.**
   - If it is **Vite**, **Next.js with `output: "export"`**, or `out/`, `dist/` or `build/` with an `index.html`
     is already in the repository, the panel runs the build and publishes the folder as a **static site**. This
     holds **even if a `Dockerfile` exists**: the `Dockerfile` is ignored.
   - With none of those clues and **with** a `Dockerfile`: it uses the `Dockerfile` (as in item 2).
   - With no clues and **without** a `Dockerfile`: it assumes the build produces `dist/` (it may be wrong).
4. **`index.html` in the root**, no build: a static site published as is.

If none of this fits, the screen says "The panel doesn't know how to deploy this code yet" and lists what it publishes.

> [!WARNING]
> **A `package.json` without a `build` script does not count as a Node project.** A Node server (Express,
> Fastify, NestJS...) with a `Dockerfile` and a `package.json` **without** `build` ends up as "unknown". Two ways
> out: create a `compose.prod.yml` (even with a single service it is the most predictable path, recipe in
> [section 3.4](#34-app-with-a-database-composeprodyml)), or add a `build` script to the `package.json`.

### My project is... what to prepare

| My project is... | Prepare in the repository | Recipe |
|---|---|---|
| A page in HTML, CSS and JS without a build | `index.html` in the root | [3.1](#31-static-site-plain-html) |
| React, Vue or Svelte with Vite | `package.json` with a `build` that produces `dist/` and `vite` in the dependencies | [3.2](#32-static-site-with-a-build-vite-react) |
| Next.js with static pages only | `next.config` with `output: "export"` | [4](#4-nextjs) |
| Next.js with a server (API, SSR) | Your own `Dockerfile` (or compose) | [4](#4-nextjs) |
| A single-service app (Node, Python, Go, PHP...), no database | `Dockerfile` with `EXPOSE` | [3.3](#33-app-with-a-dockerfile) |
| An app **with a database**, cache or more than one service | `compose.prod.yml` | [3.4](#34-app-with-a-database-composeprodyml) |
| Laravel (PHP) with MySQL or PostgreSQL | `Dockerfile` + `compose.prod.yml` | [3.5](#35-laravel-php-with-mysql-and-redis) |
| WordPress, n8n, Metabase and similar | `compose.prod.yml` with the official image | [3.4](#34-app-with-a-database-composeprodyml) |

---

## 3. Recipes

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
- The server has no "if not found, show `index.html`" rule. A page that does not exist returns 404.

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
- **Browser-side routes (React Router etc.)**: the static server does not send unknown paths to `index.html`.
  Opening `https://example.com/dashboard` directly gives 404. Use `#` (hash) routes, really generated pages,
  or publish with your own Dockerfile (below).
- **Build variables (`VITE_...`)**: the panel does **not** hand your Variables to the static build. Public
  values (such as your API address) go in a **committed** `.env.production`. Never put a secret there: it
  goes to the browser of whoever visits.

If you need browser-side routing, publish with a `compose.prod.yml` (it has priority over the Vite
detection) and your own `Dockerfile` that serves `dist/` with the rule "if not found, show `index.html`":

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

On the detection screen, set **Service port** = `8080` (with `expose` and no `ports`, the panel's guess is 80).

### 3.3 App with a Dockerfile

For an app with **a single service and no database**. Example for Node (it works the same for any language:
what matters is the `EXPOSE` and listening on all addresses):

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

`.dockerignore` (avoids copying junk and secrets into the image):

```text
node_modules
.git
.env
.env.*
npm-debug.log
```

Rules to make it work:

1. **Write `EXPOSE <port>`** with the port the app listens on. The panel takes the proxy port from it. Without
   `EXPOSE`, the screen asks for the port and you fill in **Service port**.
2. **The app must listen on `0.0.0.0`**, not on `127.0.0.1`/`localhost`. On localhost only the container itself
   can reach it and the site returns a 502 error.
3. **Run without being root** (`USER node`, or create a user). It helps security, and the panel already drops
   extra privileges from the container.
4. **Do not store data inside the container.** In this mode there is no volume: whatever the app writes to disk
   **is lost on every deploy**. If you need persistent files or a database, use [recipe 3.4](#34-app-with-a-database-composeprodyml).
5. The project's **Variables** reach the container as environment variables (`process.env.NAME`). Do not use
   `ARG`/`ENV` in the Dockerfile for secrets: the panel does not pass `--build-arg`, and the value would be
   baked into the image.

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

Why it is written this way (each item avoids a block or a common problem):

- **Internal network.** Do not declare `networks:`. Compose already creates a private network for the project,
  and the services talk to each other by **name** (`db`, `cache`). The panel connects **only the web service**
  to the proxy network by itself.
- **`expose` instead of `ports`.** `expose` only opens the port to the other containers. `ports` would publish
  on the VPS: a database one (5432, 3306, 6379...) is **blocked**, and the panel removes 80/443 by itself.
- **Which service gets the site.** The panel picks the service by name (`web`, `app`, `frontend`, `site`...) or
  by image (`caddy`, `nginx`, `traefik`). Give the site's service one of those names. **Check the "Web service"
  and "Service port" on the detection screen**: if the service only uses `expose`, the guess may come out as
  80 and you correct it to the right port (3000 here).
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

Four files. The `Dockerfile` uses Apache with PHP, pointing at `public/`:

```dockerfile
FROM composer:2 AS vendor
WORKDIR /app
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-scripts --no-autoloader --prefer-dist
COPY . .
RUN composer dump-autoload --no-dev --optimize

FROM php:8.4-apache
RUN docker-php-ext-install pdo_mysql opcache \
 && a2enmod rewrite \
 && sed -ri 's!/var/www/html!/var/www/html/public!g' /etc/apache2/sites-available/*.conf /etc/apache2/apache2.conf /etc/apache2/conf-available/*.conf
WORKDIR /var/www/html
COPY --from=vendor /app ./
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
EXPOSE 80
ENTRYPOINT ["entrypoint.sh"]
CMD ["apache2-foreground"]
```

If you use Redis through Laravel with the `phpredis` extension, add `pecl install redis && docker-php-ext-enable redis`;
with the `predis/predis` package you need nothing.

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

With PostgreSQL: `image: postgres:16-alpine`, `DB_CONNECTION: pgsql`, port `5432`, the `pdo_pgsql` extension
(`apt-get install -y libpq-dev` before `docker-php-ext-install`) and the healthcheck from recipe 3.4.

---

## 4. Next.js

<a id="nextjs"></a>

> [!NOTE]
> **Current state:** the panel publishes Next.js today in two ways, described below. **Automatic support for
> Next.js with a server** (detecting it by itself and generating what is needed, without you writing a
> `Dockerfile`) **is under development** and will be described on its own page when it ships.

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

`HOSTNAME=0.0.0.0` is mandatory: without it Next listens only on localhost and the site returns 502. With a
`package.json` that has `build` and **no** `output: "export"` and no `vite`, the panel uses this `Dockerfile` and
reads the port from `EXPOSE`.

If the app uses a database, write a `compose.prod.yml` like the one in [recipe 3.4](#34-app-with-a-database-composeprodyml)
with `build: .` on the site's service. Mind the `NEXT_PUBLIC_...` variables: Next **bakes them into the code
during the build**. With a plain Dockerfile the panel does not pass `--build-arg`; use `build.args` in the
compose file (with `${VAR}` coming from Variables) or keep only public values in a committed `.env.production`.

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
- In a **Dockerfile** project, they become the container's environment variables.
- In a **static site**, they are not used (there is no server to read them).
- The project folder on the VPS is described in
  [Where your projects' files live](operations.md#where-your-projects-files-live).

### Project email

If your app sends email, enable the project's **Email** tab (it needs the [mail server](email-deliverability.md)
configured). On every deploy the panel hands the app `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`,
`MAIL_FROM` and, if you set one, `MAIL_FROM_NAME`.

Does your app read **other names** (`MAIL_HOST`, `SMTP_SENHA`, `EMAIL_DE`)? In **Link to project variables**,
choose, for each app name, the email value it receives. In the compose file, write the app's name as required
(for example `MAIL_HOST: ${MAIL_HOST:?}`): the link counts as filled in. The link wins over a value saved
under the same name in Variables.

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
| uses a trivial password (`password`, `admin`, `root`, `123456`, `changeme`...), under 6 characters, or a user equal to the password | `weak-credentials` | Use `${DB_PASSWORD:?...}` and a long random value in Variables. The user must differ from the password. |
| publishes `80:80` or `443:443` | `proxy-port-conflict` | Remove it. The panel already handles HTTPS (it is only a block if the project brings its own HTTPS proxy). |
| uses `container_name: tws-panel`, names or volumes starting with `paas`/`tws`, or `image: node` next to `build:` | `reserved-name`, `panel-image` | Pick another name (or remove `container_name`). |
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
- [ ] When creating, the **Security guardrails** count has no `block` lines.

### It went wrong, now what?

1. **Read the deploy log** (**Deploys** tab, open the latest). A deploy has 5 steps: code ingestion,
   preparation, build and start, proxy and health check. The step that failed tells you where to look. When a
   compose fails, the log has a **Why it failed** block with the last lines of the sick service.
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
   - `Informe a porta exposta pelo container` (give the container's exposed port): the `Dockerfile` lacks
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
2. Dockerfile without package.json: one container, port from the first EXPOSE line.
3. package.json with a "build" script: if it is Vite, Next with output "export", or out/dist/build with an
   index.html already exists, it is a static site (the build runs on Node 22 and the folder goes to an nginx),
   even if a Dockerfile exists. With none of those clues and with a Dockerfile, it uses the Dockerfile.
4. index.html in the root without a build: static site.
A package.json WITHOUT a "build" script does not count; for a Node server, create a compose.prod.yml.

Mandatory rules:
- Project type: <static site | app with Dockerfile | app with database | Next.js | Laravel>. App port: <3000>.
  Database/cache: <PostgreSQL | MySQL | Redis | none>. Example domain: example.com.
- The app listens on 0.0.0.0 (not localhost), on the port declared in EXPOSE (Dockerfile) or expose (compose).
- Dockerfile: pinned base image version, non-root process (USER), .dockerignore with .git and .env, no
  secrets in ENV/ARG. Do not name the built image node, nginx, alpine, caddy, tws-panel or paas-*.
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

Deliver: the files created or changed, the list of variables I must fill in on the panel's Variables screen
(names only, with one sentence on what each is), and how to generate safe values (openssl rand -hex 24).
At the end, check each rule above item by item and say what could not be met.
````

If an AI assistant uses the panel in your place, also read [AI access (API tokens)](ai-access.md): a scoped
token lets the assistant read projects and logs without your password.
