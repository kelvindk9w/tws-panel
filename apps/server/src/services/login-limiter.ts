/**
 * login-limiter.ts — rate limit do login por IP: 5 tentativas/minuto; ao
 * estourar, lockout progressivo (1min, 2min, 4min… até 30min). Em memória —
 * suficiente para um painel single-node (o contador reinicia com o processo).
 */
import { LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS } from "@paas/core";

const BASE_LOCKOUT_MS = 60 * 1000;
const MAX_LOCKOUT_MS = 30 * 60 * 1000;

interface IpState {
  /** timestamps das falhas recentes (dentro da janela). */
  failures: number[];
  /** nível atual de lockout (dobra a cada bloqueio). */
  lockLevel: number;
  /** até quando o IP está bloqueado (epoch ms). */
  lockedUntil: number;
}

export interface LoginAttemptResult {
  allowed: boolean;
  /** segundos até poder tentar de novo (quando bloqueado). */
  retryAfterSec: number;
}

export class LoginLimiter {
  private readonly ips = new Map<string, IpState>();

  private stateFor(ip: string): IpState {
    let state = this.ips.get(ip);
    if (!state) {
      state = { failures: [], lockLevel: 0, lockedUntil: 0 };
      this.ips.set(ip, state);
    }
    return state;
  }

  /** Verifica se o IP pode tentar agora (sem registrar nada). */
  check(ip: string): LoginAttemptResult {
    const state = this.stateFor(ip);
    const now = Date.now();
    if (state.lockedUntil > now) {
      return { allowed: false, retryAfterSec: Math.ceil((state.lockedUntil - now) / 1000) };
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  /** Registra uma falha; ao atingir o limite na janela, aplica lockout progressivo. */
  onFailure(ip: string): LoginAttemptResult {
    const state = this.stateFor(ip);
    const now = Date.now();
    state.failures = state.failures.filter((t) => now - t < LOGIN_WINDOW_MS);
    state.failures.push(now);
    if (state.failures.length >= LOGIN_MAX_ATTEMPTS) {
      const lockMs = Math.min(BASE_LOCKOUT_MS * 2 ** state.lockLevel, MAX_LOCKOUT_MS);
      state.lockLevel += 1;
      state.lockedUntil = now + lockMs;
      state.failures = [];
      return { allowed: false, retryAfterSec: Math.ceil(lockMs / 1000) };
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  /** Login bem-sucedido: zera falhas e lockout do IP. */
  onSuccess(ip: string): void {
    this.ips.delete(ip);
  }
}
