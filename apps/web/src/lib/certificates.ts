/**
 * certificates.ts — rótulos da página Certificados, compartilhados com o
 * resumo no card do e-mail e nos domínios do projeto.
 */
import type { CertificateItem, CertificateState } from "@paas/core";
import { formatDate, t, type Key } from "@/i18n";

/** Chaves dos rótulos de estado (o texto sai por `t(...)` na renderização). */
export const STATE_KEYS: Record<CertificateState, Key> = {
  valid: "certificates.state.valid",
  issuing: "certificates.state.issuing",
  failed: "certificates.state.failed",
  expiring: "certificates.state.expiring",
  expired: "certificates.state.expired",
  unknown: "certificates.state.unknown",
};

export function stateVariant(state: CertificateState): "success" | "warning" | "destructive" | "secondary" {
  if (state === "valid") return "success";
  if (state === "issuing" || state === "expiring") return "warning";
  if (state === "failed" || state === "expired") return "destructive";
  return "secondary";
}

export function ownerLabel(item: CertificateItem): string {
  if (item.owner.kind === "panel") return t("certificates.owner.panel");
  if (item.owner.kind === "mail") return t("certificates.owner.mail");
  return t("certificates.owner.project", { name: item.owner.projectName ?? "" }).trim();
}

export function modeLabel(item: CertificateItem): string {
  return item.mode === "manual" ? t("certificates.mode.manual") : t("certificates.mode.automatic");
}

/** Validade total do certificado servido, em dias inteiros (90, 64, 45, 6…); null sem início ou fim. */
export function validityDays(item: Pick<CertificateItem, "validFrom" | "validTo">): number | null {
  if (!item.validFrom || !item.validTo) return null;
  const ms = Date.parse(item.validTo) - Date.parse(item.validFrom);
  return Number.isFinite(ms) && ms > 0 ? Math.max(1, Math.round(ms / 86_400_000)) : null;
}

/** Chave do texto do alerta ativo de um item (null = sem alerta). */
export function alertReasonKey(item: Pick<CertificateItem, "alert">): Key | null {
  const reason = item.alert.reason;
  if (item.alert.level === "none" || !reason) return null;
  return `certificates.card.alert.reason.${reason}` as Key;
}

/** Data no idioma da interface (UTC, como o Caddy e o Let's Encrypt contam a validade). */
export function formatDay(iso: string): string {
  return formatDate(iso, { timeZone: "UTC" });
}
