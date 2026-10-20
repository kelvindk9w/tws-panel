import { useCallback, useEffect, useState } from "react";
import type { Alert, AlertListResponse, AlertResponse } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, formatDateTime, useI18n, type Key } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BellRing, Check, CheckCheck, Loader2 } from "lucide-react";

const SEVERITY_LABELS: Record<Alert["severity"], Key> = {
  critical: "monitoring.alerts.severity.critical",
  warning: "monitoring.alerts.severity.warning",
  info: "monitoring.alerts.severity.info",
};

const SOURCE_LABELS: Record<Alert["source"], Key> = {
  guardrail: "monitoring.alerts.source.guardrail",
  scan: "monitoring.alerts.source.scan",
  blacklist: "monitoring.alerts.source.blacklist",
  certificate: "monitoring.alerts.source.certificate",
};

const STATUS_LABELS: Record<Alert["status"], Key> = {
  open: "monitoring.alerts.status.open",
  acknowledged: "monitoring.alerts.status.acknowledged",
  resolved: "monitoring.alerts.status.resolved",
};

function SeverityBadge({ severity }: { severity: Alert["severity"] }) {
  const { t } = useI18n();
  const variant = severity === "critical" ? "destructive" : severity === "warning" ? "warning" : "secondary";
  return <Badge variant={variant}>{t(SEVERITY_LABELS[severity])}</Badge>;
}

function StatusBadge({ status }: { status: Alert["status"] }) {
  const { t } = useI18n();
  const variant = status === "open" ? "destructive" : status === "acknowledged" ? "warning" : "success";
  return <Badge variant={variant}>{t(STATUS_LABELS[status])}</Badge>;
}

export function AlertsPage() {
  const { t } = useI18n();
  const [data, setData] = useState<AlertListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [severity, setSeverity] = useState("");
  const [source, setSource] = useState("");

  const refresh = useCallback(async () => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (severity) params.set("severity", severity);
    if (source) params.set("source", source);
    try {
      const res = await apiFetch<AlertListResponse>(`/api/alerts?${params.toString()}`);
      setData(res);
      setError(null);
    } catch (err) {
      setError(apiErrorText(err, "monitoring.alerts.error.load"));
    }
  }, [status, severity, source]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function transition(id: string, action: "ack" | "resolve") {
    setBusyId(id);
    try {
      await apiFetch<AlertResponse>(`/api/alerts/${id}/${action}`, { method: "POST" });
      await refresh();
    } catch (err) {
      setError(apiErrorText(err, "monitoring.alerts.error.update"));
    } finally {
      setBusyId(null);
    }
  }

  const selectClass = "h-9 rounded-md border border-input bg-transparent px-3 text-sm";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <BellRing className="h-6 w-6" /> {t("monitoring.alerts.title")}
          {data && data.openCount > 0 && <Badge variant="destructive">{t("monitoring.alerts.openCount", { n: data.openCount })}</Badge>}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("monitoring.alerts.subtitle")}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectClass}>
          <option value="" className="bg-background">{t("monitoring.alerts.filter.allStatus")}</option>
          <option value="open" className="bg-background">{t(STATUS_LABELS.open)}</option>
          <option value="acknowledged" className="bg-background">{t(STATUS_LABELS.acknowledged)}</option>
          <option value="resolved" className="bg-background">{t(STATUS_LABELS.resolved)}</option>
        </select>
        <select value={severity} onChange={(e) => setSeverity(e.target.value)} className={selectClass}>
          <option value="" className="bg-background">{t("monitoring.alerts.filter.allSeverity")}</option>
          <option value="critical" className="bg-background">{t(SEVERITY_LABELS.critical)}</option>
          <option value="warning" className="bg-background">{t(SEVERITY_LABELS.warning)}</option>
          <option value="info" className="bg-background">{t(SEVERITY_LABELS.info)}</option>
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)} className={selectClass}>
          <option value="" className="bg-background">{t("monitoring.alerts.filter.allSource")}</option>
          <option value="guardrail" className="bg-background">{t(SOURCE_LABELS.guardrail)}</option>
          <option value="scan" className="bg-background">{t(SOURCE_LABELS.scan)}</option>
          <option value="blacklist" className="bg-background">{t(SOURCE_LABELS.blacklist)}</option>
          <option value="certificate" className="bg-background">{t(SOURCE_LABELS.certificate)}</option>
        </select>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {!data ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t("monitoring.alerts.loading")}
        </p>
      ) : data.alerts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("monitoring.alerts.empty")}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {data.alerts.map((alert) => (
            <Card key={alert.id} className={alert.status === "open" ? "border-red-500/30" : undefined}>
              <CardContent className="flex flex-col gap-2 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <SeverityBadge severity={alert.severity} />
                    <Badge variant="outline">{t(SOURCE_LABELS[alert.source])}</Badge>
                    <StatusBadge status={alert.status} />
                    <span className="font-medium">{alert.title}</span>
                  </div>
                  <div className="flex gap-2">
                    {alert.status === "open" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === alert.id}
                        onClick={() => void transition(alert.id, "ack")}
                      >
                        {busyId === alert.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                        {t("monitoring.alerts.ack")}
                      </Button>
                    )}
                    {alert.status !== "resolved" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === alert.id}
                        onClick={() => void transition(alert.id, "resolve")}
                      >
                        {busyId === alert.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCheck className="h-4 w-4" />}
                        {t("monitoring.alerts.resolve")}
                      </Button>
                    )}
                  </div>
                </div>
                <pre className="whitespace-pre-wrap rounded-lg border bg-black/40 p-3 font-mono text-xs text-muted-foreground">
                  {alert.detail}
                </pre>
                <p className="text-xs text-muted-foreground">
                  {t("monitoring.alerts.createdAt", { date: formatDateTime(alert.createdAt) })}
                  {alert.acknowledgedAt ? t("monitoring.alerts.acknowledgedAt", { date: formatDateTime(alert.acknowledgedAt) }) : ""}
                  {alert.resolvedAt ? t("monitoring.alerts.resolvedAt", { date: formatDateTime(alert.resolvedAt) }) : ""}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
