import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { DatabaseJob } from "@paas/core";
import { ApiRequestError, apiFetch } from "@/lib/api";
import { jobErrorText } from "@/lib/database";
import { useI18n, type Key } from "@/i18n";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/mail/CopyButton";
import { DatabaseRunView } from "@/components/project/DatabaseRunView";

const STEP_KEYS = { backup: "database.action.step.backup", action: "database.action.step.action" } as const satisfies Record<string, Key>;
const STEP_STATUS_KEYS = {
  pending: "database.action.stepStatus.pending",
  running: "database.action.stepStatus.running",
  done: "database.action.stepStatus.done",
  failed: "database.action.stepStatus.failed",
  skipped: "database.action.stepStatus.skipped",
} as const satisfies Record<DatabaseJob["steps"][number]["status"], Key>;

/**
 * Andamento de um trabalho do banco (backup opcional + ação): consulta o servidor até terminar e mostra os passos, a
 * saída e o resultado por instrução. Usado pelo diálogo das ações e pelo de liberar a edição.
 */
export function DatabaseJobRunner({
  projectId,
  initial,
  alertWarning,
  pollMs,
  onClose,
  onFinished,
}: {
  projectId: string;
  initial: DatabaseJob;
  alertWarning: string | null;
  pollMs: number;
  onClose: () => void;
  /** Chamado quando o trabalho termina (ok ou não) ou quando o acompanhamento se perde. */
  onFinished: (job: DatabaseJob | null) => void;
}) {
  const { t } = useI18n();
  const [job, setJob] = useState<DatabaseJob>(initial);
  const [pollProblem, setPollProblem] = useState(false);
  // O painel reiniciou e a lista de trabalhos foi zerada (404): para de consultar e avisa
  const [jobGone, setJobGone] = useState(false);
  const finishedRef = useRef(false);

  const running = job.status === "running" && !jobGone;

  useEffect(() => {
    if (job.status !== "running" || jobGone) return;
    let alive = true;
    const timer = setTimeout(() => {
      apiFetch<DatabaseJob>(`/api/projects/${projectId}/database/jobs/${job.id}`)
        .then((next) => {
          if (!alive) return;
          setPollProblem(false);
          setJob(next);
        })
        .catch((err: unknown) => {
          if (!alive) return;
          if (err instanceof ApiRequestError && err.code === "job_not_found") {
            setJobGone(true);
            return;
          }
          setPollProblem(true);
          // continua tentando: o efeito roda de novo quando o estado muda
          setJob((cur) => ({ ...cur }));
        });
    }, pollMs);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [job, jobGone, projectId, pollMs]);

  useEffect(() => {
    if ((job.status !== "running" || jobGone) && !finishedRef.current) {
      finishedRef.current = true;
      onFinished(jobGone ? null : job);
    }
  }, [job, jobGone, onFinished]);

  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="database-job">
      {alertWarning && (
        <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-300">
          {t("database.action.alertWarning", { message: alertWarning })}
        </p>
      )}
      <ul className="flex flex-col gap-1">
        {job.steps.map((step) => (
          <li key={step.id} className="flex items-center gap-2" data-testid={`database-step-${step.id}`}>
            {step.status === "running" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : step.status === "done" ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            ) : step.status === "failed" ? (
              <XCircle className="h-4 w-4 text-red-400" />
            ) : (
              <span className="inline-block h-4 w-4" />
            )}
            <span>{t(STEP_KEYS[step.id])}</span>
            <span className="text-xs text-muted-foreground">{t(STEP_STATUS_KEYS[step.status])}</span>
          </li>
        ))}
      </ul>
      {job.backupFileName && <p className="text-xs text-muted-foreground">{t("database.action.backupFile", { file: job.backupFileName })}</p>}
      {job.backupValidation && (
        <p className="text-xs text-muted-foreground" data-testid="database-validation">
          {t(job.backupValidation === "passed" ? "database.action.validation.passed" : "database.action.validation.notRun")}
        </p>
      )}
      {running && (
        <p role="status" className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t("database.action.working")}
        </p>
      )}
      {pollProblem && running && <p className="text-xs text-amber-300">{t("database.action.pollError")}</p>}
      {jobGone && (
        <p role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-300" data-testid="database-job-gone">
          {t("database.action.jobGone")}
        </p>
      )}
      {job.status === "success" && (
        <p role="status" className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-emerald-400">
          {t("database.action.done")}
        </p>
      )}
      {job.status === "failed" && job.error && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
          <strong>{t("database.action.failed")}.</strong> {jobErrorText(job.error)}
        </p>
      )}
      {job.output !== null && (
        <div className="flex flex-col gap-1" data-testid="database-output">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">{t("database.action.output")}</span>
            <CopyButton text={job.output} label={t("common.copy")} />
          </div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-black/60 p-2 font-mono text-xs">{job.output || t("database.action.noOutput")}</pre>
        </div>
      )}
      {job.run && <DatabaseRunView run={job.run} error={job.status === "failed" ? job.error : null} />}
      <div className="flex justify-end">
        <Button size="sm" variant="outline" onClick={onClose} disabled={running}>
          {t("database.action.close")}
        </Button>
      </div>
    </div>
  );
}
