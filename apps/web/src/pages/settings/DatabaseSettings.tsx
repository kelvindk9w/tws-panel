import { useEffect, useId, useState, type FormEvent } from "react";
import { Database, Loader2 } from "lucide-react";
import { databaseSettingsLoosens, type DatabaseSettings as Settings, type DatabaseSettingsResponse, type DatabaseUnlockDuration, type UpdateDatabaseSettingsRequest } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, useI18n, type Key } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EMPTY_REAUTH, ReauthFields, reauthPayload, type Reauth } from "@/components/settings/ReauthFields";

const DURATION_KEYS = {
  "15m": "database.settings.duration.15m",
  "30m": "database.settings.duration.30m",
  "1h": "database.settings.duration.1h",
  "2h": "database.settings.duration.2h",
  "4h": "database.settings.duration.4h",
  session: "database.settings.duration.session",
} as const satisfies Record<DatabaseUnlockDuration, Key>;

/**
 * Configurações → Banco de dados: quanto tempo dura a liberação da edição do banco e se cada comando renova o prazo.
 * Deixar a liberação mais frouxa (mais longa, ou renovável) pede senha + código; deixar mais rígida, só a sessão.
 */
export function DatabaseSettings() {
  const { t } = useI18n();
  const base = useId();
  const [info, setInfo] = useState<DatabaseSettingsResponse | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [reauth, setReauth] = useState<Reauth>(EMPTY_REAUTH);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    apiFetch<DatabaseSettingsResponse>("/api/settings/database")
      .then((res) => {
        setInfo(res);
        setDraft(res.settings);
      })
      .catch((err: unknown) => setLoadError(apiErrorText(err, "database.settings.loadError")));
  }, []);

  if (!info || !draft) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="h-4 w-4" /> {t("database.settings.title")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loadError ? (
            <p role="alert" className="text-sm text-destructive">
              {loadError}
            </p>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> {t("database.settings.loading")}
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  const dirty = draft.unlockDuration !== info.settings.unlockDuration || draft.renewOnUse !== info.settings.renewOnUse;
  const loosens = databaseSettingsLoosens(info.settings, draft);
  const canSave = dirty && !busy && (!loosens || (reauth.password.length > 0 && reauth.code.trim().length > 0));

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setMessage(null);
    try {
      const body: UpdateDatabaseSettingsRequest = { ...draft!, ...(loosens ? reauthPayload(reauth) : {}) };
      const res = await apiFetch<DatabaseSettingsResponse>("/api/settings/database", { method: "PUT", body: JSON.stringify(body) });
      setInfo(res);
      setDraft(res.settings);
      setReauth(EMPTY_REAUTH);
      setMessage({ tone: "ok", text: t("database.settings.saved") });
    } catch (err) {
      setMessage({ tone: "error", text: apiErrorText(err, "database.settings.saveError") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card data-testid="database-settings">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Database className="h-4 w-4" /> {t("database.settings.title")}
        </CardTitle>
        <CardDescription>{t("database.settings.desc")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void save(e)} className="flex max-w-lg flex-col gap-4 text-sm">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${base}-duration`} className="font-medium">
              {t("database.settings.duration.label")}
            </label>
            <select
              id={`${base}-duration`}
              value={draft.unlockDuration}
              onChange={(e) => {
                setDraft({ ...draft, unlockDuration: e.target.value as DatabaseUnlockDuration });
                setMessage(null);
              }}
              className="h-9 rounded-md border bg-background px-2"
            >
              {info.durations.map((d) => (
                <option key={d} value={d}>
                  {t(DURATION_KEYS[d])}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{t("database.settings.duration.hint")}</p>
          </div>
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2 font-medium">
              <input
                type="checkbox"
                checked={draft.renewOnUse}
                onChange={(e) => {
                  setDraft({ ...draft, renewOnUse: e.target.checked });
                  setMessage(null);
                }}
                className="h-4 w-4"
              />
              {t("database.settings.renew.label")}
            </label>
            <p className="text-xs text-muted-foreground">{t("database.settings.renew.desc")}</p>
          </div>
          {loosens && (
            <div className="flex flex-col gap-3 rounded-md border p-3" data-testid="database-settings-reauth">
              <p className="text-xs text-muted-foreground">{t("database.settings.loosens")}</p>
              <ReauthFields idPrefix="dbset" action="database.write" value={reauth} onChange={setReauth} />
            </div>
          )}
          {message && (
            <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "text-destructive" : "text-emerald-400"}>
              {message.text}
            </p>
          )}
          <div>
            <Button type="submit" disabled={!canSave}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("database.settings.save")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
