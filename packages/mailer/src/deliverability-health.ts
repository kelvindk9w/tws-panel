/**
 * deliverability-health.ts — saúde de entregabilidade de um domínio de e-mail:
 * o plano de registros DNS (ordenado, com valor pronto para copiar) e a
 * verificação ao vivo de cada requisito que Gmail, Yahoo e Microsoft pedem de
 * quem envia.
 *
 * Nada aqui promete caixa de entrada. Mede o que dá para medir e diz se o
 * remetente está conforme as exigências; reputação do IP, engajamento e
 * reclamações são dos provedores.
 *
 * Tudo que sai para a rede tem alvo fixo ou derivado do domínio configurado:
 * consultas DNS pelos resolvedores públicos, a sonda da porta 25 (hosts fixos)
 * e a política MTA-STS (https://mta-sts.<domínio>/…). Nenhum destino digitado
 * por quem usa a API. Mesmo assim, todo endereço resolvido passa por
 * `isPrivateAddress` antes da conexão (um DNS malicioso do domínio poderia
 * apontar para 127.0.0.1 ou para o endereço de metadados da nuvem).
 *
 * Os resolvedores, a sonda e a busca da política são injetáveis: os testes não
 * saem para a rede.
 */
import { createHash, createPublicKey } from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import https from "node:https";
import {
  isMailHealthAcknowledgeable,
  mailHealthCounts,
  mailHealthFingerprint,
  mailHealthScope,
  type BlacklistCheckResponse,
  type DeliveryHealthResponse,
  type DmarcStage,
  type DnsPlanRecord,
  type DnsPlanResponse,
  type MailHealthCheck,
  type MailHealthAcknowledgement,
  type MailHealthCheckId,
  type MailHealthCounts,
  type MailHealthLevel,
  type MailHealthScopeSummary,
  type PtrCheck,
} from "@paas/core";
import { dmarcValue, spfValue, type DnsResolverLike } from "./dns-checklist.js";
import type { QueueItemView } from "./queue-view.js";

// ---------------------------------------------------------------------------
// Plano de registros
// ---------------------------------------------------------------------------

export interface PlanInput {
  domain: string;
  mailHostname: string;
  /** Nome com que o servidor se apresenta (HELO); o PTR deve ser este. */
  serverHostname: string;
  serverIp: string;
  serverIpv6?: string | null;
  dkimSelector: string;
  dkimPublicKey: string;
  dmarcStage: DmarcStage;
  /** A chave DKIM foi criada mas o servidor ainda não reiniciou para assinar com ela. */
  dkimRestartPending?: boolean;
}

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

/** Todos os registros a criar, na ordem em que a pessoa deve criá-los. */
export function buildDnsPlan(input: PlanInput): DnsPlanResponse {
  const { domain, mailHostname, serverHostname, serverIp, dkimSelector, dkimPublicKey, dmarcStage } = input;
  const policy = mtaStsPolicy(mailHostname);
  const records: Omit<DnsPlanRecord, "order" | "proxied">[] = [
    { id: "a", type: "A", name: mailHostname, value: serverIp, need: "required", purpose: "a" },
  ];
  if (serverHostname !== mailHostname) {
    records.push({ id: "a_helo", type: "A", name: serverHostname, value: serverIp, need: "required", purpose: "a_helo" });
  }
  if (input.serverIpv6) {
    records.push({ id: "aaaa", type: "AAAA", name: mailHostname, value: input.serverIpv6, need: "required", purpose: "aaaa" });
  }
  records.push(
    { id: "mx", type: "MX", name: domain, value: mailHostname, priority: 10, need: "required", purpose: "mx" },
    { id: "spf", type: "TXT", name: domain, value: spfValue(serverIp, dmarcStage), need: "required", purpose: "spf" },
    {
      id: "dkim",
      type: "TXT",
      name: `${dkimSelector}._domainkey.${domain}`,
      value: `v=DKIM1; k=rsa; p=${dkimPublicKey}`,
      need: "required",
      purpose: "dkim",
    },
    { id: "dmarc", type: "TXT", name: `_dmarc.${domain}`, value: dmarcValue(domain, dmarcStage), need: "required", purpose: "dmarc" },
    {
      id: "tls_rpt",
      type: "TXT",
      name: `_smtp._tls.${domain}`,
      value: `v=TLSRPTv1; rua=mailto:postmaster@${domain}`,
      need: "optional",
      purpose: "tls_rpt",
    },
    { id: "mta_sts_a", type: "A", name: mtaStsHostFor(domain), value: serverIp, need: "optional", purpose: "mta_sts_a" },
    { id: "mta_sts", type: "TXT", name: `_mta-sts.${domain}`, value: `v=STSv1; id=${mtaStsId(policy)}`, need: "optional", purpose: "mta_sts" },
  );
  return {
    domain,
    serverHostname,
    records: records.map((r, i) => ({ ...r, order: i + 1, proxied: false })),
    mtaStsPolicy: policy,
    ptr: { ip: serverIp, expected: serverHostname },
  };
}

// ---------------------------------------------------------------------------
// Endereços e sondas de rede
// ---------------------------------------------------------------------------

/** IPv4 em número, ou null se não for um IPv4. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
  return parts.reduce((acc, p) => acc * 256 + Number(p), 0);
}

/** Faixas que nunca são alvo (montadas por números: não são endereços reais). */
const PRIVATE_V4: Array<[number[], number]> = [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16], // inclui o endereço de metadados da nuvem
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
];

function inCidr(ip: number, base: string, bits: number): boolean {
  const start = ipv4ToInt(base) as number;
  const size = 2 ** (32 - bits);
  return ip >= start && ip < start + size;
}

function isPrivateV4(value: number): boolean {
  return PRIVATE_V4.some(([base, bits]) => inCidr(value, base.join("."), bits));
}

/** IPv6 já validado (net.isIPv6) em 16 bytes: aceita "::", forma longa e IPv4 embutido. */
function ipv6Bytes(input: string): number[] {
  let value = input;
  if (value.includes(".")) {
    const colon = value.lastIndexOf(":");
    const tail = ipv4ToInt(value.slice(colon + 1)) as number; // quem chama já validou com net.isIPv6
    value = `${value.slice(0, colon + 1)}${(tail >>> 16).toString(16)}:${(tail & 0xffff).toString(16)}`;
  }
  const halves = value.split("::");
  const groups = (text: string | undefined) => (text ? text.split(":") : []);
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  const all = halves.length === 2 ? [...head, ...Array<string>(8 - head.length - rest.length).fill("0"), ...rest] : head;
  return all.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 0xff]);
}

