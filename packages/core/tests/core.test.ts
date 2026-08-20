/**
 * Testes dos contratos centrais do @paas/core: constantes e schemas que
 * sustentam o contrato entre API, frontend e packages. Mudanças aqui quebram
 * compatibilidade — os testes verificam os valores efetivos, não a sintaxe.
 */
import { describe, it, expect } from "vitest";
import {
  ALERT_SEVERITIES,
  ALERT_SOURCES,
  ALERT_STATUSES,
  DEPLOY_LOG_MAX_CHARS,
  DKIM_SELECTOR,
  HEALTH_LIMITS,
  INGEST_MODES,
  MAIL_DEFAULT_PORTS,
  MONITOR_DEFAULT_INTERVAL_MS,
  MONITOR_MIN_INTERVAL_MS,
  PAAS_CADDY_CONTAINER,
  PAAS_LABEL_MANAGED,
  PAAS_LABEL_PROJECT,
  PAAS_NETWORK,
  PAAS_STALWART_CONTAINER,
  PAAS_STALWART_VOLUME,
  PROJECT_TYPES,
  RISKY_PHASES,
  SECURITY_PHASES,
  SECURITY_ROLLBACK_WINDOW_MS,
  SECURITY_SCAN_CACHE_MS,
  SETUP_PORT,
  SETUP_TOKEN_FILE,
  SETUP_TOKEN_HEADER,
  SETUP_TOKEN_QUERY,
  SMTP_ENV_KEYS,
  LOGIN_MAX_ATTEMPTS,
  LOGIN_WINDOW_MS,
  PASSWORD_MIN_LENGTH,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  passwordStrengthErrors,
  validatePasswordStrength,
  validateUsername,
} from "../src/index.js";

describe("setup contract", () => {
  it("expõe a porta e os nomes de header/query do token de setup", () => {
    expect(SETUP_PORT).toBe(9000);
    expect(SETUP_TOKEN_HEADER).toBe("x-setup-token");
    expect(SETUP_TOKEN_QUERY).toBe("token");
    expect(SETUP_TOKEN_FILE).toBe("/etc/paas/setup-token");
  });
});

describe("health limits", () => {
  it("exige 1 GiB de RAM e 10 GiB de disco livre", () => {
    expect(HEALTH_LIMITS.minRamBytes).toBe(1024 ** 3);
    expect(HEALTH_LIMITS.minFreeDiskBytes).toBe(10 * 1024 ** 3);
  });

  it("suporta apenas Ubuntu 22.04/24.04", () => {
    expect(HEALTH_LIMITS.supportedDistroIds).toEqual(["ubuntu"]);
    expect(HEALTH_LIMITS.supportedVersionIds).toEqual(["22.04", "24.04"]);
  });
});

describe("security phases", () => {
  it("define exatamente 7 fases na ordem segura da spec (00→06)", () => {
    expect(SECURITY_PHASES.map((p) => p.id)).toEqual(["00", "01", "02", "03", "04", "05", "06"]);
    expect(SECURITY_PHASES.map((p) => p.key)).toEqual([
      "update",
      "user",
      "ssh",
      "firewall",
      "intrusion",
      "minimal",
      "audit",
    ]);
  });

  it("cada fase tem script próprio e único", () => {
    const scripts = SECURITY_PHASES.map((p) => p.script);
    expect(new Set(scripts).size).toBe(scripts.length);
    for (const script of scripts) {
      expect(script).toMatch(/^\d{2}-[a-z]+\.sh$/);
    }
  });

  it("apenas SSH (02) e firewall (03) são fases de risco com rollback", () => {
    expect(RISKY_PHASES).toEqual(["02", "03"]);
    const ids = SECURITY_PHASES.map((p) => p.id);
    for (const risky of RISKY_PHASES) expect(ids).toContain(risky);
  });

  it("janela de rollback é de 5 minutos e o cache de scan de 1 minuto", () => {
    expect(SECURITY_ROLLBACK_WINDOW_MS).toBe(5 * 60_000);
    expect(SECURITY_SCAN_CACHE_MS).toBe(60_000);
  });
});

describe("deploy contract", () => {
  it("tipos de projeto cobrem todos os pipelines suportados", () => {
    expect(PROJECT_TYPES).toEqual(["static-node", "compose", "dockerfile", "unknown"]);
  });

  it("modos de ingestão são git, upload e existing", () => {
    expect(INGEST_MODES).toEqual(["git", "upload", "existing"]);
  });

  it("nomes de rede/labels/containers seguem o prefixo paas", () => {
    expect(PAAS_NETWORK).toBe("paas-net");
    expect(PAAS_CADDY_CONTAINER).toBe("paas-caddy");
    expect(PAAS_LABEL_MANAGED).toBe("paas.managed");
    expect(PAAS_LABEL_PROJECT).toBe("paas.project");
  });

  it("limite do log de deploy é generoso mas finito", () => {
    expect(DEPLOY_LOG_MAX_CHARS).toBe(400_000);
  });
});

