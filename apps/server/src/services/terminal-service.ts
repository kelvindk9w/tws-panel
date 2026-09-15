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
 *
 * MODO "senha" (PAAS_ROOT_MODE=senha — terminal aberto como usuário comum):
 *  - comandos que precisam de root são digitados ELEVADOS INTEIROS:
 *    `sudo -p '<prompt>' -- bash -c '<comando>'` (buildElevatedCommand);
 *  - o pedido de senha do sudo é detectado na SAÍDA do PTY (watchSudoOutput)
 *    e vira mensagem de controle aos clientes (onControl). A SAÍDA pode ser
 *    observada; o INPUT continua nunca lido — a senha que o operador digita
 *    passa por write() exatamente como qualquer outro byte;
 *  - enquanto o prompt está aberto o relógio do comando fica PAUSADO e corre
 *    um relógio próprio de espera pela senha (sudoPasswordTimeoutMs).
 */
import { randomBytes } from "node:crypto";
import type { SudoPromptOutcome, TerminalControlMessage } from "@paas/core";
import type { PtyFactory, RemotePty } from "./docker-socket.js";

/** Lançado quando o PTY não pôde ser aberto (antes de qualquer comando rodar). */
export class TerminalUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalUnavailableError";
  }
}

/**
 * Lançado quando, em modo captura, o marcador EXIT chega SEM que o BEGIN
 * tenha sido detectado — a captura está corrompida (output seria vazio) e
 * NÃO pode ser entregue como se fosse sucesso. O caller pode retentar UMA
 * vez (os checks do scanner são somente-leitura); se persistir, o erro
 * propaga e o scanner marca o check como unknown/erro — nunca um "fail"
 * mentiroso (ex.: "fail2ban ausente" com fail2ban ativo).
 */
export class CaptureDesyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureDesyncError";
  }
}

/** Por que o sudo não executou o comando pedido. */
export type SudoFailureReason = "exhausted" | "not-permitted" | "timeout" | "not-executed";

const SUDO_FAILURE_MESSAGES: Record<SudoFailureReason, string> = {
  exhausted:
    "o sudo recusou a senha 3 vezes. Nada foi executado como root. Confira a senha do usuário do terminal e rode de novo.",
  "not-permitted":
    "o usuário do terminal não tem permissão de sudo. Nada foi executado como root. Adicione-o ao grupo sudo " +
    "(como root: usermod -aG sudo <usuário>) ou reinstale com PAAS_ROOT_MODE=segundo-plano.",
  timeout:
    "tempo esgotado aguardando a senha do sudo. Nada foi executado como root e o pedido de senha foi cancelado. " +
    "Rode de novo e digite a senha no terminal.",
  "not-executed":
    "o sudo não executou o comando (senha não confirmada ou sudo interrompido). Nada foi executado como root. " +
    "Rode de novo e digite a senha no terminal quando ela for pedida.",
};

/**
 * O sudo não executou o comando (senha errada 3 vezes, usuário sem sudo,
 * tempo de espera pela senha esgotado...). NUNCA é um resultado de comando:
 * o caller deve falhar a varredura/fase com a mensagem, jamais tratá-lo como
 * "ok" ou como "fail" de um check. Não há retentativa automática — repetir
 * pediria a senha de novo.
 */
export class SudoElevationError extends Error {
  /** Resposta HTTP quando chega a uma rota: 424 (dependência — o sudo — falhou). */
  readonly statusCode = 424;
  readonly code = "sudo_elevation_failed";
  constructor(readonly reason: SudoFailureReason) {
    super(SUDO_FAILURE_MESSAGES[reason]);
    this.name = "SudoElevationError";
  }
}

/**
 * Prompt do sudo imposto com -p: independe do locale do host (o texto padrão
 * é traduzido) e segue o formato do pt_BR, que o detector também reconhece.
 * %p é expandido pelo próprio sudo para o usuário cuja senha é pedida.
 */