/** Loopback, rede privada, link-local, metadados, multicast, NAT64 ou não é um IP: não pode ser alvo. */
export function isPrivateAddress(address: string): boolean {
  const value = address.trim().toLowerCase();
  const v4 = ipv4ToInt(value);
  if (v4 !== null) return isPrivateV4(v4);
  if (!net.isIPv6(value) || value.includes("%")) return true;
  const b = ipv6Bytes(value);
  const embedded = (at: number) => (b[at]! * 2 ** 24) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zeros(0, 10)) {
    // ::, ::1, ::a.b.c.d (compatível, em desuso) são sempre recusados; ::ffff:a.b.c.d vale o IPv4 embutido
    return b[10] === 0xff && b[11] === 0xff ? isPrivateV4(embedded(12)) : true;
  }
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return true; // NAT64 (64:ff9b::/96 e /48 local)
  if (b[0] === 0x01 && zeros(1, 8)) return true; // 100::/64 (descarte)
  if (b[0] === 0x20 && b[1] === 0x01 && ((b[2] === 0 && b[3] === 0) || (b[2] === 0x0d && b[3] === 0xb8))) return true; // Teredo e documentação
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateV4(embedded(2)); // 6to4
  if ((b[0]! & 0xfe) === 0xfc) return true; // fc00::/7
  if (b[0] === 0xfe && (b[1]! & 0x80) !== 0) return true; // fe80::/10 e fec0::/10
  return b[0] === 0xff; // multicast
}

export type LookupAll = (host: string) => Promise<string[]>;

const systemLookupAll: LookupAll = async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address);

/** Endereços públicos de um nome; nome que resolve para rede privada (ou nada) é recusado. */
export async function publicAddressesOf(host: string, lookup: LookupAll = systemLookupAll): Promise<string[]> {
  const addresses = await lookup(host);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error("destino_nao_publico");
  }
  return addresses;
}

/** Destinos fixos da sonda da porta 25 (MX públicos de provedores grandes). */
export const PORT25_PROBE_HOSTS = ["gmail-smtp-in.l.google.com", "outlook-com.olc.protection.outlook.com"] as const;

export interface Port25Result {
  /** open = conectou e veio o "220"; blocked = ninguém atendeu (caso comum de VPS); error = não deu para testar. */
  status: "open" | "blocked" | "error";
  host?: string;
  detail?: string;
}

/** Abre TCP e devolve a primeira linha que o servidor manda. Sem verificação de destino: quem chama valida. */
export function readSmtpBanner(address: string, port: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, port });
    let buffer = "";
    const done = (err: Error | null, line?: string) => {
      socket.destroy();
      if (err) reject(err);
      else resolve(line as string);
    };
    socket.setTimeout(timeoutMs, () => done(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    socket.on("error", (err) => done(err));
    socket.on("close", () => done(new Error("conexao_fechada")));
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("latin1");
      const end = buffer.indexOf("\n");
      if (end >= 0) done(null, buffer.slice(0, end).trim());
      else if (buffer.length > 512) done(null, buffer.slice(0, 512));
    });
  });
}

export interface Port25Deps {
  hosts?: readonly string[];
  lookup?: LookupAll;
  banner?: (address: string, port: number, timeoutMs: number) => Promise<string>;
  timeoutMs?: number;
}

/**
 * A porta 25 de SAÍDA está liberada? Conecta num MX público de teste e espera
 * o "220". Provedores de VPS costumam bloquear essa porta (é o caso comum);
 * sem ela nada sai para o Gmail, e o painel diz isso em vez de "falha".
 */
export async function probePort25(deps: Port25Deps = {}): Promise<Port25Result> {
  /* v8 ignore next 2 -- padrões de produção (DNS do sistema e conexão real); os testes injetam os dois */
  const lookup = deps.lookup ?? systemLookupAll;
  const banner = deps.banner ?? readSmtpBanner;
  let blocked: Port25Result | null = null;
  let failure: Port25Result = { status: "error", detail: "sem_destino" };
  for (const host of deps.hosts ?? PORT25_PROBE_HOSTS) {
    try {
      const addresses = await publicAddressesOf(host, lookup);
      const line = await banner(addresses[0] as string, 25, deps.timeoutMs ?? 6_000);
      if (line.startsWith("220")) return { status: "open", host };
      blocked = { status: "blocked", host, detail: "sem_banner" };
    } catch (err) {
      const code = (err as { code?: string }).code ?? (err as Error).message;
      if (["ETIMEDOUT", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "conexao_fechada"].includes(code)) {
        blocked = { status: "blocked", host, detail: code };
      } else {
        failure = { status: "error", host, detail: code };
      }
    }
  }
  return blocked ?? failure;
}

export interface PolicyDeps {
  lookup?: LookupAll;
  get?: (address: string, host: string, timeoutMs: number) => Promise<string | null>;
  timeoutMs?: number;
}

const MAX_POLICY_BYTES = 16 * 1024;

/** GET https://mta-sts.<host>/.well-known/mta-sts.txt no IP já validado: sem redirecionamento, certificado conferido, 16 KB no máximo. */
export function getHttpsPolicy(
  address: string,
  host: string,
  timeoutMs: number,
  /** Só para testes (porta e CA de um servidor local); em produção fica vazio. */
  extra: https.RequestOptions = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    // O prazo é do RELÓGIO: `timeout` do https só vale para inatividade, e um servidor que manda 1 byte
    // de vez em quando seguraria o botão e a rotina diária para sempre.
    const wall = setTimeout(() => {
      request.destroy();
      resolve(null);
    }, timeoutMs);
    wall.unref();
    const finish = (value: string | null) => {
      clearTimeout(wall);
      resolve(value);
    };
    const request = https.get(
      { host: address, servername: host, path: "/.well-known/mta-sts.txt", headers: { Host: host }, timeout: timeoutMs, ...extra },
      (response) => {
        // Remetentes exigem text/plain: uma política com outro tipo não vale, e o painel não pode dizer que está em ordem.
        const type = String(response.headers["content-type"] ?? "").toLowerCase();
        if (response.statusCode !== 200 || !type.startsWith("text/plain")) {
          response.resume();
          finish(null);
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > MAX_POLICY_BYTES) {
            request.destroy();
            finish(null);
          }
        });
        response.on("end", () => finish(body));
        response.on("error", () => finish(null));
      },
    );
    request.on("timeout", () => request.destroy());
    request.on("error", () => finish(null));
  });
}

