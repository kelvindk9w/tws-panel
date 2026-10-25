import { AlertTriangle, CheckCircle2, HelpCircle, XCircle } from "lucide-react";
import type { HealthLevel, MetricPoint } from "@paas/core";
import { useI18n } from "@/i18n";
import { LEVEL_KEY, niceMax, seriesSummary, sparkGeometry } from "@/lib/metrics";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

const LEVEL_VARIANT = { ok: "success", warning: "warning", critical: "destructive", unknown: "secondary" } as const;
const LEVEL_ICON = { ok: CheckCircle2, warning: AlertTriangle, critical: XCircle, unknown: HelpCircle } as const;

/** Selo do semáforo: ícone + texto (a cor nunca é o único sinal). */
export function LevelBadge({ level }: { level: HealthLevel }) {
  const { t } = useI18n();
  const Icon = LEVEL_ICON[level];
  return (
    <Badge variant={LEVEL_VARIANT[level]} data-level={level}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {t(LEVEL_KEY[level])}
    </Badge>
  );
}

const W = 120;
const H = 32;

/**
 * Miniatura de 24 h: linha + área, sem eixos. O leitor de tela recebe um
 * resumo em texto (agora, média, pico) no lugar do desenho.
 */
export function Sparkline({
  title,
  points,
  from,
  to,
  step,
  max,
  format,
}: {
  title: string;
  points: readonly MetricPoint[];
  from: number;
  to: number;
  step: number;
  /** Teto fixo do eixo (100 para porcentagem). */
  max?: number;
  format: (v: number) => string;
}) {
  const { t } = useI18n();
  const summary = seriesSummary(points);
  if (!summary) {
    return (
      <p className="flex h-8 items-center text-xs text-muted-foreground" data-testid="spark-empty">
        {t("metrics.spark.empty")}
      </p>
    );
  }
  const g = sparkGeometry(points, { width: W, height: H, from, to, step, ...(max !== undefined ? { max } : {}) });
  const label = t("metrics.spark.aria", {
    title,
    summary: t("metrics.chart.summary", { now: format(summary.last), avg: format(summary.avg), peak: format(summary.peak) }),
  });
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-8 w-full overflow-visible text-primary" data-testid="sparkline">
      <path d={g.area} fill="currentColor" opacity={0.12} />
      <path d={g.line} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export interface ChartSeries {
  label: string;
  points: readonly MetricPoint[];
  /** Traço da linha: o segundo conjunto usa tracejado para não depender só da cor. */
  dashed?: boolean;
}

const CW = 600;
const CH = 140;

/**
 * Gráfico de linhas de uma ou duas séries, com eixo vertical (0 e teto) e
 * resumo em texto abaixo (agora, média, pico de cada série). `role="img"` com o
 * mesmo resumo para leitor de tela.
 */
export function MetricChart({
  title,
  series,
  from,
  to,
  step,
  rangeLabel,
  max,
  format,
  className,
}: {
  title: string;
  series: ChartSeries[];
  from: number;
  to: number;
  step: number;
  rangeLabel: string;
  max?: number;
  format: (v: number) => string;
  className?: string;
}) {
  const { t } = useI18n();
  const present = series.filter((s) => s.points.length > 0);
  // as séries do mesmo gráfico dividem o eixo (senão a linha menor pareceria maior)
  const axisMax = max ?? niceMax(Math.max(0, ...present.flatMap((s) => s.points.map((p) => p.max))));
  const geoms = present.map((s) => ({ s, g: sparkGeometry(s.points, { width: CW, height: CH, from, to, step, max: axisMax }) }));
  const summaries = present.map((s) => ({ label: s.label, sum: seriesSummary(s.points)! }));
  const text = summaries
    .map((x) => `${x.label}: ${t("metrics.chart.summary", { now: format(x.sum.last), avg: format(x.sum.avg), peak: format(x.sum.peak) })}`)
    .join("; ");
  return (
    <figure className={cn("flex min-w-0 flex-col gap-2 rounded-md border p-3", className)} data-testid="metric-chart">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm font-medium">
        <span>{title}</span>
        {present.length > 1 && (
          <span className="flex flex-wrap gap-x-3 text-xs font-normal text-muted-foreground">
            {series.map((s) => (
              <span key={s.label} className="inline-flex items-center gap-1">
                <svg width="18" height="6" aria-hidden="true">
                  <line x1="0" y1="3" x2="18" y2="3" stroke="currentColor" strokeWidth="2" strokeDasharray={s.dashed ? "4 3" : undefined} />
                </svg>
                {s.label}
              </span>
            ))}
          </span>
        )}
      </figcaption>
      {present.length === 0 ? (
        <p className="flex h-24 items-center text-sm text-muted-foreground" data-testid="chart-empty">
          {t("metrics.chart.empty")}
        </p>
      ) : (
        <div className="relative">
          <span className="absolute left-0 top-0 -translate-y-0.5 rounded bg-background/80 px-1 text-[10px] text-muted-foreground" aria-hidden="true">
            {format(axisMax)}
          </span>
          <span className="absolute bottom-0 left-0 rounded bg-background/80 px-1 text-[10px] text-muted-foreground" aria-hidden="true">
            {format(0)}
          </span>
          <svg
            role="img"
            aria-label={t("metrics.chart.aria", { title, summary: text, range: rangeLabel })}
            viewBox={`0 0 ${CW} ${CH}`}
            preserveAspectRatio="none"
            className="h-28 w-full overflow-visible text-primary"
          >
            {[0, 0.5, 1].map((f) => (
              <line key={f} x1="0" x2={CW} y1={CH * f} y2={CH * f} stroke="currentColor" opacity={0.12} vectorEffect="non-scaling-stroke" />
            ))}
            {geoms.map(({ s, g }) => (
              <path
                key={s.label}
                d={g.line}
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeDasharray={s.dashed ? "6 4" : undefined}
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
              />
            ))}
          </svg>
        </div>
      )}
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {summaries.map((x) => (
          <div key={x.label} className="flex flex-wrap gap-x-1">
            {summaries.length > 1 && <dt className="font-medium text-foreground">{x.label}:</dt>}
            <dd>
              {t("metrics.chart.now")} {format(x.sum.last)} · {t("metrics.chart.avg")} {format(x.sum.avg)} · {t("metrics.chart.peak")} {format(x.sum.peak)}
            </dd>
          </div>
        ))}
      </dl>
    </figure>
  );
}
