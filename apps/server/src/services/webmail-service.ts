/**
 * webmail-service.ts — webmail (Roundcube) do servidor de e-mail do painel.
 *
 * Pedido do dono do produto (04/10/2026): as pessoas leem, respondem e
 * enviam e-mail das caixas (contato@, suporte@…) pelo navegador, em
 * https://mail.<domínio>/, sem configurar Outlook/Gmail.
 *
 * O que este serviço faz:
 *  - ativa/desativa o container paas-webmail (na paas-net, sem porta
 *    publicada) com a configuração gerada a partir do servidor de e-mail;
 *  - acompanha o servidor de e-mail (parou → para; voltou → sobe) e regrava
 *    a configuração quando os domínios ou o certificado mudam;
 *  - isenta o IP do webmail no bloqueio automático do Stalwart: todos os
 *    logins chegam desse IP, e 100 senhas erradas num dia bloqueariam o
 *    webmail de todo mundo para sempre (conferido no Stalwart real);
 *  - no lugar desse bloqueio, bloqueia no Caddy o IP REAL de quem erra a
 *    senha demais (10 em 10 min → 1 hora), lendo o log do Roundcube.
 *
 * Estado em data/mail/webmail.json (0600: guarda a chave da sessão).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PAAS_WEBMAIL_CONTAINER, WEBMAIL_INTERNAL_PORT, webmailUrl, type WebmailStatus } from "@paas/core";
import { generateDesKey, parseFailedLogins, renderRoundcubeConfig, WebmailManager } from "@paas/mailer";
import type { ServerConfig } from "../config.js";
import { httpError } from "./http-error.js";
import type { MailAuditSink } from "./mail-service.js";

/** O que o webmail usa do servidor de e-mail (MailService). */
export interface WebmailMailSource {
  webmailBackend(): Promise<{
    serverRunning: boolean;
    imapHost: string;
    verifyTls: boolean;
    hosts: string[];
    domains: { domain: string; host: string }[];
  }>;
  exemptWebmailIp(ip: string, previousIp: string | null): Promise<void>;
  removeWebmailIpExemption(ip: string): Promise<void>;
}

/** Forma do WebmailManager usada aqui (dublê nos testes). */
export type WebmailManagerLike = Pick<
  WebmailManager,
  "image" | "containerName" | "status" | "start" | "stop" | "remove" | "internalIp" | "logsSince"
>;

export interface WebmailServiceOptions {
  createManager?: (config: string) => WebmailManagerLike;
  audit?: MailAuditSink;
  log?: (message: string) => void;
  now?: () => number;
}

interface WebmailFile {
  enabled: boolean;
  enabledAt: string | null;
  /** Chave da cifra da sessão do Roundcube (gerada uma vez). */
  desKey: string | null;
  /** IP do webmail isento no Stalwart (para tirar quando mudar). */
  exemptIp: string | null;
}

const EMPTY: WebmailFile = { enabled: false, enabledAt: null, desKey: null, exemptIp: null };

/** Bloqueio por IP: 10 senhas erradas em 10 minutos → 1 hora fora. */
const FAIL_LIMIT = 10;
const FAIL_WINDOW_MS = 10 * 60_000;
const BLOCK_MS = 60 * 60_000;
/** Primeira leitura do log: os últimos 2 minutos. */
const FIRST_LOOKBACK_S = 120;

export class WebmailService {
  private readonly file: string;
  private readonly createManager: (config: string) => WebmailManagerLike;
  private readonly audit: MailAuditSink | undefined;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private data: WebmailFile = { ...EMPTY };
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  /** IP → horários (ms) das senhas erradas na janela. Só em memória. */
  private readonly failures = new Map<string, number[]>();
  /** IP → até quando (ms) fica bloqueado. Só em memória. */
  private readonly blocked = new Map<string, number>();
  private lastPoll: number | null = null;

