/**
 * action-guard.ts — limite de tentativas nas rotas que pedem a senha (ou o
 * código) com a sessão JÁ aberta: trocar senha, ativar/desativar a verificação
 * em duas etapas e recomeçar o assistente.
 *
 * Quem tem a sessão (cookie roubado) e a senha vazada não deve poder
 * adivinhar o código ou a senha sem limite. Duas contagens independentes, e
 * as DUAS precisam permitir: por IP (bloco /64 no IPv6) e por SESSÃO. Assim a
 * sessão (ou o IP) de um atacante não bloqueia a sessão legítima do dono, o
 * que aconteceria com um limite por conta. Usa o mesmo bloqueio progressivo
 * do login (5 erros em 1 min → 1 min, dobrando até 30 min). Só uma ação
 * concluída com sucesso zera a contagem.
 *
 * Limite conhecido: um cookie roubado É a mesma sessão do dono; se o atacante
 * esgotar a contagem dessa sessão, o dono entra de novo (o login tem limite
 * próprio) e usa a sessão nova. O código de 6 dígitos tem, além disso, o
 * bloqueio por conta do 2FA (two-factor.ts).
 */
import type { FastifyReply } from "fastify";
import type { LoginAttemptResult, LoginLimiter } from "./login-limiter.js";

/** 429 padrão de "muitas tentativas" (mesma forma do login). */
export function sendTooManyAttempts(reply: FastifyReply, retryAfterSec: number): FastifyReply {
  reply.header("retry-after", String(retryAfterSec));
  return reply.code(429).send({
    error: "too_many_attempts",
    message: `Muitas tentativas. Aguarde ${retryAfterSec}s e tente novamente.`,
    retryAfterSec,
  });
}

/** Tentativa reservada nas duas contagens: termina com fail(), success() ou release() (nunca fica presa). */
export class ActionAttempt {
  private settled = false;

  constructor(
    private readonly limiter: LoginLimiter,
    private readonly keys: readonly string[],
  ) {}

  /** Erro de senha/código: conta a falha nas duas. Se alguma estourou o limite, `allowed` vem false. */
  fail(): LoginAttemptResult {
    this.settled = true;
    const results = this.keys.map((k) => this.limiter.onFailure(k));
    const blocked = results.filter((r) => !r.allowed);
    if (blocked.length === 0) return { allowed: true, retryAfterSec: 0 };
    return { allowed: false, retryAfterSec: Math.max(...blocked.map((r) => r.retryAfterSec)) };
  }

  /** Ação concluída: zera as contagens. */
  success(): void {
    this.settled = true;
    for (const k of this.keys) this.limiter.onSuccess(k);
  }

  /** Sai sem contar (erro que não é de senha: payload, conflito, falha de disco). Idempotente. */
  release(): void {
    if (this.settled) return;
    this.settled = true;
    for (const k of this.keys) this.limiter.release(k);
  }
}

/**
 * Reserva uma tentativa por IP e por sessão. Se alguma está bloqueada, responde
 * 429 e devolve null (quem chamou só retorna `reply`).
 */
export function beginAction(
  limiter: LoginLimiter,
  who: { ip: string; sessionId: string },
  reply: FastifyReply,
): ActionAttempt | null {
  const keys = [who.ip, `sessao:${who.sessionId}`];
  const reserved: string[] = [];
  for (const key of keys) {
    const gate = limiter.check(key);
    if (!gate.allowed) {
      for (const k of reserved) limiter.release(k);
      sendTooManyAttempts(reply, gate.retryAfterSec);
      return null;
    }
    reserved.push(key);
  }
  return new ActionAttempt(limiter, keys);
}
