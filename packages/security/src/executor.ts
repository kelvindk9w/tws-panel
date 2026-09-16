/**
 * executor.ts — executa as fases de hardening como jobs assíncronos.
 *
 * Garantias:
 *  - um job por vez (mutex) — hardening concorrente é receita para lockout;
 *  - a fase roda DESTACADA do canal (scripts/hardening/lib.sh
 *    --paas-run-detached): o painel dispara, acompanha o log e, se o canal cair
 *    (rede, aba fechada, reinício do daemon do Docker), a fase CONTINUA no
 *    servidor. O executor reatacha pelo mesmo id e recupera o código de saída;
 *  - log completo por passo (marcadores :::PAAS_STEP emitidos pelos scripts);
 *  - rollback automático imediato em caso de falha (script --rollback);
 *  - fases de risco (SSH/firewall) ficam "awaiting_confirmation" até o operador
 *    confirmar acesso; o rollback agendado NO ALVO (at/timer de 5 min) reverte
 *    sozinho se ninguém confirmar — o executor apenas reflete o estado.
 *  - a Fase 01 é decidida pelo marcador :::PAAS_ROLLBACK_SCHEDULED emitido pelo
 *    próprio script: quem sabe se o root foi travado (e a reversão agendada) é
 *    o script, não os argumentos que a interface mandou.
 *
 * Protocolo da execução destacada (emitido por lib.sh):
 *   :::PAAS_RUN_STARTED <runId> <pid>     lançada e destacada
 *   :::PAAS_RUN_BUSY <script>             a MESMA fase já roda no alvo (trava)
 *   :::PAAS_RUN_END <código|-> <ok|dead|missing>   desfecho recuperável
 * Sem o marcador de fim o executor NUNCA conclui nada: o canal ter morrido não
 * é resultado de fase.
 */
import { randomUUID, randomBytes } from "node:crypto";
import {
  RISKY_PHASES,
  SECURITY_PHASES,
  SECURITY_ROLLBACK_WINDOW_MS,
  type SecurityJob,
  type SecurityJobStep,
  type SecurityPhaseId,
} from "@paas/core";
import type { TargetRunner } from "./runner.js";
import {
  PHASE_RUN_DIR_DEFAULT,
  buildPhaseFollowCommand,
  buildPhaseScriptCommand,
  isValidPhaseRunId,
} from "./host-bridge.js";

const MAX_LOG_CHARS = 500_000;

/**
 * Marcador emitido por schedule_rollback (scripts/hardening/lib.sh) quando uma
 * reversão automática foi DE FATO agendada no alvo. É a única prova confiável
 * de que existe uma janela de confirmação correndo lá — em dry-run o script
 * retorna cedo e não emite nada.
 */
const ROLLBACK_SCHEDULED_MARKER = ":::PAAS_ROLLBACK_SCHEDULED";
const RUN_STARTED_MARKER = ":::PAAS_RUN_STARTED ";
const RUN_BUSY_MARKER = ":::PAAS_RUN_BUSY ";
const RUN_END_MARKER = ":::PAAS_RUN_END ";

/** Desfecho da execução destacada, lido do marcador :::PAAS_RUN_END. */
interface RunEnd {
  /** Código de saída da fase; null quando o alvo não soube dizer. */
  code: number | null;
  /** "ok" (código recuperado), "dead" (processo sumiu), "missing" (sem log). */
  reason: string;
}

/** Estado acumulado durante o parsing da saída de UM job. */
interface OutputScan {
  /** true assim que o marcador de rollback agendado aparece na saída. */
  rollbackScheduled: boolean;
  /** Resto de linha parcial entre chunks (marcador nunca é cortado ao meio). */
  pending: string;
  /** Desfecho recuperado; null enquanto a fase não terminou. */
  end: RunEnd | null;
  /** A mesma fase já estava em execução no alvo (trava por fase). */
  busy: boolean;
}

function newScan(): OutputScan {
  return { rollbackScheduled: false, pending: "", end: null, busy: false };
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
  /** Diretório de estado das execuções destacadas no alvo. */
  runDir?: string;
  /** Janela do rollback agendado — default 5 min (alinhado aos scripts). */
  rollbackWindowMs?: number;
  /** Espera entre tentativas de reatache quando o canal cai (default 10s). */
  reattachDelayMs?: number;
  /** Tentativas de reatache antes de desistir (default 180 ≈ 30 min). */
  maxReattachAttempts?: number;
  /** Chamado a cada mudança de estado do job (para persistência). */
  onChange?: (job: SecurityJob) => void;
}

export class SecurityExecutor {
  private readonly runner: TargetRunner;
  private readonly scriptsDir: string;
  private readonly remoteDir: string;
  private readonly runDir: string;
  private readonly rollbackWindowMs: number;
  private readonly reattachDelayMs: number;
  private readonly maxReattachAttempts: number;
  private readonly onChange?: ((job: SecurityJob) => void) | undefined;
  private readonly jobs = new Map<string, SecurityJob>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /**
   * job.id → id da execução destacada no alvo. Fica fora do SecurityJob (tipo
   * compartilhado da API) e é persistido ao lado dos jobs pelo servidor: sem
   * ele, um painel reiniciado não sabe a qual execução reatachar.
   */
  private readonly runIds = new Map<string, string>();
  private busy = false;

