import { describe, expect, it } from "vitest";
import { normalizeDomainInput, resolveDomainInput, stripTypedHost } from "../src/domain-input";

describe("stripTypedHost", () => {
  it("tira espaço, maiúsculas, esquema, caminho, barra e ponto final", () => {
    expect(stripTypedHost("  HTTPS://API.Example.com/x?y=1#z ")).toBe("api.example.com");
    expect(stripTypedHost("api.example.com.")).toBe("api.example.com");
    expect(stripTypedHost("http://api/")).toBe("api");
  });
});

describe("resolveDomainInput sem pai (nome completo, compatível com a API antiga)", () => {
  it("normaliza o nome completo", () => {
    expect(normalizeDomainInput("API.Example.com")).toBe("api.example.com");
    expect(normalizeDomainInput("https://example.com/")).toBe("example.com");
  });
  it("recusa o que não é nome", () => {
    expect(normalizeDomainInput("")).toBe("");
    expect(normalizeDomainInput("a b.example.com")).toBe("");
    expect(normalizeDomainInput("-a.example.com")).toBe("");
    expect(normalizeDomainInput("a_b.example.com")).toBe("");
    expect(normalizeDomainInput(`${"a".repeat(64)}.example.com`)).toBe("");
  });
  it("pai vazio ou só espaços equivale a sem pai", () => {
    expect(normalizeDomainInput("api.example.com", "")).toBe("api.example.com");
    expect(normalizeDomainInput("api.example.com", "  ")).toBe("api.example.com");
    expect(normalizeDomainInput("api.example.com", null)).toBe("api.example.com");
  });
});

describe("resolveDomainInput com pai", () => {
  it("rótulo vira rótulo.pai", () => {
    expect(resolveDomainInput("api", "example.com")).toEqual({ host: "api.example.com", fromLabel: true });
    expect(normalizeDomainInput("app.v2", "example.com")).toBe("app.v2.example.com");
    expect(normalizeDomainInput(" API ", "Example.COM.")).toBe("api.example.com");
    expect(normalizeDomainInput("api-1", "https://example.com/")).toBe("api-1.example.com");
  });
  it("@ ou vazio é o próprio pai", () => {
    expect(resolveDomainInput("@", "example.com")).toEqual({ host: "example.com", fromLabel: true });
    expect(normalizeDomainInput("", "example.com")).toBe("example.com");
    expect(normalizeDomainInput("   ", "example.com")).toBe("example.com");
  });
  it("nome que já termina no pai não é duplicado", () => {
    expect(resolveDomainInput("api.example.com", "example.com")).toEqual({ host: "api.example.com", fromLabel: false });
    expect(normalizeDomainInput("https://API.example.com/", "example.com")).toBe("api.example.com");
    expect(normalizeDomainInput("example.com", "example.com")).toBe("example.com");
  });
  it("um rótulo que só parece o pai (sufixo sem ponto) continua sendo rótulo", () => {
    expect(normalizeDomainInput("myexample", "example.com")).toBe("myexample.example.com");
  });
  it("valida os rótulos com as regras de DNS", () => {
    expect(normalizeDomainInput("-api", "example.com")).toBe("");
    expect(normalizeDomainInput("api-", "example.com")).toBe("");
    expect(normalizeDomainInput("a..b", "example.com")).toBe("");
    expect(normalizeDomainInput("a_b", "example.com")).toBe("");
    expect(normalizeDomainInput("a b", "example.com")).toBe("");
    expect(normalizeDomainInput("a".repeat(63), "example.com")).toBe(`${"a".repeat(63)}.example.com`);
    expect(normalizeDomainInput("a".repeat(64), "example.com")).toBe("");
  });
  it("respeita o limite de 253 caracteres no total", () => {
    const label = "a".repeat(63);
    expect(normalizeDomainInput(`${label}.${label}.${label}.${label}`, "example.com")).toBe("");
  });
  it("pai inválido dá vazio", () => {
    expect(normalizeDomainInput("api", "not a domain")).toBe("");
    expect(normalizeDomainInput("@", "-x.com")).toBe("");
  });
  it("rótulo Unicode com hífen na ponta é recusado antes e depois do punycode", () => {
    expect(normalizeDomainInput("-café", "example.com")).toBe("");
    expect(normalizeDomainInput("café-", "example.com")).toBe("");
    expect(normalizeDomainInput("café..x", "example.com")).toBe("");
    expect(normalizeDomainInput("é".repeat(60), "example.com")).toBe("");
  });
  it("rótulo Unicode vira punycode", () => {
    expect(normalizeDomainInput("café", "example.com")).toBe("xn--caf-dma.example.com");
  });
});

describe("entrada patológica", () => {
  it("100 mil '#', '.', '/' ou rótulos terminam rápido e dão vazio", () => {
    const inputs = ["#".repeat(100_000), ".".repeat(100_000), "a".repeat(100_000) + ".", "a." .repeat(50_000), "/".repeat(100_000)];
    const t0 = Date.now();
    for (const raw of inputs) {
      stripTypedHost(raw);
      expect(normalizeDomainInput(raw)).toBe("");
      // com pai, texto vazio depois de cortado é o próprio pai; nunca um nome inventado
      expect(["", "example.com"]).toContain(normalizeDomainInput(raw, "example.com"));
    }
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it("esquema seguido de '#' em massa sobra só o primeiro nome", () => {
    expect(stripTypedHost("https://a" + "#".repeat(100_000))).toBe("a");
  });
  it("o texto muito longo é cortado antes de processar", () => {
    expect(stripTypedHost("a".repeat(5000)).length).toBe(1000);
    expect(stripTypedHost("a.example.com" + "#".repeat(100_000))).toBe("a.example.com");
  });
});
