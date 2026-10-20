import { useCallback, useEffect, useState } from "react";
import type {
  BaselineResponse,
  BlacklistCheckResponse,
  MonitorRunResponse,
  MonitorStateResponse,
  SecurityHistoryResponse,
  SecurityScanResponse,
} from "@paas/core";
import { MONITOR_MAX_INTERVAL_MS } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, formatDateTime, Trans, useI18n, type TFunction } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Activity,
  Camera,
  Gauge,
  Loader2,
  MailWarning,
  Play,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

/** Teto do intervalo do monitoramento em horas (168 h, igual às Notificações). */
const MAX_INTERVAL_HOURS = MONITOR_MAX_INTERVAL_MS / 3_600_000;

function fmtDate(iso: string | null | undefined): string {
  return iso ? formatDateTime(iso) : "—";
}

function scaleName(t: TFunction, source: string | null | undefined): string {
  return t(source === "lynis" ? "security.scale.lynis" : "security.scale.internal");
}

/** Card 1: Hardening Index atual + histórico. */
function HardeningCard() {
  const { t } = useI18n();
  const [scan, setScan] = useState<SecurityScanResponse | null>(null);
  const [history, setHistory] = useState<SecurityHistoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      apiFetch<SecurityScanResponse>("/api/security/scan"),
      apiFetch<SecurityHistoryResponse>("/api/security/history"),
    ])
      .then(([s, h]) => {
        setScan(s);
        setHistory(h);
      })
      .catch((err) => setError(apiErrorText(err, "security.score.loadError")));
  }, []);

  const index = scan?.report?.hardeningIndex ?? null;
  const scans = history?.entries.filter((e) => e.kind === "scan") ?? [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Gauge className="h-4 w-4" /> {t("security.score.title")}
          {scan?.refreshing && (
            <span className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> {t("security.score.refreshing")}
            </span>
          )}
        </CardTitle>
        <CardDescription>{t("security.score.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!scan && !error && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {t("security.score.loading")}
          </p>
        )}
        {scan && (
          <>
            <div className="flex items-end gap-2">
              <span
                className={`text-4xl font-bold ${
                  (index ?? 0) >= 70 ? "text-emerald-400" : (index ?? 0) >= 40 ? "text-amber-400" : "text-red-400"
                }`}
              >
                {index ?? "—"}
              </span>
              <span className="pb-1 text-sm text-muted-foreground">
                {t("security.score.source", { source: scan.report.hardeningIndexSource })}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("security.score.summary", {
                pass: scan.report.summary.pass,
                fail: scan.report.summary.fail,
                date: fmtDate(scan.report.scannedAt),
              })}
            </p>
            {/* Evolução: seta só entre notas da MESMA régua — 42 (índice interno)
                → 86 (Lynis) não é ganho de 44 pontos (visto em campo). */}
            {(() => {
              const withIndex = scans.filter((e) => typeof e.hardeningIndex === "number");
              const first = withIndex[0];
              const last = withIndex.at(-1);
              if (!first || !last || first === last) return null;
              const same = (first.hardeningIndexSource ?? "internal") === (last.hardeningIndexSource ?? "internal");
              const a = first.hardeningIndex as number;
              const b = last.hardeningIndex as number;
              return (
                <p data-testid="evolution" className="text-xs text-muted-foreground">
                  {same
                    ? t("security.score.evolution", { a, b, arrow: b > a ? " ▲" : b < a ? " ▼" : "" })
                    : t("security.score.evolutionScales", {
                        a,
                        b,
                        scaleA: scaleName(t, first.hardeningIndexSource),
                        scaleB: scaleName(t, last.hardeningIndexSource),
                      })}
                </p>
              );
            })()}
            {scans.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {scans.slice(-8).map((s) => (
                  <Badge
                    key={s.id}
                    variant="secondary"
                    title={t("security.score.badgeTitle", { date: fmtDate(s.at), scale: scaleName(t, s.hardeningIndexSource) })}
                  >
                    {s.hardeningIndex ?? "—"}
                    {s.hardeningIndexSource === "lynis" ? "" : "*"}
                  </Badge>
                ))}
              </div>
            )}
            {scans.some((e) => e.hardeningIndexSource !== "lynis") && (
              <p className="text-[11px] text-muted-foreground">{t("security.score.internalNote")}</p>
            )}
          </>
        )}
        <Button size="sm" variant="outline" className="mt-1 self-start" asChild>
          <Link to="/security/hardening">{t("security.score.apply")}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

