/**
 * certificate-service.ts — página Certificados.
 *
 * Pedido do dono do produto (01/10/2026): um lugar para ver o certificado de
 * TODOS os nomes que o painel serve por HTTPS (painel, domínios dos projetos,
 * mail.<domínio>) e agir com um clique — automático (Caddy + Let's Encrypt)
 * ou manual (certificado próprio).
 *
 * - Estado: vem do certificado SERVIDO de verdade (TLS com SNI pelo proxy
 *   central, como um navegador) e, sem certificado, do último evento do log
 *   do Caddy para o nome (caddy-log.ts), traduzido para leigo.
 * - "Tentar emitir agora": `caddy reload --force`. O certmagic cancela as
 *   tentativas em espera e recomeça a emissão dos nomes sem certificado na
 *   hora. Não apaga nem renova certificado válido (o Let's Encrypt limita a
 *   5 certificados idênticos por semana) — por isso é recusado para nome
 *   que já está válido. Limite: 1 pedido por minuto por nome.
 * - Manual: o par é conferido (inspectCertificatePair), guardado em
 *   <dataDir>/certificates (0700/0600) e entregue ao Caddy (`tls` no bloco
 *   do nome) e, para mail.<domínio>, ao Stalwart. Não renova sozinho:
 *   alerta proporcional à validade (1/3 dela, no máximo 30 dias; crítico perto do fim).
 * - Alerta do automático: a mesma avaliação (assessCertificateAlert, em
 *   @paas/core) alimenta a tela e o CertificateAlertWatcher: renovação que o
 *   Caddy devia ter feito e não fez, emissão falhando repetidamente (log do
 *   Caddy) e vencimento. Janelas proporcionais à validade (90, 64, 45, 6 dias).
 */
import {
  assessCertificateAlert,
  certificateValidityTier,
  expectedRenewalAt,
  type CertificateAlertAssessment,
  type CertificateItemFailure,
  type CertificateIssueError,
  type CertificateItem,
  type CertificateListResponse,
  type CertificateOwner,
  type CertificateOwnerKind,
  type CertificateRetryResponse,
  type CertificateState,
  type Project,
} from "@paas/core";
import {
  explainIssueError,
  parseCaddyCertificateLog,
  summarizeCaddyIssueFailures,
  type CaddyCertEvent,
  type CaddyIssueFailure,
  type CertificateStatus,
} from "@paas/deploy";
import { inspectCertificatePair } from "@paas/mailer";
import { isCloudflareIp } from "../routes/domains.js";
import type { AlertsService } from "./alerts-service.js";
import type { CertificateFailureStore } from "./certificate-failure-store.js";
import { covers, type ManualCertificateMeta, type ManualCertificateStore } from "./certificate-store.js";
import { httpError } from "./http-error.js";

/** O que se sabe do log do Caddy (24 h): último evento e falha em curso por nome. */
interface LogInfo {
  events: Map<string, CaddyCertEvent>;
  failures: Map<string, CaddyIssueFailure>;
  /**
   * O log foi lido e tem conteúdo. Ilegível ou vazio (container recriado, docker
   * fora do ar) NÃO significa "sem falhas": quem decide recuperação não pode usá-lo.
   */
  known: boolean;
}
const EMPTY_LOG: LogInfo = { events: new Map(), failures: new Map(), known: false };
const NO_ALERT: CertificateAlertAssessment = { level: "none", reason: null };

/** Títulos do alerta de certificado manual de antes da troca por faixas proporcionais. */
const LEGACY_MANUAL_TITLE = /^Certificado manual de .+ vence em até (7|30) dias$/;

/** Limite de "Tentar emitir agora": 1 por minuto por nome. */
export const RETRY_MIN_INTERVAL_MS = 60_000;
/** Depois de um pedido, o nome aparece como "emitindo" por até 3 min (a tela acompanha ~2 min). */
const RETRY_PENDING_MS = 3 * 60_000;

/** Sink de auditoria mínimo (forma de AuditService.record). */
export interface CertificateAuditSink {
  record(input: { actor?: string; action: string; target?: string | null; detail: string }): Promise<unknown>;
}

