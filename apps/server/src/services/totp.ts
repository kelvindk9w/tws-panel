/**
 * totp.ts — verificação em duas etapas por código de app autenticador
 * (TOTP, RFC 6238: HMAC-SHA1, 6 dígitos, passo de 30 s) e códigos de
 * recuperação.
 *
 * Implementado com node:crypto — sem dependência nova num ponto que decide
 * quem entra no painel. Compatível com Google Authenticator, Microsoft
 * Authenticator, Authy, 1Password, Bitwarden e afins.
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
/** Passos aceitos para cada lado do atual (relógio do celular adiantado/atrasado). */
const TOTP_WINDOW = 1;
const SECRET_BYTES = 20; // 160 bits, o recomendado pela RFC 4226
const RECOVERY_CODE_COUNT = 10;
/** Sem 0/o, 1/l/i: nada que se confunda ao copiar de um papel. */
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("base32 inválido");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Segredo novo (base32), para o operador cadastrar no app autenticador. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/** Código de 6 dígitos do passo `step` (RFC 4226 §5.3, truncamento dinâmico). */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return String(bin).padStart(TOTP_DIGITS, "0");
}

/**
 * Confere o código. Devolve o passo que casou (para gravar como último usado)
 * ou null. Um passo igual ou anterior ao último usado é recusado: o mesmo
 * código não vale duas vezes, nem se alguém o viu por cima do ombro.
 */
export function verifyTotp(
  secret: string,
  code: string,
  opts: { nowMs?: number; lastStep: number | null },
): number | null {
  const digits = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(digits)) return null;
  const current = Math.floor((opts.nowMs ?? Date.now()) / 1000 / TOTP_STEP_SECONDS);
  let matched: number | null = null;
  // percorre a janela inteira (tempo constante em relação a qual passo casa)
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step += 1) {
    const expected = Buffer.from(totpCode(secret, step));
    if (timingSafeEqual(expected, Buffer.from(digits)) && (opts.lastStep === null || step > opts.lastStep)) {
      matched ??= step;
    }
  }
  return matched;
}

/** URI `otpauth://` que o QR code carrega (formato do Google Authenticator). */
export function otpauthUri(opts: { issuer: string; account: string; secret: string }): string {
  const issuer = encodeURIComponent(opts.issuer);
  const account = encodeURIComponent(opts.account);
  return (
    `otpauth://totp/${issuer}:${account}?secret=${opts.secret}&issuer=${issuer}` +
    `&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`
  );
}

/** Códigos de recuperação de uso único (mostrados UMA vez ao operador). */
export function generateRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT) {
    let raw = "";
    for (let i = 0; i < 10; i += 1) raw += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    codes.add(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return [...codes];
}

/**
 * Hash guardado no lugar do código. SHA-256 basta: são ~49 bits aleatórios
 * por código (não uma senha escolhida por gente), e o login tem limite de
 * tentativas por IP.
 */
export function hashRecoveryCode(code: string): string {
  const normalized = code.toLowerCase().replace(/[\s-]/g, "");
  return createHash("sha256").update(`paas-recovery:${normalized}`).digest("hex");
}
