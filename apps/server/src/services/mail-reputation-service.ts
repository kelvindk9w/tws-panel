/**
 * mail-reputation-service.ts — reputação do e-mail (página Envios):
 * listas de bloqueio uma vez por dia e no botão "Conferir agora", a chave
 * DQS da Spamhaus, as marcações do Postmaster Tools / SNDS e os fatos da
 * nota de entregabilidade (DNS, PTR e certificado).
 *
 * Por que é daqui e não do Monitoramento: até 04/10/2026 a checagem era um
 * gancho no scan de segurança (routes/monitoring.ts). Só que o serviço de
 * e-mail é decorado DENTRO do plugin de rotas do e-mail, que o Fastify isola:
 * no plugin do Monitoramento `app.mailService` era undefined, o gancho
 * lançava TypeError e o scan engolia o erro em silêncio ("best-effort").
 * Resultado: a checagem nunca rodou. Agora quem agenda é o próprio e-mail.
 *
 * Arquivo: data/mail/reputacao.json (0600 — guarda a chave DQS).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  BlacklistCheckResponse,
  BlacklistResult,
  MailReputationResponse,
  PostmasterMarks,
  PtrCheckStatus,
} from "@paas/core";
import { checkDomainBlacklists, checkIpBlacklists, isValidDqsKey, type BlacklistOptions } from "@paas/mailer";
import { httpError } from "./http-error.js";

export interface DeliverabilityFacts {
  domains: Array<{ name: string; dnsOk: number | null; dnsTotal: number | null; ptr: PtrCheckStatus | null }>;
  tls: { ok: number; total: number } | null;
}

export interface ReputationDeps {
  dataDir: string;
  /** IP público e domínios cadastrados. */
  targets(): Promise<{ ip: string; domains: string[] }>;
  checkIp?(ip: string, opts: BlacklistOptions): Promise<BlacklistResult[]>;
  checkDomain?(domain: string, opts: BlacklistOptions): Promise<BlacklistResult[]>;
  /** DNS/PTR/certificado para a nota. */
  facts(): Promise<DeliverabilityFacts>;
  /** Algo listado: cria o alerta (uma linha por listagem). */
  onListed?(lines: string[]): Promise<void>;
  now?: () => number;
}

interface ReputationFile {
  dqsKey: string | null;
  lastCheck: BlacklistCheckResponse | null;
  lastError: string | null;
  lastAttemptAt: string | null;
  marks: PostmasterMarks;
  facts: (DeliverabilityFacts & { at: string }) | null;
}

