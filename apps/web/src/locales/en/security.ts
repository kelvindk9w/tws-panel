// Namespace "security" (en). Flat keys; plurals use _one/_other suffixes.
export default {
  // SecurityPage
  // Cloudflare proxy notice (EdgeNotice)
  "edge.title": "Cloudflare proxy detected on the panel",
  "edge.body": "The panel is receiving traffic through Cloudflare with the proxy turned on (orange cloud). The sign-in attempt limit then sees Cloudflare's IP instead of the visitor's and stops protecting you. Keep the panel's DNS record as DNS only (grey cloud).",
  "page.title": "Security",
  "page.subtitle": "VPS protections, baseline snapshot, monitoring and email reputation.",

  // Score scales
  "scale.lynis": "Lynis",
  "scale.internal": "internal index",

  // HardeningCard
  "score.title": "Security score",
  "score.refreshing": "updating…",
  "score.description": "This VPS's current score and how it has changed over time.",
  "score.loadError": "Couldn't load.",
  "score.loading": "Loading…",
  "score.source": "/100 · source: {source}",
  "score.summary": "{pass} items OK · {fail} with issues · last scan {date}",
  "score.evolution": "Progress: {a} → {b}{arrow}",
  "score.evolutionScales":
    "First scan: {a} ({scaleA}) · today: {b} ({scaleB}) — different scales",
  "score.badgeTitle": "{date} — {scale}",
  "score.internalNote": "* the panel's internal index (from before Lynis was on the VPS)",
  "score.openTerminal": "Open terminal",
  "score.apply": "Scan and apply protections",

  // BaselineCard
  "baseline.title": "Baseline snapshot",
  "baseline.description":
    "A record of this VPS's important packages, ports and files. Monitoring compares against it to warn you when something changes.",
  "baseline.loadError": "Couldn't load the baseline.",
  "baseline.createError": "Couldn't create the baseline.",
  "baseline.loading": "Loading…",
  "baseline.created": "Created on <b>{date}</b> ({target})",
  "baseline.packages_one": "{count} package",
  "baseline.packages_other": "{count} packages",
  "baseline.ports_one": "{count} port",
  "baseline.ports_other": "{count} ports",
  "baseline.files_one": "{count} tracked file",
  "baseline.files_other": "{count} tracked files",
  "baseline.empty":
    "There's no baseline snapshot yet. Create one after applying the protections so monitoring has something to compare against.",
  "baseline.update": "Update baseline snapshot",
  "baseline.create": "Create baseline snapshot",

  // MonitorCard
  "monitor.title": "Continuous monitoring",
  "monitor.schedulerOn": "scheduler running",
  "monitor.schedulerOff": "stopped",
  "monitor.description":
    "Automatic periodic scan: compares the VPS with the baseline snapshot and warns you when something changes.",
  "monitor.loadError": "Couldn't load monitoring.",
  "monitor.runError": "Couldn't run the scan.",
  "monitor.saveError": "Couldn't save the interval.",
  "monitor.intervalInvalid": "Enter a number of hours between 1 and {max} (one week).",
  "monitor.loading": "Loading…",
  "monitor.interval": "Interval (hours):",
  "monitor.intervalAria": "Interval (hours)",
  "monitor.save": "Save",
  "monitor.runNow": "Scan now",
  "monitor.lastRun": "Last scan: {date}",
  "monitor.lastRunDetail_one": "Last scan: {date} ({ms}ms, {count} alert)",
  "monitor.lastRunDetail_other": "Last scan: {date} ({ms}ms, {count} alerts)",
  "monitor.noDiff": "No differences from the baseline.",
  "monitor.diff.newPort": "+ port {proto}/{port}",
  "monitor.diff.closedPort": "- port {proto}/{port}",
  "monitor.diff.newPackage": "+ package {name}",
  "monitor.diff.removedPackage": "- package {name}",
  "monitor.diff.changedFile": "~ {file} (changed)",
  "monitor.diff.removedFile": "- {file} (removed)",
  "monitor.diff.addedFile": "+ {file} (new)",

  // BlacklistCard
  "blacklist.title": "Email reputation",
  "blacklist.description":
    "Checks whether your IP and email domains are on spam blocklists (Spamhaus, SpamCop, Barracuda).",
  "blacklist.error": "Couldn't check the blocklists.",
  "blacklist.status": "{label}: {status}",
  "blacklist.listed": "LISTED",
  "blacklist.clean": "clean",
  "blacklist.unknown": "unknown",
  "blacklist.removal": "Removal:",
  "blacklist.checkedAt": "Checked on {date}",
  "blacklist.check": "Check now",
} as const;
