import { DEPLOY_LOG_MAX_CHARS, type DeployJob, DeployJobStartup, DeployJobStep } from "@paas/core";
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

/** Remove cores ANSI (CSI e OSC) e caracteres de controle; "\r" de barra de progresso fica só com o último trecho. */
export function stripLogControl(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b[@-Z\\-_]/g, "")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((l) => l.slice(l.lastIndexOf("\r") + 1))
      .join("\n")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
  );
}

const HISTORY_CUT_NOTE = "[… log antigo reduzido";

/**
 * Texto do botão "Copiar histórico": cabeçalho para diagnóstico + o log inteiro
 * do servidor, sem cores. O log vem como a tela o mostra (já mascarado pelo servidor).
 */
export function buildDeployHistoryText(
  job: DeployJob,
  ctx: { projectName?: string; source?: string; branch?: string } = {},
  now = Date.now(),
): { text: string; lines: number } {
  const active = isActiveJob(job);
  const head: string[] = [];
  head.push(
    t("projects.copyLog.head.title", {
      kind: t(job.kind === "recreate" ? "projects.copyLog.head.kindRecreate" : "projects.copyLog.head.kindDeploy"),
    }),
  );
  if (ctx.projectName) head.push(t("projects.copyLog.head.project", { name: ctx.projectName }));
  head.push(t("projects.copyLog.head.id", { id: job.id }));
  head.push(t("projects.copyLog.head.status", { status: t(`projects.jobStatus.${active ? "running" : job.status}` as "projects.jobStatus.running") }));
  head.push(t("projects.copyLog.head.started", { at: formatDateTime(job.startedAt ?? job.createdAt) }));
  head.push(
    job.finishedAt
      ? t("projects.copyLog.head.finished", { at: formatDateTime(job.finishedAt), duration: deployDuration(job, now) })
      : t("projects.copyLog.head.runningSince", { duration: deployDuration(job, now) }),
  );
  if (ctx.source) head.push(t("projects.copyLog.head.source", { source: ctx.source }));
  if (ctx.branch) head.push(t("projects.copyLog.head.branch", { branch: ctx.branch }));
  if (job.steps.length > 0) {
    head.push(t("projects.copyLog.head.steps", { steps: job.steps.map((s) => `${s.name} [${s.status}]`).join(" > ") }));
  }
  if (job.error) head.push(t("projects.copyLog.head.error", { error: stripLogControl(job.error) }));
  if (active) head.push(t("projects.copyLog.head.running"));

  const raw = job.log.replace(/\n+$/, "");
  const cutHistory = raw.startsWith(HISTORY_CUT_NOTE);
  const cutLimit = !cutHistory && job.log.length >= DEPLOY_LOG_MAX_CHARS;
  const body = stripLogControl(raw);
  const bodyLines = body === "" ? [] : body.split("\n");
  const out = [...head, ""];
  if (cutLimit) out.push(t("projects.copyLog.cutLimit", { limit: DEPLOY_LOG_MAX_CHARS }));
  if (bodyLines.length === 0) out.push(t("projects.copyLog.head.empty"));
  else out.push(...bodyLines);
  return { text: out.join("\n") + "\n", lines: bodyLines.length };
}