/** Card 2: Baseline de segurança. */
function BaselineCard({ onUpdated }: { onUpdated: () => void }) {
  const { t } = useI18n();
  const [baseline, setBaseline] = useState<BaselineResponse["baseline"] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch<BaselineResponse>("/api/security/baseline");
      setBaseline(res.baseline);
      setError(null);
    } catch (err) {
      setError(apiErrorText(err, "security.baseline.loadError"));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<BaselineResponse>("/api/security/baseline", { method: "POST" });
      setBaseline(res.baseline);
      onUpdated();
    } catch (err) {
      setError(apiErrorText(err, "security.baseline.createError"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Camera className="h-4 w-4" /> {t("security.baseline.title")}
        </CardTitle>
        <CardDescription>
          {t("security.baseline.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!loaded ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {t("security.baseline.loading")}
          </p>
        ) : baseline ? (
          <div className="text-sm">
            <p>
              <Trans
                k="security.baseline.created"
                params={{ date: fmtDate(baseline.createdAt), target: baseline.target }}
                components={{ b: <strong /> }}
              />
            </p>
            <p className="text-xs text-muted-foreground">
              {t("security.baseline.packages", { count: baseline.packages.length })} ·{" "}
              {t("security.baseline.ports", { count: baseline.ports.length })} ·{" "}
              {t("security.baseline.files", { count: Object.keys(baseline.files).length })}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("security.baseline.empty")}
          </p>
        )}
        <div>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void create()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {t(baseline ? "security.baseline.update" : "security.baseline.create")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Card 3: Monitoramento recorrente (scan com diff + agendador). */
function MonitorCard({ refreshKey }: { refreshKey: number }) {
  const { t } = useI18n();
  const [state, setState] = useState<MonitorStateResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hours, setHours] = useState("6");

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch<MonitorStateResponse>("/api/security/monitor/last");
      setState(res);
      setHours(String(Math.round(res.config.intervalMs / 3_600_000)));
      setError(null);
    } catch (err) {
      setError(apiErrorText(err, "security.monitor.loadError"));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  async function runNow() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch<MonitorRunResponse>("/api/security/monitor/run", { method: "POST" });
      await refresh();
    } catch (err) {
      setError(apiErrorText(err, "security.monitor.runError"));
    } finally {
      setBusy(false);
    }
  }

  async function saveInterval() {
    const value = Number(hours);
    // teto de 168 h (o mesmo das Notificações): acima de ~597 h o timer do
    // servidor estoura e o scan passaria a rodar sem parar
    if (!Number.isFinite(value) || value < 1 || value > MAX_INTERVAL_HOURS) {
      setError(t("security.monitor.intervalInvalid", { max: MAX_INTERVAL_HOURS }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/security/monitor/config", {
        method: "PUT",
        body: JSON.stringify({ intervalMs: Math.round(value * 3_600_000) }),
      });
      await refresh();
    } catch (err) {
      setError(apiErrorText(err, "security.monitor.saveError"));
    } finally {
      setBusy(false);
    }
  }

  const diff = state?.lastResult?.diff ?? null;
  const hasChanges =
    diff !== null &&
    (diff.newPackages.length > 0 ||
      diff.removedPackages.length > 0 ||
      diff.newPorts.length > 0 ||
      diff.closedPorts.length > 0 ||
      diff.changedFiles.length > 0 ||
      diff.removedFiles.length > 0 ||
      diff.addedFiles.length > 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4" /> {t("security.monitor.title")}
          </CardTitle>
          {state && (
            <Badge variant={state.schedulerRunning ? "success" : "secondary"}>
              {t(state.schedulerRunning ? "security.monitor.schedulerOn" : "security.monitor.schedulerOff")}
            </Badge>
          )}
        </div>
        <CardDescription>{t("security.monitor.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!state ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {t("security.monitor.loading")}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">{t("security.monitor.interval")}</span>
              <Input
                type="number"
                min={1}
                max={MAX_INTERVAL_HOURS}
                aria-label={t("security.monitor.intervalAria")}
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                className="h-8 w-20"
              />
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void saveInterval()}>
                {t("security.monitor.save")}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void runNow()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                {t("security.monitor.runNow")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {state.lastResult
                ? t("security.monitor.lastRunDetail", {
                    date: fmtDate(state.lastRunAt),
                    ms: state.lastResult.durationMs,
                    count: state.lastResult.alertsCreated,
                  })
                : t("security.monitor.lastRun", { date: fmtDate(state.lastRunAt) })}
            </p>
            {state.lastResult?.note && <p className="text-xs text-amber-400">{state.lastResult.note}</p>}
            {diff && !hasChanges && (
              <p className="flex items-center gap-1.5 text-sm text-emerald-400">
                <ShieldCheck className="h-4 w-4" /> {t("security.monitor.noDiff")}
              </p>
            )}
            {diff && hasChanges && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 font-mono text-xs leading-relaxed">
                {diff.newPorts.map((p) => (
                  <p key={`np-${p.proto}-${p.port}`} className="text-red-400">
                    {t("security.monitor.diff.newPort", { proto: p.proto, port: p.port })}
                    {p.process ? ` (${p.process})` : ""}
                  </p>
                ))}
                {diff.closedPorts.map((p) => (
                  <p key={`cp-${p.proto}-${p.port}`} className="text-amber-300">
                    {t("security.monitor.diff.closedPort", { proto: p.proto, port: p.port })}
                  </p>
                ))}
                {diff.newPackages.map((p) => (
                  <p key={`npkg-${p}`} className="text-amber-300">
                    {t("security.monitor.diff.newPackage", { name: p })}
                  </p>
                ))}
                {diff.removedPackages.map((p) => (
                  <p key={`rpkg-${p}`} className="text-amber-300">
                    {t("security.monitor.diff.removedPackage", { name: p })}
                  </p>
                ))}
                {diff.changedFiles.map((f) => (
                  <p key={`cf-${f}`} className="text-red-400">
                    {t("security.monitor.diff.changedFile", { file: f })}
                  </p>
                ))}
                {diff.removedFiles.map((f) => (
                  <p key={`rf-${f}`} className="text-red-400">
                    {t("security.monitor.diff.removedFile", { file: f })}
                  </p>
                ))}
                {diff.addedFiles.map((f) => (
                  <p key={`af-${f}`} className="text-amber-300">
                    {t("security.monitor.diff.addedFile", { file: f })}
                  </p>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Card 4: Blacklist de e-mail (DNSBL). */
function BlacklistCard() {
  const { t } = useI18n();
  const [data, setData] = useState<BlacklistCheckResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function check() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<BlacklistCheckResponse>("/api/mail/blacklist");
      setData(res);
    } catch (err) {
      setError(apiErrorText(err, "security.blacklist.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <MailWarning className="h-4 w-4" /> {t("security.blacklist.title")}
        </CardTitle>
        <CardDescription>
          {t("security.blacklist.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {data && (
          <div className="flex flex-col gap-2 text-sm">
            {[data.ip, ...data.domains].map(
              (target) =>
                target && (
                  <div key={target.target} className="flex flex-col gap-1">
                    <span className="font-mono text-xs text-muted-foreground">{target.target}</span>
                    <div className="flex flex-wrap gap-1.5">
                      {target.results.map((r) => (
                        <Badge
                          key={r.dnsbl}
                          variant={r.status === "listed" ? "destructive" : r.status === "clean" ? "success" : "warning"}
                          title={r.detail ?? undefined}
                        >
                          {t("security.blacklist.status", {
                            label: r.label,
                            status: t(
                              r.status === "listed"
                                ? "security.blacklist.listed"
                                : r.status === "clean"
                                  ? "security.blacklist.clean"
                                  : "security.blacklist.unknown",
                            ),
                          })}
                        </Badge>
                      ))}
                    </div>
                    {target.results.some((r) => r.status === "listed" && r.removalUrl) && (
                      <p className="text-xs text-muted-foreground">
                        {t("security.blacklist.removal")}{" "}
                        {target.results
                          .filter((r) => r.status === "listed" && r.removalUrl)
                          .map((r) => (
                            <a key={r.dnsbl} href={r.removalUrl ?? "#"} target="_blank" rel="noreferrer" className="underline">
                              {r.label}
                            </a>
                          ))}
                      </p>
                    )}
                  </div>
                ),
            )}
            <p className="text-xs text-muted-foreground">{t("security.blacklist.checkedAt", { date: fmtDate(data.checkedAt) })}</p>
          </div>
        )}
        <div>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void check()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {t("security.blacklist.check")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function SecurityPage() {
  const { t } = useI18n();
  // atualizar o baseline re-executa o card de monitoramento (diff muda)
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("security.page.title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("security.page.subtitle")}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <HardeningCard />
        <BaselineCard onUpdated={() => setRefreshKey((k) => k + 1)} />
      </div>
      <MonitorCard refreshKey={refreshKey} />
      <BlacklistCard />
    </div>
  );
}
