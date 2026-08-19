/**
 * server.ts — ciclo de vida do Stalwart Mail Server em container Docker.
 *
 * Mesmo padrão do Caddy central (packages/deploy/src/caddy.ts): container
 * dedicado na rede paas-net, volume persistente, labels do painel.
 *
 * NOTA DE VERSÃO: a imagem é `stalwartlabs/mail-server` (linha v0.11.x), a
 * última com API REST de gerenciamento (/api/principal, /api/dkim) e bootstrap
 * determinístico via config.toml montado. A linha nova (`stalwartlabs/stalwart`
 * v0.16+) removeu a API REST em favor de JMAP `x:` e exige um wizard de setup
 * interativo (config.json) — migração fica como roadmap (ver docs/fase-3-email.md).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PAAS_LABEL_MANAGED,
  PAAS_NETWORK,
  PAAS_STALWART_CONTAINER,
  PAAS_STALWART_VOLUME,
  type MailServerPorts,
  type MailServerStatus,
} from "@paas/core";
import { run } from "./exec.js";

export const STALWART_IMAGE = "stalwartlabs/mail-server:v0.11.8";

export interface StalwartManagerOptions {
  /** Diretório data/mail/stalwart (config.toml renderizado aqui). */
  configDir: string;
  /** Hostname do servidor (ex.: mail.exemplo.com) — vai no HELO/banner. */
  hostname: string;
  /** Secret do fallback-admin (gerado e persistido pelo MailService). */
  adminSecret: string;
  ports: MailServerPorts;
  image?: string;
  containerName?: string;
}

export class StalwartManager {
  readonly image: string;
  readonly containerName: string;

  constructor(private readonly opts: StalwartManagerOptions) {
    this.image = opts.image ?? STALWART_IMAGE;
    this.containerName = opts.containerName ?? PAAS_STALWART_CONTAINER;
  }

  /** Garante a rede dedicada do painel (idempotente). */
  private async ensureNetwork(): Promise<void> {
    const inspect = await run("docker", ["network", "inspect", PAAS_NETWORK]);
    if (inspect.code === 0) return;
    const create = await run("docker", [
      "network",
      "create",
      "--label",
      `${PAAS_LABEL_MANAGED}=true`,
      PAAS_NETWORK,
    ]);
    if (create.code !== 0) throw new Error(`falha ao criar a rede ${PAAS_NETWORK}: ${create.stderr}`);
  }

  /** Renderiza o config.toml do Stalwart (idempotente, sobrescreve). */
  async writeConfig(): Promise<string> {
    await mkdir(this.opts.configDir, { recursive: true });
    const file = path.join(this.opts.configDir, "config.toml");
    await writeFile(file, renderConfigToml(this.opts.hostname, this.opts.adminSecret), {
      encoding: "utf8",
      mode: 0o600,
    });
    return file;
  }

  async status(): Promise<MailServerStatus> {
    const inspect = await run("docker", [
      "inspect",
      "-f",
      "{{.State.Running}}|{{.Config.Image}}",
      this.containerName,
    ]);
    const installed = inspect.code === 0;
    const running = installed && inspect.stdout.split("|")[0]?.trim() === "true";

    let version: string | null = null;
    if (running) {
      // O binário é `stalwart-mail` na imagem mail-server e `stalwart` na nova.
      for (const bin of ["stalwart-mail", "stalwart"]) {
        const v = await run("docker", ["exec", this.containerName, bin, "--version"], {
          timeoutMs: 15_000,
        });
        if (v.code === 0 && v.stdout.trim()) {
          version = /v?([0-9]+\.[0-9.]+)/.exec(v.stdout.trim())?.[1] ?? v.stdout.trim();
          break;
        }
      }
    }

    return {
      installed,
      running,
      version,
      image: this.image,
      containerName: this.containerName,
      hostname: this.opts.hostname,
      ports: this.opts.ports,
      message: running
        ? null
        : installed
          ? "Servidor de e-mail parado. Inicie para provisionar domínios e caixas."
          : "Servidor de e-mail ainda não foi criado. Clique em iniciar para provisionar o container.",
    };
  }

