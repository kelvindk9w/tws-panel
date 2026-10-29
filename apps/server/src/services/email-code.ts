/**
 * email-code.ts — código por e-mail como fator EXTRA, opcional e escolhido pelo
 * próprio usuário (Configurações → Segurança). Desligado por padrão.
 *
 * Ligado, vale para as ações sensíveis de acesso (chaves SSH, senha do usuário
 * Linux, desbloqueio do fail2ban, desligar o 2FA, gerar códigos de recuperação
 * novos, criar tokens de API, kit de recuperação, trocar a senha do painel,
 * recomeçar o assistente): além de senha e código do app, a ação pede um código
 * de 6 dígitos enviado ao e-mail do administrador.
 *
 * Regras:
 *  - 6 dígitos, validade de 10 min, USO ÚNICO e preso à sessão que o pediu;
 *  - 5 erros seguidos invalidam o código (é preciso pedir outro);
 *  - envios limitados: 1 a cada 30 s e 5 por hora, por usuário;
 *  - só o scrypt (com sal por código e chave do processo) fica em memória; o código em claro existe só no e-mail;
 *  - tudo é auditado (auth.email_code_*), nunca com o código.
 *
 * Usa o envio de e-mail que o painel já tem (o do plugin de e-mail). Não é uma
 * recuperação de senha por e-mail: não existe rota pública para isso.
 */
import { randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import {
  EMAIL_CODE_ACTIONS,
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_MAX_SENDS_PER_HOUR,
  EMAIL_CODE_RESEND_GAP_MS,
  EMAIL_CODE_TTL_MS,
  type EmailCodeAction,
  type EmailCodeSendResponse,
  type EmailCodeStatusResponse,
} from "@paas/core";
import { httpError } from "./http-error.js";
import type { StoredUser } from "./user-store.js";

/** Envio de e-mail do painel, fornecido pelo plugin de e-mail (que enxerga o MailService). */
export interface EmailCodeMailer {
  readiness(): Promise<{ ready: boolean; reason: string | null; from: string | null }>;
  send(msg: { to: string; subject: string; text: string; html: string }): Promise<void>;
  /** O domínio do endereço é uma caixa hospedada nesta VPS? Null = não deu para saber. */
  isHostedAddress(address: string): Promise<boolean | null>;
}

export interface EmailCodeAudit {
  record(input: { action: string; detail: string; actor?: string; target?: string | null }): Promise<unknown>;
}

export type EmailCodeCheck =
  | { status: "ok" }
  | { status: "none" }
  | { status: "expired" }
  | { status: "wrong_action"; asked: EmailCodeAction }
  | { status: "invalid"; attemptsLeft: number }
  | { status: "exhausted" };

interface Pending {
  salt: string;
  hash: string;
  expiresAt: number;
  attempts: number;
  /** Ação para a qual o código foi pedido: só vale nela (não existe código "coringa"). */
  action: EmailCodeAction;
}

/** a***@dominio.com — mostra o suficiente para a pessoa reconhecer a caixa. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 1) return "***";
  return `${address[0]}***${address.slice(at)}`;
}

/**
 * scrypt (KDF) com sal aleatório por código e a chave secreta do processo como pepper (nunca sai da
 * memória): o resumo sozinho não permite testar códigos fora do servidor.
 */
function digest(pepper: Buffer, salt: string, code: string, cost: number): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(code, Buffer.concat([Buffer.from(salt, "hex"), pepper]), 32, { N: cost, r: 8, p: 1 }, (err, out) =>
      err ? reject(err) : resolve(out.toString("hex")),
    );
  });
}

export class EmailCodeService {
  private mailer: EmailCodeMailer | null = null;
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly pending = new Map<string, Pending>();
  private readonly sends = new Map<string, number[]>();
  private readonly hmacKey = randomBytes(32);
  private readonly scryptCost: number;
  private readonly now: () => number;
  private readonly generate: () => string;

  constructor(
    private readonly audit: EmailCodeAudit | null = null,
    opts: { now?: () => number; generate?: () => string; scryptCost?: number } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.scryptCost = opts.scryptCost ?? 16_384;
    this.generate = opts.generate ?? (() => String(randomInt(0, 1_000_000)).padStart(6, "0"));
  }

