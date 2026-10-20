// Namespace "timezone" (en). Flat keys; plurals use _one/_other suffixes.
export default {
  // TimezonePicker
  "picker.ariaLabel": "Time zone",
  "picker.placeholder": "Search by city or time zone name",
  "picker.optionWithPlace": "{zone} — Brazil: {place}",

  // TimezoneSettings (helpers)
  "setting.host": "Same as the VPS",
  "setting.image": "Image default",
  "source.env": "The file /opt/tws-panel/.env sets TZ={zone}. It takes priority for the panel: after a panel restart, that time zone applies again. To make the panel follow the VPS, delete the TZ line from that file.",
  "source.saved": "Last time zone read from the VPS (it couldn't be read again just now).",
  "source.localtime": "Read from the VPS /etc/localtime mounted in the container. If you changed the time zone over SSH, this may be out of date.",
  "source.default": "Couldn't detect the VPS time zone; the panel uses UTC.",

  // ProjectRestartResults
  "restart.failed": ": didn't restart — {error}",
  "restart.running": ": restarting with the new time zone. <link>Follow it in Deploys</link>.",

  // TimezoneSettings
  "error.generic": "Couldn't complete that right now. Try again in a moment.",
  "loading": "Loading…",
  "applied": "The VPS is now on {zone}. The panel and the backup schedule already use this time zone.",
  "card.title": "Time zone",
  "card.description": "The VPS time zone sets the backup time (03:00) and the dates in logs. Changing it here changes the whole VPS, no SSH needed.",
  "current": "The VPS is on <b>{zone}</b>. It's <clock>{time}</clock> there now.",
  "panelUsing": "The panel is using {zone}.",
  "newZone": "New time zone",
  "newZoneHint": "Brazilian ones come first. Search by city or state.",
  "projects.legend": "Also apply to these projects",
  "projects.help": "Checked projects switch to “Same as the VPS” and restart with the new time zone (without pulling new code). The others keep their current time zone.",
  "projects.markAll": "Select all",
  "projects.markNone": "None",
  "projects.today": "— today: {setting}",
  "projects.following_one": "{names} follows the VPS time zone, but only picks up the new one after a restart or redeploy.",
  "projects.following_other": "{names} follow the VPS time zone, but only pick up the new one after a restart or redeploy.",
  "apply": "Apply to the VPS",
  "applying": "Applying…",
} as const;
