/**
 * domain-input.ts — a ÚNICA normalização do nome de domínio digitado, usada pelo servidor e pelo web.
 *
 * Aceita o nome completo (api.example.com, https://API.example.com/x) ou, escolhido um domínio
 * pai, só o(s) rótulo(s) (api, app.v2): `api` + `example.com` = api.example.com, como no
 * formulário de DNS da Cloudflare. "@" ou vazio, com pai, é o próprio pai. Um nome que já
 * termina no pai não é duplicado. Sem pai, o texto é sempre um nome completo (compatível com a API antiga).
 */
import { cleanHost } from "./domain-pair";

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Minúsculas, sem espaços, esquema, caminho/consulta, barra final nem ponto final. */
export function stripTypedHost(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.+$/, "");
}

export interface ResolvedDomain {
  /** O nome final (ASCII, punycode se preciso); "" quando o texto não forma um nome válido. */
  host: string;
  /** O texto foi entendido como rótulo(s) sob o pai (e não como nome completo). */
  fromLabel: boolean;
}

/**
 * @param raw o texto digitado
 * @param parent o domínio pai escolhido (já normalizável); omitido = `raw` é um nome completo
 */
export function resolveDomainInput(raw: string, parent?: string | null): ResolvedDomain {
  const typed = stripTypedHost(raw);
  if (parent === undefined || parent === null || parent.trim() === "") {
    return { host: cleanHost(typed), fromLabel: false };
  }
  const base = cleanHost(stripTypedHost(parent));
  if (!base) return { host: "", fromLabel: false };
  if (typed === "" || typed === "@") return { host: base, fromLabel: true };
  const full = cleanHost(typed);
  if (full && (full === base || full.endsWith(`.${base}`))) return { host: full, fromLabel: false };
  // rótulos sob o pai: cada um com as regras de DNS (letras, dígitos, hífen; 1 a 63) e o total até 253
  const labels = typed.split(".");
  if (!labels.every((l) => LABEL.test(l))) {
    // Unicode: deixa o cleanHost converter para punycode
    const joined = cleanHost(`${typed}.${base}`);
    return { host: joined, fromLabel: joined !== "" };
  }
  const host = `${typed}.${base}`;
  return { host: host.length <= 253 ? host : "", fromLabel: true };
}

/** Atalho: só o nome final ("" se inválido). */
export function normalizeDomainInput(raw: string, parent?: string | null): string {
  return resolveDomainInput(raw, parent).host;
}
