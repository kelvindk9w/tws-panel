/**
 * Testes do loadConfig (config.ts): defaults de produção e overrides via
 * variáveis de ambiente — a fonte única de configuração do servidor.
 */
import { afterEach, describe, expect, it } from "vitest";
import { MAIL_DEFAULT_PORTS, MONITOR_DEFAULT_INTERVAL_MS, SETUP_PORT, SETUP_TOKEN_FILE } from "@paas/core";
import { loadConfig } from "../src/config.js";

const KEYS = [
  "PORT",
  "HOST",
  "PAAS_DATA_DIR",
  "WEB_DIST",
  "ALLOWED_ORIGINS",
  "SETUP_TOKEN_FILE",
  "PAAS_TARGET",
  "PAAS_TARGET_CONTAINER",
  "PAAS_SCRIPTS_DIR",
  "PAAS_HOST_HELPER_IMAGE",
  "PAAS_HOST_REPO_DIR",
  "PAAS_CADDY_HTTP_PORT",
  "PAAS_CADDY_HTTPS_PORT",
  "PAAS_STALWART_PORT_SMTP",
  "PAAS_MAIL_HOSTNAME",
  "PAAS_PUBLIC_IP",
  "PAAS_PUBLIC_IPV6",
  "PAAS_MONITOR_INTERVAL_MS",
] as const;

const saved = new Map<string, string | undefined>();

afterEach(() => {
  for (const key of KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

function setEnv(key: (typeof KEYS)[number], value: string): void {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  process.env[key] = value;
}

describe("loadConfig", () => {
  it("defaults: porta do setup, alvo container e portas de e-mail documentadas", () => {
    const config = loadConfig();
    expect(config.port).toBe(SETUP_PORT);
    expect(config.host).toBe("0.0.0.0");
    expect(config.securityTarget).toBe("container");
    expect(config.securityTargetContainer).toBe("paas-target-test");
    expect(config.setupTokenFile).toBe(SETUP_TOKEN_FILE);
    expect(config.mailPorts).toEqual(MAIL_DEFAULT_PORTS);
    expect(config.caddyHttpPort).toBe(80);
    expect(config.caddyHttpsPort).toBe(443);
    expect(config.monitorIntervalMs).toBe(MONITOR_DEFAULT_INTERVAL_MS);
    expect(config.mailHostname).toBeNull();
    expect(config.publicIp).toBeNull();
    expect(config.publicIpv6).toBeNull();
    expect(config.allowedOrigins).toEqual([]);
  });

  it("overrides de ambiente são aplicados e convertidos", () => {
    setEnv("PORT", "9999");
    setEnv("PAAS_TARGET", "host");
    setEnv("ALLOWED_ORIGINS", "http://localhost:5173, https://painel.exemplo.com ,,");
    setEnv("PAAS_STALWART_PORT_SMTP", "10025");
    setEnv("PAAS_MONITOR_INTERVAL_MS", "30000");
    const config = loadConfig();
    expect(config.port).toBe(9999);
    expect(config.securityTarget).toBe("host");
    expect(config.allowedOrigins).toEqual(["http://localhost:5173", "https://painel.exemplo.com"]);
    expect(config.mailPorts.smtp).toBe(10025);
    expect(config.monitorIntervalMs).toBe(30_000);
  });

  it("hostname/IPs com espaços são aparados; vazios viram null", () => {
    setEnv("PAAS_MAIL_HOSTNAME", "  mail.exemplo.com  ");
    setEnv("PAAS_PUBLIC_IP", "203.0.113.10");
    setEnv("PAAS_PUBLIC_IPV6", "   ");
    const config = loadConfig();
    expect(config.mailHostname).toBe("mail.exemplo.com");
    expect(config.publicIp).toBe("203.0.113.10");
    expect(config.publicIpv6).toBeNull();
  });

  it("PAAS_TARGET só vira 'host' com o valor exato (default seguro)", () => {
    setEnv("PAAS_TARGET", "HOST");
    expect(loadConfig().securityTarget).toBe("container");
    setEnv("PAAS_TARGET", "host");
    expect(loadConfig().securityTarget).toBe("host");
  });
});
