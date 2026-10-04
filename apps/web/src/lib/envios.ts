/**
 * envios.ts — textos e formatos da página Envios (E-mail → Envios).
 */
import type { MailDeliveryState, MailQueueRecipientState, MailSenderInfo } from "@paas/core";

export const HISTORY_STATE_LABELS: Record<MailDeliveryState, string> = {
  delivered: "Entregue",
  bounced: "Recusada",
  deferred: "Adiada",
  cancelled: "Cancelada",
};

export const QUEUE_STATE_LABELS: Record<MailQueueRecipientState, string> = {
  waiting: "Aguardando",
  deferred: "Adiada",
  delivered: "Entregue",
  bounced: "Recusada",
};

export type BadgeVariant = "success" | "warning" | "destructive" | "secondary";

export function stateVariant(state: MailDeliveryState | MailQueueRecipientState): BadgeVariant {
  if (state === "delivered") return "success";
  if (state === "bounced") return "destructive";
  if (state === "deferred") return "warning";
  return "secondary";
}

/** "04/10/2026 12:00" no fuso do navegador. */
export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** "2026-10-04" → "04/10". */
export function dayLabel(date: string): string {
  const [, m, d] = date.split("-");
  return `${d}/${m}`;
}

/** 0,048 → "4,8%". */
export function formatPercent(fraction: number): string {
  const rounded = Math.round(fraction * 1000) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1).replace(".", ",")}%`;
}

/** Quem enviou, para leigo: "Projeto Loja · loja@…" / "Aviso do servidor". */
export function senderLabel(sender: MailSenderInfo): string {
  if (!sender.address) return "Aviso do próprio servidor de e-mail";
  if (sender.projectName) return `Projeto ${sender.projectName} · ${sender.address}`;
  if (sender.system) return `Caixa do sistema · ${sender.address}`;
  return sender.address;
}

/**
 * Recusas conhecidas que têm caminho de solução (seção 3.4 da pesquisa de
 * entregabilidade). Texto de terceiro: só procuramos códigos conhecidos.
 */
export function rejectionHint(detail: string | null): string | null {
  if (!detail) return null;
  if (/S3150|5\.7\.515|banned sending IP/i.test(detail)) {
    return "A Microsoft (Outlook/Hotmail) bloqueou o IP. Peça a liberação em sender.office.com e cadastre o IP no SNDS.";
  }
  if (/4\.7\.28|5\.7\.26|unusual rate|reputation/i.test(detail)) {
    return "O destino está segurando por reputação: diminua o volume e mande só para quem espera a mensagem.";
  }
  if (/TSS04/.test(detail)) {
    return "O Yahoo está segurando por reputação: diminua o volume por um tempo.";
  }
  if (/5\.1\.1|user unknown|does not exist|no such user/i.test(detail)) {
    return "O endereço não existe: pare de enviar para ele.";
  }
  return null;
}
