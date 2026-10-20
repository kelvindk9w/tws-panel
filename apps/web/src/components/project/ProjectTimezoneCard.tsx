/**
 * Campo "Fuso horário" do projeto (aba Configurações): padrão da imagem,
 * igual ao da VPS (acompanha a troca) ou um fuso específico. Mostra quem já
 * define TZ no próprio projeto (o painel não mexe), avisa que vale depois de
 * reiniciar (com o botão) e aponta o serviço sem base de fusos na imagem.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { DeployJobResponse, ProjectTimezoneDefinition, ProjectTimezoneMode, ProjectTimezoneView } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, t as tGlobal, Trans, useI18n, type Key } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TimezonePicker, zoneWithOffset } from "@/components/timezone/TimezonePicker";
import { AlertTriangle, CheckCircle2, Clock, Loader2, RotateCcw } from "lucide-react";

function errorText(err: unknown): string {
  return apiErrorText(err, "projects.timezone.error");
}

const WHERE_TEXT: Record<ProjectTimezoneDefinition["where"], Key> = {
  compose: "projects.timezone.where.compose",
  variables: "projects.timezone.where.variables",
  env_file: "projects.timezone.where.envFile",
};

export function ProjectTimezoneCard({ projectId, onChanged }: { projectId: string; onChanged?: () => void }) {
  const { t } = useI18n();
  const [view, setView] = useState<ProjectTimezoneView | null>(null);
  const [mode, setMode] = useState<ProjectTimezoneMode>("image");
  const [zone, setZone] = useState("America/Sao_Paulo");
  const [busy, setBusy] = useState<"save" | "restart" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restarted, setRestarted] = useState(false);

  const show = useCallback((v: ProjectTimezoneView) => {
    // Resposta fora do formato (versão do servidor diferente, proxy no meio):
    // erro no cartão, sem derrubar a página de Configurações inteira.
    if (!v?.setting?.mode || !Array.isArray(v.services)) {
      setError(tGlobal("projects.timezone.unreadable"));
      return;
    }
    setView(v);
    setMode(v.setting.mode);
    if (v.setting.mode === "zone" && v.setting.zone) setZone(v.setting.zone);
  }, []);

  useEffect(() => {
    apiFetch<ProjectTimezoneView>(`/api/projects/${projectId}/timezone`)
      .then(show)
      .catch((err) => setError(errorText(err)));
  }, [projectId, show]);

  if (!view) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          {error ? <span role="alert" className="text-destructive">{error}</span> : t("projects.timezone.loading")}
        </CardContent>
      </Card>
    );
  }

  const dirty = mode !== view.setting.mode || (mode === "zone" && zone !== view.setting.zone);
  const noZoneinfo = view.services.filter((s) => s.zoneinfo === false);

  async function save() {
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const body = mode === "zone" ? { mode, zone } : { mode };
      show(await apiFetch<ProjectTimezoneView>(`/api/projects/${projectId}/timezone`, { method: "PUT", body: JSON.stringify(body) }));
      setNotice(t("projects.timezone.saved"));
      setRestarted(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function restart() {
    setBusy("restart");
    setError(null);
    setNotice(null);
    try {
      await apiFetch<DeployJobResponse>(`/api/projects/${projectId}/recreate`, { method: "POST" });
      setRestarted(true);
      onChanged?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card data-testid="project-timezone-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="h-4 w-4" /> {t("projects.timezone.title")}
        </CardTitle>
        <CardDescription>
          {t("projects.timezone.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {!view.supported ? (
          <p className="text-muted-foreground">{t("projects.timezone.staticSite")}</p>
        ) : (
          <>
            <fieldset className="flex flex-col gap-2" disabled={busy !== null}>
              <legend className="sr-only">{t("projects.timezone.legend")}</legend>
              <label className="flex items-start gap-2">
                <input type="radio" name="tz-mode" className="mt-0.5 h-4 w-4" checked={mode === "image"} onChange={() => setMode("image")} />
                <span>
                  {t("projects.timezone.mode.image")}
                  <span className="block text-xs text-muted-foreground">{t("projects.timezone.mode.imageHint")}</span>
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" name="tz-mode" className="mt-0.5 h-4 w-4" checked={mode === "host"} onChange={() => setMode("host")} />
                <span>
                  {t("projects.timezone.mode.host")}
                  <span className="block text-xs text-muted-foreground">
                    {t("projects.timezone.mode.hostHint", { zone: zoneWithOffset(view.hostZone, view.options) })}
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" name="tz-mode" className="mt-0.5 h-4 w-4" checked={mode === "zone"} onChange={() => setMode("zone")} />
                <span>{t("projects.timezone.mode.zone")}</span>
              </label>
              {mode === "zone" && (
                <div className="pl-6">
                  <TimezonePicker options={view.options} value={zone} onChange={setZone} aria-label={t("projects.timezone.pickerAria")} />
                </div>
              )}
            </fieldset>

            {view.definedByProject.length > 0 && (
              <div className="flex flex-col gap-1" data-testid="timezone-defined">
                <p>{t("projects.timezone.definedByProject")}</p>
                <ul className="list-disc pl-5">
                  {view.definedByProject.map((d) => (
                    <li key={`${d.service}-${d.where}`}>
                      <code>{d.service}</code>: <code>{d.value}</code> ({t(WHERE_TEXT[d.where])})
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <Button size="sm" onClick={() => void save()} disabled={busy !== null || !dirty}>
                {busy === "save" && <Loader2 className="h-4 w-4 animate-spin" />} {t("projects.timezone.save")}
              </Button>
            </div>

            {view.pendingRestart && !restarted && (
              <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3" data-testid="timezone-pending">
                <p className="text-amber-200">
                  {view.effectiveZone
                    ? t("projects.timezone.pendingZone", { zone: zoneWithOffset(view.effectiveZone, view.options) })
                    : t("projects.timezone.pendingImage")}
                </p>
                <div>
                  <Button size="sm" variant="outline" onClick={() => void restart()} disabled={busy !== null}>
                    {busy === "restart" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />} {t("projects.timezone.restart")}
                  </Button>
                </div>
              </div>
            )}
            {restarted && (
              <p className="flex items-start gap-1.5 text-sky-300" role="status">
                <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />
                <span>
                  <Trans
                    k="projects.timezone.restarting"
                    components={{
                      link: (c) => (
                        <Link to={`/projects/${projectId}/deploys`} className="underline underline-offset-2">
                          {c}
                        </Link>
                      ),
                    }}
                  />
                </span>
              </p>
            )}

            {noZoneinfo.length > 0 && (
              <div className="flex flex-col gap-1 text-amber-400" data-testid="timezone-no-tzdata">
                {noZoneinfo.map((s) => (
                  <p key={s.container} className="flex items-start gap-1.5">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      <Trans k="projects.timezone.noTzdata" params={{ service: s.service }} components={{ code: <code /> }} />
                    </span>
                  </p>
                ))}
                <p className="text-xs text-muted-foreground">
                  {t("projects.timezone.noTzdataHint")}
                </p>
              </div>
            )}
          </>
        )}
        {notice && (
          <p className="flex items-start gap-1.5 text-emerald-400">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="break-words text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
