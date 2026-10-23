import { describe, expect, it } from "vitest";
import {
  API_TOKEN_DEFAULT_TTL_HOURS,
  API_TOKEN_MAX_ACTIVE,
  API_TOKEN_MAX_TTL_HOURS,
  API_TOKEN_MIN_TTL_HOURS,
  API_TOKEN_NAME_MAX_LENGTH,
  API_TOKEN_PATTERN,
  API_TOKEN_PREFIX,
  API_TOKEN_SCOPES,
  validateApiTokenName,
} from "../src/index";

describe("tokens de API (constantes e nome)", () => {
  it("padrão: 30 dias; de 1 hora a 1 ano; 20 ativos; três escopos", () => {
    expect(API_TOKEN_DEFAULT_TTL_HOURS).toBe(720);
    expect(API_TOKEN_MIN_TTL_HOURS).toBe(1);
    expect(API_TOKEN_MAX_TTL_HOURS).toBe(8760);
    expect(API_TOKEN_MAX_ACTIVE).toBe(20);
    expect([...API_TOKEN_SCOPES]).toEqual(["read", "write", "admin"]);
  });

  it("o formato exige o prefixo e 43 caracteres base64url (256 bits)", () => {
    expect(API_TOKEN_PATTERN.test(`${API_TOKEN_PREFIX}${"A".repeat(43)}`)).toBe(true);
    expect(API_TOKEN_PATTERN.test(`${API_TOKEN_PREFIX}${"A".repeat(42)}`)).toBe(false);
    expect(API_TOKEN_PATTERN.test(`${API_TOKEN_PREFIX}${"A".repeat(44)}`)).toBe(false);
    expect(API_TOKEN_PATTERN.test(`x${API_TOKEN_PREFIX}${"A".repeat(43)}`)).toBe(false);
    expect(API_TOKEN_PATTERN.test(`${API_TOKEN_PREFIX}${"+".repeat(43)}`)).toBe(false);
  });

  it("nome: letras (inclusive acentuadas), números, espaço, ponto, hífen e sublinhado; até 40; sem espaço nas pontas", () => {
    for (const ok of ["a", "Assistente Claude", "ação-1_v2.0", "x".repeat(API_TOKEN_NAME_MAX_LENGTH)]) {
      expect(validateApiTokenName(ok), ok).toBe(true);
    }
    for (const bad of ["", " a", "a ", "-a", ".a", "_a", "a/b", "a:b", "<b>", "a\nb", "x".repeat(API_TOKEN_NAME_MAX_LENGTH + 1)]) {
      expect(validateApiTokenName(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
