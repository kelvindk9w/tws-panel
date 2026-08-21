/**
 * terminal-service.ts — gerencia A sessão de terminal do servidor (uma por
 * vez), compartilhada entre o WebSocket do painel e o executor de hardening.
 *
 * REGRA DE OURO (não negociável):
 *  - o backend faz RELAY PURO do fluxo do PTY (stdin/stdout, byte a byte);
 *  - o INPUT do usuário NUNCA é logado, persistido, auditado ou inspecionado —
 *    `write()` apenas repassa os bytes ao PTY e zera o timer de inatividade;
 *  - auditoria SOMENTE de ciclo de vida: sessão criada/encerrada, cliente
 *    conectado/desconectado, timeout de inatividade. Nunca conteúdo.
 *
 * O executor de fases roda DENTRO deste terminal (runCommand): o comando
 * aparece digitado no xterm do usuário, a saída rola ao vivo e prompts
 * interativos (ex.: senha) são respondidos digitando no próprio terminal —
 * o input segue pelo PTY sem passar por nenhum log.
 */
import { randomBytes } from "node:crypto";
import type { PtyFactory, RemotePty } from "./docker-socket.js";

/** Lançado quando o PTY não pôde ser aberto (antes de qualquer comando rodar). */
export class TerminalUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalUnavailableError";
  }
}

export interface TerminalServiceOptions {
  /** Fábrica do PTY remoto (docker-socket em produção; fake nos testes). */
  openPty: PtyFactory;
  /** Timeout de inatividade da sessão (default 30 min). */
  idleTimeoutMs?: number;
  /** Tamanho do scrollback retransmitido a clientes que conectam depois. */
  scrollbackChars?: number;
  /** Auditoria de ciclo de vida (NUNCA de conteúdo). */
  audit?: (action: string, detail: string) => void;
  /** Garante o alvo pronto antes de abrir o PTY (ex.: container de dev). */
  ensureTarget?: () => Promise<void>;
}

interface CommandWaiter {
  marker: string;
  /**
   * Modo captura: um marcador :::PAAS_BEGIN_<nonce> é impresso ANTES do
   * comando; só a saída entre BEGIN e EXIT é entregue ao caller (o eco do
   * comando digitado e o prompt não poluem o stdout capturado). Tudo continua
   * visível ao vivo no terminal do usuário (broadcast).
   */
  capture: boolean;
  capturing: boolean;
  captured: string;
  onData: (chunk: string) => void;
  resolve: (result: CommandResult) => void;
  reject: (err: Error) => void;
  /** Resto parcial de linha aguardando o próximo chunk (parse do marcador). */
  pending: string;
  timer: NodeJS.Timeout;
}

/** Resultado de um comando executado dentro do terminal. */
export interface CommandResult {
  code: number;
  /** Saída entre os marcadores BEGIN/EXIT (vazia fora do modo captura). */
  output: string;
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_SCROLLBACK_CHARS = 64_000;
const EXIT_MARKER_RE = (nonce: string) => new RegExp(`^:::PAAS_EXIT_${nonce}:(\\d+)\\r?$`);
const BEGIN_MARKER_RE = (nonce: string) => new RegExp(`^:::PAAS_BEGIN_${nonce}\\r?$`);

export class TerminalService {
  private readonly openPty: PtyFactory;
  private readonly idleTimeoutMs: number;
  private readonly scrollbackChars: number;
  private readonly audit?: ((action: string, detail: string) => void) | undefined;
  private ensureTarget?: (() => Promise<void>) | undefined;

  private pty: RemotePty | null = null;
  private opening: Promise<RemotePty> | null = null;
  private scrollback = "";
  private readonly listeners = new Set<(chunk: string) => void>();
  private idleTimer: NodeJS.Timeout | null = null;
  private waiter: CommandWaiter | null = null;
  /** Mutex de comandos: o shell é um só, comandos rodam em fila. */
  private commandQueue: Promise<unknown> = Promise.resolve();

  constructor(opts: TerminalServiceOptions) {
    this.openPty = opts.openPty;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.scrollbackChars = opts.scrollbackChars ?? DEFAULT_SCROLLBACK_CHARS;
    this.audit = opts.audit;
    this.ensureTarget = opts.ensureTarget;
  }

  setEnsureTarget(fn: (() => Promise<void>) | undefined): void {
    this.ensureTarget = fn;
  }

  get sessionActive(): boolean {
    return this.pty !== null;
  }

  // -------------------------------------------------------------------------
  // Sessão
  // -------------------------------------------------------------------------

  /**
   * Garante a sessão viva e retorna o scrollback para replay.
   * Lança TerminalUnavailableError se o PTY não puder ser aberto.
   */
  async connect(): Promise<{ replay: string }> {
    await this.ensureSession();
    return { replay: this.scrollback };
  }

