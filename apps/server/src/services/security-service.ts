/**
 * security-service.ts — orquestra scan/plano/execução de segurança e persiste
 * o histórico em disco (data/security-history.json).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SECURITY_PHASES,
  type SecurityAppliedSummary,
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
import { TerminalRelayRunner } from "./terminal-runner.js";
import type { TerminalService } from "./terminal-service.js";

/** Callback de auditoria para comandos executados no host real. */
export type SecurityAuditHook = (action: string, detail: string) => void;

const MAX_HISTORY_ENTRIES = 200;

interface HistoryFile {
  entries: SecurityHistoryEntry[];
}

/**
 * Deriva o resumo "hardening aplicado" do histórico persistido. Regras:
 *  - só considera applies REAIS (dryRun=false); dry-runs não mudam o servidor;
 *  - o hardening conta como aplicado quando o ÚLTIMO apply real terminou em
 *    sucesso (se a última tentativa falhou/reverteu, o fluxo normal de
 *    scan → plano é o caminho seguro);
 *  - o "Antes" é o índice do último scan ANTERIOR ao primeiro apply real —
 *    congelado pelo histórico append-only, nunca recalculado (bug: o valor
 *    mudava entre renders porque o scan final sobrescrevia o relatório);
 *  - o "Depois" é o scan mais recente após o apply.
 */
export function buildAppliedSummary(entries: SecurityHistoryEntry[]): SecurityAppliedSummary | null {
  const isRealApply = (e: SecurityHistoryEntry) => e.kind === "job" && e.dryRun === false;
  const lastApply = entries.filter(isRealApply).at(-1);
  if (!lastApply || lastApply.status !== "success") return null;
  const firstApplyPos = entries.findIndex(isRealApply);
  const scansWithIndex = (list: SecurityHistoryEntry[]) =>
    list.filter((e) => e.kind === "scan" && typeof e.hardeningIndex === "number");
  const before = scansWithIndex(entries.slice(0, firstApplyPos)).at(-1);
  const after = scansWithIndex(entries.slice(firstApplyPos + 1)).at(-1);
  return {
    appliedAt: lastApply.at,
    beforeIndex: before?.hardeningIndex ?? null,
    beforeIndexSource: before?.hardeningIndexSource ?? null,
    afterIndex: after?.hardeningIndex ?? null,
    afterIndexSource: after?.hardeningIndexSource ?? null,
  };
}

export class SecurityService {
  private readonly config: ServerConfig;
  private readonly runner: TargetRunner;
  private readonly executor: SecurityExecutor;
  private readonly historyFile: string;
  private readonly log?: ((msg: string) => void) | undefined;
  private readonly lastReportFile: string;
  private lastScan: SecurityScanReport | null = null;
  private runningScan: Promise<SecurityScanReport> | null = null;

