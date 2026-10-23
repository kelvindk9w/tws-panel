/**
 * O par de um domínio (example.com <-> www.example.com): quem tem par, quem não
 * tem (subdomínio, IP, localhost, hospedagem compartilhada) e como o nome se
 * escreve no provedor de DNS (@, www, loja), inclusive com sufixo composto.
 */
import { describe, expect, it } from "vitest";
import { apexOf, cleanHost, dnsHostLabel, hasUncertainSuffix, isPublicSuffix, pairOf } from "../src/domain-pair";

describe("cleanHost", () => {
  it("normaliza maiúsculas, espaços e ponto final", () => {
    expect(cleanHost("  Example.COM. ")).toBe("example.com");
  });
  it.each(["", "   ", "exa mple.com", "-a.com", "a..com", "a_b.com", "http://a.com", "exämple.com", "a.com/x"])("recusa %j", (v) => {
    expect(cleanHost(v)).toBe("");
  });
  it("aceita punycode (IDN já convertido)", () => {
    expect(cleanHost("xn--exmple-cua.com")).toBe("xn--exmple-cua.com");
  });
});

describe("apexOf", () => {
  it.each([
    ["example.com", "example.com"],
    ["www.example.com", "example.com"],
    ["app.example.com", "example.com"],
    ["a.b.c.example.com", "example.com"],
    ["example.com.br", "example.com.br"],
    ["www.example.com.br", "example.com.br"],
    ["loja.example.com.br", "example.com.br"],
    ["example.co.uk", "example.co.uk"],
    ["blog.example.co.uk", "example.co.uk"],
    ["example.org.br", "example.org.br"],
    ["example.io", "example.io"],
    ["Example.COM.", "example.com"],
  ])("%s -> %s", (host, apex) => {
    expect(apexOf(host)).toBe(apex);
  });

  it.each([
    "localhost",
    "loja.localhost",
    "com",
    "br",
    "com.br",
    "co.uk",
    "203.0.113.10",
    "1.2.3.4.5",
    "loja.203-0-113-10.sslip.io",
    "x.nip.io",
    "meu.github.io",
    "app.vercel.app",
    "host.internal",
    "a.test",
    "",
    "não é domínio",
  ])("sem apex para %j", (host) => {
    expect(apexOf(host)).toBeNull();
  });

});

describe("pairOf", () => {
  it("apex ganha o www", () => {
    expect(pairOf("example.com")).toEqual({ canonical: "example.com", pair: "www.example.com", role: "www", apex: "example.com" });
  });
  it("www ganha o apex", () => {
    expect(pairOf("www.example.com")).toEqual({ canonical: "www.example.com", pair: "example.com", role: "apex", apex: "example.com" });
  });
  it("TLD composto: example.com.br <-> www.example.com.br", () => {
    expect(pairOf("example.com.br")).toMatchObject({ pair: "www.example.com.br", role: "www", apex: "example.com.br" });
    expect(pairOf("www.example.com.br")).toMatchObject({ pair: "example.com.br", role: "apex" });
    expect(pairOf("example.co.uk")?.pair).toBe("www.example.co.uk");
    expect(pairOf("www.example.co.uk")?.pair).toBe("example.co.uk");
  });
  it("maiúsculas e ponto final não mudam o par", () => {
    expect(pairOf("WWW.Example.COM.")?.pair).toBe("example.com");
  });
  it.each([
    "app.example.com",
    "blog.example.com",
    "www.app.example.com",
    "www.www.example.com",
    "loja.example.com.br",
    "api.example.co.uk",
    "localhost",
    "www.localhost",
    "203.0.113.10",
    "loja.203-0-113-10.sslip.io",
    "www.sslip.io",
    "com.br",
    "www.com.br",
    "",
  ])("%j não tem par", (host) => {
    expect(pairOf(host)).toBeNull();
  });
  it("sufixo composto desconhecido cai no lado seguro: sem par", () => {
    expect(pairOf("example.com.xx")).toBeNull();
    expect(pairOf("www.example.com.xx")).toBeNull();
  });
});

