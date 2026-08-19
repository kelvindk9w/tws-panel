/**
 * mail-service.ts — orquestra o módulo de e-mail (Fase 3): servidor Stalwart,
 * domínios + DKIM, checklist/verificação DNS, caixas e injeção SMTP em projetos.
 * Persistência JSON em data/mail/mail.json (modo 0600 — guarda segredos),
 * seguindo o padrão das fases 0–2.
 */
import os from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  DKIM_SELECTOR,
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
import {
  buildCredentials,
  buildDnsChecklist,
  buildSmtpEnv,
  checkDomainBlacklists,
  checkIpBlacklists,
  generatePassword,
  maskEnv,
  projectMailboxAddress,
  StalwartClient,
  StalwartManager,
  verifyDnsRecords,
} from "@paas/mailer";
import type { ServerConfig } from "../config.js";
import { httpError } from "./deploy-service.js";

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
}

const EMPTY_FILE: MailFile = {
  adminSecret: null,
  hostname: null,
  domains: {},
  mailboxes: {},
  projects: {},
};

export class MailService {
  private readonly mailDir: string;
  private readonly mailFile: string;
  private data: MailFile = structuredClone(EMPTY_FILE);
  private loaded = false;

  constructor(private readonly config: ServerConfig) {
    this.mailDir = path.join(config.dataDir, "mail");
    this.mailFile = path.join(this.mailDir, "mail.json");
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
    return this.config.mailHostname ?? this.data.hostname ?? "mail.localhost";
  }

  /** IPv4 usado no checklist DNS (PAAS_PUBLIC_IP ou primeira interface externa). */
  private serverIp(): string {
    if (this.config.publicIp) return this.config.publicIp;
    for (const infos of Object.values(os.networkInterfaces())) {
      for (const info of infos ?? []) {
        if (info.family === "IPv4" && !info.internal) return info.address;
      }
    }
    return "127.0.0.1";
  }

  private manager(): StalwartManager {
    if (!this.data.adminSecret) {
      throw httpError(409, "mail_not_initialized", "Servidor de e-mail ainda não inicializado — inicie o servidor primeiro.");
    }
    return new StalwartManager({
      configDir: path.join(this.mailDir, "stalwart"),
      hostname: this.hostname(),
      adminSecret: this.data.adminSecret,
      ports: this.config.mailPorts,
    });
  }

  private client(): StalwartClient {
    if (!this.data.adminSecret) {
      throw httpError(409, "mail_not_initialized", "Servidor de e-mail ainda não inicializado — inicie o servidor primeiro.");
    }
    return new StalwartClient(
      `http://127.0.0.1:${this.config.mailPorts.http}`,
      "admin",
      this.data.adminSecret,
    );
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
    const manager = this.manager();
    await manager.start();
    await manager.waitReady(this.config.mailPorts.http);
    return manager.status();
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

  async addDomain(name: string): Promise<MailDomainSummary> {
    await this.ensureLoaded();
    const domain = normalizeMailDomain(name);
    if (this.data.domains[domain]) {
      throw httpError(409, "domain_exists", `O domínio ${domain} já está cadastrado.`);
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

  async removeDomain(name: string): Promise<void> {
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
    for (const mailbox of Object.values(this.data.mailboxes).filter((m) => m.domain === domain)) {
      await client.deleteMailbox(mailbox.id).catch(() => undefined);
      delete this.data.mailboxes[mailbox.id];
    }
    await client.deleteDomain(domain);
    delete this.data.domains[domain];
    await this.save();
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
    const result = await verifyDnsRecords(checklist);
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
    return buildSmtpEnv({ mailbox: mailbox.id, password: mailbox.password, mailFrom: mailbox.id });
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
    const status = await this.manager().status();
    if (!status.running) {
      throw httpError(409, "mail_server_stopped", "O servidor de e-mail está parado. Inicie-o antes de continuar.");
    }
  }
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
