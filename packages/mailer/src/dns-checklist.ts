/**
 * dns-checklist.ts — checklist de DNS de um domínio de e-mail e verificação
 * contra o DNS real (spec: docs/email-deliverability.md §1).
 *
 * Registros: A/AAAA (mail.<domínio>), MX, SPF (progressivo ~all → -all),
 * DKIM (RSA 2048, seletor "paas"), DMARC (progressivo none → quarantine →
 * reject) e PTR (configurado no provedor da VPS, não no DNS do domínio).
 *
 * PTR em três níveis (validação real, 01/10/2026): numa VPS da Contabo o IP
 * tinha o nome reverso genérico vmiNNNNNNN.contaboserver.net, que volta para o
 * mesmo IP. Isso já é o FCrDNS que o Gmail, o Yahoo e a Microsoft exigem; o
 * painel mostrava amarelo e mandava abrir chamado sem necessidade. Agora:
 * verde = nome do servidor; azul = nome genérico com FCrDNS válido (conta como
 * OK, trocar é recomendado); amarelo = sem PTR ou nome que não volta para o IP.
 *
 * PTR único (04/10/2026): o esperado era mail.<domínio> em cada checklist, o
 * que com dois domínios ou mais nunca fecha (um IP tem um nome reverso só).
 * Agora é o nome com que o servidor se apresenta (HELO = server.hostname),
 * igual para todos os domínios.
 * Quando o provedor é conhecido pelo nome reverso, a instrução diz onde a
 * própria pessoa troca no painel dele; o texto de chamado fica só para
 * provedor desconhecido.
 *
 * A verificação usa um resolver público (1.1.1.1/8.8.8.8) para não depender do
 * resolver local; o resolvedor é injetável para permitir testes com mock.
 *
 * DNS público que não responde (validação real, 02/10/2026): o PTR ficou
 * várias vezes "não deu para conferir" com o DNS público respondendo certo
 * de outro lugar. Agora o resolver público tem prazo e tentativas explícitos
 * e, quando mesmo assim fica sem resposta, a consulta passa para o DNS do
 * sistema (dentro do container, o do Docker) antes de desistir. O que falhou
 * vai para o log e, no PTR pendente, para o campo `diagnostic`.
 */
import dns from "node:dns/promises";
import type {
  DmarcStage,
  DnsChecklistResponse,
  DnsRecordCheck,
  PtrCheck,
  PtrProvider,
} from "@paas/core";

export interface ChecklistInput {
  domain: string;
  /** Hostname do servidor de e-mail (mail.<domínio>). */
  mailHostname: string;
  /**
   * Nome com que o servidor se apresenta (HELO = server.hostname). É o PTR
   * esperado: um IP tem um nome reverso só, o mesmo para todos os domínios.
   * Ausente = mailHostname.
   */
  serverHostname?: string;
  /** IPv4 público da máquina. */
  serverIp: string;
  /** IPv6 público (opcional — se existir, Gmail exige que esteja correto). */
  serverIpv6?: string | null;
  dkimSelector: string;
  dkimPublicKey: string;
  dmarcStage: DmarcStage;
}

/** Valor SPF conforme o estágio (observação = ~all; endurecido = -all). */
export function spfValue(serverIp: string, stage: DmarcStage): string {
  return `v=spf1 ip4:${serverIp} ${stage === "none" ? "~all" : "-all"}`;
}

/** Valor DMARC conforme o estágio progressivo. */
export function dmarcValue(domain: string, stage: DmarcStage): string {
  return `v=DMARC1; p=${stage}; rua=mailto:dmarc@${domain}`;
}

/** Sugestão de evolução da política (pt-BR), null quando já está no máximo. */
export function stageSuggestion(stage: DmarcStage): string | null {
  switch (stage) {
    case "none":
      return 'Estágio de observação: SPF "~all" e DMARC "p=none". Após 2–4 semanas monitorando os relatórios (rua) sem falsos positivos, endureça para p=quarantine e SPF "-all".';
    case "quarantine":
      return 'Estágio intermediário: DMARC "p=quarantine". Quando os relatórios estiverem limpos, evolua para p=reject — exigido inclusive para BIMI.';
    case "reject":
      return null;
  }
}

