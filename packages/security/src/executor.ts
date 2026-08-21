/**
 * executor.ts — executa as fases de hardening como jobs assíncronos.
 *
 * Garantias:
 *  - um job por vez (mutex) — hardening concorrente é receita para lockout;
 *  - log completo por passo (marcadores :::PAAS_STEP emitidos pelos scripts);
 *  - rollback automático imediato em caso de falha (script --rollback);
 *  - fases de risco (SSH/firewall) ficam "awaiting_confirmation" até o operador
 *    confirmar acesso; o rollback agendado NO ALVO (at/timer de 5 min) reverte
 *    sozinho se ninguém confirmar — o executor apenas reflete o estado.
 */
import { randomUUID } from "node:crypto";
import {
  RISKY_PHASES,
  SECURITY_PHASES,
  SECURITY_ROLLBACK_WINDOW_MS,
  type SecurityJob,
  type SecurityJobStep,
  type SecurityPhaseId,
} from "@paas/core";
import type { TargetRunner } from "./runner.js";
import { buildPhaseScriptCommand } from "./host-bridge.js";

const MAX_LOG_CHARS = 500_000;

/** Parâmetros opcionais de uma fase (Fase 01: usuário/chave SSH do operador). */
export interface PhaseParams {
  sshUser?: string;
  sshPublicKey?: string;
}

export interface ExecutorOptions {
  runner: TargetRunner;
  /** Diretório local com os scripts de hardening (scripts/hardening). */
  scriptsDir: string;
  /** Diretório remoto para onde os scripts são copiados (modo container). */
  remoteDir?: string;
  /** Janela do rollback agendado — default 5 min (alinhado aos scripts). */
  rollbackWindowMs?: number;
  /** Chamado a cada mudança de estado do job (para persistência). */
  onChange?: (job: SecurityJob) => void;
}

export class SecurityExecutor {
  private readonly runner: TargetRunner;
  private readonly scriptsDir: string;
  private readonly remoteDir: string;
  private readonly rollbackWindowMs: number;
  private readonly onChange?: ((job: SecurityJob) => void) | undefined;
  private readonly jobs = new Map<string, SecurityJob>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private busy = false;

  constructor(opts: ExecutorOptions) {
    this.runner = opts.runner;
    this.scriptsDir = opts.scriptsDir;
    this.remoteDir = opts.remoteDir ?? "/opt/paas-hardening";
    this.rollbackWindowMs = opts.rollbackWindowMs ?? SECURITY_ROLLBACK_WINDOW_MS;
    this.onChange = opts.onChange;
  }

  getJob(id: string): SecurityJob | null {
    return this.jobs.get(id) ?? null;
  }

  listJobs(): SecurityJob[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get isBusy(): boolean {
    return this.busy;
  }

  /** Inicia a execução assíncrona de uma fase. */
  async startJob(phase: SecurityPhaseId, dryRun: boolean, params?: PhaseParams): Promise<SecurityJob> {
    const phaseDef = SECURITY_PHASES.find((p) => p.id === phase);
    if (!phaseDef) throw new Error(`fase desconhecida: ${phase}`);
    if (this.busy) throw new Error("já existe um job de hardening em andamento");
    if (params && phase !== "01") {
      throw new Error("parâmetros de fase (usuário/chave SSH) só se aplicam à fase 01");
    }

    const job: SecurityJob = {
      id: randomUUID(),
      phase: phaseDef.id,
      phaseKey: phaseDef.key,
      title: phaseDef.title,
      dryRun,
      status: "queued",
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      steps: [],
      log: "",
      rollbackScheduled: false,
      rollbackDeadline: null,
      error: null,
      ...(params?.sshUser !== undefined ? { sshUser: params.sshUser } : {}),
    };
    this.jobs.set(job.id, job);
    this.busy = true;
    // execução assíncrona — o endpoint retorna o job imediatamente
    void this.run(job, phaseDef.script, params).finally(() => {
      this.busy = false;
    });
    return job;
  }

  /** Cancela o rollback agendado após o operador confirmar conectividade. */
  async confirmAccess(jobId: string): Promise<SecurityJob> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`job não encontrado: ${jobId}`);
    if (job.status !== "awaiting_confirmation") {
      throw new Error(`job ${jobId} não está aguardando confirmação (status: ${job.status})`);
    }
    const phaseDef = SECURITY_PHASES.find((p) => p.id === job.phase);
    if (!phaseDef) throw new Error(`fase desconhecida: ${job.phase}`);

