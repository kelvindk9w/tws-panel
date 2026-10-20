import { useCallback, useEffect, useState } from "react";
import type { AuditListResponse } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, formatDateTime, useI18n } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronLeft, ChevronRight, Loader2, ScrollText } from "lucide-react";

const PER_PAGE = 30;

export function AuditPage() {
  const { t } = useI18n();
  const [data, setData] = useState<AuditListResponse | null>(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch<AuditListResponse>(`/api/audit?page=${page}&perPage=${PER_PAGE}`);
      setData(res);
      setError(null);
    } catch (err) {
      setError(apiErrorText(err, "monitoring.audit.error.load"));
    }
  }, [page]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PER_PAGE)) : 1;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <ScrollText className="h-6 w-6" /> {t("monitoring.audit.title")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("monitoring.audit.subtitle")}
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{t("monitoring.audit.card.title")}</CardTitle>
            {data && <CardDescription>{t("monitoring.audit.total", { n: data.total })}</CardDescription>}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {!data ? (
            <p className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> {t("monitoring.audit.loading")}
            </p>
          ) : data.entries.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">{t("monitoring.audit.empty")}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">{t("monitoring.audit.col.when")}</th>
                  <th className="px-4 py-2 font-medium">{t("monitoring.audit.col.action")}</th>
                  <th className="px-4 py-2 font-medium">{t("monitoring.audit.col.target")}</th>
                  <th className="px-4 py-2 font-medium">{t("monitoring.audit.col.detail")}</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((entry) => (
                  <tr key={entry.id} className="border-b last:border-0">
                    <td className="whitespace-nowrap px-4 py-2 text-xs text-muted-foreground">
                      {formatDateTime(entry.at)}
                    </td>
                    <td className="px-4 py-2">
                      <Badge variant="secondary">{entry.action}</Badge>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{entry.target ?? "—"}</td>
                    <td className="max-w-md px-4 py-2">
                      <span className="block truncate text-xs text-muted-foreground" title={entry.detail}>
                        {entry.detail.split("\n")[0]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {data && data.total > PER_PAGE && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft className="h-4 w-4" /> {t("monitoring.audit.prev")}
          </Button>
          <span className="text-muted-foreground">
            {t("monitoring.audit.pageOf", { page, total: totalPages })}
          </span>
          <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            {t("monitoring.audit.next")} <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
