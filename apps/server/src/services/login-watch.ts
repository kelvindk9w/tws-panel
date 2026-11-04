/**
 * login-watch.ts — vigia do login: transforma "a senha certa chegou, mas o
 * código não" em Auditoria e em Alerta para o dono.
 *
 * Por que não avisar na hora do primeiro passo: todo login legítimo com 2FA
 * passa por ele (a senha certa, sem código, é como a tela pede o código).
 * Então o primeiro passo só abre uma "pendência" por IP+conta; se o mesmo IP
 * conclui o login em poucos minutos, a pendência some sem barulho. Ela vira
 * evento quando EXPIRA sem conclusão (ou quando o login só conclui depois de
 * vários códigos errados).
 *
 * Tipos de evento e como viram alerta:
 *  - no_code     senha certa, código nunca chegou;
 *  - wrong_code  senha certa, código errado;
 *  - locked      a conta bloqueou o código de 6 dígitos (aviso na hora: o
 *                bloqueio já é espaçado, 5 min e dobrando).
 * no_code e wrong_code são agrupados: no máximo UM alerta por tipo a cada
 * 15 min, com a contagem do período. O AlertsService ainda reaproveita o
 * alerta aberto de mesmo título (sem novo aviso fora do painel enquanto o
 * dono não reconhecer o anterior) e o serviço de notificações agrupa de novo.
 *
 * Nada aqui guarda ou mostra senha ou código. O alerta mostra o nome de
 * usuário do painel e o IP só mascarado (/24 no IPv4, /64 no IPv6).
 */
import type { AlertSeverity } from "@paas/core";
import { ipGroupKey, maskIp } from "./ip-group.js";

export type LoginWatchKind = "no_code" | "wrong_code" | "locked";

export interface LoginWatchUser {
  id: string;
  username: string;
}

export interface LoginWatchOptions {
  alerts: {
    create(input: { severity: AlertSeverity; source: "login"; title: string; detail: string }): Promise<unknown>;
  };
  audit: { record(input: { action: string; detail: string; actor?: string; target?: string | null }): Promise<unknown> };
  now?: () => number;
  log?: (message: string) => void;
  /** Quanto tempo o IP tem para concluir o login depois da senha certa (padrão 5 min). */
  challengeTtlMs?: number;
  /** Intervalo mínimo entre alertas do mesmo tipo (padrão 15 min). */
  alertWindowMs?: number;
  /** Teto de pendências em memória (padrão 5000). */
  maxChallenges?: number;
}

interface Challenge {
  username: string;
  ip: string;
  lastAt: number;
  attempts: number;
  wrong: number;
}

interface Bucket {
  count: number;
  origins: Set<string>;
  users: Set<string>;
  lastFlushAt: number;
}

const TITLES: Record<LoginWatchKind, string> = {
  no_code: "Senha correta do painel digitada sem concluir a verificação em duas etapas",
  wrong_code: "Código da verificação em duas etapas digitado errado depois da senha correta",
  locked: "Verificação em duas etapas bloqueada por excesso de códigos errados",
};

const SEVERITY: Record<LoginWatchKind, AlertSeverity> = {
  no_code: "warning",
  wrong_code: "warning",
  locked: "critical",
};

const MAX_LISTED = 5;
const SWEEP_EVERY_MS = 30_000;
/** Códigos errados antes de entrar que já valem como evento mesmo com o login concluído. */
const WRONG_BEFORE_SUCCESS = 3;

export class LoginWatch {
  private readonly challenges = new Map<string, Challenge>();
  private readonly buckets = new Map<LoginWatchKind, Bucket>();
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly ttl: number;
  private readonly window: number;
  private readonly max: number;

