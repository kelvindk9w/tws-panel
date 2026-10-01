import type { DeployJob } from "@paas/core";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronRight } from "lucide-react";
import { JobStatusBadge } from "./DeployLog";
import { deployDuration, formatDateTime } from "./deploy-format";

/** Seção Deploys: só o histórico. Clicar num deploy abre o detalhe (etapas e log). */
export function DeployHistory({ jobs, onOpen }: { jobs: DeployJob[]; onOpen: (jobId: string) => void }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Histórico de deploys</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {jobs.length === 0 ? (
          <p className="px-6 pb-4 text-sm text-muted-foreground">Nenhum deploy ainda.</p>
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
                  <span className="text-xs text-muted-foreground">{formatDateTime(job.createdAt)}</span>
                  <span className="text-xs text-muted-foreground">duração {deployDuration(job)}</span>
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
