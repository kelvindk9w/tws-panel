import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { MailRate, MailVolumeDay, MailVolumeResponse } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, t, useI18n, type Key } from "@/i18n";
import { dayLabel, formatPercent } from "@/lib/envios";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Cores por ESTADO (cores de status, com rótulo na legenda e na tabela —
 * nunca só a cor): entregue verde, adiada âmbar, recusada vermelha,
 * cancelada cinza.
 */
const SERIES = [
  { key: "delivered", label: "envios.volume.series.delivered", color: "bg-emerald-500" },
  { key: "deferred", label: "envios.volume.series.deferred", color: "bg-amber-500" },
  { key: "bounced", label: "envios.volume.series.bounced", color: "bg-red-500" },
  { key: "cancelled", label: "envios.volume.series.cancelled", color: "bg-slate-400" },
] as const satisfies readonly { key: string; label: Key; color: string }[];

const COUNT_KEYS: Record<(typeof SERIES)[number]["key"], { one: Key; many: Key }> = {
  delivered: { one: "envios.volume.count.delivered.one", many: "envios.volume.count.delivered.many" },
  deferred: { one: "envios.volume.count.deferred.one", many: "envios.volume.count.deferred.many" },
  bounced: { one: "envios.volume.count.bounced.one", many: "envios.volume.count.bounced.many" },
  cancelled: { one: "envios.volume.count.cancelled.one", many: "envios.volume.count.cancelled.many" },
};

function count(kind: keyof typeof COUNT_KEYS, n: number): string {
  return t(n === 1 ? COUNT_KEYS[kind].one : COUNT_KEYS[kind].many, { n });
}

function dayText(d: MailVolumeDay): string {
  const parts = [count("delivered", d.delivered), count("bounced", d.bounced), count("deferred", d.deferred)];
  if (d.cancelled > 0) parts.push(count("cancelled", d.cancelled));
  return t("envios.volume.dayText", { day: dayLabel(d.date), parts: parts.join(", ") });
}

/** Barras empilhadas por dia, em HTML puro (sem biblioteca de gráfico). */
function VolumeChart({ days }: { days: MailVolumeDay[] }) {
  const { t } = useI18n();
  const total = (d: MailVolumeDay) => d.delivered + d.deferred + d.bounced + d.cancelled;
  const max = Math.max(1, ...days.map(total));
  const [hover, setHover] = useState<number | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label={t("envios.volume.legend")}>
        {SERIES.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span className={cn("inline-block h-2.5 w-2.5 rounded-sm", s.color)} aria-hidden />
            {t(s.label)}
          </li>
        ))}
      </ul>
      <div className="relative">
        <p className="min-h-4 text-xs text-muted-foreground" aria-live="polite">
          {hover !== null ? dayText(days[hover]!) : t("envios.volume.hoverHint")}
        </p>
        <div role="img" aria-label={t("envios.volume.chartLabel", { days: days.length })} className="flex h-40 items-end gap-1 border-b border-border/60 pt-2">
          {days.map((d, i) => {
            const sum = total(d);
            return (
              <div
                key={d.date}
                data-testid="volume-bar"
                aria-label={dayText(d)}
                title={dayText(d)}
                tabIndex={0}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                onClick={() => setHover(i)}
                className={cn(
                  "flex h-full min-w-0 flex-1 cursor-default flex-col-reverse justify-start gap-[2px] rounded-t outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  hover === i && "bg-accent/40",
                )}
              >
                {SERIES.map((s) => {
                  const v = d[s.key];
                  if (v === 0) return null;
                  return <div key={s.key} className={cn("w-full first:rounded-b-none last:rounded-t", s.color)} style={{ height: `${(v / max) * 100}%` }} />;
                })}
                {sum === 0 && <div className="h-px w-full bg-border" />}
              </div>
            );
          })}
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-muted-foreground" aria-hidden>
          <span>{dayLabel(days[0]!.date)}</span>
          <span>{dayLabel(days[Math.floor(days.length / 2)]!.date)}</span>
          <span>{dayLabel(days.at(-1)!.date)}</span>
        </div>
      </div>
    </div>
  );
}