export const SUDO_PROMPT = "[sudo] senha para %p: ";

/** Aspas simples POSIX: qualquer byte (exceto NUL) chega intacto ao bash. */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Linha digitada para rodar `cmd` como root no modo senha.
 *
 * `sudo cmd | outro` elevaria só o primeiro comando do pipeline; por isso o
 * comando INTEIRO vira o argumento único de `bash -c`, entre aspas simples
 * (os comandos são sempre de uma linha e já passaram pela allowlist no
 * formato ORIGINAL — o prefixo nunca amplia o que é aceito). O marcador
 * BEGIN é impresso DENTRO do bash elevado: se ele aparece, o sudo autorizou
 * e o `$?` seguinte é o código do comando; se o EXIT chega sem BEGIN, o sudo
 * não executou nada (SudoElevationError), sem confundir com o código 1 do
 * próprio sudo.
 */
export function buildElevatedCommand(cmd: string, nonce: string): string {
  const inner = `echo ":::PAAS_BEGIN_${nonce}"; ${cmd}`;
  return `sudo -p ${shellSingleQuote(SUDO_PROMPT)} -- bash -c ${shellSingleQuote(inner)}`;
}

/** `sudo -v`: valida (pedindo a senha se preciso) e renova a credencial em cache. */
export function buildSudoValidateCommand(): string {
  return `sudo -p ${shellSingleQuote(SUDO_PROMPT)} -v`;
}

// Prompt do sudo: o formato imposto por -p (pt_BR) ou o padrão em inglês
// (sudo digitado pelo próprio operador), terminando a saída acumulada ou a
// linha (quando o Enter chega na mesma leitura). O nome segue a regra de
// usuário Linux — o eco do comando digitado contém "%p: ", que não casa,
// então o próprio comando nunca dispara um falso pedido de senha.
const SUDO_PROMPT_RE = /\[sudo\] (?:senha para|password for) ([a-z_][a-z0-9_.-]{0,31}\$?): ?(?=\r?\n|$)/;
const SUDO_EXHAUSTED_RE = /incorrect password attempts?|tentativas? de senha incorretas?/i;
const SUDO_NOT_PERMITTED_RE =
  /is not in the sudoers file|is not allowed to (?:run sudo|execute)|não está no arquivo sudoers|não tem permissão para executar/i;
const SUDO_REJECTED_RE = /Sorry, try again\.|Desculpe, tente novamente\./i;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const DEFAULT_SUDO_PASSWORD_TIMEOUT_MS = 5 * 60_000;
const SUDO_TAIL_MAX = 512;

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
  /**
   * Observa a SAÍDA do PTY atrás do prompt de senha do sudo e emite
   * mensagens de controle (modo senha). Desligado no legado.
   */
  watchSudoPrompt?: boolean;
  /** Espera máxima pela senha do sudo com o prompt aberto (default 5 min). */
  sudoPasswordTimeoutMs?: number;
}

