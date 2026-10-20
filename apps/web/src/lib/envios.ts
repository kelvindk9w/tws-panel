/**
 * envios.ts — textos e formatos da página Envios (E-mail → Envios).
 */
import type { MailDeliveryState, MailQueueRecipientState, MailSenderInfo } from "@paas/core";
import { formatDate, formatDateTime as formatDateTimeI18n, formatNumber, t, type Key } from "@/i18n";

/** Chaves dos rótulos de estado (o texto sai por `t(...)` na renderização). */
export const HISTORY_STATE_KEYS: Record<MailDeliveryState, Key> = {
  delivered: "envios.state.delivered",
  bounced: "envios.state.bounced",
  deferred: "envios.state.deferred",
  cancelled: "envios.state.cancelled",
};

export const QUEUE_STATE_KEYS: Record<MailQueueRecipientState, Key> = {
  waiting: "envios.state.waiting",
  deferred: "envios.state.deferred",
  delivered: "envios.state.delivered",
  bounced: "envios.state.bounced",
};

export type BadgeVariant = "success" | "warning" | "destructive" | "secondary";

export function stateVariant(state: MailDeliveryState | MailQueueRecipientState): BadgeVariant {
  if (state === "delivered") return "success";
  if (state === "bounced") return "destructive";
  if (state === "deferred") return "warning";
  return "secondary";
}

/** "04/10/2026 12:00" (pt-BR) no fuso do navegador. */
export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return formatDateTimeI18n(d, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** "2026-10-04" → "04/10" (pt-BR). */
export function dayLabel(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(day.getTime())) {
    const [, m, d] = date.split("-");
    return `${d}/${m}`;
  }
  return formatDate(day, { day: "2-digit", month: "2-digit", timeZone: "UTC" });
}

/** 0,048 → "4,8%". */
export function formatPercent(fraction: number): string {
  const rounded = Math.round(fraction * 1000) / 10;
  return `${formatNumber(rounded, { maximumFractionDigits: 1, useGrouping: false })}%`;
}

/** Quem enviou, para leigo: "Projeto Loja · loja@…" / "Aviso do servidor". */
export function senderLabel(sender: MailSenderInfo): string {
  if (!sender.address) return t("envios.sender.system");
  if (sender.projectName) return t("envios.sender.project", { name: sender.projectName, address: sender.address });
  if (sender.system) return t("envios.sender.systemMailbox", { address: sender.address });
  return sender.address;
}

/**
 * Recusas conhecidas que têm caminho de solução (seção 3.4 da pesquisa de
 * entregabilidade). Texto de terceiro: só procuramos códigos conhecidos.
 */
export function rejectionHint(detail: string | null): string | null {
  if (!detail) return null;
  if (/S3150|5\.7\.515|banned sending IP/i.test(detail)) {
    return t("envios.hint.microsoft");
  }
  if (/4\.7\.28|5\.7\.26|unusual rate|reputation/i.test(detail)) {
    return t("envios.hint.reputation");
  }
  if (/TSS04/.test(detail)) {
    return t("envios.hint.yahoo");
  }
  if (/5\.1\.1|user unknown|does not exist|no such user/i.test(detail)) {
    return t("envios.hint.unknownUser");
  }
  return null;
}