function RateTile({ id, title, rate, limitText }: { id: string; title: string; rate: MailRate; limitText: string }) {
  const { t } = useI18n();
  return (
    <div data-testid={id} className={cn("flex flex-col gap-1 rounded-lg border p-3", rate.high && "border-red-500/40 bg-red-500/5")}>
      <span className="text-xs text-muted-foreground">{title}</span>
      <span className="text-2xl font-semibold tabular-nums">{rate.value === null ? "—" : formatPercent(rate.value)}</span>
      <span className="text-xs text-muted-foreground">{t("envios.volume.tile.healthy", { limit: limitText })}</span>
      {rate.high && (
        <span className="flex items-center gap-1 text-xs text-red-400">
          <AlertTriangle className="h-3.5 w-3.5" /> {t("envios.volume.tile.warning", { limit: limitText })}
        </span>
      )}
    </div>
  );
}

/** Volume: envios por dia e por projeto nos últimos 14 dias, e as taxas. */
export function VolumeSection() {
  const { t } = useI18n();
  const [data, setData] = useState<MailVolumeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [table, setTable] = useState(false);

  useEffect(() => {
    const tz = new Date().getTimezoneOffset();
    apiFetch<MailVolumeResponse>(`/api/mail/envios/volume?tz=${tz}`)
      .then(setData)
      .catch((err: unknown) => setError(apiErrorText(err, "envios.volume.error.load")));
  }, []);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{t("envios.volume.title")}</CardTitle>
        <CardDescription>{t("envios.volume.desc")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <p className="text-sm text-destructive">{error}</p>}
        {data && (
          <>
            <VolumeChart days={data.days} />
            <div>
              <Button size="sm" variant="outline" onClick={() => setTable((v) => !v)}>
                {table ? t("envios.volume.table.hide") : t("envios.volume.table.show")}
              </Button>
            </div>
            {table && (
              <table className="w-full table-fixed text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="py-1 font-medium">{t("envios.volume.table.day")}</th>
                    <th className="py-1 font-medium">{t("envios.volume.series.delivered")}</th>
                    <th className="py-1 font-medium">{t("envios.volume.series.deferred")}</th>
                    <th className="py-1 font-medium">{t("envios.volume.series.bounced")}</th>
                    <th className="py-1 font-medium">{t("envios.volume.series.cancelled")}</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {data.days.map((d) => (
                    <tr key={d.date} className="border-t">
                      <td className="py-1">{dayLabel(d.date)}</td>
                      <td className="py-1">{d.delivered}</td>
                      <td className="py-1">{d.deferred}</td>
                      <td className="py-1">{d.bounced}</td>
                      <td className="py-1">{d.cancelled}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <RateTile id="rate-bounce" title={t("envios.volume.rate.bounce")} rate={data.bounceRate} limitText="2%" />
              <RateTile id="rate-defer" title={t("envios.volume.rate.defer")} rate={data.deferRate} limitText="5%" />
              <div className="flex flex-col gap-1 rounded-lg border p-3">
                <span className="text-xs text-muted-foreground">{t("envios.volume.complaints.title")}</span>
                <span className="text-2xl font-semibold">—</span>
                <span className="text-xs text-muted-foreground">
                  {t("envios.volume.complaints.note")}
                </span>
              </div>
            </div>
            {data.lowVolume && (
              <p className="text-xs text-muted-foreground">
                {t("envios.volume.lowVolume")}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {t("envios.volume.limitsNote")}
            </p>
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-medium">{t("envios.volume.byProject")}</h3>
              {data.byProject.length === 0 && <p className="text-xs text-muted-foreground">{t("envios.volume.byProject.empty")}</p>}
              <ul className="flex flex-col gap-1">
                {data.byProject.map((p) => (
                  <li key={p.projectId ?? "none"} data-testid={`project-${p.projectId ?? "none"}`} className="flex flex-wrap justify-between gap-2 rounded-md border px-3 py-2 text-xs">
                    <span className="font-medium">{p.name}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {count("delivered", p.delivered)} · {count("deferred", p.deferred)} · {count("bounced", p.bounced)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
