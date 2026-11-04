/**
 * totp.test.ts — o cálculo do código de 6 dígitos (RFC 6238) e os códigos de
 * recuperação. Os vetores vêm do Apêndice B da RFC 6238 (SHA-1, segredo
 * "12345678901234567890"); o código de 6 dígitos são os 6 últimos dos 8.
 */
import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  otpauthUri,
  totpCode,
  verifyTotp,
  TOTP_STEP_SECONDS,
} from "../src/services/totp.js";

const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));

describe("totpCode — vetores da RFC 6238", () => {
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
  ])("t=%i → %s", (t, esperado) => {
    expect(totpCode(RFC_SECRET, Math.floor(t / TOTP_STEP_SECONDS))).toBe(esperado);
  });
});

describe("base32", () => {
  it("ida e volta sem perda; aceita minúsculas, espaços e hífens ao decodificar", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255, 128, 64]);
    const enc = base32Encode(bytes);
    expect(enc).toMatch(/^[A-Z2-7]+$/);
    expect(base32Decode(enc).equals(bytes)).toBe(true);
    expect(base32Decode(enc.toLowerCase().replace(/(.{4})/g, "$1 ")).equals(bytes)).toBe(true);
  });
});

describe("generateTotpSecret / otpauthUri", () => {
  it("segredo de 160 bits em base32, diferente a cada chamada", () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(base32Decode(a)).toHaveLength(20);
    expect(a).not.toBe(b);
  });

  it("URI no formato que os apps autenticadores leem", () => {
    const uri = otpauthUri({ issuer: "TWS Panel", account: "admin", secret: "JBSWY3DPEHPK3PXP" });
    expect(uri).toBe(
      "otpauth://totp/TWS%20Panel:admin?secret=JBSWY3DPEHPK3PXP&issuer=TWS%20Panel&algorithm=SHA1&digits=6&period=30",
    );
  });
});

describe("verifyTotp", () => {
  const secret = RFC_SECRET;
  const now = 1111111111 * 1000;
  const step = Math.floor(1111111111 / TOTP_STEP_SECONDS);

  it("aceita o código atual e devolve o passo usado", () => {
    expect(verifyTotp(secret, totpCode(secret, step), { nowMs: now, lastStep: null })).toBe(step);
  });

  it("tolera um passo de diferença de relógio para cada lado, não dois", () => {
    expect(verifyTotp(secret, totpCode(secret, step - 1), { nowMs: now, lastStep: null })).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step + 1), { nowMs: now, lastStep: null })).toBe(step + 1);
    expect(verifyTotp(secret, totpCode(secret, step - 2), { nowMs: now, lastStep: null })).toBeNull();
  });

  it("o mesmo código (ou um mais antigo) não vale duas vezes", () => {
    expect(verifyTotp(secret, totpCode(secret, step), { nowMs: now, lastStep: step })).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, step - 1), { nowMs: now, lastStep: step })).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, step + 1), { nowMs: now, lastStep: step })).toBe(step + 1);
  });

  it("aceita espaços no meio (como os apps mostram: 123 456) e recusa lixo", () => {
    const code = totpCode(secret, step);
    expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, { nowMs: now, lastStep: null })).toBe(step);
    expect(verifyTotp(secret, "12345", { nowMs: now, lastStep: null })).toBeNull();
    expect(verifyTotp(secret, "abcdef", { nowMs: now, lastStep: null })).toBeNull();
  });
});

describe("códigos de recuperação", () => {
  it("10 códigos distintos no formato xxxxx-xxxxx, sem caracteres ambíguos", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-km-np-z2-9]{5}-[a-km-np-z2-9]{5}$/);
  });

  it("o hash ignora maiúsculas, espaços e o hífen (quem digita não erra por formato)", () => {
    const h = hashRecoveryCode("abcde-fghij");
    expect(hashRecoveryCode("ABCDE FGHIJ")).toBe(h);
    expect(hashRecoveryCode("abcdefghij")).toBe(h);
    expect(h).not.toContain("abcde");
  });
});