interface CommandWaiter {
  marker: string;
  /** Comando elevado: o BEGIN vem de dentro do bash elevado (buildElevatedCommand). */
  elevated: boolean;
  /** `sudo -v`: resolve só com código 0. */
  sudoValidation: boolean;
  /** Falha do sudo observada na saída enquanto este comando rodava. */
  sudoFailure: SudoFailureReason | null;
  timeoutMs: number;
  /** Instante-limite do relógio do comando (pausado com o prompt aberto). */
  deadline: number;
  remainingMs: number;
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

interface RunOptions {
  timeoutMs?: number | undefined;
  capture?: boolean;
  elevate?: boolean | undefined;
  sudoValidation?: boolean;
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_SCROLLBACK_CHARS = 64_000;
// SEM âncora de início: comandos cuja saída NÃO termina com newline (ex.:
// `... | tr '\\n' ' '`) fazem o echo do marcador imprimir COLADO na mesma
// linha da saída (`porta1 porta2 :::PAAS_EXIT_<n>:0`). O marcador só precisa
// terminar a linha — o trecho anterior continua sendo saída visível.
const EXIT_MARKER_RE = (nonce: string) => new RegExp(`:::PAAS_EXIT_${nonce}:(\\d+)\\r?$`);
// SEM âncora de início, pelo MESMO motivo do EXIT: o caso simétrico existe —
// provado em produção (VPS real). Quando o echo do input digitado chega
// intercalado/atrasado em relação ao output (shell de longa vida pós-fases
// de hardening), o marcador BEGIN sai COLADO na linha do prompt
// (`root@host:/# :::PAAS_BEGIN_<n>`) ou de saída anterior sem newline.
// Com a âncora ^ o BEGIN não casava: `capturing` nunca ligava, a captura
// saía VAZIA e a linha do marcador ainda vazava para o scrollback do
// usuário. O marcador só precisa TERMINAR a linha — o trecho anterior
// (prompt/resto de saída) continua visível.
const BEGIN_MARKER_RE = (nonce: string) => new RegExp(`:::PAAS_BEGIN_${nonce}\\r?$`);

export class TerminalService {
  private readonly openPty: PtyFactory;
  private readonly idleTimeoutMs: number;
  private readonly scrollbackChars: number;
  private readonly audit?: ((action: string, detail: string) => void) | undefined;
  private ensureTarget?: (() => Promise<void>) | undefined;
  private readonly watchSudoPrompt: boolean;
  private readonly sudoPasswordTimeoutMs: number;

  private pty: RemotePty | null = null;
  private opening: Promise<RemotePty> | null = null;
  private scrollback = "";
  private readonly listeners = new Set<(chunk: string) => void>();
  private readonly controlListeners = new Set<(msg: TerminalControlMessage) => void>();
  /** Fim da saída recente (sem ANSI), só para achar o prompt do sudo. */
  private sudoTail = "";
  private promptOpen = false;
  private promptUser: string | null = null;
  /** Saída desde que o prompt abriu (classifica como ele terminou). */
  private sudoAfterPrompt = "";
  private sudoPasswordTimer: NodeJS.Timeout | null = null;
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
    this.watchSudoPrompt = opts.watchSudoPrompt ?? false;
    this.sudoPasswordTimeoutMs = opts.sudoPasswordTimeoutMs ?? DEFAULT_SUDO_PASSWORD_TIMEOUT_MS;
  }

  /** true enquanto o sudo está pedindo senha no terminal (modo senha). */
  get sudoPromptOpen(): boolean {
    return this.promptOpen;
  }

