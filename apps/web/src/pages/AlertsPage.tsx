import { useCallback, useEffect, useState } from "react";
import type { Alert, AlertListResponse, AlertResponse } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { BellRing, Check, CheckCheck, Loader2 } from "lucide-react";

const SEVERITY_LABELS: Record<Alert["severity"], string> = {
  critical: "crítico",
  warning: "alerta",
  info: "info",
};

const SOURCE_LABELS: Record<Alert["source"], string> = {
  guardrail: "guardrail",
  scan: "monitoramento",
  blacklist: "blacklist",
  system: "sistema",
};

const STATUS_LABELS: Record<Alert["status"], string> = {
  open: "aberto",
  acknowledged: "reconhecido",
  resolved: "resolvido",
};

function SeverityBadge({ severity }: { severity: Alert["severity"] }) {
  const variant = severity === "critical" ? "destructive" : severity === "warning" ? "warning" : "secondary";
  return <Badge variant={variant}>{SEVERITY_LABELS[severity]}</Badge>;
}

function StatusBadge({ status }: { status: Alert["status"] }) {
  const variant = status === "open" ? "destructive" : status === "acknowledged" ? "warning" : "success";
  return <Badge variant={variant}>{STATUS_LABELS[status]}</Badge>;
}

export function AlertsPage() {
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
      setError(err instanceof Error ? err.message : "Falha ao carregar os alertas.");
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
      setError(err instanceof Error ? err.message : "Falha ao atualizar o alerta.");
    } finally {
      setBusyId(null);
    }
  }

  const selectClass = "h-9 rounded-md border border-input bg-transparent px-3 text-sm";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <BellRing className="h-6 w-6" /> Alertas
          {data && data.openCount > 0 && <Badge variant="destructive">{data.openCount} aberto(s)</Badge>}
        </h1>
        <p className="text-sm text-muted-foreground">
          Guardrails, monitoramento, blacklist e sistema em um só lugar.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectClass}>
          <option value="" className="bg-background">Todos os status</option>
          <option value="open" className="bg-background">aberto</option>
          <option value="acknowledged" className="bg-background">reconhecido</option>
          <option value="resolved" className="bg-background">resolvido</option>
        </select>
        <select value={severity} onChange={(e) => setSeverity(e.target.value)} className={selectClass}>
          <option value="" className="bg-background">Todas as severidades</option>
          <option value="critical" className="bg-background">crítico</option>
          <option value="warning" className="bg-background">alerta</option>
          <option value="info" className="bg-background">info</option>
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)} className={selectClass}>
          <option value="" className="bg-background">Todas as origens</option>
          <option value="guardrail" className="bg-background">guardrail</option>
          <option value="scan" className="bg-background">monitoramento</option>
          <option value="blacklist" className="bg-background">blacklist</option>
          <option value="system" className="bg-background">sistema</option>
        </select>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {!data ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
        </p>
      ) : data.alerts.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum alerta com esses filtros. 🎉</p>
      ) : (
        <div className="flex flex-col gap-3">
          {data.alerts.map((alert) => (
            <Card key={alert.id} className={alert.status === "open" ? "border-red-500/30" : undefined}>
              <CardContent className="flex flex-col gap-2 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <SeverityBadge severity={alert.severity} />
                    <Badge variant="outline">{SOURCE_LABELS[alert.source]}</Badge>
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
                        Reconhecer
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
                        Resolver
                      </Button>
                    )}
                  </div>
                </div>
                <pre className="whitespace-pre-wrap rounded-lg border bg-black/40 p-3 font-mono text-xs text-muted-foreground">
                  {alert.detail}
                </pre>
                <p className="text-xs text-muted-foreground">
                  criado em {new Date(alert.createdAt).toLocaleString("pt-BR")}
                  {alert.acknowledgedAt ? ` · reconhecido em ${new Date(alert.acknowledgedAt).toLocaleString("pt-BR")}` : ""}
                  {alert.resolvedAt ? ` · resolvido em ${new Date(alert.resolvedAt).toLocaleString("pt-BR")}` : ""}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
