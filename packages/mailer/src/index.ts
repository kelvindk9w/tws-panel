/**
 * @paas/mailer — engine de e-mail do painel (Fase 3).
 * Stalwart Mail Server em container, DKIM 2048, checklist DNS, caixas de
 * e-mail e injeção de SMTP nos projetos. Spec: docs/email-deliverability.md.
 */
export {
  StalwartManager,
  renderConfigToml,
  stalwartConfigFingerprint,
  STALWART_IMAGE,
  type StalwartCertificate,
  type StalwartManagerOptions,
  type RenderConfigOptions,
} from "./server.js";
export {
  CADDY_CERTIFICATES_DIR,
  certificateId,
  mailHostFor,
  pickNewest,
  readCaddyCertificate,
  validateCertificatePair,
  inspectCertificatePair,
  type CertificatePairInspection,
  type CertificatePairProblem,
  type InspectedCertificate,
  type MailCertificate,
} from "./tls-certificates.js";
export {
  assessExistingMail,
  checkExistingMail,
  suggestedSendingDomain,
  type ExistingMailAssessment,
  type ExistingMailStatus,
} from "./mx-guard.js";
export { StalwartClient, StalwartApiError } from "./client.js";
export {
  buildDnsChecklist,
  verifyDnsRecords,
  publicResolver,
  systemResolver,
  PUBLIC_DNS_OPTIONS,
  PUBLIC_DNS_SERVERS,
  ptrTicketText,
  ptrIsOk,
  detectPtrProvider,
  spfValue,
  dmarcValue,
  stageSuggestion,
  type ChecklistInput,
  type DnsResolverLike,
  type VerifyResult,
  type VerifyOptions,
} from "./dns-checklist.js";
export {
  sendSmtpMail,
  buildTestMessage,
  formatFromHeader,
  isSingleEmailAddress,
  xtext,
  SmtpSendError,
  type SmtpSendOptions,
  type SmtpSendResult,
  type SmtpConnectOptions,
} from "./smtp-send.js";
export {
  cleanSmtpResponse,
  deliveryFromQueue,
  findDeliveryReport,
  interpretDeliveryReport,
  type DeliveryInfo,
  type FindDeliveryReportOptions,
  type QueueStatus,
  type QueuedDomain,
  type QueuedMessage,
  type QueuedRecipient,
} from "./delivery-status.js";
export {
  generatePassword,
  generateStrongPassword,
  STRONG_PASSWORD_SPECIALS,
  buildCredentials,
  type CredentialsInput,
} from "./mailboxes.js";
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
  ROUNDCUBE_IMAGE,
  WEBMAIL_CONFIG_DIR,
  WEBMAIL_CONFIG_FILE,
  WEBMAIL_DATA_DIR,
  WebmailManager,
  generateDesKey,
  parseFailedLogins,
  phpString,
  renderRoundcubeConfig,
  type FailedLogin,
  type RoundcubeConfigInput,
  type WebmailManagerOptions,
} from "./webmail.js";
export {
  buildSmtpEnv,
  maskEnv,
  projectMailboxAddress,
  STALWART_NETWORK_ALIAS,
  STALWART_INTERNAL_SMTP_PORT,
  type SmtpEnvInput,
} from "./smtp-inject.js";
