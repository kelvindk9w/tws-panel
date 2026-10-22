/**
 * login-limiter.ts — rate limit do login por IP: 5 tentativas/minuto; ao
 * estourar, lockout progressivo (1min, 2min, 4min… até 30min). Em memória —
 * suficiente para um painel single-node (o contador reinicia com o processo).
 * A chave é o IPv4 exato ou o bloco /64 do IPv6 (ver ip-group.ts); chaves que
 * não são IP (ex.: "conta:<id>", usadas nas rotas com sessão) valem como estão.
 *
 * A tentativa é RESERVADA antes de a senha ser verificada (`check`): falhas
 * recentes + tentativas em andamento nunca passam do limite. Sem isso, 60
 * pedidos simultâneos passavam todos pelo `check` antes de a primeira falha
 * ser contada, e a senha era avaliada 60 vezes (achado M2). Quem reserva
 * precisa terminar com `onFailure`, `onSuccess` ou `release`.
 */
import { LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS } from "@paas/core";
import { ipGroupKey } from "./ip-group.js";

const BASE_LOCKOUT_MS = 60 * 1000;
const MAX_LOCKOUT_MS = 30 * 60 * 1000;
/** Quando recusado só porque há tentativas em andamento: tentar de novo em instantes. */
const BUSY_RETRY_SEC = 5;
const PRUNE_EVERY_MS = 60 * 1000;
/** Teto de IPs rastreados ao mesmo tempo (memória limitada, B14). */
const DEFAULT_MAX_TRACKED = 10_000;

interface IpState {
  /** timestamps das falhas recentes (dentro da janela). */
  failures: number[];
  /** tentativas reservadas cuja senha ainda está sendo verificada. */
  inflight: number;
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
  private lastPrune = 0;

  constructor(private readonly maxTracked: number = DEFAULT_MAX_TRACKED) {}

  private stateFor(ip: string): IpState {
    let state = this.ips.get(ip);
    if (!state) {
      state = { failures: [], inflight: 0, lockLevel: 0, lockedUntil: 0 };
      this.ips.set(ip, state);
    }
    return state;
  }

  /**
   * O IP não guarda nada que valha manter? Sem falha na janela, sem pedido em
   * andamento e sem bloqueio recente (o nível do lockout esfria 30 min depois
   * de o bloqueio vencer).
   */
  private idle(state: IpState, now: number): boolean {
    return (
      state.inflight === 0 &&
      state.lockedUntil + MAX_LOCKOUT_MS <= now &&
      state.failures.every((t) => now - t >= LOGIN_WINDOW_MS)
    );
  }

  /**
   * Poda periódica (B14): remove IPs ociosos e, passando do teto, os mais
   * antigos que não estejam bloqueados nem com pedido em andamento.
   */
  private prune(now: number, force = false): void {
    if (!force && now - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    for (const [ip, state] of this.ips) {
      if (this.idle(state, now)) this.ips.delete(ip);
    }
    if (this.ips.size <= this.maxTracked) return;
    for (const [ip, state] of this.ips) {
      if (this.ips.size <= this.maxTracked) break;
      if (state.inflight === 0 && state.lockedUntil <= now) this.ips.delete(ip);
    }
  }

  /** Número de IPs rastreados (testes e diagnóstico). */
  size(): number {
    return this.ips.size;
  }

  /** Pergunta se o IP pode tentar agora e, se puder, RESERVA a tentativa. */
  check(rawIp: string): LoginAttemptResult {
    const ip = ipGroupKey(rawIp);
    const now = Date.now();
    this.prune(now);
    const state = this.stateFor(ip);
    if (state.lockedUntil > now) {
      return { allowed: false, retryAfterSec: Math.ceil((state.lockedUntil - now) / 1000) };
    }
    state.failures = state.failures.filter((t) => now - t < LOGIN_WINDOW_MS);
    if (state.failures.length + state.inflight >= LOGIN_MAX_ATTEMPTS) {
      return { allowed: false, retryAfterSec: BUSY_RETRY_SEC };
    }
    state.inflight += 1;
    return { allowed: true, retryAfterSec: 0 };
  }

  /** Devolve a reserva sem contar falha (senha certa à espera do 2FA, erro interno). */
  release(rawIp: string): void {
    const state = this.ips.get(ipGroupKey(rawIp));
    if (state && state.inflight > 0) state.inflight -= 1;
  }

  /** Converte a reserva em falha; ao atingir o limite na janela, aplica lockout progressivo. */
  onFailure(rawIp: string): LoginAttemptResult {
    const ip = ipGroupKey(rawIp);
    this.release(ip);
    const state = this.stateFor(ip);
    const now = Date.now();
    state.failures = state.failures.filter((t) => now - t < LOGIN_WINDOW_MS);
    state.failures.push(now);
    if (state.failures.length >= LOGIN_MAX_ATTEMPTS) {
      const lockMs = Math.min(BASE_LOCKOUT_MS * 2 ** state.lockLevel, MAX_LOCKOUT_MS);
      state.lockLevel += 1;
      state.lockedUntil = now + lockMs;
      state.failures = [];
      this.prune(now, this.ips.size > this.maxTracked);
      return { allowed: false, retryAfterSec: Math.ceil(lockMs / 1000) };
    }
    this.prune(now, this.ips.size > this.maxTracked);
    return { allowed: true, retryAfterSec: 0 };
  }

  /** Login bem-sucedido: zera falhas e lockout do IP. */
  onSuccess(rawIp: string): void {
    this.ips.delete(ipGroupKey(rawIp));
  }
}
