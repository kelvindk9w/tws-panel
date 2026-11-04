/**
 * metrics-series.ts — série temporal em três resoluções (puro).
 *
 *  - Amostra (1 por minuto): `{ t, h: {métrica: número}, c: {chave: {métrica: número}} }`.
 *    Métrica sem medida simplesmente não aparece.
 *  - Agregado (hora ou dia): `{ t, n, h, c }` com uma célula por métrica:
 *    gauge → `[mín, média, máx, n]`; evento → `[soma]`.
 *  - Reduzir amostras a um agregado (rollup), juntar agregados num maior (hora →
 *    dia), agrupar pontos em baldes para o gráfico, escolher a resolução de uma
 *    janela e projetar o enchimento do disco.
 */
import {
  CONTAINER_METRIC_KINDS,
  HOST_METRIC_KINDS,
  METRICS_MAX_POINTS,
  METRICS_RANGE_SECONDS,
  type MetricKind,
  type MetricPoint,
  type MetricResolution,
  type MetricsRange,
  type MetricsRetention,
} from "@paas/core";
import { roundMetric } from "./metrics-compute.js";

export interface Sample {
  t: number;
  h: Record<string, number>;
  c: Record<string, Record<string, number>>;
}

/** gauge: [mín, média, máx, n]; evento: [soma]. */
export type Cell = number[];

export interface AggRecord {
  t: number;
  /** Amostras que entraram. */
  n: number;
  h: Record<string, Cell>;
  c: Record<string, Record<string, Cell>>;
}

export const HOUR = 3600;
export const DAY = 86400;

const hostKind = (id: string): MetricKind | undefined => (Object.hasOwn(HOST_METRIC_KINDS, id) ? HOST_METRIC_KINDS[id as keyof typeof HOST_METRIC_KINDS] : undefined);
const containerKind = (id: string): MetricKind | undefined =>
  Object.hasOwn(CONTAINER_METRIC_KINDS, id) ? CONTAINER_METRIC_KINDS[id as keyof typeof CONTAINER_METRIC_KINDS] : undefined;

interface Acc {
  min: number;
  max: number;
  sum: number;
  n: number;
}

function accumulate(into: Map<string, Acc>, id: string, v: number): void {
  const a = into.get(id);
  if (!a) into.set(id, { min: v, max: v, sum: v, n: 1 });
  else {
    a.min = Math.min(a.min, v);
    a.max = Math.max(a.max, v);
    a.sum += v;
    a.n++;
  }
}

function toCells(acc: Map<string, Acc>, kindOf: (id: string) => MetricKind | undefined): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  for (const [id, a] of acc) {
    const kind = kindOf(id);
    if (kind === undefined) continue;
    out[id] = kind === "event" ? [roundMetric(a.sum)] : [roundMetric(a.min), roundMetric(a.sum / a.n), roundMetric(a.max), a.n];
  }
  return out;
}

/** Reduz amostras de um período a um agregado que começa em `t0`. Sem amostras: null. */
export function rollupSamples(samples: Sample[], t0: number): AggRecord | null {
  if (samples.length === 0) return null;
  const host = new Map<string, Acc>();
  const containers = new Map<string, Map<string, Acc>>();
  for (const s of samples) {
    for (const [id, v] of Object.entries(s.h)) if (Number.isFinite(v)) accumulate(host, id, v);
    for (const [key, values] of Object.entries(s.c)) {
      let m = containers.get(key);
      if (!m) containers.set(key, (m = new Map()));
      for (const [id, v] of Object.entries(values)) if (Number.isFinite(v)) accumulate(m, id, v);
    }
  }
  const c: Record<string, Record<string, Cell>> = {};
  for (const [key, m] of containers) {
    const cells = toCells(m, containerKind);
    if (Object.keys(cells).length > 0) c[key] = cells;
  }
  return { t: t0, n: samples.length, h: toCells(host, hostKind), c };
}

