/**
 * two-factor.ts — verificação em duas etapas do login do painel.
 *
 * Com o acesso por HTTPS (padrão da instalação), o painel fica na internet e
 * só a senha o protegia. Com a verificação ativa, entrar exige também o código
 * de 6 dígitos do app autenticador do celular — ou um código de recuperação,
 * de uso único, para quem perdeu o celular.
 *
 * Em repouso o segredo fica cifrado (AES-256-GCM) com a chave de
 * data/two-factor-key (0600, gerada no primeiro uso, arquivo próprio — mesmo
 * padrão do cofre de credenciais). O segredo em claro só existe em memória,
 * e só volta pela API UMA vez: no setup, para o QR code.
 *
 * O setup começado e não confirmado fica só em memória (10 min): nada muda no
 * login até o operador provar, com um código, que o app ficou configurado.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import path from "node:path";
import {
  TWO_FACTOR_LOCK_BASE_MS,
  TWO_FACTOR_LOCK_MAX_FAILURES,
  TWO_FACTOR_LOCK_MAX_MS,
} from "@paas/core";
import { loadOrCreateKey } from "./json-file.js";
import type { StoredTwoFactor, StoredUser, UserStore } from "./user-store.js";
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  otpauthUri,
  verifyTotp,
} from "./totp.js";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const PENDING_TTL_MS = 10 * 60_000;
export const TWO_FACTOR_ISSUER = "TWS Panel";

export interface TwoFactorStatus {
  enabled: boolean;
  recoveryCodesLeft: number;
}

export type TwoFactorCheck = { method: "totp" | "recovery"; recoveryCodesLeft: number } | null;

/**
 * Resultado detalhado da conferência:
 *  - ok: código do app ou de recuperação aceito (zera o bloqueio da conta);
 *  - locked: a conta está bloqueada para o código de 6 dígitos — NADA foi conferido;
 *  - invalid: código recusado; `lockedNow` vem preenchido quando ESTE erro causou o bloqueio.
 */
export type TwoFactorOutcome =
  | { status: "ok"; method: "totp" | "recovery"; recoveryCodesLeft: number }
  | { status: "locked"; retryAfterSec: number }
  | {
      status: "invalid";
      lockedNow?: { retryAfterSec: number; level: number };
      /**
       * Só no código de 6 dígitos errado que NÃO bloqueou: quantos erros ainda cabem
       * antes do bloqueio da conta e quanto dura o PRÓXIMO bloqueio. Nunca expõe o nível.
       */
      account?: { attemptsLeft: number; nextLockSec: number };
    };

/** Código do app: 6 dígitos (espaços ignorados). Qualquer outra forma é tratada como código de recuperação. */
export function looksLikeTotp(code: string): boolean {
  return /^\d{6}$/.test(code.replace(/\s/g, ""));
}

/** Segundos até o fim do bloqueio do código do app (0 = livre). Só leitura, sem conferir nada. */
export function twoFactorLockRemainingSec(tf: StoredTwoFactor | null | undefined, nowMs: number): number {
  const until = tf?.lockedUntil ?? 0;
  return until > nowMs ? Math.ceil((until - nowMs) / 1000) : 0;
}

export class TwoFactorError extends Error {
  constructor(
    public readonly code: "already_enabled" | "not_enabled" | "no_pending_setup" | "invalid_two_factor_code",
    message: string,
  ) {
    super(message);
  }
}

export class TwoFactorService {
  private readonly keyFile: string;
  private keyLoading: Promise<Buffer> | null = null;
  private readonly pending = new Map<string, { secret: string; expiresAt: number }>();
  private readonly now: () => number;
  /** Aparece no app autenticador ("admin@1-2-3-4.sslip.io"): distingue um painel de outro. */
  private readonly accountSuffix: string | null;

  constructor(
    dataDir: string,
    private readonly users: UserStore,
    opts: { now?: () => number; accountSuffix?: string | null } = {},
  ) {
    this.keyFile = path.join(dataDir, "two-factor-key");
    this.now = opts.now ?? Date.now;
    this.accountSuffix = opts.accountSuffix ?? null;
  }

