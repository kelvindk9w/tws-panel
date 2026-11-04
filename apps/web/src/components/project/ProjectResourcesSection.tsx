import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { Info, Loader2, RefreshCw } from "lucide-react";
import type { ContainerMetricId, MetricPoint, ProjectMetricsResponse, ProjectServiceMetrics } from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { useAutoRefresh, type RefreshPhase } from "@/lib/auto-refresh";
import { formatBytes, formatPercent, PROJECT_RANGES, RANGE_KEY, seriesSummary, seriesTotal } from "@/lib/metrics";
import { formatDateTime, useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricChart, type ChartMark } from "@/components/metrics/charts";
import { formatSeconds } from "./deploy-format";
import { MEMORY_NEAR_LIMIT } from "@paas/core";

const REFRESH: readonly RefreshPhase[] = [{ untilMs: Infinity, everyMs: 60_000 }];

type Range = (typeof PROJECT_RANGES)[number];

function Tile({ label, value, hint, testId }: { label: string; value: string; hint?: string | undefined; testId: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md border p-3" data-testid={testId}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="break-words text-lg font-semibold leading-snug">{value}</span>
      {hint && <span className="break-words text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

/**
 * Aba "Recursos" do projeto: processador, memória, disco e rede por serviço e
 * na soma do projeto, em 1 h, 24 h, 7 ou 30 dias, mais os reinícios e as mortes
 * por falta de memória com o horário. O que não foi medido aparece como "sem
 * dados" (ou fica de fora do gráfico), nunca como zero.
 */
export function ProjectResourcesSection({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const [range, setRange] = useState<Range>("24h");
  const [data, setData] = useState<ProjectMetricsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(0);
  const [shownProject, setShownProject] = useState(projectId);
  const seq = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(
    async (quiet: boolean) => {
      const mine = ++seq.current;
      controller.current?.abort();
      const ac = new AbortController();
      controller.current = ac;
      if (!quiet) {
        setBusy((n) => n + 1);
        setError(null);
      }
      try {
        const res = await apiFetch<ProjectMetricsResponse>(`/api/projects/${encodeURIComponent(projectId)}/metrics?range=${range}`, { signal: ac.signal });
        if (mine !== seq.current) return;
        setData(res);
        setError(null);
      } catch (err) {
        if (mine !== seq.current || ac.signal.aborted) return;
        setError(err instanceof ApiRequestError && err.code === "metrics_busy" ? t("metrics.resources.busy") : t("metrics.resources.loadError"));
        if (!quiet) setData(null);
      } finally {
        if (!quiet) setBusy((n) => n - 1);
      }
    },
    [projectId, range, t],
  );

  // Outro projeto: as medidas do anterior somem na hora.
  if (shownProject !== projectId) {
    setShownProject(projectId);
    setData(null);
    setError(null);
  }

  useEffect(() => {
    void load(false);
  }, [load]);
  useEffect(() => () => controller.current?.abort(), []);
  useAutoRefresh(true, () => load(true), REFRESH);

  const noData = t("metrics.noData");
  const bytes = (v: number) => formatBytes(v) ?? noData;
  const core = (v: number) => `${formatPercent(v) ?? noData}%`;
  const rate = (v: number) => t("metrics.rate", { value: formatBytes(v) ?? noData });
  const loading = busy > 0;
  const rangeLabel = t(RANGE_KEY[range]);

  const total = data?.total ?? null;
  const pts = (m: ProjectServiceMetrics | null, id: ContainerMetricId): readonly MetricPoint[] => m?.series[id] ?? [];
  const services = useMemo(() => data?.services ?? [], [data]);
  const hasAnyData = total !== null || services.length > 0;
  const chartWin = data ? { from: data.from, to: data.to, step: data.stepSeconds, rangeLabel } : null;
  const restarts = seriesTotal(pts(total, "restarts"));
  const ooms = seriesTotal(pts(total, "oom"));
  const memLimit = total?.latest.memLimit;
  const cpuNow = total?.latest.cpu;
  const memNow = total?.latest.mem;
  // marcas de deploy nos gráficos (o texto diz quando e como terminou)
  const marks: ChartMark[] = (data?.deploys ?? []).map((d) => ({
    t: d.t,
    failed: d.status === "failed",
    label: t(d.kind === "recreate" ? "metrics.resources.marks.recreate" : "metrics.resources.marks.deploy", {
      time: formatDateTime(new Date(d.t * 1000).toISOString()),
      status: t(`projects.jobStatus.${d.status === "queued" ? "running" : d.status}`),
    }),
  }));
  const throttleSeries = pts(total, "cpuThrottle");

  return (
    <Card data-testid="project-resources">
      <CardHeader>
        <CardTitle className="text-base">{t("metrics.resources.title")}</CardTitle>
        <CardDescription>{t("metrics.resources.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label={t("metrics.range.label")} className="flex flex-wrap gap-1">
            {PROJECT_RANGES.map((r) => (
              <Button key={r} type="button" size="sm" variant={range === r ? "default" : "outline"} aria-pressed={range === r} onClick={() => setRange(r)}>
                {t(RANGE_KEY[r])}
              </Button>
            ))}
          </div>
          <Button type="button" size="sm" variant="outline" onClick={() => void load(false)} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {t("metrics.resources.refresh")}
          </Button>
        </div>

        {error && (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {loading && !data && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {t("metrics.resources.loading")}
          </p>
        )}

        {data && data.collector.mode === "reduced" && (
          <div role="status" className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm" data-testid="resources-reduced">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
            <p className="break-words text-muted-foreground">{t("metrics.strip.reduced.body")}</p>
          </div>
        )}

        {data && !hasAnyData && (
          <p role="status" className="text-sm text-muted-foreground" data-testid="resources-empty">
            {t("metrics.resources.empty")}
          </p>
        )}

        {data && hasAnyData && chartWin && (
          <>
            {data.partial && (
              <p role="status" className="text-xs text-muted-foreground" data-testid="resources-partial">
                {t("metrics.resources.partial")}
              </p>
            )}
            <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
              <Tile
                testId="tile-cpu"
                label={t("metrics.resources.tile.cpu")}
                value={cpuNow === undefined ? noData : t("metrics.resources.tile.cpuValue", { value: formatPercent(cpuNow) ?? noData })}
              />
              <Tile
                testId="tile-memory"
                label={t("metrics.resources.tile.memory")}
                value={memNow === undefined ? noData : bytes(memNow)}
                hint={memLimit === undefined ? t("metrics.resources.tile.noLimit") : t("metrics.resources.tile.memoryLimit", { value: bytes(memLimit) })}
              />
              <Tile testId="tile-restarts" label={t("metrics.resources.tile.restarts")} value={String(restarts)} />
              <Tile testId="tile-oom" label={t("metrics.resources.tile.oom")} value={String(ooms)} />
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <MetricChart title={t("metrics.resources.chart.cpu")} series={[{ label: t("metrics.resources.chart.cpu"), points: pts(total, "cpu") }]} {...chartWin} format={core} marks={marks} />
              <MetricChart title={t("metrics.resources.chart.memory")} series={[{ label: t("metrics.resources.chart.memory"), points: pts(total, "mem") }]} {...chartWin} format={bytes} marks={marks} />
              <MetricChart
                title={t("metrics.resources.chart.io")}
                series={[
                  { label: t("metrics.resources.series.read"), points: pts(total, "ioRead") },
                  { label: t("metrics.resources.series.write"), points: pts(total, "ioWrite"), dashed: true },
                ]}
                {...chartWin}
                format={rate}
                marks={marks}
              />
              <MetricChart
                title={t("metrics.resources.chart.net")}
                series={[
                  { label: t("metrics.resources.series.rx"), points: pts(total, "netRx") },
                  { label: t("metrics.resources.series.tx"), points: pts(total, "netTx"), dashed: true },
                ]}
                {...chartWin}
                format={rate}
                marks={marks}
              />
              {throttleSeries.length > 0 && (
                <div className="flex flex-col gap-1 lg:col-span-2" data-testid="resources-throttle">
                  <MetricChart
                    title={t("metrics.resources.chart.throttle")}
                    series={[{ label: t("metrics.resources.chart.throttle"), points: throttleSeries }]}
                    {...chartWin}
                    max={100}
                    format={core}
                    marks={marks}
                  />
                  <p className="text-xs text-muted-foreground">{t("metrics.resources.chart.throttleHint")}</p>
                </div>
              )}
            </div>

            <section aria-labelledby="resources-services-title" className="flex flex-col gap-2">
              <h3 id="resources-services-title" className="text-sm font-medium">
                {t("metrics.resources.services.title")}
              </h3>
              <ul className="flex flex-col gap-2" data-testid="resources-services">
                {services.map((s) => {
                  const cpu = seriesSummary(s.series.cpu);
                  const mem = seriesSummary(s.series.mem);
                  const up = s.latest.up;
                  const running = s.latest.replicas;
                  const wanted = s.latest.replicasWanted;
                  const memPct = s.latest.mem !== undefined && s.latest.memLimit !== undefined && s.latest.memLimit > 0 ? (s.latest.mem / s.latest.memLimit) * 100 : null;
                  const memNear = memPct !== null && memPct >= MEMORY_NEAR_LIMIT.raise;
                  const throttle = seriesSummary(s.series.cpuThrottle);
                  const cpuLimit = s.latest.cpuLimit;
                  return (
                    <li key={s.service} className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 rounded-md border p-3 text-sm sm:grid-cols-[minmax(8rem,1fr)_1fr_1fr_auto]" data-testid={`resources-service-${s.service}`}>
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="break-all font-mono font-medium">{s.service}</span>
                        {up !== undefined && (
                          <Badge variant={up > 0 ? "success" : "secondary"}>{t(up > 0 ? "metrics.resources.services.state.running" : "metrics.resources.services.state.stopped")}</Badge>
                        )}
                        {running !== undefined && wanted !== undefined && (wanted > 1 || running < wanted) && (
                          <Badge variant={running < wanted ? "warning" : "secondary"} title={t("metrics.resources.services.replicasHint")} data-testid={`replicas-${s.service}`}>
                            {t("metrics.resources.services.replicas", { running, wanted })}
                          </Badge>
                        )}
                      </div>
                      <div className="min-w-0">
                        <span className="block text-xs text-muted-foreground">{t("metrics.resources.services.col.cpu")}</span>
                        {cpu ? (
                          <span>
                            {core(cpu.last)}
                            <span className="block text-xs text-muted-foreground">{t("metrics.resources.services.stats", { avg: core(cpu.avg), peak: core(cpu.peak) })}</span>
                            {cpuLimit !== undefined && (
                              <span className="block text-xs text-muted-foreground" data-testid={`cpu-limit-${s.service}`}>
                                {t("metrics.resources.services.cpuLimit", { value: formatPercent(cpuLimit) ?? noData })}
                                {" · "}
                                {throttle && throttle.peak > 0
                                  ? t("metrics.resources.services.throttle", { now: formatPercent(throttle.last) ?? noData, peak: formatPercent(throttle.peak) ?? noData })
                                  : t("metrics.resources.services.noThrottle")}
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">{noData}</span>
                        )}
                      </div>
                      <div className="min-w-0">
                        <span className="block text-xs text-muted-foreground">{t("metrics.resources.services.col.memory")}</span>
                        {mem ? (
                          <span>
                            {bytes(mem.last)}
                            <span className="block text-xs text-muted-foreground">{t("metrics.resources.services.stats", { avg: bytes(mem.avg), peak: bytes(mem.peak) })}</span>
                            {memPct !== null && (
                              <span className={cn("block text-xs", memNear ? "font-medium text-amber-400" : "text-muted-foreground")} data-testid={`mem-pct-${s.service}`}>
                                {t("metrics.resources.services.memPct", { pct: formatPercent(memPct) ?? noData })}
                                {memNear && ` · ${t("metrics.resources.services.memNear")}`}
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">{noData}</span>
                        )}
                      </div>
                      <div className="min-w-0">
                        <span className="block text-xs text-muted-foreground">{t("metrics.resources.services.col.restarts")}</span>
                        <span className={cn(seriesTotal(s.series.restarts) > 0 && "font-medium text-amber-400")}>{seriesTotal(s.series.restarts)}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>

            <section aria-labelledby="resources-startups-title" className="flex flex-col gap-2">
              <h3 id="resources-startups-title" className="text-sm font-medium">
                {t("metrics.resources.startups.title")}
              </h3>
              <p className="text-xs text-muted-foreground">{t("metrics.resources.startups.desc")}</p>
              {(data.startups ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="resources-no-startups">
                  {t("metrics.resources.startups.none")}
                </p>
              ) : (
                <ul className="flex flex-col gap-1 text-sm" data-testid="resources-startups">
                  {(data.startups ?? []).map((r) => (
                    <li key={`${r.service}-${r.startedAt}`} className="flex flex-wrap items-baseline gap-x-2">
                      <time dateTime={r.startedAt} className="text-xs text-muted-foreground">
                        {formatDateTime(r.startedAt)}
                      </time>
                      <span className="break-words">
                        {t("metrics.resources.startups.item", { service: r.service, duration: `${r.approx ? "~" : ""}${formatSeconds(r.seconds)}` })}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {t(r.via === "health" ? "metrics.resources.startups.health" : "metrics.resources.startups.port")}
                        {r.approx && ` · ${t("metrics.resources.startups.approx")}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="resources-events-title" className="flex flex-col gap-2">
              <h3 id="resources-events-title" className="text-sm font-medium">
                {t("metrics.resources.events.title")}
              </h3>
              {data.events.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="resources-no-events">
                  {t("metrics.resources.events.none")}
                </p>
              ) : (
                <ul className="flex flex-col gap-1 text-sm" data-testid="resources-events">
                  {data.events.map((e) => (
                    <li key={`${e.t}-${e.service}-${e.kind}`} className="flex flex-wrap items-baseline gap-x-2">
                      <time dateTime={new Date(e.t * 1000).toISOString()} className="text-xs text-muted-foreground">
                        {formatDateTime(new Date(e.t * 1000).toISOString())}
                      </time>
                      <span className="break-words">{t(e.kind === "restart" ? "metrics.resources.events.restart" : "metrics.resources.events.oom", { service: e.service ?? "", count: e.count })}</span>
                    </li>
                  ))}
                </ul>
              )}
              <Link to={`/projects/${projectId}/logs`} className="self-start text-sm underline underline-offset-2">
                {t("metrics.resources.events.logs")}
              </Link>
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}