  constructor(
    config: ServerConfig,
    opts?: { audit?: SecurityAuditHook; terminal?: TerminalService; log?: (msg: string) => void },
  ) {
    this.config = config;
    this.log = opts?.log;
    // Alvo "host": host bridge (nsenter via helper privilegiado descartável) —
    // os comandos rodam na VPS real, NÃO no container do painel. Cada comando
    // passa pela allowlist e é registrado em auditoria.
    const baseRunner: TargetRunner =
      config.securityTarget === "host"
        ? new NsenterHostRunner({
            image: config.hostHelperImage,
            onAudit: (detail) => opts?.audit?.("hardening.host-exec", detail),
          })
        : new ContainerRunner({ name: config.securityTargetContainer });
    // Visão dupla: os scripts de fase (execStream) e os checks somente-leitura
    // do scanner (exec) rodam DENTRO do terminal web embutido — saída ao vivo
    // no xterm + prompts interativos respondidos pelo usuário direto no
    // terminal. Fallback ao runner direto se o PTY estiver indisponível.
    this.runner = opts?.terminal
      ? new TerminalRelayRunner(baseRunner, opts.terminal, {
          onAudit:
            config.securityTarget === "host"
              ? (detail) => opts?.audit?.("hardening.host-exec", detail)
              : undefined,
        })
      : baseRunner;
    // O PTY do modo dev (container alvo) precisa do container de pé.
    opts?.terminal?.setEnsureTarget(() => baseRunner.ensureReady());
    this.historyFile = path.join(config.dataDir, "security-history.json");
    this.lastReportFile = path.join(config.dataDir, "security-last-scan.json");
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

  /**
   * Scan de segurança.
   *
   * Sem `force` NUNCA executa varredura nova: devolve imediatamente o último
   * relatório conhecido (memória → disco). Antes desta correção, um cache de
   * 60s fazia o GET sem `fresh` disparar um scan completo (~2 min com Lynis)
   * sempre que o cache expirava — a página Segurança ficava "Carregando…".
   * Scan fresco só com `force` (?fresh=1) ou pelo agendador; se um scan já
   * estiver em andamento, a resposta traz o último relatório + refreshing.
   */
  async scan(
    force = false,
  ): Promise<{ report: SecurityScanReport; cached: boolean; refreshing: boolean }> {
    if (!force) {
      const known = this.lastScan ?? (await this.loadLastReport());
      if (known) {
        return { report: known, cached: true, refreshing: this.runningScan !== null };
      }
      // Sem relatório nenhum (primeiro uso): executa o scan — a UI mostra
      // o estado de carregamento só neste caso.
    }
    // evita scans concorrentes (dois refreshes simultâneos)
    this.runningScan ??= runSecurityScan(this.runner, {
      // Log de timing por check (nível info, NUNCA conteúdo/saída) —
      // introduzido na investigação da regressão de scan em VPS (2.1s →
      // 133.4s): mostra qual check segurou o scan e por quanto tempo.
      onCheckTiming: (checkId, durationMs) => {
        this.log?.(`scan de segurança: check ${checkId} concluído em ${durationMs}ms`);
      },
    })
      .then(async (report) => {
        this.lastScan = report;
        // persistidos ANTES de resolver: um restart logo após o scan ainda
        // encontra o relatório (o GET sem fresh nunca bloqueia).
        await this.recordScan(report);
        await this.persistLastReport(report);
        return report;
      })
      .finally(() => {
        this.runningScan = null;
      });
    return { report: await this.runningScan, cached: false, refreshing: false };
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

  /** Histórico + comparação de índice antes/depois + resumo "aplicado". */
  async history(): Promise<{
    entries: SecurityHistoryEntry[];
    firstIndex: number | null;
    latestIndex: number | null;
    applied: SecurityAppliedSummary | null;
  }> {
    const entries = await this.loadHistory();
    const scanIndexes = entries
      .filter((e) => e.kind === "scan" && typeof e.hardeningIndex === "number")
      .map((e) => e.hardeningIndex as number);
    return {
      entries,
      firstIndex: scanIndexes.length > 0 ? (scanIndexes[0] ?? null) : null,
      latestIndex: scanIndexes.length > 0 ? (scanIndexes[scanIndexes.length - 1] ?? null) : null,
      applied: buildAppliedSummary(entries),
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
      hardeningIndexSource: report.hardeningIndexSource,
    });
  }

  /** Persiste o relatório completo (sobrevive a restart do painel). Best-effort. */
  private async persistLastReport(report: SecurityScanReport): Promise<void> {
    try {
      await mkdir(path.dirname(this.lastReportFile), { recursive: true });
      await writeFile(this.lastReportFile, JSON.stringify(report, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      // cache em disco é best-effort; nunca derruba a requisição
    }
  }

  /** Carrega o último relatório persistido (primeiro acesso após restart). */
  private async loadLastReport(): Promise<SecurityScanReport | null> {
    try {
      const raw = await readFile(this.lastReportFile, "utf8");
      const parsed = JSON.parse(raw) as Partial<SecurityScanReport>;
      if (typeof parsed.id !== "string" || typeof parsed.scannedAt !== "string") return null;
      this.lastScan = parsed as SecurityScanReport;
      return this.lastScan;
    } catch {
      return null;
    }
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
