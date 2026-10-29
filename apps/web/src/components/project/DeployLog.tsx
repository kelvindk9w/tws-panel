import { useEffect, useRef } from "react";
import type { DeployJob } from "@paas/core";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { stepDuration } from "./deploy-format";

export function JobStatusBadge({ status }: { status: DeployJob["status"] }) {
  const { t } = useI18n();
  switch (status) {
    case "queued":
    case "running":
      return <Badge variant="warning">{t("projects.jobStatus.running")}</Badge>;
    case "success":
      return <Badge variant="success">{t("projects.jobStatus.success")}</Badge>;
    case "failed":
      return <Badge variant="destructive">{t("projects.jobStatus.failed")}</Badge>;
  }
}

function StepIcon({ status }: { status: DeployJob["steps"][number]["status"] }) {
  switch (status) {
    case "done":
      return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
    case "running":
      return <Loader2 className="h-4 w-4 animate-spin text-amber-400" />;
    case "failed":
      return <XCircle className="h-4 w-4 text-red-400" />;
    case "skipped":
      return <span className="inline-block h-4 w-4 rounded-full border border-muted" />;
  }
}

export function DeploySteps({ job }: { job: DeployJob }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {job.steps.map((step, i) => (
        <span key={i} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <StepIcon status={step.status} /> {step.name}
          {stepDuration(step) && <span className="tabular-nums">({stepDuration(step)})</span>}
        </span>
      ))}
    </div>
  );
}

/**
 * Log do deploy. `tail` mostra só as últimas N linhas (resumo na Visão
 * geral); o detalhe mostra tudo. Acompanha o fim do log enquanto ele cresce.
 */
export function DeployLogView({ job, tail, className }: { job: DeployJob; tail?: number; className?: string }) {
  const { t } = useI18n();
  const ref = useRef<HTMLPreElement>(null);
  const text = tail ? job.log.split("\n").filter((l, i, a) => l !== "" || i < a.length - 1).slice(-tail).join("\n") : job.log;
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [job.log]);
  return (
    <>
      <pre
        ref={ref}
        className={cn(
          "overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-black/40 p-3 font-mono text-xs leading-relaxed text-emerald-100/90",
          className,
        )}
      >
        {text || t("projects.log.waiting")}
      </pre>
      {job.error && <p className="pt-2 text-sm text-destructive">{job.error}</p>}
    </>
  );
}
