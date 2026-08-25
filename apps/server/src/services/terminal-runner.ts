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
 * indisponibilidade do terminal nunca impede scan nem hardening.
 */
import { isAllowedHostCommand, type TargetRunner, type ExecResult } from "@paas/security";
import type { SecurityTargetProfile } from "@paas/core";
import { TerminalService, TerminalUnavailableError } from "./terminal-service.js";

/** Diretório remoto padrão dos scripts no host (mesmo default do host bridge). */
const HOST_REMOTE_DIR_DEFAULT = "/opt/paas-hardening";

export interface TerminalRelayRunnerOptions {
  /** Diretório remoto dos scripts no host (validação da allowlist). */
  remoteDir?: string;
  /** Auditoria de comandos executados no host real via terminal. */
  onAudit?: (detail: string) => void;
}

export class TerminalRelayRunner implements TargetRunner {
  private readonly remoteDir: string;
  private readonly onAudit?: ((detail: string) => void) | undefined;

  constructor(
    private readonly base: TargetRunner,
    private readonly terminal: TerminalService,
    opts?: TerminalRelayRunnerOptions,
  ) {
    this.remoteDir = opts?.remoteDir ?? HOST_REMOTE_DIR_DEFAULT;
    this.onAudit = opts?.onAudit;
  }

  get label(): string {
    return this.base.label;
  }

  get profile(): SecurityTargetProfile {
    return this.base.profile;
  }

  ensureReady(): Promise<void> {
    return this.base.ensureReady();
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
