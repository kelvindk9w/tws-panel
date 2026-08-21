/**
 * terminal-runner.ts — TargetRunner que delega ao runner real, mas executa os
 * comandos STREAMADOS (scripts de fase) DENTRO do terminal web do servidor.
 *
 * Resultado: a saída dos comandos rola AO VIVO no terminal embutido do painel
 * (além da UI formatada) e prompts interativos são respondidos pelo usuário
 * digitando no xterm — o input segue pelo PTY, nunca por logs.
 *
 * Fallback: se o terminal não puder ser aberto (ex.: docker.sock ausente em
 * ambiente de teste), o comando roda pelo runner original, como antes — a
 * indisponibilidade do terminal nunca impede o hardening.
 */
import type { TargetRunner, ExecResult } from "@paas/security";
import type { SecurityTargetProfile } from "@paas/core";
import { TerminalService, TerminalUnavailableError } from "./terminal-service.js";

export class TerminalRelayRunner implements TargetRunner {
  constructor(
    private readonly base: TargetRunner,
    private readonly terminal: TerminalService,
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

  exec(cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    return this.base.exec(cmd, opts);
  }

  uploadDir(localDir: string, remoteDir: string): Promise<void> {
    return this.base.uploadDir(localDir, remoteDir);
  }

  async execStream(cmd: string, onData: (chunk: string) => void): Promise<number> {
    try {
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