const EMPTY: ReputationFile = {
  dqsKey: null,
  lastCheck: null,
  lastError: null,
  lastAttemptAt: null,
  marks: { googleAt: null, microsoftAt: null, spamRateOkAt: null },
  facts: null,
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FIRST_CHECK_MS = MINUTE;
const MANUAL_MIN_INTERVAL_MS = MINUTE;

export class MailReputationService {
  private readonly file: string;
  private readonly now: () => number;
  private readonly checkIp: NonNullable<ReputationDeps["checkIp"]>;
  private readonly checkDomain: NonNullable<ReputationDeps["checkDomain"]>;
  private running: Promise<MailReputationResponse> | null = null;
  private lastManualAt: number | null = null;
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private cache: ReputationFile | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ReputationDeps) {
    this.file = path.join(deps.dataDir, "mail", "reputacao.json");
    this.now = deps.now ?? Date.now;
    this.checkIp = deps.checkIp ?? ((ip, opts) => checkIpBlacklists(ip, undefined, opts));
    this.checkDomain = deps.checkDomain ?? ((domain, opts) => checkDomainBlacklists(domain, undefined, opts));
  }

  // -------------------------------------------------------------------------
  // Persistência
  // -------------------------------------------------------------------------

  /**
   * O arquivo é lido uma vez; depois vale a cópia em memória (o painel é o
   * único dono dele). As gravações saem em fila, na ordem.
   */
  private async load(): Promise<ReputationFile> {
    if (this.cache) return this.cache;
    let data: ReputationFile;
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Partial<ReputationFile>;
      data = { ...structuredClone(EMPTY), ...raw, marks: { ...EMPTY.marks, ...raw.marks } };
    } catch {
      data = structuredClone(EMPTY);
    }
    this.cache ??= data;
    return this.cache;
  }

  private save(data: ReputationFile): Promise<void> {
    const content = JSON.stringify(data, null, 2) + "\n";
    this.writing = this.writing.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(this.file, content, { encoding: "utf8", mode: 0o600 });
    });
    return this.writing;
  }

  private async update(change: (data: ReputationFile) => void): Promise<ReputationFile> {
    const data = await this.load();
    change(data);
    await this.save(data);
    return data;
  }

  /** Grava a hora da tentativa (o agendamento diário se guia por ela). */
  private async markAttempt(): Promise<void> {
    await this.update((d) => {
      d.lastAttemptAt = new Date(this.now()).toISOString();
    });
  }

  // -------------------------------------------------------------------------
  // Estado
  // -------------------------------------------------------------------------

  private nextCheckMs(data: ReputationFile): number {
    if (!data.lastAttemptAt) return this.now() + FIRST_CHECK_MS;
    return Date.parse(data.lastAttemptAt) + (data.lastError ? HOUR : DAY);
  }

  async state(): Promise<MailReputationResponse> {
    const data = await this.load();
    return {
      lastCheck: data.lastCheck,
      lastError: data.lastError,
      checking: this.running !== null,
      nextCheckAt: new Date(this.nextCheckMs(data)).toISOString(),
      dqs: { configured: Boolean(data.dqsKey), hint: data.dqsKey ? data.dqsKey.slice(-4) : null },
    };
  }

  async facts(): Promise<(DeliverabilityFacts & { at: string }) | null> {
    return (await this.load()).facts;
  }

  // -------------------------------------------------------------------------
  // Conferência
  // -------------------------------------------------------------------------

  /** Confere agora. `manual` = botão (no máximo uma por minuto). */
  check(opts: { manual: boolean }): Promise<MailReputationResponse> {
    if (opts.manual && !this.running) {
      if (this.lastManualAt !== null && this.now() - this.lastManualAt < MANUAL_MIN_INTERVAL_MS) {
        return Promise.reject(httpError(429, "check_too_soon", "A conferência acabou de rodar. Espere um minuto para conferir de novo."));
      }
      this.lastManualAt = this.now();
    }
    this.running ??= this.doCheck().finally(() => {
      this.running = null;
    });
    return this.running.then(() => this.state());
  }

  private async doCheck(): Promise<MailReputationResponse> {
    await this.markAttempt();
    const { dqsKey } = await this.load();
    try {
      const { ip, domains } = await this.deps.targets();
      if (domains.length === 0) {
        await this.update((d) => {
          d.lastError = "Nenhum domínio de e-mail cadastrado: ainda não há o que conferir.";
        });
        return this.state();
      }
      const opts = { dqsKey };
      const [ipResults, domainResults] = await Promise.all([
        this.checkIp(ip, opts),
        Promise.all(domains.map(async (domain) => ({ target: domain, results: await this.checkDomain(domain, opts) }))),
      ]);
      const targets = [{ target: ip, results: ipResults }, ...domainResults];
      const listed = targets.flatMap((t) =>
        t.results
          .filter((r) => r.status === "listed")
          .map((r) => `${t.target} listado em ${r.label} — remoção: ${r.removalUrl ?? "ver o site da lista"}`),
      );
      const check: BlacklistCheckResponse = {
        checkedAt: new Date(this.now()).toISOString(),
        ip: { target: ip, results: ipResults },
        domains: domainResults,
        listedCount: listed.length,
      };
      await this.update((d) => {
        d.lastCheck = check;
        d.lastError = null;
      });
      if (listed.length > 0) await this.deps.onListed?.(listed).catch(() => undefined);
    } catch (err) {
      await this.update((d) => {
        d.lastError = err instanceof Error ? `Não deu para conferir: ${err.message}` : String(err);
      });
    }
    // Fatos da nota (DNS, PTR, certificado): falha mantém os anteriores.
    try {
      const facts = await this.deps.facts();
      await this.update((d) => {
        d.facts = { ...facts, at: new Date(this.now()).toISOString() };
      });
    } catch {
      // segue com os fatos anteriores
    }
    return this.state();
  }

  // -------------------------------------------------------------------------
  // Agendamento diário
  // -------------------------------------------------------------------------

  start(): void {
    const tick = async () => {
      const data = await this.load();
      if (this.now() >= this.nextCheckMs(data) || !data.lastAttemptAt) {
        await this.check({ manual: false }).catch(() => undefined);
      }
    };
    const first = setTimeout(() => {
      void tick();
      const every = setInterval(() => void tick(), HOUR);
      every.unref?.();
      this.timers.push(every);
    }, FIRST_CHECK_MS);
    first.unref?.();
    this.timers.push(first);
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  // -------------------------------------------------------------------------
  // Chave DQS e marcações
  // -------------------------------------------------------------------------

  async setDqsKey(key: string | null): Promise<void> {
    const clean = key?.trim() ?? null;
    if (clean !== null && !isValidDqsKey(clean)) {
      throw httpError(400, "invalid_dqs_key", "A chave DQS tem só letras minúsculas e números (de 20 a 64). Confira e cole de novo.");
    }
    await this.update((d) => {
      d.dqsKey = clean;
    });
  }

  async marks(): Promise<PostmasterMarks> {
    return (await this.load()).marks;
  }

  async setMarks(change: Partial<PostmasterMarks>): Promise<PostmasterMarks> {
    const parsed: Partial<PostmasterMarks> = {};
    for (const key of ["googleAt", "microsoftAt", "spamRateOkAt"] as const) {
      const value = change[key];
      if (value === undefined) continue;
      if (value === null) {
        parsed[key] = null;
        continue;
      }
      const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
      if (Number.isNaN(ms) || ms > this.now() + DAY) {
        throw httpError(400, "invalid_date", "Data inválida. Use a data em que você fez o cadastro (não pode ser no futuro).");
      }
      parsed[key] = new Date(ms).toISOString();
    }
    return (
      await this.update((d) => {
        d.marks = { ...d.marks, ...parsed };
      })
    ).marks;
  }
}
