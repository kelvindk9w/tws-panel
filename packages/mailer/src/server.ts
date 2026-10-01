/**
 * server.ts — ciclo de vida do Stalwart Mail Server em container Docker.
 *
 * Mesmo padrão do Caddy central (packages/deploy/src/caddy.ts): container
 * dedicado na rede paas-net, volume persistente, labels do painel.
 *
 * NOTA DE VERSÃO: a imagem é `stalwartlabs/mail-server` (linha v0.11.x), a
 * última com API REST de gerenciamento (/api/principal, /api/dkim) e bootstrap
 * determinístico via config.toml (entregue ao container com `docker cp`). A linha nova (`stalwartlabs/stalwart`
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
import {
  copyFilesToContainer,
  hasLegacyConfigBind,
  INSPECT_RUNNING_AND_MOUNTS,
  parseContainerInspect,
} from "./container-files.js";
import { run } from "./exec.js";
import { certificateId, type MailCertificate } from "./tls-certificates.js";

export const STALWART_IMAGE = "stalwartlabs/mail-server:v0.11.8";

/**
 * Raiz do Stalwart na imagem (VOLUME anônimo da imagem; `data` recebe o
 * volume nomeado). Por isso a remoção usa `rm -f -v`: descarta só o volume
 * anônimo (que guarda apenas etc/, regravado a cada start), nunca o nomeado.
 */
export const STALWART_BASE_DIR = "/opt/stalwart-mail";
/** Diretório lido pelo entrypoint da imagem (`--config etc/config.toml`). */
export const STALWART_ETC_DIR = `${STALWART_BASE_DIR}/etc`;
/** Certificados copiados do Caddy (ver tls-certificates.ts). */
export const STALWART_CERTS_DIR = `${STALWART_ETC_DIR}/certs`;

/** Par certificado + chave entregue ao Stalwart. */
export type StalwartCertificate = Pick<MailCertificate, "host" | "cert" | "key">;

export interface StalwartManagerOptions {
  /**
   * Diretório data/mail/stalwart: espelho local do config.toml, só para
   * inspeção. O Stalwart NUNCA lê daqui — o arquivo é entregue ao container
   * pelo daemon (`docker cp`), sem bind mount (ver start()).
   */
  configDir: string;
  /** Hostname do servidor (ex.: mail.exemplo.com) — vai no HELO/banner. */
  hostname: string;
  /** Secret do fallback-admin (gerado e persistido pelo MailService). */
  adminSecret: string;
  ports: MailServerPorts;
  image?: string;
  containerName?: string;
  /** Rede Docker (padrão paas-net). */
  network?: string;
  /** Volume nomeado dos dados (padrão paas_stalwart_data). */
  dataVolume?: string;
  /**
   * Nomes extras do container na rede (mail.<domínio>): o projeto conecta
   * pelo nome do certificado e a conexão fica dentro da rede Docker.
   */
  aliases?: string[];
  /** Certificados emitidos pelo Caddy para os mail.<domínio> (ausente = autoassinado). */
  certificates?: StalwartCertificate[];
  /**
   * Onde a API HTTP do Stalwart responde. Padrão: 127.0.0.1:<porta http>
   * (painel fora de container). Com o painel em container, 127.0.0.1 é o
   * próprio painel — o MailService passa http://paas-stalwart:8080.
   */
  apiBaseUrl?: string;
}

export class StalwartManager {
  readonly image: string;
  readonly containerName: string;
  private readonly network: string;

  constructor(private readonly opts: StalwartManagerOptions) {
    this.image = opts.image ?? STALWART_IMAGE;
    this.containerName = opts.containerName ?? PAAS_STALWART_CONTAINER;
    this.network = opts.network ?? PAAS_NETWORK;
  }

  /** Garante a rede dedicada do painel (idempotente). */
  private async ensureNetwork(): Promise<void> {
    const inspect = await run("docker", ["network", "inspect", this.network]);
    if (inspect.code === 0) return;
    const create = await run("docker", [
      "network",
      "create",
      "--label",
      `${PAAS_LABEL_MANAGED}=true`,
      this.network,
    ]);
    if (create.code !== 0) throw new Error(`falha ao criar a rede ${this.network}: ${create.stderr}`);
  }

  /** Renderiza o config.toml do Stalwart (idempotente, sobrescreve). */
  async writeConfig(): Promise<string> {
    await mkdir(this.opts.configDir, { recursive: true });
    const file = path.join(this.opts.configDir, "config.toml");
    await writeFile(file, this.renderConfig(), {
      encoding: "utf8",
      mode: 0o600,
    });
    return file;
  }

  private certificates(): StalwartCertificate[] {
    return this.opts.certificates ?? [];
  }

  private renderConfig(): string {
    return renderConfigToml(
      this.opts.hostname,
      this.opts.adminSecret,
      this.certificates().map((c) => c.host),
    );
  }

