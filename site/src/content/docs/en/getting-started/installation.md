---
title: "Step-by-step installation"
---

A complete guide to installing TWS Panel on a clean VPS, from scratch all the way to the setup
wizard. The [README](https://github.com/kelvindk9w/tws-panel/blob/main/README.md) has the short version; this guide explains every
step, what shows up on screen, and what to do when something goes wrong.

The steps are numbered 1 to 8. The panel's scripts (`install.sh`, `uninstall.sh`) refer to
these numbers.

| Step | Where | What it does |
|---|---|---|
| [1](#passo-1) | Provider | Get a VPS |
| [2](#passo-2) | Your computer → VPS | Log in as root and check the system |
| [3](#passo-3) | VPS | Create your non-root user |
| [4](#passo-4) | Your computer | Generate the SSH key and install it on the VPS |
| [5](#passo-5) | VPS | Install git |
| [6](#passo-6) | VPS | Clone the repository into `/opt/tws-panel` |
| [7](#passo-7) | VPS | Run the installer |
| [8](#passo-8) | Browser | Open the panel and follow the wizard |

After Step 8, the wizard's Security step has its own guide:
[Security wizard](security-wizard.md).

## Before you start

> [!NOTE]
> **The only prerequisite:** a clean VPS running Ubuntu 22.04 or 24.04 LTS. Docker, Node and everything else are installed automatically — just follow the steps below, in order.

<details>
<summary>⚠️ <strong>Got an error when connecting: "REMOTE HOST IDENTIFICATION HAS CHANGED!"</strong></summary>

<a id="host-identification-changed"></a>

If, when trying to connect, you saw this in big capital letters and the connection was refused:

```text
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!
...
Host key verification failed.
```

**What happened.** SSH keeps the "fingerprint" of every server you have logged in to. The
fingerprint the server just presented is **different** from the one stored on your computer — and
SSH would rather refuse the connection than connect you to a server that may not be yours.

**When this is expected:** you reinstalled the VPS operating system, switched VPS, or the
provider reassigned that same IP to another machine. In those cases the server really is a
different one, and the old fingerprint is no longer valid.

**The fix** — delete the old fingerprint for that IP and connect again. Run **on your computer**:

```bash
ssh-keygen -R YOUR_IP
ssh root@YOUR_IP
```

(`YOUR_IP` is a placeholder: replace it with your VPS IP.)

It will ask whether you trust the new identity — answer `yes`. That's it, the connection goes back
to normal.

> [!IMPORTANT]
> **This warning is not red tape.** It is SSH's only defense against someone impersonating your
> server. Ignoring it is safe **only when you know why the identity changed** — and reinstalling
> the system is a legitimate reason. If it showed up **without** you having reinstalled or switched
> machines, **do not continue**: investigate first.

</details>

<details>
<summary>🔄 <strong>Already had the panel installed and want to start over?</strong></summary>

Before reinstalling the whole machine, check whether that is really your case — almost always it isn't.

**I just want to redo the setup wizard.** You don't need to reinstall anything. On the VPS:

```bash
cd /opt/tws-panel
sudo ./scripts/reset-setup.sh     # the wizard goes back to step 0
sudo ./scripts/show-token.sh      # shows the setup token again
```

Your projects, domains, email and security history stay intact. Use `--full` on the first
command if you also want to delete the panel's administrator account.

<a id="remover-o-painel"></a>

**I want to remove the panel and install it again, without reinstalling the system.** Useful for
testing the installation as many times as you like. On the VPS:

```bash
cd /opt/tws-panel
./scripts/uninstall.sh --dry-run   # only shows what would be deleted; changes nothing
./scripts/uninstall.sh             # shows it again and asks you to type "remover"
```

(The script is in Portuguese: the confirmation prompt expects you to type the word `remover`, which means "remove".)

It deletes **everything the panel created**: the panel and its containers, the proxy (Caddy), the
email server, the deployed projects with their data, the `/opt/tws-projects` folder, the hardening
scripts copied to the VPS and, last of all, the `/opt/tws-panel` folder itself. Before deleting, it
lists exactly what it found. Afterwards, move to another folder (`cd ~`) and **start over from [Step 6](#passo-6)**
(cloning the repository) — the git from Step 5 is still installed. Want to keep the repository folder?
Use `--keep-repo` and go straight to [Step 7](#passo-7).

> [!WARNING]
> **What it does NOT undo:** the security phases that were already applied remain in effect — the
> root password stays locked, SSH stays without password login, and the firewall, fail2ban and
> removed packages stay as they are. Your user, the SSH key installed on it and Docker also stay. For
> a truly from-scratch VPS, the way is the next one: reinstall the system.

**I want a truly clean machine.** In that case you do need to reinstall the operating system, and it
happens in two places:

**1. In your VPS provider's panel.** Look for "Reinstall", "Reimage" or similar
— the name varies by provider. Choose **Ubuntu 24.04 LTS** and **write down the new root password**
it generates; the old one stops working.

> [!WARNING]
> Reinstalling deletes **everything**: your projects, databases, emails, TLS certificates and the panel.
> There is no undo. If there is anything you want to keep, copy it first.

**2. On your computer.** Since the system is a different one, the server now identifies itself with a
different key, and your next connection will be **refused** with the warning
`REMOTE HOST IDENTIFICATION HAS CHANGED!`. This is expected, and the fix is in the block right above:

**[⬆️ Got an error when connecting: "REMOTE HOST IDENTIFICATION HAS CHANGED!"](#host-identification-changed)**

After that, just follow from Step 1 onwards, as with a new VPS — because now it is one.

</details>

<a id="passo-1"></a>

## Step 1 — Get a VPS

Get a VPS running Ubuntu 24.04 LTS (recommended minimum: 1 vCPU / 2 GB RAM / 25 GB disk).

> [!NOTE]
> **Never rented a VPS before?** This guide starts at the point where you already have **an IP and a
> root password** in hand. How to sign up, pay and choose the region differs from provider to
> provider, and the provider itself documents that part best — look for "getting started"
> in their help center, and pick **Ubuntu 24.04 LTS** when creating it.
>
> Stuck there, before you have the IP? [Talk to TWS](https://tws.tec.br/) — we'll help and, if your
> case is a common one, it will go into this documentation.

<a id="passo-2"></a>

## Step 2 — Log in as root via SSH

Log in to the VPS and confirm the OS version:

```bash
ssh root@YOUR_IP
cat /etc/os-release   # expected: PRETTY_NAME="Ubuntu 24.04.x LTS" (or 22.04)
```

<details>
<summary>🔐 <strong>First time connecting via SSH? What shows up and what to answer</strong></summary>

On the **first connection** to any new server, SSH shows this warning:

```text
The authenticity of host '203.0.113.10 (203.0.113.10)' can't be established.
ED25519 key fingerprint is SHA256:Xk9vN2mQpL7dR4wT8yB3cF6hJ1uA5sE0gH9zK2xW4vM.
This key is not known by any other names.
Are you sure you want to continue connecting (yes/no/[fingerprint])?
```

**What to answer:** type `yes` and press Enter.

**What is this?** The *fingerprint* is the server's "digital signature" — it is how your computer
recognizes the VPS on later connections. The warning appears **only the first time**; after that the
fingerprint is saved and the connection is direct.

**Common errors:**

- **"I type the password and nothing shows up"** — that's normal! The terminal **shows no characters**
  (not even `*`) while you type passwords. Type calmly and press Enter.
- **`Permission denied (publickey,password)`** — wrong password, or the VPS provider requires an
  SSH key. Check the password in the provider's panel and try again.
- **The fingerprint warning shows up again after reinstalling the VPS** — normal, the machine
  changed. Remove the old entry with `ssh-keygen -R YOUR_IP` and connect again.

</details>

<a id="passo-3"></a>

## Step 3 — Create your non-root user

This is the user who will operate the VPS from now on:

```bash
adduser YOUR_USER           # replace YOUR_USER with any name you like; you choose the password on the spot
usermod -aG sudo YOUR_USER  # grants administrator permission (sudo)


# --- Mistyped the password, gave up midway or want to start over? Choose ONE of the two: ---
passwd YOUR_USER                  # sets/resets only the password, keeping the user
deluser --remove-home YOUR_USER   # deletes the user and their folder, so you can create everything again
```

(`YOUR_USER` is a placeholder for the username you choose.)

<details>
<summary>👤 <strong>Stuck on <code>adduser</code>? What shows up and what to fill in</strong></summary>

When you run `adduser YOUR_USER`, the system asks a series of questions. In the examples below
we use "kelvin" as an example name — in your case the username you
chose will appear. This is how it looks:

```text
Adding user `kelvin' ...
Adding new group `kelvin' (1000) ...
Adding new user `kelvin' (1000) with group `kelvin' ...
Creating home directory `/home/kelvin' ...
Copying files from `/etc/skel' ...
New password:
Retype new password:
passwd: password updated successfully
Changing the user information for kelvin
Enter the new value, or press ENTER for the default
        Full Name []:
        Room Number []:
        Work Phone []:
        Home Phone []:
        Other []:
Is the information correct? [Y/n]
```

**What to fill in, step by step:**

1. **`New password:`** — create a strong password **that you will remember** (it is your user's
   password, used for SSH and for `sudo`). Note: **nothing shows while you type** —
   not even `*`. That's normal, the password is being recorded. Type it and press Enter.
2. **`Retype new password:`** — repeat the same password.
3. **`Full Name`, `Room Number`, `Work Phone`, `Home Phone`, `Other`** — optional data.
   You can leave everything blank: just press **Enter** on each one.
4. **`Is the information correct? [Y/n]`** — type `Y` (or just Enter) to confirm.

**Common errors:**

- **`Sorry, passwords do not match`** followed by **`Try again? [y/N]`** — the two passwords
  you typed were different. Answer **`y`** to type them again. Beware of the capital
  `N`: it is the default, so **just pressing Enter is the same as answering `n`**.

  **What if I already answered `n`?** Then `adduser` gives up on the password but **keeps going and creates the
  user** — you will see `passwd: password unchanged` and, at the end, `Adding new user ...`.
  The user exists, but **has no password**, and cannot log in over SSH. Nothing is lost: set the
  password now, without recreating anything.

  ```bash
  passwd YOUR_USER
  ```

  If you prefer to start from zero, delete the user and run `adduser` again:

  ```bash
  deluser --remove-home YOUR_USER
  ```
- **I typed `n` (or anything) at `Room Number` / `Work Phone`** — these are purely cosmetic fields,
  they affect neither login nor permissions. If you want to clear them: `chfn YOUR_USER` and press
  Enter on each field.
- **`BAD PASSWORD: ...`** — weak password warning. The system accepts it, but prefer a
  long one (a phrase with words + numbers, e.g.: `horse-battery-42-window`).
- **"I think I mistyped because I saw nothing"** — no problem: if you got it wrong, `adduser`
  complains (`Sorry, try again.`) and asks again.

</details>

**Check that it worked before moving on:**

```bash
id YOUR_USER
```

`sudo` must appear in the list of groups. If it doesn't, the second command didn't take.

> [!CAUTION]
> **The two commands above are a pair — and the second one is the easiest to lose.** If you get the
> name wrong, give up midway and create the user again with **another name**, the `usermod` you
> already ran still points to the old user. The new one is born **without administrator permission**,
> and the symptom only shows up much later, in Step 5:
>
> ```text
> YOUR_USER is not in the sudoers file.
> ```
>
> Changed the username? **Run both commands again**, with the new name, and confirm with the
> `id` above.

> [!IMPORTANT]
> **Why before everything else?** Operating as root is a security anti-pattern. By creating the user now,
> the wizard only needs to **validate** that it exists (security Phase 01) instead of creating it — and
> root access will be locked at the end of the process. **Write down the name you chose**: you will type it
> again in the wizard's Security step.

**Now end the root session.** We are not reconnecting yet — the next step happens on your
computer, and `exit` already leaves you there:

```bash
exit    # leaves root and closes the SSH connection
```

You are back at your computer's terminal. Step 4 continues from there.

<details>
<summary>🤔 <strong>What about <code>su - YOUR_USER</code>, won't that do?</strong></summary>

It works, and it's faster — but it has a side effect worth knowing about.

With `su - YOUR_USER` you stay **inside the root session** — just with another identity on
top. An `exit` returns you to root instead of ending access, and it is easy to forget that that
terminal still has a root session open underneath.

By logging in over SSH directly as your user, the session is theirs from start to finish: `exit` really
ends it, and anything that requires privilege goes through `sudo` — which asks for a password and is logged
in the system log. It is the difference between "I'm root wearing another hat" and "I'm a
regular user and I ask permission when I need to".

This matters even more if you will leave the session open for a while: better that it be your
user's, not root's.

**And why don't we use that shortcut here?** Besides the root session that stays open, it
keeps you inside the VPS — and Step 4 happens on your computer. You would have to leave anyway,
so `exit` solves both things at once.

</details>

> [!WARNING]
> **This password won't be enough to get into the VPS.** It gets you this far and remains the one
> `sudo` asks for inside the machine — but the wizard's Security step **turns off password login
> over SSH**. From then on, your key is what gets you in.
>
> That is why **Step 4, right below, is not optional**: it's where you generate that key. If you skip it, you will
> get stuck in the middle of the wizard, with a 5-minute timer running, having to switch to another
> terminal to sort it out.

<details>
<summary>⏱️ <strong>Want to control how long your SSH session survives idle?</strong> (optional — read if the connection drops by itself when you stop typing)</summary>

If you have noticed the session closing after a few minutes idle, the culprit is almost always
the **VPS provider**, not the server: network firewalls tend to drop connections that
sit without traffic for a while. Your computer can fix this by sending a sign of life
every minute. Run **on your computer**, not on the VPS:

```bash
# on YOUR computer (Linux/macOS). On Windows with PuTTY, the equivalent field is
# "Seconds between keepalives" under Connection.
printf 'Host *\n    ServerAliveInterval 60\n    ServerAliveCountMax 3\n' >> ~/.ssh/config
```

After that, reconnect. **This does not weaken security** — the session is still
ended if the network really goes down; what changes is that it stops *looking* abandoned while
you are working.

> [!IMPORTANT]
> **Later, in the wizard, this changes.** When you apply the panel's security step,
> it starts ending idle sessions on its own, after about **10 minutes**. This is
> intentional: it protects you from leaving a terminal open and forgotten — on a laptop, in a café,
> on a shared machine. With the keepalive above configured, you won't notice it while
> you are working, only when you truly abandon the session.
>
> **We recommend leaving it that way.** But if your case requires longer idle sessions (a
> long build that you watch from afar, for example), create a file of **your own** with the exact name
> below. Copy and paste the three lines at once — no text editor, no room for a
> typing error:
>
> ```bash
> printf 'ClientAliveInterval 600\nClientAliveCountMax 6\n' | sudo tee /etc/ssh/sshd_config.d/10-local-override.conf
> sudo sshd -t && sudo systemctl restart ssh
> sudo sshd -T | grep -i clientalive
> ```
>
> The time until disconnection is `ClientAliveInterval` **×** `ClientAliveCountMax` — above, 600 × 6 =
> **1 hour**. To never disconnect for idleness, use `0` in both values (we don't recommend it).
>
> **The file name is not decoration.** The panel writes its configuration to
> `40-paas-hardening.conf`, and SSH reads the files in that folder in alphabetical order, with **the
> first value it finds** winning. A file starting with `10-` is read first and therefore wins; a
> `99-something` would be read after the panel's and simply have no effect at all. (This is also
> why the panel uses `40-`: many VPS images ship a `50-cloud-init.conf` that turns on
> password login, and it needs to be overridden.)
>
> The last two lines are your safety net. `sshd -t` checks the file **before**
> restarting — without it, a typing error can keep SSH from coming up and leave you without access to the
> machine. `sshd -T` shows what the server actually adopted, so you're not guessing:
> `clientaliveinterval 600` and `clientalivecountmax 6` must appear. Keep the current window
> open and test reconnecting in **another** one before closing the one that works.
>
> **And when you're done with what you needed**, delete the file. The panel's default goes back into effect
> on its own, without you having to remember what the original values were:
>
> ```bash
> sudo rm /etc/ssh/sshd_config.d/10-local-override.conf
> sudo sshd -t && sudo systemctl restart ssh
> ```

</details>

<a id="passo-4"></a>

## Step 4 — Generate your SSH key

Do this before going to the wizard.

The wizard's Security step will turn off password login over SSH (hardening phase 02). From
then on, the key is your way in — and the wizard **asks for the public key right in the first
phase**, with an automatic 5-minute rollback running. By generating it now, with the terminal
already open, you don't have to stop midway to switch windows.

> [!TIP]
> **The password you just created with `adduser` doesn't go away.** The only thing that changes is the remote
> way in (SSH). Inside the machine, that password is still the one `sudo` asks for.

You just left the VPS, so you are already in the right place: the commands below run **on your
computer**. That is where the key needs to exist so you can authenticate later — if it were
generated on the VPS, it would be no use for logging in to it.

**First, check whether you already have a key.** If you already use SSH for something — GitHub,
another server, work — it probably already exists, and **generating another on top of it deletes the
old one**. Run:

```bash
ls -l ~/.ssh/*.pub
```

On **Windows (PowerShell)**:

```powershell
Get-ChildItem ~\.ssh\*.pub
```

Look **only at the file names** that showed up and follow the first row of the table that matches
what you saw:

| If the list shows… | Use this key | What to do now |
|---|---|---|
| `id_ed25519.pub` (even if other files appear alongside it) | `id_ed25519` | **Don't generate anything.** Go straight to **[⬇️ Install the key on the VPS](#instale-a-chave-na-vps)** (it's a link — click it) |
| `id_rsa.pub`, but **not** `id_ed25519.pub` | `id_rsa` | **Don't generate anything.** Go to **[⬇️ Install the key on the VPS](#instale-a-chave-na-vps)** and, there, use the commands with `id_rsa` |
| Only files with **other names** (e.g. `github_deploy.pub`, `some_service_deploy.pub`) | none of them | **Generate a new key** in the next block |
| `No such file or directory` (or nothing) | — | **Generate a new key** in the next block |

Why this rule, and not "pick whichever you like best":

- **`id_ed25519` and `id_rsa` are names that `ssh` tries on its own** every time you connect.
  Using one of them, logging in to the VPS works with no extra configuration on your computer.
  `id_rsa` is older, but the server accepts it just the same.
- **Keys with other names were created for a specific service** (a deploy, a company,
  a tool). Don't reuse them: besides `ssh` not trying them on its own, mixing accesses
  means that whoever has that key also gets into your VPS.
- **Generating a new `id_ed25519`, in those last two cases, deletes nothing** — it doesn't exist
  yet, so there is nothing to overwrite.

**Now generate the key pair** (only if the table above told you to generate). It is the same command on
Linux, macOS, WSL and Windows PowerShell:

```bash
ssh-keygen -t ed25519
```

> [!WARNING]
> **Run only that line and wait.** `ssh-keygen` is interactive: it stops and asks questions. If you
> paste more than one command at once, the second becomes the **answer** to the first question and the key
> ends up saved in a file with the wrong name.

It asks three questions, in this order:

| What shows up | What to do |
|---|---|
| `Enter file in which to save the key (...id_ed25519):` | Just **Enter** — accepts the default location |
| `Enter passphrase (empty for no passphrase):` | Type a passphrase. **Nothing shows on screen**, not even an asterisk |
| `Enter same passphrase again:` | Repeat the same one |

> [!CAUTION]
> **If `id_ed25519 already exists. Overwrite (y/n)?` appears, answer `n`.** You already had a
> key and the command is about to **delete it forever** — along with access to everything that
> depended on it. By answering `n` the command cancels without breaking anything; go back to the previous block and
> follow the "I already have a key" path.

The passphrase is an extra password that protects the key in case someone gets access to your computer.
It is recommended, and so you don't have to type it on every connection you can keep it in the session:

```bash
eval "$(ssh-agent -s)" && ssh-add ~/.ssh/id_ed25519
```

**When the command finishes**, check that the key was created:

```bash
cat ~/.ssh/id_ed25519.pub
```

On **Windows (PowerShell)** the command to display it is different:

```powershell
Get-Content ~\.ssh\id_ed25519.pub
```

**A single line** will appear, a long one, looking something like this:

```text
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH8k2p... your-user@your-computer
```

(`your-user@your-computer` means "your-user@your-computer": it will show your own username and machine name.)

If the line showed up, the key is created.

<a id="instale-a-chave-na-vps"></a>

**Install the key on the VPS** — now, while the password still works. The command always says **which
file** to install; use the line for the key the table chose:

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub YOUR_USER@YOUR_IP
```

If the table told you to use `id_rsa`, the line is this one (instead of the one above):

```bash
ssh-copy-id -i ~/.ssh/id_rsa.pub YOUR_USER@YOUR_IP
```

> [!WARNING]
> **Don't run `ssh-copy-id` without the `-i ~/.ssh/...pub`.** Without it, the command decides on its own what
> to send: if your computer has keys loaded in the session, it installs **all** of them on the VPS
> (including keys for other services); if not, it takes the most recently modified `id*.pub` file
> — which may not be the one you want. With `-i`, exactly the chosen key goes.

It asks for the `adduser` password one last time and writes your public key to the server. On
**Windows (PowerShell)**, where `ssh-copy-id` doesn't exist, the equivalent is:

```powershell
Get-Content ~\.ssh\id_ed25519.pub | ssh YOUR_USER@YOUR_IP "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

With `id_rsa`, replace `id_ed25519.pub` with `id_rsa.pub` on that line. From here on, whenever
a command mentions `id_ed25519` (the `cat`, the `ssh-add`), anyone using `id_rsa` makes the same swap.

**Now test, and this is the test that matters:**

```bash
ssh YOUR_USER@YOUR_IP
```

If you get in **without it asking for the account password**, it's working. It may ask for the
*key passphrase* — that is a different thing, it's local, and has nothing to do with the server.

> [!IMPORTANT]
> **Why install and test now, and not leave it for the wizard.** The Security step turns off
> password login. If the key is only tested there, the first real test happens at the worst possible
> moment: with the hardening already applied and a 5-minute rollback running.
>
> By doing it here, you test calmly and with the password still active as a safety net. If something
> is wrong, you can fix it without pressure. By the time you reach the wizard, key access is already
> a proven fact.

> [!NOTE]
> The wizard will still **ask for the public key pasted in** at phase 01. It's not wasted work: that is
> where it records which user and which key the panel should consider. When you get there, go back to
> this terminal, run `cat` again and paste the line.

> [!IMPORTANT]
> The command generates **two files**, and they are not interchangeable:
>
> - **`id_ed25519.pub`** — the **public** key. It's the one you paste into the wizard. It can be shown to
>   anyone, with no risk.
> - **`id_ed25519`** (no extension) — the **private** key. It **never leaves your computer**, and is never
>   pasted anywhere. Whoever has this file has access to the VPS.
>
> The whole line that `cat`/`Get-Content` showed — starting at `ssh-ed25519` — is what goes in the
> wizard's public key field in phase 01.

<details>
<summary>🔑 <strong>What if I lose, delete or corrupt the private key?</strong></summary>

**Prevention (do this before moving on):**

- Keep a copy of the private key somewhere safe, such as a password manager. Whoever has
  that copy can access the VPS — treat it like a password.
- A more robust alternative: have a **second key**, generated on another device (another
  computer, or your phone). The wizard field accepts **one key at a time**, so install the
  second one after finishing the wizard, while the first one still works.

  Take the **public** key from the other device (the contents of its `.pub`), connect to the VPS from the
  computer that already has access and append the line:

  ```bash
  echo "PASTE_THE_SECOND_PUBLIC_KEY_HERE" >> ~/.ssh/authorized_keys
  ```

  (Replace `PASTE_THE_SECOND_PUBLIC_KEY_HERE` with the key itself.)

  Use `>>` and not `>` — a lone `>` **erases** the existing keys and locks you out on the
  next connection. Check the result with `cat ~/.ssh/authorized_keys`: both lines should
  appear. That way, losing a device doesn't leave you without access.

**If you have already lost the key** — or the password, or access to the panel — see
[I lost access — now what?](../guides/recover-access.md), which covers each case and the way back.

</details>

The test above already left you connected to the VPS. From here on, **all the steps are done there,
with that user** — anything that needs administrator permission will ask for `sudo` and your password.

<a id="passo-5"></a>

## Step 5 — Install git

```bash
sudo apt update && sudo apt install -y git
```

<details>
<summary>📦 <strong><code>git</code> was already installed. Is that normal?</strong></summary>

**Yes, it's normal.** "Ubuntu 24.04 LTS" in your provider's panel is almost never the raw system from
Canonical: it is a *template* assembled by the provider, and `git`, `curl`, `wget` and `vim` usually come
in that package. Finding `git` already there on a freshly created machine doesn't mean someone got into
it.

The Step 5 command is still valid: if the package is already there, `apt` replies
`git is already the newest version` and does nothing.

**Want to confirm instead of trusting?** These are three read-only checks, none of which alters the system:

```bash
dpkg -V git             # silence = files identical to the official package's
apt-cache policy git    # the origin should be archive.ubuntu.com or security.ubuntu.com
last -a | head          # only your own logins should appear
```

`dpkg -V` compares each installed file against the package's official signature — **no output
is the good result**. In `apt-cache policy`, what matters is the origin: an unknown repository
there would be a reason to stop and investigate.

</details>

<details>
<summary>🔑 <strong>First <code>sudo</code>: the giant warning and the password that doesn't show</strong></summary>

The **first time** you use `sudo` with a new user, a classic warning appears:

```text
We trust you have received the usual lecture from the local System
Administrator. It usually boils down to these three things:

    #1) Respect the privacy of others.
    #2) Think before you type.
    #3) With great power comes great responsibility.

[sudo] password for kelvin:
```

**What to do:**

1. The warning is just welcome ceremony (a Linux tradition) — it doesn't require an answer.
2. At **`[sudo] password for kelvin:`** (on your terminal the name of the user you
   created will appear, not "kelvin"), type **YOUR user's password** (the one you created in
   `adduser`), **not** the root password.
3. Remember: **nothing shows on screen while you type** — not even `*`. Type it and Enter.

That long warning only appears once. After that `sudo` asks for the password directly — and, for
a few minutes, not even that (it "remembers" that you authenticated).

**Common errors:**

- **`Sorry, try again.`** — wrong password. You get 3 attempts before the command fails.
- **`kelvin is not in the sudoers file`** — the user doesn't have administrator permission,
  because the `usermod` from Step 3 never ran for **this** user. Since `sudo` itself
  is blocked, the fix has to be made as root. **On your computer**, open the root
  session, grant the permission and confirm:

  ```bash
  ssh root@YOUR_IP
  usermod -aG sudo YOUR_USER
  id YOUR_USER          # must list "sudo"
  exit
  ```

  **And now the detail that fools everyone:** go back to your user's terminal, close the session
  with `exit` and **connect again**. Linux only reads a user's groups **at the moment the
  session opens** — yours was opened before the group existed, so it would keep refusing the
  command even with the fix already applied. Once reconnected, test with `sudo whoami`: it should answer
  `root`.

</details>

<a id="passo-6"></a>

## Step 6 — Clone the repository

Clone into `/opt` and give ownership of the folder to your user:

```bash
sudo git clone https://github.com/kelvindk9w/tws-panel.git /opt/tws-panel
sudo chown -R $USER:$USER /opt/tws-panel
cd /opt/tws-panel && git checkout main
```

> [!TIP]
> The clone starts on the `dev` branch (the repository's default, used by contributors). For
> **real use**, always use `main` — it only receives validated and tested code. Want to help with
> development? Stay on `dev` (see [CONTRIBUTING.md](https://github.com/kelvindk9w/tws-panel/blob/main/CONTRIBUTING.md)).

<a id="passo-7"></a>

## Step 7 — Run the installer

The installer installs Docker if needed, builds the image, brings the containers up
and finishes by showing your **panel's address**, already with HTTPS:
`https://YOUR-IP-WITH-HYPHENS.sslip.io` (e.g. `https://203-0-113-10.sslip.io`). No tunnel and no
choosing a port.

```bash
./scripts/install.sh
```

> [!NOTE]
> **Where the `https://…sslip.io` address comes from.** [sslip.io](https://sslip.io) is a free,
> public DNS service: the name `203-0-113-10.sslip.io` simply points to the IP
> `203.0.113.10`. It **only translates the name** — traffic goes straight from your browser to your VPS,
> without passing through anyone in between. With that name, the panel's proxy (Caddy) gets a
> **free, valid HTTPS certificate** from [Let's Encrypt](https://letsencrypt.org), and the
> browser opens the panel with the padlock, with no "Not secure" warning. The panel itself listens only
> inside the VPS: from outside, the proxy answers, on ports 80 and 443.
>
> For the certificate to be issued, ports **80 and 443 must be open** to the internet. On
> Contabo (and most VPSs) they already come open. If your provider has a firewall in the
> hosting panel, open both before installing. The installer waits for the certificate
> to be ready (up to 3 minutes) and, if it isn't issued, tells you the most likely reason and shows access
> through a tunnel as an alternative.
>
> Prefer the panel to be **invisible on the internet**, reachable only through an SSH tunnel? See
> [SSH tunnel access](#acesso-por-tunel).

> [!TIP]
> **It may stop right at the start asking you to restart the VPS — that's normal, especially on a
> new VPS.** The provider delivers the system with updates that only take effect after a restart
> (that's the `*** System restart required ***` that shows up when you log in). Nothing has been installed yet: run
> `sudo reboot`, wait about a minute, log in again with the same `ssh` and repeat the two
> commands, `cd /opt/tws-panel` and `./scripts/install.sh`.

> [!NOTE]
> The installer needs administrator privileges (install Docker, create volumes, open
> ports). You **don't need to type `sudo`**: running as your regular user, it detects
> that and re-executes itself via `sudo`, asking for your password. If you prefer to be explicit,
> `sudo ./scripts/install.sh` does exactly the same thing — the two paths are equivalent.
>
> After the installation, everyday Docker commands also take `sudo` in front
> (e.g. `sudo docker compose ps`) — the reason is in
> [Why the panel doesn't put you in the docker group](#grupo-docker).

> [!NOTE]
> **🩺 Pre-flight check:** before installing anything, the installer runs **read-only**
> checks (OS, RAM/disk, Docker and running containers, the ports the panel
> reserves for your projects — 80/443 for the proxy and 25/465/587/143/993/8080 for email — and services
> such as nginx, apache, caddy, postfix, mysql and postgres) and shows a report. The panel's own
> port isn't on that list: it is chosen right afterwards, in a question that already checks whether it is
> free. If the VPS is already
> in use, it warns that the panel was made for a clean VPS and asks for explicit confirmation
> (type `continuar`, the Portuguese word for "continue") — or use `./scripts/install.sh --force` / `PAAS_FORCE=1` in automation. It
> **never removes or stops** anything that already exists on the machine.

<details>
<summary>🩺 <strong>Pre-flight: what shows on screen and what to do in each scenario</strong></summary>

**Scenario 1 — clean VPS (the expected case):** the report comes out all green and the installation
continues on its own, without asking for anything. (The installer's output is in Portuguese; it reads roughly: "Pre-flight: inspecting the machine (nothing will be changed in this step)", then OS, RAM, free disk, Docker absent (will be installed by this script), no Docker containers running, proxy and email ports free, and "Clean machine detected — proceeding with the installation".)

```text
[tws-panel] Pré-flight: inspecionando a máquina (nada será alterado nesta etapa)…
  ✓ SO: Ubuntu 24.04.2 LTS (suportado)
  ✓ RAM: 1984 MB
  ✓ Disco livre em /: 23 GB
  ✓ Docker: ausente (será instalado por este script)
  ✓ Nenhum container Docker em execução
  ✓ Portas do proxy e do e-mail (80/443/25/465/587/143/993/8080) livres
[tws-panel] Máquina limpa detectada ✓ — prosseguindo com a instalação.
```

You don't need to do anything — just wait for the build (it takes a few minutes the first time).

**Scenario 2 — VPS already in use:** the report shows items with `⚠` and the installer **stops and
waits for your decision**. (The output below is in Portuguese. In short, it lists the ports and services found, warns that this VPS does not look clean, explains that TWS Panel is made for a clean Ubuntu VPS and that the installer never removes or stops anything, and asks you to type "continuar" to proceed anyway, or to use `--force` / `PAAS_FORCE=1` in automation.)

```text
  ⚠ Portas em uso: 80 443
  ⚠ Serviço ativo: nginx

================================================================================
  ⚠️  ATENÇÃO: esta VPS NÃO parece estar limpa (2 ponto(s) acima).

  O TWS Panel foi feito para uma VPS Ubuntu LIMPA. Continuar pode causar
  conflitos (portas, serviços, recursos) com o que já existe na máquina.
  Este instalador NUNCA remove ou para nada que já exista — mas os
  serviços do painel podem falhar ao subir se as portas estiverem ocupadas.

  Para prosseguir mesmo assim, digite "continuar" — ou rode com
  --force (PAAS_FORCE=1) em automações.
================================================================================

Digite "continuar" para prosseguir:
```

**What to do:**

- **Recommended:** press **Ctrl+C** (or simply type nothing and close it) to
  abort — nothing was installed or changed. Resolve the conflicts (e.g. disable nginx if
  it is no longer used, or get a clean VPS) and run the installer again.
- **If you know what you're doing** (e.g. the listed service doesn't use the panel's ports):
  type `continuar` and press Enter. By typing it, you confirm that you **read the report and
  accept the risk** of conflicts.

**Common errors:**

- **Typed it wrong (`continua`, `Continuar`)** — the installer aborts with
  `Instalação abortada. Nada foi instalado ou alterado.` (Portuguese for "Installation aborted. Nothing was installed or changed."). Just run it again.
- **Don't use `--force` on your first try** — it skips exactly the reflection this
  warning is meant to provoke. `--force` exists for automation, not for hurrying.

</details>

<a id="terminal-do-painel"></a>

**Right after the pre-flight, the installer asks two questions.** They decide how the **panel's live
terminal** works — it is where the security scan and the hardening run:

1. **Which user the terminal opens as.** It lists the VPS users that have administrator
   permission, but **you are the one who types the name** — even if there is only one. Type the user
   you created in Step 3. `root` is also accepted, but we don't recommend it: a forgotten
   browser tab left open would give root access to the VPS to whoever sat in front of it.
2. **How to run what needs root.** Answer **`1` (senha, i.e. password)** — it's the recommended one: when something
   needs administrator rights, the panel uses `sudo` inside the terminal and **you type your
   password there**, as you would over SSH. The other option, `2` (segundo-plano, i.e. background), doesn't ask for a password: those
   commands run as root behind the scenes, and you check them afterwards on the **Auditoria** (Audit) screen.

If the user won't do (doesn't exist, has no password, has no `sudo`…), the installer explains what
to do and asks again. Nothing is installed before you answer. The panel's port is chosen
by the installer itself: it is internal only, you will never type it.


<details>
<summary>🔑 <strong>Password or background? What happens in each, no fine print</strong></summary>

**`senha` (password) mode (recommended).** The terminal opens as your user. When a scan or a hardening
phase needs root, the panel runs the command with `sudo` in the terminal itself, and `sudo`
asks for your password — the same one from `adduser`. Nothing runs as administrator without you seeing and authorizing it.

- **The trade-off:** the password leaves your browser, passes through the panel and reaches the VPS terminal. It
  is not saved, logged or sent anywhere — the project is open source and this can be
  verified in the code. On the way between your browser and the VPS it goes **encrypted**: the
  panel is opened over HTTPS (or through the SSH tunnel, if you choose that access).
- **Requires** that the user has a password and is in the `sudo` group — which Step 3 already did.

**`segundo-plano` (background) mode.** The terminal also opens as your user, but the commands that need
root run **as root, behind the scenes**, through the same bridge the panel already uses to talk to the VPS. The
output shows up in the terminal just so you can follow along.

- **The trade-off:** it doesn't ask for a password, so you don't authorize command by command. The check
  comes afterwards: everything is recorded on the panel's **Auditoria** (Audit) screen.
- **Doesn't require `sudo`** — you can even use a user created just for the panel. The installer warns if
  the chosen user doesn't have `sudo`, because then, logging in over SSH with it, you can't do
  anything as administrator.

**In both modes**, the scheduled automatic monitoring — which runs by itself, with nobody to type a
password — keeps running as root in the background, and each run is recorded in the
Audit screen.

**Condition for both modes to really protect you:** the terminal user **must not be in the
`docker` group**. Anyone in that group becomes root without a password with a single command, so they would bypass
both the password prompt and the Audit. If the user is in it, the installer warns and offers to
remove them — see [Why the panel doesn't put you in the docker group](#grupo-docker).

**Installing through automation** (with nobody to answer)? Pass the choices directly:

```bash
./scripts/install.sh --terminal-user=YOUR_USER --root-mode=senha
```

Without these options, with `--force` or without an interactive terminal, the installer **doesn't guess**: it keeps the
old behavior (terminal as root) and warns. On a reinstall, what you chose the
first time is kept without asking again — to change it, see
[Changing the panel's terminal user](../guides/operations.md#trocar-terminal).

</details>

<a id="grupo-docker"></a>

> [!IMPORTANT]
> **Why the panel doesn't put you in the docker group.** Being in the `docker` group is the same as having
> root on the VPS **without typing a password**: any member can, with one command, open a container
> with the machine's entire disk. If the terminal user were in that group, a forgotten panel
> tab left open would once again give root to the VPS, and the `senha` and `segundo-plano` modes would protect
> nothing. That is why Docker commands take `sudo` in front (`sudo docker compose ps`).
>
> **Already in the group** (an old version of the installer put you there, and uninstalling the panel
> doesn't undo it)? When you run the installer, it asks whether to remove you — answer `s` (short for "sim", yes). To do it by hand:
>
> ```bash
> sudo gpasswd -d YOUR_USER docker
> ```
>
> Then leave the VPS (`exit`) and log in again over SSH: as with the `sudo` group, the change only applies in
> new sessions. Check with `groups` — `docker` must not appear in the list. In an installation with
> nobody to answer, the installer doesn't touch groups: it only warns prominently at the end.

<a id="acesso-por-tunel"></a>

<details>
<summary>🔐 <strong>Optional — access only through an SSH tunnel (the panel stays invisible on the internet)</strong></summary>

By default the panel opens at `https://YOUR-IP-WITH-HYPHENS.sslip.io`. If you prefer it to **have no
address at all on the internet** — only people with SSH to the VPS reach it —, install with:

```bash
./scripts/install.sh --acesso=tunel
```

In this mode the installer asks which VPS port the panel sits on and finishes by showing the SSH
tunnel command and the address `http://localhost:PORTA/?token=…` (`PORTA` means "port"). The browser will show "Not secure"
because it is `http://localhost` — and here that's fine: the traffic travels encrypted inside the SSH
tunnel. To switch modes later, run the installer again with `--acesso=https` or `--acesso=tunel`.
With the panel on HTTPS, Phase 02 also closes the SSH tunnel (it isn't used); when switching to
`--acesso=tunel`, the installer reopens the tunnel on its own.

<a id="porta-livre-no-seu-computador"></a>

> [!TIP]
> **Before installing: check, on YOUR computer, for a free port number.** In a moment the
> installer will ask which port the panel sits on in the VPS — and the access command it
> prints at the end opens the SSH tunnel using **the same number on both sides**
> (`ssh -L 9000:localhost:9000`). That is: **the number you choose here is the one that will be
> given to the installer**, and it must be free in both places. On the VPS, the installer itself checks and warns; **on your computer it has no way to see**, because it runs on the VPS.
> That is why this check is here, on your machine, before you start.
>
> Start by testing **9000** (the default). If it's taken, test **9100**, then **9200**, and
> so on — any high free number will do. Replace the `9000` in the command with the number
> you are testing.
>
> **Linux and WSL:**
>
> ```bash
> ss -ltnH 'sport = :9000'
> ```
>
> **macOS:**
>
> ```bash
> lsof -nP -iTCP:9000 -sTCP:LISTEN
> ```
>
> **Windows (PowerShell):**
>
> ```powershell
> Get-NetTCPConnection -State Listen -LocalPort 9000 -ErrorAction SilentlyContinue
> ```
>
> **How to read the result — applies to all three:**
>
> - **Nothing showed up** (the terminal just goes back to showing the prompt, with no line): the port
>   is **free**. That number is the one you give the installer in the next step.
> - **Some line showed up**: a program is already listening on that port on your computer. It
>   is **taken** — pick another number and run the command again.
>
> **Want to know which program is using it?** On Linux and WSL, add `-p`
> (`ss -ltnpH 'sport = :9000'`): without administrator rights it shows only your own programs, so
> use `sudo ss -ltnpH 'sport = :9000'` to see all of them. On macOS the same applies: `lsof` without `sudo`
> only sees your own programs — if the port seems free and the tunnel still complains,
> repeat with `sudo` in front. On Windows, the `OwningProcess` column is the process number;
> `Get-Process -Id <number>` tells you its name (open PowerShell as administrator if it
> refuses to report).
>
> You don't need to close anything or free up 9000: picking another number is simpler and doesn't break the
> program that was already there. Understand the [two ports of the tunnel](#duas-portas).

<a id="duas-portas"></a>

> [!TIP]
> **The tunnel has two ends, and they are different ports.** In the command
> `ssh -L 9000:localhost:9000 ...`, the two numbers look the same, but they are not the same thing:
>
> ```text
> ssh -L 9000 : localhost : 9000  YOUR_USER@YOUR_IP
>      ─┬──              ─┬──
>       │                 └── the VPS's port: where the panel listens. It's the one you chose
>       │                     at installation (default 9000), saved in .env.
>       └── YOUR COMPUTER's port: the tunnel's "mouth" on your machine. This is the one
>           you type in the browser, after localhost:.
> ```
>
> They **don't need to be equal**. Using the same number on both sides is just a habit that makes
> the command easy to read. If your computer's port is already taken by another program (it's
> common: `9000` is used by several development environments), **change only the number on the
> left** and open the browser on it:
>
> ```bash
> ssh -L 9100:localhost:9000 YOUR_USER@YOUR_IP
> # and in the browser: http://localhost:9100/?token=YOUR_TOKEN
> ```
>
> The installer has no way to guess what's taken on your computer — it runs on the VPS and
> only sees the VPS. That is why the left-hand port is always your choice, when you open the tunnel.
>
> To avoid finding this out only when the error hits, you can
> [check beforehand, on your computer, which port is free](#porta-livre-no-seu-computador) — and
> give that same number to the installer, so both sides match.

**Common errors when opening the tunnel:**

- **`bind [127.0.0.1]:9000: Address already in use`** (when opening the tunnel) — the port that's taken is
  **on your computer**, not the VPS's: the **left** number in `ssh -L`. One of your programs is already
  using 9000 (common for people who program). Change only that number and open the browser on it:
  `ssh -L 9100:localhost:9000 YOUR_USER@YOUR_IP`, then `http://localhost:9100/?token=...`.
  Any high free number will do — 9100, 9300, 12345. Understand the
  [two ports of the tunnel](#duas-portas). On the next installation, this error won't even show up if you
  [check beforehand which port is free on your computer](#porta-livre-no-seu-computador) and
  give that number to the installer.
- **"This site can't be reached"** in the browser, with the tunnel open — the address has the
  **wrong** number. What goes in the browser is always the **left** number of your `ssh -L`, which is
  your computer's port. If your tunnel is `ssh -L 9100:localhost:9001`, the address is
  `http://localhost:9100/?token=...` — `9001` is the VPS's port and never appears in the browser.
  Check which number your tunnel is listening on with `ss -ltnH 'sport = :9100'` (Linux/WSL).
- **`channel 2: open failed: connect failed: Connection refused`** (the tunnel opens, but the browser
  says it couldn't connect) — that's the other side: the **right** number doesn't match the port
  the panel is on in the VPS. Check with `sudo ./scripts/show-token.sh`, which prints the command
  already with the right port.

</details>

<a id="passo-8"></a>

## Step 8 — Open the panel

Open the panel at the `https://…sslip.io` address the installer showed at the end (it already
carries the **setup token** in the link; if you need it, the token also appears highlighted in the terminal) and follow
the wizard. The panel's interface is currently in Portuguese only, so the screen labels below are shown in Portuguese, with the English meaning in the list after the diagram:

```
┌─────────────────────────────────────────────────────────────┐
│  Assistente — https://YOUR-IP.sslip.io/?token=…              │
├─────────────────────────────────────────────────────────────┤
│  1. Boas-vindas      → valida o setup token e libera o      │
│                        terminal ao vivo do servidor         │
│  2. Saúde da máquina → CPU, RAM, disco, rede — os checks    │
│                        rodam AO VIVO no terminal embutido   │
│  3. Segurança        → scan Lynis → plano → hardening       │
│                        (com rollback automático em 5 min)   │
│  4. Conta admin      → usuário + senha forte do painel      │
└─────────────────────────────────────────────────────────────┘
```

- **Assistente** (Wizard)
- **1. Boas-vindas** (Welcome) — validates the setup token and unlocks the server's live terminal
- **2. Saúde da máquina** (Machine health) — CPU, RAM, disk, network; the checks run LIVE in the embedded terminal
- **3. Segurança** (Security) — Lynis scan → plan → hardening (with automatic rollback in 5 min)
- **4. Conta admin** (Admin account) — the panel's username + strong password

The **Segurança** (Security) step is the one that demands the most attention: it changes how you log in to the VPS. Before
applying the phases, read the [Security wizard](security-wizard.md).

The installer is **idempotent**: it can be run again without breaking anything (rebuild + restart).
The panel runs 100% in Docker (`docker compose up -d`), with state persisted in the
`paas_data` volume and access to the Docker socket to manage Caddy, Stalwart and your projects.

> [!TIP]
> **Lost the setup token?** Recover it at any time with `sudo ./scripts/show-token.sh` or
> `sudo docker exec tws-panel cat /data/setup-token`.

<details>
<summary>🎫 <strong>The installer's final banner — and how to recover the token later</strong></summary>

When the installation finishes, the terminal plays a "beep" and shows a banner like this. (It is real installer output, in Portuguese. It says "TWS PANEL INSTALLED AND RUNNING SUCCESSFULLY", tells you the next step is to open the panel in the browser at the link shown, explains that the connection is encrypted with HTTPS and that sslip.io only translates the name to the VPS IP, and shows the SETUP TOKEN box with two warnings: it appears highlighted ONLY NOW, so keep it until you finish the wizard, and it is invalidated after you create the admin account at the end of the wizard.)

```text
██████████████████████████████████████████████████████████████████████████████
██                                                                          ██
██               ✅  TWS PANEL INSTALADO E RODANDO COM SUCESSO!               ██
██                                                                          ██
██████████████████████████████████████████████████████████████████████████████

👉  PRÓXIMO PASSO: abra o painel no navegador

  Abra no navegador (de qualquer computador — não precisa de túnel nem de porta):

      https://203-0-113-10.sslip.io/?token=<seu-token-de-48-caracteres>

  A conexão é criptografada (HTTPS, certificado Let's Encrypt): a senha de
  administrador que você vai criar e a senha do sudo, se o terminal pedir,
  trafegam protegidas. O sslip.io só traduz o nome para o IP desta VPS — o
  tráfego vai direto do seu navegador para cá.

┌──────────────────────────────────────────────────────────────────────────┐
│                            ⚑  SETUP TOKEN  ⚑                              │
│                                                                          │
│   <seu-token-de-48-caracteres>                                            │
│                                                                          │
│   ⚠  Ele aparece SÓ AGORA em destaque. Guarde-o até concluir o wizard.   │
│   ⚠  Após criar a conta admin no fim do wizard, ele é invalidado.        │
└──────────────────────────────────────────────────────────────────────────┘
```

(`<seu-token-de-48-caracteres>` means "your 48-character token".)

**What to do:** copy the **full link** (`https://…sslip.io/?token=...`) and paste it into the browser.
It already carries the token embedded — you don't need to type anything. Installed with `--acesso=tunel`? The banner
shows, in its place, the tunnel command and the `http://localhost:…` address (see
[SSH tunnel access](#acesso-por-tunel)).

**Closed the terminal and lost the banner?** Don't panic. On the VPS, run either one:

```bash
sudo ./scripts/show-token.sh                       # shows the full link + token again
sudo docker exec tws-panel cat /data/setup-token   # shows only the token
```

**Common errors:**

- **The installer said the `https://…sslip.io` address didn't respond within 3 minutes** — the
  certificate wasn't issued. The most common cause is ports **80 and 443 blocked** by a provider
  firewall (in the hosting panel): open both and restart the panel with
  `sudo docker compose restart`. To see what the proxy says: `sudo docker logs paas-caddy --tail 50`.
  In the meantime, tunnel access works (the banner shows the command).
- **Errors when opening the tunnel** (only with tunnel access) — they are explained in
  [SSH tunnel access](#acesso-por-tunel).
- **`permission denied while trying to connect to the Docker daemon socket`** — you forgot `sudo`
  in front of the command. This is on purpose: the panel doesn't put anyone in the docker group (see
  [the reason](#grupo-docker)).
- **`setup token não encontrado...`** (Portuguese for "setup token not found...") — either `show-token.sh` was run on a machine without the panel
  (run it on the right VPS, from inside `/opt/tws-panel`), or the wizard was already completed and the token was
  deleted on purpose: to reopen it with a new token, `sudo ./scripts/reset-setup.sh`.
- **The token no longer works in the browser** — after you create the admin account (the last
  step of the wizard), the token is **invalidated forever**. From then on, access is through the login
  screen, with your panel username and password.

</details>

## After the wizard

On first access, the Dashboard shows the **Deixe o painel pronto** (Get the panel ready) checklist, with what is still left to
configure (protections, two-step verification, panel domain, email, notifications and
backups). The steps are in the [README](https://github.com/kelvindk9w/tws-panel/blob/main/README.md#after-installing).

To publish a project: register the project, point the DNS, and the panel takes care of the build, the proxy and
SSL. Production guide in [production.md](../guides/production.md). Everyday commands, the projects folder
and changing the terminal's port or user are in [Operation](../guides/operations.md).
