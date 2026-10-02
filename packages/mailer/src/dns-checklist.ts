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
 * verde = mail.<domínio>; azul = nome genérico com FCrDNS válido (conta como
 * OK, trocar é opcional); amarelo = sem PTR ou nome que não volta para o IP.
 * Quando o provedor é conhecido pelo nome reverso, a instrução diz onde a
 * própria pessoa troca no painel dele; o texto de chamado fica só para
 * provedor desconhecido.
 *
 * A verificação usa um resolver público (1.1.1.1/8.8.8.8) para não depender do
 * resolver local; o resolvedor é injetável para permitir testes com mock.
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

/** Monta a lista completa de registros esperados para o domínio. */
export function buildDnsChecklist(input: ChecklistInput): DnsChecklistResponse {
  const { domain, mailHostname, serverIp, serverIpv6, dkimSelector, dkimPublicKey, dmarcStage } = input;

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
      expected: `10 ${mailHostname}`,
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
      expected: mailHostname,
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

/** Resolver padrão: servidores públicos (independe do resolver local da VPS). */
export function publicResolver(): DnsResolverLike {
  const resolver = new dns.Resolver();
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  return resolver;
}

async function safe<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch {
    return fallback;
  }
}

function normalizeTxt(chunks: string[][]): string[] {
  return chunks.map((parts) => parts.join(""));
}

export interface VerifyResult {
  records: DnsRecordCheck[];
  ptr: PtrCheck;
  summary: { ok: number; total: number };
}

/** Verifica cada registro do checklist no DNS real. */
export async function verifyDnsRecords(
  checklist: DnsChecklistResponse,
  resolver: DnsResolverLike = publicResolver(),
): Promise<VerifyResult> {
  const records: DnsRecordCheck[] = [];

  for (const record of checklist.records) {
    const checked: DnsRecordCheck = { ...record, found: [], status: "missing", note: null };

    if (record.type === "A") {
      checked.found = await safe(resolver.resolve4(record.name), []);
    } else if (record.type === "AAAA") {
      checked.found = await safe(resolver.resolve6(record.name), []);
    } else if (record.type === "MX") {
      const mx = await safe(resolver.resolveMx(record.name), []);
      checked.found = mx
        .sort((a, b) => a.priority - b.priority)
        .map((m) => `${m.priority} ${m.exchange.replace(/\.$/, "")}`);
    } else if (record.type === "TXT") {
      checked.found = normalizeTxt(await safe(resolver.resolveTxt(record.name), []));
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

  const ptr = await verifyPtr(checklist.ptr, resolver);

  const total = records.length + 1;
  const ok = records.filter((r) => r.status === "found").length + (ptrIsOk(ptr.status) ? 1 : 0);
  return { records, ptr, summary: { ok, total } };
}

/** PTR verde (mail.<domínio>) ou azul (genérico com FCrDNS válido) conta como OK. */
export function ptrIsOk(status: PtrCheck["status"]): boolean {
  return status === "found" || status === "generic";
}

/** Normaliza um nome DNS: minúsculas e sem o ponto final. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * DNS reverso do IP: o nome reverso é mail.<domínio> (found)? Senão, algum
 * nome reverso volta para o mesmo IP (generic, FCrDNS válido)? Senão,
 * mismatch; sem nome reverso nenhum, action_required.
 */
async function verifyPtr(expectedPtr: PtrCheck, resolver: DnsResolverLike): Promise<PtrCheck> {
  const names = (await safe(resolver.reverse(expectedPtr.ip), [])).map(normalizeName);
  const expected = normalizeName(expectedPtr.expected);
  const base: PtrCheck = { ...expectedPtr, found: names, forwardConfirmed: null, provider: null, ticketText: null };

  if (names.length === 0) {
    return { ...base, status: "action_required", ticketText: ptrTicketText(base.ip, base.expected) };
  }
  if (names.includes(expected)) {
    return { ...base, status: "found" };
  }

  // FCrDNS: algum nome reverso resolve (A) de volta para o mesmo IP.
  let confirmedName: string | null = null;
  for (const name of names) {
    const addresses = await safe(resolver.resolve4(name), []);
    if (addresses.includes(base.ip)) {
      confirmedName = name;
      break;
    }
  }
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
