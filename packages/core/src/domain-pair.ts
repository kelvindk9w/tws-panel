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
  "dev.br", "app.br", "tec.br", "ind.br", "inf.br", "wiki.br", "log.br", "tur.br", "tv.br", "fm.br", "rec.br", "srv.br", "esp.br",
  "eti.br", "far.br", "fnd.br", "fot.br", "jor.br", "mus.br", "not.br", "ppg.br", "psc.br", "qsl.br", "slg.br", "vet.br", "zlg.br",
  "agr.br", "am.br", "arq.br", "bio.br", "cim.br", "cng.br", "cnt.br", "coop.br", "ecn.br", "etc.br", "flog.br", "ggf.br", "gru.br",
  "imb.br", "jus.br", "lel.br", "mat.br", "med.br", "mp.br", "nom.br", "odo.br", "pro.br", "psi.br", "radio.br", "taxi.br", "trd.br",
  "b.br", "leg.br", "def.br", "ntr.br", "net.pt", "com.pt", "org.pt", "gov.pt", "edu.pt", "com.es", "org.es", "nom.es", "gob.es",
  "com.de", "co.at", "or.at", "com.fr", "asso.fr", "com.it", "com.ch", "com.nl", "co.hu", "com.gr", "com.cy", "com.pt",
  "co.ao", "co.mz", "com.cv", "co.cr", "com.cr", "com.sv", "com.hn", "com.ni", "com.cu", "com.pr", "com.cl", "com.bz", "com.ky",
  "co.ve", "com.lb", "com.qa", "com.kw", "com.om", "com.jo", "com.np", "com.lk", "com.mm", "com.kh", "co.ma", "co.tz", "co.ug", "co.zw", "com.gh",
  // domínios de cidade do Registro.br (cidade.br)
  "aju.br", "bage.br", "barueri.br", "belem.br", "bhz.br", "boavista.br", "bsb.br", "campinas.br", "caxias.br", "cuiaba.br",
  "curitiba.br", "floripa.br", "fortal.br", "foz.br", "goiania.br", "jab.br", "jampa.br", "joinville.br", "londrina.br",
  "maceio.br", "manaus.br", "natal.br", "niteroi.br", "osasco.br", "palmas.br", "poa.br", "recife.br", "rio.br", "riobranco.br",
  "salvador.br", "sampa.br", "santamaria.br", "santoandre.br", "santos.br", "saoluis.br", "sjc.br", "slz.br", "sorocaba.br",
  "teresina.br", "uberlandia.br", "vitoria.br", "vix.br", "vlg.br",
  "ong.br", "agro.br",
  // CentralNic (países e regiões sob .com/.net/.org)
  "br.com", "cn.com", "de.com", "eu.com", "gb.com", "gb.net", "hu.com", "hu.net", "jpn.com", "kr.com", "no.com", "qc.com",
  "ru.com", "sa.com", "se.com", "se.net", "uk.com", "uk.net", "us.com", "uy.com", "za.com", "ae.org", "us.org", "jp.net",
  "ar.com", "africa.com", "in.net", "ca.com", "mex.com", "co.com", "web.com", "gr.com", "it.com",
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
  return /^\d+$/.test(host.slice(host.lastIndexOf(".") + 1));
}

function isShared(host: string): boolean {
  return SHARED_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

const BR_STATES: ReadonlySet<string> = new Set([
  "ac", "al", "am", "ap", "ba", "ce", "df", "es", "go", "ma", "mg", "ms", "mt", "pa", "pb", "pe", "pi", "pr", "rj", "rn", "ro", "rr", "rs", "sc", "se", "sp", "to",
]);
const BR_STATE_BRANCHES: ReadonlySet<string> = new Set(["gov", "jus", "leg", "mp", "def"]);

/** Sufixo de três rótulos do Registro.br: <uf>.gov.br, <uf>.jus.br, <uf>.leg.br, <uf>.mp.br, <uf>.def.br. */
function isBrStateBranch(labels: string[]): boolean {
  const n = labels.length;
  return n >= 4 && labels[n - 1] === "br" && BR_STATE_BRANCHES.has(labels[n - 2]!) && BR_STATES.has(labels[n - 3]!);
}

/** Quantos rótulos tem o sufixo público do nome (1 = .com; 2 = com.br; 3 = sp.gov.br). */
function suffixLabels(labels: string[]): number {
  if (isBrStateBranch(labels)) return 3;
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
 * O sufixo do nome é incerto: três rótulos ou mais e o sufixo NÃO está na lista, em
 * um destes casos em que a zona pode começar mais à direita do que o esperado:
 *  - qualquer .br (o Registro.br tem dezenas de domínios de cidade, estado e categoria);
 *  - país (2 letras) com penúltimo rótulo de até 4 letras (example.xyz.zz);
 *  - .com/.net/.org com penúltimo rótulo de 2 letras (CentralNic: example.xx.com).
 * Nesses casos não dá para dizer onde a zona começa, e o guia mostra o nome completo.
 */
export function hasUncertainSuffix(raw: string): boolean {
  const labels = cleanHost(raw).split(".");
  if (labels.length < 3) return false;
  const tld = labels[labels.length - 1]!;
  const second = labels[labels.length - 2]!;
  if (isBrStateBranch(labels)) return false;
  // x.<?>.gov.br com <?> que não é estado: a zona é desconhecida
  if (tld === "br" && BR_STATE_BRANCHES.has(second) && labels.length >= 4) return true;
  if (COMPOUND_SUFFIXES.has(`${second}.${tld}`)) return false;
  if (tld === "br") return true;
  if (tld.length === 2) return second.length <= 4;
  return (tld === "com" || tld === "net" || tld === "org") && second.length === 2;
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
