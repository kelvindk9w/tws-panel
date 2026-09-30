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
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StoredUser, UserStore } from "./user-store.js";
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
  private key: Buffer | null = null;
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
    const tf = user.twoFactor;
    if (!tf) return null;
    const secret = await this.open(tf);
    const step = verifyTotp(secret, code, { nowMs: this.now(), lastStep: tf.lastStep });
    if (step !== null) {
      await this.users.setTwoFactor(user.id, { ...tf, lastStep: step });
      return { method: "totp", recoveryCodesLeft: tf.recoveryHashes.length };
    }
    const hash = hashRecoveryCode(code);
    if (tf.recoveryHashes.includes(hash)) {
      const recoveryHashes = tf.recoveryHashes.filter((h) => h !== hash);
      await this.users.setTwoFactor(user.id, { ...tf, recoveryHashes });
      return { method: "recovery", recoveryCodesLeft: recoveryHashes.length };
    }
    return null;
  }

  async disable(user: StoredUser): Promise<void> {
    if (!user.twoFactor) throw new TwoFactorError("not_enabled", "A verificação em duas etapas não está ativa.");
    await this.users.setTwoFactor(user.id, null);
  }

  private async loadKey(): Promise<Buffer> {
    if (this.key) return this.key;
    try {
      const raw = Buffer.from((await readFile(this.keyFile, "utf8")).trim(), "hex");
      if (raw.length === KEY_BYTES) {
        this.key = raw;
        return raw;
      }
    } catch {
      // arquivo inexistente — gera abaixo
    }
    const gerada = randomBytes(KEY_BYTES);
    await mkdir(path.dirname(this.keyFile), { recursive: true });
    await writeFile(this.keyFile, gerada.toString("hex") + "\n", { encoding: "utf8", mode: 0o600 });
    await chmod(this.keyFile, 0o600).catch(() => undefined);
    this.key = gerada;
    return gerada;
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
