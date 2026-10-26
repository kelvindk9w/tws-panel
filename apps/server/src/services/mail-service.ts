/**
 * mail-service.ts — orquestra o módulo de e-mail (Fase 3): servidor Stalwart,
 * domínios + DKIM, checklist/verificação DNS, caixas e injeção SMTP em projetos.
 * Persistência JSON em data/mail/mail.json (modo 0600 — guarda segredos),
 * seguindo o padrão das fases 0–2.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAILBOX_PASSWORD_MIN,
  normalizeDisplayName,
  sanitizeDisplayName,
  DKIM_SELECTOR,
  MAX_PROJECT_EMAIL_LINKS,
  PROJECT_EMAIL_VALUE_KEYS,
  envLinkNameProblem,
  PAAS_STALWART_CONTAINER,
  MAIL_ADOPT_SKIPPED_MAX,
  STALWART_IMAGE_REF,
  type MailTlsHostStatus,
  type MailTlsStatusResponse,
  type BlacklistCheckResponse,
  type DnsChecklistResponse,
  type DnsVerifyResponse,
  type MailAdoptResult,
  type MailDomain,
  type MailDomainSummary,
  type MailTestStatus,
  type Mailbox,
  type MailboxCredentials,
  type MailServerStatus,
  type ExistingMailboxMode,
  type ProjectEmailConfig,
  type ProjectEmailUsableMailbox,
  type ProjectEmailValueKey,
  type Project,
  type SetMailboxDisplayNameResponse,
} from "@paas/core";
import { certificateStatus, type CertificateStatus } from "@paas/deploy";
import {
  buildCredentials,
  buildDnsChecklist,
  buildSmtpEnv,
  checkDomainBlacklists,
  checkExistingMail,
  checkIpBlacklists,
  deliveryFromQueue,
  findDeliveryReport,
  generatePassword,
  generateStrongPassword,
  isSingleEmailAddress,
  mailHostFor,
  mtaStsHostFor,
  mtaStsServedPolicy,
  maskEnv,
  publicResolver,
  systemResolver,
  readCaddyCertificate,
  sendSmtpMail,
  SmtpSendError,
  StalwartApiError,
  StalwartClient,
  StalwartManager,
  stalwartConfigFingerprint,
  type SendHookConfig,
  verifyDnsRecords,
  type DnsResolverLike,
  type MailCertificate,
  type PlanInput,
  type QueuedMessage,
  type QueueMessageRaw,
} from "@paas/mailer";
import type { ServerConfig } from "../config.js";
import { isCloudflareIp, publicIpFromPanelDomain } from "../routes/domains.js";
import { httpError } from "./deploy-service.js";
import { loadJson, withFileLock, writeFileAtomic } from "./json-file.js";
import { planAdoption } from "./mail-adopt.js";
import type { HttpError } from "./http-error.js";
import { MAIL_SMTP_AUTH_REJECTED_MESSAGE, mailSmtpAuthRejectedMessage, mailAuthRepairFailedError, mailAuthRepairIncompleteError } from "./mail-auth-error.js";

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
  /**
   * Impressão digital do config.toml com que o Stalwart foi (re)iniciado
   * (stalwartConfigFingerprint — sem o segredo). Ausente = gravado por uma
   * versão anterior do painel: conta como diferente, e a sincronização
   * reinicia uma vez para as chaves novas valerem.
   */
  config?: string;
}

interface StoredDomain extends MailDomain {
  lastVerify: { at: string; ok: number; total: number; recordsOk?: boolean } | null;
  /**
   * dmarc@<domínio> já é endereço da postmaster@ (o rua do DMARC). Ausente
   * em domínios cadastrados antes de 04/10/2026: a sincronização acrescenta.
   */
  dmarcAlias?: boolean;
  /** Chave DKIM criada e ainda não carregada pelo Stalwart (precisa reiniciar). Some quando um reinício dá certo. */
  dkimRestartPending?: true;
}

/**
 * Partes locais que o painel cria com o domínio, todas na postmaster@:
 * abuse@ (boa prática) e dmarc@ (destino dos relatórios DMARC, rua=).
 */
const SYSTEM_LOCAL_PARTS = new Set(["postmaster", "abuse", "dmarc"]);

interface StoredMailbox extends Mailbox {
  /** Senha em claro — necessária para credenciais e injeção SMTP (arquivo 0600). */
  password: string;
  /**
   * A caixa já existia antes de virar a do projeto (caixa de usuário ou adotada). Nunca é apagada quando o projeto
   * a deixa (troca de endereço, projeto removido): volta a ser caixa de usuário. Não sai pela API.
   */
  external?: boolean;
  /** Dono (aba Caixas de um projeto) que a caixa tinha antes de ser adotada; volta a ser dele ao ser solta. Não sai pela API. */
  ownerBefore?: string;
}

/** A caixa como a API a mostra: sem a senha e sem campos internos. */
function publicMailbox(stored: StoredMailbox): Mailbox {
  const { password: _p, external: _e, ownerBefore: _o, ...mailbox } = stored;
  return mailbox;
}

interface StoredProjectEmail {
  domain: string;
  /** Caixa do projeto = endereço de envio (antes de 02/10/2026: caixa técnica <slug>@). */
  mailbox: string;
  enabledAt: string;
  /**
   * SÓ em registros antigos: endereço de envio como alias da caixa técnica.
   * Continua valendo até a pessoa salvar de novo (aí vira a caixa do projeto).
   */
  fromAddress?: string | null;
  /** Nome de exibição; ausente = nome do projeto na época da ativação. */
  fromName?: string | null;
  /** Variável do app → valor do e-mail que ela recebe no deploy (ex.: SMTP_SENHA → SMTP_PASS). */
  envLinks?: Record<string, ProjectEmailValueKey>;
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
  /**
   * Certificado MANUAL do host (página Certificados), com preferência sobre o
   * do Caddy. Ausente = só o automático.
   */
  manualCertificate?: (host: string) => Promise<MailCertificate | null>;
  /** Conferência TLS como a de um app (padrão: certificateStatus). */
  checkCertificate?: typeof certificateStatus;
  /** Resolver DNS (padrão: servidores públicos). */
  resolver?: DnsResolverLike;
  /**
   * Segunda opção da verificação de DNS quando o resolver não responde.
   * Padrão: o DNS do sistema (no container, o do Docker) — mas só quando o
   * resolver também é o padrão; com resolver injetado (testes), nenhum.
   */
  fallbackResolver?: DnsResolverLike | null;
  /** Envio SMTP do e-mail de teste (padrão: sendSmtpMail). */
  sendMail?: typeof sendSmtpMail;
  /** Leitura do aviso de entrega na caixa do remetente (padrão: findDeliveryReport). */
  findReport?: typeof findDeliveryReport;
  /** Relógio (ms) — limite de frequência e espera do e-mail de teste. */
  now?: () => number;
  /**
   * Projetos cadastrados, para dar dono à caixa que o painel adota do
   * Stalwart (endereço <slug>@ = caixa do projeto). Ausente ou com erro: as
   * caixas entram sem dono. Também diz quais projetos ainda existem: registro
   * de e-mail de projeto que não está na lista é órfão (projeto apagado) e é
   * solto. Ausente ou com erro: nada é considerado órfão.
   */
  projects?: () => Promise<Array<Pick<Project, "id" | "slug"> & { name?: string }>>;
}

/** E-mail de teste em acompanhamento (só em memória: some ao reiniciar o painel). */
interface TestEmailRecord {
  status: MailTestStatus;
  envId: string;
  /** Quando a mensagem deixou de aparecer na fila sem aviso de entrega (ms). */
  goneSince: number | null;
}

/** No máximo 1 e-mail de teste a cada 30 s e 20 por hora (por instância do painel). */
const TEST_MIN_INTERVAL_MS = 30_000;
const TEST_MAX_PER_HOUR = 20;
/** Teto por dia: o teste só vai a endereços digitados por quem está logado, e não vira canal de envio em massa. */
const TEST_MAX_PER_DAY = 60;
/**
 * Espera pelo aviso de entrega depois que a mensagem sai da fila. O Stalwart
 * enfileira o aviso ANTES de remover a mensagem e a entrega local é imediata;
 * se nada chegar nesse tempo, "saiu da fila sem erro" vale como entregue.
 */
const TEST_REPORT_GRACE_MS = 20_000;
/** Testes acompanhados ficam guardados por 1 hora. */
const TEST_KEEP_MS = 60 * 60 * 1000;

export type TlsSyncResult = "none" | "reloaded" | "restarted";

/** Resultado de removeDomain: caixas cuja remoção REMOTA falhou (a remoção
 * do domínio prossegue mesmo assim — ver removeDomain). */
export interface RemoveDomainResult {
  mailboxDeleteFailures: string[];
}

/** Reparos da senha de administração em andamento, por pasta de dados. */
const REPAIRS_IN_FLIGHT = new Map<string, Promise<"ok" | "repaired" | "failed" | "unreachable" | "not_running">>();

/**
 * Reinícios do Stalwart por pasta de dados: um de cada vez, e quem pede enquanto
 * outro ainda ESPERA para começar entra no mesmo (cadastros simultâneos, a
 * sincronização do TLS e o reparo da senha não reiniciam o servidor em cima um do outro).
 */
const RESTARTS = new Map<string, { tail: Promise<void>; waiting: Promise<void> | null }>();

export class MailService {
  private readonly mailDir: string;
  private readonly mailFile: string;
  private readonly audit: MailAuditSink | undefined;
  private readonly log: (message: string, meta?: Record<string, unknown>) => void;
  private readonly inContainer: boolean;
  private readonly readCertificate: (host: string) => Promise<MailCertificate | null>;
  private readonly checkCertificate: typeof certificateStatus;
  private readonly manualCertificate: ((host: string) => Promise<MailCertificate | null>) | undefined;
  private readonly resolverOverride: DnsResolverLike | undefined;
  private readonly fallbackOverride: DnsResolverLike | null | undefined;
  private readonly sendMail: typeof sendSmtpMail;
  private readonly findReport: typeof findDeliveryReport;
  private readonly now: () => number;
  private readonly projectsOf: (() => Promise<Array<Pick<Project, "id" | "slug"> & { name?: string }>>) | undefined;
  private adopting: Promise<MailAdoptResult> | null = null;
  /** Fila por caixa: trocar a senha e realinhá-la no servidor nunca se cruzam. */
  private readonly mailboxLocks = new Map<string, Promise<unknown>>();
  private readonly tests = new Map<string, TestEmailRecord>();
  /** Horário (ms) de cada tentativa de envio de teste na última hora. */
  private testAttempts: number[] = [];
  private data: MailFile = structuredClone(EMPTY_FILE);
  private loadedPromise: Promise<void> | null = null;
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
    this.manualCertificate = opts.manualCertificate;
    this.resolverOverride = opts.resolver;
    this.fallbackOverride = opts.fallbackResolver;
    this.sendMail = opts.sendMail ?? sendSmtpMail;
    this.findReport = opts.findReport ?? findDeliveryReport;
    this.now = opts.now ?? Date.now;
    this.projectsOf = opts.projects;
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

  /** Projetos com e-mail habilitado (os que alcançam o Stalwart pela rede de e-mail). */
  async emailProjectIds(): Promise<string[]> {
    await this.ensureLoaded();
    return Object.keys(this.data.projects);
  }

  /**
   * Migração (A4), parte 1: liga o Stalwart que já roda às redes novas
   * (administração e e-mail) sem reiniciá-lo, e o painel à da administração.
   * Servidor nunca criado: nada a fazer.
   */
  async joinMailNetworks(): Promise<void> {
    await this.ensureLoaded();
    if (!this.data.adminSecret) return;
    await this.manager().joinMailNetworks();
    await this.ensureNetworkAccess();
  }

  /** Migração (A4), parte 2: tira o Stalwart da paas-net dos projetos. */
  async leaveProjectNetwork(): Promise<void> {
    await this.ensureLoaded();
    if (!this.data.adminSecret) return;
    await this.manager().leaveProjectNetwork();
  }

  private resolver(): DnsResolverLike {
    return this.resolverOverride ?? publicResolver();
  }

  // -------------------------------------------------------------------------
  // Persistência
  // -------------------------------------------------------------------------