function mergeCells(cells: Cell[], kind: MetricKind): Cell | null {
  if (cells.length === 0) return null;
  if (kind === "event") return [roundMetric(cells.reduce((s, c) => s + (c[0] ?? 0), 0))];
  let min = Infinity;
  let max = -Infinity;
  let weighted = 0;
  let n = 0;
  for (const c of cells) {
    const [lo, avg, hi, w] = c;
    if (lo === undefined || avg === undefined || hi === undefined || w === undefined || w <= 0) continue;
    min = Math.min(min, lo);
    max = Math.max(max, hi);
    weighted += avg * w;
    n += w;
  }
  return n === 0 ? null : [roundMetric(min), roundMetric(weighted / n), roundMetric(max), n];
}

/** Junta agregados menores (horas) num maior (dia) que começa em `t0`. Média ponderada pelo número de amostras. */
export function mergeAggregates(records: AggRecord[], t0: number): AggRecord | null {
  if (records.length === 0) return null;
  const hostCells = new Map<string, Cell[]>();
  const contCells = new Map<string, Map<string, Cell[]>>();
  const push = (m: Map<string, Cell[]>, id: string, cell: Cell) => m.set(id, [...(m.get(id) ?? []), cell]);
  for (const r of records) {
    for (const [id, cell] of Object.entries(r.h)) push(hostCells, id, cell);
    for (const [key, values] of Object.entries(r.c)) {
      let m = contCells.get(key);
      if (!m) contCells.set(key, (m = new Map()));
      for (const [id, cell] of Object.entries(values)) push(m, id, cell);
    }
  }
  const build = (m: Map<string, Cell[]>, kindOf: (id: string) => MetricKind | undefined): Record<string, Cell> => {
    const out: Record<string, Cell> = {};
    for (const [id, cells] of m) {
      const kind = kindOf(id);
      const merged = kind === undefined ? null : mergeCells(cells, kind);
      if (merged) out[id] = merged;
    }
    return out;
  };
  const c: Record<string, Record<string, Cell>> = {};
  for (const [key, m] of contCells) {
    const cells = build(m, containerKind);
    if (Object.keys(cells).length > 0) c[key] = cells;
  }
  return { t: t0, n: records.reduce((s, r) => s + r.n, 0), h: build(hostCells, hostKind), c };
}

// ---------------------------------------------------------------------------
// Pontos para o gráfico
// ---------------------------------------------------------------------------

/** Ponto normalizado de qualquer resolução: valor, pico e peso (amostras que representa). */
export interface RawPoint {
  t: number;
  v: number;
  max: number;
  w: number;
}

export function samplePoint(t: number, v: number): RawPoint {
  return { t, v, max: v, w: 1 };
}

/** Célula de um agregado → ponto; null se a célula está estragada. */
export function cellPoint(t: number, cell: Cell | undefined, kind: MetricKind): RawPoint | null {
  if (!Array.isArray(cell)) return null;
  if (kind === "event") {
    const sum = cell[0];
    return typeof sum === "number" && Number.isFinite(sum) ? { t, v: sum, max: sum, w: 1 } : null;
  }
  const [, avg, max, n] = cell;
  if (![avg, max, n].every((x) => typeof x === "number" && Number.isFinite(x)) || (n as number) <= 0) return null;
  return { t, v: avg as number, max: max as number, w: n as number };
}

/**
 * Agrupa pontos em baldes de `step` segundos alinhados a `from`. Gauge: média
 * ponderada e pico; evento: soma. Baldes sem ponto não existem (lacuna = sem dados).
 */
export function bucketize(points: RawPoint[], kind: MetricKind, from: number, step: number): MetricPoint[] {
  const buckets = new Map<number, { sum: number; w: number; max: number }>();
  for (const p of points) {
    if (p.t < from) continue;
    const idx = Math.floor((p.t - from) / step);
    const b = buckets.get(idx);
    if (!b) buckets.set(idx, { sum: kind === "event" ? p.v : p.v * p.w, w: p.w, max: p.max });
    else {
      b.sum += kind === "event" ? p.v : p.v * p.w;
      b.w += p.w;
      b.max = Math.max(b.max, p.max);
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, b]) => {
      const v = roundMetric(kind === "event" ? b.sum : b.sum / b.w);
      return { t: from + idx * step, v, max: kind === "event" ? v : roundMetric(b.max) };
    });
}

