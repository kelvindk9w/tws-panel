/**
 * monitor.ts — agendador interno do scan recorrente (Fase 4).
 *
 * Roda dentro do processo do servidor (setInterval) — sem depender de
 * cron/systemd do host, o que é mais portável e não altera o sistema do
 * usuário. A configuração (intervalo) e a última execução são persistidas
 * pela camada de serviço (apps/server) via callbacks.
 */
export interface MonitorSchedulerOptions {
  /** Intervalo entre execuções (ms). */
  intervalMs: number;
  /** Tarefa do scan (nunca deve lançar — erros são capturados). */
  task: () => Promise<void>;
  /** Chamado após cada execução (para persistir lastRunAt). */
  onTick?: (info: { ranAt: string; error: string | null }) => void;
}

export class MonitorScheduler {
  private intervalMs: number;
  private readonly task: () => Promise<void>;
  private readonly onTick?: ((info: { ranAt: string; error: string | null }) => void) | undefined;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(opts: MonitorSchedulerOptions) {
    this.intervalMs = opts.intervalMs;
    this.task = opts.task;
    this.onTick = opts.onTick;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  get currentIntervalMs(): number {
    return this.intervalMs;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Altera o intervalo (reagenda se estiver rodando). */
  setIntervalMs(intervalMs: number): void {
    this.intervalMs = intervalMs;
    if (this.timer) {
      this.stop();
      this.start();
    }
  }

  /** Executa imediatamente (endpoint "rodar agora"). */
  async runNow(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return; // scan anterior ainda rodando — pula este ciclo
    this.inFlight = true;
    let error: string | null = null;
    try {
      await this.task();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      this.inFlight = false;
      this.onTick?.({ ranAt: new Date().toISOString(), error });
    }
  }
}