  constructor(opts: ExecutorOptions) {
    this.runner = opts.runner;
    this.scriptsDir = opts.scriptsDir;
    this.remoteDir = opts.remoteDir ?? "/opt/paas-hardening";
    this.runDir = opts.runDir ?? PHASE_RUN_DIR_DEFAULT;
    this.rollbackWindowMs = opts.rollbackWindowMs ?? SECURITY_ROLLBACK_WINDOW_MS;
    this.reattachDelayMs = opts.reattachDelayMs ?? 10_000;
    this.maxReattachAttempts = opts.maxReattachAttempts ?? 180;
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

  /** Mapa job.id → runId, para o servidor persistir junto dos jobs. */
  runIdsSnapshot(): Record<string, string> {
    return Object.fromEntries(this.runIds);
  }

  /** Restaura o mapa persistido. Chamar ANTES de restoreJobs(). */
  restoreRunIds(map: Record<string, string>): void {
    for (const [jobId, runId] of Object.entries(map)) {
      if (typeof runId === "string" && isValidPhaseRunId(runId)) this.runIds.set(jobId, runId);
    }
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
      const runId = `f${job.phase}-${randomBytes(8).toString("hex")}`;
      this.runIds.set(job.id, runId);
      const command = buildPhaseScriptCommand({
        remoteDir: this.remoteDir,
        script,
        runId,
        runDir: this.runDir,
        dryRun: job.dryRun,
        rollbackDelaySec: delaySec,
        ...(params?.sshUser !== undefined ? { sshUser: params.sshUser } : {}),
        ...(params?.sshPublicKey !== undefined ? { sshPublicKey: params.sshPublicKey } : {}),
      });
      this.appendLog(job, this.header(job, script, runId, delaySec));
      const scan = newScan();
      await this.streamOnce(job, command, scan);

      if (scan.busy) {
        // A trava por fase no alvo recusou: alguém (outra sessão do painel, ou
        // uma execução anterior que sobreviveu a um restart) ainda está com
        // esta fase rodando. NUNCA aplicar de novo por cima.
        job.status = "failed";
        job.error = `a fase ${job.phase} já está em execução no servidor — aguarde ela terminar`;
        job.finishedAt = new Date().toISOString();
        this.runIds.delete(job.id);
        this.appendLog(job, `\n[executor] ${job.error}\n`);
        this.notify(job);
        return;
      }

      await this.driveUntilEnd(job, runId, scan);
      await this.finishRun(job, script, scan);
    } catch (err) {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = new Date().toISOString();
      this.appendLog(job, `\n[executor] erro interno: ${job.error}\n`);
      this.notify(job);
    }
  }

  private header(job: SecurityJob, script: string, runId: string, delaySec: number): string {
    return (
      `[executor] alvo=${this.runner.label} fase=${job.phase} script=${script} ` +
      `dryRun=${job.dryRun} rollbackDelay=${delaySec}s execução=${runId} (destacada do terminal)\n`
    );
  }

