---
title: "Restore on a new VPS"
description: "Move everything from an old or lost VPS to a new one using the backups in external storage: what you need, what migrates, the order of the steps, DNS and the final checks."
sidebar:
  label: "Restore on a new VPS"
---

Use this guide when the old VPS is lost, broken into or being replaced, and you want the panel,
the projects and the email back on a new VPS. It relies on the **external copy** of the backups
(Cloudflare R2 or another S3-compatible storage). Backups kept only on the old VPS disappear with
it.

> [!NOTE]
> **Interface language.** The panel is available in English and Portuguese ([how to choose](../getting-started/complete-guide.md#idioma-da-interface)). This page quotes the English labels exactly as they appear on screen. Some messages that come from the server still appear in Portuguese in both languages: backup records, mail server notices and many error messages. Whenever this page quotes one of them, it says so. The word you type to confirm a restore depends on the interface language (steps 5 and 8).

Most of the time goes to waiting for DNS and for projects to be published again. If the old VPS
still runs, keep it until the last step.

> [!IMPORTANT]
> **What is written or received after the last backup does not migrate.** That includes database
> records, uploaded files and email received between the backup and the moment the DNS points to
> the new VPS. Step 2 makes a final backup to keep that gap small.

## What you need before you start

Keep all of this **outside the VPS** (a password manager, for example). You cannot get it from a
server you no longer have.

| What | Where it comes from | If you lost it |
|---|---|---|
| **Backup password** | The recovery kit you downloaded in **Settings → Backups → External copy encryption**. The panel also shows it under **View password**, but only on a panel you can still sign in to. | There is no way around it: without the password, nobody can open the external copies. |
| **Storage endpoint and bucket** | The recovery kit lists the bucket and the endpoint. | In Cloudflare: R2 → your bucket → Settings → S3 API. |
| **Storage access keys** (Access Key ID and Secret Access Key) | You saw them once, when you created the token on Cloudflare. **They are not in the kit.** | Create a new R2 API token for the same bucket ([Complete guide, Step 8.1](../getting-started/complete-guide.md#etapa-8)). Old files stay readable. See the warning in step 5. |
| **Domain access** | Your DNS provider or registrar. | Recover it with the registrar. |
| **Provider access** | The new VPS provider's dashboard (to set the PTR and unblock port 25). | — |

## What is restored and what is not

| Comes back | Does **not** come back (you redo it) |
|---|---|
| **Panel:** administrator accounts and two-factor authentication, registered projects, settings, notification and backup settings, panel domain and the keys that encrypt the secrets (project variables, tokens). | The operating system and its hardening: user, SSH key, firewall. Run the installation and the security wizard on the new VPS. |
| **Projects from GitHub:** the databases and folders that were checked in each project's **Backups** tab. The code is published again from the repository. | Anything that was **not** checked in the project's Backups tab, and files written outside volumes. |
| **Email:** mailboxes, messages, accounts, rules and DKIM keys, and the webmail settings. | DNS records, the PTR and the provider's firewall. They point to the old IP. |
| | TLS certificates: they are issued again, once DNS points to the new VPS. |
| | The email IP reputation: a new IP starts with none. |
| | The project code as of the backup date: projects from GitHub come from the repository's **current** branch. |
| | **Projects that do not come from GitHub** (created by upload or from a folder on the server): this flow does not restore them. See [Projects that do not come from GitHub](#projetos-fora-do-github). |

## Step by step

Do steps 2 to 8 **without a long pause**. The old panel is stopped in step 2 and the services only
come back as you restore them.

### 1. Prepare the new VPS

Follow the [installation guide](../getting-started/installation.md) from Step 1 to Step 8 and finish
the setup wizard, including the Security step. The restore needs a panel you are signed in to, so create a
temporary administrator account when the wizard asks for it. The restore replaces it with the old
accounts.

Check that ports **80 and 443** are open at the provider, and port **25** if you will use email
(see [Complete guide, Step 6.1](../getting-started/complete-guide.md#etapa-6)).

### 2. Make a final backup and stop the old panel

Skip this step if the old VPS is gone. Otherwise, on the **old** panel, in this order:

1. In **Settings → Backups**, click **Back up now** in the **Panel**
   card and in the **Email** card.
2. Open each project, go to its **Backups** tab and click **Back up now**.
3. Wait until every backup shows "external copy verified" under
   **Latest backups**. Write down the date and time of the panel backup.
4. Only then, stop the old panel, so that two servers do not write to the same bucket (the restored
   panel brings the same backup schedule back):

   ```bash
   cd /opt/tws-panel && sudo docker compose stop
   ```

From this moment, nothing written or received on the old VPS reaches the new one, until the DNS
points to it.

### 3. Connect the same storage

In the new panel, open **Settings → Backups**. In **External storage**
(External storage), type the same endpoint, bucket and access keys the old VPS used. Region: `auto`.
Click **Test and save**.

**What to check:** "Connection tested and saved" appears.

> [!WARNING]
> **Do not click Back up now on the new panel before step 5**, and do not change the
> schedules. The automatic backup of the panel is on by default. Once the password is set (step 4),
> the new VPS can send a backup of an **empty** panel to the `_painel/` folder, and the retention
> (5 copies by default) deletes the oldest one. The most recent date in the list may then be the empty panel,
> not the one from the old VPS.

### 4. Enter the backup password

Still in **Settings → Backups**, find the **Restore from another server** card and click **Get started**.

1. Step 1 of the card shows the connected bucket.
2. In step 2, type the backup password from the kit and click **Check and use**.

**What to check:** the card accepts the password. If it says it cannot verify it because the check
file is missing, you can click **Use this password anyway**. If it says
the password does not open the backups, check the kit again.

### 5. Restore the panel first

1. In step 3, click **See what's in the storage**.
2. In the **Panel** block, click **Restore the panel**.
3. Choose the date of the **last backup of the old VPS**, the one you wrote down in step 2. Do not
   assume that the first date in the list is the right one. Confirm by typing the word the screen shows: `panel` with the English interface, `painel` with the Portuguese one.
4. Wait. The panel restarts by itself.

**What to check:** open the new VPS address again (`https://203-0-113-10.sslip.io`, with the new IP)
and sign in with the **old** administrator username and password, plus the two-factor code from the old
phone. Go back to **Settings → Backups → Restore from another server**.

> [!WARNING]
> **The storage keys go back to the old ones.** The backup settings and their keys come back with
> the panel. If you created a new token in step 3 (because you lost the keys, or because you revoked
> the old token after a break-in), the restored panel holds the old keys and the download of
> projects and email fails. Go to **Settings → Backups → External storage → Edit**,
> type the new keys again and click **Test and save**, before step 7. If the old VPS was
> broken into, revoke the old token on Cloudflare and change the passwords (panel, mailboxes,
> databases, Git tokens) after the restore.

> [!WARNING]
> **If the old panel had access by IP turned off**, that setting comes back too. The new panel then
> answers only on the panel domain, which still points to the old VPS, and you cannot sign in. Two
> ways out: point the domain's A record to the new IP and wait for DNS, or run, on the new VPS,
> `cd /opt/tws-panel && sudo ./scripts/reativar-acesso-ip.sh` and use the `…sslip.io` address.
> To avoid it, change the panel domain's A record to the new IP **before** this step.

If the panel does not open at all, restore it from a file instead:
`cd /opt/tws-panel && sudo ./scripts/restaurar-painel.sh /root/ARQUIVO.7z` (see
[Operations](operations.md)).

### 6. Point the DNS to the new IP

Do this while the projects are restored, because DNS takes time to spread. For each domain, edit the
**A** record to the new VPS IP (on Cloudflare, gray cloud, "DNS only"). That includes the panel
domain and every project domain. Lower the TTL beforehand if you can.

### 7. Restore the projects

In the **Projects** block of the card, click **Restore** next to each project.

- A project shown as "Not registered here: restore the panel first" means step 5 did not finish.
- Choose the date and confirm by typing the project name.
- On a new VPS the project has no containers. Keep **Deploy from GitHub before restoring** checked: the panel publishes the project again from its
  repository and then puts the databases and folders back. This can take several minutes per
  project, and the panel waits up to 45 minutes.

**What to check:** each project opens at its domain and the data is there. The **Certificates**
(Certificates) page shows the project's domain as **Valid**. A certificate fails until the
DNS from step 6 points to the new IP. Use **Try issuing now** on that page
after that.

<a id="projetos-fora-do-github"></a>

#### Projects that do not come from GitHub

Projects created by upload or from a folder on the server cannot be restored by the steps above.
The panel publishes the project **before** it puts the code back, and for these projects the
source was a folder on the old VPS, so the publication fails. The workaround, per project, with the
projects registered (step 5) and before you click **Restore** in step 7:

1. Download, from the storage (`TWS Panel Backups/<project>/`), the `.7z` of the **last backup made
   on the old VPS** (the same moment as the panel backup from step 5) and open it with 7-Zip, using
   the backup password. Take out `codigo/codigo.tar` and copy it to the new VPS.
2. Find the project's **source folder** (`<ORIGIN>` below) in the project's configuration tab: the
   screen says "This project uses a folder on the server (…), not a Git repository". It must be inside the projects folder of the new VPS (`PAAS_PROJECTS_DIR`, default
   `/opt/tws-projects`), the only host folder the panel can see.
3. Put the code in `<ORIGIN>`, according to how the project was created:
   - **Created by upload** (the tar holds a folder called `src/`): extract to a temporary folder and
     copy the **contents** of `src/` to the origin:

     ```bash
     sudo mkdir -p <ORIGIN>
     TMP=$(mktemp -d)
     sudo tar -xf codigo.tar -C "$TMP"
     sudo cp -a "$TMP"/src/. <ORIGIN>/
     sudo head -1 <ORIGIN>/.env 2>/dev/null | grep -q '^# Gerado pelo painel (seção Variáveis do projeto)' && sudo rm <ORIGIN>/.env
     ```

     The last line removes the `.env` that the panel generated (it starts with the comment
     "Gerado pelo painel"), and only that one: a `.env` written by the project's owner has no such
     header and stays.

   - **Created from a folder on the server** (the tar holds a folder with the folder's own name,
     for example `meusite/`): extract it into the parent of the origin:

     ```bash
     sudo tar -xf codigo.tar -C "$(dirname <ORIGIN>)"
     ```
4. In both cases, give the folder to the panel user (it runs as user 10001):

   ```bash
   sudo chown -R 10001:10001 <ORIGIN>
   ```
5. Click **Deploy** in the project to publish it.
6. Only then restore the data: **Backups** tab of the project → **Restore**. The restore puts the
   code back over the folder once more.

> [!NOTE]
> The panel only accepts a source folder inside the projects folder: it refuses any other one when
> the project is created or changed (`source_outside_projects_dir`), and the projects folder is the
> only host folder it can see.
>
> In upload mode, the `.env` file with the project's variables that the panel generated comes along
> in the tar. That generated `.env` must not stay in the origin: the panel generates a new one at
> deploy. If it stayed, every deploy would copy the old values back, and a compose file with
> `env_file: .env` would keep reading them.
>
> This workaround was derived from the code and has not been tested on a real VPS.

### 8. Restore the email last

1. In the card, click **Restore email** and confirm by typing the word the screen shows: `email` with the English
   interface, `e-mail` with the Portuguese one.
   If the restore ends with the notice "O servidor de e-mail ainda não existe nesta VPS: abra a
   página E-mail e clique em Iniciar" (the mail server does not exist on this VPS yet: open the
   Email page and click Start; this notice comes from the server and is still in Portuguese), open **Email** and click **Start server**. It
   starts with the restored data.
2. Update the DNS (**Email** page → the domain → **DNS checklist**):
   - the **A** record of `mail.send.example.com` to the new IP;
   - the **SPF** record, which contains the old IP (`ip4:`): copy the new value from the checklist;
   - MX, DKIM and DMARC do not change, because the names and the keys came back.
3. Ask the provider to set the **PTR** of the new IP to `mail.send.example.com`.
4. Check that outbound port 25 is open ([Complete guide, Step 6.1](../getting-started/complete-guide.md#etapa-6)).

**What to check:** click **Verify now** until you reach **6/6 OK**, send a test email
(Step 6.7 of the complete guide), and see **Valid** in the email certificate card. Send slowly at
first: the new IP has no reputation yet.

## Final checks

- The panel opens at its domain with a padlock, and sign-in and two-factor authentication work.
- **Certificates** shows every address as **Valid**.
- Every project opens and has its data.
- **Automatic backups are still on.** Open the **Backups** tab of each project and check that the
  automatic backup is on. The restored schedule can try to back up a project that has no containers
  yet, and then the panel turns that project's automatic backup off.
- Email: the DNS checklist is 6/6, the test email arrives, and a mailbox can sign in to the webmail.
- **Settings → Time zone** shows the time zone you want. Backups run
  at 03:00 in the VPS time zone.
- Run **Back up now** on the panel and see "external copy verified". Then run a project
  backup.
- If **Security** shows differences from the old server, update the baseline with **Update baseline snapshot**, now that the new VPS is hardened.
- Turn the old VPS off for good only now, and delete its DNS leftovers.

## If something fails

- **Wrong password:** the card does not accept it. Check the kit again. For a backup made before a
  password change, the restore window has a link, **Was this backup made before a password change?**
  where you type the password in use when that
  backup was made.
- **The download fails in step 7 or 8:** the storage keys are probably the old ones. See the warning
  in step 5.
- **A restore fails halfway:** the panel keeps the previous state in
  `/data/backups/_painel/antes-da-restauracao/` and undoes a failed panel swap by itself. Read the
  error in **Latest backups** and run the step again.
- **No access to the panel at all:** restore the panel from a downloaded file with
  `restaurar-painel.sh`, or open the `.7z` by hand with 7-Zip. The kit explains both.
