/**
 * Testes do loadConfig (config.ts): defaults de produção e overrides via
 * variáveis de ambiente — a fonte única de configuração do servidor.
 */
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAIL_DEFAULT_PORTS, MONITOR_DEFAULT_INTERVAL_MS, SETUP_PORT, SETUP_TOKEN_FILE } from "@paas/core";
import { ConfigError, loadConfig, resolveTerminalAccess, type ServerConfig } from "../src/config.js";

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
  "PAAS_PROJECTS_DIR",
  "PAAS_CADDY_HTTP_PORT",
  "PAAS_CADDY_HTTPS_PORT",
  "PAAS_STALWART_PORT_SMTP",
  "PAAS_MAIL_HOSTNAME",
  "PAAS_PUBLIC_IP",
  "PAAS_PUBLIC_IPV6",
  "PAAS_MONITOR_INTERVAL_MS",
  "PAAS_TERMINAL_USER",
  "PAAS_ROOT_MODE",
  "PAAS_TERMINAL_SUDO_PASSWORD_TIMEOUT_MS",
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

function unsetEnv(key: (typeof KEYS)[number]): void {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  delete process.env[key];
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

  it("sem PAAS_PROJECTS_DIR, os projetos ficam onde sempre ficaram (<dataDir>/projects)", () => {
    // Teste de compatibilidade: uma instalação antiga que só rodou `git pull`
    // não tem a variável no .env e precisa continuar achando os projetos que
    // já clonou. Mudar este default silenciosamente some com eles.
    setEnv("PAAS_DATA_DIR", "/data");
    const config = loadConfig();
    expect(config.projectsDir).toBe(path.join("/data", "projects"));
    expect(config.projectsDir).toBe(path.join(config.dataDir, "projects"));
  });

  it("com PAAS_PROJECTS_DIR, o diretório dos projetos é o valor da variável", () => {
    setEnv("PAAS_DATA_DIR", "/data");
    setEnv("PAAS_PROJECTS_DIR", "/opt/tws-projects");
    expect(loadConfig().projectsDir).toBe("/opt/tws-projects");
  });

  /**
   * O default de 5 min de espera silenciosa pela senha do sudo foi um defeito
   * de produto em produção (duas varreduras perdidas): o padrão agora é 2 min
   * e o operador pode ajustar pelo .env como faz com o idle do terminal.
   */
  it("espera pela senha do sudo: 2 min por padrão, ajustável pela variável", () => {
    expect(loadConfig().terminalSudoPasswordTimeoutMs).toBe(120_000);
    setEnv("PAAS_TERMINAL_SUDO_PASSWORD_TIMEOUT_MS", "45000");
    expect(loadConfig().terminalSudoPasswordTimeoutMs).toBe(45_000);
  });

  it("PAAS_TARGET só vira 'host' com o valor exato (default seguro)", () => {
    setEnv("PAAS_TARGET", "HOST");
    expect(loadConfig().securityTarget).toBe("container");
    setEnv("PAAS_TARGET", "host");
    expect(loadConfig().securityTarget).toBe("host");
  });
});