/** Política MTA-STS publicada em https://mta-sts.<domínio>/.well-known/mta-sts.txt (null = inalcançável). */
export async function fetchMtaStsPolicy(domain: string, deps: PolicyDeps = {}): Promise<string | null> {
  const host = `mta-sts.${domain}`;
  const timeoutMs = deps.timeoutMs ?? 5_000;
  return withDeadline(
    (async () => {
      try {
        const addresses = await publicAddressesOf(host, deps.lookup);
        /* v8 ignore next -- padrões de produção (GET real); os testes injetam o get */
        return await (deps.get ?? getHttpsPolicy)(addresses[0] as string, host, timeoutMs);
      } catch {
        return null;
      }
    })(),
    timeoutMs + 500,
    null,
  );
}

/** Resolve com `fallback` se a promessa não terminar no prazo (relógio). Não deixa timer pendurado. */
export async function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// SPF
// ---------------------------------------------------------------------------

export type SpfOutcome = "pass" | "fail" | "softfail" | "neutral" | "permerror";

export interface SpfAnalysis {
  /** Registros "v=spf1" encontrados (mais de um é erro permanente para quem recebe). */
  records: string[];
  /** Consultas DNS que o SPF faz ao ser avaliado (o limite é 10). */
  lookups: number;
  /** O IP do servidor passa no SPF (o primeiro termo que casa, com o qualificador dele, é "+"). */
  authorizes: boolean;
  /** Resultado que um receptor daria ao IP do servidor. */
  outcome: SpfOutcome;
  /** Qualificador do "all" que vale (o do registro, ou o do destino de um redirect=), null se não houver. */
  all: string | null;
  usesPtr: boolean;
  /** Algum termo usa macro (%{...}): não é expandida, então o resultado pode não ser definitivo. */
  macros: boolean;
}

const MAX_SPF_DEPTH = 10;

function spfRecordsOf(txt: string[][]): string[] {
  return txt.map((parts) => parts.join("")).filter((r) => /^v=spf1(\s|$)/i.test(r.trim()));
}

function ipv4InMechanism(ip: string, spec: string): boolean {
  const [base = "", bits] = spec.split("/");
  const target = ipv4ToInt(ip);
  const start = ipv4ToInt(base);
  if (target === null || start === null) return false;
  const length = bits === undefined ? 32 : Number(bits);
  if (!Number.isInteger(length) || length < 0 || length > 32) return false;
  return inCidr(target, base, length) || base === ip;
}

async function safe<T>(fn: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return empty;
  }
}

const QUALIFIER_OUTCOME: Record<string, SpfOutcome> = { "+": "pass", "-": "fail", "~": "softfail", "?": "neutral" };

/**
 * Avalia o SPF como um receptor: termos em ordem, o primeiro que casa decide,
 * o qualificador manda ("-ip4:" NÃO autoriza), termos depois de "all" são
 * ignorados, "redirect=" só vale sem "all" e herda o "all" do destino, e
 * include/redirect para um nome sem SPF é erro permanente. Macros (%{...}) não
 * são expandidas: o termo não casa e o resultado fica marcado como incerto.
 */
export async function analyzeSpf(domain: string, ip: string, resolver: DnsResolverLike): Promise<SpfAnalysis> {
  const result: SpfAnalysis = { records: [], lookups: 0, authorizes: false, outcome: "neutral", all: null, usesPtr: false, macros: false };

  const walk = async (name: string, depth: number): Promise<{ outcome: SpfOutcome | "none"; all: string | null }> => {
    const records = spfRecordsOf(await safe(() => resolver.resolveTxt(name), []));
    if (depth === 0) result.records = records;
    if (records.length !== 1 && depth > 0) return { outcome: "permerror", all: null };
    const record = records[0];
    if (record === undefined || depth > MAX_SPF_DEPTH) return { outcome: depth === 0 ? "none" : "permerror", all: null };
    const state: { decided: SpfOutcome | null } = { decided: null };
    let all: string | null = null;
    let redirect: string | null = null;
    const decide = (outcome: SpfOutcome) => {
      if (state.decided === null) state.decided = outcome;
    };
    for (const term of record.trim().split(/\s+/).slice(1)) {
      if (/^redirect=/i.test(term)) {
        redirect = term.slice(9);
        continue;
      }
      if (/^[a-z][a-z0-9_.-]*=/i.test(term)) continue; // exp= e outros modificadores
      const qualifier = /^[+\-~?]/.test(term) ? (term[0] as string) : "+";
      const body = term.replace(/^[+\-~?]/, "");
      const lower = body.toLowerCase();
      const outcome = QUALIFIER_OUTCOME[qualifier] as SpfOutcome;
      if (body.includes("%{")) result.macros = true;
      if (lower === "all") {
        all = `${qualifier}all`;
        decide(outcome);
        break; // nada depois de "all" é avaliado
      }
      if (lower.startsWith("ip4:")) {
        if (ipv4InMechanism(ip, body.slice(4))) decide(outcome);
      } else if (lower.startsWith("include:")) {
        result.lookups += 1;
        if (body.includes("%{")) continue;
        const inner = await walk(body.slice(8), depth + 1);
        if (inner.outcome === "permerror") decide("permerror");
        else if (inner.outcome === "pass") decide(outcome);
      } else if (lower === "a" || lower.startsWith("a:") || lower.startsWith("a/")) {
        result.lookups += 1;
        if (body.includes("%{")) continue;
        const host = lower.startsWith("a:") ? body.slice(2).split("/")[0] : name;
        const addresses = await safe(() => resolver.resolve4(host as string), []);
        if (addresses.includes(ip)) decide(outcome);
      } else if (lower === "mx" || lower.startsWith("mx:") || lower.startsWith("mx/")) {
        result.lookups += 1;
        if (body.includes("%{")) continue;
        const host = lower.startsWith("mx:") ? body.slice(3).split("/")[0] : name;
        const exchanges = await safe(() => resolver.resolveMx(host as string), []);
        for (const mx of exchanges.slice(0, 10)) {
          if ((await safe(() => resolver.resolve4(mx.exchange), [])).includes(ip)) decide(outcome);
        }
      } else if (lower === "ptr" || lower.startsWith("ptr:")) {
        result.lookups += 1;
        result.usesPtr = true;
      } else if (lower.startsWith("exists:")) {
        result.lookups += 1;
      }
    }
    if (state.decided !== null) {
      if (all === null && redirect !== null) result.lookups += 1; // conta no limite mesmo sem ser avaliado
      return { outcome: state.decided, all };
    }
    if (all === null && redirect !== null) {
      result.lookups += 1;
      if (redirect.includes("%{")) {
        result.macros = true;
        return { outcome: "neutral", all: null };
      }
      const target = await walk(redirect, depth + 1);
      return { outcome: target.outcome === "none" ? "permerror" : target.outcome, all: target.all };
    }
    return { outcome: "neutral", all };
  };

  const top = await walk(domain, 0);
  result.outcome = top.outcome === "none" ? "neutral" : top.outcome;
  result.all = top.all;
  result.authorizes = result.outcome === "pass";
  return result;
}

