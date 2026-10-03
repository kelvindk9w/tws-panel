/**
 * Testes do envio SMTP do e-mail de teste (smtp-send.ts) contra um servidor
 * SMTP falso em TCP puro (a conexão é injetada; em produção é TLS na 465).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTestMessage, sendSmtpMail, SmtpSendError, xtext, type SmtpSendOptions } from "../src/smtp-send.js";

interface FakeServerOptions {
  /** Servidor com TLS implícito (como a 465 do Stalwart). */
  tls?: { cert: string; key: string };
  ehlo?: string[];
  /** Resposta para cada comando (prefixo) — padrão: sucesso. */
  replies?: Record<string, string>;
}

interface FakeServer {
  port: number;
  commands: string[];
  data: string;
  close: () => Promise<void>;
}

const servers: FakeServer[] = [];

async function fakeSmtp(opts: FakeServerOptions = {}): Promise<FakeServer> {
  const commands: string[] = [];
  const state = { data: "" };
  const handler = (socket: net.Socket) => {
    let buffer = "";
    let inData = false;
    socket.write("220 mail.exemplo.com.br ESMTP Stalwart\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          state.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write(opts.replies?.["."] ?? "250 2.0.0 Message queued for delivery.\r\n");
          continue;
        }
        const idx = buffer.indexOf("\r\n");
        if (idx < 0) return;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        commands.push(line);
        const verb = line.split(/[ :]/)[0]!.toUpperCase();
        const custom = Object.entries(opts.replies ?? {}).find(([k]) => k !== "." && line.toUpperCase().startsWith(k));
        if (custom) {
          socket.write(custom[1]);
          continue;
        }
        if (verb === "EHLO") {
          const ext = opts.ehlo ?? ["PIPELINING", "AUTH PLAIN LOGIN", "DSN", "8BITMIME"];
          socket.write(["250-mail.exemplo.com.br", ...ext.slice(0, -1).map((e) => `250-${e}`), `250 ${ext.at(-1)}`].join("\r\n") + "\r\n");
        } else if (verb === "AUTH") {
          socket.write("235 2.7.0 Authentication succeeded.\r\n");
        } else if (verb === "MAIL" || verb === "RCPT") {
          socket.write("250 2.1.0 OK\r\n");
        } else if (verb === "DATA") {
          inData = true;
          socket.write("354 Start mail input; end with <CRLF>.<CRLF>\r\n");
        } else if (verb === "QUIT") {
          socket.end("221 2.0.0 Bye.\r\n");
        } else {
          socket.write("500 5.5.1 Unknown command\r\n");
        }
      }
    });
  };
  const server = opts.tls ? tls.createServer(opts.tls, handler) : net.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const fake: FakeServer = {
    port: (server.address() as net.AddressInfo).port,
    commands,
    get data() {
      return state.data;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  } as FakeServer;
  servers.push(fake);
  return fake;
}

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

function options(port: number, overrides: Partial<SmtpSendOptions> = {}): SmtpSendOptions {
  return {
    host: "127.0.0.1",
    port,
    servername: "mail.exemplo.com.br",
    username: "postmaster@exemplo.com.br",
    password: "senha-forte",
    from: "postmaster@exemplo.com.br",
    to: "pessoa@gmail.com",
    subject: "Teste do TWS Panel",
    text: "Olá!\nLinha começando com ponto:\n.oculta",
    envId: "tws-teste-abc123",
    messageId: "<tws-teste-abc123@exemplo.com.br>",
    date: new Date("2026-10-01T12:00:00Z"),
    connect: (o) => net.connect({ host: o.host, port: o.port }),
    ...overrides,
  };
}

