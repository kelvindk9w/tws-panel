/**
 * Testes do checklist DNS de e-mail (dns-checklist.ts): geração dos registros
 * esperados (SPF com o IP certo, DKIM RSA, DMARC progressivo) e a verificação
 * contra o DNS real com resolver mockado (found/missing/mismatch/PTR).
 */
import { describe, expect, it } from "vitest";
import {
  buildDnsChecklist,
  detectPtrProvider,
  dmarcValue,
  ptrTicketText,
  publicResolver,
  spfValue,
  stageSuggestion,
  verifyDnsRecords,
  type ChecklistInput,
  type DnsResolverLike,
} from "../src/dns-checklist.js";

const BASE_INPUT: ChecklistInput = {
  domain: "exemplo.com.br",
  mailHostname: "mail.exemplo.com.br",
  serverIp: "203.0.113.10",
  serverIpv6: null,
  dkimSelector: "paas",
  dkimPublicKey: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCg",
  dmarcStage: "none",
};

function mockResolver(overrides: Partial<DnsResolverLike> = {}): DnsResolverLike {
  const fail = () => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
  return {
    resolve4: overrides.resolve4 ?? fail,
    resolve6: overrides.resolve6 ?? fail,
    resolveMx: overrides.resolveMx ?? fail,
    resolveTxt: overrides.resolveTxt ?? fail,
    reverse: overrides.reverse ?? fail,
  };
}

describe("geração dos registros esperados", () => {
  it("SPF usa o IP do servidor e ~all no estágio de observação", () => {
    expect(spfValue("203.0.113.10", "none")).toBe("v=spf1 ip4:203.0.113.10 ~all");
  });

  it("SPF endurece para -all a partir do estágio quarantine", () => {
    expect(spfValue("203.0.113.10", "quarantine")).toBe("v=spf1 ip4:203.0.113.10 -all");
    expect(spfValue("203.0.113.10", "reject")).toBe("v=spf1 ip4:203.0.113.10 -all");
  });

  it("DMARC acompanha o estágio progressivo com rua no domínio", () => {
    expect(dmarcValue("exemplo.com.br", "none")).toBe("v=DMARC1; p=none; rua=mailto:dmarc@exemplo.com.br");
    expect(dmarcValue("exemplo.com.br", "reject")).toBe("v=DMARC1; p=reject; rua=mailto:dmarc@exemplo.com.br");
  });

  it("sugestão orienta a evolução até reject, onde não há mais sugestão", () => {
    expect(stageSuggestion("none")).toContain("p=quarantine");
    expect(stageSuggestion("quarantine")).toContain("p=reject");
    expect(stageSuggestion("reject")).toBeNull();
  });

  it("checklist sem IPv6 tem 5 registros: A, MX, SPF, DKIM, DMARC", () => {
    const checklist = buildDnsChecklist(BASE_INPUT);
    expect(checklist.records.map((r) => r.id)).toEqual(["a", "mx", "spf", "dkim", "dmarc"]);
  });

  it("com IPv6 o registro AAAA entra logo após o A (Gmail exige consistência)", () => {
    const checklist = buildDnsChecklist({ ...BASE_INPUT, serverIpv6: "2001:db8::10" });
    expect(checklist.records.map((r) => r.id)).toEqual(["a", "aaaa", "mx", "spf", "dkim", "dmarc"]);
    expect(checklist.records[1]).toMatchObject({ type: "AAAA", expected: "2001:db8::10" });
  });

  it("valores efetivos de cada registro estão corretos para o domínio dado", () => {
    const checklist = buildDnsChecklist(BASE_INPUT);
    const byId = Object.fromEntries(checklist.records.map((r) => [r.id, r]));
    expect(byId.a).toMatchObject({ type: "A", name: "mail.exemplo.com.br", expected: "203.0.113.10" });
    expect(byId.mx).toMatchObject({ type: "MX", name: "exemplo.com.br", expected: "10 mail.exemplo.com.br" });
    expect(byId.spf).toMatchObject({ type: "TXT", name: "exemplo.com.br", expected: "v=spf1 ip4:203.0.113.10 ~all" });
    expect(byId.dkim).toMatchObject({
      type: "TXT",
      name: "paas._domainkey.exemplo.com.br",
      expected: `v=DKIM1; k=rsa; p=${BASE_INPUT.dkimPublicKey}`,
    });
    expect(byId.dmarc).toMatchObject({
      type: "TXT",
      name: "_dmarc.exemplo.com.br",
      expected: "v=DMARC1; p=none; rua=mailto:dmarc@exemplo.com.br",
    });
    // todos começam pendentes até a primeira verificação
    expect(checklist.records.every((r) => r.status === "pending")).toBe(true);
    expect(checklist.ptr).toMatchObject({ ip: "203.0.113.10", expected: "mail.exemplo.com.br", status: "pending" });
  });
});

