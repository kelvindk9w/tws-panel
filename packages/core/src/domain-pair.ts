/**
 * domain-pair.ts — o "par" de um domínio: example.com <-> www.example.com.
 *
 * O nome que a pessoa digita é o CANÔNICO. O par (o mesmo nome com ou sem
 * "www") é um apelido opcional que só redireciona para o canônico (308), para
 * o site ter um endereço só (SEO, cookies e login) e o visitante que digitar o
 * outro jeito chegar. Subdomínios que não são nem o apex nem o www
 * (app.example.com, blog.example.com) não ganham par.
 *
 * Sem biblioteca de sufixos públicos: uma lista curta de sufixos compostos
 * conhecidos (com.br, co.uk…). Um sufixo composto que não está na lista cai no
 * lado seguro: o nome é tratado como subdomínio e NÃO ganha par.
 */

/** Sufixos públicos de dois rótulos mais comuns (o apex tem um rótulo a mais que eles). */
export const COMPOUND_SUFFIXES: ReadonlySet<string> = new Set([
  "com.br", "net.br", "org.br", "gov.br", "edu.br", "mil.br", "art.br", "blog.br", "eco.br", "emp.br", "eng.br", "adv.br",
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
  "co.za", "org.za", "net.za", "gov.za",
  "co.in", "net.in", "org.in", "gov.in", "ac.in",
  "co.kr", "or.kr", "ne.kr", "go.kr",
  "com.mx", "org.mx", "gob.mx", "edu.mx",
  "com.ar", "org.ar", "gob.ar", "net.ar",
  "com.co", "org.co", "net.co",
  "com.pe", "com.uy", "com.ve", "com.ec", "com.py", "com.bo", "com.gt", "com.pa", "com.do",
  "com.cn", "net.cn", "org.cn", "gov.cn",
  "com.tw", "org.tw", "com.hk", "com.sg", "com.my", "com.ph", "com.vn", "co.th", "co.id",
  "com.tr", "com.ua", "com.pl", "com.ru", "co.il", "com.eg", "com.ng", "co.ke", "com.sa", "com.pk", "com.bd",
]);

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
  return /^\d+(\.\d+)*$/.test(host.split(".").at(-1) ?? "");
}

function isShared(host: string): boolean {
  return SHARED_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

/** Quantos rótulos tem o sufixo público do nome (1 = .com; 2 = com.br). */
function suffixLabels(labels: string[]): number {
  return labels.length >= 2 && COMPOUND_SUFFIXES.has(labels.slice(-2).join(".")) ? 2 : 1;
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
 * Como escrever o nome no provedor de DNS: "@" para o apex, "www" ou o
 * trecho antes do apex (loja para loja.example.com). Nome fora da zona
 * conhecida: o próprio nome.
 */
export function dnsHostLabel(raw: string): string {
  const host = cleanHost(raw);
  const apex = apexOf(host);
  if (!apex) return host;
  if (host === apex) return "@";
  return host.slice(0, host.length - apex.length - 1);
}
