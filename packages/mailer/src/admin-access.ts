/**
 * admin-access.ts — quem pode usar a administração HTTP do Stalwart (API de gerenciamento e console web, porta 8080
 * do container).
 *
 * O Stalwart está em várias redes: a da administração (paas-mail-admin, só ele e o painel), a dele (paas-mail), a do
 * webmail (paas-mailweb) e a de e-mail de cada projeto (paas-mail-<slug>). O ouvinte HTTP escuta em todas as
 * interfaces, então qualquer container de projeto e o webmail chegavam à porta 8080 — e, com a senha de
 * administração, a tudo (contas, domínios, chaves DKIM). Projetos e webmail só precisam de SMTP (25/465/587) e IMAP
 * (143/993).
 *
 * Como fica restrito (conferido no código da tag v0.11.8, crates/jmap/src/api/http.rs e
 * crates/common/src/config/network.rs): a chave `server.http.allowed-endpoint` é uma expressão avaliada ANTES de
 * qualquer rota HTTP, com o IP de origem (`remote_ip`, já convertido de IPv6 mapeado para IPv4). Devolvendo 403 para
 * quem não é da rede do painel, toda rota responde 403 sem olhar a senha. Loopback (127.0.0.1 dentro do container)
 * o Stalwart sempre deixa passar (proteção dele contra se trancar para fora). `server.*` é chave local: vale o
 * config.toml que o painel grava, e a tela de administração do Stalwart não a troca.
 *
 * Quem passa:
 *  - a sub-rede da paas-mail-admin (só o painel e o Stalwart estão nela; a sub-rede de uma rede Docker não muda
 *    enquanto ela existir);
 *  - o gateway das redes do próprio Stalwart que têm saída (paas-mail-admin e paas-mail): é por ele que chega o acesso
 *    pela porta publicada só em 127.0.0.1 do host (túnel SSH para ver o console).
 *
 * A linguagem de expressões do Stalwart não tem "IP dentro de CIDR": a sub-rede vira prefixos de texto exatos
 * (`starts_with(remote_ip, '10.213.')` para /16, um termo por bloco /24 de uma /20, um IP exato para máscara maior que
 * /24). Na dúvida (sub-rede IPv6, painel e Stalwart dividindo outra rede, leitura que falhou), a restrição não é
 * ligada (ou fica a última conhecida): trancar o painel para fora seria pior que deixar como estava.
 */

/** IPs e sub-redes (IPv4) que podem usar a administração HTTP do Stalwart. */
export interface StalwartAdminAccess {
  /** Sub-redes inteiras (a da rede da administração). */
  cidrs: string[];
  /** Endereços exatos (gateways das redes do Stalwart: acesso pela porta publicada no host). */
  ips: string[];
}

/** Código HTTP devolvido a quem não pode usar a administração. */
export const ADMIN_DENIED_STATUS = 403;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4Octets(ip: string): number[] | null {
  const m = IPV4.exec(ip.trim());
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

/** É um IPv4 válido (quatro octetos de 0 a 255)? */
export function isIpv4(ip: string): boolean {
  return ipv4Octets(ip) !== null;
}

/**
 * Termos da expressão que cobrem EXATAMENTE a sub-rede: prefixos de texto com ponto no fim (octetos inteiros) e IPs
 * exatos (máscara maior que /24). null = sub-rede inválida ou larga demais (menos de /8).
 */
export function cidrTerms(cidr: string): string[] | null {
  const parts = cidr.trim().split("/");
  if (parts.length !== 2) return null;
  const [address, mask] = parts as [string, string];
  const octets = ipv4Octets(address);
  const bits = /^\d{1,2}$/.test(mask) ? Number(mask) : -1;
  if (!octets || bits < 8 || bits > 32) return null;
  // De /8 para cima, no máximo 7 bits livres no último octeto: até 128 termos.
  const whole = Math.ceil(bits / 8);
  const free = whole * 8 - bits;
  const count = 2 ** free;
  const fixed = octets.slice(0, whole - 1);
  const base = (octets[whole - 1] as number) & (0xff << free) & 0xff;
  const terms: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const parts = [...fixed, base + i];
    terms.push(whole === 4 ? `=${parts.join(".")}` : `^${parts.join(".")}.`);
  }
  return terms;
}

/**
 * Condição da expressão do Stalwart: verdadeira só para os IPs permitidos. null = nada válido para permitir (aí a
 * restrição não é escrita). Os valores são validados (só dígitos e pontos), então nada de texto livre entra no TOML.
 */
