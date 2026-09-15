/**
 * terminal-runner.ts — TargetRunner que delega ao runner real, mas executa os
 * comandos DENTRO do terminal web do servidor:
 *
 *  - execStream (scripts de fase): saída rolando AO VIVO no terminal embutido
 *    e prompts interativos respondidos pelo usuário digitando no xterm;
 *  - exec (checks somente-leitura do scanner — ex.: `cat /etc/os-release`,
 *    verificações de SSH/firewall): rodados via runCommandCaptured, que usa
 *    marcadores BEGIN/EXIT para capturar o stdout limpo (sem o eco do comando)
 *    ENQUANTO o usuário vê cada check rodando de verdade no terminal.
 *
 * SEGURANÇA (inalterada em relação ao runner base):
 *  - os comandos são strings FIXAS definidas em @paas/security (checks, Lynis,
 *    scripts de fase) — nenhum parâmetro vindo da API vira shell;
 *  - no perfil "host", comandos fora da allowlist do host bridge NÃO sobem
 *    pelo terminal: caem no runner base, que os rejeita (fail-closed);
 *  - cada comando roteado pelo terminal é registrado em auditoria.
 *
 * Fallback: se o terminal não puder ser aberto (ex.: docker.sock ausente em
 * ambiente de teste), o comando roda pelo runner original, como antes — a
 * indisponibilidade do terminal nunca impede scan nem hardening. EXCETO no
 * modo senha (elevation "sudo"): lá o operador escolheu que root só acontece
 * no terminal dele, com a senha dele; cair para o host bridge seria rodar
 * como root em segundo plano sem que ele tenha pedido — falha com mensagem.
 *
 * Modos (PAAS_ROOT_MODE, ver config.ts):
 *  - legado / root: TerminalRelayRunner sem elevação (terminal já é root);
 *  - "senha": TerminalRelayRunner com elevation "sudo";
 *  - "segundo-plano": BackgroundMirrorRunner (host bridge + espelho).
 */
import { isAllowedHostCommand, type TargetRunner, type ExecResult } from "@paas/security";
import type { SecurityTargetProfile } from "@paas/core";
import {
  SudoElevationError,
  TerminalService,
  TerminalUnavailableError,
} from "./terminal-service.js";

/** Diretório remoto padrão dos scripts no host (mesmo default do host bridge). */
const HOST_REMOTE_DIR_DEFAULT = "/opt/paas-hardening";

export interface TerminalRelayRunnerOptions {
  /** Diretório remoto dos scripts no host (validação da allowlist). */
  remoteDir?: string;
  /** Auditoria de comandos executados no host real via terminal. */
  onAudit?: (detail: string) => void;
  /**
   * "sudo" (modo senha): terminal aberto como usuário comum — cada comando
   * da allowlist é digitado elevado inteiro com sudo, a credencial é validada
   * no início (ensureReady) e renovada antes de cada script de fase.
   */
  elevation?: "none" | "sudo";
}

function senhaModeUnavailable(err: TerminalUnavailableError): Error {
  return new Error(
    `terminal indisponível (${err.message}). No modo senha (PAAS_ROOT_MODE=senha) os comandos com root só rodam ` +
      `no seu terminal, com a sua senha — nada foi executado em segundo plano. Reabra o terminal e tente de novo.`,
  );
}

export class TerminalRelayRunner implements TargetRunner {
  private readonly remoteDir: string;
  private readonly onAudit?: ((detail: string) => void) | undefined;
  private readonly elevate: boolean;
  /**
   * Primeira falha do sudo desta execução (senha errada 3x, sem permissão,
   * tempo esgotado). Enquanto registrada, os comandos seguintes falham na
   * hora, sem digitar nada (não pede a senha 27 vezes). O scanner transforma
   * erro de check em "unknown"; quem orquestra (SecurityService) consulta
   * takeElevationFailure() e falha a varredura inteira com a mensagem.
   */
  private elevationFailure: SudoElevationError | null = null;

  constructor(
    private readonly base: TargetRunner,
    private readonly terminal: TerminalService,
    opts?: TerminalRelayRunnerOptions,
  ) {
    this.remoteDir = opts?.remoteDir ?? HOST_REMOTE_DIR_DEFAULT;
    this.onAudit = opts?.onAudit;
    this.elevate = opts?.elevation === "sudo";
  }

  /** Devolve (e limpa) a falha do sudo registrada nesta execução, se houver. */
  takeElevationFailure(): SudoElevationError | null {
    const failure = this.elevationFailure;
    this.elevationFailure = null;
    return failure;
  }

