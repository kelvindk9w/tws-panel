/**
 * mail-send-log.ts — tipos do registro de envios por SMTP (E-mail → Envios →
 * "Saídas" e aba "Envios" do projeto): o que um app de projeto enviou pela
 * caixa do projeto, em que estado está e, se falhou, por quê.
 *
 * PRIVACIDADE: assunto e corpo NUNCA aparecem em `MailSendItem` (listagens).
 * Só a rota de revelar uma mensagem devolve `MailSendContent`. De onde vem
 * cada dado: comoFuncionaSistema/email/saidas.json.
 */

/**
 * Estado de uma mensagem (ou de um destinatário):
 *  - queued: aceita pelo servidor, ainda sem resultado (primeira tentativa);
 *  - delivered: o servidor do destinatário aceitou;
 *  - deferred: adiada, o servidor tenta de novo (há tentativas e próxima data);
 *  - failed: não deu para entregar (DNS, conexão, TLS, tempo esgotado, desistência);
 *  - rejected: o servidor do destinatário recusou de vez (resposta 5xx);
 *  - cancelled: tirada da fila pelo painel;
 *  - unconfirmed: saiu da fila e o painel não viu o resultado (estava parado).
 */
export type MailSendState = "queued" | "delivered" | "deferred" | "failed" | "rejected" | "cancelled" | "unconfirmed";

export const MAIL_SEND_STATES: readonly MailSendState[] = [
  "queued",
  "delivered",
  "deferred",
  "failed",
  "rejected",
  "cancelled",
  "unconfirmed",
];

/** De onde veio o envio: app de um projeto, o próprio painel (webmail, teste) ou outro remetente. */
export type MailSendOrigin = "project" | "panel" | "other";

export const MAIL_SEND_ORIGINS: readonly MailSendOrigin[] = ["project", "panel", "other"];

/**
 * Tipo do erro, em linguagem de gente (a tela traduz cada um em explicação e
 * sugestão). O texto original do servidor fica em `technical`.
 */
export type MailSendErrorKind =
  | "no_such_user"
  | "mailbox_full"
  | "message_too_large"
  | "blocklisted"
  | "spam_content"
  | "sender_auth"
  | "policy_rejected"
  | "greylisted"
  | "rate_limited"
  | "no_mx"
  | "dns_failure"
  | "tls_failure"
  | "timeout"
  | "connection_failed"
  | "expired"
  | "temporary"
  | "rejected_other"
  | "unknown";

export const MAIL_SEND_ERROR_KINDS: readonly MailSendErrorKind[] = [
  "no_such_user",
  "mailbox_full",
  "message_too_large",
  "blocklisted",
  "spam_content",
  "sender_auth",
  "policy_rejected",
  "greylisted",
  "rate_limited",
  "no_mx",
  "dns_failure",
  "tls_failure",
  "timeout",
  "connection_failed",
  "expired",
  "temporary",
  "rejected_other",
  "unknown",
];

export interface MailSendFailure {
  kind: MailSendErrorKind;
  /** Código SMTP (550, 451…), quando houve. */
  code: number | null;
  /** Código estendido (5.1.1, 4.7.28…), quando a resposta trouxe. */
  enhanced: string | null;
  /** Texto original devolvido pelo servidor (limitado, sem caracteres de controle). */
  technical: string;
}

export interface MailSendRecipient {
  address: string;
  domain: string;
  state: MailSendState;
  /** Quantas vezes o servidor adiou esta entrega. */
  deferrals: number;
  /** Última mudança de estado (ISO). */
  updatedAt: string | null;
  /** Adiada: próxima tentativa (ISO). */
  nextRetryAt: string | null;
  /** Servidor do destinatário que respondeu. */
  remoteHost: string | null;
  /** Motivo (adiada, falha ou recusa); null enquanto não houve problema. */
  error: MailSendFailure | null;
}

export interface MailSendAttachment {
  name: string;
  size: number;
}