  setMailer(mailer: EmailCodeMailer | null): void {
    this.mailer = mailer;
  }

  private record(action: string, detail: string, actor: string): void {
    void this.audit?.record({ action, detail, actor, target: "código por e-mail" })?.catch(() => undefined);
  }

  /** O usuário ligou o fator? */
  isEnabled(user: StoredUser): boolean {
    return Boolean(user.emailCodeEnabledAt);
  }

  async status(user: StoredUser): Promise<EmailCodeStatusResponse> {
    const address = user.email ?? null;
    let mailReady = false;
    let mailReason: string | null = "O envio de e-mail do painel não está disponível nesta instalação.";
    let hostedHere: boolean | null = null;
    if (this.mailer) {
      try {
        const r = await this.mailer.readiness();
        mailReady = r.ready;
        mailReason = r.ready ? null : (r.reason ?? "O envio de e-mail do painel não está pronto.");
      } catch {
        mailReady = false;
        mailReason = "Não foi possível conferir o envio de e-mail agora. Tente de novo em instantes.";
      }
      if (address) {
        try {
          hostedHere = await this.mailer.isHostedAddress(address);
        } catch {
          hostedHere = null;
        }
      }
    }
    const twoFactorEnabled = Boolean(user.twoFactor);
    return {
      enabled: this.isEnabled(user),
      enabledAt: user.emailCodeEnabledAt ?? null,
      twoFactorEnabled,
      address: address ? maskEmail(address) : null,
      hostedHere,
      mailReady,
      mailReason,
      canEnable: twoFactorEnabled && Boolean(address) && mailReady,
    };
  }

  private key(userId: string, sessionId: string): string {
    return `${userId}:${sessionId}`;
  }

  /**
   * Avisa o dono por e-mail que o acesso à VPS mudou (o quê, quando e de que IP; nunca segredo). Melhor esforço:
   * sem e-mail no perfil ou sem envio pronto, grava `auth.access_alert_skipped` e devolve o motivo (as rotas o
   * põem em `alertWarning`, que a tela mostra); falha no envio, que roda em segundo plano, grava `auth.access_alert_failed`.
   * A ação NUNCA é desfeita. Nunca lança.
   */
  async alertAccessChange(user: StoredUser, what: string, ip: string | null | undefined, to?: string): Promise<string | undefined> {
    try {
      const address = to ?? user.email;
      const skip = (reason: string): string => {
        this.record("auth.access_alert_skipped", `Alerta de mudança de acesso não enviado: ${reason} (mudança: ${what}).`, user.username);
        return `Alerta por e-mail não enviado: ${reason}.`;
      };
      if (!address) return skip("não há e-mail cadastrado no perfil");
      const mailer = this.mailer;
      if (!mailer) return skip("o envio de e-mail do painel não está disponível");
      const readiness = await mailer.readiness().catch(() => null);
      if (!readiness?.ready) return skip(`o envio de e-mail do painel não está pronto${readiness?.reason ? ` (${readiness.reason})` : ""}`);
      const when = new Date(this.now()).toISOString();
      const origin = ip ? ip : "desconhecido";
      // Em segundo plano: um SMTP lento não segura a resposta da ação que já foi feita.
      const job = mailer.send({
        to: address,
        subject: "Alerta do TWS Panel: o acesso à sua VPS foi alterado",
        text:
          `O acesso à sua VPS foi alterado pelo painel.\n\n` +
          `O que mudou: ${what}\n` +
          `Quando: ${when}\n` +
          `De qual IP: ${origin}\n\n` +
          `Se não foi você, troque a senha do painel agora e confira as chaves em Configurações → Acesso à VPS.`,
        html:
          `<p>O acesso à sua VPS foi alterado pelo painel.</p>` +
          `<ul><li>O que mudou: ${escapeHtml(what)}</li><li>Quando: ${when}</li><li>De qual IP: ${escapeHtml(origin)}</li></ul>` +
          `<p>Se não foi você, troque a senha do painel agora e confira as chaves em Configurações → Acesso à VPS.</p>`,
      }).then(
        () => this.record("auth.access_alert_sent", `Aviso de mudança de acesso enviado para ${maskEmail(address)}.`, user.username),
        () => this.record("auth.access_alert_failed", "Não foi possível enviar o aviso de mudança de acesso por e-mail.", user.username),
      );
      this.inflight.add(job);
      void job.finally(() => this.inflight.delete(job));
      return undefined;
    } catch {
      this.record("auth.access_alert_failed", "Não foi possível enviar o aviso de mudança de acesso por e-mail.", user.username);
      return undefined;
    }
  }

