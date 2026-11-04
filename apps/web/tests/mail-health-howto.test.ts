/**
 * Estrutura do "O que fazer" (apps/web/src/lib/mail-health-howto.ts): quais
 * valores copiáveis cada item leva. Os testes comparam com o plano recebido
 * (dados de execução, endereços de documentação) para que trocar ou remover um
 * valor quebre aqui.
 */
import { describe, expect, it } from "vitest";
import type { DnsPlanResponse, MailHealthCheck } from "@paas/core";
import { HOWTO_STEP_COUNT, howtoFor, type HowtoCopy } from "../src/lib/mail-health-howto";
import { catalog } from "../src/i18n/core";

const DOMAIN = "loja.example.com";
const HOST = `mail.${DOMAIN}`;
const HELO = "srv.example.net";
const IP = "203.0.113.44";
const DKIM_VALUE = "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A";
const DMARC_VALUE = `v=DMARC1; p=none; rua=mailto:postmaster@${DOMAIN}`;

const PLAN: DnsPlanResponse = {
  domain: DOMAIN,
  serverHostname: HELO,
  ptr: { ip: IP, expected: HELO },
  mtaStsPolicy: `version: STSv1\r\nmode: testing\r\nmx: ${HOST}\r\n`,
  records: [
    { id: "a", order: 1, type: "A", name: HOST, value: IP, need: "required", purpose: "a", proxied: false },
    { id: "a_helo", order: 2, type: "A", name: HELO, value: IP, need: "required", purpose: "a_helo", proxied: false },
    { id: "mx", order: 3, type: "MX", name: DOMAIN, value: HOST, priority: 10, need: "required", purpose: "mx", proxied: false },
    { id: "spf", order: 4, type: "TXT", name: DOMAIN, value: `v=spf1 ip4:${IP} ~all`, need: "required", purpose: "spf", proxied: false },
    { id: "dkim", order: 5, type: "TXT", name: `paas._domainkey.${DOMAIN}`, value: DKIM_VALUE, need: "required", purpose: "dkim", proxied: false },
    { id: "dmarc", order: 6, type: "TXT", name: `_dmarc.${DOMAIN}`, value: DMARC_VALUE, need: "required", purpose: "dmarc", proxied: false },
    { id: "tls_rpt", order: 7, type: "TXT", name: `_smtp._tls.${DOMAIN}`, value: `v=TLSRPTv1; rua=mailto:postmaster@${DOMAIN}`, need: "optional", purpose: "tls_rpt", proxied: false },
    { id: "mta_sts_a", order: 8, type: "A", name: `mta-sts.${DOMAIN}`, value: IP, need: "optional", purpose: "mta_sts_a", proxied: false },
    { id: "mta_sts", order: 9, type: "TXT", name: `_mta-sts.${DOMAIN}`, value: "v=STSv1; id=20261022", need: "optional", purpose: "mta_sts", proxied: false },
  ],
};

function chk(over: Partial<MailHealthCheck> & Pick<MailHealthCheck, "id">): MailHealthCheck {
  return { level: "warn", inbox: true, code: "missing", params: {}, ...over };
}

/** label curto -> valor literal, para comparar sem depender da ordem. */
function values(copies: HowtoCopy[]): Record<string, string | undefined> {
  return Object.fromEntries(copies.map((c) => [c.labelKey.replace("mailHealth.howto.label.", ""), c.value]));
}

