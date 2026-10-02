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

/**
 * Estado do DNS reverso (PTR) do IP da VPS, em três níveis:
 *  - found: o nome reverso é mail.<domínio> (o ideal);
 *  - generic: o IP tem um nome reverso genérico do provedor (ex.:
 *    vmi123.contaboserver.net) e esse nome volta para o mesmo IP. É o que o
 *    Gmail, o Yahoo e a Microsoft exigem (FCrDNS): o envio está liberado.
 *    Trocar para mail.<domínio> é opcional (melhora um pouco a reputação);
 *  - mismatch: o IP tem nome reverso, mas ele não volta para o IP (FCrDNS
 *    falha) — os grandes provedores podem recusar as mensagens;
 *  - action_required: o IP não tem nome reverso nenhum.
 */
export type PtrCheckStatus = DnsCheckStatus | "generic";

/** Provedor da VPS reconhecido pelo nome reverso atual, com o caminho para trocá-lo. */
export interface PtrProvider {
  /** Identificador estável (ex.: "contabo", "hetzner", "vultr"). */
  id: string;
  /** Nome para a pessoa (ex.: "Contabo"). */
  name: string;
  /** Onde clicar para trocar o nome reverso para mail.<domínio> (pt-BR). */
  instructions: string;
}

export interface PtrCheck {
  ip: string;
  /** Hostname esperado no reverse DNS. */
  expected: string;
  status: PtrCheckStatus;
  found: string[];
  /**
   * Algum nome reverso encontrado volta (registro A) para o mesmo IP —
   * FCrDNS válido. null = ainda não verificado ou não há nome reverso.
   */
  forwardConfirmed?: boolean | null;
  /** Provedor reconhecido pelo nome reverso atual (null = desconhecido). */
  provider?: PtrProvider | null;
  /**
   * Texto pronto para abrir chamado no provedor da VPS. Só vem quando o
   * provedor é desconhecido e o nome reverso ainda não é mail.<domínio>.
   */
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

/** Tamanho mínimo da senha que a pessoa define para uma caixa. */
export const MAILBOX_PASSWORD_MIN = 12;

export interface CreateMailboxRequest {
  localPart: string;
  /**
   * Senha definida pela pessoa (mínimo MAILBOX_PASSWORD_MIN). O painel nunca
   * a mostra de volta: quem esqueceu troca (ChangeMailboxPasswordRequest).
   */
  password: string;
}

/** PUT /api/mail/mailboxes/:id/password — nova senha definida pela pessoa. */
export interface ChangeMailboxPasswordRequest {
  password: string;
}

/** Bloco de credenciais pronto para cliente externo (Outlook/Gmail/Thunderbird). */
/** Configuração para cliente externo. Sem senha: ela nunca volta pela API. */
export interface MailboxCredentials {
  email: string;
  username: string;
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
  /** Caixa técnica <slug>@<domínio> (o projeto entra com ela). */
  mailbox: string | null;
  /** Endereço de envio: a caixa técnica ou um escolhido (alias dela). */
  mailFrom: string | null;
  /** Nome de exibição do remetente (MAIL_FROM_NAME). */
  fromName?: string | null;
  /** Env vars que serão injetadas no próximo deploy (valores mascarados na API). */
  env: Record<string, string>;
}

export interface ProjectEmailResponse {
  email: ProjectEmailConfig;
}

/**
 * POST /api/projects/:id/email — ativa ou atualiza o e-mail do projeto.
 * Sem fromLocalPart, envia como a caixa técnica (<slug>@<domínio>); sem
 * fromName, usa o nome do projeto.
 */
export interface EnableProjectEmailRequest {
  domain: string;
  /** Parte antes do @ do endereço de envio (ex.: "nao-responda"). */
  fromLocalPart?: string;
  /** Nome que aparece para quem recebe (ex.: "Loja Exemplo"). */
  fromName?: string;
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
  /**
   * O domínio já recebe e-mail em outro servidor (MX) e o operador confirmou
   * que quer seguir mesmo assim. Sem isto, o cadastro responde 409
   * `domain_receives_mail` com `existingMail`.
   */
  confirmExistingMail?: boolean;
}

/** Quem recebe o e-mail do domínio hoje (consulta ao MX antes do cadastro). */
export interface ExistingMailInfo {
  /** none = não recebe; here = já aponta para cá; elsewhere = outro servidor; unknown = consulta falhou. */
  status: "none" | "here" | "elsewhere" | "unknown";
  /** Servidores MX atuais, por prioridade. */
  servers: string[];
  /** Subdomínio sugerido para o envio (ex.: envio.exemplo.com.br). */
  suggestedDomain: string;
}

// ---------------------------------------------------------------------------
// Certificado do servidor de e-mail (mail.<domínio>)
// ---------------------------------------------------------------------------

/**
 * O registro A de mail.<domínio>: ok = aponta para esta VPS; missing = não
 * existe; cloudflare = proxy da Cloudflare ligado (nuvem laranja); other_ip =
 * aponta para outro lugar.
 */
export type MailTlsDnsStatus = "ok" | "missing" | "cloudflare" | "other_ip";

export interface MailTlsHostStatus {
  /** mail.<domínio> (ou PAAS_MAIL_HOSTNAME). */
  host: string;
  /** O servidor de e-mail apresenta um certificado válido para este nome. */
  ok: boolean;
  /** Emissor do certificado apresentado (quando válido). */
  issuer: string | null;
  /** Fim da validade (ISO, quando válido). */
  validTo: string | null;
  /** Erro da conexão TLS (quando não é válido). */
  error: string | null;
  /** O proxy (Caddy) já emitiu o certificado deste nome. */
  issued: boolean;
  dns: { status: MailTlsDnsStatus; resolved: string[]; expectedIp: string };
  /** O que falta, em pt-BR (null quando válido). */
  hint: string | null;
}

export interface MailTlsStatusResponse {
  checkedAt: string;
  serverRunning: boolean;
  hosts: MailTlsHostStatus[];
  /** Falha ao instalar o certificado no servidor de e-mail (null = ok). */
  syncError: string | null;
}

// ---------------------------------------------------------------------------
// E-mail de teste (página do domínio)
// ---------------------------------------------------------------------------

/**
 * Destino de um e-mail de teste:
 *  - queued: na fila do servidor de e-mail, tentando entregar;
 *  - delivered: o servidor do destinatário aceitou (ex.: Gmail);
 *  - bounced: o servidor do destinatário recusou de vez;
 *  - deferred: adiada (recusa temporária ou falha de conexão), nova tentativa marcada.
 */
export type MailTestState = "queued" | "delivered" | "bounced" | "deferred";

export interface MailTestStatus {
  id: string;
  domain: string;
  /** Caixa que enviou (postmaster@<domínio>). */
  from: string;
  to: string;
  sentAt: string;
  checkedAt: string;
  state: MailTestState;
  /** Resposta ou motivo devolvido pelo servidor do destinatário (quando houver). */
  detail: string | null;
  /** Próxima tentativa (ISO) quando adiada. */
  nextRetryAt: string | null;
  /**
   * true = o resultado veio do aviso de entrega do servidor de e-mail; false
   * = a mensagem só saiu da fila sem erro registrado (entregue, sem recibo).
   */
  confirmed: boolean;
  /** Resultado definitivo (entregue ou recusado): não precisa mais consultar. */
  final: boolean;
}

export interface SendTestEmailRequest {
  /** Um endereço de destino só (ex.: o Gmail da pessoa). */
  to: string;
  /** Caixa do domínio que envia (padrão: postmaster@<domínio>). */
  from?: string;
}

export interface MailTestResponse {
  test: MailTestStatus;
}

export interface MailboxResponse {
  mailbox: Mailbox;
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