describe("publicResolver", () => {
  it("fixa servidores públicos (1.1.1.1/8.8.8.8) independentes do resolver da VPS", () => {
    const resolver = publicResolver();
    // a tipagem pública não expõe getServers; o objeto real é um dns.Resolver
    expect(typeof resolver.resolve4).toBe("function");
    expect(typeof resolver.resolveTxt).toBe("function");
    expect((resolver as { getServers?: () => string[] }).getServers?.()).toContain("1.1.1.1");
  });
});

describe("verificação contra o DNS real (resolver mockado)", () => {
  it("todos os registros corretos → found e summary completo", async () => {
    const checklist = buildDnsChecklist(BASE_INPUT);
    const resolver = mockResolver({
      resolve4: async () => ["203.0.113.10"],
      resolveMx: async () => [{ exchange: "mail.exemplo.com.br.", priority: 10 }],
      resolveTxt: async (name) => {
        if (name === "exemplo.com.br") return [["v=spf1 ip4:203.0.113.10 ~all"]];
        if (name.startsWith("paas._domainkey.")) return [[`v=DKIM1; k=rsa; p=${BASE_INPUT.dkimPublicKey}`]];
        return [["v=DMARC1; p=none; rua=mailto:dmarc@exemplo.com.br"]];
      },
      reverse: async () => ["mail.exemplo.com.br."],
    });
    const result = await verifyDnsRecords(checklist, resolver);
    expect(result.records.every((r) => r.status === "found")).toBe(true);
    expect(result.ptr.status).toBe("found");
    expect(result.summary).toEqual({ ok: 6, total: 6 });
  });

  it("registro ausente → missing (falha de DNS não derruba a verificação)", async () => {
    const checklist = buildDnsChecklist(BASE_INPUT);
    const result = await verifyDnsRecords(checklist, mockResolver());
    expect(result.records.every((r) => r.status === "missing")).toBe(true);
    expect(result.ptr.status).toBe("action_required");
    expect(result.ptr.ticketText).toContain("203.0.113.10");
    expect(result.summary).toEqual({ ok: 0, total: 6 });
  });

  it("registro de tipo sem consulta direta (PTR) não é procurado no DNS do domínio: fica faltando", async () => {
    const base = buildDnsChecklist(BASE_INPUT);
    const checklist = { ...base, records: [{ ...base.records[0]!, id: "ptr", type: "PTR" as const }] };
    const result = await verifyDnsRecords(checklist, mockResolver());
    expect(result.records[0]?.status).toBe("missing");
    expect(result.records[0]?.found).toEqual([]);
  });

  it("valor divergente → mismatch com nota explicativa", async () => {
    const checklist = buildDnsChecklist(BASE_INPUT);
    const resolver = mockResolver({ resolve4: async () => ["198.51.100.99"] });
    const result = await verifyDnsRecords(checklist, resolver);
    const a = result.records.find((r) => r.id === "a");
    expect(a?.status).toBe("mismatch");
    expect(a?.found).toEqual(["198.51.100.99"]);
    expect(a?.note).toContain("difere do esperado");
  });

  it("SPF com IP certo mas mecanismo final diferente → mismatch com nota específica", async () => {
    const checklist = buildDnsChecklist({ ...BASE_INPUT, dmarcStage: "reject" }); // espera -all
    const resolver = mockResolver({
      resolveTxt: async (name) => (name === "exemplo.com.br" ? [["v=spf1 ip4:203.0.113.10 ~all"]] : []),
    });
    const result = await verifyDnsRecords(checklist, resolver);
    const spf = result.records.find((r) => r.id === "spf");
    expect(spf?.status).toBe("mismatch");
    expect(spf?.note).toContain("mecanismo final");
  });

  it("SPF com IP de outro servidor → mismatch com a nota genérica, não a de quase-conforme", async () => {
    const checklist = buildDnsChecklist(BASE_INPUT);
    const resolver = mockResolver({
      resolveTxt: async (name) => (name === "exemplo.com.br" ? [["v=spf1 ip4:198.51.100.99 ~all"]] : []),
    });
    const result = await verifyDnsRecords(checklist, resolver);
    const spf = result.records.find((r) => r.id === "spf");
    expect(spf?.status).toBe("mismatch");
    expect(spf?.note).toBe("Registro existe, mas o valor difere do esperado.");
    expect(spf?.note).not.toContain("mecanismo final");
  });

  it("TXT: basta UM dos registros do nome conferir (SPF divide o nome com outros TXT)", async () => {
    const checklist = buildDnsChecklist(BASE_INPUT);
    const resolver = mockResolver({
      resolveTxt: async (name) =>
        name === "exemplo.com.br"
          ? [["google-site-verification=abc"], ["v=spf1 ip4:203.0.113.10 ~all"]]
          : [],
    });
    const result = await verifyDnsRecords(checklist, resolver);
    expect(result.records.find((r) => r.id === "spf")?.status).toBe("found");
  });

  it("MX é normalizado (ponto final removido) e ordenado por prioridade", async () => {
    const checklist = buildDnsChecklist(BASE_INPUT);
    const resolver = mockResolver({
      resolveMx: async () => [
        { exchange: "mail2.exemplo.com.br.", priority: 20 },
        { exchange: "mail.exemplo.com.br.", priority: 10 },
      ],
    });
    const result = await verifyDnsRecords(checklist, resolver);
    const mx = result.records.find((r) => r.id === "mx");
    expect(mx?.status).toBe("found");
    expect(mx?.found).toEqual(["10 mail.exemplo.com.br", "20 mail2.exemplo.com.br"]);
  });

  it("PTR divergente → mismatch com texto de chamado citando o valor atual", async () => {
    const checklist = buildDnsChecklist(BASE_INPUT);
    const resolver = mockResolver({ reverse: async () => ["host.generico.provedor.com"] });
    const result = await verifyDnsRecords(checklist, resolver);
    expect(result.ptr.status).toBe("mismatch");
    expect(result.ptr.ticketText).toContain("host.generico.provedor.com");
    expect(result.ptr.ticketText).toContain("mail.exemplo.com.br");
  });

  it("com IPv6: registro AAAA é verificado via resolve6 (found e missing)", async () => {
    const checklistV6 = buildDnsChecklist({ ...BASE_INPUT, serverIpv6: "2001:db8::10" });
    const aaaa = checklistV6.records.find((r) => r.type === "AAAA");
    expect(aaaa?.expected).toBe("2001:db8::10");

    const found = await verifyDnsRecords(
      checklistV6,
      mockResolver({ resolve6: async () => ["2001:db8::10"] }),
    );
    expect(found.records.find((r) => r.type === "AAAA")?.status).toBe("found");

    const missing = await verifyDnsRecords(checklistV6, mockResolver());
    expect(missing.records.find((r) => r.type === "AAAA")?.status).toBe("missing");
  });
});

