/**
 * smtp-probe.ts — "Testar conexão a partir do app": a MESMA sequência que um app de verdade faz ao enviar pela
 * caixa do projeto, SEM enviar mensagem nenhuma:
 *
 *   conectar (saudação 220) → EHLO → STARTTLS → certificado verificado → EHLO → AUTH com a caixa do projeto → QUIT
 *
 * Devolve o PRIMEIRO passo que falhou e o motivo (tipo + a resposta curta do servidor), para a tela traduzir.
 *
 * Onde roda: no próprio container do painel, que está na mesma rede Docker (paas-net) dos projetos e resolve
 * `mail.<domínio>` pelo mesmo alias que o app usa. Então não precisa de container descartável nem de exec dentro
 * do app (que pode nem ter shell). O que NÃO cobre: regra de rede/firewall exclusiva do container do app.
 *
 * Diferença de propósito para smtp-send.ts: aqui o certificado É verificado (é o que um app faz e o que costuma
 * falhar); o envio de teste do painel não verifica.
 *
 * Segurança:
 *  - a senha só entra no comando AUTH enviado ao servidor; nunca aparece no resultado, em mensagem de erro nem
 *    em registro (o texto devolvido pelo servidor é limpo e, se por acaso repetir a senha, é cortado);
 *  - toda falha de socket (ECONNRESET, EPIPE, fechamento) vira resultado: nenhum evento 'error' fica sem ouvinte,
 *    então o processo do painel nunca cai por causa do servidor remoto;
 *  - prazo por resposta e prazo total; o socket é sempre destruído.
 */
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import type { MailProbeFailure, MailProbeResult, MailProbeStep } from "@paas/core";

export interface SmtpProbeOptions {
  host: string;
  port: number;
  /** Nome esperado no certificado (padrão: o próprio host). */
  servername?: string;
  username: string;
  password: string;
  /** Prazo para cada resposta (padrão 8 s). */
  timeoutMs?: number;
  /** Prazo total (padrão 20 s). */
  totalTimeoutMs?: number;
  /** Abre a conexão TCP (injetável em testes). */
  connect?: (host: string, port: number) => net.Socket;
  /** Opções extras do TLS (testes passam `ca`); a verificação do certificado fica SEMPRE ligada. */
  tlsOptions?: Pick<tls.ConnectionOptions, "ca">;
  /** Relógio em ms (testes). */
  now?: () => number;
}

class ProbeError extends Error {
  constructor(
    readonly failure: MailProbeFailure,
    readonly detail: string | null = null,
  ) {
    super(failure);
  }
}

const CERT_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "CERT_REVOKED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HOSTNAME_MISMATCH",
]);

/** Erro de socket → motivo. `code` é o código do Node (ECONNREFUSED...); nunca o texto livre. */
export function classifySocketError(err: unknown): MailProbeFailure {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return "unexpected";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NODATA" || code === "EAI_NONAME") return "dns";
  if (code === "ECONNREFUSED") return "refused";
  if (code === "ETIMEDOUT" || code === "EHOSTUNREACH" || code === "ENETUNREACH") return "timeout";
  if (code === "ECONNRESET" || code === "EPIPE" || code === "ECONNABORTED") return "reset";
  return CERT_CODES.has(code) ? "certificate" : "unexpected";
}

/** Teto de bytes lidos no teste inteiro (uma conversa normal tem poucas centenas). */
const TOTAL_BYTES_MAX = 256 * 1024;

/** Lê respostas SMTP (uma ou mais linhas) de um socket; qualquer falha vira rejeição de quem espera. */
class Session {
  private buffer = "";
  /** Total lido de TODAS as respostas do teste (inclusive linhas curtas sem fim): teto contra servidor hostil. */
  private received = 0;
  private lines: string[] = [];
  private ready: string[] = [];
  private waiter: { resolve: (r: string) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;
  private readonly onData = (chunk: Buffer): void => {
    this.received += chunk.length;
    if (this.received > TOTAL_BYTES_MAX) return this.fail(new ProbeError("unexpected", "resposta grande demais"));
    this.buffer += chunk.toString("utf8");
    // Um servidor hostil não pode encher a memória: sem fim de linha em 64 KiB, desiste.
    if (this.buffer.length > 65_536) return this.fail(new ProbeError("unexpected", "resposta grande demais"));
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      this.lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) {
        this.ready.push(this.lines.join("\n"));
        this.lines = [];
      }
    }
    this.flush();
  };

  constructor(public socket: Duplex) {
    this.attach(socket);
  }

  private attach(socket: Duplex): void {
    socket.on("data", this.onData);
    // Sem este ouvinte um ECONNRESET derrubaria o processo (evento 'error' sem tratamento).
    socket.on("error", (err) => this.fail(new ProbeError(classifySocketError(err))));
    socket.on("close", () => this.fail(new ProbeError("closed")));
  }

  /** Troca o socket (depois do STARTTLS): o texto que sobrou no buffer é descartado de propósito. */
  replace(next: Duplex): void {
    this.socket.removeListener("data", this.onData);
    this.buffer = "";
    this.lines = [];
    this.ready = [];
    this.socket = next;
    this.attach(next);
  }

  fail(err: Error): void {
    this.failure ??= err;
    this.flush();
  }

  private flush(): void {
    if (!this.waiter) return;
    const next = this.ready.shift();
    if (next !== undefined) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve(next);
    } else if (this.failure) {
      const w = this.waiter;
      this.waiter = null;
      w.reject(this.failure);
    }
  }

  next(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
      this.flush();
    });
  }
}