export interface ResolutionChoice {
  resolution: MetricResolution;
  /** Distância entre pontos do dado guardado. */
  baseStep: number;
  /** Distância entre pontos da resposta (≤ METRICS_MAX_POINTS pontos). */
  step: number;
}

/** Janela mais longa lida do dado por minuto (24 h): acima disso o custo de ler e analisar não compensa. */
export const MINUTE_MAX_RANGE_SECONDS = DAY;

/**
 * Resolução mais fina que cobre a janela inteira dentro da retenção. Minuto só
 * até 24 h; depois hora; depois dia (a retenção por dia é a mais longa, então é
 * também a reserva quando nenhuma cobre).
 */
export function chooseResolution(range: MetricsRange, retention: MetricsRetention): ResolutionChoice {
  const seconds = METRICS_RANGE_SECONDS[range];
  let resolution: MetricResolution;
  let baseStep: number;
  if (seconds <= MINUTE_MAX_RANGE_SECONDS && seconds <= retention.minuteHours * HOUR) {
    resolution = "minute";
    baseStep = 60;
  } else if (seconds <= retention.hourDays * DAY) {
    resolution = "hour";
    baseStep = HOUR;
  } else {
    resolution = "day";
    baseStep = DAY;
  }
  const step = Math.max(baseStep, Math.ceil(seconds / METRICS_MAX_POINTS / baseStep) * baseStep);
  return { resolution, baseStep, step };
}

// ---------------------------------------------------------------------------
// Projeção do disco
// ---------------------------------------------------------------------------

/** Dias de dados exigidos para projetar. */
export const PROJECTION_MIN_SPAN_DAYS = 7;
/** Mínimo de pontos na regressão. */
export const PROJECTION_MIN_POINTS = 24;
/** Acima disso a projeção não é útil (10 anos). */
export const PROJECTION_MAX_DAYS = 3650;
/** Abaixo disto (pontos percentuais por dia) o disco "não está crescendo". */
export const PROJECTION_MIN_SLOPE = 0.01;

/**
 * Regressão linear do uso do disco (% por tempo) → faixa de dias até encher.
 * Só com ≥ 7 dias de dados, ≥ 24 pontos e inclinação positiva; senão null.
 * A faixa vem do erro da inclinação (80%): ritmo mais rápido → `low`, mais lento → `high`.
 */
export function projectDaysToFull(points: Array<{ t: number; pct: number }>): { low: number; high: number } | null {
  const pts = points.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.pct));
  if (pts.length < PROJECTION_MIN_POINTS) return null;
  let tMax = -Infinity;
  let tMin = Infinity;
  for (const p of pts) {
    tMax = Math.max(tMax, p.t);
    tMin = Math.min(tMin, p.t);
  }
  if (tMax - tMin < PROJECTION_MIN_SPAN_DAYS * DAY) return null;
  const xs = pts.map((p) => (p.t - tMax) / DAY);
  const ys = pts.map((p) => p.pct);
  const n = pts.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i]! - mx) ** 2;
    sxy += (xs[i]! - mx) * (ys[i]! - my);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  if (slope <= PROJECTION_MIN_SLOPE) return null;
  const intercept = my - slope * mx;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (ys[i]! - (intercept + slope * xs[i]!)) ** 2;
  const se = Math.sqrt(sse / (n - 2) / sxx);
  const last = pts.reduce((a, b) => (b.t >= a.t ? b : a)).pct;
  const remaining = 100 - last;
  if (remaining <= 0) return { low: 0, high: 0 };
  const fast = slope + 1.28 * se;
  const slowRaw = slope - 1.28 * se;
  const slow = Math.max(slowRaw, slope * 0.25);
  const lowDays = remaining / fast;
  if (lowDays > PROJECTION_MAX_DAYS) return null;
  const low = Math.max(0, Math.floor(lowDays + 1e-9));
  const high = Math.min(PROJECTION_MAX_DAYS, Math.max(low, Math.ceil(remaining / slow - 1e-9)));
  return { low, high };
}

/** Início do período (hora ou dia) que contém `t`, em segundos UTC. */
export function periodStart(t: number, size: number): number {
  return Math.floor(t / size) * size;
}