// ---------------------------------------------------------------------------
// Verificações
// ---------------------------------------------------------------------------

function check(
  id: MailHealthCheckId,
  level: MailHealthLevel,
  inbox: boolean,
  code: string,
  params: MailHealthCheck["params"] = {},
  extra: { expected?: string; found?: string[] } = {},
): MailHealthCheck {
  return { id, level, inbox, code, params, ...extra };
}

/** Consulta que não respondeu (diferente de "não existe") vira null. */
async function ask<T>(fn: () => Promise<T>, empty: T): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    return ["ENOTFOUND", "ENODATA", "NOTFOUND", "NODATA"].includes((err as { code?: string }).code ?? "") ? empty : null;
  }
}

const txtOf = (chunks: string[][]): string[] => chunks.map((parts) => parts.join(""));

function tags(record: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of record.split(";")) {
    const index = part.indexOf("=");
    if (index > 0) map.set(part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim());
  }
  return map;
}

async function checkAddress(
  id: "a" | "helo",
  host: string,
  ip: string,
  resolver: DnsResolverLike,
  isProxyIp: (ip: string) => boolean,
): Promise<MailHealthCheck> {
  const found = await ask(() => resolver.resolve4(host), []);
  const base = { expected: ip };
  if (found === null) return check(id, "warn", false, "unavailable", { host }, base);
  if (found.length === 0) return check(id, "critical", true, "missing", { host, ip }, { ...base, found });
  if (found.includes(ip)) return check(id, "ok", true, "ok", { host, ip }, { ...base, found });
  if (found.every(isProxyIp)) return check(id, "critical", true, "proxied", { host, ip }, { ...base, found });
  return check(id, "critical", true, "mismatch", { host, ip, found: found.join(", ") }, { ...base, found });
}

async function checkMx(domain: string, mailHostname: string, ip: string, resolver: DnsResolverLike): Promise<MailHealthCheck> {
  const mx = await ask(() => resolver.resolveMx(domain), []);
  if (mx === null) return check("mx", "warn", false, "unavailable", { domain });
  const found = mx.sort((a, b) => a.priority - b.priority).map((m) => `${m.priority} ${m.exchange.replace(/\.$/, "").toLowerCase()}`);
  const expected = `10 ${mailHostname}`;
  if (mx.length === 0) return check("mx", "warn", true, "missing", { domain, host: mailHostname }, { expected, found });
  if (!found.some((f) => f.endsWith(` ${mailHostname.toLowerCase()}`))) {
    return check("mx", "warn", false, "other", { domain, found: found.join(", ") }, { expected, found });
  }
  const addresses = await ask(() => resolver.resolve4(mailHostname), []);
  if (addresses !== null && addresses.length > 0 && !addresses.includes(ip)) {
    return check("mx", "critical", true, "target_wrong_ip", { host: mailHostname, ip }, { expected, found });
  }
  return check("mx", "ok", true, "ok", { host: mailHostname }, { expected, found });
}

async function checkSpf(domain: string, ip: string, stage: DmarcStage, resolver: DnsResolverLike): Promise<MailHealthCheck> {
  const expected = spfValue(ip, stage);
  const txt = await ask(() => resolver.resolveTxt(domain), []);
  if (txt === null) return check("spf", "warn", false, "unavailable", { domain });
  const spf = await analyzeSpf(domain, ip, resolver);
  if (spf.records.length === 0) return check("spf", "critical", true, "missing", { domain }, { expected });
  if (spf.records.length > 1) return check("spf", "critical", true, "multiple", { count: spf.records.length }, { expected, found: spf.records });
  const found = spf.records;
  if (spf.lookups > 10) return check("spf", "critical", true, "too_many_lookups", { lookups: spf.lookups }, { expected, found });
  if (spf.outcome === "permerror") return check("spf", "critical", true, "permerror", {}, { expected, found });
  if (!spf.authorizes) {
    // Macros não são expandidas aqui: dizer "IP ausente" seria afirmar o que não se sabe.
    if (spf.macros) return check("spf", "warn", true, "has_macros", {}, { expected, found });
    return check("spf", "critical", true, "ip_missing", { ip }, { expected, found });
  }
  if (spf.all === null || spf.all === "+all" || spf.all === "?all") {
    return check("spf", "critical", true, "weak_all", { all: spf.all ?? "" }, { expected, found });
  }
  if (spf.lookups >= 8) return check("spf", "warn", true, "near_limit", { lookups: spf.lookups }, { expected, found });
  if (spf.usesPtr) return check("spf", "warn", true, "uses_ptr", {}, { expected, found });
  return check("spf", "ok", true, spf.all === "-all" ? "ok_hard" : "ok_soft", { lookups: spf.lookups }, { expected, found });
}

function keyBits(publicKey: string): number | null {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
    return key.asymmetricKeyDetails?.modulusLength ?? null;
  } catch {
    return null;
  }
}

async function checkDkim(
  domain: string,
  selector: string,
  expectedKey: string,
  resolver: DnsResolverLike,
  pendingRestart = false,
): Promise<MailHealthCheck> {
  const name = `${selector}._domainkey.${domain}`;
  const expected = `v=DKIM1; k=rsa; p=${expectedKey}`;
  const txt = await ask(() => resolver.resolveTxt(name), []);
  if (txt === null) return check("dkim", "warn", false, "unavailable", { name });
  const found = txtOf(txt).filter((r) => /v=DKIM1|p=/i.test(r));
  if (found.length === 0) return check("dkim", "critical", true, "missing", { name }, { expected });
  const published = tags(found[0] as string).get("p")?.replace(/\s+/g, "") ?? "";
  const extra = { expected, found };
  if (published === "") return check("dkim", "critical", true, "revoked", { name }, extra);
  const bits = keyBits(published);
  if (bits === null) return check("dkim", "critical", true, "invalid_key", { name }, extra);
  if (published !== expectedKey) return check("dkim", "critical", true, "mismatch", { name }, extra);
  if (bits < 1024) return check("dkim", "critical", true, "weak_key", { bits }, extra);
  // O DNS está certo, mas o servidor ainda não carregou a chave: sem o reinício a mensagem sai SEM assinatura.
  if (pendingRestart) return check("dkim", "warn", true, "restart_pending", { selector }, extra);
  if (bits < 2048) return check("dkim", "warn", true, "short_key", { bits }, extra);
  return check("dkim", "ok", true, "ok", { bits, selector }, extra);
}

