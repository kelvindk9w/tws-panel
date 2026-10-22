/**
 * ip-group.ts — como o painel agrupa e mostra o IP de quem tenta entrar.
 *
 * Quem tem uma rede IPv6 recebe um bloco /64 inteiro (2^64 endereços): contar
 * por endereço exato deixaria o atacante trocar de endereço a cada tentativa.
 * Por isso o limite de tentativas agrupa o IPv6 pelo /64; o IPv4 continua
 * por endereço (um /32 é o que a pessoa realmente controla).
 */
import { isIPv4, isIPv6 } from "node:net";

/** IPv4 dentro de IPv6 ("::ffff:1.2.3.4") vira o IPv4 puro. */
function unmap(ip: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return m ? m[1]! : ip;
}

/** Os 8 grupos de 16 bits de um IPv6 válido (aceita "::" e IPv4 no final). */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.split("%")[0]!; // zona (fe80::1%eth0)
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail) {
    const p = tail[1]!.split(".").map(Number);
    if (p.some((n) => n > 255)) return null;
    text =
      text.slice(0, -tail[1]!.length) +
      ((p[0]! << 8) | p[1]!).toString(16) +
      ":" +
      ((p[2]! << 8) | p[3]!).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...(halves.length === 2 ? Array<string>(missing).fill("0") : []), ...rest];
  const groups = all.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : Number.NaN));
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : null;
}

/** Chave de contagem: IPv4 por endereço, IPv6 pelo bloco /64. Texto que não é IP volta como veio. */
export function ipGroupKey(ip: string): string {
  const plain = unmap(ip.trim());
  if (isIPv4(plain)) return plain;
  if (isIPv6(plain)) {
    const g = ipv6Groups(plain);
    if (g) return `${g.slice(0, 4).map((n) => n.toString(16)).join(":")}::/64`;
  }
  return plain;
}

/** IP para mostrar em Alertas: IPv4 vira /24, IPv6 vira /64 (nunca o endereço inteiro). */
export function maskIp(ip: string): string {
  const plain = unmap(ip.trim());
  if (isIPv4(plain)) return `${plain.split(".").slice(0, 3).join(".")}.0/24`;
  if (isIPv6(plain)) return ipGroupKey(plain);
  return "origem desconhecida";
}
