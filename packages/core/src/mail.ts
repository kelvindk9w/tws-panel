/**
 * Tipos compartilhados do módulo de e-mail (Fase 3 — E-mail).
 * Spec: plano §5.3 e docs/email-deliverability.md.
 */

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Nome do container do Stalwart Mail gerenciado pelo painel. */
export const PAAS_STALWART_CONTAINER = "paas-stalwart";

/** Volume Docker persistente dos dados do Stalwart. */
export const PAAS_STALWART_VOLUME = "paas_stalwart_data";

/** Seletor DKIM usado em todos os domínios provisionados pelo painel. */
export const DKIM_SELECTOR = "paas";

/** Portas padrão do servidor de e-mail (produção). Em dev, sobrescrever via env. */
export const MAIL_DEFAULT_PORTS = {
  smtp: 25,
  submission: 587,
  submissions: 465,
  imap: 143,
  imaps: 993,
  http: 8080,
} as const;

/** Env vars injetadas nos projetos com e-mail habilitado (plano §5.3). */
export const SMTP_ENV_KEYS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "MAIL_FROM"] as const;

// ---------------------------------------------------------------------------
// Servidor Stalwart
// ---------------------------------------------------------------------------

export interface MailServerPorts {
  smtp: number;
  submission: number;
  submissions: number;
  imap: number;
  imaps: number;
  http: number;
}

export interface MailServerStatus {
  /** Container existe (criado alguma vez). */
  installed: boolean;
  running: boolean;
  /** Versão do Stalwart (null se não conseguiu detectar). */
  version: string | null;
  image: string;
  containerName: string;
  /** Hostname do servidor de e-mail (mail.<domínio>). */
  hostname: string;
  ports: MailServerPorts;
  /** Mensagem amigável (pt-BR) com orientação quando algo está fora do esperado. */
  message: string | null;
}

// ---------------------------------------------------------------------------
// Domínios de e-mail
// ---------------------------------------------------------------------------

/** Política DMARC progressiva: começa em observação e endurece com o tempo. */
export type DmarcStage = "none" | "quarantine" | "reject";

export interface MailDomain {
  name: string;
  dkimSelector: string;
  /** Valor base64 do parâmetro p= do registro DKIM (chave pública RSA 2048). */
  dkimPublicKey: string;
  dkimKeyBits: number;
  dmarcStage: DmarcStage;
  createdAt: string;
}

export interface MailDomainSummary extends MailDomain {
  mailboxCount: number;
  /** Resumo da última verificação DNS persistida (null = nunca verificado). */
  lastVerify: {
    at: string;
    ok: number;
    total: number;
  } | null;
}

export interface MailDomainListResponse {
  domains: MailDomainSummary[];
}

// ---------------------------------------------------------------------------
// Checklist DNS
// ---------------------------------------------------------------------------

export type DnsRecordType = "A" | "AAAA" | "MX" | "TXT" | "PTR";

export type DnsCheckStatus = "found" | "missing" | "mismatch" | "action_required" | "pending";

export interface DnsRecordCheck {
  /** Identificador estável (ex.: "a", "mx", "spf", "dkim", "dmarc"). */
  id: string;
  type: DnsRecordType;
  /** Nome do registro (ex.: "mail.exemplo.com", "_dmarc.exemplo.com"). */
  name: string;
  /** Valor esperado. */
  expected: string;
  /** Para quê serve (pt-BR). */
  purpose: string;
  status: DnsCheckStatus;
  /** Valores encontrados no DNS real (após verify). */
  found: string[];
  /** Observação adicional (ex.: explicar um mismatch). */
  note: string | null;
}

export interface PtrCheck {
  ip: string;
  /** Hostname esperado no reverse DNS. */
  expected: string;
  status: DnsCheckStatus;
  found: string[];
  /** Texto pronto para abrir chamado no provedor da VPS (quando ausente). */
  ticketText: string | null;
}

export interface DnsChecklistResponse {
  domain: string;
  mailHostname: string;
  serverIp: string;
  records: DnsRecordCheck[];
  ptr: PtrCheck;
  /** Sugestão de evolução da política (DMARC progressivo / SPF), pt-BR. */
  suggestion: string | null;
}

export interface DnsVerifyResponse {
  domain: string;
  verifiedAt: string;
  summary: { ok: number; total: number };
  records: DnsRecordCheck[];
  ptr: PtrCheck;
  suggestion: string | null;
}

// ---------------------------------------------------------------------------
// Caixas de e-mail
// ---------------------------------------------------------------------------

export interface Mailbox {
  /** Endereço completo (identificador), ex.: contato@exemplo.com. */
  id: string;
  localPart: string;
  domain: string;
  /** Caixa técnica criada automaticamente para um projeto (slug) ou sistema. */
  kind: "user" | "project" | "system";
  createdAt: string;
}

export interface MailboxListResponse {
  mailboxes: Mailbox[];
}

export interface CreateMailboxRequest {
  localPart: string;
  /** Senha informada pelo usuário; se ausente, o painel gera uma forte. */
  password?: string;
}

/** Bloco de credenciais pronto para cliente externo (Outlook/Gmail/Thunderbird). */
export interface MailboxCredentials {
  email: string;
  username: string;
  password: string;
  imap: {
    host: string;
    port: number;
    security: "ssl";
  };
  imapAlt: {
    host: string;
    port: number;
    security: "starttls";
  };
  smtp: {
    host: string;
    port: number;
    security: "starttls";
  };
  smtpAlt: {
    host: string;
    port: number;
    security: "ssl";
  };
  notes: string[];
}

export interface MailboxCredentialsResponse {
  credentials: MailboxCredentials;
}

// ---------------------------------------------------------------------------
// E-mail de projeto (injeção SMTP)
// ---------------------------------------------------------------------------

export interface ProjectEmailConfig {
  enabled: boolean;
  domain: string | null;
  mailbox: string | null;
  mailFrom: string | null;
  /** Env vars que serão injetadas no próximo deploy (valores mascarados na API). */
  env: Record<string, string>;
}

export interface ProjectEmailResponse {
  email: ProjectEmailConfig;
}

export interface EnableProjectEmailRequest {
  domain: string;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export interface MailServerActionResponse {
  ok: boolean;
  status: MailServerStatus;
}

export interface MailDomainResponse {
  domain: MailDomainSummary;
}

export interface CreateMailDomainRequest {
  domain: string;
}

export interface MailboxResponse {
  mailbox: Mailbox;
  /** Senha (retornada apenas na criação — depois só via /credentials). */
  password: string;
}

// ---------------------------------------------------------------------------
// Monitoramento de blacklist (Fase 4)
// ---------------------------------------------------------------------------

export type BlacklistStatus = "listed" | "clean" | "unknown";

export interface BlacklistResult {
  /** Identificador da DNSBL, ex.: "spamhaus-zen". */
  dnsbl: string;
  /** Nome legível, ex.: "Spamhaus ZEN". */
  label: string;
  status: BlacklistStatus;
  /** Detalhe (códigos de retorno da DNSBL ou motivo do "unknown"). */
  detail: string | null;
  /** Link para checagem/remoção quando listed. */
  removalUrl: string | null;
}

export interface BlacklistTargetResult {
  /** IP ou domínio consultado. */
  target: string;
  results: BlacklistResult[];
}

export interface BlacklistCheckResponse {
  checkedAt: string;
  /** IP público verificado (null se desconhecido). */
  ip: BlacklistTargetResult | null;
  /** Um item por domínio de e-mail cadastrado. */
  domains: BlacklistTargetResult[];
  /** Resumo: quantidade de listagens encontradas. */
  listedCount: number;
}
