/**
 * mail-health-service.ts — saúde de entregabilidade por domínio de e-mail
 * (plano de registros DNS + verificação ao vivo). A regra de cada verificação
 * está em packages/mailer/src/deliverability-health.ts; aqui ficam a coleta
 * dos fatos que dependem do painel (PTR, certificado, listas de bloqueio), o
 * limite de uso e a última verificação de cada domínio.
 *
 * Segurança: nenhum destino vem de quem chama a API. Os alvos são o domínio
 * cadastrado, os resolvedores públicos fixos e os MX de teste da porta 25.
 * "Verificar agora" tem intervalo mínimo por domínio e a sonda da porta 25
 * fica em cache (não vira ferramenta de varredura contra Google/Microsoft).
 */
import dns from "node:dns/promises";
import {
  applyAcknowledgements,
  buildDnsPlan,
  evaluateHealth,
  fetchMtaStsPolicy,
  probePort25,
  type MtaStsCertState,
  type PlanInput,
  type Port25Result,
  type QueueItemView,
  type ResolverEntry,
  type StoredAcknowledgement,
} from "@paas/mailer";
import {
  isMailHealthAcknowledgeable,
  mailHealthFingerprint,
  MAIL_HEALTH_ACK_REASON_MAX,
  MAIL_HEALTH_MIN_INTERVAL_MS,
  type MailHealthCheckId,
  type BlacklistCheckResponse,
  type DeliveryHealthResponse,
  type DeliveryHealthStateResponse,
  type DnsPlanResponse,
  type DnsVerifyResponse,
  type MailTlsStatusResponse,
} from "@paas/core";
import { httpError } from "./http-error.js";

export interface MailHealthDeps {
  planInput(domain: string): Promise<PlanInput>;
  /** Verificação de DNS do checklist (traz o PTR); também atualiza o resumo do domínio. */
  verify(domain: string): Promise<DnsVerifyResponse>;
  tls(): Promise<MailTlsStatusResponse>;
  /** Última conferência de listas de bloqueio (a diária); null = nunca rodou. */
  blacklist(): Promise<BlacklistCheckResponse | null>;
  /** Fila do servidor de e-mail agora (mensagens adiadas incluídas). */
  queue(): Promise<QueueItemView[]>;
  /** Resolvedores públicos diferentes (padrão: Cloudflare, Google, Quad9). */
  resolvers?: () => ResolverEntry[];
  probePort25?: () => Promise<Port25Result>;
  fetchPolicy?: (domain: string) => Promise<string | null>;
  /** Estado do certificado de mta-sts.<domínio> segundo o painel (sem handshake TLS). Ausente = desconhecido. */
  certState?: (host: string) => Promise<MtaStsCertState>;
  /** O proxy publica a política MTA-STS? (precisa do domínio do painel). Ausente = sim. */
  mtaStsPublishing?: () => Promise<boolean>;
  /** Marcações "ciente" (itens que dependem do provedor). Ausente = guardadas só em memória (testes). */
  acks?: AckPort;
  isProxyIp: (ip: string) => boolean;
  log?: (message: string) => void;
  now?: () => number;
}

/** Onde ficam as marcações "ciente" (o arquivo do painel; em memória nos testes). */
export interface AckPort {
  all(): Promise<Partial<Record<MailHealthCheckId, StoredAcknowledgement>>>;
  set(id: MailHealthCheckId, ack: StoredAcknowledgement): Promise<void>;
  remove(id: MailHealthCheckId): Promise<boolean>;
}

function memoryAcks(): AckPort {
  let map: Partial<Record<MailHealthCheckId, StoredAcknowledgement>> = {};
  return {
    all: async () => map,
    set: async (id, ack) => {
      map = { ...map, [id]: ack };
    },
    remove: async (id) => {
      const had = id in map;
      const { [id]: _gone, ...rest } = map;
      map = rest;
      return had;
    },
  };
}

/** Intervalo mínimo entre duas verificações do mesmo domínio ("Verificar agora"). */
export const HEALTH_MIN_INTERVAL_MS = MAIL_HEALTH_MIN_INTERVAL_MS;
/**
 * Limite do servidor todo: no máximo isto de verificações completas feitas pelo
 * botão por minuto, somando todos os domínios (cada uma faz dezenas de consultas
 * DNS e pode abrir conexões de saída). A rotina diária não conta.
 */
