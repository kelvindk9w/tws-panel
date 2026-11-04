import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Loader2, RefreshCw } from "lucide-react";
import { PROJECT_LOGS_SINCE, SERVER_LOG_SOURCES, type ProjectLogService, type ProjectLogsSince, type ServerLogsResponse } from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { useAutoRefresh, type RefreshPhase } from "@/lib/auto-refresh";
import { copyText } from "@/lib/clipboard";
import { filterLogLines, isNearBottom, linesToText, logTimeLabel } from "@/lib/project-logs";
import { buildServerLogsQuery, hasJournalUnavailable, isJournalSource, serverLogsErrorKey, sourceLabelKey } from "@/lib/server-logs";
import { formatDateTime, useI18n, type Key } from "@/i18n";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const TAIL_CHOICES = [100, 200, 500, 1000, 2000] as const;
const INTERVALS = [5, 10, 30, 60] as const;

const selectClass =
  "h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";

const STATE_KEYS: Record<string, Key> = {
  running: "projects.logs.state.running",
  exited: "projects.logs.state.exited",
  restarting: "projects.logs.state.restarting",
  paused: "projects.logs.state.paused",
  created: "projects.logs.state.created",
  dead: "projects.logs.state.dead",
  journal: "diagnostico.serverLogs.state.journal",
};
const SINCE_KEYS: Record<ProjectLogsSince, Key> = {
  "15m": "projects.logs.since.15m",
  "1h": "projects.logs.since.1h",
  "24h": "projects.logs.since.24h",
};

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

function SourceState({ s }: { s: ProjectLogService }) {
  const { t } = useI18n();
  const labelKey = sourceLabelKey(s.service);
  const running = s.state === "running";
  const journal = isJournalSource(s.service);
  return (
    <li className="flex min-w-0 flex-col gap-1 rounded-md border p-2 text-xs" data-testid={`server-log-source-${s.service}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="break-all text-sm font-medium">{labelKey ? t(labelKey) : s.service}</span>
        <Badge variant={running ? "success" : s.state === "restarting" || s.state === "dead" ? "destructive" : "secondary"}>
          {t(STATE_KEYS[s.state] ?? "projects.logs.state.unknown")}
        </Badge>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
        {s.restartCount !== null && <span>{t("projects.logs.restarts", { count: s.restartCount })}</span>}
        {running && s.startedAt && <span>{t("projects.logs.startedAt", { date: formatDateTime(s.startedAt) })}</span>}
      </div>
      {s.logsError && (
        <p className="text-amber-300">
          {s.logsError === "too_large"
            ? t("projects.logs.logError.too_large")
            : journal
              ? t("diagnostico.serverLogs.journalUnavailable")
              : t("projects.logs.logError.unavailable")}
        </p>
      )}
    </li>
  );
}

/**
 * Painel da página "Logs do servidor": mesmas opções da aba Logs do projeto, mas a fonte é uma lista fechada
 * (containers do painel e unidades da VPS). A atualização automática começa DESLIGADA: cada leitura é auditada
 * e o servidor limita a frequência.
 */
export function ServerLogsPanel() {
  const { t } = useI18n();
  const [source, setSource] = useState("");
  const [tail, setTail] = useState<number>(200);
  const [since, setSince] = useState<"" | ProjectLogsSince>("");
  const [auto, setAuto] = useState(false);
  const [interval, setIntervalSeconds] = useState<number>(30);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState("");
  const [data, setData] = useState<ServerLogsResponse | null>(null);
  const [busy, setBusy] = useState(0);
  const loading = busy > 0;
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const seq = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        const res = await apiFetch<ServerLogsResponse>(`/api/server-logs?${buildServerLogsQuery({ source, tail, since })}`, { signal: ac.signal });
        if (mine !== seq.current) return;
        setData(res);
        setError(null);
      } catch (err) {
        if (mine !== seq.current || ac.signal.aborted) return;
        const code = err instanceof ApiRequestError ? err.code : "";
        const status = err instanceof ApiRequestError ? err.status : 0;
        setError(t(serverLogsErrorKey(code, status)));
        if (!quiet) setData(null);
      } finally {
        if (!quiet) setBusy((n) => n - 1);
      }
    },
    [source, tail, since, t],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => () => controller.current?.abort(), []);

  const schedule = useMemo<readonly RefreshPhase[]>(() => [{ untilMs: Infinity, everyMs: interval * 1000 }], [interval]);
  useAutoRefresh(auto, () => load(true), schedule);

  const visible = useMemo(() => filterLogLines(data?.lines ?? [], filter), [data, filter]);

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
  const total = data?.lines.length ?? 0;
  const multi = services.length > 1;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{t("diagnostico.serverLogs.title")}</CardTitle>
        <CardDescription>{t("diagnostico.serverLogs.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          <p>{t("diagnostico.serverLogs.note.masking")}</p>
          <p>{t("diagnostico.serverLogs.note.ssh")}</p>
        </div>

        {services.length > 0 && (
          <ul aria-label={t("diagnostico.serverLogs.sourceHeading")} className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {services.map((s) => (
              <SourceState key={s.service} s={s} />
            ))}
          </ul>
        )}

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Field id="slogs-source" label={t("diagnostico.serverLogs.field.source")}>
            <select id="slogs-source" className={selectClass} value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">{t("diagnostico.serverLogs.source.all")}</option>
              {SERVER_LOG_SOURCES.map((s) => (
                <option key={s.id} value={s.id}>
                  {t(sourceLabelKey(s.id)!)}
                </option>
              ))}
            </select>
          </Field>
          <Field id="slogs-tail" label={t("projects.logs.field.tail")}>
            <select id="slogs-tail" className={selectClass} value={tail} onChange={(e) => setTail(Number(e.target.value))}>
              {TAIL_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          <Field id="slogs-since" label={t("projects.logs.field.since")}>
            <select id="slogs-since" className={selectClass} value={since} onChange={(e) => setSince(e.target.value as "" | ProjectLogsSince)}>
              <option value="">{t("projects.logs.since.any")}</option>
              {PROJECT_LOGS_SINCE.map((s) => (
                <option key={s} value={s}>
                  {t(SINCE_KEYS[s])}
                </option>
              ))}
            </select>
          </Field>
          <Field id="slogs-filter" label={t("projects.logs.field.filter")}>
            <Input id="slogs-filter" value={filter} maxLength={200} placeholder={t("projects.logs.filter.placeholder")} onChange={(e) => setFilter(e.target.value)} />
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
            {t("diagnostico.serverLogs.auto.label")}
          </label>
          <div className="flex items-center gap-2">
            <label htmlFor="slogs-interval" className="text-xs text-muted-foreground">
              {t("projects.logs.auto.interval")}
            </label>
            <select id="slogs-interval" className={cn(selectClass, "w-auto")} value={interval} disabled={!auto} onChange={(e) => setIntervalSeconds(Number(e.target.value))}>
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
              ? t(filter.trim() ? "projects.logs.status.filtered" : "projects.logs.status.shown", { shown: visible.length, total, time: logTimeLabel(data.generatedAt) })
              : ""}
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {data && hasJournalUnavailable(services) && (
          <p role="note" className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
            {t("diagnostico.serverLogs.journalUnavailable")}
          </p>
        )}
        {data?.truncated && <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-300">{t("projects.logs.truncated")}</p>}
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
                {multi && <span className="text-sky-300">{l.service} </span>}
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
