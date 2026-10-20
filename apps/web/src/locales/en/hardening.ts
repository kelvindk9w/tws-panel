// Namespace "hardening" (en). Flat keys; plurals use _one/_other suffixes.
export default {
  // IndexGauge
  "gauge.sourceShort.lynis": "Lynis",
  "gauge.sourceShort.internal": "Internal",
  "gauge.sourceLong.lynis": "Lynis Index",
  "gauge.sourceLong.internal": "Internal index",
  "gauge.aria": "Security index: {value} out of 100 (source: {source})",

  // SshKeyGuide
  "sshGuide.toggle": "Never used an SSH key? Learn how to create one in 2 minutes.",
  "sshGuide.whatIs":
    "<b>What it is:</b> a pair of cryptographic keys. The <b>private key</b> stays on YOUR computer (never leave it or share it) and the <b>public key</b> is installed on the server — that's the one you paste here.",
  "sshGuide.purpose":
    "<b>What it's for:</b> it's how you'll sign in to the VPS over SSH <b>after root access is disabled</b> by hardening. Until it's installed, the panel will NOT lock root (anti-lockout protection).",
  "sshGuide.windows.title": "🪟 Windows (PowerShell)",
  "sshGuide.windows.step1":
    "Open <b>PowerShell</b> and generate the key pair (press Enter to accept the default location; a passphrase is optional but recommended):",
  "sshGuide.windows.step2": "Show the public key so you can copy it (it lives at <code>{path}</code>):",
  "sshGuide.windows.step3": "Copy the whole line it prints (it starts with ssh-ed25519) and paste it in the field below.",
  "sshGuide.unix.title": "🐧 Linux / 🍎 macOS (Terminal)",
  "sshGuide.unix.step1":
    "Open <b>Terminal</b> and generate the key pair (press Enter to accept the default location; a passphrase is optional but recommended):",
  "sshGuide.unix.step2": "Show the public key so you can copy it (it lives at <code>{path}</code>):",
  "sshGuide.unix.step3":
    "Copy the whole line it prints (it starts with ssh-ed25519) and paste it in the field below. On a Mac, you can copy it straight to the clipboard with <code>{command}</code>.",
  "sshGuide.alreadyHave":
    "💡 <b>Already have a key?</b> If the command above prints a line that starts with ssh-ed25519 or ssh-rsa, you don't need another one — use the one you have.",

  // ManualPhaseModal
  "manual.aria": "Manual run — {title}",
  "manual.heading": "Run manually — {title}",
  "manual.intro":
    "Run the commands below on the server, in order (over SSH or in the panel's built-in terminal). Then click <b>I ran them — check again</b> so the panel can validate the phase.",
  "manual.closeAria": "Close window",
  "manual.satisfied": "✅ This phase already shows as complete in the latest check.",
  "manual.loading": "Loading the step-by-step guide…",
  "manual.stepsLabel": "Step by step — exact commands (copy and run them one at a time):",
  "manual.note": "ℹ️ {note}",
  "manual.script": "View the full phase script ({script})",
  "manual.close": "Close",
  "manual.rescan": "I ran them — check again",
  "manual.confirmed": "✅ confirmed in the latest check",

  // AccessTestAlert
  "access.changed.01": "The root password has been disabled. Make sure you can still sign in as {who}.",
  "access.changed.02": "SSH now accepts only key-based sign-in, and only for {who}. Make sure you can still sign in.",
  "access.changed.other": "The firewall is on. Make sure you can still sign in.",
  "access.whoDefault": "your user",
  "access.title": "Test your access now — Phase {phase} ({phaseTitle})",
  "access.step1": "Open the <b>terminal on your own computer</b> (not the browser) and keep this page open.",
  "access.step2.run": "Run:",
  "access.step2.fallback": "ssh YOUR_USER@{host} (replace with the user you created)",
  "access.step2.placeholder": "Replace {placeholder} with your VPS's IP address — the same one you use to connect over SSH.",
  "access.step3":
    "Do you see <code>{user}@…$</code>? It worked: type <code>exit</code> and click <b>I'm in — confirm</b>.",
  "access.userFallback": "your-user",
  "access.why": "Why test now: if it fails, we undo only this phase — not all the work done so far.",
  "access.expired":
    "Time ran out without a confirmation: the server is undoing this phase. The result will appear here in a moment.",
  "access.countdown": "With no answer, this phase undoes itself in <timer>{time}</timer>.",
  "access.confirm": "✅ I'm in — confirm",
  "access.undo": "I couldn't sign in — undo now",
  "access.details": "More details",
  "access.details.why":
    "<b>Why test after every phase:</b> phases 01, 02 and 03 change how you sign in to the VPS — the root password, SSH and the firewall. Testing one at a time means that if something goes wrong, only that phase is undone and you know exactly which one it was.",
  "access.details.where":
    "<b>Where to find the terminal:</b> on Windows, PowerShell (Start menu → type \"PowerShell\"); on a Mac, Terminal (Spotlight → \"Terminal\"); on Linux, Terminal. It's the same one you used to connect to the VPS at the start.",
  "access.details.password":
    "<b>Asked for a password?</b> If it says \"Enter passphrase for key\", that's the passphrase of the SSH key you created on your computer — not the server password.",
  "access.details.keyName":
    "<b>Does your key have a different name?</b> Add <code>-i ~/.ssh/NAME</code> to the command.",
  "access.details.failed":
    "<b>Couldn't sign in:</b> click \"undo now\". This phase goes back to how it was, the next ones don't run, and you can try again once you've sorted out the access.",

  // Phase01Card
  "phase01.title": "Phase 01 — disable the root password",
  "phase01.description":
    "After this phase, nobody can sign in as root with a password. You sign in with your SSH key and administer with your own user and its password.",
  "phase01.userLabel": "Non-root user created during installation",
  "phase01.userInvalid": "Invalid name (lowercase, no spaces, never root).",
  "phase01.userFromConfig":
    "⚙️ Name from the <b>installation settings</b>. If that's not right, just edit it.",
  "phase01.userDetected": "🔎 Name <b>detected on the server</b>. If that's not right, just edit it.",
  "phase01.userNotDetected":
    "The check <b>did not find</b> <bm>{user}</bm> with sudo on this server. Check the name and, if needed, run as root: <code>usermod -aG sudo {user}</code>",
  "phase01.userMany": "We found <b>{n} users</b> with sudo on the server. Which one did you create during installation?",
  "phase01.userHint": "The name you created when following the README (e.g. deploy).",
  "phase01.whoDefault": "your user",
  "phase01.unchecked":
    "We couldn't check {who} in this scan. The simulation shows, before any change, whether the root password will be disabled.",
  "phase01.hasPassword": "{user} has a password",
  "phase01.noPassword": "{user} has no password",
  "phase01.keys_one": "{count} SSH key installed",
  "phase01.keys_other": "{count} SSH keys installed",
  "phase01.keysPasted": " (including the one you pasted)",
  "phase01.noKeys": "no SSH key installed",
  "phase01.resultLocked": "Result: the root password will be disabled.",
  "phase01.resultNoPassword":
    "Result: the root password will not be disabled — without a password, {user} would be left without sudo. To fix it, run <code>sudo passwd {user}</code> in the terminal below and click “Check again”.",
  "phase01.resultNoKey":
    "Result: the root password will not be disabled and nothing changes — you keep signing in with the password. To turn on the protection, install your key below.",
  "phase01.keyToggleMissing": "Install my SSH key",
  "phase01.keyToggleOptional": "Add an SSH key (optional)",
  "phase01.keyHelp":
    "Paste the contents of the <code>.pub</code> file from your computer — the phase installs the key on the server for you. If your key is already on the server, leave this blank.",
  "phase01.keyPublic":
    "<b>The public key is not a secret</b> — it's meant to be shared. Never paste the <b>private key</b> (the file without <code>.pub</code>).",
  "phase01.keyLabel": "SSH public key (contents of the .pub file) — optional",
  "phase01.keyPlaceholder": "ssh-ed25519 AAAAC3NzaC… you@your-machine",
  "phase01.keyInvalid":
    "Unrecognized format — paste the full contents of the .pub file (a single line that starts with ssh-ed25519 or ssh-rsa).",
  "phase01.keyValid": "Your key looks valid ✅",
  "phase01.detailsToggle": "Details and emergency",
  "phase01.details.apply":
    "When you apply, open a <b>new SSH window</b> (keep the current one open) and test the sign-in before confirming. If you don't confirm within 5 minutes, the change undoes itself.",
  "phase01.details.lostKey":
    "Lost your key? Sign in through your <b>hosting provider's console</b> (VNC, in the provider's dashboard) as <bm>{who}</bm> with its password — the root password no longer works there.",
  "phase01.details.dontConfuse":
    "<b>Don't mix them up:</b> the SSH key is how you <b>sign in</b> to the VPS over SSH; the sudo password is what <b>authorizes</b> administrative commands. To disable the root password without locking you out, the phase requires at least one installed key and the password of {who}.",
  "phase01.details.insecure":
    "This page is not encrypted (http outside the SSH tunnel). Pasting the public key leaks nothing useful, but someone on the path could <b>tamper</b> with the traffic — prefer the SSH tunnel.",

  // Phase titles (SECURITY_PHASES, from @paas/core)
  "phaseTitle.00": "System updates",
  "phaseTitle.01": "Non-root user",
  "phaseTitle.02": "SSH hardening",
  "phaseTitle.03": "Firewall (UFW)",
  "phaseTitle.04": "Intrusion prevention",
  "phaseTitle.05": "Package minimization",
  "phaseTitle.06": "Auditing and detection",
  "phaseTitle.07": "Additional hardening",
  "phaseLabel": "Phase {id} — {title}",

  // SecurityStep: states, badges and icons
  "phaseRun.pending": "waiting",
  "phaseRun.running": "running",
  "phaseRun.done": "complete",
  "phaseRun.error": "error",
  "phaseRun.skipped": "skipped",
  "severity.critical": "critical",
  "severity.warning": "warning",
  "severity.info": "info",
  "jobStatus.running": "running…",
  "jobStatus.awaiting": "waiting for confirmation",
  "jobStatus.success": "done",
  "jobStatus.failed": "failed",
  "jobStatus.rolledBack": "rolled back",
  "scale.lynis": "Lynis",
  "scale.internal": "the panel's internal index",

  // SecurityStep: header and errors
  "header.backPage": "Back to Security",
  "header.backWizard": "Back to Server health",
  "header.title": "Security",
  "header.subtitle":
    "VPS scan, remediation plan and phased protections — with simulation, backup and automatic rollback.",
  "error.scan": "Couldn't run the scan.",
  "error.plan": "Couldn't build the plan.",
  "error.manualLoad": "Couldn't load the manual commands.",
  "error.rescan": "Couldn't check again.",
  "error.apply": "Couldn't apply the phase.",
  "error.undo": "Couldn't undo the phase.",
  "error.confirm": "Couldn't confirm access.",
  "error.confirmRetry": "{message} Try confirming again.",
  "error.confirmNetwork":
    "Couldn't confirm access right now (connection failed). Try again — the phase is still waiting.",
  "error.nothingPending": "No phases with pending items — the server is already hardened.",
  "error.undone":
    "You undid the \"{title}\" phase: the previous configuration was restored. Once the access issue is sorted out, run hardening again.",
  "error.expired":
    "The time for the \"{title}\" phase ran out without a confirmation, so it was undone automatically: the previous configuration is back. Run it again when you can test access.",
  "error.failed": "The \"{title}\" phase failed. The rollback ran — check the log.",
  "elevation.scan": "The scan didn't run: sudo didn't authorize it",
  "elevation.phase": "The \"{title}\" phase stopped: sudo didn't run the script",
  "elevation.hint": "The password is requested in the live terminal below when the command starts.",
  "elevation.retry": "Retry the scan",

  // SecurityStep: scan
  "scan.title": "Security scan",
  "scan.description":
    "Checks SSH, firewall, ports, packages and Docker, and runs Lynis, the security auditing tool. If Lynis isn't on the VPS yet, it's installed from the official Ubuntu repository — the only thing the scan changes. Takes 2 to 5 minutes.",
  "scan.start": "Start scan",
  "scan.running": "Scanning the VPS… (Lynis takes 2 to 5 minutes)",
  "scan.ok": "✅ ok",
  "scan.warning": "⚠️ warning",
  "scan.critical": "❌ critical",
  "scan.target": "target: {target}",
  "scan.profile": "profile: {profile}",
  "scan.total": "{total} checks in {seconds}s",
  "scan.noLynis": "(Lynis not found — internal index)",
  "scan.skipped_one": "{count} check skipped for this profile",
  "scan.skipped_other": "{count} checks skipped for this profile",
  "scan.phaseAllOk": "all ok",
  "scan.phasePending_one": "{count} pending",
  "scan.phasePending_other": "{count} pending",
  "scan.again": "Check again",
  "scan.buildPlan": "Build remediation plan",

  // SecurityStep: plan
  "plan.title": "Remediation plan",
  "plan.description_one":
    "{count} phase with pending items. Run <b>one phase at a time</b> (button on each phase) or all of them in sequence (button below) — everything runs as a dry run first; if one fails, execution stops and the rollback is applied. Prefer to run it yourself? Use <b>Run manually</b> to see a copyable step-by-step guide.",
  "plan.description_other":
    "{count} phases with pending items. Run <b>one phase at a time</b> (button on each phase) or all of them in sequence (button below) — everything runs as a dry run first; if one fails, execution stops and the rollback is applied. Prefer to run it yourself? Use <b>Run manually</b> to see a copyable step-by-step guide.",
  "plan.satisfied": "already ok",
  "plan.fixes_one": "{count} fix",
  "plan.fixes_other": "{count} fixes",
  "plan.rollback": "with rollback",
  "plan.alreadyApplied":
    "This phase was already applied successfully on {date}, but the item below is still failing — applying it again probably won't help. Something on the server is undoing or overriding the fix:",
  "plan.phase01Hint":
    "Enter the non-root user created during installation below to enable this phase (the SSH key is optional).",
  "plan.dryRunHint":
    "It starts with a <b>simulation</b> (dry run) of this phase only, in the terminal below: nothing is changed on the server. In password mode, sudo will ask for your password. If the simulation passes, a button appears to apply it for real.",
  "plan.manual": "Run manually",
  "plan.runOne": "Run only this phase",
  "plan.backToReport": "Back to the report",
  "plan.simulateAll": "Simulate all pending phases (dry run)",
  "plan.dryRunSummary": "<b>Nothing is changed on the server</b> — it's only a simulation.",
  "plan.dryRunHelp": "What does this do?",
  "plan.dryRunExplain":
    "Runs the <b>simulation</b> of all pending phases, in order. <b>Nothing is changed on the server</b> — you can follow everything in the terminal below. In password mode, sudo will ask for your password in the terminal. If the simulation passes, a button then appears to apply it for real.",
  "plan.invalidForm":
    "Enter the user created during installation to run Phase 01 — the SSH public key is optional, but if you paste one it must be in a valid format (or use \"Run manually\" on the phase).",

  // SecurityStep: run
  "run.titleDry": "Dry run (simulation)",
  "run.titleReal": "Applying hardening",
  "run.stoppedAt": "Stopped at Phase {id} — {title}",
  "run.progress": "Phase {current} of {total}",
  "run.progressJob": "Phase {current} of {total} — {title}",
  "run.pending": "waiting",
  "run.skipped": "skipped (manual mode)",
  "run.liveLog": "Live log — {title}",
  "run.noOutput": "(no output yet)",
  "run.failedDry": "The simulation stopped at Phase {id} — {title}",
  "run.failedReal": "The run stopped at Phase {id} — {title}",
  "run.failedDryNote": "Nothing was changed on the server — it was a simulation. The remaining phases didn't run.",
  "run.failedRealNote": "The remaining phases didn't run. The phase log (above, if any) shows what happened.",
  "run.retryDry": "Retry the simulation",
  "run.backToPlan": "Back to the plan",
  "run.dryDone": "Simulation finished without errors — nothing was changed on the server.",
  "run.dryDoneBody_one":
    "The simulation went through the phase above without touching anything. When you click <b>Apply for real</b>, the same steps run <b>and change the server</b>: every modified file is backed up first, and the SSH/firewall phases run with a 5-minute automatic rollback, undoing themselves if you don't confirm you can still reach the server.",
  "run.dryDoneBody_other":
    "The simulation went through the {count} phases above, in order, without touching anything. When you click <b>Apply for real</b>, the same steps run <b>and change the server</b>: every modified file is backed up first, and the SSH/firewall phases run with a 5-minute automatic rollback, undoing themselves if you don't confirm you can still reach the server.",
  "run.realWarning": "The VPS is about to be changed for real.",
  "run.applyReal": "Apply for real",

  // SecurityStep: result
  "done.title": "Protections applied",
  "done.subtitle": "How the VPS arrived and how it looks today.",
  "done.first": "When the VPS arrived",
  "done.today": "Today",
  "done.waiting": "Full Lynis audit in progress — takes 2 to 5 minutes.",
  "done.scales":
    "The two scores use different scales ({first} and {today}) — so we don't show the difference in points. On new installations, the first scan already uses Lynis.",
  "done.lastApply_one": "Last run: {before} → {after} ({scale}), {delta} point",
  "done.lastApply_other": "Last run: {before} → {after} ({scale}), {delta} points",
  "done.lastApplyScales": "Last run: {before} → {after} ({scaleBefore} → {scaleAfter})",
  "done.drift":
    "The score was {after} right after the last run and is {today} today. The score changes over time: new security updates that aren't installed yet and a pending reboot cost points until they're applied. See the full report to find out what changed.",
  "done.deltaUp_one": "+{delta} point on the index",
  "done.deltaUp_other": "+{delta} points on the index",
  "done.deltaSame": "index unchanged — fixes applied",
  "done.deltaDown_one": "{delta} point — review the report",
  "done.deltaDown_other": "{delta} points — review the report",
  "done.remaining": "⚠️ Still failing (critical):",
  "done.verifyAgain": "Check again",
  "done.fullReport": "View full report",
  "done.backToSecurity": "Back to Security",
  "done.continue": "Continue",
} as const;
