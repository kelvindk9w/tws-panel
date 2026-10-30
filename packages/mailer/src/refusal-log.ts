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
import type { MailRefusalKind } from "@paas/core";
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

export interface ParsedRefusal {
  /** ISO 8601. */
  at: string;
  kind: MailRefusalKind;
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
  return { at: line.at, kind, login };
}
