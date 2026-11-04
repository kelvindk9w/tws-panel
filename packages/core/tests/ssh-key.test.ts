/**
 * Testes da validação de chave pública SSH e nome de usuário (Fase 01):
 * a chave é injetada em comando shell single-quoted pelo executor — o
 * validador precisa aceitar formatos legítimos e rejeitar qualquer tentativa
 * de quebra de quoting/injeção.
 */
import { describe, expect, it } from "vitest";
import { isValidSshPublicKey, isValidSshUsername } from "../src/security";

const ED25519 = `ssh-ed25519 ${"A".repeat(68)}`;
const RSA = `ssh-rsa ${"B".repeat(372)}`;
const ECDSA = `ecdsa-sha2-nistp256 ${"C".repeat(140)}`;

describe("isValidSshPublicKey", () => {
  it("aceita formatos legítimos com e sem comentário", () => {
    expect(isValidSshPublicKey(ED25519)).toBe(true);
    expect(isValidSshPublicKey(`${ED25519} user@host`)).toBe(true);
    expect(isValidSshPublicKey(`${ED25519} comentário com espaços-ok_1.0`)).toBe(true);
    expect(isValidSshPublicKey(RSA)).toBe(true);
    expect(isValidSshPublicKey(ECDSA)).toBe(true);
    expect(isValidSshPublicKey(`  ${ED25519}  `)).toBe(true); // trim
  });

  it("rejeita tipos de chave não suportados e corpos inválidos", () => {
    expect(isValidSshPublicKey("ssh-dss AAAA")).toBe(false);
    expect(isValidSshPublicKey("ed25519 sem-prefixo")).toBe(false);
    expect(isValidSshPublicKey("ssh-ed25519 CURTA")).toBe(false);
    expect(isValidSshPublicKey(`ssh-ed25519 ${"A".repeat(68)}!#$%`)).toBe(false);
  });

  it("rejeita quebra de quoting e injeção de shell", () => {
    expect(isValidSshPublicKey(`${ED25519}' ; rm -rf / #`)).toBe(false);
    expect(isValidSshPublicKey(`${ED25519}" ; rm -rf / #`)).toBe(false);
    expect(isValidSshPublicKey(`${ED25519}\\`)).toBe(false);
    expect(isValidSshPublicKey(`${ED25519}\noutra-linha`)).toBe(false);
    expect(isValidSshPublicKey(`${ED25519}\r\noutra-linha`)).toBe(false);
    expect(isValidSshPublicKey(`$(rm -rf /) ${ED25519}`)).toBe(false);
  });

  it("rejeita tamanhos absurdos", () => {
    expect(isValidSshPublicKey("")).toBe(false);
    expect(isValidSshPublicKey("ssh-ed25519")).toBe(false);
    expect(isValidSshPublicKey(`${ED25519} ${"x".repeat(3000)}`)).toBe(false);
  });
});

describe("isValidSshUsername", () => {
  it("aceita nomes Linux válidos", () => {
    for (const ok of ["deploy", "kelvin", "user-01", "ops_admin", "_svc"]) {
      expect(isValidSshUsername(ok), ok).toBe(true);
    }
  });

  it("rejeita root, vazio, maiúsculas e caracteres especiais", () => {
    for (const bad of ["root", "", "Deploy", "a b", "a;b", "a'; rm -rf /;'", "1abc", "a".repeat(40)]) {
      expect(isValidSshUsername(bad), bad).toBe(false);
    }
  });
});
