/**
 * caddy-storage.ts — certificados que o Caddy JÁ emitiu, lidos do
 * armazenamento dele (volume paas_caddy_data), sem abrir conexão TLS.
 *
 * Por que não o handshake de sempre (tls-status.ts): num nome de emissão sob
 * demanda, o handshake com SNI É o primeiro acesso — dispararia a emissão (e
 * gastaria a cota do Let's Encrypt) só por a tela olhar o nome. Ler o arquivo
 * não tem efeito colateral.
 *
 * Formato do Caddy: /data/caddy/certificates/<emissor>/<nome>/<nome>.crt
 * (curinga: wildcard_.example.com). O texto lido é dado do volume: só o que
 * tem formato de certificado e de nome é usado; o resto é ignorado.
 */
import { X509Certificate } from "node:crypto";
import type { CertificateStatus } from "./tls-status.js";

/** Pasta dos certificados dentro do container do Caddy. */
export const CADDY_CERTIFICATES_DIR = "/data/caddy/certificates";

const MARKER = "### ";
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const PEM_RE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/;

/** Comando (para `sh -c` no container) que imprime cada certificado precedido de `### <caminho>`. */
export const LIST_CERTIFICATES_SCRIPT =
  `for f in ${CADDY_CERTIFICATES_DIR}/*/*/*.crt; do [ -f "$f" ] && { echo "${MARKER}$f"; cat "$f"; echo; }; done; true`;

function iso(date: string): string | null {
  const ms = Date.parse(date);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * Lê a saída de LIST_CERTIFICATES_SCRIPT. Devolve, por nome, o certificado de
 * validade mais longa (um nome pode ter o do Let's Encrypt e o do ZeroSSL).
 * Arquivo ilegível, nome fora do formato e certificado sem datas são pulados.
 */
export function parseIssuedCertificates(output: string): Map<string, CertificateStatus> {
  const found = new Map<string, CertificateStatus>();
  // o que vem antes do primeiro marcador não é certificado
  for (const block of output.split(/^### /m).slice(1)) {
    const newline = block.indexOf("\n");
    if (newline < 0) continue;
    const parts = block.slice(0, newline).trim().split("/");
    const host = parts[parts.length - 2] ?? "";
    // o nome da pasta e o do arquivo têm de coincidir; curinga (wildcard_.x) e lixo ficam de fora
    if (!HOST_RE.test(host) || parts[parts.length - 1] !== `${host}.crt`) continue;
    const pem = PEM_RE.exec(block.slice(newline + 1))?.[0];
    if (!pem) continue;
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(pem);
    } catch {
      continue;
    }
    const validTo = iso(cert.validTo);
    const validFrom = iso(cert.validFrom);
    if (!validTo || !validFrom) continue;
    const previous = found.get(host);
    if (previous?.validTo && previous.validTo >= validTo) continue;
    found.set(host, { ok: true, issuer: issuerName(cert.issuer), validFrom, validTo, error: null });
  }
  return found;
}

/** "O=Let's Encrypt\nCN=R11" → "Let's Encrypt" (a organização; senão o CN). */
function issuerName(issuer: string): string | null {
  const field = (key: string) => new RegExp(`^${key}=(.+)$`, "m").exec(issuer)?.[1]?.trim() ?? null;
  const name = field("O") ?? field("CN");
  return name ? name.slice(0, 80) : null;
}
