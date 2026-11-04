/**
 * mail-diagnosis.ts — funções puras do diagnóstico de e-mail: recusas, "por que nada chegou" e teste de conexão.
 */
import {
  MAIL_PROBE_STEPS,
  MAIL_REFUSAL_KINDS,
  type MailHintCode,
  type MailHintItem,
  type MailProbeResult,
  type MailProbeStep,
  type MailRefusalKind,
} from "@paas/core";
import { t, type Key } from "@/i18n";

export function isRefusalKind(kind: unknown): kind is MailRefusalKind {
  return typeof kind === "string" && (MAIL_REFUSAL_KINDS as readonly string[]).includes(kind);
}

/** Título e sugestão de uma recusa; tipo desconhecido (servidor mais novo) não quebra a tela. */
export function refusalText(kind: string): { title: string; hint: string } | null {
  if (!isRefusalKind(kind)) return null;
  return { title: t(`diagnostico.refusal.kind.${kind}.title`), hint: t(`diagnostico.refusal.kind.${kind}.hint`) };
}

const HINT_CODES: readonly MailHintCode[] = [
  "email_disabled",
  "no_mailbox",
  "test_inbox_on",
  "needs_restart",
  "mailer_not_smtp",
  "smtp_not_linked",
  "queue_no_worker",
  "recent_refusals",
  "app_never_connected",
];

/** Título e explicação de um item de "por que nada chegou"; null se o código for desconhecido. */
export function hintText(hint: MailHintItem): { title: string; body: string } | null {
  if (!HINT_CODES.includes(hint.code)) return null;
  const p = hint.params ?? {};
  const title = t(`diagnostico.hint.${hint.code}.title` as Key);
  let body: string;
  switch (hint.code) {
    case "mailer_not_smtp":
      body = p.mailer ? t("diagnostico.hint.mailer_not_smtp.body", { mailer: p.mailer }) : t("diagnostico.hint.mailer_not_smtp.bodyUnknown");
      break;
    case "smtp_not_linked":
      body = p.names ? t("diagnostico.hint.smtp_not_linked.body", { names: p.names }) : t("diagnostico.hint.smtp_not_linked.bodyUnknown");
      break;
    case "recent_refusals": {
      const reason = p.kind ? (refusalText(p.kind)?.title ?? p.kind) : "";
      body =
        p.count && reason
          ? t("diagnostico.hint.recent_refusals.body", { count: p.count, kind: reason })
          : t("diagnostico.hint.recent_refusals.bodyUnknown");
      break;
    }
    default:
      body = t(`diagnostico.hint.${hint.code}.body` as Key);
  }
  return { title, body };
}

export type ProbeStepState = "passed" | "failed" | "notReached";

/** Situação de cada etapa, na ordem: concluída, a que falhou, ou nem chegou a rodar. */
export function probeStepStates(result: Pick<MailProbeResult, "passed" | "failedStep">): { step: MailProbeStep; state: ProbeStepState }[] {
  return MAIL_PROBE_STEPS.map((step) => ({
    step,
    state: result.passed.includes(step) ? "passed" : result.failedStep === step ? "failed" : "notReached",
  }));
}

/** Texto do motivo da falha do teste; motivo desconhecido cai em "inesperado". */
export function probeFailureText(failure: string | null): string {
  const known = ["dns", "refused", "timeout", "reset", "closed", "greeting", "ehlo_rejected", "starttls_unavailable", "starttls_rejected", "certificate", "auth_rejected", "auth_unsupported"];
  const code = failure && known.includes(failure) ? failure : "unexpected";
  return t(`diagnostico.probe.failure.${code}` as Key);
}

/** Texto do erro da API do teste de conexão. */
export function probeErrorText(code: string, status: number): string {
  if (code === "email_not_enabled") return t("diagnostico.probe.error.email_not_enabled");
  if (code === "probe_running") return t("diagnostico.probe.error.probe_running");
  if (status === 429) return t("diagnostico.probe.error.rate");
  return t("diagnostico.probe.error.generic");
}
