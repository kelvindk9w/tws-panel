import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { Activity, Loader2 } from "lucide-react";
import { validateMetricsRetention, type MetricsRetention, type MetricsSettingsResponse } from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { formatBytes } from "@/lib/metrics";
import { formatDateTime, useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type Field = keyof MetricsRetention;
const FIELDS: ReadonlyArray<{ key: Field; label: "metrics.settings.retention.minute" | "metrics.settings.retention.hour" | "metrics.settings.retention.day"; help: "metrics.settings.retention.minuteHelp" | "metrics.settings.retention.hourHelp" | "metrics.settings.retention.dayHelp" }> = [
  { key: "minuteHours", label: "metrics.settings.retention.minute", help: "metrics.settings.retention.minuteHelp" },
  { key: "hourDays", label: "metrics.settings.retention.hour", help: "metrics.settings.retention.hourHelp" },
  { key: "dayDays", label: "metrics.settings.retention.day", help: "metrics.settings.retention.dayHelp" },
];

/**
 * Configurações → Recursos da VPS: estado da coleta, espaço usado e a retenção
 * (quanto tempo guardar o dado por minuto, por hora e por dia). Reduzir um prazo
 * apaga o excedente na hora, então pede uma segunda confirmação.
 */
export function MetricsSettings() {
  const { t } = useI18n();
  const base = useId();
  const [info, setInfo] = useState<MetricsSettingsResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState<Record<Field, string>>({ minuteHours: "", hourDays: "", dayDays: "" });
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const apply = (res: MetricsSettingsResponse) => {
    setInfo(res);
    setDraft({ minuteHours: String(res.retention.minuteHours), hourDays: String(res.retention.hourDays), dayDays: String(res.retention.dayDays) });
  };

  const load = useCallback(async () => {
    try {
      apply(await apiFetch<MetricsSettingsResponse>("/api/metrics/settings"));
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const parsed = {
    minuteHours: Number(draft.minuteHours),
    hourDays: Number(draft.hourDays),
    dayDays: Number(draft.dayDays),
  };
  const check = validateMetricsRetention(parsed);
  const dirty = info !== null && FIELDS.some(({ key }) => parsed[key] !== info.retention[key]);
  const shrinks = info !== null && FIELDS.some(({ key }) => parsed[key] < info.retention[key]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!info || !check.ok || !dirty || busy) return;
    if (shrinks && !confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      apply(await apiFetch<MetricsSettingsResponse>("/api/metrics/settings", { method: "PUT", body: JSON.stringify({ retention: check.value }) }));
      setMessage({ tone: "ok", text: t("metrics.settings.retention.saved") });
    } catch (err) {
      const code = err instanceof ApiRequestError ? err.code : "";
      setMessage({ tone: "error", text: code === "retention_order" ? t("metrics.settings.retention.order") : code === "invalid_retention" || code === "invalid_request" ? t("metrics.settings.retention.invalid") : t("metrics.settings.retention.saveError") });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (!info) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4" /> {t("metrics.settings.title")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loadError ? (
            <p role="alert" className="text-sm text-destructive">
              {t("metrics.settings.loadError")}
            </p>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> {t("metrics.settings.loading")}
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  const u = info.usage;
  const total = u.minuteBytes + u.hourBytes + u.dayBytes;
  const mode = info.collector.mode;
  const errorText = !check.ok && dirty ? (check.error === "retention_order" ? t("metrics.settings.retention.order") : t("metrics.settings.retention.invalid")) : null;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4" /> {t("metrics.settings.title")}
          </CardTitle>
          <CardDescription>{t("metrics.settings.desc")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <h3 className="font-medium">{t("metrics.settings.collector.title")}</h3>
          <p data-testid="metrics-collector-state">
            {mode === "full" ? t("metrics.settings.collector.full") : mode === "reduced" ? t("metrics.settings.collector.reduced") : t("metrics.settings.collector.unavailable")}
          </p>
          {info.collector.lastTickAt && <p className="text-xs text-muted-foreground">{t("metrics.settings.collector.lastTick", { date: formatDateTime(info.collector.lastTickAt) })}</p>}
          <h3 className="mt-2 font-medium">{t("metrics.settings.usage.title")}</h3>
          <p data-testid="metrics-usage" className="text-muted-foreground">
            {t("metrics.settings.usage.value", {
              total: formatBytes(total) ?? "0 B",
              minute: formatBytes(u.minuteBytes) ?? "0 B",
              hour: formatBytes(u.hourBytes) ?? "0 B",
              day: formatBytes(u.dayBytes) ?? "0 B",
            })}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("metrics.settings.retention.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void save(e)} className="flex max-w-lg flex-col gap-4 text-sm">
            {FIELDS.map(({ key, label, help }) => {
              const lim = info.limits[key];
              const id = `${base}-${key}`;
              return (
                <div key={key} className="flex flex-col gap-1.5">
                  <label htmlFor={id} className="font-medium">
                    {t(label)}
                  </label>
                  <Input
                    id={id}
                    type="number"
                    inputMode="numeric"
                    min={lim.min}
                    max={lim.max}
                    step={1}
                    value={draft[key]}
                    aria-describedby={`${id}-help`}
                    aria-invalid={draft[key] !== "" && (!Number.isInteger(parsed[key]) || parsed[key] < lim.min || parsed[key] > lim.max)}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, [key]: e.target.value }));
                      setConfirming(false);
                      setMessage(null);
                    }}
                  />
                  <p id={`${id}-help`} className="text-xs text-muted-foreground">
                    {t(help, { min: lim.min, max: lim.max, def: info.defaults[key] })}
                  </p>
                </div>
              );
            })}
            {errorText && (
              <p role="alert" className="text-xs text-destructive">
                {errorText}
              </p>
            )}
            {shrinks && check.ok && (
              <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs" data-testid="metrics-shrink-warning">
                {t("metrics.settings.retention.shrink")}
              </p>
            )}
            {message && (
              <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "text-destructive" : "text-emerald-400"}>
                {message.text}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={!check.ok || !dirty || busy} variant={confirming ? "destructive" : "default"}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {confirming ? t("metrics.settings.retention.confirm") : t("metrics.settings.retention.save")}
              </Button>
              {confirming && (
                <Button type="button" variant="outline" onClick={() => setConfirming(false)}>
                  {t("metrics.settings.retention.cancel")}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setDraft({ minuteHours: String(info.defaults.minuteHours), hourDays: String(info.defaults.hourDays), dayDays: String(info.defaults.dayDays) });
                  setConfirming(false);
                  setMessage(null);
                }}
              >
                {t("metrics.settings.retention.reset")}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
