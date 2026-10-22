/**
 * action-guard.ts — limite de tentativas nas rotas que pedem a senha (ou o
 * código) com a sessão JÁ aberta: trocar senha, ativar/desativar a verificação
 * em duas etapas e recomeçar o assistente.
 *
 * Quem tem a sessão (cookie roubado) e a senha vazada não deve poder
 * adivinhar o código ou a senha sem limite. A contagem é por CONTA, não por
 * sessão nem por IP: abrir outra sessão ou trocar de IP não zera nada. Usa o
 * mesmo bloqueio progressivo do login (5 erros em 1 min → 1 min, dobrando até
 * 30 min). Só uma ação concluída com sucesso zera a contagem.
 */
import type { FastifyReply } from "fastify";
import type { LoginAttemptResult, LoginLimiter } from "./login-limiter.js";

export function accountKey(userId: string): string {
  return `conta:${userId}`;
}

/** 429 padrão de "muitas tentativas" (mesma forma do login). */
export function sendTooManyAttempts(reply: FastifyReply, retryAfterSec: number): FastifyReply {
  reply.header("retry-after", String(retryAfterSec));
  return reply.code(429).send({
    error: "too_many_attempts",
    message: `Muitas tentativas. Aguarde ${retryAfterSec}s e tente novamente.`,
    retryAfterSec,
  });
}

/** Tentativa reservada: termina com fail(), success() ou release() (nunca fica presa). */
export class ActionAttempt {
  private settled = false;

  constructor(
    private readonly limiter: LoginLimiter,
    private readonly key: string,
  ) {}

  /** Erro de senha/código: conta a falha. Se estourou o limite, `allowed` vem false. */
  fail(): LoginAttemptResult {
    this.settled = true;
    return this.limiter.onFailure(this.key);
  }

  /** Ação concluída: zera a contagem da conta. */
  success(): void {
    this.settled = true;
    this.limiter.onSuccess(this.key);
  }

  /** Sai sem contar (erro que não é de senha: payload, conflito, falha de disco). Idempotente. */
  release(): void {
    if (this.settled) return;
    this.settled = true;
    this.limiter.release(this.key);
  }
}

/**
 * Reserva uma tentativa da conta. Se já está bloqueada, responde 429 e devolve
 * null (quem chamou só retorna `reply`).
 */
export function beginAction(limiter: LoginLimiter, userId: string, reply: FastifyReply): ActionAttempt | null {
  const key = accountKey(userId);
  const gate = limiter.check(key);
  if (!gate.allowed) {
    sendTooManyAttempts(reply, gate.retryAfterSec);
    return null;
  }
  return new ActionAttempt(limiter, key);
}
