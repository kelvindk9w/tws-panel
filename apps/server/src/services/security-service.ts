/**
 * security-service.ts — orquestra scan/plano/execução de segurança e persiste
 * o histórico em disco (data/security-history.json).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SECURITY_SCAN_CACHE_MS,
  type SecurityHistoryEntry,
  type SecurityJob,
  type SecurityPhaseId,
  type SecurityPlan,
  type SecurityScanReport,
} from "@paas/core";
import {
  ContainerRunner,
  HostRunner,
  SecurityExecutor,
  buildSecurityPlan,
  runSecurityScan,
  type TargetRunner,
} from "@paas/security";
import type { ServerConfig } from "../config.js";

const MAX_HISTORY_ENTRIES = 200;

interface HistoryFile {
  entries: SecurityHistoryEntry[];
}

export class SecurityService {
  private readonly runner: TargetRunner;
  private readonly executor: SecurityExecutor;
  private readonly historyFile: string;
  private lastScan: SecurityScanReport | null = null;
  private lastScanAt = 0;
  private runningScan: Promise<SecurityScanReport> | null = null;

  constructor(config: ServerConfig) {
    this.runner =
      config.securityTarget === "host"
        ? new HostRunner()
        : new ContainerRunner({ name: config.securityTargetContainer });
    this.historyFile = path.join(config.dataDir, "security-history.json");
    this.executor = new SecurityExecutor({
      runner: this.runner,
      scriptsDir: config.hardeningScriptsDir,
      onChange: (job) => {
        // persiste ao finalizar (qualquer status terminal)
        if (["success", "failed", "rolled_back"].includes(job.status)) {
          void this.recordJob(job);
        }
      },
    });
  }

  get targetLabel(): string {
    return this.runner.label;
  }

  /** Scan com cache de 60s (refresh da UI não re-executa tudo). */
  async scan(force = false): Promise<{ report: SecurityScanReport; cached: boolean }> {
    const now = Date.now();
    if (!force && this.lastScan && now - this.lastScanAt < SECURITY_SCAN_CACHE_MS) {
      return { report: this.lastScan, cached: true };
    }
    // evita scans concorrentes (dois refreshes simultâneos)
    this.runningScan ??= runSecurityScan(this.runner)
      .then((report) => {
        this.lastScan = report;
        this.lastScanAt = Date.now();
        void this.recordScan(report);
        return report;
      })
      .finally(() => {
        this.runningScan = null;
      });
    return { report: await this.runningScan, cached: false };
  }

  /** Plano de correção baseado no último scan (faz um scan se não houver). */
  async plan(): Promise<SecurityPlan> {
    const { report } = await this.scan();
    return buildSecurityPlan(report);
  }

  /** Inicia job de aplicação de uma fase (assíncrono). */
  async apply(phase: SecurityPhaseId, dryRun: boolean): Promise<SecurityJob> {
    return this.executor.startJob(phase, dryRun);
  }

  getJob(id: string): SecurityJob | null {
    return this.executor.getJob(id);
  }

  async confirmAccess(jobId: string): Promise<SecurityJob> {
    return this.executor.confirmAccess(jobId);
  }

  /** Histórico + comparação de índice antes/depois. */
  async history(): Promise<{
    entries: SecurityHistoryEntry[];
    firstIndex: number | null;
    latestIndex: number | null;
  }> {
    const entries = await this.loadHistory();
    const scanIndexes = entries
      .filter((e) => e.kind === "scan" && typeof e.hardeningIndex === "number")
      .map((e) => e.hardeningIndex as number);
    return {
      entries,
      firstIndex: scanIndexes.length > 0 ? (scanIndexes[0] ?? null) : null,
      latestIndex: scanIndexes.length > 0 ? (scanIndexes[scanIndexes.length - 1] ?? null) : null,
    };
  }

  // -------------------------------------------------------------------------

  private async loadHistory(): Promise<SecurityHistoryEntry[]> {
    try {
      const raw = await readFile(this.historyFile, "utf8");
      const parsed = JSON.parse(raw) as Partial<HistoryFile>;
      return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      return [];
    }
  }

  private async appendHistory(entry: SecurityHistoryEntry): Promise<void> {
    try {
      const entries = await this.loadHistory();
      entries.push(entry);
      const trimmed = entries.slice(-MAX_HISTORY_ENTRIES);
      await mkdir(path.dirname(this.historyFile), { recursive: true });
      await writeFile(this.historyFile, JSON.stringify({ entries: trimmed }, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      // histórico é best-effort; nunca derruba a requisição
    }
  }

  private async recordScan(report: SecurityScanReport): Promise<void> {
    await this.appendHistory({
      id: report.id,
      at: report.scannedAt,
      kind: "scan",
      hardeningIndex: report.hardeningIndex,
    });
  }

  private async recordJob(job: SecurityJob): Promise<void> {
    await this.appendHistory({
      id: job.id,
      at: job.finishedAt ?? new Date().toISOString(),
      kind: "job",
      phase: job.phase,
      dryRun: job.dryRun,
      status: job.status,
    });
  }
}