export function adminAccessCondition(access: StalwartAdminAccess | null | undefined): string | null {
  if (!access) return null;
  const terms = new Set<string>();
  for (const cidr of access.cidrs) {
    const found = cidrTerms(cidr);
    if (!found) return null;
    for (const t of found) terms.add(t);
  }
  for (const ip of access.ips) {
    if (!isIpv4(ip)) return null;
    terms.add(`=${ip.trim()}`);
  }
  if (terms.size === 0) return null;
  return [...terms]
    .sort()
    .map((t) => (t.startsWith("=") ? `remote_ip == '${t.slice(1)}'` : `starts_with(remote_ip, '${t.slice(1)}')`))
    .join(" || ");
}

/** Seção `[server.http]` do config.toml; vazia quando não há restrição válida. */
export function adminAccessSection(access: StalwartAdminAccess | null | undefined): string[] {
  const condition = adminAccessCondition(access);
  if (!condition) return [];
  return [
    "# Administração (API e console, porta 8080) só para a rede do painel: o resto recebe 403 em toda rota.",
    "[server.http]",
    `allowed-endpoint = [{if = "${condition}", then = 200}, {else = ${ADMIN_DENIED_STATUS}}]`,
    "",
  ];
}

/** Forma canônica (ordenada, sem repetição) — é ela que vai para a impressão digital da configuração. */
export function normalizeAdminAccess(access: StalwartAdminAccess): StalwartAdminAccess {
  return {
    cidrs: [...new Set(access.cidrs.map((c) => c.trim()))].sort(),
    ips: [...new Set(access.ips.map((i) => i.trim()))].sort(),
  };
}

export function sameAdminAccess(a: StalwartAdminAccess | null | undefined, b: StalwartAdminAccess | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  const x = normalizeAdminAccess(a);
  const y = normalizeAdminAccess(b);
  return x.cidrs.join(",") === y.cidrs.join(",") && x.ips.join(",") === y.ips.join(",");
}

/** Entrada de `docker network inspect -f '{{json .IPAM.Config}}'`. */
export interface IpamEntry {
  Subnet?: string;
  Gateway?: string;
}

/** Lê a saída JSON do IPAM; null = saída ilegível. */
export function parseIpamConfig(stdout: string): IpamEntry[] | null {
  try {
    const parsed = JSON.parse(stdout.trim() || "null") as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((e): e is IpamEntry => typeof e === "object" && e !== null);
  } catch {
    return null;
  }
}

export interface AdminAccessFacts {
  /** Nome da rede da administração (paas-mail-admin). */
  adminNetwork: string;
  /** Redes em que o container do Stalwart está agora. */
  stalwartNetworks: string[];
  /** Redes em que o container do painel está agora. */
  panelNetworks: string[];
  /** IPAM da rede da administração. */
  adminIpam: IpamEntry[];
  /** IPAM das outras redes do Stalwart com saída (paas-mail): só o gateway entra. */
  gatewayIpams: IpamEntry[][];
}

/**
 * Decisão:
 *  - `access`: restringir a estes IPs;
 *  - `unsafe` (motivo): não dá para restringir sem arriscar trancar o painel para fora — fica como estava antes da
 *    restrição (aberto), e o motivo vai para o log.
 */
export type AdminAccessDecision = { access: StalwartAdminAccess } | { unsafe: string };

export function decideAdminAccess(facts: AdminAccessFacts): AdminAccessDecision {
  const { adminNetwork } = facts;
  if (!facts.stalwartNetworks.includes(adminNetwork)) return { unsafe: `o servidor de e-mail não está na rede ${adminNetwork}` };
  if (!facts.panelNetworks.includes(adminNetwork)) return { unsafe: `o painel não está na rede ${adminNetwork}` };
  // Outra rede em comum: o painel poderia chegar ao Stalwart por ela (e com outro IP de origem).
  const shared = facts.panelNetworks.filter((n) => n !== adminNetwork && facts.stalwartNetworks.includes(n)).sort();
  if (shared.length > 0) return { unsafe: `o painel e o servidor de e-mail ainda dividem a rede ${shared.join(", ")}` };
  const subnets = facts.adminIpam.map((e) => (e.Subnet ?? "").trim()).filter(Boolean);
  if (subnets.length === 0) return { unsafe: `a rede ${adminNetwork} não informou sub-rede` };
  if (subnets.some((s) => s.includes(":"))) return { unsafe: `a rede ${adminNetwork} tem IPv6 (o painel poderia chegar por ele)` };
  const bad = subnets.find((s) => cidrTerms(s) === null);
  if (bad) return { unsafe: `a sub-rede ${bad} da rede ${adminNetwork} não dá para expressar no Stalwart` };
  const ips = facts.gatewayIpams
    .flat()
    .map((e) => (e.Gateway ?? "").trim())
    .filter(isIpv4);
  return { access: normalizeAdminAccess({ cidrs: subnets, ips }) };
}
