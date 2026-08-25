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
  /** Chamado após cada execução automática (para persistir lastRunAt). */
  onTick?: (info: { ranAt: string; error: string | null }) => void;
  /**
   * Chamado quando um ciclo AUTOMÁTICO (setInterval) é pulado por já haver um
   * scan em andamento (manual ou automático). Antes desta correção isso era
   * silencioso — o operador via ciclos "perdidos" sem nenhum indício no log.
   */
  onSkip?: () => void;
}

export class MonitorScheduler {
  private intervalMs: number;
  private readonly task: () => Promise<void>;
  private readonly onTick?: ((info: { ranAt: string; error: string | null }) => void) | undefined;
  private readonly onSkip?: (() => void) | undefined;
  private timer: NodeJS.Timeout | null = null;
  private inFlightFlag = false;

  constructor(opts: MonitorSchedulerOptions) {
    this.intervalMs = opts.intervalMs;
    this.task = opts.task;
    this.onTick = opts.onTick;
    this.onSkip = opts.onSkip;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  get currentIntervalMs(): number {
    return this.intervalMs;
  }

  /** true enquanto um scan (automático OU manual via runNow) está em andamento. */
  get inFlight(): boolean {
    return this.inFlightFlag;
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

  /**
   * Executa imediatamente (endpoint "rodar agora"), respeitando o MESMO lock
   * que o tick automático — antes desta correção este método chamava a
   * tarefa direto, sem checar `inFlight`, permitindo dois scans concorrentes
   * disputando os mesmos recursos do alvo.
   *
   * Decisão de design: se já houver um scan em andamento, RECUSA com um erro
   * claro em vez de enfileirar/esperar o resultado alheio. Um scan pode levar
   * mais de um minuto em VPS real (Lynis incluso) — esperar bloquearia a
   * requisição HTTP do operador pelo tempo inteiro do scan já em andamento,
   * e não haveria como diferenciar "meu resultado" do resultado de outro
   * disparo. Recusar imediatamente é reversível (o operador tenta de novo) e
   * segue o mesmo padrão já usado pelo SecurityExecutor (409 job_conflict).
   *
   * Diferente do tick automático, erros da própria tarefa SÃO propagados ao
   * chamador (quem chamou runNow precisa saber que o scan falhou).
   */
  async runNow(): Promise<void> {
    if (this.inFlightFlag) {
      throw new Error("já existe um scan de monitoramento em andamento — tente novamente em instantes");
    }
    this.inFlightFlag = true;
    try {
      await this.task();
      this.onTick?.({ ranAt: new Date().toISOString(), error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.onTick?.({ ranAt: new Date().toISOString(), error: message });
      throw err;
    } finally {
      this.inFlightFlag = false;
    }
  }

  /** Disparado pelo setInterval — nunca lança (erros só viram onTick.error). */
  private async tick(): Promise<void> {
    if (this.inFlightFlag) {
      // scan anterior (automático ou manual) ainda rodando — pula este ciclo
      this.onSkip?.();
      return;
    }
    this.inFlightFlag = true;
    let error: string | null = null;
    try {
      await this.task();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      this.inFlightFlag = false;
      this.onTick?.({ ranAt: new Date().toISOString(), error });
    }
  }
}
