/**
 * scanner.ts — executa os checks somente-leitura + integração com Lynis.
 * Spec: docs/security-research.md §3 (Lynis como motor de health-check) e §6.5.
 */
import { randomUUID } from "node:crypto";
import type { SecurityCheckResult, SecurityScanReport, SecurityScanSummary } from "@paas/core";
import { SECURITY_CHECKS } from "./checks.js";
import type { TargetRunner } from "./runner.js";

const SEVERITY_WEIGHT = { critical: 3, warning: 2, info: 1 } as const;

/** Índice interno 0-100 quando o Lynis não está disponível. */
function internalIndex(checks: SecurityCheckResult[]): number {
  let total = 0;
  let earned = 0;
  for (const c of checks) {
    const w = SEVERITY_WEIGHT[c.severity];
    total += w;
    if (c.status === "pass") earned += w;
    else if (c.status === "unknown") earned += w * 0.5;
  }
  return total === 0 ? 0 : Math.round((earned / total) * 100);
}

function summarize(checks: SecurityCheckResult[]): SecurityScanSummary {
  const s: SecurityScanSummary = { total: checks.length, pass: 0, fail: 0, unknown: 0, critical: 0, warning: 0 };
  for (const c of checks) {
    s[c.status] += 1;
    if (c.status === "fail") {
      if (c.severity === "critical") s.critical += 1;
      if (c.severity === "warning") s.warning += 1;
    }
  }
  return s;
}

/** Roda `lynis audit system --quick` e extrai o Hardening Index do relatório. */
async function lynisIndex(runner: TargetRunner): Promise<number | null> {
  const available = await runner.exec("command -v lynis >/dev/null 2>&1");
  if (available.code !== 0) return null;
  // --quick: sem prompts. Tolerante a falhas — o scan próprio já está pronto.
  await runner.exec("lynis audit system --quick >/dev/null 2>&1 || true", { timeoutMs: 300_000 });
  const report = await runner.exec(
    "grep -E '^hardening_index=' /var/log/lynis-report.dat 2>/dev/null | tail -1",
  );
  const match = /hardening_index=(\d+)/.exec(report.stdout);
  return match?.[1] !== undefined ? Number.parseInt(match[1], 10) : null;
}

export async function runSecurityScan(runner: TargetRunner): Promise<SecurityScanReport> {
  const startedAt = Date.now();
  await runner.ensureReady();

  const checks: SecurityCheckResult[] = [];
  for (const def of SECURITY_CHECKS) {
    let result: SecurityCheckResult;
    try {
      const r = await runner.exec(def.command, { timeoutMs: 60_000 });
      const evaluation = def.evaluate(r);
      result = {
        id: def.id,
        phase: def.phase,
        title: def.title,
        severity: def.severity,
        status: evaluation.status,
        description: def.description,
        remediation: def.remediation,
        ...(evaluation.detail !== undefined ? { detail: evaluation.detail } : {}),
      };
    } catch (err) {
      result = {
        id: def.id,
        phase: def.phase,
        title: def.title,
        severity: def.severity,
        status: "unknown",
        description: def.description,
        remediation: def.remediation,
        detail: `erro ao executar check: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    checks.push(result);
  }

  const lynis = await lynisIndex(runner).catch(() => null);

  return {
    id: randomUUID(),
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    target: runner.label,
    hardeningIndex: lynis ?? internalIndex(checks),
    hardeningIndexSource: lynis !== null ? "lynis" : "internal",
    lynisAvailable: lynis !== null,
    checks,
    summary: summarize(checks),
  };
}