describe("sendSmtpMail", () => {
  it("autentica, pede aviso de entrega (DSN) e entrega a mensagem", async () => {
    const server = await fakeSmtp();
    const result = await sendSmtpMail(options(server.port));

    expect(result.response).toContain("queued");
    expect(result.dsn).toBe(true);
    const plain = Buffer.from("\0postmaster@exemplo.com.br\0senha-forte").toString("base64");
    await vi.waitFor(() => expect(server.commands).toContain("QUIT"));
    expect(server.commands).toEqual([
      expect.stringMatching(/^EHLO /),
      `AUTH PLAIN ${plain}`,
      // o Stalwart só anuncia DSN para sessão autenticada: EHLO de novo após o AUTH
      expect.stringMatching(/^EHLO /),
      "MAIL FROM:<postmaster@exemplo.com.br> RET=HDRS ENVID=tws-teste-abc123",
      "RCPT TO:<pessoa@gmail.com> NOTIFY=SUCCESS,FAILURE,DELAY ORCPT=rfc822;pessoa@gmail.com",
      "DATA",
      "QUIT",
    ]);
    expect(server.data).toContain("Subject: Teste do TWS Panel");
    expect(server.data).toContain("Message-ID: <tws-teste-abc123@exemplo.com.br>");
    expect(server.data).toContain("Content-Transfer-Encoding: base64");
  });

  it("TLS de verdade com certificado AUTOASSINADO (padrão do painel): o teste não falha por isso", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paas-smtp-tls-"));
    try {
      execFileSync(
        "openssl",
        [
          "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
          "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "2",
          "-subj", "/CN=paas-stalwart",
        ],
        { stdio: "ignore" },
      );
      const server = await fakeSmtp({
        tls: { cert: readFileSync(path.join(dir, "c.pem"), "utf8"), key: readFileSync(path.join(dir, "k.pem"), "utf8") },
      });
      // sem `connect`: usa o padrão do painel (TLS implícito)
      const { connect: _c, ...withoutConnect } = options(server.port);
      const result = await sendSmtpMail(withoutConnect);
      expect(result.response).toBe("250 2.0.0 Message queued for delivery.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saudação diferente de 220: erro citando a conexão", async () => {
    const server = await fakeSmtp();
    const err = await sendSmtpMail(
      options(server.port, {
        connect: (o) => {
          const socket = net.connect({ host: o.host, port: o.port });
          // troca a saudação por uma recusa
          const original = socket.emit.bind(socket);
          socket.emit = ((event: string, ...args: unknown[]) =>
            event === "data" && String(args[0]).startsWith("220")
              ? original("data", Buffer.from("554 5.3.2 Ocupado\r\n"))
              : original(event, ...args)) as typeof socket.emit;
          return socket;
        },
      }),
    ).catch((e: unknown) => e);
    expect((err as SmtpSendError).code).toBe(554);
    expect((err as Error).message).toContain("conexão");
  });

  it("DSN anunciado só depois do AUTH (como o Stalwart faz): pede o aviso de entrega", async () => {
    const server = await fakeSmtp();
    let ehloCount = 0;
    const result = await sendSmtpMail(
      options(server.port, {
        connect: (o) => {
          const socket = net.connect({ host: o.host, port: o.port });
          const original = socket.emit.bind(socket);
          // primeira resposta de EHLO (antes do AUTH) sem a linha DSN
          socket.emit = ((event: string, ...args: unknown[]) => {
            if (event === "data" && String(args[0]).startsWith("250-mail.exemplo.com.br") && ehloCount++ === 0) {
              return original("data", Buffer.from(String(args[0]).replace("250-DSN\r\n", "")));
            }
            return original(event, ...args);
          }) as typeof socket.emit;
          return socket;
        },
      }),
    );
    expect(result.dsn).toBe(true);
    expect(server.commands).toContain("MAIL FROM:<postmaster@exemplo.com.br> RET=HDRS ENVID=tws-teste-abc123");
  });

  it("sem data informada, a mensagem sai com a hora atual no cabeçalho Date", async () => {
    const server = await fakeSmtp();
    await sendSmtpMail(options(server.port, { date: undefined }));
    expect(server.data).toMatch(/^Date: .+\d{4} \d{2}:\d{2}:\d{2}/m);
  });

  it("sem DSN anunciado, envia sem os parâmetros de aviso", async () => {
    const server = await fakeSmtp({ ehlo: ["AUTH PLAIN"] });
    const result = await sendSmtpMail(options(server.port));
    expect(result.dsn).toBe(false);
    expect(server.commands).toContain("MAIL FROM:<postmaster@exemplo.com.br>");
    expect(server.commands).toContain("RCPT TO:<pessoa@gmail.com>");
  });

  it("senha recusada vira erro com a resposta do servidor", async () => {
    const server = await fakeSmtp({ replies: { AUTH: "535 5.7.8 Authentication credentials invalid.\r\n" } });
    const err = await sendSmtpMail(options(server.port)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmtpSendError);
    expect((err as SmtpSendError).code).toBe(535);
    expect((err as SmtpSendError).message).toContain("Authentication credentials invalid");
  });

  it("destinatário recusado na hora vira erro", async () => {
    const server = await fakeSmtp({ replies: { RCPT: "550 5.1.2 Relay not allowed.\r\n" } });
    await expect(sendSmtpMail(options(server.port))).rejects.toMatchObject({ code: 550 });
  });

  it("servidor que não responde: erro de tempo esgotado", async () => {
    const silent = net.createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const port = (silent.address() as net.AddressInfo).port;
    try {
      await expect(sendSmtpMail(options(port, { timeoutMs: 100 }))).rejects.toThrow(/tempo/i);
    } finally {
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });

  it("conexão recusada vira erro legível", async () => {
    const server = await fakeSmtp();
    const port = server.port;
    await server.close();
    servers.length = 0;
    await expect(sendSmtpMail(options(port))).rejects.toThrow(/conectar/i);
  });

  it("recusa endereço com quebra de linha ou mais de um destinatário (injeção de comando)", async () => {
    await expect(sendSmtpMail(options(1, { to: "a@b.com\r\nRCPT TO:<c@d.com>" }))).rejects.toThrow(/inválido/);
    await expect(sendSmtpMail(options(1, { to: "a@b.com, c@d.com" }))).rejects.toThrow(/inválido/);
  });
});

describe("buildTestMessage", () => {
  it("cabeçalhos ASCII, assunto UTF-8 codificado e corpo em base64 (sem linha começando com ponto)", () => {
    const raw = buildTestMessage({
      from: "postmaster@exemplo.com.br",
      to: "pessoa@gmail.com",
      subject: "Teste do TWS Panel — ação",
      text: "Olá\n.ponto",
      messageId: "<x@exemplo.com.br>",
      date: new Date("2026-10-01T12:00:00Z"),
    });
    expect(/^[\x00-\x7f]*$/.test(raw)).toBe(true);
    expect(raw).toContain("Subject: =?UTF-8?B?");
    expect(buildTestMessage({ from: "a@b.com", to: "c@d.com", subject: "ASCII", text: "x", messageId: "<m@b.com>", date: new Date(0) })).toContain(
      "Subject: ASCII",
    );
    expect(raw.split("\r\n").some((l) => l.startsWith("."))).toBe(false);
    const body = raw.split("\r\n\r\n")[1]!.replace(/\r\n/g, "");
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("Olá\r\n.ponto");
  });
});

/**
 * E-mail de teste da caixa de um projeto (02/10/2026): no Gmail aparecia só
 * "cassino" — o teste saía sem nome de exibição. Agora vai "Nome" <endereço>,
 * com acentos codificados (RFC 2047) e sem brecha para cabeçalho extra.
 */
describe("buildTestMessage — nome de exibição", () => {
  const base = {
    from: "contato@exemplo.com.br",
    to: "c@d.com",
    subject: "S",
    text: "x",
    messageId: "<m@b.com>",
    date: new Date(0),
  };
  /** Linha From e as continuações dela (começam com espaço). */
  function fromLines(raw: string): string[] {
    const lines = raw.split("\r\n");
    const start = lines.findIndex((l) => l.startsWith("From:"));
    const out = [lines[start]!];
    for (let i = start + 1; lines[i]!.startsWith(" "); i += 1) out.push(lines[i]!);
    return out;
  }
  function decodeWords(lines: string[]): { words: string[]; text: string } {
    const words = lines.join("").match(/=\?UTF-8\?B\?[^?]+\?=/g) ?? [];
    return { words, text: words.map((w) => Buffer.from(w.slice(10, -2), "base64").toString("utf8")).join("") };
  }

  it("ASCII: nome entre aspas antes do endereço", () => {
    expect(buildTestMessage({ ...base, fromName: "Contato Loja" })).toContain(
      'From: "Contato Loja" <contato@exemplo.com.br>\r\n',
    );
  });

  it("acentos: palavra codificada UTF-8 (RFC 2047), tudo ASCII no fio", () => {
    const raw = buildTestMessage({ ...base, fromName: "Contato - Cassino Ação" });
    expect(/^[\x00-\x7f]*$/.test(raw)).toBe(true);
    const lines = fromLines(raw);
    expect(decodeWords(lines).text).toBe("Contato - Cassino Ação");
    expect(lines.at(-1)).toMatch(/ <contato@exemplo\.com\.br>$/);
  });

  it("nome longo com acentos: várias palavras de até 75 caracteres, sem cortar letra ao meio", () => {
    const name = "Ação ".repeat(16).trim();
    const lines = fromLines(buildTestMessage({ ...base, fromName: name }));
    expect(lines.length).toBeGreaterThan(1);
    const { words, text } = decodeWords(lines);
    for (const w of words) expect(w.length).toBeLessThanOrEqual(75);
    expect(text).toBe(name);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(78);
  });

  it("aspas e barra no nome são escapadas; quebra de linha é removida (sem injeção de cabeçalho)", () => {
    const raw = buildTestMessage({ ...base, fromName: 'A "B" \\ C\r\nBcc: x@y.com' });
    expect(raw).toContain('From: "A \\"B\\" \\\\ CBcc: x@y.com" <contato@exemplo.com.br>\r\n');
    expect(raw.split("\r\n").some((l) => l.startsWith("Bcc:"))).toBe(false);
  });

  it("nome vazio ou só espaços: só o endereço", () => {
    expect(buildTestMessage({ ...base, fromName: "  " })).toContain("From: contato@exemplo.com.br\r\n");
  });

  it("sendSmtpMail repassa o nome ao cabeçalho From", async () => {
    const server = await fakeSmtp();
    await sendSmtpMail({ ...options(server.port), fromName: "Loja Exemplo" });
    expect(server.data).toContain('From: "Loja Exemplo" <');
  });
});

describe("xtext", () => {
  it("codifica +, = e caracteres fora do ASCII visível (RFC 3461)", () => {
    expect(xtext("tws-teste-abc")).toBe("tws-teste-abc");
    expect(xtext("a+b=c d")).toBe("a+2Bb+3Dc+20d");
  });
});
