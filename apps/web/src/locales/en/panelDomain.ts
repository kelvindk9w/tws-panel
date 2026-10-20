// Namespace "panelDomain" (en). Flat keys; plurals use _one/_other suffixes.
export default {
  // Command / Field
  "command.copyAria": "Copy the command",
  "field.copyAria": "Copy {label}",

  // Loading and errors
  "load.error": "Couldn't load the panel domain. Reload the page.",
  "error.save": "Couldn't save the domain.",
  "error.verify": "Couldn't check the DNS.",
  "error.remove": "Couldn't remove the domain.",
  "error.disableIp": "Couldn't turn off IP access.",
  "error.enableIp": "Couldn't turn IP access back on.",
  "error.refresh": "Couldn't check again.",

  // Tunnel mode
  "tunnel.title": "Panel domain",
  "tunnel.intro": "This panel was installed in <b>SSH tunnel</b> mode: it only opens through the tunnel, on your computer, and has no address on the internet. That's why there is no domain to set up, and no IP shows up in any address.",
  "tunnel.switch": "To open the panel at an internet address (with HTTPS) and then use your own domain, switch the access mode to HTTPS by running this on the VPS over SSH:",
  "tunnel.note": "The installer keeps your users, projects and settings; it only starts serving the panel at https://{host}.sslip.io on ports 80 and 443. After that, come back to this screen.",
  "tunnel.hostPlaceholder": "ip-with-dashes",

  // Panel address
  "addresses.title": "Panel address",
  "addresses.description": "Where the panel opens today. The automatic address has the VPS IP in its name: with your own domain it looks cleaner and is easier to remember.",
  "addresses.badgeIp": "via IP",
  "addresses.badgeDomain": "your domain",
  "addresses.badgeCurrent": "this page",
  "addresses.ipDisabled": "The address https://{ip} is turned off: the panel no longer responds there.",

  // Your domain
  "domain.title": "Your domain",
  "domain.description": "Use a subdomain just for the panel, such as panel.example.com.",
  "domain.label": "Panel domain",
  "domain.placeholder": "panel.example.com",
  "domain.changeWarning": "When you switch, IP access comes back (https://{ip}) until the new domain is ready. You'll need to sign in again there.",
  "domain.save": "Save domain",
  "domain.cancel": "Cancel",
  "domain.badgeActive": "DNS verified",
  "domain.badgePending": "waiting for DNS",
  "domain.createRecord": "At your DNS provider, create this record:",
  "domain.recordType": "Type",
  "domain.recordName": "Name",
  "domain.recordValue": "Value (VPS IP)",
  "domain.recordValueFallback": "VPS IP",
  "domain.cloudflareNote": "On Cloudflare, keep the cloud gray (“DNS only”): with the orange cloud the certificate can't be issued. If there is an AAAA record with this name, delete it. Propagation usually takes from a few minutes to a few hours.",
  "domain.verify": "Check DNS",
  "domain.change": "Change domain",
  "domain.remove": "Remove domain",
  "domain.removeConfirm": "The panel stops responding at https://{domain} and opens only at https://{ip}{extra}. If you're on this page through the domain, you'll need to sign in again at the IP address.",
  "domain.removeConfirmReactivated": " (IP access is turned back on)",
  "domain.removeCancel": "Cancel",
  "domain.removeYes": "Yes, remove",

  // HTTPS certificate
  "certificate.title": "HTTPS certificate",
  "certificate.description": "Issued automatically by Let's Encrypt as soon as the domain is added to the proxy. It usually takes from a few seconds to 2 minutes.",
  "certificate.unknown": "Couldn't check the certificate yet. Click “Check again”.",
  "certificate.refresh": "Check again",
  "certificate.openNew": "Open the panel at the new address",
  "certificate.openNewNote": "You'll need to sign in again there (username, password and code): the session only works at the address where you signed in. This address keeps working.",

  // IP access
  "ip.title": "IP access",
  "ip.description": "The address https://{ip} shows the VPS IP. Once the new domain works, you can turn it off.",
  "ip.disabledInfo": "IP access is turned off: the panel responds only at https://{domain}.",
  "ip.enable": "Turn IP access back on",
  "ip.disable": "Turn off IP access",
  "ip.blockerDefault": "Open the panel at the new address (https://{domain}) to enable the button.",
  "ip.blockerDefaultDomain": "your domain",
  "ip.disableConfirm": "The panel will respond <b>only</b> at https://{domain}. The address https://{ip} will stop opening. If the domain ever stops working (DNS deleted, domain expired), turn it back on over SSH on the VPS with:",
  "ip.typeToConfirm": "Type {domain} to confirm",
  "ip.cancel": "Cancel",
  "ip.disableNow": "Turn off now",
  "ip.lostAccess": "If you lose access through the domain",
  "ip.lostAccessHelp": "Connect to the VPS over SSH and run the command below: it turns the IP address back on.",
  "ip.configNote": "Your choice is saved in {file} and also holds after the panel or the VPS restarts.",
} as const;
