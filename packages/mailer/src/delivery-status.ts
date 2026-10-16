/**
 * delivery-status.ts — para onde foi o e-mail de teste.
 *
 * Duas fontes, as duas conferidas no código-fonte do Stalwart na tag v0.11.8:
 *
 * 1. A FILA (API de administração, GET /api/queue/messages?values=1 —
 *    crates/jmap/src/api/management/queue.rs). Cada mensagem tem `env_id`
 *    (o ENVID que o painel mandou) e `domains[]`, cada domínio com `status`,
 *    `next_retry` e `recipients[]` (cada um com `address` e `status`). O
 *    status é um enum do serde sem tag interna: "scheduled" (texto) ou
 *    {"completed": "..."}, {"temp_fail": "..."}, {"perm_fail": "..."}. A
 *    resposta do destinatário vem no formato
 *    "Code: 550, Enhanced code: 5.1.1, Message: ..." (Display do smtp-proto).
 *
 * 2. O AVISO DE ENTREGA (DSN). Quando nada mais está pendente — entregue OU
 *    recusada de vez — o Stalwart REMOVE a mensagem da fila
 *    (crates/smtp/src/outbound/delivery.rs: `message.remove(...)` quando
 *    `next_event()` é None). Então "sumiu da fila" não basta para dizer
 *    "entregue". Antes de remover, ele chama `send_dsn`
 *    (crates/smtp/src/queue/dsn.rs), que manda ao remetente (postmaster@) um
 *    aviso com assunto fixo: "Successfully delivered message" (só com
 *    NOTIFY=SUCCESS, que o painel pede), "Failed to deliver message" ou
 *    "Warning: Delay in message delivery". O texto traz uma linha por
 *    destinatário: "<end> (delivered to 'host' with code 250 (2.0.0) '...')"
 *    ou "<end> (host 'host' rejected command '...' with code 550 (5.1.1) '...')".
 *    O painel lê esse aviso pela API JMAP do próprio Stalwart, com a senha da
 *    caixa postmaster@ (que ele já guarda).
 *
 *    Um aviso só vale para a mensagem que o gerou: o painel exige o ENVID
 *    dela no aviso. O dsn.rs (v0.11.8) monta multipart/report com três
 *    partes: text/plain (as linhas por destinatário), message/delivery-status
 *    (com "Original-Envelope-Id: <envid>" quando o envio tinha ENVID) e
 *    message/rfc822 só com os cabeçalhos originais (o Message-ID do teste é
 *    `<envid@domínio>`). As duas últimas não são text/*, então o JMAP não as
 *    devolve em bodyValues: vêm em `attachments`, e o painel baixa cada uma
 *    (pequenas) pelo download do próprio JMAP para procurar o ENVID. Casar
 *    só pelo destinatário fazia um teste herdar o recibo do teste anterior
 *    ao mesmo endereço.
 */
import type { MailTestState } from "@paas/core";

/** Status de domínio/destinatário na fila (serde: "scheduled" ou { variante: texto }). */
export type QueueStatus =
  | "scheduled"
  | { completed: string }
  | { temp_fail: string }
  | { perm_fail: string };

export interface QueuedRecipient {
  address: string;
  status: QueueStatus;
  orcpt?: string;
}

export interface QueuedDomain {
  name: string;
  status: QueueStatus;
  recipients: QueuedRecipient[];
  retry_num: number;
  next_retry: string | null;
  next_notify: string | null;
  expires: string;
}

/** Mensagem da fila como GET /api/queue/messages?values=1 devolve (v0.11.8). */
export interface QueuedMessage {
  /** u64 — pode perder precisão no JSON.parse; o painel não usa o id. */
  id: number;
  return_path: string;
  domains: QueuedDomain[];
  created: string;
  size: number;
  priority?: number;
  env_id?: string;
  blob_hash: string;
}

export interface DeliveryInfo {
  state: MailTestState;
  detail: string | null;
  nextRetryAt: string | null;
}

