/**
 * mail-diagnosis.ts — diagnóstico de e-mail por projeto: tentativas recusadas ANTES da fila, "por que nada chegou",
 * avisos do Laravel (fila sem worker, LOG_CHANNEL) e o teste de conexão feito pelo painel.
 *
 * De onde vem cada dado: comoFuncionaSistema/email/diagnostico.json.
 */

/**
 * Tentativa de envio recusada antes de entrar na fila do servidor de e-mail:
 *  - auth_failed: usuário ou senha errados;
 *  - auth_banned: bloqueio temporário por tentativas demais de login;
 *  - auth_not_allowed: o login não é aceito nesta conexão (sem TLS, mecanismo não suportado);
 *  - tls_error: a conexão TLS não fechou (versão, certificado, o app desistiu);
 *  - sender_not_allowed: o remetente (From do envelope) não é permitido para este login;
 *  - relay_not_allowed: tentou enviar sem estar autenticado;
 *  - rate_limited: limite de envios ou de conexões;
 *  - message_too_large: mensagem acima do tamanho aceito.
 */
export type MailRefusalKind =
  | "auth_failed"
  | "auth_banned"
  | "auth_not_allowed"
  | "tls_error"
  | "sender_not_allowed"
  | "relay_not_allowed"
  | "rate_limited"
  | "message_too_large";

export const MAIL_REFUSAL_KINDS: readonly MailRefusalKind[] = [
  "auth_failed",
  "auth_banned",
  "auth_not_allowed",
  "tls_error",
  "sender_not_allowed",
  "relay_not_allowed",
  "rate_limited",
  "message_too_large",
];

/**
 * De onde a tentativa veio, sem guardar o endereço: "internal" = da rede Docker do painel (onde estão os apps e o
 * próprio painel); "external" = da internet; "unknown" = o registro não trouxe o endereço.
 */
export type MailRefusalOrigin = "internal" | "external" | "unknown";

/** Uma tentativa recusada, como guardada em disco (sem endereço IP, sem conteúdo). */
export interface MailRefusal {
  /** ISO 8601. */
  at: string;
  kind: MailRefusalKind;
  /** Só "internal" conta como tentativa do app do projeto. */
  origin: MailRefusalOrigin;
  /** Login informado (só se parece um endereço de e-mail); null = não apareceu no registro. */
  login: string | null;
  /** Projeto dono da caixa técnica `<slug>@<domínio>` usada no login; null = não é de projeto. */
  projectId: string | null;
}

export interface MailRefusalItem extends MailRefusal {
  projectName: string | null;
}

export interface MailRefusalsResponse {
  items: MailRefusalItem[];
  /** Total guardado no recorte (a lista traz os mais recentes). */
  total: number;
  /** Dias de retenção. */
  retentionDays: number;
  /** Última leitura do registro do servidor de e-mail (ISO); null = nunca. */
  collectedAt: string | null;
  /** O servidor de e-mail foi criado (sem ele não há o que ler). */
  serverCreated: boolean;
}

/** Códigos dos itens de "por que nada chegou". A tela traduz cada um. */
export type MailHintCode =
  | "email_disabled"
  | "no_mailbox"
  | "test_inbox_on"
  | "needs_restart"
  | "mailer_not_smtp"
  | "smtp_not_linked"
  | "queue_no_worker"
  | "recent_refusals"
  | "app_never_connected";

export interface MailHintItem {
  code: MailHintCode;
  /** problem = explica a falta de e-mail; info = pode ser a causa. */
  severity: "problem" | "info";
  /** Valores para o texto (nomes de variáveis, motivo da recusa). Nunca valores secretos. */
  params?: Record<string, string>;
}

/** Aviso do projeto vindo do código/Compose (aparece na página do projeto). */
export type ProjectNoticeCode = "queue_no_worker" | "log_channel_stderr";

export interface ProjectNotice {
  code: ProjectNoticeCode;
  severity: "warning" | "info";
}

export interface MailLastAttempt {
  /** ISO 8601. */
  at: string;
  outcome: "accepted" | "refused";
  /** Motivo, quando recusada. */
  kind: MailRefusalKind | null;
}

export interface ProjectMailDiagnosis {
  /** Janela olhada para dizer que "não houve envio" (horas). */
  windowHours: number;
  /** Nenhum envio do app na janela. */
  noSendsRecent: boolean;
  /** Itens de "por que nada chegou"; só vem preenchida quando `noSendsRecent`. */
  hints: MailHintItem[];
  /** Avisos do Laravel (fila sem worker, LOG_CHANNEL). Valem mesmo com envios. */
  notices: ProjectNotice[];
  /** Última vez que o app apareceu no servidor de e-mail (aceito ou recusado); null = nunca vista. */
  lastAttempt: MailLastAttempt | null;
}

/** Passos do teste de conexão, na ordem em que acontecem. */
export const MAIL_PROBE_STEPS = ["connect", "ehlo", "starttls", "certificate", "auth"] as const;
export type MailProbeStep = (typeof MAIL_PROBE_STEPS)[number];

/** Por que um passo falhou (a tela traduz). */
export type MailProbeFailure =
  | "dns"
  | "refused"
  | "timeout"
  | "reset"
  | "closed"
  | "greeting"
  | "ehlo_rejected"
  | "starttls_unavailable"
  | "starttls_rejected"
  | "certificate"
  | "auth_rejected"
  | "auth_unsupported"
  | "unexpected";

export interface MailProbeResult {
  ok: boolean;
  host: string;
  port: number;
  /** Passos concluídos com sucesso, em ordem. */
  passed: MailProbeStep[];
  /** Primeiro passo que falhou; null quando ok. */
  failedStep: MailProbeStep | null;
  failure: MailProbeFailure | null;
  /** Resposta SMTP do servidor (código e texto curto, sem credenciais); null se não houve. */
  detail: string | null;
  elapsedMs: number;
}
