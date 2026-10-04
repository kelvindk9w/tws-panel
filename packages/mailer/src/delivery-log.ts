/**
 * delivery-log.ts — histórico de entregas a partir do registro (stdout) do
 * Stalwart v0.11.8, lido com `docker logs`.
 *
 * Por que o registro: o Stalwart 0.11.8 tira a mensagem da fila quando
 * termina (entregue ou recusada) e o histórico de rastreio dele
 * (`tracing.history`) é recurso da edição Enterprise. O que sobra, na edição
 * livre, é o registro: com `[tracer.stdout] level = "info"` (o que o painel
 * gera), cada resultado de entrega vira uma linha (conferido no código da tag
 * v0.11.8 — crates/trc/src/serializers/text.rs, event/level.rs,
 * smtp/src/outbound/{delivery,session}.rs, smtp/src/queue/dsn.rs — e num
 * Stalwart real em Docker):
 *
 *   <hora RFC 3339> <NÍVEL> <descrição> (<evento>) chave = valor, chave = valor
 *
 * Os campos da tentativa (queueId, from, to = [lista], size, total) vêm na
 * frente de toda linha da entrega. Os eventos usados:
 *  - delivery.dsn-success  → entregue (uma vez por destinatário);
 *  - delivery.dsn-perm-fail → recusada de vez (inclui a desistência depois de dias);
 *  - queue.rescheduled → adiada; o motivo é a última falha da tentativa:
 *    delivery.rcpt-to-rejected (resposta do destinatário) ou uma falha do
 *    domínio (delivery.connect-error, mx-lookup-failed, greeting-failed…);
 *  - delivery.delivered → só para guardar a resposta do DATA ("250 2.0.0 OK …").
 * Remetente vazio (`from = <>`) é aviso do próprio servidor: fica de fora.
 *
 * Registro é dado NÃO confiável (traz respostas de terceiros): daqui só saem
 * campos conhecidos, texto limitado e sem caracteres de controle. Nada do
 * conteúdo da mensagem aparece no registro (só o envelope).
 */
import type { MailDeliveryEvent } from "@paas/core";

/** Valor de um campo: texto, lista ou outro evento aninhado. */
export type LogValue = string | LogValue[] | LogEventValue;

export interface LogEventValue {
  description: string;
  name: string;
  fields: Array<[string, LogValue]>;
}

export interface StalwartLogLine {
  /** Hora (ISO). */
  at: string;
  level: string;
  /** Ex.: "delivery.dsn-success". */
  event: string;
  description: string;
  fields: Array<[string, LogValue]>;
  /** Último valor do campo (os campos da tentativa vêm antes dos do evento). */
  get(key: string): LogValue | undefined;
  all(key: string): LogValue[];
}

/** Tamanho máximo de um texto guardado. */
export const MAX_LOG_DETAIL = 300;

const HEADER =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+(.*?)\s\(([a-z0-9-]+\.[a-z0-9-]+)\)(?:\s(.*))?$/;
const KEY = /([A-Za-z][A-Za-z0-9]*) = /y;
const KEY_BOUNDARY = /, [A-Za-z][A-Za-z0-9]* = /y;
const EVENT_VALUE = /^(.*?) \(([a-z0-9-]+\.[a-z0-9-]+)\)(?: \{ ([\s\S]*) \})?$/;

/** Remove cores e caracteres de controle, junta espaços e limita o tamanho. */
export function sanitizeLogText(text: string, max = MAX_LOG_DETAIL): string {
  const clean = text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function boundaryAt(re: RegExp, s: string, i: number): boolean {
  re.lastIndex = i;
  return re.test(s);
}

/** A aspa em `k` fecha o texto? (o Stalwart não escapa aspas dentro do texto) */
function closesQuote(s: string, k: number, inList: boolean): boolean {
  const next = k + 1;
  if (next >= s.length) return true;
  if (inList) return s[next] === "]" || s.startsWith(", ", next);
  return boundaryAt(KEY_BOUNDARY, s, next);
}

function unescape(text: string): string {
  return text.replace(/\\([nrt\\])/g, (_m, c: string) => ({ n: "\n", r: "\r", t: "\t" })[c] ?? "\\");
}

function readQuoted(s: string, i: number, inList: boolean): [string, number] {
  let k = s.indexOf('"', i + 1);
  while (k !== -1 && !closesQuote(s, k, inList)) k = s.indexOf('"', k + 1);
  const end = k === -1 ? s.length : k;
  return [unescape(s.slice(i + 1, end)), Math.min(end + 1, s.length)];
}

function readUnquoted(s: string, i: number, inList: boolean): [LogValue, number] {
  let depth = 0;
  let j = i;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    if (depth > 0) continue;
    if (inList ? c === "]" || s.startsWith(", ", j) : boundaryAt(KEY_BOUNDARY, s, j)) break;
  }
  const raw = s.slice(i, j);
  const ev = EVENT_VALUE.exec(raw);
  if (!ev) return [raw, j];
  return [{ description: ev[1]!, name: ev[2]!, fields: ev[3] ? parseFields(ev[3]) : [] }, j];
}

