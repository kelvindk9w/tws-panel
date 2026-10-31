import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import type { MailRefusalItem, MailRefusalsResponse } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { useAutoRefresh, type RefreshPhase } from "@/lib/auto-refresh";
import { refusalText } from "@/lib/mail-diagnosis";
import { formatDateTime, useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const LIMIT = 50;
/** Leitura tranquila: o registro só é relido pelo servidor de tempos em tempos. */
const WATCH: readonly RefreshPhase[] = [{ untilMs: Infinity, everyMs: 60_000 }];

/**
 * "Tentativas recusadas": conexões que o servidor de e-mail recusou antes da fila.
 * Com projectId, só as deste projeto; sem, as da rede interna (apps e painel). `external`: as que vieram da internet
 * (robôs tentando senha), numa lista à parte que não acusa o app de nada.
 */
export function RefusalsSection({ projectId, external = false }: { projectId?: string; external?: boolean }) {
  const { t } = useI18n();
  const [data, setData] = useState<MailRefusalsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(
    async (quiet: boolean) => {
      const mine = ++seq.current;
      if (!quiet) {
        setLoading(true);
        setError(false);
      }
      const url = projectId
        ? `/api/projects/${encodeURIComponent(projectId)}/email/recusas?limit=${LIMIT}`
        : `/api/mail/envios/recusas?${external ? "scope=external&" : ""}limit=${LIMIT}`;
      try {
        const res = await apiFetch<MailRefusalsResponse>(url);
        if (mine !== seq.current) return;
        setData(res);
        setError(false);
      } catch {
        if (mine !== seq.current) return;
        if (!quiet) {
          setError(true);
          setData(null);
        }
      } finally {
        if (!quiet && mine === seq.current) setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  useAutoRefresh(true, () => load(true), WATCH);

  const items = data?.items ?? [];

  return (
    <Card data-testid={external ? "refusals-external" : "refusals-section"}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">
            {projectId ? t("diagnostico.refusal.titleProject") : external ? t("diagnostico.refusal.titleExternal") : t("diagnostico.refusal.title")}
          </CardTitle>
          <Button size="sm" variant="outline" disabled={loading} onClick={() => void load(false)}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {t("diagnostico.refusal.refresh")}
          </Button>
        </div>
        <CardDescription>{external ? t("diagnostico.refusal.descExternal") : t("diagnostico.refusal.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {loading && !data && <p className="text-sm text-muted-foreground">{t("diagnostico.refusal.loading")}</p>}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {t("diagnostico.refusal.error")}
          </p>
        )}
        {data && items.length === 0 && (
          <p data-testid="refusals-empty" className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
            {t("diagnostico.refusal.empty.none", { days: data.retentionDays })}
            {!data.serverCreated && <> {t("diagnostico.refusal.empty.noServer")}</>}
          </p>
        )}
        {items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">{t("diagnostico.refusal.col.when")}</th>
                  <th className="py-1 pr-3 font-medium">{t("diagnostico.refusal.col.reason")}</th>
                  <th className="py-1 pr-3 font-medium">{t("diagnostico.refusal.col.login")}</th>
                  {!projectId && <th className="py-1 font-medium">{t("diagnostico.refusal.col.project")}</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((r, i) => {
                  const text = refusalText(r.kind);
                  const key = `${r.at}-${i}`;
                  const expanded = open === key;
                  const detailsId = `refusal-details-${i}`;
                  const columns = projectId ? 3 : 4;
                  return (
                    <Fragment key={key}>
                      <tr className="border-t align-top" data-kind={r.kind}>
                        <td className="whitespace-nowrap py-1.5 pr-3">
                          <button
                            type="button"
                            data-testid={`refusal-toggle-${i}`}
                            aria-expanded={expanded}
                            aria-controls={detailsId}
                            aria-label={t(expanded ? "diagnostico.refusal.details.hide" : "diagnostico.refusal.details.show", { date: formatDateTime(r.at) })}
                            onClick={() => setOpen(expanded ? null : key)}
                            className="inline-flex items-center gap-1 rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          >
                            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            {formatDateTime(r.at)}
                          </button>
                        </td>
                        <td className="py-1.5 pr-3">
                          <span className="font-medium">{text?.title ?? r.kind}</span>
                          {text && <span className="block text-xs text-muted-foreground">{text.hint}</span>}
                        </td>
                        <td className="break-all py-1.5 pr-3 font-mono text-xs">{r.login ?? t("diagnostico.refusal.unknownLogin")}</td>
                        {!projectId && <td className="py-1.5">{r.projectName ?? t("diagnostico.refusal.noProject")}</td>}
                      </tr>
                      {expanded && (
                        <tr id={detailsId} data-testid={`refusal-details-${i}`}>
                          <td colSpan={columns} className="pb-2 pr-3">
                            <RefusalDetails item={r} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {data && items.length > 0 && (
          <p className="text-xs text-muted-foreground">{t("diagnostico.refusal.shown", { shown: items.length, total: data.total })}</p>
        )}
        {data?.collectedAt && <p className="text-xs text-muted-foreground">{t("diagnostico.refusal.collected", { date: formatDateTime(data.collectedAt) })}</p>}
      </CardContent>
    </Card>
  );
}

const ORIGIN_KEYS = {
  internal: "diagnostico.refusal.details.origin.internal",
  external: "diagnostico.refusal.details.origin.external",
  unknown: "diagnostico.refusal.details.origin.unknown",
} as const;

/** Detalhes de uma tentativa recusada: tudo o que o painel guarda dela (nunca endereço IP, senha nem texto do cliente). */
function RefusalDetails({ item }: { item: MailRefusalItem }) {
  const { t } = useI18n();
  const text = refusalText(item.kind);
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 rounded-md bg-muted/40 p-2 text-xs sm:grid-cols-2">
      <div className="flex gap-1">
        <dt className="text-muted-foreground">{t("diagnostico.refusal.col.when")}:</dt>
        <dd>{formatDateTime(item.at)}</dd>
      </div>
      <div className="flex gap-1">
        <dt className="text-muted-foreground">{t("diagnostico.refusal.col.reason")}:</dt>
        <dd>{text?.title ?? item.kind}</dd>
      </div>
      <div className="flex min-w-0 gap-1 sm:col-span-2">
        <dt className="text-muted-foreground">{t("diagnostico.refusal.details.whatToDo")}:</dt>
        <dd>{text?.hint ?? t("diagnostico.refusal.details.noHint")}</dd>
      </div>
      <div className="flex min-w-0 gap-1">
        <dt className="text-muted-foreground">{t("diagnostico.refusal.col.login")}:</dt>
        <dd className="break-all font-mono">{item.login ?? t("diagnostico.refusal.unknownLogin")}</dd>
      </div>
      <div className="flex gap-1">
        <dt className="text-muted-foreground">{t("diagnostico.refusal.col.project")}:</dt>
        <dd>{item.projectName ?? t("diagnostico.refusal.noProject")}</dd>
      </div>
      <div className="flex gap-1">
        <dt className="text-muted-foreground">{t("diagnostico.refusal.details.origin")}:</dt>
        <dd>{t(ORIGIN_KEYS[item.origin] ?? ORIGIN_KEYS.unknown)}</dd>
      </div>
      <div className="flex gap-1">
        <dt className="text-muted-foreground">{t("diagnostico.refusal.details.listener")}:</dt>
        <dd className="font-mono">{item.listener ?? t("diagnostico.refusal.details.listenerUnknown")}</dd>
      </div>
      <p className="text-muted-foreground sm:col-span-2">{t("diagnostico.refusal.details.noDelivery")}</p>
    </dl>
  );
}
