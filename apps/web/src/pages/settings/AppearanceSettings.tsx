import { useState } from "react";
import type { NavLayout, UpdatePreferencesResponse, UserPreferences } from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { useI18n, type Key } from "@/i18n";
import { LanguageSelect } from "@/components/LanguageSelect";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle2, Loader2 } from "lucide-react";

const NAV_OPTIONS: Array<{ value: NavLayout; label: Key; hint: Key }> = [
  { value: "top", label: "settings.appearance.nav.top.label", hint: "settings.appearance.nav.top.hint" },
  { value: "left", label: "settings.appearance.nav.left.label", hint: "settings.appearance.nav.left.hint" },
  { value: "right", label: "settings.appearance.nav.right.label", hint: "settings.appearance.nav.right.hint" },
];

/** Miniatura do formato — mostra, sem precisar ler, onde o menu vai ficar. */
function LayoutPreview({ value }: { value: NavLayout }) {
  const bar = "rounded-sm bg-muted-foreground/60";
  const body = "rounded-sm bg-muted-foreground/20";
  return (
    <div aria-hidden className="flex h-16 w-24 gap-1 rounded border bg-background p-1">
      {value === "top" ? (
        <div className="flex flex-1 flex-col gap-1">
          <div className={cn(bar, "h-2.5")} />
          <div className={cn(body, "flex-1")} />
        </div>
      ) : (
        <>
          {value === "left" && <div className={cn(bar, "w-5")} />}
          <div className={cn(body, "flex-1")} />
          {value === "right" && <div className={cn(bar, "w-5")} />}
        </>
      )}
    </div>
  );
}

/**
 * Configurações → Aparência: onde fica o menu de navegação. A escolha vale na
 * hora e fica salva na conta (vale em qualquer computador).
 */
export function AppearanceSettings() {
  const { t } = useI18n();
  const { preferences, setPreferences } = useAuth();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(navLayout: NavLayout) {
    if (navLayout === preferences.navLayout || saving) return;
    const before: UserPreferences = preferences;
    setPreferences({ ...preferences, navLayout }); // muda na hora
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await apiFetch<UpdatePreferencesResponse>("/api/settings/preferences", {
        method: "PUT",
        body: JSON.stringify({ navLayout }),
      });
      setPreferences(res.preferences);
      setSaved(true);
    } catch (err) {
      setPreferences(before);
      setError(
        t("settings.appearance.error.save", {
          detail: err instanceof ApiRequestError && err.message ? ` (${err.message})` : "",
        }),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("settings.appearance.title")}</CardTitle>
          <CardDescription>{t("settings.appearance.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div role="radiogroup" aria-label={t("settings.appearance.navLabel")} className="grid gap-3 sm:grid-cols-3">
            {NAV_OPTIONS.map((opt) => {
              const checked = preferences.navLayout === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={t(opt.label)}
                  onClick={() => void choose(opt.value)}
                  className={cn(
                    "flex flex-col items-start gap-2 rounded-md border p-3 text-left transition-colors",
                    checked ? "border-primary bg-secondary" : "hover:bg-accent",
                  )}
                >
                  <LayoutPreview value={opt.value} />
                  <span className="text-sm font-medium">{t(opt.label)}</span>
                  <span className="text-xs text-muted-foreground">{t(opt.hint)}</span>
                </button>
              );
            })}
          </div>
          <div className="min-h-5 text-xs">
            {saving && (
              <span className="flex items-center gap-1 text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> {t("settings.appearance.saving")}
              </span>
            )}
            {saved && !saving && (
              <span className="flex items-center gap-1 text-emerald-400">
                <CheckCircle2 className="h-3 w-3" /> {t("settings.appearance.saved")}
              </span>
            )}
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("settings.appearance.language.title")}</CardTitle>
          <CardDescription>{t("settings.appearance.language.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <LanguageSelect />
        </CardContent>
      </Card>
    </div>
  );
}
