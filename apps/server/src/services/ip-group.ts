/**
 * ip-group.ts — como o painel agrupa e mostra o IP de quem tenta entrar.
 *
 * Quem tem uma rede IPv6 recebe um bloco /64 inteiro (2^64 endereços): contar
 * por endereço exato deixaria o atacante trocar de endereço a cada tentativa.
 * Por isso o limite de tentativas agrupa o IPv6 pelo /64; o IPv4 continua
 * por endereço (um /32 é o que a pessoa realmente controla).
 */
import { isIPv4, isIPv6 } from "node:net";

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

/** Forma canônica: IPv4 puro (inclusive o mapeado em IPv6, em qualquer grafia) ou os 8 grupos do IPv6. */
function canonical(raw: string): { v4: string } | { groups: number[] } | null {
  const ip = raw.trim().split("%")[0]!; // zona (fe80::1%eth0, ::ffff:1.2.3.4%eth0)
  if (isIPv4(ip)) return { v4: ip };
  if (!isIPv6(ip)) return null;
  const g = ipv6Groups(ip);
  if (!g) return null;
  // IPv4-mapeado (::ffff:a.b.c.d, ::ffff:102:304, 0:0:0:0:0:ffff:...) é o IPv4 de verdade
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) {
    return { v4: `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}` };
  }
  return { groups: g };
}

/** Chave de contagem: IPv4 por endereço, IPv6 pelo bloco /64. Texto que não é IP volta como veio. */
export function ipGroupKey(ip: string): string {
  const c = canonical(ip);
  if (!c) return ip.trim();
  if ("v4" in c) return c.v4;
  return `${c.groups.slice(0, 4).map((n) => n.toString(16)).join(":")}::/64`;
}

/** IP para mostrar em Alertas: IPv4 vira /24, IPv6 vira /64 (nunca o endereço inteiro). */
export function maskIp(ip: string): string {
  const c = canonical(ip);
  if (!c) return "origem desconhecida";
  if ("v4" in c) return `${c.v4.split(".").slice(0, 3).join(".")}.0/24`;
  return ipGroupKey(ip);
}
