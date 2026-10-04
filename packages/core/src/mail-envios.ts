/**
 * mail-envios.ts — tipos da página "Envios" (E-mail → Envios): fila do
 * servidor de e-mail, histórico de entregas, volume, reputação (listas de
 * bloqueio) e a nota de entregabilidade.
 *
 * De onde vem cada dado está em comoFuncionaSistema/email/envios.json.
 */
import type { BlacklistCheckResponse } from "./mail";

// ---------------------------------------------------------------------------
// Quem enviou (caixa / projeto)
// ---------------------------------------------------------------------------

/** Remetente de uma mensagem, com a caixa e o projeto a que pertence (quando se sabe). */
export interface MailSenderInfo {
  /** Endereço do envelope (MAIL FROM). Vazio = aviso do próprio servidor. */
  address: string;
  /** Caixa do painel que enviou (endereço da caixa); null = desconhecida. */
  mailbox: string | null;
  projectId: string | null;
  projectName: string | null;
  /** Caixa do sistema (postmaster@, avisos do servidor). */
  system: boolean;
}

// ---------------------------------------------------------------------------
// Fila agora
// ---------------------------------------------------------------------------

/**
 * Estado de um destinatário na fila:
 *  - waiting: aguardando a primeira tentativa (ou sem resposta ainda);
 *  - deferred: o destino recusou por enquanto ou a conexão falhou, nova tentativa marcada;
 *  - delivered: já entregue (a mensagem segue na fila por outro destinatário);
 *  - bounced: recusado de vez.
 */
export type MailQueueRecipientState = "waiting" | "deferred" | "delivered" | "bounced";

export interface MailQueueRecipient {
  address: string;
  /** Domínio do destinatário (ex.: gmail.com). */
  domain: string;
  state: MailQueueRecipientState;
  /** Motivo devolvido pelo servidor do destinatário (ou da falha de conexão). */
  detail: string | null;
}

export interface MailQueueItem {
  /** Id da mensagem na fila do Stalwart (número grande, guardado como texto). */
  id: string;
  sender: MailSenderInfo;
  /** Quando entrou na fila (ISO); null = data ilegível. */
  createdAt: string | null;
  size: number;
  recipients: MailQueueRecipient[];
  /** Tentativas já feitas (a maior entre os domínios de destino). */
  attempts: number;
  /** Próxima tentativa (ISO) do primeiro domínio ainda pendente. */
  nextRetryAt: string | null;
  /** Quando o servidor desiste (ISO). */
  expiresAt: string | null;
  /** Motivo da última falha (o primeiro encontrado). */
  lastError: string | null;
}

export interface MailQueueResponse {
  /** false = o servidor de e-mail não está criado ou não respondeu. */
  available: boolean;
  /** Explicação quando `available` é false. */
  message: string | null;
  items: MailQueueItem[];
  total: number;
  checkedAt: string;
}

