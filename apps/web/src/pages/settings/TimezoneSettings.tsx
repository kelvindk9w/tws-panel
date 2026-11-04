/**
 * Configurações → Fuso horário: o fuso da VPS e a hora de agora, trocar o
 * fuso (aplica na VPS pelo host bridge, vale na hora para o painel e para a
 * agenda dos backups) e, junto, reiniciar os projetos marcados com o fuso novo.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import type { ProjectTimezoneSetting, SetTimezoneResponse, TimezoneProjectResult, TimezoneStatus } from "@paas/core";
import { apiFetch, ApiRequestError } from "@/lib/api";
import { apiErrorText, Trans, t, useI18n, type Key } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TimezonePicker, clockIn, zoneWithOffset } from "@/components/timezone/TimezonePicker";
import { AlertTriangle, CheckCircle2, Clock, Loader2 } from "lucide-react";

/** Só erro da API traz mensagem própria; qualquer outro vira o texto padrão. */
function errorText(err: unknown, fallback: Key): string {
  return apiErrorText(err instanceof ApiRequestError ? err : null, fallback);
}

/** Texto da escolha do projeto ("Padrão da imagem", "Igual ao da VPS", um fuso). */
export function settingText(s: ProjectTimezoneSetting): string {
  if (s.mode === "host") return t("timezone.setting.host");
  if (s.mode === "zone" && s.zone) return s.zone;
  return t("timezone.setting.image");
}

/** De onde veio o fuso que o painel usa, em uma frase. */
export function sourceText(st: TimezoneStatus): string | null {
  switch (st.source) {
    case "env":
      return t("timezone.source.env", { zone: String(st.envOverride) });
    case "saved":
      return t("timezone.source.saved");
    case "localtime":
      return t("timezone.source.localtime");
    case "default":
      return t("timezone.source.default");
    default:
      return null;
  }
}

/** Relógio que anda a cada 30 s, alinhado com a hora do servidor. */
export function useServerClock(serverNow: string | undefined): Date {
  // Hora do servidor quando chegou + quanto andou desde então no navegador.
  // A base é calculada já no render em que a hora chega (useMemo), não num
  // efeito depois: senão o primeiro render mostrava a hora do navegador.
  const base = useMemo(() => (serverNow ? { server: Date.parse(serverNow), local: Date.now() } : null), [serverNow]);
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return new Date(base ? base.server + Math.max(0, tick - base.local) : tick);
}