  /** Usuário cuja senha o prompt aberto pede (null se fechado/desconhecido). */
  get sudoPromptUser(): string | null {
    return this.promptOpen ? this.promptUser : null;
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
    this.closeSudoPrompt("session-ended");
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
    this.closeSudoPrompt("session-ended");
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

  /** Assina as mensagens de controle (clientes WS). Retorna o unsubscribe. */
  onControl(cb: (msg: TerminalControlMessage) => void): () => void {
    this.controlListeners.add(cb);
    return () => this.controlListeners.delete(cb);
  }

  /** Emite uma mensagem de controle aos clientes (nunca passa pelo PTY). */
  emitControl(msg: TerminalControlMessage): void {
    for (const cb of this.controlListeners) {
      try {
        cb(msg);
      } catch {
        // cliente quebrado não derruba o terminal
      }
    }
  }

  /**
   * ESPELHO só de visualização (modo segundo-plano): o texto vai aos clientes
   * e ao scrollback como se fosse saída, mas NUNCA é escrito na entrada do
   * PTY — não é digitado no shell do usuário e não abre sessão.
   */
  mirror(text: string): void {
    this.broadcast(text);
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
    // Antes do waiter: uma falha do sudo e o EXIT podem chegar na MESMA
    // leitura, e a falha precisa estar registrada quando o EXIT resolver.
    if (this.watchSudoPrompt) this.watchSudoOutput(chunk);
    const waiter = this.waiter;
    if (!waiter) {
      this.broadcast(chunk);
      return;
    }
    const { visible, capturable, done, exitCode } = this.consumeForWaiter(waiter, chunk);
    if (visible.length > 0) {
      // Modo captura: só o trecho DEPOIS do marcador BEGIN vai ao caller,
      // com CRLF normalizado para \n (o stdout é parseado pelos checks do
      // scanner) — o prompt/saída anterior colado ANTES do BEGIN fica fora.
      // O BROADCAST segue cru (\r\n) para o xterm renderizar certinho — sem
      // efeito escada na tela do usuário.
      if (!waiter.capture) {
        waiter.onData(visible);
        waiter.captured += visible;
      } else if (capturable.length > 0) {
        const forCaller = capturable.replace(/\r\n/g, "\n");
        waiter.onData(forCaller);
        waiter.captured += forCaller;
      }
      this.broadcast(visible);
    }
    if (done) {
      clearTimeout(waiter.timer);
      this.clearSudoPasswordTimer();
      this.waiter = null;
      if (waiter.sudoValidation) {
        if (exitCode === 0) waiter.resolve({ code: 0, output: "" });
        else waiter.reject(new SudoElevationError(waiter.sudoFailure ?? "not-executed"));
      } else if (waiter.elevated && !waiter.capturing) {
        // EXIT sem o BEGIN que só o bash ELEVADO imprime: o sudo não
        // executou o comando. Nunca é desync (sem retentativa, que pediria a
        // senha de novo) e nunca é o código do comando.
        waiter.reject(new SudoElevationError(waiter.sudoFailure ?? "not-executed"));
      } else if (waiter.capture && !waiter.capturing) {
        // GUARDA DE INTEGRIDADE: o EXIT chegou sem que o BEGIN tivesse sido
        // detectado — a captura está vazia/corrompida. Entregar "" como
        // sucesso faria o scanner avaliar lixo (todos os checks "ausente").
        waiter.reject(
          new CaptureDesyncError(
            "captura dessincronizada: marcador BEGIN não detectado no fluxo do terminal (resultado descartado)",
          ),
        );
      } else {
        waiter.resolve({ code: exitCode ?? 1, output: waiter.captured });
      }
    }
  }

  /**
   * Parse linha a linha atrás dos marcadores :::PAAS_BEGIN_<nonce> (início
   * da captura) e :::PAAS_EXIT_<nonce>:<code> (fim + exit code). Ambos são
   * tolerantes a colagem (podem vir no meio da linha): o trecho anterior é
   * conteúdo real e segue visível. Os marcadores NÃO são exibidos no
   * terminal do usuário nem vão ao scrollback.
   */
  private consumeForWaiter(
    waiter: CommandWaiter,
    chunk: string,
  ): { visible: string; capturable: string; done: boolean; exitCode: number | null } {
    const re = EXIT_MARKER_RE(waiter.marker);
    const beginRe = BEGIN_MARKER_RE(waiter.marker);
    let buf = waiter.pending + chunk;
    let visible = "";
    // Trecho de `visible` produzido com a captura LIGADA (depois do BEGIN):
    // é o único que vai ao caller em modo captura. O prefixo colado antes do
    // BEGIN (prompt/resto de saída anterior) é exibido mas NÃO capturado.
    let capturable = "";
    let exitCode: number | null = null;
    const push = (s: string) => {
      visible += s;
      // Capturável = captura ligada E marcador EXIT ainda não visto: bytes
      // POSTERIORES ao EXIT no mesmo chunk (ex.: o próximo prompt, que chega
      // colado à linha do marcador numa única leitura do socket) são
      // exibidos ao usuário mas NUNCA poluem o stdout entregue ao scanner.
      if (waiter.capturing && exitCode === null) capturable += s;
    };
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl === -1) break;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if ((waiter.capture || waiter.elevated) && !waiter.capturing) {
        const b = beginRe.exec(line);
        if (b) {
          // Marcador de início: não é exibido nem capturado — a partir da
          // próxima linha a saída é do comando de fato. O trecho ANTES dele
          // na mesma linha (prompt sem newline/resto de saída anterior ao
          // qual o BEGIN colou) é conteúdo real: exibido, mas não capturado.
          push(line.slice(0, b.index));
          waiter.capturing = true;
          continue;
        }
      }
      const m = re.exec(line);
      if (m) {
        // Marcador colado após saída sem newline: o trecho ANTES do marcador
        // é saída real do comando e NÃO pode sumir (nem poluir o parse do
        // scanner). Sem "\n" sintético: o newline da linha era do echo do
        // marcador, não da saída — o captured fica byte a byte fiel.
        push(line.slice(0, m.index));
        exitCode = Number(m[1]);
      } else {
        push(line + "\n");
      }
    }
    // Segura o resto parcial SOMENTE se ele puder ser (o início de) uma linha
    // de marcador — prompts sem newline (ex.: "New password:") são exibidos
    // na hora, essencial para a interatividade.
    const exitFull = `:::PAAS_EXIT_${waiter.marker}:`;
    const beginFull = `:::PAAS_BEGIN_${waiter.marker}`;
    const candidate = buf.endsWith("\r") ? buf.slice(0, -1) : buf;
    const couldBeMarker = (full: string) => full.startsWith(candidate) || candidate.startsWith(full);
    const watchBegin = waiter.capture || waiter.elevated;
    if (couldBeMarker(exitFull) || (watchBegin && couldBeMarker(beginFull))) {
      waiter.pending = buf;
    } else {
      // Marcador colado NO MEIO da linha E dividido entre chunks (ex.: chunk
      // termina com "porta1 :::PAAS_EX"): segura a partir do último "::" cuja
      // continuação possa ser o marcador; o trecho anterior é exibido na hora.
      // Requer "::" no início do sufixo para NÃO prender prompts interativos
      // ("New password:" termina com ":" simples e aparece imediatamente).
      let glue = -1;
      for (let i = candidate.indexOf(":"); i !== -1; i = candidate.indexOf(":", i + 1)) {
        if (!candidate.startsWith("::", i)) continue;
        const suffix = candidate.slice(i);
        // O sufixo pode ser o início do EXIT (sempre) ou do BEGIN (enquanto
        // a captura não ligou — BEGIN colado ao prompt E dividido entre
        // chunks, ex.: `root@host:/# :::PAAS_BE` | `GIN_<n>`).
        if (
          exitFull.startsWith(suffix) ||
          (watchBegin && !waiter.capturing && beginFull.startsWith(suffix))
        ) {
          glue = i;
        }
      }
      if (glue !== -1) {
        push(buf.slice(0, glue));
        waiter.pending = buf.slice(glue);
      } else {
        push(buf);
        waiter.pending = "";
      }
    }
    return { visible, capturable, done: exitCode !== null, exitCode };
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
    opts?: { timeoutMs?: number; elevate?: boolean },
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
    opts?: { timeoutMs?: number; elevate?: boolean },
  ): Promise<CommandResult> {
    const attempt = () => this.enqueue(cmd, () => undefined, { ...opts, capture: true });
    return attempt().catch((err: unknown) => {
      // Dessincronia de captura (BEGIN perdido no byte stream): os comandos
      // desta variante são os checks SOMENTE-LEITURA do scanner — UMA
      // retentativa automática é segura. Se a segunda também dessincronizar,
      // o CaptureDesyncError propaga e o scanner marca o check como
      // unknown/erro em vez de avaliar uma saída vazia como "ausente".
      if (!(err instanceof CaptureDesyncError)) throw err;
      return attempt();
    });
  }

