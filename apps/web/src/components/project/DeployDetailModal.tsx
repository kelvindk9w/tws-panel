import { useEffect, useState } from "react";
import type { DeployJob, DeployJobResponse } from "@paas/core";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Loader2, X } from "lucide-react";
import { DeployLogView, DeploySteps, JobStatusBadge } from "./DeployLog";
import { deployDuration, formatDateTime, isActiveJob } from "./deploy-format";

/**
 * Detalhe de um deploy numa janela: etapas, duração e o log inteiro. Em
 * andamento, atualiza sozinho. Fecha com o botão, com Esc ou clicando fora.
 */
export function DeployDetailModal({
  projectId,
  jobId,
  onClose,
}: {
  projectId: string;
  jobId: string;
  onClose: () => void;
}) {
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
        if (!cancelled) setError(err instanceof Error ? err.message : "Não foi possível carregar o deploy.");
      }
    }
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectId, jobId]);

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
        aria-label="Detalhes do deploy"
        data-testid="deploy-detail"
        className="flex max-h-[90dvh] w-full max-w-4xl flex-col gap-3 rounded-xl border bg-background p-4 shadow-2xl sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
              Deploy <code className="text-sm text-muted-foreground">{jobId.slice(0, 8)}</code>
              {job && <JobStatusBadge status={job.status} />}
            </h2>
            {job && (
              <p className="text-xs text-muted-foreground">
                {formatDateTime(job.createdAt)} · duração {deployDuration(job)}
              </p>
            )}
          </div>
          <Button variant="ghost" size="icon" aria-label="Fechar" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!job && !error && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        {job && (
          <>
            <DeploySteps job={job} />
            <DeployLogView job={job} className="min-h-[12rem] flex-1" />
          </>
        )}
      </div>
    </div>
  );
}
