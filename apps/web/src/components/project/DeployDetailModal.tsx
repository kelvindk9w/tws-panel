import { useEffect, useState } from "react";
import type { DeployJob, DeployJobResponse } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { apiErrorText, useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { copyTextLater } from "@/lib/clipboard";
import { Copy, Loader2, X } from "lucide-react";
import { DeployLogView, DeploySteps, JobStatusBadge } from "./DeployLog";
import { buildDeployHistoryText, deployDuration, formatDateTime, isActiveJob, startupSummary } from "./deploy-format";

/**
 * Detalhe de um deploy numa janela: etapas, duração e o log inteiro. Em
 * andamento, atualiza sozinho. Fecha com o botão, com Esc ou clicando fora.
 */
export function DeployDetailModal({
  projectId,
  jobId,
  projectName,
  source,
  branch,
  onClose,
}: {
  projectId: string;
  jobId: string;
  projectName?: string;
  source?: string;
  branch?: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [job, setJob] = useState<DeployJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      try {
        const res = await apiFetch<DeployJobResponse>(`/api/projects/${projectId}/jobs/${jobId}`);
        if (cancelled) return;
        setJob(res.job);
        if (isActiveJob(res.job)) timer = setTimeout(() => void tick(), 1_500);
      } catch (err) {
        if (!cancelled) setError(apiErrorText(err, "projects.detailModal.loadError"));
      }
    }
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectId, jobId]);

  const [copying, setCopying] = useState(false);
  const [copyMsg, setCopyMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Busca o log completo no servidor na hora do clique (a tela pode estar atrás do que existe) e copia.
  async function copyHistory() {
    setCopying(true);
    setCopyMsg(null);
    try {
      const built = apiFetch<DeployJobResponse>(`/api/projects/${projectId}/jobs/${jobId}`).then((res) =>
        buildDeployHistoryText(res.job, { projectName, source, branch }),
      );
      built.catch(() => {});
      const ok = await copyTextLater(built.then((b) => b.text));
      if (!ok) {
        setCopyMsg({ ok: false, text: t("projects.copyLog.failed") });
        return;
      }
      const { lines } = await built;
      setCopyMsg({ ok: true, text: t("projects.copyLog.done", { count: lines === 1 ? 1 : 2, n: lines }) });
    } catch {
      setCopyMsg({ ok: false, text: t("projects.copyLog.failed") });
    } finally {
      setCopying(false);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2 sm:p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("projects.detailModal.aria")}
        data-testid="deploy-detail"
        className="flex max-h-[90dvh] w-full max-w-4xl flex-col gap-3 rounded-xl border bg-background p-4 shadow-2xl sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
              {job?.kind === "recreate" ? t("projects.detailModal.titleRecreate") : t("projects.detailModal.titleDeploy")} <code className="text-sm text-muted-foreground">{jobId.slice(0, 8)}</code>
              {job && <JobStatusBadge status={job.status} />}
            </h2>
            {job && (
              <p className="text-xs text-muted-foreground">
                {formatDateTime(job.createdAt)} · {t("projects.history.duration", { duration: deployDuration(job) })}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!job || copying}
              aria-busy={copying}
              title={t("projects.copyLog.hint")}
              onClick={() => void copyHistory()}
            >
              {copying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}
              {copying ? t("projects.copyLog.busy") : t("projects.copyLog.button")}
            </Button>
            <Button variant="ghost" size="icon" aria-label={t("projects.detailModal.close")} onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
        {copyMsg && (
          <p
            role={copyMsg.ok ? "status" : "alert"}
            data-testid="copy-log-msg"
            className={copyMsg.ok ? "text-sm text-emerald-400" : "text-sm text-destructive"}
          >
            {copyMsg.text}
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!job && !error && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        {job && (
          <>
            <DeploySteps job={job} />
            {job.startups && job.startups.length > 0 && (
              <p className="text-xs text-muted-foreground" data-testid="job-startups" title={t("projects.history.startupHint")}>
                {t("projects.history.startup", { items: startupSummary(job.startups) })}
              </p>
            )}
            <DeployLogView job={job} className="min-h-[12rem] flex-1" />
          </>
        )}
      </div>
    </div>
  );
}
