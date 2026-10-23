import { cleanHost, dnsHostLabel, pairOf, type DomainPair } from "@paas/core";

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
  const rows: DnsRecordRow[] = [{ kind: "canonical", name: host, label: dnsHostLabel(host), type: "A", value: ip }];
  if (pair && withPair) {
    rows.push({
      kind: "pair",
      name: pair.pair,
      label: dnsHostLabel(pair.pair),
      type: "A",
      value: ip,
      ...(pair.role === "www" ? { cname: host } : {}),
    });
  }
  return { rows, pair };
}