  /** Espera os avisos em segundo plano terminarem (testes e encerramento). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }

  /** Envia um código novo (o anterior deixa de valer). Limites de intervalo e de envios por hora. */
  async send(user: StoredUser, sessionId: string, action: EmailCodeAction): Promise<EmailCodeSendResponse> {
    if (!user.email) {
      throw httpError(
        409,
        "email_missing",
        "Cadastre o seu e-mail em Configurações → Perfil: é para ele que o código é enviado.",
      );
    }
    if (!this.mailer) {
      throw httpError(409, "email_unavailable", "O envio de e-mail do painel não está disponível nesta instalação.");
    }
    const nowMs = this.now();
    const recent = (this.sends.get(user.id) ?? []).filter((t) => nowMs - t < 60 * 60_000);
    const last = recent.at(-1);
    if (last !== undefined && nowMs - last < EMAIL_CODE_RESEND_GAP_MS) {
      const wait = Math.ceil((EMAIL_CODE_RESEND_GAP_MS - (nowMs - last)) / 1000);
      throw this.rateLimited(`Aguarde ${wait}s antes de pedir outro código.`, wait);
    }
    if (recent.length >= EMAIL_CODE_MAX_SENDS_PER_HOUR) {
      const wait = Math.ceil((recent[0]! + 60 * 60_000 - nowMs) / 1000);
      throw this.rateLimited(
        `Limite de ${EMAIL_CODE_MAX_SENDS_PER_HOUR} códigos por hora atingido. Tente de novo em ${Math.ceil(wait / 60)} min.`,
        wait,
      );
    }

    // Reserva o envio ANTES de qualquer espera: pedidos paralelos não furam o intervalo nem o limite por hora.
    this.sends.set(user.id, [...recent, nowMs]);
    const release = () => this.sends.set(user.id, (this.sends.get(user.id) ?? []).filter((t) => t !== nowMs));
    const readiness = await this.mailer.readiness().catch(() => null);
    if (!readiness?.ready) {
      release();
      throw httpError(
        409,
        "email_unavailable",
        readiness?.reason ?? "Não foi possível conferir o envio de e-mail agora. Tente de novo em instantes.",
      );
    }
    const code = this.generate();
    const salt = randomBytes(16).toString("hex");
    const minutes = Math.round(EMAIL_CODE_TTL_MS / 60_000);
    const forWhat = EMAIL_CODE_ACTIONS[action];
    try {
      await this.mailer.send({
        to: user.email,
        subject: `Código de confirmação do TWS Panel: ${code}`,
        text:
          `Seu código de confirmação do TWS Panel é ${code}.\n\n` +
          `Pedido para: ${forWhat}.\n\n` +
          `Ele vale por ${minutes} minutos e só pode ser usado uma vez. ` +
          `Se não foi você quem pediu, ignore este e-mail e troque a senha do painel.`,
        html:
          `<p>Seu código de confirmação do TWS Panel é:</p>` +
          `<p style="font-size:24px;letter-spacing:4px;font-family:monospace"><strong>${code}</strong></p>` +
          `<p>Pedido para: ${forWhat}.</p>` +
          `<p>Ele vale por ${minutes} minutos e só pode ser usado uma vez. ` +
          `Se não foi você quem pediu, ignore este e-mail e troque a senha do painel.</p>`,
      });
    } catch (err) {
      this.record("auth.email_code_send_failed", `Não foi possível enviar o código por e-mail para ${maskEmail(user.email)}.`, user.username);
      release();
      // o motivo detalhado (host, porta) fica no log do servidor; a tela recebe só o aviso
      throw httpError(502, "email_send_failed", "O servidor de e-mail não aceitou o envio do código. Confira as configurações de e-mail do painel.");
    }
    this.pending.set(this.key(user.id, sessionId), {
      salt,
      hash: await digest(this.hmacKey, salt, code, this.scryptCost),
      expiresAt: nowMs + EMAIL_CODE_TTL_MS,
      attempts: 0,
      action,
    });
    this.record("auth.email_code_sent", `Código enviado para ${maskEmail(user.email)}.`, user.username);
    return {
      sentTo: maskEmail(user.email),
      expiresInSec: Math.round(EMAIL_CODE_TTL_MS / 1000),
      resendAfterSec: Math.round(EMAIL_CODE_RESEND_GAP_MS / 1000),
    };
  }

