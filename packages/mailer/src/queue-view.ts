/**
 * queue-view.ts — a fila do Stalwart (v0.11.8) como a página Envios mostra.
 *
 * Fonte: GET /api/queue/messages?values=1 (crates/jmap/src/api/management/
 * queue.rs). Formato em delivery-status.ts. Dois cuidados:
 *  - o `id` é um u64 (ex.: 333028896599011329), maior que o inteiro seguro do
 *    JavaScript: o JSON.parse comum arredonda e "Tentar agora"/"Cancelar"
 *    acertariam outra mensagem (ou nenhuma). Por isso o id é lido como texto;
 *  - o motivo da falha pode estar no destinatário ou só no domínio (quando
 *    a conexão nem chegou ao RCPT TO).
 */
import type { MailQueueRecipient } from "@paas/core";
import { cleanSmtpResponse, type QueuedMessage, type QueueStatus } from "./delivery-status.js";

/** Mensagem da fila com o id preservado como texto. */
export type QueueMessageRaw = Omit<QueuedMessage, "id"> & { id: string };

/** Id da fila: só dígitos (u64 tem até 20). */
export function isQueueId(id: string): boolean {
  return /^\d{1,20}$/.test(id);
}

/**
 * Lê a resposta da listagem preservando o id. Os textos do JSON escapam as
 * aspas (\"), então `"id":<número>` só casa com a chave de verdade.
 */
export function parseQueueResponse(body: string): { items: QueueMessageRaw[]; total: number } {
  const quoted = body.replace(/"id":(\d+)/g, '"id":"$1"');
  const data = (JSON.parse(quoted) as { data?: { items?: unknown[]; total?: number } }).data;
  const items = (data?.items ?? []).filter(
    (item): item is QueueMessageRaw => typeof item === "object" && item !== null,
  );
  return { items, total: data?.total ?? items.length };
}

export interface QueueItemView {
  id: string;
  from: string;
  createdAt: string | null;
  size: number;
  recipients: MailQueueRecipient[];
  attempts: number;
  nextRetryAt: string | null;
  expiresAt: string | null;
  lastError: string | null;
}

function iso(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function kindOf(status: QueueStatus): { kind: "scheduled" | "completed" | "temp_fail" | "perm_fail"; text: string } {
  if (typeof status === "string") return { kind: "scheduled", text: "" };
  if ("completed" in status) return { kind: "completed", text: status.completed };
  if ("temp_fail" in status) return { kind: "temp_fail", text: status.temp_fail };
  return { kind: "perm_fail", text: status.perm_fail };
}

const STATE = { scheduled: "waiting", completed: "delivered", temp_fail: "deferred", perm_fail: "bounced" } as const;

/** Uma mensagem da fila: estado de cada destinatário, tentativas e o último motivo. */
export function queueItemFromMessage(message: QueueMessageRaw): QueueItemView {
  const domains = message.domains ?? [];
  const recipients: MailQueueRecipient[] = [];
  for (const domain of domains) {
    const domainStatus = kindOf(domain.status);
    for (const rcpt of domain.recipients) {
      let status = kindOf(rcpt.status);
      // Sem resposta própria (a conexão nem chegou ao RCPT): vale a do domínio.
      if (status.kind === "scheduled") status = domainStatus;
      recipients.push({
        address: rcpt.address,
        domain: rcpt.address.slice(rcpt.address.lastIndexOf("@") + 1).toLowerCase(),
        state: STATE[status.kind],
        detail: status.text ? cleanSmtpResponse(status.text) : null,
      });
    }
  }
  const pending = domains.filter((d) => {
    const k = kindOf(d.status).kind;
    return k === "scheduled" || k === "temp_fail";
  });
  const earliest = (values: Array<string | null>) =>
    values
      .map(iso)
      .filter((v): v is string => v !== null)
      .sort()[0] ?? null;
  return {
    id: message.id,
    from: message.return_path,
    createdAt: iso(message.created),
    size: message.size,
    recipients,
    attempts: Math.max(0, ...domains.map((d) => d.retry_num)),
    nextRetryAt: earliest(pending.map((d) => d.next_retry)),
    expiresAt: earliest(pending.map((d) => d.expires)),
    lastError: recipients.find((r) => r.state === "deferred" || r.state === "bounced")?.detail ?? null,
  };
}
