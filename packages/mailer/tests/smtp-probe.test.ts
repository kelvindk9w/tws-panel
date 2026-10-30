/**
 * Teste de conexão a partir do app (smtp-probe.ts) contra um servidor SMTP falso em TCP com STARTTLS de verdade
 * (certificado gerado na hora com openssl). Cobre o primeiro passo que falha, a ausência de erro não tratado
 * (ECONNRESET, fechamento, silêncio) e a garantia de que a senha nunca aparece no resultado.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { classifySocketError, probeSmtp, type SmtpProbeOptions } from "../src/smtp-probe.js";

const PASSWORD = "senha-super-secreta-123";
const USER = "meu-app@example.com";

let dir: string;
let cert: string;
let key: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "paas-probe-"));
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "2",
      "-subj", "/CN=mail.example.com", "-addext", "subjectAltName=DNS:mail.example.com",
    ],
    { stdio: "ignore" },
  );
  cert = readFileSync(path.join(dir, "c.pem"), "utf8");
  key = readFileSync(path.join(dir, "k.pem"), "utf8");
});

afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

interface Behavior {
  greeting?: string | null;
  /** Anuncia STARTTLS no primeiro EHLO. */
  starttls?: boolean;
  starttlsReply?: string;
  ehloReply?: string;
  authCaps?: string;
  authReply?: string;
  /** Derruba a conexão com RST ao receber este comando. */
  resetOn?: string;
  /** Cala-se (não responde) ao receber este comando. */
  silentOn?: string;
  /** Resposta gigante sem fim de linha na saudação. */
  flood?: boolean;
}

const servers: Array<{ close: () => void }> = [];
const received: string[] = [];

async function fake(b: Behavior = {}): Promise<number> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((raw) => {
    sockets.add(raw);
    raw.on("error", () => undefined);
    let socket: net.Socket = raw;
    let secure = false;
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (let idx = buffer.indexOf("\r\n"); idx >= 0; idx = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        received.push(line);
        const verb = line.split(" ")[0]!.toUpperCase();
        if (b.resetOn === verb) return void raw.resetAndDestroy();
        if (b.silentOn === verb) continue;
        if (verb === "EHLO") {
          const caps = [`250-mail.example.com`, ...(b.starttls !== false && !secure ? ["250-STARTTLS"] : []), "250-PIPELINING"];
          caps.push(`250 ${secure ? (b.authCaps ?? "AUTH PLAIN LOGIN") : "SIZE 1000"}`);
          socket.write((b.ehloReply ?? caps.join("\r\n")) + "\r\n");
        } else if (verb === "STARTTLS") {
          socket.write((b.starttlsReply ?? "220 2.0.0 Ready to start TLS") + "\r\n");
          if (b.starttlsReply && !b.starttlsReply.startsWith("220")) continue;
          raw.removeListener("data", onData);
          const wrapped = new tls.TLSSocket(raw, { isServer: true, cert, key });
          wrapped.on("error", () => undefined);
          wrapped.on("data", onData);
          socket = wrapped as unknown as net.Socket;
          secure = true;
        } else if (verb === "AUTH") {
          socket.write((b.authReply ?? "235 2.7.0 Authentication succeeded") + "\r\n");
        } else if (verb === "QUIT") {
          socket.end("221 Bye\r\n");
        } else {
          socket.write("500 5.5.1 Unknown\r\n");
        }
      }
    };
    raw.on("data", onData);
    if (b.flood) raw.write("x".repeat(70_000));
    else if (b.greeting !== null) raw.write((b.greeting ?? "220 mail.example.com ESMTP") + "\r\n");
  });
  server.on("error", () => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  });
  return (server.address() as net.AddressInfo).port;
}

afterEach(() => {
  received.length = 0;
  for (const s of servers.splice(0)) s.close();
});

function opts(port: number, extra: Partial<SmtpProbeOptions> = {}): SmtpProbeOptions {
  return {
    host: "127.0.0.1",
    port,
    servername: "mail.example.com",
    username: USER,
    password: PASSWORD,
    timeoutMs: 1500,
    totalTimeoutMs: 5000,
    tlsOptions: { ca: cert },
    ...extra,
  };
}

