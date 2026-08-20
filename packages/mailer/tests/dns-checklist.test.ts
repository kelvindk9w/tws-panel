/**
 * Testes do checklist DNS de e-mail (dns-checklist.ts): geração dos registros
 * esperados (SPF com o IP certo, DKIM RSA, DMARC progressivo) e a verificação
 * contra o DNS real com resolver mockado (found/missing/mismatch/PTR).
 */
import { describe, expect, it } from "vitest";
import {
  buildDnsChecklist,
  dmarcValue,
  ptrTicketText,
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