  /**
   * Executa UM comando do protocolo destacado transmitindo a saída ao job.
   * Nunca lança: a morte do canal é um fato esperado aqui (é justamente o que
   * a execução destacada existe para tolerar) e vira apenas "sem desfecho".
   */
  private async streamOnce(job: SecurityJob, command: string, scan: OutputScan): Promise<void> {
    try {
      await this.runner.execStream(command, (chunk) => this.processChunk(job, chunk, scan));
    } catch (err) {
      this.appendLog(
        job,
        `\n[executor] canal interrompido: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    this.flushPending(job, scan);
  }

  /**
   * Acompanha a execução até o marcador de fim aparecer, reatachando sempre
   * que o canal morrer antes disso. O reatache relê o log DO INÍCIO (a fonte
   * da verdade é o arquivo no alvo), então o operador reencontra o que já
   * passou e o que está acontecendo agora.
   */
  private async driveUntilEnd(job: SecurityJob, runId: string, scan: OutputScan): Promise<void> {
    let attempts = 0;
    while (scan.end === null && !scan.busy) {
      attempts += 1;
      if (attempts > this.maxReattachAttempts) {
        throw new Error(
          "o painel não conseguiu reatachar à fase destacada no servidor — ela pode ter terminado; confira o alvo manualmente",
        );
      }
      this.appendLog(
        job,
        `\n[executor] canal caiu, mas a fase continua rodando no servidor — reatachando (tentativa ${attempts})…\n`,
      );
      await sleep(this.reattachDelayMs);
      this.resetForReattach(job, scan);
      await this.streamOnce(
        job,
        buildPhaseFollowCommand({ remoteDir: this.remoteDir, runId, runDir: this.runDir }),
        scan,
      );
    }
  }

  /** Reatache: o log do alvo é relido inteiro, então o job recomeça do zero. */
  private resetForReattach(job: SecurityJob, scan: OutputScan): void {
    job.log = `[executor] reatachando à execução destacada no servidor — reexibindo o que já passou\n`;
    job.steps = [];
    scan.rollbackScheduled = false;
    scan.pending = "";
  }

  /** Conclui o job a partir do desfecho recuperado do alvo. */
  private async finishRun(job: SecurityJob, script: string, scan: OutputScan): Promise<void> {
    const end = scan.end;
    if (!end) return;

    if (end.code === null) {
      // Sem código de saída não há sucesso possível — e também não há rollback
      // automático: reverter sem saber o que aconteceu pode desfazer uma fase
      // que terminou bem.
      this.finishCurrentStep(job, "failed");
      job.error =
        end.reason === "missing"
          ? "a execução destacada não foi encontrada no servidor (log ausente) — confira o alvo manualmente"
          : "o processo da fase morreu no servidor sem registrar o código de saída — confira o alvo manualmente";
      job.status = "failed";
      job.finishedAt = new Date().toISOString();
      this.appendLog(job, `\n[executor] ${job.error}\n`);
      this.notify(job);
      return;
    }

    const code = end.code;
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
   *  - "queued"/"running" COM execução destacada conhecida (runId persistido):
   *    o painel reatacha à execução que continua rodando no servidor —
   *    reexibindo o log desde o início e recuperando o código de saída no fim,
   *    mesmo que ninguém estivesse olhando quando ela terminou;
   *  - "queued"/"running" SEM runId (jobs de versões anteriores): não há como
   *    saber o resultado real, então o job é marcado "failed" com uma nota
   *    explicando o motivo (nunca fica preso em execução);
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
        const runId = this.runIds.get(job.id);
        if (runId && !this.busy) {
          this.jobs.set(job.id, job);
          job.status = "running";
          this.appendLog(
            job,
            "\n[executor] painel reiniciado — a fase continuou rodando no servidor; reatachando à execução destacada\n",
          );
          this.busy = true;
          this.notify(job);
          void this.reattach(job, runId).finally(() => {
            this.busy = false;
          });
          continue;
        }
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

  /** Reatache a uma execução destacada que já estava rodando no servidor. */
  private async reattach(job: SecurityJob, runId: string): Promise<void> {
    const phaseDef = SECURITY_PHASES.find((p) => p.id === job.phase);
    if (!phaseDef) return;
    const scan = newScan();
    try {
      // Sem ensureReady() de propósito: o reatache é só leitura e, no modo
      // senha, ensureReady valida o sudo — pedir a senha para REATACHAR seria
      // exatamente o que a execução destacada veio evitar.
      this.resetForReattach(job, scan);
      await this.streamOnce(
        job,
        buildPhaseFollowCommand({ remoteDir: this.remoteDir, runId, runDir: this.runDir }),
        scan,
      );
      await this.driveUntilEnd(job, runId, scan);
      await this.finishRun(job, phaseDef.script, scan);
    } catch (err) {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = new Date().toISOString();
      this.appendLog(job, `\n[executor] erro ao reatachar: ${job.error}\n`);
      this.notify(job);
    }
  }

  private processChunk(job: SecurityJob, chunk: string, scan: OutputScan): void {
    this.appendLog(job, chunk);
    // Parseia marcadores linha a linha, guardando o resto parcial entre chunks
    // (um marcador partido no meio nunca pode passar despercebido).
    const buffered = scan.pending + chunk;
    const lines = buffered.split("\n");
    scan.pending = lines.pop() ?? "";
    for (const line of lines) this.processLine(job, line, scan);
  }

  /** Processa o resto sem newline ao fim de um comando (marcador colado). */
  private flushPending(job: SecurityJob, scan: OutputScan): void {
    if (scan.pending.length === 0) return;
    const line = scan.pending;
    scan.pending = "";
    this.processLine(job, line, scan);
  }

  private processLine(job: SecurityJob, rawLine: string, scan: OutputScan): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith(ROLLBACK_SCHEDULED_MARKER)) {
      // Sinal de controle, não um passo: tratado antes (e à parte) do
      // :::PAAS_STEP para nunca aparecer na lista exibida ao operador.
      scan.rollbackScheduled = true;
    } else if (line.startsWith(RUN_END_MARKER)) {
      const [rawCode, reason] = line.slice(RUN_END_MARKER.length).trim().split(/\s+/);
      const code = rawCode !== undefined && /^\d+$/.test(rawCode) ? Number(rawCode) : null;
      scan.end = { code, reason: reason ?? "ok" };
    } else if (line.startsWith(RUN_BUSY_MARKER)) {
      scan.busy = true;
    } else if (line.startsWith(RUN_STARTED_MARKER)) {
      // apenas informativo (id/pid da execução destacada já vão para o log)
    } else if (line.startsWith(":::PAAS_STEP ")) {
      this.finishCurrentStep(job, "done");
      job.steps.push({ name: line.slice(":::PAAS_STEP ".length).trim(), status: "running" });
    } else if (line.startsWith(":::PAAS_SKIP ")) {
      // passo pulado dentro do script — registrado no log apenas
    } else if (line.startsWith(":::PAAS_FAIL ")) {
      this.finishCurrentStep(job, "failed");
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