  get label(): string {
    return this.base.label;
  }

  get profile(): SecurityTargetProfile {
    return this.base.profile;
  }

  async ensureReady(): Promise<void> {
    await this.base.ensureReady();
    if (!this.elevate) return;
    // Início de uma execução longa (varredura ou job de fase): zera a trava
    // da execução anterior e pede a senha UMA vez, antes do primeiro comando.
    this.elevationFailure = null;
    await this.elevated(() => this.terminal.validateSudo());
  }

  /** Executa um passo elevado registrando falhas do sudo e sem fallback. */
  private async elevated<T>(fn: () => Promise<T>): Promise<T> {
    if (this.elevationFailure) throw this.elevationFailure;
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SudoElevationError) this.elevationFailure = err;
      if (err instanceof TerminalUnavailableError) throw senhaModeUnavailable(err);
      throw err;
    }
  }

  private audit(detail: string): void {
    this.onAudit?.(detail.length > 400 ? `${detail.slice(0, 400)}…` : detail);
  }

  /**
   * No perfil "host", só comandos da allowlist do host bridge podem subir
   * pelo terminal. Fora dela, delegamos ao runner base — que rejeita com
   * erro explícito (o comportamento fail-closed se mantém).
   */
  private allowedOnHost(cmd: string): boolean {
    // Com sudo a allowlist vale em QUALQUER perfil e sempre sobre o comando
    // ORIGINAL — o prefixo elevado nunca é aplicado a string arbitrária.
    if (this.elevate) return isAllowedHostCommand(cmd, this.remoteDir);
    return this.profile !== "host" || isAllowedHostCommand(cmd, this.remoteDir);
  }

  /**
   * Checks somente-leitura (scanner/Lynis) rodam DENTRO do terminal: o
   * usuário vê cada comando ao vivo e o stdout é capturado limpo entre os
   * marcadores BEGIN/EXIT para o parse do scanner.
   */
  async exec(cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    if (!this.allowedOnHost(cmd)) {
      return this.base.exec(cmd, opts);
    }
    if (this.elevate) {
      if (this.elevationFailure) throw this.elevationFailure;
      this.audit(`host-exec (terminal, sudo): ${cmd}`);
      const { code, output } = await this.elevated(() =>
        this.terminal.runCommandCaptured(cmd, { timeoutMs: opts?.timeoutMs, elevate: true }),
      );
      return { code, stdout: output, stderr: "" };
    }
    try {
      this.audit(`host-exec (terminal): ${cmd}`);
      const { code, output } = await this.terminal.runCommandCaptured(cmd, {
        timeoutMs: opts?.timeoutMs,
      });
      // No PTY, stderr chega misturado ao stream (TTY não separa) — os checks
      // do scanner só leem stdout e comandos ruidosos já usam 2>/dev/null.
      return { code, stdout: output, stderr: "" };
    } catch (err) {
      if (err instanceof TerminalUnavailableError) {
        // terminal indisponível ANTES de o comando começar: fallback seguro.
        return this.base.exec(cmd, opts);
      }
      // comando já estava rodando quando falhou (timeout/sessão morta) —
      // NUNCA re-executar (risco de efeitos colaterais duplicados).
      throw err;
    }
  }

  uploadDir(localDir: string, remoteDir: string): Promise<void> {
    return this.base.uploadDir(localDir, remoteDir);
  }

  async execStream(cmd: string, onData: (chunk: string) => void): Promise<number> {
    if (!this.allowedOnHost(cmd)) {
      return this.base.execStream(cmd, onData);
    }
    if (this.elevate) {
      // Renova a credencial antes do script (fases podem ser longas): sem
      // prompt enquanto ela vale; se expirou, a senha é pedida ANTES de a
      // saída da fase começar a rolar.
      await this.elevated(() => this.terminal.validateSudo()); // lança a trava, se houver
      this.audit(`host-exec (stream/terminal, sudo): ${cmd}`);
      return this.elevated(() => this.terminal.runCommand(cmd, onData, { elevate: true }));
    }
    try {
      this.audit(`host-exec (stream/terminal): ${cmd}`);
      return await this.terminal.runCommand(cmd, onData);
    } catch (err) {
      if (err instanceof TerminalUnavailableError) {
        // terminal indisponível ANTES de o comando começar: fallback seguro.
        return this.base.execStream(cmd, onData);
      }
      // comando já estava rodando quando falhou (timeout/sessão morta) —
      // NUNCA re-executar (risco de aplicar a fase duas vezes).
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Modo segundo-plano: host bridge + espelho só de visualização
// ---------------------------------------------------------------------------

/** Teto do espelho de UM comando capturado (o executor recebe tudo). */
const MIRROR_EXEC_MAX_CHARS = 4_000;
const BAR = "\x1b[35m│\x1b[0m ";

/** Troca caracteres de controle por "?": o cabeçalho nunca vira escape de terminal. */
function printable(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x1f\x7f]/g, "?");
}