  private async ensureSession(): Promise<RemotePty> {
    if (this.pty) {
      this.touch();
      return this.pty;
    }
    this.opening ??= this.openSession().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async openSession(): Promise<RemotePty> {
    try {
      await this.ensureTarget?.();
      const pty = await this.openPty();
      this.pty = pty;
      pty.stream.on("data", (chunk: Buffer) => this.handleOutput(chunk.toString("utf8")));
      pty.stream.on("end", () => this.handleSessionEnd("sessão encerrada pelo alvo"));
      pty.stream.on("close", () => this.handleSessionEnd("sessão encerrada pelo alvo"));
      pty.stream.on("error", () => this.handleSessionEnd("erro no fluxo do terminal"));
      this.audit?.("terminal.session", "Sessão de terminal aberta no alvo.");
      this.touch();
      return pty;
    } catch (err) {
      throw new TerminalUnavailableError(
        err instanceof Error ? err.message : "não foi possível abrir o terminal do servidor",
      );
    }
  }

  private handleSessionEnd(reason: string): void {
    const pty = this.pty;
    if (!pty) return;
    this.pty = null;
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) clearTimeout(waiter.timer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    // Limpa o alvo (container paas-terminal-* / exec): sem isso, uma sessão
    // morta por erro de stream VAZAVA o helper — o AutoRemove do Docker só
    // dispara se o processo principal sair — e o próximo connect() abria um
    // SEGUNDO container por cima do primeiro.
    void pty.kill().catch(() => undefined);
    this.audit?.("terminal.session-end", `Sessão de terminal encerrada (${reason}).`);
    waiter?.reject(new Error(`o terminal foi encerrado durante a execução (${reason})`));
    this.broadcast(`\r\n\x1b[33m[terminal] sessão encerrada — reconecte para abrir outra\x1b[0m\r\n`);
  }

  /** Timeout de inatividade: zera a sessão se ninguém digitar/receber nada. */
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.waiter) {
        // comando em andamento (ex.: apt upgrade longo) — adia o encerramento
        this.touch();
        return;
      }
      this.audit?.("terminal.idle-timeout", "Sessão de terminal encerrada por inatividade.");
      void this.dispose();
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  async dispose(): Promise<void> {
    const pty = this.pty;
    this.pty = null;
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) clearTimeout(waiter.timer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    waiter?.reject(new Error("sessão de terminal encerrada"));
    await pty?.kill().catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Relay puro (REGRA DE OURO: input nunca é lido/logado/auditado)
  // -------------------------------------------------------------------------

  /** Repassa input do usuário ao PTY. NUNCA inspecionar o conteúdo aqui. */
  write(data: string | Buffer): void {
    if (!this.pty) return;
    this.pty.stream.write(data);
    this.touch();
  }

  resize(cols: number, rows: number): void {
    if (!this.pty) return;
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
    if (cols < 2 || rows < 2 || cols > 500 || rows > 200) return;
    this.pty.resize(cols, rows);
  }

  /** Assina a saída do terminal (clientes WS). Retorna o unsubscribe. */
  onOutput(cb: (chunk: string) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private broadcast(chunk: string): void {
    this.scrollback += chunk;
    if (this.scrollback.length > this.scrollbackChars) {
      this.scrollback = this.scrollback.slice(this.scrollback.length - this.scrollbackChars);
    }
    for (const cb of this.listeners) {
      try {
        cb(chunk);
      } catch {
        // cliente lento/quebrado não derruba o terminal
      }
    }
  }

  /**
   * Ponto único de entrada da saída do PTY: alimenta o waiter de comando
   * (que filtra o marcador de saída) e replica o restante aos clientes.
   */
  private handleOutput(chunk: string): void {
    this.touch();
    const waiter = this.waiter;
    if (!waiter) {
      this.broadcast(chunk);
      return;
    }
    const { visible, done, exitCode } = this.consumeForWaiter(waiter, chunk);
    if (visible.length > 0) {
      // Modo captura: só o trecho entre os marcadores BEGIN/EXIT vai ao
      // caller, com CRLF normalizado para \n (o stdout é parseado pelos
      // checks do scanner). O BROADCAST segue cru (\r\n) para o xterm
      // renderizar certinho — sem efeito escada na tela do usuário.
      if (!waiter.capture || waiter.capturing) {
        const forCaller = waiter.capture ? visible.replace(/\r\n/g, "\n") : visible;
        waiter.onData(forCaller);
        waiter.captured += forCaller;
      }
      this.broadcast(visible);
    }
    if (done) {
      clearTimeout(waiter.timer);
      this.waiter = null;
      waiter.resolve({ code: exitCode ?? 1, output: waiter.captured });
    }
  }

  /**
   * Parse linha a linha atrás do marcador :::PAAS_EXIT_<nonce>:<code>.
   * O marcador NÃO é exibido no terminal do usuário nem vai ao scrollback.
   */
  private consumeForWaiter(
    waiter: CommandWaiter,
    chunk: string,
  ): { visible: string; done: boolean; exitCode: number | null } {
    const re = EXIT_MARKER_RE(waiter.marker);
    const beginRe = BEGIN_MARKER_RE(waiter.marker);
    let buf = waiter.pending + chunk;
    let visible = "";
    let exitCode: number | null = null;
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl === -1) break;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (waiter.capture && !waiter.capturing && beginRe.exec(line)) {
        // Marcador de início: não é exibido nem capturado — a partir da
        // próxima linha a saída é do comando de fato.
        waiter.capturing = true;
        continue;
      }
      const m = re.exec(line);
      if (m) {
        exitCode = Number(m[1]);
      } else {
        visible += line + "\n";
      }
    }
    // Segura o resto parcial SOMENTE se ele puder ser (o início de) uma linha
    // de marcador — prompts sem newline (ex.: "New password:") são exibidos
    // na hora, essencial para a interatividade.
    const exitFull = `:::PAAS_EXIT_${waiter.marker}:`;
    const beginFull = `:::PAAS_BEGIN_${waiter.marker}`;
    const candidate = buf.endsWith("\r") ? buf.slice(0, -1) : buf;
    const couldBeMarker = (full: string) => full.startsWith(candidate) || candidate.startsWith(full);
    if (couldBeMarker(exitFull) || (waiter.capture && couldBeMarker(beginFull))) {
      waiter.pending = buf;
    } else {
      visible += buf;
      waiter.pending = "";
    }
    return { visible, done: exitCode !== null, exitCode };
  }

