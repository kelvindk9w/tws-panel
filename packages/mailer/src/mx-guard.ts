/**
 * mx-guard.ts — antes de cadastrar um domínio de e-mail, quem recebe o e-mail
 * dele hoje?
 *
 * Motivo real (01/10/2026): o dono do produto ia cadastrar o domínio
 * principal da empresa, que tem e-mail funcionando em outro provedor. O
 * checklist DNS manda apontar o MX para esta VPS — seguir isso desviaria todo
 * o e-mail que hoje chega no provedor atual. O painel consulta o MX e, se ele
 * aponta para outro lugar, exige confirmação explícita e sugere um subdomínio
 * dedicado (ex.: envio.<domínio>), que não mexe no e-mail da empresa.
 */
import { publicResolver, type DnsResolverLike } from "./dns-checklist.js";

export type ExistingMailStatus =
  /** Nenhum MX (ou MX nulo, RFC 7505): o domínio não recebe e-mail. */
  | "none"
  /** O MX já aponta para este servidor. */
  | "here"
  /** Ao menos um MX aponta para outro servidor: o domínio recebe e-mail lá. */
  | "elsewhere"
  /** A consulta falhou: não dá para afirmar que não há e-mail chegando. */
  | "unknown";

export interface ExistingMailAssessment {
  status: ExistingMailStatus;
  /** Servidores MX atuais, por prioridade, em minúsculas e sem ponto final. */
  servers: string[];
  /** Subdomínio sugerido para o envio pelo painel. */
  suggestedDomain: string;
}

/** Subdomínio dedicado sugerido quando o domínio já recebe e-mail. */
export function suggestedSendingDomain(domain: string): string {
  return `envio.${domain}`;
}

export function assessExistingMail(
  domain: string,
  mx: Array<{ exchange: string; priority: number }>,
  ownHosts: string[],
): ExistingMailAssessment {
  const servers = [...mx]
    .sort((a, b) => a.priority - b.priority)
    .map((r) => r.exchange.trim().toLowerCase().replace(/\.$/, ""))
    .filter((s) => s !== "");
  const status: ExistingMailStatus =
    servers.length === 0 ? "none" : servers.every((s) => ownHosts.includes(s)) ? "here" : "elsewhere";
  return { status, servers, suggestedDomain: suggestedSendingDomain(domain) };
}

/** Consulta o MX real (resolvers públicos) e classifica. */
export async function checkExistingMail(
  domain: string,
  ownHosts: string[],
  resolver: DnsResolverLike = publicResolver(),
): Promise<ExistingMailAssessment> {
  try {
    return assessExistingMail(domain, await resolver.resolveMx(domain), ownHosts);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENODATA" || code === "ENOTFOUND") return assessExistingMail(domain, [], ownHosts);
    return { status: "unknown", servers: [], suggestedDomain: suggestedSendingDomain(domain) };
  }
}
