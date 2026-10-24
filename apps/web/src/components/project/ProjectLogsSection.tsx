import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Loader2, RefreshCw } from "lucide-react";
import {
  PROJECT_LOGS_SINCE,
  PROJECT_LOGS_TAIL_DEFAULT,
  PROJECT_LOGS_TAIL_MAX,
  type ProjectLogService,
  type ProjectLogsResponse,
  type ProjectLogsSince,
} from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { useAutoRefresh, type RefreshPhase } from "@/lib/auto-refresh";
import { copyText } from "@/lib/clipboard";
import { filterLogLines, isNearBottom, isProjectStopped, linesToText, logTimeLabel } from "@/lib/project-logs";
import { formatDateTime, useI18n, type Key } from "@/i18n";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const TAIL_CHOICES = [100, 200, 500, 1000, PROJECT_LOGS_TAIL_MAX] as const;
const INTERVALS = [5, 10, 30, 60] as const;
const DEFAULT_INTERVAL = 10;

const selectClass =
  "h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";

const STATE_KEYS: Record<string, Key> = {
  running: "projects.logs.state.running",
  exited: "projects.logs.state.exited",
  restarting: "projects.logs.state.restarting",
  paused: "projects.logs.state.paused",
  created: "projects.logs.state.created",
  dead: "projects.logs.state.dead",
};
const HEALTH_KEYS: Record<NonNullable<ProjectLogService["health"]>, Key> = {
  healthy: "projects.logs.health.healthy",
  unhealthy: "projects.logs.health.unhealthy",
  starting: "projects.logs.health.starting",
};
const SINCE_KEYS: Record<ProjectLogsSince, Key> = {
  "15m": "projects.logs.since.15m",
  "1h": "projects.logs.since.1h",
  "24h": "projects.logs.since.24h",
};

