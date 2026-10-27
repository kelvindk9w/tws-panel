/**
 * deploy-jobs.ts — regras puras do histórico de deploys (sem disco, sem Docker).
 *
 *  - teto por projeto + teto geral de segurança (antes era um teto geral de 100: um projeto movimentado
 *    empurrava para fora o histórico dos outros);
 *  - horário de início e fim de cada etapa;
 *  - tempo de subida de cada serviço ligado ao deploy que o causou.
 */
import type { DeployJob, DeployJobStartup, DeployJobStep, StartupRecord } from "@paas/core";

/** Deploys guardados por projeto. O padrão é o antigo teto geral: quem tinha até 100 no total nunca perde nenhum. */
export const DEPLOY_HISTORY_PER_PROJECT_DEFAULT = 100;
export const DEPLOY_HISTORY_PER_PROJECT_LIMITS = { min: 5, max: 500 } as const;
/** Teto geral de segurança (o arquivo não cresce sem limite, mesmo com muitos projetos). */
export const DEPLOY_HISTORY_TOTAL_DEFAULT = 1000;
export const DEPLOY_HISTORY_TOTAL_LIMITS = { min: 100, max: 10_000 } as const;

export interface DeployHistoryLimits {
  perProject: number;
  total: number;
}

const removable = (j: DeployJob) => j.status !== "running" && j.status !== "queued";

/**
 * Corta o histórico: no máximo `perProject` por projeto (os mais novos ficam) e, se o total ainda passar
 * de `total`, tira o mais antigo do projeto que tem mais deploys guardados (a divisão fica justa).
 * Deploy em andamento nunca é cortado. Mantém a ordem original e devolve a MESMA lista se nada saiu.
 */
export function trimJobs(jobs: readonly DeployJob[], limits: DeployHistoryLimits): DeployJob[] {
  const drop = new Set<DeployJob>();
  const kept = new Map<string, DeployJob[]>();
  for (const j of jobs) kept.set(j.projectId, [...(kept.get(j.projectId) ?? []), j]);
  const dropOldest = (list: DeployJob[]): boolean => {
    const at = list.findIndex(removable);
    if (at === -1) return false;
    drop.add(list[at]!);
    list.splice(at, 1);
    return true;
  };
  for (const list of kept.values()) while (list.length > limits.perProject && dropOldest(list));
  let total = [...kept.values()].reduce((n, l) => n + l.length, 0);
  while (total > limits.total) {
    const fattest = [...kept.values()].filter((l) => l.some(removable)).sort((a, b) => b.length - a.length)[0];
    if (!fattest) break; // só sobrou deploy em andamento
    dropOldest(fattest);
    total--;
  }
  return drop.size === 0 ? (jobs as DeployJob[]) : jobs.filter((j) => !drop.has(j));
}

/** Lê um inteiro de limite do ambiente; ausente ou fora da faixa = padrão (nunca derruba a subida). */
export function historyLimitFromEnv(raw: string | undefined, def: number, range: { min: number; max: number }): number {
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= range.min && n <= range.max ? n : def;
}

/**
 * Marca a etapa `current` (0-based) como em andamento, as anteriores como concluídas e as seguintes como
 * não iniciadas, guardando o horário em que cada uma começou e terminou (sem sobrescrever o que já tem).
 */
export function advanceSteps(steps: readonly DeployJobStep[], current: number, nowIso: string): DeployJobStep[] {
  return steps.map((step, i) => {
    const status: DeployJobStep["status"] = i < current ? "done" : i === current ? "running" : "skipped";
    const startedAt = step.startedAt ?? (status === "skipped" ? undefined : nowIso);
    const finishedAt = step.finishedAt ?? (status === "done" ? nowIso : undefined);
    return { name: step.name, status, ...(startedAt ? { startedAt } : {}), ...(finishedAt ? { finishedAt } : {}) };
  });
}

/** Fim do deploy: etapas ainda em andamento terminam (concluídas ou falhas) no horário do fim. */
export function finishSteps(steps: readonly DeployJobStep[], ok: boolean, nowIso: string): DeployJobStep[] {
  return steps.map((step) => (step.status === "running" ? { ...step, status: ok ? "done" : "failed", finishedAt: step.finishedAt ?? nowIso } : step));
}

/** Quanto tempo depois do fim do deploy ainda se liga uma subida a ele (a coleta nota a subida depois do health check). */
export const STARTUP_ATTACH_GRACE_MS = 10 * 60_000;

/**
 * Tempo de subida por serviço de cada deploy: containers que começaram entre o início do deploy e 10 minutos
 * depois do fim (ou até agora, se ainda roda). O mais lento de cada serviço representa o deploy (réplicas).
 */
export function attachStartups(jobs: readonly DeployJob[], records: readonly StartupRecord[], nowMs: number): DeployJob[] {
  return jobs.map((job) => {
    const from = job.startedAt === null ? Number.NaN : Date.parse(job.startedAt);
    if (!Number.isFinite(from)) return job;
    const until = job.finishedAt === null ? nowMs : Date.parse(job.finishedAt) + STARTUP_ATTACH_GRACE_MS;
    const bySvc = new Map<string, DeployJobStartup>();
    for (const r of records) {
      const at = Date.parse(r.startedAt);
      if (!Number.isFinite(at) || at < from || at > until) continue;
      const prev = bySvc.get(r.service);
      if (!prev || r.seconds > prev.seconds) bySvc.set(r.service, { service: r.service, seconds: r.seconds, via: r.via, approx: r.approx });
    }
    return bySvc.size === 0 ? job : { ...job, startups: [...bySvc.values()].sort((a, b) => a.service.localeCompare(b.service)) };
  });
}