  /** Base da API HTTP do Stalwart (ver StalwartManagerOptions.apiBaseUrl). */
  apiBaseUrl(): string {
    return this.opts.apiBaseUrl ?? `http://127.0.0.1:${this.opts.ports.http}`;
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

  /**
   * Entrega o config.toml (e os certificados) ao container, parado ou
   * rodando, pelo daemon. A chave privada só existe aqui e dentro do
   * container (0600) — nunca no espelho local do config.
   */
  private async pushConfig(): Promise<void> {
    const certs = this.certificates();
    const cp = await copyFilesToContainer(this.containerName, STALWART_BASE_DIR, [
      { name: "etc/", mode: 0o755 },
      { name: "etc/config.toml", content: this.renderConfig(), mode: 0o600 },
      ...(certs.length > 0 ? [{ name: "etc/certs/", mode: 0o700 }] : []),
      ...certs.flatMap((c) => [
        { name: `etc/certs/${certificateId(c.host)}.crt`, content: c.cert, mode: 0o600 },
        { name: `etc/certs/${certificateId(c.host)}.key`, content: c.key, mode: 0o600 },
      ]),
    ]);
    if (cp.code !== 0) {
      throw new Error(`falha ao gravar a configuração em ${this.containerName}: ${cp.stderr.trim()}`);
    }
  }

  /**
   * Sobe (ou garante) o container do Stalwart com config renderizada.
   *
   * A configuração vai para dentro do container via `docker cp` antes do
   * start. Antes ela era um bind mount de `configDir`, caminho que só existe
   * onde o painel roda: com o painel em container (produção), o daemon do
   * host montava um diretório vazio e o entrypoint da imagem caía no
   * `--init` com configuração padrão. Um container existente com essa
   * montagem antiga é removido e recriado (os dados ficam no volume nomeado).
   */
  async start(): Promise<void> {
    await this.ensureNetwork();
    await this.writeConfig();

    const inspect = await run("docker", ["inspect", "-f", INSPECT_RUNNING_AND_MOUNTS, this.containerName]);
    if (inspect.code === 0) {
      const { running, mounts } = parseContainerInspect(inspect.stdout);
      if (hasLegacyConfigBind(mounts, STALWART_ETC_DIR)) {
        await run("docker", ["rm", "-f", "-v", this.containerName]);
      } else {
        // Rodando: o arquivo novo vale a partir do próximo restart (como antes).
        await this.pushConfig();
        await this.ensureAliases();
        if (running) return;
        const start = await run("docker", ["start", this.containerName]);
        if (start.code === 0 || /already in use/i.test(start.stderr)) return;
        // Container existe mas pode estar com config/versão antiga: recria.
        await run("docker", ["rm", "-f", "-v", this.containerName]);
      }
    }

    const { ports } = this.opts;
    const create = await run("docker", [
      "create",
      "--name",
      this.containerName,
      "--restart",
      "unless-stopped",
      "--network",
      this.network,
      ...this.allAliases().flatMap((a) => ["--network-alias", a]),
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
      `${this.opts.dataVolume ?? PAAS_STALWART_VOLUME}:${STALWART_BASE_DIR}/data`,
      "--label",
      `${PAAS_LABEL_MANAGED}=true`,
      "--label",
      "paas.role=stalwart",
      this.image,
    ]);
    if (create.code !== 0) {
      throw new Error(`falha ao criar ${this.containerName}: ${create.stderr}`);
    }
    await this.pushConfig();
    const start = await run("docker", ["start", this.containerName]);
    if (start.code !== 0) {
      throw new Error(`falha ao iniciar ${this.containerName}: ${start.stderr}`);
    }
  }

  private allAliases(): string[] {
    return [...new Set(["paas-stalwart", ...(this.opts.aliases ?? [])])];
  }

  /**
   * Garante os aliases mail.<domínio> num container que já existe (criado
   * antes deles, ou antes de um domínio novo). O Docker não acrescenta alias
   * a uma conexão existente: desconecta e reconecta com a lista completa
   * (segundos sem rede interna; as portas publicadas no host não caem).
   */
  private async ensureAliases(): Promise<void> {
    const wanted = this.allAliases();
    if (wanted.length === 1) return;
    const inspect = await run("docker", ["inspect", "-f", "{{json .NetworkSettings.Networks}}", this.containerName]);
    let current: string[] | null = null;
    try {
      const networks = JSON.parse(inspect.stdout.trim() || "{}") as Record<string, { Aliases?: string[] | null }>;
      const net = networks[this.network];
      current = net ? (net.Aliases ?? []) : null;
    } catch {
      current = null;
    }
    if (current && wanted.every((a) => current.includes(a))) return;
    if (current) await run("docker", ["network", "disconnect", this.network, this.containerName]);
    const connect = await run("docker", [
      "network",
      "connect",
      ...wanted.flatMap((a) => ["--alias", a]),
      this.network,
      this.containerName,
    ]);
    if (connect.code !== 0) {
      throw new Error(
        `falha ao conectar ${this.containerName} à rede ${this.network} com os aliases: ${connect.stderr.trim()}`,
      );
    }
  }

  /**
   * Liga outro container (o do painel) à rede do Stalwart — de dentro dele é
   * por ela que a API e o TLS do servidor de e-mail são alcançados.
   */
  async connectContainer(container: string): Promise<void> {
    const inspect = await run("docker", ["inspect", "-f", "{{json .NetworkSettings.Networks}}", container]);
    if (inspect.code === 0) {
      try {
        const networks = JSON.parse(inspect.stdout.trim() || "{}") as Record<string, unknown>;
        if (Object.prototype.hasOwnProperty.call(networks, this.network)) return;
      } catch {
        // saída inesperada: tenta conectar
      }
    }
    const connect = await run("docker", ["network", "connect", this.network, container]);
    if (connect.code !== 0) {
      throw new Error(`falha ao conectar ${container} à rede ${this.network}: ${connect.stderr.trim()}`);
    }
  }

  /**
   * Instala os certificados atuais no container que está rodando.
   *
   * Comportamento conferido no Stalwart v0.11.8 real (01/10/2026):
   *  - `GET /api/reload/certificate` relê os ARQUIVOS das seções que já
   *    existiam (o `%{file:...}%` é avaliado de novo): troca o certificado
   *    renovado sem derrubar conexão nenhuma;
   *  - nem ele nem `GET /api/reload` releem o config.toml local: uma seção
   *    [certificate.*] nova (primeiro certificado de um domínio) ou outro
   *    `server.hostname` só valem depois de reiniciar o container.
   * `restart: true` cobre o segundo caso; no primeiro, se a API falhar, o
   * container é reiniciado do mesmo jeito (o certificado novo precisa valer).
   */
  async applyTls(opts: { restart: boolean }): Promise<"reloaded" | "restarted"> {
    await this.pushConfig();
    await this.ensureAliases();
    if (!opts.restart && (await this.reloadCertificates())) return "reloaded";
    const restart = await run("docker", ["restart", this.containerName], { timeoutMs: 60_000 });
    if (restart.code !== 0) {
      throw new Error(`falha ao reiniciar ${this.containerName}: ${restart.stderr.trim()}`);
    }
    return "restarted";
  }

  private async reloadCertificates(): Promise<boolean> {
    try {
      const auth = Buffer.from(`admin:${this.opts.adminSecret}`).toString("base64");
      const res = await fetch(`${this.apiBaseUrl()}/api/reload/certificate`, {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    const stop = await run("docker", ["stop", this.containerName], { timeoutMs: 60_000 });
    if (stop.code !== 0 && !/no such container/i.test(stop.stderr)) {
      throw new Error(`falha ao parar ${this.containerName}: ${stop.stderr}`);
    }
  }

  /** Espera a API HTTP do Stalwart responder (pós-start). */
  async waitReady(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = "sem resposta";
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.apiBaseUrl()}/api/principal?limit=1`, {
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
    throw new Error(`Stalwart não respondeu em ${this.apiBaseUrl()} após ${Math.round(timeoutMs / 1000)}s (${lastError}).`);
  }
}

/**
 * Seções [certificate.<id>] lidas de arquivo (sintaxe `%{file:...}%`,
 * conferida no Stalwart v0.11.8 real). O Stalwart escolhe o certificado pelo
 * nome pedido na conexão (SNI), a partir dos nomes do próprio certificado; o
 * marcado `default` atende quem não manda SNI — o do hostname do servidor.
 */
function certificateSections(hostname: string, hosts: string[]): string[] {
  if (hosts.length === 0) {
    return [
      "# Sem certificado emitido ainda: o Stalwart gera um autoassinado. O painel",
      "# instala o certificado de mail.<domínio> assim que o Caddy o emitir.",
      "",
    ];
  }
  const defaultHost = hosts.includes(hostname) ? hostname : hosts[0];
  return hosts.flatMap((host) => {
    const id = certificateId(host);
    return [
      `[certificate.${id}]`,
      `cert = "%{file:${STALWART_CERTS_DIR}/${id}.crt}%"`,
      `private-key = "%{file:${STALWART_CERTS_DIR}/${id}.key}%"`,
      ...(host === defaultHost ? ["default = true"] : []),
      "",
    ];
  });
}

/** Config TOML mínimo e determinístico (bootstrap sem wizard). */
export function renderConfigToml(hostname: string, adminSecret: string, certificateHosts: string[] = []): string {
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
    ...certificateSections(hostname, certificateHosts),
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
