---
title: "Writing a compose the panel accepts"
description: "What each deploy guardrail blocks, how to write the compose file and the Dockerfile so the deploy passes, how to read the error message and what to change."
sidebar:
  label: "Compose rules"
---

Before it starts a project, the panel checks the compose file against a list of what a hosted project is
allowed to ask Docker for. Anything outside the list is a **block** and the deploy stops. This page
shows what each rule blocks, how to write the project so it passes and how to read the message when it does not.

> [!NOTE]
> **Interface language.** The rule names (`host-mount`, `db-port-exposed`...) are the same in both languages, but the **title**, the **evidence** and the **suggested fix** of each block are written by the server in Portuguese, even with the interface in English. This page quotes them as they appear and explains each one.

> Also read: [Deploy blocked by a guardrail](troubleshooting.md#deploy-bloqueado-por-guardrail) for the override
> and the audit log, and [Security](../reference/security.md) for why the rules exist.

---

## When the check runs

The panel checks the project three times, and the message looks different in each one:

1. **When you click Deploy.** The panel reads the compose file as written and, if anything blocks, opens the
   **Deploy blocked by guardrails** window before creating the job. This is where you see the full card of each block.
2. **After the code is downloaded.** The same check runs again over the code that was actually fetched (it may have changed
   since the first one, mainly in a Git project).
3. **On the resolved compose, right before `docker compose up`.** The panel asks Docker for the compose the way it
   will run it (`include`, `extends`, merges and `${VARIABLE}` already resolved) and checks that. It catches what the first
   check could not see, for example a folder that only exists once a variable is filled in. A failure here is a
   **failed deploy** with the message in the log, not the window of step 1.

Only warnings (`warn`) and information (`info`) never stop a deploy.

## How to read the message

Each block in the window has this shape:

| Part | Example | What it tells you |
|---|---|---|
| Badge | `block` | `block` stops the deploy, `warn` and `info` only advise. |
| Title | `Pasta do servidor montada no container` | What kind of problem it is. |
| `[rule]` | `[host-mount]` | The rule's name. Look it up in the [table below](#what-each-rule-blocks). |
| Evidence | `compose.yml: serviço "app" monta /srv/uploads de fora da pasta do projeto` | **File, service and the exact line of the problem.** The words "serviço" mean "service". Here: service `app` mounts `/srv/uploads`. |
| 💡 | `Só é permitido montar pastas DENTRO do código do projeto (ex.: ./dados). Use um volume nomeado para o resto.` | What to change. |

The same lines go to the deploy log in the form `✖ BLOCK [rule] title — evidence`. **The log does not
repeat the 💡 suggestion**; to see it, use the rule's row in the table below.

The summary messages you may see are:

- `Deploy bloqueado: N violação(ões) de segurança (block). Corrija ou confirme o override explícito.`: the window of
  step 1. N is the number of blocks. Fix them or, if the rule allows it, confirm the override.
- `guardrail_blocked: N bloqueio(s) de segurança no compose resolvido — deploy requer override explícito.`: step 3, a rule
  that the override can release. The block lines come just above, in the log, under the title
  **Guardrails sobre o compose resolvido (docker compose config)**.
- `guardrail_blocked: N bloqueio(s) de isolamento do painel no compose resolvido — sem override possível.`: step 3, a
  rule that protects the panel. The log says "Estes bloqueios protegem o próprio painel e não têm override" (these blocks protect the
  panel itself and cannot be overridden). **The only way out is to change the compose.**
- `o docker compose não conseguiu interpretar o compose do projeto: ...`: the compose has a syntax or reference
  error. It is not a guardrail: fix the file. The text after the colon is Docker's own message.
- `faltam variáveis obrigatórias do compose: NAME, ...`: not a guardrail either. Fill the variables in the project's
  **Variables** section and deploy again.

> [!TIP]
> Most blocks are fixed by following the 💡 suggestion. If you are about to override, first read
> [which blocks accept it](#which-blocks-accept-an-override).

---

## What each rule blocks

### Always a block, with override

| Rule | What it blocks | How to write it to pass |
|---|---|---|
| `db-port-exposed` | Publishing in `ports` a database container port: 5432 (PostgreSQL), 3306 (MySQL/MariaDB), 6379 (Redis), 27017 (MongoDB), 1521 (Oracle), 1433 (SQL Server), 5984 (CouchDB), 9200 (Elasticsearch). It is the **container** port that counts: `"15432:5432"`, `"5432"` (random host port) and `"127.0.0.1:5432:5432"` also block. | Delete the line from `ports`. The other services reach the database by its service name (`db:5432`) on the project's internal network. For an occasional look, use an SSH tunnel. Without touching the repository, **Overview → Containers → Ports** removes the publication, and publishing it again there only on `127.0.0.1` is a warning, not a block. |
| `weak-credentials` | In a service's `environment`: a variable whose name contains `PASSWORD`, `PASSWD`, `SECRET`, `TOKEN`, `API_KEY` or `PRIVATE_KEY` with a trivial value (`password`, `admin`, `root`, `123456`, `postgres`, `mysql`, `redis`, `mongo`, `changeme`, `test`, `dev`...), with fewer than 6 characters or in the form `user:user`; and a user variable (`...USER`, `...USERNAME`, `...LOGIN`) with the same value as a password variable of the same service. | Use a long random value and keep it out of the Git repository: `POSTGRES_PASSWORD: ${DB_PASSWORD}` with `DB_PASSWORD` filled in the project's **Variables**. Use a user name that is not the password (`app`, not `postgres`/`admin`). |
| `privileged-container` | `privileged: true`; `cap_add`; `devices` and `device_cgroup_rules`; `security_opt` other than `no-new-privileges`; `sysctls`; `provider`; and the fields `use_api_socket`, `gpus`, `runtime`, `cgroup_parent`, `storage_opt`, `credential_spec`, `deploy.resources.reservations.devices`; a `post_start`/`pre_stop` hook with `privileged`. | Remove the field. If the service needs something specific, look for the narrowest option instead of giving it everything. `security_opt: ["no-new-privileges:true"]` is accepted. |
| `host-namespace` | `pid`, `ipc`, `network_mode`, `cgroup`, `uts`, `userns_mode` that share the server's namespace (`network_mode: host`, `pid: host`...) or another container's; `volumes_from: container:...`; `external_links`. | Remove the field. `network_mode: service:other` (sharing with another service **of the same compose**) is accepted, and so are `bridge`, `none` and the defaults. For a service that needs to be reached, use the project's network and its service name. |
| `host-mount` | A bind (`/path:/path`) to a folder **outside** the project's code folder, `~/...`, or a mount type other than volume/bind/tmpfs; a bind **inside another bind that is writable** (for example `./:/app` plus `./data:/data`); and build context, Dockerfile, `env_file`, `secrets` and `configs` sitting inside a writable bind; `label_file`. | Use a named volume (`dados:/data`, declared at the end of the file) or a folder inside the project (`./uploads:/app/uploads`). For the bind-inside-bind case, mount the parent as `:ro` (`.:/app:ro`) or separate the folders. |
| `shared-resource` | A volume or network that is not the project's: `external: true`, a `name:` that is not `<project>_<key>`, a `driver` other than `local` (volume) or `bridge`/`overlay` (network), `driver_opts`. | Declare the volume or network without `external`, without `name:` and without `driver`. |
| `build-outside-src` | In `build`: `context`, `dockerfile` or `additional_contexts` outside the project folder or a remote URL/Git; `cache_from`/`cache_to` with `type=local` (or any type other than `registry`/`inline`), or with `src=`/`dest=`, or with a repeated key; `privileged`, `entitlements` or `ssh`; `network` other than `default`/`none`/`bridge`. Also: `env_file`, `secrets` and `configs` whose file is outside the folder, or `external`. | Keep the context, the Dockerfile and the files they read **inside** the repository. For build cache, use `type=registry` or `type=inline`. |
| `unsupported-field` | Any compose field that is not on the panel's list of accepted fields, including inside `build`, `deploy`, `logging` and at the top of the file. Top level accepts only `name`, `services`, `networks`, `volumes`, `secrets`, `configs` (and `x-...`). Also `logging` with a network driver (`gelf`, `fluentd`...) or `syslog-address`. | Remove the field the evidence names. `x-...` fields are always free. A field that is new in Compose has to be assessed before it is accepted. |
| `invalid-compose` | The compose file does not parse as YAML. | Fix the syntax (indentation, a missing `:`). The 💡 only says "Corrija a sintaxe do arquivo compose antes de deployar". |
| `proxy-port-conflict` | Publishing port 80 or 443 of the server. In an ordinary project it is only a **warning** (the panel removes the publication on its own and the site answers through the proxy). It is a **block** when the project has its own HTTPS proxy (Caddy/Traefik). | Remove `80:80` and `443:443`. With a proxy of its own, create a `compose.paas.yaml` in the repository (the panel gives it priority) without those ports and with the proxy speaking plain HTTP. **No override in this case.** |

### Always a block, without override

These protect the panel itself. Confirming the override in the window does not help: the deploy fails at step 3
with "sem override possível". The compose has to change.

| Rule | What it blocks | How to write it to pass |
|---|---|---|
| `panel-resource` | Any bind that **is or contains** the Docker socket (`/var/run/docker.sock`, in any spelling, or a link to it), `/`, `/proc`, `/sys`, anything under `/run` and `/var/run`, `/var/lib/docker`, the panel's `/data`, the projects folder (outside your own project) and the panel's install folder. Volumes and networks in the panel's space (`paas_*`, `paas-*`, `tws-*`). | Do not mount these. A project that needs to talk to Docker does not belong on this panel. Rename any volume or network that starts with `paas`/`tws`. |
| `network-hijack` | Joining the panel's networks (the proxy's, mail administration, mail delivery) by hand; declaring them with `driver`, `ipam` or without `external`; extra aliases on them. Only the service that serves the site is joined to the proxy network, and by the panel. | Delete the `networks:` entry that points at those networks. The panel connects the web service to the proxy network by itself. |
| `reserved-name` | `container_name`, `hostname`, service name (of the web service) or alias equal to a name of the panel (`tws-panel`, `paas-caddy`, `paas-stalwart`, `paas-webmail`), of another project, or starting with `paas-`/`tws-`/`paas_`/`tws_`; labels starting with `paas.` or `com.docker.compose.`. With email enabled, also names starting with `mail.` and the mail host names. | Choose another name, or simply remove `container_name`. Do not set `paas.*` labels. |
| `panel-image` | An image or a build tag that is `tws-panel` or `paas-...` of another project; and a `build` that writes the tag of an image the panel runs (`alpine`, `caddy`, `nginx`, `node`, `stalwart`, `roundcube`). | When you use `build:`, do not put `image: node:20` (or those names) next to it: use your own name, such as `image: example-app:1.0`, or remove `image`. |

### Warnings and information (never stop the deploy)

| Rule | Level | What it flags | What to do |
|---|---|---|---|
| `dev-service-in-prod` | warn | Image of a development tool: Mailhog, Mailpit, phpMyAdmin, Adminer, pgAdmin, MongoDB Compass, RedisInsight, Selenium, or any image with `debug` in its name. | Keep it in the development compose only. |
| `secret-in-code` | warn | A likely committed secret (AWS key, PEM private key, GitHub, Slack, Google, Stripe tokens, or `...SECRET`/`TOKEN`/`API_KEY`/`PASSWORD = "long dense value"`) in `.js`, `.ts`, `.py`, `.php`, `.json`, `.yml`, `.env*`, `.sql` and similar files. | Remove it from the code, **consider the credential compromised and replace it**, and pass it as a project variable. |
| `latest-tag` | info | An image without a version or with `:latest`. | Pin it: `redis:7.2-alpine`. |

---

## Which blocks accept an override

- **The window of step 1** offers **I understand the risks and want to deploy anyway (override)** for every block, except
  the one in `proxy-port-conflict` with its own proxy. The override is **audited** (`guardrail.override`) and
  the log says "Override explícito do operador".
- **The four rules without override** (`panel-resource`, `network-hijack`, `reserved-name`, `panel-image`) are
  refused again at step 3, even if you confirmed the override in the window. Do not spend time on it: change the compose.
- A block found only at **step 3** (the resolved compose) fails the deploy without a window. See
  [the gaps below](#known-limits-of-the-messages) on how to proceed.

---

## Writing the compose: before and after

A compose with several of the problems above (everything here is an example: `example.com`, nothing real):

```yaml
# before: blocked
services:
  app:
    build: .
    image: node:20
    container_name: tws-panel
    privileged: true
    ports:
      - "443:443"
    volumes:
      - /srv/uploads:/app/uploads
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      DATABASE_URL: postgres://app:secret-pass@db:5432/app
  db:
    image: postgres
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: admin
```

What the panel says, in the order of the compose:

- `app` — `image: node:20` with `build:` → `panel-image` (no override).
- `app` — `container_name: tws-panel` → `reserved-name` (no override).
- `app` — `privileged: true` → `privileged-container`.
- `app` — publishes `443` → `proxy-port-conflict` (a warning here; the panel removes it).
- `app` — `/srv/uploads` → `host-mount`.
- `app` — `/var/run/docker.sock` → `panel-resource` (no override).
- `db` — publishes `5432` → `db-port-exposed`.
- `db` — `POSTGRES_PASSWORD: admin` → `weak-credentials`.
- `db` — `postgres` with no version → `latest-tag` (info).

The same project, written to pass:

```yaml
# after: accepted
services:
  app:
    build: .
    image: example-app:1.0
    expose:
      - "3000"
    volumes:
      - ./uploads:/app/uploads
    environment:
      DATABASE_URL: postgres://app:${DB_PASSWORD}@db:5432/app
    depends_on:
      - db
  db:
    image: postgres:16-alpine
    volumes:
      - dbdata:/var/lib/postgresql/data
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: ${DB_PASSWORD}

volumes:
  dbdata:
```

Fill `DB_PASSWORD` in the project's **Variables** (for example the output of `openssl rand -hex 24`) before the deploy.
The site is reached through the project's domain: you do not publish `3000`, `80` or `443`.

### Another common case: the whole folder as a bind

For development it is common to write `.:/app`. Together with a `Dockerfile` or an `env_file: .env` in the root
of the repository, the panel blocks it (`host-mount`, "Arquivo lido pelo painel dentro de uma pasta montada com
escrita"), because the app could replace that folder with a link to the server and the panel would read it during the build.

```yaml
# before: blocked
services:
  web:
    build: .
    env_file: .env
    volumes:
      - .:/app

# after: accepted
services:
  web:
    build: .
    env_file: .env
    volumes:
      - .:/app:ro
      - ./storage:/app/storage   # only if the app must write here
```

Better still, for production: do not bind the code. The `build:` already copies it into the image (`COPY . .`), and
the volume is only for data (`dados:/app/storage`).

## Writing the Dockerfile

The panel does not read the Dockerfile's instructions; it checks the `build` section of the compose and the files the
build reaches. To keep it from blocking:

- Keep the **build context and the Dockerfile inside the repository.** `context: ..`, `context: /srv/app` or a
  `git@...` context are blocks; a Dockerfile in a subfolder (`dockerfile: docker/Dockerfile`) is fine.
- `COPY`/`ADD` only reach what is in the context. Anything the image needs (the application, configuration) has to be in the
  repository, not in a server folder.
- Do not ask the build for `privileged`, `ssh`, `entitlements` or `network: host`.
- Do not name the image you build `node`, `nginx`, `alpine`, `caddy`, `stalwart`, `roundcube`, `tws-panel`
  or `paas-...`. Use your own name.
- Do not write the password into `ENV` or `ARG` or into a committed `.env`: the `secret-in-code` scan looks at `.env*`,
  `.yml`, `.json`, `.py`, `.js`... and the credential would be in the image history. Use a project variable.
- Use a fixed version in `FROM` (`FROM node:20-alpine`); `latest-tag` is only information, but it keeps the
  deploy repeatable.

## Checking before the deploy

1. Open the project and look at the guardrails count shown on the page (**Guardrails (N)**) or, on the
   creation screen, **Security guardrails (N)**: they come from the same check, without deploying.
2. Fix the `block` lines. The `warn` and `info` lines may stay.
3. Deploy. If it fails at step 3, read the log from **Guardrails sobre o compose resolvido (docker compose config)** on.

---

## Known limits of the messages

- The log lines of a block carry the title and the evidence, **without** the 💡 suggestion. If you only
  have the log, use the table above.
- A block found only in the resolved compose (step 3) is **not** shown in the window and the project page has no
  button to override it, even though the summary says "deploy requer override explícito". The practical way
  out is to change the compose. Typical cause: a `${VARIABLE}` that, once filled, becomes a path outside the project.
- The window offers the override for the four rules that never accept one; the refusal only comes afterwards,
  in the log.
