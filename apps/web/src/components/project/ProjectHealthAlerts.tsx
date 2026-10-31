import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { Alert, AlertListResponse } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { formatDateTime, useI18n, type Key } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle } from "lucide-react";

/**
 * Alertas abertos deste projeto (container que não passa na saúde, serviço parado, reinício em laço), cada
 * um com o detalhe que o e-mail não leva: qual serviço, qual verificação falhou, estado/código de saída e
 * desde quando. O e-mail só aponta para Alertas; aqui o motivo já aparece ao abrir o item.
 */
export function ProjectHealthAlerts({ slug, refreshKey }: { slug: string; refreshKey: string }) {
  const { t } = useI18n();
  const [alerts, setAlerts] = useState<Alert[]>([]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<AlertListResponse>(`/api/alerts?project=${encodeURIComponent(slug)}&status=open&perPage=20`)
      .then((r) => !cancelled && setAlerts(r.alerts ?? []))
      .catch(() => !cancelled && setAlerts([]));
    return () => {
      cancelled = true;
    };
  }, [slug, refreshKey]);

  if (alerts.length === 0) return null;
  return (
    <Card data-testid="overview-alerts" className="border-amber-500/40">
      <CardContent className="flex flex-col gap-2 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <AlertTriangle className="h-4 w-4 text-amber-300" /> {t("projects.overview.alerts.title")}
          </span>
          <Link to={`/alerts?project=${encodeURIComponent(slug)}`} className="text-xs text-sky-400 hover:underline">
            {t("projects.overview.alerts.all")}
          </Link>
        </div>
        {alerts.map((a) => (
          <details key={a.id} className="rounded-lg border p-2 text-sm" data-testid={`overview-alert-${a.id}`}>
            <summary className="flex cursor-pointer flex-wrap items-center gap-2">
              <Badge variant={a.severity === "critical" ? "destructive" : "warning"}>{t(`monitoring.alerts.severity.${a.severity}` as Key)}</Badge>
              <span className="font-medium">{a.title}</span>
              <span className="text-xs text-muted-foreground">{t("projects.overview.alerts.since", { date: formatDateTime(a.createdAt) })}</span>
            </summary>
            <pre className="mt-2 whitespace-pre-wrap rounded-lg border bg-black/40 p-3 font-mono text-xs text-muted-foreground">{a.detail}</pre>
          </details>
        ))}
      </CardContent>
    </Card>
  );
}