/** "Code: 550, Enhanced code: 5.1.1, Message: X" → "550 5.1.1 X". Outros textos passam como estão. */
export function cleanSmtpResponse(value: string): string {
  const match = /^Code: (\d+), Enhanced code: (\d+)\.(\d+)\.(\d+), Message: ([\s\S]*)$/.exec(value.trim());
  if (!match) return value.trim();
  const [, code, a, b, c, message] = match;
  const enhanced = a === "0" && b === "0" && c === "0" ? "" : ` ${a}.${b}.${c}`;
  return `${code}${enhanced} ${message!.trim()}`;
}

function kindOf(status: QueueStatus): { kind: "scheduled" | "completed" | "temp_fail" | "perm_fail"; text: string } {
  if (typeof status === "string") return { kind: "scheduled", text: "" };
  if ("completed" in status) return { kind: "completed", text: status.completed };
  if ("temp_fail" in status) return { kind: "temp_fail", text: status.temp_fail };
  return { kind: "perm_fail", text: status.perm_fail };
}

/** Estado do destinatário `to` numa mensagem que ainda está na fila. */
export function deliveryFromQueue(message: QueuedMessage, to: string): DeliveryInfo {
  const target = to.toLowerCase();
  for (const domain of message.domains) {
    const rcpt = domain.recipients.find((r) => r.address.toLowerCase() === target);
    if (!rcpt) continue;
    let { kind, text } = kindOf(rcpt.status);
    // Sem resposta própria (ex.: a conexão nem chegou ao RCPT): vale a do domínio.
    if (kind === "scheduled") ({ kind, text } = kindOf(domain.status));
    const detail = text ? cleanSmtpResponse(text) : null;
    switch (kind) {
      case "completed":
        return { state: "delivered", detail, nextRetryAt: null };
      case "perm_fail":
        return { state: "bounced", detail, nextRetryAt: null };
      case "temp_fail":
        return { state: "deferred", detail, nextRetryAt: domain.next_retry };
      default:
        return { state: "queued", detail: null, nextRetryAt: null };
    }
  }
  return { state: "queued", detail: null, nextRetryAt: null };
}

/** Lê o aviso de entrega do Stalwart (assunto + texto) para o destinatário `to`. */
export function interpretDeliveryReport(
  subject: string,
  text: string,
  to: string,
): { state: Exclude<MailTestState, "queued">; detail: string } | null {
  const marker = `<${to.toLowerCase()}>`;
  const line = text.split(/\r?\n/).find((l) => l.toLowerCase().includes(marker));
  if (!line) return null;
  const detail = line
    .slice(line.toLowerCase().indexOf(marker) + marker.length)
    .trim()
    .replace(/^\(/, "")
    .replace(/\)$/, "")
    .trim();
  const s = subject.toLowerCase();
  if (s.includes("delay")) return { state: "deferred", detail };
  if (s.includes("failed") || s.includes("failures")) return { state: "bounced", detail };
  if (s.includes("delivered")) {
    // "Partially delivered": a linha do destinatário diz o que houve com ele.
    return { state: line.includes("(delivered to") ? "delivered" : "bounced", detail };
  }
  return null;
}

export interface FindDeliveryReportOptions {
  /** Base da API HTTP do Stalwart (ex.: http://paas-stalwart:8080). */
  baseUrl: string;
  /** Caixa remetente (recebe o aviso) e a senha dela. */
  username: string;
  password: string;
  to: string;
  /**
   * ENVID da mensagem (o mesmo do MAIL FROM ... ENVID=). Só um aviso que o
   * cita (Original-Envelope-Id ou Message-ID original) conta.
   */
  envId: string;
  /** Só avisos que chegaram depois disto. */
  since: Date;
  timeoutMs?: number;
}

/** Partes do aviso que identificam a mensagem original. */
const REPORT_PART = /^(message\/(delivery-status|global-delivery-status|rfc822|global-headers)|text\/rfc822-headers)$/i;

interface JmapBodyPart {
  partId?: string;
  blobId?: string;
  type?: string;
}

