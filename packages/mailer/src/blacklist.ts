/**
 * blacklist.ts — monitoramento de blacklist (DNSBL) do IP público e dos
 * domínios de e-mail (Fase 4, plano §5.3 roadmap → §5.4).
 *
 * Consulta DNSBLs via DNS reverso: <octetos invertidos>.<zona> → resposta A
 * em 127.0.0.0/8 indica listagem. Respostas 127.255.255.x indicam que a zona
 * RECUSOU a consulta (ex.: Spamhaus bloqueia resolvedores públicos abertos) —
 * tratadas como "unknown", nunca como listagem.
 *
 * O resolver é injetável para permitir testes determinísticos com mock
 * (127.0.0.2 é reservado para teste em várias DNSBLs).
 */
import dns from "node:dns/promises";
import type { BlacklistResult } from "@paas/core";

export interface DnsblDefinition {
  id: string;
  zone: string;
  label: string;
  removalUrl: string;
  kind: "ip" | "domain";
}

/** DNSBLs principais baseadas em IP. */
export const IP_DNSBLS: readonly DnsblDefinition[] = [
  {
    id: "spamhaus-zen",
    zone: "zen.spamhaus.org",
    label: "Spamhaus ZEN",
    removalUrl: "https://www.spamhaus.org/lookup/",
    kind: "ip",
  },
  {
    id: "spamcop",
    zone: "bl.spamcop.net",
    label: "SpamCop",
    removalUrl: "https://www.spamcop.net/bl.shtml",
    kind: "ip",
  },
  {
    id: "barracuda",
    zone: "b.barracudacentral.org",
    label: "Barracuda Reputation",
    removalUrl: "https://www.barracudacentral.org/rbl/removal-request",
    kind: "ip",
  },
];

/** DNSBLs baseadas em domínio. */
export const DOMAIN_DNSBLS: readonly DnsblDefinition[] = [
  {
    id: "spamhaus-dbl",
    zone: "dbl.spamhaus.org",
    label: "Spamhaus DBL",
    removalUrl: "https://www.spamhaus.org/lookup/",
    kind: "domain",
  },
];

/** Interface injetável do resolver (facilita mock em testes). */
export interface BlacklistResolverLike {
  resolve4(name: string): Promise<string[]>;
}

/**
 * Resolver padrão: usa o resolvedor do sistema (não servidores públicos) —
 * DNSBLs sérias (Spamhaus) recusam consultas vindas de resolvedores abertos
 * como 1.1.1.1/8.8.8.8.
 */
export function defaultBlacklistResolver(): BlacklistResolverLike {
  return new dns.Resolver();
}

/** "203.0.113.10" → "10.113.0.203" (ordem usada na consulta DNSBL). */
export function reversedIpv4(ip: string): string {
  return ip.split(".").reverse().join(".");
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

async function queryZone(
  name: string,
  def: DnsblDefinition,
  resolver: BlacklistResolverLike,
): Promise<BlacklistResult> {
  const base = { dnsbl: def.id, label: def.label, removalUrl: def.removalUrl };
  try {
    const answers = await resolver.resolve4(name);
    // 127.255.255.x = a zona recusou a consulta (resolvedor bloqueado/rate limit)
    const refused = answers.filter((a) => a.startsWith("127.255.255."));
    const listed = answers.filter(
      (a) => a.startsWith("127.") && !a.startsWith("127.255.255."),
    );
    if (listed.length > 0) {
      return {
        ...base,
        status: "listed",
        detail: `Listado (retorno ${listed.join(", ")}).`,
        removalUrl: def.removalUrl,
      };
    }
    if (refused.length > 0) {
      return {
        ...base,
        status: "unknown",
        detail: "A DNSBL recusou a consulta (resolvedor bloqueado ou limite excedido).",
        removalUrl: null,
      };
    }
    return { ...base, status: "clean", detail: null, removalUrl: null };
  } catch (err) {
    const code = (err as { code?: string }).code ?? "";
    if (code === "ENOTFOUND" || code === "ENODATA") {
      return { ...base, status: "clean", detail: null, removalUrl: null };
    }
    return {
      ...base,
      status: "unknown",
      detail: `Falha na consulta DNS (${code || "erro desconhecido"}).`,
      removalUrl: null,
    };
  }
}

/** Consulta um IPv4 em todas as DNSBLs de IP. IP inválido → lista vazia. */
export async function checkIpBlacklists(
  ip: string,
  resolver: BlacklistResolverLike = defaultBlacklistResolver(),
): Promise<BlacklistResult[]> {
  if (!isIpv4(ip)) return [];
  const reversed = reversedIpv4(ip);
  return Promise.all(
    IP_DNSBLS.map((def) => queryZone(`${reversed}.${def.zone}`, def, resolver)),
  );
}

/** Consulta um domínio nas DNSBLs de domínio. */
export async function checkDomainBlacklists(
  domain: string,
  resolver: BlacklistResolverLike = defaultBlacklistResolver(),
): Promise<BlacklistResult[]> {
  return Promise.all(
    DOMAIN_DNSBLS.map((def) => queryZone(`${domain}.${def.zone}`, def, resolver)),
  );
}