  /**
   * Modo senha: `sudo -v` no início de uma execução longa (varredura, fila de
   * fases) — pede a senha UMA vez, antes do primeiro comando, e renova a
   * credencial em cache sem perguntar de novo enquanto ela vale. Rejeita com
   * SudoElevationError se o sudo não confirmar.
   */
  validateSudo(opts?: { timeoutMs?: number }): Promise<void> {
    return this.enqueue("", () => undefined, { ...opts, sudoValidation: true }).then(() => undefined);
  }

  private enqueue(
    cmd: string,
    onData: (chunk: string) => void,
    opts?: RunOptions,
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
    opts?: RunOptions,
  ): Promise<CommandResult> {
    await this.ensureSession(); // TerminalUnavailableError aqui = antes de começar
    const nonce = randomBytes(4).toString("hex");
    const capture = opts?.capture ?? false;
    const sudoValidation = opts?.sudoValidation ?? false;
    const elevated = !sudoValidation && (opts?.elevate ?? false);
    const timeoutMs = opts?.timeoutMs ?? 30 * 60_000;
    return new Promise<CommandResult>((resolve, reject) => {
      const waiter: CommandWaiter = {
        marker: nonce,
        elevated,
        sudoValidation,
        sudoFailure: null,
        timeoutMs,
        deadline: 0,
        remainingMs: timeoutMs,
        capture,
        capturing: false,
        captured: "",
        onData,
        resolve,
        reject,
        pending: "",
        timer: undefined as unknown as NodeJS.Timeout,
      };
      this.waiter = waiter;
      this.armCommandTimer(waiter, timeoutMs);
      // O comando digitado inclui os marcadores de início/fim — honesto e
      // visível para o usuário, como num SSH real.
      let line: string;
      if (sudoValidation) line = buildSudoValidateCommand();
      else if (elevated) line = buildElevatedCommand(cmd, nonce); // BEGIN vem de dentro do sudo
      else line = `${capture ? `echo ":::PAAS_BEGIN_${nonce}"; ` : ""}${cmd}`;
      this.write(`${line}; echo ":::PAAS_EXIT_${nonce}:$?"\n`);
    });
  }

