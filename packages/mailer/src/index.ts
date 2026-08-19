/**
 * @paas/mailer — engine de e-mail do painel (Fase 3).
 * Stalwart Mail Server em container, DKIM 2048, checklist DNS, caixas de
 * e-mail e injeção de SMTP nos projetos. Spec: docs/email-deliverability.md.
 */
export { StalwartManager, renderConfigToml, STALWART_IMAGE, type StalwartManagerOptions } from "./server.js";
export { StalwartClient, StalwartApiError } from "./client.js";
export {
  buildDnsChecklist,
  verifyDnsRecords,
  publicResolver,
  ptrTicketText,
  spfValue,
  dmarcValue,
  stageSuggestion,
  type ChecklistInput,
  type DnsResolverLike,
  type VerifyResult,
} from "./dns-checklist.js";
export { generatePassword, buildCredentials, type CredentialsInput } from "./mailboxes.js";
export {
  checkIpBlacklists,
  checkDomainBlacklists,
  reversedIpv4,
  defaultBlacklistResolver,
  IP_DNSBLS,
  DOMAIN_DNSBLS,
  type BlacklistResolverLike,
  type DnsblDefinition,
} from "./blacklist.js";
export {
  buildSmtpEnv,
  maskEnv,
  projectMailboxAddress,
  STALWART_NETWORK_ALIAS,
  STALWART_INTERNAL_SMTP_PORT,
  type SmtpEnvInput,
} from "./smtp-inject.js";
