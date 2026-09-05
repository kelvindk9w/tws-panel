/**
 * scanner.ts — executa os checks somente-leitura + integração com Lynis.
 * Spec: docs/security-research.md §3 (Lynis como motor de health-check) e §6.5.
 */
import { randomUUID } from "node:crypto";
import type { SecurityCheckResult, SecurityScanReport, SecurityScanSummary } from "@paas/core";
import { stripAnsi } from "./ansi.js";
import { parseSudoUsers, SECURITY_CHECKS } from "./checks.js";
import { LYNIS_CHECK_CMD, LYNIS_REPORT_CMD, LYNIS_RUN_CMD } from "./host-bridge.js";
import { partitionChecksForProfile, profileNote } from "./profiles.js";
import type { TargetRunner } from "./runner.js";

/** Check cuja saída revela os usuários não-root com sudo do alvo. */
const SUDO_USERS_CHECK_ID = "user.non-root-sudo";

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
  const available = await runner.exec(LYNIS_CHECK_CMD);
  if (available.code !== 0) return null;
  // --quick: sem prompts. Tolerante a falhas — o scan próprio já está pronto.
  await runner.exec(LYNIS_RUN_CMD, { timeoutMs: 300_000 });
  const report = await runner.exec(LYNIS_REPORT_CMD);
  const match = /hardening_index=(\d+)/.exec(report.stdout);
  return match?.[1] !== undefined ? Number.parseInt(match[1], 10) : null;
}

export interface SecurityScanOptions {
  /**
   * Telemetria de timing por check (id + duração em ms). NUNCA recebe saída
   * ou conteúdo do comando — só identificação e quanto tempo levou.
   */
  onCheckTiming?: (checkId: string, durationMs: number) => void;
}

export async function runSecurityScan(
  runner: TargetRunner,
  opts?: SecurityScanOptions,
): Promise<SecurityScanReport> {
  const startedAt = Date.now();
  await runner.ensureReady();

  // Perfil do alvo: no perfil "container" os checks de host são pulados e
  // documentados no relatório (falsos-positivos de contexto, não achados).
  const { run: applicableChecks, skipped } = partitionChecksForProfile(SECURITY_CHECKS, runner.profile);

  const checks: SecurityCheckResult[] = [];
  // Nomes dos usuários não-root com sudo descobertos no alvo. Preenchido a
  // partir da saída BRUTA do check "user.non-root-sudo" (o SecurityCheckResult
  // só carrega o `detail` legível) e só quando o check passa — se falhou, deu
  // unknown ou veio em formato inesperado, a lista fica vazia.
  let nonRootSudoUsers: string[] = [];
  for (const def of applicableChecks) {
    const checkStart = Date.now();
    let result: SecurityCheckResult;
    try {
      const r = await runner.exec(def.command, { timeoutMs: 60_000 });
      // Sanitização central: a saída vem de um PTY (visão dupla no terminal
      // web), então grep & cia. colorizam (--color=auto). Sem o strip, os
      // códigos ANSI vazam para o `detail` exibido como texto na UI.
      const evaluation = def.evaluate({ code: r.code, stdout: stripAnsi(r.stdout), stderr: stripAnsi(r.stderr) });
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
      if (def.id === SUDO_USERS_CHECK_ID && evaluation.status === "pass") {
        nonRootSudoUsers = parseSudoUsers(stripAnsi(r.stdout)).map((u) => u.name);
      }
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
    // Timing por check: introduzido na investigação da regressão de scan em
    // VPS (2.1s → 133.4s com um check travado ~120s) — permite identificar
    // na auditoria/log qual check segurou o scan.
    opts?.onCheckTiming?.(def.id, Date.now() - checkStart);
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
    profile: runner.profile,
    skippedChecks: skipped,
    profileNote: profileNote(runner.profile),
    nonRootSudoUsers,
  };
}
