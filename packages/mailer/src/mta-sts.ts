/**
 * mta-sts.ts — a política MTA-STS que o painel publica (texto, nome do site e identificador).
 * Fica à parte para o checklist de DNS e a saúde do e-mail usarem o mesmo texto sem importar um ao outro.
 */
import { createHash } from "node:crypto";

/** Política MTA-STS sugerida: começa em "testing" (relata, não bloqueia). */
export function mtaStsPolicy(mailHostname: string): string {
  return ["version: STSv1", "mode: testing", `mx: ${mailHostname}`, "max_age: 86400", ""].join("\r\n");
}

/**
 * Texto que o proxy serve em https://mta-sts.<domínio>/.well-known/mta-sts.txt: o mesmo da
 * política mostrada na tela, com quebra de linha LF (o RFC 8461 aceita CRLF ou LF).
 */
export function mtaStsServedPolicy(mailHostname: string): string {
  return mtaStsPolicy(mailHostname).replace(/\r\n/g, "\n");
}

/** Nome do site da política de um domínio de e-mail. */
export function mtaStsHostFor(domain: string): string {
  return `mta-sts.${domain}`;
}

/** Identificador da política (muda quando o texto muda, como o MTA-STS pede). */
export function mtaStsId(policy: string): string {
  return createHash("sha256").update(policy).digest("hex").slice(0, 16);
}
