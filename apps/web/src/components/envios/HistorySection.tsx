import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { MailDeliveryState, MailHistoryResponse } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, useI18n } from "@/i18n";
import { formatDateTime, HISTORY_STATE_KEYS, rejectionHint, senderLabel, stateVariant } from "@/lib/envios";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const PAGE = 100;
const selectClass =
  "h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

interface Filters {
  days: string;
  state: "" | MailDeliveryState;
  projectId: string;
  mailbox: string;
  domain: string;
  q: string;
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

/** Histórico: entregues, recusadas e adiadas, com o motivo devolvido pelo destino. */
export function HistorySection() {
  const { t } = useI18n();
  const [filters, setFilters] = useState<Filters>({ days: "7", state: "", projectId: "", mailbox: "", domain: "", q: "" });
  const [search, setSearch] = useState("");
  const [data, setData] = useState<MailHistoryResponse | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const first = useRef(true);

  // Busca digitada: espera a pessoa parar de digitar.
  useEffect(() => {
    const timer = setTimeout(() => setFilters((f) => (f.q === search ? f : { ...f, q: search })), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    const qs = new URLSearchParams({ days: filters.days, limit: String(limit) });
    for (const key of ["state", "projectId", "mailbox", "domain", "q"] as const) {
      if (filters[key]) qs.set(key, filters[key]);
    }
    // Na primeira vez e no "Atualizar", o servidor lê o registro antes.
    if (first.current || reloadKey > 0) qs.set("refresh", "1");
    first.current = false;
    setLoading(true);
    setError(null);
    apiFetch<MailHistoryResponse>(`/api/mail/envios/history?${qs.toString()}`)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(apiErrorText(err, "envios.history.error.load"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters, limit, reloadKey]);

  const set = (key: keyof Filters) => (e: React.ChangeEvent<HTMLSelectElement>) => {
    setLimit(PAGE);
    setFilters((f) => ({ ...f, [key]: e.target.value }));
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{t("envios.history.title")}</CardTitle>
        <CardDescription>
          {t("envios.history.desc", { days: data?.retentionDays ?? 30 })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Field id="h-days" label={t("envios.history.field.period")}>
            <select id="h-days" className={selectClass} value={filters.days} onChange={set("days")}>
              <option value="1">{t("envios.history.period.1")}</option>
              <option value="7">{t("envios.history.period.7")}</option>
              <option value="14">{t("envios.history.period.14")}</option>
              <option value="30">{t("envios.history.period.30")}</option>
            </select>
          </Field>
          <Field id="h-state" label={t("envios.history.field.state")}>
            <select id="h-state" className={selectClass} value={filters.state} onChange={set("state")}>
              <option value="">{t("envios.history.all")}</option>
              {(Object.keys(HISTORY_STATE_KEYS) as MailDeliveryState[]).map((s) => (
                <option key={s} value={s}>
                  {t(HISTORY_STATE_KEYS[s])}
                </option>
              ))}
            </select>
          </Field>
          <Field id="h-project" label={t("envios.history.field.project")}>
            <select id="h-project" className={selectClass} value={filters.projectId} onChange={set("projectId")}>
              <option value="">{t("envios.history.all")}</option>
              {data?.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value="none">{t("envios.history.noProject")}</option>
            </select>
          </Field>
          <Field id="h-mailbox" label={t("envios.history.field.mailbox")}>
            <select id="h-mailbox" className={selectClass} value={filters.mailbox} onChange={set("mailbox")}>
              <option value="">{t("envios.history.allMailboxes")}</option>
              {data?.mailboxes.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
          <Field id="h-domain" label={t("envios.history.field.domain")}>
            <select id="h-domain" className={selectClass} value={filters.domain} onChange={set("domain")}>
              <option value="">{t("envios.history.all")}</option>
              {data?.domains.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </Field>
          <Field id="h-q" label={t("envios.history.field.search")}>
            <Input id="h-q" value={search} placeholder={t("envios.history.search.placeholder")} maxLength={100} onChange={(e) => setSearch(e.target.value)} />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={loading} onClick={() => setReloadKey((k) => k + 1)}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {t("envios.history.refresh")}
          </Button>
          {data?.collectedAt && <span className="text-xs text-muted-foreground">{t("envios.history.collectedAt", { date: formatDateTime(data.collectedAt) })}</span>}
        </div>
        {data?.collectError && (
          <p className="break-words rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            {t("envios.history.collectError", { error: data.collectError })}
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {data && data.items.length === 0 && <p className="text-sm text-muted-foreground">{t("envios.history.empty")}</p>}
        {data && data.items.length > 0 && (
          <>
            <p className="text-xs text-muted-foreground">
              {t("envios.history.showing", { shown: data.items.length, total: data.total })}
            </p>
            <ul className="flex flex-col gap-2">
              {data.items.map((i, idx) => {
                const hint = i.state === "delivered" ? null : rejectionHint(i.detail);
                return (
                  <li key={`${i.queueId}-${i.to}-${i.at}-${idx}`} data-testid={`history-${i.queueId}-${i.to}`} className="flex flex-col gap-1 rounded-lg border p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={stateVariant(i.state)}>{t(HISTORY_STATE_KEYS[i.state])}</Badge>
                      <span className="break-all font-medium">{i.to}</span>
                      <span className="text-xs text-muted-foreground">{formatDateTime(i.at)}</span>
                    </div>
                    <p className="break-words text-xs text-muted-foreground">{t("envios.sender.from", { sender: senderLabel(i.sender) })}</p>
                    {i.detail && (
                      <p className="break-words text-xs">
                        {i.remoteHost ? t("envios.history.item.replied", { host: i.remoteHost }) : t("envios.history.item.reason")}
                        {i.detail}
                      </p>
                    )}
                    {i.state === "deferred" && i.nextRetryAt && (
                      <p className="text-xs text-muted-foreground">{t("envios.history.item.nextRetry", { date: formatDateTime(i.nextRetryAt) })}</p>
                    )}
                    {hint && <p className="text-xs text-amber-300">{hint}</p>}
                  </li>
                );
              })}
            </ul>
            {data.total > data.items.length && (
              <div>
                <Button size="sm" variant="outline" disabled={loading} onClick={() => setLimit((l) => l + PAGE)}>
                  {t("envios.history.loadMore")}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
