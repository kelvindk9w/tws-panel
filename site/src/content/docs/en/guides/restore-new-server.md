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
> **The panel interface is being translated.** For now, screen names, buttons and messages appear in Portuguese, exactly as on screen, followed by the English meaning in parentheses. They may change when the English interface is released.

Most of the time goes to waiting for DNS and for projects to be published again. If the old VPS
still runs, keep it until the last step.

## What you need before you start

Keep all of this **outside the VPS** (a password manager, for example). You cannot get it from a
server you no longer have.

| What | Where it comes from | If you lost it |
|---|---|---|
| **Backup password** | The recovery kit you downloaded in **Configurações → Backups → Criptografia** (Settings → Backups → Encryption). The panel also shows it under **Ver a senha** (View the password), but only on a panel you can still log in to. | There is no way around it: without the password, nobody can open the external copies. |
| **Storage endpoint and bucket** | The recovery kit lists the bucket and the endpoint. | In Cloudflare: R2 → your bucket → Settings → S3 API. |
| **Storage access keys** (Access Key ID and Secret Access Key) | You saw them once, when you created the token on Cloudflare. **They are not in the kit.** | Create a new R2 API token for the same bucket ([Complete guide, Step 8.1](../getting-started/complete-guide.md#etapa-8)). Old files stay readable. |
| **Domain access** | Your DNS provider or registrar. | Recover it with the registrar. |
| **Provider access** | The new VPS provider's dashboard (to set the PTR and unblock port 25). | — |

## What is restored and what is not

| Comes back | Does **not** come back (you redo it) |
|---|---|
| **Panel:** administrator accounts and two-step verification, registered projects, settings, notification and backup settings, panel domain and the keys that encrypt the secrets (project variables, tokens). | The operating system and its hardening: user, SSH key, firewall. Run the installation and the security wizard on the new VPS. |
| **Projects:** the databases and folders that were checked in each project's **Backups** tab, and the code of projects that do not come from GitHub. | Anything that was **not** checked in the project's Backups tab, and files written outside volumes. |
| **Email:** mailboxes, messages, accounts, rules and DKIM keys, and the webmail settings. | DNS records, the PTR and the provider's firewall. They point to the old IP. |
| | TLS certificates: they are issued again, once DNS points to the new VPS. |
| | The email IP reputation: a new IP starts with none. |
| | Projects from GitHub come from the repository's **current** branch, not from the date of the backup. |

## Step by step

### 1. Prepare the new VPS

Follow the [installation guide](../getting-started/installation.md) from Step 1 to Step 8 and finish
the setup wizard, including the Security step. The restore needs a logged-in panel, so create a
temporary administrator account when the wizard asks for it. The restore replaces it with the old
accounts.

Check that ports **80 and 443** are open at the provider, and port **25** if you will use email
(see [Complete guide, Step 6.1](../getting-started/complete-guide.md#etapa-6)).

### 2. Stop the old panel's backups

Do this if the old VPS still runs. The restored panel brings back the same backup settings, and two
servers writing to the same bucket would mix their copies and their retention. On the old VPS:

```bash
cd /opt/tws-panel && sudo docker compose stop
```

Skip this step if the old VPS is gone.

### 3. Connect the same storage

In the new panel, open **Configurações → Backups** (Settings → Backups). In **Armazenamento externo**
(External storage), type the same endpoint, bucket and access keys the old VPS used. Region: `auto`.
Click **Testar e salvar** (Test and save).

**What to check:** "Conexão testada e salva" (Connection tested and saved) appears.

### 4. Enter the backup password

Still in **Configurações → Backups**, find the **Restaurar de outro servidor** (Restore from another
server) card and click **Começar** (Start).

1. Step 1 of the card shows the connected bucket.
2. In step 2, type the backup password from the kit and click **Conferir e usar** (Check and use).

**What to check:** the card accepts the password. If it says it cannot verify it because the check
file is missing, you can click **Usar esta senha mesmo assim** (Use this password anyway). If it says
the password does not open the backups, check the kit again.

### 5. Restore the panel first

1. In step 3, click **Ver o que existe no armazenamento** (See what exists in the storage).
2. In the **Painel** (Panel) block, click **Restaurar o painel** (Restore the panel).
3. Choose the date, which is usually the most recent. Confirm by typing `painel`.
4. Wait. The panel restarts by itself.

**What to check:** open the new VPS address again (`https://203-0-113-10.sslip.io`, with the new IP)
and log in with the **old** administrator username and password, plus the two-step code from the old
phone. Go back to **Configurações → Backups → Restaurar de outro servidor**.

> [!WARNING]
> **If the old panel had access by IP turned off**, that setting comes back too. The new panel then
> answers only on the panel domain, which still points to the old VPS, and you cannot log in. Two
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

In the **Projetos** (Projects) block of the card, click **Restaurar** (Restore) next to each project.

- A project shown as "Não cadastrado aqui: restaure o painel primeiro" (Not registered here: restore
  the panel first) means step 5 did not finish.
- Choose the date and confirm by typing the project name.
- On a new VPS the project has no containers. Keep **Publicar do GitHub antes de restaurar**
  (Publish from GitHub before restoring) checked: the panel publishes the project again from its
  repository and then puts the databases and folders back. This can take several minutes per
  project, and the panel waits up to 45 minutes.

**What to check:** each project opens at its domain, the data is there, and the **Domínios**
(Domains) tab shows a **Válido** (Valid) certificate. A certificate fails until the DNS from step 6
points to the new IP. Use **Tentar emitir agora** (Try to issue now) after that.

### 8. Restore the email last

1. In the card, click **Restaurar o e-mail** (Restore the email) and confirm by typing `e-mail`.
2. Update the DNS (**E-mail** page → the domain → **Checklist DNS**):
   - the **A** record of `mail.send.example.com` to the new IP;
   - the **SPF** record, which contains the old IP (`ip4:`): copy the new value from the checklist;
   - MX, DKIM and DMARC do not change, because the names and the keys came back.
3. Ask the provider to set the **PTR** of the new IP to `mail.send.example.com`.
4. Check that outbound port 25 is open ([Complete guide, Step 6.1](../getting-started/complete-guide.md#etapa-6)).

**What to check:** click **Verificar agora** (Check now) until you reach **6/6 OK**, send a test email
(Step 6.7 of the complete guide), and see **válido** in the email certificate card. Send slowly at
first: the new IP has no reputation yet.

## Final checks

- The panel opens at its domain with a padlock, and login and two-step verification work.
- **Certificados** (Certificates) shows every address as **Válido**.
- Every project opens and has its data.
- Email: the DNS checklist is 6/6, the test email arrives, and a mailbox can log in to the webmail.
- **Configurações → Fuso horário** (Settings → Time zone) shows the time zone you want. Backups run
  at 03:00 in the VPS time zone.
- Run **Fazer backup agora** (Back up now) on the panel and see "cópia externa conferida" (external
  copy verified). Then run a project backup.
- If the **Alertas** (Alerts) page shows differences from the old server, create the security
  baseline again, now that the new VPS is hardened.
- Turn the old VPS off for good only now, and delete its DNS leftovers.

## If something fails

- **Wrong password:** the card does not accept it. Check the kit again. For a backup made before a
  password change, the restore window has a link, **Este backup é de antes de uma troca de senha?**
  (Is this backup from before a password change?), where you type the password of that time.
- **A restore fails halfway:** the panel keeps the previous state in
  `/data/backups/_painel/antes-da-restauracao/` and undoes a failed panel swap by itself. Read the
  error in **Últimos backups** (Latest backups) and run the step again.
- **No access to the panel at all:** restore the panel from a downloaded file with
  `restaurar-painel.sh`, or open the `.7z` by hand with 7-Zip. The kit explains both.
