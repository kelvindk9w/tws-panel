/**
 * mail-service.ts — orquestra o módulo de e-mail (Fase 3): servidor Stalwart,
 * domínios + DKIM, checklist/verificação DNS, caixas e injeção SMTP em projetos.
 * Persistência JSON em data/mail/mail.json (modo 0600 — guarda segredos),
 * seguindo o padrão das fases 0–2.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  DKIM_SELECTOR,
  PAAS_STALWART_CONTAINER,
  type MailTlsHostStatus,
  type MailTlsStatusResponse,
  type BlacklistCheckResponse,
  type DnsChecklistResponse,
  type DnsVerifyResponse,
  type MailDomain,
  type MailDomainSummary,
  type Mailbox,
  type MailboxCredentials,
  type MailServerStatus,
  type ProjectEmailConfig,
  type Project,
} from "@paas/core";
import { certificateStatus, type CertificateStatus } from "@paas/deploy";
import {
  buildCredentials,
  buildDnsChecklist,
  buildSmtpEnv,
  checkDomainBlacklists,
  checkExistingMail,
  checkIpBlacklists,
  generatePassword,
  mailHostFor,
  maskEnv,
  projectMailboxAddress,
  publicResolver,
  readCaddyCertificate,
  StalwartClient,
  StalwartManager,
  verifyDnsRecords,
  type DnsResolverLike,
  type MailCertificate,
} from "@paas/mailer";
import type { ServerConfig } from "../config.js";
import { isCloudflareIp, publicIpFromPanelDomain } from "../routes/domains.js";
import { httpError } from "./deploy-service.js";

/** Container do painel no compose (container_name) — mesmo nome do deploy-service. */
const PANEL_CONTAINER = "tws-panel";

/**
 * Certificados instalados no Stalwart na última sincronização (sem a chave):
 * é o que decide entre não fazer nada, recarregar ou reiniciar (syncTls).
 */
interface AppliedTls {
  hostname: string;
  aliases: string[];
  /** host → impressão digital do certificado instalado. */
  certificates: Record<string, string>;
}

interface StoredDomain extends MailDomain {
  lastVerify: { at: string; ok: number; total: number } | null;
}

interface StoredMailbox extends Mailbox {
  /** Senha em claro — necessária para credenciais e injeção SMTP (arquivo 0600). */
  password: string;
}

interface StoredProjectEmail {
  domain: string;
  mailbox: string;
  enabledAt: string;
}

interface MailFile {
  adminSecret: string | null;
  hostname: string | null;
  domains: Record<string, StoredDomain>;
  mailboxes: Record<string, StoredMailbox>;
  projects: Record<string, StoredProjectEmail>;
  tls?: AppliedTls | null;
}

const EMPTY_FILE: MailFile = {
  adminSecret: null,
  hostname: null,
  domains: {},
  mailboxes: {},
  projects: {},
  tls: null,
};

/** Sink de auditoria mínimo — compatível com AuditService.record sem acoplar
 * mail-service.ts à classe concreta (só a forma usada aqui). */
export interface MailAuditSink {
  record(input: { actor?: string; action: string; target?: string | null; detail: string }): Promise<unknown>;
}

export interface MailServiceOptions {
  /**
   * Auditoria de ações sensíveis. Mesmo sink usado hoje pelas rotas para
   * criar domínio/caixa (routes/mail.ts, fora do escopo desta correção) —
   * quando fornecido, deleteMailbox passa a registrar a remoção da mesma
   * forma. Opcional: sem ele, o comportamento é o de hoje (sem auditoria).
   */
  audit?: MailAuditSink;
  /**
   * Log estruturado de falhas não fatais (ex.: deleteMailbox individual
   * falhando dentro de removeDomain — antes silenciada com
   * `.catch(() => undefined)`, podendo deixar caixa órfã viva no Stalwart
   * sem registro local). Default: console.warn.
   */
  log?: (message: string, meta?: Record<string, unknown>) => void;
  /**
   * O painel roda em container (produção)? Então 127.0.0.1 é ele mesmo: a
   * API e o TLS do Stalwart são alcançados pela paas-net (paas-stalwart:8080
   * e mail.<domínio>:465), com o painel ligado a ela. Padrão: /.dockerenv.
   */
  inContainer?: boolean;
  /** Lê o certificado de um host no Caddy (padrão: readCaddyCertificate). */
  readCertificate?: (host: string) => Promise<MailCertificate | null>;
  /** Conferência TLS como a de um app (padrão: certificateStatus). */
  checkCertificate?: typeof certificateStatus;
  /** Resolver DNS (padrão: servidores públicos). */
  resolver?: DnsResolverLike;
}

