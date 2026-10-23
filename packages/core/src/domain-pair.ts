/**
 * domain-pair.ts — o "par" de um domínio: example.com <-> www.example.com.
 *
 * O nome que a pessoa digita é o CANÔNICO. O par (o mesmo nome com ou sem
 * "www") é um apelido opcional que só redireciona para o canônico (308), para
 * o site ter um endereço só (SEO, cookies e login) e o visitante que digitar o
 * outro jeito chegar. Subdomínios que não são nem o apex nem o www
 * (app.example.com, blog.example.com) não ganham par.
 *
 * O domínio registrável (apex) vem da Public Suffix List (cópia fixada, subconjunto
 * gerado por scripts/gen-public-suffixes.mjs: .br, .uk, .au, .jp… e CentralNic), com as
 * regras da PSL: sufixos exatos, curingas (*.x) e exceções (!x). Para TLDs fora do
 * subconjunto vale só o último rótulo, e um nome com sufixo possivelmente composto
 * (hasUncertainSuffix) mostra o nome completo no guia em vez de um trecho cortado.
 */
import { PSL_COUNTRY_TLDS, PSL_RULES } from "./public-suffixes.generated";

/** Sufixos de hospedagem compartilhada: o "apex" não é de quem cadastra, então não há par. */
const SHARED_SUFFIXES: readonly string[] = [
  "sslip.io", "nip.io", "traefik.me", "github.io", "vercel.app", "netlify.app", "pages.dev", "workers.dev",
  "herokuapp.com", "web.app", "firebaseapp.com", "onrender.com", "fly.dev", "ngrok.io", "ngrok-free.app", "trycloudflare.com",
  "localhost", "local", "internal", "test", "invalid", "lan", "home.arpa",
];

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Nome em minúsculas, sem ponto final e sem espaços; "" se não for um hostname. */
export function cleanHost(raw: string): string {
  const value = raw.trim().toLowerCase().replace(/\.$/, "");
  return HOSTNAME.test(value) ? value : "";
}

function isIpLike(host: string): boolean {
  return /^\d+$/.test(host.slice(host.lastIndexOf(".") + 1));
}

function isShared(host: string): boolean {
  return SHARED_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

const COUNTRY_TLDS: ReadonlySet<string> = new Set(PSL_COUNTRY_TLDS);

interface TldRules {
  exact: Set<string>;
  wildcard: Set<string>;
  exception: Set<string>;
}
const RULES: ReadonlyMap<string, TldRules> = new Map(
  Object.entries(PSL_RULES).map(([tld, list]) => {
    const rules: TldRules = { exact: new Set(), wildcard: new Set(), exception: new Set() };
    for (const rule of list.split(" ").filter(Boolean)) {
      if (rule.startsWith("!")) rules.exception.add(`${rule.slice(1)}.${tld}`);
      else if (rule === "*") rules.wildcard.add(tld);
      else if (rule.startsWith("*.")) rules.wildcard.add(`${rule.slice(2)}.${tld}`);
      else rules.exact.add(`${rule}.${tld}`);
    }
    return [tld, rules];
  }),
);

/** Quantos rótulos tem o sufixo público do nome (1 = .com; 2 = com.br; 3 = sp.gov.br), pelas regras da PSL. */
function suffixLabels(labels: string[]): number {
  const n = labels.length;
  const rules = RULES.get(labels[n - 1]!);
  if (!rules) return 1;
  let best = 1;
  for (let i = 0; i < n; i++) {
    const suffix = labels.slice(i).join(".");
    if (rules.exception.has(suffix)) return n - i - 1;
    if (rules.exact.has(suffix) || rules.wildcard.has(labels.slice(i + 1).join("."))) best = Math.max(best, n - i);
  }
  return best;
}

/** O nome é, ele mesmo, um sufixo público (sp.gov.br, com.br): não dá para registrá-lo nem criar par. */
export function isPublicSuffix(raw: string): boolean {
  const host = cleanHost(raw);
  if (!host || isIpLike(host) || isShared(host)) return false;
  const labels = host.split(".");
  return labels.length >= 2 && suffixLabels(labels) >= labels.length;
}

/**
 * O apex (domínio registrável) de um nome: example.com para app.example.com,
 * example.com.br para www.example.com.br. null se não dá para saber (IP,
 * localhost, sufixo sozinho, hospedagem compartilhada).
 */
export function apexOf(raw: string): string | null {
  const host = cleanHost(raw);
  if (!host || isIpLike(host) || isShared(host)) return null;
  const labels = host.split(".");
  const keep = suffixLabels(labels) + 1;
  if (labels.length < keep) return null;
  return labels.slice(-keep).join(".");
}

export type DomainPairRole = "www" | "apex";

export interface DomainPair {
  /** O nome digitado (canônico). */
  canonical: string;
  /** O outro nome (com ou sem www). */
  pair: string;
  /** O que o par é: "www" (o canônico é o apex) ou "apex" (o canônico é o www). */
  role: DomainPairRole;
  /** O apex da zona. */
  apex: string;
}

/**
 * O par de um domínio, ou null: só o apex (ganha o www) e o www de um apex
 * (ganha o apex) têm par. app.example.com, www.app.example.com e
 * www.www.example.com não têm.
 */
export function pairOf(raw: string): DomainPair | null {
  const canonical = cleanHost(raw);
  const apex = apexOf(canonical);
  if (!apex) return null;
  // um apex que já começa com "www." (www.com.br é registrável) não ganha um "www.www."
  if (canonical === apex && !apex.startsWith("www.")) return { canonical, pair: `www.${apex}`, role: "www", apex };
  if (canonical === `www.${apex}`) return { canonical, pair: apex, role: "apex", apex };
  return null;
}

/**
 * O sufixo do nome é incerto: três rótulos ou mais, TLD de 2 letras que a PSL embutida NÃO
 * conhece (um país novo, depois da data da cópia) e penúltimo rótulo de até 4 letras
 * (example.xyz.zz pode ser o apex ou o subdomínio "example" de "xyz.zz"). Para todo TLD que a
 * PSL conhece, ela decide e nada é incerto. Nesse caso o guia mostra o nome completo.
 */
export function hasUncertainSuffix(raw: string): boolean {
  const labels = cleanHost(raw).split(".");
  if (labels.length < 3) return false;
  const tld = labels[labels.length - 1]!;
  if (COUNTRY_TLDS.has(tld)) return false;
  return tld.length === 2 && labels[labels.length - 2]!.length <= 4;
}

/**
 * Como escrever o nome no provedor de DNS: "@" para o apex, "www" ou o
 * trecho antes do apex (loja para loja.example.com). Nome fora da zona
 * conhecida ou com sufixo incerto: o NOME COMPLETO, nunca um trecho
 * truncado (quem colar "example" no Registro.br cria example.example.dev.br).
 */
export function dnsHostLabel(raw: string): string {
  const host = cleanHost(raw);
  const apex = apexOf(host);
  if (!apex || hasUncertainSuffix(host)) return host;
  if (host === apex) return "@";
  return host.slice(0, host.length - apex.length - 1);
}