/** Domínios acima do nome (sub.exemplo.com → exemplo.com), com ao menos dois rótulos. */
function parentsOf(domain: string): string[] {
  const labels = domain.split(".");
  const parents: string[] = [];
  for (let i = 1; labels.length - i >= 2; i += 1) parents.push(labels.slice(i).join("."));
  return parents;
}

async function checkDmarc(domain: string, stage: DmarcStage, resolver: DnsResolverLike): Promise<MailHealthCheck> {
  const expected = dmarcValue(domain, stage);
  const find = async (name: string): Promise<string[] | null> => {
    const txt = await ask(() => resolver.resolveTxt(`_dmarc.${name}`), []);
    return txt === null ? null : txtOf(txt).filter((r) => /^v=DMARC1/i.test(r.trim()));
  };
  let records = await find(domain);
  if (records === null) return check("dmarc", "warn", false, "unavailable", { domain });
  let inherited: string | null = null;
  if (records.length === 0) {
    for (const parent of parentsOf(domain)) {
      const upper = await find(parent);
      if (upper && upper.length > 0) {
        records = upper;
        inherited = parent;
        break;
      }
    }
  }
  if (records.length === 0) return check("dmarc", "critical", true, "missing", { domain }, { expected });
  if (records.length > 1) return check("dmarc", "critical", true, "multiple", { count: records.length }, { expected, found: records });
  const parsed = tags(records[0] as string);
  const policy = (parsed.get("p") ?? "").toLowerCase();
  const extra = { expected, found: records };
  if (!["none", "quarantine", "reject"].includes(policy)) return check("dmarc", "critical", true, "invalid", {}, extra);
  if (inherited) return check("dmarc", "warn", true, "inherited", { parent: inherited, policy }, extra);
  if (!parsed.get("rua")) return check("dmarc", "warn", false, "no_rua", { policy }, extra);
  return check("dmarc", "ok", true, policy, { policy }, extra);
}

function checkPtr(ptr: PtrCheck): MailHealthCheck {
  const extra = { expected: ptr.expected, found: ptr.found };
  const params = { ip: ptr.ip, expected: ptr.expected, current: ptr.found[0] ?? "" };
  switch (ptr.status) {
    case "found":
      return check("ptr", "ok", true, "ok", params, extra);
    case "generic":
      return check("ptr", "warn", true, "generic", params, extra);
    // Atenção forte, não crítico: SPF, DKIM e DMARC passando, o Gmail aceita sem o
    // PTR (confirmado na VPS real); Microsoft, Yahoo e servidores corporativos
    // podem atrasar ou recusar. Vermelho fica para porta 25 bloqueada e falha de
    // autenticação, que impedem o envio de fato.
    case "mismatch":
      return check("ptr", "warn", true, "mismatch", params, extra);
    case "action_required":
      return check("ptr", "warn", true, "missing", params, extra);
    default:
      return check("ptr", "warn", false, "unavailable", params, extra);
  }
}

function checkPort25(result: Port25Result): MailHealthCheck {
  if (result.status === "open") return check("port25", "ok", true, "ok", { host: result.host ?? "" });
  if (result.status === "blocked") return check("port25", "critical", true, "blocked", { detail: result.detail ?? "" });
  return check("port25", "warn", false, "unavailable", { detail: result.detail ?? "" });
}

export interface TlsHostState {
  host: string;
  ok: boolean;
  validTo: string | null;
  error: string | null;
}

const DAY_MS = 86_400_000;

function checkTls(serverRunning: boolean, hosts: TlsHostState[], now: number): MailHealthCheck {
  if (!serverRunning) return check("tls", "critical", true, "server_stopped");
  if (hosts.length === 0) return check("tls", "info", false, "no_hosts");
  const bad = hosts.find((h) => !h.ok);
  if (bad) return check("tls", "critical", true, "invalid", { host: bad.host, error: bad.error ?? "" });
  const known = hosts.filter((h) => h.validTo !== null && Number.isFinite(Date.parse(h.validTo)));
  // Sem validade conhecida não se afirma "ok, N dias": o certificado é válido, a data é que não veio.
  if (known.length === 0) return check("tls", "info", false, "expiry_unknown", { host: (hosts[0] as TlsHostState).host });
  const days = (h: TlsHostState) => Math.floor((Date.parse(h.validTo as string) - now) / DAY_MS);
  const worst = known.reduce((a, b) => (days(b) < days(a) ? b : a), known[0] as TlsHostState);
  const left = days(worst);
  const params = { host: worst.host, days: left };
  if (left < 7) return check("tls", "critical", true, "expiring", params);
  if (left < 15) return check("tls", "warn", true, "expiring_soon", params);
  return check("tls", "ok", true, "ok", params);
}

function checkDnsbl(list: BlacklistCheckResponse | null): MailHealthCheck {
  if (!list) return check("dnsbl", "info", false, "not_checked");
  const results = [...(list.ip ? list.ip.results : []), ...list.domains.flatMap((d) => d.results)];
  const listed = results.filter((r) => r.status === "listed");
  if (listed.length > 0) return check("dnsbl", "critical", true, "listed", { lists: listed.map((r) => r.label).join(", ") });
  if (results.some((r) => r.status === "unknown")) {
    return check("dnsbl", "info", false, "unknown", { lists: results.filter((r) => r.status === "unknown").map((r) => r.label).join(", ") });
  }
  return check("dnsbl", "ok", true, "ok", { count: results.length });
}

export interface ResolverEntry {
  label: string;
  resolver: DnsResolverLike;
}