export type TlsSyncResult = "none" | "reloaded" | "restarted";

/** Resultado de removeDomain: caixas cuja remoção REMOTA falhou (a remoção
 * do domínio prossegue mesmo assim — ver removeDomain). */
export interface RemoveDomainResult {
  mailboxDeleteFailures: string[];
}

export class MailService {
  private readonly mailDir: string;
  private readonly mailFile: string;
  private readonly audit: MailAuditSink | undefined;
  private readonly log: (message: string, meta?: Record<string, unknown>) => void;
  private readonly inContainer: boolean;
  private readonly readCertificate: (host: string) => Promise<MailCertificate | null>;
  private readonly checkCertificate: typeof certificateStatus;
  private readonly resolverOverride: DnsResolverLike | undefined;
  private data: MailFile = structuredClone(EMPTY_FILE);
  private loaded = false;
  private syncing: Promise<{ result: TlsSyncResult; certificates: MailCertificate[] }> | null = null;
  private networkReady: Promise<void> | null = null;

  constructor(
    private readonly config: ServerConfig,
    opts: MailServiceOptions = {},
  ) {
    this.mailDir = path.join(config.dataDir, "mail");
    this.mailFile = path.join(this.mailDir, "mail.json");
    this.audit = opts.audit;
    this.log = opts.log ?? ((message, meta) => console.warn(message, meta ?? {}));
    this.inContainer = opts.inContainer ?? existsSync("/.dockerenv");
    this.readCertificate = opts.readCertificate ?? ((host) => readCaddyCertificate(host));
    this.checkCertificate = opts.checkCertificate ?? certificateStatus;
    this.resolverOverride = opts.resolver;
  }

  /**
   * Em container, o painel só alcança a API e o TLS do Stalwart pela
   * paas-net. Depois de uma atualização (`docker compose up --build`
   * recria o painel) ele volta fora dela — reconecta uma vez por processo.
   */
  private async ensureNetworkAccess(): Promise<void> {
    if (!this.inContainer || !this.data.adminSecret) return;
    this.networkReady ??= this.manager()
      .connectContainer(PANEL_CONTAINER)
      .catch((err: unknown) => {
        this.networkReady = null;
        throw err;
      });
    await this.networkReady;
  }

  private resolver(): DnsResolverLike {
    return this.resolverOverride ?? publicResolver();
  }

