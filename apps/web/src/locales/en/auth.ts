// Namespace "auth" (en). Chaves planas; plural com sufixos _one/_other.
export default {
  // LoginPage
  "login.subtitle": "Sign in with the administrator account created during setup.",
  "login.username": "Username",
  "login.password": "Password",
  "login.code": "Verification code",
  "login.codeHelp": "Open the authenticator app on your phone and enter the 6-digit code for TWS Panel. No phone at hand? Use one of your recovery codes.",
  "login.failed": "Could not sign in. Please try again.",
  "login.codeWrong_one": "Wrong code. {count} attempt left before the app code is locked for {time}.",
  "login.codeWrong_other": "Wrong code. {count} attempts left before the app code is locked for {time}.",
  "login.codeWrongIp_one": "Wrong code. {count} attempt left before a temporary lock of {time}.",
  "login.codeWrongIp_other": "Wrong code. {count} attempts left before a temporary lock of {time}.",
  "login.lockedBoth": "Two-step verification and sign-in from this address are temporarily locked after too many attempts. Wait or try from another place.",
  "login.accountNear_one": "The app code is also close to locking: {count} attempt left before it locks for {time} (errors refused by the IP lock count too).",
  "login.accountNear_other": "The app code is also close to locking: {count} attempts left before it locks for {time} (errors refused by the IP lock count too).",
  "login.retryIn": "Try again in {time}.",
  "login.submit": "Sign in",
  "login.submitting": "Signing in…",
} as const;