describe("howtoFor: valores copiáveis", () => {
  it("A do servidor de e-mail: nome e IP do plano", () => {
    const h = howtoFor(chk({ id: "a" }), PLAN)!;
    expect(h.variant).toBe("a");
    expect(values(h.copies)).toEqual({ name: HOST, ip: IP });
  });

  it("HELO: usa o registro A do nome do servidor (a_helo), não o do mail.<domínio>", () => {
    const h = howtoFor(chk({ id: "helo" }), PLAN)!;
    expect(h.variant).toBe("a");
    expect(values(h.copies)).toEqual({ name: HELO, ip: IP });
  });

  it("MX: nome, servidor e prioridade", () => {
    const h = howtoFor(chk({ id: "mx" }), PLAN)!;
    expect(values(h.copies)).toEqual({ name: DOMAIN, host: HOST, priority: "10" });
  });

  it("MX sem prioridade no plano: não inventa prioridade", () => {
    const plan = { ...PLAN, records: PLAN.records.map((r) => (r.id === "mx" ? { ...r, priority: undefined } : r)) };
    expect(values(howtoFor(chk({ id: "mx" }), plan)!.copies)).toEqual({ name: DOMAIN, host: HOST });
  });

  it("SPF: nome e o valor esperado do item; sem esperado, o do plano", () => {
    expect(values(howtoFor(chk({ id: "spf", expected: "v=spf1 ip4:198.51.100.9 -all" }), PLAN)!.copies)).toEqual({
      name: DOMAIN,
      value: "v=spf1 ip4:198.51.100.9 -all",
    });
    expect(values(howtoFor(chk({ id: "spf" }), PLAN)!.copies).value).toBe(`v=spf1 ip4:${IP} ~all`);
  });

  it("DKIM: nome com o seletor e o valor do plano (ou o esperado do item)", () => {
    expect(values(howtoFor(chk({ id: "dkim" }), PLAN)!.copies)).toEqual({ name: `paas._domainkey.${DOMAIN}`, value: DKIM_VALUE });
    expect(values(howtoFor(chk({ id: "dkim", expected: "v=DKIM1; p=OUTRA" }), PLAN)!.copies).value).toBe("v=DKIM1; p=OUTRA");
  });

  it("DMARC com problema: nome _dmarc e valor do plano", () => {
    expect(values(howtoFor(chk({ id: "dmarc", level: "critical" }), PLAN)!.copies)).toEqual({ name: `_dmarc.${DOMAIN}`, value: DMARC_VALUE });
  });

  it("PTR: nome, IP e texto pronto com os dados do plano", () => {
    const h = howtoFor(chk({ id: "ptr" }), PLAN)!;
    expect(values(h.copies)).toMatchObject({ ptrName: HELO, ip: IP });
    const request = h.copies.find((c) => c.messageKey)!;
    expect(request.messageKey).toBe("mailHealth.howto.ptr.request");
    expect(request.params).toEqual({ ip: IP, name: HELO });
    expect(h.severityKey).toBe("mailHealth.howto.ptr.severity");
    expect(h.params).toMatchObject({ ip: IP, name: HELO, domain: DOMAIN, host: HELO });
  });

  it("porta 25: texto pronto com o IP", () => {
    const h = howtoFor(chk({ id: "port25", level: "critical", code: "blocked" }), PLAN)!;
    expect(h.copies).toHaveLength(1);
    expect(h.copies[0]!.params).toEqual({ ip: IP });
    expect(h.severityKey).toBeUndefined();
  });

  it("MTA-STS sem o domínio do painel: passos próprios (configurar o domínio do painel), sem A/TXT para copiar", () => {
    const h = howtoFor(chk({ id: "mta_sts", level: "optional", code: "publish_unavailable", inbox: false }), PLAN)!;
    expect(h.variant).toBe("mta_sts_panel");
    expect(h.copies).toEqual([]);
    expect(h.steps).toHaveLength(3);
    expect(h.optional).toBe(true);
  });

  it("MTA-STS tem componente próprio (MtaStsHowTo): howtoFor só cuida do caso sem o domínio do painel", () => {
    for (const code of ["absent", "missing_a", "missing_txt", "id_outdated", "cert_pending", "testing", "mx_mismatch", "invalid"]) {
      expect(howtoFor(chk({ id: "mta_sts", level: "optional", code, inbox: false }), PLAN), code).toBeNull();
    }
    expect(howtoFor(chk({ id: "mta_sts", level: "critical", code: "mx_mismatch", inbox: true }), PLAN)).toBeNull();
  });

  it("TLS-RPT: nome e valor; opcional com ganho", () => {
    const h = howtoFor(chk({ id: "tls_rpt", level: "optional", code: "absent", inbox: false }), PLAN)!;
    expect(values(h.copies)).toEqual({ name: `_smtp._tls.${DOMAIN}`, value: `v=TLSRPTv1; rua=mailto:postmaster@${DOMAIN}` });
    expect(h.optional).toBe(true);
    expect(h.gainKey).toBe("mailHealth.howto.tls_rpt.gain");
  });

  it("itens sem valor para copiar (fila, certificado, listas, propagação) só têm passos", () => {
    for (const id of ["queue", "tls", "dnsbl", "propagation"] as const) {
      const h = howtoFor(chk({ id, code: "x" }), PLAN)!;
      expect(h.variant).toBe(id);
      expect(h.copies, id).toEqual([]);
      expect(h.optional, id).toBe(false);
      expect(h.gainKey, id).toBeUndefined();
      expect(h.steps, id).toHaveLength(HOWTO_STEP_COUNT[id]);
    }
  });

  it("registro ausente no plano: sem valores copiáveis, sem quebrar", () => {
    const empty: DnsPlanResponse = { ...PLAN, records: [] };
    for (const id of ["a", "helo", "mx", "spf", "dkim", "dmarc", "tls_rpt"] as const) {
      const h = howtoFor(chk({ id }), empty)!;
      expect(h.copies.filter((c) => c.value !== undefined && !c.value.startsWith("https://") && c.value !== empty.mtaStsPolicy), id).toEqual([]);
    }
  });
});

