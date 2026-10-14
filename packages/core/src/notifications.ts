/**
 * notifications.ts — avisos fora do painel (Configurações → Notificações).
 *
 * Dois canais: Telegram (um robô criado no @BotFather) e e-mail (enviado pelo
 * servidor de e-mail do próprio painel). A pessoa escolhe um, outro ou os dois,
 * e escolhe também O QUE avisa (tipos abaixo). O token do robô nunca volta
 * pela API: só o nome do robô e o nome da conversa.
 */

/** O que pode virar aviso. */
export type NotificationKind = "security" | "deploy" | "certificate" | "blacklist" | "disk" | "panel";

export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  "security",
  "deploy",
  "certificate",
  "blacklist",
  "disk",
  "panel",
];

/** Padrão sensato: tudo que pede ação ligado; "painel iniciado" desligado (é informativo). */
export const DEFAULT_NOTIFICATION_KINDS: Readonly<Record<NotificationKind, boolean>> = {
  security: true,
  deploy: true,
  certificate: true,
  blacklist: true,
  disk: true,
  panel: false,
};

/** Texto de cada tipo para a tela. */
export const NOTIFICATION_KIND_LABELS: Readonly<Record<NotificationKind, { title: string; description: string }>> = {
  security: {
    title: "Alertas de segurança",
    description: "O que o monitoramento encontra (porta nova, arquivo de configuração alterado) e deploy barrado pelas regras de segurança.",
  },
  deploy: {
    title: "Deploy",
    description: "Quando um deploy falha e quando o projeto volta a publicar sem erro.",
  },
  certificate: {
    title: "Certificados HTTPS",
    description: "Certificado que não foi emitido ou renovado e certificado perto de vencer.",
  },
  blacklist: {
    title: "E-mail em lista de bloqueio",
    description: "Quando o IP ou o domínio do e-mail aparece numa blacklist.",
  },
  disk: {
    title: "Disco quase cheio",
    description: "Quando o disco da VPS passa de 90% de uso.",
  },
  panel: {
    title: "Painel reiniciado",
    description: "Quando o painel liga de novo (depois de uma atualização ou de reiniciar a VPS).",
  },
};

export type NotificationChannelId = "telegram" | "email";

export type TelegramState = "none" | "awaiting_chat" | "connected";

export interface TelegramChannelStatus {
  state: TelegramState;
  /** @nome do robô (sem o @). Não é segredo. */
  botUsername: string | null;
  /** Nome da conversa ligada (pessoa, grupo ou canal). */
  chatTitle: string | null;
  connectedAt: string | null;
  /** Último "Enviar teste" que deu certo. */
  testedAt: string | null;
}

export interface EmailChannelStatus {
  /** O servidor de e-mail do painel está pronto para enviar. */
  available: boolean;
  /** O que falta, em português, quando não está pronto. */
  unavailableReason: string | null;
  /** Endereço de onde os avisos saem (postmaster@<domínio>). */
  from: string | null;
  recipients: string[];
  testedAt: string | null;
}

export type NotificationDeliveryStatus = "sent" | "failed" | "retrying";

/** Um envio, sem o conteúdo da mensagem — só o assunto. */
export interface NotificationHistoryEntry {
  id: string;
  at: string;
  channel: NotificationChannelId;
  kind: NotificationKind | "test" | "summary";
  title: string;
  status: NotificationDeliveryStatus;
  /** Motivo da falha (curto, sem token nem endereço). */
  detail: string | null;
}

export interface NotificationsStatus {
  telegram: TelegramChannelStatus;
  email: EmailChannelStatus;
  kinds: Record<NotificationKind, boolean>;
  history: NotificationHistoryEntry[];
}

export interface TelegramTokenRequest {
  token: string;
}

export interface EmailRecipientsRequest {
  recipients: string[];
}

export interface NotificationKindsRequest {
  kinds: Partial<Record<NotificationKind, boolean>>;
}

/** Máximo de endereços que recebem os avisos por e-mail. */
export const MAX_NOTIFICATION_RECIPIENTS = 5;