export function ProjectRestartResults({ results }: { results: TimezoneProjectResult[] }) {
  if (results.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 text-sm" data-testid="timezone-project-results">
      {results.map((r) => (
        <li key={r.id} className="flex items-start gap-1.5">
          {r.error ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          ) : (
            <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-sky-400" />
          )}
          <span className="min-w-0 break-words">
            <strong className="font-medium">{r.name}</strong>
            {r.error ? (
              <>{t("timezone.restart.failed", { error: r.error })}</>
            ) : (
              <Trans
                k="timezone.restart.running"
                components={{
                  link: (c) => (
                    <Link to={`/projects/${r.id}/deploys`} className="underline underline-offset-2">
                      {c}
                    </Link>
                  ),
                }}
              />
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function TimezoneSettings() {
  const { t } = useI18n();
  const [status, setStatus] = useState<TimezoneStatus | null>(null);
  const [zone, setZone] = useState("");
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [results, setResults] = useState<TimezoneProjectResult[]>([]);
  const clock = useServerClock(status?.now);

  const load = useCallback(async () => {
    try {
      const st = await apiFetch<TimezoneStatus>("/api/timezone");
      setStatus(st);
      setZone((z) => z || st.hostZone || st.zone);
    } catch (err) {
      setError(errorText(err, "timezone.error.generic"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!status) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        {error ? <span role="alert" className="text-destructive">{error}</span> : <><Loader2 className="h-4 w-4 animate-spin" /> {t("timezone.loading")}</>}
      </p>
    );
  }

  const vpsZone = status.hostZone ?? status.zone;
  const same = zone === vpsZone;
  const source = sourceText(status);
  const toggle = (id: string, on: boolean) =>
    setMarked((m) => {
      const next = new Set(m);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  async function apply() {
    setBusy(true);
    setError(null);
    setNotice(null);
    setResults([]);
    try {
      const res = await apiFetch<SetTimezoneResponse>("/api/timezone", {
        method: "PUT",
        body: JSON.stringify({ zone, projects: [...marked] }),
      });
      setStatus(res.status);
      setResults(res.projects);
      setMarked(new Set());
      setNotice(t("timezone.applied", { zone: zoneWithOffset(zone, res.status.options) }));
    } catch (err) {
      setError(errorText(err, "timezone.error.generic"));
    } finally {
      setBusy(false);
    }
  }

  const following = status.projects.filter((p) => p.setting.mode === "host" && !marked.has(p.id));

  return (
    <div className="flex flex-col gap-6">
      <Card data-testid="timezone-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="h-4 w-4" /> {t("timezone.card.title")}
          </CardTitle>
          <CardDescription>{t("timezone.card.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          <div className="flex flex-col gap-1" data-testid="timezone-current">
            <p>
              <Trans
                k="timezone.current"
                params={{ zone: zoneWithOffset(vpsZone, status.options), time: clockIn(vpsZone, clock) }}
                components={{ b: <strong />, clock: <strong data-testid="timezone-clock" /> }}
              />
            </p>
            {status.zone !== vpsZone && (
              <p className="text-amber-400">
                {t("timezone.panelUsing", { zone: zoneWithOffset(status.zone, status.options) })}
              </p>
            )}
            {source && <p className="text-xs text-muted-foreground">{source}</p>}
            {status.hostError && <p className="text-xs text-amber-400">{status.hostError}</p>}
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="timezone-zone" className="font-medium">
              {t("timezone.newZone")}
            </label>
            <TimezonePicker id="timezone-zone" options={status.options} value={zone} onChange={setZone} disabled={busy || !status.canApply} />
            <p className="text-xs text-muted-foreground">{t("timezone.newZoneHint")}</p>
          </div>

          {status.projects.length > 0 && (
            <fieldset className="flex flex-col gap-2" data-testid="timezone-projects">
              <legend className="mb-1 font-medium">{t("timezone.projects.legend")}</legend>
              <p className="text-xs text-muted-foreground">
                {t("timezone.projects.help")}
              </p>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setMarked(new Set(status.projects.map((p) => p.id)))}>
                  {t("timezone.projects.markAll")}
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setMarked(new Set())}>
                  {t("timezone.projects.markNone")}
                </Button>
              </div>
              <ul className="flex flex-col gap-1">
                {status.projects.map((p) => (
                  <li key={p.id}>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="h-4 w-4"
                        checked={marked.has(p.id)}
                        disabled={busy}
                        onChange={(e) => toggle(p.id, e.target.checked)}
                      />
                      <span className="min-w-0 break-words">
                        {p.name} <span className="text-xs text-muted-foreground">{t("timezone.projects.today", { setting: settingText(p.setting) })}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              {following.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t("timezone.projects.following", { count: following.length, names: following.map((p) => p.name).join(", ") })}
                </p>
              )}
            </fieldset>
          )}

          {!status.canApply && status.cannotApplyReason && (
            <p className="flex items-start gap-1.5 text-amber-400" data-testid="timezone-cannot-apply">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {status.cannotApplyReason}
            </p>
          )}

          <div>
            <Button onClick={() => void apply()} disabled={busy || !status.canApply || !zone || (same && marked.size === 0)}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {busy ? t("timezone.applying") : t("timezone.apply")}
            </Button>
          </div>

          {notice && (
            <p className="flex items-start gap-1.5 text-emerald-400" role="status">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> {notice}
            </p>
          )}
          {error && (
            <p role="alert" className="break-words text-destructive">
              {error}
            </p>
          )}
          <ProjectRestartResults results={results} />
        </CardContent>
      </Card>
    </div>
  );
}