  status(user: StoredUser): TwoFactorStatus {
    const tf = user.twoFactor;
    return { enabled: Boolean(tf), recoveryCodesLeft: tf?.recoveryHashes.length ?? 0 };
  }

  /** Começa a ativação: segredo novo (em memória) + URI do QR code. */
  beginSetup(user: StoredUser): { secret: string; otpauthUri: string } {
    if (user.twoFactor) throw new TwoFactorError("already_enabled", "A verificação em duas etapas já está ativa.");
    const secret = generateTotpSecret();
    this.pending.set(user.id, { secret, expiresAt: this.now() + PENDING_TTL_MS });
    const account = this.accountSuffix ? `${user.username}@${this.accountSuffix}` : user.username;
    return { secret, otpauthUri: otpauthUri({ issuer: TWO_FACTOR_ISSUER, account, secret }) };
  }

  /** Confirma a ativação com um código do app. Devolve os códigos de recuperação (mostrados uma vez). */
  async enable(user: StoredUser, code: string): Promise<string[]> {
    if (user.twoFactor) throw new TwoFactorError("already_enabled", "A verificação em duas etapas já está ativa.");
    const pending = this.pending.get(user.id);
    if (!pending || pending.expiresAt < this.now()) {
      this.pending.delete(user.id);
      throw new TwoFactorError(
        "no_pending_setup",
        "A configuração expirou ou não foi iniciada. Comece de novo para gerar outro QR code.",
      );
    }
    const step = verifyTotp(pending.secret, code, { nowMs: this.now(), lastStep: null });
    if (step === null) {
      throw new TwoFactorError(
        "invalid_two_factor_code",
        "Código incorreto. Confira se o relógio do celular está certo e digite o código que aparece agora no app.",
      );
    }
    const recoveryCodes = generateRecoveryCodes();
    const box = await this.seal(pending.secret);
    await this.users.setTwoFactor(user.id, {
      ...box,
      lastStep: step,
      recoveryHashes: recoveryCodes.map(hashRecoveryCode),
      enabledAt: new Date(this.now()).toISOString(),
    });
    this.pending.delete(user.id);
    return recoveryCodes;
  }

  /**
   * Confere o código do login (ou de uma ação sensível). Código do app:
   * grava o passo usado (anti-reuso). Código de recuperação: é consumido.
   */
  async verify(user: StoredUser, code: string): Promise<TwoFactorCheck> {
    const outcome = await this.verifyDetailed(user, code);
    return outcome.status === "ok"
      ? { method: outcome.method, recoveryCodesLeft: outcome.recoveryCodesLeft }
      : null;
  }

  /**
   * Como `verify`, com o bloqueio por conta. Tudo acontece DENTRO da fila do
   * UserStore, contra o estado atual do disco: pedidos simultâneos, de IPs
   * diferentes, nunca conferem mais códigos de 6 dígitos que o limite.
   *  - Código de 6 dígitos com a conta bloqueada: recusado sem conferir.
   *  - Código de 6 dígitos errado: soma uma falha; na 5ª, bloqueia (5 min,
   *    dobrando a cada reincidência, até 24 h).
   *  - Código de recuperação: sempre conferido, não conta falha e não é
   *    bloqueado (é a saída do dono). Acertar qualquer um zera o bloqueio.
   */
  async verifyDetailed(user: StoredUser, code: string): Promise<TwoFactorOutcome> {
    const snapshot = user.twoFactor;
    if (!snapshot) return { status: "invalid" };
    const secret = await this.open(snapshot);
    const nowMs = this.now();
    const totpShaped = looksLikeTotp(code);
    const hash = hashRecoveryCode(code);
    const outcome = await this.users.updateTwoFactor<TwoFactorOutcome>(user.id, (tf) => {
      // desativada (ou reativada com outro segredo) desde a leitura de quem chamou
      if (!tf || tf.data !== snapshot.data || tf.iv !== snapshot.iv) return { result: { status: "invalid" } };
      if (totpShaped) {
        const remaining = twoFactorLockRemainingSec(tf, nowMs);
        if (remaining > 0) return { result: { status: "locked", retryAfterSec: remaining } };
        const step = verifyTotp(secret, code, { nowMs, lastStep: tf.lastStep });
        if (step !== null) {
          return {
            result: { status: "ok", method: "totp", recoveryCodesLeft: tf.recoveryHashes.length },
            next: clearLock({ ...tf, lastStep: step }),
          };
        }
        return this.registerFailure(tf, nowMs);
      }
      if (!tf.recoveryHashes.includes(hash)) return { result: { status: "invalid" } };
      const recoveryHashes = tf.recoveryHashes.filter((h) => h !== hash);
      return {
        result: { status: "ok", method: "recovery", recoveryCodesLeft: recoveryHashes.length },
        next: clearLock({ ...tf, recoveryHashes }),
      };
    });
    return outcome ?? { status: "invalid" };
  }

