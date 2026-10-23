/**
 * O par de um domínio (example.com <-> www.example.com): quem tem par, quem não
 * tem (subdomínio, IP, localhost, hospedagem compartilhada) e como o nome se
 * escreve no provedor de DNS (@, www, loja), inclusive com sufixo composto.
 */
import { describe, expect, it } from "vitest";
import { apexOf, cleanHost, COMPOUND_SUFFIXES, dnsHostLabel, pairOf } from "../src/domain-pair";

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

  it("a lista de sufixos compostos só tem dois rótulos", () => {
    for (const s of COMPOUND_SUFFIXES) expect(s.split(".")).toHaveLength(2);
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
  it("nome fora de uma zona conhecida volta inteiro", () => {
    expect(dnsHostLabel("loja.localhost")).toBe("loja.localhost");
    expect(dnsHostLabel("203.0.113.10")).toBe("203.0.113.10");
  });
});
