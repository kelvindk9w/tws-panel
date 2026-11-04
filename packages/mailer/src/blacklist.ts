/**
 * blacklist.ts — listas de bloqueio (DNSBL) do IP público e dos domínios de
 * e-mail (página Envios → Reputação).
 *
 * Consulta por DNS: <octetos invertidos>.<zona> (ou <domínio>.<zona>). Uma
 * resposta A em 127.0.0.0/8 indica listagem; NXDOMAIN, que não está.
 *
 * Regra de ouro: nunca dizer "limpo" sem ter certeza de que a lista
 * respondeu. Várias listas não respondem a qualquer servidor DNS:
 *  - a Spamhaus recusa consultas vindas de resolvedores públicos ou de muito
 *    volume (resposta 127.255.255.x) e oferece o DQS gratuito, com chave;
 *  - a Barracuda só responde a servidores DNS cadastrados;
 *  - alguns resolvedores públicos devolvem NXDOMAIN para tudo dessas zonas.
 * Por isso cada zona é testada junto com o ponto de teste oficial (RFC 5782:
 * 127.0.0.2 tem de estar listado; na Spamhaus DBL, o domínio dbltest.com).
 * Se o ponto de teste não aparece listado, o resultado da zona é "unknown"
 * ("não deu para verificar"), com o link para conferir no site.
 *
 * O resolver é injetável (testes determinísticos).
 */
import dns from "node:dns/promises";
import type { BlacklistResult } from "@paas/core";

export interface DnsblDefinition {
  id: string;
  zone: string;
  label: string;
  removalUrl: string;
  /** Página para conferir à mão. */
  lookupUrl: string;
  kind: "ip" | "domain";
  /** Zona do DQS da Spamhaus (prefixada pela chave), quando a lista tem. */
  dqsZone?: string;
  /** O que dizer quando a lista não responde ao ponto de teste. */
  unverifiedHint: string;
}

const SPAMHAUS_LOOKUP = "https://check.spamhaus.org/";
const SPAMHAUS_HINT =
  "A Spamhaus não respondeu a este servidor (ela recusa servidores DNS públicos ou de muito volume). Cadastre a chave DQS gratuita da Spamhaus no painel ou confira no site.";

/** DNSBLs principais baseadas em IP. */
export const IP_DNSBLS: readonly DnsblDefinition[] = [
  {
    id: "spamhaus-zen",
    zone: "zen.spamhaus.org",
    dqsZone: "zen.dq.spamhaus.net",
    label: "Spamhaus ZEN",
    removalUrl: SPAMHAUS_LOOKUP,
    lookupUrl: SPAMHAUS_LOOKUP,
    kind: "ip",
    unverifiedHint: SPAMHAUS_HINT,
  },
  {
    id: "spamcop",
    zone: "bl.spamcop.net",
    label: "SpamCop",
    removalUrl: "https://www.spamcop.net/bl.shtml",
    lookupUrl: "https://www.spamcop.net/bl.shtml",
    kind: "ip",
    unverifiedHint: "A SpamCop não respondeu ao teste de conferência a partir deste servidor. Confira no site.",
  },
  {
    id: "barracuda",
    zone: "b.barracudacentral.org",
    label: "Barracuda Reputation",
    removalUrl: "https://www.barracudacentral.org/rbl/removal-request",
    lookupUrl: "https://www.barracudacentral.org/lookups",
    kind: "ip",
    unverifiedHint:
      "A Barracuda só responde a servidores DNS cadastrados nela, e o deste servidor não está. Confira o IP no site da Barracuda.",
  },
];

/** DNSBLs baseadas em domínio. */
export const DOMAIN_DNSBLS: readonly DnsblDefinition[] = [
  {
    id: "spamhaus-dbl",
    zone: "dbl.spamhaus.org",
    dqsZone: "dbl.dq.spamhaus.net",
    label: "Spamhaus DBL",
    removalUrl: SPAMHAUS_LOOKUP,
    lookupUrl: SPAMHAUS_LOOKUP,
    kind: "domain",
    unverifiedHint: SPAMHAUS_HINT,
  },
];

/** Ponto de teste (RFC 5782): 127.0.0.2 está sempre listado nas listas de IP. */
const IP_TEST_POINT = "2.0.0.127";
/** Domínio de teste da Spamhaus DBL (sempre listado). */
const DOMAIN_TEST_POINT = "dbltest.com";

/** Interface injetável do resolver (facilita mock em testes). */
export interface BlacklistResolverLike {
  resolve4(name: string): Promise<string[]>;
}

