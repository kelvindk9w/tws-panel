/**
 * smtp-send.ts — envio do "e-mail de teste" do painel pela submission do
 * próprio Stalwart, autenticado com a caixa postmaster@<domínio>.
 *
 * Cliente SMTP mínimo (sem dependência nova): TLS implícito na porta 465,
 * EHLO, AUTH PLAIN, EHLO de novo, MAIL/RCPT/DATA, QUIT. Uma mensagem, um
 * destinatário.
 *
 * Aviso de entrega (DSN, RFC 3461): quando o servidor anuncia DSN — o
 * Stalwart v0.11.8 anuncia para sessões autenticadas
 * (`session.extensions.dsn`, padrão `!is_empty(authenticated_as)`) — o envio
 * pede NOTIFY=SUCCESS,FAILURE,DELAY e um ENVID. Assim o Stalwart deixa um
 * aviso ("Successfully delivered message" ou "Failed to deliver message") na
 * caixa postmaster@ quando a mensagem sai da fila, e o painel consegue dizer
 * se ela foi aceita ou recusada pelo servidor do destinatário (ver
 * delivery-report.ts). Sem isso, "saiu da fila" não diz nada: o Stalwart
 * remove a mensagem da fila tanto na entrega quanto na recusa definitiva.
 *
 * Certificado: a conexão é do painel com o próprio servidor de e-mail, por
 * dentro da rede Docker (paas-net). O certificado ainda pode ser
 * autoassinado (antes de o Caddy emitir o de mail.<domínio>), e o teste não
 * pode falhar só por isso — a verificação da cadeia fica desligada AQUI. O
 * estado do certificado continua conferido à parte (MailService.tlsStatus),
 * como um app confere.
 */
import { randomBytes } from "node:crypto";
import tls from "node:tls";
import type { Duplex } from "node:stream";

export interface SmtpConnectOptions {
  host: string;
  port: number;
  servername: string;
}

export interface SmtpSendOptions extends SmtpConnectOptions {
  username: string;
  password: string;
  from: string;
  /** Nome de exibição no cabeçalho From (caixa de um projeto). */
  fromName?: string;
  to: string;
  subject: string;
  text: string;
  /** Versão em HTML (opcional): a mensagem vira multipart/alternative, texto + HTML. */
  html?: string;
  /**
   * Pedir o aviso de entrega (DSN) quando o servidor anuncia. Padrão: sim (o
   * e-mail de teste acompanha a entrega por ele). Os avisos do painel
   * (notificações) desligam: cada envio deixaria uma mensagem na postmaster@.
   */
  dsn?: boolean;
  /** Identificador do envio (ENVID do DSN). */
  envId: string;
  messageId: string;
  date?: Date;
  /** Tempo máximo de espera por cada resposta do servidor (padrão 15 s). */
  timeoutMs?: number;
  /** Abre a conexão (padrão: TLS implícito sem verificar a cadeia). Injetável em testes. */
  connect?: (opts: SmtpConnectOptions) => Duplex;
}

export interface SmtpSendResult {
  /** Resposta final do servidor ao DATA (ex.: "250 2.0.0 Message queued for delivery."). */
  response: string;
  /** O servidor aceitou o pedido de aviso de entrega (DSN). */
  dsn: boolean;
}

export class SmtpSendError extends Error {
  constructor(
    /** Código SMTP da resposta (0 = falha de conexão ou tempo esgotado). */
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "SmtpSendError";
  }
}

