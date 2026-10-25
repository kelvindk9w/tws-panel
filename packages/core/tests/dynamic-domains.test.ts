/**
 * Validação do nome e do sufixo dos domínios dinâmicos: o que pode receber
 * certificado público sob demanda e o que nunca pode.
 */
import { describe, expect, it } from "vitest";
import {
  DYNAMIC_DOMAIN_LIMIT_DEFAULTS,
  DYNAMIC_DOMAIN_LIMIT_RANGE,
  checkDynamicHost,
  checkDynamicSuffix,
  dynamicHostWarning,
  isOneLevelUnder,
} from "../src/dynamic-domains";

describe("checkDynamicHost", () => {
  it("normaliza e aceita nomes comuns", () => {
    expect(checkDynamicHost("  App.Cliente.EXAMPLE. ")).toEqual({ ok: true, host: "app.cliente.example" });
    expect(checkDynamicHost("cliente1.example.com")).toEqual({ ok: true, host: "cliente1.example.com" });
  });

  it("Unicode vira punycode", () => {
    expect(checkDynamicHost("exämple.com")).toEqual({ ok: true, host: "xn--exmple-cua.com" });
  });

  it.each([
    ["*.example.com", "wildcard"],
    ["*", "wildcard"],
    ["", "invalid"],
    ["   ", "invalid"],
    ["https://app.example.com", "invalid"],
    ["app.example.com/caminho", "invalid"],
    ["app.example.com:8080", "invalid"],
    ["a b.example.com", "invalid"],
    ["-a.example.com", "invalid"],
    ["a..example.com", "invalid"],
    ["exemplo", "single_label"],
    ["203.0.113.5", "ip"],
    ["[2001:db8::1]", "invalid"],
    ["2001:db8::1", "invalid"],
    ["localhost", "single_label"],
    ["app.localhost", "local"],
    ["painel.local", "local"],
    ["db.internal", "local"],
    ["x.test", "local"],
    ["com.br", "public_suffix"],
    ["co.uk", "public_suffix"],
  ])("recusa %j (%s)", (value, issue) => {
    const r = checkDynamicHost(value);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issue).toBe(issue);
      expect(r.message.length).toBeGreaterThan(10);
    }
  });

  it("recusa o que não é texto e texto gigante", () => {
    expect(checkDynamicHost(undefined).ok).toBe(false);
    expect(checkDynamicHost(42).ok).toBe(false);
    expect(checkDynamicHost("a".repeat(401)).ok).toBe(false);
    expect(checkDynamicHost(`${"a".repeat(64)}.example.com`).ok).toBe(false);
    expect(checkDynamicHost(`${"a.".repeat(130)}com`).ok).toBe(false);
  });

  it("aceita o limite de 253 caracteres", () => {
    const name = `${["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(53)].join(".")}.com`;
    expect(name.length).toBeLessThanOrEqual(253);
    expect(checkDynamicHost(name).ok).toBe(true);
  });
});

describe("checkDynamicSuffix", () => {
  it("aceita com ou sem o curinga na frente", () => {
    expect(checkDynamicSuffix("*.Example.com")).toEqual({ ok: true, host: "example.com" });
    expect(checkDynamicSuffix("example.com.br")).toEqual({ ok: true, host: "example.com.br" });
    expect(checkDynamicSuffix("clientes.example.com")).toEqual({ ok: true, host: "clientes.example.com" });
  });

  it.each(["com.br", "*.com.br", "com", "*.com", "herokuapp.com", "*.sslip.io", "localhost", "*", "*.*.example.com", "203.0.113.5", "x.local"])(
    "recusa %j",
    (value) => {
      expect(checkDynamicSuffix(value).ok).toBe(false);
    },
  );

  it("diz por que sufixo de hospedagem compartilhada não vale", () => {
    const r = checkDynamicSuffix("meuapp.herokuapp.com");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issue).toBe("shared_hosting");
    expect(checkDynamicSuffix(42).ok).toBe(false);
  });
});

describe("isOneLevelUnder", () => {
  it("só um nível acima do sufixo", () => {
    expect(isOneLevelUnder("x.example.com", "example.com")).toBe(true);
    expect(isOneLevelUnder("a.b.example.com", "example.com")).toBe(false);
    expect(isOneLevelUnder("example.com", "example.com")).toBe(false);
    expect(isOneLevelUnder(".example.com", "example.com")).toBe(false);
    expect(isOneLevelUnder("xexample.com", "example.com")).toBe(false);
    expect(isOneLevelUnder("x.other.com", "example.com")).toBe(false);
  });
});

describe("hospedagem compartilhada e terminações reservadas (B9)", () => {
  it.each(["app.github.io", "x.sslip.io", "a.nip.io", "x.eu.org", "a.b.github.io"])("recusa o nome %s como hospedagem compartilhada", (host) => {
    for (const r of [checkDynamicHost(host), checkDynamicSuffix(host)]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issue).toBe("shared_hosting");
    }
  });

  it("avisa (sem recusar) de .example e .alt, e de mais nada", () => {
    expect(checkDynamicHost("app.cliente.example").ok).toBe(true);
    expect(dynamicHostWarning("app.cliente.example")).toBe("reserved_tld");
    expect(dynamicHostWarning("foo.alt")).toBe("reserved_tld");
    expect(dynamicHostWarning("a.example.com")).toBeNull();
  });
});

describe("limites", () => {
  it("padrões dentro da faixa", () => {
    expect(DYNAMIC_DOMAIN_LIMIT_DEFAULTS).toEqual({ maxNamesPerProject: 500, maxIssuancesPerHour: 20, maxIssuancesPerWeekPerDomain: 40 });
    // o teto semanal fica abaixo dos 50 certificados por domínio registrado que o Let's Encrypt aceita em 7 dias
    expect(DYNAMIC_DOMAIN_LIMIT_RANGE.maxIssuancesPerWeekPerDomain.max).toBeLessThan(50);
    for (const key of ["maxNamesPerProject", "maxIssuancesPerHour", "maxIssuancesPerWeekPerDomain"] as const) {
      expect(DYNAMIC_DOMAIN_LIMIT_DEFAULTS[key]).toBeGreaterThanOrEqual(DYNAMIC_DOMAIN_LIMIT_RANGE[key].min);
      expect(DYNAMIC_DOMAIN_LIMIT_DEFAULTS[key]).toBeLessThanOrEqual(DYNAMIC_DOMAIN_LIMIT_RANGE[key].max);
    }
  });
});
