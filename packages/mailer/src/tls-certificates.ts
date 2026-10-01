/**
 * tls-certificates.ts — certificado de verdade para o servidor de e-mail.
 *
 * Validação real (01/10/2026): sem seção [certificate.*] o Stalwart gera um
 * certificado autoassinado, e o projeto conectava em `paas-stalwart:587`.
 * App que confere o certificado (nodemailer com requireTLS e verificação
 * padrão, caso do cassino) recusa as duas coisas: o emissor não é confiável e
 * o nome `paas-stalwart` nunca está em certificado público nenhum.
 *
 * Quem emite é o Caddy central (ele já emite os certificados dos sites e do
 * painel): o Caddyfile ganha um bloco para mail.<domínio> e o Caddy guarda o
 * par em /data/caddy/certificates/<emissor>/<host>/<host>.crt|.key, no volume
 * paas_caddy_data. O painel LÊ esse par pelo daemon (`docker exec`) e COPIA
 * só ele para o Stalwart — em vez de montar o volume do Caddy no Stalwart,
 * que exporia as chaves de todos os sites e a conta ACME a um terceiro
 * serviço. A cópia é refeita a cada sincronização (renovação do Let's
 * Encrypt, ~60 dias) — ver MailService.syncTls.
 */
import { createPrivateKey, X509Certificate } from "node:crypto";
import { PAAS_CADDY_CONTAINER } from "@paas/core";
import { run } from "./exec.js";

/** Pasta onde o Caddy guarda os certificados (dentro do container dele). */
export const CADDY_CERTIFICATES_DIR = "/data/caddy/certificates";

/** Hostname do servidor de e-mail de um domínio (mesmo nome do checklist DNS). */
export function mailHostFor(domain: string): string {
  return `mail.${domain}`;
}

/** Id da seção [certificate.<id>] e nome dos arquivos no Stalwart. */
export function certificateId(host: string): string {
  return host.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

export interface MailCertificate {
  host: string;
  /** PEM do certificado (com a cadeia, como o Caddy grava). */
  cert: string;
  /** PEM da chave privada. Nunca vai para log nem para a API. */
  key: string;
  /** SHA-256 do certificado: muda a cada renovação. */
  fingerprint: string;
  /** Organização (ou nome) do emissor, ex.: "Let's Encrypt". */
  issuer: string | null;
  /** Fim da validade, ISO. */
  validTo: string;
}

/**
 * Confere o par antes de entregá-lo ao Stalwart: nome certo, dentro da
 * validade e chave que pertence ao certificado. Um par que o cliente
 * recusaria (ou com o qual o Stalwart nem fecharia o TLS) devolve null.
 */
export function validateCertificatePair(
  host: string,
  cert: string,
  key: string,
  now: Date = new Date(),
): MailCertificate | null {
  try {
    const x509 = new X509Certificate(cert);
    if (!x509.checkHost(host)) return null;
    const validTo = new Date(x509.validTo);
    if (!(validTo.getTime() > now.getTime())) return null;
    if (!x509.checkPrivateKey(createPrivateKey(key))) return null;
    const issuer = /^O=(.*)$/m.exec(x509.issuer)?.[1] ?? /^CN=(.*)$/m.exec(x509.issuer)?.[1] ?? null;
    return { host, cert, key, fingerprint: x509.fingerprint256, issuer, validTo: validTo.toISOString() };
  } catch {
    return null;
  }
}

/** Entre vários emissores (Let's Encrypt, ZeroSSL), o que vence por último. */
export function pickNewest(certificates: MailCertificate[]): MailCertificate | null {
  let best: MailCertificate | null = null;
  for (const c of certificates) {
    if (!best || new Date(c.validTo).getTime() > new Date(best.validTo).getTime()) best = c;
  }
  return best;
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Lê do Caddy o certificado de `host`, se já emitido. O emissor não é fixo:
 * o Caddy tenta o Let's Encrypt e, se falhar, o ZeroSSL — por isso a busca
 * pelo nome do arquivo em todas as pastas de emissor.
 */
export async function readCaddyCertificate(
  host: string,
  opts: { caddyContainer?: string; now?: Date } = {},
): Promise<MailCertificate | null> {
  if (!HOST_RE.test(host)) return null;
  const container = opts.caddyContainer ?? PAAS_CADDY_CONTAINER;
  const found = await run("docker", [
    "exec", container, "find", CADDY_CERTIFICATES_DIR, "-type", "f", "-name", `${host}.crt`,
  ]);
  if (found.code !== 0) return null;
  const candidates: MailCertificate[] = [];
  for (const certPath of found.stdout.split("\n").map((l) => l.trim())) {
    if (!certPath.startsWith(`${CADDY_CERTIFICATES_DIR}/`) || !certPath.endsWith(`/${host}.crt`)) continue;
    const cert = await run("docker", ["exec", container, "cat", certPath]);
    const key = await run("docker", ["exec", container, "cat", certPath.replace(/\.crt$/, ".key")]);
    if (cert.code !== 0 || key.code !== 0) continue;
    const valid = validateCertificatePair(host, cert.stdout, key.stdout, opts.now);
    if (valid) candidates.push(valid);
  }
  return pickNewest(candidates);
}
