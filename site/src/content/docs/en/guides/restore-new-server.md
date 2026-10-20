---
title: "Restore on a new VPS"
description: "Move everything from an old or lost VPS to a new one using the backups in external storage: what you need, what migrates, the order of the steps, DNS and the final checks."
sidebar:
  label: "Restore on a new VPS"
---

Use this guide when the old VPS is lost, broken into or being replaced, and you want the panel,
the projects and the email back on a new VPS. It relies on the **external copy** of the backups
(Cloudflare R2 or another S3-compatible storage). Backups kept only on the old VPS disappear with
it. Installing for the first time, with nothing to bring over? Follow the
[step-by-step guide](../getting-started/installation.md) instead.

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
| **Storage access keys** (Access Key ID and Secret Access Key) | You saw them once, when you created the token on Cloudflare. **They are not in the kit.** | Create a new R2 API token for the same bucket ([Complete guide, Step 8.1](../getting-started/complete-guide.md#etapa-8)). Old files stay readable. The keys you type in step 3 stay in use after the panel is restored from the screen (see step 5). |
| **Domain access** | Your DNS provider or registrar. | Recover it with the registrar. |
| **Provider access** | The new VPS provider's dashboard (to set the PTR and unblock port 25). | — |

## What is restored and what is not

| Comes back | Does **not** come back (you redo it) |
|---|---|
| **Panel:** administrator accounts and two-factor authentication, registered projects, settings, notification settings, panel domain and the keys that encrypt the secrets (project variables, tokens). | The operating system and its hardening: user, SSH key, firewall. Run the installation and the security wizard on the new VPS. |
| **Backup settings:** schedule, frequency, number of copies and the backup password. The storage address and keys are the exception: they stay the ones you typed on this VPS. This holds when you restore from the screen. With `restaurar-painel.sh`, the whole backup settings file comes back, old keys included (see step 5). | Anything that was **not** checked in the project's Backups tab, and files written outside volumes. |
| **Projects:** the databases and folders that were checked in each project's **Backups** tab. Projects from GitHub are deployed again from the repository. For projects created by upload or from a folder on the server, the code comes back from the backup into the project's source folder, and then the project is deployed. | DNS records, the PTR and the provider's firewall. They point to the old IP. |
| **Email:** mailboxes, messages, accounts, rules and DKIM keys, and the webmail settings. | TLS certificates: they are issued again, once DNS points to the new VPS. |
| | The email IP reputation: a new IP starts with none. |
| | The code of a project from GitHub as of the backup date: it comes from the repository's **current** branch. |

## Step by step

Do steps 2 to 8 **without a long pause**. The old panel is stopped in step 2 and the services only
come back as you restore them.

### 1. Prepare the new VPS

> [!WARNING]
> **Reinstalled the VPS operating system, or reinstalled it to test again, and SSH complained "REMOTE HOST IDENTIFICATION HAS CHANGED!"?** That is expected: the VPS now has a new identity. On your computer, run `ssh-keygen -R YOUR_IP` (with the VPS IP), connect again and answer `yes`. [Full message and details](../getting-started/installation.md#host-identification-changed).
>
> **Did not reinstall or switch anything, and the warning appeared out of nowhere?** Do not continue and do not run that command. Check that the IP is the right one and look in the provider's dashboard for a reinstall, a rescue mode or a changed IP. The warning may be the only sign that another machine is answering at that address.

Follow the [installation guide](../getting-started/installation.md) from Step 1 to Step 8 and finish
the setup wizard, including the Security step. The restore needs a panel you are signed in to, so create a
temporary administrator account when the wizard asks for it. The restore replaces it with the old
accounts.

If the old VPS used another projects folder, install with the same one (`./scripts/install.sh --projects-dir=<folder>`, see [Operations](operations.md)). Otherwise projects created by upload or from a folder on the server fail in step 7 with "fica fora da pasta de projetos".

**Do not start the mail server on the new VPS** before step 8, even though the "Get the panel ready" checklist on the Dashboard suggests it. The scheduled email backup would send an empty mail server to `_email/`, count as a finished backup and, since the container would already exist, the email would not enter the hold after the panel is restored.

The new panel has the backup schedule on and runs at 03:00 even with no storage connected. That is harmless: the copy stays on the VPS only and does **not** count as a panel backup for the protection described in step 3, which only considers a backup already **sent to the storage**. You can install on one day and connect the storage on another.

Check that ports **80 and 443** are open at the provider, and port **25** if you will use email
(see [Step-by-step guide, Part 2, Step 4.1](../getting-started/complete-guide.md#etapa-4)).

### 2. Make a final backup and stop the old panel

Skip this step if the old VPS is gone. Otherwise, on the **old** panel, in this order:

1. In **Settings → Backups**, click **Back up now** in the **Panel**
   card and in the **Email** card.
2. Open each project, go to its **Backups** tab and click **Back up now**.
3. Wait until every backup shows "external copy verified" under
   **Latest backups**. Write down the date and time of the panel **and email** backups.
4. Only then, stop the old panel, so that two servers do not write to the same bucket (the restored
   panel brings the same backup schedule back):

   ```bash
   cd /opt/tws-panel && sudo docker compose stop
   ```

From this moment, nothing written or received on the old VPS reaches the new one, until the DNS
points to it.

### 3. Connect the same storage

In the new panel, open **Settings → Backups**. In **External storage**, type the same endpoint, bucket and access keys the old VPS used. Region: `auto`.
Click **Test and save**.

**What to check:** "Connection tested and saved" appears.

> [!WARNING]
> **Do not click Back up now on the new panel before step 5.** A manual backup always runs, and it sends a backup of an **empty** panel to the
> `_painel/` folder; the retention (5 copies by default) then deletes the oldest one. The most
> recent date in the list may end up being the empty panel, not the one from the old VPS.
>
> The scheduled backup of the new panel is on by default, and the panel holds it only under
> these conditions:
>
> - no project is registered, the panel was not restored and no panel or email backup was
>   **sent to the storage** by this VPS (a copy only on the VPS does not count); and
> - the storage already holds panel backups in `_painel/`; and
> - less than **7 days** have passed since you connected the storage.
>
> While the hold lasts, **Settings → Backups** shows the reason, and the panel sends one
> notification, "Backup automático do painel em pausa: o armazenamento tem backups de outro
> servidor" (a server message, in Portuguese). Expect it. If the panel cannot list the storage, it
> does not send the backup either, and a notification warns you on the third failure in a row.
> **If more than 7 days pass between step 3 and step 5**, the hold ends by itself and the
> next scheduled backup can put an empty panel over the good backup. If you already know it will take
> more than 7 days, turn off **Automatic backup on** in the **Panel** card before connecting the
> storage and turn it on again at the end (extra care, only for that case).

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

If you already pointed the panel domain's A record to the new IP and the old panel had access by IP
turned off, the `…sslip.io` address does not open (the access stays off because the domain points to
this VPS). In that case, sign in at the panel domain.

> [!NOTE]
> **The storage keys you typed in step 3 stay in use.** When you restore from the screen, the backup
> settings come back with the panel, but the storage endpoint, bucket and keys stay the ones of this
> VPS, because those are the ones that just downloaded the backup. If the backup held other keys, the
> record of the restore says so (a server message, in Portuguese): "As chaves do armazenamento
> externo que você configurou nesta VPS (…) foram mantidas…". If the old VPS was broken into, revoke
> the old token on Cloudflare and change the passwords (panel, mailboxes, databases, Git tokens)
> after the restore.

> [!NOTE]
> **Access by IP.** If the old panel had access by IP turned off, the restored panel turns it back
> **on** while the panel domain does not point to this VPS, so you can sign in. The record of the
> restore says so (a server message, in Portuguese): "O painel antigo tinha o acesso pelo IP
> desativado. Aqui ele fica ativo…". If the domain already points to this VPS, the access stays
> off. After the DNS points here, turn it off again in **Settings → Panel domain** (**Turn off
> IP access**). Changing the domain's A record before this step is optional.

If the panel does not open at all, restore it from a file instead:
`cd /opt/tws-panel && sudo ./scripts/restaurar-painel.sh /root/ARQUIVO.7z` (see
[Operations](operations.md)). That path skips the adjustments above, so the next two warnings apply
**only to it**. It also does not hold the schedules (see the final checks).

> [!WARNING]
> **With `restaurar-painel.sh`, the storage keys go back to the old ones.** The whole backup
> settings file comes back. If you created a new token in step 3 (because you lost the keys, or
> because you revoked the old token after a break-in), the restored panel holds the old keys and the
> download of projects and email fails. Go to **Settings → Backups → External storage → Edit**,
> type the new keys again and click **Test and save**, before step 7. If the old VPS was
> broken into, revoke the old token on Cloudflare and change the passwords (panel, mailboxes,
> databases, Git tokens) after the restore.

> [!WARNING]
> **With `restaurar-painel.sh`, if the old panel had access by IP turned off**, that setting comes
> back too. The new panel then answers only on the panel domain, which still points to the old VPS,
> and you cannot sign in. Two ways out: point the domain's A record to the new IP and wait for DNS,
> or run, on the new VPS, `cd /opt/tws-panel && sudo ./scripts/reativar-acesso-ip.sh` and use the
> `…sslip.io` address. To avoid it, change the panel domain's A record to the new IP **before** this
> step.

### 6. Point the DNS to the new IP

Do this while the projects are restored, because DNS takes time to spread. For each domain, edit the
**A** record to the new VPS IP (on Cloudflare, gray cloud, "DNS only"). That includes the panel
domain and every project domain. Lower the TTL beforehand if you can.

### 7. Restore the projects

In the **Projects** block of the card, click **Restore** next to each project.

- A project shown as "Not registered here: restore the panel first" means step 5 did not finish.
- Choose the date and confirm by typing the project name.
- On a new VPS the project has no containers. Keep **Deploy from GitHub before restoring** checked
  (the box also serves projects that do not come from GitHub). The panel deploys the project and
  then puts the databases and folders back. This can take several minutes per project, and the panel
  waits up to 45 minutes.
  - **Project from GitHub:** the panel deploys it again from its repository.
  - **Project created by upload or from a folder on the server:** the panel first puts the code from
    the backup back into the project's **source folder** (the one in the project's configuration) and
    then deploys. That folder must be inside the projects folder of the new VPS
    (`PAAS_PROJECTS_DIR`, default `/opt/tws-projects`), without a symbolic link pointing outside it,
    and the panel user (10001) must be able to write in the projects folder, where the source folder is created. In a project created by upload, the `.env`
    that the panel generated does not come back (the panel generates a new one at deploy); a `.env`
    written by the project's owner does.
  - **The source folder already exists on the new VPS with files in it:** it stays as it is, nothing
    is overwritten, and the restore record warns about it. The deploy uses what is already there. To
    use the code from the backup instead, rename or empty that folder **before** you click
    **Restore**. Doing it afterwards does not help: in a project created by upload, a new restore
    puts the code back only in the panel's working copy, and the next deploy fails without the
    source folder.

**What to check:** each project opens at its domain and the data is there. The **Certificates**
page shows the project's domain as **Valid**. A certificate fails until the
DNS from step 6 points to the new IP. Use **Try issuing now** on that page
after that.

### 8. Restore the email last

1. In the card, click **Restore email**, choose the date of the email backup you wrote down in step 2 and confirm by typing the word the screen shows: `email` with the English
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
4. Check that outbound port 25 is open ([Step-by-step guide, Part 2, Step 4.1](../getting-started/complete-guide.md#etapa-4)).

**What to check:** click **Verify now** until you reach **6/6 OK**, send a test email
(Step 4.7 of Part 2 of the step-by-step guide), and see **Valid** in the email certificate card. Send slowly at
first: the new IP has no reputation yet.

## Final checks

- The panel opens at its domain with a padlock, and sign-in and two-factor authentication work.
- **Certificates** shows every address as **Valid**.
- Every project opens and has its data.
- **The schedules are back.** After the panel is restored, the automatic backup of the projects and
  of the email stays on hold until the data of each one comes back. The hold shows in
  **Settings → Backups** and in the project's **Backups** tab, as a message that starts with "Em
  pausa" (a server message, in Portuguese), in place of "Next: …". After you restore each project
  and the email, check that the message is gone. A project created after the restore is not held,
  and the hold ends by itself after 7 days. If you restored the panel with `restaurar-painel.sh`,
  there is no hold: the old schedule comes back as it was, and it can try to back up a project that
  has no containers yet.
- **Do not leave projects waiting.** The scheduled backup of a project that still has no containers
  fails with "Nenhum container do projeto encontrado" (a server message), with a notification. The
  one of a project that is deployed but whose data has not come back yet can send a backup without
  the data. Restore the projects soon after the panel.
- Email: the DNS checklist is 6/6, the test email arrives, and a mailbox can sign in to the webmail.
- In **Settings → Backups**, the **Panel** card has **Automatic backup on** checked. If you turned it off as extra care in step 3, turn it on again: the restore brings the old schedule back only when the backup has the backup settings, and an old backup without them leaves the schedule as it was.
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
- **The download fails in step 7 or 8:** the token may be revoked or wrong. Go to
  **Settings → Backups → External storage → Edit**, type the keys again and click **Test and save**.
  If you restored the panel with `restaurar-painel.sh`, this is also the effect of the old keys that
  came back (see the warning in step 5).
- **"A pasta do código deste projeto (…) fica fora da pasta de projetos desta VPS" (a server
  message: the project's code folder is outside this VPS's projects folder):** the panel does not
  write outside the projects folder. Put the code inside it, with no symbolic link pointing outside,
  and register the path again in the project's configuration.
- **"A pasta do código (…) já existe nesta VPS e tem arquivos: ficou como está, nada foi
  sobrescrito" (a server message: the code folder already exists with files and was left as it is):**
  the deploy uses what is already there. If you want the code from the backup, rename or empty the
  source folder **before** clicking **Restore**, never afterwards (see step 7).
- **A restore fails halfway:** the panel keeps the previous state in
  `/data/backups/_painel/antes-da-restauracao/` and undoes a failed panel swap by itself. Read the
  error in **Latest backups** and run the step again.
- **No access to the panel at all:** restore the panel from a downloaded file with
  `restaurar-painel.sh`, or open the `.7z` by hand with 7-Zip. The kit explains both.
