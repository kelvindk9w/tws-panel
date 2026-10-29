import { DEPLOY_LOG_MAX_CHARS, type DeployJob, DeployJobStartup, DeployJobStep } from "@paas/core";
import { formatDateTime as formatLocaleDateTime, formatNumber, t } from "@/i18n";

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
      .map((l) => {
        // "\r" no fim não apaga a linha (como no terminal); só vale o último trecho com texto
        const kept = l.replace(/\r+$/, "");
        return kept.slice(kept.lastIndexOf("\r") + 1);
      })
      .join("\n")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
  );
}

const HISTORY_CUT_NOTE = "[… log antigo reduzido";

/** Data com fuso ("29/10/2026 10:00:00 GMT-3"): quem lê o texto copiado não sabe o fuso de quem copiou. */
function dateWithZone(iso: string): string {
  return formatLocaleDateTime(iso, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" });
}

/** URL de repositório sem usuário/senha/token (https://, ssh:// e scp-like git@host:repo); null se não der para analisar. */
export function safeGitSource(source: string): string | null {
  const text = source.trim();
  try {
    const url = new URL(text);
    if (url.host) {
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    }
  } catch {
    // não é URL: tenta o formato scp-like (usuario@host:caminho)
  }
  // userinfo com ":" (usuario:token@) ou "@" no caminho podem esconder credencial: omite a origem
  const scp = /^(?:[^@/:\s]+@)?([A-Za-z0-9.-]+):(?!\/\/)([^@\s]+)$/.exec(text);
  return scp ? `${scp[1]}:${scp[2]}` : null;
}

/**
 * Texto do botão "Copiar histórico": cabeçalho para diagnóstico + o log inteiro
 * do servidor, sem cores. O log é copiado como a tela o mostra: a rota do job NÃO
 * mascara segredos (isso vale só para os logs dos containers), então nada aqui
 * passa a proteger o que o log já traz. A origem do projeto é nova no texto e por
 * isso é limpa de credenciais. `stale` avisa que veio da tela, sem nova busca.
 */
export function buildDeployHistoryText(
  job: DeployJob,
  ctx: { projectName?: string; ingestMode?: string; source?: string; branch?: string; stale?: boolean } = {},
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
  head.push(t("projects.copyLog.head.status", { status: job.status === "queued" ? t("projects.copyLog.head.statusQueued") : t(`projects.jobStatus.${active ? "running" : job.status}` as "projects.jobStatus.running") }));
  head.push(t("projects.copyLog.head.started", { at: dateWithZone(job.startedAt ?? job.createdAt) }));
  head.push(
    job.finishedAt
      ? t("projects.copyLog.head.finished", { at: dateWithZone(job.finishedAt), duration: deployDuration(job, now) })
      : t("projects.copyLog.head.runningSince", { duration: deployDuration(job, now) }),
  );
  if (ctx.ingestMode === "git") {
    const source = ctx.source ? safeGitSource(ctx.source) : null;
    if (source) head.push(t("projects.copyLog.head.source", { source }));
  } else if (ctx.ingestMode === "upload" || ctx.ingestMode === "existing") {
    // caminho da VPS não vai para o texto: só o tipo de origem
    head.push(t("projects.copyLog.head.source", { source: t(ctx.ingestMode === "upload" ? "projects.copyLog.head.sourceUpload" : "projects.copyLog.head.sourceExisting") }));
  }
  if (ctx.branch) head.push(t("projects.copyLog.head.branch", { branch: ctx.branch }));
  if (job.steps.length > 0) {
    head.push(t("projects.copyLog.head.steps", { steps: job.steps.map((s) => `${s.name} [${s.status}]`).join(" > ") }));
  }
  if (job.error) head.push(t("projects.copyLog.head.error", { error: stripLogControl(job.error) }));
  if (active) head.push(t("projects.copyLog.head.running"));
  if (ctx.stale) head.push(t("projects.copyLog.head.stale"));

  let raw = job.log.replace(/\n+$/, "");
  // a nota do servidor vem sempre em pt-BR: troca pela do idioma da tela
  const cutHistory = raw.startsWith(HISTORY_CUT_NOTE);
  if (cutHistory) raw = raw.includes("\n") ? raw.slice(raw.indexOf("\n") + 1) : "";
  const cutLimit = !cutHistory && job.log.length >= DEPLOY_LOG_MAX_CHARS;
  const body = stripLogControl(raw);
  const bodyLines = body === "" ? [] : body.split("\n");
  const out = [...head, ""];
  if (cutHistory) out.push(t("projects.copyLog.cutHistory"));
  if (cutLimit) out.push(t("projects.copyLog.cutLimit", { limit: formatNumber(DEPLOY_LOG_MAX_CHARS) }));
  if (bodyLines.length === 0) out.push(t("projects.copyLog.head.empty"));
  else out.push(...bodyLines);
  return { text: out.join("\n") + "\n", lines: bodyLines.length };
}
