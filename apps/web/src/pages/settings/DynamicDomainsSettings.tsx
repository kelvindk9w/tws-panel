import { useEffect, useState, type FormEvent } from "react";
import type { DynamicDomainSettingsResponse } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, useI18n } from "@/i18n";
import { saasDomainsGuideUrl } from "@/lib/links";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { BookOpen, Loader2 } from "lucide-react";

const PATH = "/api/settings/dynamic-domains";

/** Configurações → Domínios dinâmicos: os tetos (nomes por projeto, emissões novas por hora e por semana por domínio). */
type Body = { maxNamesPerProject: number; maxIssuancesPerHour: number; maxIssuancesPerWeekPerDomain: number };

export function DynamicDomainsSettings() {
  const { t, locale } = useI18n();
  const [data, setData] = useState<DynamicDomainSettingsResponse | null>(null);
  const [names, setNames] = useState("");
  const [issuances, setIssuances] = useState("");
  const [weekly, setWeekly] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function show(res: DynamicDomainSettingsResponse) {
    setData(res);
    setNames(String(res.limits.maxNamesPerProject));
    setIssuances(String(res.limits.maxIssuancesPerHour));
    setWeekly(String(res.limits.maxIssuancesPerWeekPerDomain));
  }

  useEffect(() => {
    apiFetch<DynamicDomainSettingsResponse>(PATH)
      .then(show)
      .catch((err) => setError(apiErrorText(err, "settings.dynamicDomains.loadError")));
  }, []);

  async function save(event: FormEvent, body?: Body) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await apiFetch<DynamicDomainSettingsResponse>(PATH, {
        method: "PUT",
        body: JSON.stringify(
          body ?? { maxNamesPerProject: Number(names), maxIssuancesPerHour: Number(issuances), maxIssuancesPerWeekPerDomain: Number(weekly) },
        ),
      });
      show(res);
      setSaved(true);
    } catch (err) {
      setError(apiErrorText(err, "settings.dynamicDomains.saveError"));
    } finally {
      setBusy(false);
    }
  }

  const dirty =
    data !== null &&
    (names !== String(data.limits.maxNamesPerProject) ||
      issuances !== String(data.limits.maxIssuancesPerHour) ||
      weekly !== String(data.limits.maxIssuancesPerWeekPerDomain));

  return (
    <Card data-testid="dynamic-domains-settings">
      <CardHeader>
        <CardTitle>{t("settings.dynamicDomains.title")}</CardTitle>
        <CardDescription>{t("settings.dynamicDomains.intro")}</CardDescription>
        <a
          href={saasDomainsGuideUrl(locale)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-fit items-center gap-1 text-xs text-primary hover:underline"
        >
          <BookOpen className="h-3.5 w-3.5" /> {t("settings.dynamicDomains.guide")}
        </a>
      </CardHeader>
      <CardContent>
        {data && (
          <form onSubmit={(e) => void save(e)} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="dyn-names" className="text-sm font-medium">
                {t("settings.dynamicDomains.names.label")}
              </label>
              <Input
                id="dyn-names"
                inputMode="numeric"
                value={names}
                onChange={(e) => setNames(e.target.value.replace(/\D/g, ""))}
                className="w-40"
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.dynamicDomains.names.hint", {
                  min: data.range.maxNamesPerProject.min,
                  max: data.range.maxNamesPerProject.max,
                  default: data.defaults.maxNamesPerProject,
                })}
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="dyn-issuances" className="text-sm font-medium">
                {t("settings.dynamicDomains.issuances.label")}
              </label>
              <Input
                id="dyn-issuances"
                inputMode="numeric"
                value={issuances}
                onChange={(e) => setIssuances(e.target.value.replace(/\D/g, ""))}
                className="w-40"
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.dynamicDomains.issuances.hint", {
                  min: data.range.maxIssuancesPerHour.min,
                  max: data.range.maxIssuancesPerHour.max,
                  default: data.defaults.maxIssuancesPerHour,
                })}
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="dyn-weekly" className="text-sm font-medium">
                {t("settings.dynamicDomains.weekly.label")}
              </label>
              <Input
                id="dyn-weekly"
                inputMode="numeric"
                value={weekly}
                onChange={(e) => setWeekly(e.target.value.replace(/\D/g, ""))}
                className="w-40"
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.dynamicDomains.weekly.hint", {
                  min: data.range.maxIssuancesPerWeekPerDomain.min,
                  max: data.range.maxIssuancesPerWeekPerDomain.max,
                  default: data.defaults.maxIssuancesPerWeekPerDomain,
                })}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={!dirty || busy || !names || !issuances || !weekly}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("settings.dynamicDomains.save")}
              </Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={(e) => void save(e, data.defaults)}>
                {t("settings.dynamicDomains.reset")}
              </Button>
              {saved && (
                <span role="status" className="text-xs text-emerald-400">
                  {t("settings.dynamicDomains.saved")}
                </span>
              )}
            </div>
          </form>
        )}
        {error && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