describe("PTR em três níveis (verde, azul, amarelo)", () => {
  // Caso real (01/10/2026): VPS na Contabo com o PTR genérico do provedor,
  // que volta para o mesmo IP. O FCrDNS (o que o Gmail exige) já passa; só o
  // nome não é mail.<domínio> — sinal leve de reputação, não recusa.
  const CONTABO_PTR = "vmi1234567.contaboserver.net";

  function allGreenExceptPtr(overrides: Partial<DnsResolverLike>): DnsResolverLike {
    return mockResolver({
      resolve4: async (name) => (name === "mail.exemplo.com.br" ? ["203.0.113.10"] : []),
      resolveMx: async () => [{ exchange: "mail.exemplo.com.br.", priority: 10 }],
      resolveTxt: async (name) => {
        if (name === "exemplo.com.br") return [["v=spf1 ip4:203.0.113.10 ~all"]];
        if (name.startsWith("paas._domainkey.")) return [[`v=DKIM1; k=rsa; p=${BASE_INPUT.dkimPublicKey}`]];
        return [["v=DMARC1; p=none; rua=mailto:dmarc@exemplo.com.br"]];
      },
      ...overrides,
    });
  }

  it("verde: o nome reverso é mail.<domínio>", async () => {
    const result = await verifyDnsRecords(
      buildDnsChecklist(BASE_INPUT),
      allGreenExceptPtr({ reverse: async () => ["mail.exemplo.com.br."] }),
    );
    expect(result.ptr.status).toBe("found");
    expect(result.ptr.ticketText).toBeNull();
    expect(result.summary).toEqual({ ok: 6, total: 6 });
  });

  it("azul: PTR genérico da Contabo que volta para o mesmo IP conta como OK, sem chamado", async () => {
    const result = await verifyDnsRecords(
      buildDnsChecklist(BASE_INPUT),
      allGreenExceptPtr({
        reverse: async () => [`${CONTABO_PTR}.`],
        resolve4: async (name) =>
          name === "mail.exemplo.com.br" || name === CONTABO_PTR ? ["203.0.113.10"] : [],
      }),
    );
    expect(result.ptr.status).toBe("generic");
    expect(result.ptr.found).toEqual([CONTABO_PTR]);
    expect(result.ptr.forwardConfirmed).toBe(true);
    expect(result.ptr.provider?.id).toBe("contabo");
    expect(result.ptr.provider?.instructions).toContain("my.contabo.com");
    expect(result.ptr.provider?.instructions).toContain("Reverse DNS Management");
    expect(result.ptr.provider?.instructions).toContain("mail.exemplo.com.br");
    expect(result.ptr.ticketText).toBeNull();
    // não deixa o domínio com pendências
    expect(result.summary).toEqual({ ok: 6, total: 6 });
  });

  it("azul com provedor desconhecido: oferece o texto de chamado (opcional)", async () => {
    const result = await verifyDnsRecords(
      buildDnsChecklist(BASE_INPUT),
      allGreenExceptPtr({
        reverse: async () => ["srv42.provedor-qualquer.net"],
        resolve4: async (name) =>
          name === "mail.exemplo.com.br" || name === "srv42.provedor-qualquer.net" ? ["203.0.113.10"] : [],
      }),
    );
    expect(result.ptr.status).toBe("generic");
    expect(result.ptr.provider).toBeNull();
    expect(result.ptr.ticketText).toContain("srv42.provedor-qualquer.net");
    expect(result.summary.ok).toBe(6);
  });

  it("amarelo: o nome reverso não volta para o IP (FCrDNS falha)", async () => {
    const result = await verifyDnsRecords(
      buildDnsChecklist(BASE_INPUT),
      allGreenExceptPtr({
        reverse: async () => ["srv42.provedor-qualquer.net"],
        resolve4: async (name) =>
          name === "mail.exemplo.com.br" ? ["203.0.113.10"] : ["198.51.100.7"],
      }),
    );
    expect(result.ptr.status).toBe("mismatch");
    expect(result.ptr.forwardConfirmed).toBe(false);
    expect(result.ptr.ticketText).toContain("srv42.provedor-qualquer.net");
    expect(result.summary).toEqual({ ok: 5, total: 6 });
  });

  it("amarelo na Contabo: mostra o caminho no painel da Contabo, não o chamado", async () => {
    const result = await verifyDnsRecords(
      buildDnsChecklist(BASE_INPUT),
      allGreenExceptPtr({ reverse: async () => [CONTABO_PTR] }),
    );
    expect(result.ptr.status).toBe("mismatch");
    expect(result.ptr.provider?.id).toBe("contabo");
    expect(result.ptr.ticketText).toBeNull();
  });

  it("amarelo: IP sem PTR nenhum → chamado", async () => {
    const result = await verifyDnsRecords(buildDnsChecklist(BASE_INPUT), allGreenExceptPtr({}));
    expect(result.ptr.status).toBe("action_required");
    expect(result.ptr.forwardConfirmed).toBeNull();
    expect(result.ptr.provider).toBeNull();
    expect(result.ptr.ticketText).toContain("não possui registro PTR");
  });

  it("nome confirmado de provedor desconhecido, outro nome da Contabo: usa a instrução da Contabo", async () => {
    const result = await verifyDnsRecords(
      buildDnsChecklist(BASE_INPUT),
      allGreenExceptPtr({
        reverse: async () => ["srv42.provedor-qualquer.net", CONTABO_PTR],
        resolve4: async (name) =>
          name === "mail.exemplo.com.br" || name === "srv42.provedor-qualquer.net" ? ["203.0.113.10"] : [],
      }),
    );
    expect(result.ptr.status).toBe("generic");
    expect(result.ptr.provider?.id).toBe("contabo");
    expect(result.ptr.ticketText).toBeNull();
  });

  it("basta UM dos nomes reversos voltar para o IP", async () => {
    const result = await verifyDnsRecords(
      buildDnsChecklist(BASE_INPUT),
      allGreenExceptPtr({
        reverse: async () => ["velho.exemplo.net", CONTABO_PTR],
        resolve4: async (name) =>
          name === "mail.exemplo.com.br" || name === CONTABO_PTR ? ["203.0.113.10"] : [],
      }),
    );
    expect(result.ptr.status).toBe("generic");
    expect(result.ptr.provider?.id).toBe("contabo");
  });
});

