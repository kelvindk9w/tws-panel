import path from "node:path";
import {
  MAIL_DEFAULT_PORTS,
  MONITOR_DEFAULT_INTERVAL_MS,
  SETUP_PORT,
  SETUP_TOKEN_FILE,
  type MailServerPorts,
} from "@paas/core";

export interface ServerConfig {
  port: number;
  host: string;
  /** Diretório de dados de runtime (setup-state.json, etc.). */
  dataDir: string;
  /** Diretório do build do frontend (SPA). */
  webDist: string;
  /** Origens extras permitidas no CORS (ex.: dev do Vite). */
  allowedOrigins: string[];
  setupTokenFile: string;
  /**
   * Alvo do hardening: "container" (padrão — container Docker descartável,
   * seguro para desenvolvimento) ou "host" (somente quando explicitamente
   * configurado via PAAS_TARGET=host).
   */
  securityTarget: "container" | "host";
  /** Nome do container alvo quando securityTarget=container. */
  securityTargetContainer: string;
  /** Diretório local dos scripts de hardening. */
  hardeningScriptsDir: string;
  /** Porta HTTP publicada do Caddy central (80 em produção; configurável em dev). */
  caddyHttpPort: number;
  /** Porta HTTPS publicada do Caddy central (443 em produção). */
  caddyHttpsPort: number;
  /** Portas publicadas do Stalwart no host (25/587/465/143/993/8080 em produção; altas em dev). */
  mailPorts: MailServerPorts;
  /** Hostname do servidor de e-mail (PAAS_MAIL_HOSTNAME ou derivado do 1º domínio). */
  mailHostname: string | null;
  /** IPv4 público da máquina para o checklist DNS (PAAS_PUBLIC_IP). */
  publicIp: string | null;
  /** IPv6 público da máquina (opcional — PAAS_PUBLIC_IPV6). */
  publicIpv6: string | null;
  /** Intervalo inicial do scan recorrente de segurança (ms). Persistido depois. */
  monitorIntervalMs: number;
}

export function loadConfig(): ServerConfig {
  return {
    port: Number(process.env.PORT ?? SETUP_PORT),
    host: process.env.HOST ?? "0.0.0.0",
    dataDir: path.resolve(process.env.PAAS_DATA_DIR ?? "../../data"),
    webDist: path.resolve(process.env.WEB_DIST ?? "../web/dist"),
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
    setupTokenFile: process.env.SETUP_TOKEN_FILE ?? SETUP_TOKEN_FILE,
    securityTarget: process.env.PAAS_TARGET === "host" ? "host" : "container",
    securityTargetContainer: process.env.PAAS_TARGET_CONTAINER ?? "paas-target-test",
    hardeningScriptsDir: path.resolve(process.env.PAAS_SCRIPTS_DIR ?? "../../scripts/hardening"),
    caddyHttpPort: Number(process.env.PAAS_CADDY_HTTP_PORT ?? 80),
    caddyHttpsPort: Number(process.env.PAAS_CADDY_HTTPS_PORT ?? 443),
    mailPorts: {
      smtp: Number(process.env.PAAS_STALWART_PORT_SMTP ?? MAIL_DEFAULT_PORTS.smtp),
      submission: Number(process.env.PAAS_STALWART_PORT_SUBMISSION ?? MAIL_DEFAULT_PORTS.submission),
      submissions: Number(process.env.PAAS_STALWART_PORT_SUBMISSIONS ?? MAIL_DEFAULT_PORTS.submissions),
      imap: Number(process.env.PAAS_STALWART_PORT_IMAP ?? MAIL_DEFAULT_PORTS.imap),
      imaps: Number(process.env.PAAS_STALWART_PORT_IMAPS ?? MAIL_DEFAULT_PORTS.imaps),
      http: Number(process.env.PAAS_STALWART_PORT_HTTP ?? MAIL_DEFAULT_PORTS.http),
    },
    mailHostname: process.env.PAAS_MAIL_HOSTNAME?.trim() || null,
    publicIp: process.env.PAAS_PUBLIC_IP?.trim() || null,
    publicIpv6: process.env.PAAS_PUBLIC_IPV6?.trim() || null,
    monitorIntervalMs: Number(process.env.PAAS_MONITOR_INTERVAL_MS ?? MONITOR_DEFAULT_INTERVAL_MS),
  };
}