const codeOf = (response: string): number => Number(response.slice(response.lastIndexOf("\n") + 1, response.lastIndexOf("\n") + 4));

/** Resposta curta e limpa para mostrar: "535 5.7.8 ...". Sem controle, 160 caracteres; a senha, se repetida, some. */
function shortDetail(response: string, secret: string): string {
  const last = response.slice(response.lastIndexOf("\n") + 1);
  // eslint-disable-next-line no-control-regex
  let clean = last.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (secret.length >= 4) clean = clean.split(secret).join("[oculto]");
  return clean.length > 160 ? `${clean.slice(0, 159)}…` : clean;
}

function capabilities(ehlo: string): string[] {
  return ehlo
    .split("\n")
    .slice(1)
    .map((l) => l.slice(4).trim().toUpperCase());
}

export async function probeSmtp(opts: SmtpProbeOptions): Promise<MailProbeResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const timeoutMs = opts.timeoutMs ?? 8000;
  const passed: MailProbeStep[] = [];
  let step: MailProbeStep = "connect";
  let session: Session | null = null;
  let totalTimer: NodeJS.Timeout | undefined;
  const result = (r: Pick<MailProbeResult, "ok" | "failedStep" | "failure" | "detail">): MailProbeResult => ({
    host: opts.host,
    port: opts.port,
    passed: [...passed],
    elapsedMs: Math.max(0, now() - started),
    ...r,
  });

  const read = async (): Promise<string> => {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProbeError("timeout")), timeoutMs);
    });
    try {
      return await Promise.race([session!.next(), limit]);
    } finally {
      clearTimeout(timer);
    }
  };
  const command = async (text: string, ok: number[], failure: MailProbeFailure): Promise<string> => {
    session!.socket.write(`${text}\r\n`);
    const response = await read();
    if (!ok.includes(codeOf(response))) throw new ProbeError(failure, shortDetail(response, opts.password));
    return response;
  };

  const run = async (): Promise<MailProbeResult> => {
    const socket = (opts.connect ?? ((h, p) => net.connect({ host: h, port: p })))(opts.host, opts.port);
    session = new Session(socket);
    const greeting = await read();
    if (codeOf(greeting) !== 220) throw new ProbeError("greeting", shortDetail(greeting, opts.password));
    passed.push("connect");

    step = "ehlo";
    const ehlo = await command("EHLO tws-panel", [250], "ehlo_rejected");
    passed.push("ehlo");

    step = "starttls";
    if (!capabilities(ehlo).includes("STARTTLS")) throw new ProbeError("starttls_unavailable");
    await command("STARTTLS", [220], "starttls_rejected");

    step = "certificate";
    const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ProbeError("timeout")), timeoutMs);
      const upgraded = tls.connect({
        socket: session!.socket as net.Socket,
        servername: opts.servername ?? opts.host,
        rejectUnauthorized: true,
        ...(opts.tlsOptions?.ca ? { ca: opts.tlsOptions.ca } : {}),
      });
      // Os dois ouvintes ficam: erro depois do aperto de mão também não pode ficar sem tratamento.
      upgraded.once("secureConnect", () => {
        clearTimeout(timer);
        resolve(upgraded);
      });
      upgraded.on("error", (err) => {
        clearTimeout(timer);
        const failure = classifySocketError(err);
        reject(new ProbeError(failure === "unexpected" ? "starttls_rejected" : failure, (err as { code?: string }).code ?? null));
      });
    });
    session.replace(secure);
    passed.push("starttls", "certificate");

    step = "ehlo";
    const secureEhlo = await command("EHLO tws-panel", [250], "ehlo_rejected");

    step = "auth";
    const mechanisms = capabilities(secureEhlo).find((c) => c.startsWith("AUTH ")) ?? "";
    if (!mechanisms.split(" ").includes("PLAIN")) throw new ProbeError("auth_unsupported", mechanisms || null);
    const plain = Buffer.from(`\0${opts.username}\0${opts.password}`, "utf8").toString("base64");
    await command(`AUTH PLAIN ${plain}`, [235], "auth_rejected");
    passed.push("auth");
    session.socket.write("QUIT\r\n");
    return result({ ok: true, failedStep: null, failure: null, detail: null });
  };

  const total = new Promise<never>((_, reject) => {
    totalTimer = setTimeout(() => reject(new ProbeError("timeout")), opts.totalTimeoutMs ?? 20_000);
  });
  try {
    return await Promise.race([run(), total]);
  } catch (err) {
    if (err instanceof ProbeError) return result({ ok: false, failedStep: step, failure: err.failure, detail: err.detail });
    return result({ ok: false, failedStep: step, failure: classifySocketError(err), detail: null });
  } finally {
    clearTimeout(totalTimer);
    // Se o total estourou, a corrida deixa `run` solto: o socket é derrubado e o que ele rejeitar depois é ignorado.
    const open = (session as Session | null)?.socket;
    setTimeout(() => open?.destroy(), 50).unref();
  }
}
