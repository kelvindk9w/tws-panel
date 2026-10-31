---
title: "Migrating to separated networks: VPS runbook and rollback"
description: "Runbook for updating an existing installation to the version with separated Docker networks, with checks, failure handling and how to roll back."
sidebar:
  label: "Network migration"
---

Applies to an installation that already runs the panel (folder `/opt/tws-panel`, projects in `/opt/tws-projects`) and is going to
receive the version with separated networks. A new installation does not need this: the networks are created correctly.

> [!NOTE]
> **Interface language.** The panel is available in English and Portuguese ([how to choose](../getting-started/complete-guide.md#idioma-da-interface)). This page quotes the English labels exactly as they appear on screen. The log lines and notices this page quotes come from the server and are still in Portuguese in both languages; each one comes with its English meaning.

## What changes in the networks

| Network | Who is on it |
|---|---|
| `paas-net` | Caddy (`paas-caddy`) and the projects' web services. **The panel, Stalwart and webmail leave it.** |
| `paas-panel` | Only Caddy and the panel (`tws-panel`); webmail too, so Caddy can reach it. |
| `paas-mail-admin` | Only the panel and Stalwart (`paas-stalwart`): the email administration. |
| `paas-mail` | Stalwart, webmail and the services of projects with email enabled (SMTP/IMAP). |

> A compose service with `network_mode: service:X` (sharing another service's network) gets no network of its own: the panel attaches the owner service (`X`) to `paas-mail`, and the services sharing its network reach the mail server through it.

> Databases and caches (recognised image, or `tws.mail=false`) do **not** join `paas-mail` and do not receive `SMTP_*`; any already attached by an older deploy are disconnected from it during the migration (only from it: the project's own network, which the database uses to talk to the app, is untouched). To keep a database-image service that sends mail, use the `tws.mail=true` label. A service that shares a database's network (`network_mode: service:db`) has no other way to reach the mail server: it is left out together with it, without `SMTP_*`, and the deploy log tells you to label the **owner** (`db`) with `tws.mail=true`; once the owner is labelled, both join. The panel stamps each service with `tws.mail.decided` (`in`/`out`) and on restart only follows the stamp; containers from before the stamp (no stamp) are attached to `paas-mail` as always, so they do not lose email when Stalwart leaves `paas-net`, except those with a recognised database image, which are disconnected from it.

What happens on its own (nothing is recreated, only `docker network connect/disconnect`):

1. Panel up and served by domain: at boot (and on every deploy or proxy update) Caddy joins
   `paas-panel`, the panel joins it and, **only after Caddy's reload**, the panel leaves `paas-net`. With access by
   tunnel (no panel domain) the panel leaves `paas-net` immediately.
2. About 1 minute after boot (and again on every certificate renewal, until it succeeds), if there is a mail
   server: Stalwart joins `paas-mail-admin` and `paas-mail`; the panel joins `paas-mail-admin`; the
   already-running containers of projects with email join `paas-mail`; webmail moves to `paas-panel` +
   `paas-mail`; lastly Stalwart leaves `paas-net`. If Stalwart does not join the new networks, **nothing** is
   moved.
3. At boot, the panel log warns about old containers on `paas-net` that carry a panel name
   (`tws-panel`, `paas-*`, `tws-*`) as an alias. The panel only warns; you decide.

Effects you will notice: projects are now checked against a closed list of compose fields
(an unknown field, `privileged`, a bind outside the folder, a volume or network of the panel, `docker.sock` etc. block
the deploy), and every container starts without `NET_RAW` and with `no-new-privileges`. A compose that relied on this is
blocked **on the next deploy** (containers that are already running stay as they are).

## Runbook

Sign in to the VPS over SSH with your user. All the commands below run with `sudo`.

### Step 0 — note the current state (this is what lets you go back)

```
cd /opt/tws-panel
sudo git status -sb | head -1
sudo git log --oneline -1
sudo docker network ls --format '{{.Name}}' | grep -E '^paas'
sudo docker inspect -f '{{json .NetworkSettings.Networks}}' tws-panel
sudo docker inspect -f '{{json .NetworkSettings.Networks}}' paas-stalwart
sudo docker network inspect paas-net --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}'
```

Write down: the **branch** (first line of `git status -sb`), the **commit hash** and who is on `paas-net`. If you
do not use email, the `paas-stalwart` commands will say "No such object": that is normal.

### Step 1 — update

```
cd /opt/tws-panel && sudo git pull && sudo git log --oneline -1 && sudo docker compose up -d --build
```

The first time it downloads the Alpine, Caddy, nginx, node and Stalwart images **by digest** (it needs access to the
registry). To verify: the command finishes without error and `sudo docker ps --filter name=tws-panel --format '{{.Status}}'`
shows `Up`. If the `build` fails, the old panel keeps running and **nothing changed**: see the "If it fails midway" section.

Installation outside `/opt/tws-panel` that only does `git pull`: the panel does not know where its folder is and keeps protecting
`/opt/tws-panel` (the `.env` with the secrets could be mounted by a project compose with an override). Run
`./scripts/install.sh` again, or add `PAAS_HOST_REPO_DIR=<real path of the folder, without symlinks>` to `.env` and run
`docker compose up -d`.

### Step 2 — panel and Caddy

Wait about 1 minute and check:

```
sudo docker logs --tail 40 tws-panel
sudo docker network inspect paas-panel --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}'
sudo docker network inspect paas-net --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}'
```

Expected: `paas-panel` with `paas-caddy` and `tws-panel`; `paas-net` **without** `tws-panel`; in the log, no
"falha ao conectar" (failed to connect) or "o painel continua na rede paas-net" (the panel is still on the paas-net network) line. Then:

- open `https://<panel domain>` and sign in with your credentials (the sign-in screen has to respond);
- open a project's site in another tab (Caddy responds);
- `sudo docker logs --tail 40 paas-caddy` must not show any "no such host" error.

### Step 3 — email (only if you use the mail server)

Wait another 1 or 2 minutes (the migration runs on certificate renewal) and check:

```
sudo docker network inspect paas-mail-admin --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}'
sudo docker network inspect paas-mail --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}'
sudo docker network inspect paas-net --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}'
```

Expected: `paas-mail-admin` = `tws-panel` + `paas-stalwart`; `paas-mail` = `paas-stalwart`, `paas-webmail` (if enabled) and
the containers of projects with email; `paas-net` without `paas-stalwart` or `paas-webmail`.

Real tests:

1. On the panel's **Email** page, the server status shows as running (the panel talks to Stalwart
   over `paas-mail-admin`).
2. A project's SMTP: use the send test of the project itself / of the panel's **Email** page. To check only the network
   (replace `<domain>` with yours):
   `sudo docker run --rm --network paas-mail alpine:3 nc -zv -w 5 mail.<domain> 587` — it should say `open`.
3. Webmail (if enabled): open its address; it has to load and let you sign in.
4. Isolation proof (name resolution should **fail**):
   `sudo docker run --rm --network paas-net alpine:3 sh -c 'nslookup paas-stalwart; nslookup tws-panel'`

### Step 4 — projects

Check the panel log and look for the reserved alias warning (item "3" above):
`sudo docker logs tws-panel 2>&1 | grep -i "responde pelo nome"` (the log message is in Portuguese; the text means "answers to the name"). For each container mentioned, fix the project's
compose and deploy again (or, to take it off the network now, the command the warning itself shows).

Do a test deploy of an ordinary project. If the panel blocks it (`guardrail_blocked`), the screen shows which field; the
rules that protect the panel (`reserved-name`, `network-hijack`, `panel-image`, `panel-resource`) have no
override.

## If it fails midway

| What happened | State | What to do |
|---|---|---|
| `docker compose up -d --build` failed (for example, no registry access to download by digest) | The old panel keeps running; nothing changed. | Fix the access and run the step 1 line again. |
| Log: "falha ao conectar … à rede paas-panel" (failed to connect … to the paas-panel network) or "falha ao criar a rede" (failed to create the network) | The panel **stays on `paas-net`**; the site stays up. | Usually there is no free address for the new network: `sudo docker network create --label paas.managed=true --subnet 172.29.0.0/24 paas-panel` (pick a range that `docker network inspect` of the other networks does not use). Restart the panel: `cd /opt/tws-panel && sudo docker compose restart`. |
| Log: "o painel continua na rede paas-net" (the panel is still on the paas-net network) | The panel is on both networks. | No urgency. Try `sudo docker network disconnect paas-net tws-panel` once Caddy already answers on the panel's domain. |
| Log: "E-mail: migração para as redes separadas falhou" (Email: migration to the separate networks failed) | Stalwart **did not** move; email stays as before. | The migration repeats on the next certificate renewal. To force it: `sudo docker network connect paas-mail-admin paas-stalwart` and `sudo docker network connect paas-mail paas-stalwart` (with the aliases: see "Rolling back" below), then `sudo docker restart tws-panel`. |
| Log: "não consegui ligar o projeto X à rede de e-mail" (could not connect project X to the email network) | That project has no SMTP until its next deploy. | Deploy project X (the panel connects it to `paas-mail`) or `sudo docker network connect paas-mail <project-container>`. |
| Log: "o webmail não mudou de rede agora" (webmail did not change network now) | Webmail stays on the old network. | `sudo docker network connect paas-panel paas-webmail` and `sudo docker network connect paas-mail paas-webmail`; then `sudo docker network disconnect paas-net paas-webmail`. |
| Panel does not open by domain after step 1 | Caddy must reach `tws-panel` through `paas-panel`. | `sudo docker network connect paas-panel paas-caddy` and `sudo docker network connect paas-panel tws-panel` ("already exists" message is normal). If it still does not open, connect the panel to the old network again: `sudo docker network connect paas-net tws-panel` and go on to "Rolling back". |

## Rolling back to the previous version

What the panel does on its own when going back is **not everything** (checked by reading the previous version's code):

- **Panel ↔ Caddy:** the old version, at boot and on every proxy update, connects the panel to `paas-net` again
  (only if the panel is served by domain). This is automatic.
- **Stalwart:** the old version only connects it back to `paas-net` when `mail.<domain>` hosts exist (it reconnects
  it with the aliases when starting the mail server or renewing certificates). With no mail domains
  registered, it **does not reconnect**. Do it by hand (below).
- **Webmail:** the old version does **not** reconnect its network. Do it by hand.
- **Projects with email:** they stay connected to `paas-mail` (harmless); they reach Stalwart again as soon as it
  returns to `paas-net`. The next deploy on the old version recreates them without `paas-mail`.

Steps:

```
cd /opt/tws-panel
sudo git checkout <hash noted in step 0>
sudo docker compose up -d --build
```

Then, **by hand** (whatever applies; "already exists" is normal):

```
sudo docker network connect paas-net tws-panel
sudo docker network connect --alias paas-stalwart --alias mail.<domain> paas-net paas-stalwart
sudo docker network connect paas-net paas-webmail
```

On the Stalwart line repeat `--alias mail.<domain>` for each registered mail domain and the mail
server's hostname (it is by these names that projects find SMTP in the old version). If Stalwart is already on
`paas-net` without the aliases, first run `sudo docker network disconnect paas-net paas-stalwart`.

To verify: panel sign-in; `sudo docker network inspect paas-net --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}'`
lists `tws-panel`, `paas-stalwart` and `paas-webmail` again; a project's SMTP and webmail respond.

To go back to the new version later: `sudo git checkout <branch noted in step 0> && sudo git pull` and the step 1
line. (While on a `checkout` of a hash, `git pull` does not work: that is expected.)

The `paas-panel`, `paas-mail-admin` and `paas-mail` networks can stay: the old version ignores them. To delete them later
(only if they are empty): `sudo docker network rm paas-panel paas-mail-admin paas-mail`.

Data: the migration does not touch volumes. The panel writes new files outside the projects' `src` folder
(`paas.canonical.json`, `paas.up.env`, `repo.git`); the old version ignores them. Note: projects that were already
updated by the new version have the `src` `.git` converted into a pointer to `repo.git`; the old version's git
follows that pointer, but **this was not tested** with the old version.

## What was not really tested

- None of these steps was run on a VPS or with real Docker (the developer's Docker Desktop became
  unresponsive and its network address pool is exhausted): the order of the `docker network connect/disconnect` commands, the
  migration on a live installation and the rollback were verified by reading the code and with Docker test doubles in the tests.
  Run the runbook first on a test server or in a window where a minute of instability is acceptable.
- A project's end-to-end SMTP through `paas-mail` and the real reading of Caddy's IPs for `trustProxy`.
- The real `docker compose` was used only for `config` (canonical model, round trip of the JSON written outside `src`);
  `up` of the canonical JSON was not run.
