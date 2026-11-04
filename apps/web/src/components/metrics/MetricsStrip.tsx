import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Activity, AlertTriangle, CheckCircle2, Cpu, HelpCircle, HardDrive, Info, MemoryStick, Network, ShieldCheck, Boxes } from "lucide-react";
import { METRICS_LEVELS } from "@paas/core";
import type { HealthLevel, MetricPoint, MetricsIndicator, MetricsSummaryResponse, ProjectProblemReason } from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { useAutoRefresh, type RefreshPhase } from "@/lib/auto-refresh";
import { formatBytes, formatPercent, REASON_KEY } from "@/lib/metrics";
import { formatDateTime, useI18n, type Key } from "@/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { LevelBadge, Sparkline } from "./charts";

/** Atualiza a cada 30 s (o servidor guarda a resposta por 30 s e coleta a cada 60 s). */
const REFRESH: readonly RefreshPhase[] = [{ untilMs: Infinity, everyMs: 30_000 }];
const DAY = 86_400;

const ERROR_KEY: Record<string, Key> = {
  host_unreadable: "metrics.strip.error.host",
  docker_unavailable: "metrics.strip.error.docker",
  disk_write: "metrics.strip.error.disk_write",
  unexpected: "metrics.strip.error.unexpected",
};

interface AttentionItem {
  key: string;
  level: HealthLevel;
  title: string;
  text: string;
  link?: { to: string; label: string; aria?: string };
}

/** Slug do projeto (o servidor devolve o slug) → dados para o link. */
export interface StripProject {
  slug: string;
  id: string;
  name: string;
}