  /**
   * Carga única e compartilhada. Com a flag marcada antes de ler, uma segunda
   * chamada seguia com os dados vazios: podia gerar outra senha de admin do
   * Stalwart e gravar o mail.json inteiro por cima do de verdade.
   */
  private ensureLoaded(): Promise<void> {
    // mail.json guarda a senha de admin do Stalwart: erro de leitura (ou
    // arquivo ilegível) falha a carga em vez de gerar outra senha por cima.
    this.loadedPromise ??= (async () => {
      this.data = await loadJson<MailFile>(this.mailFile, {
        empty: () => structuredClone(EMPTY_FILE),
        parse: (value) =>
          typeof value === "object" && value !== null && !Array.isArray(value)
            ? { ...structuredClone(EMPTY_FILE), ...(value as Partial<MailFile>) }
            : null,
        strict: true,
      });
      this.backfillProjectNames();
    })().catch((err: unknown) => {
      this.loadedPromise = null;
      throw err;
    });
    return this.loadedPromise;
  }

  /**
   * Projeto ativado ANTES do nome de exibição por caixa: o nome vivia só em projects[].fromName. Copia-o para a
   * caixa de envio que ainda não tem nome (a lista e o modal mostram o nome efetivo). Em memória e idempotente;
   * nunca sobrescreve um nome já existente. O Stalwart recebe o nome no próximo Sincronizar (pushProjectNames).
   */
  private backfillProjectNames(): void {
    for (const project of Object.values(this.data.projects)) {
      const box = this.data.mailboxes[project.mailbox];
      const name = sanitizeDisplayName(project.fromName);
      if (box && !box.displayName && name) box.displayName = name;
    }
  }

