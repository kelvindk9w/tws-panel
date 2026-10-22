/**
 * Nome de exibição das caixas de e-mail: a regra única do painel (servidor e tela).
 */
import { describe, expect, it } from "vitest";
import { MAILBOX_DISPLAY_NAME_MAX, MAILBOX_DISPLAY_NAME_PATTERN, normalizeDisplayName } from "../src/mail";

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
