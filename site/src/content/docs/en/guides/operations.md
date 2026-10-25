---
title: "Running the panel on the VPS"
description: "Day-to-day work: update the panel, emergency scripts, where project files live, and how to change the terminal user or the panel port."
sidebar:
  label: "Operations"
---

Day-to-day work after installation: updating, useful commands, where the files live and how to
change the terminal user or the panel port. All commands run **on the VPS**, connected
over SSH with your user, inside `/opt/tws-panel`.

## Update the panel

A single line, on the VPS:

```bash
cd /opt/tws-panel && sudo git pull && sudo git log --oneline -1 && sudo docker compose up -d --build
```

`git log --oneline -1` shows the commit that went live, so you can check it. Your projects,
domains, email and the administrator account stay as they were. What changed in each version
is in the [CHANGELOG](https://github.com/kelvindk9w/tws-panel/blob/main/CHANGELOG.md).

> [!NOTE]
> **Why this line recreates the panel container.** Some versions add a mount to the panel container (the resource
> monitoring needs the host's `/proc` and `/sys/fs/cgroup`, **read-only**). A mount only exists when the container is
> **recreated**, and `docker compose up -d --build` does that on its own when the compose file changed. A plain
> `docker restart tws-panel` does **not** pick up new mounts: use the line above. If the Dashboard says "Monitoring in
> reduced mode", that is the cause. See [Resource monitoring](features.md#resource-monitoring).

<a id="scripts-de-emergência"></a>

## Emergency scripts

| Situation | Command (in `/opt/tws-panel`) | Guide |
|---|---|---|
| Lost the setup token | `sudo ./scripts/show-token.sh` | [Installation](../getting-started/installation.md#passo-8) |
| Want to redo the wizard | `sudo ./scripts/reset-setup.sh` (`--full` also deletes the admin account) | [Recover access](recover-access.md) |
| Lost your phone and the two-factor authentication codes | `sudo ./scripts/reset-2fa.sh` | [Recover access](recover-access.md) |
| Disabled access by IP and the panel domain stopped opening | `sudo ./scripts/reativar-acesso-ip.sh` | [Features](features.md#dominio-do-painel) |
| The panel does not open and you have a `.7z` backup of it | `sudo ./scripts/restaurar-painel.sh /root/ARQUIVO.7z` | [Features](features.md#backups) |
| Want to remove the panel | `./scripts/uninstall.sh --dry-run` and then `./scripts/uninstall.sh` | [Installation](../getting-started/installation.md#remover-o-painel) |

> [!WARNING]
> **`restaurar-painel.sh` brings back the whole backup, with no adjustments.** Restoring the panel
> from the screen (**Settings → Backups → Restore from another server**) keeps the storage keys of
> this VPS, keeps access by IP turned on while the panel domain does not point here, and holds the
> schedule of projects and email for up to 7 days. The script does none of that: the **old storage
> keys** come back (type the new ones again in **Settings → Backups → External storage → Edit**),
> access by IP comes back **turned off** if it was (use `reativar-acesso-ip.sh` if the panel domain
> does not open), and the old schedule comes back without a hold. Details in
> [Restore on a new VPS](restore-new-server.md) and in [Features](features.md#backups).


## Where your projects' files live

Each project you deploy has its own folder on the server, with the code cloned from Git (in `src/`)
and the files the panel generates around it (such as `repo.git` and `paas.env`). By default these folders live in
**`/opt/tws-projects`** — next to `/opt/tws-panel`, and outside any `/home`, so they do not
disappear if you ever delete a Linux user.

They live in a real directory on the VPS, not hidden inside the container, for two
practical reasons:

- **You can look at them.** Connected over SSH, `ls /opt/tws-projects` already shows everything; you can
  read a log, copy a file or take a backup with the usual tools.
- **Projects that write files work.** If your project's `docker-compose.yml` has a
  line like `./dados:/app/dados` (to keep uploads, a SQLite database, whatever), the one looking for
  that `dados` folder is Docker **on the VPS**, not the panel. If it existed only inside the
  panel's container, Docker would create an empty folder and your project would come up without its data.
  That is why the path is exactly the same inside and outside.

**Want to use another location** (a larger disk mounted at `/mnt/dados`, for example)? Choose it
at install time:

```bash
./scripts/install.sh --projects-dir=/mnt/dados/projetos
```

> [!IMPORTANT]
> This choice is made **at installation**, not on a panel screen. Changing the folder means
> changing a container mount, and a container only picks up a new mount when it is
> recreated. If you need to change it later, edit the `PAAS_PROJECTS_DIR=` line of the `.env` file in
> `/opt/tws-panel`, move the old files to the new location (`sudo mv`), adjust the owner
> (`sudo chown -R 10001:10001 /novo/caminho`) and run `sudo docker compose up -d` — it recreates the
> panel with the new folder. Just restarting (`restart`) is **not** enough.

> [!NOTE]
> If you already had the panel installed before this change, nothing moves on its own: without the
> `PAAS_PROJECTS_DIR=` line in `.env`, the panel keeps using the old location and the projects
> you already created stay where they were.

<a id="trocar-terminal"></a>

## Change the panel's terminal user

The user the terminal opens as and the mode (`senha` or `segundo-plano`) are stored in the `.env`
file in `/opt/tws-panel`. To change them, run the installer again asking it to prompt you
once more:

```bash
cd /opt/tws-panel
./scripts/install.sh --reconfigure-terminal
```

It asks the same questions again, validates the answer and recreates the panel with the new choice. Your
projects, domains, email and the administrator account are not touched — it is the same safe
reinstall as always. If you would rather not answer anything, pass the values directly:

```bash
./scripts/install.sh --terminal-user=OUTRO_USUARIO --root-mode=segundo-plano
```

> [!NOTE]
> Installed the panel before this question existed? Nothing changes on its own: without the
> `PAAS_TERMINAL_USER=` and `PAAS_ROOT_MODE=` lines in `.env`, the terminal keeps opening as root, as
> before. Running the installer again interactively asks the question — and, if you want to keep everything
> as is, just answer `root`.

<a id="trocar-porta"></a>

## Change the panel port on the VPS

**It only matters for tunnel access.** With HTTPS access (the default) this port is internal —
the panel listens only inside the VPS and the proxy serves the outside world, on ports 80/443 — and the installer
picks it by itself.

With tunnel access, the port is the one you chose at installation (default `9000`) and it is stored in the
`PAAS_PORT=` line of the `.env` in `/opt/tws-panel`. To change it, run the installer again passing
the new one:

```bash
cd /opt/tws-panel
./scripts/install.sh --port=9500
```

It checks that the new port is free, rejects the ones that would break the panel (22, 80, 443 and the mail
ports), recreates the container and prints the tunnel command with the right number already in it. Your projects,
domains, email and the administrator account are not touched.

> [!NOTE]
> Only the **outside** port changes. Inside the container the panel keeps listening on 9000 — it is
> `docker-compose.yml` that makes the connection (`"127.0.0.1:${PAAS_PORT:-9000}:9000"` — inside the
> VPS only). That is why it is no use to
> edit `.env` and run `restart`: a container only picks up a new port publication when it is
> recreated (`sudo docker compose up -d`).

> [!TIP]
> If the problem is the port being in use **on your computer** when you open the tunnel, do not change anything here:
> change only the left-hand number of `ssh -L`. See [the two tunnel ports](../getting-started/installation.md#duas-portas).

> [!IMPORTANT]
> **Updating an installation that predates HTTPS access?** Since that version the panel listens
> **only inside the VPS**: the `http://YOUR-IP:PORT` address stops opening (it used to leave the port open
> to the internet even with the firewall on). After `git pull`, run the installer instead of
> `docker compose up`:
>
> ```bash
> cd /opt/tws-panel && sudo git pull && ./scripts/install.sh
> ```
>
> It keeps your choices (terminal user, projects, accounts), sets up the
> `https://…sslip.io` address and shows the link at the end. Prefer to stay with tunnel only? Use
> `./scripts/install.sh --acesso=tunel`.

## Useful commands (production)

```bash
sudo docker compose ps            # panel status
sudo docker compose logs -f panel # real-time logs
sudo docker compose up -d --build # update to a new version (git pull first)

sudo ./scripts/show-token.sh      # shows the URL + setup token again (if you lost the token)
sudo ./scripts/reset-setup.sh     # restarts the wizard from scratch (--full also deletes users/sessions)
./scripts/install.sh --reconfigure-terminal   # changes the panel's terminal user/mode
./scripts/install.sh --port=9500              # changes the panel port on the VPS
./scripts/uninstall.sh --dry-run              # shows what removing the panel would delete
```

> [!NOTE]
> Docker commands and the `show-token.sh` and `reset-setup.sh` scripts take `sudo` because the
> panel does not put anyone in the docker group — being in it is having root without a password
> ([learn more](../getting-started/installation.md#grupo-docker)). Without `sudo`, the error is `permission denied ... docker.sock`.
