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
 *   alerta a 30 e a 7 dias do fim.
 */
import type {
  CertificateIssueError,
  CertificateItem,
  CertificateListResponse,
  CertificateOwner,
  CertificateOwnerKind,
  CertificateRetryResponse,
  CertificateState,
  Project,
} from "@paas/core";
import { explainIssueError, parseCaddyCertificateLog, type CaddyCertEvent, type CertificateStatus } from "@paas/deploy";
import { inspectCertificatePair } from "@paas/mailer";
import { isCloudflareIp } from "../routes/domains.js";
import type { AlertsService } from "./alerts-service.js";
import { covers, type ManualCertificateMeta, type ManualCertificateStore } from "./certificate-store.js";
import { httpError } from "./http-error.js";

const DAY_MS = 24 * 3600 * 1000;
/** O Let's Encrypt (via Caddy) renova quando falta ~1/3 da validade: ~30 dias num certificado de 90. */
const RENEW_BEFORE_MS = 30 * DAY_MS;
/** Automático que não renovou até 20 dias do fim: algo está errado. */
const AUTO_EXPIRING_MS = 20 * DAY_MS;
/** Manual: avisa a 30 dias do fim. */
const MANUAL_EXPIRING_MS = 30 * DAY_MS;
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
}

export interface CertificateServiceOptions {
  audit?: CertificateAuditSink;
  alerts?: Pick<AlertsService, "create">;
  now?: () => number;
  log?: (message: string) => void;
}

export interface CertificateFilter {
  kind?: CertificateOwnerKind;
  projectId?: string;
  host?: string;
}

interface Named {
  host: string;
  owner: CertificateOwner;
}

function isLocal(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost");
}

export class CertificateService {
  private readonly audit: CertificateAuditSink | undefined;
  private readonly alerts: Pick<AlertsService, "create"> | undefined;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  /** host → último "Tentar emitir agora" (ms). Só em memória. */
  private readonly retries = new Map<string, number>();

  constructor(
    private readonly store: ManualCertificateStore,
    private readonly deps: CertificateDeps,
    opts: CertificateServiceOptions = {},
  ) {
    this.audit = opts.audit;
    this.alerts = opts.alerts;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.warn(m));
  }

  /** Todos os nomes servidos por HTTPS, com o dono. O primeiro dono de um nome vence. */
  private async names(): Promise<Named[]> {
    const out: Named[] = [];
    const seen = new Set<string>();
    const add = (host: string, owner: CertificateOwner) => {
      const h = host.trim().toLowerCase();
      if (!h || isLocal(h) || seen.has(h)) return;
      seen.add(h);
      out.push({ host: h, owner });
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
    return out;
  }

  private async findName(host: string): Promise<Named> {
    const h = host.trim().toLowerCase();
    const named = (await this.names()).find((n) => n.host === h);
    if (!named) throw httpError(404, "unknown_host", `O painel não serve o nome ${h} por HTTPS.`);
    return named;
  }

  private async events(): Promise<Map<string, CaddyCertEvent>> {
    try {
      return parseCaddyCertificateLog(await this.deps.caddyLogs());
    } catch (err) {
      this.log(`Certificados: log do Caddy ilegível (${err instanceof Error ? err.message : String(err)}).`);
      return new Map();
    }
  }

  async list(filter: CertificateFilter = {}): Promise<CertificateListResponse> {
    let names = await this.names();
    if (filter.kind) names = names.filter((n) => n.owner.kind === filter.kind);
    if (filter.projectId) names = names.filter((n) => n.owner.projectId === filter.projectId);
    if (filter.host) names = names.filter((n) => n.host === filter.host!.toLowerCase());
    const proxyRunning = await this.deps.proxyRunning().catch(() => false);
    const [manual, events] = await Promise.all([this.store.list(), proxyRunning ? this.events() : new Map()]);
    const items = await Promise.all(names.map((n) => this.itemFor(n, manual, events, proxyRunning)));
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
    events: Map<string, CaddyCertEvent>,
    proxyRunning: boolean,
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

    if (!proxyRunning) {
      return { ...base, state: "unknown", issuer: null, validTo: null, renewsAround: null, lastError: null, canRetry: false };
    }

    const served = await this.deps
      .servedCertificate(host)
      .catch((err: unknown): CertificateStatus => ({ ok: false, issuer: null, validTo: null, error: String(err) }));
    if (served.ok && served.validTo) {
      const left = Date.parse(served.validTo) - this.now();
      const state: CertificateState =
        left <= 0 ? "expired" : left <= (mode === "manual" ? MANUAL_EXPIRING_MS : AUTO_EXPIRING_MS) ? "expiring" : "valid";
      return {
        ...base,
        state,
        issuer: served.issuer,
        validTo: served.validTo,
        renewsAround: mode === "automatic" ? new Date(Date.parse(served.validTo) - RENEW_BEFORE_MS).toISOString() : null,
        lastError: null,
        canRetry: false,
      };
    }

    const automatic = mode === "automatic";
    if (/expired/i.test(served.error ?? "")) {
      return { ...base, state: "expired", issuer: null, validTo: null, renewsAround: null, lastError: null, canRetry: automatic };
    }

    const event = events.get(host) ?? null;
    const retriedAt = this.retries.get(host) ?? 0;
    const eventAt = event?.at ? Date.parse(event.at) : 0;
    const retryPending = retriedAt > 0 && this.now() - retriedAt < RETRY_PENDING_MS && retriedAt >= eventAt;

    let lastError: CertificateIssueError | null = null;
    if (event?.kind === "error" && !retryPending) {
      lastError = { ...explainIssueError(event.detail ?? "", new Date(this.now())), at: event.at };
      lastError = await this.refineWithDns(host, lastError);
    }
    const state: CertificateState = lastError ? "failed" : automatic ? "issuing" : "failed";
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
    return { ...base, state, issuer: null, validTo: null, renewsAround: null, lastError, canRetry: automatic };
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
    const { host } = await this.findName(hostRaw);
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
    const event = (await this.events()).get(host);
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
    return this.itemFor(named, await this.store.list(), new Map(), proxyRunning);
  }

  /**
   * Manual não renova sozinho: alerta a 30 dias (aviso), a 7 dias e vencido
   * (crítico). O título é fixo por faixa — o mesmo alerta aberto é
   * atualizado em vez de duplicado (AlertsService).
   */
  async checkExpiryAlerts(): Promise<void> {
    if (!this.alerts) return;
    for (const m of await this.store.list()) {
      const left = Date.parse(m.validTo) - this.now();
      const day = new Date(m.validTo).toLocaleDateString("pt-BR", { timeZone: "UTC" });
      const what = `O certificado manual de ${m.host} (emissor: ${m.issuer ?? "—"}) não renova sozinho e vence em ${day}. ` +
        'Envie um certificado novo em Certificados ou use "Voltar para automático".';
      if (left <= 0) {
        await this.alerts.create({ severity: "critical", source: "certificate", title: `Certificado manual de ${m.host} venceu`, detail: what });
      } else if (left <= 7 * DAY_MS) {
        await this.alerts.create({ severity: "critical", source: "certificate", title: `Certificado manual de ${m.host} vence em até 7 dias`, detail: what });
      } else if (left <= 30 * DAY_MS) {
        await this.alerts.create({ severity: "warning", source: "certificate", title: `Certificado manual de ${m.host} vence em até 30 dias`, detail: what });
      }
    }
  }
}