/** Os mesmos registros de autenticação aparecem em todos os resolvedores públicos? */
async function checkPropagation(domain: string, selector: string, resolvers: ResolverEntry[]): Promise<MailHealthCheck> {
  const targets: Array<[string, string, RegExp]> = [
    ["SPF", domain, /^v=spf1(\s|$)/i],
    ["DKIM", `${selector}._domainkey.${domain}`, /v=DKIM1|p=/i],
    ["DMARC", `_dmarc.${domain}`, /^v=DMARC1/i],
  ];
  const lacking: string[] = [];
  let seen = false;
  for (const [label, name, pattern] of targets) {
    const answers = await Promise.all(
      resolvers.map(async (r) => ({ at: r.label, txt: await ask(() => r.resolver.resolveTxt(name), []) })),
    );
    const answered = answers.filter((a): a is { at: string; txt: string[][] } => a.txt !== null);
    const has = (a: { txt: string[][] }) => txtOf(a.txt).some((r) => pattern.test(r.trim()));
    if (answered.some(has)) {
      seen = true;
      for (const a of answered.filter((x) => !has(x))) lacking.push(`${label} (${a.at})`);
    }
  }
  if (lacking.length > 0) return check("propagation", "warn", false, "partial", { missing: lacking.join(", ") });
  return seen ? check("propagation", "ok", false, "ok") : check("propagation", "info", false, "none");
}

function mxMatches(pattern: string, host: string): boolean {
  const p = pattern.trim().toLowerCase();
  const h = host.toLowerCase();
  if (!p.startsWith("*.")) return p === h;
  // RFC 8461 §3.2: o curinga casa UM rótulo só (*.example.com casa a.example.com, não a.b.example.com)
  const suffix = p.slice(1);
  return h.endsWith(suffix) && h.length > suffix.length && !h.slice(0, -suffix.length).includes(".");
}

/** Estado do certificado de mta-sts.<domínio> segundo o painel (nunca por handshake TLS: ele dispararia a emissão). */
export type MtaStsCertState = "valid" | "issuing" | "waiting" | "failed" | "unknown";

/** Opcional: o envio funciona sem o item, então ele nunca pesa no resumo; só o "O que fazer" aparece. */
function optionalCheck(
  id: "mta_sts" | "tls_rpt",
  code: string,
  params: MailHealthCheck["params"] = {},
  extra: { expected?: string; found?: string[] } = {},
): MailHealthCheck {
  return check(id, "optional", false, code, params, extra);
}

/**
 * MTA-STS (opcional): o painel publica a política em https://mta-sts.<domínio>/.well-known/mta-sts.txt.
 * Faltam, na ordem: o registro A (ou CNAME) de mta-sts.<domínio>, o TXT _mta-sts e (por
 * dedução) o arquivo/certificado. Cada falta tem a sua mensagem.
 */
async function checkMtaSts(
  domain: string,
  mailHostname: string,
  serverIp: string,
  resolver: DnsResolverLike,
  fetchPolicy: (domain: string) => Promise<string | null>,
  isProxyIp: (ip: string) => boolean,
  certState: (host: string) => Promise<MtaStsCertState>,
  publishing: boolean,
  lastMode: string | null,
): Promise<MailHealthCheck> {
  const host = mtaStsHostFor(domain);
  const [txt, addresses, mxRecords] = await Promise.all([
    ask(() => resolver.resolveTxt(`_mta-sts.${domain}`), []),
    ask(() => resolver.resolve4(host), []),
    ask(() => resolver.resolveMx(domain), []),
  ]);
  // A política vale para o MX REAL do domínio (que pode ser de outro provedor). Consulta que FALHOU (null) é diferente
  // de domínio SEM MX ([]): no primeiro caso não se compara nada; no segundo o MX implícito é o próprio domínio (RFC 5321).
  const mxUnknown = mxRecords === null;
  const realMx = (mxRecords ?? []).map((m) => m.exchange.replace(/\.$/, "").toLowerCase());
  const mxList = realMx.length > 0 ? realMx : [domain.toLowerCase()];
  // Consulta do TXT que FALHOU (erro, timeout) não é "TXT inexistente": não se afirma nada, e o modo guardado não é apagado.
  if (txt === null) return check("mta_sts", "info", false, "txt_unavailable", { host: `_mta-sts.${domain}` });
  const found = txtOf(txt).filter((r) => /^v=STSv1/i.test(r.trim()));
  const a = addresses ?? [];
  const expectedId = mtaStsId(mtaStsPolicy(mailHostname));
  const expectedTxt = `v=STSv1; id=${expectedId}`;
  if (found.length === 0) {
    // Sem o TXT não há política: o modo guardado não vale mais (o painel o apaga ao ver este código).
    // Sem o domínio do painel o proxy não publica a política: não adianta mandar criar o A e o TXT.
    if (!publishing) return optionalCheck("mta_sts", "publish_unavailable", { host });
    return a.length === 0
      ? optionalCheck("mta_sts", "absent", { host })
      : optionalCheck("mta_sts", "missing_txt", { host }, { expected: expectedTxt, found });
  }
  // Com o TXT publicado, a política é a prova: se ela abre e é válida, está em ordem, seja do painel ou de fora.
  // Só quando não abre se diagnostica o A, a nuvem laranja e o certificado (nunca se manda trocar o A de quem funciona).
  const policy = await fetchPolicy(domain);
  /** Por que a política não abre: publicação indisponível, A ausente/errado/atrás do proxy, certificado ou nada conhecido. */
  const diagnoseUnreachable = async (): Promise<MailHealthCheck> => {
    if (!publishing) return optionalCheck("mta_sts", "publish_unavailable", { host }, { found });
    if (a.length === 0) return optionalCheck("mta_sts", "missing_a", { host, ip: serverIp }, { expected: serverIp, found });
    if (!a.includes(serverIp)) {
      return a.every(isProxyIp)
        ? optionalCheck("mta_sts", "a_proxied", { host, ip: serverIp }, { expected: serverIp, found: a })
        : optionalCheck("mta_sts", "a_mismatch", { host, ip: serverIp, found: a.join(", ") }, { expected: serverIp, found: a });
    }
    const state = await certState(host).catch((): MtaStsCertState => "unknown");
    if (state === "issuing" || state === "waiting") return optionalCheck("mta_sts", "cert_pending", { host }, { found });
    if (state === "failed") return optionalCheck("mta_sts", "cert_failed", { host }, { found });
    return optionalCheck("mta_sts", "unreachable", { host }, { found });
  };
  if (policy === null) {
    const cause = await diagnoseUnreachable();
    // Já esteve em enforce e deixou de abrir: os remetentes usam a cópia guardada até expirar, e se o MX mudou
    // nesse meio-tempo podem recusar a entrega. O painel não vê esse cache, então avisa. A causa diagnosticada
    // (A, nuvem laranja, certificado) continua aparecendo; o enforce anterior entra como agravante.
    if (lastMode !== "enforce") return cause;
    if (cause.code === "unreachable") return check("mta_sts", "warn", false, "enforce_lapsed", { host }, { found });
    return { ...cause, level: "warn", params: { ...cause.params, wasEnforce: "1" } };
  }
  const lines = policy.split(/\r?\n/).map((l) => l.split(":").map((s) => s.trim()));
  const value = (key: string) => lines.filter((l) => l[0]?.toLowerCase() === key).map((l) => l.slice(1).join(":"));
  const mode = (value("mode")[0] ?? "").toLowerCase();
  // Em enforce o remetente RECUSA a entrega quando a política não confere: aí deixa de ser opcional.
  const enforcing = mode === "enforce";
  if (value("version")[0] !== "STSv1") {
    return enforcing ? check("mta_sts", "warn", true, "invalid", {}, { found }) : optionalCheck("mta_sts", "invalid", {}, { found });
  }
  // A política é a do painel e o TXT guarda outro id: ela mudou (por exemplo, o MX) e o TXT precisa do id novo.
  // Política escrita à mão em outro lugar tem id próprio: não é comparada.
  const servedByPanel = policy.replace(/\r\n/g, "\n") === mtaStsServedPolicy(mailHostname);
  // Não deu para consultar o MX agora (erro, timeout): não se compara, e nunca se acende crítico por isso.
  if (mxUnknown) {
    // O modo é o da política que acabou de abrir (ou, se ele não vier, o guardado); o painel grava esse modo.
    const level = enforcing || lastMode === "enforce" ? "warn" : "info";
    return check("mta_sts", level, false, "mx_unverified", { host: domain, mode: mode === "enforce" ? "enforce" : "testing" }, { found });
  }
  const policyMx = value("mx");
  const uncovered = mxList.filter((h) => !policyMx.some((p) => mxMatches(p, h)));
  if (uncovered.length > 0) {
    const list = uncovered.join(", ");
    // A política do painel lista o servidor de e-mail do painel: com o MX em outro provedor ela não serve.
    if (servedByPanel) return optionalCheck("mta_sts", "mx_external", { host: list }, { found });
    return enforcing
      ? check("mta_sts", "critical", true, "mx_mismatch", { host: list }, { found })
      : optionalCheck("mta_sts", "mx_mismatch", { host: list }, { found });
  }
  if (servedByPanel && tags(found[0] as string).get("id") !== expectedId) {
    return optionalCheck("mta_sts", "id_outdated", { host: `_mta-sts.${domain}` }, { expected: expectedTxt, found });
  }
  return check("mta_sts", mode === "enforce" ? "ok" : "info", false, mode === "enforce" ? "enforce" : "testing", { mode }, { found });
}