/** O que o serviço precisa do resto do painel (dublês nos testes, sem Docker). */
export interface CertificateDeps {
  listProjects(): Promise<Project[]>;
  /** Domínio do painel no proxy central (null = acesso por túnel/IP). */
  panelDomain(): string | null;
  /** Outros endereços do painel (o acesso pelo IP enquanto o domínio próprio não o substitui). */
  panelAliases?(): string[];
  /** mail.<domínio> do servidor de e-mail. */
  mailHosts(): Promise<string[]>;
  proxyRunning(): Promise<boolean>;
  /** Certificado servido pelo proxy central para o nome (SNI). */
  servedCertificate(host: string): Promise<CertificateStatus>;
  /** Log das últimas 24 h do Caddy (texto não confiável). */
  caddyLogs(): Promise<string>;
  /** Recalcula o Caddyfile; force = `caddy reload --force`. */
  refreshProxy(opts: { force: boolean }): Promise<void>;
  /** Apaga de dentro do container do Caddy o par manual do nome. */
  removeManualFiles(host: string): Promise<void>;
  /** Instala no Stalwart o certificado atual de mail.<domínio>. */
  syncMailTls?(): Promise<unknown>;
  /** DNS (IPv4) do nome — refina a causa (Cloudflare). */
  resolve4?(host: string): Promise<string[]>;
  /**
   * Domínios dinâmicos cadastrados (emissão sob demanda). O estado deles vem do
   * armazenamento do Caddy, NUNCA de um handshake TLS: o handshake com SNI é o
   * primeiro acesso e dispararia a emissão.
   */
  dynamicNames?(): Promise<Array<{ host: string; projectId: string }>>;
  /** Certificados já emitidos pelo Caddy; null = não deu para ler. */
  issuedCertificates?(): Promise<Map<string, CertificateStatus> | null>;
}

export interface CertificateServiceOptions {
  audit?: CertificateAuditSink;
  alerts?: Pick<AlertsService, "create" | "list" | "resolveActive">;
  /** Desde quando cada nome falha (sobrevive ao reinício; sem ele a duração vem só do log de 24 h). */
  failureStore?: CertificateFailureStore;
  now?: () => number;
  log?: (message: string) => void;
}

export interface CertificateFilter {
  kind?: CertificateOwnerKind;
  projectId?: string;
  host?: string;
  /** Só estes nomes (a aba de domínios dinâmicos do projeto). */
  hosts?: ReadonlySet<string>;
}

interface Named {
  host: string;
  owner: CertificateOwner;
  /** Domínio dinâmico: emissão sob demanda; nunca se abre conexão TLS para olhá-lo. */
  dynamic?: true;
}

/** Quanto tempo vale a leitura do armazenamento do Caddy (a tela pede a lista com frequência). */
const ISSUED_CACHE_MS = 20_000;

function onDemandOnly(host: string, why: string) {
  return httpError(409, "on_demand", `${host} é um domínio dinâmico: ${why}.`);
}

function isLocal(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost");
}

export class CertificateService {
  private readonly audit: CertificateAuditSink | undefined;
  private readonly alerts: Pick<AlertsService, "create" | "list" | "resolveActive"> | undefined;
  private readonly failureStore: CertificateFailureStore | undefined;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  /** host → último "Tentar emitir agora" (ms). Só em memória. */
  private readonly retries = new Map<string, number>();
  private issuedCache: { at: number; value: Map<string, CertificateStatus> | null } | null = null;