  /**
   * Grava no Stalwart o nome da caixa de envio dos projetos antigos (ver backfillProjectNames) quando o servidor
   * ainda não tem nome nenhum nela. Nunca sobrescreve um nome que o Stalwart já tenha; falha só vai para o log.
   */
  private async pushProjectNames(client: StalwartClient, principals: readonly { name: string; description?: string }[]): Promise<void> {
    const described = new Map(principals.map((p) => [p.name.trim().toLowerCase(), p.description]));
    for (const project of Object.values(this.data.projects)) {
      const box = this.data.mailboxes[project.mailbox];
      if (!box?.displayName || !described.has(box.id) || described.get(box.id)) continue;
      try {
        await this.withMailboxLock(box.id, () => client.setMailboxDisplayName(box.id, box.displayName!));
      } catch (err) {
        this.log(`não deu para gravar o nome de exibição de ${box.id} no servidor de e-mail`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Grava o estado em memória de AGORA, na fila do arquivo e de forma
   * atômica: gravações nunca se intercalam nem terminam fora de ordem (uma
   * versão mais velha chegando por último).
   */
  private async save(): Promise<void> {
    await withFileLock(this.mailFile, () => writeFileAtomic(this.mailFile, JSON.stringify(this.data, null, 2) + "\n"));
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
   * Domínio dos avisos de entrega e relatórios do Stalwart (report.domain):
   * o domínio cadastrado a que o hostname pertence (o mais específico), ou o
   * 1º domínio quando o hostname é de fora (PAAS_MAIL_HOSTNAME). Precisa ser
   * cadastrado: é ele que tem a chave DKIM rsa-<domínio> e o SPF desta VPS.
   * Sem domínio: null (vale o padrão do Stalwart).
   */
  private reportDomain(): string | null {
    const host = this.hostname();
    const domains = Object.keys(this.data.domains);
    const owner = domains
      .filter((d) => host === d || host.endsWith(`.${d}`))
      .sort((a, b) => b.length - a.length)[0];
    return owner ?? domains[0] ?? null;
  }

  /** Impressão digital do config.toml que o Stalwart leria agora (ver AppliedTls.config). */
  private configFingerprint(certificates: MailCertificate[]): string {
    return stalwartConfigFingerprint({
      hostname: this.hostname(),
      certificateHosts: certificates.map((c) => c.host),
      reportDomain: this.reportDomain(),
      sendHook: this.sendHook(),
    });
  }

  /**
   * Aviso de envio SMTP ao painel (MTA hook do Stalwart; ver SendHookConfig).
   * Só com o painel em container: o Stalwart alcança `tws-panel` pela rede da
   * administração (a mesma da API) e a porta do aviso não é publicada nem
   * passa pelo Caddy. O segredo é derivado da senha de administração (HMAC),
   * então não há outro segredo para guardar, restaurar ou perder.
   */
  private sendHook(): SendHookConfig | null {
    const port = this.config.mailHookPort ?? 9100;
    if (!this.inContainer || !this.data.adminSecret || port <= 0) return null;
    return {
      url: `http://${PANEL_CONTAINER}:${port}/mail-hook/send`,
      secret: createHmac("sha256", this.data.adminSecret).update("paas-send-log-hook-v1").digest("hex"),
    };
  }

  /**
   * O ouvido do aviso pode subir? Só depende de o painel estar em container e
   * da porta: o segredo nasce quando o servidor de e-mail é criado (com o painel
   * já no ar), e até lá o ouvido responde 401 a tudo.
   */
  sendHookListenable(): boolean {
    return this.inContainer && (this.config.mailHookPort ?? 9100) > 0;
  }

  /** A captura de envios SMTP está configurada? (servidor criado, painel em container) */
  async sendHookConfigured(): Promise<boolean> {
    await this.ensureLoaded();
    return this.sendHook() !== null;
  }

  /** Confere (em tempo constante) o segredo que o Stalwart mandou no aviso de envio. */
  async verifySendHookSecret(provided: string): Promise<boolean> {
    await this.ensureLoaded();
    const hook = this.sendHook();
    if (!hook) return false;
    const a = createHmac("sha256", "cmp").update(provided).digest();
    const b = createHmac("sha256", "cmp").update(hook.secret).digest();
    return timingSafeEqual(a, b);
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
   * Política MTA-STS de cada domínio de e-mail: o proxy publica o texto em
   * https://mta-sts.<domínio>/.well-known/mta-sts.txt (o mesmo que a tela da saúde mostra).
   */
  async mtaStsSites(): Promise<Array<{ host: string; policy: string }>> {
    await this.ensureLoaded();
    return Object.keys(this.data.domains)
      .filter((d) => !d.endsWith(".localhost"))
      .map((d) => ({ host: mtaStsHostFor(d), policy: mtaStsServedPolicy(mailHostFor(d)) }));
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
      reportDomain: this.reportDomain(),
      sendHook: this.sendHook(),
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
        image: STALWART_IMAGE_REF,
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
  // Senha de administração: mail.json x config.toml do container
  // -------------------------------------------------------------------------

  /**
   * A senha de administração (`adminSecret`) mora em dois lugares: aqui, no
   * mail.json (o que o painel envia), e no config.toml DENTRO do container
   * (`fallback-admin`, o que o Stalwart aceita). Restaurar o e-mail devolve o
   * etc/ do servidor antigo; restaurar o painel devolve o mail.json do painel
   * antigo. Em qualquer ordem os dois lados podem divergir e toda chamada dá
   * 401 ("You have to authenticate first"). Esta conferência faz uma chamada
   * autenticada de leitura. A senha nunca vai para o log.
   */
  async checkAdminAuth(): Promise<"ok" | "mismatch" | "unreachable" | "not_running"> {
    await this.ensureLoaded();
    if (!this.data.adminSecret) return "not_running";
    if (!(await this.manager().status()).running) return "not_running";
    try {
      await this.client().listQueue(1);
      return "ok";
    } catch (err) {
      if (err instanceof StalwartApiError && (err.status === 401 || err.status === 403)) return "mismatch";
      return "unreachable";
    }
  }

  /**
   * Se a senha do painel não autentica no servidor em execução, regrava a
   * configuração com a senha do painel e reinicia o container (os dados ficam
   * no volume; nada é apagado). Servidor parado: não faz nada, porque o
   * próximo "Iniciar" já grava a configuração com a senha certa.
   */
  async repairAdminAuth(): Promise<"ok" | "repaired" | "failed" | "unreachable" | "not_running"> {
    // Um reparo por vez no processo (a subida do painel, o botão e o fim da restauração usam instâncias diferentes):
    // quem chega durante um reparo espera o mesmo resultado, e o Stalwart não reinicia duas vezes.
    const key = this.mailDir;
    const running = REPAIRS_IN_FLIGHT.get(key);
    if (running) return running;
    const run = this.doRepairAdminAuth().finally(() => REPAIRS_IN_FLIGHT.delete(key));
    REPAIRS_IN_FLIGHT.set(key, run);
    return run;
  }

  private async doRepairAdminAuth(): Promise<"ok" | "repaired" | "failed" | "unreachable" | "not_running"> {
    await this.ensureLoaded();
    // Logo depois de um start (restauração do e-mail) a API ainda está subindo: espera até responder (401 também vale).
    if (this.data.adminSecret && (await this.manager().status()).running) {
      await this.manager().waitReady(30_000).catch(() => undefined);
    }
    const before = await this.checkAdminAuth();
    if (before !== "mismatch") return before;
    // Sincronizar, o botão e a subida do painel usam este método: o erro cru do Docker (stderr, que pode
    // ecoar a configuração com a senha) vira aqui, num lugar só, o erro limpo e mascarado.
    try {
      await this.requestRestart();
    } catch (err) {
      throw mailAuthRepairIncompleteError(err, this.data.adminSecret ?? null);
    }
    return (await this.checkAdminAuth()) === "ok" ? "repaired" : "failed";
  }

  // -------------------------------------------------------------------------
  // Certificado do servidor de e-mail (mail.<domínio>)
  // -------------------------------------------------------------------------

  /**
   * Certificado de cada host de e-mail: o manual (página Certificados), se
   * houver, senão o que o Caddy emitiu.
   */
  private async currentCertificates(): Promise<MailCertificate[]> {
    const found = await Promise.all(
      this.hostList().map(
        async (h) => (await this.manualCertificate?.(h).catch(() => null)) ?? this.readCertificate(h),
      ),
    );
    return found.filter((c): c is MailCertificate => c !== null);
  }

  private tlsState(certificates: MailCertificate[]): AppliedTls {
    return {
      hostname: this.hostname(),
      aliases: this.hostList(),
      certificates: Object.fromEntries(certificates.map((c) => [c.host, c.fingerprint])),
      config: this.configFingerprint(certificates),
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
    await this.ensureDmarcAliases();

    const wanted = this.tlsState(certificates);
    const applied = this.data.tls ?? null;
    // "Mesmos nomes" inclui a mesma configuração: chave nova no config.toml
    // (atualização do painel) só vale reiniciando — o reload não relê o arquivo.
    const sameNames =
      applied !== null &&
      applied.hostname === wanted.hostname &&
      applied.config === wanted.config &&
      Object.keys(applied.certificates).sort().join(",") === Object.keys(wanted.certificates).sort().join(",");
    const sameContent =
      sameNames &&
      Object.entries(wanted.certificates).every(([h, fp]) => applied.certificates[h] === fp) &&
      applied.aliases.join(",") === wanted.aliases.join(",");
    const dkimPending = this.dkimPendingDomains().length > 0;
    if (sameContent && !dkimPending) return { result: "none", certificates };

    // Nome novo, outra configuração ou chave DKIM ainda não carregada: só reiniciando (fila única de reinícios).
    if (!sameNames || dkimPending) {
      await this.requestRestart(certificates);
      return { result: "restarted", certificates };
    }
    const result = await this.manager(certificates).applyTls({ restart: false });
    this.data.tls = wanted;
    await this.save();
    return { result, certificates };
  }

  /**
   * Domínios cadastrados antes de 04/10/2026: o DMARC deles manda os
   * relatórios para dmarc@<domínio>, que não existia (os provedores
   * recebiam "usuário desconhecido"). Acrescenta dmarc@ como endereço da
   * postmaster@, conferindo antes no Stalwart (idempotente). Falha fica no
   * log e é tentada de novo na próxima sincronização; não trava o TLS.
   */
  private async ensureDmarcAliases(): Promise<void> {
    const pending = Object.values(this.data.domains).filter((d) => !d.dmarcAlias);
    if (pending.length === 0) return;
    let changed = false;
    for (const domain of pending) {
      const dmarc = `dmarc@${domain.name}`;
      const postmaster = `postmaster@${domain.name}`;
      try {
        // Caixa própria dmarc@ (criada antes da reserva): os relatórios já chegam nela.
        if (!this.data.mailboxes[dmarc]) {
          const client = this.client();
          const emails = await client.mailboxEmails(postmaster);
          if (!emails.includes(dmarc)) await client.addMailboxAlias(postmaster, dmarc);
        }
        domain.dmarcAlias = true;
        changed = true;
      } catch (err) {
        this.log(`E-mail: não deu para acrescentar ${dmarc} à ${postmaster}; tento de novo na próxima sincronização.`, {
          domain: domain.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (changed) await this.save();
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

  // -------------------------------------------------------------------------
  // Página Envios (fila, remetentes, listas de bloqueio, nota). Só leitura do
  // estado e repasse ao cliente do Stalwart; a regra fica nos serviços
  // mail-envios-service.ts e mail-reputation-service.ts.
  // -------------------------------------------------------------------------

  /** O servidor de e-mail já foi criado (há senha de administrador)? */
  async enviosServerCreated(): Promise<boolean> {
    await this.ensureLoaded();
    return Boolean(this.data.adminSecret);
  }

  /** A fila do Stalwart (até `limit` mensagens), com o id como texto. */
  async enviosQueue(limit = 200): Promise<{ items: QueueMessageRaw[]; total: number }> {
    await this.ensureLoaded();
    await this.ensureNetworkAccess();
    return this.client().listQueue(limit);
  }

  /** "Tentar agora" (ver StalwartClient.retryQueuedMessage: é a última tentativa). */
  async enviosRetry(id: string): Promise<boolean> {
    await this.ensureLoaded();
    await this.ensureNetworkAccess();
    return this.client().retryQueuedMessage(id);
  }

  /** "Cancelar": tira a mensagem da fila. */
  async enviosCancel(id: string): Promise<boolean> {
    await this.ensureLoaded();
    await this.ensureNetworkAccess();
    return this.client().cancelQueuedMessage(id);
  }

  /**
   * Endereços que enviam por este servidor → caixa e projeto. Inclui os
   * endereços extras que o painel cria: abuse@ e dmarc@ (da postmaster@) e o
   * endereço de envio antigo de projeto (alias da caixa técnica).
   */
  async enviosSenders(): Promise<Array<{ address: string; mailbox: string; projectId: string | null; system: boolean }>> {
    await this.ensureLoaded();
    const senderOf = new Map(Object.entries(this.data.projects).map(([id, p]) => [p.mailbox, id]));
    const out: Array<{ address: string; mailbox: string; projectId: string | null; system: boolean }> = [];
    for (const m of Object.values(this.data.mailboxes)) {
      const projectId = m.projectId ?? senderOf.get(m.id) ?? null;
      const system = m.kind === "system";
      out.push({ address: m.id, mailbox: m.id, projectId, system });
      if (system && m.localPart === "postmaster") {
        for (const extra of ["abuse", "dmarc"]) {
          out.push({ address: `${extra}@${m.domain}`, mailbox: m.id, projectId: null, system: true });
        }
      }
    }
    for (const [projectId, p] of Object.entries(this.data.projects)) {
      if (p.fromAddress && p.fromAddress !== p.mailbox) {
        out.push({ address: p.fromAddress, mailbox: p.mailbox, projectId, system: false });
      }
    }
    return out;
  }

  /** O que conferir nas listas de bloqueio: o IP público e os domínios. */
  async enviosBlacklistTargets(): Promise<{ ip: string; domains: string[] }> {
    await this.ensureLoaded();
    return { ip: this.serverIp(), domains: Object.keys(this.data.domains) };
  }

  /**
   * Fatos para a nota de entregabilidade: a verificação de DNS de cada
   * domínio (com o PTR) e o certificado do servidor. O que falhar fica como
   * "não verificado" (null), nunca como certo.
   */
  async enviosDeliverabilityFacts(): Promise<{
    domains: Array<{ name: string; dnsOk: number | null; dnsTotal: number | null; ptr: DnsVerifyResponse["ptr"]["status"] | null }>;
    tls: { ok: number; total: number } | null;
  }> {
    await this.ensureLoaded();
    const domains = [];
    for (const name of Object.keys(this.data.domains)) {
      try {
        const v = await this.verifyDomain(name);
        domains.push({ name, dnsOk: v.summary.ok, dnsTotal: v.summary.total, ptr: v.ptr.status });
      } catch {
        domains.push({ name, dnsOk: null, dnsTotal: null, ptr: null });
      }
    }
    let tls: { ok: number; total: number } | null = null;
    try {
      const status = await this.tlsStatus();
      tls = { ok: status.hosts.filter((h) => h.ok).length, total: status.hosts.length };
    } catch {
      tls = null;
    }
    return { domains, tls };
  }

  private summaryOf(domain: StoredDomain): MailDomainSummary {
    const mailboxCount = Object.values(this.data.mailboxes).filter(
      (m) => m.domain === domain.name,
    ).length;
    const { dmarcAlias: _migrated, ...summary } = domain;
    return { ...summary, mailboxCount };
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
      dmarcAlias: true,
      dkimRestartPending: true,
    };
    this.data.domains[domain] = stored;

    // Boas práticas (spec §3): postmaster@ e abuse@ funcionais; dmarc@ é o
    // destino dos relatórios DMARC (rua= do checklist) e cai na mesma caixa.
    const postmaster = `postmaster@${domain}`;
    const password = generatePassword();
    await client.createMailbox(postmaster, password, [`abuse@${domain}`, `dmarc@${domain}`]);
    this.data.mailboxes[postmaster] = {
      id: postmaster,
      localPart: "postmaster",
      domain,
      kind: "system",
      createdAt: now,
      password,
    };

    await this.save();
    await this.restartToActivateDkim([domain]);
    return this.summaryOf(stored);
  }

  /**
   * O Stalwart v0.11.8 só passa a assinar com uma chave DKIM nova depois de
   * reiniciar: GET /api/reload não a carrega (conferido em Docker real,
   * packages/mailer/tests/stalwart-deliverability.integration.test.ts: sem o
   * reinício a mensagem sai SEM DKIM-Signature). Por isso cadastrar um domínio
   * ou adotar um que já tem chave criada agora reinicia o servidor (alguns
   * segundos; a fila fica no volume), numa fila única de reinícios. Falha não
   * desfaz o cadastro: o domínio fica marcado como "reinício pendente" (o
   * painel de saúde mostra atenção, não "ok"), vai para o log e a próxima
   * sincronização do servidor tenta de novo. Devolve os domínios ainda pendentes.
   */
  private async restartToActivateDkim(domains: string[]): Promise<string[]> {
    try {
      await this.requestRestart();
    } catch (err) {
      this.log(`E-mail: não deu para reiniciar o servidor para ativar o DKIM de ${domains.join(", ")}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return domains.filter((d) => this.data.domains[d]?.dkimRestartPending);
  }

  private dkimPendingDomains(): string[] {
    return Object.values(this.data.domains).filter((d) => d.dkimRestartPending).map((d) => d.name);
  }

  /** Pede um reinício: um de cada vez, e quem chega enquanto outro ainda espera para começar entra nele. */
  private requestRestart(known?: MailCertificate[]): Promise<void> {
    const slot = RESTARTS.get(this.mailDir) ?? { tail: Promise.resolve(), waiting: null };
    RESTARTS.set(this.mailDir, slot);
    if (slot.waiting) return slot.waiting;
    const waiting = slot.tail
      .catch(() => undefined)
      .then(async () => {
        slot.waiting = null; // a partir daqui, quem pedir precisa de OUTRO reinício
        await this.restartNow(known);
      });
    slot.waiting = waiting;
    slot.tail = waiting;
    return waiting;
  }

  private async restartNow(known?: MailCertificate[]): Promise<void> {
    const covered = this.dkimPendingDomains();
    const certificates = known ?? (await this.currentCertificates());
    const manager = this.manager(certificates);
    await manager.applyTls({ restart: true });
    await manager.waitReady();
    this.data.tls = this.tlsState(certificates);
    for (const name of covered) delete this.data.domains[name]?.dkimRestartPending;
    await this.save();
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
      // Um IP tem um nome reverso só: o PTR esperado é o nome com que o
      // servidor se apresenta (HELO), o mesmo em todos os domínios.
      serverHostname: this.hostname(),
      serverIp: this.serverIp(),
      serverIpv6: this.config.publicIpv6,
      dkimSelector: domain.dkimSelector,
      dkimPublicKey: domain.dkimPublicKey,
      dmarcStage: domain.dmarcStage,
    });
  }

  /**
   * Dados do domínio para o plano de registros e a saúde de entregabilidade
   * (mail-health-service.ts). Só leitura do cadastro: a chave DKIM é a pública.
   */
  async healthPlanInput(name: string): Promise<PlanInput> {
    await this.ensureLoaded();
    const domain = this.requireDomain(name);
    return {
      domain: domain.name,
      mailHostname: mailHostFor(domain.name),
      serverHostname: this.hostname(),
      serverIp: this.serverIp(),
      serverIpv6: this.config.publicIpv6,
      dkimSelector: domain.dkimSelector,
      dkimPublicKey: domain.dkimPublicKey,
      dmarcStage: domain.dmarcStage,
      ...(domain.dkimRestartPending ? { dkimRestartPending: true } : {}),
    };
  }

  async verifyDomain(name: string): Promise<DnsVerifyResponse> {
    const checklist = await this.dnsChecklist(name);
    // O resolver injetado (testes) vale também aqui; o padrão segue sendo o
    // público, com o DNS do sistema como segunda opção quando ele não responde.
    const fallback =
      this.fallbackOverride !== undefined ? this.fallbackOverride : this.resolverOverride ? null : systemResolver();
    const result = await verifyDnsRecords(checklist, this.resolver(), { fallback, log: (m) => this.log(m) });
    const domain = this.requireDomain(name);
    domain.lastVerify = {
      at: new Date().toISOString(),
      ok: result.summary.ok,
      total: result.summary.total,
      // sem o PTR (recomendação): o roteiro de primeiros passos se guia por isto
      recordsOk: result.records.filter((r) => !r.optional).every((r) => r.status === "found"),
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

  /**
   * Caixas do domínio, cada uma com o projeto dono quando tem. Com
   * `projectId`, só as daquele projeto (aba Caixas do e-mail do projeto).
   * Caixa antiga sem dono gravado: a de envio de um projeto conta como dele.
   */
  async listMailboxes(domainName: string, opts: { projectId?: string } = {}): Promise<Mailbox[]> {
    await this.ensureLoaded();
    await this.purgeOrphanProjects();
    const domain = normalizeMailDomain(domainName);
    const senderOf = new Map(Object.entries(this.data.projects).map(([id, p]) => [p.mailbox, id]));
    return Object.values(this.data.mailboxes)
      .filter((m) => m.domain === domain)
      .map((stored): Mailbox => {
        const { password } = stored;
        const mailbox = publicMailbox(stored);
        const owner = mailbox.projectId ?? senderOf.get(mailbox.id);
        const out: Mailbox = owner ? { ...mailbox, projectId: owner } : mailbox;
        return password === "" ? { ...out, passwordUnknown: true } : out;
      })
      .filter((m) => opts.projectId === undefined || m.projectId === opts.projectId);
  }

  /**
   * Cria a caixa com a senha que a PESSOA definiu. O painel guarda a senha
   * (precisa dela para o e-mail de teste e para os projetos), mas nunca a
   * devolve pela API: quem esqueceu troca (changeMailboxPassword).
   */
  async createMailbox(
    domainName: string,
    localPart: string,
    password: string | undefined,
    opts: { generate?: boolean; projectId?: string; displayName?: string } = {},
  ): Promise<{ mailbox: Mailbox; generatedPassword?: string }> {
    await this.ensureLoaded();
    const domain = this.requireDomain(domainName);
    const local = normalizeLocalPart(localPart);
    const displayName = requireDisplayName(opts.displayName);
    const email = `${local}@${domain.name}`;
    if (this.data.mailboxes[email]) {
      throw httpError(409, "mailbox_exists", `A caixa ${email} já existe.`);
    }
    if (SYSTEM_LOCAL_PARTS.has(local)) {
      throw httpError(
        409,
        "mailbox_exists",
        `O endereço ${email} já existe: ele entrega na caixa postmaster@${domain.name}, que o painel cria com o domínio.`,
      );
    }
    // senha da pessoa ou, com `generate`, uma forte devolvida uma única vez
    const generated = opts.generate ? generateStrongPassword() : undefined;
    const finalPassword = generated ?? requireStrongPassword(password);
    await this.requireRunning();
    await this.client().createMailbox(email, finalPassword, [], displayName || undefined);

    const stored: StoredMailbox = {
      id: email,
      localPart: local,
      domain: domain.name,
      kind: "user",
      createdAt: new Date().toISOString(),
      ...(displayName ? { displayName } : {}),
      // criada pela aba Caixas do e-mail do projeto: a caixa é dele
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      password: finalPassword,
    };
    this.data.mailboxes[email] = stored;
    await this.save();
    const mailbox = publicMailbox(stored);
    return generated ? { mailbox, generatedPassword: generated } : { mailbox };
  }

  /**
   * Troca a senha de uma caixa (quem esqueceu a senha troca — ela nunca é
   * mostrada). Vale também para a caixa de um projeto: o projeto recebe a
   * senha nova no próximo deploy. Com `generate`, o painel gera uma senha
   * forte e a devolve uma única vez.
   */
  async changeMailboxPassword(
    id: string,
    password: string | undefined,
    opts: { generate?: boolean } = {},
  ): Promise<{ mailbox: Mailbox; generatedPassword?: string }> {
    await this.ensureLoaded();
    const email = decodeURIComponent(id).toLowerCase();
    const stored = this.data.mailboxes[email];
    if (!stored) {
      throw httpError(404, "mailbox_not_found", `Caixa ${email} não encontrada.`);
    }
    const generated = opts.generate ? generateStrongPassword() : undefined;
    const finalPassword = generated ?? requireStrongPassword(password);
    await this.requireRunning();
    await this.withMailboxLock(email, async () => {
      await this.client().setMailboxMainPassword(email, finalPassword);
      stored.password = finalPassword;
    });
    await this.save();
    const mailbox = publicMailbox(stored);
    return generated ? { mailbox, generatedPassword: generated } : { mailbox };
  }

  /**
   * Altera (ou, vazio, remove) o nome de exibição de uma caixa: grava no
   * Stalwart (campo `description` do principal) e no cadastro do painel. Só
   * esse campo muda — senha, 2FA, senhas de app, aliases e mensagens ficam
   * como estão. Com `projectId`, a caixa precisa ser daquele projeto (a aba do
   * projeto não edita caixa de outro). Na caixa de envio de um projeto o nome é
   * o do MAIL_FROM_NAME (vazio volta ao nome do projeto) e vale no próximo
   * deploy: o painel não faz deploy sozinho.
   */
  async setMailboxDisplayName(
    id: string,
    displayNameInput: string,
    opts: { projectId?: string; projectName?: (projectId: string) => Promise<string | undefined> } = {},
  ): Promise<SetMailboxDisplayNameResponse> {
    await this.ensureLoaded();
    const requested = requireDisplayName(displayNameInput);
    const email = decodeURIComponent(id).toLowerCase();
    const stored = this.data.mailboxes[email];
    if (!stored) {
      throw httpError(404, "mailbox_not_found", `Caixa ${email} não encontrada.`);
    }
    const sender = Object.entries(this.data.projects).find(([, p]) => p.mailbox === email);
    const owner = stored.projectId ?? sender?.[0];
    if (opts.projectId !== undefined && owner !== opts.projectId) {
      throw httpError(403, "mailbox_not_in_project", `A caixa ${email} não é deste projeto.`);
    }
    // caixa de envio do projeto: sem nome, vale o nome do projeto (como na ativação)
    const projectId = sender?.[0];
    let name = requested;
    if (projectId !== undefined && name === "") {
      name = sanitizeDisplayName((await opts.projectName?.(projectId)) ?? "");
    }
    await this.requireRunning();
    await this.withMailboxLock(email, async () => {
      await this.client().setMailboxDisplayName(email, name);
      if (name) stored.displayName = name;
      else delete stored.displayName;
      if (sender) {
        // só para o deploy: sem nome guardado, o deploy usa o nome do projeto
        if (name) sender[1].fromName = name;
        else delete sender[1].fromName;
      }
    });
    await this.save();
    await this.audit?.record({
      action: "mail.mailbox.display-name",
      target: email,
      detail: name
        ? `Nome de exibição da caixa de e-mail ${email} alterado.`
        : `Nome de exibição da caixa de e-mail ${email} removido.`,
    });
    const { password, ...mailbox } = stored;
    const out: Mailbox = {
      ...mailbox,
      ...(mailbox.projectId === undefined && owner !== undefined ? { projectId: owner } : {}),
      ...(password === "" ? { passwordUnknown: true } : {}),
    };
    return projectId !== undefined
      ? { mailbox: out, projectEmail: { projectId, appliesOnNextDeploy: true } }
      : { mailbox: out };
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
      throw httpError(409, "mailbox_in_use", "Esta caixa está em uso por um projeto. Desative o e-mail do projeto antes.");
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
      host: `mail.${stored.domain}`,
      ports: this.config.mailPorts,
    });
  }

  // -------------------------------------------------------------------------
  // Adoção: cadastrar no painel o que o Stalwart já tem (depois de restaurar)
  // -------------------------------------------------------------------------

  /**
   * O painel lista domínios e caixas do SEU cadastro (mail.json), não do
   * Stalwart. Depois de restaurar o backup do e-mail, o Stalwart volta com o
   * que havia e o cadastro não sabe. Lê o Stalwart (domínios e caixas) e
   * cadastra o que falta. Regras:
   *  - nada é ativado; o que já está cadastrado não muda;
   *  - nenhuma senha é lida, guardada ou mostrada (o `secrets` da resposta é
   *    descartado no cliente); a caixa adotada fica sem senha conhecida;
   *  - o domínio entra com o DNS "não verificado";
   *  - chamadas simultâneas viram uma só; repetir não duplica.
   * Falha do Stalwart (401, fora do ar) sobe como está e não apaga nada.
   */
  adoptFromStalwart(): Promise<MailAdoptResult> {
    this.adopting ??= this.doAdoptRepairing().finally(() => {
      this.adopting = null;
    });
    return this.adopting;
  }

  /**
   * 401/403 do Stalwart na leitura: a senha do mail.json não é a do servidor
   * em execução (acontece depois de restaurar). Tenta UMA vez o reparo da
   * senha de administração (o mesmo do botão Reparar agora: regrava a
   * configuração e reinicia, sem apagar dados; coalescido entre instâncias) e
   * repete a leitura. Se continuar falhando, devolve o erro dizendo o que foi
   * tentado. Senha certa: nada é reiniciado.
   */
  private async doAdoptRepairing(): Promise<MailAdoptResult> {
    try {
      return await this.doAdopt();
    } catch (err) {
      if (!(err instanceof StalwartApiError) || (err.status !== 401 && err.status !== 403)) throw err;
    }
    let repair: Awaited<ReturnType<MailService["repairAdminAuth"]>>;
    try {
      repair = await this.repairAdminAuth();
    } catch (err) {
      // O reparo parou no meio (o erro já vem mascarado de doRepairAdminAuth; outro erro é mascarado aqui).
      const incomplete = (err as { code?: string }).code === "mail_auth_repair_incomplete" ? (err as Error) : mailAuthRepairIncompleteError(err, this.data.adminSecret ?? null);
      this.log(`Sincronizar: ${incomplete.message}`);
      throw incomplete;
    }
    if (repair === "repaired" || repair === "ok") {
      try {
        return await this.doAdopt();
      } catch (err) {
        if (!(err instanceof StalwartApiError) || (err.status !== 401 && err.status !== 403)) throw err;
        throw mailAuthRepairFailedError(repair === "ok" ? "ok" : "failed");
      }
    }
    throw mailAuthRepairFailedError(repair);
  }

  private async doAdopt(): Promise<MailAdoptResult> {
    await this.ensureLoaded();
    await this.purgeOrphanProjects();
    const client = this.client();
    await this.requireRunning();
    const domainList = await client.listPrincipalsChecked("domain");
    const mailboxList = await client.listPrincipalsChecked("individual");
    const domainPrincipals = domainList.items;
    const mailboxPrincipals = mailboxList.items;
    const truncated = domainList.truncated || mailboxList.truncated;
    let projects: Array<Pick<Project, "id" | "slug">> = [];
    try {
      projects = (await this.projectsOf?.()) ?? [];
    } catch {
      // sem a lista de projetos as caixas entram sem dono
    }
    const plan = planAdoption({
      domains: domainPrincipals.map((p) => p.name),
      mailboxes: mailboxPrincipals,
      knownDomains: new Set(Object.keys(this.data.domains)),
      knownMailboxes: new Set(Object.keys(this.data.mailboxes)),
      projects,
      projectDomains: new Map(Object.entries(this.data.projects).map(([id, p]) => [id, p.domain])),
    });

    // O domínio precisa da chave DKIM pública para o checklist de DNS. Sem ela, não entra (nem as caixas dele).
    const dkim = new Map<string, string>();
    const createdKeys = new Set<string>();
    const skipped = [...plan.skipped];
    for (const name of plan.domains) {
      try {
        const read = await this.readOrCreateDkim(client, name);
        dkim.set(name, read.key);
        if (read.created) createdKeys.add(name);
      } catch (err) {
        if (err instanceof StalwartApiError && (err.status === 401 || err.status === 403)) throw err;
        skipped.push(name);
      }
    }
    // O DMARC do checklist manda relatórios para dmarc@: o domínio adotado só fica sem a marca (a rotina horária
    // acrescenta o alias) quando a postmaster@ existe no Stalwart e dmarc@ ainda não recebe; sem postmaster@
    // não há onde pôr o alias, e a rotina falharia no log a cada hora.
    const dmarcReceives = (domain: string): boolean => {
      const dmarc = `dmarc@${domain}`;
      const postmaster = `postmaster@${domain}`;
      const hasPostmaster = mailboxPrincipals.some((p) => p.name === postmaster);
      const dmarcDelivers = mailboxPrincipals.some((p) => p.name === dmarc || p.emails.includes(dmarc));
      return dmarcDelivers || !hasPostmaster;
    };
    // Nome de exibição que o Stalwart já tem (campo description): só entra se passa na mesma regra das telas.
    const descriptions = new Map<string, string>();
    for (const p of mailboxPrincipals) {
      const checked = normalizeDisplayName(p.description);
      if (checked.ok && checked.value) descriptions.set(p.name, checked.value);
    }
    const now = new Date().toISOString();
    const result: MailAdoptResult = { domains: [], mailboxes: [], skipped };
    for (const [name, dkimPublicKey] of dkim) {
      if (this.data.domains[name]) continue;
      this.data.domains[name] = {
        name,
        dkimSelector: DKIM_SELECTOR,
        dkimPublicKey,
        dkimKeyBits: 2048,
        dmarcStage: "none",
        createdAt: now,
        lastVerify: null,
        ...(dmarcReceives(name) ? { dmarcAlias: true } : {}),
        // chave criada agora: o Stalwart só assina com ela depois de reiniciar
        ...(createdKeys.has(name) ? { dkimRestartPending: true as const } : {}),
      };
      result.domains.push(name);
    }
    for (const box of plan.mailboxes) {
      if (!this.data.domains[box.domain]) {
        skipped.push(box.id);
        continue;
      }
      if (this.data.mailboxes[box.id]) continue;
      this.data.mailboxes[box.id] = {
        id: box.id,
        localPart: box.localPart,
        domain: box.domain,
        kind: box.kind,
        createdAt: now,
        ...(box.projectId ? { projectId: box.projectId } : {}),
        ...(descriptions.get(box.id) ? { displayName: descriptions.get(box.id)! } : {}),
        // sem senha conhecida: o Stalwart nunca a entrega, e o painel não a pede
        password: "",
      };
      result.mailboxes.push(box.id);
    }
    if (result.domains.length > 0 || result.mailboxes.length > 0) await this.save();
    await this.realignKnownPasswords(client, new Set(mailboxPrincipals.map((p) => p.name.trim().toLowerCase())), result);
    await this.pushProjectNames(client, mailboxPrincipals);
    if (result.domains.some((d) => createdKeys.has(d))) {
      const stillPending = await this.restartToActivateDkim(result.domains.filter((d) => createdKeys.has(d)));
      if (stillPending.length > 0) result.dkimRestartPending = stillPending;
    }
    if (skipped.length > MAIL_ADOPT_SKIPPED_MAX) {
      result.skippedTotal = skipped.length;
      result.skipped = skipped.slice(0, MAIL_ADOPT_SKIPPED_MAX);
    }
    if (truncated) result.truncated = true;
    return result;
  }

  /** Executa `fn` depois de tudo o que já está na fila da caixa (uma por vez, mesmo se uma etapa falhar). */
  private withMailboxLock<T>(email: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.mailboxLocks.get(email) ?? Promise.resolve()).catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.mailboxLocks.set(email, tail);
    void tail.then(() => {
      if (this.mailboxLocks.get(email) === tail) this.mailboxLocks.delete(email);
    });
    return run;
  }

  /**
   * Depois de restaurar o e-mail o Stalwart volta com a senha ANTIGA do backup nas caixas, e o painel segue
   * usando a que guardou: o envio de avisos falha com "535 5.7.8". Para as caixas que o painel gerencia
   * (sistema: postmaster@; projeto) e cuja senha ele conhece, o painel é a fonte da verdade.
   *
   * No Stalwart v0.11.8, GET /principal/<caixa> devolve a senha como foi enviada (texto puro). O painel COMPARA
   * em memória (StalwartClient.mailboxPasswordMatches; a senha do servidor nunca é guardada, logada nem
   * devolvida) e só regrava quando difere: não faz login errado (cada login errado leva ~5 s e ~100 por dia do
   * mesmo IP acionam o bloqueio automático do Stalwart, `server.auto-ban.auth.rate = 100/1d`, que corta até a API
   * de administração), a contagem é verdadeira e só se avisa quando de fato houve diferença. Se a leitura falha
   * ou não traz a senha (só hash), reaplica mesmo assim e conta à parte ("reaplicada, não verificada").
   *
   * Fica de fora: caixa de usuário (a pessoa pode ter trocado a senha no webmail), caixa sem senha conhecida,
   * caixa de domínio não cadastrado, caixa que o servidor não tem (404) e a removida do cadastro durante a
   * sincronização. Falha numa caixa não impede as outras. Nada reinicia; nenhuma senha vai a log, resposta ou
   * auditoria (só o endereço da caixa).
   */
  private async realignKnownPasswords(client: StalwartClient, present: ReadonlySet<string>, result: MailAdoptResult): Promise<void> {
    let realigned = 0;
    let reapplied = 0;
    const failed: string[] = [];
    for (const email of Object.keys(this.data.mailboxes)) {
      const box = this.data.mailboxes[email];
      // `box` some se a caixa foi removida do cadastro durante a sincronização
      if (!box || (box.kind !== "system" && box.kind !== "project") || !box.password || !present.has(email) || !this.data.domains[box.domain]) continue;
      try {
        // Dentro da fila da caixa, uma etapa de cada vez: `box` é o próprio registro, então a senha é lida só
        // quando chega a vez dela, e uma troca que já estava em andamento vale (nunca é desfeita).
        const outcome = await this.withMailboxLock(email, async (): Promise<"same" | "realigned" | "reapplied"> => {
          // removida do cadastro enquanto esperava a vez: nada a fazer
          if (this.data.mailboxes[email] !== box) return "same";
          let matches: boolean | null = null;
          try {
            matches = await client.mailboxPasswordMatches(email, box.password);
          } catch (err) {
            if (err instanceof StalwartApiError && err.status === 404) throw err;
            // leitura falhou: reaplica sem ter conferido
          }
          if (matches === true) return "same";
          // troca só a senha principal e preserva senhas de app e 2FA (se a caixa não pode ser lida, falha sem trocar)
          await client.setMailboxMainPassword(email, box.password);
          return matches === false ? "realigned" : "reapplied";
        });
        if (outcome === "realigned") realigned += 1;
        else if (outcome === "reapplied") reapplied += 1;
      } catch (err) {
        // caixa apagada no servidor durante a sincronização: fica de fora, não é falha
        if (err instanceof StalwartApiError && err.status === 404) continue;
        failed.push(email);
        this.log(`Sincronizar: não deu para realinhar a senha da caixa ${email} (${err instanceof StalwartApiError ? `HTTP ${err.status}` : "falha de conexão"}).`);
      }
    }
    if (realigned > 0) result.passwordsRealigned = realigned;
    if (reapplied > 0) result.passwordsReapplied = reapplied;
    if (failed.length > 0) result.passwordsFailed = failed.slice(0, MAIL_ADOPT_SKIPPED_MAX);
  }

  /** Chave pública DKIM do domínio no Stalwart; se a assinatura não existe, cria como no cadastro do domínio. */
  private async readOrCreateDkim(client: StalwartClient, domain: string): Promise<{ key: string; created: boolean }> {
    // só cria quando o Stalwart diz que NÃO existe; qualquer outra falha de leitura sobe (e o domínio fica de fora)
    const existing = await client.findDkimPublicKey(`rsa-${domain}`);
    if (existing !== null) return { key: existing, created: false };
    return { key: await client.getDkimPublicKey(await client.createDkimSignature(domain, DKIM_SELECTOR)), created: true };
  }

  // -------------------------------------------------------------------------
  // E-mail de teste (página do domínio)
  // -------------------------------------------------------------------------

  /**
   * Envia um e-mail de teste simples a partir de postmaster@<domínio>, pela
   * submission do próprio Stalwart (465, TLS), como os projetos fazem.
   *
   * Por que postmaster@: o painel cria essa caixa ao cadastrar o domínio e
   * já guarda a senha dela (mail.json, 0600) — a mesma que as credenciais e
   * a injeção SMTP usam. Não precisa de caixa nova nem de segredo novo. Ela
   * também recebe o aviso de entrega (DSN) que o Stalwart manda ao
   * remetente, e é por ele que o painel sabe se a mensagem foi aceita ou
   * recusada (testEmailStatus).
   */
  async sendTestEmail(domainName: string, recipient: string, sender?: string): Promise<MailTestStatus> {
    await this.ensureLoaded();
    const domain = this.requireDomain(domainName);
    const to = (recipient ?? "").trim().toLowerCase();
    if (!isSingleEmailAddress(to)) {
      throw httpError(400, "invalid_recipient", "Informe um endereço de e-mail válido (um só destinatário).");
    }
    // Qualquer caixa do domínio pode testar (ex.: logo depois de trocar a senha
    // dela); sem escolha, postmaster@.
    if (sender !== undefined) {
      const chosen = this.data.mailboxes[sender.trim().toLowerCase()];
      if (!chosen || chosen.domain !== domain.name) {
        throw httpError(404, "mailbox_not_found", `Caixa ${sender} não encontrada em ${domain.name}.`);
      }
    }
    const from = sender !== undefined ? sender.trim().toLowerCase() : `postmaster@${domain.name}`;
    const mailbox = this.data.mailboxes[from];
    if (!mailbox) {
      throw httpError(
        409,
        "test_mailbox_missing",
        `A caixa ${from} não está registrada no painel, e é dela que o teste sai. Remova e cadastre o domínio de novo para recriá-la.`,
      );
    }
    if (mailbox.password === "") throw noPasswordError(from);
    await this.requireRunning();
    this.takeTestSlot();

    // Da caixa de um projeto, o teste sai com o nome de exibição dele
    // (validação real: no Gmail aparecia só "cassino"); das demais, com o nome da própria caixa, se tiver.
    const owner = Object.values(this.data.projects).find((p) => p.mailbox === from);
    const fromName = sanitizeDisplayName(owner?.fromName ?? mailbox.displayName) || undefined;

    const id = randomBytes(8).toString("hex");
    // O ENVID é segredo do painel (só no envelope SMTP e na memória): quem recebe
    // o teste vê o id, o Message-ID e o texto, e não pode montá-lo para forjar
    // o recibo de entrega. O Message-ID usa só o id público.
    const envId = `tws-teste-${id}-${randomBytes(12).toString("hex")}`;
    const sentAt = new Date(this.now());
    try {
      await this.sendMail({
        // Pela paas-net, o nome do container; fora de container, a porta publicada.
        host: this.inContainer ? PAAS_STALWART_CONTAINER : "127.0.0.1",
        port: this.inContainer ? 465 : this.config.mailPorts.submissions,
        servername: mailHostFor(domain.name),
        username: mailbox.id,
        password: mailbox.password,
        from,
        ...(fromName ? { fromName } : {}),
        to,
        subject: "Teste do TWS Panel",
        text: testEmailText(domain.name, from, id, sentAt),
        envId,
        messageId: `<tws-teste-${id}@${domain.name}>`,
        date: sentAt,
      });
    } catch (err) {
      if (err instanceof SmtpSendError && err.command === "AUTH" && err.code >= 500 && err.code < 600) {
        throw httpError(409, "email_auth_rejected", mailSmtpAuthRejectedMessage(from));
      }
      throw httpError(
        502,
        "test_send_failed",
        `O servidor de e-mail não aceitou o teste: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const status: MailTestStatus = {
      id,
      domain: domain.name,
      from,
      to,
      sentAt: sentAt.toISOString(),
      checkedAt: sentAt.toISOString(),
      state: "queued",
      detail: null,
      nextRetryAt: null,
      confirmed: false,
      final: false,
    };
    this.forgetOldTests();
    this.tests.set(id, { status, envId, goneSince: null });
    return { ...status };
  }

  /**
   * Destino do e-mail de teste: enquanto está na fila, o estado vem da API
   * de administração (/api/queue/messages); quando sai, do aviso de entrega
   * na caixa postmaster@. Sem aviso depois de TEST_REPORT_GRACE_MS, conta
   * como entregue sem recibo (o Stalwart remove a mensagem da fila ao
   * concluir, e a recusa definitiva SEMPRE gera aviso ao remetente).
   */
  async testEmailStatus(domainName: string, id: string): Promise<MailTestStatus> {
    await this.ensureLoaded();
    const record = this.tests.get(id);
    if (!record || record.status.domain !== normalizeMailDomain(domainName)) {
      throw httpError(404, "test_not_found", "Teste não encontrado (o painel guarda os testes por 1 hora).");
    }
    const { status } = record;
    if (status.final) return { ...status };

    const now = this.now();
    let queued: QueuedMessage | undefined;
    try {
      await this.ensureNetworkAccess();
      queued = (await this.client().listQueuedMessages(status.to)).find((m) => m.env_id === record.envId);
    } catch (err) {
      throw httpError(
        502,
        "mail_queue_unavailable",
        `Não foi possível consultar a fila do servidor de e-mail: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (queued) {
      record.goneSince = null;
      const info = deliveryFromQueue(queued, status.to);
      Object.assign(status, info, {
        confirmed: info.state !== "queued",
        final: info.state === "delivered" || info.state === "bounced",
      });
    } else {
      const report = await this.readDeliveryReport(record);
      if (report && report.state !== "deferred") {
        Object.assign(status, { state: report.state, detail: report.detail, nextRetryAt: null, confirmed: true, final: true });
      } else {
        record.goneSince ??= now;
        if (now - record.goneSince >= TEST_REPORT_GRACE_MS) {
          Object.assign(status, {
            state: "delivered",
            detail: "A mensagem saiu da fila sem erro registrado, mas o servidor não mandou o recibo de entrega.",
            nextRetryAt: null,
            confirmed: false,
            final: true,
          });
        } else {
          Object.assign(status, { state: "queued", detail: null, nextRetryAt: null });
        }
      }
    }
    status.checkedAt = new Date(now).toISOString();
    return { ...status };
  }

  /** Aviso de entrega na caixa do remetente; falha na leitura conta como "sem aviso". */
  private async readDeliveryReport(record: TestEmailRecord): Promise<Awaited<ReturnType<typeof findDeliveryReport>>> {
    const { status } = record;
    const mailbox = this.data.mailboxes[status.from];
    if (!mailbox || mailbox.password === "") return null;
    try {
      return await this.findReport({
        baseUrl: this.apiBaseUrl(),
        username: mailbox.id,
        password: mailbox.password,
        to: status.to,
        // só o aviso desta mensagem (o de um teste anterior ao mesmo destino não serve)
        envId: record.envId,
        // O aviso sai do domínio dos relatórios (report.domain), que pode ser
        // outro domínio cadastrado, não o da caixa: passa todos os possíveis.
        senderDomains: [
          ...Object.keys(this.data.domains),
          this.hostname(),
          ...(this.reportDomain() ? [this.reportDomain()!] : []),
        ],
        // folga para diferença de relógio entre o painel e o Stalwart
        since: new Date(Date.parse(status.sentAt) - 60_000),
      });
    } catch (err) {
      this.log("e-mail de teste: falha ao ler o aviso de entrega", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** Limite de frequência do e-mail de teste (a tentativa conta mesmo se o envio falhar). */
  private takeTestSlot(): void {
    const now = this.now();
    const hour = 60 * 60 * 1000;
    this.testAttempts = this.testAttempts.filter((t) => now - t < 24 * hour);
    if (this.testAttempts.length >= TEST_MAX_PER_DAY) {
      const wait = Math.ceil((this.testAttempts[0]! + 24 * hour - now) / hour);
      throw httpError(
        429,
        "test_rate_limited",
        `Limite de ${TEST_MAX_PER_DAY} testes por dia atingido. Tente de novo em ${wait} h.`,
      );
    }
    const lastHour = this.testAttempts.filter((t) => now - t < hour);
    const last = this.testAttempts.at(-1);
    if (last !== undefined && now - last < TEST_MIN_INTERVAL_MS) {
      const wait = Math.ceil((TEST_MIN_INTERVAL_MS - (now - last)) / 1000);
      throw httpError(429, "test_rate_limited", `Aguarde ${wait} s para enviar outro e-mail de teste.`);
    }
    if (lastHour.length >= TEST_MAX_PER_HOUR) {
      const wait = Math.ceil((lastHour[0]! + hour - now) / 60_000);
      throw httpError(
        429,
        "test_rate_limited",
        `Limite de ${TEST_MAX_PER_HOUR} testes por hora atingido. Tente de novo em ${wait} min.`,
      );
    }
    this.testAttempts.push(now);
  }

  private forgetOldTests(): void {
    const now = this.now();
    for (const [id, record] of this.tests) {
      if (now - Date.parse(record.status.sentAt) > TEST_KEEP_MS) this.tests.delete(id);
    }
  }

  // -------------------------------------------------------------------------
  // E-mail de projeto (injeção SMTP no deploy)
  // -------------------------------------------------------------------------

  /**
   * Ativa ou atualiza o e-mail do projeto. O endereço de envio É a caixa do
   * projeto (padrão: <slug>@<domínio>): o projeto entra com ela (SMTP_USER) e
   * envia como ela (MAIL_FROM), e a pessoa pode abri-la num app de e-mail
   * para ler as respostas. Validação real (02/10/2026): antes o endereço era
   * só um alias de uma caixa técnica sem senha visível — ninguém lia nada.
   *
   * Caixa nova pede a senha: `password` (digitada pela pessoa) ou
   * `generatePassword` (o painel gera uma forte e a devolve UMA vez, em
   * `generatedPassword`). Mesmo endereço: a senha só muda se vier uma.
   *
   * Trocar o endereço cria a caixa nova e remove a antiga do projeto, se
   * nenhum outro projeto a usa. Registro antigo (fromAddress = alias): o
   * alias sai da caixa técnica ANTES de o endereço virar caixa (o Stalwart
   * não deixa o mesmo endereço em duas caixas).
   */
  async enableProjectEmail(
    project: Project,
    domainName: string,
    opts: { fromLocalPart?: string; fromName?: string; password?: string; generatePassword?: boolean } = {},
  ): Promise<{ email: ProjectEmailConfig; generatedPassword?: string }> {
    await this.ensureLoaded();
    const live = await this.purgeOrphanProjects();
    const domain = this.requireDomain(domainName);
    const local = opts.fromLocalPart ? normalizeLocalPart(opts.fromLocalPart) : project.slug;
    const address = `${local}@${domain.name}`;
    this.requireFreeAddress(address, project);
    // caixa criada para outro projeto que existe (mesmo desativada): não passa para este, nem criando "nova"
    if (this.data.mailboxes[address]) this.requireNotUsedByOtherProject(address, project.id, live);

    // sem nome digitado, o nome do projeto (padrão da caixa de envio)
    const requestedName = requireDisplayName(opts.fromName);
    const fromName = requestedName || sanitizeDisplayName(project.name);
    const previous = this.data.projects[project.id];
    const existing = this.data.mailboxes[address];
    const generated = opts.generatePassword ? generateStrongPassword() : undefined;
    const newPassword = generated ?? (opts.password !== undefined ? requireStrongPassword(opts.password) : undefined);
    const keepsMailbox = previous?.mailbox === address && existing !== undefined;
    if (!keepsMailbox && newPassword === undefined) {
      throw httpError(
        400,
        "password_required",
        `Defina a senha da caixa ${address} (mínimo ${MAILBOX_PASSWORD_MIN} caracteres) ou peça uma senha forte gerada pelo painel.`,
      );
    }
    await this.requireRunning();
    const client = this.client();

    if (previous?.fromAddress) {
      await client.removeMailboxAlias(previous.mailbox, previous.fromAddress);
    }
    if (!existing) {
      await client.createMailbox(address, newPassword!, [], fromName || undefined);
      this.data.mailboxes[address] = {
        id: address,
        localPart: local,
        domain: domain.name,
        kind: "project",
        createdAt: new Date().toISOString(),
        projectId: project.id,
        ...(fromName ? { displayName: fromName } : {}),
        password: newPassword!,
      };
    } else {
      // caixa que já existe (a do projeto ou uma adotada): o Stalwart passa a ter o mesmo nome do From
      if (existing.displayName !== (fromName || undefined)) {
        await client.setMailboxDisplayName(address, fromName);
        if (fromName) existing.displayName = fromName;
        else delete existing.displayName;
      }
    }
    if (existing && newPassword !== undefined) {
      await this.withMailboxLock(address, async () => {
        await client.setMailboxMainPassword(address, newPassword);
        existing.password = newPassword;
      });
      // caixa adotada do Stalwart: passa a ser a do projeto (e volta a ser de usuário quando ele a deixar)
      if (existing.kind === "user") {
        existing.kind = "project";
        existing.external = true;
        if (existing.projectId) existing.ownerBefore = existing.projectId;
      }
      existing.projectId = project.id;
    }

    this.data.projects[project.id] = {
      domain: domain.name,
      mailbox: address,
      enabledAt: previous?.enabledAt ?? new Date().toISOString(),
      ...(fromName ? { fromName } : {}),
      ...(previous?.envLinks ? { envLinks: previous.envLinks } : {}),
    };
    await this.save();
    if (previous && previous.mailbox !== address) {
      await this.dropUnusedProjectMailbox(previous.mailbox);
    }
    const email = await this.projectEmailConfig(project.id);
    return generated ? { email, generatedPassword: generated } : { email };
  }

  /**
   * O endereço não pode ser de outra caixa (salvo uma caixa de projeto que
   * ninguém usa mais, ou a do próprio projeto), nem de outro projeto, nem o
   * postmaster@/abuse@/dmarc@ que o painel cria com o domínio.
   */
  private requireFreeAddress(address: string, project: Pick<Project, "id" | "slug">): void {
    const projectId = project.id;
    const [local] = address.split("@");
    const takenByOther = Object.entries(this.data.projects).some(
      ([id, p]) => id !== projectId && (p.fromAddress === address || p.mailbox === address),
    );
    const mailbox = this.data.mailboxes[address];
    // Caixa adotada do Stalwart (restauração) SEM senha conhecida e no endereço padrão do projeto (slug@domínio):
    // a ativação a assume como caixa do projeto (pede a senha e a define no Stalwart; nada é apagado).
    const adoptedForProject = mailbox?.kind === "user" && mailbox.password === "" && address.startsWith(`${project.slug}@`);
    if (takenByOther || (mailbox && mailbox.kind !== "project" && !adoptedForProject) || SYSTEM_LOCAL_PARTS.has(local ?? "")) {
      throw httpError(409, "address_in_use", `O endereço ${address} já é de outra caixa ou de outro projeto.`);
    }
  }

  /**
   * Remove a caixa antiga do projeto (endereço trocado) se nenhum projeto a
   * usa. Falha no servidor de e-mail não desfaz a troca: fica no log e a
   * caixa continua na lista do domínio, onde dá para remover depois.
   */
  private async dropUnusedProjectMailbox(email: string): Promise<void> {
    const mailbox = this.data.mailboxes[email];
    if (!mailbox || mailbox.kind !== "project") return;
    if (Object.values(this.data.projects).some((p) => p.mailbox === email)) return;
    // caixa que já existia antes de ser a do projeto: nunca é apagada, só solta
    if (mailbox.external) {
      this.freeMailbox(mailbox);
      await this.save();
      return;
    }
    try {
      await this.client().deleteMailbox(email);
    } catch (err) {
      this.log(`falha ao remover a caixa antiga ${email} do projeto no servidor de e-mail`, {
        mailbox: email,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    delete this.data.mailboxes[email];
    await this.save();
  }

  /**
   * Desativa o e-mail do projeto. A caixa (e as mensagens dela) fica: quem
   * quiser apagar remove na página do domínio. Registro antigo: tira o alias.
   */
  async disableProjectEmail(projectId: string): Promise<ProjectEmailConfig> {
    await this.ensureLoaded();
    const stored = this.data.projects[projectId];
    if (stored?.fromAddress) {
      await this.client().removeMailboxAlias(stored.mailbox, stored.fromAddress);
    }
    delete this.data.projects[projectId];
    // caixa que já existia antes de virar a do projeto: volta a ser de usuário (outro projeto pode usá-la e o
    // Sincronizar deixa de regravar a senha dela); a criada para o projeto segue como estava
    const box = stored ? this.data.mailboxes[stored.mailbox] : undefined;
    if (box?.external && !Object.values(this.data.projects).some((p) => p.mailbox === box.id)) this.freeMailbox(box);
    await this.save();
    return this.projectEmailConfig(projectId);
  }

  // -------------------------------------------------------------------------
  // Soltar o e-mail de um projeto apagado e ligar o de um projeto a uma caixa que já existe
  // -------------------------------------------------------------------------

  /** Projetos que existem agora (id → slug/nome); null = não dá para saber (nada é tratado como apagado). */
  private async liveProjects(): Promise<Map<string, { slug: string; name?: string }> | null> {
    if (!this.projectsOf) return null;
    try {
      const list = await this.projectsOf();
      // Lista vazia com e-mails de projeto registrados = "não sei" (um projects.json ausente é lido como
      // lista vazia): soltar os vínculos de projetos vivos seria irreversível. Órfão só é solto quando
      // existe ao menos um projeto para provar que a lista é de verdade.
      if (list.length === 0 && (Object.keys(this.data.projects).length > 0 || Object.values(this.data.mailboxes).some((m) => m.kind === "project" && m.projectId))) {
        return null;
      }
      return new Map(list.map((p) => [p.id, { slug: p.slug, ...(p.name ? { name: p.name } : {}) }]));
    } catch {
      return null;
    }
  }

  /**
   * A caixa deixa de ser de um projeto: sem dono. Caixa que já existia antes de virar a do projeto (`external`)
   * volta a ser de usuário; a criada para o projeto segue "de projeto", sem uso (o código a reaproveita). A senha
   * guardada continua: o realinhamento só regrava caixa de projeto e de sistema, e a de usuário a pessoa gerencia.
   */
  private freeMailbox(mailbox: StoredMailbox): void {
    delete mailbox.projectId;
    if (mailbox.external) {
      mailbox.kind = "user";
      delete mailbox.external;
      // caixa criada na aba Caixas de um projeto: volta a ser dele
      if (mailbox.ownerBefore) mailbox.projectId = mailbox.ownerBefore;
      delete mailbox.ownerBefore;
    }
  }

  /** Tira o alias antigo (registro legado) da caixa técnica; falha do servidor de e-mail só vai para o log. */
  private async dropLegacyAliasQuietly(stored: StoredProjectEmail): Promise<void> {
    if (!stored.fromAddress) return;
    try {
      await this.client().removeMailboxAlias(stored.mailbox, stored.fromAddress);
    } catch (err) {
      this.log(`não deu para tirar o endereço ${stored.fromAddress} da caixa ${stored.mailbox} ao soltar o e-mail do projeto`, {
        mailbox: stored.mailbox,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Tira o registro de e-mail de um projeto e solta a caixa dele (se nenhum outro projeto a usa). */
  private async detachProjectEmail(projectId: string): Promise<boolean> {
    const stored = this.data.projects[projectId];
    if (!stored) return false;
    delete this.data.projects[projectId];
    const box = this.data.mailboxes[stored.mailbox];
    if (box && box.kind === "project" && !Object.values(this.data.projects).some((p) => p.mailbox === box.id)) {
      this.freeMailbox(box);
    }
    await this.dropLegacyAliasQuietly(stored);
    return true;
  }

  /**
   * Solta o vínculo de e-mail de um projeto que deixou de existir: tira o registro e as ligações de variáveis e
   * solta a caixa. A caixa e as mensagens ficam no servidor de e-mail; nada é apagado.
   */
  async releaseProjectEmail(projectId: string): Promise<void> {
    await this.ensureLoaded();
    let changed = await this.detachProjectEmail(projectId);
    for (const box of Object.values(this.data.mailboxes)) {
      if (box.kind === "project" && box.projectId === projectId) {
        this.freeMailbox(box);
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  /**
   * Projetos apagados antes de a remoção soltar o e-mail deixaram registro órfão, que bloqueava o endereço
   * ("já existe"). Com a lista de projetos que existem, solta cada órfão (mesma regra de releaseProjectEmail).
   * Sem a lista (ou com erro nela) nada é considerado órfão.
   */
  private async purgeOrphanProjects(): Promise<Map<string, { slug: string; name?: string }> | null> {
    const live = await this.liveProjects();
    if (!live) return null;
    let changed = false;
    for (const id of Object.keys(this.data.projects)) {
      if (live.has(id)) continue;
      changed = (await this.detachProjectEmail(id)) || changed;
    }
    for (const box of Object.values(this.data.mailboxes)) {
      if (box.kind === "project" && box.projectId && !live.has(box.projectId)) {
        this.freeMailbox(box);
        changed = true;
      }
    }
    if (changed) await this.save();
    return live;
  }

  /** Projeto (que existe) que já usa esta caixa, ou null. */
  private otherOwnerOf(address: string, projectId: string, live: Map<string, { slug: string; name?: string }> | null): { id: string; viaRegistry: boolean } | null {
    for (const [id, p] of Object.entries(this.data.projects)) {
      if (id !== projectId && (p.mailbox === address || p.fromAddress === address)) return { id, viaRegistry: true };
    }
    // caixa criada na aba Caixas de OUTRO projeto (que existe, ou que não dá para saber): é dele
    const owner = this.data.mailboxes[address]?.projectId;
    if (owner && owner !== projectId && (live === null || live.has(owner))) return { id: owner, viaRegistry: false };
    return null;
  }

  private requireNotUsedByOtherProject(
    address: string,
    projectId: string,
    live: Map<string, { slug: string; name?: string }> | null,
  ): void {
    const other = this.otherOwnerOf(address, projectId, live);
    if (other === null) return;
    const info = live?.get(other.id);
    // sem a lista de projetos não há nome: nunca mostra o id interno
    const name = info?.name ?? info?.slug;
    throw httpError(
      409,
      "mailbox_taken_by_project",
      other.viaRegistry
        ? `A caixa ${address} já é usada ${name ? `pelo projeto ${name}` : "por outro projeto"}. Desative o e-mail dele antes.`
        : `A caixa ${address} pertence ${name ? `ao projeto ${name}` : "a outro projeto"} (foi criada para ele, no e-mail ou na aba Caixas dele) e só pode ser usada por ele.`,
    );
  }

  /**
   * Caixas do domínio que o projeto pode usar como a do e-mail dele: caixas de usuário e caixas de projeto sem
   * uso. Fora: as de sistema, postmaster@/abuse@/dmarc@, as que outro projeto usa e a que já é a dele.
   * Nunca traz senha: só se o painel a conhece.
   */
  async listUsableMailboxes(project: Pick<Project, "id" | "slug">, domainName: string): Promise<ProjectEmailUsableMailbox[]> {
    await this.ensureLoaded();
    const live = await this.purgeOrphanProjects();
    const domain = this.requireDomain(domainName);
    const current = this.data.projects[project.id]?.mailbox;
    return Object.values(this.data.mailboxes)
      .filter(
        (m) =>
          m.domain === domain.name &&
          (m.kind === "user" || m.kind === "project") &&
          !SYSTEM_LOCAL_PARTS.has(m.localPart) &&
          m.id !== current &&
          this.otherOwnerOf(m.id, project.id, live) === null,
      )
      .map((m) => ({ address: m.id, localPart: m.localPart, kind: m.kind as "user" | "project", passwordKnown: m.password !== "" }))
      .sort((a, b) => a.address.localeCompare(b.address));
  }

  /**
   * Liga o e-mail do projeto a uma caixa que JÁ existe, sem apagar nem refazer nada (as mensagens e a caixa
   * ficam). O app precisa da senha da caixa (SMTP_USER/SMTP_PASS no deploy), então a pessoa escolhe:
   *  - `current_password`: informa a senha atual. O painel confere comparando com o que o servidor de e-mail
   *    guarda (GET do cadastro, sem tentar login: login errado leva ~5 s e o Stalwart bloqueia o IP com 100 por
   *    dia). Senha de app e 2FA dividem o campo da senha e são ignorados na comparação. Se o servidor não
   *    deixa comparar (só guarda hash): em caixa de usuário recusa (409 password_unverifiable); em caixa que o
   *    painel criou aceita e devolve `passwordVerified: false`;
   *  - `keep_password`: usa a senha que o painel já guarda (conferida do mesmo jeito);
   *  - `replace_password`: o painel gera uma senha forte e a aplica na caixa, preservando senhas de app e 2FA
   *    (apps e webmail que usavam a antiga precisam ser atualizados).
   * A caixa passa a ser "do projeto" (o Sincronizar a realinha) e volta a ser de usuário quando ele a deixar.
   * Falha no meio reverte o cadastro: a caixa não fica meio assumida.
   */
  async connectExistingMailbox(
    project: Project,
    domainName: string,
    localPart: string,
    opts: { mode: ExistingMailboxMode; password?: string; fromName?: string },
  ): Promise<{ email: ProjectEmailConfig; generatedPassword?: string; passwordVerified?: boolean }> {
    await this.ensureLoaded();
    const live = await this.purgeOrphanProjects();
    const domain = this.requireDomain(domainName);
    const local = normalizeLocalPart(localPart);
    const address = `${local}@${domain.name}`;
    if (SYSTEM_LOCAL_PARTS.has(local)) {
      throw httpError(409, "address_in_use", `O endereço ${address} é reservado do painel e não pode ser a caixa de um projeto.`);
    }
    // nome digitado; sem ele, o que a caixa já tem; sem nenhum, o nome do projeto
    const requestedName = requireDisplayName(opts.fromName);
    const found = this.data.mailboxes[address];
    if (!found || found.domain !== domain.name) {
      throw httpError(404, "mailbox_not_found", `A caixa ${address} não existe. Rode Sincronizar na página E-mail se ela foi criada fora do painel.`);
    }
    if (found.kind === "system") {
      throw httpError(409, "address_in_use", `A caixa ${address} é do próprio painel e não pode ser a de um projeto.`);
    }
    this.requireNotUsedByOtherProject(address, project.id, live);

    let candidate: string;
    if (opts.mode === "replace_password") candidate = generateStrongPassword();
    else if (opts.mode === "keep_password") {
      if (found.password === "") {
        throw httpError(400, "password_required", `O painel não sabe a senha de ${address}. Informe a senha atual ou troque por uma gerada pelo painel.`);
      }
      candidate = found.password;
    } else candidate = requireStrongPassword(opts.password);

    await this.requireRunning();
    const client = this.client();
    const gone = () =>
      httpError(409, "mailbox_gone", `A caixa ${address} não existe mais no servidor de e-mail. Rode Sincronizar na página E-mail e escolha de novo.`);

    let passwordVerified: boolean | undefined;
    await this.withMailboxLock(address, async () => {
      // a vez dela chegou: confere de novo (outra operação pode ter mexido na caixa enquanto esperava)
      const box = this.data.mailboxes[address];
      if (!box) throw gone();
      this.requireNotUsedByOtherProject(address, project.id, live);

      if (opts.mode !== "replace_password") {
        let matches: boolean | null = null;
        try {
          matches = await client.mailboxPasswordMatches(address, candidate);
        } catch (err) {
          if (err instanceof StalwartApiError && err.status === 404) throw gone();
          // sem conseguir conferir: só uma caixa que o painel criou é aceita assim (abaixo); nada de tentar de novo
          this.log(`não deu para conferir a senha da caixa ${address} (${err instanceof StalwartApiError ? `HTTP ${err.status}` : "falha de conexão"}).`);
        }
        if (matches === false) {
          throw opts.mode === "keep_password"
            ? httpError(409, "stored_password_stale", `A senha que o painel guarda para ${address} não é mais a da caixa. Informe a senha atual ou troque por uma gerada pelo painel.`)
            : httpError(400, "mailbox_password_mismatch", `A senha informada não é a da caixa ${address}.`);
        }
        // Não deu para conferir e a caixa é de usuário (o painel não a criou): NÃO aceita. Uma senha errada
        // guardada seria regravada na caixa pelo Sincronizar, trancando o dono para fora (senha de app e 2FA
        // dividem o campo da senha, e o servidor pode só guardar o hash).
        if (matches === null && box.kind === "user") {
          throw httpError(
            409,
            "password_unverifiable",
            `O servidor de e-mail não deixou o painel conferir a senha de ${address}. Para não guardar uma senha possivelmente errada (o Sincronizar a gravaria na caixa), o painel não a aceita: troque por uma senha gerada pelo painel.`,
          );
        }
        passwordVerified = matches === true;
      }

      const previous = this.data.projects[project.id];
      const boxBefore = structuredClone(box);
      const entryBefore = previous ? structuredClone(previous) : undefined;
      const revert = async () => {
        for (const key of Object.keys(box)) delete (box as unknown as Record<string, unknown>)[key];
        Object.assign(box, boxBefore);
        if (entryBefore) this.data.projects[project.id] = entryBefore;
        else delete this.data.projects[project.id];
        try {
          await this.save();
        } catch (err) {
          this.log(`não deu para regravar o cadastro depois de desfazer a ligação da caixa ${address}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };

      const fromName = requestedName || box.displayName || sanitizeDisplayName(project.name);
      box.password = candidate;
      if (fromName) box.displayName = fromName;
      else delete box.displayName;
      if (box.kind === "user") {
        box.kind = "project";
        box.external = true;
        if (box.projectId) box.ownerBefore = box.projectId;
      }
      box.projectId = project.id;
      this.data.projects[project.id] = {
        domain: domain.name,
        mailbox: address,
        enabledAt: previous?.enabledAt ?? new Date().toISOString(),
        ...(fromName ? { fromName } : {}),
        ...(previous?.envLinks ? { envLinks: previous.envLinks } : {}),
      };
      try {
        // grava antes de trocar a senha no servidor: se o processo cair no meio, o painel não perde a senha nova
        await this.save();
        if (opts.mode === "replace_password") await client.setMailboxMainPassword(address, candidate);
        // o Stalwart passa a ter o mesmo nome do From (só o campo description)
        if (boxBefore.displayName !== (fromName || undefined)) await client.setMailboxDisplayName(address, fromName);
      } catch (err) {
        await revert();
        if (err instanceof StalwartApiError && err.status === 404) throw gone();
        throw err;
      }
      if (previous) {
        await this.dropLegacyAliasQuietly(previous);
        if (previous.mailbox !== address) await this.dropUnusedProjectMailbox(previous.mailbox);
      }
    });

    const email = await this.projectEmailConfig(project.id);
    return {
      email,
      ...(opts.mode === "replace_password" ? { generatedPassword: candidate } : {}),
      ...(passwordVerified !== undefined ? { passwordVerified } : {}),
    };
  }

  /**
   * Liga variáveis do app a valores do e-mail (ex.: { SMTP_SENHA: "SMTP_PASS" }).
   * Guarda só o mapeamento — o valor nunca é copiado para as Variáveis — e o
   * deploy entrega o valor atual (linkedEnvForProject): a senha trocada chega
   * sozinha no deploy seguinte. Lista vazia apaga o mapeamento.
   */
  async setProjectEmailLinks(projectId: string, links: Record<string, string>): Promise<ProjectEmailConfig> {
    await this.ensureLoaded();
    const stored = this.data.projects[projectId];
    if (!stored) {
      throw httpError(409, "email_not_enabled", "Ative o e-mail do projeto antes de ligar as variáveis.");
    }
    const entries = Object.entries(links);
    if (entries.length > MAX_PROJECT_EMAIL_LINKS) {
      throw httpError(400, "invalid_env_link", `No máximo ${MAX_PROJECT_EMAIL_LINKS} variáveis ligadas.`);
    }
    const clean: Record<string, ProjectEmailValueKey> = {};
    for (const [name, source] of entries) {
      const problem = envLinkNameProblem(name);
      if (problem) throw httpError(400, "invalid_env_key", problem);
      if (!(PROJECT_EMAIL_VALUE_KEYS as readonly string[]).includes(source)) {
        throw httpError(400, "invalid_env_link", `${source} não é um valor do e-mail do projeto.`);
      }
      clean[name] = source as ProjectEmailValueKey;
    }
    if (entries.length === 0) delete stored.envLinks;
    else stored.envLinks = clean;
    await this.save();
    return this.projectEmailConfig(projectId);
  }

  /** Configuração atual (env vars mascaradas) para a UI. */
  async projectEmailConfig(projectId: string): Promise<ProjectEmailConfig> {
    await this.ensureLoaded();
    const stored = this.data.projects[projectId];
    const mailbox = stored ? this.data.mailboxes[stored.mailbox] : undefined;
    if (!stored || !mailbox) {
      return { enabled: false, domain: null, mailbox: null, mailFrom: null, env: {} };
    }
    const env = this.smtpEnvOf(stored, mailbox);
    return {
      enabled: true,
      domain: stored.domain,
      mailbox: stored.mailbox,
      mailFrom: env.MAIL_FROM!,
      fromName: sanitizeDisplayName(stored.fromName) || null,
      env: maskEnv(env),
      envLinks: { ...(stored.envLinks ?? {}) },
      legacyAlias: Boolean(stored.fromAddress),
    };
  }

  /**
   * Provedor de env vars para o engine de deploy (Fase 2): retorna o mapa
   * SMTP completo (com senha) ou {} quando o projeto não tem e-mail habilitado.
   */
  envForProject = async (project: Project): Promise<Record<string, string>> => {
    await this.ensureLoaded();
    const stored = this.data.projects[project.id];
    const mailbox = stored ? this.data.mailboxes[stored.mailbox] : undefined;
    // caixa sem senha conhecida: SMTP_PASS vazio quebraria o login do app; melhor não entregar nada
    if (!stored || !mailbox || mailbox.password === "") return {};
    return this.smtpEnvOf(stored, mailbox, project.name);
  };

  /**
   * Variáveis do app ligadas a valores do e-mail, com o valor ATUAL (inclusive
   * a senha). Entregues no deploy como as Variáveis do projeto (no `.env`).
   * Valor que não existe (MAIL_FROM_NAME sem nome) fica de fora.
   */
  linkedEnvForProject = async (project: Project): Promise<Record<string, string>> => {
    const env = await this.envForProject(project);
    const out: Record<string, string> = {};
    for (const [name, source] of Object.entries(await this.envLinksForProject(project))) out[name] = env[source]!;
    return out;
  };

  /**
   * Ligações em vigor (nome do app → valor do e-mail), só com os NOMES: a
   * seção Variáveis mostra "SMTP_SENHA ← SMTP_PASS". Mesma regra da entrega:
   * ligação a um valor que não existe fica de fora.
   */
  envLinksForProject = async (project: Project): Promise<Record<string, ProjectEmailValueKey>> => {
    const env = await this.envForProject(project);
    const links = this.data.projects[project.id]?.envLinks ?? {};
    const out: Record<string, ProjectEmailValueKey> = {};
    for (const [name, source] of Object.entries(links)) {
      if (env[source] !== undefined) out[name] = source;
    }
    return out;
  };

  private smtpEnvOf(stored: StoredProjectEmail, mailbox: StoredMailbox, projectName?: string): Record<string, string> {
    // O nome pode vir de registro antigo ou do nome do projeto (texto livre): sempre limpo; vazio = sem MAIL_FROM_NAME.
    const name = sanitizeDisplayName(stored.fromName ?? projectName);
    return buildSmtpEnv({
      host: mailHostFor(stored.domain),
      mailbox: mailbox.id,
      password: mailbox.password,
      mailFrom: stored.fromAddress ?? mailbox.id,
      ...(name ? { mailFromName: name } : {}),
    });
  }

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

  // -------------------------------------------------------------------------
  // Avisos do painel por e-mail (Configurações → Notificações)
  // -------------------------------------------------------------------------

  /**
   * De onde os avisos do painel saem: a postmaster@ do primeiro domínio com o
   * DNS conferido (A, MX, SPF, DKIM, DMARC — mesma regra do roteiro de
   * primeiros passos; sem DNS certo o aviso iria para o spam ou seria
   * recusado). Não pronto: diz o que falta, em português.
   */
  async systemMailReadiness(): Promise<{ ready: boolean; reason: string | null; from: string | null }> {
    await this.ensureLoaded();
    const notReady = (reason: string) => ({ ready: false, reason, from: null });
    if (!this.data.adminSecret) {
      return notReady("O servidor de e-mail do painel não foi iniciado. Inicie-o na página E-mail e cadastre um domínio de envio.");
    }
    const domains = Object.values(this.data.domains);
    if (domains.length === 0) {
      return notReady("O servidor de e-mail está criado, mas não tem nenhum domínio de envio. Adicione um na página E-mail.");
    }
    const dnsOk = (d: StoredDomain): boolean => {
      const v = d.lastVerify as { ok: number; total: number; recordsOk?: boolean } | null;
      if (!v) return false;
      return typeof v.recordsOk === "boolean" ? v.recordsOk : v.total > 0 && v.ok === v.total;
    };
    const withDns = domains.filter((d) => dnsOk(d) && this.data.mailboxes[`postmaster@${d.name}`]);
    const chosen = withDns.find((d) => this.data.mailboxes[`postmaster@${d.name}`]!.password !== "");
    if (!chosen && withDns.length > 0) {
      return notReady(
        `A caixa postmaster@${withDns[0]!.name} veio de um backup e o painel não sabe a senha dela. Em E-mail → ${withDns[0]!.name} → Caixas, use Trocar senha na postmaster@.`,
      );
    }
    if (!chosen) {
      return notReady("Nenhum domínio de e-mail está com o DNS conferido. Abra o domínio na página E-mail e clique em Verificar DNS.");
    }
    try {
      await this.ensureNetworkAccess();
      const status = await this.manager().status();
      if (!status.running) return notReady("O servidor de e-mail do painel está parado. Inicie-o na página E-mail.");
    } catch {
      return notReady("Não foi possível conferir o servidor de e-mail agora. Tente de novo em instantes.");
    }
    return { ready: true, reason: null, from: `postmaster@${chosen.name}` };
  }

  /**
   * Envia um aviso do painel (texto + HTML) pela submission do Stalwart,
   * autenticado como a postmaster@ escolhida. Sem aviso de entrega (DSN):
   * cada aviso deixaria uma mensagem na caixa. Recusa 5xx do servidor é
   * definitiva (`permanent`), o resto vale tentar de novo.
   */
  async sendSystemMail(msg: { to: string; subject: string; text: string; html: string }): Promise<void> {
    const readiness = await this.systemMailReadiness();
    if (!readiness.ready || !readiness.from) {
      throw Object.assign(new Error(readiness.reason ?? "O servidor de e-mail não está pronto."), { permanent: false });
    }
    const mailbox = this.data.mailboxes[readiness.from]!;
    const domainName = mailbox.domain;
    const id = randomBytes(8).toString("hex");
    try {
      await this.sendMail({
        host: this.inContainer ? PAAS_STALWART_CONTAINER : "127.0.0.1",
        port: this.inContainer ? 465 : this.config.mailPorts.submissions,
        servername: mailHostFor(domainName),
        username: mailbox.id,
        password: mailbox.password,
        from: readiness.from,
        fromName: "TWS Panel",
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        dsn: false,
        envId: `tws-aviso-${id}`,
        messageId: `<tws-aviso-${id}@${domainName}>`,
        date: new Date(this.now()),
      });
    } catch (err) {
      const code = err instanceof SmtpSendError ? err.code : 0;
      if (err instanceof SmtpSendError && err.command === "AUTH" && code >= 500 && code < 600) {
        throw Object.assign(new Error(MAIL_SMTP_AUTH_REJECTED_MESSAGE), { permanent: true, code: "email_auth_rejected" });
      }
      throw Object.assign(new Error(err instanceof Error ? err.message : String(err)), {
        permanent: code >= 500 && code < 600,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Webmail (ver webmail-service.ts)
  // -------------------------------------------------------------------------

  /**
   * Por onde o webmail fala com o Stalwart: um nome que é alias dele na
   * paas-net e, se possível, cujo certificado já foi instalado (o do
   * hostname do servidor primeiro) — aí o webmail confere cadeia e nome.
   * Sem nenhum instalado, o hostname e sem conferir (autoassinado).
   */
  async webmailBackend(): Promise<{
    serverRunning: boolean;
    imapHost: string;
    verifyTls: boolean;
    hosts: string[];
    domains: { domain: string; host: string }[];
    identities: Record<string, string>;
  }> {
    await this.ensureLoaded();
    const serverRunning = this.data.adminSecret ? (await this.manager().status()).running : false;
    const hosts = this.hostList();
    const installed = Object.keys(this.data.tls?.certificates ?? {}).filter((h) => hosts.includes(h));
    const hostname = this.hostname();
    const verified = installed.includes(hostname) ? hostname : (installed[0] ?? null);
    return {
      serverRunning,
      imapHost: verified ?? hostname,
      verifyTls: verified !== null,
      hosts,
      domains: Object.keys(this.data.domains).map((domain) => ({ domain, host: mailHostFor(domain) })),
      identities: this.webmailIdentities(),
    };
  }

  /**
   * Nome de exibição de cada caixa de projeto (pedido do dono, 04/10/2026:
   * e-mail enviado pelo webmail saía sem nome). O webmail dá esse nome à
   * identidade da caixa no primeiro login, ou a quem ainda está sem nome.
   * Registro antigo sem nome guardado fica de fora.
   */
  private webmailIdentities(): Record<string, string> {
    const out: Record<string, string> = {};
    // as demais caixas (global e extras do projeto) com nome de exibição
    for (const m of Object.values(this.data.mailboxes)) {
      const name = sanitizeDisplayName(m.displayName);
      if (name) out[m.id.toLowerCase()] = name;
    }
    // a caixa de envio do projeto vale o nome do MAIL_FROM_NAME
    for (const p of Object.values(this.data.projects)) {
      const name = sanitizeDisplayName(p.fromName);
      if (name) out[p.mailbox.toLowerCase()] = name;
    }
    return out;
  }

  /** Isenta o IP do webmail do bloqueio automático do Stalwart (e tira o anterior). */
  async exemptWebmailIp(ip: string, previousIp: string | null): Promise<void> {
    await this.ensureLoaded();
    await this.ensureNetworkAccess();
    await this.client().exemptIp(ip, previousIp);
  }

  async removeWebmailIpExemption(ip: string): Promise<void> {
    await this.ensureLoaded();
    await this.ensureNetworkAccess();
    await this.client().removeIpExemption(ip);
  }
}

/** Corpo do e-mail de teste (texto simples, para leigo). */
function testEmailText(domain: string, from: string, id: string, sentAt: Date): string {
  const when = sentAt.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  return [
    "Olá!",
    "",
    "Este é um e-mail de teste do TWS Panel.",
    "",
    `Ele saiu do servidor de e-mail da sua VPS, pela caixa ${from}, para conferir se as mensagens do domínio ${domain} chegam até você.`,
    "",
    'Se ele caiu na pasta Spam, marque como "Não é spam": isso ajuda a reputação do domínio nas próximas mensagens.',
    "",
    "Não é preciso responder.",
    "",
    `Enviado em ${when} (horário de Brasília). Código do teste: ${id}.`,
  ].join("\n");
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

function noPasswordError(address: string): HttpError {
  return httpError(
    409,
    "mailbox_no_password",
    `O painel não sabe a senha da caixa ${address} (ela veio de um backup). Use Trocar senha nesta caixa e tente de novo.`,
  );
}

function normalizeLocalPart(localPart: string): string {
  const local = (localPart ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(local) || local.includes("..")) {
    throw httpError(400, "invalid_mailbox", `Nome de caixa inválido: ${localPart}`);
  }
  return local;
}

/** Nome de exibição pedido pela pessoa: valida (400 invalid_display_name) e normaliza; vazio = "". */
function requireDisplayName(raw: string | undefined): string {
  const checked = normalizeDisplayName(raw);
  if (!checked.ok) throw httpError(400, "invalid_display_name", checked.reason);
  return checked.value;
}

/** Senha definida pela pessoa para uma caixa: mínimo MAILBOX_PASSWORD_MIN caracteres. */
function requireStrongPassword(password: string | undefined): string {
  const value = password ?? "";
  if (value.trim().length < MAILBOX_PASSWORD_MIN) {
    throw httpError(400, "weak_password", `A senha deve ter pelo menos ${MAILBOX_PASSWORD_MIN} caracteres.`);
  }
  return value;
}