/** Um endereço só, sem espaço, vírgula, ponto e vírgula, <> nem quebra de linha. */
const ADDRESS_RE = /^[^\s@<>(),;:"[\]\\]+@[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;

export function isSingleEmailAddress(value: string): boolean {
  return value.length <= 254 && ADDRESS_RE.test(value);
}

/** Codificação xtext (RFC 3461 §4) para ENVID e ORCPT. */
export function xtext(value: string): string {
  let out = "";
  for (const ch of Buffer.from(value, "utf8")) {
    out += ch >= 33 && ch <= 126 && ch !== 43 && ch !== 61 ? String.fromCharCode(ch) : `+${ch.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/**
 * Cabeçalho From com nome de exibição (RFC 5322 §3.4). Nome ASCII vai entre
 * aspas, com `"` e `\` escapados; com acento, vira palavras codificadas
 * UTF-8/base64 (RFC 2047) de até 75 caracteres cada, cortadas entre letras
 * (nunca no meio de um caractere), uma por linha dobrada. Quebras de linha
 * são removidas antes de tudo: o nome nunca abre um cabeçalho novo (o schema
 * da rota já recusa \r, \n, < > e aspas — isto é a segunda barreira).
 */
export function formatFromHeader(address: string, name?: string): string {
  const clean = (name ?? "").replace(/[\r\n]+/g, "").trim();
  if (!clean) return `From: ${address}`;
  if (/^[\x20-\x7e]*$/.test(clean)) {
    return `From: "${clean.replace(/[\\"]/g, "\\$&")}" <${address}>`;
  }
  // 45 bytes de UTF-8 → 60 de base64 + 12 de "=?UTF-8?B?" e "?=" = 72 (≤ 75).
  const words: string[] = [];
  let chunk = "";
  for (const ch of clean) {
    if (Buffer.byteLength(chunk + ch, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  words.push(chunk);
  const encoded = words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`);
  return `From: ${encoded.join("\r\n ")}\r\n <${address}>`;
}

/** Corpo em base64, linhas de até 76 caracteres (sem linha começando com ponto). */
function base64Body(value: string): string {
  return Buffer.from(value.replace(/\r?\n/g, "\r\n"), "utf8")
    .toString("base64")
    .replace(/.{1,76}/g, "$&\r\n")
    .trimEnd();
}

/**
 * Mensagem 100% ASCII no fio (corpo em base64). Só texto: text/plain. Com
 * `html`: multipart/alternative, a parte de texto antes da de HTML (o leitor
 * mostra a última alternativa que sabe exibir).
 */
export function buildTestMessage(input: {
  from: string;
  /** Nome de exibição do remetente (caixa de um projeto); ausente = só o endereço. */
  fromName?: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  messageId: string;
  date: Date;
}): string {
  const headers = [
    formatFromHeader(input.from, input.fromName),
    `To: ${input.to}`,
    `Subject: ${encodeHeader(input.subject)}`,
    `Date: ${input.date.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${input.messageId}`,
    "MIME-Version: 1.0",
  ];
  if (input.html === undefined) {
    return [
      ...headers,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "Auto-Submitted: auto-generated",
      "",
      base64Body(input.text),
    ].join("\r\n");
  }
  // base64 nunca contém "=_", então a fronteira não aparece dentro das partes.
  const boundary = `=_tws_${randomBytes(12).toString("hex")}`;
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "Auto-Submitted: auto-generated",
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Body(input.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Body(input.html),
    `--${boundary}--`,
  ].join("\r\n");
}

function defaultConnect(opts: SmtpConnectOptions): Duplex {
  return tls.connect({
    host: opts.host,
    port: opts.port,
    servername: opts.servername,
    // Conexão interna com o próprio servidor (ver o comentário do arquivo).
    rejectUnauthorized: false,
  });
}

/** Lê respostas SMTP (uma ou várias linhas) de um socket. */
class ResponseReader {
  private buffer = "";
  private lines: string[] = [];
  private waiting: { resolve: (r: string) => void; reject: (e: Error) => void } | null = null;
  private ready: string[] = [];
  private failure: Error | null = null;

  constructor(socket: Duplex) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).replace(/\r$/, "");
        this.buffer = this.buffer.slice(idx + 1);
        this.lines.push(line);
        if (/^\d{3}(?: |$)/.test(line)) {
          this.ready.push(this.lines.join("\n"));
          this.lines = [];
          this.flush();
        }
      }
    });
  }

  fail(err: Error): void {
    this.failure ??= err;
    this.flush();
  }

  private flush(): void {
    if (!this.waiting) return;
    const next = this.ready.shift();
    if (next !== undefined) {
      const w = this.waiting;
      this.waiting = null;
      w.resolve(next);
    } else if (this.failure) {
      const w = this.waiting;
      this.waiting = null;
      w.reject(this.failure);
    }
  }

  next(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
      this.flush();
    });
  }
}

/** Código da última linha (a resposta já passou pela leitura, que exige os 3 dígitos). */
function codeOf(response: string): number {
  return Number(response.slice(response.lastIndexOf("\n") + 1, response.lastIndexOf("\n") + 4));
}

/** Texto da resposta sem os códigos (para mensagens de erro). */
function textOf(response: string): string {
  return response
    .split("\n")
    .map((l) => l.slice(4))
    .join(" ")
    .trim();
}

export async function sendSmtpMail(opts: SmtpSendOptions): Promise<SmtpSendResult> {
  if (!isSingleEmailAddress(opts.to) || !isSingleEmailAddress(opts.from)) {
    throw new SmtpSendError(0, "Endereço de e-mail inválido.");
  }
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const socket = (opts.connect ?? defaultConnect)({ host: opts.host, port: opts.port, servername: opts.servername });
  const reader = new ResponseReader(socket);
  socket.on("error", (err: Error) => {
    reader.fail(
      new SmtpSendError(
        0,
        `Não foi possível conectar ao servidor de e-mail (${opts.host}:${opts.port}): ${err.message}.`,
      ),
    );
  });
  socket.on("close", () => reader.fail(new SmtpSendError(0, "O servidor de e-mail fechou a conexão.")));

  const read = async (): Promise<string> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new SmtpSendError(0, "O servidor de e-mail não respondeu a tempo (tempo esgotado).")),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([reader.next(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
  const expect = async (command: string | null, okCodes: number[]): Promise<string> => {
    if (command !== null) socket.write(`${command}\r\n`);
    const response = await read();
    const code = codeOf(response);
    if (!okCodes.includes(code)) {
      const label = command === null ? "conexão" : command.split(" ")[0];
      throw new SmtpSendError(code, `O servidor de e-mail recusou (${label}): ${code} ${textOf(response)}`);
    }
    return response;
  };

  try {
    await expect(null, [220]);
    await expect("EHLO tws-panel", [250]);
    const plain = Buffer.from(`\0${opts.username}\0${opts.password}`, "utf8").toString("base64");
    await expect(`AUTH PLAIN ${plain}`, [235]);
    // O Stalwart só anuncia DSN para sessão autenticada, e a lista do EHLO é
    // calculada na hora do EHLO. Um EHLO novo depois do AUTH mantém a
    // autenticação (o reset da sessão não mexe nela — conferido na v0.11.8)
    // e devolve a lista certa. Visto na validação local com o Stalwart real.
    const ehlo = await expect("EHLO tws-panel", [250]);
    const dsn =
      opts.dsn !== false &&
      ehlo
        .split("\n")
        .map((l) => l.slice(4).toUpperCase())
        .includes("DSN");
    await expect(`MAIL FROM:<${opts.from}>${dsn ? ` RET=HDRS ENVID=${xtext(opts.envId)}` : ""}`, [250]);
    await expect(
      `RCPT TO:<${opts.to}>${dsn ? ` NOTIFY=SUCCESS,FAILURE,DELAY ORCPT=rfc822;${xtext(opts.to)}` : ""}`,
      [250, 251],
    );
    await expect("DATA", [354]);
    const raw = buildTestMessage({
      from: opts.from,
      ...(opts.fromName ? { fromName: opts.fromName } : {}),
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      ...(opts.html !== undefined ? { html: opts.html } : {}),
      messageId: opts.messageId,
      date: opts.date ?? new Date(),
    });
    const response = await expect(`${raw}\r\n.`, [250]);
    socket.write("QUIT\r\n");
    return { response: `${codeOf(response)} ${textOf(response)}`.trim(), dsn };
  } finally {
    // QUIT já foi enviado no sucesso; em qualquer caso, encerra sem esperar.
    setTimeout(() => socket.destroy(), 50).unref();
  }
}