describe("probeSmtp", () => {
  it("sequência completa: conecta, STARTTLS verificado e login — sem enviar mensagem", async () => {
    const port = await fake();
    const r = await probeSmtp(opts(port));
    expect(r).toMatchObject({ ok: true, failedStep: null, failure: null, detail: null, host: "127.0.0.1", port });
    expect(r.passed).toEqual(["connect", "ehlo", "starttls", "certificate", "auth"]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const verbs = received.map((l) => l.split(" ")[0]);
    expect(verbs).toEqual(["EHLO", "STARTTLS", "EHLO", "AUTH", "QUIT"]);
    expect(verbs).not.toContain("MAIL");
    expect(verbs).not.toContain("DATA");
  });

  it("senha errada: falha no login, com a resposta curta do servidor e sem a senha", async () => {
    const port = await fake({ authReply: `535 5.7.8 Credenciais inválidas para ${PASSWORD}` });
    const r = await probeSmtp(opts(port));
    expect(r).toMatchObject({ ok: false, failedStep: "auth", failure: "auth_rejected" });
    expect(r.passed).toEqual(["connect", "ehlo", "starttls", "certificate"]);
    expect(r.detail).toContain("535");
    expect(JSON.stringify(r)).not.toContain(PASSWORD);
    expect(JSON.stringify(r)).not.toContain(Buffer.from(`\0${USER}\0${PASSWORD}`).toString("base64"));
  });

  it("detalhe longo do servidor é cortado", async () => {
    const port = await fake({ authReply: `535 ${"a".repeat(500)}` });
    const r = await probeSmtp(opts(port));
    expect(r.detail!.length).toBeLessThanOrEqual(160);
  });

  it("certificado que o app não confiaria (sem a CA): falha no passo do certificado", async () => {
    const port = await fake();
    const r = await probeSmtp(opts(port, { tlsOptions: {} }));
    expect(r).toMatchObject({ ok: false, failedStep: "certificate", failure: "certificate" });
    expect(r.detail).toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY/);
    expect(received.map((l) => l.split(" ")[0])).not.toContain("AUTH");
  });

  it("nome diferente do certificado: falha no certificado", async () => {
    const port = await fake();
    const r = await probeSmtp(opts(port, { servername: "outro.example.com" }));
    expect(r).toMatchObject({ failedStep: "certificate", failure: "certificate", detail: "ERR_TLS_CERT_ALTNAME_INVALID" });
  });

  it("servidor sem STARTTLS", async () => {
    const port = await fake({ starttls: false });
    const r = await probeSmtp(opts(port));
    expect(r).toMatchObject({ failedStep: "starttls", failure: "starttls_unavailable" });
  });

  it("STARTTLS recusado", async () => {
    const port = await fake({ starttlsReply: "454 4.7.0 TLS not available" });
    const r = await probeSmtp(opts(port));
    expect(r).toMatchObject({ failedStep: "starttls", failure: "starttls_rejected" });
    expect(r.detail).toContain("454");
  });

  it("saudação que não é 220", async () => {
    const port = await fake({ greeting: "554 5.7.1 sem serviço" });
    const r = await probeSmtp(opts(port));
    expect(r).toMatchObject({ failedStep: "connect", failure: "greeting" });
  });

  it("EHLO recusado", async () => {
    const port = await fake({ ehloReply: "502 5.5.1 nao implementado" });
    const r = await probeSmtp(opts(port));
    expect(r).toMatchObject({ failedStep: "ehlo", failure: "ehlo_rejected" });
  });

  it("sem AUTH PLAIN depois do TLS", async () => {
    const port = await fake({ authCaps: "AUTH XOAUTH2" });
    const r = await probeSmtp(opts(port));
    expect(r).toMatchObject({ failedStep: "auth", failure: "auth_unsupported" });
    const none = await probeSmtp(opts(await fake({ authCaps: "SIZE 10" })));
    expect(none).toMatchObject({ failedStep: "auth", failure: "auth_unsupported", detail: null });
  });

  it("porta fechada: recusada, sem erro não tratado", async () => {
    const closed = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const r = await probeSmtp(opts(closed));
    expect(r).toMatchObject({ ok: false, failedStep: "connect", failure: "refused" });
  });

  it("ECONNRESET na saudação e no meio da conversa vira resultado (nada sem tratamento)", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("uncaughtException", onUnhandled);
    process.on("unhandledRejection", onUnhandled);
    try {
      const mid = await probeSmtp(opts(await fake({ resetOn: "STARTTLS" })));
      expect(mid).toMatchObject({ ok: false, failedStep: "starttls" });
      expect(["reset", "closed"]).toContain(mid.failure);
      const auth = await probeSmtp(opts(await fake({ resetOn: "AUTH" })));
      expect(auth).toMatchObject({ ok: false, failedStep: "auth" });
      expect(["reset", "closed"]).toContain(auth.failure);
      await new Promise((r) => setTimeout(r, 120));
    } finally {
      process.off("uncaughtException", onUnhandled);
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it("servidor que fecha logo ao conectar", async () => {
    const port = await fake({ greeting: null });
    // fecha do lado do servidor assim que conecta: a saudação nunca vem
    const server = net.createServer((s) => {
      s.on("error", () => undefined);
      s.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push({ close: () => server.close() });
    const r = await probeSmtp(opts((server.address() as net.AddressInfo).port));
    expect(r).toMatchObject({ ok: false, failedStep: "connect", failure: "closed" });
    expect(port).toBeGreaterThan(0);
  });

  it("silêncio do servidor: tempo esgotado no passo certo", async () => {
    const quiet = await probeSmtp(opts(await fake({ greeting: null }), { timeoutMs: 80 }));
    expect(quiet).toMatchObject({ failedStep: "connect", failure: "timeout" });
    const authSilent = await probeSmtp(opts(await fake({ silentOn: "AUTH" }), { timeoutMs: 120 }));
    expect(authSilent).toMatchObject({ failedStep: "auth", failure: "timeout" });
  });

  it("prazo total", async () => {
    const r = await probeSmtp(opts(await fake({ greeting: null }), { timeoutMs: 5000, totalTimeoutMs: 80 }));
    expect(r).toMatchObject({ ok: false, failure: "timeout" });
  });

  it("resposta enorme sem fim de linha é abandonada", async () => {
    const r = await probeSmtp(opts(await fake({ flood: true })));
    expect(r).toMatchObject({ ok: false, failedStep: "connect", failure: "unexpected" });
  });

  it("falha de DNS injetada", async () => {
    const r = await probeSmtp(
      opts(25, {
        connect: () => {
          const s = new EventEmitter() as unknown as net.Socket;
          Object.assign(s, { write: () => true, destroy: () => s });
          queueMicrotask(() => s.emit("error", Object.assign(new Error("getaddrinfo ENOTFOUND mail.example.com"), { code: "ENOTFOUND" })));
          return s;
        },
      }),
    );
    expect(r).toMatchObject({ ok: false, failedStep: "connect", failure: "dns" });
  });

  it("usa o nome do servidor como padrão do certificado", async () => {
    const port = await fake();
    const { servername: _s, ...rest } = opts(port);
    const r = await probeSmtp({ ...rest, host: "localhost" });
    expect(r.failure === null || r.failedStep === "certificate" || r.failedStep === "connect").toBe(true);
  });
});

describe("classifySocketError", () => {
  it.each([
    ["ENOTFOUND", "dns"],
    ["EAI_AGAIN", "dns"],
    ["ECONNREFUSED", "refused"],
    ["ETIMEDOUT", "timeout"],
    ["EHOSTUNREACH", "timeout"],
    ["ECONNRESET", "reset"],
    ["EPIPE", "reset"],
    ["CERT_HAS_EXPIRED", "certificate"],
    ["EACCES", "unexpected"],
  ])("%s -> %s", (code, expected) => {
    expect(classifySocketError({ code })).toBe(expected);
  });

  it("erro sem código", () => {
    expect(classifySocketError(new Error("x"))).toBe("unexpected");
    expect(classifySocketError(null)).toBe("unexpected");
  });
});