function stateVariant(state: string): "success" | "warning" | "destructive" | "secondary" {
  if (state === "running") return "success";
  if (state === "restarting" || state === "dead") return "destructive";
  if (state === "paused" || state === "created") return "warning";
  return "secondary";
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

function ServiceState({ s }: { s: ProjectLogService }) {
  const { t } = useI18n();
  const running = s.state === "running";
  return (
    <li className="flex min-w-0 flex-col gap-1 rounded-md border p-2 text-xs" data-testid={`log-service-${s.service}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="break-all font-mono text-sm font-medium">{s.service}</span>
        <Badge variant={stateVariant(s.state)}>{t(STATE_KEYS[s.state] ?? "projects.logs.state.unknown")}</Badge>
        {s.health && <Badge variant={s.health === "healthy" ? "success" : s.health === "unhealthy" ? "destructive" : "secondary"}>{t(HEALTH_KEYS[s.health])}</Badge>}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
        {s.restartCount !== null && <span>{t("projects.logs.restarts", { count: s.restartCount })}</span>}
        {running && s.startedAt && <span>{t("projects.logs.startedAt", { date: formatDateTime(s.startedAt) })}</span>}
        {!running && s.finishedAt && <span>{t("projects.logs.finishedAt", { date: formatDateTime(s.finishedAt) })}</span>}
        {!running && s.exitCode !== null && <span>{t("projects.logs.exitCode", { code: s.exitCode })}</span>}
      </div>
      {s.logsError && <p className="text-amber-300">{t(s.logsError === "too_large" ? "projects.logs.logError.too_large" : "projects.logs.logError.unavailable")}</p>}
    </li>
  );
}

/**
 * Aba "Logs" do projeto: o que os containers escrevem (stdout/stderr com
 * horário) e o estado de cada serviço, sem entrar na VPS. Consulta simples
 * (sem streaming): ao abrir, ao mudar um seletor, no botão e — enquanto
 * ligado — a cada N segundos. O filtro de texto é local (não consulta).
 */
export function ProjectLogsSection({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const [service, setService] = useState("");
  const [tail, setTail] = useState<number>(PROJECT_LOGS_TAIL_DEFAULT);
  const [since, setSince] = useState<"" | ProjectLogsSince>("");
  const [auto, setAuto] = useState(true);
  const [interval, setIntervalSeconds] = useState<number>(DEFAULT_INTERVAL);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState("");
  const [data, setData] = useState<ProjectLogsResponse | null>(null);
  // consultas pedidas pela pessoa ainda em andamento (conta mesmo as que ficaram velhas: o botão só destrava quando todas terminam)
  const [busy, setBusy] = useState(0);
  const loading = busy > 0;
  const [shownProject, setShownProject] = useState(projectId);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const seq = useRef(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (quiet: boolean) => {
      const mine = ++seq.current;
      if (!quiet) {
        setBusy((n) => n + 1);
        setError(null);
      }
      const qs = new URLSearchParams({ tail: String(tail) });
      if (service) qs.set("service", service);
      if (since) qs.set("since", since);
      try {
        const res = await apiFetch<ProjectLogsResponse>(`/api/projects/${encodeURIComponent(projectId)}/logs?${qs.toString()}`);
        if (mine !== seq.current) return;
        setData(res);
        setError(null);
        // o serviço escolhido deixou de existir (novo deploy): volta para "todos"
        if (service && !res.services.some((s) => s.service === service)) setService("");
      } catch (err) {
        if (mine !== seq.current) return;
        const code = err instanceof ApiRequestError ? err.code : "";
        setError(
          code === "docker_unavailable"
            ? t("projects.logs.error.docker")
            : code === "log_masking_unavailable"
              ? t("projects.logs.error.masking")
              : code === "logs_busy"
                ? t("projects.logs.error.busy")
                : t("projects.logs.error.load"),
        );
        // consulta pedida pela pessoa não deixa lista velha ao lado do erro; a automática mantém o que já estava
        if (!quiet) setData(null);
      } finally {
        if (!quiet) setBusy((n) => n - 1);
      }
    },
    [projectId, service, tail, since, t],
  );

  // Outro projeto: as linhas e o serviço escolhido do anterior somem na hora (antes de o novo responder).
  if (shownProject !== projectId) {
    setShownProject(projectId);
    setData(null);
    setError(null);
    setService("");
  }

  useEffect(() => {
    void load(false);
  }, [load]);

  const schedule = useMemo<readonly RefreshPhase[]>(() => [{ untilMs: Infinity, everyMs: interval * 1000 }], [interval]);
  useAutoRefresh(auto, () => load(true), schedule);

  const visible = useMemo(() => filterLogLines(data?.lines ?? [], filter), [data, filter]);

  // Acompanhar o fim: depois de cada atualização (ou ao ligar), a caixa vai para a última linha.
  useEffect(() => {
    const box = boxRef.current;
    if (follow && box) box.scrollTop = box.scrollHeight;
  }, [visible, follow]);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  async function copy() {
    const ok = await copyText(linesToText(visible));
    setCopied(ok ? "ok" : "fail");
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 1500);
  }

  const services = data?.services ?? [];
  const serviceNames = [...new Set([...services.map((s) => s.service), ...(service ? [service] : [])])];
  const stopped = isProjectStopped(services);
  const total = data?.lines.length ?? 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{t("projects.logs.title")}</CardTitle>
        <CardDescription>{t("projects.logs.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {services.length > 0 && (
          <ul aria-label={t("projects.logs.services.label")} className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {services.map((s) => (
              <ServiceState key={s.container} s={s} />
            ))}
          </ul>
        )}

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Field id="logs-service" label={t("projects.logs.field.service")}>
            <select id="logs-service" className={selectClass} value={service} onChange={(e) => setService(e.target.value)}>
              <option value="">{t("projects.logs.field.allServices")}</option>
              {serviceNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          <Field id="logs-tail" label={t("projects.logs.field.tail")}>
            <select id="logs-tail" className={selectClass} value={tail} onChange={(e) => setTail(Number(e.target.value))}>
              {TAIL_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          <Field id="logs-since" label={t("projects.logs.field.since")}>
            <select id="logs-since" className={selectClass} value={since} onChange={(e) => setSince(e.target.value as "" | ProjectLogsSince)}>
              <option value="">{t("projects.logs.since.any")}</option>
              {PROJECT_LOGS_SINCE.map((s) => (
                <option key={s} value={s}>
                  {t(SINCE_KEYS[s])}
                </option>
              ))}
            </select>
          </Field>
          <Field id="logs-filter" label={t("projects.logs.field.filter")}>
            <Input id="logs-filter" value={filter} maxLength={200} placeholder={t("projects.logs.filter.placeholder")} onChange={(e) => setFilter(e.target.value)} />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button size="sm" variant="outline" disabled={loading} onClick={() => void load(false)}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {t("projects.logs.action.refresh")}
          </Button>
          <Button size="sm" variant="outline" disabled={visible.length === 0} onClick={() => void copy()}>
            {copied === "ok" ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
            {copied === "ok" ? t("projects.logs.action.copied") : t("projects.logs.action.copy")}
          </Button>
          <span aria-live="polite" className="text-xs text-destructive">
            {copied === "fail" ? t("projects.logs.action.copyFailed") : ""}
          </span>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            {t("projects.logs.auto.label")}
          </label>
          <div className="flex items-center gap-2">
            <label htmlFor="logs-interval" className="text-xs text-muted-foreground">
              {t("projects.logs.auto.interval")}
            </label>
            <select
              id="logs-interval"
              className={cn(selectClass, "w-auto")}
              value={interval}
              disabled={!auto}
              onChange={(e) => setIntervalSeconds(Number(e.target.value))}
            >
              {INTERVALS.map((n) => (
                <option key={n} value={n}>
                  {t("projects.logs.auto.seconds", { seconds: n })}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            {t("projects.logs.follow")}
          </label>
        </div>

        <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
          {loading && !data
            ? t("projects.logs.status.loading")
            : data
              ? t(filter.trim() ? "projects.logs.status.filtered" : "projects.logs.status.shown", {
                  shown: visible.length,
                  total,
                  time: logTimeLabel(data.generatedAt),
                })
              : ""}
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {data?.truncated && <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-300">{t("projects.logs.truncated")}</p>}

        {data && services.length === 0 && <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">{t("projects.logs.empty.noContainers")}</p>}
        {data && stopped && <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-300">{t("projects.logs.empty.stopped")}</p>}
        {data && services.length > 0 && total === 0 && (
          <p className="text-sm text-muted-foreground">{t(data.since ? "projects.logs.empty.noLinesSince" : "projects.logs.empty.noLines")}</p>
        )}
        {data && total > 0 && visible.length === 0 && <p className="text-sm text-muted-foreground">{t("projects.logs.empty.filter")}</p>}

        {visible.length > 0 && (
          <div
            ref={boxRef}
            role="region"
            aria-label={t("projects.logs.box.label")}
            tabIndex={0}
            onScroll={(e) => setFollow(isNearBottom(e.currentTarget))}
            className="max-h-[60vh] min-h-[8rem] overflow-auto rounded-md border bg-black/40 p-2 font-mono text-xs leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {visible.map((l, i) => (
              <div key={i} data-stream={l.stream} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                {l.time && <span className="text-muted-foreground">{logTimeLabel(l.time)} </span>}
                {services.length > 1 && <span className="text-sky-300">{l.service} </span>}
                {l.stream === "stderr" && (
                  <span className="font-semibold text-red-400" title={t("projects.logs.stream.stderrLabel")}>
                    [{t("projects.logs.stream.stderr")}]{" "}
                  </span>
                )}
                <span className={l.stream === "stderr" ? "text-red-300" : undefined}>{l.text}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