/** Prioridade do MX (um servidor só, qualquer número serve; 10 é o costume). */
const MX_PRIORITY = 10;

/** Monta a lista completa de registros esperados para o domínio. */
export function buildDnsChecklist(input: ChecklistInput): DnsChecklistResponse {
  const { domain, mailHostname, serverIp, serverIpv6, dkimSelector, dkimPublicKey, dmarcStage } = input;
  const ptrHostname = input.serverHostname ?? mailHostname;

  const records: DnsRecordCheck[] = [
    {
      id: "a",
      type: "A",
      name: mailHostname,
      expected: serverIp,
      purpose: "Hostname do servidor de e-mail precisa resolver para o IP da VPS.",
      status: "pending",
      found: [],
      note: null,
    },
  ];

  if (serverIpv6) {
    records.push({
      id: "aaaa",
      type: "AAAA",
      name: mailHostname,
      expected: serverIpv6,
      purpose: "IPv6 do servidor (se presente, o Gmail exige que esteja correto).",
      status: "pending",
      found: [],
      note: null,
    });
  }

  records.push(
    {
      id: "mx",
      type: "MX",
      name: domain,
      expected: `${MX_PRIORITY} ${mailHostname}`,
      priority: MX_PRIORITY,
      target: mailHostname,
      purpose: "Recebimento de e-mail — aponta para o hostname, nunca para IP.",
      status: "pending",
      found: [],
      note: null,
    },
    {
      id: "spf",
      type: "TXT",
      name: domain,
      expected: spfValue(serverIp, dmarcStage),
      purpose: "SPF: declara quais IPs podem enviar pelo domínio.",
      status: "pending",
      found: [],
      note: null,
    },
    {
      id: "dkim",
      type: "TXT",
      name: `${dkimSelector}._domainkey.${domain}`,
      expected: `v=DKIM1; k=rsa; p=${dkimPublicKey}`,
      purpose: "DKIM (RSA 2048): assinatura criptográfica de toda mensagem enviada.",
      status: "pending",
      found: [],
      note: null,
    },
    {
      id: "dmarc",
      type: "TXT",
      name: `_dmarc.${domain}`,
      expected: dmarcValue(domain, dmarcStage),
      purpose: "DMARC: política de autenticação + relatórios (evoluir none → quarantine → reject).",
      status: "pending",
      found: [],
      note: null,
    },
  );

  return {
    domain,
    mailHostname,
    serverIp,
    records,
    ptr: {
      ip: serverIp,
      expected: ptrHostname,
      status: "pending",
      found: [],
      forwardConfirmed: null,
      provider: null,
      ticketText: null,
    },
    suggestion: stageSuggestion(dmarcStage),
  };
}

// ---------------------------------------------------------------------------
// Verificação contra o DNS real
// ---------------------------------------------------------------------------

/** Interface injetável do resolver (facilita mock em testes). */
export interface DnsResolverLike {
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
  resolveMx(name: string): Promise<Array<{ exchange: string; priority: number }>>;
  resolveTxt(name: string): Promise<string[][]>;
  reverse(ip: string): Promise<string[]>;
}

/** Servidores do resolver público (independem do resolver local da VPS). */
export const PUBLIC_DNS_SERVERS = ["1.1.1.1", "8.8.8.8"] as const;

/**
 * Prazo e tentativas do resolver público (opções de `new dns.Resolver()` do
 * Node). Sem elas valem os padrões do c-ares, e uma consulta presa pode
 * passar de dez segundos. Cada tentativa pergunta aos dois servidores.
 */
export const PUBLIC_DNS_OPTIONS = { timeout: 2_000, tries: 2 } as const;

/** Resolver padrão: servidores públicos, com prazo e tentativas explícitos. */
export function publicResolver(): DnsResolverLike {
  const resolver = new dns.Resolver({ ...PUBLIC_DNS_OPTIONS });
  resolver.setServers([...PUBLIC_DNS_SERVERS]);
  return resolver;
}

/**
 * Resolver do sistema (/etc/resolv.conf). Dentro do container é o DNS do
 * Docker, que pergunta ao DNS da própria VPS: segunda opção quando o
 * público não responde.
 */