export interface MailQueueActionResponse {
  ok: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Histórico
// ---------------------------------------------------------------------------

/**
 * Resultado registrado para um destinatário:
 *  - delivered: o servidor do destinatário aceitou;
 *  - bounced: recusada de vez (ou desistência depois de tentar por dias);
 *  - deferred: adiada nesta tentativa (haverá outra);
 *  - cancelled: cancelada pelo painel (botão "Cancelar" da fila).
 */
export type MailDeliveryState = "delivered" | "bounced" | "deferred" | "cancelled";

export const MAIL_DELIVERY_STATES: readonly MailDeliveryState[] = ["delivered", "bounced", "deferred", "cancelled"];

/** Um evento guardado no histórico (só metadados: nunca o conteúdo da mensagem). */
export interface MailDeliveryEvent {
  at: string;
  queueId: string;
  /** Remetente do envelope. */
  from: string;
  to: string;
  /** Domínio do destinatário. */
  toDomain: string;
  state: MailDeliveryState;
  /** Código SMTP devolvido (ex.: 250, 451, 550), quando houver. */
  code: number | null;
  /** Resposta ou motivo (limitado, sem caracteres de controle). */
  detail: string | null;
  /** Servidor que respondeu (ex.: gmail-smtp-in.l.google.com). */
  remoteHost: string | null;
  /** Adiada: próxima tentativa (ISO). */
  nextRetryAt: string | null;
}

export interface MailHistoryItem extends MailDeliveryEvent {
  sender: MailSenderInfo;
}

export interface MailHistoryResponse {
  items: MailHistoryItem[];
  /** Total que casa com o filtro (a lista vem limitada). */
  total: number;
  /** Última leitura do registro do servidor (null = nunca leu). */
  collectedAt: string | null;
  /** Erro da última leitura, quando houve. */
  collectError: string | null;
  /** Dias guardados (os mais antigos são apagados). */
  retentionDays: number;
  /** Projetos e caixas que aparecem no período (para os filtros). */
  projects: Array<{ id: string; name: string }>;
  mailboxes: string[];
  domains: string[];
}

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------

export interface MailVolumeDay {
  /** Dia local (AAAA-MM-DD), no fuso de quem pediu. */
  date: string;
  delivered: number;
  bounced: number;
  deferred: number;
  cancelled: number;
}

export interface MailVolumeProject {
  /** null = remetente sem projeto (sistema ou caixa avulsa). */
  projectId: string | null;
  name: string;
  delivered: number;
  bounced: number;
  deferred: number;
}

export interface MailRate {
  /** Fração (0–1); null = sem envios no período. */
  value: number | null;
  /** Limite saudável (fração). */
  limit: number;
  /** Passou do limite. */
  high: boolean;
}

export interface MailVolumeResponse {
  days: MailVolumeDay[];
  byProject: MailVolumeProject[];
  totals: { delivered: number; bounced: number; deferred: number; cancelled: number; recipients: number };
  /** Recusadas ÷ (entregues + recusadas). */
  bounceRate: MailRate;
  /** Destinatários com algum adiamento ÷ destinatários no período. */
  deferRate: MailRate;
  /**
   * Reclamações (marcar como spam): o servidor não recebe esse dado. null
   * sempre; a página manda para o Google Postmaster Tools.
   */
  complaintRate: null;
  /** Poucos envios: a taxa oscila muito e não deve assustar. */
  lowVolume: boolean;
}

// ---------------------------------------------------------------------------
// Reputação (listas de bloqueio)
// ---------------------------------------------------------------------------

export interface MailReputationResponse {
  /** Última conferência (null = ainda não conferiu). */
  lastCheck: BlacklistCheckResponse | null;
  /** Por que não conferiu ou o que falhou na última vez. */
  lastError: string | null;
  /** Conferência em andamento agora. */
  checking: boolean;
  /** Próxima conferência automática (ISO). */
  nextCheckAt: string | null;
  /** Chave DQS da Spamhaus: só se existe e os 4 últimos caracteres. */
  dqs: { configured: boolean; hint: string | null };
}

export interface SetDqsKeyRequest {
  /** Chave nova; null apaga. */
  key: string | null;
}

// ---------------------------------------------------------------------------
// Nota de entregabilidade
// ---------------------------------------------------------------------------

export type DeliverabilityItemStatus = "done" | "partial" | "todo" | "unknown";

export interface DeliverabilityItem {
  id: string;
  label: string;
  status: DeliverabilityItemStatus;
  points: number;
  maxPoints: number;
  /** O que o painel viu, em uma frase. */
  detail: string;
  /** O que fazer para melhorar (null quando já está feito). */
  howTo: string | null;
  /** Link útil (Postmaster Tools, SNDS, página do domínio…). */
  link: { label: string; href: string } | null;
}

export type DeliverabilityBand = "green" | "yellow" | "red";

/** Marcações que a pessoa faz (o painel não tem como conferir sozinho). */
export interface PostmasterMarks {
  /** Data em que cadastrou o domínio no Google Postmaster Tools. */
  googleAt: string | null;
  /** Data em que cadastrou o IP no Microsoft SNDS. */
  microsoftAt: string | null;
  /** Data em que conferiu a taxa de spam abaixo de 0,1% no Postmaster Tools. */
  spamRateOkAt: string | null;
}

export interface DeliverabilityResponse {
  score: number;
  max: number;
  band: DeliverabilityBand;
  items: DeliverabilityItem[];
  marks: PostmasterMarks;
  /** Quando os dados de DNS/PTR/certificado foram conferidos (null = nunca). */
  factsAt: string | null;
}

export type SetPostmasterMarksRequest = Partial<PostmasterMarks>;