/** Uma mensagem enviada por SMTP. NUNCA traz assunto nem corpo. */
export interface MailSendItem {
  /** Id da mensagem na fila do Stalwart (número grande, como texto). */
  id: string;
  /** Hora em que o servidor aceitou a mensagem (ISO). */
  at: string;
  /** Remetente do envelope (de). */
  from: string;
  /** Caixa autenticada na submissão (a do projeto); null = não registrada (mensagem vista só pelo registro de entrega). */
  mailbox: string | null;
  origin: MailSendOrigin;
  projectId: string | null;
  projectName: string | null;
  /** Estado geral: o pior entre os destinatários, ou o pendente. */
  state: MailSendState;
  recipients: MailSendRecipient[];
  /** Tamanho da mensagem em bytes (0 = desconhecido). */
  size: number;
  attachments: MailSendAttachment[];
  /** Há assunto e corpo guardados que o botão "Exibir" pode mostrar. */
  hasContent: boolean;
  /** O conteúdo existia e já foi apagado pela retenção. */
  contentExpired: boolean;
  /** Apagado na hora porque a gravação de assunto e corpo foi desligada. */
  contentRemoved: boolean;
  /** Corpo guardado cortado no limite de tamanho. */
  contentTruncated: boolean;
  /** O painel viu o envio chegar (captura ativa) ou só reconstruiu pelo registro de entrega. */
  captured: boolean;
}

export interface MailSendListResponse {
  items: MailSendItem[];
  total: number;
  limit: number;
  offset: number;
  /** Projetos que aparecem nos dados (para o filtro). */
  projects: Array<{ id: string; name: string }>;
  /** A captura de envios SMTP está configurada no servidor de e-mail. */
  capture: MailSendCaptureStatus;
  retention: { metadataDays: number; bodyDays: number };
  /** O conteúdo (assunto e corpo) é guardado para este recorte (global ou do projeto). */
  storesContent: boolean;
}

export interface MailSendCaptureStatus {
  /** O painel gerou a configuração de captura (rede interna disponível). */
  configured: boolean;
  /** Último aviso de envio recebido do servidor (ISO); null = nenhum ainda. */
  lastReceivedAt: string | null;
  /** O servidor de e-mail já foi criado. */
  serverCreated: boolean;
}

/** Resposta de "Exibir": o conteúdo de UMA mensagem. */
export interface MailSendContent {
  id: string;
  subject: string | null;
  body: string | null;
  bodyTruncated: boolean;
  attachments: MailSendAttachment[];
  /** Quando o conteúdo é apagado pela retenção (ISO). */
  expiresAt: string | null;
}

export interface MailSendSettings {
  /** Dias que os dados da mensagem (sem assunto/corpo) ficam guardados. */
  metadataDays: number;
  /** Dias que assunto e corpo ficam guardados. */
  bodyDays: number;
  /** Guardar assunto e corpo (global). Desligado = só metadados. */
  storeContent: boolean;
  /** Teto do corpo guardado por mensagem (KiB); acima disso o corpo é cortado. */
  maxBodyKiB: number;
  /** Teto de todo o conteúdo guardado (MiB); passou, os mais antigos são apagados. */
  maxTotalMiB: number;
  /** Projetos em que a gravação de assunto/corpo foi desligada. */
  projectsWithoutContent: string[];
}

export const MAIL_SEND_DEFAULT_SETTINGS: MailSendSettings = {
  metadataDays: 90,
  bodyDays: 14,
  storeContent: true,
  maxBodyKiB: 64,
  maxTotalMiB: 100,
  projectsWithoutContent: [],
};

export const MAIL_SEND_LIMITS = {
  metadataDays: { min: 7, max: 365 },
  bodyDays: { min: 1, max: 90 },
  maxBodyKiB: { min: 1, max: 512 },
  maxTotalMiB: { min: 10, max: 2048 },
} as const;

export type UpdateMailSendSettingsRequest = Partial<Omit<MailSendSettings, "projectsWithoutContent">> & {
  /** Liga/desliga a gravação de assunto/corpo de UM projeto. */
  project?: { id: string; storeContent: boolean };
};

/** Nome da pasta (dentro de data/) com assunto e corpo: fica de fora dos backups do painel. */
export const MAIL_SEND_CONTENT_DIRNAME = "envios-conteudo";
