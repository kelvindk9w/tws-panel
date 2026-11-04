---
title: "Security wizard"
description: "How to apply the eight hardening phases of the setup wizard safely, with the confirmation test and the automatic rollback."
sidebar:
  label: "Security wizard"
---

How to walk through the **Security** step of the setup wizard (see [Step 8](installation.md#passo-8)
of the installation). The same phases remain available after installation, under
**Security → Scan and apply protections** (`/security/hardening`), so you can review, simulate or reapply them.

> [!NOTE]
> **Interface language.** The panel is available in English and Portuguese ([how to choose](complete-guide.md#idioma-da-interface)). This page quotes the English labels exactly as they appear on screen. The scan results, the plan and the hardening log are written by the server and still appear in Portuguese in both languages.

## How it works

A scan with **Lynis** plus the panel's own checks gives a score before and after. Hardening runs in
idempotent phases, with a backup of every file it changes. Each phase can be **simulated** first:
nothing changes on the VPS during a simulation. Scans and phases run in the panel's embedded
terminal, and you see the real commands, just as you would over SSH.

<a id="as-oito-fases"></a>
## The eight phases

The **Security** step applies hardening in **eight phases**, one at a time: apply, confirm, and only then
move on to the next one. Never start a new phase while the previous one is still waiting for confirmation.

| Phase | What it does | Asks for confirmation? |
|---|---|---|
| 00 · Updates | `apt full-upgrade` + automatic updates (**except Docker**) | No |
| 01 · Non-root user | Installs your SSH key and locks the root password | **Yes** |
| 02 · SSH | Disables password login and root over SSH; only your user can sign in. Keeps the panel tunnel (`ssh -L`) working | **Yes** |
| 03 · Firewall | Enables UFW (denies everything except what was allowed beforehand) | **Yes** |
| 04 · Intrusion prevention | fail2ban + AppArmor | No |
| 05 · Minimization | Removes unnecessary packages (e.g. snapd) | No |
| 06 · Auditing | auditd, Lynis, AIDE, rkhunter — slow | No |
| 07 · Additional hardening | The Lynis recommendations that are safe to automate: core dumps disabled, umask 027, kernel modules and tuning, legal banner at login, compilers restricted to root, process accounting | No |

> [!NOTE]
> **Phase 00 does not upgrade Docker — on purpose.** The phases run in a terminal that is kept
> alive by the Docker daemon itself, the same one that keeps the panel running. Upgrading `docker-ce` restarts that
> daemon, and the phase would knock itself down in the middle of a `dpkg` run — which is exactly what happened before
> this safeguard existed. That is why the Docker packages are left out of the `full-upgrade` and also out of the
> automatic updates; the phase lists in the log which ones were skipped and which command to run.
>
> To upgrade Docker, sign in **over SSH** (not through the panel's terminal) and run:
>
> ```bash
> sudo apt-get update && sudo apt-get install --only-upgrade docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
> ```
>
> The panel goes offline for a few seconds and **comes back on its own** (compose uses `restart: unless-stopped`).
> Do this from time to time: since Docker is excluded from automatic updates, nobody else
> will do it for you.

The three phases marked as requiring confirmation (01, 02 and 03) change how you get into the machine — the
key, the password and the firewall. That is why, before applying any of them, the script itself
**already schedules an automatic rollback on the server**. If nobody confirms within ~5 minutes, the server
undoes by itself what it just did. Confirming cancels that schedule — which is why the test below
matters: it is your only way to know, before cancelling the safety net, whether it would still be
needed.

> [!IMPORTANT]
> **The confirmation procedure, step by step:**
>
> 1. After applying the phase, the panel shows "waiting for confirmation" and a timer of ~5
>    minutes starts running on the server.
> 2. **Do not test in the window that is already open.** An SSH session that is already connected keeps
>    working even if the new configuration is broken — it proves nothing, because it did not
>    go through the change you just applied.
> 3. Open your **computer's terminal** (not the browser — on Windows, PowerShell), in a new
>    window, without closing the old one, and run the command the panel shows (it has a copy button):
>    ```bash
>    ssh YOUR_USER@YOUR-IP-WITH-HYPHENS.sslip.io
>    ```
>    (`YOUR_USER` is your user and `YOUR-IP-WITH-HYPHENS` is your server IP with dashes instead of dots.)
> 4. **Only after the new window actually connects** (you see `YOUR_USER@…$`), type
>    `exit` and click **I'm in — confirm** in the panel.
> 5. If the new window does **not** connect: click **I couldn't sign in — undo now**. The
>    server undoes **only this phase** right away — the previous ones stay in effect and the following ones
>    do not run. That is why each of these phases has its own test: if something goes wrong, you know
>    exactly which one it was and lose only that part. (If you do nothing, it also undoes itself
>    when the timer runs out.)
> 6. Keep the old window open until the very end of the whole Security step, even after confirming each
>    phase.
>
> **Phase 01 specific test:** the connection in the new window must sign in **without asking for the
> account password**. It may ask for your *key's passphrase* — that is a different thing, it is local and does not involve
> the server. If the new window still asks for the account password, the key was not installed
> correctly; **do not confirm**, and do not move on to phase 02 in that state — without a working
> key, phase 02 (which disables password login) would lock you out.

Two safeguards already exist in the script itself and help avoid the worst-case scenario, but they **do not
replace the test in the new window**: phase 01 only locks the root password if it finds at least one
SSH key installed, and phase 02 refuses to run (with an error) if the given user does not exist
or has no key. They are safety nets, not proof that your specific access works.

If something still goes wrong, see [I lost access: now what?](../guides/recover-access.md).

## Before you run: phases that deserve attention

> [!TIP]
> Three hardening phases deserve attention before you run them, and there is one last step after them:
>
> - **Phase 05 (Minimization)** removes `snapd` and blocks it. If any program of yours depends on
>   snap, know this beforehand — the rollback of this phase restores the APT configuration, but **does not
>   reinstall** the removed packages. Exception: if this server's Docker comes from a snap
>   (`snap install docker`), the phase detects that and preserves that snap and `snapd` — removing them
>   would bring down the panel itself —, removing only the other snaps and explaining in the log.
> - **Phase 06 (Auditing)** takes several minutes: it builds the AIDE baseline by scanning the
>   file system. It looks stuck, but it is not. The final score (a full Lynis audit, after
>   the last phase) also takes 2 to 5 minutes.
> - **Phase 07 (Additional hardening)** does not apply everything Lynis suggests — on purpose.
>   Left out: password expiry (your user's password would expire and the terminal's `sudo`
>   would stop working), a GRUB password (a mistake prevents the VPS from rebooting on its own), changing the
>   SSH port (breaks the tunnel and the installation guide), separate partitions (only at system
>   installation) and `apt-listbugs` (made for Debian, not Ubuntu). That is why the Lynis
>   score does not reach 100 — and does not need to: what remains are conscious choices, explained above.
> - **After the last phase, reboot the VPS** (`sudo reboot`), wait a minute and open the panel
>   again (at the same address, or through the tunnel if that is how you access it): the kernel updated by
>   phase 00 and the kernel tuning only take effect after the reboot.