export function systemResolver(): DnsResolverLike {
  return dns;
}

const PUBLIC_LABEL = `DNS público (${PUBLIC_DNS_SERVERS.join(", ")})`;
const SYSTEM_LABEL = "DNS do sistema";

/** Consulta que não teve resposta (demora, erro do servidor de DNS) — diferente de "não existe". */
const UNAVAILABLE = Symbol("dns-indisponivel");
/** Respostas definitivas de "não há registro". */
const NO_RECORD = new Set(["ENOTFOUND", "ENODATA", "NOTFOUND", "NODATA"]);

/** Código do erro de DNS (ex.: ETIMEOUT) ou, sem código, a mensagem. */
function failureReason(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : err.message;
}

type Attempt<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Consulta num resolvedor, com uma nova tentativa quando o DNS não responde.
 * "Não existe" é resposta: vira o valor vazio.
 */
async function ask<T>(resolver: DnsResolverLike, query: (r: DnsResolverLike) => Promise<T>, empty: T): Promise<Attempt<T>> {
  let reason = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return { ok: true, value: await query(resolver) };
    } catch (err) {
      reason = failureReason(err);
      if (NO_RECORD.has(reason)) return { ok: true, value: empty };
    }
  }
  return { ok: false, reason };
}

/**
 * Consultas de uma verificação: primeiro o DNS público; sem resposta, o do
 * sistema. Guarda (e manda para o log) o caminho que falhou.
 */
class Lookups {
  /** Consultas que ficaram sem resposta nos dois caminhos. */
  readonly failures: string[] = [];

  constructor(
    private readonly primary: DnsResolverLike,
    private readonly fallback: DnsResolverLike | null,
    private readonly log: (message: string) => void,
  ) {}

  async run<T>(what: string, query: (r: DnsResolverLike) => Promise<T>, empty: T): Promise<T | typeof UNAVAILABLE> {
    const first = await ask(this.primary, query, empty);
    if (first.ok) return first.value;
    const paths = [`${PUBLIC_LABEL}: sem resposta (${first.reason})`];
    if (this.fallback) {
      const second = await ask(this.fallback, query, empty);
      if (second.ok) {
        this.log(`DNS: ${what} — ${paths[0]}; respondida pelo ${SYSTEM_LABEL}.`);
        return second.value;
      }
      paths.push(`${SYSTEM_LABEL}: sem resposta (${second.reason})`);
    }
    const failure = `${what} — ${paths.join("; ")}`;
    this.log(`DNS: ${failure}.`);
    this.failures.push(failure);
    return UNAVAILABLE;
  }

  /** Igual a run(), mas sem resposta vira o valor vazio (registro "ausente"). */
  async orEmpty<T>(what: string, query: (r: DnsResolverLike) => Promise<T>, empty: T): Promise<T> {
    const value = await this.run(what, query, empty);
    return value === UNAVAILABLE ? empty : value;
  }
}

function normalizeTxt(chunks: string[][]): string[] {
  return chunks.map((parts) => parts.join(""));
}

export interface VerifyOptions {
  /**
   * Segunda opção quando o resolvedor principal não responde. Padrão: o DNS
   * do sistema quando o principal é o público padrão; nenhum quando um
   * resolvedor foi injetado (testes não saem para a rede). null = nenhum.
   */
  fallback?: DnsResolverLike | null;
  /** Para onde vai o caminho que falhou (diagnóstico). Padrão: nenhum. */
  log?: (message: string) => void;
}

export interface VerifyResult {
  records: DnsRecordCheck[];
  ptr: PtrCheck;
  summary: { ok: number; total: number };
}

