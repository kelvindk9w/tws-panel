/**
 * send-hook.ts — lê o aviso que o Stalwart v0.11.8 manda ao painel (MTA hook,
 * estágio `data`) quando um app envia uma mensagem por SMTP autenticado.
 *
 * Conferido num Stalwart real: o aviso traz a caixa autenticada
 * (`context.sasl.login`), o id da fila em hexadecimal (`context.queue.id`; o
 * registro e a API da fila usam o mesmo número em decimal), o envelope, os
 * cabeçalhos e o conteúdo inteiro da mensagem. O aviso é DADO NÃO CONFIÁVEL
 * (quem escreveu a mensagem é o app): daqui só saem campos conhecidos, com
 * tamanho limitado. O conteúdo é decodificado só até o limite pedido; anexos
 * nunca são decodificados nem guardados (só nome e tamanho).
 */
import type { MailSendAttachment } from "@paas/core";
import { sanitizeLogText } from "./delivery-log.js";

export interface SendHookMessage {
  /** Id da fila em decimal (o mesmo do registro e da API da fila). */
  queueId: string;
  /** Caixa autenticada na submissão. */
  login: string;
  from: string;
  to: string[];
  size: number;
  messageId: string | null;
  subject: string | null;
  body: string | null;
  bodyTruncated: boolean;
  attachments: MailSendAttachment[];
}

export interface ParseSendHookOptions {
  /** Teto do corpo guardado (bytes UTF-8). */
  maxBodyBytes: number;
  /** Guardar assunto e corpo? false = só metadados (nem decodifica). */
  withContent: boolean;
}

export type ParseSendHookResult = { ok: true; value: SendHookMessage } | { ok: false; reason: string };

const MAX_RCPT = 500;
const MAX_ATTACHMENTS = 20;
const MAX_PARTS = 60;
const MAX_DEPTH = 5;
const MAX_SUBJECT = 998;
const MAX_ADDRESS = 320;

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function address(v: unknown): string | null {
  const o = obj(v);
  const a = o?.address;
  if (typeof a !== "string" || a.length === 0 || a.length > MAX_ADDRESS) return null;
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f\s]/.test(a) ? null : a.toLowerCase();
}

/** "4ab14d0b7ef4000" (hexadecimal do aviso) → "336385483840897024" (decimal do registro). */
export function queueIdFromHex(hex: string): string | null {
  if (!/^[0-9a-fA-F]{1,16}$/.test(hex)) return null;
  return BigInt(`0x${hex}`).toString();
}

// ---------------------------------------------------------------------------
// Cabeçalhos e palavras codificadas (RFC 2047)
// ---------------------------------------------------------------------------

function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset.toLowerCase() === "us-ascii" ? "utf-8" : charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function qpBytes(text: string, header: boolean): Uint8Array {
  const src = header ? text.replace(/_/g, " ") : text;
  const out: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) {
      out.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(...Buffer.from(c, "utf8"));
    }
  }
  return Uint8Array.from(out);
}

/** Decodifica "=?UTF-8?Q?...?=" e "=?...?B?...?=" de um cabeçalho. */
export function decodeHeaderWords(value: string): string {
  const unfolded = value.replace(/\r?\n[ \t]+/g, " ").trim();
  // Palavras codificadas vizinhas: o espaço entre elas não conta.
  const joined = unfolded.replace(/(\?=)\s+(=\?)/g, "$1$2");
  return joined.replace(/=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g, (_m, charset: string, enc: string, text: string) => {
    const cs = charset.split("*")[0]!;
    const bytes = enc.toLowerCase() === "b" ? Uint8Array.from(Buffer.from(text, "base64")) : qpBytes(text, true);
    return decodeBytes(bytes, cs);
  });
}

type Headers = Map<string, string>;

function parseHeaderBlock(block: string): Headers {
  const map: Headers = new Map();
  let current: string | null = null;
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && current) {
      map.set(current, `${map.get(current)} ${line.trim()}`);
      continue;
    }
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    if (!map.has(name)) map.set(name, line.slice(idx + 1).trim());
    current = name;
  }
  return map;
}

/** "multipart/mixed; boundary=\"x\"; charset=utf-8" → tipo e parâmetros. */
function parseParams(value: string | undefined): { main: string; params: Map<string, string> } {
  const parts = (value ?? "").split(";");
  const main = (parts.shift() ?? "").trim().toLowerCase();
  const params = new Map<string, string>();
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx <= 0) continue;
    const key = p.slice(0, idx).trim().toLowerCase();
    let val = p.slice(idx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1).replace(/\\(.)/g, "$1");
    params.set(key, val);
  }
  return { main, params };
}

// ---------------------------------------------------------------------------
// Corpo
// ---------------------------------------------------------------------------

function decodeTransfer(raw: string, encoding: string, charset: string): string {
  const cte = encoding.toLowerCase();
  if (cte === "base64") return decodeBytes(Uint8Array.from(Buffer.from(raw.replace(/\s+/g, ""), "base64")), charset);
  if (cte === "quoted-printable") return decodeBytes(qpBytes(raw.replace(/=\r?\n/g, ""), false), charset);
  return raw;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodedSize(raw: string, encoding: string): number {
  if (encoding.toLowerCase() === "base64") {
    const clean = raw.replace(/\s+/g, "");
    const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((clean.length * 3) / 4) - pad);
  }
  return Buffer.byteLength(raw, "utf8");
}

function safeName(name: string): string {
  return sanitizeLogText(decodeHeaderWords(name), 255) || "—";
}

interface Collected {
  plain: string | null;
  html: string | null;
  attachments: MailSendAttachment[];
  parts: number;
}

