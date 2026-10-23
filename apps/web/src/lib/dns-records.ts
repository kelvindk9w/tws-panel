import { cleanHost, dnsHostLabel, hasUncertainSuffix, pairOf, type DomainPair } from "@paas/core";

/** Um registro de DNS a criar no provedor. */
export interface DnsRecordRow {
  /** "canonical" = o nome digitado; "pair" = o outro (com/sem www). */
  kind: "canonical" | "pair";
  /** Nome completo (example.com, www.example.com). */
  name: string;
  /** Como escrever o nome no provedor: "@", "www" ou o trecho antes do domínio. */
  label: string;
  type: "A";
  /** IP da VPS (null = ainda não se sabe). */
  value: string | null;
  /** Alternativa para o www: CNAME apontando para o canônico (acompanha o IP dele). */
  cname?: string;
}

/** O que a pessoa digitou, sem esquema, caminho, maiúsculas nem ponto final. "" se não for um nome. */
export function typedHost(raw: string): string {
  return cleanHost(raw.trim().replace(/^https?:\/\//i, "").replace(/[/?#].*$/, ""));
}

/**
 * Os registros que a pessoa precisa criar: o do nome digitado e, se ele tem
 * par (apex <-> www) e a pessoa quer o par, o do outro nome. O apex sempre é
 * registro A (CNAME não é permitido nele); o www pode ser A ou CNAME para o apex.
 */
export function dnsRecords(
  raw: string,
  ip: string | null,
  withPair: boolean,
): { rows: DnsRecordRow[]; pair: DomainPair | null } {
  const host = typedHost(raw);
  if (!host) return { rows: [], pair: null };
  const pair = pairOf(host);
  // Se o sufixo de qualquer um dos dois nomes é incerto, os dois ficam com o nome completo
  // (nunca um "@" ao lado de um nome inteiro, nem um rótulo cortado).
  const full = pair !== null && (hasUncertainSuffix(host) || hasUncertainSuffix(pair.pair));
  const labelOf = (name: string) => (full ? name : dnsHostLabel(name));
  const rows: DnsRecordRow[] = [{ kind: "canonical", name: host, label: labelOf(host), type: "A", value: ip }];
  if (pair && withPair) {
    rows.push({
      kind: "pair",
      name: pair.pair,
      label: labelOf(pair.pair),
      type: "A",
      value: ip,
      ...(pair.role === "www" ? { cname: host } : {}),
    });
  }
  return { rows, pair };
}

/**
 * O nome a enviar ao servidor: normalizado (punycode, minúsculas, sem esquema). Se o texto não é
 * um nome válido, vai o texto limpo como foi digitado e o servidor responde 400 (invalid_domain).
 */
export function domainToSend(raw: string): string {
  return typedHost(raw) || raw.trim().toLowerCase();
}

/** O texto digitado tem Unicode que o guia converteu (para mostrar o nome em punycode com legenda). */
export function wasConverted(raw: string): boolean {
  return /[^\x00-\x7f]/.test(raw) && typedHost(raw) !== "";
}