/** Verifica cada registro do checklist no DNS real. */
export async function verifyDnsRecords(
  checklist: DnsChecklistResponse,
  resolver?: DnsResolverLike,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const fallback = options.fallback !== undefined ? options.fallback : resolver ? null : systemResolver();
  const lookups = new Lookups(resolver ?? publicResolver(), fallback, options.log ?? (() => {}));
  const records: DnsRecordCheck[] = [];

  for (const record of checklist.records) {
    const checked: DnsRecordCheck = { ...record, found: [], status: "missing", note: null };

    const what = `${record.type} de ${record.name}`;
    if (record.type === "A") {
      checked.found = await lookups.orEmpty(what, (r) => r.resolve4(record.name), []);
    } else if (record.type === "AAAA") {
      checked.found = await lookups.orEmpty(what, (r) => r.resolve6(record.name), []);
    } else if (record.type === "MX") {
      const mx = await lookups.orEmpty(what, (r) => r.resolveMx(record.name), []);
      checked.found = mx
        .sort((a, b) => a.priority - b.priority)
        .map((m) => `${m.priority} ${m.exchange.replace(/\.$/, "")}`);
    } else if (record.type === "TXT") {
      checked.found = normalizeTxt(await lookups.orEmpty(what, (r) => r.resolveTxt(record.name), []));
    }

    if (checked.found.length > 0) {
      const normalize = (v: string) => v.trim().replace(/\.$/, "").replace(/\s+/g, " ");
      const expected = normalize(record.expected);
      // TXT: basta UM dos registros conferir (SPF/DKIM/DMARC dividem o nome com outros TXT).
      // A/AAAA/MX: o valor esperado precisa estar presente.
      checked.status = checked.found.some((v) => normalize(v) === expected) ? "found" : "mismatch";
      if (record.id === "spf" && checked.status === "mismatch") {
        // SPF com o IP certo mas mecanismo final diferente (~all vs -all) é quase-conforme.
        const hasIp = checked.found.some(
          (v) => v.startsWith("v=spf1") && v.includes(`ip4:${checklist.serverIp}`),
        );
        if (hasIp) {
          checked.note = "SPF encontrado com o IP correto, mas o mecanismo final (~all/-all) difere do esperado para o estágio atual.";
        }
      }
      if (checked.status === "mismatch" && checked.note === null) {
        checked.note = "Registro existe, mas o valor difere do esperado.";
      }
    }

    records.push(checked);
  }

  const ptr = await verifyPtr(checklist.ptr, lookups);

  const total = records.length + 1;
  const ok = records.filter((r) => r.status === "found").length + (ptrIsOk(ptr.status) ? 1 : 0);
  return { records, ptr, summary: { ok, total } };
}

/** PTR verde (nome do servidor) ou azul (genérico com FCrDNS válido) conta como OK. */
export function ptrIsOk(status: PtrCheck["status"]): boolean {
  return status === "found" || status === "generic";
}

/** Normaliza um nome DNS: minúsculas e sem o ponto final. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * DNS reverso do IP: o nome reverso é o nome do servidor (found)? Senão, algum
 * nome reverso volta para o mesmo IP (generic, FCrDNS válido)? Senão,
 * mismatch; sem nome reverso nenhum, action_required.
 */
async function verifyPtr(expectedPtr: PtrCheck, lookups: Lookups): Promise<PtrCheck> {
  const before = lookups.failures.length;
  /** Pendente: diz quais consultas do PTR ficaram sem resposta, e onde. */
  const diagnostic = () => lookups.failures.slice(before).join(" · ");
  const reverse = await lookups.run(`reverso de ${expectedPtr.ip}`, (r) => r.reverse(expectedPtr.ip), [] as string[]);
  const empty: PtrCheck = {
    ...expectedPtr,
    found: [],
    forwardConfirmed: null,
    provider: null,
    ticketText: null,
    diagnostic: null,
  };
  if (reverse === UNAVAILABLE) return { ...empty, status: "pending", diagnostic: diagnostic() };
  const names = reverse.map(normalizeName);
  const expected = normalizeName(expectedPtr.expected);
  const base: PtrCheck = { ...empty, found: names };

  if (names.length === 0) {
    return { ...base, status: "action_required", ticketText: ptrTicketText(base.ip, base.expected) };
  }
  if (names.includes(expected)) {
    return { ...base, status: "found" };
  }

  // FCrDNS: algum nome reverso resolve (A) de volta para o mesmo IP.
  let confirmedName: string | null = null;
  let unavailable = false;
  for (const name of names) {
    const addresses = await lookups.run(`A de ${name}`, (r) => r.resolve4(name), [] as string[]);
    if (addresses === UNAVAILABLE) {
      unavailable = true;
      continue;
    }
    if (addresses.includes(base.ip)) {
      confirmedName = name;
      break;
    }
  }
  // Sem confirmação porque o DNS não respondeu: não é "não volta para o IP".
  if (!confirmedName && unavailable) return { ...base, status: "pending", diagnostic: diagnostic() };
  const current = confirmedName ?? names[0]!;
  const provider = detectPtrProvider(current, base.expected) ?? firstProvider(names, base.expected);
  return {
    ...base,
    status: confirmedName ? "generic" : "mismatch",
    forwardConfirmed: confirmedName !== null,
    provider,
    // Provedor conhecido: a instrução diz onde trocar sem chamado.
    ticketText: provider ? null : ptrTicketText(base.ip, base.expected, current),
  };
}