function readList(s: string, i: number): [LogValue[], number] {
  const items: LogValue[] = [];
  let j = i + 1;
  while (j < s.length && s[j] !== "]") {
    const [value, next] = readValue(s, j, true);
    items.push(value);
    j = s.startsWith(", ", next) ? next + 2 : next;
  }
  return [items, j + 1];
}

function readValue(s: string, i: number, inList: boolean): [LogValue, number] {
  if (s[i] === '"') return readQuoted(s, i, inList);
  if (s[i] === "[") return readList(s, i);
  return readUnquoted(s, i, inList);
}

function parseFields(s: string): Array<[string, LogValue]> {
  const fields: Array<[string, LogValue]> = [];
  let i = 0;
  while (i < s.length) {
    KEY.lastIndex = i;
    const m = KEY.exec(s);
    if (!m) break;
    const [value, next] = readValue(s, i + m[0].length, false);
    fields.push([m[1]!, value]);
    if (!s.startsWith(", ", next)) break;
    i = next + 2;
  }
  return fields;
}

/** Lê uma linha do registro do Stalwart; null = não é do formato. */
export function parseStalwartLogLine(raw: string): StalwartLogLine | null {
  const m = HEADER.exec(sanitizeAnsi(raw));
  if (!m) return null;
  const fields = parseFields(m[5] ?? "");
  return {
    at: new Date(m[1]!).toISOString(),
    level: m[2]!,
    description: m[3]!,
    event: m[4]!,
    fields,
    get: (key) => fields.filter(([k]) => k === key).at(-1)?.[1],
    all: (key) => fields.filter(([k]) => k === key).map(([, v]) => v),
  };
}

function sanitizeAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

/** Texto legível de um valor (evento aninhado: "detalhe: motivo"). */
export function logValueText(value: LogValue | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(logValueText).join(", ");
  const parts = ["details", "reason"]
    .map((k) => value.fields.find(([key]) => key === k)?.[1])
    .filter((v): v is LogValue => v !== undefined)
    .map(logValueText);
  return parts.length > 0 ? parts.join(": ") : value.description;
}

/** Só estas linhas interessam ao histórico (filtro barato antes do parse). */
export function isDeliveryLogLine(line: string): boolean {
  return /\((delivery\.[a-z-]+|queue\.rescheduled)\)/.test(line);
}

/** Eventos da entrega que não são falha nem resultado. */
const NOT_FAILURES = new Set([
  "delivery.attempt-start",
  "delivery.attempt-end",
  "delivery.domain-delivery-start",
  "delivery.connect",
  "delivery.start-tls",
  "delivery.start-tls-unavailable",
  "delivery.start-tls-disabled",
  "delivery.delivered",
  "delivery.completed",
  "delivery.dsn-success",
  "delivery.dsn-temp-fail",
  "delivery.dsn-perm-fail",
  "delivery.mx-lookup",
  "delivery.ip-lookup",
  "delivery.ehlo",
  "delivery.auth",
  "delivery.mail-from",
  "delivery.rcpt-to",
  "delivery.raw-input",
  "delivery.raw-output",
  "delivery.double-bounce",
]);

interface Response {
  code: number | null;
  detail: string | null;
  host: string | null;
}

interface Track {
  /** Domínios tentados nesta tentativa. */
  attempted: Set<string>;
  rcptFail: Map<string, Response>;
  domainFail: Map<string, Response>;
  anyFail: Response | null;
  delivered: Map<string, Response>;
  /** Destinatários com resultado final já registrado (não duplica). */
  finalized: Set<string>;
}

function text(value: LogValue | undefined): string | null {
  return typeof value === "string" && value !== "(null)" ? value : null;
}