export interface BlacklistOptions {
  /** Chave do DQS gratuito da Spamhaus. Inválida = ignorada. */
  dqsKey?: string | null;
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

/** Chave DQS: só letras minúsculas e números (vira parte de um nome DNS). */
export function isValidDqsKey(key: string): boolean {
  return /^[a-z0-9]{20,64}$/.test(key);
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

type Answer = { kind: "answers"; listed: string[]; refused: boolean } | { kind: "absent" } | { kind: "error"; code: string };

async function lookup(name: string, resolver: BlacklistResolverLike): Promise<Answer> {
  try {
    const answers = await resolver.resolve4(name);
    // 127.255.255.x = a zona recusou a consulta (resolvedor bloqueado, limite, chave DQS inválida)
    const refused = answers.some((a) => a.startsWith("127.255.255."));
    const listed = answers.filter((a) => a.startsWith("127.") && !a.startsWith("127.255.255."));
    return { kind: "answers", listed, refused };
  } catch (err) {
    const code = (err as { code?: string }).code ?? "";
    if (code === "ENOTFOUND" || code === "ENODATA") return { kind: "absent" };
    return { kind: "error", code };
  }
}

async function queryZone(
  name: string,
  testName: string,
  def: DnsblDefinition,
  resolver: BlacklistResolverLike,
  usingDqs: boolean,
): Promise<BlacklistResult> {
  const base = {
    dnsbl: def.id,
    label: usingDqs ? `${def.label} (DQS)` : def.label,
    removalUrl: null,
    lookupUrl: def.lookupUrl,
  };
  const [answer, probe] = await Promise.all([lookup(name, resolver), lookup(testName, resolver)]);

  if (answer.kind === "error") {
    return { ...base, status: "unknown", detail: `Falha na consulta DNS (${answer.code || "erro desconhecido"}).` };
  }
  if (answer.kind === "answers" && answer.listed.length > 0 && probe.kind === "answers" && probe.listed.length > 0) {
    return { ...base, status: "listed", detail: `Listado (retorno ${answer.listed.join(", ")}).`, removalUrl: def.removalUrl };
  }
  if (answer.kind === "answers" && answer.refused && answer.listed.length === 0) {
    return {
      ...base,
      status: "unknown",
      detail: usingDqs
        ? "A Spamhaus recusou a consulta com a chave DQS. Confira se a chave está certa e ativa."
        : `A lista recusou a consulta (servidor DNS bloqueado ou limite excedido). ${def.unverifiedHint}`,
    };
  }
  if (probe.kind !== "answers" || probe.listed.length === 0) {
    // O ponto de teste (sempre listado) não apareceu: a resposta desta zona
    // não é confiável a partir deste servidor DNS.
    return {
      ...base,
      status: "unknown",
      detail: usingDqs
        ? "A Spamhaus não respondeu ao teste de conferência com a chave DQS. Confira se a chave está certa e ativa."
        : def.unverifiedHint,
    };
  }
  return { ...base, status: "clean", detail: null };
}

function zoneFor(def: DnsblDefinition, opts: BlacklistOptions): { zone: string; usingDqs: boolean } {
  const key = opts.dqsKey?.trim();
  if (def.dqsZone && key && isValidDqsKey(key)) return { zone: `${key}.${def.dqsZone}`, usingDqs: true };
  return { zone: def.zone, usingDqs: false };
}

/** Consulta um IPv4 em todas as DNSBLs de IP. IP inválido → lista vazia. */
export async function checkIpBlacklists(
  ip: string,
  resolver: BlacklistResolverLike = defaultBlacklistResolver(),
  opts: BlacklistOptions = {},
): Promise<BlacklistResult[]> {
  if (!isIpv4(ip)) return [];
  const reversed = reversedIpv4(ip);
  return Promise.all(
    IP_DNSBLS.map((def) => {
      const { zone, usingDqs } = zoneFor(def, opts);
      return queryZone(`${reversed}.${zone}`, `${IP_TEST_POINT}.${zone}`, def, resolver, usingDqs);
    }),
  );
}

/** Consulta um domínio nas DNSBLs de domínio. */
export async function checkDomainBlacklists(
  domain: string,
  resolver: BlacklistResolverLike = defaultBlacklistResolver(),
  opts: BlacklistOptions = {},
): Promise<BlacklistResult[]> {
  return Promise.all(
    DOMAIN_DNSBLS.map((def) => {
      const { zone, usingDqs } = zoneFor(def, opts);
      return queryZone(`${domain}.${zone}`, `${DOMAIN_TEST_POINT}.${zone}`, def, resolver, usingDqs);
    }),
  );
}