/** UTCDate do JMAP (RFC 8620): sem fração de segundo. */
function utcDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Procura, na caixa do remetente, o aviso de entrega mais recente sobre `to`
 * DA MENSAGEM `envId` (JMAP do próprio Stalwart: GET /.well-known/jmap e
 * POST /jmap/).
 */
export async function findDeliveryReport(
  opts: FindDeliveryReportOptions,
): Promise<{ state: Exclude<MailTestState, "queued">; detail: string } | null> {
  const auth = `Basic ${Buffer.from(`${opts.username}:${opts.password}`).toString("base64")}`;
  const timeout = () => AbortSignal.timeout(opts.timeoutMs ?? 10_000);
  const session = await fetch(`${opts.baseUrl}/.well-known/jmap`, {
    headers: { authorization: auth },
    signal: timeout(),
  });
  if (!session.ok) throw new Error(`JMAP: sessão recusada (HTTP ${session.status}).`);
  const sessionBody = (await session.json()) as { primaryAccounts?: Record<string, string>; downloadUrl?: string };
  const accountId = sessionBody.primaryAccounts?.["urn:ietf:params:jmap:mail"];
  if (!accountId) throw new Error("JMAP: a caixa não tem conta de e-mail.");

  const res = await fetch(`${opts.baseUrl}/jmap/`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    signal: timeout(),
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
      methodCalls: [
        [
          "Email/query",
          {
            accountId,
            filter: { after: utcDate(opts.since) },
            sort: [{ property: "receivedAt", isAscending: false }],
            limit: 20,
          },
          "q",
        ],
        [
          "Email/get",
          {
            accountId,
            "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
            properties: ["subject", "receivedAt", "textBody", "bodyValues", "attachments"],
            fetchTextBodyValues: true,
          },
          "g",
        ],
      ],
    }),
  });
  if (!res.ok) throw new Error(`JMAP: consulta recusada (HTTP ${res.status}).`);
  const payload = (await res.json()) as { methodResponses?: Array<[string, Record<string, unknown>, string]> };
  const get = payload.methodResponses?.find((r) => r[0] === "Email/get");
  const list = (get?.[1]?.list ?? []) as Array<{
    subject?: string;
    textBody?: JmapBodyPart[];
    attachments?: JmapBodyPart[];
    bodyValues?: Record<string, { value?: string }>;
  }>;

  // Download pelo endereço interno (baseUrl), com o caminho que a sessão
  // anuncia — o host dela é o público, que de dentro da rede pode não servir.
  const template = (sessionBody.downloadUrl ?? "/jmap/download/{accountId}/{blobId}/{name}?accept={type}").replace(
    /^[a-z]+:\/\/[^/]+/i,
    "",
  );
  const mentionsEnvId = async (parts: JmapBodyPart[]): Promise<boolean> => {
    for (const part of parts) {
      if (!part.blobId || !REPORT_PART.test(part.type ?? "")) continue;
      const url =
        opts.baseUrl +
        template
          .replace("{accountId}", encodeURIComponent(accountId))
          .replace("{blobId}", encodeURIComponent(part.blobId))
          .replace("{name}", "aviso")
          .replace("{type}", encodeURIComponent("application/octet-stream"));
      const blob = await fetch(url, { headers: { authorization: auth }, signal: timeout() });
      if (!blob.ok) throw new Error(`JMAP: download do aviso recusado (HTTP ${blob.status}).`);
      if ((await blob.text()).includes(opts.envId)) return true;
    }
    return false;
  };

  for (const email of list) {
    const text = (email.textBody ?? []).map((p) => email.bodyValues?.[p.partId ?? ""]?.value ?? "").join("\n");
    const report = interpretDeliveryReport(email.subject ?? "", text, opts.to);
    // Do destinatário certo, mas de qual mensagem? Só vale se citar o ENVID.
    if (report && (text.includes(opts.envId) || (await mentionsEnvId(email.attachments ?? [])))) return report;
  }
  return null;
}
