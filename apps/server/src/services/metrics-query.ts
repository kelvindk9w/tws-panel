/**
 * metrics-query.ts — responde às telas: séries do host e do projeto, e o
 * semáforo do painel. Lê o que o coletor gravou (store) e o que ele guarda em
 * memória (última volta).
 *
 * Custo sob controle: a resposta é guardada 30 s (muitas abas abertas = uma
 * leitura de disco só), pedidos iguais ao mesmo tempo dividem a mesma leitura,
 * no máximo 3 leituras de disco correm ao mesmo tempo e a fila de espera é
 * curta (acima dela, MetricsBusyError → 429).
 */
import {
  CONTAINER_METRIC_KINDS,
  HOST_METRIC_KINDS,
  METRICS_RANGE_SECONDS,
  type ContainerMetricId,
  type HostMetricId,
  type HostMetricsResponse,
  type MetricKind,
  type MetricPoint,
  type MetricsIndicator,
  type MetricsRange,
  type MetricsSummaryResponse,
  type ProjectMetricsResponse,
  type ProjectServiceMetrics,
} from "@paas/core";
import { problemReasons, type MetricsCollector } from "./metrics-collector.js";
import { cpuLevel, diskLevel, memoryLevel, networkLevel, projectsLevel, protectionsLevel } from "./metrics-levels.js";
import {
  DAY,
  bucketize,
  cellPoint,
  chooseResolution,
  projectDaysToFull,
  samplePoint,
  type AggRecord,
  type RawPoint,
  type ResolutionChoice,
  type Sample,
} from "./metrics-series.js";
import type { MetricsStore } from "./metrics-store.js";

export class MetricsBusyError extends Error {
  constructor() {
    super("Há consultas de métricas demais em andamento. Tente de novo em alguns segundos.");
    this.name = "MetricsBusyError";
  }
}

export const CACHE_TTL_MS = 30_000;
export const CACHE_MAX_ENTRIES = 64;
export const MAX_READS = 3;
export const MAX_QUEUE = 40;
/** A projeção do disco muda devagar: uma hora de cache. */
const PROJECTION_TTL_MS = 3_600_000;
const SPARK_STEP = 900;
/** Janela em memória mais velha que isso (painel parado, coleta parada) é relida inteira. */
const WINDOW_MAX_GAP_SECONDS = 600;
const FRESH_SECONDS = 300;
const MAX_EVENTS = 100;

/** Séries que são constantes (aparecem em `latest`, não em gráfico). */
const HOST_SERIES_SKIP: ReadonlySet<string> = new Set(["cores", "memTotal", "swapTotal", "diskTotal", "uptime", "load5", "load15"]);
const CONTAINER_SERIES_SKIP: ReadonlySet<string> = new Set(["memLimit"]);

export interface QueryDeps {
  store: Pick<MetricsStore, "readSamples" | "readAggregates">;
  collector: Pick<MetricsCollector, "status" | "latest">;
  /** Epoch em ms. */
  now: () => number;
}

interface Loaded {
  choice: ResolutionChoice;
  from: number;
  to: number;
  samples: Sample[] | null;
  aggs: AggRecord[] | null;
}

class Limiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_READS) {
      if (this.waiting.length >= MAX_QUEUE) throw new MetricsBusyError();
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next(); // a vaga passa direto para quem esperava
      else this.active--;
    }
  }
}

export class MetricsQuery {
  private readonly limiter = new Limiter();
  private readonly cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(private readonly deps: QueryDeps) {}