  constructor(
    config: Pick<ServerConfig, "dataDir">,
    private readonly mail: WebmailMailSource,
    opts: WebmailServiceOptions = {},
  ) {
    this.file = path.join(config.dataDir, "mail", "webmail.json");
    this.createManager = opts.createManager ?? ((cfg) => new WebmailManager({ config: cfg }));
    this.audit = opts.audit;
    this.log = opts.log ?? ((m) => console.warn(m));
    this.now = opts.now ?? Date.now;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.file)) return;
    try {
      this.data = { ...EMPTY, ...(JSON.parse(await readFile(this.file, "utf8")) as Partial<WebmailFile>) };
    } catch {
      this.data = { ...EMPTY };
    }
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  }

  /** Uma operação de cada vez (ativar, desativar, sincronizar). */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private manager(config = ""): WebmailManagerLike {
    return this.createManager(config);
  }

  private configFor(backend: Awaited<ReturnType<WebmailMailSource["webmailBackend"]>>): string {
    this.data.desKey ??= generateDesKey();
    return renderRoundcubeConfig({
      imapHost: backend.imapHost,
      verifyTls: backend.verifyTls,
      desKey: this.data.desKey,
      trustedHosts: backend.hosts,
    });
  }

  async status(): Promise<WebmailStatus> {
    await this.ensureLoaded();
    const backend = await this.mail.webmailBackend();
    const manager = this.manager();
    const container = await manager.status();
    const enabled = this.data.enabled;
    const message =
      backend.domains.length === 0
        ? "Cadastre um domínio de e-mail para usar o webmail."
        : !backend.serverRunning
          ? "O servidor de e-mail está parado. Inicie-o para usar o webmail."
          : !enabled
            ? "Ative o webmail para ler e enviar e-mails das caixas pelo navegador."
            : !container.running
              ? "O webmail está ativado, mas não está rodando. Clique em “Ativar webmail” para subir de novo."
              : null;
    return {
      enabled,
      installed: container.installed,
      running: container.running,
      image: manager.image,
      containerName: manager.containerName,
      mailServerRunning: backend.serverRunning,
      tlsVerified: backend.verifyTls,
      links: backend.domains.map((d) => ({ domain: d.domain, host: d.host, url: webmailUrl(d.host) })),
      blockedIps: this.activeBlocks().length,
      message,
    };
  }

  async enable(): Promise<WebmailStatus> {
    await this.serialize(async () => {
      await this.ensureLoaded();
      const backend = await this.mail.webmailBackend();
      if (backend.domains.length === 0) {
        throw httpError(409, "webmail_no_domain", "Cadastre um domínio de e-mail antes de ativar o webmail.");
      }
      if (!backend.serverRunning) {
        throw httpError(409, "mail_server_stopped", "O servidor de e-mail está parado. Inicie-o antes de ativar o webmail.");
      }
      const manager = this.manager(this.configFor(backend));
      await manager.start();
      this.data.enabled = true;
      this.data.enabledAt = new Date(this.now()).toISOString();
      await this.save();
      await this.refreshExemption(manager);
    });
    return this.status();
  }

  async disable(): Promise<WebmailStatus> {
    await this.serialize(async () => {
      await this.ensureLoaded();
      await this.manager().remove();
      if (this.data.exemptIp) {
        try {
          await this.mail.removeWebmailIpExemption(this.data.exemptIp);
        } catch (err) {
          this.log(`Webmail: não deu para tirar a isenção do IP ${this.data.exemptIp} no servidor de e-mail (${errorText(err)}).`);
        }
      }
      this.data.enabled = false;
      this.data.exemptIp = null;
      this.blocked.clear();
      this.failures.clear();
      await this.save();
    });
    return this.status();
  }

  /** O servidor de e-mail iniciou (true) ou parou (false): o webmail acompanha. */
  async followMailServer(running: boolean): Promise<void> {
    await this.ensureLoaded();
    if (!this.data.enabled) return;
    if (running) await this.sync();
    else await this.serialize(() => this.manager().stop());
  }

  /**
   * Regrava a configuração (domínio novo, certificado instalado) e garante
   * o container no ar e a isenção do IP atual. Nada com o webmail
   * desativado ou o servidor de e-mail parado.
   */
  async sync(): Promise<void> {
    await this.serialize(async () => {
      await this.ensureLoaded();
      if (!this.data.enabled) return;
      const backend = await this.mail.webmailBackend();
      if (!backend.serverRunning) return;
      const manager = this.manager(this.configFor(backend));
      await manager.start();
      await this.refreshExemption(manager);
    });
  }

  /** O IP do container muda quando ele é recriado: a isenção acompanha. */
  private async refreshExemption(manager: WebmailManagerLike): Promise<void> {
    const ip = await manager.internalIp();
    if (!ip || ip === this.data.exemptIp) return;
    try {
      await this.mail.exemptWebmailIp(ip, this.data.exemptIp);
      this.data.exemptIp = ip;
      await this.save();
    } catch (err) {
      this.log(`Webmail: não deu para isentar o IP ${ip} no servidor de e-mail (${errorText(err)}); tento de novo depois.`);
    }
  }

  /** O que o Caddy precisa: null = webmail desativado (página do servidor de e-mail). */
  async proxyState(): Promise<{ upstream: string; blockedIps: string[] } | null> {
    await this.ensureLoaded();
    if (!this.data.enabled) return null;
    return { upstream: `${PAAS_WEBMAIL_CONTAINER}:${WEBMAIL_INTERNAL_PORT}`, blockedIps: this.activeBlocks() };
  }

  private activeBlocks(): string[] {
    const now = this.now();
    return [...this.blocked.entries()].filter(([, until]) => until > now).map(([ip]) => ip);
  }

  /**
   * Lê as senhas erradas desde a última leitura e bloqueia o IP que passou
   * do limite. true = a lista de bloqueados mudou (o Caddy precisa ser
   * recalculado). Chamado a cada minuto pela rota.
   */
  async pollFailedLogins(): Promise<boolean> {
    await this.ensureLoaded();
    const now = this.now();
    let changed = false;
    for (const [ip, until] of this.blocked) {
      if (until <= now) {
        this.blocked.delete(ip);
        changed = true;
      }
    }
    if (!this.data.enabled) return changed;
    const manager = this.manager();
    if (!(await manager.status()).running) return changed;

    const since = this.lastPoll === null ? Math.floor(now / 1000) - FIRST_LOOKBACK_S : Math.floor(this.lastPoll / 1000);
    this.lastPoll = now;
    for (const { ip } of parseFailedLogins(await manager.logsSince(since))) {
      if (this.blocked.has(ip)) continue;
      const recent = [...(this.failures.get(ip) ?? []), now].filter((t) => t > now - FAIL_WINDOW_MS);
      if (recent.length < FAIL_LIMIT) {
        this.failures.set(ip, recent);
        continue;
      }
      this.failures.delete(ip);
      this.blocked.set(ip, now + BLOCK_MS);
      changed = true;
      await this.audit?.record({
        action: "mail.webmail.block",
        target: ip,
        detail: `Webmail: ${ip} bloqueado por 1 hora depois de ${FAIL_LIMIT} senhas erradas em 10 minutos.`,
      });
    }
    for (const [ip, times] of this.failures) {
      if (times.every((t) => t <= now - FAIL_WINDOW_MS)) this.failures.delete(ip);
    }
    return changed;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
