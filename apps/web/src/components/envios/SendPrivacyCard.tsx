import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { MAIL_SEND_LIMITS, type MailSendSettings } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, useI18n, type Key } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const SETTINGS_URL = "/api/mail/envios/saidas/settings";

type NumberField = "metadataDays" | "bodyDays" | "maxBodyKiB" | "maxTotalMiB";
const FIELDS: ReadonlyArray<{ key: NumberField; label: Key }> = [
  { key: "metadataDays", label: "envios.privacy.metadataDays" },
  { key: "bodyDays", label: "envios.privacy.bodyDays" },
  { key: "maxBodyKiB", label: "envios.privacy.maxBodyKiB" },
  { key: "maxTotalMiB", label: "envios.privacy.maxTotalMiB" },
];

/** Retenção e privacidade dos envios por SMTP (global). */
export function SendPrivacyCard() {
  const { t } = useI18n();
  const [saved, setSaved] = useState<MailSendSettings | null>(null);
  const [form, setForm] = useState<Record<NumberField, string>>({ metadataDays: "", bodyDays: "", maxBodyKiB: "", maxTotalMiB: "" });
  const [store, setStore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  function adopt(s: MailSendSettings) {
    setSaved(s);
    setStore(s.storeContent);
    setForm({ metadataDays: String(s.metadataDays), bodyDays: String(s.bodyDays), maxBodyKiB: String(s.maxBodyKiB), maxTotalMiB: String(s.maxTotalMiB) });
  }

  useEffect(() => {
    let cancelled = false;
    apiFetch<MailSendSettings>(SETTINGS_URL)
      .then((s) => {
        if (!cancelled) adopt(s);
      })
      .catch((err: unknown) => {
        if (!cancelled) setNote({ ok: false, text: apiErrorText(err, "envios.privacy.error.load") });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      const body: Record<string, number | boolean> = { storeContent: store };
      for (const { key } of FIELDS) body[key] = Number(form[key]);
      adopt(await apiFetch<MailSendSettings>(SETTINGS_URL, { method: "PUT", body: JSON.stringify(body) }));
      setNote({ ok: true, text: t("envios.privacy.saved") });
    } catch (err) {
      setNote({ ok: false, text: apiErrorText(err, "envios.privacy.error.save") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{t("envios.privacy.title")}</CardTitle>
        <CardDescription>{t("envios.privacy.desc")}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t("envios.privacy.loading")}
          </p>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={(e) => void save(e)}>
            <div className="flex flex-col gap-1">
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5 h-4 w-4" checked={store} onChange={(e) => setStore(e.target.checked)} />
                <span>{t("envios.privacy.storeContent")}</span>
              </label>
              <p className="text-xs text-muted-foreground">{t("envios.privacy.storeContent.help")}</p>
              {saved && saved.projectsWithoutContent.length > 0 && (
                <p className="text-xs text-muted-foreground">{t("envios.privacy.projectsOff", { n: saved.projectsWithoutContent.length })}</p>
              )}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {FIELDS.map(({ key, label }) => (
                <div key={key} className="flex min-w-0 flex-col gap-1">
                  <label htmlFor={`p-${key}`} className="text-xs text-muted-foreground">
                    {t(label)}
                  </label>
                  <Input
                    id={`p-${key}`}
                    type="number"
                    inputMode="numeric"
                    min={MAIL_SEND_LIMITS[key].min}
                    max={MAIL_SEND_LIMITS[key].max}
                    value={form[key]}
                    onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t("envios.privacy.limits")}</p>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" size="sm" disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {t("envios.privacy.save")}
              </Button>
              {note && (
                <p role="status" className={note.ok ? "text-xs text-emerald-400" : "text-xs text-destructive"}>
                  {note.text}
                </p>
              )}
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
