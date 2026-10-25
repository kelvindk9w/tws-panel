/**
 * metrics.ts — funções puras do monitoramento de recursos (formatação,
 * geometria dos gráficos, resumo de séries).
 */
import type { HealthLevel, MetricPoint, MetricsRange, ProjectProblemReason } from "@paas/core";
import { formatNumber } from "@/i18n";
import type { Key } from "@/i18n";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** 1536 → "1,5 KB". Valor ausente ou inválido → null (quem chama mostra "sem dados"). */
export function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${formatNumber(value, { maximumFractionDigits: unit === 0 || value >= 100 ? 0 : 1 })} ${BYTE_UNITS[unit]}`;
}

/** Porcentagem com uma casa abaixo de 10 e inteira acima. */
export function formatPercent(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return formatNumber(value, { maximumFractionDigits: Math.abs(value) < 10 ? 1 : 0 });
}

export const LEVEL_KEY: Record<HealthLevel, Key> = {
  ok: "metrics.level.ok",
  warning: "metrics.level.warning",
  critical: "metrics.level.critical",
  unknown: "metrics.level.unknown",
};

export const REASON_KEY: Record<ProjectProblemReason, Key> = {
  restarting: "metrics.reason.restarting",
  unhealthy: "metrics.reason.unhealthy",
  dead: "metrics.reason.dead",
  restart_loop: "metrics.reason.restart_loop",
  oom: "metrics.reason.oom",
  exited_with_error: "metrics.reason.exited_with_error",
};

export const RANGE_KEY: Record<"1h" | "24h" | "7d" | "30d", Key> = {
  "1h": "metrics.range.1h",
  "24h": "metrics.range.24h",
  "7d": "metrics.range.7d",
  "30d": "metrics.range.30d",
};
export const PROJECT_RANGES = ["1h", "24h", "7d", "30d"] as const satisfies readonly MetricsRange[];

/** Resumo de uma série: último valor, média e pico. null se a série está vazia. */
export function seriesSummary(points: readonly MetricPoint[] | undefined): { last: number; avg: number; peak: number } | null {
  if (!points || points.length === 0) return null;
  let sum = 0;
  let peak = -Infinity;
  for (const p of points) {
    sum += p.v;
    peak = Math.max(peak, p.max);
  }
  return { last: points[points.length - 1]!.v, avg: sum / points.length, peak };
}

/** Soma de eventos (reinícios, mortes por memória) de uma série. */
export function seriesTotal(points: readonly MetricPoint[] | undefined): number {
  return (points ?? []).reduce((s, p) => s + p.v, 0);
}

/** Teto "redondo" para o eixo: 1, 2 ou 5 vezes uma potência de 10 (nunca menor que o valor). */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  for (const m of [1, 2, 5, 10]) if (value <= m * base) return m * base;
  return 10 * base;
}

export interface SparkGeometry {
  /** Caminho da linha (vários trechos quando há lacuna). */
  line: string;
  /** Caminho da área sob a linha (fecha em baixo). */
  area: string;
  /** Último ponto, para destacar. */
  last: { x: number; y: number } | null;
  /** Valor máximo do eixo vertical. */
  max: number;
}

export interface SparkOptions {
  width: number;
  height: number;
  from: number;
  to: number;
  /** Distância normal entre pontos (s): acima de 2,5× é lacuna e a linha quebra. */
  step: number;
  /** Teto fixo do eixo (ex.: 100 para porcentagem). Sem ele, usa o maior valor arredondado. */
  max?: number;
  /** Por onde a escala começa (padrão 0). */
  min?: number;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Pontos de uma série → caminhos SVG. Lacunas (falta de coleta) quebram a linha em vez de ligar pontos distantes. */
export function sparkGeometry(points: readonly MetricPoint[], o: SparkOptions): SparkGeometry {
  const span = Math.max(1, o.to - o.from);
  const min = o.min ?? 0;
  const top = o.max ?? niceMax(points.reduce((m, p) => Math.max(m, p.max, p.v), 0));
  const range = Math.max(1e-9, top - min);
  const x = (t: number) => r1(Math.min(o.width, Math.max(0, ((t - o.from) / span) * o.width)));
  const y = (v: number) => r1(o.height - Math.min(1, Math.max(0, (v - min) / range)) * o.height);

  const runs: Array<Array<{ x: number; y: number }>> = [];
  let prevT: number | null = null;
  for (const p of points) {
    if (!Number.isFinite(p.v)) continue;
    if (prevT === null || p.t - prevT > o.step * 2.5) runs.push([]);
    runs[runs.length - 1]!.push({ x: x(p.t), y: y(p.v) });
    prevT = p.t;
  }
  const line = runs.map((run) => run.map((pt, i) => `${i === 0 ? "M" : "L"}${pt.x} ${pt.y}`).join(" ")).join(" ");
  const area = runs
    .map((run) => {
      const first = run[0]!;
      const last = run[run.length - 1]!;
      return `M${first.x} ${o.height} ${run.map((pt) => `L${pt.x} ${pt.y}`).join(" ")} L${last.x} ${o.height} Z`;
    })
    .join(" ");
  const lastRun = runs[runs.length - 1];
  return { line, area, last: lastRun ? lastRun[lastRun.length - 1]! : null, max: top };
}
