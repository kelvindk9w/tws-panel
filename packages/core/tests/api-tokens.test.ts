import { describe, expect, it } from "vitest";
import {
  API_TOKEN_DEFAULT_TTL_HOURS,
  API_TOKEN_MAX_ACTIVE,
  API_TOKEN_MAX_TTL_HOURS,
  API_TOKEN_MIN_TTL_HOURS,
  API_TOKEN_NAME_MAX_LENGTH,
  API_TOKEN_PATTERN,
  API_TOKEN_PREFIX,
  API_TOKEN_NEVER_EXPIRES_AT,
  API_TOKEN_SCOPES,
  API_TOKEN_TTL_CHOICES_DAYS,
  MCP_APPROVAL_MAX,
  MCP_APPROVAL_MAX_PER_TOKEN,
  MCP_SESSIONS_MAX_PER_TOKEN,
  MCP_APPROVAL_TTL_MS,
  MCP_PATH,
  MCP_PROTOCOL_VERSIONS,
  MCP_SETUP_LEVELS,
  MCP_TOKEN_OPTION_KEYS,
  defaultMcpOptions,
  isNeverExpiresAt,
  normalizeMcpOptions,
  validateApiTokenName,
  widenedMcpOptions,
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

describe("validade escolhida na tela e ilimitado", () => {
  it("as escolhas são 1, 7, 15, 30, 90, 180 e 365 dias, e todas cabem no teto de horas finitas", () => {
    expect([...API_TOKEN_TTL_CHOICES_DAYS]).toEqual([1, 7, 15, 30, 90, 180, 365]);
    for (const days of API_TOKEN_TTL_CHOICES_DAYS) expect(days * 24).toBeLessThanOrEqual(API_TOKEN_MAX_TTL_HOURS);
    expect(API_TOKEN_TTL_CHOICES_DAYS).toContain(API_TOKEN_DEFAULT_TTL_HOURS / 24);
  });

  it("ilimitado tem uma data fixa e só ela conta como ilimitada", () => {
    expect(isNeverExpiresAt(API_TOKEN_NEVER_EXPIRES_AT)).toBe(true);
    expect(isNeverExpiresAt("2030-01-01T00:00:00.000Z")).toBe(false);
    expect(Number.isFinite(Date.parse(API_TOKEN_NEVER_EXPIRES_AT))).toBe(true);
  });
});

describe("opções do MCP por token", () => {
  it("tudo desligado por padrão", () => {
    expect(defaultMcpOptions()).toEqual({ securityApply: false, secretsRead: false, skipApproval: false, metrics: false });
    expect([...MCP_TOKEN_OPTION_KEYS]).toEqual(["securityApply", "secretsRead", "skipApproval", "metrics"]);
  });

  it("só `true` de verdade liga; lixo, texto e ausência ficam desligados", () => {
    expect(normalizeMcpOptions(undefined)).toEqual(defaultMcpOptions());
    expect(normalizeMcpOptions(null)).toEqual(defaultMcpOptions());
    expect(normalizeMcpOptions("sim")).toEqual(defaultMcpOptions());
    expect(normalizeMcpOptions({ securityApply: "true", secretsRead: 1, skipApproval: false, metrics: true })).toEqual({
      securityApply: false,
      secretsRead: false,
      skipApproval: false,
      metrics: true,
    });
  });

  it("widenedMcpOptions lista só o que foi ligado agora", () => {
    const before = { ...defaultMcpOptions(), metrics: true };
    expect(widenedMcpOptions(before, { ...before, secretsRead: true, metrics: false })).toEqual(["secretsRead"]);
    expect(widenedMcpOptions(before, defaultMcpOptions())).toEqual([]);
  });

  it("constantes do protocolo", () => {
    expect(MCP_PATH).toBe("/mcp");
    expect(MCP_PROTOCOL_VERSIONS[0]).toBe("2025-06-18");
    expect(MCP_APPROVAL_TTL_MS).toBe(600_000);
    expect(MCP_APPROVAL_MAX).toBeGreaterThan(0);
    expect(MCP_APPROVAL_MAX_PER_TOKEN).toBeGreaterThan(0);
    expect(MCP_APPROVAL_MAX_PER_TOKEN).toBeLessThan(MCP_APPROVAL_MAX);
    expect(MCP_SESSIONS_MAX_PER_TOKEN).toBeGreaterThan(0);
    expect([...MCP_SETUP_LEVELS]).toEqual(["read", "write", "admin"]);
  });
});
