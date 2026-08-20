/**
 * Testes dos serviços de senha: hash/verify argon2id e validação de força —
 * verificando o RESULTADO (senha correta passa, errada falha, regras ok).
 */
import { describe, expect, it } from "vitest";
import { passwordStrengthErrors, validatePasswordStrength, validateUsername } from "@paas/core";
import { hashPassword, verifyPassword, verifyPasswordTimingSafe } from "../src/services/password.js";

describe("argon2 (hash/verify)", () => {
  it("hash gera formato argon2id e verifica a senha correta", async () => {
    const hash = await hashPassword("SenhaForte123");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    // o hash NUNCA contém a senha em claro
    expect(hash).not.toContain("SenhaForte123");
    expect(await verifyPassword(hash, "SenhaForte123")).toBe(true);
  });

  it("senha errada → verify false", async () => {
    const hash = await hashPassword("SenhaForte123");
    expect(await verifyPassword(hash, "senhaforte123")).toBe(false);
    expect(await verifyPassword(hash, "OutraSenha123")).toBe(false);
  });

  it("hashes da mesma senha diferem (salt aleatório)", async () => {
    const a = await hashPassword("SenhaForte123");
    const b = await hashPassword("SenhaForte123");
    expect(a).not.toBe(b);
  });

  it("hash malformado → false (sem lançar)", async () => {
    expect(await verifyPassword("lixo", "qualquer")).toBe(false);
  });

  it("timing-safe: usuário inexistente → false (verifica contra hash dummy)", async () => {
    expect(await verifyPasswordTimingSafe(null, "SenhaForte123")).toBe(false);
    const hash = await hashPassword("SenhaForte123");
    expect(await verifyPasswordTimingSafe(hash, "SenhaForte123")).toBe(true);
    expect(await verifyPasswordTimingSafe(hash, "errada")).toBe(false);
  });
});

describe("validatePasswordStrength", () => {
  it("senha forte (12+ chars, maiúscula, minúscula, número) → válida", () => {
    const result = validatePasswordStrength("MinhaSenha123");
    expect(result.valid).toBe(true);
    expect(passwordStrengthErrors("MinhaSenha123")).toEqual([]);
  });

  it("cada regra violada é reportada individualmente", () => {
    const curta = validatePasswordStrength("Aa1");
    expect(curta.valid).toBe(false);
    expect(curta.checks.minLength).toBe(false);

    expect(validatePasswordStrength("minhasenha123").checks.hasUpper).toBe(false);
    expect(validatePasswordStrength("MINHASENHA123").checks.hasLower).toBe(false);
    expect(validatePasswordStrength("MinhaSenhaForte").checks.hasNumber).toBe(false);

    const errors = passwordStrengthErrors("aaa");
    expect(errors.length).toBe(3); // tamanho, maiúscula e número
  });
});

describe("validateUsername", () => {
  it("aceita nomes simples e rejeita inválidos", () => {
    expect(validateUsername("admin")).toBe(true);
    expect(validateUsername("kelvin.souza-1_2")).toBe(true);
    expect(validateUsername("ab")).toBe(false); // curto demais
    expect(validateUsername("a".repeat(33))).toBe(false); // longo demais
    expect(validateUsername("-admin")).toBe(false); // começa com símbolo
    expect(validateUsername("adm in")).toBe(false); // espaço
    expect(validateUsername("")).toBe(false);
  });
});