describe("dnsHostLabel", () => {
  it.each([
    ["example.com", "@"],
    ["www.example.com", "www"],
    ["loja.example.com", "loja"],
    ["a.b.example.com", "a.b"],
    ["example.com.br", "@"],
    ["www.example.com.br", "www"],
    ["loja.example.com.br", "loja"],
    ["example.co.uk", "@"],
    ["www.example.co.uk", "www"],
    ["EXAMPLE.com.", "@"],
  ])("%s -> %s", (host, label) => {
    expect(dnsHostLabel(host)).toBe(label);
  });
  // Rodadas 1 a 4 do revisor: cada caso é "digitado -> rótulo no provedor de DNS" pela PSL.
  it.each([
    ["example.dev.br", "@"], ["www.example.dev.br", "www"], ["www.example.app.br", "www"], ["loja.example.tec.br", "loja"],
    ["example.ind.br", "@"], ["example.inf.br", "@"], ["example.eco.br", "@"], ["example.blog.br", "@"],
    ["example.com.pt", "@"], ["www.example.com.pt", "www"],
    ["example.salvador.br", "@"], ["www.example.salvador.br", "www"], ["example.recife.br", "@"], ["example.floripa.br", "@"],
    ["example.campinas.br", "@"], ["loja.example.rio.br", "loja"],
    ["example.br.com", "@"], ["www.example.br.com", "www"], ["example.us.com", "@"], ["example.uk.net", "@"], ["www.example.eu.com", "www"],
    ["example.sp.gov.br", "@"], ["www.example.sp.gov.br", "www"], ["loja.example.rj.gov.br", "loja"],
    ["joao.silva.nom.br", "@"], ["www.joao.silva.nom.br", "www"],
    ["shop.se.com", "shop"], ["loja.ca.com", "loja"], ["app.web.com", "app"],
    ["shop.com.ch", "shop"], ["shop.com.nl", "shop"], ["shop.com.it", "shop"], ["loja.com.cl", "loja"],
    ["site.de", "@"], ["www.site.de", "www"], ["loja.io", "@"], ["meu.co", "@"], ["www.meu.co", "www"], ["shop.example.io", "shop"],
    ["example.ia.br", "@"], ["www.example.xyz.br", "www"], ["example.abc.br", "@"], ["example.bet.br", "@"], ["example.api.br", "@"],
    ["example.social.br", "@"], ["example.adm.br", "@"], ["example.feira.br", "@"], ["example.maringa.br", "@"], ["example.riopreto.br", "@"],
    ["example.com.sa", "@"], ["www.example.co.il", "www"], ["www.example.com.pl", "www"], ["www.city.kobe.jp", "www"],
  ])("%s -> %s (nunca truncado)", (host, label) => {
    expect(dnsHostLabel(host)).toBe(label);
    expect(hasUncertainSuffix(host)).toBe(false);
  });

  it("curinga e exceção da PSL: *.nom.br e !city.kobe.jp", () => {
    expect(apexOf("www.joao.silva.nom.br")).toBe("joao.silva.nom.br");
    expect(isPublicSuffix("silva.nom.br")).toBe(true);
    expect(apexOf("city.kobe.jp")).toBe("city.kobe.jp");
    expect(isPublicSuffix("a.kobe.jp")).toBe(true);
    expect(apexOf("x.a.kobe.jp")).toBe("x.a.kobe.jp");
    expect(isPublicSuffix("anything.ck")).toBe(true);
    expect(apexOf("www.ck")).toBe("www.ck");
  });

  it("o nome digitado que é um sufixo público (sp.gov.br, com.br, ia.br) não é registrável: sem apex, sem par, nome inteiro", () => {
    for (const host of ["sp.gov.br", "com.br", "ia.br", "xyz.br", "maringa.br", "co.uk", "silva.nom.br"]) {
      expect(isPublicSuffix(host)).toBe(true);
      expect(apexOf(host)).toBeNull();
      expect(pairOf(host)).toBeNull();
      expect(dnsHostLabel(host)).toBe(host);
    }
    for (const host of ["example.com.br", "www.sp.gov.br", "localhost", "203.0.113.10", "example.com", "com", "nao é host"]) {
      expect(isPublicSuffix(host)).toBe(false);
    }
  });

  it("os pares de nomes comuns", () => {
    expect(pairOf("site.de")?.pair).toBe("www.site.de");
    expect(pairOf("www.meu.co")?.pair).toBe("meu.co");
    expect(pairOf("joao.silva.nom.br")?.pair).toBe("www.joao.silva.nom.br");
    expect(pairOf("example.ia.br")?.pair).toBe("www.example.ia.br");
    expect(pairOf("shop.se.com")).toBeNull();
    expect(pairOf("se.com")?.pair).toBe("www.se.com");
    // santos.br, vitoria.br, vlg.br... não são sufixos na PSL: são domínios comuns
    expect(isPublicSuffix("santos.br")).toBe(false);
    expect(pairOf("santos.br")?.pair).toBe("www.santos.br");
    expect(dnsHostLabel("example.santos.br")).toBe("example");
  });

  it.each(["example.xyz.zz", "loja.xyz.qq", "www.site.zz", "app.com.zz"])(
    "TLD de país que a PSL não conhece (%s): incerto, nome completo, nunca rótulo truncado",
    (host) => {
      expect(hasUncertainSuffix(host)).toBe(true);
      expect(dnsHostLabel(host)).toBe(host);
    },
  );
  it.each(["example.com", "www.example.com.br", "app.example.io", "shop.example.io", "example.de", "www.example.de", "localhost", "site.zz"])(
    "%s não é incerto",
    (host) => {
      expect(hasUncertainSuffix(host)).toBe(false);
    },
  );
  it("nome fora de uma zona conhecida volta inteiro", () => {
    expect(dnsHostLabel("loja.localhost")).toBe("loja.localhost");
    expect(dnsHostLabel("203.0.113.10")).toBe("203.0.113.10");
  });
});
