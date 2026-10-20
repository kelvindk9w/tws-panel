import type { DeployJob } from "@paas/core";
import { formatDateTime as formatLocaleDateTime, t } from "@/i18n";

/** Duração de um deploy ("1min 30s", "45s"); em andamento, até agora. */
export function deployDuration(job: DeployJob, now = Date.now()): string {
  const start = job.startedAt ?? job.createdAt;
  if (!start) return "—";
  const end = job.finishedAt ? new Date(job.finishedAt).getTime() : now;
  const total = Math.max(0, Math.round((end - new Date(start).getTime()) / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min > 0 ? t("projects.duration.minSec", { min, sec }) : t("projects.duration.sec", { sec });
}

export function isActiveJob(job: DeployJob): boolean {
  return job.status === "running" || job.status === "queued";
}

export function formatDateTime(iso: string): string {
  return formatLocaleDateTime(iso);
}