    this.appendLog(job, `\n[executor] operador confirmou acesso — cancelando rollback agendado\n`);
    const code = await this.runner.execStream(
      buildPhaseScriptCommand({ remoteDir: this.remoteDir, script: phaseDef.script, confirm: true }),
      (chunk) => this.appendLog(job, chunk),
    );
    if (code !== 0) {
      throw new Error(`falha ao confirmar acesso no alvo (exit ${code}) — rollback continua agendado`);
    }
    const timer = this.timers.get(job.id);
    if (timer) clearTimeout(timer);
    this.timers.delete(job.id);
    job.rollbackScheduled = false;
    job.rollbackDeadline = null;
    job.status = "success";
    job.finishedAt = new Date().toISOString();
    this.notify(job);
    return job;
  }

  // -------------------------------------------------------------------------

  private async run(job: SecurityJob, script: string, params?: PhaseParams): Promise<void> {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    this.notify(job);

    try {
      await this.runner.ensureReady();
      await this.runner.uploadDir(this.scriptsDir, this.remoteDir);

      // Propaga a janela de rollback para o script (default 300s = at now +5 minutes).
      const delaySec = Math.round(this.rollbackWindowMs / 1000);
      const command = buildPhaseScriptCommand({
        remoteDir: this.remoteDir,
        script,
        dryRun: job.dryRun,
        rollbackDelaySec: delaySec,
        ...(params?.sshUser !== undefined ? { sshUser: params.sshUser } : {}),
        ...(params?.sshPublicKey !== undefined ? { sshPublicKey: params.sshPublicKey } : {}),
      });
      this.appendLog(
        job,
        `[executor] alvo=${this.runner.label} fase=${job.phase} script=${script} dryRun=${job.dryRun} rollbackDelay=${delaySec}s\n`,
      );
      const code = await this.runner.execStream(command, (chunk) => this.processChunk(job, chunk));
      this.finishCurrentStep(job, code === 0 ? "done" : "failed");

      if (code !== 0) {
        job.error = `script ${script} saiu com código ${code}`;
        if (!job.dryRun) {
          this.appendLog(job, `\n[executor] FALHA — executando rollback imediato (--rollback)\n`);
          const rbCode = await this.runner.execStream(
            buildPhaseScriptCommand({ remoteDir: this.remoteDir, script, rollback: true }),
            (chunk) => this.appendLog(job, chunk),
          );
          this.appendLog(
            job,
            rbCode === 0
              ? `[executor] rollback concluído com sucesso\n`
              : `[executor] ATENÇÃO: rollback saiu com código ${rbCode} — verificar o alvo manualmente\n`,
          );
        }
        job.status = "failed";
        job.finishedAt = new Date().toISOString();
        this.notify(job);
        return;
      }

      // Fases de risco (SSH/firewall) + Fase 01 COM chave (root é travado).
      const needsConfirmation =
        RISKY_PHASES.includes(job.phase) ||
        (job.phase === "01" && typeof params?.sshPublicKey === "string" && params.sshPublicKey.length > 0);
      if (!job.dryRun && needsConfirmation) {
        // O script já agendou a reversão NO ALVO (at/timer de 5 min).
        job.status = "awaiting_confirmation";
        job.rollbackScheduled = true;
        job.rollbackDeadline = new Date(Date.now() + this.rollbackWindowMs).toISOString();
        this.scheduleStatusFlip(job);
      } else {
        job.status = "success";
        job.finishedAt = new Date().toISOString();
      }
      this.notify(job);
    } catch (err) {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = new Date().toISOString();
      this.appendLog(job, `\n[executor] erro interno: ${job.error}\n`);
      this.notify(job);
    }
  }

  /** Reflete o rollback agendado no alvo quando a janela expira sem confirmação. */
  private scheduleStatusFlip(job: SecurityJob): void {
    const timer = setTimeout(() => {
      this.timers.delete(job.id);
      if (job.status === "awaiting_confirmation") {
        job.status = "rolled_back";
        job.rollbackScheduled = false;
        job.finishedAt = new Date().toISOString();
        this.appendLog(
          job,
          `\n[executor] janela de confirmação expirada — o rollback agendado no alvo reverteu a configuração\n`,
        );
        this.notify(job);
      }
    }, this.rollbackWindowMs + 15_000);
    timer.unref();
    this.timers.set(job.id, timer);
  }

  private processChunk(job: SecurityJob, chunk: string): void {
    this.appendLog(job, chunk);
    // Parseia marcadores de passo linha a linha (mantendo resto parcial no log).
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (line.startsWith(":::PAAS_STEP ")) {
        this.finishCurrentStep(job, "done");
        job.steps.push({ name: line.slice(":::PAAS_STEP ".length).trim(), status: "running" });
      } else if (line.startsWith(":::PAAS_SKIP ")) {
        // passo pulado dentro do script — registrado no log apenas
      } else if (line.startsWith(":::PAAS_FAIL ")) {
        this.finishCurrentStep(job, "failed");
      }
    }
  }

  private finishCurrentStep(job: SecurityJob, status: SecurityJobStep["status"]): void {
    for (let i = job.steps.length - 1; i >= 0; i -= 1) {
      const step = job.steps[i];
      if (step && step.status === "running") {
        step.status = status;
        return;
      }
    }
  }

  private appendLog(job: SecurityJob, chunk: string): void {
    job.log += chunk;
    if (job.log.length > MAX_LOG_CHARS) {
      job.log = job.log.slice(job.log.length - MAX_LOG_CHARS);
    }
  }

  private notify(job: SecurityJob): void {
    this.onChange?.(job);
  }
}