describe("detectPtrProvider", () => {
  it.each([
    ["vmi1234567.contaboserver.net", "contabo", "my.contabo.com"],
    ["static.10.113.0.203.clients.your-server.de", "hetzner", "Reverse DNS"],
    ["203.0.113.10.vultrusercontent.com", "vultr", "Reverse DNS"],
  ])("%s → %s", (name, id, hint) => {
    const provider = detectPtrProvider(name, "mail.exemplo.com.br");
    expect(provider?.id).toBe(id);
    expect(provider?.instructions).toContain(hint);
    expect(provider?.instructions).toContain("mail.exemplo.com.br");
  });

  it("aceita ponto final e maiúsculas; não confunde sufixo parcial", () => {
    expect(detectPtrProvider("VMI1.CONTABOSERVER.NET.", "mail.x.com")?.id).toBe("contabo");
    expect(detectPtrProvider("contaboserver.net", "mail.x.com")?.id).toBe("contabo");
    expect(detectPtrProvider("host.falsocontaboserver.net", "mail.x.com")).toBeNull();
    expect(detectPtrProvider("host.provedor-qualquer.net", "mail.x.com")).toBeNull();
  });
});

describe("ptrTicketText", () => {
  it("gera chamado completo com IP e hostname quando não há PTR", () => {
    const text = ptrTicketText("203.0.113.10", "mail.exemplo.com.br");
    expect(text).toContain("203.0.113.10");
    expect(text).toContain("mail.exemplo.com.br");
    expect(text).toContain("não possui registro PTR");
  });

  it("menciona o PTR atual quando informado", () => {
    const text = ptrTicketText("203.0.113.10", "mail.exemplo.com.br", "old.host.com");
    expect(text).toContain('resolve para "old.host.com"');
  });
});