describe("usuário do terminal e modo de root (PAAS_TERMINAL_USER / PAAS_ROOT_MODE)", () => {
  it("sem PAAS_TERMINAL_USER: comportamento legado (terminal root, execução nele)", () => {
    // Compatibilidade: uma instalação que só rodou `git pull` não tem a
    // variável no .env e NÃO pode mudar de comportamento em silêncio.
    unsetEnv("PAAS_TERMINAL_USER");
    unsetEnv("PAAS_ROOT_MODE");
    const config = loadConfig();
    expect(config.terminalUser).toBeNull();
    expect(config.terminalRootMode).toBeNull();
  });

  it("PAAS_TERMINAL_USER vazio (compose com ${VAR:-}) também é legado", () => {
    setEnv("PAAS_TERMINAL_USER", "");
    unsetEnv("PAAS_ROOT_MODE");
    expect(loadConfig().terminalUser).toBeNull();
  });

  it("usuário comum + modo senha", () => {
    setEnv("PAAS_TERMINAL_USER", "kelvin");
    setEnv("PAAS_ROOT_MODE", "senha");
    const config = loadConfig();
    expect(config.terminalUser).toBe("kelvin");
    expect(config.terminalRootMode).toBe("senha");
  });

  it("usuário comum + modo segundo-plano", () => {
    setEnv("PAAS_TERMINAL_USER", "deploy_1");
    setEnv("PAAS_ROOT_MODE", "segundo-plano");
    const config = loadConfig();
    expect(config.terminalUser).toBe("deploy_1");
    expect(config.terminalRootMode).toBe("segundo-plano");
  });

  it("root explícito é aceito e o modo não se aplica", () => {
    setEnv("PAAS_TERMINAL_USER", "root");
    unsetEnv("PAAS_ROOT_MODE");
    const config = loadConfig();
    expect(config.terminalUser).toBe("root");
    expect(config.terminalRootMode).toBeNull();
    setEnv("PAAS_ROOT_MODE", "senha");
    expect(loadConfig().terminalRootMode).toBeNull();
  });

  it("usuário comum SEM modo falha a inicialização em vez de adivinhar", () => {
    setEnv("PAAS_TERMINAL_USER", "kelvin");
    unsetEnv("PAAS_ROOT_MODE");
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/PAAS_ROOT_MODE.*senha.*segundo-plano/);
  });

  it.each(["Kelvin", "1abc", "ke lvin", "kelvin;rm -rf /", "-kelvin", "a".repeat(40), "kelvin\r"])(
    "PAAS_TERMINAL_USER inválido (%j) é rejeitado com mensagem clara",
    (valor) => {
      setEnv("PAAS_TERMINAL_USER", valor);
      setEnv("PAAS_ROOT_MODE", "senha");
      expect(() => loadConfig()).toThrow(ConfigError);
      expect(() => loadConfig()).toThrow(/PAAS_TERMINAL_USER/);
    },
  );

  it.each(["SENHA", "sudo", "segundo_plano", "background"])("PAAS_ROOT_MODE inválido (%j) é rejeitado", (valor) => {
    setEnv("PAAS_TERMINAL_USER", "kelvin");
    setEnv("PAAS_ROOT_MODE", valor);
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(/PAAS_ROOT_MODE/);
  });

  it("PAAS_ROOT_MODE inválido é rejeitado mesmo sem usuário (erro de digitação não passa)", () => {
    unsetEnv("PAAS_TERMINAL_USER");
    setEnv("PAAS_ROOT_MODE", "senhaa");
    expect(() => loadConfig()).toThrow(/PAAS_ROOT_MODE/);
  });
});

describe("resolveTerminalAccess", () => {
  const base = { securityTarget: "host", terminalUser: null, terminalRootMode: null } as const;
  const resolve = (over: Partial<Pick<ServerConfig, "securityTarget" | "terminalUser" | "terminalRootMode">>) =>
    resolveTerminalAccess({ ...base, ...over });

  it("legado no host: root, elevation root-legado", () => {
    expect(resolve({})).toEqual({
      target: "host",
      user: "root",
      configuredUser: null,
      rootMode: null,
      elevation: "root-legado",
      scheduledMonitoringRunsAsRoot: true,
    });
  });

  it("root explícito", () => {
    expect(resolve({ terminalUser: "root" })).toMatchObject({ user: "root", configuredUser: "root", elevation: "root" });
  });

  it("usuário comum sem modo nunca vira root por omissão", () => {
    expect(() => resolve({ terminalUser: "kelvin" })).toThrow(ConfigError);
  });

  it("senha e segundo-plano no host", () => {
    expect(resolve({ terminalUser: "kelvin", terminalRootMode: "senha" })).toMatchObject({
      user: "kelvin",
      rootMode: "senha",
      elevation: "senha",
    });
    expect(resolve({ terminalUser: "kelvin", terminalRootMode: "segundo-plano" })).toMatchObject({
      user: "kelvin",
      rootMode: "segundo-plano",
      elevation: "segundo-plano",
    });
  });

  it("alvo container (dev): usuário/modo não se aplicam, mas o valor configurado é informado", () => {
    expect(resolve({ securityTarget: "container", terminalUser: "kelvin", terminalRootMode: "senha" })).toEqual({
      target: "container",
      user: "root",
      configuredUser: "kelvin",
      rootMode: null,
      elevation: "container-dev",
      scheduledMonitoringRunsAsRoot: true,
    });
  });
});