  constructor(
    private readonly store: ManualCertificateStore,
    private readonly deps: CertificateDeps,
    opts: CertificateServiceOptions = {},
  ) {
    this.audit = opts.audit;
    this.alerts = opts.alerts;
    this.failureStore = opts.failureStore;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.warn(m));
  }

  /** Todos os nomes servidos por HTTPS, com o dono. O primeiro dono de um nome vence. */
  private async names(): Promise<Named[]> {
    const out: Named[] = [];
    const seen = new Set<string>();
    const add = (host: string, owner: CertificateOwner, dynamic = false) => {
      const h = host.trim().toLowerCase();
      if (!h || isLocal(h) || seen.has(h)) return;
      seen.add(h);
      out.push({ host: h, owner, ...(dynamic ? { dynamic: true as const } : {}) });
    };
    const panel = this.deps.panelDomain();
    if (panel) add(panel, { kind: "panel", projectId: null, projectName: null });
    for (const alias of this.deps.panelAliases?.() ?? []) add(alias, { kind: "panel", projectId: null, projectName: null });
    for (const p of await this.deps.listProjects()) {
      for (const d of [p.domain, ...(p.aliases ?? [])]) {
        if (d) add(d, { kind: "project", projectId: p.id, projectName: p.name });
      }
    }
    let mail: string[] = [];
    try {
      mail = await this.deps.mailHosts();
    } catch {
      mail = [];
    }
    for (const h of mail) add(h, { kind: "mail", projectId: null, projectName: null });
    // Domínios dinâmicos entram por último: nome fixo de site, do painel ou do e-mail sempre vence.
    const projects = new Map((await this.deps.listProjects()).map((p) => [p.id, p.name] as const));
    for (const d of await this.dynamicNamesSafe()) {
      add(d.host, { kind: "project", projectId: d.projectId, projectName: projects.get(d.projectId) ?? null }, true);
    }
    return out;
  }

  /** Lista dos dinâmicos; arquivo ilegível não derruba a página (os demais nomes seguem). */
  private async dynamicNamesSafe(): Promise<Array<{ host: string; projectId: string }>> {
    try {
      return (await this.deps.dynamicNames?.()) ?? [];
    } catch (err) {
      this.log(`Certificados: domínios dinâmicos ilegíveis (${err instanceof Error ? err.message : String(err)}).`);
      return [];
    }
  }

  /** O que o Caddy já emitiu, com um cache curto (centenas de nomes numa leitura só). */
  private async issued(): Promise<Map<string, CertificateStatus> | null> {
    const t = this.now();
    if (this.issuedCache && t - this.issuedCache.at < ISSUED_CACHE_MS) return this.issuedCache.value;
    let value: Map<string, CertificateStatus> | null = null;
    try {
      value = (await this.deps.issuedCertificates?.()) ?? null;
    } catch (err) {
      this.log(`Certificados: armazenamento do Caddy ilegível (${err instanceof Error ? err.message : String(err)}).`);
    }
    this.issuedCache = { at: t, value };
    return value;
  }

  private async findName(host: string): Promise<Named> {
    const h = host.trim().toLowerCase();
    const named = (await this.names()).find((n) => n.host === h);
    if (!named) throw httpError(404, "unknown_host", `O painel não serve o nome ${h} por HTTPS.`);
    return named;
  }

  /** O que o log do Caddy diz: último evento e falhas em curso de cada nome. */
  private async logInfo(): Promise<LogInfo> {
    try {
      const text = await this.deps.caddyLogs();
      return { events: parseCaddyCertificateLog(text), failures: summarizeCaddyIssueFailures(text), known: text.trim() !== "" };
    } catch (err) {
      this.log(`Certificados: log do Caddy ilegível (${err instanceof Error ? err.message : String(err)}).`);
      return EMPTY_LOG;
    }
  }

  /** Falha em curso de um nome automático, com a causa traduzida (certmagic tenta de novo sozinho). */
  private async failureFor(host: string, automatic: boolean, log: LogInfo): Promise<CertificateItemFailure | null> {
    const f = automatic ? log.failures.get(host) : undefined;
    if (!f) {
      // Avaliação completa (log legível e com conteúdo) sem falha: esquece o início antigo, para uma falha
      // nova não herdá-lo. Log desconhecido não prova nada: não mexe.
      if (automatic && log.known) await this.guard(() => this.failureStore?.clear(host));
      return null;
    }
    const explained = { ...explainIssueError(f.detail ?? "", new Date(this.now())), at: f.lastAt };
    // O log guarda só 24 h: o início da falha vem do arquivo, para a duração poder passar de 24 h.
    const firstAt =
      (await this.guard(() => this.failureStore?.record(host, f.firstAt, new Date(this.now()).toISOString()))) ?? f.firstAt;
    return { rounds: f.rounds, firstAt, lastAt: f.lastAt, error: await this.refineWithDns(host, explained) };
  }

  /** Gravar o início da falha nunca derruba a página: sem o arquivo, vale o que o log mostra. */
  private async guard<T>(fn: () => Promise<T> | undefined): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      this.log(`Certificados: início da falha não gravado (${err instanceof Error ? err.message : String(err)}).`);
      return undefined;
    }
  }

  async list(filter: CertificateFilter = {}): Promise<CertificateListResponse> {
    let names = await this.names();
    if (!filter.kind && !filter.projectId && !filter.host) {
      const keep = new Set(names.map((n) => n.host));
      await this.guard(() => this.failureStore?.prune(keep));
    }
    if (filter.kind) names = names.filter((n) => n.owner.kind === filter.kind);
    if (filter.projectId) names = names.filter((n) => n.owner.projectId === filter.projectId);
    if (filter.host) names = names.filter((n) => n.host === filter.host!.toLowerCase());
    if (filter.hosts) names = names.filter((n) => filter.hosts!.has(n.host));
    const proxyRunning = await this.deps.proxyRunning().catch(() => false);
    const issued = proxyRunning && names.some((n) => n.dynamic) ? await this.issued() : null;
    const [manual, log] = await Promise.all([this.store.list(), proxyRunning ? this.logInfo() : EMPTY_LOG]);
    const items = await Promise.all(names.map((n) => this.itemFor(n, manual, log, proxyRunning, issued)));
    // mail.<domínio> válido: instala no servidor de e-mail na hora (o syncTls
    // só mexe no Stalwart se o certificado mudou).
    if (this.deps.syncMailTls && items.some((i) => i.owner.kind === "mail" && i.issuer !== null)) {
      this.deps.syncMailTls().catch((err: unknown) =>
        this.log(`Certificados: falha ao instalar no servidor de e-mail (${err instanceof Error ? err.message : String(err)}).`),
      );
    }
    return { checkedAt: new Date(this.now()).toISOString(), proxyRunning, items };
  }

  private async itemFor(
    named: Named,
    manualAll: ManualCertificateMeta[],
    log: LogInfo,
    proxyRunning: boolean,
    issued: Map<string, CertificateStatus> | null = null,
  ): Promise<CertificateItem> {
    const { host, owner } = named;
    const own = manualAll.find((m) => m.host === host) ?? null;
    const covering = own ? null : (manualAll.find((m) => covers(m.names, host)) ?? null);
    const mode = own || covering ? "manual" : "automatic";
    const base = {
      host,
      owner,
      mode,
      coveredBy: covering?.host ?? null,
      manual: own
        ? { issuer: own.issuer, validFrom: own.validFrom, validTo: own.validTo, names: own.names, installedAt: own.installedAt }
        : null,
    } as const;

    const nowMs = this.now();
    // Sem certificado servido: nada de datas. O alerta vem da avaliação única (core).
    const none = { issuer: null, validFrom: null, validTo: null, renewsAround: null } as const;
    const automatic = mode === "automatic";

    if (!proxyRunning) {
      return { ...base, ...none, state: "unknown", lastError: null, canRetry: false, alert: NO_ALERT, failure: null, failureKnown: false };
    }

    // Dinâmico: lê o que o Caddy guardou. O handshake com SNI seria o primeiro acesso e dispararia a emissão.
    const served = named.dynamic
      ? (issued?.get(host) ?? { ok: false, issuer: null, validFrom: null, validTo: null, error: issued ? "sem certificado ainda" : "armazenamento do Caddy ilegível" })
      : await this.deps
          .servedCertificate(host)
          .catch((err: unknown): CertificateStatus => ({ ok: false, issuer: null, validFrom: null, validTo: null, error: String(err) }));
    const failure = await this.failureFor(host, automatic, log);
    if (served.ok && served.validTo) {
      const tier = certificateValidityTier(mode, served.validFrom, served.validTo, nowMs);
      const state: CertificateState = tier === "expired" ? "expired" : tier === "ok" ? "valid" : "expiring";
      return {
        ...base,
        state,
        issuer: served.issuer,
        validFrom: served.validFrom ?? null,
        validTo: served.validTo,
        renewsAround: automatic ? expectedRenewalAt(served.validFrom, served.validTo) : null,
        lastError: null,
        canRetry: false,
        alert: assessCertificateAlert({ mode, nowMs, validFrom: served.validFrom ?? null, validTo: served.validTo, failure }),
        failure,
        failureKnown: log.known,
      };
    }

    if (/expired/i.test(served.error ?? "")) {
      const alert = assessCertificateAlert({ mode, nowMs, validFrom: null, validTo: null, servedExpired: true });
      return { ...base, ...none, state: "expired", lastError: null, canRetry: automatic, alert, failure, failureKnown: log.known };
    }

    const event = log.events.get(host) ?? null;
    const retriedAt = this.retries.get(host) ?? 0;
    const eventAt = event?.at ? Date.parse(event.at) : 0;
    const retryPending = retriedAt > 0 && this.now() - retriedAt < RETRY_PENDING_MS && retriedAt >= eventAt;

    let lastError: CertificateIssueError | null = null;
    if (event?.kind === "error" && !retryPending) {
      lastError = { ...explainIssueError(event.detail ?? "", new Date(this.now())), at: event.at };
      lastError = await this.refineWithDns(host, lastError);
    }
    // Dinâmico sem nenhuma tentativa no log: aguardando o primeiro acesso (o DNS ainda pode nem apontar). Não é falha.
    const state: CertificateState = lastError
      ? "failed"
      : named.dynamic
        ? issued === null
          ? "unknown"
          : event
            ? "issuing"
            : "waiting"
        : automatic
          ? "issuing"
          : "failed";
    if (!automatic && !lastError) {
      lastError = {
        cause: "unknown",
        message:
          "O proxy não está servindo o certificado manual deste nome. Confira se o DNS aponta para esta VPS; se continuar, envie o certificado de novo.",
        detail: served.error ? served.error.slice(0, 300) : null,
        at: null,
        retryAfter: null,
      };
    }
    const alert = assessCertificateAlert({ mode, nowMs, validFrom: null, validTo: null, failure });
    return { ...base, ...none, state, lastError, canRetry: automatic, alert, failure, failureKnown: log.known };
  }

  /** Se o DNS do nome está nos IPs da Cloudflare, a causa é a nuvem laranja. */
  private async refineWithDns(host: string, error: CertificateIssueError): Promise<CertificateIssueError> {
    if (!this.deps.resolve4 || error.cause === "rate_limit" || error.cause === "caa") return error;
    const ips = await this.deps.resolve4(host).catch(() => [] as string[]);
    if (ips.length > 0 && ips.every(isCloudflareIp)) {
      return {
        ...error,
        cause: "cloudflare",
        message:
          "A Cloudflare está na frente deste nome (nuvem laranja) e atende no lugar da VPS. No painel da Cloudflare, deixe a nuvem CINZA (\"Somente DNS\") neste registro e tente de novo.",
      };
    }
    return error;
  }

  /** "Tentar emitir agora". */
  /**
   * "Tentar emitir agora". Com `background`, as conferências (nome, modo
   * manual, limite, certificado já válido, limite do Let's Encrypt) são as
   * mesmas e continuam podendo recusar, mas o recarregamento do proxy não
   * prende quem pediu: falha dele vai para o log. Usado pela verificação de
   * DNS do e-mail, quando o registro A de mail.<domínio> fica certo.
   */
  async retry(hostRaw: string, opts: { background?: boolean } = {}): Promise<CertificateRetryResponse> {
    const named = await this.findName(hostRaw);
    const host = named.host;
    if (named.dynamic) throw onDemandOnly(host, "o certificado sai sozinho no primeiro acesso (abra https://" + host + ") e o painel não precisa recarregar o proxy");
    const manual = await this.store.list();
    if (manual.some((m) => m.host === host || covers(m.names, host))) {
      throw httpError(
        409,
        "manual_mode",
        `${host} usa um certificado manual: o painel não emite para ele. Para o painel emitir, use "Voltar para automático".`,
      );
    }
    const last = this.retries.get(host);
    if (last !== undefined && this.now() - last < RETRY_MIN_INTERVAL_MS) {
      const wait = Math.ceil((RETRY_MIN_INTERVAL_MS - (this.now() - last)) / 1000);
      const err = httpError(429, "retry_too_soon", `Já pedimos a emissão de ${host} agora há pouco. Tente de novo em ${wait} s.`);
      err.details = { retryAfterSeconds: wait };
      throw err;
    }
    const served = await this.deps.servedCertificate(host).catch(() => null);
    if (served?.ok) {
      throw httpError(
        409,
        "already_valid",
        `O certificado de ${host} já está válido e o painel renova sozinho perto do fim. Não é preciso emitir de novo — ` +
          "e pedir certificados repetidos pode bater no limite do Let's Encrypt (5 iguais por semana).",
      );
    }
    const event = (await this.logInfo()).events.get(host);
    if (event?.kind === "error") {
      const explained = explainIssueError(event.detail ?? "", new Date(this.now()));
      if (explained.cause === "rate_limit" && explained.retryAfter && Date.parse(explained.retryAfter) > this.now()) {
        const err = httpError(409, "issuer_rate_limited", explained.message);
        err.details = { retryAfter: explained.retryAfter };
        throw err;
      }
    }
    this.retries.set(host, this.now());
    const reload = this.deps.refreshProxy({ force: true });
    if (opts.background) {
      reload.catch((err: unknown) =>
        this.log(`Certificados: falha ao pedir a emissão de ${host} (${err instanceof Error ? err.message : String(err)}).`),
      );
    } else {
      await reload;
    }
    void this.audit?.record({ action: "certificate.retry", target: host, detail: `Emissão do certificado de ${host} pedida de novo.` });
    return {
      host,
      message: `Pedimos ao proxy que tente emitir o certificado de ${host} agora. Costuma levar de alguns segundos a 2 minutos.`,
    };
  }

  /** Instala um certificado manual para o nome. */
  async installManual(hostRaw: string, cert: string, key: string): Promise<CertificateItem> {
    const named = await this.findName(hostRaw);
    if (named.dynamic) throw onDemandOnly(named.host, "certificado manual não vale para domínio dinâmico (a emissão é sob demanda)");
    const r = inspectCertificatePair(named.host, cert, key, new Date(this.now()));
    if (!r.ok) throw httpError(400, r.reason, r.message);
    const meta = await this.store.install(named.host, r.certificate, new Date(this.now()).toISOString());
    await this.deps.refreshProxy({ force: false });
    if (named.owner.kind === "mail") await this.syncMail();
    void this.audit?.record({
      action: "certificate.manual_install",
      target: named.host,
      detail: `Certificado manual instalado para ${named.host} (emissor: ${meta.issuer ?? "—"}, válido até ${meta.validTo}).`,
    });
    await this.checkExpiryAlerts();
    return this.itemNow(named);
  }

  /** Volta o nome para o automático (o Caddy volta a emitir). */
  async removeManual(hostRaw: string): Promise<CertificateItem> {
    const named = await this.findName(hostRaw);
    const meta = await this.store.get(named.host);
    if (!meta || !(await this.store.remove(named.host))) {
      throw httpError(404, "no_manual_certificate", `${named.host} não tem certificado manual.`);
    }
    await this.deps.refreshProxy({ force: false });
    await this.deps.removeManualFiles(named.host).catch((err: unknown) =>
      this.log(`Certificados: arquivos antigos de ${named.host} não apagados do proxy (${err instanceof Error ? err.message : String(err)}).`),
    );
    if (named.owner.kind === "mail") await this.syncMail();
    void this.audit?.record({
      action: "certificate.manual_remove",
      target: named.host,
      detail: `Certificado manual de ${named.host} removido (emissor: ${meta.issuer ?? "—"}, válido até ${meta.validTo}); volta ao automático.`,
    });
    return this.itemNow(named);
  }

  private async syncMail(): Promise<void> {
    try {
      await this.deps.syncMailTls?.();
    } catch (err) {
      this.log(`Certificados: falha ao instalar no servidor de e-mail (${err instanceof Error ? err.message : String(err)}).`);
    }
  }

  private async itemNow(named: Named): Promise<CertificateItem> {
    const proxyRunning = await this.deps.proxyRunning().catch(() => false);
    return this.itemFor(named, await this.store.list(), EMPTY_LOG, proxyRunning);
  }

  /**
   * Os títulos antigos ("vence em até 7/30 dias") foram trocados; o alerta que
   * ficou aberto com o título antigo é resolvido para não duplicar com o novo.
   */
  private async resolveLegacyManualAlerts(): Promise<void> {
    const { alerts } = await this.alerts!.list({ source: "certificate", perPage: 200 });
    for (const a of alerts) {
      if (a.status !== "resolved" && LEGACY_MANUAL_TITLE.test(a.title)) await this.alerts!.resolveActive("certificate", a.title);
    }
  }

  /**
   * Manual não renova sozinho: alerta quando falta 1/3 da validade (no máximo
   * 30 dias: um certificado de 90 dias avisa com 30), crítico perto do fim e
   * quando vence (janelas em @paas/core, certificateThresholds). O título é
   * fixo por faixa — o mesmo alerta aberto é atualizado em vez de duplicado
   * (AlertsService).
   */
  async checkExpiryAlerts(): Promise<void> {
    if (!this.alerts) return;
    await this.resolveLegacyManualAlerts();
    for (const m of await this.store.list()) {
      const tier = certificateValidityTier("manual", m.validFrom, m.validTo, this.now());
      if (tier === "ok") continue;
      const day = new Date(m.validTo).toLocaleDateString("pt-BR", { timeZone: "UTC" });
      const what = `O certificado manual de ${m.host} (emissor: ${m.issuer ?? "—"}) não renova sozinho e vence em ${day}. ` +
        'Envie um certificado novo em Certificados ou use "Voltar para automático".';
      const title =
        tier === "expired"
          ? `Certificado manual de ${m.host} venceu`
          : tier === "critical"
            ? `Certificado manual de ${m.host} está perto de vencer`
            : `Certificado manual de ${m.host} vence em breve`;
      await this.alerts.create({ severity: tier === "warning" ? "warning" : "critical", source: "certificate", title, detail: what });
    }
  }
}