  constructor(private readonly opts: LoginWatchOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.warn(m));
    this.ttl = opts.challengeTtlMs ?? 5 * 60_000;
    this.window = opts.alertWindowMs ?? 15 * 60_000;
    this.max = opts.maxChallenges ?? 5000;
  }

  private key(ip: string, user: LoginWatchUser): string {
    return `${ipGroupKey(ip)}|${user.id}`;
  }

  /** Primeiro passo: senha certa, falta o código. Abre (ou renova) a pendência. */
  passwordAccepted(ip: string, user: LoginWatchUser): void {
    const k = this.key(ip, user);
    const current = this.challenges.get(k);
    if (current) {
      current.lastAt = this.now();
      current.attempts += 1;
      return;
    }
    if (this.challenges.size >= this.max) this.expireOldest();
    this.challenges.set(k, { username: user.username, ip, lastAt: this.now(), attempts: 1, wrong: 0 });
  }

  /** Código recusado (errado, ou a conta já estava bloqueada). Conta na pendência do IP. */
  codeRejected(ip: string, user: LoginWatchUser): void {
    const k = this.key(ip, user);
    let c = this.challenges.get(k);
    if (!c) {
      if (this.challenges.size >= this.max) this.expireOldest();
      c = { username: user.username, ip, lastAt: this.now(), attempts: 0, wrong: 0 };
      this.challenges.set(k, c);
    }
    c.lastAt = this.now();
    c.wrong += 1;
  }

  /** Login concluído: a pendência some. Só deixa rastro se houve vários erros antes. */
  completed(ip: string, user: LoginWatchUser): void {
    const k = this.key(ip, user);
    const c = this.challenges.get(k);
    this.challenges.delete(k);
    if (c && c.wrong >= WRONG_BEFORE_SUCCESS) void this.raise(c, "wrong_code", this.now());
  }

  /** O código de 6 dígitos da conta acabou de ser bloqueado. Aviso imediato. */
  async accountLocked(
    ip: string,
    user: LoginWatchUser,
    info: { retryAfterSec: number; level: number },
  ): Promise<void> {
    await this.safe(() =>
      this.opts.audit.record({
        actor: "anon",
        action: "auth.2fa_locked",
        target: user.username,
        detail:
          `Código de 6 dígitos bloqueado por ${formatDuration(info.retryAfterSec)} após erros seguidos ` +
          `(bloqueio nº ${info.level}; origem do último erro: ${ip}). O código de recuperação continua valendo.`,
      }),
    );
    await this.safe(() =>
      this.opts.alerts.create({
        severity: SEVERITY.locked,
        source: "login",
        title: TITLES.locked,
        detail:
          `Usuário do painel: ${user.username}. O código do app ficou bloqueado por ${formatDuration(info.retryAfterSec)} ` +
          `(bloqueio nº ${info.level}; o tempo dobra a cada reincidência, até 24 h). Origem do último erro: ${maskIp(ip)}. ` +
          "Quem errou o código já digitou a senha certa: se não foi você, troque a senha em Configurações. " +
          "Para entrar durante o bloqueio, use um código de recuperação.",
      }),
    );
  }

  /** Expira pendências antigas e solta os alertas agrupados que já podem sair. */
  async sweep(): Promise<void> {
    const now = this.now();
    for (const [k, c] of this.challenges) {
      if (now - c.lastAt >= this.ttl) {
        this.challenges.delete(k);
        await this.raise(c, c.wrong > 0 ? "wrong_code" : "no_code", now);
      }
    }
    for (const [kind, bucket] of this.buckets) {
      if (bucket.count > 0 && now - bucket.lastFlushAt >= this.window) await this.flush(kind, now);
    }
  }

  /** Quantas pendências estão abertas (testes e diagnóstico). */
  pending(): number {
    return this.challenges.size;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sweep().catch(() => undefined), SWEEP_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private expireOldest(): void {
    const first = this.challenges.entries().next();
    if (first.done) return;
    this.challenges.delete(first.value[0]);
    void this.raise(first.value[1], first.value[1].wrong > 0 ? "wrong_code" : "no_code", this.now());
  }

  /** Auditoria do evento + soma no alerta agrupado do tipo. */
  private async raise(c: Challenge, kind: "no_code" | "wrong_code", now: number): Promise<void> {
    const detail =
      kind === "no_code"
        ? `Senha correta digitada, mas o código de verificação não foi enviado (${c.attempts} vez(es), origem ${c.ip}).`
        : `Senha correta digitada, mas o código de verificação foi recusado ${c.wrong} vez(es) (origem ${c.ip}).`;
    await this.safe(() =>
      this.opts.audit.record({
        actor: "anon",
        action: kind === "no_code" ? "auth.2fa_abandoned" : "auth.2fa_wrong_code",
        target: c.username,
        detail,
      }),
    );
    const bucket = this.bucket(kind);
    bucket.count += 1;
    if (bucket.origins.size < MAX_LISTED) bucket.origins.add(maskIp(c.ip));
    if (bucket.users.size < MAX_LISTED) bucket.users.add(c.username);
    if (now - bucket.lastFlushAt >= this.window) await this.flush(kind, now);
  }

  private bucket(kind: LoginWatchKind): Bucket {
    let b = this.buckets.get(kind);
    if (!b) {
      b = { count: 0, origins: new Set(), users: new Set(), lastFlushAt: 0 };
      this.buckets.set(kind, b);
    }
    return b;
  }

  private async flush(kind: LoginWatchKind, now: number): Promise<void> {
    const b = this.bucket(kind);
    if (b.count === 0) return;
    const count = b.count;
    const origins = [...b.origins].join(", ");
    const users = [...b.users].join(", ");
    b.count = 0;
    b.origins = new Set();
    b.users = new Set();
    b.lastFlushAt = now;
    const what =
      kind === "no_code"
        ? "alguém digitou a senha correta e não concluiu a verificação"
        : "alguém digitou a senha correta e errou o código de verificação";
    await this.safe(() =>
      this.opts.alerts.create({
        severity: SEVERITY[kind],
        source: "login",
        title: TITLES[kind],
        detail:
          `${count} ocorrência(s) no último período: ${what}. Usuário do painel: ${users}. ` +
          `Origens (mascaradas): ${origins}. Se não foi você, troque a senha em Configurações e confira a Auditoria; ` +
          "o painel bloqueia o código de 6 dígitos depois de 5 erros seguidos.",
      }),
    );
  }

  private async safe(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.log(`login-watch: falha ao registrar o evento (${err instanceof Error ? err.message : String(err)}).`);
    }
  }
}

function formatDuration(sec: number): string {
  if (sec >= 3600) return `${Math.round(sec / 3600)} h`;
  if (sec >= 60) return `${Math.round(sec / 60)} min`;
  return `${sec} s`;
}