async function checkTlsRpt(domain: string, resolver: DnsResolverLike): Promise<MailHealthCheck> {
  const txt = await ask(() => resolver.resolveTxt(`_smtp._tls.${domain}`), []);
  const found = txt === null ? [] : txtOf(txt).filter((r) => /^v=TLSRPTv1/i.test(r.trim()));
  if (found.length === 0) return optionalCheck("tls_rpt", "absent");
  return tags(found[0] as string).get("rua") ? check("tls_rpt", "ok", false, "ok", {}, { found }) : optionalCheck("tls_rpt", "no_rua", {}, { found });
}

/** Código de autenticação do Gmail/Microsoft ou a frase típica; menção solta a SPF/DKIM/DMARC (num link, por exemplo) não conta. */
const AUTH_FAILURE = new RegExp(
  [
    String.raw`\b[45]\.7\.(?:26|27|30|32|509|515)\b`,
    "unauthenticated|not authenticated|authentication (?:is )?required|from: header is not aligned",
    String.raw`(?:does not|did not|doesn't|didn't|fails?|failed|not) pass(?:ed|ing)? (?:the )?(?:spf|dkim|dmarc|authentication)`,
    String.raw`(?:spf|dkim|dmarc)(?: \w+){0,3} (?:fail|failed|failure|check failed|verification failed|not aligned|alignment)`,
    String.raw`(?:fails?|failed) (?:the )?(?:spf|dkim|dmarc)`,
  ].join("|"),
);

export type DelayCause =
  | "greylisted"
  | "auth"
  | "blocked_ip"
  | "rate_limited"
  | "mailbox"
  | "tls"
  | "dns"
  | "connection"
  | "other";

/**
 * Por que o servidor de destino adiou a mensagem, pelo texto da resposta.
 * A ordem importa: "greylisted" e "blocked_ip" trazem códigos que também
 * aparecem em limites de taxa.
 */
export function classifyDelay(text: string | null): DelayCause {
  const reason = (text ?? "").toLowerCase();
  if (/greylist|graylist|4\.2\.0|451 4\.7\.1\b/.test(reason)) return "greylisted";
  // 4.7.26/27/30/32: o Gmail adia por falha de autenticação (SPF/DKIM/alinhamento), NÃO por taxa
  if (!/4\.7\.28/.test(reason) && AUTH_FAILURE.test(reason)) return "auth";
  if (/s3150|s775|s3140|blacklist|blocklist|spamhaus|poor reputation|5\.7\.1\b|ip.*blocked|blocked.*ip/.test(reason)) return "blocked_ip";
  if (/rate|4\.7\.28|4\.7\.0\b|tss0|4\.2\.1\b|too many|unusual|try again later|temporarily/.test(reason)) return "rate_limited";
  if (/mailbox full|over quota|quota exceeded|4\.2\.2\b/.test(reason)) return "mailbox";
  if (/tls|starttls|certificate/.test(reason)) return "tls";
  if (/dns|resolve|lookup|no mx|nxdomain/.test(reason)) return "dns";
  if (/timeout|timed out|refused|unreachable|connect|network/.test(reason)) return "connection";
  return "other";
}

/** Mensagens deste domínio paradas na fila (adiadas), com a causa mais comum. */
function checkQueue(queue: QueueItemView[] | null, domain: string, now: number): MailHealthCheck {
  if (queue === null) return check("queue", "info", false, "unavailable");
  const deferred = queue.filter(
    (m) => m.from.toLowerCase().endsWith(`@${domain}`) && m.recipients.some((r) => r.state === "deferred"),
  );
  if (deferred.length === 0) return check("queue", "ok", false, "empty");
  const counts = new Map<DelayCause, number>();
  for (const m of deferred) {
    const cause = classifyDelay(m.lastError);
    counts.set(cause, (counts.get(cause) ?? 0) + 1);
  }
  const cause = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const attempts = Math.max(...deferred.map((m) => m.attempts));
  const next = deferred.map((m) => m.nextRetryAt).filter((v): v is string => v !== null).sort()[0];
  const minutes = next ? Math.max(0, Math.ceil((Date.parse(next) - now) / 60_000)) : 0;
  // Muitas tentativas sem sucesso (a agenda do Stalwart passa de 1 h na 6ª): deixou de ser só atraso.
  const level = attempts >= 6 || cause === "blocked_ip" || cause === "auth" ? "critical" : "warn";
  return check("queue", level, true, `deferred_${cause}`, {
    count: deferred.length,
    attempts,
    minutes,
    reason: (deferred[0]!.lastError ?? "").slice(0, 160),
  });
}

