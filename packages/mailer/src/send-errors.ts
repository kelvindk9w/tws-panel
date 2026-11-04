/**
 * send-errors.ts — traduz o motivo de uma falha de entrega (resposta SMTP do
 * destino, falha de DNS, TLS, conexão) em um TIPO que a tela explica em
 * linguagem de gente. O texto original segue junto ("Detalhes técnicos").
 *
 * O texto vem de terceiros (o servidor do destinatário): só procuramos
 * códigos e palavras conhecidas; nada dele é executado ou confiado.
 */
import type { MailSendErrorKind, MailSendFailure, MailSendState } from "@paas/core";
import { sanitizeLogText } from "./delivery-log.js";

const ENHANCED = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/;

interface Rule {
  kind: MailSendErrorKind;
  test: (text: string, enhanced: string | null, code: number | null) => boolean;
}

const has = (re: RegExp) => (text: string) => re.test(text);

/** A primeira regra que casar vale: da mais específica para a mais geral. */
const RULES: Rule[] = [
  { kind: "no_mx", test: has(/no mx records|record not found for mx|nullmx|null mx|does not accept mail|domain does not have/i) },
  { kind: "dns_failure", test: has(/\bdns\b|nxdomain|name or service not known|no such host|failed to lookup|could not resolve|record not found|lookup failed|temporary failure in name resolution|domain (not found|name not found)/i) },
  { kind: "tls_failure", test: has(/\btls\b|\bssl\b|certificate|handshake|starttls|mta-sts/i) },
  { kind: "timeout", test: has(/time(d)?[ -]?out|timeout|deadline/i) },
  { kind: "connection_failed", test: has(/connection (refused|reset|closed|error|failed)|unreachable|econn|broken pipe|no route to host|connect error|connection to .* failed/i) },
  { kind: "expired", test: has(/queue rate limit exceeded|expired|giving up|gave up|too long in the queue|delivery time exceeded/i) },
  { kind: "mailbox_full", test: (t, e) => e === "5.2.2" || e === "4.2.2" || /over quota|mailbox (is )?full|quota exceeded|storage (limit|full)|insufficient system storage/i.test(t) },
  { kind: "message_too_large", test: (t, e) => e === "5.3.4" || e === "5.2.3" || /message (size|is) (exceeds|too (large|big))|too large|too big|exceeds (the )?(maximum |max )?(message )?size/i.test(t) },
  { kind: "no_such_user", test: (t, e) => e === "5.1.1" || e === "5.1.10" || /user unknown|unknown user|no such user|does not exist|recipient (address )?rejected|invalid recipient|mailbox unavailable|address rejected|unknown recipient|no mailbox here/i.test(t) },
  { kind: "sender_auth", test: (t, e) => e === "5.7.26" || e === "5.7.23" || e === "5.7.25" || /\bspf\b|\bdkim\b|\bdmarc\b|sender (policy|authentication)|not authenticated|unauthenticated|authentication required|reverse dns|\bptr\b/i.test(t) },
  { kind: "blocklisted", test: (t, e) => e === "5.7.511" || e === "5.7.512" || /s3150|banned sending ip|blocked using|\blisted\b|blocklist|blacklist|spamhaus|barracuda|\brbl\b|dnsbl|spamcop|sorbs|ip (address )?(has been )?(blocked|banned)/i.test(t) },
  { kind: "rate_limited", test: (t, e) => e === "4.7.28" || /too many|rate ?limit|throttl|tss04|unusual rate|exceeded|slow down|4\.7\.0/i.test(t) },
  { kind: "spam_content", test: has(/spam|junk|unsolicited|suspicious|content rejected|bulk|phishing|malware|virus/i) },
  { kind: "greylisted", test: has(/grey ?list|gray ?list|try again later|come back later|temporarily deferred|temporarily rejected/i) },
  { kind: "policy_rejected", test: (t, e) => (e?.startsWith("5.7.") ?? false) || /policy|not allowed|denied|refused|administrative prohibition|relay/i.test(t) },
];

/** Código SMTP de três dígitos no começo do texto ("550 5.1.1 …"), quando houver. */
function codeFrom(text: string): number | null {
  const m = /^\s*([245]\d{2})[ -]/.exec(text);
  return m ? Number(m[1]) : null;
}

/** Classifica uma resposta/falha. `code` vem do registro quando ele separou. */
export function explainSendFailure(input: { code: number | null; detail: string | null }): MailSendFailure {
  const technical = sanitizeLogText(input.detail ?? "");
  const enh = ENHANCED.exec(technical);
  const enhanced = enh ? enh[0] : null;
  const code = input.code ?? codeFrom(technical);
  const hit = RULES.find((r) => r.test(technical, enhanced, code));
  let kind: MailSendErrorKind;
  if (hit) kind = hit.kind;
  else if (code !== null && code >= 500) kind = "rejected_other";
  else if (code !== null && code >= 400) kind = "temporary";
  else if (enhanced?.startsWith("5.")) kind = "rejected_other";
  else if (enhanced?.startsWith("4.")) kind = "temporary";
  else kind = "unknown";
  return { kind, code, enhanced, technical };
}

/**
 * Estado de um destinatário que o registro de entrega marcou como "bounced":
 * `rejected` quando o servidor do destino respondeu com recusa definitiva
 * (5xx), `failed` quando não deu nem para conversar (DNS, conexão, TLS) ou o
 * servidor desistiu depois de tentar por dias.
 */
export function failureState(failure: MailSendFailure): Extract<MailSendState, "failed" | "rejected"> {
  const refused = (failure.code !== null && failure.code >= 500) || (failure.enhanced?.startsWith("5.") ?? false);
  const transport: MailSendFailure["kind"][] = ["no_mx", "dns_failure", "tls_failure", "timeout", "connection_failed", "expired"];
  return refused && !transport.includes(failure.kind) ? "rejected" : "failed";
}