/**
 * Bloco de espelho de UM comando: cabeçalho, linhas prefixadas com a barra
 * lateral (diferencia do que o usuário digita) e rodapé com o código.
 */
class MirrorBlock {
  private atLineStart = true;

  constructor(
    private readonly terminal: Pick<TerminalService, "mirror" | "emitControl">,
    private readonly command: string,
  ) {
    terminal.emitControl({ type: "background-exec", state: "start", command });
    terminal.mirror(
      `\r\n\x1b[1;35m┌─ [segundo plano] executando como root pelo host bridge — não foi digitado no seu terminal\x1b[0m\r\n` +
        `${BAR}\x1b[1m# ${printable(command)}\x1b[0m\r\n`,
    );
  }

  write(chunk: string): void {
    if (chunk.length === 0) return;
    let out = "";
    for (const ch of chunk.replace(/\r\n/g, "\n")) {
      if (this.atLineStart && ch !== "\n") {
        out += BAR;
        this.atLineStart = false;
      }
      if (ch === "\n") {
        out += this.atLineStart ? `${BAR}\r\n` : "\r\n";
        this.atLineStart = true;
      } else {
        out += ch;
      }
    }
    this.terminal.mirror(out);
  }

  end(code: number | null, failure?: unknown): void {
    const close = this.atLineStart ? "" : "\r\n";
    const status =
      failure !== undefined
        ? `falhou: ${printable(failure instanceof Error ? failure.message : String(failure))}`
        : `código de saída ${code} — registrado na auditoria`;
    this.terminal.mirror(`${close}\x1b[35m└─ ${status}\x1b[0m\r\n`);
    this.terminal.emitControl({ type: "background-exec", state: "end", command: this.command, code });
  }
}

/**
 * Runner do modo segundo-plano (PAAS_ROOT_MODE=segundo-plano): a varredura e
 * as fases rodam pelo runner base — o host bridge (NsenterHostRunner), com a
 * allowlist e a auditoria `hardening.host-exec` de sempre — e NADA é digitado
 * no terminal do usuário. A saída é ESPELHADA no terminal ao vivo só para
 * visualização (TerminalService.mirror: vai aos clientes e ao scrollback,
 * nunca ao stdin do PTY), com cabeçalho deixando claro que é root em segundo
 * plano. O operador pode conferir depois na tela de Auditoria.
 */
export class BackgroundMirrorRunner implements TargetRunner {
  constructor(
    private readonly base: TargetRunner,
    private readonly terminal: Pick<TerminalService, "mirror" | "emitControl">,
  ) {}

  get label(): string {
    return this.base.label;
  }

  get profile(): SecurityTargetProfile {
    return this.base.profile;
  }

  ensureReady(): Promise<void> {
    return this.base.ensureReady();
  }

  async exec(cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    const block = new MirrorBlock(this.terminal, cmd);
    try {
      const result = await this.base.exec(cmd, opts);
      const output = `${result.stdout}${result.stderr}`;
      block.write(
        output.length > MIRROR_EXEC_MAX_CHARS
          ? `${output.slice(0, MIRROR_EXEC_MAX_CHARS)}\n… (saída truncada no espelho; ${output.length} caracteres no total)\n`
          : output,
      );
      block.end(result.code);
      return result;
    } catch (err) {
      block.end(null, err);
      throw err;
    }
  }

  async uploadDir(localDir: string, remoteDir: string): Promise<void> {
    this.terminal.mirror(
      `\r\n\x1b[35m── [segundo plano] enviando os scripts de hardening para ${printable(remoteDir)} (root, host bridge)\x1b[0m\r\n`,
    );
    await this.base.uploadDir(localDir, remoteDir);
  }

  async execStream(cmd: string, onData: (chunk: string) => void): Promise<number> {
    const block = new MirrorBlock(this.terminal, cmd);
    try {
      const code = await this.base.execStream(cmd, (chunk) => {
        block.write(chunk);
        onData(chunk);
      });
      block.end(code);
      return code;
    } catch (err) {
      block.end(null, err);
      throw err;
    }
  }
}