  private cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const now = this.deps.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < ttl) return hit.value as Promise<T>;
    const value = load();
    this.cache.set(key, { at: now, value });
    // falha não fica guardada
    value.catch(() => {
      if (this.cache.get(key)?.value === value) this.cache.delete(key);
    });
    while (this.cache.size > CACHE_MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value as string);
    return value;
  }

  private load(range: MetricsRange): Promise<Loaded> {
    const retention = this.deps.collector.status().retention;
    const choice = chooseResolution(range, retention);
    const seconds = METRICS_RANGE_SECONDS[range];
    const to = Math.floor(this.deps.now() / 1000);
    const from = Math.floor((to - seconds) / choice.step) * choice.step;
    return this.limiter.run(async () => {
      if (choice.resolution === "minute") return { choice, from, to, samples: await this.deps.store.readSamples(from, to), aggs: null };
      return { choice, from, to, samples: null, aggs: await this.deps.store.readAggregates(choice.resolution, from, to) };
    });
  }

  // -- host -------------------------------------------------------------------

  host(range: MetricsRange): Promise<HostMetricsResponse> {
    return this.cached(`host:${range}`, CACHE_TTL_MS, async () => {
      const data = await this.load(range);
      const series: Partial<Record<HostMetricId, MetricPoint[]>> = {};
      for (const id of Object.keys(HOST_METRIC_KINDS) as HostMetricId[]) {
        if (HOST_SERIES_SKIP.has(id)) continue;
        const points = pointsOf(data, (s) => s.h, (r) => r.h, id, HOST_METRIC_KINDS[id]);
        if (points.length > 0) series[id] = bucketize(points, HOST_METRIC_KINDS[id], data.from, data.choice.step);
      }
      const tick = this.deps.collector.latest();
      return {
        range,
        resolution: data.choice.resolution,
        stepSeconds: data.choice.step,
        from: data.from,
        to: data.to,
        partial: isPartial(Object.values(series), data),
        series,
        latest: tick ? { t: tick.t, values: { ...tick.host } } : null,
        collector: this.deps.collector.status(),
      };
    });
  }

  // -- projeto ----------------------------------------------------------------

  project(slug: string, range: MetricsRange): Promise<ProjectMetricsResponse> {
    return this.cached(`project:${slug}:${range}`, CACHE_TTL_MS, async () => {
      const data = await this.load(range);
      const keys = new Set<string>();
      const prefix = `${slug}/`;
      const collect = (c: Record<string, unknown>) => {
        for (const k of Object.keys(c)) if (k === slug || k.startsWith(prefix)) keys.add(k);
      };
      for (const s of data.samples ?? []) collect(s.c);
      for (const r of data.aggs ?? []) collect(r.c);
      // serviços do momento (inclui parados que ainda não têm dado na janela)
      const tick = this.deps.collector.latest();
      const latestC = tick?.sample.c ?? {};
      collect(latestC);

      const events: ProjectMetricsResponse["events"] = [];
      const build = (key: string): ProjectServiceMetrics => {
        const series: ProjectServiceMetrics["series"] = {};
        for (const id of Object.keys(CONTAINER_METRIC_KINDS) as ContainerMetricId[]) {
          if (CONTAINER_SERIES_SKIP.has(id)) continue;
          const kind = CONTAINER_METRIC_KINDS[id];
          const points = pointsOf(data, (s) => s.c[key], (r) => r.c[key], id, kind);
          if (points.length === 0) continue;
          series[id] = bucketize(points, kind, data.from, data.choice.step);
          if (key !== slug && (id === "restarts" || id === "oom")) {
            for (const p of points) if (p.v > 0) events.push({ t: p.t, service: key.slice(prefix.length), kind: id === "restarts" ? "restart" : "oom", count: p.v });
          }
        }
        const latest: ProjectServiceMetrics["latest"] = {};
        for (const [id, v] of Object.entries(latestC[key] ?? {})) {
          if (Object.hasOwn(CONTAINER_METRIC_KINDS, id) && Number.isFinite(v)) latest[id as ContainerMetricId] = v;
        }
        return { service: key === slug ? "" : key.slice(prefix.length), series, latest };
      };

      const total = keys.has(slug) ? build(slug) : null;
      const services = [...keys].filter((k) => k !== slug).sort().map(build);
      events.sort((a, b) => b.t - a.t);
      return {
        range,
        resolution: data.choice.resolution,
        stepSeconds: data.choice.step,
        from: data.from,
        to: data.to,
        partial: isPartial([...(total ? Object.values(total.series) : []), ...services.flatMap((s) => Object.values(s.series))], data),
        total,
        services,
        events: events.slice(0, MAX_EVENTS),
        collector: this.deps.collector.status(),
      };
    });
  }

  // -- semáforo ---------------------------------------------------------------

  /** As últimas 24 h do host (sem containers) guardadas em memória: a cada atualização lê só o que chegou depois. */
  private window: Sample[] | null = null;

  private async hostWindow(from: number, to: number): Promise<Sample[]> {
    const last = this.window?.at(-1);
    let samples: Sample[];
    if (this.window && last && to - last.t < WINDOW_MAX_GAP_SECONDS) {
      const fresh = await this.limiter.run(() => this.deps.store.readSamples(last.t + 1, to, true));
      samples = [...this.window.filter((s) => s.t >= from), ...fresh];
    } else {
      samples = await this.limiter.run(() => this.deps.store.readSamples(from, to, true));
    }
    this.window = samples;
    return samples;
  }

  private async daysToFull(): Promise<{ low: number; high: number } | null> {
    return this.cached("projection", PROJECTION_TTL_MS, async () => {
      const to = Math.floor(this.deps.now() / 1000);
      const aggs = await this.limiter.run(() => this.deps.store.readAggregates("hour", to - 30 * DAY, to));
      const pts: Array<{ t: number; pct: number }> = [];
      for (const r of aggs) {
        const p = cellPoint(r.t, r.h.diskPct, "gauge");
        if (p) pts.push({ t: p.t, pct: p.v });
      }
      return projectDaysToFull(pts);
    });
  }

  /**
   * O semáforo. `protections` traz certificados e backups (quem chama sabe de
   * onde); falhar lá vira "sem dados" só naquele indicador. `visible` limita a
   * lista de projetos com problema (token de projetos com a opção do
   * monitoramento só vê os dele); null = todos.
   */
  async summary(opts: {
    protections: () => Promise<{ certificates: { total: number; problems: number } | null; backups: { destinationConnected: boolean; lastFailure: boolean; lastFailureAt?: string } | null }>;
    visible: ReadonlySet<string> | null;
  }): Promise<MetricsSummaryResponse> {
    const base = await this.cached("summary", CACHE_TTL_MS, () => this.buildSummary(opts.protections));
    if (opts.visible === null) return base;
    const problems = base.projects.problems.filter((p) => opts.visible!.has(p.slug));
    const level = base.projects.level === "unknown" ? "unknown" : projectsLevel({ measured: true, problems });
    return { ...base, projects: { ...base.projects, problems, problemCount: problems.length, level } };
  }

  private async buildSummary(protections: () => Promise<{ certificates: { total: number; problems: number } | null; backups: { destinationConnected: boolean; lastFailure: boolean; lastFailureAt?: string } | null }>): Promise<MetricsSummaryResponse> {
    const nowSec = Math.floor(this.deps.now() / 1000);
    const from = Math.floor((nowSec - DAY) / SPARK_STEP) * SPARK_STEP;
    const samples = await this.hostWindow(from, nowSec);
    const tick = this.deps.collector.latest();
    const last = samples.at(-1);
    const fresh = last !== undefined && nowSec - last.t < FRESH_SECONDS ? last : null;
    const now: Partial<Record<HostMetricId, number>> = tick ? tick.host : (fresh?.h ?? {});
    const get = (id: HostMetricId): number | null => (typeof now[id] === "number" ? (now[id] as number) : null);
    const spark = (id: HostMetricId): MetricPoint[] => bucketize(samples.flatMap((s) => (Object.hasOwn(s.h, id) ? [samplePoint(s.t, s.h[id]!)] : [])), "gauge", from, SPARK_STEP);
    const netSpark = bucketize(
      samples.flatMap((s) => (Object.hasOwn(s.h, "netRx") && Object.hasOwn(s.h, "netTx") ? [samplePoint(s.t, s.h.netRx! + s.h.netTx!)] : [])),
      "gauge",
      from,
      SPARK_STEP,
    );
    const oomKills24h = samples.reduce((sum, s) => sum + (s.h.oom ?? 0), 0);
    const total = get("memTotal");
    const avail = get("memAvail");
    const availPct = total !== null && avail !== null && total > 0 ? (avail / total) * 100 : null;
    const days = await this.daysToFull().catch(() => null);

    // projetos (só os do painel)
    const statuses = tick?.containers ?? [];
    const bySlug = new Map<string, typeof statuses>();
    for (const c of statuses) if (c.managed && c.slug !== null) bySlug.set(c.slug, [...(bySlug.get(c.slug) ?? []), c]);
    const problems: MetricsSummaryResponse["projects"]["problems"] = [];
    let running = 0;
    for (const [slug, list] of bySlug) {
      if (list.some((c) => c.state === "running")) running++;
      const reasons = new Set<MetricsSummaryResponse["projects"]["problems"][number]["reasons"][number]>();
      const services: string[] = [];
      for (const c of list) {
        const r = problemReasons(c, nowSec);
        if (r.length > 0) {
          services.push(c.service ?? c.name);
          for (const x of r) reasons.add(x);
        }
      }
      if (reasons.size > 0) {
        const sorted = [...reasons].sort();
        problems.push({ slug, services: services.sort(), reasons: sorted, level: projectsLevel({ measured: true, problems: [{ reasons: sorted }] }) as "warning" | "critical" });
      }
    }
    problems.sort((a, b) => a.slug.localeCompare(b.slug));
    const measured = tick !== null && tick.dockerOk;

    let prot: Awaited<ReturnType<typeof protections>> = { certificates: null, backups: null };
    try {
      prot = await protections();
    } catch {
      // sem dados naquele indicador
    }

    const ind = (level: MetricsIndicator["level"], sparkline: MetricPoint[]): MetricsIndicator => ({ level, spark: sparkline });
    const diskPct = get("diskPct");
    const inodePct = get("inodePct");
    return {
      generatedAt: new Date(this.deps.now()).toISOString(),
      collector: this.deps.collector.status(),
      cpu: {
        ...ind(cpuLevel({ busy: get("cpuBusy"), steal: get("cpuSteal"), psi: get("psiCpu") }), spark("cpuBusy")),
        busyPct: get("cpuBusy"),
        stealPct: get("cpuSteal"),
        psi: get("psiCpu"),
        cores: get("cores"),
      },
      memory: {
        ...ind(memoryLevel({ availPct, psi: get("psiMem"), oomKills24h }), spark("memUsedPct")),
        usedPct: get("memUsedPct"),
        availBytes: avail,
        totalBytes: total,
        swapUsedBytes: get("swapUsed"),
        psi: get("psiMem"),
        oomKills24h,
      },
      disk: {
        ...ind(diskLevel({ pct: diskPct, inodePct, daysToFull: days }), spark("diskPct")),
        usedPct: diskPct,
        freeBytes: get("diskFree"),
        inodePct,
        daysToFull: days,
      },
      network: {
        ...ind(networkLevel({ rx: get("netRx"), tx: get("netTx") }), netSpark),
        rxBytesPerSecond: get("netRx"),
        txBytesPerSecond: get("netTx"),
      },
      projects: {
        ...ind(projectsLevel({ measured, problems }), []),
        running,
        total: bySlug.size,
        problems,
        problemCount: problems.length,
      },
      protections: { level: protectionsLevel(prot), certificates: prot.certificates, backups: prot.backups },
    };
  }
}

// ---------------------------------------------------------------------------

/** Pontos de uma métrica, da resolução que foi carregada (amostra ou agregado). */
function pointsOf<S extends Record<string, number>, A extends Record<string, number[]>>(
  data: Loaded,
  fromSample: (s: Sample) => S | undefined,
  fromAgg: (r: AggRecord) => A | undefined,
  id: string,
  kind: MetricKind,
): RawPoint[] {
  const out: RawPoint[] = [];
  for (const s of data.samples ?? []) {
    const m = fromSample(s);
    if (m && Object.hasOwn(m, id)) out.push(samplePoint(s.t, m[id]!));
  }
  for (const r of data.aggs ?? []) {
    const m = fromAgg(r);
    if (!m || !Object.hasOwn(m, id)) continue;
    const p = cellPoint(r.t, m[id], kind);
    if (p) out.push(p);
  }
  return out;
}

/** A janela começa antes do primeiro dado guardado (coleta nova, ou retenção menor que a janela)? */
function isPartial(allSeries: MetricPoint[][], data: Loaded): boolean {
  let first = Infinity;
  for (const s of allSeries) if (s[0] && s[0].t < first) first = s[0].t;
  return first === Infinity || first > data.from + 2 * data.choice.step;
}
