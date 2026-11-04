import type { DeployJob } from "@paas/core";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronRight } from "lucide-react";
import { JobStatusBadge } from "./DeployLog";
import { useI18n } from "@/i18n";
import { deployDuration, formatDateTime, startupSummary } from "./deploy-format";

/** Seção Deploys: só o histórico. Clicar num deploy abre o detalhe (etapas e log). */
export function DeployHistory({ jobs, onOpen }: { jobs: DeployJob[]; onOpen: (jobId: string) => void }) {
  const { t } = useI18n();
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{t("projects.history.title")}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {jobs.length === 0 ? (
          <p className="px-6 pb-4 text-sm text-muted-foreground">{t("projects.history.empty")}</p>
        ) : (
          <ul>
            {jobs.map((job) => (
              <li key={job.id} className="border-t">
                <button
                  type="button"
                  data-testid={`job-row-${job.id}`}
                  onClick={() => onOpen(job.id)}
                  className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-6 py-3 text-left text-sm hover:bg-accent/50"
                >
                  <JobStatusBadge status={job.status} />
                  {job.kind === "recreate" && <span className="text-xs font-medium">{t("projects.history.recreate")}</span>}
                  <span className="text-xs text-muted-foreground">{formatDateTime(job.createdAt)}</span>
                  <span className="text-xs text-muted-foreground">{t("projects.history.duration", { duration: deployDuration(job) })}</span>
                  {job.startups && job.startups.length > 0 && (
                    <span className="text-xs text-muted-foreground" data-testid={`job-startup-${job.id}`} title={t("projects.history.startupHint")}>
                      {t("projects.history.startup", { items: startupSummary(job.startups) })}
                    </span>
                  )}
                  <code className="text-xs text-muted-foreground">{job.id.slice(0, 8)}</code>
                  {job.error && <span className="w-full truncate text-xs text-red-300 sm:w-auto sm:flex-1">{job.error}</span>}
                  <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