  // -------------------------------------------------------------------------
  // Persistência
  // -------------------------------------------------------------------------

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.mailFile, "utf8")) as Partial<MailFile>;
      this.data = { ...structuredClone(EMPTY_FILE), ...raw };
    } catch {
      this.data = structuredClone(EMPTY_FILE);
    }
  }

  private async save(): Promise<void> {
    await mkdir(this.mailDir, { recursive: true });
    await writeFile(this.mailFile, JSON.stringify(this.data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  // -------------------------------------------------------------------------
  // Infra derivada (hostname, IP, manager, client)
  // -------------------------------------------------------------------------

  /** Hostname do servidor: env PAAS_MAIL_HOSTNAME → mail.<1º domínio> → mail.localhost. */
  private hostname(): string {
    const first = Object.keys(this.data.domains)[0];
    return this.config.mailHostname ?? this.data.hostname ?? (first ? mailHostFor(first) : "mail.localhost");
  }

  /**
   * Nomes do servidor de e-mail: o hostname dele e o mail.<domínio> de cada
   * domínio (é o nome do registro A e do MX no checklist). Cada um ganha
   * certificado (Caddy), alias na paas-net e vira o SMTP_HOST dos projetos.
   */
  private hostList(): string[] {
    const hosts = [this.hostname(), ...Object.keys(this.data.domains).map(mailHostFor)];
    return [...new Set(hosts)].filter((h) => h !== "localhost" && !h.endsWith(".localhost"));
  }

  async mailHosts(): Promise<string[]> {
    await this.ensureLoaded();
    return this.hostList();
  }

  /**
   * IPv4 usado no checklist DNS: PAAS_PUBLIC_IP, o IP do endereço sslip.io do
   * painel ou a primeira interface externa (esta última só serve fora de
   * container: dentro dele a interface é a da rede do Docker).
   */
  private serverIp(): string {
    if (this.config.publicIp) return this.config.publicIp;
    const fromPanel = publicIpFromPanelDomain(this.config.panelDomain);
    if (fromPanel) return fromPanel;
    for (const infos of Object.values(os.networkInterfaces())) {
      for (const info of infos ?? []) {
        if (info.family === "IPv4" && !info.internal) return info.address;
      }
    }
    return "127.0.0.1";
  }

  /** Em container, a API do Stalwart pela paas-net (porta do container, não a do host). */
  private apiBaseUrl(): string {
    return this.inContainer ? `http://${PAAS_STALWART_CONTAINER}:8080` : `http://127.0.0.1:${this.config.mailPorts.http}`;
  }

  private manager(certificates: MailCertificate[] = []): StalwartManager {
    if (!this.data.adminSecret) {
      throw httpError(409, "mail_not_initialized", "Servidor de e-mail ainda não inicializado — inicie o servidor primeiro.");
    }
    return new StalwartManager({
      configDir: path.join(this.mailDir, "stalwart"),
      hostname: this.hostname(),
      adminSecret: this.data.adminSecret,
      ports: this.config.mailPorts,
      aliases: this.hostList(),
      certificates,
      ...(this.inContainer ? { apiBaseUrl: this.apiBaseUrl() } : {}),
    });
  }

  private client(): StalwartClient {
    if (!this.data.adminSecret) {
      throw httpError(409, "mail_not_initialized", "Servidor de e-mail ainda não inicializado — inicie o servidor primeiro.");
    }
    return new StalwartClient(this.apiBaseUrl(), "admin", this.data.adminSecret);
  }

  // -------------------------------------------------------------------------
  // Servidor Stalwart
  // -------------------------------------------------------------------------

  async status(): Promise<MailServerStatus> {
    await this.ensureLoaded();
    if (!this.data.adminSecret) {
      // Nunca iniciado: reporta estado "não instalado" sem tocar no Docker.
      return {
        installed: false,
        running: false,
        version: null,
        image: "stalwartlabs/mail-server:v0.11.8",
        containerName: "paas-stalwart",
        hostname: this.hostname(),
        ports: this.config.mailPorts,
        message: "Servidor de e-mail ainda não foi criado. Clique em iniciar para provisionar o container.",
      };
    }
    return this.manager().status();
  }

  async startServer(): Promise<MailServerStatus> {
    await this.ensureLoaded();
    this.data.adminSecret ??= generatePassword(24);
    await this.save();
    // Já sobe com os certificados que o Caddy tiver emitido.
    const certificates = await this.currentCertificates();
    const manager = this.manager(certificates);
    // Já rodando, start() só regrava os arquivos — seção nova não vale até
    // reiniciar. Aí o estado aplicado fica como estava, e a sincronização
    // seguinte (syncTls) decide o reinício.
    const wasRunning = (await manager.status()).running;
    await manager.start();
    if (this.inContainer) await manager.connectContainer(PANEL_CONTAINER);
    await manager.waitReady();
    if (!wasRunning) {
      this.data.tls = this.tlsState(certificates);
      await this.save();
    }
    return manager.status();
  }

  // -------------------------------------------------------------------------
  // Certificado do servidor de e-mail (mail.<domínio>)
  // -------------------------------------------------------------------------

  /** Certificados já emitidos pelo Caddy para os hosts de e-mail. */
  private async currentCertificates(): Promise<MailCertificate[]> {
    const found = await Promise.all(this.hostList().map((h) => this.readCertificate(h)));
    return found.filter((c): c is MailCertificate => c !== null);
  }

  private tlsState(certificates: MailCertificate[]): AppliedTls {
    return {
      hostname: this.hostname(),
      aliases: this.hostList(),
      certificates: Object.fromEntries(certificates.map((c) => [c.host, c.fingerprint])),
    };
  }

  /**
   * Instala no Stalwart os certificados que o Caddy emitiu — e os renovados
   * (o Let's Encrypt renova a cada ~60 dias; o painel chama isto a cada hora
   * e ao abrir a página E-mail). Compara com o que foi instalado da última
   * vez: nada mudou → nada; só o conteúdo (renovação) ou os aliases → entrega
   * e recarrega sem derrubar conexão; certificado de um nome novo ou outro
   * hostname → entrega e reinicia (o Stalwart não relê seção nova do
   * config.toml sem reiniciar — conferido na v0.11.8 real).
   */
  async syncTls(): Promise<TlsSyncResult> {
    return (await this.syncOnce()).result;
  }

  private syncOnce(): Promise<{ result: TlsSyncResult; certificates: MailCertificate[] }> {
    this.syncing ??= this.doSyncTls().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async doSyncTls(): Promise<{ result: TlsSyncResult; certificates: MailCertificate[] }> {
    await this.ensureLoaded();
    if (!this.data.adminSecret) return { result: "none", certificates: [] };
    await this.ensureNetworkAccess();
    const certificates = await this.currentCertificates();
    if (!(await this.manager().status()).running) return { result: "none", certificates };

    const wanted = this.tlsState(certificates);
    const applied = this.data.tls ?? null;
    const sameNames =
      applied !== null &&
      applied.hostname === wanted.hostname &&
      Object.keys(applied.certificates).sort().join(",") === Object.keys(wanted.certificates).sort().join(",");
    const sameContent =
      sameNames &&
      Object.entries(wanted.certificates).every(([h, fp]) => applied.certificates[h] === fp) &&
      applied.aliases.join(",") === wanted.aliases.join(",");
    if (sameContent) return { result: "none", certificates };

    const result = await this.manager(certificates).applyTls({ restart: !sameNames });
    this.data.tls = wanted;
    await this.save();
    return { result, certificates };
  }

  /**
   * Estado do certificado de cada host de e-mail, conferido como um app
   * confere (TLS com SNI = mail.<domínio>, cadeia e nome validados), e o que
   * falta quando ainda não está válido.
   */
  async tlsStatus(): Promise<MailTlsStatusResponse> {
    await this.ensureLoaded();
    let syncError: string | null = null;
    let certificates: MailCertificate[] = [];
    try {
      certificates = (await this.syncOnce()).certificates;
    } catch (err) {
      syncError = err instanceof Error ? err.message : String(err);
    }
    const serverRunning = this.data.adminSecret ? (await this.manager().status()).running : false;
    const expectedIp = this.serverIp();
    const hosts = await Promise.all(
      this.hostList().map(async (host): Promise<MailTlsHostStatus> => {
        const issued = certificates.some((c) => c.host === host);
        const [tls, dns] = await Promise.all([
          serverRunning
            ? this.checkCertificate({
                // Em container, pelo alias na paas-net — o mesmo caminho do app.
                host: this.inContainer ? host : "127.0.0.1",
                port: this.inContainer ? 465 : this.config.mailPorts.submissions,
                servername: host,
                timeoutMs: 5_000,
              })
            : Promise.resolve<CertificateStatus>({ ok: false, issuer: null, validTo: null, error: null }),
          this.dnsOf(host, expectedIp),
        ]);
        return {
          host,
          ok: tls.ok,
          issuer: tls.ok ? tls.issuer : null,
          validTo: tls.ok ? tls.validTo : null,
          error: tls.ok ? null : tls.error,
          issued,
          dns,
          hint: tls.ok ? null : tlsHint(host, { serverRunning, issued, dns }),
        };
      }),
    );
    return { checkedAt: new Date().toISOString(), serverRunning, hosts, syncError };
  }

  private async dnsOf(host: string, expectedIp: string): Promise<MailTlsHostStatus["dns"]> {
    const resolved = await this.resolver()
      .resolve4(host)
      .catch(() => [] as string[]);
    const status =
      resolved.length === 0
        ? "missing"
        : resolved.includes(expectedIp)
          ? "ok"
          : resolved.every(isCloudflareIp)
            ? "cloudflare"
            : "other_ip";
    return { status, resolved, expectedIp };
  }

  async stopServer(): Promise<MailServerStatus> {
    await this.ensureLoaded();
    const manager = this.manager();
    await manager.stop();
    return manager.status();
  }

  // -------------------------------------------------------------------------
  // Domínios
  // -------------------------------------------------------------------------

  async listDomains(): Promise<MailDomainSummary[]> {
    await this.ensureLoaded();
    return Object.values(this.data.domains).map((d) => this.summaryOf(d));
  }

  /**
   * Check de blacklist (Fase 4): IP público do servidor contra as principais
   * DNSBLs de IP + cada domínio cadastrado contra DNSBLs de domínio.
   */
  async checkBlacklists(): Promise<BlacklistCheckResponse> {
    await this.ensureLoaded();
    const ip = this.serverIp();
    const [ipResults, domainResults] = await Promise.all([
      checkIpBlacklists(ip),
      Promise.all(
        Object.keys(this.data.domains).map(async (domain) => ({
          target: domain,
          results: await checkDomainBlacklists(domain),
        })),
      ),
    ]);
    const targets = [{ target: ip, results: ipResults }, ...domainResults];
    const listedCount = targets.reduce(
      (acc, t) => acc + t.results.filter((r) => r.status === "listed").length,
      0,
    );
    return {
      checkedAt: new Date().toISOString(),
      ip: { target: ip, results: ipResults },
      domains: domainResults,
      listedCount,
    };
  }

  private summaryOf(domain: StoredDomain): MailDomainSummary {
    const mailboxCount = Object.values(this.data.mailboxes).filter(
      (m) => m.domain === domain.name,
    ).length;
    return { ...domain, mailboxCount };
  }

  async addDomain(name: string, opts: { confirmExistingMail?: boolean } = {}): Promise<MailDomainSummary> {
    await this.ensureLoaded();
    const domain = normalizeMailDomain(name);
    if (this.data.domains[domain]) {
      throw httpError(409, "domain_exists", `O domínio ${domain} já está cadastrado.`);
    }
    // Motivo real (01/10/2026): o dono do produto ia cadastrar o domínio
    // principal da empresa, que recebe e-mail em outro provedor. O checklist
    // manda apontar o MX para esta VPS — seguir isso desviaria o e-mail
    // dela. Sem confirmação explícita, o cadastro para aqui.
    if (!opts.confirmExistingMail) {
      const existing = await checkExistingMail(domain, [mailHostFor(domain), this.hostname()], this.resolver());
      if (existing.status === "elsewhere" || existing.status === "unknown") {
        const err = httpError(
          409,
          "domain_receives_mail",
          existing.status === "elsewhere"
            ? `O domínio ${domain} já recebe e-mail em ${existing.servers.join(", ")}. Seguir o checklist ` +
                `(apontar o MX para esta VPS) desviaria todo o e-mail que hoje chega em ${existing.servers[0]}. ` +
                `Recomendado: use um subdomínio só para o envio, como ${existing.suggestedDomain}.`
            : `Não foi possível consultar quem recebe o e-mail de ${domain} hoje (registro MX). Se o domínio ` +
                `já tem e-mail funcionando em outro provedor, apontar o MX para esta VPS desviaria esse e-mail. ` +
                `Recomendado: use um subdomínio só para o envio, como ${existing.suggestedDomain}.`,
        );
        err.details = { existingMail: existing };
        throw err;
      }
    }
    await this.requireRunning();

    // Provisiona no Stalwart: domínio + par DKIM RSA 2048 + caixa postmaster.
    const client = this.client();
    await client.createDomain(domain);
    const signatureId = await client.createDkimSignature(domain, DKIM_SELECTOR);
    const dkimPublicKey = await client.getDkimPublicKey(signatureId);

    const now = new Date().toISOString();
    const stored: StoredDomain = {
      name: domain,
      dkimSelector: DKIM_SELECTOR,
      dkimPublicKey,
      dkimKeyBits: 2048,
      dmarcStage: "none",
      createdAt: now,
      lastVerify: null,
    };
    this.data.domains[domain] = stored;

    // Boas práticas (spec §3): postmaster@ e abuse@ funcionais.
    const postmaster = `postmaster@${domain}`;
    const password = generatePassword();
    await client.createMailbox(postmaster, password, [`abuse@${domain}`]);
    this.data.mailboxes[postmaster] = {
      id: postmaster,
      localPart: "postmaster",
      domain,
      kind: "system",
      createdAt: now,
      password,
    };

    await this.save();
    return this.summaryOf(stored);
  }

  async removeDomain(name: string): Promise<RemoveDomainResult> {
    await this.ensureLoaded();
    const domain = normalizeMailDomain(name);
    if (!this.data.domains[domain]) {
      throw httpError(404, "domain_not_found", `Domínio ${domain} não encontrado.`);
    }
    if (Object.values(this.data.projects).some((p) => p.domain === domain)) {
      throw httpError(
        409,
        "domain_in_use",
        "Há projetos com e-mail habilitado neste domínio. Desative o e-mail dos projetos antes.",
      );
    }
    await this.requireRunning();

    const client = this.client();
    const mailboxDeleteFailures: string[] = [];
    for (const mailbox of Object.values(this.data.mailboxes).filter((m) => m.domain === domain)) {
      try {
        await client.deleteMailbox(mailbox.id);
      } catch (err) {
        // Observável, NUNCA silenciosa: a caixa pode ter ficado viva no
        // Stalwart mesmo com o registro local removido logo abaixo — quem
        // opera o painel precisa saber disso, não só ver "domínio removido
        // com sucesso". Não interrompe o loop nem a remoção do domínio: uma
        // caixa presa não pode travar a limpeza das demais.
        mailboxDeleteFailures.push(mailbox.id);
        this.log(`falha ao remover a caixa ${mailbox.id} no Stalwart (domínio ${domain})`, {
          domain,
          mailbox: mailbox.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      delete this.data.mailboxes[mailbox.id];
    }
    await client.deleteDomain(domain);
    delete this.data.domains[domain];
    await this.save();
    return { mailboxDeleteFailures };
  }

  async dnsChecklist(name: string): Promise<DnsChecklistResponse> {
    await this.ensureLoaded();
    const domain = this.requireDomain(name);
    return buildDnsChecklist({
      domain: domain.name,
      mailHostname: `mail.${domain.name}`,
      serverIp: this.serverIp(),
      serverIpv6: this.config.publicIpv6,
      dkimSelector: domain.dkimSelector,
      dkimPublicKey: domain.dkimPublicKey,
      dmarcStage: domain.dmarcStage,
    });
  }

  async verifyDomain(name: string): Promise<DnsVerifyResponse> {
    const checklist = await this.dnsChecklist(name);
    // O resolver injetado (testes) vale também aqui; o padrão segue sendo o público.
    const result = await verifyDnsRecords(checklist, this.resolver());
    const domain = this.requireDomain(name);
    domain.lastVerify = {
      at: new Date().toISOString(),
      ok: result.summary.ok,
      total: result.summary.total,
    };
    await this.save();
    return {
      domain: checklist.domain,
      verifiedAt: domain.lastVerify.at,
      summary: result.summary,
      records: result.records,
      ptr: result.ptr,
      suggestion: checklist.suggestion,
    };
  }

  // -------------------------------------------------------------------------
  // Caixas de e-mail
  // -------------------------------------------------------------------------

  async listMailboxes(domainName: string): Promise<Mailbox[]> {
    await this.ensureLoaded();
    const domain = normalizeMailDomain(domainName);
    return Object.values(this.data.mailboxes)
      .filter((m) => m.domain === domain)
      .map(({ password: _password, ...mailbox }) => mailbox);
  }

  async createMailbox(
    domainName: string,
    localPart: string,
    password?: string,
  ): Promise<{ mailbox: Mailbox; password: string }> {
    await this.ensureLoaded();
    const domain = this.requireDomain(domainName);
    const local = normalizeLocalPart(localPart);
    const email = `${local}@${domain.name}`;
    if (this.data.mailboxes[email]) {
      throw httpError(409, "mailbox_exists", `A caixa ${email} já existe.`);
    }
    await this.requireRunning();

    const finalPassword = password?.trim() || generatePassword();
    if (finalPassword.length < 8) {
      throw httpError(400, "weak_password", "A senha deve ter pelo menos 8 caracteres.");
    }
    await this.client().createMailbox(email, finalPassword);

    const stored: StoredMailbox = {
      id: email,
      localPart: local,
      domain: domain.name,
      kind: "user",
      createdAt: new Date().toISOString(),
      password: finalPassword,
    };
    this.data.mailboxes[email] = stored;
    await this.save();
    const { password: _p, ...mailbox } = stored;
    return { mailbox, password: finalPassword };
  }

  async deleteMailbox(domainName: string, id: string): Promise<void> {
    await this.ensureLoaded();
    const domain = this.requireDomain(domainName);
    const email = decodeURIComponent(id).toLowerCase();
    const stored = this.data.mailboxes[email];
    if (!stored || stored.domain !== domain.name) {
      throw httpError(404, "mailbox_not_found", `Caixa ${email} não encontrada.`);
    }
    if (stored.kind === "system") {
      throw httpError(409, "mailbox_protected", "A caixa postmaster@ é exigida pelas boas práticas de e-mail e não pode ser removida.");
    }
    if (Object.values(this.data.projects).some((p) => p.mailbox === email)) {
      throw httpError(409, "mailbox_in_use", "Esta caixa técnica está em uso por um projeto. Desative o e-mail do projeto antes.");
    }
    await this.requireRunning();
    await this.client().deleteMailbox(email);
    delete this.data.mailboxes[email];
    await this.save();
    // Mesmo padrão de criar domínio/caixa (routes/mail.ts): a remoção também
    // é uma ação sensível e precisa ficar na trilha de auditoria.
    await this.audit?.record({
      action: "mail.mailbox.delete",
      target: email,
      detail: `Caixa de e-mail ${email} removida.`,
    });
  }

  async mailboxCredentials(id: string): Promise<MailboxCredentials> {
    await this.ensureLoaded();
    const email = decodeURIComponent(id).toLowerCase();
    const stored = this.data.mailboxes[email];
    if (!stored) {
      throw httpError(404, "mailbox_not_found", `Caixa ${email} não encontrada.`);
    }
    return buildCredentials({
      email: stored.id,
      password: stored.password,
      host: `mail.${stored.domain}`,
      ports: this.config.mailPorts,
    });
  }

  // -------------------------------------------------------------------------
  // E-mail de projeto (injeção SMTP no deploy)
  // -------------------------------------------------------------------------

  /** Ativa e-mail para o projeto: cria caixa técnica <slug>@<domínio> se preciso. */
  async enableProjectEmail(project: Project, domainName: string): Promise<ProjectEmailConfig> {
    await this.ensureLoaded();
    const domain = this.requireDomain(domainName);
    await this.requireRunning();

    const address = projectMailboxAddress(project, domain.name);
    if (!this.data.mailboxes[address]) {
      const password = generatePassword();
      await this.client().createMailbox(address, password);
      this.data.mailboxes[address] = {
        id: address,
        localPart: project.slug,
        domain: domain.name,
        kind: "project",
        createdAt: new Date().toISOString(),
        password,
      };
    }
    this.data.projects[project.id] = {
      domain: domain.name,
      mailbox: address,
      enabledAt: new Date().toISOString(),
    };
    await this.save();
    return this.projectEmailConfig(project.id);
  }

  async disableProjectEmail(projectId: string): Promise<ProjectEmailConfig> {
    await this.ensureLoaded();
    delete this.data.projects[projectId];
    await this.save();
    return this.projectEmailConfig(projectId);
  }

  /** Configuração atual (env vars mascaradas) para a UI. */
  async projectEmailConfig(projectId: string): Promise<ProjectEmailConfig> {
    await this.ensureLoaded();
    const stored = this.data.projects[projectId];
    if (!stored) {
      return { enabled: false, domain: null, mailbox: null, mailFrom: null, env: {} };
    }
    const mailbox = this.data.mailboxes[stored.mailbox];
    if (!mailbox) {
      return { enabled: false, domain: null, mailbox: null, mailFrom: null, env: {} };
    }
    const env = buildSmtpEnv({
      host: mailHostFor(stored.domain),
      mailbox: mailbox.id,
      password: mailbox.password,
      mailFrom: mailbox.id,
    });
    return {
      enabled: true,
      domain: stored.domain,
      mailbox: stored.mailbox,
      mailFrom: mailbox.id,
      env: maskEnv(env),
    };
  }

  /**
   * Provedor de env vars para o engine de deploy (Fase 2): retorna o mapa
   * SMTP completo (com senha) ou {} quando o projeto não tem e-mail habilitado.
   */
  envForProject = async (project: Project): Promise<Record<string, string>> => {
    await this.ensureLoaded();
    const stored = this.data.projects[project.id];
    if (!stored) return {};
    const mailbox = this.data.mailboxes[stored.mailbox];
    if (!mailbox) return {};
    return buildSmtpEnv({
      host: mailHostFor(stored.domain),
      mailbox: mailbox.id,
      password: mailbox.password,
      mailFrom: mailbox.id,
    });
  };

  // -------------------------------------------------------------------------

  private requireDomain(name: string): StoredDomain {
    const domain = this.data.domains[normalizeMailDomain(name)];
    if (!domain) {
      throw httpError(404, "domain_not_found", `Domínio ${name} não encontrado.`);
    }
    return domain;
  }

  private async requireRunning(): Promise<void> {
    await this.ensureNetworkAccess();
    const status = await this.manager().status();
    if (!status.running) {
      throw httpError(409, "mail_server_stopped", "O servidor de e-mail está parado. Inicie-o antes de continuar.");
    }
  }
}

/** O que falta para o certificado de `host` valer (pt-BR, para o operador). */
function tlsHint(
  host: string,
  s: { serverRunning: boolean; issued: boolean; dns: MailTlsHostStatus["dns"] },
): string {
  if (!s.serverRunning) return "O servidor de e-mail está parado. Inicie-o para conferir o certificado.";
  const { dns } = s;
  if (!s.issued) {
    if (dns.status === "missing") {
      return (
        `Falta o registro A de ${host} apontando para ${dns.expectedIp}. Na Cloudflare, deixe a nuvem ` +
        `CINZA ("Somente DNS"): com a nuvem laranja o certificado não é emitido e o e-mail não chega à VPS.`
      );
    }
    if (dns.status === "cloudflare") {
      return (
        `${host} está com o proxy da Cloudflare ligado (nuvem laranja): responde com os IPs da Cloudflare, ` +
        `não com o da VPS. Na Cloudflare, abra o registro A e mude para a nuvem CINZA ("Somente DNS"), ` +
        `com o valor ${dns.expectedIp}.`
      );
    }
    if (dns.status === "other_ip") {
      return `${host} aponta para ${dns.resolved.join(", ")}, não para esta VPS. Troque o registro A para ${dns.expectedIp}.`;
    }
    return (
      `O DNS de ${host} já aponta para esta VPS; o certificado está sendo emitido (costuma levar alguns ` +
      `minutos). Se demorar, confira se as portas 80 e 443 estão liberadas no firewall do provedor.`
    );
  }
  return (
    `O certificado de ${host} já foi emitido, mas o servidor de e-mail ainda apresenta outro. O painel o ` +
    `instala sozinho em instantes; clique em "Conferir de novo".`
  );
}

export function normalizeMailDomain(name: string): string {
  const domain = (name ?? "").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    throw httpError(400, "invalid_domain", `Domínio inválido: ${name}`);
  }
  return domain;
}

function normalizeLocalPart(localPart: string): string {
  const local = (localPart ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(local) || local.includes("..")) {
    throw httpError(400, "invalid_mailbox", `Nome de caixa inválido: ${localPart}`);
  }
  return local;
}
