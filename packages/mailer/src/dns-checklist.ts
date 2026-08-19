/**
 * dns-checklist.ts — checklist de DNS de um domínio de e-mail e verificação
 * contra o DNS real (spec: docs/email-deliverability.md §1).
 *
 * Registros: A/AAAA (mail.<domínio>), MX, SPF (progressivo ~all → -all),
 * DKIM (RSA 2048, seletor "paas"), DMARC (progressivo none → quarantine →
 * reject) e PTR (fora do nosso controle — gera texto de chamado quando ausente).
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

  // PTR: reverse DNS do IP (só o provedor da VPS configura).
  const ptrNames = (await safe(resolver.reverse(checklist.ptr.ip), [])).map((n) =>
    n.replace(/\.$/, ""),
  );
  const ptr: PtrCheck = {
    ...checklist.ptr,
    found: ptrNames,
    status:
      ptrNames.length === 0
        ? "action_required"
        : ptrNames.includes(checklist.ptr.expected)
          ? "found"
          : "mismatch",
    ticketText: null,
  };
  if (ptr.status === "action_required") {
    ptr.ticketText = ptrTicketText(ptr.ip, ptr.expected);
  } else if (ptr.status === "mismatch") {
    ptr.ticketText = ptrTicketText(ptr.ip, ptr.expected, ptrNames[0]);
  }

  const total = records.length + 1;
  const ok = records.filter((r) => r.status === "found").length + (ptr.status === "found" ? 1 : 0);
  return { records, ptr, summary: { ok, total } };
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