export interface HealthInput extends PlanInput {
  resolvers: ResolverEntry[];
  ptr: PtrCheck;
  port25: Port25Result;
  /** Fila do servidor de e-mail agora (null = não deu para ler). */
  queue: QueueItemView[] | null;
  serverRunning: boolean;
  tlsHosts: TlsHostState[];
  blacklist: BlacklistCheckResponse | null;
  fetchPolicy: (domain: string) => Promise<string | null>;
  isProxyIp: (ip: string) => boolean;
  now: number;
  /** Prazo total (relógio) da checagem de MTA-STS. Padrão: 10 s. */
  mtaStsDeadlineMs?: number;
  /** Estado do certificado de mta-sts.<domínio> (para dizer "ainda sendo emitido"). Ausente = desconhecido. */
  mtaStsCertState?: (host: string) => Promise<MtaStsCertState>;
  /** O proxy do painel publica a política MTA-STS (precisa do domínio do painel)? Padrão: sim. */
  mtaStsPublishing?: boolean;
  /** Modo da última vez que a política abriu (testing/enforce), guardado pelo painel. */
  mtaStsLastMode?: string | null;
}

/** Roda todas as verificações e resume o estado do domínio. */
export async function evaluateHealth(input: HealthInput): Promise<DeliveryHealthResponse> {
  const main = (input.resolvers[0] as ResolverEntry).resolver;
  const { domain, mailHostname, serverHostname, serverIp } = input;
  const checks: MailHealthCheck[] = await Promise.all([
    checkAddress("a", mailHostname, serverIp, main, input.isProxyIp),
    serverHostname === mailHostname
      ? Promise.resolve(null)
      : checkAddress("helo", serverHostname, serverIp, main, input.isProxyIp),
    checkMx(domain, mailHostname, serverIp, main),
    checkSpf(domain, serverIp, input.dmarcStage, main),
    checkDkim(domain, input.dkimSelector, input.dkimPublicKey, main, input.dkimRestartPending === true),
    checkDmarc(domain, input.dmarcStage, main),
    Promise.resolve(checkPtr(input.ptr)),
    Promise.resolve(checkPort25(input.port25)),
    Promise.resolve(checkQueue(input.queue, domain, input.now)),
    Promise.resolve(checkTls(input.serverRunning, input.tlsHosts, input.now)),
    Promise.resolve(checkDnsbl(input.blacklist)),
    checkPropagation(domain, input.dkimSelector, input.resolvers),
    // Prazo total do relógio: um servidor de política lento não pode segurar a verificação inteira.
    withDeadline(
      checkMtaSts(domain, mailHostname, serverIp, main, input.fetchPolicy, input.isProxyIp, input.mtaStsCertState ?? (async () => "unknown"), input.mtaStsPublishing !== false, input.mtaStsLastMode ?? null),
      input.mtaStsDeadlineMs ?? 10_000,
      optionalCheck("mta_sts", "unreachable", { host: mtaStsHostFor(domain) }),
    ),
    checkTlsRpt(domain, main),
  ]).then((all) => all.filter((c): c is MailHealthCheck => c !== null));

  return buildReport(domain, input.now, checks);
}

/**
 * Resumo de uma lista de itens: só pesam ok, atenção e crítico que não foram marcados como
 * "ciente". Opcional e informativo ficam de fora (e aparecem à parte nas contagens).
 */
export function summarizeChecks(list: MailHealthCheck[]): MailHealthScopeSummary {
  const counts: MailHealthCounts = { ok: 0, warn: 0, critical: 0, optional: 0, acknowledged: 0 };
  for (const c of list) {
    if (c.level === "optional") counts.optional += 1;
    else if (c.acknowledged) counts.acknowledged += 1;
    else if (mailHealthCounts(c)) counts[c.level as "ok" | "warn" | "critical"] += 1;
  }
  return { level: counts.critical > 0 ? "critical" : counts.warn > 0 ? "warn" : "ok", counts };
}

function buildReport(domain: string, now: number, checks: MailHealthCheck[]): DeliveryHealthResponse {
  const { level, counts } = summarizeChecks(checks);
  return {
    domain,
    checkedAt: new Date(now).toISOString(),
    level,
    counts,
    checks,
    scopes: {
      server: summarizeChecks(checks.filter((c) => mailHealthScope(c.id) === "server")),
      domain: summarizeChecks(checks.filter((c) => mailHealthScope(c.id) === "domain")),
    },
    inboxIssues: checks.filter((c) => c.inbox && !c.acknowledged && (c.level === "warn" || c.level === "critical")).map((c) => c.id),
  };
}

/** Marcação "ciente" guardada: a impressão do problema na hora da marcação, mais o que a pessoa escreveu. */
export interface StoredAcknowledgement extends MailHealthAcknowledgement {
  fingerprint: string;
}

/**
 * Aplica as marcações "ciente" a um relatório e refaz os resumos. A marcação só vale para item
 * atenção/crítico que dependa do provedor e cujo problema seja exatamente o de quando foi marcada;
 * mudou o problema (outro nome no PTR, virou crítico), o item volta a contar sozinho.
 */
export function applyAcknowledgements(
  report: DeliveryHealthResponse,
  acks: Partial<Record<MailHealthCheckId, StoredAcknowledgement>>,
): DeliveryHealthResponse {
  const checks = report.checks.map((c): MailHealthCheck => {
    const { acknowledged: _old, ...raw } = c;
    const ack = acks[c.id];
    const applies =
      ack !== undefined &&
      isMailHealthAcknowledgeable(c.id) &&
      c.level === "warn" &&
      ack.fingerprint === mailHealthFingerprint(c);
    return applies ? { ...raw, acknowledged: { reason: ack.reason, at: ack.at, by: ack.by } } : raw;
  });
  return buildReport(report.domain, Date.parse(report.checkedAt), checks);
}