function firstProvider(names: string[], mailHostname: string): PtrProvider | null {
  for (const name of names) {
    const provider = detectPtrProvider(name, mailHostname);
    if (provider) return provider;
  }
  return null;
}

interface PtrProviderRule {
  id: string;
  name: string;
  /** Sufixos do nome reverso genérico que o provedor atribui aos IPs. */
  suffixes: string[];
  instructions: (mailHostname: string) => string;
}

/**
 * Provedores reconhecidos pelo nome reverso genérico. Para acrescentar um:
 * o sufixo do nome que o provedor dá ao IP e o caminho no painel dele.
 *
 * Fora da lista, de propósito: a DigitalOcean não tem nome genérico — o
 * reverso segue o NOME do droplet (ex.: "ubuntu-s-1vcpu-1gb-01"), então não
 * dá para reconhecê-la pelo nome. A dica dela aparece na página do domínio
 * junto do texto de chamado (provedor desconhecido).
 */
const PTR_PROVIDERS: PtrProviderRule[] = [
  {
    id: "contabo",
    name: "Contabo",
    suffixes: ["contaboserver.net"],
    instructions: (host) =>
      `Na Contabo você mesmo troca, sem chamado: no painel da Contabo (my.contabo.com), abra ` +
      `"Reverse DNS Management", edite o IP e coloque ${host}.`,
  },
  {
    id: "hetzner",
    name: "Hetzner",
    suffixes: ["your-server.de"],
    instructions: (host) =>
      `Na Hetzner você mesmo troca, sem chamado: no Hetzner Console (console.hetzner.com), abra o ` +
      `servidor, vá na aba "Networking" e, no IP, use a opção "Reverse DNS" para colocar ${host}.`,
  },
  {
    id: "vultr",
    name: "Vultr",
    suffixes: ["vultrusercontent.com"],
    instructions: (host) =>
      `Na Vultr você mesmo troca, sem chamado: no painel da Vultr (my.vultr.com), abra o servidor, ` +
      `vá em Settings → IPv4, edite o campo "Reverse DNS" do IP e coloque ${host}.`,
  },
];

/** Reconhece o provedor da VPS pelo sufixo do nome reverso atual. */
export function detectPtrProvider(ptrName: string, mailHostname: string): PtrProvider | null {
  const name = normalizeName(ptrName);
  for (const rule of PTR_PROVIDERS) {
    if (rule.suffixes.some((suffix) => name === suffix || name.endsWith(`.${suffix}`))) {
      return { id: rule.id, name: rule.name, instructions: rule.instructions(mailHostname) };
    }
  }
  return null;
}

/** Texto pronto para abrir chamado no provedor da VPS (registro PTR). */
export function ptrTicketText(ip: string, mailHostname: string, current?: string): string {
  return [
    "Assunto: Solicitação de configuração de reverse DNS (PTR/rDNS)",
    "",
    "Olá,",
    "",
    `Solicito a configuração do registro de reverse DNS (PTR) do IP ${ip} para:`,
    "",
    `    ${mailHostname}`,
    "",
    current
      ? `Atualmente o IP resolve para "${current}". Preciso que aponte para o hostname acima,`
      : "Atualmente o IP não possui registro PTR.",
    "pois este servidor hospeda um servidor de e-mail e o reverse DNS (FCrDNS) é",
    "exigido pelo Gmail, Yahoo e Microsoft para aceitar mensagens.",
    "",
    "Obrigado!",
  ].join("\n");
}
