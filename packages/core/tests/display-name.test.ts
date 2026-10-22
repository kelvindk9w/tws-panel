/**
 * Nome de exibição das caixas de e-mail: a regra única do painel (servidor e tela).
 */
import { describe, expect, it } from "vitest";
import { MAILBOX_DISPLAY_NAME_MAX, MAILBOX_DISPLAY_NAME_PATTERN, normalizeDisplayName, sanitizeDisplayName } from "../src/mail";

describe("normalizeDisplayName", () => {
  it("vazio, ausente e só espaços valem 'sem nome'", () => {
    for (const raw of [undefined, null, "", "   "]) expect(normalizeDisplayName(raw)).toEqual({ ok: true, value: "" });
  });

  it("apara e junta espaços repetidos, mantém UTF-8", () => {
    expect(normalizeDisplayName("  Loja   Exemplo - Ação 日本 😀 ")).toEqual({ ok: true, value: "Loja Exemplo - Ação 日本 😀" });
  });

  it("aceita exatamente o limite, contando caracteres (não bytes nem unidades UTF-16)", () => {
    expect(normalizeDisplayName("é".repeat(MAILBOX_DISPLAY_NAME_MAX)).ok).toBe(true);
    expect(normalizeDisplayName("😀".repeat(MAILBOX_DISPLAY_NAME_MAX)).ok).toBe(true);
    expect(normalizeDisplayName("x".repeat(MAILBOX_DISPLAY_NAME_MAX + 1)).ok).toBe(false);
  });

  it("recusa o que não é texto", () => {
    expect(normalizeDisplayName(42)).toMatchObject({ ok: false, code: "not_text" });
    expect(normalizeDisplayName({})).toMatchObject({ ok: false, code: "not_text" });
  });

  it.each(["a\rb", "a\nb", "a\r\nBcc: x@evil.test", "a\tb", "a\u0000b", "a\u007fb", "a\u0085b", "\nabc", "abc\r", "a b", "a b", "a‮b", "a⁦b", "a<b", "a>b", 'a"b', "a\\b"])(
    "recusa %j (controle, quebra de linha, direção, < >, aspas, barra invertida)",
    (raw) => {
      expect(normalizeDisplayName(raw)).toMatchObject({ ok: false, code: "invalid_chars" });
    },
  );

  it("o limite é reportado com código próprio", () => {
    expect(normalizeDisplayName("x".repeat(81))).toMatchObject({ ok: false, code: "too_long" });
  });

  it("aceita aspas simples, parênteses, & e @ (nada que quebre o cabeçalho From)", () => {
    expect(normalizeDisplayName("O'Neil (Vendas) & Cia @ Loja").ok).toBe(true);
  });

  it("o padrão exportado (usado no schema das rotas) concorda com a função", () => {
    const re = new RegExp(MAILBOX_DISPLAY_NAME_PATTERN, "u");
    expect(re.test("Loja Exemplo")).toBe(true);
    expect(re.test("")).toBe(true);
    expect(re.test("a\r\nb")).toBe(false);
    expect(re.test("a<b")).toBe(false);
  });
});

describe("sanitizeDisplayName", () => {
  it("tira o que o nome não aceita (vira espaço), junta espaços e corta no limite", () => {
    expect(sanitizeDisplayName("Loja\r\nBcc: x")).toBe("Loja Bcc: x");
    expect(sanitizeDisplayName("Loja <b>")).toBe("Loja b");
    expect(sanitizeDisplayName("  a\u200bb\ud800c ")).toBe("a b c");
    expect(sanitizeDisplayName("x".repeat(200))).toHaveLength(MAILBOX_DISPLAY_NAME_MAX);
    expect(sanitizeDisplayName("😀".repeat(200))).toBe("😀".repeat(MAILBOX_DISPLAY_NAME_MAX));
  });

  it("só caracteres inválidos, vazio, nulo: sem nome (vazio), nunca o texto cru", () => {
    expect(sanitizeDisplayName("<<>>")).toBe("");
    expect(sanitizeDisplayName(null)).toBe("");
    expect(sanitizeDisplayName(undefined)).toBe("");
  });

  it("o resultado sempre passa em normalizeDisplayName", () => {
    for (const raw of ["a\r\nb", "<<x>>", "\u202eabc", "ok", "é".repeat(120)]) {
      expect(normalizeDisplayName(sanitizeDisplayName(raw)).ok).toBe(true);
    }
  });

  it("'@' e emoji sem junção são aceitos (o endereço real continua visível)", () => {
    expect(normalizeDisplayName("ceo@example.com").ok).toBe(true);
    expect(normalizeDisplayName("Loja 😀").ok).toBe(true);
  });
});