  /** Sobe (ou garante) o container do Stalwart com config renderizada. */
  async start(): Promise<void> {
    await this.ensureNetwork();
    await this.writeConfig();

    const inspect = await run("docker", ["inspect", this.containerName]);
    if (inspect.code === 0) {
      const start = await run("docker", ["start", this.containerName]);
      if (start.code !== 0 && !/already in use/i.test(start.stderr)) {
        // Container existe mas pode estar com config/versão antiga: recria.
        await run("docker", ["rm", "-f", this.containerName]);
      } else {
        return;
      }
    }

    const { ports } = this.opts;
    const etcDir = this.opts.configDir;
    const create = await run("docker", [
      "run",
      "-d",
      "--name",
      this.containerName,
      "--restart",
      "unless-stopped",
      "--network",
      PAAS_NETWORK,
      "--network-alias",
      "paas-stalwart",
      "-p",
      `${ports.smtp}:25`,
      "-p",
      `${ports.submission}:587`,
      "-p",
      `${ports.submissions}:465`,
      "-p",
      `${ports.imap}:143`,
      "-p",
      `${ports.imaps}:993`,
      "-p",
      `${ports.http}:8080`,
      "-v",
      `${PAAS_STALWART_VOLUME}:/opt/stalwart-mail/data`,
      "-v",
      `${etcDir}:/opt/stalwart-mail/etc:ro`,
      "--label",
      `${PAAS_LABEL_MANAGED}=true`,
      "--label",
      "paas.role=stalwart",
      this.image,
    ]);
    if (create.code !== 0) {
      throw new Error(`falha ao criar ${this.containerName}: ${create.stderr}`);
    }
  }

  async stop(): Promise<void> {
    const stop = await run("docker", ["stop", this.containerName], { timeoutMs: 60_000 });
    if (stop.code !== 0 && !/no such container/i.test(stop.stderr)) {
      throw new Error(`falha ao parar ${this.containerName}: ${stop.stderr}`);
    }
  }

  /** Espera a API HTTP do Stalwart responder (pós-start). */
  async waitReady(httpPort: number, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = "sem resposta";
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${httpPort}/api/principal?limit=1`, {
          signal: AbortSignal.timeout(3_000),
        });
        // 401 = API no ar aguardando auth; 200 = ok
        if (res.status === 200 || res.status === 401) return;
        lastError = `HTTP ${res.status}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      await new Promise((r) => setTimeout(r, 1_500));
    }
    throw new Error(`Stalwart não respondeu na porta ${httpPort} após ${Math.round(timeoutMs / 1000)}s (${lastError}).`);
  }
}

/** Config TOML mínimo e determinístico (bootstrap sem wizard). */
export function renderConfigToml(hostname: string, adminSecret: string): string {
  return [
    "# Gerado pelo painel PaaS — não editar manualmente.",
    `server.hostname = "${hostname}"`,
    "",
    "[server.listener.smtp]",
    'bind = ["[::]:25"]',
    'protocol = "smtp"',
    "",
    "[server.listener.submission]",
    'bind = ["[::]:587"]',
    'protocol = "smtp"',
    "",
    "[server.listener.submissions]",
    'bind = ["[::]:465"]',
    'protocol = "smtp"',
    "tls.implicit = true",
    "",
    "[server.listener.imap]",
    'bind = ["[::]:143"]',
    'protocol = "imap"',
    "",
    "[server.listener.imaptls]",
    'bind = ["[::]:993"]',
    'protocol = "imap"',
    "tls.implicit = true",
    "",
    "[server.listener.http]",
    'bind = ["[::]:8080"]',
    'protocol = "http"',
    "",
    "# Sem seção [certificate.*]: o Stalwart gera um certificado autoassinado",
    "# automaticamente (dev). Em produção, configurar ACME ou certificado real.",
    "",
    "[authentication.fallback-admin]",
    'user = "admin"',
    `secret = "${adminSecret}"`,
    "",
    "[storage]",
    'data = "rocksdb"',
    'fts = "rocksdb"',
    'blob = "rocksdb"',
    'lookup = "rocksdb"',
    'directory = "internal"',
    "",
    "[directory.internal]",
    'type = "internal"',
    'store = "rocksdb"',
    "",
    "[store.rocksdb]",
    'type = "rocksdb"',
    'path = "/opt/stalwart-mail/data"',
    'compression = "lz4"',
    "",
    "[tracer.stdout]",
    'type = "stdout"',
    'level = "info"',
    "ansi = false",
    "enable = true",
    "",
  ].join("\n");
}
