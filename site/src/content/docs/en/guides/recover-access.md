---
title: "I lost access: now what?"
description: "How to get back in after losing the panel password, the two-factor authentication phone, the Linux password, the SSH key or the panel domain."
sidebar:
  label: "Recover access"
---

Hardening closes ports on purpose, and that cuts off some ways back in. This section exists so
you don't find that out at the worst possible moment. Found your case in the table? Go straight to it.

> [!NOTE]
> **Interface language.** The panel is available in English and Portuguese ([how to choose](../getting-started/complete-guide.md#idioma-da-interface)). This page quotes the English labels exactly as they appear on screen. Some messages that come from the server still appear in Portuguese in both languages (alerts, audit details, health and security-scan results, and many error messages).

| What you lost | What still works | Way back in |
|---|---|---|
| **Panel** password (web sign-in) | SSH into the VPS | `sudo ./scripts/reset-setup.sh --full` |
| Your **phone** for two-factor authentication | Recovery codes | At sign-in, type a recovery code instead of the app code |
| Your **phone** and the recovery codes | SSH into the VPS | `sudo ./scripts/reset-2fa.sh` |
| **Linux user** password (the `sudo` one) | SSH + panel | Panel terminal (if it opens as root) → `passwd YOUR_USER`; otherwise, the provider console |
| **SSH key** | Panel reachable | **Settings → VPS access → SSH keys** (or the panel terminal, if it opens as your user or root) |
| **SSH key** | Provider console | `sudo /opt/tws-panel/scripts/recuperar-acesso.sh`, or sign in with user and password → put the key back |
| **Panel domain** (with IP access turned off) | SSH into the VPS | `sudo ./scripts/reativar-acesso-ip.sh` |
| My **computer** (wiped, lost or stolen) | Panel reachable | **Settings → VPS access → SSH keys**: add the new key |
| My computer **and** I can't get into the panel | Provider console | `sudo /opt/tws-panel/scripts/recuperar-acesso.sh` (opens SSH by password for 15 minutes only) |
| I got **blocked** (fail2ban) for a wrong key | Panel reachable, or the provider console | **Settings → VPS access → Blocked IPs**, or `recuperar-acesso.sh` option 2 |
| Panel password, **without deleting the account** | Provider console or SSH | `recuperar-acesso.sh` option 5 (keeps 2FA, projects and domains) |
| All of the above | — | The provider's rescue mode |

> [!IMPORTANT]
> **Confirm your recovery path BEFORE applying hardening.** Open your provider's dashboard and look
> for "Console", "VNC", "Rescue" or "Recovery mode". If you can't find any, the prevention described in [Installation, Step 4](../getting-started/installation.md#passo-4) stops being a recommendation and becomes mandatory:
> without a console there is no safety net, and a lost key can mean reinstalling the machine
> from scratch.

## I lost the panel password

Want to keep the account, 2FA, projects and domains? From the provider console run `sudo /opt/tws-panel/scripts/recuperar-acesso.sh` and choose option 5: it only changes the panel password (and ends sessions and revokes API tokens).

The panel's administrator account is independent of the operating system. With SSH access to the
VPS, delete the account and redo the **Administrator account** step of
the wizard:

```bash
cd /opt/tws-panel
sudo ./scripts/reset-setup.sh --full
sudo ./scripts/show-token.sh
```

The first command deletes the admin account and all sessions (it asks for confirmation: type
`resetar`, Portuguese for "reset"). The second shows the setup token again, so you can reopen the
wizard and create a new account.

Can you still sign in to the panel and want to redo the wizard? Under **Setup** (once setup is
complete) there is a **Start over from scratch** button: it asks for the
current password, the two-factor authentication code, and for you to type the confirmation word
(`restart` with the English interface, `recomeçar` with the Portuguese one; `recomeçar` is accepted
in both) before you click **Delete and start over**;
it deletes the account and sessions and immediately opens the wizard with a new token. Without
two-factor authentication enabled, the panel doesn't offer this button — use the script above.

**Your projects, domains, email and security history are not touched.**

## I lost the phone for two-factor authentication

At sign-in, type one of your **recovery codes** in the code field (each one works once). Once
inside the panel, turn the verification off and on again to register the new phone and get new
codes.

**Locked out by wrong codes?** After 5 wrong codes in a row the app code is locked (5 minutes, doubling
on each repeat up to 24 hours), but a **recovery code still signs you in**. With no recovery code, and
your phone at hand, clear only the lock on the VPS (`sudo ./scripts/reset-2fa.sh --so-bloqueio`,
confirmation word: `liberar`; two-factor stays on).

Lost the codes too? With SSH access to the VPS:

```bash
cd /opt/tws-panel
sudo ./scripts/reset-2fa.sh
```

It asks for confirmation (type `desligar`, Portuguese for "turn off"), stops the panel for a few
seconds, turns two-factor authentication off (clearing any wrong-code lock), and brings the panel back up. Sign in with just your
username and password and enable the verification again. **Nothing else is touched.**

## I lost the Linux user password

This is the trickiest one, because everything looks fine: the SSH key still lets you in, but no
`sudo` works — and hardening locked the root password, so you can't become root the normal way.

**If the panel terminal opens as root** (the `root` choice at install time, or an install that
predates that question), it's your way out. In the panel, open the terminal and run:

```bash
passwd YOUR_USER
```

Set the new password and you're done.

**If it opens as your user**, that path doesn't exist, and that's on purpose: in `senha`
(password) mode, `sudo` would ask for exactly the password you lost; in `segundo-plano`
(background) mode, the panel only runs its own scan and hardening commands as root, not an
arbitrary `passwd`. The way out is the **provider console** or rescue mode — which is why it's
worth confirming they work before hardening.

## I lost the SSH key

You need to install a new key in your user's `~/.ssh/authorized_keys`. Generate a new pair on
your computer ([Installation, Step 4](../getting-started/installation.md#passo-4)) and use one of the paths below, in order:

**1. Through the panel terminal** — if you can still get into the panel. If it opens as **your
user**, the `~/.ssh` folder is theirs, and no root is needed:

```bash
echo "PASTE_THE_NEW_PUBLIC_KEY_HERE" >> ~/.ssh/authorized_keys
```

If it opens as **root**, give the full path:

```bash
echo "PASTE_THE_NEW_PUBLIC_KEY_HERE" >> /home/YOUR_USER/.ssh/authorized_keys
```

(Did you pick, at install time, a user different from the one you use for SSH? Then the terminal
can't reach your user's folder without root — go on to path 2.)

**2. Through the provider console** — browser access doesn't go through SSH, so the password
password sign-in restriction doesn't apply there. Sign in with your user and password, and run the same
command (without the full path, since you're signed in as that user):

```bash
echo "PASTE_THE_NEW_PUBLIC_KEY_HERE" >> ~/.ssh/authorized_keys
```

**3. Through rescue mode** — last resort. The provider boots the machine from another system and
mounts your disk, letting you edit `authorized_keys` from outside. The procedure varies by
provider; look for "rescue mode" in their documentation.

> [!WARNING]
> Always `>>`, never `>`. A lone `>` **erases** the keys that were already there — including the
> one you may still be using. Check the result with `cat ~/.ssh/authorized_keys` before closing
> the session, and test the connection in a new window **before** ending the one that works.

<a id="o-domínio-do-painel-parou-de-abrir"></a>
## The panel domain stopped opening

This applies to anyone who registered a domain under **Settings → Panel domain**
(Settings → Panel domain) and then turned off IP access. If the domain stops opening (DNS
deleted or changed, expired domain, certificate that didn't renew), turn the IP address back on
with SSH access to the VPS:

```bash
cd /opt/tws-panel && sudo ./scripts/reativar-acesso-ip.sh
```

The script stops the panel, turns IP access back on (the domain stays registered), brings the
panel up, and checks that the proxy has the IP address again. Then open
`https://YOUR-IP-WITH-HYPHENS.sslip.io` and sign in again. Username, password, projects and
everything else stay as they are.

## I wiped my computer (or lost it, or it was stolen)

If you can still sign in to the panel, **you don't need the provider console**:

1. On the new computer, open a terminal (PowerShell on Windows) and run `ssh-keygen -t ed25519 -C "my-laptop"`. It creates a key pair; the file ending in `.pub` is the **public** key, the only one you share.
2. In the panel, go to **Settings → VPS access → SSH keys**, paste the whole line from the `.pub` file and confirm with the panel password, the app code and, if you turned it on, the code sent by email.
3. Test in a new terminal window. Only then, if the old computer was stolen or lost, **remove the old key** in the same list. The panel never removes the last key: you can't lock yourself out by mistake.

The panel does not generate a private key in the browser, does not open SSH by password and does not touch the firewall: it only adds or removes lines of your user's `authorized_keys`.

**Lost access to the panel too?** Use the single command in the next section.

## One command from the provider console

From the provider console (VNC/"Console"), sign in with the Linux user and its password and run:

```bash
sudo /opt/tws-panel/scripts/recuperar-acesso.sh
```

The menu offers:

1. **Open SSH by password for 15 minutes**, only for your administration user (and, if you want, only for one IP). It closes by itself, **even if the VPS reboots**, and you can close it earlier with the `fechar` option. Within the 15 minutes, sign in over SSH with the password, add the new key and you're done.
2. **Unblock fail2ban** (for when you used a wrong key and got banned).
3. **Turn IP access back on** for the panel (what `reativar-acesso-ip.sh` does).
4. **Turn off two-factor authentication** or just the **email code**.
5. **Reset only the panel password**, without deleting the account, 2FA, projects or domains.

The script is safe to repeat. The Linux password is the one you saved in your password manager (or the one you changed in **Settings → VPS access**); it works for the console and `sudo`, and does **not** open SSH.

## I got blocked

After 3 wrong keys in a row, fail2ban blocks your IP for 6 hours (longer if you insist). It happens, for example, when you try the old computer's key. With the panel open, see and unblock it in **Settings → VPS access → Blocked IPs** (your IP is highlighted). Without the panel, use `recuperar-acesso.sh` option 2 from the provider console.

## How much to trust each way out

From easiest to most drastic, use the first one that works:

1. **Panel** (VPS access): needs password + app code (+ email code, if on).
2. **Recovery code** for 2FA, at sign-in.
3. **Provider console** with `recuperar-acesso.sh`: needs the Linux user's password and the provider account.
4. The provider's **rescue mode**: last resort.

At the top of everything is your **provider account** (its password and 2FA): whoever controls it controls the VPS. Never lose it.

## Email code (optional)

In **Settings → Security → Email code** you can turn on a **third factor**, off by default. When on, the sensitive actions (SSH keys, Linux password, IP unblocking, the kit, turning off 2FA, generating new recovery codes, changing the panel password, restarting the wizard and creating API tokens) also ask for a 6-digit code sent to your email (valid for 10 minutes, once). To turn it on you need 2FA on, an email on your profile and the panel's email sending working.

> [!WARNING]
> Use an email **outside the VPS** (Gmail, for example). A mailbox hosted on the VPS itself goes down with it, exactly when you'd need the code; the panel warns you if it detects that. If email stops arriving, the way out is `recuperar-acesso.sh` option 4 from the provider console.

## Recovery kit and recovery codes

In **Settings → VPS access → Recovery kit** the panel generates a sheet to **print or download**, with the panel address, the user, the port, the key fingerprints and the step-by-step. It **contains no password, private key or codes**. Keep it with your 2FA recovery codes (which you can swap for 10 new ones, without turning 2FA off, in **Settings → Security**; the panel warns when 3 or fewer are left).

## Do this before you need it

- Keep a **reserve SSH key** (protected by a passphrase) in your password manager and on a USB stick, and add its **public** half to the panel.
- Write down the **Linux user's password** in your password manager and **test the provider console** (login and `sudo`).
- Keep the 2FA **recovery codes** printed and the **provider account's 2FA**.
- If you turn on the email code, use an external address.
- Every six months, rehearse: add a test key, remove it, open the provider console and run the menu without choosing anything.

## The panel terminal paradox

You may have noticed that the built-in terminal shows up twice as a lifesaver. The more power it
has, the more it saves you — and the more dangerous it is. Opened as root, it's the back door
when everything else fails, and for exactly that reason the most sensitive point in the system.
Opened as your user (the recommended setup), it saves you less, but a forgotten session also
hands over less.

It's worth knowing it works this way and deciding consciously: keeping the panel reachable is a
safety net, but it's also the installation's largest attack surface. If you choose to restrict
access to it, first make sure your provider's console works.
