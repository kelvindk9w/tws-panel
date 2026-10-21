// Namespace "shell" (en). Chaves planas; plural com sufixos _one/_other.
export default {
  // Layout / navegação
  "nav.dashboard": "Dashboard",
  "nav.newProject": "New project",
  "nav.mail": "Email",
  "nav.sending": "Sending",
  "nav.certificates": "Certificates",
  "nav.security": "Security",
  "nav.alerts": "Alerts",
  "nav.audit": "Audit log",
  "nav.settings": "Settings",
  "nav.setup": "Setup",
  "nav.menu": "Menu",
  "nav.settingsMenu": "Settings submenu",
  "nav.label": "Main",
  "footer.poweredBy": "Powered by",
  "footer.license": "open source (MIT)",
  // UpdateBanner
  "update.message": "A new version of the panel was installed. Reload to use the current version.",
  "update.reload": "Reload",
  // RequireAuth
  "session.checking": "Checking session…",
  // UserMenu
  "userMenu.account": "Account: {name}",
  "userMenu.settings": "Settings",
  "userMenu.changePassword": "Change password",
  "userMenu.twoFactor": "Two-step verification",
  "userMenu.stillSignedIn": "You are still signed in.",
  "userMenu.logoutUnconfirmed": "The server did not confirm the sign-out: {detail}",
  "userMenu.retryLogout": "Try signing out again",
  "userMenu.signingOut": "Signing out…",
  "userMenu.signOut": "Sign out",
  "userMenu.unexpectedError": "Unexpected error while talking to the server.",
  "userMenu.language": "Language",
  // HelpMenu (Help and feedback)
  "help.button": "Help and feedback",
  "help.docs": "Guide and documentation",
  "help.site": "Help and feedback page",
  "help.discussions": "Ask a question or share an idea",
  "help.bug": "Report a problem",
  "help.feature": "Suggest a feature",
  "help.newTab": "(opens in a new tab)",
  "help.logsWarning": "Don't paste logs without reviewing them: they may contain domains, IPs and tokens.",
  "help.version": "TWS Panel v{version}",
  // TwoFactorNudge
  "twoFactorNudge.text": "The panel is on the internet and protected only by your password. Turn on <b>two-step verification</b>: signing in will then also require a code from your phone.",
  "twoFactorNudge.cta": "Turn on now",
} as const;