  private armCommandTimer(waiter: CommandWaiter, ms: number): void {
    waiter.deadline = Date.now() + ms;
    waiter.timer = setTimeout(() => this.onCommandTimeout(waiter), ms);
    waiter.timer.unref();
  }

  private onCommandTimeout(waiter: CommandWaiter): void {
    // Timeout: interrompe com Ctrl-C e dá um grace curto pelo marcador.
    this.write("\x03");
    this.rejectAfterGrace(waiter, () => {
      // REGRA: o timeout de UM comando NUNCA derruba a sessão. Um check
      // lento não pode destruir o terminal que o usuário está vendo
      // (nem o container paas-terminal-*): o Ctrl-C devolve o prompt e
      // a fila segue no mesmo shell. Sessão comprovadamente morta é
      // tratada pelos eventos do stream (end/close/error →
      // handleSessionEnd), nunca por timeout de comando.
      this.broadcast(
        "\r\n\x1b[33m[terminal] comando interrompido por tempo limite — a sessão continua ativa\x1b[0m\r\n",
      );
      return new Error(`comando excedeu o tempo limite no terminal (${waiter.timeoutMs}ms)`);
    });
  }

  /** Depois de um Ctrl-C: se o marcador não chegar na folga, rejeita e libera a fila. */
  private rejectAfterGrace(waiter: CommandWaiter, makeError: () => Error): void {
    setTimeout(() => {
      if (this.waiter !== waiter) return; // marcador chegou — já resolvido
      this.waiter = null;
      waiter.reject(makeError());
    }, 5_000).unref();
  }

  // -------------------------------------------------------------------------
  // Prompt de senha do sudo (modo senha) — SÓ a SAÍDA do PTY é observada
  // -------------------------------------------------------------------------