describe("howtoFor: próximo passo do DMARC e itens que não precisam de ação", () => {
  it("p=none em ordem: sugere p=quarantine, mostra o valor atual e o novo, com ganho e risco", () => {
    const h = howtoFor(chk({ id: "dmarc", level: "ok", code: "none", found: [DMARC_VALUE] }), PLAN)!;
    expect(h.variant).toBe("dmarc_next_none");
    expect(h.optional).toBe(true);
    expect(h.nextStep).toBe(true);
    expect(h.gainKey).toBe("mailHealth.howto.dmarc_next_none.gain");
    expect(h.riskKey).toBe("mailHealth.howto.dmarc_next_none.risk");
    expect(values(h.copies)).toEqual({
      name: `_dmarc.${DOMAIN}`,
      current: DMARC_VALUE,
      value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${DOMAIN}`,
    });
  });

  it("p=quarantine em ordem: sugere p=reject", () => {
    const current = `v=DMARC1; p=quarantine; pct=50; rua=mailto:postmaster@${DOMAIN}`;
    const h = howtoFor(chk({ id: "dmarc", level: "ok", code: "quarantine", found: [current] }), PLAN)!;
    expect(h.variant).toBe("dmarc_next_quarantine");
    expect(values(h.copies).value).toBe(`v=DMARC1; p=reject; pct=50; rua=mailto:postmaster@${DOMAIN}`);
    expect(h.steps).toHaveLength(2);
  });

  it("sem o valor encontrado, parte do valor do plano", () => {
    const h = howtoFor(chk({ id: "dmarc", level: "ok", code: "none" }), PLAN)!;
    expect(values(h.copies).current).toBe(DMARC_VALUE);
    expect(values(h.copies).value).toContain("p=quarantine");
  });

  it("sem registro DMARC no plano e sem valor encontrado: não oferece valores", () => {
    const plan = { ...PLAN, records: PLAN.records.filter((r) => r.id !== "dmarc") };
    expect(howtoFor(chk({ id: "dmarc", level: "ok", code: "none" }), plan)!.copies).toEqual([]);
  });

  it("p=reject em ordem e itens em ordem não têm o que fazer", () => {
    expect(howtoFor(chk({ id: "dmarc", level: "ok", code: "reject" }), PLAN)).toBeNull();
    expect(howtoFor(chk({ id: "spf", level: "ok", code: "ok_hard" }), PLAN)).toBeNull();
    expect(howtoFor(chk({ id: "helo", level: "ok", code: "ok" }), PLAN)).toBeNull();
    expect(howtoFor(chk({ id: "queue", level: "ok", code: "empty" }), PLAN)).toBeNull();
  });

  it("fila com mensagem adiada tem passos; a variante 'a' tem 4 passos e a do PTR 5", () => {
    expect(howtoFor(chk({ id: "queue", code: "deferred_auth", level: "critical" }), PLAN)!.steps).toHaveLength(3);
    expect(howtoFor(chk({ id: "a" }), PLAN)!.steps).toHaveLength(4);
    expect(howtoFor(chk({ id: "ptr" }), PLAN)!.steps).toHaveLength(5);
  });
});

describe("howtoFor: passo do PTR conforme o item HELO", () => {
  it("com HELO no relatório, o 2º passo aponta para o HELO; sem, para o Registro A", () => {
    const withHelo = howtoFor(chk({ id: "ptr" }), PLAN, { hasHelo: true })!;
    const without = howtoFor(chk({ id: "ptr" }), PLAN)!;
    expect(withHelo.steps[1]).toBe("mailHealth.howto.ptr.2helo");
    expect(without.steps[1]).toBe("mailHealth.howto.ptr.2");
    expect(withHelo.steps).toHaveLength(without.steps.length);
    expect(withHelo.steps.filter((s, i) => i !== 1)).toEqual(without.steps.filter((s, i) => i !== 1));
  });

  it("hasHelo não muda os outros itens", () => {
    expect(howtoFor(chk({ id: "spf" }), PLAN, { hasHelo: true })!.steps).toEqual(howtoFor(chk({ id: "spf" }), PLAN)!.steps);
  });
});

describe("dicionário x estrutura do 'O que fazer'", () => {
  it.each(Object.keys(catalog))("%s tem todos os passos, ganhos e riscos", (locale) => {
    const dict = catalog[locale]!.mailHealth as unknown as Record<string, string>;
    const missing: string[] = [];
    for (const [variant, count] of Object.entries(HOWTO_STEP_COUNT)) {
      for (let i = 1; i <= count; i++) if (!(`howto.${variant}.${i}` in dict)) missing.push(`${variant}.${i}`);
      // não sobra passo no dicionário sem estar na contagem
      if (`howto.${variant}.${count + 1}` in dict) missing.push(`${variant}.${count + 1} (extra)`);
    }
    if (!("howto.ptr.2helo" in dict)) missing.push("ptr.2helo");
    for (const v of ["mta_sts_panel", "tls_rpt", "dmarc_next_none", "dmarc_next_quarantine"]) if (!(`howto.${v}.gain` in dict)) missing.push(`${v}.gain`);
    // o ganho do MTA-STS é lido pelo componente MtaStsHowTo
    if (!("howto.mta_sts.gain" in dict)) missing.push("mta_sts.gain");
    for (const v of ["dmarc_next_none", "dmarc_next_quarantine"]) if (!(`howto.${v}.risk` in dict)) missing.push(`${v}.risk`);
    expect(missing).toEqual([]);
  });
});