  /** Soma um erro do código de 6 dígitos e, no limite, aplica o bloqueio progressivo. */
  private registerFailure(
    tf: StoredTwoFactor,
    nowMs: number,
  ): { result: TwoFactorOutcome; next: StoredTwoFactor } {
    const failed = (tf.failedCodes ?? 0) + 1;
    // o nível esfria: um bloqueio velho (venceu há mais de 24 h) não pesa no próximo
    const previous = tf.lockedUntil ?? 0;
    const level = previous > 0 && nowMs - previous > TWO_FACTOR_LOCK_MAX_MS ? 0 : (tf.lockLevel ?? 0);
    const lockMs = Math.min(TWO_FACTOR_LOCK_BASE_MS * 2 ** Math.min(level, 20), TWO_FACTOR_LOCK_MAX_MS);
    if (failed < TWO_FACTOR_LOCK_MAX_FAILURES) {
      return {
        result: {
          status: "invalid",
          account: { attemptsLeft: TWO_FACTOR_LOCK_MAX_FAILURES - failed, nextLockSec: Math.ceil(lockMs / 1000) },
        },
        next: { ...tf, failedCodes: failed },
      };
    }
    return {
      result: { status: "invalid", lockedNow: { retryAfterSec: Math.ceil(lockMs / 1000), level: level + 1 } },
      next: { ...tf, failedCodes: 0, lockLevel: level + 1, lockedUntil: nowMs + lockMs },
    };
  }

  async disable(user: StoredUser): Promise<void> {
    if (!user.twoFactor) throw new TwoFactorError("not_enabled", "A verificação em duas etapas não está ativa.");
    await this.users.setTwoFactor(user.id, null);
  }

  /** Lida (ou criada) uma vez só: pedidos paralelos no primeiro uso nunca geram duas chaves. */
  private loadKey(): Promise<Buffer> {
    this.keyLoading ??= loadOrCreateKey(this.keyFile, KEY_BYTES, { log: (m) => console.warn(m) }).catch((err: unknown) => {
      this.keyLoading = null;
      throw err;
    });
    return this.keyLoading;
  }

  private async seal(secret: string): Promise<{ iv: string; tag: string; data: string }> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", await this.loadKey(), iv);
    const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  }

  private async open(box: { iv: string; tag: string; data: string }): Promise<string> {
    const decipher = createDecipheriv("aes-256-gcm", await this.loadKey(), Buffer.from(box.iv, "base64"));
    decipher.setAuthTag(Buffer.from(box.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]).toString("utf8");
  }
}

/** Remove o estado do bloqueio (campos opcionais saem do arquivo, não ficam em zero). */
function clearLock(tf: StoredTwoFactor): StoredTwoFactor {
  const { failedCodes: _f, lockLevel: _l, lockedUntil: _u, ...rest } = tf;
  return rest;
}