describe("mail contract", () => {
  it("seletor DKIM padrão e nomes dos recursos Docker", () => {
    expect(DKIM_SELECTOR).toBe("paas");
    expect(PAAS_STALWART_CONTAINER).toBe("paas-stalwart");
    expect(PAAS_STALWART_VOLUME).toBe("paas_stalwart_data");
  });

  it("portas padrão seguem as convenções de e-mail", () => {
    expect(MAIL_DEFAULT_PORTS).toEqual({
      smtp: 25,
      submission: 587,
      submissions: 465,
      imap: 143,
      imaps: 993,
      http: 8080,
    });
  });

  it("env vars SMTP injetadas nos projetos são exatamente as 5 documentadas", () => {
    expect([...SMTP_ENV_KEYS]).toEqual(["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "MAIL_FROM"]);
  });
});

describe("auth contract", () => {
  it("cookie de sessão, TTL de 12h e limites de login são os valores efetivos", () => {
    expect(SESSION_COOKIE).toBe("paas_session");
    expect(SESSION_TTL_MS).toBe(12 * 60 * 60 * 1000);
    expect(LOGIN_MAX_ATTEMPTS).toBe(5);
    expect(LOGIN_WINDOW_MS).toBe(60 * 1000);
  });

  it("senha forte válida passa em todas as checagens", () => {
    const result = validatePasswordStrength("MinhaSenha123");
    expect(result.valid).toBe(true);
    expect(result.checks).toEqual({ minLength: true, hasUpper: true, hasLower: true, hasNumber: true });
    expect(passwordStrengthErrors("MinhaSenha123")).toEqual([]);
  });

  it("cada regra violada aparece individualmente nas checagens e nas mensagens", () => {
    // curta (demais regras ok)
    const curta = validatePasswordStrength("Abc123");
    expect(curta.valid).toBe(false);
    expect(curta.checks).toEqual({ minLength: false, hasUpper: true, hasLower: true, hasNumber: true });
    expect(passwordStrengthErrors("Abc123")).toEqual([`mínimo de ${PASSWORD_MIN_LENGTH} caracteres`]);

    // sem maiúscula, sem minúscula, sem número — uma violação por vez
    expect(validatePasswordStrength("senhafraca123").checks.hasUpper).toBe(false);
    expect(passwordStrengthErrors("senhafraca123")).toContain("ao menos uma letra maiúscula");

    expect(validatePasswordStrength("SENHAFORTE123").checks.hasLower).toBe(false);
    expect(passwordStrengthErrors("SENHAFORTE123")).toContain("ao menos uma letra minúscula");

    expect(validatePasswordStrength("SenhaSemNumero").checks.hasNumber).toBe(false);
    expect(passwordStrengthErrors("SenhaSemNumero")).toContain("ao menos um número");
  });

  it("senha vazia acumula as 4 violações na ordem documentada", () => {
    expect(passwordStrengthErrors("")).toEqual([
      `mínimo de ${PASSWORD_MIN_LENGTH} caracteres`,
      "ao menos uma letra maiúscula",
      "ao menos uma letra minúscula",
      "ao menos um número",
    ]);
  });

  it("usuário: limites de tamanho e caracteres permitidos", () => {
    expect(USERNAME_MIN_LENGTH).toBe(3);
    expect(USERNAME_MAX_LENGTH).toBe(32);
    // válidos: limites exatos e charset completo
    expect(validateUsername("abc")).toBe(true);
    expect(validateUsername("a".repeat(32))).toBe(true);
    expect(validateUsername("kelvin.souza_01-x")).toBe(true);
    // inválidos: curto, longo, começa com símbolo, contém caractere proibido
    expect(validateUsername("ab")).toBe(false);
    expect(validateUsername("a".repeat(33))).toBe(false);
    expect(validateUsername(".admin")).toBe(false);
    expect(validateUsername("-admin")).toBe(false);
    expect(validateUsername("_admin")).toBe(false);
    expect(validateUsername("a b")).toBe(false);
    expect(validateUsername("admin!")).toBe(false);
    expect(validateUsername("")).toBe(false);
  });
});

describe("monitoring contract", () => {
  it("severidades, fontes e status de alerta são conjuntos fechados", () => {
    expect(ALERT_SEVERITIES).toEqual(["critical", "warning", "info"]);
    expect(ALERT_SOURCES).toEqual(["guardrail", "scan", "blacklist", "system"]);
    expect(ALERT_STATUSES).toEqual(["open", "acknowledged", "resolved"]);
  });

  it("intervalo padrão é 6h e o mínimo 10s (proteção contra loop agressivo)", () => {
    expect(MONITOR_DEFAULT_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
    expect(MONITOR_MIN_INTERVAL_MS).toBe(10_000);
    expect(MONITOR_MIN_INTERVAL_MS).toBeLessThan(MONITOR_DEFAULT_INTERVAL_MS);
  });
});
