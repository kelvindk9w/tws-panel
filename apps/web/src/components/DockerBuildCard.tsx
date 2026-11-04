import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { DockerBuildFixResponse, DockerBuildStatusResponse, DockerOriginKind } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, useI18n } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/CopyButton";
import { EMPTY_REAUTH, ReauthFields, reauthPayload, type Reauth } from "@/components/settings/ReauthFields";
import { CheckCircle2, HelpCircle, Loader2, RefreshCw, Container, XCircle } from "lucide-react";

/**
 * Saúde da VPS → Docker e BuildKit. Mostra se o plugin buildx existe no Docker do painel (faz os deploys) e no
 * da VPS; no da VPS, com origem reconhecida, corrige com um clique (senha + código do app, como as ações de
 * acesso à VPS). Origem não reconhecida: mostra os comandos manuais.
 */
export function DockerBuildCard() {
  const { t } = useI18n();
  const [status, setStatus] = useState<DockerBuildStatusResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fixing, setFixing] = useState(false);
  const [reauth, setReauth] = useState<Reauth>(EMPTY_REAUTH);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [alertWarning, setAlertWarning] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setStatus(await apiFetch<DockerBuildStatusResponse>("/api/health/docker-build"));
    } catch (err) {
      setLoadError(apiErrorText(err, "access.dockerBuild.loadError"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function fix(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    setAlertWarning(null);
    try {
      const res = await apiFetch<DockerBuildFixResponse>("/api/health/docker-build/fix", {
        method: "POST",
        body: JSON.stringify(reauthPayload(reauth)),
      });
      setStatus(res.status);
      setAlertWarning(res.alertWarning ?? null);
      setDone(t("access.dockerBuild.fixDone"));
      setFixing(false);
      setReauth(EMPTY_REAUTH);
    } catch (err) {
      setError(apiErrorText(err, "access.dockerBuild.fixError"));
    } finally {
      setBusy(false);
    }
  }

  const originText = (origin: DockerOriginKind) => {
    switch (origin) {
      case "docker-ce":
        return t("access.dockerBuild.origin.docker-ce");
      case "docker.io":
        return t("access.dockerBuild.origin.docker.io");
      case "snap":
        return t("access.dockerBuild.origin.snap");
      default:
        return t("access.dockerBuild.origin.unknown");
    }
  };

  const okBadge = (
    <Badge variant="success" className="gap-1">
      <CheckCircle2 className="h-3 w-3" /> OK
    </Badge>
  );
  const missingBadge = (
    <Badge variant="destructive" className="gap-1">
      <XCircle className="h-3 w-3" /> buildx
    </Badge>
  );
  const unknownBadge = (
    <Badge variant="outline" className="gap-1">
      <HelpCircle className="h-3 w-3" /> ?
    </Badge>
  );

  return (
    <Card data-testid="docker-build-card">
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base">
            <Container className="h-4 w-4" /> {t("access.dockerBuild.title")}
          </CardTitle>
          <CardDescription>{t("access.dockerBuild.description")}</CardDescription>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {t("access.dockerBuild.refresh")}
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {loadError && (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
            {loadError}
          </p>
        )}
        {status && (
          <>
            <div className="flex flex-col gap-1" data-testid="docker-build-panel">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{t("access.dockerBuild.panel.label")}</span>
                {status.panel.buildx ? okBadge : missingBadge}
              </div>
              {status.panel.buildx ? (
                <p className="text-muted-foreground">
                  {status.panel.version
                    ? t("access.dockerBuild.panel.ok", { version: status.panel.version })
                    : t("access.dockerBuild.panel.okNoVersion")}
                </p>
              ) : (
                <>
                  <p className="text-amber-400">{t("access.dockerBuild.panel.missing")}</p>
                  {status.panel.detail && (
                    <p className="font-mono text-xs text-muted-foreground">{t("access.dockerBuild.panel.detail", { detail: status.panel.detail })}</p>
                  )}
                </>
              )}
            </div>

            <div className="flex flex-col gap-1" data-testid="docker-build-host">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{t("access.dockerBuild.host.label")}</span>
                {status.host.buildx === null ? unknownBadge : status.host.buildx ? okBadge : missingBadge}
              </div>
              {status.host.buildx === null && (
                <p className="text-muted-foreground">{t("access.dockerBuild.host.unavailable", { reason: status.host.reason ?? "" })}</p>
              )}
              {status.host.buildx === true && <p className="text-muted-foreground">{t("access.dockerBuild.host.ok")}</p>}
              {status.host.buildx === false && (
                <>
                  <p className="text-amber-400">{t("access.dockerBuild.host.missing")}</p>
                  {status.host.origin && (
                    <p className="text-xs text-muted-foreground">{t("access.dockerBuild.host.origin", { origin: originText(status.host.origin) })}</p>
                  )}
                  {status.host.fixable && !fixing && (
                    <div>
                      <Button size="sm" onClick={() => { setFixing(true); setReauth(EMPTY_REAUTH); setError(null); setDone(null); }}>
                        {t("access.dockerBuild.fix")}
                      </Button>
                    </div>
                  )}
                  {!status.host.fixable && status.host.manualCommands.length > 0 && (
                    <div className="flex flex-col gap-1" data-testid="docker-build-manual">
                      <p className="text-muted-foreground">{t("access.dockerBuild.manual.title")}</p>
                      <div className="flex items-start justify-between gap-2 rounded bg-black/60 px-2 py-1.5">
                        <pre className="overflow-x-auto font-mono text-xs">{status.host.manualCommands.join("\n")}</pre>
                        <CopyButton text={status.host.manualCommands.join("\n")} />
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}

        {fixing && (
          <form onSubmit={(e) => void fix(e)} className="flex max-w-md flex-col gap-3 rounded-md border p-3" data-testid="docker-build-fix-form">
            <p className="text-sm font-medium">{t("access.dockerBuild.fixTitle")}</p>
            <p className="text-xs text-muted-foreground">{t("access.dockerBuild.fixHint")}</p>
            <ReauthFields idPrefix="dbfix" action="docker.buildx" value={reauth} onChange={setReauth} />
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || reauth.password.length === 0 || reauth.code.trim().length === 0}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} {busy ? t("access.dockerBuild.fixing") : t("access.dockerBuild.fixConfirm")}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setFixing(false)}>
                {t("access.keys.cancel")}
              </Button>
            </div>
          </form>
        )}
        {error && (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
            {error}
          </p>
        )}
        {done && (
          <p role="status" className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-emerald-400">
            {done}
          </p>
        )}
        {alertWarning && (
          <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-400">
            {alertWarning}
          </p>
        )}
        {status?.ok && !done && <p className="text-muted-foreground">{t("access.dockerBuild.allOk")}</p>}
      </CardContent>
    </Card>
  );
}
