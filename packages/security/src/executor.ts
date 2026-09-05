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
 *  - a Fase 01 é decidida pelo marcador :::PAAS_ROLLBACK_SCHEDULED emitido pelo
 *    próprio script: quem sabe se o root foi travado (e a reversão agendada) é
 *    o script, não os argumentos que a interface mandou.
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

/**
 * Marcador emitido por schedule_rollback (scripts/hardening/lib.sh) quando uma
 * reversão automática foi DE FATO agendada no alvo. É a única prova confiável
 * de que existe uma janela de confirmação correndo lá — em dry-run o script
 * retorna cedo e não emite nada.
 */
const ROLLBACK_SCHEDULED_MARKER = ":::PAAS_ROLLBACK_SCHEDULED";

/** Estado acumulado durante o parsing da saída de UM job. */
interface OutputScan {
  /** true assim que o marcador de rollback agendado aparece na saída. */
  rollbackScheduled: boolean;
}

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
      const scan: OutputScan = { rollbackScheduled: false };
      const code = await this.runner.execStream(command, (chunk) => this.processChunk(job, chunk, scan));
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

      // Fases de risco (SSH/firewall) sempre agendam reversão. A Fase 01 só
      // trava o root quando encontra uma chave já instalada no alvo — o que
      // NÃO se deduz dos argumentos: quem seguiu o README instalou a própria
      // chave antes de abrir o painel e não precisa colar nada. Por isso a
      // decisão vem do marcador que o script emite ao agendar a reversão; sem
      // ele, nada foi travado e o job termina em sucesso honesto (nunca vira
      // "rolled_back" depois, porque não há reversão alguma para acontecer).
      const needsConfirmation =
        RISKY_PHASES.includes(job.phase) || (job.phase === "01" && scan.rollbackScheduled);
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

  /**
   * Reflete o rollback agendado no alvo quando a janela expira sem
   * confirmação. `delayMs` é configurável para restoreJobs() reagendar com o
   * tempo RESTANTE de uma janela que já estava correndo antes de um restart
   * do painel (o timer original morre com o processo).
   */
  private scheduleStatusFlip(job: SecurityJob, delayMs = this.rollbackWindowMs + 15_000): void {
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
    }, delayMs);
    timer.unref();
    this.timers.set(job.id, timer);
  }

  /**
   * Restaura jobs persistidos (ex.: após restart do painel) — sem isso,
   * GET /api/security/jobs/:id respondia 404 para um job em
   * "awaiting_confirmation" logo após um restart, mesmo com o rollback
   * agendado NO ALVO (at/timer) continuando a correr de forma independente.
   * O operador perdia visibilidade justo no momento em que precisa confirmar
   * que ainda tem acesso.
   *
   * Regras:
   *  - "queued"/"running": o processo do script morreu junto com o painel —
   *    não há como saber o resultado real, então o job é marcado "failed"
   *    com uma nota explicando o motivo (nunca fica preso em execução).
   *  - "awaiting_confirmation": se a janela (rollbackDeadline) já expirou
   *    enquanto o painel estava fora do ar, assume-se que o rollback
   *    agendado NO ALVO já reverteu — marca "rolled_back" imediatamente. Se
   *    ainda há tempo, reagenda o flip (scheduleStatusFlip) com o tempo
   *    RESTANTE, preservando o comportamento normal; confirmAccess() ainda
   *    funciona normalmente sobre o job restaurado.
   *  - qualquer outro status (terminal: success/failed/rolled_back): restaura
   *    como está, sem efeitos colaterais.
   */
  restoreJobs(jobs: readonly SecurityJob[]): void {
    for (const job of jobs) {
      if (job.status === "queued" || job.status === "running") {
        job.status = "failed";
        job.error = "processo do painel reiniciado durante a execução — status real não pôde ser confirmado";
        job.finishedAt = job.finishedAt ?? new Date().toISOString();
        this.appendLog(
          job,
          "\n[executor] painel reiniciado com este job em execução — marcado como falho (verifique o alvo manualmente)\n",
        );
        this.jobs.set(job.id, job);
        this.notify(job);
        continue;
      }

      this.jobs.set(job.id, job);

      if (job.status === "awaiting_confirmation" && job.rollbackDeadline) {
        const remainingMs = new Date(job.rollbackDeadline).getTime() - Date.now() + 15_000;
        if (remainingMs <= 0) {
          job.status = "rolled_back";
          job.rollbackScheduled = false;
          job.finishedAt = new Date().toISOString();
          this.appendLog(
            job,
            "\n[executor] painel reiniciado após a janela de confirmação — assumindo que o rollback agendado no alvo reverteu a configuração\n",
          );
          this.notify(job);
        } else {
          this.scheduleStatusFlip(job, remainingMs);
        }
      }
    }
  }

  private processChunk(job: SecurityJob, chunk: string, scan?: OutputScan): void {
    this.appendLog(job, chunk);
    // Parseia marcadores de passo linha a linha (mantendo resto parcial no log).
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (line.startsWith(ROLLBACK_SCHEDULED_MARKER)) {
        // Sinal de controle, não um passo: tratado antes (e à parte) do
        // :::PAAS_STEP para nunca aparecer na lista exibida ao operador.
        if (scan) scan.rollbackScheduled = true;
      } else if (line.startsWith(":::PAAS_STEP ")) {
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