  /**
   * Chamado com cada pedaço de SAÍDA do PTY (nunca com input). Abre o prompt
   * quando o fim da saída é o pedido de senha do sudo; com o prompt aberto,
   * a primeira linha não vazia que chega diz como ele terminou.
   */
  private watchSudoOutput(chunk: string): void {
    let text = chunk.replace(ANSI_RE, "");
    while (text.length > 0) {
      if (!this.promptOpen) {
        const tail = this.sudoTail + text;
        const m = SUDO_PROMPT_RE.exec(tail);
        if (!m) {
          this.sudoTail = tail.slice(-SUDO_TAIL_MAX);
          break;
        }
        this.openSudoPrompt(m[1] ?? null);
        // o que veio depois do prompt na mesma leitura (Enter, erro...) conta
        text = tail.slice(m.index + m[0].length);
        continue;
      }
      this.sudoAfterPrompt = (this.sudoAfterPrompt + text).slice(-SUDO_TAIL_MAX);
      text = "";
      const line = /^\s*(\S[^\n]*)\n/.exec(this.sudoAfterPrompt);
      if (!line) continue; // só Enter/whitespace até aqui (ex.: atraso do PAM)
      const first = line[1] ?? "";
      const outcome: SudoPromptOutcome = SUDO_EXHAUSTED_RE.test(first)
        ? "exhausted"
        : SUDO_NOT_PERMITTED_RE.test(first)
          ? "not-permitted"
          : SUDO_REJECTED_RE.test(first)
            ? "rejected"
            : "answered";
      // o resto (ex.: um prompt novo depois de "Sorry, try again.") é reanalisado
      text = this.sudoAfterPrompt.slice(line[0].length);
      this.closeSudoPrompt(outcome);
    }
  }

  private openSudoPrompt(user: string | null): void {
    this.promptOpen = true;
    this.promptUser = user;
    this.sudoTail = "";
    this.sudoAfterPrompt = "";
    this.emitControl({ type: "sudo-password-requested", user });
    const waiter = this.waiter;
    if (!waiter) return; // sudo digitado pelo operador: nenhum relógio do painel
    // Pausa o relógio do comando: esperar a senha não é o comando demorando.
    clearTimeout(waiter.timer);
    waiter.remainingMs = Math.max(0, waiter.deadline - Date.now());
    this.clearSudoPasswordTimer();
    this.sudoPasswordTimer = setTimeout(() => this.onSudoPasswordTimeout(waiter), this.sudoPasswordTimeoutMs);
    this.sudoPasswordTimer.unref();
  }

  private closeSudoPrompt(outcome: SudoPromptOutcome): void {
    if (!this.promptOpen) return;
    this.promptOpen = false;
    this.sudoTail = "";
    this.sudoAfterPrompt = "";
    const hadPasswordTimer = this.sudoPasswordTimer !== null;
    this.clearSudoPasswordTimer();
    this.emitControl({ type: "sudo-password-prompt-closed", outcome });
    const waiter = this.waiter;
    if (!waiter) return;
    if (outcome === "exhausted" || outcome === "not-permitted") waiter.sudoFailure = outcome;
    // Retoma o relógio do comando com o tempo que restava.
    if (hadPasswordTimer && outcome !== "session-ended") this.armCommandTimer(waiter, waiter.remainingMs);
  }

  private onSudoPasswordTimeout(waiter: CommandWaiter): void {
    this.sudoPasswordTimer = null;
    if (this.waiter !== waiter) return;
    waiter.sudoFailure = "timeout";
    this.closeSudoPrompt("timeout");
    clearTimeout(waiter.timer); // sem relógio do comando: o desfecho é o da senha
    this.broadcast(
      "\r\n\x1b[33m[terminal] tempo esgotado aguardando a senha do sudo — pedido cancelado (Ctrl-C)\x1b[0m\r\n",
    );
    // Ctrl-C encerra o sudo: nada fica pendurado esperando senha.
    this.write("\x03");
    this.rejectAfterGrace(waiter, () => new SudoElevationError("timeout"));
  }

  private clearSudoPasswordTimer(): void {
    if (this.sudoPasswordTimer) clearTimeout(this.sudoPasswordTimer);
    this.sudoPasswordTimer = null;
  }
}