  private rateLimited(message: string, retryAfterSec: number) {
    return Object.assign(httpError(429, "email_code_rate_limited", message), { details: { retryAfterSec } });
  }

  /**
   * Confere SEM consumir (quem chama ainda vai conferir a senha/o código do app;
   * se isso falhar, o código do e-mail continua valendo). Erro conta tentativa;
   * ao esgotar, o código pendente some.
   */
  async check(user: StoredUser, sessionId: string, code: string | undefined, action: EmailCodeAction): Promise<EmailCodeCheck> {
    const key = this.key(user.id, sessionId);
    const entry = this.pending.get(key);
    if (!entry) return { status: "none" };
    // código preso à ação: pedido para outra coisa não vale aqui (e não gasta tentativa nem o código)
    if (entry.action !== action) return { status: "wrong_action", asked: entry.action };
    if (entry.expiresAt <= this.now()) {
      this.pending.delete(key);
      return { status: "expired" };
    }
    const typed = (code ?? "").replace(/\s/g, "");
    if (/^\d{6}$/.test(typed)) {
      const given = Buffer.from(await digest(this.hmacKey, entry.salt, typed, this.scryptCost), "hex");
      const wanted = Buffer.from(entry.hash, "hex");
      // durante a espera do scrypt outro pedido pode ter trocado/consumido o código
      if (this.pending.get(key) !== entry) return { status: "none" };
      if (given.length === wanted.length && timingSafeEqual(given, wanted)) return { status: "ok" };
    }
    entry.attempts += 1;
    if (entry.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
      this.pending.delete(key);
      this.record(
        "auth.email_code_exhausted",
        `Código por e-mail invalidado depois de ${EMAIL_CODE_MAX_ATTEMPTS} erros seguidos.`,
        user.username,
      );
      return { status: "exhausted" };
    }
    return { status: "invalid", attemptsLeft: EMAIL_CODE_MAX_ATTEMPTS - entry.attempts };
  }

  /** Uso único: depois de a ação ser autorizada, o código deixa de valer. */
  consume(user: StoredUser, sessionId: string): void {
    this.pending.delete(this.key(user.id, sessionId));
  }

  /** Esquece os códigos pendentes do usuário (troca de senha, 2FA desligado, sessões encerradas). */
  forget(userId: string): void {
    for (const key of [...this.pending.keys()]) if (key.startsWith(`${userId}:`)) this.pending.delete(key);
  }

  /** Mensagem do erro de cada falha da conferência (null = ok). */
  static failureMessage(check: EmailCodeCheck): { error: string; message: string } | null {
    switch (check.status) {
      case "ok":
        return null;
      case "none":
        return {
          error: "email_code_required",
          message: "Peça o código por e-mail (botão Enviar código) e digite os 6 dígitos que chegarem.",
        };
      case "wrong_action":
        return {
          error: "email_code_wrong_action",
          message: `Este código foi pedido para outra ação (${EMAIL_CODE_ACTIONS[check.asked]}). Peça um código novo aqui.`,
        };
      case "expired":
        return { error: "email_code_expired", message: "O código por e-mail venceu. Peça outro." };
      case "exhausted":
        return {
          error: "email_code_exhausted",
          message: `Muitos erros no código por e-mail: ele foi cancelado. Peça outro.`,
        };
      case "invalid":
        return {
          error: "invalid_email_code",
          message: `Código por e-mail incorreto. Restam ${check.attemptsLeft} tentativa(s) com este código.`,
        };
    }
  }
}
