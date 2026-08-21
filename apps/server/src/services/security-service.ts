/**
 * security-service.ts — orquestra scan/plano/execução de segurança e persiste
 * o histórico em disco (data/security-history.json).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SECURITY_PHASES,
  SECURITY_SCAN_CACHE_MS,
  type SecurityHistoryEntry,
  type SecurityJob,
  type SecurityManualCommandsResponse,
  type SecurityPhaseId,
  type SecurityPlan,
  type SecurityScanReport,
} from "@paas/core";
import {
  ContainerRunner,
  NsenterHostRunner,
  SecurityExecutor,
  buildSecurityPlan,
  runSecurityScan,
  type PhaseParams,
  type TargetRunner,
} from "@paas/security";
import type { ServerConfig } from "../config.js";

/** Callback de auditoria para comandos executados no host real. */
export type SecurityAuditHook = (action: string, detail: string) => void;

const MAX_HISTORY_ENTRIES = 200;

interface HistoryFile {
  entries: SecurityHistoryEntry[];
}

export class SecurityService {
  private readonly config: ServerConfig;
  private readonly runner: TargetRunner;
  private readonly executor: SecurityExecutor;
  private readonly historyFile: string;
  private lastScan: SecurityScanReport | null = null;
  private lastScanAt = 0;
  private runningScan: Promise<SecurityScanReport> | null = null;

  constructor(config: ServerConfig, opts?: { audit?: SecurityAuditHook }) {
    this.config = config;
    // Alvo "host": host bridge (nsenter via helper privilegiado descartável) —
    // os comandos rodam na VPS real, NÃO no container do painel. Cada comando
    // passa pela allowlist e é registrado em auditoria.
    this.runner =
      config.securityTarget === "host"
        ? new NsenterHostRunner({
            image: config.hostHelperImage,
            onAudit: (detail) => opts?.audit?.("hardening.host-exec", detail),
          })
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
  async apply(phase: SecurityPhaseId, dryRun: boolean, params?: PhaseParams): Promise<SecurityJob> {
    return this.executor.startJob(phase, dryRun, params);
  }

  getJob(id: string): SecurityJob | null {
    return this.executor.getJob(id);
  }

  /**
   * Modo manual: comandos exatos (copiáveis) para o operador executar a fase
   * por conta própria no alvo + o conteúdo do script para conferência.
   */
  async manualCommands(phase: SecurityPhaseId): Promise<SecurityManualCommandsResponse> {
    const phaseDef = SECURITY_PHASES.find((p) => p.id === phase);
    if (!phaseDef) throw new Error(`fase desconhecida: ${phase}`);
    const scriptContent = await readFile(path.join(this.config.hardeningScriptsDir, phaseDef.script), "utf8");

    const notes: string[] = [
      "Adicione --dry-run para simular sem alterar nada e --rollback para desfazer.",
    ];
    let commands: string[];
    if (this.config.securityTarget === "host") {
      const scriptPath = `${this.config.hostRepoDir}/scripts/hardening/${phaseDef.script}`;
      commands = [`sudo bash ${scriptPath}`];
      notes.push(`Os scripts ficam no checkout do repo no host (${this.config.hostRepoDir}).`);
      if (phase === "01") {
        commands = [
          `sudo bash ${scriptPath} --user SEU_USUARIO --pubkey 'ssh-ed25519 AAAA... seu-comentario'`,
        ];
        notes.push("Sem chave SSH instalada, o script NÃO trava o root (proteção anti-lockout).");
      }
      if (phase === "01" || phase === "02" || phase === "03") {
        commands.push(`sudo bash ${scriptPath} --confirm`);
        notes.push(
          "Esta fase agenda rollback automático de 5 min: teste o acesso e rode --confirm para manter a configuração.",
        );
      }
    } else {
      const target = this.config.securityTargetContainer;
      commands = [`docker exec ${target} bash /opt/paas-hardening/${phaseDef.script}`];
      notes.push(
        `Alvo de dev (container ${target}): os scripts são enviados a /opt/paas-hardening quando um job roda; ` +
          `para enviar manualmente: docker cp <repo>/scripts/hardening/. ${target}:/opt/paas-hardening/`,
      );
    }

    return {
      phase: phaseDef.id,
      phaseKey: phaseDef.key,
      title: phaseDef.title,
      script: phaseDef.script,
      commands,
      scriptContent,
      notes,
    };
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
