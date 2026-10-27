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
export const DEPLOY_HISTORY_TOTAL_LIMITS = { min: 100, max: 3000 } as const;

/** Deploys por projeto que guardam o log inteiro (os que a tela lista); os mais antigos guardam só o final. */
export const DEPLOY_LOG_FULL_PER_PROJECT = 20;
/** Quanto do final do log os deploys antigos guardam. */
export const DEPLOY_LOG_TAIL_CHARS = 12_000;
/** Teto de caracteres de log em todos os deploys juntos (o arquivo é reescrito inteiro a cada deploy). */
export const DEPLOY_LOG_TOTAL_CHARS = 48_000_000;
const LOG_CUT_NOTE = "[… log antigo reduzido: só o final foi guardado …]\n";

export interface DeployHistoryLimits {
  perProject: number;
  total: number;
  /** Teto de caracteres de log no total (padrão DEPLOY_LOG_TOTAL_CHARS). */
  logChars?: number;
  /** Deploys por projeto com o log inteiro (padrão DEPLOY_LOG_FULL_PER_PROJECT). */
  fullLogs?: number;
  /** Final guardado dos logs reduzidos (padrão DEPLOY_LOG_TAIL_CHARS). */
  tailChars?: number;
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
  const remaining = drop.size === 0 ? (jobs as DeployJob[]) : jobs.filter((j) => !drop.has(j));
  return capLogs(remaining, limits);
}

const cutLog = (j: DeployJob, tail: number): DeployJob => (j.log.length <= tail ? j : { ...j, log: LOG_CUT_NOTE + j.log.slice(-tail) });

/**
 * Limita o tamanho do arquivo: o log inteiro fica só nos N deploys mais recentes de cada projeto (o que a tela lista);
 * os mais antigos guardam o final. Se o total de log ainda passar do teto, reduz os mais antigos primeiro e, em último
 * caso, tira os deploys mais antigos. Os metadados (horário, etapas, status) seguem até os tetos de quantidade.
 * Deploy em andamento nunca é mexido. Devolve a MESMA lista se nada mudou.
 */
function capLogs(jobs: DeployJob[], limits: DeployHistoryLimits): DeployJob[] {
  const full = limits.fullLogs ?? DEPLOY_LOG_FULL_PER_PROJECT;
  const tail = limits.tailChars ?? DEPLOY_LOG_TAIL_CHARS;
  const maxChars = limits.logChars ?? DEPLOY_LOG_TOTAL_CHARS;
  const seen = new Map<string, number>();
  const rank = new Map<DeployJob, number>(); // 0 = o mais recente do projeto
  for (let i = jobs.length - 1; i >= 0; i--) {
    const j = jobs[i]!;
    const n = seen.get(j.projectId) ?? 0;
    seen.set(j.projectId, n + 1);
    rank.set(j, n);
  }
  let out = jobs.map((j) => (removable(j) && rank.get(j)! >= full ? cutLog(j, tail) : j));
  let total = out.reduce((n, j) => n + j.log.length, 0);
  // ainda acima do teto: reduz os logs inteiros, do mais antigo para o mais novo
  for (let i = 0; i < out.length && total > maxChars; i++) {
    const j = out[i]!;
    if (!removable(j) || j.log.length <= tail) continue;
    const cut = cutLog(j, tail);
    total -= j.log.length - cut.log.length;
    out[i] = cut;
  }
  // por fim, tira deploys inteiros (os mais antigos que podem sair)
  for (let i = 0; i < out.length && total > maxChars; ) {
    const j = out[i]!;
    if (removable(j)) {
      total -= j.log.length;
      out = out.filter((_, k) => k !== i);
    } else i++;
  }
  return out.length === jobs.length && out.every((j, i) => j === jobs[i]) ? jobs : out;
}

/** Entrada do arquivo de histórico que dá para usar (objeto com id, projeto e log em texto); o resto é descartado. */
export function validJob(raw: unknown): raw is DeployJob {
  if (typeof raw !== "object" || raw === null) return false;
  const j = raw as Partial<DeployJob>;
  return typeof j.id === "string" && typeof j.projectId === "string" && typeof j.log === "string" && typeof j.status === "string";
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
