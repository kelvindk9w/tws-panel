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
import { BlockList, isIP } from "node:net";
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

/** Tira porta, colchetes e o prefixo ::ffff: de IPv4 mapeado. */
export function normalizeAddress(raw: string): string {
  let ip = raw.trim().toLowerCase();
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracket) ip = bracket[1]!;
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(":"));
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return ip;
}

/**
 * Plano B, SÓ quando não se sabe as redes do Docker: o endereço é privado (loopback, 10/8, 172.16/12, 192.168/16,
 * link-local, ULA fc00::/7)? Não distingue o gateway da rede (que é por onde clientes da internet aparecem quando o
 * Docker usa o proxy em espaço de usuário), por isso o caminho normal usa classifyOrigin com as redes de verdade.
 */
export function isInternalAddress(raw: string): boolean {
  const ip = normalizeAddress(raw);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (ip === "::1") return true;
  return /^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip);
}

/** Uma rede Docker por onde os apps e o painel falam com o servidor de e-mail. */
export interface MailNetwork {
  /** CIDR, ex.: "172.20.0.0/16". */
  subnet: string;
  /** Endereço do gateway da rede (por ele passam os clientes da internet no proxy em espaço de usuário); null = não informado. */
  gateway: string | null;
}

function inSubnet(ip: string, subnet: string): boolean {
  const m = /^([^/]+)\/(\d{1,3})$/.exec(subnet);
  if (!m) return false;
  const family = isIP(m[1]!);
  const addrFamily = isIP(ip);
  if (family === 0 || addrFamily !== family) return false;
  const list = new BlockList();
  try {
    list.addSubnet(m[1]!, Number(m[2]), family === 4 ? "ipv4" : "ipv6");
    return list.check(ip, family === 4 ? "ipv4" : "ipv6");
  } catch {
    return false;
  }
}

/**
 * De onde veio a conexão, sem guardar o endereço:
 *  - dentro da sub-rede de uma rede do e-mail e diferente do gateway → internal (container do painel ou de um app);
 *  - igual ao gateway → unknown (no proxy em espaço de usuário os clientes da internet, em especial IPv6, chegam com
 *    o endereço do gateway: não dá para dizer que é o app);
 *  - qualquer outro endereço → external;
 *  - sem `networks` (ou vazio): plano B por faixa privada (isInternalAddress), sem tratar o gateway.
 */
export function classifyOrigin(remote: string, networks?: readonly MailNetwork[] | null): MailRefusalOrigin {
  if (!remote.trim()) return "unknown";
  const ip = normalizeAddress(remote);
  if (!networks || networks.length === 0) return isInternalAddress(ip) ? "internal" : "external";
  let inside = false;
  for (const n of networks) {
    if (!inSubnet(ip, n.subnet)) continue;
    if (n.gateway && normalizeAddress(n.gateway) === ip) return "unknown";
    inside = true;
  }
  return inside ? "internal" : "external";
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
export function parseRefusalLine(raw: string, networks?: readonly MailNetwork[] | null): ParsedRefusal | null {
  if (!isRefusalLogLine(raw)) return null;
  const line = parseStalwartLogLine(raw);
  if (!line) return null;
  const kind = REFUSAL_EVENTS[line.event];
  if (!kind) return null;
  const listener = logValueText(line.get("listenerId")).trim().toLowerCase();
  if (listener && !SUBMISSION_LISTENERS.has(listener)) return null;
  const remote = logValueText(line.get("remoteIp")).trim();
  const origin: MailRefusalOrigin = classifyOrigin(remote, networks);
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