function responseOf(line: StalwartLogLine): Response {
  const code = text(line.get("code"));
  const raw = line.get("details") ?? line.get("causedBy") ?? line.get("reason");
  const detail = sanitizeLogText(raw === undefined ? line.description : logValueText(raw));
  return {
    code: code && /^\d{3}$/.test(code) ? Number(code) : null,
    detail: detail || null,
    host: text(line.get("hostname")),
  };
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

function isoOrNull(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export interface DeliveryLogReaderOptions {
  /** Quantas mensagens acompanhar ao mesmo tempo (as mais antigas são esquecidas). */
  maxTracked?: number;
}

/**
 * Transforma as linhas do registro, em ordem, em eventos do histórico. Guarda
 * em memória o que cada tentativa já disse (motivo da falha, resposta do
 * DATA) até a linha que fecha a tentativa.
 */
export class DeliveryLogReader {
  private readonly tracked = new Map<string, Track>();
  private readonly maxTracked: number;

  constructor(opts: DeliveryLogReaderOptions = {}) {
    this.maxTracked = opts.maxTracked ?? 5000;
  }

  private track(queueId: string): Track {
    let t = this.tracked.get(queueId);
    if (t) {
      this.tracked.delete(queueId);
    } else {
      t = { attempted: new Set(), rcptFail: new Map(), domainFail: new Map(), anyFail: null, delivered: new Map(), finalized: new Set() };
    }
    this.tracked.set(queueId, t);
    if (this.tracked.size > this.maxTracked) this.tracked.delete(this.tracked.keys().next().value!);
    return t;
  }

  push(raw: string): MailDeliveryEvent[] {
    if (!isDeliveryLogLine(raw)) return [];
    const line = parseStalwartLogLine(raw);
    if (!line) return [];
    const queueId = text(line.all("queueId")[0]);
    const from = text(line.all("from")[0]);
    if (!queueId || !from || from === "<>") return [];
    const pending = line.all("to").find(Array.isArray)?.filter((v): v is string => typeof v === "string") ?? [];
    const rcpt = text(line.all("to").filter((v) => typeof v === "string").at(-1));
    const t = this.track(queueId);

    const event = (to: string, state: MailDeliveryEvent["state"], r: Response, nextRetryAt: string | null = null): MailDeliveryEvent => ({
      at: line.at,
      queueId,
      from,
      to,
      toDomain: domainOf(to),
      state,
      code: r.code,
      detail: r.detail,
      remoteHost: r.host,
      nextRetryAt,
    });
    const resetAttempt = () => {
      t.attempted.clear();
      t.rcptFail.clear();
      t.domainFail.clear();
      t.anyFail = null;
      t.delivered.clear();
    };

    switch (line.event) {
      case "delivery.attempt-start":
        resetAttempt();
        return [];
      case "delivery.domain-delivery-start": {
        const domain = text(line.get("domain"));
        if (domain) t.attempted.add(domain.toLowerCase());
        return [];
      }
      case "delivery.delivered":
        if (rcpt) t.delivered.set(rcpt.toLowerCase(), responseOf(line));
        return [];
      case "delivery.dsn-success":
      case "delivery.dsn-perm-fail": {
        if (!rcpt) return [];
        const to = rcpt.toLowerCase();
        if (t.finalized.has(to)) return [];
        t.finalized.add(to);
        if (line.event === "delivery.dsn-success") return [event(to, "delivered", t.delivered.get(to) ?? responseOf(line))];
        return [event(to, "bounced", responseOf(line))];
      }
      case "queue.rescheduled": {
        const none: Response = { code: null, detail: null, host: null };
        const nextRetryAt = isoOrNull(text(line.get("nextRetry")));
        const out = pending
          .map((a) => a.toLowerCase())
          .filter((to) => !t.finalized.has(to) && (t.attempted.size === 0 || t.attempted.has(domainOf(to))))
          .map((to) => event(to, "deferred", t.rcptFail.get(to) ?? t.domainFail.get(domainOf(to)) ?? t.anyFail ?? none, nextRetryAt));
        resetAttempt();
        return out;
      }
      default: {
        if (NOT_FAILURES.has(line.event) || !line.event.startsWith("delivery.")) return [];
        const r = responseOf(line);
        const domain = text(line.get("domain"));
        if (rcpt) t.rcptFail.set(rcpt.toLowerCase(), r);
        else if (domain) t.domainFail.set(domain.toLowerCase(), r);
        else t.anyFail = r;
        return [];
      }
    }
  }
}
