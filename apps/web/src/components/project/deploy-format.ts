import type { DeployJob, DeployJobStartup, DeployJobStep } from "@paas/core";
import { formatDateTime as formatLocaleDateTime, t } from "@/i18n";

/** Segundos como "1min 30s" / "45s". */
export function formatSeconds(total: number): string {
  const whole = Math.max(0, Math.round(total));
  const min = Math.floor(whole / 60);
  const sec = whole % 60;
  return min > 0 ? t("projects.duration.minSec", { min, sec }) : t("projects.duration.sec", { sec });
}

/** Duração de um deploy ("1min 30s", "45s"); em andamento, até agora. */
export function deployDuration(job: DeployJob, now = Date.now()): string {
  const start = job.startedAt ?? job.createdAt;
  if (!start) return "—";
  const end = job.finishedAt ? new Date(job.finishedAt).getTime() : now;
  return formatSeconds((end - new Date(start).getTime()) / 1000);
}

/** Duração de uma etapa; null se o deploy é antigo (sem horários) ou a etapa não rodou. */
export function stepDuration(step: DeployJobStep, now = Date.now()): string | null {
  if (!step.startedAt) return null;
  const end = step.finishedAt ? new Date(step.finishedAt).getTime() : step.status === "running" ? now : Number.NaN;
  const ms = end - new Date(step.startedAt).getTime();
  return Number.isFinite(ms) ? formatSeconds(ms / 1000) : null;
}

/** "web 12s, api ~40s" (o til marca a medida aproximada); vazio se nada foi medido. */
export function startupSummary(list: readonly DeployJobStartup[] | undefined): string {
  return (list ?? []).map((s) => `${s.service} ${s.approx ? "~" : ""}${formatSeconds(s.seconds)}`).join(", ");
}

export function isActiveJob(job: DeployJob): boolean {
  return job.status === "running" || job.status === "queued";
}

export function formatDateTime(iso: string): string {
  return formatLocaleDateTime(iso);
}