/**
 * Validação real (02/10/2026): o PTR da VPS estava azul (nome do provedor que
 * volta para o IP) e, numa verificação seguinte, ficou amarelo com "esse nome
 * não volta para o IP" — mas o DNS respondia certo. Consulta que falha por
 * demora ou erro do servidor de DNS não é resposta "não": tenta de novo e,
 * se continuar falhando, diz que não deu para conferir em vez de alarmar.
 */
describe("PTR com DNS instável", () => {
  const BASE = buildDnsChecklist(BASE_INPUT);
  const ip = BASE.ptr.ip;
  const timeout = () => Promise.reject(Object.assign(new Error("ETIMEOUT"), { code: "ETIMEOUT" }));

  it("a volta do nome (A) falha uma vez por demora: tenta de novo e fica azul", async () => {
    let calls = 0;
    const resolver = mockResolver({
      reverse: async () => ["vmi1234567.contaboserver.net"],
      resolve4: async (name) => {
        if (name !== "vmi1234567.contaboserver.net") throw Object.assign(new Error("x"), { code: "ENOTFOUND" });
        calls += 1;
        if (calls === 1) return timeout();
        return [ip];
      },
    });
    const result = await verifyDnsRecords(BASE, resolver);
    expect(result.ptr.status).toBe("generic");
    expect(calls).toBe(2);
  });

  it("a volta do nome continua falhando: 'não deu para conferir' (pendente), sem dizer que o Gmail recusa", async () => {
    const resolver = mockResolver({
      reverse: async () => ["vmi1234567.contaboserver.net"],
      resolve4: async (name) => (name === "vmi1234567.contaboserver.net" ? timeout() : Promise.reject(Object.assign(new Error("x"), { code: "ENOTFOUND" }))),
    });
    const result = await verifyDnsRecords(BASE, resolver);
    expect(result.ptr.status).toBe("pending");
    expect(result.ptr.forwardConfirmed).toBeNull();
    expect(result.ptr.ticketText).toBeNull();
  });

  it("a consulta reversa falha por demora: pendente, não 'IP sem nome reverso'", async () => {
    const resolver = mockResolver({ reverse: timeout });
    const result = await verifyDnsRecords(BASE, resolver);
    expect(result.ptr.status).toBe("pending");
    expect(result.ptr.ticketText).toBeNull();
  });

  it("resposta definitiva 'não existe' continua sendo amarelo", async () => {
    const resolver = mockResolver({ reverse: async () => ["vmi1234567.contaboserver.net"] });
    const result = await verifyDnsRecords(BASE, resolver);
    expect(result.ptr.status).toBe("mismatch");
  });
});
