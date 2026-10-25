/**
 * tls-status.ts — estado do certificado HTTPS de um domínio, conferido do
 * jeito que um navegador confere: conexão TLS com o nome (SNI) e validação da
 * cadeia e do nome. Usado pela Visão geral do projeto, pelo proxy central.
 */
import tls from "node:tls";

export interface CertificateStatus {
  ok: boolean;
  /** Organização (ou nome) de quem emitiu, ex.: "Let's Encrypt". */
  issuer: string | null;
  /** Início da validade, ISO (com validTo dá a validade total: 90, 64, 45, 6 dias…). */
  validFrom?: string | null;
  /** Fim da validade, ISO. */
  validTo: string | null;
  error: string | null;
}

/** Data do certificado (formato do TLS, ex.: "Mar  1 10:00:00 2027 GMT") em ISO; vazio ou ilegível = null. */
export function parseCertDate(date: string | undefined): string | null {
  const ms = date ? Date.parse(date) : NaN;
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function certificateStatus(opts: {
  host: string;
  port: number;
  servername: string;
  /** Só para testes: autoridade extra aceita. */
  ca?: string;
  timeoutMs?: number;
}): Promise<CertificateStatus> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: CertificateStatus) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(r);
    };
    const socket = tls.connect({
      host: opts.host,
      port: opts.port,
      servername: opts.servername,
      rejectUnauthorized: true,
      ...(opts.ca ? { ca: opts.ca } : {}),
    });
    socket.setTimeout(opts.timeoutMs ?? 8_000, () =>
      finish({ ok: false, issuer: null, validFrom: null, validTo: null, error: "tempo esgotado ao conectar" }),
    );
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      const issuer = cert.issuer?.O ?? cert.issuer?.CN ?? null;
      const validTo = parseCertDate(cert.valid_to);
      const validFrom = parseCertDate(cert.valid_from);
      finish({ ok: true, issuer: Array.isArray(issuer) ? issuer[0]! : issuer, validFrom, validTo, error: null });
    });
    socket.once("error", (err) => finish({ ok: false, issuer: null, validFrom: null, validTo: null, error: err.message }));
  });
}
