/**
 * refusal-log.ts — tentativas de envio RECUSADAS antes da fila, lidas do mesmo registro (stdout) do Stalwart que
 * alimenta o histórico de entregas (delivery-log.ts).
 *
 * O aviso de envio (MTA hook) só existe para o que chegou à fase DATA com login: senha errada, falha de TLS e
 * remetente não permitido nunca chegam lá e ficavam invisíveis. Com `[tracer.stdout] level = "info"` (o que o painel
 * gera) o Stalwart escreve uma linha para cada um desses eventos, no mesmo formato das linhas de entrega:
 *
 *   <hora> INFO <descrição> (<evento>) listenerId = "submission", remoteIp = ..., id = "<login>", ...
 *
 * Os nomes dos eventos abaixo são os do código do Stalwart v0.11 (crates/trc, enum EventType em kebab-case). Os
 * CAMPOS de cada evento variam; por isso o login é procurado em alguns nomes de campo conhecidos e só vale se
 * parecer um endereço de e-mail. Nada além do tipo, da hora e do login sai daqui (nem IP, nem texto livre do
 * cliente: o registro é dado de terceiros).
 */
import type { MailRefusalKind, MailRefusalOrigin } from "@paas/core";
import { logValueText, parseStalwartLogLine } from "./delivery-log.js";

/** Evento do Stalwart → tipo da recusa. */
export const REFUSAL_EVENTS: Readonly<Record<string, MailRefusalKind>> = {
  "auth.failed": "auth_failed",
  "auth.too-many-attempts": "auth_banned",
  "security.authentication-ban": "auth_banned",
  "smtp.auth-not-allowed": "auth_not_allowed",
  "smtp.auth-mechanism-not-supported": "auth_not_allowed",
  "smtp.auth-exchange-too-long": "auth_not_allowed",
  "tls.handshake-error": "tls_error",
  "smtp.mail-from-unauthorized": "sender_not_allowed",
  "smtp.mail-from-not-allowed": "sender_not_allowed",
  "smtp.mail-from-unauthenticated": "relay_not_allowed",
  "smtp.relay-not-allowed": "relay_not_allowed",
  "smtp.rate-limit-exceeded": "rate_limited",
  "smtp.concurrency-limit-exceeded": "rate_limited",
  "smtp.message-too-large": "message_too_large",
};

/** Campos onde o Stalwart costuma pôr o nome da conta que tentou entrar. */
const LOGIN_FIELDS = ["accountName", "id", "name", "authenticatedAs", "details"] as const;

/** Parece um endereço de e-mail simples (sem espaço, aspas nem sinais de lista). */
const LOGIN_RE = /^[^\s@<>"',;()[\]\\]{1,128}@[A-Za-z0-9.-]{1,255}$/;

/**
 * Ouvidos de ENVIO do Stalwart. Recusas de outros ouvidos (IMAP, webmail, administração) não dizem nada sobre o app
 * enviando e-mail: um login errado no webmail não é "o app falhou". Ouvido ausente no registro = não filtra.
 */
export const SUBMISSION_LISTENERS: ReadonlySet<string> = new Set(["submission", "submissions", "smtp", "smtps"]);

/**
 * O endereço é da rede interna (loopback, privados 10/8, 172.16/12, 192.168/16, link-local, ULA fc00::/7)? É onde ficam
 * o painel e os apps dos projetos (rede Docker). Aceita "ip", "ip:porta" e "[ipv6]:porta". Não guarda nada.
 */
export function isInternalAddress(raw: string): boolean {
  let ip = raw.trim().toLowerCase();
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracket) ip = bracket[1]!;
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":"));
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (ip === "::1") return true;
  return /^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip);
}

export interface ParsedRefusal {
  /** ISO 8601. */
  at: string;
  kind: MailRefusalKind;
  origin: MailRefusalOrigin;
  login: string | null;
}

const EVENT_RE = /\(([a-z0-9-]+\.[a-z0-9-]+)\)/;

/** Filtro barato antes do parse: a linha é de um evento de recusa conhecido? */
export function isRefusalLogLine(line: string): boolean {
  const m = EVENT_RE.exec(line);
  return m !== null && Object.prototype.hasOwnProperty.call(REFUSAL_EVENTS, m[1]!);
}

/** Lê uma linha do registro; null = não é recusa conhecida. */
export function parseRefusalLine(raw: string): ParsedRefusal | null {
  if (!isRefusalLogLine(raw)) return null;
  const line = parseStalwartLogLine(raw);
  if (!line) return null;
  const kind = REFUSAL_EVENTS[line.event];
  if (!kind) return null;
  const listener = logValueText(line.get("listenerId")).trim().toLowerCase();
  if (listener && !SUBMISSION_LISTENERS.has(listener)) return null;
  const remote = logValueText(line.get("remoteIp")).trim();
  const origin: MailRefusalOrigin = remote ? (isInternalAddress(remote) ? "internal" : "external") : "unknown";
  let login: string | null = null;
  for (const field of LOGIN_FIELDS) {
    for (const value of line.all(field)) {
      const text = logValueText(value).trim().toLowerCase();
      if (LOGIN_RE.test(text)) {
        login = text;
        break;
      }
    }
    if (login) break;
  }
  return { at: line.at, kind, origin, login };
}