export const HEALTH_MAX_MANUAL_PER_MINUTE = 10;
/** A sonda da porta 25 não repete antes disto (ela conecta em servidores de terceiros). */
export const PORT25_CACHE_MS = 10 * 60_000;
const PUBLIC_RESOLVERS = [
  ["Cloudflare (1.1.1.1)", "1.1.1.1"],
  ["Google (8.8.8.8)", "8.8.8.8"],
  ["Quad9 (9.9.9.9)", "9.9.9.9"],
] as const;

function publicResolvers(): ResolverEntry[] {
  return PUBLIC_RESOLVERS.map(([label, server]) => {
    const resolver = new dns.Resolver({ timeout: 2_000, tries: 2 });
    resolver.setServers([server]);
    return { label, resolver };
  });
}

/** Minúsculas e sem ponto final: a chave de limite e de fusão é sempre a mesma. */
export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.+$/, "");
}

/** Anexa "espere N s" ao erro 429: a rota devolve como Retry-After e a tela usa essa espera. */
function withRetryAfter(err: ReturnType<typeof httpError>, seconds: number): ReturnType<typeof httpError> {
  err.details = { retryAfter: seconds };
  return err;
}

export class MailHealthService {
  private readonly reports = new Map<string, DeliveryHealthResponse>();
  private readonly lastRun = new Map<string, number>();
  private readonly running = new Map<string, Promise<DeliveryHealthResponse>>();
  private readonly manualRuns: number[] = [];
  private port25: { at: number; result: Port25Result } | null = null;
  private readonly acks: AckPort;
  /** Última leitura das marcações (para o resumo síncrono). */
  private ackCache: Partial<Record<MailHealthCheckId, StoredAcknowledgement>> = {};

  constructor(private readonly deps: MailHealthDeps) {
    this.acks = deps.acks ?? memoryAcks();
  }

