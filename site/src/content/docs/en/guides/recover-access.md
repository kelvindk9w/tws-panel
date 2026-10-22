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
| **SSH key** | Panel reachable | Panel terminal (if it opens as your user or root) → put the key back |
| **SSH key** | Provider console | Sign in with user and password → put the key back |
| **Panel domain** (with IP access turned off) | SSH into the VPS | `sudo ./scripts/reativar-acesso-ip.sh` |
| All of the above | — | The provider's rescue mode |

> [!IMPORTANT]
> **Confirm your recovery path BEFORE applying hardening.** Open your provider's dashboard and look
> for "Console", "VNC", "Rescue" or "Recovery mode". If you can't find any, the prevention described in [Installation, Step 4](../getting-started/installation.md#passo-4) stops being a recommendation and becomes mandatory:
> without a console there is no safety net, and a lost key can mean reinstalling the machine
> from scratch.

## I lost the panel password

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

## The panel terminal paradox

You may have noticed that the built-in terminal shows up twice as a lifesaver. The more power it
has, the more it saves you — and the more dangerous it is. Opened as root, it's the back door
when everything else fails, and for exactly that reason the most sensitive point in the system.
Opened as your user (the recommended setup), it saves you less, but a forgotten session also
hands over less.

It's worth knowing it works this way and deciding consciously: keeping the panel reachable is a
safety net, but it's also the installation's largest attack surface. If you choose to restrict
access to it, first make sure your provider's console works.
