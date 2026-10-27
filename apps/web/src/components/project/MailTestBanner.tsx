/**
 * Faixa no topo do projeto: "os e-mails deste projeto estão indo para a caixa de teste".
 * Também aparece quando a caixa foi desligada mas o projeto ainda aponta para ela (falta reiniciar).
 * Se a consulta falhar, a faixa some em silêncio: ela é um aviso, não pode atrapalhar a página.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Inbox, RefreshCw } from "lucide-react";
import type { MailTestView } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";

export function MailTestBanner({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const [view, setView] = useState<MailTestView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<MailTestView>(`/api/projects/${encodeURIComponent(projectId)}/mail-test`)
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch(() => {
        if (!cancelled) setView(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  async function restart() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/recreate`, { method: "POST" });
      setView((v) => (v ? { ...v, needsRestart: false } : v));
    } catch (err) {
      setError(apiErrorText(err, "mailTest.error.generic"));
    } finally {
      setBusy(false);
    }
  }

  if (!view || (!view.enabled && !view.needsRestart)) return null;

  return (
    <div
      data-testid="mail-test-banner"
      className="flex flex-wrap items-center gap-3 rounded-md border border-sky-500/40 bg-sky-500/10 px-4 py-3 text-sm text-sky-100"
    >
      <Inbox className="h-4 w-4 shrink-0 text-sky-300" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {view.enabled ? (
          <>
            <strong>{t("mailTest.banner.title")}</strong>
            <span>{t("mailTest.banner.body")}</span>
            {view.needsRestart && <span className="text-amber-200">{t("mailTest.banner.pendingOn")}</span>}
          </>
        ) : (
          <span className="text-amber-200">{t("mailTest.banner.pendingOnly")}</span>
        )}
        {error && (
          <span role="alert" className="text-destructive">
            {error}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {view.enabled && (
          <Button asChild variant="outline" size="sm">
            <Link to={`/projects/${projectId}/mailTest`}>{t("mailTest.banner.open")}</Link>
          </Button>
        )}
        {view.needsRestart && (
          <Button size="sm" onClick={() => void restart()} disabled={busy}>
            <RefreshCw className="h-4 w-4" /> {t("mailTest.banner.restart")}
          </Button>
        )}
      </div>
    </div>
  );
}