function StatCard({
  icon: Icon,
  title,
  indicator,
  value,
  children,
  spark,
  testId,
}: {
  icon: typeof Cpu;
  title: string;
  indicator: Pick<MetricsIndicator, "level">;
  value: ReactNode;
  children?: ReactNode;
  spark?: ReactNode;
  testId: string;
}) {
  return (
    <Card className="min-w-0" data-testid={testId}>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0 p-3 pb-1">
        <CardTitle className="flex min-w-0 flex-1 basis-32 items-start gap-1.5 text-sm font-medium">
          <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <h4 className="break-words">{title}</h4>
        </CardTitle>
        <LevelBadge level={indicator.level} />
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5 p-3 pt-1">
        <p className="break-words text-base font-semibold leading-snug">{value}</p>
        {children && <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">{children}</div>}
        {spark}
      </CardContent>
    </Card>
  );
}

/**
 * Faixa de semáforos do Dashboard: processador, memória, disco, rede, projetos e
 * proteções, cada um com o valor de agora e a miniatura das últimas 24 horas.
 * O que não foi medido aparece como "sem dados", nunca como zero.
 */
export function MetricsStrip({ projects }: { projects: readonly StripProject[] }) {
  const { t } = useI18n();
  const [data, setData] = useState<MetricsSummaryResponse | null>(null);
  const [error, setError] = useState<"load" | "forbidden" | null>(null);
  const seq = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    try {
      const res = await apiFetch<MetricsSummaryResponse>("/api/metrics/summary", { signal: ac.signal });
      if (mine !== seq.current) return;
      // resposta que não é o semáforo (proxy no meio, versão antiga do servidor): erro de leitura, não tela quebrada
      if (!res || typeof res !== "object" || !res.cpu || !res.collector || !res.projects || !res.protections) throw new Error("shape");
      setData(res);
      setError(null);
    } catch (err) {
      if (mine !== seq.current || ac.signal.aborted) return;
      setError(err instanceof ApiRequestError && err.status === 403 ? "forbidden" : "load");
    }
  }, []);

  useEffect(() => {
    void load();
    return () => controller.current?.abort();
  }, [load]);
  useAutoRefresh(true, load, REFRESH);

  const bySlug = useMemo(() => new Map(projects.map((p) => [p.slug, p])), [projects]);
  const noData = t("metrics.noData");
  const pct = (v: number | null) => (formatPercent(v) === null ? noData : `${formatPercent(v)}%`);
  const bytes = (v: number | null) => formatBytes(v) ?? noData;
  const rate = (v: number | null) => (formatBytes(v) === null ? noData : t("metrics.rate", { value: formatBytes(v)! }));

  if (!data) {
    return (
      <section aria-labelledby="metrics-strip-title" aria-busy={error === null} className="flex flex-col gap-2" data-testid="metrics-strip">
        <h2 id="metrics-strip-title" className="text-lg font-semibold tracking-tight">
          {t("metrics.strip.title")}
        </h2>
        <p role="status" className="text-sm text-muted-foreground">
          {error === "forbidden" ? t("metrics.strip.forbidden") : error === "load" ? t("metrics.strip.loadError") : t("metrics.strip.loading")}
        </p>
        {/* enquanto não chega (e sem erro), os cartões já ocupam o lugar: a tela não pula quando a medida aparece */}
        {error === null && (
          <div
            data-testid="metrics-skeleton"
            aria-hidden="true"
            className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-3"
          >
            {Array.from({ length: 6 }, (_, i) => (
              <Card key={i} className="min-w-0">
                <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 p-3 pb-1">
                  <Skeleton className="h-5 w-24" />
                  <Skeleton className="h-5 w-14 rounded-full" />
                </CardHeader>
                <CardContent className="flex flex-col gap-1.5 p-3 pt-1">
                  <Skeleton className="h-6 w-20" />
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-8 w-full" />
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
    );
  }

  const to = Math.floor(Date.parse(data.generatedAt) / 1000);
  const win = { from: to - DAY, to, step: 900 };
  const sparkOf = (title: string, points: readonly MetricPoint[], format: (v: number) => string, max?: number) => (
    <Sparkline title={title} points={points} {...win} {...(max !== undefined ? { max } : {})} format={format} />
  );
  const c = data.collector;
  const errText = c.lastError ? t(ERROR_KEY[c.lastError] ?? "metrics.strip.error.unexpected") : null;
  const stealHigh = (data.cpu.stealPct ?? 0) >= 1;
  const swap = data.memory.swapUsedBytes ?? 0;
  const full = data.disk.daysToFull;

  // ---- O que precisa de atenção (mesmos semáforos e limiares do servidor; só escolho a frase pelo fator que acendeu)
  const L = METRICS_LEVELS;
  const attention: AttentionItem[] = [];
  const bad = (l: HealthLevel): l is "warning" | "critical" => l === "warning" || l === "critical";
  const ago = (iso: string) => {
    const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
    const span =
      mins < 1 ? t("metrics.when.now") : mins < 60 ? t("metrics.when.min", { count: mins }) : mins < 2880 ? t("metrics.when.hour", { count: Math.round(mins / 60) }) : t("metrics.when.day", { count: Math.round(mins / 1440) });
    return t("metrics.when.full", { ago: span, date: formatDateTime(iso, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }) });
  };

  // Vários fatores podem estar acesos ao mesmo tempo: a frase vem do mais grave (crítico antes de atenção).
  const worstCause = (causes: Array<{ crit: boolean; warn: boolean; text: () => string }>, fallback: () => string) =>
    (causes.find((x) => x.crit) ?? causes.find((x) => x.warn))?.text() ?? fallback();

  if (bad(data.cpu.level)) {
    const { stealPct, psi, busyPct } = data.cpu;
    const text = worstCause(
      [
        { crit: stealPct !== null && stealPct >= L.stealCritical, warn: stealPct !== null && stealPct >= L.stealWarn, text: () => t("metrics.attention.cpu.steal", { value: pct(stealPct) }) },
        { crit: psi !== null && psi >= L.psiCritical, warn: psi !== null && psi >= L.psiWarn, text: () => t("metrics.attention.cpu.psi", { value: pct(psi) }) },
      ],
      () => t("metrics.attention.cpu.busy", { value: pct(busyPct) }),
    );
    attention.push({ key: "cpu", level: data.cpu.level, title: t("metrics.card.cpu.title"), text });
  }
  if (bad(data.memory.level)) {
    const m = data.memory;
    const availPct = m.availBytes !== null && m.totalBytes ? (m.availBytes / m.totalBytes) * 100 : null;
    const avail = () => t("metrics.attention.memory.avail", { avail: bytes(m.availBytes), total: bytes(m.totalBytes) });
    const text = worstCause(
      [
        { crit: m.oomKills24h > 0, warn: m.oomKills24h > 0, text: () => t("metrics.attention.memory.oom", { count: m.oomKills24h }) },
        { crit: m.psi !== null && m.psi >= L.memPsiCritical, warn: m.psi !== null && m.psi >= L.memPsiWarn, text: () => t("metrics.attention.memory.pressure", { value: pct(m.psi) }) },
        { crit: availPct !== null && availPct < L.memAvailCritical, warn: availPct !== null && availPct < L.memAvailWarn, text: avail },
      ],
      avail,
    );
    attention.push({ key: "memory", level: m.level, title: t("metrics.card.memory.title"), text });
  }
  if (bad(data.disk.level)) {
    const d = data.disk;
    const days = d.daysToFull;
    const space = () => t("metrics.attention.disk.space", { value: pct(d.usedPct), free: bytes(d.freeBytes) });
    const text = worstCause(
      [
        { crit: d.usedPct !== null && d.usedPct >= L.diskCritical, warn: d.usedPct !== null && d.usedPct >= L.diskWarn, text: space },
        { crit: d.inodePct !== null && d.inodePct >= L.diskCritical, warn: d.inodePct !== null && d.inodePct >= L.diskWarn, text: () => t("metrics.attention.disk.inodes", { value: pct(d.inodePct) }) },
        {
          crit: days !== null && days.low < L.fullDaysCritical,
          warn: days !== null && days.low < L.fullDaysWarn,
          text: () => (days && days.high === 0 ? t("metrics.card.disk.fullNow") : t("metrics.attention.disk.forecast", { low: days?.low ?? 0, high: days?.high ?? 0 })),
        },
      ],
      space,
    );
    attention.push({ key: "disk", level: d.level, title: t("metrics.card.disk.title"), text });
  }
  for (const p of data.projects.problems) {
    const known = bySlug.get(p.slug);
    const reasons = [...new Set(p.reasons)].map((r: ProjectProblemReason) => t(REASON_KEY[r])).join(", ");
    attention.push({
      key: `project-${p.slug}`,
      level: p.level ?? "warning",
      title: known?.name ?? p.slug,
      text: t("metrics.attention.project", { reasons }),
      ...(known ? { link: { to: `/projects/${known.id}/resources`, label: t("metrics.attention.projectLink"), aria: t("metrics.attention.projectLinkNamed", { name: known.name }) } } : {}),
    });
  }
  const certs = data.protections.certificates;
  const backups = data.protections.backups;
  if (certs && certs.problems > 0) {
    attention.push({ key: "certs", level: "critical", title: t("metrics.attention.certsTitle"), text: t("metrics.attention.certs", { problems: certs.problems, total: certs.total }), link: { to: "/certificates", label: t("metrics.attention.certsLink") } });
  }
  if (backups?.lastFailure) {
    attention.push({ key: "backup", level: "critical", title: t("metrics.attention.backupTitle"), text: backups.lastFailureAt ? t("metrics.attention.backupFailedAt", { date: ago(backups.lastFailureAt) }) : t("metrics.attention.backupFailed"), link: { to: "/settings/backups", label: t("metrics.attention.backupLink") } });
  } else if (backups && !backups.destinationConnected) {
    attention.push({ key: "backup", level: "warning", title: t("metrics.attention.backupTitle"), text: t("metrics.attention.backupLocal"), link: { to: "/settings/backups", label: t("metrics.attention.backupLink") } });
  }
  const rank = { critical: 0, warning: 1 } as const;
  attention.sort((a, b) => rank[a.level as "critical" | "warning"] - rank[b.level as "critical" | "warning"]);
  const needCount = attention.length;

  // Indicador sem medida NÃO é "em ordem": vira item informativo (neutro) com o motivo.
  const whyNoData = c.mode === "unavailable" && c.lastTickAt === null ? t("metrics.unknown.collecting") : (errText ?? t("metrics.unknown.stale"));
  const noMeasure: Array<[string, string, HealthLevel, string?]> = [
    ["cpu", t("metrics.card.cpu.title"), data.cpu.level],
    ["memory", t("metrics.card.memory.title"), data.memory.level],
    ["disk", t("metrics.card.disk.title"), data.disk.level],
    ["projects", t("metrics.card.projects.title"), data.projects.level],
    ["protections", t("metrics.card.protections.title"), data.protections.level, certs === null && backups === null ? t("metrics.unknown.protections") : undefined],
  ];
  const unknownItems = noMeasure.filter(([, , level]) => level === "unknown");
  for (const [key, title, , why] of unknownItems) {
    attention.push({ key: `unknown-${key}`, level: "unknown", title, text: t("metrics.unknown.item", { name: title, reason: why ?? whyNoData }) });
  }
  const summaryKind: "ok" | "needs" | "unknown" = needCount > 0 ? "needs" : unknownItems.length > 0 ? "unknown" : "ok";
  const checks = [certs && certs.total > 0 ? certs.problems === 0 : null, backups ? backups.destinationConnected && !backups.lastFailure : null].filter((v): v is boolean => v !== null);
  const GRID = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-3";
  const GRID_RESOURCES = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))] gap-3";

  return (
    <section aria-labelledby="metrics-strip-title" className="flex flex-col gap-4" data-testid="metrics-strip">
      <div>
        <h2 id="metrics-strip-title" className="text-lg font-semibold tracking-tight">
          {t("metrics.strip.title")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("metrics.strip.subtitle")}
          {c.lastTickAt && <> {t("metrics.strip.lastTick", { date: formatDateTime(c.lastTickAt) })}</>}
        </p>
      </div>

      {c.mode === "unavailable" && c.lastTickAt === null && (
        <p role="status" className="flex items-start gap-2 text-sm text-muted-foreground" data-testid="metrics-collecting">
          <Activity className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> {t("metrics.strip.collecting")}
        </p>
      )}
      {c.mode === "reduced" && (
        <div role="status" className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm" data-testid="metrics-reduced">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-medium">{t("metrics.strip.reduced.title")}</p>
            <p className="break-words text-muted-foreground">{t("metrics.strip.reduced.body")}</p>
          </div>
        </div>
      )}
      {errText && (
        <p role="status" className="text-sm text-amber-400" data-testid="metrics-error">
          {errText}
        </p>
      )}
      {error && <p role="status" className="text-sm text-muted-foreground">{error === "forbidden" ? t("metrics.strip.forbidden") : t("metrics.strip.loadError")}</p>}

      <div
        role="status"
        className={`flex items-start gap-2 rounded-md border px-3 py-2 ${
          summaryKind === "ok" ? "border-emerald-500/40 bg-emerald-500/10" : summaryKind === "needs" ? "border-amber-500/40 bg-amber-500/10" : "border-border bg-muted/40"
        }`}
        data-testid="metrics-summary"
        data-state={summaryKind}
        data-attention={needCount}
      >
        {summaryKind === "ok" ? (
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" aria-hidden="true" />
        ) : summaryKind === "needs" ? (
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" aria-hidden="true" />
        ) : (
          <HelpCircle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <p className="break-words text-base font-semibold">
          {summaryKind === "ok"
            ? t("metrics.summary.allOk")
            : summaryKind === "needs"
              ? t("metrics.summary.needs", { count: needCount })
              : t("metrics.summary.noData", { count: unknownItems.length })}
        </p>
      </div>

      {attention.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label={t("metrics.attention.listLabel")} data-testid="metrics-attention">
          {attention.map((a) => (
            <li key={a.key} className="flex flex-col gap-2 rounded-md border bg-card p-3 sm:flex-row sm:items-center sm:justify-between" data-testid={`attention-${a.key}`}>
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <LevelBadge level={a.level} />
                  <span className="break-words font-medium">{a.title}</span>
                </div>
                <p className="break-words text-sm text-muted-foreground">{a.text}</p>
              </div>
              {a.link && (
                <Link to={a.link.to} {...(a.link.aria ? { "aria-label": a.link.aria } : {})} className="shrink-0 self-start rounded-md border px-3 py-1.5 text-sm font-medium underline-offset-2 hover:bg-accent sm:self-center">
                  {a.link.label}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}

      <section aria-labelledby="metrics-resources-title" className="flex flex-col gap-2" data-testid="metrics-group-resources">
        <h3 id="metrics-resources-title" className="text-base font-semibold">
          {t("metrics.group.resources")}
        </h3>
        <div className={GRID_RESOURCES}>
          <StatCard
            testId="metric-cpu"
            icon={Cpu}
            title={t("metrics.card.cpu.title")}
            indicator={data.cpu}
            value={data.cpu.busyPct === null ? noData : t("metrics.card.cpu.value", { value: formatPercent(data.cpu.busyPct) ?? "" })}
            spark={sparkOf(t("metrics.card.cpu.title"), data.cpu.spark, (v) => pct(v), 100)}
          >
            {data.cpu.cores !== null && <span>{t("metrics.card.cpu.cores", { count: data.cpu.cores })}</span>}
            {stealHigh && <span>{t("metrics.card.cpu.steal", { value: formatPercent(data.cpu.stealPct) ?? "" })}</span>}
            {data.cpu.psi !== null && data.cpu.psi >= 5 && <span>{t("metrics.card.cpu.psi", { value: formatPercent(data.cpu.psi) ?? "" })}</span>}
          </StatCard>

          <StatCard
            testId="metric-memory"
            icon={MemoryStick}
            title={t("metrics.card.memory.title")}
            indicator={data.memory}
            value={
              data.memory.availBytes === null || data.memory.totalBytes === null
                ? noData
                : t("metrics.card.memory.avail", { avail: bytes(data.memory.availBytes), total: bytes(data.memory.totalBytes) })
            }
            spark={sparkOf(t("metrics.card.memory.title"), data.memory.spark, (v) => pct(v), 100)}
          >
            {data.memory.psi !== null && data.memory.psi >= 5 && <span>{t("metrics.card.memory.pressure", { value: formatPercent(data.memory.psi) ?? "" })}</span>}
            {swap > 0 && <span>{t("metrics.card.memory.swap", { value: bytes(swap) })}</span>}
            {data.memory.oomKills24h > 0 && <span className="text-red-400">{t("metrics.card.memory.oom", { count: data.memory.oomKills24h })}</span>}
          </StatCard>

          <StatCard
            testId="metric-disk"
            icon={HardDrive}
            title={t("metrics.card.disk.title")}
            indicator={data.disk}
            value={data.disk.usedPct === null ? noData : t("metrics.card.disk.value", { value: formatPercent(data.disk.usedPct) ?? "" })}
            spark={sparkOf(t("metrics.card.disk.title"), data.disk.spark, (v) => pct(v), 100)}
          >
            {data.disk.freeBytes !== null && <span>{t("metrics.card.disk.free", { value: bytes(data.disk.freeBytes) })}</span>}
            {data.disk.inodePct !== null && data.disk.inodePct >= 50 && <span>{t("metrics.card.disk.inodes", { value: formatPercent(data.disk.inodePct) ?? "" })}</span>}
            {full && (full.high === 0 ? <span>{t("metrics.card.disk.fullNow")}</span> : <span>{t("metrics.card.disk.full", { low: full.low, high: full.high })}</span>)}
          </StatCard>

          <StatCard
            testId="metric-network"
            icon={Network}
            title={t("metrics.card.network.title")}
            indicator={data.network}
            value={
              data.network.rxBytesPerSecond === null && data.network.txBytesPerSecond === null
                ? t("metrics.card.network.none")
                : t("metrics.card.network.value", { rx: rate(data.network.rxBytesPerSecond), tx: rate(data.network.txBytesPerSecond) })
            }
            spark={sparkOf(t("metrics.card.network.title"), data.network.spark, (v) => rate(v))}
          />
        </div>
      </section>

      <section aria-labelledby="metrics-protect-title" className="flex flex-col gap-2" data-testid="metrics-group-protections">
        <h3 id="metrics-protect-title" className="text-base font-semibold">
          {t("metrics.group.projectsProtections")}
        </h3>
        <div className={GRID}>
          <StatCard
            testId="metric-projects"
            icon={Boxes}
            title={t("metrics.card.projects.title")}
            indicator={data.projects}
            value={data.projects.level === "unknown" ? noData : data.projects.total === 0 ? t("metrics.card.projects.none") : t("metrics.card.projects.value", { running: data.projects.running, total: data.projects.total, count: data.projects.total })}
          >
            {data.projects.level !== "unknown" && data.projects.problems.length === 0 && <span>{t("metrics.card.projects.ok")}</span>}
            {data.projects.problems.length > 0 && (
              <>
                <span className="font-medium text-foreground">{t("metrics.card.projects.problems", { count: data.projects.problems.length })}</span>
                <ul className="flex flex-col gap-0.5">
                  {data.projects.problems.map((p) => {
                    const known = bySlug.get(p.slug);
                    const reasons = [...new Set(p.reasons)].map((r: ProjectProblemReason) => t(REASON_KEY[r])).join(", ");
                    return (
                      <li key={p.slug} className="break-words">
                        {known ? (
                          <Link to={`/projects/${known.id}/resources`} className="font-medium text-foreground underline underline-offset-2" aria-label={t("metrics.card.projects.open", { name: known.name })}>
                            {known.name}
                          </Link>
                        ) : (
                          <span className="font-medium text-foreground">{p.slug}</span>
                        )}
                        : {reasons}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </StatCard>

          <StatCard
            testId="metric-protections"
            icon={ShieldCheck}
            title={t("metrics.card.protections.title")}
            indicator={{ level: data.protections.level }}
            value={checks.length === 0 ? noData : t("metrics.card.protections.count", { ok: checks.filter(Boolean).length, total: checks.length })}
          >
            {certs ? (
              <span>
                {certs.total === 0
                  ? t("metrics.card.protections.certsNone")
                  : certs.problems === 0
                    ? t("metrics.card.protections.certsOk", { total: certs.total })
                  : t("metrics.card.protections.certsProblems", { problems: certs.problems, total: certs.total })}{" "}
                <Link to="/certificates" className="underline underline-offset-2">
                  {t("metrics.card.protections.certsLink")}
                </Link>
              </span>
            ) : (
              <span>{t("metrics.card.protections.unknown")}</span>
            )}
            {backups && (
              <span>
                {backups.lastFailure
                  ? backups.lastFailureAt
                    ? t("metrics.card.protections.backupFailedAt", { date: ago(backups.lastFailureAt) })
                    : t("metrics.card.protections.backupFailed")
                  : backups.destinationConnected
                    ? t("metrics.card.protections.backupOk")
                    : t("metrics.card.protections.backupLocal")}{" "}
                <Link to="/settings/backups" className="underline underline-offset-2">
                  {t("metrics.card.protections.backupsLink")}
                </Link>
              </span>
            )}
          </StatCard>
        </div>
      </section>
    </section>
  );
}