  // -------------------------------------------------------------------------
  // Execução de comandos DENTRO do terminal (executor de fases)
  // -------------------------------------------------------------------------

  /**
   * Executa um comando de UMA LINHA no shell do terminal, transmitindo a saída
   * ao vivo (onData + clientes WS) e resolvendo com o exit code.
   *
   * O comando aparece digitado no terminal do usuário — transparência total.
   * Prompts interativos do comando são respondidos pelo usuário digitando no
   * xterm; o input segue direto pelo PTY (nunca passa por este serviço).
   *
   * Falhas ANTES do comando começar lançam TerminalUnavailableError (caller
   * pode fazer fallback); falhas DEPOIS de iniciado são erros reais.
   */
  runCommand(
    cmd: string,
    onData: (chunk: string) => void,
    opts?: { timeoutMs?: number },
  ): Promise<number> {
    return this.enqueue(cmd, onData, { ...opts, capture: false }).then((r) => r.code);
  }

  /**
   * Variante com CAPTURA de stdout: imprime um marcador :::PAAS_BEGIN antes do
   * comando e retorna { code, output } com apenas a saída real (sem o eco do
   * comando digitado nem o prompt). Usada pelos checks somente-leitura do
   * scanner, que precisam parsear o stdout — enquanto o usuário continua
   * vendo cada comando rodar ao vivo no terminal.
   */
  runCommandCaptured(
    cmd: string,
    opts?: { timeoutMs?: number },
  ): Promise<CommandResult> {
    return this.enqueue(cmd, () => undefined, { ...opts, capture: true });
  }

  private enqueue(
    cmd: string,
    onData: (chunk: string) => void,
    opts?: { timeoutMs?: number; capture?: boolean },
  ): Promise<CommandResult> {
    if (cmd.includes("\n") || cmd.includes("\r")) {
      return Promise.reject(new Error("runCommand aceita apenas comandos de uma linha"));
    }
    const run = () => this.runCommandNow(cmd, onData, opts);
    const queued = this.commandQueue.then(run, run);
    this.commandQueue = queued.catch(() => undefined);
    return queued;
  }

  private async runCommandNow(
    cmd: string,
    onData: (chunk: string) => void,
    opts?: { timeoutMs?: number; capture?: boolean },
  ): Promise<CommandResult> {
    await this.ensureSession(); // TerminalUnavailableError aqui = antes de começar
    const nonce = randomBytes(4).toString("hex");
    const capture = opts?.capture ?? false;
    return new Promise<CommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        // timeout: tenta Ctrl-C; se o marcador não vier, derruba a sessão
        this.write("\x03");
        setTimeout(() => {
          if (this.waiter?.marker === nonce) {
            this.waiter = null;
            void this.dispose();
            reject(new Error(`comando excedeu o tempo limite no terminal (${opts?.timeoutMs ?? 0}ms)`));
          }
        }, 5_000).unref();
      }, opts?.timeoutMs ?? 30 * 60_000);
      timer.unref();
      this.waiter = {
        marker: nonce,
        capture,
        capturing: false,
        captured: "",
        onData,
        resolve,
        reject,
        pending: "",
        timer,
      };
      // O comando digitado inclui os marcadores de início/fim — honesto e
      // visível para o usuário, como num SSH real.
      const prelude = capture ? `echo ":::PAAS_BEGIN_${nonce}"; ` : "";
      this.write(`${prelude}${cmd}; echo ":::PAAS_EXIT_${nonce}:$?"\n`);
    });
  }
}