function splitHeadersBody(part: string): { headers: Headers; body: string } {
  const m = /\r?\n\r?\n/.exec(part);
  if (!m) return { headers: parseHeaderBlock(part), body: "" };
  return { headers: parseHeaderBlock(part.slice(0, m.index)), body: part.slice(m.index + m[0].length) };
}

function walk(headers: Headers, body: string, depth: number, out: Collected, textBudget: number): void {
  if (out.parts++ > MAX_PARTS || depth > MAX_DEPTH) return;
  const ct = parseParams(headers.get("content-type") ?? "text/plain");
  const disp = parseParams(headers.get("content-disposition"));
  const encoding = (headers.get("content-transfer-encoding") ?? "7bit").trim();
  const boundary = ct.params.get("boundary");

  if (ct.main.startsWith("multipart/") && boundary) {
    const delimiter = `--${boundary}`;
    const chunks = body.split(delimiter);
    // [0] = preâmbulo; o último pedaço começa com "--" (fecho).
    for (const chunk of chunks.slice(1)) {
      if (chunk.startsWith("--")) break;
      const trimmed = chunk.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
      const { headers: h, body: b } = splitHeadersBody(trimmed);
      walk(h, b, depth + 1, out, textBudget);
    }
    return;
  }

  const filename = disp.params.get("filename") ?? ct.params.get("name");
  const isAttachment = disp.main === "attachment" || filename !== undefined || !(ct.main === "text/plain" || ct.main === "text/html");
  if (isAttachment) {
    if (out.attachments.length < MAX_ATTACHMENTS) {
      out.attachments.push({ name: filename ? safeName(filename) : "—", size: decodedSize(body, encoding) });
    }
    return;
  }
  const charset = ct.params.get("charset") ?? "utf-8";
  // Só decodifica o começo: o resto seria descartado pelo teto de qualquer jeito.
  const slice = body.length > textBudget * 4 ? body.slice(0, textBudget * 4) : body;
  // Parte vazia não conta: não impede o texto da próxima.
  const text = ct.main === "text/plain" ? out.plain : out.html;
  if (text !== null) return;
  const decoded = decodeTransfer(slice, encoding, charset);
  if (decoded.trim() === "") return;
  if (ct.main === "text/plain") out.plain = decoded;
  else out.html = decoded;
}

function cutUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

/** Texto e anexos (nome e tamanho) de uma mensagem; corpo cortado em `maxBodyBytes`. */
export function extractBody(
  headers: Headers,
  contents: string,
  maxBodyBytes: number,
): { body: string | null; truncated: boolean; attachments: MailSendAttachment[] } {
  const out: Collected = { plain: null, html: null, attachments: [], parts: 0 };
  walk(headers, contents, 0, out, maxBodyBytes);
  const text = out.plain ?? (out.html !== null ? htmlToText(out.html) : null);
  if (text === null) return { body: null, truncated: false, attachments: out.attachments };
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const cut = cutUtf8(clean, maxBodyBytes);
  return { body: cut.text, truncated: cut.truncated, attachments: out.attachments };
}

// ---------------------------------------------------------------------------
// Aviso completo
// ---------------------------------------------------------------------------

/** Valida o aviso do Stalwart e extrai o que o painel guarda. */
export function parseSendHook(payload: unknown, opts: ParseSendHookOptions): ParseSendHookResult {
  const root = obj(payload);
  if (!root) return { ok: false, reason: "payload" };
  const context = obj(root.context);
  if (!context || context.stage !== "data") return { ok: false, reason: "stage" };
  const login = obj(context.sasl)?.login;
  if (typeof login !== "string" || login.length === 0 || login.length > MAX_ADDRESS) return { ok: false, reason: "login" };
  const queue = obj(context.queue)?.id;
  const queueId = typeof queue === "string" ? queueIdFromHex(queue) : null;
  if (!queueId) return { ok: false, reason: "queue_id" };

  const envelope = obj(root.envelope);
  const fromRaw = obj(envelope?.from)?.address;
  const from = typeof fromRaw === "string" ? address({ address: fromRaw }) : null;
  const rcpts = envelope?.to;
  if (from === null || !Array.isArray(rcpts) || rcpts.length === 0 || rcpts.length > MAX_RCPT) return { ok: false, reason: "envelope" };
  const to: string[] = [];
  for (const r of rcpts) {
    const a = address(r);
    if (a === null) return { ok: false, reason: "envelope" };
    if (!to.includes(a)) to.push(a);
  }

  const message = obj(root.message);
  if (!message || !Array.isArray(message.headers) || typeof message.contents !== "string") return { ok: false, reason: "message" };
  const headers: Headers = new Map();
  for (const pair of message.headers) {
    if (!Array.isArray(pair) || typeof pair[0] !== "string" || typeof pair[1] !== "string") return { ok: false, reason: "message" };
    const name = pair[0].toLowerCase();
    if (!headers.has(name)) headers.set(name, pair[1].replace(/\r?\n$/, "").trim());
  }
  const size = typeof message.size === "number" && Number.isFinite(message.size) && message.size >= 0 ? Math.floor(message.size) : 0;
  const messageId = headers.get("message-id");

  const extracted = extractBody(headers, message.contents, opts.withContent ? opts.maxBodyBytes : 0);
  const subjectRaw = headers.get("subject");
  return {
    ok: true,
    value: {
      queueId,
      login: login.toLowerCase(),
      from,
      to,
      size,
      messageId: messageId ? sanitizeLogText(messageId, 200) : null,
      subject: opts.withContent && subjectRaw !== undefined ? sanitizeLogText(decodeHeaderWords(subjectRaw), MAX_SUBJECT) : null,
      body: opts.withContent ? extracted.body : null,
      bodyTruncated: opts.withContent && extracted.truncated,
      attachments: extracted.attachments,
    },
  };
}
