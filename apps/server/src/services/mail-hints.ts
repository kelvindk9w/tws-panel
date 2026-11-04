/**
 * mail-hints.ts — "Por que nada chegou": transforma os fatos do projeto em itens que a tela traduz.
 * Função PURA (os fatos são reunidos em mail-diagnosis-service.ts), para testar cada regra sozinha.
 *
 * A ordem é a da probabilidade de ser a causa e de quão fácil é conferir: primeiro o que impede o envio de existir
 * (e-mail desligado), depois o que desvia (caixa de teste, mailer `log`), depois o que ainda não chegou ao app
 * (reinício pendente, variáveis não ligadas, fila sem worker) e por fim o que o servidor de e-mail viu.
 */
import type { MailHintItem, MailRefusalKind } from "@paas/core";

export interface MailHintFacts {
  /** O e-mail do projeto está ligado (existe configuração). */
  emailEnabled: boolean;
  /** A caixa do projeto existe e tem senha conhecida pelo painel. */
  hasMailbox: boolean;
  /** A caixa de teste (Mailpit) está ligada: o e-mail vai para lá. */
  testInboxOn: boolean;
  /** O e-mail mudou (ou foi ligado) depois do último deploy. */
  emailNeedsRestart: boolean;
  /** MAIL_MAILER efetivo é `log` ou `array` (variável ou, no Laravel, o padrão do projeto). */
  silentMailer: "log" | "array" | null;
  /** O projeto é Laravel. */
  laravel: boolean;
  /** Variáveis MAIL_HOST/MAIL_USERNAME/MAIL_PASSWORD que não estão ligadas ao e-mail do painel (só Laravel). */
  unlinked: string[];
  /** A fila do Laravel não tem worker. */
  queueWithoutWorker: boolean;
  /** Recusas recentes do login do projeto e a mais frequente. */
  refusals: { count: number; topKind: MailRefusalKind | null };
  /** O servidor de e-mail nunca viu o app tentar entrar (nem aceito, nem recusado). */
  neverConnected: boolean;
}

export function buildMailHints(f: MailHintFacts): MailHintItem[] {
  const hints: MailHintItem[] = [];
  const add = (code: MailHintItem["code"], severity: MailHintItem["severity"], params?: Record<string, string>) =>
    hints.push({ code, severity, ...(params ? { params } : {}) });

  if (!f.emailEnabled) {
    add("email_disabled", "problem");
    // Sem e-mail ligado no painel, o resto não se aplica, exceto o mailer e a fila (o app pode usar outro provedor).
    if (f.silentMailer) add("mailer_not_smtp", "problem", { mailer: f.silentMailer });
    if (f.queueWithoutWorker) add("queue_no_worker", "problem");
    return hints;
  }
  if (!f.hasMailbox) add("no_mailbox", "problem");
  if (f.testInboxOn) add("test_inbox_on", "problem");
  if (f.emailNeedsRestart) add("needs_restart", "problem");
  if (f.silentMailer) add("mailer_not_smtp", "problem", { mailer: f.silentMailer });
  if (f.laravel && f.unlinked.length > 0) add("smtp_not_linked", "problem", { names: f.unlinked.join(", ") });
  if (f.queueWithoutWorker) add("queue_no_worker", "problem");
  if (f.refusals.count > 0) add("recent_refusals", "problem", { count: String(f.refusals.count), ...(f.refusals.topKind ? { kind: f.refusals.topKind } : {}) });
  // "Nunca conectou" só ajuda quando nada acima explica: é o sintoma de um app que não está falando com o servidor.
  if (f.neverConnected && hints.length === 0) add("app_never_connected", "info");
  return hints;
}
