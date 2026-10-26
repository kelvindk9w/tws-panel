/**
 * metrics-levels.ts — semáforo (ok / atenção / crítico / sem dados) de cada
 * indicador do painel. Puro. Os limiares seguem a pesquisa do lote
 * (comoFuncionaSistema/metricas): pressão (PSI) e "disponível" dizem mais
 * que "% usada" (o Linux enche a RAM de cache de propósito).
 */
import { METRICS_LEVELS, type HealthLevel, type ProjectProblemReason } from "@paas/core";

export const LEVELS = METRICS_LEVELS;

const rank: Record<HealthLevel, number> = { unknown: 0, ok: 1, warning: 2, critical: 3 };
const worst = (...levels: HealthLevel[]): HealthLevel => levels.reduce((a, b) => (rank[b] > rank[a] ? b : a), "ok" as HealthLevel);
const known = (...values: Array<number | null | undefined>) => values.some((v) => v !== null && v !== undefined);

export function cpuLevel(v: { busy: number | null; steal: number | null; psi: number | null }): HealthLevel {
  if (!known(v.busy, v.steal, v.psi)) return "unknown";
  const out: HealthLevel[] = ["ok"];
  if (v.steal !== null) out.push(v.steal >= LEVELS.stealCritical ? "critical" : v.steal >= LEVELS.stealWarn ? "warning" : "ok");
  if (v.psi !== null) out.push(v.psi >= LEVELS.psiCritical ? "critical" : v.psi >= LEVELS.psiWarn ? "warning" : "ok");
  if (v.psi === null && v.busy !== null && v.busy >= LEVELS.cpuBusyWarn) out.push("warning");
  return worst(...out);
}

export function memoryLevel(v: { availPct: number | null; psi: number | null; oomKills24h: number }): HealthLevel {
  if (v.oomKills24h > 0) return "critical";
  if (!known(v.availPct, v.psi)) return "unknown";
  const out: HealthLevel[] = ["ok"];
  if (v.psi !== null) out.push(v.psi >= LEVELS.memPsiCritical ? "critical" : v.psi >= LEVELS.memPsiWarn ? "warning" : "ok");
  if (v.availPct !== null) out.push(v.availPct < LEVELS.memAvailCritical ? "critical" : v.availPct < LEVELS.memAvailWarn ? "warning" : "ok");
  return worst(...out);
}

export function diskLevel(v: { pct: number | null; inodePct: number | null; daysToFull: { low: number; high: number } | null }): HealthLevel {
  if (!known(v.pct, v.inodePct)) return "unknown";
  const byPct = (p: number | null): HealthLevel => (p === null ? "ok" : p >= LEVELS.diskCritical ? "critical" : p >= LEVELS.diskWarn ? "warning" : "ok");
  const byDays: HealthLevel =
    v.daysToFull === null ? "ok" : v.daysToFull.low < LEVELS.fullDaysCritical ? "critical" : v.daysToFull.low < LEVELS.fullDaysWarn ? "warning" : "ok";
  return worst(byPct(v.pct), byPct(v.inodePct), byDays);
}

/** Rede é informativa: sem selo de problema, só "sem dados" quando não mediu. */
export function networkLevel(v: { rx: number | null; tx: number | null }): HealthLevel {
  return known(v.rx, v.tx) ? "ok" : "unknown";
}

const CRITICAL_REASONS: ReadonlySet<ProjectProblemReason> = new Set(["restarting", "dead", "restart_loop", "oom"]);

export function projectsLevel(v: { measured: boolean; problems: Array<{ reasons: ProjectProblemReason[] }> }): HealthLevel {
  if (!v.measured) return "unknown";
  if (v.problems.length === 0) return "ok";
  return v.problems.some((p) => p.reasons.some((r) => CRITICAL_REASONS.has(r))) ? "critical" : "warning";
}

/** Certificados e backups: problema de certificado ou falha de backup é crítico; backup só na VPS é atenção. */
export function protectionsLevel(v: {
  certificates: { total: number; problems: number } | null;
  backups: { destinationConnected: boolean; lastFailure: boolean } | null;
}): HealthLevel {
  if (v.certificates === null && v.backups === null) return "unknown";
  if ((v.certificates?.problems ?? 0) > 0 || v.backups?.lastFailure === true) return "critical";
  if (v.backups !== null && !v.backups.destinationConnected) return "warning";
  return "ok";
}