  /** Relatório guardado (bruto) com as marcações "ciente" que ainda valem. */
  private async withAcks(report: DeliveryHealthResponse): Promise<DeliveryHealthResponse> {
    // arquivo de marcações ilegível não derruba a tela: sem marcações, tudo conta como antes
    this.ackCache = await this.acks.all().catch(() => ({}));
    return applyAcknowledgements(report, this.ackCache);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  async plan(domain: string): Promise<DnsPlanResponse> {
    return buildDnsPlan(await this.deps.planInput(normalizeDomain(domain)));
  }

  async state(domain: string): Promise<DeliveryHealthStateResponse> {
    const plan = await this.plan(domain);
    const raw = this.reports.get(plan.domain);
    return { plan, report: raw ? await this.withAcks(raw) : null };
  }

  /**
   * Marca um item que depende do provedor (PTR, porta 25) como "ciente". Vale para o problema de
   * agora: se ele mudar, o item volta a contar sozinho. Precisa de uma verificação feita.
   */
  async acknowledge(domain: string, id: string, input: { reason?: string | null; by?: string | null }): Promise<DeliveryHealthStateResponse> {
    if (!isMailHealthAcknowledgeable(id)) {
      throw httpError(422, "not_acknowledgeable", "Só os itens que dependem do provedor da VPS podem ser marcados como ciente.");
    }
    const plan = await this.plan(domain);
    const raw = this.reports.get(plan.domain);
    if (!raw) throw httpError(409, "health_not_checked", "Verifique a saúde do e-mail antes de marcar um item como ciente.");
    const item = raw.checks.find((c) => c.id === id);
    // crítico nunca é silenciado (porta 25 bloqueada = nenhum e-mail sai)
    if (!item || item.level !== "warn") {
      throw httpError(409, "nothing_to_acknowledge", "Esse item não está em atenção: não há o que marcar como ciente.");
    }
    const reason = (input.reason ?? "").replace(/\s+/g, " ").trim().slice(0, MAIL_HEALTH_ACK_REASON_MAX);
    await this.acks.set(id, {
      fingerprint: mailHealthFingerprint(item),
      reason: reason === "" ? null : reason,
      at: new Date(this.now()).toISOString(),
      by: input.by ?? null,
    });
    return this.state(domain);
  }

  /** Tira a marcação "ciente": o item volta a contar. Sem marcação, não faz nada. */
  async unacknowledge(domain: string, id: string): Promise<DeliveryHealthStateResponse> {
    if (!isMailHealthAcknowledgeable(id)) {
      throw httpError(422, "not_acknowledgeable", "Só os itens que dependem do provedor da VPS podem ser marcados como ciente.");
    }
    await this.plan(domain);
    await this.acks.remove(id);
    return this.state(domain);
  }

  /** Verifica agora. `manual` = botão (intervalo mínimo por domínio); a rotina diária não tem. */
  check(rawDomain: string, opts: { manual: boolean }): Promise<DeliveryHealthResponse> {
    // Mesma chave para "Loja.Example.com", "loja.example.com" e "loja.example.com.":
    // o intervalo e a fusão de chamadas não se burlam trocando a grafia.
    const domain = normalizeDomain(rawDomain);
    const running = this.running.get(domain);
    if (running) return running;
    const last = this.lastRun.get(domain);
    if (opts.manual && last !== undefined && this.now() - last < HEALTH_MIN_INTERVAL_MS) {
      const wait = Math.ceil((HEALTH_MIN_INTERVAL_MS - (this.now() - last)) / 1000);
      return Promise.reject(withRetryAfter(httpError(429, "health_check_too_soon", `A verificação acabou de rodar. Espere ${wait} s para verificar de novo.`), wait));
    }
    if (opts.manual) {
      const windowStart = this.now() - 60_000;
      while (this.manualRuns.length > 0 && (this.manualRuns[0] as number) <= windowStart) this.manualRuns.shift();
      if (this.manualRuns.length >= HEALTH_MAX_MANUAL_PER_MINUTE) {
        const wait = Math.max(1, Math.ceil((((this.manualRuns[0] as number) + 60_000) - this.now()) / 1000));
        return Promise.reject(
          withRetryAfter(httpError(429, "health_check_busy", `Muitas verificações de saúde em pouco tempo neste servidor. Espere ${wait} s e tente de novo.`), wait),
        );
      }
      this.manualRuns.push(this.now());
    }
    const stamp = this.now();
    this.lastRun.set(domain, stamp);
    const promise = this.doCheck(domain)
      .catch((err: unknown) => {
        // Domínio não cadastrado: não gasta a vaga do servidor nem fica na memória.
        if ((err as { statusCode?: number } | null)?.statusCode === 404) {
          const i = opts.manual ? this.manualRuns.indexOf(stamp) : -1;
          if (i >= 0) this.manualRuns.splice(i, 1);
          this.lastRun.delete(domain);
        }
        throw err;
      })
      .finally(() => this.running.delete(domain));
    this.running.set(domain, promise);
    return promise;
  }

  private async cachedPort25(): Promise<Port25Result> {
    if (this.port25 && this.now() - this.port25.at < PORT25_CACHE_MS) return this.port25.result;
    const result = await (this.deps.probePort25 ?? probePort25)();
    // "Não deu para testar" não fica em cache: a próxima verificação tenta de novo.
    this.port25 = result.status === "error" ? null : { at: this.now(), result };
    return result;
  }

  private async doCheck(domain: string): Promise<DeliveryHealthResponse> {
    const plan = await this.deps.planInput(domain);
    const [verify, tls, blacklist, port25, queue] = await Promise.all([
      this.deps.verify(domain),
      this.deps.tls().catch((err: unknown) => {
        this.deps.log?.(`Saúde do e-mail: certificado não conferido (${err instanceof Error ? err.message : String(err)}).`);
        return null;
      }),
      this.deps.blacklist().catch(() => null),
      this.cachedPort25(),
      this.deps.queue().catch(() => null),
    ]);
    const report = await evaluateHealth({
      ...plan,
      resolvers: (this.deps.resolvers ?? publicResolvers)(),
      ptr: verify.ptr,
      port25,
      queue,
      // certificado não conferido: não acusa servidor parado, só deixa de avaliar
      serverRunning: tls?.serverRunning ?? true,
      tlsHosts: (tls?.hosts ?? []).map((h) => ({ host: h.host, ok: h.ok, validTo: h.validTo, error: h.error })),
      blacklist,
      fetchPolicy: this.deps.fetchPolicy ?? ((d) => fetchMtaStsPolicy(d)),
      ...(this.deps.certState ? { mtaStsCertState: this.deps.certState } : {}),
      mtaStsPublishing: await (this.deps.mtaStsPublishing?.() ?? Promise.resolve(true)).catch(() => true),
      isProxyIp: this.deps.isProxyIp,
      now: this.now(),
    });
    this.reports.set(report.domain, report);
    return this.withAcks(report);
  }
}
